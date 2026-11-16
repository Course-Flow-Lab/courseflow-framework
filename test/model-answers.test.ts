import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelAnswer } from '../src/services/answers.ts';

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

test('选择题映射修复不改变判断、填空和简答的答案约定', () => {
  assert.deepEqual(parseModelAnswer({ ...question, kind: 'judge', options: [] }, '{"answer":false}').answer, ['false']);
  assert.deepEqual(parseModelAnswer({ ...question, kind: 'blank', options: [], blanks: 2 }, '{"answer":["DNA","RNA"]}').answer, ['DNA', 'RNA']);
  assert.deepEqual(parseModelAnswer({ ...question, kind: 'essay', options: [] }, '{"answer":"DNA 和 RNA"}').answer, ['DNA 和 RNA']);
});
