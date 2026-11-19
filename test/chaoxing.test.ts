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

test('超星真实 RPC 在模拟慢接口下只扫描所选课程且不阻塞登录', {skip:available?false:'需要超星模块 Python 依赖',timeout:30_000}, async t => {
  const {runtime}=await boot('courseflow-cx-latency-');t.after(()=>runtime.close());
  runtime.manager.install(moduleDir);runtime.manager.configure('cx',{source:'live',python});
  const session=await setupAdmin(runtime);
  const network: string[]=[];
  let optionalStarted!:()=>void;
  const optional=new Promise<void>(resolve=>{optionalStarted=resolve;});
  let releaseCards!:()=>void;
  const cardsReady=new Promise<void>(resolve=>{releaseCards=resolve;});
  let firstCards=0;
  t.mock.method(globalThis,'fetch',async (input:URL,init:RequestInit)=>{
    const url=new URL(input),route=url.pathname;network.push(route);
    if(route==='/fanyalogin')return new Response('{"status":true}',{headers:{'set-cookie':'_uid=7; Domain=chaoxing.com; Path=/; Secure'}});
    if(route==='/space/index'||route==='/mooc2-ans/visit/interaction')return new Response('');
    if(route==='/mooc2-ans/visit/courselistdata')return new Response(Array.from({length:30},(_,i)=>`<div class="course"><a href="/a?cpi=33"></a><input class="clazzId" value="22"><input class="courseId" value="${i+11}"><span class="course-name">合成课程${i+11}</span></div>`).join(''));
    if(route==='/mooc2-ans/mycourse/studentcourse')return new Response(Array.from({length:4},(_,i)=>`<div id="cur${i+1}"><a class="clicktitle">合成章节${i+1}</a></div>`).join(''));
    if(route==='/gas/clazz'){
      optionalStarted();
      return new Promise<Response>((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true}));
    }
    if(route==='/api/phone/jobfinishedList'||route==='/api/phone/jobunfinishedList')return Response.json({data:[]});
    if(route==='/mooc-ans/knowledge/cards'){
      if(url.searchParams.get('num')!=='0')return new Response('');
      firstCards++;if(firstCards===4)releaseCards();
      await cardsReady;
      const id=url.searchParams.get('knowledgeid');
      return new Response('mArg='+JSON.stringify({attachments:[{jobid:'video-'+id,type:'video',isPassed:id==='1',property:{name:'合成视频'+id}}]})+';');
    }
    assert.fail('未声明的模拟网络请求：'+url.origin+route);
  });
  const begin=await call(runtime,{method:'POST',url:'/api/platforms/cx/login',session,body:{method:'password'}});
  const challenge=begin.body.challenge.session;
  const submitted=await call(runtime,{method:'POST',url:`/api/platforms/cx/login/${challenge}/submit`,session,body:{fields:{username:'synthetic',password:'synthetic'}}});
  assert.equal(submitted.status,200);
  assert.equal((await call(runtime,{method:'POST',url:`/api/platforms/cx/login/${challenge}/poll`,session})).body.state,'connected');
  const courses=await call(runtime,{url:'/api/platforms/cx/courses',session});
  assert.equal(courses.body.courses.length,30);
  assert.equal(network.filter(path=>path.endsWith('/studentcourse')).length,0,'获取课程列表不应全量扫描三十门课');
  const root='/api/platforms/cx/courses/11/22';
  const readers=[call(runtime,{url:root+'/units',session}),call(runtime,{url:root+'/units',session})];
  await optional;
  const nextLogin=await call(runtime,{method:'POST',url:'/api/platforms/cx/login',session,body:{method:'password'}});
  assert.equal(nextLogin.status,200,'慢目录查询期间仍能创建登录挑战');
  const results=await Promise.all(readers);
  for(const result of results){assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.units.length,4);}
  assert.equal(firstCards,4,'两个同时打开的页面应共用一次扫描');
  assert.equal(network.filter(path=>path.endsWith('/studentcourse')).length,1);
  const refreshed=await call(runtime,{url:'/api/platforms/cx/courses',session});
  assert.equal(refreshed.body.courses[0].progress,25);
  assert.equal(network.filter(path=>path.endsWith('/studentcourse')).length,1);
  assert.equal(runtime.db.get<{n:number}>('SELECT COUNT(*) AS n FROM write_ledger')!.n,0,'目录和登录不能产生学习或交卷写入');
});

test('超星勾选待解锁章节后接续学习，只执行所选单元', {skip:!available,timeout:30_000}, async t => {
  const {runtime}=await boot('courseflow-cx-chain-');t.after(()=>runtime.close());
  runtime.manager.install(moduleDir);runtime.manager.configure('cx',{source:'live',python});
  const session=await setupAdmin(runtime);
  const written: string[]=[];
  let chapterThreeOpen=false;
  t.mock.method(globalThis,'fetch',async (input:URL)=>{
    const url=new URL(input);
    switch(url.pathname){
      case '/fanyalogin': return new Response('{"status":true}',{headers:{'set-cookie':'_uid=7; Domain=chaoxing.com; Path=/; Secure'}});
      case '/space/index':
      case '/mooc2-ans/visit/interaction': return new Response('');
      case '/mooc2-ans/visit/courselistdata':
        return new Response('<div class="course"><a href="/a?cpi=33"></a><input class="clazzId" value="22"><input class="courseId" value="11"><span class="course-name">合成课程</span></div>');
      case '/mooc2-ans/mycourse/studentcourse':
        return new Response([true,written.includes('job-1'),chapterThreeOpen,true,false].map((open,index)=>
          `<div id="cur${index+1}"><a class="clicktitle">章节 ${index+1}</a>${open?'':`<span class="bntHoverTips">${index===4?'到指定日期解锁':'需完成之前闯关任务点，该章节才能解锁'}</span>`}</div>`).join(''));
      case '/gas/clazz':
      case '/api/phone/jobfinishedList':
      case '/api/phone/jobunfinishedList': return Response.json({data:[]});
      case '/mooc-ans/knowledge/cards': {
        if(url.searchParams.get('num')!=='0') return new Response('');
        const point=url.searchParams.get('knowledgeid');
        assert.ok(point==='1'||point==='2'&&written.includes('job-1')||point==='3'&&chapterThreeOpen||point==='4');
        const id='job-'+point;
        return new Response('mArg='+JSON.stringify({attachments:[{jobid:id,type:'document',isPassed:written.includes(id),property:{name:'文档 '+point}}]})+';');
      }
      case '/mooc-ans/job/document':
        written.push(url.searchParams.get('jobid')!);
        return Response.json({status:true});
      default: assert.fail('未声明的模拟网络请求：'+url.pathname);
    }
  });
  const begin=await call(runtime,{method:'POST',url:'/api/platforms/cx/login',session,body:{method:'password'}});
  const challenge=begin.body.challenge.session;
  await call(runtime,{method:'POST',url:`/api/platforms/cx/login/${challenge}/submit`,session,body:{fields:{username:'synthetic',password:'synthetic'}}});
  assert.equal((await call(runtime,{method:'POST',url:`/api/platforms/cx/login/${challenge}/poll`,session})).body.state,'connected');
  const root='/api/platforms/cx/courses/11/22';
  const before=await call(runtime,{url:root+'/units',session});
  assert.deepEqual(before.body.units.filter((unit:{selectable_after_unlock?:boolean})=>unit.selectable_after_unlock).map((unit:{id:string})=>unit.id),['locked:2','locked:3']);
  const invalid=await call(runtime,{method:'POST',url:root+'/study',session,body:{unit_ids:['locked:5']}});
  assert.equal(invalid.status,400);
  const created=await call(runtime,{method:'POST',url:root+'/study',session,body:{unit_ids:['locked:3']}});
  assert.equal(created.status,200,JSON.stringify(created.body));
  const id=created.body.task.id;
  const paused=await waitFor(runtime,session,id,'paused');
  assert.deepEqual(paused.units,['job-1','job-2','locked:3']);
  assert.deepEqual(paused.completed,['job-1','job-2']);
  assert.ok((await call(runtime,{url:'/api/tasks/'+id,session})).body.events.some((event:{kind:string})=>event.kind==='prerequisites_added'));
  assert.match(paused.detail,/还有 1 项/);
  chapterThreeOpen=true;
  assert.equal((await call(runtime,{method:'POST',url:'/api/tasks/'+id+'/resume',session})).status,200);
  const completed=await waitFor(runtime,session,id,'completed');
  assert.equal(completed.progress,100);
  assert.deepEqual(completed.units,['job-1','job-2','job-3']);
  assert.deepEqual(completed.completed,completed.units);
  assert.deepEqual(written,completed.units,'只执行平台已解锁且尚未完成的真实单元');
});
