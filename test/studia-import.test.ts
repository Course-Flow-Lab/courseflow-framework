import { withHttp, type HttpRuntime } from './support/harness.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { importStudia, studiaArchive } from '../src/core/studia-import.ts';
import { Db } from '../src/core/db.ts';
import { Vault } from '../src/core/vault.ts';
import { digest, nowSeconds } from '../src/core/domain.ts';
import { createUser, createSession, verifyPassword } from '../src/core/auth.ts';
import { preferences } from '../src/core/preferences.ts';
import { AnswerMemory } from '../src/services/answers.ts';
import { createRuntime } from '../src/runtime.ts';
import { configFor, call, tokenFrom } from './support/harness.ts';

function fixture(root: string) {
  const source=path.join(root,'old'); fs.mkdirSync(source);
  const key=Buffer.alloc(32,7), salt=Buffer.alloc(16,3);
  fs.writeFileSync(path.join(source,'secret.key'),key.toString('base64url'),{mode:0o600});
  const hash=`pbkdf2_sha256$10000$${salt.toString('base64')}$${pbkdf2Sync('pass2026',salt,10000,32,'sha256').toString('base64')}`;
  const db=new DatabaseSync(path.join(source,'studia.db'));
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,password TEXT,role TEXT,disabled INTEGER,created REAL); CREATE TABLE zhs_answers(key TEXT,correct TEXT,wrong TEXT,updated TEXT)');
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run('legacy-admin','old-admin',hash,'admin',0,100);
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run('legacy-member','old-member',hash,'user',1,100);
  const legacyKey=digest('{"blanks": 0, "kind": 1, "options": ["乙", "甲"], "title": "合成题"}');
  db.prepare('INSERT INTO zhs_answers VALUES(?,?,?,?)').run(legacyKey,'["乙"]','[]','2026-01-01');
  const scopedKey=digest('{"blanks": 0, "kind": 1, "options": ["乙", "甲"], "scope": "shared/scoped", "title": "课程隔离题"}');
  db.prepare('INSERT INTO zhs_answers VALUES(?,?,?,?)').run(scopedKey,'["甲"]','[]','2026-01-01'); db.close();
  const user=path.join(source,'users','legacy-admin'); fs.mkdirSync(user,{recursive:true});
  const settings={version:1,concurrency:{study:3},quiet_hours:false,ai_profiles:{active_id:'mine',items:[{id:'mine',provider_name:'合成模型',base_url:'https://synthetic.invalid/v1',model:'synthetic-model',api_key:'synthetic-private-key',api_format:'chat_completions'},{id:'builtin-default',base_url:'https://synthetic.invalid',model:'never-import',api_key:'synthetic-builtin-key'}]},session_cx:{cookies:{UID:'synthetic-cookie'}}};
  const cipher=createCipheriv('aes-256-gcm',key,Buffer.alloc(16,9)); cipher.setAAD(Buffer.from('legacy-admin'));
  const body=Buffer.concat([cipher.update(JSON.stringify(settings)),cipher.final()]);
  fs.writeFileSync(path.join(user,'settings.enc'),JSON.stringify({v:1,nonce:Buffer.alloc(16,9).toString('base64'),data:body.toString('base64'),tag:cipher.getAuthTag().toString('base64')}));
  fs.writeFileSync(path.join(user,'jobs.json'),JSON.stringify({active:[{platform:'cx',course:'synthetic'}],history:[{message:'合成历史',password:'synthetic-hidden-password'}]}));
  fs.mkdirSync(path.join(user,'ai_results')); fs.writeFileSync(path.join(user,'ai_results','report.md'),'合成报告');
  return source;
}

test('Studia 只读预检不写目标，AES-GCM 16 字节随机数可导入，账号和模型密钥保留并重新加密',async(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'courseflow-studia-import-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=fixture(root), destination=path.join(root,'new');
  const sourceHash=digest(fs.readFileSync(path.join(source,'studia.db')).toString('base64'));
  const cli=JSON.parse(execFileSync(process.execPath,['src/main.ts','migrate','legacy','--source',source,'--destination',destination,'--dry-run'],{encoding:'utf8',env:{...process.env,CF_HTTP_PROXY:''}}));
  assert.equal(cli.dry_run,true);assert.equal(cli.users,2);assert.ok(!fs.existsSync(destination));
  const plan=await importStudia({source,destination,dryRun:true}); assert.equal(plan.users,2); assert.equal(plan.archived_files,2); assert.ok(!fs.existsSync(destination));
  const report=await importStudia({source,destination}); assert.equal(report.users,2); assert.equal('personal_models' in report && report.personal_models,1);
  const db=new Db(path.join(destination,'courseflow.db')); t.after(()=>db.close()); const vault=Vault.open(path.join(destination,'secret.key'),true);
  const user=db.get<{password_hash:string;role:string}>('SELECT password_hash,role FROM users WHERE id=?1','legacy-admin')!;
  assert.ok(await verifyPassword('pass2026',user.password_hash)); assert.equal(user.role,'admin');
  assert.equal(preferences(db,'legacy-admin').concurrency,3); assert.equal(preferences(db,'legacy-admin').quiet_hours,false);
  assert.equal(db.get<{n:number}>('SELECT COUNT(*) AS n FROM tasks')!.n,0); assert.equal(db.get<{n:number}>('SELECT COUNT(*) AS n FROM sessions')!.n,0);
  const model=db.get<{id:string;key_sealed:Uint8Array}>('SELECT id,key_sealed FROM ai_models')!;
  assert.equal(vault.openJson('legacy-admin',`ai/${model.id}`,Buffer.from(model.key_sealed)),'synthetic-private-key');
  const memory=new AnswerMemory(db,vault);
  assert.deepEqual(memory.get('legacy-admin','zhs','synthetic-course',{id:'q',kind:'single',text:'合成题',options:[{id:'A',text:'甲'},{id:'B',text:'乙'}],answer:[],blanks:0}),['B']);
  const scoped={id:'q',kind:'single' as const,text:'课程隔离题',options:[{id:'A',text:'甲'},{id:'B',text:'乙'}],answer:[],blanks:0};
  assert.deepEqual(memory.get('legacy-admin','zhs','scoped/class',scoped,'shared'),['A']);
  assert.equal(memory.get('legacy-admin','zhs','other/class',scoped,'shared'),null);
  memory.record('legacy-admin','zhs','scoped/class',scoped,['A'],{result:'incorrect',source:'platform'});
  assert.equal(memory.get('legacy-admin','zhs','scoped/class',scoped,'shared'),null);
  assert.equal((studiaArchive(db,vault,'legacy-admin','ai_results/report.md') as Buffer).toString(),'合成报告');
  assert.equal(digest(fs.readFileSync(path.join(source,'studia.db')).toString('base64')),sourceHash);
  for(const file of ['courseflow.db','secret.key']) assert.equal(fs.statSync(path.join(destination,file)).mode&0o777,0o600);
  assert.equal(fs.statSync(destination).mode&0o777,0o700);
  assert.ok(!fs.readFileSync(path.join(destination,'courseflow.db')).includes(Buffer.from('synthetic-private-key')));
});

test('旧密码可从站点登录，迁移档案按用户隔离，导出 JSON 隐藏凭据且不暴露配置',async(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'courseflow-studia-http-')); let runtime:HttpRuntime|undefined;
  t.after(async()=>{await runtime?.close();fs.rmSync(root,{recursive:true,force:true});});
  const source=fixture(root),destination=path.join(root,'new'); await importStudia({source,destination});
  runtime=withHttp(await createRuntime(configFor(destination)),configFor(destination));
  const login=await call(runtime,{method:'POST',url:'/api/auth/login',body:{username:'old-admin',password:'pass2026'}}); assert.equal(login.status,200);
  const session={token:tokenFrom(login.setCookie),csrf:login.body.csrf};
  assert.equal((await call(runtime,{url:'/api/settings',session})).body.legacy.total,2);
  assert.equal((await call(runtime,{url:'/api/legacy/studia'})).status,401);
  const download=await runtime.app.inject({url:'/api/legacy/studia/archive?name=jobs.json',headers:{cookie:`cf_session=${session.token}`}});
  assert.equal(download.statusCode,200); assert.match(download.body,/合成历史/); assert.doesNotMatch(download.body,/synthetic-hidden-password|password/);
  assert.equal((await runtime.app.inject({url:'/api/legacy/studia/archive?name=settings.enc',headers:{cookie:`cf_session=${session.token}`}})).statusCode,404);
  const another=await createUser(runtime.db,'new-member','synthetic-new-member-password','user',nowSeconds()); const other=createSession(runtime.db,another.id,nowSeconds());
  assert.equal((await call(runtime,{url:'/api/legacy/studia/archive?name=jobs.json',session:other})).status,404);
  assert.equal((await call(runtime,{method:'POST',url:'/api/auth/login',body:{username:'old-member',password:'pass2026'}})).status,401);
});

test('错误旧密钥、非空目标和用户目录符号链接不会覆盖任何已有数据',async(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'courseflow-studia-failure-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=fixture(root), destination=path.join(root,'new'); const wrong=path.join(root,'wrong-key');fs.writeFileSync(wrong,Buffer.alloc(32,2).toString('base64url'));
  await assert.rejects(importStudia({source,destination,keyFile:wrong}),/无法解密/);assert.ok(!fs.existsSync(destination));
  fs.mkdirSync(destination);fs.writeFileSync(path.join(destination,'keep'),'保留');await assert.rejects(importStudia({source,destination}),/目标目录/);assert.equal(fs.readFileSync(path.join(destination,'keep'),'utf8'),'保留');
  const member=path.join(source,'users','legacy-member');fs.symlinkSync(path.join(source,'users','legacy-admin'),member);
  await assert.rejects(importStudia({source,destination:path.join(root,'other')}),/符号链接/);
});

test('单用户 settings.json 以密码文件创建新管理员，旧报告仅封存',async(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'courseflow-studia-local-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'old');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'settings.json'),JSON.stringify({version:1}));
  const file=path.join(root,'password');fs.writeFileSync(file,'synthetic-local-admin-password\n',{mode:0o600});
  const destination=path.join(root,'new'); await importStudia({source,destination,username:'local-admin',passwordFile:file});
  const db=new Db(path.join(destination,'courseflow.db'));t.after(()=>db.close());const user=db.get<{password_hash:string;role:string}>('SELECT * FROM users')!;
  assert.equal(user.role,'admin');assert.ok(await verifyPassword('synthetic-local-admin-password',user.password_hash));
});
