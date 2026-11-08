import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { boot, call, setupAdmin, waitFor } from './support/harness.ts';

test('超额问答按用户保存，客户端不能伪造开关，关闭后运行步骤恢复默认限制',async(t)=>{
  const {runtime}=await boot('courseflow-qa-limits-');t.after(()=>runtime.close());
  const session=await setupAdmin(runtime);
  runtime.manager.install(fileURLToPath(new URL('../modules/simulator',import.meta.url)));
  const begin=await call(runtime,{method:'POST',url:'/api/platforms/sim/login',session});
  await call(runtime,{method:'POST',url:`/api/platforms/sim/login/${begin.body.challenge.id}/poll`,session});
  const owner=(await call(runtime,{url:'/api/me',session})).body.user.id;
  const course=(await runtime.manager.courses(owner,'sim'))[0]!;
  const create=(operation:string,options:Record<string,unknown>)=>runtime.jobs.create(owner,{platform:'sim',course,unit_ids:['course'],operation,options});
  assert.equal((await call(runtime,{url:'/api/settings',session})).body.preferences.qa_allow_over_limit,false);
  assert.throws(()=>create('qa',{limit:21,allow_over_limit:true}),/1–20/);
  assert.throws(()=>create('ask',{texts:Array(11).fill('合成提问正文包含足够的字数'),allow_over_limit:true}),/1–10/);
  assert.equal((await call(runtime,{method:'POST',url:'/api/settings/preferences',session,body:{qa_allow_over_limit:'true'}})).status,400);
  assert.equal((await call(runtime,{method:'POST',url:'/api/settings/preferences',session,body:{qa_allow_over_limit:true}})).status,200);
  assert.throws(()=>create('qa',{limit:51}),/1–50/);
  assert.throws(()=>create('ask',{texts:Array(51).fill('合成提问正文包含足够的字数')}),/1–50/);
  assert.equal(runtime.db.get<{n:number}>('SELECT count(*) AS n FROM tasks')?.n,0,'被拒绝的数量不能留下残缺任务');
  const observed:boolean[]=[];
  runtime.manager.invoke=async(_owner,_platform,method,params)=>{assert.equal(method,'activity.step');observed.push((params.options as any).allow_over_limit);return {status:'needs_human',reason:'合成暂停'};};
  const task=create('qa',{limit:30});await waitFor(runtime,session,task.id,'paused');assert.deepEqual(observed,[true]);
  await call(runtime,{method:'POST',url:'/api/settings/preferences',session,body:{qa_allow_over_limit:false}});
  runtime.jobs.resume(owner,task.id);await waitFor(runtime,session,task.id,'paused');assert.ok(observed.length>=2);assert.ok(observed.slice(1).every(value=>value===false));
});
