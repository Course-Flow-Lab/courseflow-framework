import test from 'node:test';
import assert from 'node:assert/strict';
import { candidate, createYanxiProvider, createTikuAdapterProvider, createTikuLikeProvider } from '../src/question-bank/index.js';
const q={kind:'single',text:'合成题目',options:[{id:'A',text:'甲'},{id:'B',text:'乙'}],blanks:0};
test('旧题库协议适配通过注入传输发送，不运行真实请求',async()=>{
  let request;
  const yanxi=createYanxiProvider({url:'https://synthetic.invalid/query',token:'synthetic-token'},async r=>{request=r;return {code:1,data:{answer:'乙'}};});
  assert.deepEqual((await yanxi.query(q,{})).answer,['B']); assert.equal(new URL(request.url).searchParams.get('token'),'synthetic-token');
  const adapter=createTikuAdapterProvider({url:'https://synthetic.invalid/query'},async r=>{assert.equal(JSON.parse(r.body).type,0);return {answer:{bestAnswer:['B']}};});
  assert.deepEqual((await adapter.query(q,{})).answer,['B']);
  const like=createTikuLikeProvider({url:'https://synthetic.invalid/query',token:'synthetic-token'},async()=>({results:{output:{questionType:'JUDGMENT',answer:{isCorrect:false}}}}));
  assert.deepEqual((await like.query({...q,kind:'judge',options:[]},{})).answer,['false']);
});
test('不会以相似文本、缺失答案或无法匹配的判断值猜测答案',()=>{
  assert.equal(candidate(q,'甲乙'),null); assert.equal(candidate(q,null),null);
  assert.equal(candidate({...q,kind:'judge'},'也许'),null);
  assert.deepEqual(candidate({...q,kind:'multiple'},'BA').answer,['B','A']);
});
