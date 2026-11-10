import test from 'node:test';
import assert from 'node:assert/strict';
import {createGeometryLive,readGeometryStream,geometryTilePlan,geometryRequestBody,prepareGeometryImages} from '../geometry-live.mjs';
const sha='a'.repeat(64),png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1cAAAAASUVORK5CYII=';
const encode=value=>new TextEncoder().encode(value);
function response(events,{chunks,close=true,status=200}={}){const bytes=encode(events.map(e=>typeof e==='string'?e:JSON.stringify(e)).join('\n')+'\n');return new Response(new ReadableStream({start(controller){if(chunks){let offset=0;for(const size of chunks){controller.enqueue(bytes.slice(offset,offset+size));offset+=size;}if(offset<bytes.length)controller.enqueue(bytes.slice(offset));}else controller.enqueue(bytes);if(close)controller.close();}}),{status,headers:{'Content-Type':'application/x-ndjson'}});}
const result=()=>({schema_version:'geometry-2.0',document_sha256:sha,page:1,parameters:[],observations:[],unmapped_annotations:[]});
const rendered=()=>({page:1,width:1000,height:700,image_base64:png,source_document_sha256:sha});
const images=()=>[{image_base64:png,image_id:'page_1',region:{x:0,y:0,width:1,height:1}},...geometryTilePlan(1000,700).map(p=>({image_base64:png,image_id:p.image_id,region:p.region}))];
function fixture(overrides={}){
 let selected='a',saved=[],calls=[],progress=[],nodes=new Map();const documents=new Map([['a',{id:'a',name:'真实图纸.pdf',contentId:sha,file:{name:'真实图纸.pdf'},pages:[{page:1}],geometryResult:{old:true},history:[]}],['b',{id:'b',name:'另一图纸.pdf',contentId:'b'.repeat(64),file:{},pages:[{page:1}],geometryResult:{old:true},history:[]}]]);
 const getDocument=id=>documents.get(id||selected);
 const fetcher=async(url,options)=>{calls.push({url,options});if(url.endsWith('-status'))return Response.json({configured:true,model:'configured-model',provider:'MatrixOrigin',csrf_token:'memory-csrf',limits:{}});return response([{type:'progress',message:'正在分析尺寸对象…'},{type:'result',result:result()}]);};
 const live=createGeometryLive({getDocument,saveDocument:async(doc,options)=>{if(!options.guard()||options.signal.aborted)throw new DOMException('Stopped','AbortError');saved.push(doc);documents.set(doc.id,doc);},renderVisionPage:async()=>rendered(),prepareImages:async()=>images(),validateGeometryImport:(doc,r)=>{if(doc.contentId!==r.document_sha256)throw Error('wrong source');return r;},redraw:()=>{},setStatus:message=>progress.push(message),toast:()=>{},fetcher,getNode:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);},...overrides});
 live.bindDocument(getDocument());return {live,documents,saved,calls,progress,nodes,setSelected(id){selected=id;},getDocument};
}
test('bounded NDJSON handles split UTF-8 characters and receives exactly one completed result',async()=>{
 const messages=[],r=result();const actual=await readGeometryStream(response([{type:'progress',message:'正在读取孔径'},{type:'result',result:r}],{chunks:[1,2,7,1,1,2,9,13,1]}),{onProgress:x=>messages.push(x)});
 assert.deepEqual(actual,r);assert.deepEqual(messages,['正在读取孔径']);
});
test('partial, duplicate, out-of-order, and oversized streams never become results',async()=>{
 await assert.rejects(readGeometryStream(response([{type:'progress',message:'仍在读取'}])),/提前结束/);
 await assert.rejects(readGeometryStream(response(['{"type":"result","result":'])),/不完整|无效/);
 await assert.rejects(readGeometryStream(response([{type:'result',result:result()},{type:'result',result:result()}])),/顺序无效/);
 await assert.rejects(readGeometryStream(response([{type:'result',result:result()},{type:'progress',message:'late'}])),/顺序无效/);
 await assert.rejects(readGeometryStream(response([{type:'progress',message:'x'.repeat(30)}]),{maxBytes:15}),/总大小/);
 await assert.rejects(readGeometryStream(response([{type:'progress',message:'x'.repeat(30)}]),{maxLineBytes:15}),/单条/);
 await assert.rejects(readGeometryStream(response([{type:'progress',message:'a'},{type:'progress',message:'b'}]),{maxEvents:1}),/过多/);
});
test('server failures, HTTP failures and cancellation preserve their actual meaning',async()=>{
 await assert.rejects(readGeometryStream(response([{type:'error',code:'provider_down',message:'模型暂不可用'}])),e=>e.code==='provider_down'&&/暂不可用/.test(e.message));
 await assert.rejects(readGeometryStream(Response.json({code:'csrf',message:'会话过期'},{status:403})),e=>e.httpStatus===403&&e.code==='csrf');
 const controller=new AbortController(),waiting=readGeometryStream(response([{type:'progress',message:'pending'}],{close:false}),{signal:controller.signal});controller.abort();await assert.rejects(waiting,e=>e.name==='AbortError');
});
test('overlapping crop coordinates reflect actual rounded pixels and cover every page corner',()=>{
 const plans=geometryTilePlan(1001,701);assert.equal(plans.length,4);assert.equal(plans[0].region.x,0);assert.equal(plans[0].region.y,0);
 for(const p of plans){assert(p.region.x+p.region.width<=1);assert(p.region.y+p.region.height<=1);assert.equal(p.region.width,p.pixels.width/1001);}
 assert.equal(plans[3].region.x+plans[3].region.width,1);assert.equal(plans[3].region.y+plans[3].region.height,1);assert(plans[0].region.width>plans[1].region.x);
});
test('PNG preparation retains full-page source and makes exactly four cropped images without scaling',async()=>{
 const draws=[],canvas=[];const prepared=await prepareGeometryImages(rendered(),{decodeImage:async()=>({naturalWidth:1000,naturalHeight:700}),createCanvas:()=>{const c={width:0,height:0,getContext:()=>({drawImage:(...args)=>draws.push(args.slice(1))}),toDataURL:()=>`data:image/png;base64,${png}`};canvas.push(c);return c;}});
 assert.equal(prepared.length,5);assert.equal(prepared[0].image_base64,png);assert.deepEqual(prepared[0].region,{x:0,y:0,width:1,height:1});assert.equal(draws.length,4);for(const d of draws){assert.equal(d[2],d[6]);assert.equal(d[3],d[7]);}assert(canvas.every(c=>c.width===1&&c.height===1));
});
test('oversized source, aggregate PNG and request body are rejected instead of resized',async()=>{
 await assert.rejects(prepareGeometryImages({...rendered(),width:5000}),/未降低清晰度/);
 await assert.rejects(prepareGeometryImages(rendered(),{limits:{max_image_bytes:1}}),/超过/);
 const setup={decodeImage:async()=>({naturalWidth:1000,naturalHeight:700}),createCanvas:()=>({getContext:()=>({drawImage(){}}),toDataURL:()=>`data:image/png;base64,${png}`}),limits:{max_image_bytes:150}};
 await assert.rejects(prepareGeometryImages(rendered(),setup),/总大小/);
 assert.throws(()=>geometryRequestBody(rendered(),images(),{max_request_bytes:100}),/请求超过/);
 assert.throws(()=>geometryRequestBody(rendered(),images().slice(0,4)),/四张/);
 const body=JSON.parse(geometryRequestBody(rendered(),images()));assert.deepEqual(Object.keys(body),['page','document_sha256','images']);assert(!JSON.stringify(body).includes('api_key'));
});
test('live extraction requires explicit consent and configured service before sending a page',async()=>{
 const f=fixture();await assert.rejects(f.live.run(),/尚未配置/);await f.live.checkService();await assert.rejects(f.live.run(),/确认/);assert.equal(f.calls.filter(c=>c.url.endsWith('-extract')).length,0);
 f.live.setConsent(true);await f.live.run();const request=f.calls.find(c=>c.url.endsWith('-extract'));assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.headers['X-CSRF-Token'],'memory-csrf');assert.equal(JSON.parse(request.options.body).images.length,5);assert.equal(f.saved.length,1);assert.deepEqual(f.saved[0].history[0].previous,{old:true});assert.equal(f.saved[0].geometryPreview.page,1);assert.match(f.progress.join('\n'),/分析尺寸对象/);assert(!f.progress.some(p=>/\d+%/.test(p)));
});
test('cancel and document switching cannot overwrite previous geometry even when a late result arrives',async()=>{
 let resolveRender;const f=fixture({renderVisionPage:()=>new Promise(resolve=>{resolveRender=resolve;})});await f.live.checkService();f.live.setConsent(true);const work=f.live.run();f.live.cancel();resolveRender(rendered());await work;assert.equal(f.saved.length,0);assert.deepEqual(f.documents.get('a').geometryResult,{old:true});
 const g=fixture({prepareImages:async()=>{g.setSelected('b');g.live.bindDocument(g.getDocument());return images();}});await g.live.checkService();g.live.setConsent(true);await g.live.run();assert.equal(g.saved.length,0);assert.deepEqual(g.documents.get('a').geometryResult,{old:true});
});
test('failed streaming and invalid source never mutate existing geometry or history',async()=>{
 for(const fetchExtract of [()=>response([{type:'progress',message:'incomplete'}]),()=>response([{type:'result',result:{...result(),document_sha256:'f'.repeat(64)}}]),()=>response([{type:'error',code:'down',message:'模型无法处理'}])]){
  const f=fixture({fetcher:async url=>url.endsWith('-status')?Response.json({configured:true,model:'test',csrf_token:'csrf'}):fetchExtract()});await f.live.checkService();f.live.setConsent(true);assert.equal(await f.live.run(),null);assert.equal(f.saved.length,0);assert.deepEqual(f.documents.get('a').geometryResult,{old:true});assert.deepEqual(f.documents.get('a').history,[]);
 }
});
test('the live controls show true configuration, a fixed model, explicit page consent, and no credential',async()=>{
 const f=fixture();await f.live.checkService();let html=f.live.controls(f.getDocument());assert.match(html,/configured-model/);assert.match(html,/MatrixOrigin/);assert.match(html,/id="geometryLiveConsent"/);assert(!html.includes('memory-csrf'));assert(!html.includes('type="password"'));assert.match(html,/id="geometryLiveFile"/);assert.match(html,/开始识别中文参数/);
 f.live.setConsent(true);html=f.live.controls(f.getDocument());assert.match(html,/id="geometryLiveConsent" checked/);f.live.setPage(f.getDocument(),1);assert.equal(f.live.state.consent,false);
});
test('missing configuration and malformed status responses remain visibly unavailable',async()=>{
 const f=fixture({fetcher:async()=>Response.json({configured:false,model:'',message:'尚未配置服务账号'})});await f.live.checkService();assert.equal(f.live.state.service.configured,false);assert.match(f.live.controls(f.getDocument()),/尚未配置服务账号/);assert.match(f.live.controls(f.getDocument()),/id="geometryLiveRun" class="primary" disabled/);
 const g=fixture({fetcher:async()=>Response.json({configured:true,model:'x'})});await g.live.checkService();assert.equal(g.live.state.service.configured,false);
});
test('cancel during guarded save signals the storage transaction and prevents overwrite',async()=>{
 let release;const f=fixture({saveDocument:async(doc,{signal,guard})=>{await new Promise(resolve=>{release=resolve;});if(signal.aborted||!guard())throw new DOMException('Stopped','AbortError');throw Error('Should not reach commit');}});await f.live.checkService();f.live.setConsent(true);const run=f.live.run();for(let i=0;i<20&&!release;i++)await new Promise(resolve=>setTimeout(resolve,0));assert(release);f.live.cancel();release();await run;assert.deepEqual(f.documents.get('a').geometryResult,{old:true});
});
test('server endpoint may select only a supported same-origin geometry route',async()=>{
 const sent=[];const f=fixture({fetcher:async(url,options)=>{if(url.endsWith('-status'))return Response.json({configured:true,model:'x',csrf_token:'csrf',endpoint:'/api/geometry'});sent.push(url);return response([{type:'result',result:result()}]);}});await f.live.checkService();f.live.setConsent(true);await f.live.run();assert.deepEqual(sent,['/api/geometry']);
 const g=fixture({fetcher:async()=>Response.json({configured:true,csrf_token:'csrf',endpoint:'https://external.invalid/upload'})});await g.live.checkService();assert.equal(g.live.state.service.configured,false);g.live.setConsent(true);await assert.rejects(g.live.run(),/尚未配置/);
});
test('server limits aliases are applied before any paid extraction request',async()=>{
 const f=fixture({fetcher:async()=>Response.json({configured:true,csrf_token:'csrf',limits:{request_bytes:100,total_image_bytes:100,max_images:5,max_edge:8192}})});await f.live.checkService();assert.equal(f.live.state.service.limits.max_request_bytes,100);assert.equal(f.live.state.service.limits.max_image_bytes,100);assert.equal(f.live.state.service.limits.max_edge,4096);f.live.setConsent(true);assert.equal(await f.live.run(),null);assert.equal(f.saved.length,0);assert.match(f.progress.at(-1),/上限/);
});
test('configuration checks time out and can be retried instead of leaving controls stuck',async()=>{
 const f=fixture({statusTimeoutMs:5,fetcher:async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Timeout','AbortError')),{once:true}))});await f.live.checkService();assert.equal(f.live.state.checking,false);assert.equal(f.live.state.checkPromise,null);assert.equal(f.live.state.service.configured,false);assert.match(f.live.controls(f.getDocument()),/配置检查超时/);assert.equal(f.nodes.get('#geometryLiveCheck').disabled,false);
});
test('an expired CSRF session clears in-memory authorization and requires a new explicit consent',async()=>{
 const f=fixture({fetcher:async url=>url.endsWith('-status')?Response.json({configured:true,csrf_token:'old-csrf'}):Response.json({code:'csrf_failed',message:'安全会话已失效'},{status:403})});await f.live.checkService();f.live.setConsent(true);assert.equal(await f.live.run(),null);assert.equal(f.live.state.service.csrf_token,'');assert.equal(f.live.state.service.configured,false);assert.equal(f.live.state.consent,false);assert.equal(f.nodes.get('#geometryLiveConsent').checked,false);assert.equal(f.saved.length,0);assert.match(f.live.controls(f.getDocument()),/检查服务.*重新确认/);
});
test('a display failure after a successful save is not reported as a failed extraction',async()=>{
 const f=fixture({onSaved:()=>{throw Error('view unavailable');}});await f.live.checkService();f.live.setConsent(true);assert.deepEqual(await f.live.run(),result());assert.equal(f.saved.length,1);assert.match(f.progress.at(-1),/结果已保存.*显示更新未完成/);assert(!f.progress.at(-1).includes('旧结果保留'));
 const request=f.calls.find(c=>c.url.endsWith('-extract'));assert.equal(request.options.mode,'same-origin');assert.equal(request.options.redirect,'error');
});
