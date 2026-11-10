import test from 'node:test';
import assert from 'node:assert/strict';
import {extractGeometry,validateGeometryRequest,adaptGeometryProtocol,GeometryProviderError,GEOMETRY_LIMITS,UPSTREAM_ENDPOINT} from '../worker/geometry-provider.mjs';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWUYAAAAASUVORK5CYII=';
const region={x:0,y:0,width:1,height:1},box={x:.2,y:.3,width:.2,height:.1};
const request=()=>({page:3,document_sha256:'c'.repeat(64),images:[{image_id:'full_page',region:{...region},image_base64:png}]});
const env={DRAWING_VLM_API_KEY:'server-only-secret',DRAWING_VLM_MODEL:'qwen3.8-max'};
const payload=()=>({schema_version:'geometry-2.0',observations:[{id:'d',raw_text:'9.50 ±0.20 DIA',region:box},{id:'u',raw_text:'DIMENSIONS IN mm',region:box}],parameters:[{id:'hole1',key:'mounting_hole_diameter',instance_label:'前端安装通孔',status:'candidate',value_raw:'9.50 ±0.20 DIA',nominal_raw:'9.50',unit_raw:'mm',tolerance_raw:'±0.20',limit:null,annotation_region:box,object_region:box,leader_points:[{x:.2,y:.3},{x:.4,y:.3}],reason:'直径标注的引线指向前端安装孔的内圆。',evidence_text:'9.50 ±0.20 DIA\nDIMENSIONS IN mm',evidence_ids:['d','u']}],unmapped_annotations:[],part_description:'带安装通孔的接线端子。'});
const response=(value=payload(),extra={})=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value),reasoning_content:'private internal model reasoning'}}],...extra}),{headers:{'Content-Type':'application/json'}});

// Transport is injected by server-side tests only; no real credential or network is used.
test('cloud provider sends fixed endpoint/server settings and returns source-bound validated candidates',async()=>{
 const events=[];
 const output=await extractGeometry(request(),env,{onProgress:e=>events.push(e),fetcher:async(url,options)=>{
  assert.equal(url,UPSTREAM_ENDPOINT);assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'Bearer '+env.DRAWING_VLM_API_KEY);
  const data=JSON.parse(new TextDecoder().decode(options.body));assert.equal(data.model,'qwen3.8-max');assert.equal(data.enable_thinking,true);assert.equal(data.thinking_budget,8000);assert.equal(data.max_completion_tokens,24000);assert.equal(data.stream,false);
  assert.equal(data.messages[0].role,'system');assert.match(data.messages[0].content,/115/);assert.equal(data.messages[1].content.filter(p=>p.type==='image_url').length,1);
  const context=JSON.parse(data.messages[1].content[0].text);assert.equal(context.parameter_catalog.length,115);assert.equal(context.page,3);assert.equal(context.stage_one_used,false);
  return response();
 }});
 assert.equal(output.result.document_sha256,'c'.repeat(64));assert.equal(output.result.page,3);assert.equal(output.result.parameters[0].nominal_raw,'9.50');assert.equal(output.result.parameters[0].status,'candidate');assert.equal(output.result.observations[0].origin,'cloud_model_transcription_unreviewed');assert.equal(output.result.human_review_required,true);
 assert.deepEqual(events.map(e=>e.phase),['validating','requesting','checking']);assert.equal(output.audit.document_hash_basis,'caller_supplied_original_file_hash');assert.match(output.audit.image_sources[0].image_sha256,/^[a-f0-9]{64}$/);
 const exposed=JSON.stringify(output)+JSON.stringify(events);assert(!exposed.includes('private internal'));assert(!exposed.includes(env.DRAWING_VLM_API_KEY));assert(!exposed.includes(png));
});
test('caller cannot choose URL, endpoint, prompt, model or unbound page',async()=>{
 for(const change of [v=>v.endpoint='https://evil.invalid',v=>v.model='override',v=>v.prompt='override',v=>v.images[0].url='https://evil.invalid/a.png',v=>v.images[0].image_base64='data:image/png;base64,'+png,v=>v.images[0].image_base64='https://evil.invalid',v=>v.page=0,v=>v.document_sha256='notsha',v=>v.images[0].region.x=.1]){
  const body=request();change(body);assert.throws(()=>validateGeometryRequest(body),GeometryProviderError);
 }
 let calls=0;const bad=request();bad.model='override';await assert.rejects(extractGeometry(bad,env,{fetcher:async()=>{calls++;return response();}}),e=>e.status===400);assert.equal(calls,0);
});
test('signature/size/pixel bounds and same-page image count fail closed',()=>{
 const bad=request();bad.images[0].image_base64=btoa('<html>not an image</html>');assert.throws(()=>validateGeometryRequest(bad),/PNG|JPEG/);
 const oversize=request();oversize.images[0].image_base64='A'.repeat(Math.ceil(GEOMETRY_LIMITS.imageBytes/3)*4+4);assert.throws(()=>validateGeometryRequest(oversize),/大小|base64/);
 const six=request();six.images=Array.from({length:6},(_,i)=>({...six.images[0],image_id:'p'+i}));assert.throws(()=>validateGeometryRequest(six),/最多四/);
 const dupe=request();dupe.images.push({...dupe.images[0],region:{x:0,y:0,width:.6,height:.6}});assert.throws(()=>validateGeometryRequest(dupe),/重复/);
 const huge=request(),bytes=Buffer.from(png,'base64');bytes.writeUInt32BE(9000,16);huge.images[0].image_base64=bytes.toString('base64');assert.throws(()=>validateGeometryRequest(huge),/尺寸/);
 const fullTwice=request();fullTwice.images.push({...fullTwice.images[0],image_id:'second'});assert.throws(()=>validateGeometryRequest(fullTwice),/局部/);
});
test('provider 503 and authentication failure expose controlled error without raw service body',async()=>{
 for(const status of [401,503])await assert.rejects(extractGeometry(request(),env,{fetcher:async()=>new Response('Authorization Bearer server-only-secret internal details',{status})}),error=>{
  assert(error instanceof GeometryProviderError);assert.equal(error.status,502);assert.equal(error.details.upstream_status,status);assert.equal(error.audit.http_status,status);assert.equal(error.audit.network_call_performed,true);assert(!JSON.stringify(error).includes('server-only-secret'));return true;
 });
});
test('timeout aborts request and retains elapsed configuration without transport secrets',async()=>{
 const started=Date.now();let receivedSignal;
 await assert.rejects(extractGeometry(request(),{...env,DRAWING_GEOMETRY_TIMEOUT:'1'},{fetcher:async(_url,options)=>{receivedSignal=options.signal;return new Promise(()=>{});}}),error=>{
  assert.equal(error.code,'provider_timeout');assert.equal(error.status,504);assert(error.audit.elapsed_seconds>=.9);assert.equal(error.audit.configuration.timeout_seconds,1);return true;
 });assert(Date.now()-started<2500);assert.equal(receivedSignal.aborted,true);
});
test('caller cancellation and transport errors never expose arbitrary exception text',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 await assert.rejects(extractGeometry(request(),env,{signal:controller.signal,fetcher:async()=>{calls++;return response();}}),e=>e.code==='request_cancelled'&&e.status===499);assert.equal(calls,0);
 await assert.rejects(extractGeometry(request(),env,{fetcher:async()=>{throw Error('server-only-secret private-network-route');}}),e=>e.code==='provider_transport_error'&&!JSON.stringify(e).includes('server-only-secret')&&!e.message.includes('private-network-route'));
});
test('invalid JSON, truncated output and oversized response are not imported',async()=>{
 const fetchers=[async()=>new Response('not-json'),async()=>response(payload(),{choices:[{finish_reason:'length',message:{content:'{}'}}]}),async()=>new Response('small',{headers:{'Content-Length':String(GEOMETRY_LIMITS.responseBytes+1)}})];
 for(const fetcher of fetchers)await assert.rejects(extractGeometry(request(),env,{fetcher}),e=>['provider_invalid_output','upstream_response_too_large'].includes(e.code));
});
test('numeric, unit, dimension type and citation violations remain strict',async()=>{
 for(const mutate of [p=>p.parameters[0].nominal_raw='19.50',p=>p.parameters[0].unit_raw='inch',p=>p.parameters[0].tolerance_raw='±0.30',p=>p.parameters[0].evidence_ids=['missing'],p=>p.parameters[0].status='approved',p=>p.parameters[0].object_region=null,p=>p.parameters[0].nominal_raw='-9.50',p=>{p.parameters[0].unit_raw='mm²';p.parameters[0].evidence_text+='\nmm²';p.observations[1].raw_text+=' mm²';}]){
  const data=payload();mutate(data);await assert.rejects(extractGeometry(request(),env,{fetcher:async()=>response(data)}),e=>e.code==='provider_validation_failed');
 }
});
test('limited protocol adapter records downgrade/translation without changing engineering values',async()=>{
 const data=payload();Object.assign(data.parameters[0],{id:1,status:'provided',component:'CONTACT PIN',view:'FRONT VIEW',evidence_text:'9.50 ±0.20 DIA\\nDIMENSIONS IN mm'});
 const before=structuredClone(data);const adapted=adaptGeometryProtocol(data);assert.deepEqual(data,before);assert.equal(adapted.value.parameters[0].status,'candidate');assert.equal(adapted.value.parameters[0].id,'p_1');assert.equal(adapted.value.parameters[0].component,'接触针');assert.equal(adapted.value.parameters[0].value_raw,before.parameters[0].value_raw);
 const output=await extractGeometry(request(),env,{fetcher:async()=>response(data)});assert.equal(output.audit.protocol_adapter.changes.length,5);assert.equal(output.result.protocol_normalization_count,5);
 const unknown=payload();unknown.parameters[0].component='UNKNOWN_CUSTOM_NAME';await assert.rejects(extractGeometry(request(),env,{fetcher:async()=>response(unknown)}),e=>e.code==='provider_validation_failed');
});
test('explicit-note missing box can only copy its sole cited region',async()=>{
 const data={schema_version:'geometry-2.0',observations:[{id:'n',raw_text:'WORKING HEIGHT 4.80mm',region:box}],parameters:[{id:1,key:'working_mating_height',instance_label:'工作状态插合高度',status:'candidate',value_raw:'4.80',nominal_raw:'4.80',unit_raw:'mm',tolerance_raw:null,limit:null,annotation_region:null,object_region:null,leader_points:[],evidence_mode:'explicit_note',reason:'文字说明明确写出工作状态的插合高度。',evidence_text:'WORKING HEIGHT 4.80mm',evidence_ids:['n']}],unmapped_annotations:[]};
 const output=await extractGeometry(request(),env,{fetcher:async()=>response(data)});assert.deepEqual(output.result.parameters[0].annotation_region,box);assert.equal(output.result.parameters[0].object_region,null);
 data.parameters[0].evidence_ids.push('n2');data.observations.push({...data.observations[0],id:'n2'});await assert.rejects(extractGeometry(request(),env,{fetcher:async()=>response(data)}),e=>e.code==='provider_validation_failed');
});
test('missing server credential never sends images and upstream credential echo is rejected',async()=>{
 let calls=0;await assert.rejects(extractGeometry(request(),{}, {fetcher:async()=>{calls++;return response();}}),e=>e.code==='provider_not_configured');assert.equal(calls,0);
 await assert.rejects(extractGeometry(request(),env,{fetcher:async()=>response(payload(),{reasoning_content:env.DRAWING_VLM_API_KEY})}),e=>e.code==='provider_invalid_output'&&!JSON.stringify(e).includes(env.DRAWING_VLM_API_KEY));
});
test('streamed response size is bounded even without a Content-Length header',async()=>{
 let cancelled=false;
 const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(GEOMETRY_LIMITS.responseBytes));controller.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}});
 await assert.rejects(extractGeometry(request(),env,{fetcher:async()=>new Response(stream)}),e=>e.code==='upstream_response_too_large');assert.equal(cancelled,true);
});
test('bad model region remains a provider contract failure, not a client input error',async()=>{
 const data=payload();data.observations[0].region={...box,x:2};
 await assert.rejects(extractGeometry(request(),env,{fetcher:async()=>response(data)}),e=>e.code==='provider_validation_failed'&&e.status===502&&typeof e.audit.validation_error==='string');
});
test('server-prepared image validation is reused once and cannot be supplied through HTTP JSON',async()=>{
 const body=request(),preparedInput=validateGeometryRequest(body);assert(preparedInput.images[0].data instanceof Uint8Array);
 const output=await extractGeometry(body,env,{preparedInput,fetcher:async()=>response()});assert.equal(output.result.page,body.page);assert(!Object.hasOwn(preparedInput.images[0],'data'));
 const bad=request();bad.preparedInput={images:[]};await assert.rejects(extractGeometry(bad,env,{preparedInput,fetcher:async()=>response()}),e=>e.code==='invalid_geometry_input');
 const forged=request();forged.images[0].image_base64='not base64';await assert.rejects(extractGeometry(forged,env,{preparedInput:{...preparedInput},fetcher:async()=>response()}),e=>e.code==='invalid_geometry_input');
});
test('native transport diagnostics retain failure stage and bounded redacted runtime cause only',async()=>{
 const body=request();
 await assert.rejects(extractGeometry(body,env,{fetcher:async()=>{throw new TypeError('fetch blocked: '+env.DRAWING_VLM_API_KEY+' data:image/png;base64,'+png+' https://private.invalid/path?token=abc '+body.document_sha256+' '+'Z'.repeat(1000));}}),error=>{
  assert.equal(error.code,'provider_transport_error');assert.equal(error.audit.failure_stage,'upstream_fetch');assert.equal(error.audit.network_call_performed,true);assert.equal(error.audit.native_error.name,'TypeError');assert.equal(error.audit.native_error.category,'fetch_policy');assert(error.audit.native_error.message.length<=384);
  for(const forbidden of [env.DRAWING_VLM_API_KEY,png,'private.invalid',body.document_sha256,'Z'.repeat(24)])assert(!error.audit.native_error.message.includes(forbidden));
  assert(!error.message.includes('blocked'));return true;
 });
});
test('early native hashing failure is distinguished from attempted network transport',async t=>{
 let calls=0;t.mock.method(globalThis.crypto.subtle,'digest',()=>{throw new ReferenceError('crypto digest is not defined');});
 await assert.rejects(extractGeometry(request(),env,{fetcher:async()=>{calls++;return response();}}),error=>{
  assert.equal(error.audit.failure_stage,'image_hashing');assert.equal(error.audit.network_call_performed,false);assert.equal(error.audit.native_error.name,'ReferenceError');assert.match(error.audit.native_error.message,/digest/);return true;
 });assert.equal(calls,0);
});

test('upstream redirects are never followed and return controlled diagnostics without Location',async()=>{
 for(const status of [300,301,302,303,307,308]){
  let calls=0;const destination='https://untrusted.invalid/collect?secret='+env.DRAWING_VLM_API_KEY;
  await assert.rejects(extractGeometry(request(),env,{fetcher:async(url,options)=>{
   calls++;assert.equal(url,UPSTREAM_ENDPOINT);assert.equal(options.redirect,'manual');
   return new Response('redirect target '+destination,{status,headers:{Location:destination}});
  }}),error=>{
   assert.equal(error.code,'provider_redirect_rejected');assert.equal(error.status,502);assert.equal(error.audit.http_status,status);assert.equal(error.audit.failure_stage,'upstream_status');assert.equal(error.audit.network_call_performed,true);
   assert(!JSON.stringify(error).includes(destination));assert(!JSON.stringify(error).includes(env.DRAWING_VLM_API_KEY));return true;
  });assert.equal(calls,1);
 }
});

test('failed response-body cleanup cannot replace the received HTTP status classification',async()=>{
 for(const [status,code] of [[302,'provider_redirect_rejected'],[401,'provider_auth_failed'],[429,'provider_busy'],[503,'provider_unavailable']]){
  let cancelled=false;
  await assert.rejects(extractGeometry(request(),env,{fetcher:async()=>({status,ok:false,body:{async cancel(){cancelled=true;throw new TypeError('cleanup failure '+env.DRAWING_VLM_API_KEY);}}})}),error=>{
   assert.equal(error.code,code);assert.equal(error.audit.http_status,status);assert.equal(error.audit.failure_stage,'upstream_status');assert.equal(error.audit.native_error,undefined);assert(!JSON.stringify(error).includes('cleanup failure'));return true;
  });assert(cancelled);
 }
});
