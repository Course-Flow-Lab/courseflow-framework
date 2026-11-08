import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createUser } from '../src/core/auth.ts';
import { nowSeconds } from '../src/core/domain.ts';
import { boot, setupAdmin, call } from './support/harness.ts';
import type { Runtime } from '../src/runtime.ts';

function moduleSource(directory: string, id: string, permission: boolean, loop = false) {
  const source=path.join(directory,id);fs.mkdirSync(source);
  const manifest={schemaVersion:1,id,name:'离线题库契约',version:'0.1.0',moduleApi:1,engines:{framework:'>=0.1.0 <0.2.0'},runtime:{engine:'node',entry:'index.mjs',files:[]},platform:{id,name:'离线题库',short:'离线',login:['qr'],operations:['study'],unit_kinds:['video']},permissions:{network:[],browser:false,ai:false,question_bank:permission,storage:'module'}};
  fs.writeFileSync(path.join(source,'courseflow.module.json'),JSON.stringify(manifest));
  fs.writeFileSync(path.join(source,'index.mjs'),`import {createInterface} from 'node:readline';import{readFileSync}from'node:fs';const manifest=JSON.parse(readFileSync(new URL('./courseflow.module.json',import.meta.url)));const pending=new Map();let seq=10000;const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');const host=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});send({jsonrpc:'2.0',id,method,params});});createInterface({input:process.stdin}).on('line',async line=>{const m=JSON.parse(line);if(!m.method){const p=pending.get(m.id);if(p){pending.delete(m.id);if(m.error)p.reject(m.error);else p.resolve(m.result);}return;}try{let result;if(m.method==='platform.describe')result={module:{name:manifest.id,version:manifest.version,module_api:1},platform:manifest.platform};else if(m.method==='catalog.courses'){const n=m.params.cursor??0;result={courses:[{id:String(n),recruit_id:'class',name:'synthetic',kind:'synthetic',outline_available:false}],next_cursor:${loop?'1':"n<2?n+1:null"}};}else result=await host(m.method==='identity.probe'?'cw.session.identity':m.method==='bank.record'?'cw.question_bank.record':m.method==='bank.confirm'?'cw.question_bank.confirm':'cw.question_bank.lookup',m.params);send({jsonrpc:'2.0',id:m.id,result});}catch(error){send({jsonrpc:'2.0',id:m.id,error:{code:error.code??'test_failure',message:error.message??'test failure'}});}});`);
  return source;
}
function connect(runtime: Runtime, owner: string, platform: string) {
  const challenge=runtime.sessions.openChallenge(owner,platform,180);
  const entry=runtime.sessions.challenge(challenge,owner);
  entry.cookies=[{name:'_uid',value:'7',domain:'synthetic.invalid',path:'/',secure:true,http_only:true},{name:'fid',value:'8',domain:'synthetic.invalid',path:'/',secure:true,http_only:true},{name:'private-token',value:'synthetic-private-token',domain:'synthetic.invalid',path:'/',secure:true,http_only:true}];
  runtime.sessions.complete(owner,platform,challenge,{account_raw:'7',display_name:'合成账号'});
}
const question={id:'q',text:'合成隔离题',kind:'single',options:[{id:'a',text:'甲'},{id:'b',text:'乙'}],answer:[],blanks:0};

test('真实模块 RPC 的题库按用户和课程隔离，忽略伪造 owner，未声明权限不能访问',async(t)=>{
  const {runtime,dir}=await boot('courseflow-bank-contract-');t.after(()=>runtime.close());const session=await setupAdmin(runtime);
  const owner=(await call(runtime,{url:'/api/me',session})).body.user.id;
  const other=await createUser(runtime.db,'bank-member','synthetic-bank-member-password','user',nowSeconds());
  runtime.manager.install(moduleSource(dir,'banktest',true));runtime.manager.install(moduleSource(dir,'nobank',false));
  for(const actor of [owner,other.id])connect(runtime,actor,'banktest');connect(runtime,owner,'nobank');
  await runtime.manager.invoke(owner,'banktest','bank.record',{owner:other.id,course:'same-course',question,answer:['b'],evidence:{result:'correct',source:'platform'}});
  assert.equal(runtime.questionBank,runtime.memory);
  const modules=(await call(runtime,{url:'/api/modules',session})).body;
  assert.ok(modules.builtins.some((item:any)=>item.id==='question-bank'&&item.running));
  await assert.rejects(runtime.manager.invoke(owner,'banktest','bank.confirm',{course:'same-course',question,answer:['a'],confirmation:{confirmed:false,source:'platform'}}),/平台已确认/);
  await assert.rejects(runtime.manager.invoke(owner,'banktest','bank.confirm',{course:'same-course',question,answer:['a'],confirmation:{confirmed:true,source:'model'}}),/平台已确认/);
  await runtime.manager.invoke(owner,'banktest','bank.confirm',{course:'same-course',question,answer:['b'],confirmation:{confirmed:true,source:'platform',reference:'synthetic-attempt'}});
  assert.deepEqual((await runtime.manager.invoke(owner,'banktest','bank.lookup',{course:'same-course',question})).correct,['b']);
  assert.equal((await runtime.manager.invoke(other.id,'banktest','bank.lookup',{owner,course:'same-course',question})).correct,null);
  assert.equal((await runtime.manager.invoke(owner,'banktest','bank.lookup',{course:'other-course',question})).correct,null);
  await assert.rejects(runtime.manager.invoke(owner,'nobank','bank.lookup',{course:'same-course',question}),/题库权限/);
  const identity=await runtime.manager.invoke(owner,'banktest','identity.probe',{});
  assert.equal(identity.user_id,'7');assert.equal(identity.organization_id,'8');assert.ok(!JSON.stringify(identity).includes('synthetic-private-token'));
  await assert.rejects(runtime.manager.invoke(owner,'banktest','bank.record',{course:'same-course',question,answer:['a'],evidence:{result:'correct',source:'model'}}),/只记录/);
});
test('目录分页在宿主聚合，游标重复时停止而不无限请求',async(t)=>{
  const {runtime,dir}=await boot('courseflow-catalog-pages-');t.after(()=>runtime.close());const session=await setupAdmin(runtime);
  const owner=(await call(runtime,{url:'/api/me',session})).body.user.id;
  runtime.manager.install(moduleSource(dir,'paged',false));connect(runtime,owner,'paged');
  assert.deepEqual((await runtime.manager.courses(owner,'paged')).map(c=>c.id),['0','1','2']);
  runtime.manager.install(moduleSource(dir,'looped',false,true));connect(runtime,owner,'looped');
  await assert.rejects(runtime.manager.courses(owner,'looped'),/分页游标重复/);
});
