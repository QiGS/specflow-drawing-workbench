"""Actual loopback HTTP tests; provider is fake and no external network is used."""
import base64
import hashlib
import http.client
import io
import json
from pathlib import Path
import shutil
import subprocess
import threading
import unittest
from unittest.mock import patch
from PIL import Image

import workbench as wb
from provider import ProviderFailure


def png_bytes():
    stream=io.BytesIO();Image.new('RGB',(24,16),'white').save(stream,format='PNG');return stream.getvalue()


def pdf_bytes(pages=2):
    module=wb.pdf_module()
    if module is None:raise unittest.SkipTest('Optional PyMuPDF is not installed')
    pdf=module.open()
    try:
        for i in range(pages):
            page=pdf.new_page(width=200,height=100);page.insert_text((10,40),f'Page {i+1} 8.33 +/- 0.13')
        return pdf.tobytes()
    finally:pdf.close()


class WorkbenchHTTPTests(unittest.TestCase):
    def setUp(self):
        self.calls=[]
        self.env=patch.dict('os.environ',{'DRAWING_VLM_API_KEY':'fake-provider-secret-never-network','DRAWING_VLM_MODEL':'qwen3.8-flash',
                            'DRAWING_VLM_THINKING_MODE':'disabled','DRAWING_VLM_CREDENTIAL_EXPIRES':'2026-11-10'})
        self.env.start()
        self.server=wb.create_server(0,dispatch=self.fake_dispatch)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.origin=f'http://127.0.0.1:{self.server.server_port}';self.host=f'127.0.0.1:{self.server.server_port}'
        self.cookie=''

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join(timeout=3);self.env.stop()

    def fake_dispatch(self,value):
        self.calls.append(value)
        image=value['images'][0]
        return {'result':{'status':'valid_unreviewed','model_requested':'qwen3.8-flash','model_returned':'mock',
                          'validation':{'schema_valid':True,'reference_links_valid':True},'sources':[{'page':image['page'],'document_sha256':image['source_document_sha256']}],
                          'payload':{'fields':[],'observations':[],'image_texts':[{'image_id':image['image_id'],'raw_text':'fake test response'}],'missing_information':[]}},
                'audit':{'network_call_performed':False}}

    def req(self,method,path,body=None,headers=None):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=10)
        supplied={'Host':self.host}
        if self.cookie:supplied['Cookie']=self.cookie
        supplied.update(headers or {})
        connection.request(method,path,body=body,headers=supplied)
        response=connection.getresponse();data=response.read();status=response.status;head=dict(response.getheaders());connection.close()
        return status,head,data

    def login(self):
        token=self.server.state.bootstrap_token
        status,head,_=self.req('GET','/bootstrap?token='+token)
        self.assertEqual(status,303);self.assertEqual(head['Location'],'/')
        self.cookie=head['Set-Cookie'].split(';',1)[0]
        self.assertIn('HttpOnly',head['Set-Cookie']);self.assertIn('SameSite=Strict',head['Set-Cookie'])
        return token

    def upload(self,data,mime='image/png',name='sample.png'):
        status,_,body=self.req('POST','/api/upload',data,{'Origin':self.origin,'Content-Type':mime,'X-File-Name':name})
        return status,json.loads(body)

    def extract(self,doc,page=1,extra=None):
        value={'document_id':doc['id'],'page':page};value.update(extra or {})
        status,_,body=self.req('POST','/api/extract',json.dumps(value),{'Origin':self.origin,'Content-Type':'application/json'})
        return status,json.loads(body)

    def test_bootstrap_one_use_cookie_and_no_secret_in_session(self):
        self.assertEqual(self.req('GET','/')[0],401)
        token=self.login()
        self.assertEqual(self.req('GET','/bootstrap?token='+token)[0],403)
        status,headers,body=self.req('GET','/api/session')
        self.assertEqual(status,200);self.assertNotIn(b'fake-provider-secret',body)
        data=json.loads(body);self.assertTrue(data['configured']);self.assertFalse(data['provider_connectivity_tested'])
        self.assertEqual(data['credential_expires'],'2026-11-10')
        self.assertEqual(headers['Cache-Control'],'no-store');self.assertIn("frame-ancestors 'none'",headers['Content-Security-Policy'])
        self.assertNotIn('Access-Control-Allow-Origin',headers)
        self.assertEqual(self.calls,[])

    def test_host_origin_and_session_all_required(self):
        token=self.server.state.bootstrap_token
        self.assertEqual(self.req('GET','/bootstrap?token='+token,headers={'Host':'attacker.example'})[0],403)
        self.assertEqual(self.server.state.bootstrap_token,token)
        self.assertEqual(self.req('POST','/api/upload',png_bytes(),{'Origin':self.origin,'Content-Type':'image/png'})[0],401)
        self.login()
        for origin in [None,'null','http://attacker.example','http://localhost:'+str(self.server.server_port)]:
            headers={'Content-Type':'image/png'}
            if origin is not None:headers['Origin']=origin
            self.assertEqual(self.req('POST','/api/upload',png_bytes(),headers)[0],403)
        self.assertEqual(self.req('POST','/api/upload',png_bytes(),{'Host':'evil','Origin':self.origin,'Content-Type':'image/png'})[0],403)
        self.assertEqual(self.calls,[])

    def test_image_upload_preview_and_server_owned_extract(self):
        self.login();data=png_bytes();status,result=self.upload(data)
        self.assertEqual(status,200);doc=result['document'];self.assertEqual(doc['source_sha256'],hashlib.sha256(data).hexdigest())
        status,headers,preview=self.req('GET',doc['pages'][0]['preview_url'])
        self.assertEqual(status,200);self.assertEqual(headers['Content-Type'],'image/png')
        self.assertEqual(Image.open(io.BytesIO(preview)).size,(24,16))
        status,response=self.extract(doc);self.assertEqual(status,200);self.assertEqual(response['state'],'validated_unreviewed')
        spec=self.calls[0]['images'][0]
        self.assertEqual(spec['page'],1);self.assertEqual(spec['source_document_sha256'],hashlib.sha256(data).hexdigest())
        self.assertNotIn('path',spec);self.assertEqual(base64.b64decode(spec['image_base64']),preview)
        for extra in [{'model':'evil'},{'endpoint':'https://evil'},{'path':'/etc/passwd'},{'roi_px':[0,0,1,1]},{'operation':'other'}]:
            self.assertEqual(self.extract(doc,extra=extra)[0],400)
        self.assertEqual(self.extract(doc,page=True)[0],400)
        self.assertEqual(len(self.calls),1)
        self.assertEqual(self.req('GET','/../../provider.py')[0],404)

    def test_real_pdf_render_preserves_original_sha_and_page_number(self):
        self.login();data=pdf_bytes(2);status,result=self.upload(data,'application/pdf','example.pdf')
        self.assertEqual(status,200);doc=result['document'];self.assertEqual(doc['page_count'],2)
        self.assertEqual(doc['kind'],'pdf');self.assertEqual(doc['source_sha256'],hashlib.sha256(data).hexdigest())
        self.assertEqual(doc['pages'][1]['width'],4000);self.assertEqual(doc['pages'][1]['height'],2000)
        status,response=self.extract(doc,page=2);self.assertEqual(status,200)
        spec=self.calls[0]['images'][0]
        self.assertEqual(spec['source_document_sha256'],hashlib.sha256(data).hexdigest());self.assertEqual(spec['page'],2)
        rendered=base64.b64decode(spec['image_base64']);self.assertEqual(Image.open(io.BytesIO(rendered)).size,(4000,2000))
        self.assertNotEqual(hashlib.sha256(rendered).hexdigest(),hashlib.sha256(data).hexdigest())

    def test_pdf_dependency_and_limits_are_explicit(self):
        self.login()
        with patch.object(wb,'pdf_module',return_value=None):
            status,result=self.upload(b'%PDF-1.7\nnot-rendered','application/pdf','x.pdf')
        self.assertEqual(status,501);self.assertEqual(result['error'],'pdf_dependency_missing')
        status,result=self.upload(pdf_bytes(21),'application/pdf','long.pdf')
        self.assertEqual(status,413);self.assertEqual(result['error'],'pdf_page_limit')
        status,result=self.upload(pdf_bytes(7),'application/pdf','too-many-pixels.pdf')
        self.assertEqual(status,413);self.assertEqual(result['error'],'pdf_pixel_limit')
        self.assertEqual(self.calls,[])

    def test_failure_audit_is_not_validated_and_secrets_are_redacted(self):
        self.login();_,result=self.upload(png_bytes());doc=result['document']
        def failure(value):
            raise ProviderFailure('invalid_model_output','fake-provider-secret-never-network rejected',
                                  {'raw_response_text_redacted':'candidate text fake-provider-secret-never-network','authorization':'Bearer abc'})
        self.server.state.dispatch=failure
        status,result=self.extract(doc)
        self.assertEqual(status,502);self.assertEqual(result['state'],'failed_candidate')
        self.assertFalse(result['structured_fields_accepted']);self.assertNotIn('fake-provider-secret',json.dumps(result))
        self.assertEqual(result['audit']['authorization'],'[REDACTED]')

    def test_health_and_assets_do_not_claim_provider_connection(self):
        status,_,body=self.req('GET','/health');self.assertEqual(status,200)
        self.assertFalse(json.loads(body)['provider_connectivity_tested']);self.assertEqual(self.calls,[])
        self.login()
        for path,mime in [('/','text/html'),('/workbench.js','text/javascript'),('/workbench.css','text/css')]:
            status,headers,body=self.req('GET',path);self.assertEqual(status,200);self.assertTrue(headers['Content-Type'].startswith(mime));self.assertTrue(body)
        self.assertEqual(self.req('OPTIONS','/api/extract')[0],405)

    def test_partial_keeps_rejected_items_separate_and_complete(self):
        self.login();_,uploaded=self.upload(png_bytes());doc=uploaded['document']
        fixture=partial_fixture()
        self.server.state.dispatch=lambda value:{'result':fixture,'audit':{'model_payload_before_item_validation':fixture['model_payload_before_item_validation']}}
        status,response=self.extract(doc)
        self.assertEqual(status,200);self.assertEqual(response['state'],'partial_validated_unreviewed')
        self.assertEqual(len(response['result']['payload']['fields']),1)
        self.assertEqual(response['result']['payload']['bom'],[])
        self.assertEqual(response['result']['rejected_fields'],fixture['rejected_fields'])
        self.assertEqual(response['result']['rejected_bom'],fixture['rejected_bom'])
        self.assertEqual(response['result']['model_payload_before_item_validation'],fixture['model_payload_before_item_validation'])
        fixture['validation']['reference_links_valid']=False
        status,response=self.extract(doc)
        self.assertEqual(status,502);self.assertEqual(response['error'],'unvalidated_backend_result')

    def test_all_rejected_remains_failure_with_full_candidate_audit(self):
        self.login();_,uploaded=self.upload(png_bytes());doc=uploaded['document'];fixture=partial_fixture()
        def fail(value):
            raise ProviderFailure('no_valid_items','All item checks rejected candidates',
                                  {k:fixture[k] for k in ['model_payload_before_item_validation','rejected_fields','rejected_bom','item_validation_counts']})
        self.server.state.dispatch=fail
        status,response=self.extract(doc)
        self.assertEqual(status,502);self.assertEqual(response['state'],'failed_candidate')
        self.assertFalse(response['structured_fields_accepted'])
        self.assertEqual(response['audit']['rejected_fields'],fixture['rejected_fields'])
        self.assertNotIn('result',response)


def partial_fixture():
    accepted={'id':'accepted','name':'Accepted fixture','value_raw':'3.50','nominal_raw':'3.50','unit_raw':None,
              'tolerance':None,'limit_raw':None,'evidence_ids':['o1'],'association_evidence_ids':[],'object':None,'view':None,'state':None}
    rejected={'id':'rejected','name':'Unverified fixture','value_raw':'25 ±0.10','nominal_raw':'25','unit_raw':'MM',
              'tolerance':None,'limit_raw':None,'evidence_ids':['missing_ref'],'association_evidence_ids':[],
              'object':'Unsupported object','view':'Front','state':None,'original_extra':{'keep':'all original values'}}
    bom={'id':'bom_rejected','item_raw':'1','part_number_raw':'PART-8','name_raw':'Candidate part','quantity_raw':'99',
         'unit_raw':'PCS','material_raw':None,'evidence_ids':['o1']}
    observations=[{'id':'o1','image_id':'page1','raw_text':'3.50','region':None,'legibility':'clear'}]
    payload={'fields':[accepted],'bom':[],'observations':observations,'image_texts':[{'image_id':'page1','raw_text':'3.50'}],'missing_information':[]}
    return {'status':'partial_valid_unreviewed','model_requested':'fake','payload':payload,
            'validation':{'schema_valid':True,'reference_links_valid':True,'scope':'accepted_fields_and_bom_only','complete_document_valid':False},
            'model_payload_before_item_validation':{**payload,'fields':[accepted,rejected],'bom':[bom]},
            'rejected_fields':[{'item':rejected,'error':'Independent object evidence is absent','error_code':'item_contract_violation','status':'rejected_unreviewed'}],
            'rejected_bom':[{'item':bom,'error':'Quantity is not supported by evidence','error_code':'item_contract_violation','status':'rejected_unreviewed'}],
            'item_validation_counts':{'fields':{'total':2,'accepted':1,'rejected':1},'bom':{'total':1,'accepted':0,'rejected':1},'total':3,'accepted':1,'rejected':2}}


class PartialUITests(unittest.TestCase):
    def test_browser_render_logic_counts_candidates_and_preserves_failure_items(self):
        node=shutil.which('node')
        if not node:self.skipTest('Node is required for offline UI logic test')
        root=Path(wb.__file__).resolve().parent
        fixture={'state':'partial_validated_unreviewed','selected_page':1,'result':partial_fixture(),'audit':{}}
        # Minimal DOM doubles execute the actual production JS. No browser/network/model call.
        script=r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const html=fs.readFileSync(HTML,'utf8');const ids=[...html.matchAll(/id="([^"]+)"/g)].map(x=>x[1]);
class Element{constructor(tag='div'){this.tagName=tag;this.children=[];this.hidden=false;this._text='';this.dataset={};this.attributes={};this.listeners={};this.classList={toggle(){},add(){},remove(){}};}set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(x=>x.textContent||'').join(' ');}append(...xs){this.children.push(...xs);}replaceChildren(...xs){this._text='';this.children=xs;}setAttribute(k,v){this.attributes[k]=v;}addEventListener(k,v){this.listeners[k]=v;}scrollIntoView(){}click(){}}
const elements=Object.fromEntries(ids.map(id=>[id,new Element()]));
const tabs=['fields','candidates','raw','audit'].map(name=>{const e=new Element('button');e.dataset.tab=name;return e;});
const document={getElementById(id){assert(elements[id],`Missing real HTML id: ${id}`);return elements[id];},createElement(tag){return new Element(tag);},querySelectorAll(selector){return selector==='.tab'?tabs:[];}};
const context={document,console,setTimeout,URL,Blob,fetch:()=>Promise.resolve({ok:true,json:()=>Promise.resolve({configured:false,pdf_supported:true})})};
vm.createContext(context);vm.runInContext(fs.readFileSync(JS,'utf8'),context);context.fixture=FIXTURE;
vm.runInContext('display(fixture)',context);
assert.equal(elements.fieldCount.textContent,'1');assert.equal(elements.bomCount.textContent,'0');assert.equal(elements.candidateCount.textContent,'2');
assert.equal(elements.rejectedNotice.hidden,false);assert(elements.statusBadge.textContent.includes('部分通过'));
assert(elements.rejectedFieldList.textContent.includes('25 ±0.10'));assert(elements.rejectedFieldList.textContent.includes('Independent object evidence is absent'));
assert(elements.rejectedFieldList.textContent.includes('all original values'));assert(elements.rejectedFieldList.textContent.includes('missing_ref'));
assert(elements.rejectedBomList.textContent.includes('PART-8'));assert(elements.rejectedBomList.textContent.includes('99'));
assert(!elements.fieldList.textContent.includes('Unverified fixture'));
context.failed={state:'failed_candidate',error:'no_valid_items',audit:{rejected_fields:FIXTURE.result.rejected_fields,rejected_bom:FIXTURE.result.rejected_bom,model_payload_before_item_validation:FIXTURE.result.model_payload_before_item_validation}};
vm.runInContext('display(failed,true)',context);
assert.equal(elements.fieldCount.textContent,'0');assert.equal(elements.bomCount.textContent,'0');assert.equal(elements.candidateCount.textContent,'2');
assert.equal(elements['tab-candidates'].hidden,false);assert(elements.statusBadge.textContent.includes('未通过'));
assert(elements.rejectedFieldList.textContent.includes('25 ±0.10'));assert(elements.auditText.textContent.includes('original_extra'));
// Scope is declared only when returned. Legacy records are visibly unspecified.
assert(elements.scopeNotice.textContent.includes('此记录未声明提取范围'));
context.fixture.result.extraction_scope='visible_annotation_facts';
context.fixture.result.geometry_association_performed=false;
context.fixture.result.request_schema_sha256='fixture-schema-hash';
const before=JSON.stringify(context.fixture);
vm.runInContext('display(fixture)',context);
assert(elements.scopeNotice.textContent.includes('任务范围：标注提取'));
assert(elements.scopeNotice.textContent.includes('几何关系未自动确认'));
assert(elements.scopeNotice.textContent.includes('未执行几何关联'));
assert(elements.auditText.textContent.includes('visible_annotation_facts'));
assert(elements.auditText.textContent.includes('"geometry_association_performed": false'));
assert.equal(JSON.stringify(context.fixture),before,'Display must not edit original data or export');
// Main explanations are brief Chinese; exact errors stay in collapsed details.
const rejectedCard=elements.rejectedFieldList.children[0];
const reason=rejectedCard.children.find(child=>child.className==='rejection-reason');
assert(reason.textContent.includes('缺少对象、视图或状态的明确关联依据'));
assert(!reason.textContent.includes('Independent object evidence is absent'));
assert(rejectedCard.children.find(child=>child.tagName==='details').textContent.includes('Independent object evidence is absent'));
for(const [error,expected] of [
 ['Dimension observations cannot be reused or cloned as independent association evidence','尺寸文字被重复用作关联依据'],
 ['Dimension unit must be explicitly present in cited readable text; otherwise null','引用原文未明确写出该单位'],
 ['Numeric string is inconsistent with its reported evidence text','模型数值与引用原文不一致'],
 ['Visible-annotation task requires a neutral dimension name and unconfirmed object/view/state: wrong type','字段名称不符合本次标注提取规则；原值已保留，需复核命名'],
 ['Unrecognized future contract error','请展开查看原始错误']
]){context.entry={error};assert(vm.runInContext('rejectionExplanation(entry)',context).includes(expected));}
context.entry={error:'new task scope detail',error_code:'task_scope_violation'};
assert(vm.runInContext('rejectionExplanation(entry)',context).includes('本步仅提取标注'));
assert(html.includes('表格候选（BOM / 包装 / 料号表，待分类）'));
assert(elements.acceptedSummary.textContent.includes('表格候选（待分类'));
assert(elements.rejectedBomList.textContent.includes('表格候选'));
assert(!elements.rejectedBomList.textContent.includes('BOM候选'));
console.log('Actual UI: separate candidates, scope declaration, Chinese explanations, preserved raw errors and unclassified tables passed');
'''.replace('HTML',json.dumps(str(root/'static/workbench.html'))).replace('JS,',json.dumps(str(root/'static/workbench.js'))+',').replace('FIXTURE',json.dumps(fixture))
        # Replacing JS only at fs.readFileSync avoids altering normal identifier text.
        completed=subprocess.run([node],input=script,text=True,capture_output=True)
        self.assertEqual(completed.returncode,0,completed.stdout+'\n'+completed.stderr)


if __name__=='__main__':unittest.main()
