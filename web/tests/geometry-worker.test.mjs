import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHandler} from '../worker/index.mjs';
const origin='https://specflow.test';
const secret='session-signing-secret-long-enough-for-hmac-validation';
const apiKey='private-service-account-key';
const baseTime=Date.UTC(2026,10,10,12,0,0);
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWUYAAAAASUVORK5CYII=';
const payload=()=>({page:1,document_sha256:'c'.repeat(64),images:[{image_id:'full_page',image_base64:png,region:{x:0,y:0,width:1,height:1}}]});
const result=body=>({schema_version:'geometry-2.0',document_sha256:body.document_sha256,page:body.page,observations:[],parameters:[],unmapped_annotations:[],human_review_required:true});
function setup(options={}){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(`CREATE TABLE specflow_jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,ip_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('running','succeeded','failed','cancelled')),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,error_code TEXT);
 CREATE INDEX owner_created ON specflow_jobs(owner,created_at);CREATE INDEX status_expires ON specflow_jobs(status,expires_at);CREATE INDEX ip_created ON specflow_jobs(ip_hash,created_at);`);
 const db={prepare(sql){return {bind(...args){return {async run(){const r=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes)}};}};}};}};
 const env={SESSION_SIGNING_KEY:secret,DRAWING_VLM_API_KEY:apiKey,DB:db,ASSETS:{fetch:async()=>new Response('static asset')}};
 const calls=[];let timestamp=baseTime;
 const extractor=options.extractor||(async(body,_env,opts)=>{calls.push(body);await opts.onProgress({phase:'requesting',message:'do not echo untrusted provider text'});return {result:result(body),audit:{private:'must not be emitted'}};});
 const handler=createHandler({extractor,now:()=>timestamp,logger:()=>{},...options});
 return {sqlite,env,handler,calls,setTime:value=>timestamp=value,rows:()=>sqlite.prepare('SELECT * FROM specflow_jobs ORDER BY created_at,id').all(),close:()=>sqlite.close()};
}
async function login(app,headers={}){
 const response=await app.handler(new Request(origin+'/api/geometry-status',{headers}),app.env);
 assert.equal(response.status,200);const value=await response.json();
 const set=response.headers.get('Set-Cookie');return {cookie:set?.split(';')[0]||headers.Cookie,csrf:value.csrf_token,status:value,setCookie:set};
}
function post(session,body=payload(),headers={},options={}){
 return new Request(origin+'/api/geometry-extract',{method:'POST',headers:{Cookie:session.cookie,'X-CSRF-Token':session.csrf,Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json','CF-Connecting-IP':'203.0.113.1',...headers},body:typeof body==='string'?body:JSON.stringify(body),...options});
}
async function events(response){const text=await response.text();return text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}

// D1 adapter executes the actual production SQL with SQLite, not mocked quota decisions.
test('status issues secure HMAC session and CSRF, reuses valid session, and never claims tested connectivity',async()=>{
 const a=setup();try{
  const s=await login(a);assert.match(s.setCookie,/__Host-specflow_session=[a-f0-9]{32}\.[a-f0-9]+\.[a-f0-9]{64}/);for(const attr of ['Path=/','HttpOnly','Secure','SameSite=Strict','Max-Age=86400'])assert(s.setCookie.includes(attr));
  assert.equal(s.status.endpoint,'/api/geometry-extract');assert.equal(s.status.configured,true);assert.equal(s.status.limits.isolate_concurrency,1);assert.equal(s.status.provider_connectivity_tested,false);assert.match(s.csrf,/^[a-f0-9]{64}$/);
  const reused=await login(a,{Cookie:s.cookie});assert.equal(reused.setCookie,null);assert.equal(reused.csrf,s.csrf);
  assert(!JSON.stringify(s.status).includes(secret));assert(!JSON.stringify(s.status).includes(apiKey));assert.equal(a.rows().length,0);
 }finally{a.close();}
});
test('successful request emits only progress and one terminal result, closes, and stores usage metadata only',async()=>{
 const a=setup();try{
  const s=await login(a),response=await a.handler(post(s),a.env);assert.equal(response.status,200);assert.match(response.headers.get('Content-Type'),/ndjson/);
  const list=await events(response);assert.deepEqual(list.map(e=>e.type),['progress','result']);assert.equal(list.at(-1).result.document_sha256,'c'.repeat(64));assert.equal(a.calls.length,1);
  const serialized=JSON.stringify(list);for(const prohibited of [secret,apiKey,'private','do not echo',png])assert(!serialized.includes(prohibited));
  const rows=a.rows();assert.equal(rows.length,1);assert.equal(rows[0].status,'succeeded');assert.equal(rows[0].error_code,null);assert.match(rows[0].owner,/^[a-f0-9]{64}$/);assert.match(rows[0].ip_hash,/^[a-f0-9]{64}$/);assert(!JSON.stringify(rows).includes('203.0.113.1'));assert(!JSON.stringify(rows).includes('c'.repeat(64)));
  assert.deepEqual(Object.keys(rows[0]).sort(),['id','owner','ip_hash','status','created_at','expires_at','error_code'].sort());
 }finally{a.close();}
});
test('same-origin, valid cookie and CSRF are all required before work is reserved',async()=>{
 const a=setup();try{
  const s=await login(a);
  for(const headers of [{Origin:'https://evil.test'},{Origin:'null'},{'Sec-Fetch-Site':'cross-site'},{Cookie:''},{'X-CSRF-Token':''},{'X-CSRF-Token':'a'.repeat(64)},{Cookie:s.cookie.slice(0,-1)+(s.cookie.endsWith('a')?'b':'a')}]){
   const response=await a.handler(post(s,payload(),headers),a.env);assert.equal(response.status,403);assert.equal((await response.json()).code.length>0,true);
  }assert.equal(a.rows().length,0);assert.equal(a.calls.length,0);
 }finally{a.close();}
});
test('expired cookies fail POST and refresh to a new session on status GET',async()=>{
 const a=setup();try{
  const s=await login(a);a.setTime(baseTime+86401*1000);
  assert.equal((await a.handler(post(s),a.env)).status,403);
  const next=await login(a,{Cookie:s.cookie});assert(next.setCookie);assert.notEqual(next.cookie,s.cookie);assert.notEqual(next.csrf,s.csrf);
 }finally{a.close();}
});
test('invalid JSON, wrong content-type, URL overrides and streaming body overflow never call model or reserve quota',async()=>{
 const a=setup({maxBodyBytes:1024});try{
  const s=await login(a);
  for(const [body,headers,status] of [['{broken',{},400],[payload(),{'Content-Type':'text/plain'},415],[{...payload(),endpoint:'https://evil.test'}, {},400]])assert.equal((await a.handler(post(s,body,headers),a.env)).status,status);
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(800));c.enqueue(new Uint8Array(800));c.close();}});
  const req=post(s,'',{'Content-Length':'1'},{body:stream,duplex:'half'});assert.equal((await a.handler(req,a.env)).status,413);
  assert.equal(a.rows().length,0);assert.equal(a.calls.length,0);
 }finally{a.close();}
});
test('single atomic SQL reservation enforces owner/global concurrency across separate isolates with actual SQLite',async()=>{
 const pending=[],extractor=async(body)=>new Promise(resolve=>pending.push(()=>resolve({result:result(body)}))),a=setup({extractor}),responses=[];
 const isolate=()=>createHandler({extractor,now:()=>baseTime});
 try{
  const s1=await login(a),r1=await a.handler(post(s1),a.env);responses.push(r1);assert.equal(r1.status,200);
  assert.equal((await isolate()(post(s1),a.env)).status,429);
  for(let i=0;i<2;i++){const s=await login(a);responses.push(await isolate()(post(s,payload(),{'CF-Connecting-IP':`203.0.113.${i+2}`}),a.env));}
  const fourth=await login(a);assert.equal((await isolate()(post(fourth),a.env)).status,429);assert.equal(a.rows().filter(r=>r.status==='running').length,3);
  for(const done of pending)done();await Promise.all(responses.map(events));assert.equal(a.rows().filter(r=>r.status==='succeeded').length,3);
 }finally{for(const done of pending)done();a.close();}
});
test('owner hourly limit counts completed requests and opens after an hour',async()=>{
 const a=setup();try{
  const s=await login(a);for(let i=0;i<10;i++)await events(await a.handler(post(s),a.env));
  const blocked=await a.handler(post(s),a.env);assert.equal(blocked.status,429);assert.equal(blocked.headers.get('Retry-After'),'60');assert.equal(a.rows().length,10);
  a.setTime(baseTime+3601*1000);const next=await a.handler(post(s),a.env);assert.equal(next.status,200);await events(next);assert.equal(a.rows().length,11);
 }finally{a.close();}
});
test('IP hourly quota survives new anonymous sessions and does not trust X-Forwarded-For',async()=>{
 const a=setup();try{
  for(let group=0;group<3;group++){const s=await login(a);for(let i=0;i<10;i++)await events(await a.handler(post(s,payload(),{'X-Forwarded-For':`198.51.100.${i}`}),a.env));}
  const fresh=await login(a);assert.equal((await a.handler(post(fresh),a.env)).status,429);assert.equal(a.rows().length,30);
  const otherIp=await a.handler(post(fresh,payload(),{'CF-Connecting-IP':'203.0.113.99'}),a.env);assert.equal(otherIp.status,200);await events(otherIp);
 }finally{a.close();}
});
test('heartbeats precede one terminal result and stop after completion',async()=>{
 let resolve;const a=setup({heartbeatMs:5,extractor:async(body)=>new Promise(done=>{resolve=()=>done({result:result(body)});})});
 try{
  const s=await login(a),response=await a.handler(post(s),a.env),reader=response.body.getReader();
  const first=JSON.parse(new TextDecoder().decode((await reader.read()).value));assert.equal(first.type,'progress');assert.equal(first.phase,'waiting');
  resolve();let remaining='';while(true){const row=await reader.read();if(row.done)break;remaining+=new TextDecoder().decode(row.value);}const list=remaining.trim().split('\n').filter(Boolean).map(JSON.parse);assert.equal(list.at(-1).type,'result');assert.equal(list.filter(e=>e.type==='result').length,1);
 }finally{resolve?.();a.close();}
});
test('client cancellation aborts provider but holds concurrency lease until expiry',async()=>{
 let providerSignal;const a=setup({extractor:async(_body,_env,{signal})=>{providerSignal=signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('private cancellation data'),{code:'request_cancelled'})),{once:true}));}});
 try{
  const s=await login(a),response=await a.handler(post(s),a.env);await response.body.cancel();assert.equal(providerSignal.aborted,true);
  await new Promise(resolve=>setTimeout(resolve,0));const row=a.rows()[0];assert.equal(row.status,'running');assert.equal(row.error_code,'request_cancelled');assert.equal(row.expires_at,Math.floor(baseTime/1000)+660);
  assert.equal((await a.handler(post(s),a.env)).status,429);
  // A new handler with a successful extractor uses the same D1/session after the held lease expires.
  a.setTime(baseTime+661*1000);const handler=createHandler({now:()=>baseTime+661*1000,extractor:async body=>({result:result(body)})});await events(await handler(post(s),a.env));assert.equal(a.rows().length,2);
 }finally{a.close();}
});
test('controlled provider failures close stream, release lease and never expose audit or arbitrary error text',async()=>{
 const a=setup({extractor:async()=>{const error=Error(apiKey+' internal details');error.code='provider_unavailable';error.audit={private:secret};throw error;}});
 try{
  const s=await login(a),list=await events(await a.handler(post(s),a.env));assert.equal(list.length,1);assert.equal(list[0].type,'error');assert.equal(list[0].code,'provider_unavailable');assert(!JSON.stringify(list).includes(apiKey));assert(!JSON.stringify(list).includes(secret));assert.equal(a.rows()[0].status,'failed');
 }finally{a.close();}
});
test('missing configuration fails closed for geometry while static and unknown-route behavior remain available',async()=>{
 const a=setup();try{
  const partial={...a.env};delete partial.DRAWING_VLM_API_KEY;
  assert.equal((await a.handler(new Request(origin+'/api/geometry-status'),partial)).status,503);
  assert.equal(await (await a.handler(new Request(origin+'/'),partial)).text(),'static asset');
  for(const path of ['/api/unknown','/api']){const r=await a.handler(new Request(origin+path),partial);assert.equal(r.status,404);assert.match(r.headers.get('Content-Type'),/json/);}
  const legacy=await (await a.handler(new Request(origin+'/api/vision-status'),a.env)).json();assert.equal(legacy.available,false);assert.equal(legacy.geometry_endpoint,'/api/geometry-extract');
  assert.equal((await a.handler(new Request(origin+'/api/geometry-extract'),a.env)).status,405);
 }finally{a.close();}
});
test('cleanup is bounded and removes only usage rows older than 24h with expired leases',async()=>{
 const a=setup();try{
  const now=Math.floor(baseTime/1000),insert=a.sqlite.prepare('INSERT INTO specflow_jobs VALUES(?,?,?,?,?,?,?)');
  for(let i=0;i<205;i++)insert.run('old'+i,'owner','ip','failed',now-90000,now-89000,'error');
  insert.run('recent','owner','ip','succeeded',now-20,now-10,null);
  await login(a);assert.equal(a.rows().length,6);assert(a.rows().some(r=>r.id==='recent'));
 }finally{a.close();}
});

test('isolate admission protects memory across anonymous sessions and releases on validation failure/completion',async()=>{
 const pending=[];const a=setup({extractor:async body=>new Promise(resolve=>pending.push(()=>resolve({result:result(body)})))});
 try{
  const first=await login(a),second=await login(a);
  assert.equal((await a.handler(post(first,'not-json'),a.env)).status,400);
  const running=await a.handler(post(second),a.env);assert.equal(running.status,200);
  assert.equal((await a.handler(post(first),a.env)).status,429);assert.equal(a.rows().length,1);
  pending.shift()();await events(running);
  const after=await a.handler(post(first),a.env);assert.equal(after.status,200);pending.shift()();await events(after);
 }finally{for(const done of pending)done();a.close();}
});
test('disconnect keeps isolate admission until the extractor settles',async()=>{
 let rejectPending;const a=setup({extractor:async()=>new Promise((_resolve,reject)=>{rejectPending=reject;})});
 try{
  const first=await login(a),second=await login(a),response=await a.handler(post(first),a.env);
  await response.body.cancel();assert.equal((await a.handler(post(second),a.env)).status,429);
  rejectPending(Object.assign(Error('cancelled upstream'),{code:'request_cancelled'}));await new Promise(resolve=>setTimeout(resolve,0));
  // Admission is free after settlement; malformed input now fails validation, not busy.
  assert.equal((await a.handler(post(second,'not-json'),a.env)).status,400);
 }finally{rejectPending?.(Object.assign(Error('cancelled'),{code:'request_cancelled'}));a.close();}
});
test('failure logger emits one sanitized server-only diagnostic and excludes source/audit secrets',async()=>{
 const logs=[],a=setup({logger:record=>logs.push(record),extractor:async body=>{
  const error=new Error('unsafe outer '+apiKey);error.code='provider_transport_error';error.audit={network_call_performed:true,http_status:503,failure_stage:'upstream_fetch',document_sha256:body.document_sha256,request:{image:png},private:secret,native_error:{name:'TypeError',message:'fetch failed '+apiKey+' '+secret+' data:image/png;base64,'+png+' https://secret.invalid/'+body.document_sha256+' '+body.document_sha256}};throw error;
 }});try{
  const s=await login(a),list=await events(await a.handler(post(s),a.env));assert.equal(list.at(-1).type,'error');assert.equal(list.at(-1).code,'provider_transport_error');assert.equal(logs.length,1);
  const record=logs[0];assert.equal(record.event,'geometry_request_failed');assert.equal(record.request_id,list.at(-1).request_id);assert.equal(record.network_call_performed,true);assert.equal(record.http_status,503);assert.equal(record.failure_stage,'upstream_fetch');assert.equal(record.native_error.name,'TypeError');assert.equal(record.native_error.category,'network');assert.equal(record.elapsed_seconds,0);
  assert.deepEqual(Object.keys(record).sort(),['event','request_id','code','elapsed_seconds','network_call_performed','http_status','failure_stage','native_error'].sort());
  for(const value of [apiKey,secret,png,payload().document_sha256,'secret.invalid','unsafe outer'])assert(!JSON.stringify(record).includes(value));
  assert(!JSON.stringify(list).includes('native_error'));assert(!JSON.stringify(list).includes('failure_stage'));assert(!JSON.stringify(list).includes('fetch failed'));
 }finally{a.close();}
});
test('diagnostic logger exceptions cannot prevent terminal error or memory admission release',async()=>{
 const a=setup({logger:()=>{throw Error('logger unavailable');},extractor:async()=>{const e=new Error('failed');e.code='provider_transport_error';throw e;}});try{
  const s=await login(a);for(let i=0;i<2;i++){const response=await a.handler(post(s),a.env);assert.equal(response.status,200);const list=await events(response);assert.equal(list.at(-1).code,'provider_transport_error');}assert.equal(a.rows().length,2);
 }finally{a.close();}
});
