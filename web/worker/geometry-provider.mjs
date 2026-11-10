/** Server-only bounded single-page VLM call. No URL, model or prompt comes from callers. */
import {validateGeometryImport} from '../geometry-ui.mjs';
import catalog from '../parameter-catalog.mjs';
import {GEOMETRY_PROMPT,PROMPT_VERSION} from './geometry-prompt.mjs';

export const UPSTREAM_ENDPOINT='https://token.moi.matrixorigin.cn/v1/chat/completions';
export const GEOMETRY_LIMITS=Object.freeze({images:5,imageBytes:12*1024*1024,totalImageBytes:12*1024*1024,totalPixels:50_000_000,maxEdge:8192,responseBytes:8*1024*1024});
const definitions=new Map(catalog.map(p=>[p.key,p]));
const encoder=new TextEncoder();
// Server-internal validation cache: only this module can brand a prepared input.
const PREPARED_INPUTS=new WeakMap();
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const han=v=>/[\u3400-\u9fff]/u.test(v);
const norm=v=>String(v).normalize('NFKC').replace(/\s+/g,' ').trim();
const ID=/^[A-Za-z0-9_-]{1,100}$/;
const DECIMAL=/[+\-−]?(?:\d+(?:\.\d*)?|\.\d+)/g;
const PARAMETER_KEYS=new Set(['id','key','instance_label','status','value_raw','nominal_raw','unit_raw','tolerance_raw','limit','annotation_region','object_region','leader_points','reason','evidence_text','evidence_ids','component','view','evidence_mode','missing_reason']);
const REQUIRED_PARAMETER=['id','key','instance_label','status','value_raw','nominal_raw','unit_raw','tolerance_raw','limit','annotation_region','object_region','leader_points','reason','evidence_text','evidence_ids'];

export class GeometryProviderError extends Error{
 constructor(code,message,status=502,details={}){super(message);this.name='GeometryProviderError';this.code=code;this.status=status;this.details=details;}
}
// Server diagnostics never retain credentials, image data, URLs or source hashes.
// Native messages are useful for runtime/egress failures; model text never enters here.
export function sanitizeGeometryDiagnostic(error,{secrets=[],sourceTokens=[]}={}){
 const raw=typeof error?.message==='string'?error.message:'';
 const names=new Set(['Error','TypeError','ReferenceError','RangeError','SyntaxError','DOMException','AbortError','TimeoutError','NotSupportedError','OperationError','DataError','InvalidStateError','NetworkError','SecurityError']);
 const name=names.has(error?.name)?error.name:'Error';
 const category=/ENOTFOUND|EAI_AGAIN|\bDNS\b|getaddrinfo|resolve.{0,30}host/i.test(raw)?'dns':/TLS|SSL|CERT_|certificate|handshake/i.test(raw)?'tls':/redirect/i.test(raw)?'redirect':/not allowed|prohibited|blocked|restricted|cross-origin|unsupported protocol|not permitted/i.test(raw)?'fetch_policy':/abort|cancelled|canceled/i.test(raw)?'abort':/digest|crypto|SHA-?256|algorithm/i.test(raw)?'crypto':/is not defined|is not a function|undefined|null|ReferenceError/i.test(raw)?'runtime':/fetch|network|socket|connection|ECONN|EHOSTUNREACH/i.test(raw)?'network':'other';
 let message=raw;
 for(const value of [...secrets,...sourceTokens])if(typeof value==='string'&&value)message=message.split(value).join('[REDACTED]');
 message=message.replace(/data:[^\s"'<>]*/gi,'[REDACTED_DATA]').replace(/https?:\/\/[^\s"'<>)]*/gi,'[REDACTED_URL]').replace(/Bearer\s+[^\s,;]+/gi,'Bearer [REDACTED]').replace(/[A-Za-z0-9+/_=-]{24,}/g,'[REDACTED_TOKEN]').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,384);
 return {name,category,message};
}
const inputError=message=>{throw new GeometryProviderError('invalid_geometry_input',message,400);};
function exactKeys(value,keys){return plain(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));}
function sourceRegion(value){
 if(!exactKeys(value,['x','y','width','height'])||!Object.values(value).every(v=>typeof v==='number'&&Number.isFinite(v))||value.x<0||value.y<0||value.width<=0||value.height<=0||value.x+value.width>1.000001||value.y+value.height>1.000001)inputError('图片区域必须位于同一完整页面内。');
 return {...value};
}
function signatureDimensions(data){
 const png=[137,80,78,71,13,10,26,10];
 if(data.length>=45&&png.every((n,i)=>data[i]===n)){
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  if(view.getUint32(8)!==13||String.fromCharCode(...data.subarray(12,16))!=='IHDR'||String.fromCharCode(...data.subarray(data.length-8,data.length-4))!=='IEND')inputError('PNG 文件签名或结构不完整。');
  return {mime:'image/png',width:view.getUint32(16),height:view.getUint32(20)};
 }
 if(data.length>=12&&data[0]===255&&data[1]===216&&data[data.length-2]===255&&data[data.length-1]===217){
  let i=2;
  while(i+4<=data.length){
   if(data[i++]!==255)inputError('JPEG 标记结构无效。');
   while(i<data.length&&data[i]===255)i++;
   const marker=data[i++];
   if(marker===217||marker===218)break;
   if(marker===1||(marker>=208&&marker<=215))continue;
   const length=(data[i]<<8)|data[i+1];
   if(length<2||i+length>data.length)inputError('JPEG 数据不完整。');
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
    if(length<8)inputError('JPEG 尺寸信息无效。');
    return {mime:'image/jpeg',height:(data[i+3]<<8)|data[i+4],width:(data[i+5]<<8)|data[i+6]};
   }
   i+=length;
  }
 }
 inputError('只接受具有有效文件签名的 PNG 或 JPEG 页面图片。');
}
/** SHA binds the result to the browser's original file; only image hashes can be verified here. */
export function validateGeometryRequest(body){
 if(!exactKeys(body,['page','document_sha256','images']))inputError('请求仅允许页码、原文件 SHA-256 和页面图片；不接受 URL、提示词、端点或模型。');
 if(!Number.isInteger(body.page)||body.page<1||body.page>500)inputError('来源页码无效。');
 if(typeof body.document_sha256!=='string'||!/^[a-f0-9]{64}$/i.test(body.document_sha256))inputError('原文件 SHA-256 无效。');
 if(!Array.isArray(body.images)||body.images.length<1||body.images.length>GEOMETRY_LIMITS.images)inputError('每次识别只接受一张整页及最多四张局部图。');
 let totalBytes=0,totalPixels=0;const seen=new Set();
 const images=body.images.map((spec,index)=>{
  if(!exactKeys(spec,['image_base64','region','image_id']))inputError('图片只允许 base64、来源区域和编号。');
  if(typeof spec.image_id!=='string'||!ID.test(spec.image_id)||seen.has(spec.image_id))inputError('图片编号无效或重复。');seen.add(spec.image_id);
  const region=sourceRegion(spec.region),full=region.x===0&&region.y===0&&region.width===1&&region.height===1;
  if(index===0&&!full)inputError('首张图片必须是当前页面的完整原图。');
  if(index>0&&full)inputError('后续图片必须是同页局部区域。');
  const raw=spec.image_base64;
  if(typeof raw!=='string'||!raw.length||raw.length>Math.ceil(GEOMETRY_LIMITS.imageBytes/3)*4||raw.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(raw))inputError('页面图片必须为大小受限的原始 base64，不接受 URL 或 data URL。');
  let binary;try{binary=atob(raw);}catch{inputError('图片 base64 无效。');}
  if(binary.length>GEOMETRY_LIMITS.imageBytes)inputError('单张图片超过 12 MiB。');
  const data=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)data[i]=binary.charCodeAt(i);
  const dimensions=signatureDimensions(data);
  if(!dimensions.width||!dimensions.height||dimensions.width>GEOMETRY_LIMITS.maxEdge||dimensions.height>GEOMETRY_LIMITS.maxEdge)inputError('图片尺寸超出支持范围。');
  totalBytes+=data.length;totalPixels+=dimensions.width*dimensions.height;
  if(totalBytes>GEOMETRY_LIMITS.totalImageBytes||totalPixels>GEOMETRY_LIMITS.totalPixels)inputError('单次页面图片总量超过 12 MiB 或 5000 万像素。');
  return {image_id:spec.image_id,region,image_base64:raw,data,...dimensions};
 });
 const prepared={page:body.page,document_sha256:body.document_sha256.toLowerCase(),images,totalBytes,totalPixels};PREPARED_INPUTS.set(prepared,body);return prepared;
}

const TRANSLATIONS={'CONTACT PIN':'接触针','BACK COVER':'后盖','HOUSING':'壳体','BODY':'本体','TERMINAL':'端子','INSULATOR':'绝缘体','SPRING':'弹簧','SHELL':'外壳','FRONT VIEW':'前视图','TOP VIEW':'俯视图','SIDE VIEW':'侧视图','BOTTOM VIEW':'底视图','REAR VIEW':'后视图','SECTION VIEW':'剖视图','DETAIL VIEW':'局部详图','NOTES':'技术说明','TECHNICAL NOTES':'技术说明','RECOMMEND PCB LAYOUT COMPONENT SIDE':'推荐印制板布局（元件侧）','RECOMMENDED PCB LAYOUT COMPONENT SIDE':'推荐印制板布局（元件侧）','RECOMMEND PCB LAYOUT':'推荐印制板布局','RECOMMENDED PCB LAYOUT':'推荐印制板布局','COMPONENT SIDE':'元件侧'};
function translated(raw){if(typeof raw!=='string'||han(raw))return null;const key=raw.replace(/\s+/g,' ').trim().toUpperCase();if(TRANSLATIONS[key])return TRANSLATIONS[key];const match=key.match(/^([1-9][0-9]{0,2}) PIN POGO PIN CONNECTOR$/);return match?match[1]+' 针弹簧针连接器':null;}
export function adaptGeometryProtocol(payload){
 const value=structuredClone(payload),changes=[];
 if(!plain(value)||value.schema_version!=='geometry-2.0'||!Array.isArray(value.parameters)||!Array.isArray(value.observations))return {value,changes};
 const observations=new Map();for(const o of value.observations){if(!plain(o)||typeof o.id!=='string'||observations.has(o.id))throw new Error('原文观察编号无效或重复');observations.set(o.id,o);}
 function change(p,index,key,next,basis){changes.push({path:`/parameters/${index}/${key}`,old:p[key]??null,new:structuredClone(next),basis});p[key]=structuredClone(next);}
 value.parameters.forEach((p,index)=>{
  if(!plain(p))return;
  if(p.status==='provided')change(p,index,'status','candidate','仅将非标准 provided 状态降为待复核候选。');
  if(Number.isSafeInteger(p.id)&&p.id>0&&p.id<=1_000_000)change(p,index,'id','p_'+p.id,'正整数编号转换为字符串协议编号，仍检查重复。');
  const cited=Array.isArray(p.evidence_ids)?p.evidence_ids.map(id=>observations.get(id)).filter(Boolean):[],raw=cited.map(o=>typeof o.raw_text==='string'?o.raw_text:'').join('\n');
  if(typeof p.evidence_text==='string'&&p.evidence_text.includes('\\n')){const decoded=p.evidence_text.replace(/\\n/g,'\n');if(decoded.split('\n').filter(line=>line.trim()).every(line=>norm(raw).includes(norm(line))))change(p,index,'evidence_text',decoded,'解码逐句可核对的换行分隔符，未改引用内容。');}
  if(p.evidence_mode==='explicit_note'&&p.annotation_region==null&&cited.length===1&&cited[0].region){const b=sourceRegion(cited[0].region);change(p,index,'annotation_region',b,'完整复制唯一引用观察的标注区域，未推断对象位置。');}
  for(const key of ['component','view']){const next=translated(p[key]);if(next!==null)change(p,index,key,next,'已知工程标签按固定词典翻译，原文保留在审计。');}
 });
 const ids=value.parameters.filter(plain).map(p=>p.id);if(ids.every(id=>typeof id==='string')&&new Set(ids).size!==ids.length)throw new Error('协议编号转换发生重复');
 return {value,changes};
}
function strictPayload(payload){
 if(!plain(payload)||payload.schema_version!=='geometry-2.0'||!['schema_version','observations','parameters','unmapped_annotations'].every(k=>Object.hasOwn(payload,k))||Object.keys(payload).some(k=>!['schema_version','observations','parameters','unmapped_annotations','part_description'].includes(k)))throw new Error('模型输出不是支持的几何协议');
 if(!Array.isArray(payload.observations)||payload.observations.length>300||!Array.isArray(payload.parameters)||payload.parameters.length>300||!Array.isArray(payload.unmapped_annotations)||payload.unmapped_annotations.length>300)throw new Error('模型输出条目超过限制');
 for(const o of payload.observations){if(!exactKeys(o,['id','raw_text','region'])||typeof o.id!=='string'||!ID.test(o.id)||typeof o.raw_text!=='string'||!o.raw_text.trim()||o.raw_text.length>6000)throw new Error('模型观察格式无效');sourceRegion(o.region);}
 for(const p of payload.parameters){
  if(!plain(p)||!REQUIRED_PARAMETER.every(k=>Object.hasOwn(p,k))||Object.keys(p).some(k=>!PARAMETER_KEYS.has(k)))throw new Error('模型参数字段不符合协议');
  if(p.status==='candidate'){
   const kind=definitions.get(p.key)?.kind;
   if(['length','diameter','radius'].includes(kind)&&/\bAWG\b|circular\s+mil|mm\s*[²2]|mm\^2/i.test([p.value_raw,p.unit_raw].join(' ')))throw new Error('面积或线规不能作为线性尺寸');
   if(p.nominal_raw!=null&&typeof p.value_raw==='string'&&!(p.value_raw.match(DECIMAL)||[]).includes(p.nominal_raw))throw new Error('名义值的数字或符号没有保留原标注');
  }
 }
 for(const p of payload.unmapped_annotations)if(!exactKeys(p,['id','raw_text','reason','region','evidence_ids']))throw new Error('未归类标注字段不符合协议');
}
function integerSetting(env,names,fallback,min,max){let value=fallback;for(const name of names)if(env[name]!=null&&env[name]!==''){value=Number(env[name]);break;}if(!Number.isSafeInteger(value)||value<min||value>max)throw new GeometryProviderError('server_configuration_invalid','识别服务配置无效。',503);return value;}
function configuration(env){
 const key=env.DRAWING_VLM_API_KEY,model=env.DRAWING_VLM_MODEL||'qwen3.8-max';
 if(typeof key!=='string'||!key.trim()||key.length>8192||/[\r\n]/.test(key))throw new GeometryProviderError('provider_not_configured','在线识图服务尚未配置可用凭据。',503);
 if(typeof model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(model))throw new GeometryProviderError('server_configuration_invalid','识别服务模型配置无效。',503);
 const timeout=integerSetting(env,['DRAWING_GEOMETRY_TIMEOUT','DRAWING_VLM_TIMEOUT'],600,1,600),maxTokens=integerSetting(env,['DRAWING_GEOMETRY_MAX_TOKENS','DRAWING_VLM_MAX_TOKENS'],24000,1,65536);
 const qwen=/^qwen3\.8(?:-[A-Za-z0-9_.-]+)?$/i.test(model),mode=env.DRAWING_GEOMETRY_THINKING_MODE??env.DRAWING_VLM_THINKING_MODE??(qwen?'enabled':'disabled');
 if(!['enabled','disabled'].includes(mode)||(!qwen&&mode!=='disabled'))throw new GeometryProviderError('server_configuration_invalid','识别服务思考模式配置无效。',503);
 const budget=mode==='enabled'?integerSetting(env,['DRAWING_GEOMETRY_THINKING_BUDGET','DRAWING_VLM_THINKING_BUDGET'],8000,1,maxTokens-1):null;
 return {key,model,timeout,maxTokens,qwen,mode,budget};
}
async function sha256(data){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function discardResponse(response){try{await response.body?.cancel();}catch{/* Cleanup must not replace the received HTTP status. */}}
async function readBounded(response,signal){
 const announced=Number(response.headers.get('content-length'));if(Number.isFinite(announced)&&announced>GEOMETRY_LIMITS.responseBytes)throw new GeometryProviderError('upstream_response_too_large','模型响应超过安全大小限制。');
 if(!response.body)throw new GeometryProviderError('upstream_empty_response','模型服务没有返回正文。');
 const reader=response.body.getReader(),chunks=[];let length=0;
 const abort=()=>{reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{while(true){if(signal.aborted)throw new DOMException('Aborted','AbortError');const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>GEOMETRY_LIMITS.responseBytes){await reader.cancel();throw new GeometryProviderError('upstream_response_too_large','模型响应超过安全大小限制。');}chunks.push(value);}}finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
 const all=new Uint8Array(length);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}return all;
}
/** Returns {result,audit}; the caller emits only final result/controlled errors, never reasoning. */
export async function extractGeometry(body,env,{signal,onProgress=()=>{},fetcher=fetch,preparedInput}={}){
 const input=preparedInput&&PREPARED_INPUTS.get(preparedInput)===body?preparedInput:validateGeometryRequest(body);PREPARED_INPUTS.delete(input);
 const cfg=configuration(env),started=Date.now(),controller=new AbortController();let timedOut=false,abortReject;
 const elapsed=()=>Math.round((Date.now()-started)/1000*1000)/1000;
 const cancel=()=>controller.abort();if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
 const abortPromise=new Promise((_,reject)=>{abortReject=()=>reject(new GeometryProviderError(timedOut?'provider_timeout':'request_cancelled',timedOut?'模型识别超时，请稍后重试；本次没有可用结果。':'识别已取消。',timedOut?504:499));controller.signal.addEventListener('abort',abortReject,{once:true});if(controller.signal.aborted)abortReject();});
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},cfg.timeout*1000);
 const audit={operation:'associate_geometry',prompt_version:PROMPT_VERSION,document_sha256:input.document_sha256,document_hash_basis:'caller_supplied_original_file_hash',page:input.page,model:cfg.model,image_payload_bytes:input.totalBytes,network_call_performed:false,failure_stage:'preparing',configuration:{timeout_seconds:cfg.timeout,output_token_limit:cfg.maxTokens,thinking_mode:cfg.mode,thinking_budget:cfg.budget},image_sources:[]};
 const report=phase=>onProgress({type:'progress',phase,message:{validating:'已检查页面图片，正在准备识别。',requesting:'模型正在读取图纸并关联部位，复杂页面可能需要数分钟。',checking:'模型已返回，正在核对数值、单位和来源。'}[phase]});
 try{
  const task=(async()=>{
   await report('validating');audit.failure_stage='image_hashing';
   for(const image of input.images){audit.image_sources.push({image_id:image.image_id,source_region:image.region,size:[image.width,image.height],image_sha256:await sha256(image.data)});delete image.data;}
   audit.failure_stage='request_encoding';
   const context={parameter_catalog:catalog,page:input.page,stage_one_used:false,stage_one_observations:[],source_images:audit.image_sources};
   const content=[{type:'text',text:JSON.stringify(context)}];
   input.images.forEach((image,i)=>{content.push({type:'text',text:'The following exact source image: '+JSON.stringify(audit.image_sources[i])+'. Return coordinates relative to the complete first image, not this tile.'},{type:'image_url',image_url:{url:`data:${image.mime};base64,${image.image_base64}`}});});
   const request={model:cfg.model,stream:false,response_format:{type:'json_object'},...(cfg.qwen?{max_completion_tokens:cfg.maxTokens,enable_thinking:cfg.mode==='enabled',...(cfg.budget?{thinking_budget:cfg.budget}:{})}:{max_tokens:cfg.maxTokens}),messages:[{role:'system',content:GEOMETRY_PROMPT},{role:'user',content}]};
   const bytes=encoder.encode(JSON.stringify(request));audit.failure_stage='request_hashing';audit.request_sha256=await sha256(bytes);
   if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');
   await report('requesting');audit.failure_stage='upstream_fetch';audit.network_call_performed=true;
   const response=await fetcher(UPSTREAM_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg.key},body:bytes,redirect:'manual',signal:controller.signal});
   audit.http_status=response.status;audit.failure_stage='upstream_status';
   // Workers supports manual/follow, not error. Never follow a redirect or
   // forward the service credential to its Location destination.
   if(response.status>=300&&response.status<400){await discardResponse(response);throw new GeometryProviderError('provider_redirect_rejected','模型服务返回了不允许的重定向，请联系管理员。',502,{upstream_status:response.status});}
   if(!response.ok){await discardResponse(response);const status=response.status;throw new GeometryProviderError(status===401||status===403?'provider_auth_failed':status===429?'provider_busy':'provider_unavailable',status===401||status===403?'模型服务凭据未通过验证，请联系管理员。':status===429?'模型服务繁忙，请稍后重试。':'模型服务暂不可用，请稍后重试。',status===429?503:502,{upstream_status:status});}
   audit.failure_stage='upstream_read';const raw=await readBounded(response,controller.signal);audit.failure_stage='response_hashing';audit.response_sha256=await sha256(raw);
   await report('checking');
   audit.failure_stage='response_json';let responseData,payload;
   try{const responseText=new TextDecoder('utf-8',{fatal:true}).decode(raw);if(responseText.includes(cfg.key))throw new Error('credential_echo');responseData=JSON.parse(responseText);const choice=responseData?.choices?.[0];if(choice?.finish_reason==='length')throw new Error('truncated');if(typeof choice?.message?.content!=='string'||!choice.message.content.trim())throw new Error('empty');payload=JSON.parse(choice.message.content);}catch{throw new GeometryProviderError('provider_invalid_output','模型未返回完整的结构化结果，本次内容未作为识别结果接收。');}
   try{
    audit.failure_stage='protocol_validation';const {value,changes}=adaptGeometryProtocol(payload);strictPayload(value);
    const result=validateGeometryImport({contentId:input.document_sha256,pages:[{page:input.page}]},{...value,document_sha256:input.document_sha256,page:input.page,model:cfg.model,elapsed_seconds:elapsed()});
    result.observations=result.observations.map(o=>({...o,origin:'cloud_model_transcription_unreviewed'}));
    result.human_review_required=true;result.operation='associate_geometry';result.coordinate_space='full_page_normalized_top_left';result.validation_scope='format_numeric_citations_only_not_geometry_correctness';
    if(changes.length)result.protocol_normalization_count=changes.length;
    audit.failure_stage='complete';audit.protocol_adapter={version:'geometry-protocol-1.0-cloud',changes,engineering_values_modified:false};audit.elapsed_seconds=elapsed();
    return {result,audit};
   }catch(error){audit.validation_error=String(error?.message||'Invalid geometry contract').split(cfg.key).join('[REDACTED]').slice(0,500);throw new GeometryProviderError('provider_validation_failed','模型结果未通过数值、单位或来源校验，本次内容未作为识别结果接收。');}
  })();
  return await Promise.race([task,abortPromise]);
 }catch(error){
  audit.elapsed_seconds=elapsed();
  if(!(error instanceof GeometryProviderError))audit.native_error=sanitizeGeometryDiagnostic(error,{secrets:[cfg.key,env.SESSION_SIGNING_KEY],sourceTokens:[input.document_sha256,...input.images.map(image=>image.image_base64)]});
  const safe=error instanceof GeometryProviderError?error:new GeometryProviderError(timedOut?'provider_timeout':controller.signal.aborted?'request_cancelled':'provider_transport_error',timedOut?'模型识别超时，请稍后重试；本次没有可用结果。':controller.signal.aborted?'识别已取消。':'模型连接失败，请稍后重试。',timedOut?504:controller.signal.aborted?499:502);
  safe.audit={...audit,failure:{code:safe.code,message:safe.message}};
  throw safe;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',abortReject);}
}
