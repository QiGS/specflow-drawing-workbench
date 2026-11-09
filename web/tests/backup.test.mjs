import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreBackup} from '../backup.mjs';
import {parseDocument,calculateQuote} from '../engine.mjs';
import {reconcileQuote} from '../business.mjs';
import {defaultRules,defaultTemplate} from '../instructions.mjs';

function fixture(){
  const pages=[{page:2,text:'Material: Steel\nItem | Part Number | Description | Qty | Unit\n1 | SS-1 | Tube | 162.36 | in.',method:'pdf-text',width:1200,height:800,regions:[{text:'Material: Steel',x:.1,y:.2,width:.3,height:.02}],thumbnail:'data:image/png;base64,YQ==',hash:'0'.repeat(64)}];
  const doc={id:'original-id',name:'drawing.pdf',pages,...parseDocument(pages),contentId:'a'.repeat(64),thumbnail:pages[0].thumbnail,hash:'1'.repeat(64),createdAt:'2026-11-08T03:00:00.000Z',history:[]};
  doc.fields[0].value='Aluminium（人工更正）';doc.fields[0].status='approved';
  doc.bom[0].qty=100.25;doc.bom[0].status='rejected';
  doc.history=[{at:doc.createdAt,action:'修改字段',fieldId:doc.fields[0].id,page:2,before:'Steel',after:doc.fields[0].value},{at:doc.createdAt,action:'修改BOM',before:{...doc.bom[0],qty:162.36},key:'qty',value:100.25}];
  doc.quote=reconcileQuote({...doc,bom:[{...doc.bom[0],status:'approved'}]});doc.quote.rows[0].unitPrice=8.2;doc.quote.priceReference='报价单 A';doc.quote.needsReview=true;
  doc.quoteHistory=[{id:'q1',at:doc.createdAt,document:doc.name,contentId:doc.contentId,...structuredClone(doc.quote),result:calculateQuote(doc.quote.rows,doc.quote.options),status:'reference',basis:'人工价格'}];
  doc.instructionRules=structuredClone(defaultRules);doc.instructionRules.version='custom-2';
  doc.instructionTemplate=structuredClone(defaultTemplate);doc.instructionTemplate.sections[0].fixedText='人工编制的适用范围';
  return {version:1,documents:[doc]};
}
test('restores all human review, corrected values, source geometry, audit, quote history and custom guidance without reparsing',()=>{
  const data=fixture(),before=structuredClone(data);const result=restoreBackup(data);
  assert.deepEqual(result,data.documents);assert.deepEqual(data,before);
  result[0].fields[0].value='new';result[0].quoteHistory[0].rows[0].unitPrice=99;
  assert.deepEqual(data,before,'restored objects must not alias backup inputs');
});
test('drops only original file and generated output; never dereferences a path or URL',()=>{
  const data=fixture();data.documents[0].file={path:'/private/secret.pdf',url:'https://example.invalid/private'};data.documents[0].generated={html:'<script>bad()</script>'};
  const [doc]=restoreBackup(data);assert(!Object.hasOwn(doc,'file'));assert(!Object.hasOwn(doc,'generated'));assert.equal(doc.contentId,data.documents[0].contentId);
});
test('legacy missing fields are parsed while existing BOM edits/history remain intact',()=>{
  const data=fixture();delete data.documents[0].fields;
  const [doc]=restoreBackup(data);assert.equal(doc.fields[0].value,'Steel');assert.equal(doc.fields[0].status,'pending');assert.deepEqual(doc.bom,data.documents[0].bom);assert.deepEqual(doc.history,data.documents[0].history);
  delete data.documents[0].bom;assert.equal(restoreBackup(data)[0].bom[0].qty,162.36);
});
test('an explicitly empty fields array is preserved without re-extracting rejected/deleted candidates',()=>{
  const data=fixture();data.documents[0].fields=[];assert.deepEqual(restoreBackup(data)[0].fields,[]);
});
test('enhanced drawing backup rejects malformed candidate arrays and remote previews',()=>{
 for(const key of ['otherCandidates','alternateMeasurements','unresolvedAnnotations','sourcePasses']){
  const data=fixture();data.documents[0].fields[0][key]='bad';assert.throws(()=>restoreBackup(data),/备份格式无效/);
 }
 const data=fixture();data.documents[0].fields[0].otherCandidates=[{value:'12 mm',evidence:'12',region:{x:2,y:0,width:1,height:1}}];assert.throws(()=>restoreBackup(data),/备份格式无效/);
 const remote=fixture();remote.documents[0].pages[0].preview='https://example.invalid/track';assert.throws(()=>restoreBackup(remote),/备份格式无效/);
});
test('rejects wrong root/version/array types with a Chinese format error',()=>{
  for(const bad of [null,[],{version:2,documents:[]},{version:1,documents:{}},{version:1,documents:[null]}])assert.throws(()=>restoreBackup(bad),/备份格式无效/);
  assert.deepEqual(restoreBackup({version:1,documents:[]}),[]);
});
test('rejects wrong field types, invalid page references, duplicate pages and invalid source coordinates',()=>{
  const changes=[d=>d.pages[0].page=0,d=>d.pages[0].page='2',d=>d.pages.push({...d.pages[0]}),d=>d.fields[0].page=1,d=>d.fields[0].value=42,d=>d.fields[0].status='trusted',d=>d.fields[0].region={x:.9,y:0,width:.2,height:.1},d=>d.pages[0].regions='bad',d=>d.history[0].page=-1,d=>d.pages[0].text=null];
  for(const mutate of changes){const data=fixture();mutate(data.documents[0]);assert.throws(()=>restoreBackup(data),/备份格式无效/);}
});
test('rejects nonfinite/string/negative quantities and prices and invalid rates',()=>{
  const changes=[d=>d.bom[0].qty=-1,d=>d.bom[0].qty='2',d=>d.bom[0].qty=NaN,d=>d.quote.rows[0].unitPrice=Infinity,d=>d.quote.rows[0].unitPrice=-.1,d=>d.quote.options.marginPercent=100,d=>d.quoteHistory[0].result.total='0',d=>d.fields[0].numericValue=Infinity];
  for(const mutate of changes){const data=fixture();mutate(data.documents[0]);assert.throws(()=>restoreBackup(data),/备份格式无效/);}
  const data=fixture();data.documents[0].quote.rows[0].unitPrice=null;assert.equal(restoreBackup(data)[0].quote.rows[0].unitPrice,null);
});
test('allows only inline raster thumbnails, never remote URLs, SVG or HTML',()=>{
  for(const value of ['https://example.com/a.png','file:///a.png','data:image/svg+xml;base64,YQ==','data:text/html;base64,YQ==','data:image/png;base64,invalid!']){
    const data=fixture();data.documents[0].pages[0].thumbnail=value;assert.throws(()=>restoreBackup(data),/缩略图/);
  }
  for(const mime of ['png','jpeg','webp']){const data=fixture();data.documents[0].thumbnail=`data:image/${mime};base64,YQ==`;assert.equal(restoreBackup(data)[0].thumbnail,data.documents[0].thumbnail);}
});
test('rejects malformed custom guidance, cycles and prototype pollution payloads',()=>{
  let data=fixture();data.documents[0].instructionRules.blockExportOnMissing='false';assert.throws(()=>restoreBackup(data),/作业指导书配置/);
  data=fixture();data.documents[0].instructionTemplate.sections=[];assert.throws(()=>restoreBackup(data),/作业指导书配置/);
  data=fixture();data.documents[0].history[0].loop=data.documents[0];assert.throws(()=>restoreBackup(data),/循环引用/);
  data=fixture();data.documents[0].history.push(JSON.parse('{"__proto__":{"polluted":true}}'));assert.throws(()=>restoreBackup(data),/不允许的属性/);assert.equal({}.polluted,undefined);
});
test('validation is atomic and does not mutate earlier valid documents if a later document fails',()=>{
  const data=fixture();data.documents.push({...structuredClone(data.documents[0]),fields:'invalid'});const before=structuredClone(data);
  assert.throws(()=>restoreBackup(data),/第 2 份资料/);assert.deepEqual(data,before);
});
test('keeps historical page references after page removal but rejects malformed arrays',()=>{
  const data=fixture();data.documents[0].history[0].page=9;
  assert.equal(restoreBackup(data)[0].history[0].page,9);
  data.documents[1]=structuredClone(data.documents[0]);delete data.documents[0];
  assert.throws(()=>restoreBackup(data),/空缺项/);
});
