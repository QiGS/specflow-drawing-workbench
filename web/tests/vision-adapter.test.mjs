import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAndMapVision,mergeVisionResult,applyReferenceSuggestion} from '../vision-adapter.mjs';

const sha='a'.repeat(64);
function sample(){
  const doc={id:'doc',name:'source.pdf',contentId:sha,pages:[{page:1,text:'',rotation:0}],fields:[],bom:[],history:[]};
  const source={image_id:'p1',document_sha256:sha,page:1,rotation_clockwise:0,roi_normalized:{x:0,y:0,width:1,height:1}};
  const observation={id:'o1',image_id:'p1',kind:'visible_text',raw_text:'8.33 ±0.13 DIA',legibility:'clear',region:{x:.2,y:.3,width:.2,height:.1}};
  const field={id:'f1',name:'尺寸标注1',category:'dimension',value_raw:'8.33 ±0.13 DIA',nominal_raw:'8.33',unit_raw:null,tolerance:{raw:'±0.13',kind:'symmetric',amplitude_raw:'0.13',upper_raw:null,lower_raw:null,evidence_ids:['o1']},object:null,view:null,state:null,evidence_ids:['o1'],association_evidence_ids:[]};
  const input={schema_version:'1.0',operation:'extract_page',status:'valid_unreviewed',sources:[source],payload:{fields:[field],bom:[],observations:[observation],image_texts:[{image_id:'p1',raw_text:observation.raw_text}]},model_returned:'test-model'};
  return {doc,input};
}

test('maps evidence without approving or inventing unit / geometric association',async()=>{
  const {doc,input}=sample(),before=JSON.stringify(input);const mapped=await validateAndMapVision(doc,input);
  assert.equal(mapped.fields.length,1);const f=mapped.fields[0];assert.equal(f.numericValue,8.33);assert.equal(f.tolerance.raw,'±0.13');assert.equal(f.unit,'');assert.equal(f.object,null);assert.equal(f.status,'pending');assert.equal(f.provenance.documentSha256,sha);assert.equal(JSON.stringify(input),before);
});
test('rejects source fingerprint mismatch, unknown page and duplicate observation id',async()=>{
  for(const change of [i=>i.sources[0].document_sha256='b'.repeat(64),i=>i.sources[0].page=2,i=>i.payload.observations.push(i.payload.observations[0])]){
    const {doc,input}=sample();change(input);await assert.rejects(validateAndMapVision(doc,input));
  }
});
test('numeric, tolerance and unsupported unit errors stay as isolated original candidates',async()=>{
  for(const change of [f=>f.nominal_raw='88.33',f=>f.unit_raw='mm',f=>f.tolerance.amplitude_raw='0.31',f=>f.object='Ring Tongue']){
    const {doc,input}=sample();change(input.payload.fields[0]);const raw=structuredClone(input.payload.fields[0]);const mapped=await validateAndMapVision(doc,input);assert.equal(mapped.fields.length,0);assert.equal(mapped.quarantined.length,1);assert.deepEqual(mapped.quarantined[0].item,raw);
  }
});
test('preserves backend quarantine and keeps model table rows out of BOM',async()=>{
  const {doc,input}=sample();input.status='partial_valid_unreviewed';input.rejected_fields=[{item:input.payload.fields[0],error:'original failure'}];input.payload.bom=[{id:'table1',part_number:'P1',quantity_raw:'2500',evidence_ids:['o1']}];
  const mapped=await validateAndMapVision(doc,input);assert.equal(mapped.fields.length,0);assert.equal(mapped.quarantined.length,2);const merged=mergeVisionResult(doc,mapped);assert.deepEqual(merged.bom,[]);
});
test('maps ROI and rotation to the displayed source page',async()=>{
  const {doc,input}=sample();input.sources[0].roi_normalized={x:.5,y:0,width:.5,height:1};doc.pages[0].rotation=90;
  const {fields}=await validateAndMapVision(doc,input);const r=fields[0].region;assert.ok(Math.abs(r.x-.6)<1e-9);assert.ok(Math.abs(r.y-.6)<1e-9);assert.equal(r.width,.1);assert.equal(r.height,.1);
});
test('merging preserves human edits and rejects duplicate import',async()=>{
  const {doc,input}=sample();doc.fields=[{id:'manual',name:'尺寸标注1',value:'8.34',numericValue:8.34,page:1,status:'approved',userEdited:true}];
  const mapped=await validateAndMapVision(doc,input),merged=mergeVisionResult(doc,mapped);assert.deepEqual(merged.fields[0],doc.fields[0]);assert.equal(merged.fields[1].status,'pending');assert.equal(merged.fields[1].requiresReconciliation,true);assert.equal(doc.fields.length,1);assert.throws(()=>mergeVisionResult(merged,mapped),/已经导入/);
});
test('unit and general tolerance linkage needs explicit same-page confirmation and does not approve fields',()=>{
  const {doc}=sample();doc.fields=[{id:'dim',category:'dimension',page:1,unit:'',tolerance:{raw:'±0.13'},status:'approved'}];doc.referenceSuggestions=[{id:'unit',kind:'unit_declaration',raw:'DIMENSIONS IN mm [INCHES]',source:{page:1},units:['mm','INCHES'],appliedToFieldIds:[]},{id:'tol',kind:'general_tolerance',raw:'2 PLC DEC ±0.20',source:{page:1},appliedToFieldIds:[]}];
  assert.throws(()=>applyReferenceSuggestion(doc,'unit',['dim'],{unit:'mm'}));assert.throws(()=>applyReferenceSuggestion(doc,'unit',['dim'],{unit:'cm',confirmed:true}));
  const linked=applyReferenceSuggestion(doc,'unit',['dim'],{unit:'mm',confirmed:true});assert.equal(linked.fields[0].unit,'mm');assert.equal(linked.fields[0].status,'pending');assert.equal(doc.fields[0].unit,'');
  const referenced=applyReferenceSuggestion(linked,'tol',['dim'],{confirmed:true});assert.deepEqual(referenced.fields[0].tolerance,{raw:'±0.13'});assert.deepEqual(referenced.fields[0].generalToleranceReferences,['tol']);
});
