import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { boot,call,setupAdmin,waitFor } from './support/harness.ts';

const moduleDir=fileURLToPath(new URL('../../courseflow-chaoxing/',import.meta.url));
const python=process.env.CF_CX_PYTHON??'/usr/bin/python3';
let available=fs.existsSync(path.join(moduleDir,'main.py'));
try{execFileSync(python,['-c','import lxml, Crypto, fontTools'],{stdio:'ignore'});}catch{available=false;}
test('超星 Python 模块通过真实 RPC 子进程完成离线登录、五类学习与人工确认作答', {skip:available?false:'需要 ../courseflow-chaoxing 和 CF_CX_PYTHON 所指的模块依赖环境'},async(t)=>{
  const {runtime}=await boot('courseflow-cx-contract-');t.after(()=>runtime.close());
  runtime.manager.install(moduleDir);runtime.manager.configure('cx',{source:'fixture',python});
  const session=await setupAdmin(runtime);
  const begin=await call(runtime,{method:'POST',url:'/api/platforms/cx/login',session,body:{method:'qr'}});assert.equal(begin.status,200);
  const poll=await call(runtime,{method:'POST',url:'/api/platforms/cx/login/'+begin.body.challenge.session+'/poll',session});assert.equal(poll.body.state,'connected');
  const course=(await call(runtime,{url:'/api/platforms/cx/courses',session})).body.courses[0];
  const root=`/api/platforms/cx/courses/${course.id}/${course.recruit_id}`;
  const units=(await call(runtime,{url:root+'/units',session})).body.units;
  assert.deepEqual(units.map((u:any)=>u.kind),['video','audio','document','reading','empty']);
  const created=await call(runtime,{method:'POST',url:root+'/jobs',session,body:{operation:'study',unit_ids:units.map((u:any)=>u.id)}});assert.equal(created.status,200,JSON.stringify(created.body));
  await waitFor(runtime,session,created.body.task.id,'completed');
  const answering=await call(runtime,{method:'POST',url:root+'/jobs',session,body:{operation:'answer',item_ids:['synthetic-work'],options:{use_ai:false}}});assert.equal(answering.status,200);
  await waitFor(runtime,session,answering.body.task.id,'paused');
  const owner=(await call(runtime,{url:'/api/me',session})).body.user.id;
  runtime.jobs.answers(owner,answering.body.task.id,{answers:{'synthetic-question':['B']}});runtime.jobs.resume(owner,answering.body.task.id);
  await waitFor(runtime,session,answering.body.task.id,'paused');runtime.jobs.confirm(owner,answering.body.task.id);
  await waitFor(runtime,session,answering.body.task.id,'completed');
  assert.equal(runtime.db.get<{n:number}>('SELECT COUNT(*) AS n FROM write_ledger')!.n,0,'fixture 不得发出平台写入');
});
