#!/usr/bin/env node
/** Local preview of the built Worker with real environment-configured model calls.
 * No .env/credential/PAT files are read; no remote database is ever migrated.
 */
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,mkdir,lstat,realpath,stat,chmod} from 'node:fs/promises';
import {resolve,dirname,relative,sep,extname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const LOCAL=resolve(ROOT,'.local');
const ASSETS=resolve(ROOT,'dist/client');
const BUILT_WORKER=resolve(ROOT,'dist/server/index.js');
const ENVIRONMENT_KEYS=['DRAWING_VLM_API_KEY','DRAWING_VLM_MODEL','DRAWING_VLM_TIMEOUT','DRAWING_VLM_MAX_TOKENS','DRAWING_VLM_THINKING_MODE','DRAWING_VLM_THINKING_BUDGET','DRAWING_GEOMETRY_TIMEOUT','DRAWING_GEOMETRY_MAX_TOKENS','DRAWING_GEOMETRY_THINKING_MODE','DRAWING_GEOMETRY_THINKING_BUDGET'];
const MIME={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.wasm':'application/wasm','.gz':'application/gzip','.txt':'text/plain; charset=utf-8','.ico':'image/x-icon'};
const hash=data=>createHash('sha256').update(data).digest('hex');
const isWithin=(root,path)=>{const r=relative(root,path);return r===''||(!r.startsWith('..'+sep)&&r!=='..'&&!r.startsWith(sep));};

/** Only checked project schema creation is supported; new migration kinds need review. */
export function checkedMigrationStatements(sql){
 if(typeof sql!=='string'||sql.length>1024*1024)throw Error('本机迁移文件超出支持范围。');
 const statements=sql.split('--> statement-breakpoint').flatMap(part=>part.split(';')).map(s=>s.trim()).filter(Boolean);
 if(!statements.length)throw Error('本机迁移文件没有可执行语句。');
 for(const statement of statements){
  if(/\b(?:ATTACH|DETACH|DROP|DELETE|UPDATE|INSERT|PRAGMA|REPLACE|TRIGGER|VIRTUAL)\b/i.test(statement))throw Error('本机预览仅允许已检查的图纸用量表和索引创建迁移。');
  const table=/^CREATE\s+TABLE\s+[`"]?specflow_jobs[`"]?\s*\([\s\S]*\)$/i.test(statement);
  const index=/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+[`"]?specflow_[A-Za-z0-9_]+[`"]?\s+ON\s+[`"]?specflow_jobs[`"]?\s*\([\s\S]*\)$/i.test(statement);
  if(!table&&!index)throw Error('本机预览拒绝未经检查的迁移语句。');
 }
 return statements;
}
export async function applyLocalMigrations(database){
 const migrationRoot=resolve(ROOT,'drizzle'),journal=JSON.parse(await readFile(resolve(migrationRoot,'meta/_journal.json'),'utf8'));
 if(journal.dialect!=='sqlite'||!Array.isArray(journal.entries)||journal.entries.length>100)throw Error('需要有效的已检查 SQLite 迁移日志。');
 const existing=database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
 if(existing.some(row=>!['specflow_jobs','_specflow_local_migrations'].includes(row.name)))throw Error('本机预览数据库含其他应用的表，拒绝迁移。');
 const migrations=[];const seen=new Set();
 for(const entry of journal.entries){
  if(typeof entry.tag!=='string'||!/^\d{4}_[A-Za-z0-9_-]+$/.test(entry.tag)||seen.has(entry.tag))throw Error('迁移日志条目无效或重复。');seen.add(entry.tag);
  const path=resolve(migrationRoot,entry.tag+'.sql'),actual=await realpath(path);if(!isWithin(migrationRoot,actual))throw Error('迁移文件必须位于项目 drizzle 目录。');
  const sql=await readFile(actual,'utf8');migrations.push({tag:entry.tag,sha:hash(sql),statements:checkedMigrationStatements(sql)});
 }
 database.exec('CREATE TABLE IF NOT EXISTS _specflow_local_migrations (tag TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)');
 for(const migration of migrations){
  const applied=database.prepare('SELECT sha256 FROM _specflow_local_migrations WHERE tag=?').get(migration.tag);
  if(applied){if(applied.sha256!==migration.sha)throw Error('已应用的本机迁移被修改，请先人工检查。');continue;}
  database.exec('BEGIN IMMEDIATE');
  try{for(const sql of migration.statements)database.exec(sql);database.prepare('INSERT INTO _specflow_local_migrations VALUES(?,?,?)').run(migration.tag,migration.sha,Math.floor(Date.now()/1000));database.exec('COMMIT');}
  catch(error){database.exec('ROLLBACK');throw error;}
 }
}
export function d1Adapter(database){
 function prepared(sql,args=[]){
  return {
   bind(...values){return prepared(sql,values);},
   async run(){const result=database.prepare(sql).run(...args);return {success:true,meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};},
   async all(){return {success:true,results:database.prepare(sql).all(...args)};},
   async first(column){const row=database.prepare(sql).get(...args);return row==null?null:column==null?row:row[column];}
  };
 }
 return {prepare:sql=>prepared(sql),async batch(statements){database.exec('BEGIN IMMEDIATE');try{const result=[];for(const statement of statements)result.push(await statement.run());database.exec('COMMIT');return result;}catch(error){database.exec('ROLLBACK');throw error;}}};
}
export function assetBinding(root=ASSETS){
 const canonicalRoot=realpath(root).catch(()=>null);
 return {async fetch(request){
  const actualRoot=await canonicalRoot;if(!actualRoot)return new Response('Not found',{status:404});
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}});
  let pathname;try{pathname=decodeURIComponent(new URL(request.url).pathname);}catch{return new Response('Bad path',{status:400});}
  if(pathname.includes('\0')||pathname.includes('\\'))return new Response('Bad path',{status:400});
  const path=resolve(actualRoot,'.'+(pathname==='/'?'/index.html':pathname));if(!isWithin(actualRoot,path))return new Response('Not found',{status:404});
  try{
   const actual=await realpath(path);if(!isWithin(actualRoot,actual)||(await stat(actual)).isDirectory())return new Response('Not found',{status:404});
   const data=await readFile(actual);return new Response(request.method==='HEAD'?null:data,{headers:{'Content-Type':MIME[extname(actual)]||'application/octet-stream','Content-Length':String(data.length),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }catch{return new Response('Not found',{status:404});}
 }};
}
function headerMap(raw){const headers=new Headers();for(let i=0;i<raw.length;i+=2)headers.append(raw[i],raw[i+1]);return headers;}
async function drain(response){await new Promise((resolve,reject)=>{const cleanup=()=>{response.off('drain',ready);response.off('close',closed);};const ready=()=>{cleanup();resolve();};const closed=()=>{cleanup();reject(Error('client_closed'));};response.once('drain',ready);response.once('close',closed);});}

export async function startPreview({port=46664,environment=process.env}={}){
 if(!Number.isInteger(port)||port<0||port>65535)throw Error('端口必须为 0–65535 的整数。');
 if(!(await stat(BUILT_WORKER)).isFile()||!(await stat(resolve(ASSETS,'index.html'))).isFile())throw Error('请先执行 node build.mjs，生成 Worker 和 dist/client。');
 await mkdir(LOCAL,{recursive:true,mode:0o700});if((await lstat(LOCAL)).isSymbolicLink())throw Error('本机预览状态目录不能是符号链接。');
 const databasePath=resolve(LOCAL,'preview-worker.sqlite');try{if((await lstat(databasePath)).isSymbolicLink())throw Error('本机数据库不能是符号链接。');}catch(error){if(error.code!=='ENOENT')throw error;}
 const database=new DatabaseSync(databasePath);await chmod(databasePath,0o600);
 try{await applyLocalMigrations(database);}catch(error){database.close();throw error;}
 database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
 const env=Object.fromEntries(ENVIRONMENT_KEYS.filter(key=>environment[key]!=null).map(key=>[key,environment[key]]));
 env.SESSION_SIGNING_KEY=environment.SESSION_SIGNING_KEY||randomBytes(32).toString('hex');
 env.DB=d1Adapter(database);env.ASSETS=assetBinding();
 const worker=(await import(pathToFileURL(BUILT_WORKER).href)).default;
 if(typeof worker?.fetch!=='function'){database.close();throw Error('构建产物没有 Worker fetch 入口。');}
 const active=new Set();let listeningPort=port;
 const server=http.createServer(async(req,res)=>{
  const host=req.headers.host;
  if(![`localhost:${listeningPort}`,`127.0.0.1:${listeningPort}`].includes(host)||typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//')){res.writeHead(403,{'Content-Type':'application/json'});res.end('{"error":"invalid_host"}');return;}
  const controller=new AbortController();active.add(controller);let reader;
  const abort=()=>controller.abort();req.on('aborted',abort);const disconnected=()=>{if(!res.writableFinished){abort();reader?.cancel().catch(()=>{});}};res.on('close',disconnected);
  try{
   const request=new Request(`http://${host}${req.url}`,{method:req.method,headers:headerMap(req.rawHeaders),signal:controller.signal,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
   const response=await worker.fetch(request,env);
   if(controller.signal.aborted)return;
   const headers=Object.fromEntries(response.headers);const cookies=response.headers.getSetCookie?.();if(cookies?.length)headers['set-cookie']=cookies;
   res.writeHead(response.status,headers);res.flushHeaders();
   if(response.body){reader=response.body.getReader();while(!controller.signal.aborted){const {value,done}=await reader.read();if(done)break;if(!res.write(Buffer.from(value)))await drain(res);}}
   if(!controller.signal.aborted)res.end();
  }catch{
   if(!res.headersSent&&!res.destroyed){res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"error":"local_preview_failed","message":"本机预览请求未完成。"}');}else if(!res.destroyed)res.destroy();
  }finally{
   active.delete(controller);req.off('aborted',abort);res.off('close',disconnected);if(controller.signal.aborted)await reader?.cancel().catch(()=>{});reader?.releaseLock();
  }
 });
 server.headersTimeout=15000;server.requestTimeout=650000;
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);listeningPort=server.address().port;resolve();});});}catch(error){database.close();throw error;}
 let closing=false;
 const close=async()=>{if(closing)return;closing=true;for(const controller of active)controller.abort();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});database.close();};
 return {url:`http://localhost:${listeningPort}`,port:listeningPort,close,providerConfigured:typeof env.DRAWING_VLM_API_KEY==='string'&&!!env.DRAWING_VLM_API_KEY.trim(),databasePath};
}

async function main(){
 const args=process.argv.slice(2);if(args.includes('--help')){process.stdout.write('Usage: node scripts/preview-worker.mjs [--port 46664]\nReads provider credentials only from existing process environment. Run node build.mjs first.\n');return;}
 let port=46664;if(args.length){if(args.length!==2||args[0]!=='--port'||!/^\d+$/.test(args[1]))throw Error('仅支持 --port 参数。');port=Number(args[1]);}
 process.umask(0o077);
 const preview=await startPreview({port});
 process.stdout.write(`SpecFlow 本机 Worker 预览：${preview.url}\n仅监听127.0.0.1；请始终使用上方localhost地址以保持Origin一致。\n模型凭据：${preview.providerConfigured?'来自已有进程环境；真实调用可能消耗服务额度':'未配置；静态页面可用，在线识图将返回503'}。\n仅迁移本机 .local/preview-worker.sqlite；未读取任何密钥文件，未连接或迁移云端数据库。\n修改代码并重新构建后，请重启本预览。\n`);
 const stop=()=>preview.close().then(()=>process.exit(0),()=>process.exit(1));process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write('本机预览未启动：'+(error.code==='ENOENT'?'请先执行 node build.mjs。':error.code==='EADDRINUSE'?'端口已被占用；请指定其他 --port。':error.message)+'\n');process.exitCode=1;});
