/** Same-origin live geometry extraction. Credentials remain on the server. */
const MiB=1024*1024;
export const GEOMETRY_LIVE_LIMITS=Object.freeze({max_request_bytes:20*MiB,max_image_bytes:12*MiB,max_images:5,max_edge:4096,timeout_seconds:600});
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const abortError=()=>new DOMException('识别已取消。','AbortError');
const checkAbort=signal=>{if(signal?.aborted)throw abortError();};
function limitsOf(input={}){const aliases={max_request_bytes:['request_bytes'],max_image_bytes:['total_image_bytes','image_bytes']};return Object.fromEntries(Object.entries(GEOMETRY_LIVE_LIMITS).map(([key,max])=>{const values=[input[key],...(aliases[key]||[]).map(alias=>input[alias])].filter(value=>Number.isFinite(value)&&value>0).map(value=>Math.floor(value));return [key,Math.min(max,...values)];}));}
function serviceMessage(state){if(state.checking)return '正在检查服务器模型配置…';if(!state.service)return '正在读取公网识图配置…';return state.service.configured?'公网模型已配置；实际可用性由本次识别验证。':state.service.message||'公网模型尚未配置或当前不可用。请稍后重新检查。';}
function base64Bytes(value){if(typeof value!=='string'||!value.length||value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw Error('页面图像编码无效。');return value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0);}

/** Full-page normalized regions, with pixel rounding reflected in the actual crop coordinates. */
export function geometryTilePlan(width,height){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)throw Error('页面像素尺寸无效。');
 return [[0,0],[.4,0],[0,.4],[.4,.4]].map(([x,y],i)=>{const left=Math.floor(x*width),top=Math.floor(y*height),right=Math.min(width,Math.ceil((x+.6)*width)),bottom=Math.min(height,Math.ceil((y+.6)*height));return {image_id:'tile_'+(i+1),pixels:{x:left,y:top,width:right-left,height:bottom-top},region:{x:left/width,y:top/height,width:(right-left)/width,height:(bottom-top)/height}};});
}
function decodePNG(base64,signal){return new Promise((resolve,reject)=>{checkAbort(signal);const image=new Image();const cleanup=()=>signal?.removeEventListener('abort',cancel);const cancel=()=>{cleanup();image.src='';reject(abortError());};signal?.addEventListener('abort',cancel,{once:true});image.onload=()=>{cleanup();resolve(image);};image.onerror=()=>{cleanup();reject(Error('高清页面图像无法解码。'));};image.src='data:image/png;base64,'+base64;});}
export async function prepareGeometryImages(rendered,{signal,limits={},decodeImage=decodePNG,createCanvas=()=>document.createElement('canvas'),onProgress=()=>{}}={}){
 checkAbort(signal);const cap=limitsOf(limits),{width,height,image_base64}=rendered;
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||Math.max(width,height)>cap.max_edge)throw Error(`页面长边超过 ${cap.max_edge} 像素，请调整源文件后重试；本次未降低清晰度。`);
 if(!String(image_base64||'').startsWith('iVBORw0KGgo'))throw Error('当前页面必须为 PNG 图像。');
 if(cap.max_images<5)throw Error('服务器图像数量上限不足以接收整页及四块高清裁剪。');
 let bytes=base64Bytes(image_base64);
 if(bytes>cap.max_image_bytes)throw Error('整页 PNG 已超过服务器图像总大小上限；本次未发送。');
 const images=[{image_base64,region:{x:0,y:0,width:1,height:1},image_id:'page_'+rendered.page}],image=await decodeImage(image_base64,signal);
 try{
  checkAbort(signal);if((image.naturalWidth??image.width)!==width||(image.naturalHeight??image.height)!==height)throw Error('渲染页面的像素尺寸与图像不一致。');
  for(const tile of geometryTilePlan(width,height)){
   checkAbort(signal);const canvas=createCanvas();
   try{canvas.width=tile.pixels.width;canvas.height=tile.pixels.height;const ctx=canvas.getContext('2d');if(!ctx)throw Error('浏览器无法创建图纸裁剪画布。');const p=tile.pixels;ctx.drawImage(image,p.x,p.y,p.width,p.height,0,0,p.width,p.height);const data=canvas.toDataURL('image/png');if(!data.startsWith('data:image/png;base64,'))throw Error('浏览器未生成 PNG 裁剪图。');const encoded=data.slice('data:image/png;base64,'.length);bytes+=base64Bytes(encoded);if(bytes>cap.max_image_bytes)throw Error('整页与裁剪 PNG 总大小超过服务器上限；请拆分更小页面。本次未发送，也未降低清晰度。');images.push({image_base64:encoded,region:tile.region,image_id:tile.image_id});onProgress(`已准备 ${images.length-1} / 4 块高清裁剪；图像仍在本机。`);}finally{canvas.width=canvas.height=1;}
   // Yield to pointer/cancel events between expensive PNG encodes.
   await new Promise(resolve=>setTimeout(resolve,0));
  }
 }finally{image.close?.();}
 checkAbort(signal);return images;
}
export function geometryRequestBody(rendered,images,limits={}){
 const cap=limitsOf(limits);
 if(!/^[a-f0-9]{64}$/i.test(rendered.source_document_sha256||'')||!Number.isInteger(rendered.page)||rendered.page<1)throw Error('页面来源标识无效。');
 if(!Array.isArray(images)||images.length!==5||images.length>cap.max_images)throw Error('识别需要一张整页和四张裁剪图。');
 const sum=images.reduce((total,image)=>total+base64Bytes(image.image_base64),0);if(sum>cap.max_image_bytes)throw Error('图像总大小超过服务器上限。');
 const body=JSON.stringify({page:rendered.page,document_sha256:rendered.source_document_sha256.toLowerCase(),images});
 if(new TextEncoder().encode(body).byteLength>=cap.max_request_bytes)throw Error('识别请求超过服务器大小上限，本次未发送。');
 return body;
}

async function readTextBounded(response,maxBytes,signal){
 if(!response.body?.getReader)throw Error('服务器未返回可读取的响应。');const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let count=0,text='';const cancel=()=>{reader.cancel().catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
 try{for(;;){checkAbort(signal);const {done,value}=await reader.read();checkAbort(signal);if(done)break;count+=value.byteLength;if(count>maxBytes)throw Error('服务器响应过大。');text+=decoder.decode(value,{stream:true});}return text+decoder.decode();}finally{signal?.removeEventListener('abort',cancel);reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** A result is accepted only after a complete, bounded stream with exactly one terminal event. */
export async function readGeometryStream(response,{signal,onProgress=()=>{},maxBytes=8*MiB,maxLineBytes=4*MiB,maxEvents=500}={}){
 if(!response.ok){let body={};try{body=JSON.parse(await readTextBounded(response,16384,signal));}catch(e){if(e.name==='AbortError')throw e;}const error=Error(typeof body.message==='string'?body.message.slice(0,2000):`识别服务暂不可用（HTTP ${response.status}）。`);error.code=typeof body.code==='string'?body.code:'http_error';error.httpStatus=response.status;throw error;}
 if(!response.body?.getReader)throw Error('当前浏览器或服务未提供流式识别响应。');
 const contentType=response.headers?.get('content-type')||'';if(contentType&&!/(?:ndjson|jsonl)/i.test(contentType))throw Error('服务器未返回约定的识别数据流。');
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder();let buffer='',bytes=0,events=0,terminal=null;
 const cancel=()=>{reader.cancel().catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
 function event(line){if(!line.trim())return;if(encoder.encode(line).byteLength>maxLineBytes)throw Error('单条识别结果超过大小上限。');if(++events>maxEvents)throw Error('识别数据流事件过多。');let data;try{data=JSON.parse(line);}catch{throw Error('识别数据流包含不完整或无效的 JSON。');}if(!data||typeof data!=='object'||Array.isArray(data)||terminal)throw Error('识别数据流顺序无效。');if(data.type==='progress'){if(typeof data.message!=='string'||data.message.length>2000)throw Error('识别进度消息无效。');onProgress(data.message);return;}if(data.type==='result'){if(!data.result||typeof data.result!=='object'||Array.isArray(data.result))throw Error('识别结果格式无效。');terminal=data;return;}if(data.type==='error'){if(typeof data.message!=='string'||data.message.length>2000||data.code!=null&&(typeof data.code!=='string'||data.code.length>100))throw Error('识别错误消息无效。');terminal=data;return;}throw Error('识别数据流含未知事件。');}
 try{
  for(;;){checkAbort(signal);const chunk=await reader.read();checkAbort(signal);if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>maxBytes)throw Error('识别数据流超过总大小上限。');buffer+=decoder.decode(chunk.value,{stream:true});let newline;while((newline=buffer.indexOf('\n'))>=0){event(buffer.slice(0,newline).replace(/\r$/,''));buffer=buffer.slice(newline+1);}if(encoder.encode(buffer).byteLength>maxLineBytes)throw Error('单条识别结果超过大小上限。');}
  buffer+=decoder.decode();if(buffer.trim())event(buffer);checkAbort(signal);if(!terminal)throw Error('识别连接提前结束，尚未收到完整结果；旧结果已保留。');if(terminal.type==='error'){const error=Error(terminal.message);error.code=terminal.code||'provider_error';throw error;}return terminal.result;
 }finally{signal?.removeEventListener('abort',cancel);reader.cancel().catch(()=>{});reader.releaseLock();}
}

export function createGeometryLive({getDocument,saveDocument,renderVisionPage,validateGeometryImport,redraw,setStatus=()=>{},toast=()=>{},onSaved=()=>{},fetcher=(...args)=>fetch(...args),prepareImages=prepareGeometryImages,getNode=selector=>document.querySelector(selector),now=()=>Date.now(),statusTimeoutMs=15000}){
 const state={service:null,checking:false,checkPromise:null,pages:new Map(),documentId:'',consent:false,busy:false,controller:null,message:'',startedAt:null,runId:0};
 const currentPage=doc=>{const value=state.pages.get(doc.id)??doc.geometryResult?.page;return doc.pages.some(p=>p.page===value)?value:doc.pages[0]?.page||1;};
 function update(){
  const progress=getNode('#geometryLiveProgress');if(progress)progress.textContent=state.message;const run=getNode('#geometryLiveRun');if(run)run.textContent=state.busy?'识别进行中…':'开始识别中文参数';
  const elapsed=getNode('#geometryLiveElapsed');if(elapsed)elapsed.textContent=state.busy&&state.startedAt!=null?`已等待 ${Math.max(0,Math.floor((now()-state.startedAt)/1000))} 秒`:'';
  const service=getNode('#geometryLiveService');if(service)service.textContent=serviceMessage(state);
  const model=getNode('#geometryLiveModel');if(model)model.textContent=state.service?.model||'尚未配置';const consent=getNode('#geometryLiveConsent');if(consent)consent.checked=state.consent;
  for(const [id,disabled] of [['geometryLiveRun',state.busy||!state.service?.configured||!getDocument()?.file||!state.consent],['geometryLiveCancel',!state.busy],['geometryLiveCheck',state.checking||state.busy],['geometryLivePage',state.busy],['geometryLiveConsent',state.busy],['geometryImportButton',state.busy],['geometryImport',state.busy]]){const n=getNode('#'+id);if(n)n.disabled=disabled;}
 }
 function progress(message){state.message=message;setStatus(message);update();}
 async function checkService(){
  if(state.busy)return state.service;if(state.checkPromise)return state.checkPromise;state.checking=true;update();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(30000,statusTimeoutMs)));
  state.checkPromise=(async()=>{try{const response=await fetcher('/api/geometry-status',{credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal}),body=JSON.parse(await readTextBounded(response,32768,controller.signal));state.service={endpoint:['/api/geometry','/api/geometry-extract'].includes(body.endpoint)?body.endpoint:'/api/geometry-extract',configured:response.ok&&body.configured===true&&(!body.endpoint||['/api/geometry','/api/geometry-extract'].includes(body.endpoint))&&typeof body.csrf_token==='string'&&body.csrf_token.length>0&&body.csrf_token.length<2048,model:typeof body.model==='string'?body.model.slice(0,200):'',provider:typeof body.provider==='string'?body.provider.slice(0,200):'MatrixOrigin',limits:limitsOf(body.limits||{}),csrf_token:typeof body.csrf_token==='string'?body.csrf_token:'',message:typeof body.message==='string'?body.message.slice(0,2000):''};}catch{state.service={configured:false,message:controller.signal.aborted?'公网配置检查超时，请重新检查服务。':'暂时无法连接公网识图服务，请重新检查。'};}finally{clearTimeout(timer);state.checking=false;state.checkPromise=null;update();}return state.service;})();return state.checkPromise;
 }
 function cancel(message='已取消本次识别；旧结果保留。已发送的请求可能仍在服务器处理。'){if(state.controller){state.controller.abort();state.runId++;progress(message);}return state.busy;}
 function bindDocument(doc){if(state.documentId!==doc?.id){cancel('已切换图纸，本次识别结果不会写入。');state.documentId=doc?.id||'';state.consent=false;state.message='';}return doc;}
 function setPage(doc,value){cancel('已切换页面，本次识别结果不会写入。');const page=Number(value);if(!doc.pages.some(p=>p.page===page))throw Error('请选择有效来源页。');state.pages.set(doc.id,page);state.consent=false;state.message='';}
 async function run(){
  if(state.busy)return null;const doc=getDocument();if(!doc?.file)throw Error('请先导入 PDF 或图片原文件。');if(!state.service?.configured)throw Error('公网识图尚未配置或当前不可用，请先检查服务。');if(!state.consent)throw Error('请先确认将当前页发送至 MatrixOrigin。');
  const page=currentPage(doc),source={id:doc.id,sha:String(doc.contentId||'').toLowerCase(),file:doc.file},controller=new AbortController(),signal=controller.signal,runId=++state.runId;state.controller=controller;state.busy=true;state.startedAt=now();let timedOut=false,savedResult=null;
  const isCurrent=()=>!signal.aborted&&runId===state.runId&&getDocument()?.id===source.id&&String(getDocument(source.id)?.contentId||'').toLowerCase()===source.sha&&currentPage(getDocument(source.id))===page;
  const ensureCurrent=()=>{checkAbort(signal);if(!isCurrent())throw abortError();};
  const timer=setInterval(update,1000),timeout=setTimeout(()=>{timedOut=true;controller.abort();},(state.service.limits.timeout_seconds+60)*1000);
  progress(`正在本机渲染第 ${page} 页高清原图…`);
  try{
   const rendered=await renderVisionPage(source.file,page,{signal});ensureCurrent();if(rendered.source_document_sha256!==source.sha||rendered.page!==page)throw Error('渲染页面与所选原文件不一致，本次未发送。');
   const images=await prepareImages(rendered,{signal,limits:state.service.limits,onProgress:progress});ensureCurrent();const body=geometryRequestBody(rendered,images,state.service.limits);
   progress(`正在发送第 ${page} 页整图和四块高清裁剪；等待模型返回真实进度…`);
   const response=await fetcher(state.service.endpoint,{method:'POST',credentials:'same-origin',mode:'same-origin',redirect:'error',headers:{'Content-Type':'application/json','X-CSRF-Token':state.service.csrf_token},body,signal});
   const input=await readGeometryStream(response,{signal,onProgress:message=>{if(isCurrent())progress(message);}});ensureCurrent();
   const fresh=getDocument(source.id),result=validateGeometryImport(fresh,input);if(result.page!==page||result.document_sha256!==source.sha)throw Error('模型结果来源与请求页面不一致，旧结果已保留。');ensureCurrent();
   const next={...fresh,geometryResult:result,geometryPreview:{page,data:'data:image/png;base64,'+rendered.image_base64,rotation:0},history:[...(fresh.history||[]),{at:new Date(now()).toISOString(),action:'公网实时中文参数识别',sourcePage:page,sourceSha256:source.sha,model:result.model||state.service.model,provider:state.service.provider,previous:fresh.geometryResult||null}]};
   progress('完整结果已收到，正在校验来源并保存中文参数…');await saveDocument(next,{signal,guard:isCurrent});savedResult=result;if(!isCurrent())return result;onSaved(next,result);
   progress(`识别完成：${result.parameters.filter(p=>p.status==='candidate').length} 项中文参数候选。已自动检查 2D / 3D 所需尺寸，并展示可生成的局部视图或缺项原因。`);redraw();return result;
  }catch(error){if(savedResult){progress('识别结果已保存，但显示更新未完成。请重新打开这份图纸查看。');toast(state.message);return savedResult;}if(error.httpStatus===403){state.service={configured:false,csrf_token:'',message:'识图会话已失效或未通过安全校验，请点击“检查服务”后重新确认发送。'};state.consent=false;}progress(timedOut?'识别等待超时，旧结果保留；没有自动重试。':error.name==='AbortError'?'本次识别已停止，旧结果保留；服务器可能仍在完成已发送的请求。':error.message||'识别未完成，旧结果保留。');if(error.name!=='AbortError')toast(state.message);return null;}
  finally{clearInterval(timer);clearTimeout(timeout);state.busy=false;state.controller=null;state.startedAt=null;update();}
 }
 function controls(doc){
  const page=currentPage(doc),preview=doc.pages.find(p=>p.page===page)?.thumbnail||doc.pages.find(p=>p.page===page)?.preview||'',safe=/^(?:data:image\/(?:png|jpe?g|webp);base64,|blob:)/i.test(preview)?preview:'';
  return `<section class="panel geometry-live-panel"><div class="geometry-live-heading"><div><h2>直接识图 · 中文参数与几何</h2><p>选择这一页，模型识别后自动展示中文参数、原图依据与可建立的局部 2D / 3D。</p></div><div class="geometry-live-file-actions"><span class="geometry-live-badge">公网实时识别</span><label class="button">导入新图纸<input id="geometryLiveFile" type="file" accept=".pdf,.png,.jpg,.jpeg" hidden></label></div></div><div class="geometry-live-layout">${safe?`<img class="geometry-live-preview" src="${esc(safe)}" alt="第 ${page} 页待识别图纸预览">`:''}<div class="geometry-live-form"><div class="geometry-live-source"><label>识别页面<select id="geometryLivePage" ${state.busy?'disabled':''}>${doc.pages.map(p=>`<option value="${p.page}" ${p.page===page?'selected':''}>第 ${p.page} 页</option>`).join('')}</select></label><div><span>服务器模型</span><strong id="geometryLiveModel">${esc(state.service?.model||'尚未配置')}</strong></div><button type="button" id="geometryLiveCheck" ${state.busy||state.checking?'disabled':''}>检查服务</button></div><p id="geometryLiveService" class="geometry-live-service">${esc(serviceMessage(state))}</p><label class="geometry-live-consent"><input type="checkbox" id="geometryLiveConsent" ${state.consent?'checked':''} ${state.busy?'disabled':''}>我确认将当前第 ${page} 页的整图及高清裁剪发送至 MatrixOrigin 模型服务进行识别。</label><div class="geometry-live-actions"><button type="button" id="geometryLiveRun" class="primary" ${state.busy||!state.service?.configured||!doc.file||!state.consent?'disabled':''}>${state.busy?'识别进行中…':'开始识别中文参数'}</button><button type="button" id="geometryLiveCancel" ${state.busy?'':'disabled'}>取消本次识别</button><span id="geometryLiveElapsed"></span></div>${!doc.file?'<p class="notice">此资料缺少原始文件，请重新导入 PDF 或图片。</p>':''}<p id="geometryLiveProgress" role="status" aria-live="polite">${esc(state.message)}</p><p class="geometry-live-note">仅处理所选页。取消、切换图纸或识别失败时保留已有结果；重新识别成功后保留历史记录。三维形状依据已识别尺寸建立，缺失尺寸不会自动填造。</p></div></div></section>`;
 }
 return {state,currentPage,update,controls,run,cancel,bindDocument,setPage,checkService,setConsent(value){state.consent=value===true;update();}};
}
