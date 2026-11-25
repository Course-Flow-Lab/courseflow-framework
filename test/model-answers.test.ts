import test from 'node:test';
import assert from 'node:assert/strict';
import { generateModelAnswer, parseModelAnswer, type ModelAnswerFailure } from '../src/services/answers.ts';

const question = {
  id: 'synthetic-macromolecules', kind: 'multiple', text: '下列属于生物大分子的物质有哪些？',
  options: [{ id: 'remote-101', text: 'DNA' }, { id: 'remote-102', text: 'ATP' }, { id: 'remote-103', text: '葡萄糖' }, { id: 'remote-104', text: 'RNA' }],
  answer: [], blanks: 0, images: [],
};

test('模型选项标签先按展示顺序映射，DNA 中的字母不能抢先匹配答案', () => {
  // deepseek-flash returned this valid shape for the synthetic question.
  const raw = '{"answer":["A","D"],"explanation":"DNA和RNA是核酸，属于生物大分子"}';
  assert.deepEqual(parseModelAnswer(question, raw), { answer: ['remote-101', 'remote-104'], explanation: 'DNA和RNA是核酸，属于生物大分子' });
  assert.deepEqual(parseModelAnswer({ ...question, kind: 'single' }, '{"answer":"D"}').answer, ['remote-104']);
  const idsOverlapLabels = { ...question, options: question.options.map((option, index) => ({ ...option, id: ['D', 'C', 'B', 'A'][index]! })) };
  assert.deepEqual(parseModelAnswer(idsOverlapLabels, '{"answer":["A","D"]}').answer, ['D', 'A']);
});

test('多选兼容紧凑、分隔与小写标签，仍保留明确的选项编号及完整文字', () => {
  for (const answer of ['AD', 'ad', 'A,D', 'A、D', 'A D', ['a', 'd'], ['A. DNA', 'D. RNA'], ['remote-101', 'remote-104'], ['DNA', 'RNA']]) {
    assert.deepEqual(parseModelAnswer(question, JSON.stringify({ answer })).answer, ['remote-101', 'remote-104'], JSON.stringify(answer));
  }
  assert.deepEqual(parseModelAnswer(question, '{"answer":"DNA"}').answer, ['remote-101']);
  assert.deepEqual(parseModelAnswer(question, '```json\n{"answer":["A","D"]}\n```').answer, ['remote-101', 'remote-104']);
});

test('不以选项子串或含糊内容猜测答案，空值和无效响应保持可处理错误', () => {
  for (const answer of ['', 'NA', ['A', 'A'], 'AZ', 'A. RNA', {}, [null], ['A', {}]]) {
    assert.throws(() => parseModelAnswer(question, JSON.stringify({ answer })), /模型答案与题型或选项不符/, JSON.stringify(answer));
  }
  const duplicateText = { ...question, options: [{ id: 'one', text: 'DNA' }, { id: 'two', text: 'DNA' }] };
  assert.throws(() => parseModelAnswer(duplicateText, '{"answer":"DNA"}'), /选项不符/);
  for (const raw of ['null', '[]', '"A"', '{}', '{"answer":null}']) {
    assert.throws(() => parseModelAnswer(question, raw), error => error instanceof Error && error.name === 'AppError');
  }
});

test('模型明确返回空答案时展示缺少资料的原因，不误报为答案格式错误', () => {
  const judge = { ...question, kind: 'judge', options: [{ id: 'A', text: '对' }, { id: 'B', text: '错' }] };
  assert.throws(() => parseModelAnswer(judge, '{"answer":null,"explanation":"缺少老师在课程中的具体观点，无法判断。"}'), error =>
    error instanceof Error && 'code' in error && error.code === 'answer_unavailable' && /缺少老师在课程中的具体观点/.test(error.message) && !/选项不符/.test(error.message));
  assert.throws(() => parseModelAnswer(judge, '{"answer":null}'), /模型未能确定答案/);
  assert.throws(() => parseModelAnswer(judge, '{}'), error =>
    error instanceof Error && 'code' in error && error.code === 'answer_format');
  assert.deepEqual(parseModelAnswer(judge, '{"answer":false}').answer, ['false']);
});

test('判断题按选项实际含义解析标签、编号和符号，不假定 A 一定是正确', () => {
  const judge = { ...question, kind: 'judge', options: [{ id: 'yes-id', text: '对' }, { id: 'no-id', text: '错' }] };
  for (const answer of ['B', ['B'], 'B. 错', 'no-id', 'false', false, 'F', '×']) {
    assert.deepEqual(parseModelAnswer(judge, JSON.stringify({ answer })).answer, ['false'], JSON.stringify(answer));
  }
  assert.deepEqual(parseModelAnswer(judge, '{"answer":"A"}').answer, ['true']);
  assert.deepEqual(parseModelAnswer({ ...judge, options: [...judge.options].reverse() }, '{"answer":"A"}').answer, ['false']);
  assert.deepEqual(parseModelAnswer({ ...judge, options: [...judge.options].reverse() }, '{"answer":"B"}').answer, ['true']);
  for (const options of [[], [{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }]]) {
    assert.throws(() => parseModelAnswer({ ...judge, options }, '{"answer":"B"}'), /选项不符/);
  }
  for (const answer of ['可能错', {}, ['A', 'B'], 'B. 对']) {
    assert.throws(() => parseModelAnswer(judge, JSON.stringify({ answer })), /选项不符/);
  }
});

test('答案格式错误只重试一次并保留失败响应，资料不足和连接错误不重试', async () => {
  const failures: ModelAnswerFailure[] = []; const prompts: string[] = [];
  const answer = await generateModelAnswer(question, async prompt => {
    prompts.push(prompt);
    return prompts.length === 1 ? '{"answer":["Z"]}' : '{"answer":["A","D"]}';
  }, { onFailure: failure => failures.push(failure) });
  assert.deepEqual(answer.answer, ['remote-101', 'remote-104']);
  assert.equal(prompts.length, 2); assert.match(prompts[1]!, /上次响应不符合答案格式/);
  assert.equal(failures.length, 1); assert.equal(failures[0]!.raw, '{"answer":["Z"]}');
  assert.equal(failures[0]!.retrying, true);
  let requests = 0; failures.length = 0;
  await assert.rejects(generateModelAnswer(question, async () => { requests++; return 'invalid-json'; }, { onFailure: failure => failures.push(failure) }), /合法 JSON/);
  assert.equal(requests, 2); assert.equal(failures.length, 2); assert.equal(failures[1]!.retrying, false);
  requests = 0;
  await assert.rejects(generateModelAnswer(question, async () => { requests++; return '{"answer":null,"explanation":"缺少资料"}'; }), /缺少资料/);
  assert.equal(requests, 1);
  requests = 0;
  await assert.rejects(generateModelAnswer(question, async () => { requests++; throw new Error('connection failed'); }), /connection failed/);
  assert.equal(requests, 1);
});

test('任务停止后不重试答案格式错误，也不保存失效响应', async () => {
  const controller = new AbortController(); let requests = 0; let failures = 0;
  await assert.rejects(generateModelAnswer(question, async () => {
    requests++; controller.abort(new Error('stopped')); return 'invalid-json';
  }, { check: () => controller.signal.throwIfAborted(), onFailure: () => { failures++; } }), /stopped/);
  assert.equal(requests, 1); assert.equal(failures, 0);
});

test('选择题映射修复不改变判断、填空和简答的答案约定', () => {
  assert.deepEqual(parseModelAnswer({ ...question, kind: 'judge', options: [] }, '{"answer":false}').answer, ['false']);
  assert.deepEqual(parseModelAnswer({ ...question, kind: 'blank', options: [], blanks: 2 }, '{"answer":["DNA","RNA"]}').answer, ['DNA', 'RNA']);
  assert.deepEqual(parseModelAnswer({ ...question, kind: 'essay', options: [] }, '{"answer":"DNA 和 RNA"}').answer, ['DNA 和 RNA']);
});
