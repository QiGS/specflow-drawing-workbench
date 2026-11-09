import test from 'node:test';
import assert from 'node:assert/strict';
import {createVisionUI,visionResults,visionReason,visionFailure,visionPageSelection} from '../vision-ui.mjs';
function setup(options={}){
 let doc={id:'document-1',name:'drawing.pdf',contentId:'a'.repeat(64),pages:[{page:1},{page:2}],file:{name:'drawing.pdf'},fields:[],history:[]};
 const saved=[],requests=[],nodes=new Map(),messages=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',disabled:false,checked:false});return nodes.get(id);};
 const rendered={image_base64:'aW1hZ2U=',width:4000,height:2590,source_document_sha256:doc.contentId,page:2};
 const deps={getDocument:()=>doc,saveDocument:async value=>{saved.push(value);doc=value;},validateAndMapVision:async()=>({fields:[{id:'f1',status:'pending'}]}),mergeVisionResult:(value,mapped)=>({...value,fields:[...value.fields,...mapped.fields]}),renderVisionPage:async(file,page)=>({...rendered,page}),redraw:()=>{},showSource:()=>{},setStatus:value=>messages.push(value),toast:()=>{},getNode:node,fetcher:async(path,options)=>{requests.push({path,options});return {ok:true,status:200,json:async()=>({result:{payload:{}}})};},...options};
 const ui=createVisionUI(deps);ui.setPage(doc,2);
 return {ui,node,saved,requests,messages,doc:()=>doc,setDoc:value=>doc=value};
}
test('cloud extraction requires explicit consent and sends only selected image contract',async()=>{
 const h=setup();await assert.rejects(h.ui.run(),/勾选确认/);assert.equal(h.requests.length,0);
 h.node('#visionConsent').checked=true;await h.ui.run();assert.equal(h.requests.length,1);
 assert.equal(h.requests[0].path,'/api/vision-extract');const body=JSON.parse(h.requests[0].options.body);
 assert.deepEqual(body,{operation:'extract_page',images:[{image_base64:'aW1hZ2U=',image_id:'page_2',page:2,source_document_sha256:'a'.repeat(64)}]});
 assert(!('width' in body.images[0]));assert.equal(h.saved.length,1);assert.equal(h.saved[0].fields[0].status,'pending');
});
test('JSON import uses mapper without network and preserves latest human edits',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);const h=setup({validateAndMapVision:async(doc,input)=>{assert.equal(input.result.status,'partial_valid_unreviewed');await gate;return {fields:[{id:'vision'}]};}});
 const pending=h.ui.importResult({size:100,text:async()=>JSON.stringify({result:{status:'partial_valid_unreviewed'},audit:{}})});
 await new Promise(resolve=>setImmediate(resolve));h.setDoc({...h.doc(),fields:[{id:'human',status:'approved',value:'manual'}]});release();await pending;
 assert.equal(h.requests.length,0);assert.deepEqual(h.saved[0].fields.map(f=>f.id),['human','vision']);assert.equal(h.saved[0].fields[0].status,'approved');
});
test('invalid JSON, mapper rejection and oversized input do not write data',async()=>{
 const h=setup({validateAndMapVision:async()=>{throw Error('原文件 SHA 不匹配');}});
 await assert.rejects(h.ui.importResult({size:3,text:async()=>'{invalid'}));
 await assert.rejects(h.ui.importResult({size:3,text:async()=>'{}'}),/SHA/);
 await assert.rejects(h.ui.importResult({size:11*1024*1024,text:async()=>'{}'}),/10 MiB/);
 assert.equal(h.saved.length,0);assert.equal(h.requests.length,0);assert.equal(h.ui.state.busy,false);
});
test('cancellation during rendering never sends or saves and resets controls',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);const h=setup({renderVisionPage:async()=>{await gate;return {image_base64:'unused'};}});h.node('#visionConsent').checked=true;
 const pending=h.ui.run();h.ui.cancel();release();await pending;assert.equal(h.requests.length,0);assert.equal(h.saved.length,0);assert.equal(h.ui.state.busy,false);assert.match(h.ui.state.message,/停止等待/);
});
test('cancellation after send prevents a late response from being saved',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);const h=setup({fetcher:async()=>{await gate;return {ok:true,status:200,json:async()=>({result:{}})};}});h.node('#visionConsent').checked=true;
 const pending=h.ui.run();await new Promise(resolve=>setImmediate(resolve));h.ui.cancel();release();await pending;assert.equal(h.saved.length,0);assert.match(h.ui.state.message,/可能仍在服务端处理/);
});
test('unavailable API explains local import and failed status cannot claim configured',async()=>{
 const h=setup({fetcher:async()=>({ok:false,status:503,json:async()=>({configured:true,message:'not configured'})})});h.node('#visionConsent').checked=true;
 const status=await h.ui.checkService();assert.equal(status.configured,false);await h.ui.run();assert.match(h.ui.state.message,/云识图未配置/);assert.match(h.ui.state.message,/导入本机/);assert.equal(h.saved.length,0);
});
test('source page selection and result HTML keep untrusted raw text escaped and packaging separate',()=>{
 const doc={id:'x',name:'<img onerror="bad">',contentId:'abc',fields:[{id:'field',category:'dimension',name:'寸',value:'3.2',page:1}],pages:[{page:1},{page:3}],visionRuns:[],visionQuarantine:[{item:{name:'<script>bad</script>',value_raw:'4 ±.1'},error:'Numeric string is inconsistent',page:1}],referenceSuggestions:[{id:'r',kind:'unit_declaration',raw:'<img src=x onerror=bad>',source:{page:1},status:'pending_review'}],packagingVariants:[{partNumber:'P1',quantityRaw:'2500',raw:'PACKAGING',page:1}]};
 const html=visionResults(doc);assert(!html.includes('<script>bad'));assert(html.includes('&lt;script&gt;'));assert(!html.includes('<img src=x'));assert(html.includes('包装数量不等于装配用量'));assert(html.includes('id="visionRefConfirm0"'));assert(html.includes('人工采纳单位并留痕'));assert.equal(doc.bom,undefined);
 assert.equal(visionPageSelection(doc,3),3);assert.equal(visionPageSelection(doc,2),1);
 assert.match(visionReason({error:'Visible-annotation task requires a neutral dimension name'}),/复核命名/);assert.match(visionFailure(Error('x'),404),/云识图未配置/);
});

test('JSON import has a native keyboard-operable button and busy state blocks the file picker',()=>{
 const h=setup();let clicks=0;h.node('#visionImport').click=()=>clicks++;
 let html=h.ui.controls(h.doc());assert.match(html,/<button id="visionImportButton" type="button"[^>]*>导入视觉结果 JSON<\/button>/);assert.match(html,/<input id="visionImport"[^>]* hidden>/);
 h.ui.openImport();assert.equal(clicks,1);
 h.ui.state.busy=true;h.ui.update();h.ui.openImport();assert.equal(clicks,1);assert.equal(h.node('#visionImportButton').disabled,true);assert.equal(h.node('#visionImport').disabled,true);
 html=h.ui.controls(h.doc());assert.match(html,/<button id="visionImportButton" type="button" disabled>/);
 h.ui.state.busy=false;h.ui.update();assert.equal(h.node('#visionImportButton').disabled,false);
});
