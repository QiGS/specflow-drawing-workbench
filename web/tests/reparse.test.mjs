import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileExtraction} from '../reparse.mjs';

const field=(id,value,y=.2,extra={})=>({id,name:'尺寸标注',value,page:1,unit:'mm',evidence:value,region:{x:.2,y,width:.1,height:.02},status:'pending',...extra});
const row=(id,qty,extra={})=>({id,partNumber:'P-1',name:'螺钉',qty,page:1,evidence:'1 P-1 SCREW 4',region:{x:.6,y:.7,width:.2,height:.02},status:'pending',...extra});

test('reviewed and rejected fields keep their IDs, values and decisions despite new OCR IDs',()=>{
  const approved=field('human-a','12.5 mm',.2,{status:'approved'}),rejected=field('human-r','99 mm',.5,{status:'rejected'});
  const doc={fields:[approved,rejected],bom:[]};
  const next={fields:[field('field-1','12.6 mm'),field('field-2','99 mm',.501)],bom:[]};
  const result=reconcileExtraction(doc,next);
  assert.deepEqual(result.fields.map(f=>[f.id,f.value,f.status]),[['human-a','12.5 mm','approved'],['human-r','99 mm','rejected']]);
  assert.equal(result.fields[0].reparseCandidates[0].value,'12.6 mm');
  assert.equal(result.fields[0].reparseConflict,true);
  assert(result.fields.every(f=>f.preservedByReparse===true));
  assert.equal(doc.fields[0].reparseCandidates,undefined);assert.equal(next.fields[0].status,'pending');
});

test('manual edit, manual association and renamed field history are protected while pending',()=>{
  const doc={fields:[field('f-1','14 mm',.2,{name:'安装孔直径',object:'法兰孔'})],bom:[],history:[
    {action:'修改字段',fieldId:'f-1',before:'13 mm',after:'14 mm'},
    {action:'修改字段名',fieldId:'f-1',before:'尺寸标注',after:'安装孔直径'},
    {action:'人工标注关联',fieldId:'f-1',key:'object',after:'法兰孔'},
  ]};
  const out=reconcileExtraction(doc,{fields:[field('new','13 mm')],bom:[]});
  assert.equal(out.fields.length,1);assert.equal(out.fields[0].name,'安装孔直径');
  assert.equal(out.fields[0].object,'法兰孔');assert.equal(out.fields[0].value,'14 mm');assert.equal(out.fields[0].id,'f-1');
});

test('method manual and userEdited protect fields without requiring review-history records',()=>{
  const doc={fields:[field('m','1 mm',.2,{method:'manual'}),field('u','2 mm',.5,{userEdited:true})]};
  const out=reconcileExtraction(doc,{fields:[field('a','9 mm'),field('b','8 mm',.5)]});
  assert.deepEqual(out.fields.map(f=>f.value),['1 mm','2 mm']);
});

test('a distant candidate is a separate dimension and remains eligible while the protected field keeps its ID',()=>{
  const doc={fields:[field('field-1','10 mm',.2,{userEdited:true})],bom:[]};
  const out=reconcileExtraction(doc,{fields:[field('field-1','20 mm',.8)],bom:[]});
  assert.equal(out.fields.length,2);assert.equal(out.fields[0].status,'pending');assert.equal(out.fields[0].requiresReconciliation,false);
  assert.equal(out.fields[0].preservedByReparse,false);assert.equal(out.fields[1].preservedByReparse,true);
  assert.deepEqual(out.fields[0].possibleReviewedFieldIds,[]);assert.notEqual(out.fields[0].id,'field-1');
  assert.equal(out.fields[1].id,'field-1');assert.equal(out.fields[1].value,'10 mm');
});

test('ambiguous same-source protected dimensions are not arbitrarily merged',()=>{
  const doc={fields:[field('a','10 mm',.2,{status:'approved'}),field('b','11 mm',.2,{status:'rejected'})]};
  const out=reconcileExtraction(doc,{fields:[field('new','10.5 mm')]});
  assert.equal(out.fields.length,3);assert.equal(out.fields[0].requiresReconciliation,true);
  assert.deepEqual(out.fields.slice(1).map(f=>f.status),['approved','rejected']);
});

test('duplicate OCR candidates at one rejected source do not reintroduce the rejected field',()=>{
  const doc={fields:[field('r','10 mm',.2,{status:'rejected'})]};
  const out=reconcileExtraction(doc,{fields:[field('new-a','10 mm'),field('new-b','10.0 mm',.201)]});
  assert.equal(out.fields.length,1);assert.equal(out.fields[0].id,'r');assert.equal(out.fields[0].status,'rejected');
});

test('same evidence on different pages is never merged',()=>{
  const doc={fields:[field('old','10 mm',.2,{status:'approved'})]};
  const out=reconcileExtraction(doc,{fields:[field('new','10 mm',.2,{page:2})]});
  assert.equal(out.fields.length,2);assert.deepEqual(out.fields.map(f=>f.page),[2,1]);
});

test('identical numbers at distant positions are different dimensions, even if evidence text is equal',()=>{
  const doc={fields:[field('old','10 mm',.2,{status:'approved'})]};
  const out=reconcileExtraction(doc,{fields:[field('new','10 mm',.8)]});
  assert.equal(out.fields.length,2);assert.equal(out.fields[0].requiresReconciliation,false);
});

test('repeated text without usable positions cannot collapse several new dimensions into one review',()=>{
  const old=field('old','10 mm',.2,{status:'approved',region:undefined});
  const out=reconcileExtraction({fields:[old]},{fields:[field('a','10 mm',.2,{region:undefined}),field('b','10 mm',.5,{region:undefined})]});
  assert.equal(out.fields.length,3);assert.equal(out.fields.filter(f=>f.requiresReconciliation).length,2);
});

test('unreviewed extraction is replaced and empty new extraction keeps only protected fields',()=>{
  const doc={fields:[field('pending','8 mm'),field('approved','9 mm',.5,{status:'approved'})],bom:[]};
  const out=reconcileExtraction(doc,{fields:[],bom:[],warnings:['OCR为空']});
  assert.deepEqual(out.fields.map(f=>f.id),['approved']);assert(out.warnings.includes('OCR为空'));
});

test('a new unreviewed field reusing an old automatic ID is not marked as preserved',()=>{
  const old=field('field-1','8 mm'),fresh=field('field-1','9 mm',.8);
  const out=reconcileExtraction({fields:[old]},{fields:[fresh]});
  assert.equal(out.fields.length,1);assert.equal(out.fields[0].id,'field-1');assert.equal(out.fields[0].value,'9 mm');
  assert.equal(out.fields[0].preservedByReparse,false);
});

test('manual BOM quantity survives a reliable row match and rejects keep their IDs',()=>{
  const doc={fields:[],bom:[row('b-1',7,{status:'rejected'})],history:[{action:'修改BOM',before:row('b-1',4),key:'qty',value:7}]};
  const out=reconcileExtraction(doc,{fields:[],bom:[row('new-b',4)]});
  assert.equal(out.bom[0].qty,7);assert.equal(out.bom[0].id,'b-1');assert.equal(out.bom[0].status,'rejected');
});

test('uncertain or missing re-extracted BOM preserves the entire original table',()=>{
  const original=[row('b-1',7,{userEdited:true}),row('b-2',2,{partNumber:'P-2',region:{x:.6,y:.74,width:.2,height:.02}})];
  const doc={fields:[],bom:original};
  for(const bom of [[],[row('new',100,{partNumber:'OTHER',name:'OTHER',evidence:'OTHER',region:{x:.1,y:.1,width:.1,height:.02}})]]){
    const out=reconcileExtraction(doc,{fields:[],bom});
    assert.deepEqual(out.bom,original);assert.notEqual(out.bom,original);assert(out.warnings.some(w=>w.includes('完整保留原 BOM')));
  }
});

test('old BOM edits without a row ID conservatively protect all prior rows',()=>{
  const doc={fields:[],bom:[row('b',5)],history:[{action:'修改BOM',before:{qty:3},key:'qty',value:5}]};
  assert.equal(reconcileExtraction(doc,{fields:[],bom:[]}).bom[0].qty,5);
});
