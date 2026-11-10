import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {checkedMigrationStatements,applyLocalMigrations,d1Adapter,assetBinding} from '../scripts/preview-worker.mjs';

test('local migration checker accepts only bounded project usage schema creation',()=>{
 const sql='CREATE TABLE `specflow_jobs` (`id` text PRIMARY KEY);--> statement-breakpoint\nCREATE INDEX `specflow_owner_created` ON `specflow_jobs` (`id`);';assert.equal(checkedMigrationStatements(sql).length,2);
 for(const bad of ['DROP TABLE specflow_jobs;','ATTACH DATABASE "/tmp/other.sqlite" AS other;','CREATE TABLE secrets (value text);','CREATE TABLE specflow_jobs (id TEXT); DELETE FROM specflow_jobs;','CREATE INDEX unowned ON specflow_jobs (id);'])assert.throws(()=>checkedMigrationStatements(bad));
});
test('checked drizzle migrations apply idempotently only to local SQLite with recorded hashes',async()=>{
 const db=new DatabaseSync(':memory:');try{
  await applyLocalMigrations(db);const columns=db.prepare('PRAGMA table_info(specflow_jobs)').all().map(r=>r.name);assert.deepEqual(columns,['id','owner','ip_hash','status','created_at','expires_at','error_code']);
  const count=db.prepare('SELECT COUNT(*) AS n FROM _specflow_local_migrations').get().n;await applyLocalMigrations(db);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _specflow_local_migrations').get().n,count);
  db.prepare('UPDATE _specflow_local_migrations SET sha256=?').run('changed');await assert.rejects(applyLocalMigrations(db),/被修改/);
 }finally{db.close();}
 const unrelated=new DatabaseSync(':memory:');try{unrelated.exec('CREATE TABLE unrelated (id TEXT)');await assert.rejects(applyLocalMigrations(unrelated),/其他应用/);assert.equal(unrelated.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='specflow_jobs'").get().n,0);}finally{unrelated.close();}
});
test('local D1 adapter executes parameter binding and transactional batches with rollback',async()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE examples (id TEXT PRIMARY KEY,value INTEGER)');const d1=d1Adapter(db);
  const r=await d1.prepare('INSERT INTO examples VALUES(?,?)').bind('a',1).run();assert.equal(r.meta.changes,1);
  assert.equal(await d1.prepare('SELECT value FROM examples WHERE id=?').bind('a').first('value'),1);
  await assert.rejects(d1.batch([d1.prepare('INSERT INTO examples VALUES(?,?)').bind('b',2),d1.prepare('INSERT INTO examples VALUES(?,?)').bind('a',3)]));
  assert.equal(await d1.prepare('SELECT value FROM examples WHERE id=?').bind('b').first(),null);
 }finally{db.close();}
});
test('asset binding serves the built asset root without traversal or symlink escape',async()=>{
 const root=await mkdtemp(join(tmpdir(),'specflow-preview-assets-')),outside=await mkdtemp(join(tmpdir(),'specflow-preview-outside-'));
 try{
  await writeFile(join(root,'index.html'),'<p>local</p>');await writeFile(join(outside,'outside.txt'),'not an asset');await symlink(join(outside,'outside.txt'),join(root,'escape.txt'));
  const assets=assetBinding(root);const home=await assets.fetch(new Request('http://localhost:46664/'));assert.equal(home.status,200);assert.equal(await home.text(),'<p>local</p>');assert.match(home.headers.get('Content-Type'),/html/);
  assert.equal((await assets.fetch(new Request('http://localhost:46664/escape.txt'))).status,404);
  assert.equal((await assets.fetch(new Request('http://localhost:46664/%2e%2e%2foutside.txt'))).status,404);
  assert.equal((await assets.fetch(new Request('http://localhost:46664/',{method:'POST'}))).status,405);
  const head=await assets.fetch(new Request('http://localhost:46664/',{method:'HEAD'}));assert.equal(await head.text(),'');
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
