import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScore, scoreView, scoreAction } from '../web/score.js';
const fresh=()=>({route:{pid:'demo',tab:'score'},course:{id:'course',recruit_id:'class'},presentation:{score_sections:[{id:'scores',label:'成绩概览'},{id:'habit',label:'学习习惯'},{id:'interaction',label:'问答互动'},{id:'rules',label:'考核占比'}]}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('成绩分区独立完成，失败不阻塞其他区域，重试只请求对应分区',async()=>{
  const state=fresh(),pending=new Map(),calls=[];
  const api=url=>{const part=new URL(url,'http://synthetic.invalid').searchParams.get('part');calls.push(part);return new Promise((resolve,reject)=>pending.set(part,{resolve,reject}));};
  let renders=0;const loading=loadScore(state,api,()=>true,()=>renders++);
  assert.equal(pending.size,4);assert.match(scoreView(state),/0 \/ 4/);
  pending.get('scores').resolve({title:'成绩概览',metrics:[{label:'总评',value:0,unit:'分'},{label:'未知',value:null}]});await tick();
  assert.equal(state.feature.sections[0].loading,false);assert.equal(state.feature.sections[1].loading,true);
  pending.get('habit').reject(new Error('合成习惯接口故障'));
  pending.get('interaction').resolve({metrics:[{label:'回答',value:25,max:20,unit:'条'}]});
  pending.get('rules').resolve({metrics:[]});await loading;
  const html=scoreView(state);assert.match(html,/合成习惯接口故障/);assert.match(html,/<strong>0<\/strong>/);assert.match(html,/待平台提供/);assert.match(html,/<strong>25<\/strong>/);assert.ok(renders>=5);
  const retry=scoreAction({dataset:{action:'score-refresh',part:'habit'}},{state,api,renderPage:()=>{}});
  pending.get('habit').resolve({metrics:[{label:'习惯',value:3,unit:'分'}]});await retry;
  assert.deepEqual(calls,['scores','habit','interaction','rules','habit']);assert.equal(state.feature.sections[1].error,'');
});
test('切换课程后晚到的数据不能覆盖新页面，平台文本转义且进度不溢出',async()=>{
  const state=fresh();let resolve;state.presentation.score_sections=[{id:'scores',label:'概览'}];
  const loading=loadScore(state,()=>new Promise(r=>resolve=r),()=>true);
  const old=state.feature;state.feature={tab:'qa'};resolve({metrics:[{label:'晚到成绩',value:99}]});await loading;
  assert.equal(old.sections[0].data,null);assert.equal(state.feature.tab,'qa');
  state.feature={tab:'score',sections:[{id:'interaction',label:'互动',loading:false,data:{metrics:[{label:'<script>合成</script>',value:200,max:20}]},updatedAt:0}]};
  const html=scoreView(state);assert.ok(!html.includes('<script>'));assert.match(html,/value="100"/);
});
