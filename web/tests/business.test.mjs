import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileQuote,quoteIssues,applyHistoricalPrices,reviewSamples} from '../business.mjs';
import {parseDocument,editDimension} from '../engine.mjs';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const bom=[{partNumber:'M4',name:'Screw',material:'Steel',unit:'pcs',qty:4}];
test('BOM edits preserve matching prices and invalidate confirmation',()=>{
 const doc={bom};doc.quote=reconcileQuote(doc);doc.quote.rows[0].unitPrice=2;doc.quote.priceReference='Supplier Q1';
 const changed=reconcileQuote({...doc,bom:[{...bom[0],qty:6}]});
 assert.equal(changed.rows[0].qty,6);assert.equal(changed.rows[0].unitPrice,2);assert.equal(changed.needsReview,true);
 assert.match(quoteIssues(changed).join(),/BOM/);
 const replaced=reconcileQuote({...doc,bom:[{...bom[0],material:'Brass'}]});assert.equal(replaced.rows[0].unitPrice,null);
});
test('empty and unpriced drafts cannot export',()=>{
 const q=reconcileQuote({bom}); assert.match(quoteIssues(q).join(),/单价/);
 q.rows[0].unitPrice=0;assert.match(quoteIssues(q).join(),/单价/);
 q.rows[0].unitPrice=2;q.priceReference='test scenario';assert.deepEqual(quoteIssues(q),[]);
});
test('historical prices require exact material identity and fresh review',()=>{
 const q=reconcileQuote({bom:[...bom,{...bom[0],partNumber:'M5'}]});
 const history={document:'actual assembly',at:'2026-11-08',rows:[{...bom[0],source:'bom',unitPrice:3}]};
 const {quote,matched}=applyHistoricalPrices(q,history);assert.equal(matched,1);assert.equal(quote.rows[0].unitPrice,3);assert.equal(quote.rows[1].unitPrice,null);assert.equal(quote.needsReview,true);
 assert.equal(q.rows[0].unitPrice,null);
});
test('reviews export evidence and decision without claiming training',()=>{
 const records=reviewSamples([{id:'d1',name:'drawing',contentId:'sha',fields:[{id:'f1',name:'长度',value:'4 mm',status:'approved',page:2,evidence:'Length 4 mm'},{id:'f2',status:'pending'}],history:[{fieldId:'f1',action:'review',field:'长度',value:'4 mm',page:2}]}]);
 assert.equal(records.length,1);assert.equal(records[0].page,2);assert.equal(records[0].reviewEvents.length,1);assert.equal(records[0].trainingStatus,'not_trained');
});

test('reparsed field IDs cannot attach another field or value to review samples',()=>{
 const before=parseDocument([{page:1,text:'Length: 20 mm\nMaterial: Steel'}]);
 const after=parseDocument([{page:1,text:'Material: Steel\nLength: 30 mm'}]);
 after.fields.forEach(f=>{f.status='approved';});
 const oldLength={action:'复核',fieldId:before.fields[0].id,field:'长度',value:'20 mm',page:1,decision:'approved'};
 const current={action:'复核',fieldId:after.fields[0].id,field:'材料',value:'Steel',page:1,decision:'approved'};
 const history=[oldLength,current,{...current,page:2},{...current,value:'Brass'},{fieldId:current.fieldId,action:'legacy review'}];
 const samples=reviewSamples([{id:'drawing',...after,history}]);
 assert.deepEqual(samples[0].reviewEvents,[current]);assert.deepEqual(samples[1].reviewEvents,[]);
 // Reusing the same ID and name after a value change is also insufficient.
 const changed=parseDocument([{page:1,text:'Length: 30 mm'}]);changed.fields[0].status='approved';
 assert.deepEqual(reviewSamples([{...changed,history:[oldLength]}])[0].reviewEvents,[]);
 assert.equal(history.length,5); // The full document audit remains intact.
});

test('actual workspace field edits synchronize and clear all derived dimension values',async()=>{
 const source=await readFile(new URL('../workspace.mjs',import.meta.url),'utf8');
 // Run the production change handler with a minimal UI shell; do not duplicate its update logic.
 const start=source.indexOf('app.onchange=async e=>');
 const end=source.indexOf("\n$('#backup')",start);
 assert(start>=0&&end>start);
 const doc={...parseDocument([{page:1,text:'Dimensions: 10 x 20 mm'}]),history:[]};
 let saves=0;
 const context=vm.createContext({app:{},active:()=>doc,parse:pages=>parseDocument(pages),editDimension,audit:(d,action,details)=>d.history.push({action,...details}),save:async()=>{saves++;},toast:message=>assert.fail(message),draw:()=>{}});
 vm.runInContext(source.slice(start,end),context);
 await context.app.onchange({target:{dataset:{field:'0'},value:'30 x 40 mm'}});
 assert.equal(doc.fields[0].numericValue,null);assert.deepEqual(doc.fields[0].numericValues,[30,40]);
 assert.deepEqual(doc.fields[0].measurements.map(m=>m.value),[30,40]);assert.equal(doc.fields[0].unit,'mm');
 await context.app.onchange({target:{dataset:{field:'0'},value:'pending verification'}});
 assert.equal(doc.fields[0].numericValue,null);assert.equal(doc.fields[0].numericValues.length,0);assert.equal(doc.fields[0].measurements.length,0);
 assert.equal(doc.fields[0].unit,'');assert.equal(doc.fields[0].tolerance,null);assert.equal(saves,2);
});
test('repeated BOM page items cannot silently double charge and rejected rows are omitted',()=>{
 const data=[{...bom[0],item:'1',page:1},{...bom[0],item:'1',page:2}];
 assert.match(quoteIssues(reconcileQuote({bom:data})).join(),/重复/);
 data[0].status='rejected';const q=reconcileQuote({bom:data});assert.equal(q.rows.length,1);assert.equal(q.duplicateBOM,false);
});
