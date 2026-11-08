import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionBank, createJsonProvider, fingerprint, queryProviders } from '../src/question-bank/index.js';
const scope = { owner: 'synthetic-owner', platform: 'cx', course: 'synthetic-course' };
const question = { kind: 'single', text: '1 + 1 = ?', options: [{ id: 'A', text: '1' }, { id: 'B', text: '2' }], blanks: 0 };
function bank() { const rows = new Map(); return new QuestionBank({ get: key => rows.get(key), put: (key, value) => rows.set(key, value) }); }
test('已确认答案在选项重排、换编号后仍映射正确，用户与课程隔离', () => {
  const b = bank(); b.record(scope, question, ['B'], { result: 'correct', source: 'platform', at: 10 });
  const reordered = { ...question, options: [{ id: 'X', text: '2' }, { id: 'Y', text: '1' }] };
  assert.deepEqual(b.lookup(scope, reordered).correct, ['X']);
  assert.equal(b.lookup({ ...scope, owner: 'other' }, question).correct, null);
  assert.equal(b.lookup({ ...scope, course: 'other' }, question).correct, null);
  assert.notEqual(fingerprint(scope, question), fingerprint(scope, { ...question, images: ['synthetic-image'] }));
});
test('错误答案撤销旧确认，新的平台确认清除相同错误组合', () => {
  const b = bank(); b.record(scope, question, ['B'], { result: 'correct', source: 'platform' });
  b.record(scope, question, ['B'], { result: 'incorrect', source: 'platform' });
  assert.deepEqual(b.lookup(scope, question).wrong, [['B']]); assert.equal(b.lookup(scope, question).correct, null);
  b.record(scope, question, ['B'], { result: 'correct', source: 'reviewed' });
  assert.deepEqual(b.lookup(scope, question).wrong, []);
});
test('未确认、格式错误或重复文字的选项不能污染题库', () => {
  const b = bank();
  assert.throws(() => b.record(scope, question, ['B'], { result: 'correct', source: 'model' }));
  assert.throws(() => b.record(scope, question, ['Z'], { result: 'correct', source: 'platform' }));
  const duplicate = { ...question, options: [{ id: 'A', text: '2' }, { id: 'B', text: '2' }] };
  assert.throws(() => b.record(scope, duplicate, ['A'], { result: 'correct', source: 'platform' }));
  assert.equal(b.lookup(scope, question).correct, null);
});
test('填空顺序保留，多选组合排序稳定，返回值不能修改存储', () => {
  const b = bank(); const q = { kind: 'blank', text: '两个空', options: [], blanks: 2 };
  b.record(scope, q, ['甲', '乙'], { result: 'correct', source: 'platform' });
  b.record(scope, q, ['乙', '甲'], { result: 'incorrect', source: 'platform' });
  b.lookup(scope, q).correct.reverse(); assert.deepEqual(b.lookup(scope, q).correct, ['甲', '乙']);
  const multiple = { ...question, kind: 'multiple' };
  b.record(scope, multiple, ['B', 'A'], { result: 'correct', source: 'platform' });
  assert.deepEqual(b.lookup(scope, multiple).correct, ['A', 'B']);
});
test('外部数据源使用注入传输，失败或不合题型的候选可回退，候选不自动入库', async () => {
  const b = bank(); const seen = [];
  const provider = createJsonProvider({ id: 'synthetic', request: q => ({ method: 'POST', url: 'https://synthetic.invalid/query', body: q.text }), parse: data => data }, async req => { seen.push(req); return { answer: ['B'] }; });
  const result = await queryProviders([{ id: 'bad', query: async () => ({ answer: ['Z'] }) }, provider], question);
  assert.equal(result.provider, 'synthetic'); assert.equal(seen.length, 1); assert.equal(b.lookup(scope, question).correct, null);
  await assert.rejects(queryProviders([provider], question, { signal: AbortSignal.abort() }));
});
