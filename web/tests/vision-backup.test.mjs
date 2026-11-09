import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreBackup} from '../backup.mjs';
import {validateAndMapVision,mergeVisionResult,applyReferenceSuggestion} from '../vision-adapter.mjs';

const sha='a'.repeat(64),at='2026-11-09T01:02:03.000Z';
async function fixture(){
  const doc={id:'source',name:'source.pdf',contentId:sha,pages:[{page:1,text:'',rotation:0}],fields:[],bom:[],history:[],warnings:[]};
  const box={x:.1,y:.1,width:.3,height:.1};
  const observations=[
    ['o1','8.33 ±0.13 DIA'],['o2','DIMENSIONS IN mm [INCHES]\nTOLERANCES: 2 PLC DEC ±0.20'],
    ['o3','QUANTITY PACKAGE TYPE PART NO'],['o4','7 2500 ON TAPE REEL PN-100'],
  ].map(([id,raw_text])=>({id,image_id:'p1',kind:'visible_text',raw_text,legibility:'clear',region:{...box}}));
  const field={id:'f1',name:'尺寸标注1',category:'dimension',value_raw:'8.33 ±0.13 DIA',nominal_raw:'8.33',unit_raw:null,
    tolerance:{raw:'±0.13',kind:'symmetric',amplitude_raw:'0.13',upper_raw:null,lower_raw:null,evidence_ids:['o1']},
    object:null,view:null,state:null,evidence_ids:['o1'],association_evidence_ids:[],review_status:'pending'};
  const input={schema_version:'1.0',operation:'extract_page',status:'valid_unreviewed',model_returned:'fixture-model',
    sources:[{image_id:'p1',document_sha256:sha,page:1,rotation_clockwise:0,roi_normalized:{x:0,y:0,width:1,height:1}}],
    payload:{fields:[field,{...structuredClone(field),id:'bad',nominal_raw:'88.33'}],bom:[{id:'b1',part_number:'PN-100',quantity_raw:'2500',evidence_ids:['o4'],review_status:'pending'}],
      observations,image_texts:[{image_id:'p1',raw_text:observations.map(o=>o.raw_text).join('\n')}]}};
  const merged=mergeVisionResult(doc,await validateAndMapVision(doc,input));
  return {version:1,documents:[merged]};
}

test('visual import round-trips nullable associations, raw candidate values, provenance, references and packaging separately from BOM',async()=>{
  const data=await fixture(),before=structuredClone(data),[doc]=restoreBackup(data);
  assert.deepEqual(doc,data.documents[0]);assert.equal(doc.fields[0].object,null);
  assert.equal(doc.referenceSuggestions.length,2);assert.equal(doc.packagingVariants.length,1);assert.equal(doc.visionQuarantine.length,2);
  assert.equal(doc.packagingVariants[0].quantityRaw,'2500');assert.equal(doc.packagingVariants[0].notesRaw,'7 ');assert.deepEqual(doc.bom,[]);
  doc.visionRuns[0].sources[0].page=99;doc.fields[0].rawVisionField.value_raw='changed';
  assert.deepEqual(data,before,'all restored provenance must be detached from the input');
});

test('preserves manual unit/reference/geometry/value edits and an existing last matching human review event',async()=>{
  const data=await fixture();let doc=data.documents[0];const id=doc.fields[0].id;
  const unit=doc.referenceSuggestions.find(s=>s.kind==='unit_declaration'),tol=doc.referenceSuggestions.find(s=>s.kind==='general_tolerance');
  doc=applyReferenceSuggestion(doc,unit.id,[id],{confirmed:true,unit:'mm'});
  doc=applyReferenceSuggestion(doc,tol.id,[id],{confirmed:true});
  const f=doc.fields[0];f.object='人工核对的孔';f.view='A-A';f.state='打开';f.value='8.34 ±0.13 DIA';f.numericValue=8.34;
  doc.history.push({at,action:'人工标注关联',fieldId:id,key:'object',before:null,after:f.object},{at,action:'修改字段',fieldId:id,before:'8.33 ±0.13 DIA',after:f.value});
  f.status='approved';doc.history.push({at,action:'复核',fieldId:id,field:f.name,value:f.value,page:1,decision:'approved'});
  data.documents[0]=doc;const [restored]=restoreBackup(data);assert.deepEqual(restored,doc);
  assert.equal(restored.fields[0].rawVisionField.nominal_raw,'8.33','manual changes never rewrite the model snapshot');
  assert.equal(restored.fields[0].rawVisionField.review_status,'pending');
});

test('bare candidate approvals, quarantined approvals and packaging approvals cannot become engineering approvals',async()=>{
  const data=await fixture(),doc=data.documents[0];doc.fields[0].status='approved';doc.fields[0].rawVisionField.review_status='approved';
  doc.visionQuarantine[0].status='approved';doc.visionQuarantine[0].item.review_status='approved';
  doc.packagingVariants[0].status='approved';doc.packagingVariants[0].rawVariant.engineering_value_approved=true;
  doc.referenceSuggestions[0].status='approved';doc.referenceSuggestions[0].rawSuggestion.engineering_value_approved=true;
  const [r]=restoreBackup(data);assert.equal(r.fields[0].status,'pending');assert.equal(r.fields[0].rawVisionField.review_status,'pending');
  assert.equal(r.visionQuarantine[0].status,undefined);assert.equal(r.visionQuarantine[0].item.review_status,'pending');
  assert.equal(r.packagingVariants[0].status,'pending');assert.equal(r.packagingVariants[0].rawVariant.engineering_value_approved,false);
  assert.equal(r.referenceSuggestions[0].status,'pending_review');assert.equal(r.referenceSuggestions[0].rawSuggestion.engineering_value_approved,false);
});

test('unit provenance must match a linked unit declaration while direct manual units remain restorable',async()=>{
  const data=await fixture(),doc=data.documents[0],f=doc.fields[0],unit=doc.referenceSuggestions.find(s=>s.kind==='unit_declaration');
  data.documents[0]=applyReferenceSuggestion(doc,unit.id,[f.id],{confirmed:true,unit:'mm'});
  for(const mutate of [
    d=>d.fields[0].unitSource.observationId='missing-observation',
    d=>d.fields[0].unitSource.raw='b'.repeat(64),
    d=>d.referenceSuggestions.find(s=>s.id===unit.id).appliedToFieldIds=[],
  ]){const invalid=structuredClone(data);mutate(invalid.documents[0]);assert.throws(()=>restoreBackup(invalid),/单位引用缺少/);}
  assert.deepEqual(restoreBackup(data)[0],data.documents[0]);
  for(const source of [null,'人工核对']){const manual=structuredClone(data);manual.documents[0].fields[0].unitSource=source;assert.equal(restoreBackup(manual)[0].fields[0].unitSource,source);}
});

test('last review must match current field value and page and cannot precede a later edit',async()=>{
  for(const change of [d=>d.fields[0].value='another value',d=>d.history.at(-1).page=2,d=>d.history.push({at,action:'人工单位确认',fieldId:d.fields[0].id,before:'',after:'mm'})]){
    const data=await fixture(),d=data.documents[0],f=d.fields[0];f.status='approved';d.history.push({at,action:'复核',fieldId:f.id,field:f.name,value:f.value,page:1,decision:'approved'});
    change(d);assert.equal(restoreBackup(data)[0].fields[0].status,'pending');
  }
  const data=await fixture(),d=data.documents[0],f=d.fields[0];f.status='rejected';d.history.push({at,action:'复核',fieldId:f.id,value:f.value,page:1,decision:'rejected'});
  assert.equal(restoreBackup(data)[0].fields[0].status,'rejected');
});

test('rejects orphan/cross-document/cross-page vision provenance and broken reference links atomically',async()=>{
  const base=await fixture();
  const changes=[
    d=>d.visionRuns=[],d=>d.visionRuns[0].sourceSha256='b'.repeat(64),d=>d.visionRuns[0].sources[0].document_sha256='b'.repeat(64),
    d=>d.fields[0].provenance.imageId='unknown',d=>d.fields[0].provenance.evidenceIds=['wrong'],d=>d.visionQuarantine[0].runId='b'.repeat(64),
    d=>d.referenceSuggestions[0].source.page=2,d=>d.referenceSuggestions[0].appliedToFieldIds=['missing'],
    d=>d.fields[0].generalToleranceReferences=['missing'],d=>d.packagingVariants[0].rawVariant.assembly_quantity_raw='2500',
    d=>d.visionRuns[0].counts.total=20,d=>d.visionRuns.push(structuredClone(d.visionRuns[0])),
  ];
  for(const mutate of changes){const data=structuredClone(base);mutate(data.documents[0]);const before=structuredClone(data);assert.throws(()=>restoreBackup(data),/备份格式无效/);assert.deepEqual(data,before);}
});

test('drops provider audits/credentials/media extras while retaining raw engineering text and human history',async()=>{
  const data=await fixture(),d=data.documents[0],run=d.visionRuns[0];
  d.audit={api_key:'fixture-not-a-key',raw_response:'fixture-audit'};
  run.raw_response={request_payload:{image_url:'data:image/png;base64,YQ=='}};
  run.apiKey='fixture-not-a-key';run.sources[0].endpoint='https://example.invalid';run.sources[0].image_url='data:image/png;base64,YQ==';
  d.fields[0].rawVisionField.authorization='Bearer fixture-not-a-key';d.fields[0].rawVisionField.audit={ignored:true};
  d.visionQuarantine[0].item.raw_response_text_redacted='fixture-audit';
  d.fields[0].value='<script>shown as text by UI</script>';
  const [r]=restoreBackup(data),encoded=JSON.stringify(r);
  assert.equal(encoded.includes('fixture-not-a-key'),false);assert.equal(encoded.includes('fixture-audit'),false);assert.equal(encoded.includes('base64'),false);
  assert.equal(r.visionRuns[0].sources[0].endpoint,undefined);assert.equal(r.fields[0].value,d.fields[0].value);assert.deepEqual(r.history,d.history);
});

test('enforces vision quotas and rejects embedded media in text without disabling legacy raster thumbnails',async()=>{
  const base=await fixture();
  for(const mutate of [
    d=>d.visionRuns=Array.from({length:101},()=>structuredClone(d.visionRuns[0])),
    d=>d.visionRuns[0].rawTexts[0].text='x'.repeat(200001),
    d=>d.visionQuarantine=Array.from({length:6001},()=>structuredClone(d.visionQuarantine[0])),
    d=>d.fields[0].rawVisionField.value_raw='data:image/png;base64,YQ==',
    d=>d.fields[0].rawVisionField.tolerance.amplitude_raw=Infinity,
  ]){const data=structuredClone(base);mutate(data.documents[0]);assert.throws(()=>restoreBackup(data),/备份格式无效/);}
  base.documents[0].thumbnail='data:image/png;base64,YQ==';base.documents[0].fields[0].sourceSnapshot={preview:'data:image/png;base64,YQ==',rotation:0};
  assert.equal(restoreBackup(base)[0].thumbnail,'data:image/png;base64,YQ==');
});
