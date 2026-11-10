/** Anonymous same-origin demo gateway. D1 stores usage only, never drawings or results. */
import {extractGeometry,validateGeometryRequest,GEOMETRY_LIMITS,sanitizeGeometryDiagnostic} from './geometry-provider.mjs';

const COOKIE='__Host-specflow_session';
const SESSION_SECONDS=86400,LEASE_SECONDS=660,BODY_LIMIT=20*1024*1024;
const encoder=new TextEncoder();
const EMPTY_HEADERS={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
export const RESERVE_SQL=`INSERT INTO specflow_jobs (id, owner, ip_hash, status, created_at, expires_at, error_code)
SELECT ?, ?, ?, 'running', ?, ?, NULL
WHERE (SELECT COUNT(*) FROM specflow_jobs WHERE owner = ? AND status = 'running' AND expires_at > ?) < 1
AND (SELECT COUNT(*) FROM specflow_jobs WHERE status = 'running' AND expires_at > ?) < 3
AND (SELECT COUNT(*) FROM specflow_jobs WHERE owner = ? AND created_at > ?) < 10
AND (SELECT COUNT(*) FROM specflow_jobs WHERE ip_hash = ? AND created_at > ?) < 30`;
const PROGRESS={validating:'已检查图片，正在准备识别。',requesting:'模型正在读取图纸并关联部位，复杂页面可能需要数分钟。',checking:'模型已返回，正在核对数值、单位和来源。',waiting:'仍在识别中，请保持页面打开。'};
const ERRORS={
 invalid_geometry_input:['请求中的页面图片或来源信息无效。',400], invalid_json:['请求必须是有效的 JSON。',400],invalid_content_type:['请求必须使用 application/json。',415],request_too_large:['本次上传超过 20 MiB 请求上限。',413],
 same_origin_required:['拒绝跨来源识别请求。',403],session_required:['识别会话已失效，请刷新页面后重试。',403],csrf_required:['请求校验失败，请刷新页面后重试。',403],
 geometry_unavailable:['在线识图服务尚未完成配置。',503],storage_unavailable:['识别服务暂不可用，请稍后重试。',503],rate_limited:['已有识别任务正在运行，或已达到本小时使用上限，请稍后重试。',429],
 provider_not_configured:['在线识图服务尚未配置可用凭据。',503],server_configuration_invalid:['在线识图服务配置暂不可用。',503],provider_auth_failed:['模型服务凭据未通过验证，请联系管理员。',502],provider_busy:['模型服务繁忙，请稍后重试。',503],provider_unavailable:['模型服务暂不可用，请稍后重试。',502],provider_timeout:['模型识别超时，请稍后重试；本次没有可用结果。',504],request_cancelled:['识别已取消。',499],provider_transport_error:['模型连接失败，请稍后重试。',502],provider_redirect_rejected:['模型服务返回了不允许的重定向，请联系管理员。',502],provider_invalid_output:['模型未返回完整的结构化结果，本次内容未作为识别结果接收。',502],provider_validation_failed:['模型结果未通过数值、单位或来源校验，本次内容未作为识别结果接收。',502],upstream_response_too_large:['模型响应超过安全大小限制。',502],upstream_empty_response:['模型服务没有返回正文。',502],internal_error:['识别未能完成，请稍后重试。',500]
};
class GatewayError extends Error{constructor(code){super(ERRORS[code]?.[0]||ERRORS.internal_error[0]);this.code=ERRORS[code]?code:'internal_error';this.status=ERRORS[this.code][1];}}
function safeError(error){return new GatewayError(typeof error?.code==='string'&&Object.hasOwn(ERRORS,error.code)?error.code:'internal_error');}
function json(value,status=200,headers={}){return new Response(JSON.stringify(value),{status,headers:{...EMPTY_HEADERS,'Content-Type':'application/json; charset=utf-8',...headers}});}
function errorResponse(error,headers={}){const e=safeError(error);return json({error:e.code,code:e.code,message:e.message},e.status,headers);}
function configured(env){return typeof env?.SESSION_SIGNING_KEY==='string'&&env.SESSION_SIGNING_KEY.length>32&&env.SESSION_SIGNING_KEY.length<=8192&&typeof env?.DRAWING_VLM_API_KEY==='string'&&!!env.DRAWING_VLM_API_KEY.trim()&&!/[\r\n]/.test(env.DRAWING_VLM_API_KEY)&&typeof env?.DB?.prepare==='function';}
function hex(bytes){return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');}
function unhex(raw){return Uint8Array.from(raw.match(/../g)||[],x=>Number.parseInt(x,16));}
async function signingKey(secret){return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
async function sign(key,value){return hex(await crypto.subtle.sign('HMAC',key,encoder.encode(value)));}
async function verify(key,value,signature){return typeof signature==='string'&&/^[a-f0-9]{64}$/.test(signature)&&crypto.subtle.verify('HMAC',key,unhex(signature),encoder.encode(value));}
function randomSession(){const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return hex(bytes);}
function cookieValue(request){const found=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));return found.length===1?found[0].slice(COOKIE.length+1):null;}
async function session(request,key,nowSeconds){
 const raw=cookieValue(request),match=raw?.match(/^([a-f0-9]{32})\.([a-f0-9]{1,16})\.([a-f0-9]{64})$/);if(!match)return null;
 const expires=Number.parseInt(match[2],16);if(!Number.isSafeInteger(expires)||expires<=nowSeconds||expires>nowSeconds+SESSION_SECONDS+60||!await verify(key,match[1]+'.'+match[2],match[3]))return null;
 return {sid:match[1],expires,value:raw};
}
async function newSession(key,nowSeconds){const sid=randomSession(),expires=nowSeconds+SESSION_SECONDS,base=sid+'.'+expires.toString(16);return {sid,expires,value:base+'.'+await sign(key,base)};}
function cookieHeader(s){return `${COOKIE}=${s.value}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;}
function checkOrigin(request){const origin=request.headers.get('Origin');if(origin!==new URL(request.url).origin||request.headers.get('Sec-Fetch-Site')?.toLowerCase()==='cross-site')throw new GatewayError('same_origin_required');}
function ipValue(request){const value=(request.headers.get('CF-Connecting-IP')||'').trim();return value.length<=64&&/^[0-9a-fA-F:.]+$/.test(value)?value:'unavailable';}
async function run(db,sql,args){try{const result=await db.prepare(sql).bind(...args).run();if(result?.success===false)throw Error('D1 statement failed');return result;}catch{throw new GatewayError('storage_unavailable');}}
async function cleanup(db,seconds){await run(db,'DELETE FROM specflow_jobs WHERE id IN (SELECT id FROM specflow_jobs WHERE created_at < ? AND expires_at <= ? LIMIT 200)',[seconds-SESSION_SECONDS,seconds]);}
async function reserve(db,job){const {id,owner,ip,seconds}=job;const result=await run(db,RESERVE_SQL,[id,owner,ip,seconds,seconds+LEASE_SECONDS,owner,seconds,seconds,owner,seconds-3600,ip,seconds-3600]);const count=result?.meta?.changes;if(count!==0&&count!==1)throw new GatewayError('storage_unavailable');if(count===0)throw new GatewayError('rate_limited');}
async function finish(db,id,status,errorCode,seconds){await run(db,"UPDATE specflow_jobs SET status = ?, expires_at = ?, error_code = ? WHERE id = ? AND status = 'running'",[status,seconds,errorCode,id]);}
async function holdCancelledLease(db,id){await run(db,"UPDATE specflow_jobs SET error_code = 'request_cancelled' WHERE id = ? AND status = 'running'",[id]);}
async function bodyJSON(request,maxBytes){
 if((request.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase()!=='application/json')throw new GatewayError('invalid_content_type');
 const length=request.headers.get('Content-Length');if(length!=null&&Number(length)>maxBytes)throw new GatewayError('request_too_large');
 if(!request.body)throw new GatewayError('invalid_json');
 const reader=request.body.getReader(),parts=[],decoder=new TextDecoder('utf-8',{fatal:true});let size=0;
 // This request protocol carries only ASCII JSON metadata and base64 images.
 // Decode incrementally to avoid retaining both 20 MiB byte chunks and a second
 // contiguous byte buffer alongside the parsed base64 string.
 try{while(true){if(request.signal.aborted)throw new GatewayError('request_cancelled');const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new GatewayError('request_too_large');}const part=decoder.decode(value,{stream:true});if(/[^\x00-\x7f]/.test(part))throw new GatewayError('invalid_geometry_input');parts.push(part);}const tail=decoder.decode();if(/[^\x00-\x7f]/.test(tail))throw new GatewayError('invalid_geometry_input');parts.push(tail);}catch(error){if(error instanceof GatewayError)throw error;throw new GatewayError(request.signal.aborted?'request_cancelled':'invalid_json');}finally{reader.releaseLock();}
 try{return JSON.parse(parts.join(''));}catch{throw new GatewayError('invalid_json');}
}
function resultBound(result,body,env){
 if(!result||result.schema_version!=='geometry-2.0'||result.document_sha256!==body.document_sha256.toLowerCase()||result.page!==body.page)throw new GatewayError('provider_validation_failed');
 const serialized=JSON.stringify(result);if(serialized.includes(env.DRAWING_VLM_API_KEY)||serialized.includes(env.SESSION_SIGNING_KEY))throw new GatewayError('provider_invalid_output');
}

const FAILURE_STAGES=new Set(['preparing','image_hashing','request_encoding','request_hashing','upstream_fetch','upstream_status','upstream_read','response_hashing','response_json','protocol_validation','complete']);
function logFailure(logger,error,safe,id,elapsed,env,body){
 const audit=error?.audit,record={event:'geometry_request_failed',request_id:/^[A-Za-z0-9_-]{1,100}$/.test(id)?id:'unknown',code:safe.code,elapsed_seconds:elapsed,network_call_performed:typeof audit?.network_call_performed==='boolean'?audit.network_call_performed:null,http_status:Number.isInteger(audit?.http_status)&&audit.http_status>=100&&audit.http_status<=599?audit.http_status:null,failure_stage:FAILURE_STAGES.has(audit?.failure_stage)?audit.failure_stage:'unknown'};
 if(audit?.native_error)record.native_error=sanitizeGeometryDiagnostic(audit.native_error,{secrets:[env.DRAWING_VLM_API_KEY,env.SESSION_SIGNING_KEY],sourceTokens:[body.document_sha256,...body.images.map(image=>image.image_base64)]});
 // Logging failure must never interrupt terminal events or admission release.
 try{logger(record);}catch{}
}
/** DI is test-only/server-owned. No dependency or configuration is taken from HTTP bodies. */
export function createHandler({extractor=extractGeometry,now=Date.now,heartbeatMs=10000,maxBodyBytes=BODY_LIMIT,randomId=()=>crypto.randomUUID(),logger=record=>console.error(JSON.stringify(record))}={}){
 let activePosts=0;
 return async function handle(request,env){
  let releaseAdmission=null,streamOwnsAdmission=false;
  const url=new URL(request.url),path=url.pathname;
  if(path!=='/api'&&!path.startsWith('/api/'))return env?.ASSETS?.fetch?env.ASSETS.fetch(request):new Response('Not found',{status:404});
  if(path==='/api/vision-status'&&request.method==='GET')return json({available:false,configured:false,message:'请使用参数与部位页面的在线识图功能。',geometry_endpoint:'/api/geometry-extract',status_endpoint:'/api/geometry-status'});
  const statusPath=path==='/api/geometry-status',extractPath=path==='/api/geometry-extract'||path==='/api/geometry';
  if(!statusPath&&!extractPath)return json({error:'not_found',message:'接口不存在。'},404);
  if((statusPath&&request.method!=='GET')||(extractPath&&request.method!=='POST'))return json({error:'method_not_allowed',message:'请求方法不支持。'},405,{Allow:statusPath?'GET':'POST'});
  if(!configured(env))return errorResponse(new GatewayError('geometry_unavailable'));
  const seconds=()=>Math.floor(now()/1000);
  try{
   const key=await signingKey(env.SESSION_SIGNING_KEY);
   if(statusPath){
    const current=await session(request,key,seconds()),active=current||await newSession(key,seconds());
    await cleanup(env.DB,seconds());
    return json({available:true,configured:true,provider_connectivity_tested:false,endpoint:'/api/geometry-extract',csrf_token:await sign(key,'csrf:'+active.value),model:env.DRAWING_VLM_MODEL||'qwen3.8-max',limits:{request_bytes:maxBodyBytes,image_bytes:GEOMETRY_LIMITS.imageBytes,total_image_bytes:GEOMETRY_LIMITS.totalImageBytes,max_images:GEOMETRY_LIMITS.images,total_pixels:GEOMETRY_LIMITS.totalPixels,max_edge:GEOMETRY_LIMITS.maxEdge,session_per_hour:10,ip_per_hour:30,session_concurrency:1,global_concurrency:3,isolate_concurrency:1},message:'在线识图已配置；尚未验证模型服务连接，结果仍需人工复核。'},200,current?{}:{'Set-Cookie':cookieHeader(active)});
   }
   checkOrigin(request);
   const active=await session(request,key,seconds());if(!active)throw new GatewayError('session_required');
   if(!await verify(key,'csrf:'+active.value,request.headers.get('X-CSRF-Token')))throw new GatewayError('csrf_required');
   // A 12 MiB decoded image request can coexist with base64/request/response
   // buffers. Admit one POST per isolate before reading any request body.
   if(activePosts>=1)throw new GatewayError('rate_limited');
   activePosts++;let released=false;releaseAdmission=()=>{if(!released){released=true;activePosts--;}};
   const body=await bodyJSON(request,maxBodyBytes),preparedInput=validateGeometryRequest(body);
   if(request.signal.aborted)throw new GatewayError('request_cancelled');
   const id=randomId(),owner=await sign(key,'owner:'+active.sid),ip=await sign(key,'ip:'+ipValue(request)),created=seconds();
   await reserve(env.DB,{id,owner,ip,seconds:created});
   const controller=new AbortController();let disconnected=false,closed=false,heartbeat=null,terminal=false;
   const abort=()=>{disconnected=true;controller.abort();if(heartbeat!==null){clearInterval(heartbeat);heartbeat=null;}};
   if(request.signal.aborted)abort();else request.signal.addEventListener('abort',abort,{once:true});
   const elapsed=()=>Math.max(0,Math.round((now()/1000-created)*1000)/1000);
   const stream=new ReadableStream({
    start(output){
     const send=data=>{if(closed||disconnected||terminal)return false;try{output.enqueue(encoder.encode(JSON.stringify({...data,request_id:id})+'\n'));return true;}catch{abort();return false;}};
     const close=()=>{releaseAdmission?.();if(heartbeat!==null){clearInterval(heartbeat);heartbeat=null;}request.signal.removeEventListener('abort',abort);if(!closed){closed=true;try{output.close();}catch{}}};
     if(!disconnected)heartbeat=setInterval(()=>send({type:'progress',phase:'waiting',message:PROGRESS.waiting}),heartbeatMs);
     return (async()=>{
      try{
       const {result}=await extractor(body,env,{signal:controller.signal,preparedInput,onProgress:event=>{const phase=Object.hasOwn(PROGRESS,event?.phase)?event.phase:'requesting';send({type:'progress',phase,message:PROGRESS[phase]});}});
       resultBound(result,body,env);
       if(disconnected){await finish(env.DB,id,'cancelled','request_cancelled',seconds());return;}
       await finish(env.DB,id,'succeeded',null,seconds());
       send({type:'result',result,elapsed_seconds:elapsed()});terminal=true;
      }catch(error){
       const safe=disconnected?new GatewayError('request_cancelled'):safeError(error);
       logFailure(logger,error,safe,id,elapsed(),env,body);
       try{if(disconnected)await holdCancelledLease(env.DB,id);else await finish(env.DB,id,safe.code==='request_cancelled'?'cancelled':'failed',safe.code,seconds());}catch{}
       if(!disconnected){send({type:'error',code:safe.code,message:safe.message,elapsed_seconds:elapsed()});terminal=true;}
      }finally{close();}
     })();
    },
    cancel(){closed=true;abort();request.signal.removeEventListener('abort',abort);}
   });
   const response=new Response(stream,{status:200,headers:{...EMPTY_HEADERS,'Content-Type':'application/x-ndjson; charset=utf-8','X-Request-Id':id,'X-Accel-Buffering':'no'}});streamOwnsAdmission=true;return response;
  }catch(error){const safe=safeError(error);return errorResponse(safe,safe.code==='rate_limited'?{'Retry-After':'60'}:{});}
  finally{if(!streamOwnsAdmission)releaseAdmission?.();}
 };
}
export default {fetch:createHandler()};
