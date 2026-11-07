import test from 'node:test';
import assert from 'node:assert/strict';
import { qaSummary, qaView, loadQa } from '../web/qa.js';
const now = Date.parse('2026-11-07T12:00:00+08:00') / 1000;
const data = { score: { interactive: 4, rules: { learnedInteractiveScoreShare: 10 }, qa: { validQuestionAmount: '3', effectiveAnswer: 8, getAnswer: 12 } }, own_posts: [
  { kind: 'question', content: '今日提问', created_at: now - 60 },
  { kind: 'answer', content: '今天的回答', question: '讨论题', created_at: now - 20 },
  { kind: 'question', content: '昨日提问', created_at: now - 86400 },
] };
test('问答进度区分平台有效数、今天发布数和剩余额度，缺失统计不冒充零分', () => {
  const summary = qaSummary(data, now);
  assert.deepEqual(summary.counts, { ask: 3, answer: 8, received: 12 });
  assert.deepEqual(summary.today, { ask: 1, answer: 1 }); assert.deepEqual(summary.room, { ask: 6, answer: 11 });
  assert.equal(qaSummary({ own_posts: [] }, now).counts.ask, null);
  const html = qaView({ feature: { data, drafts: ['<script>草稿</script>'], selected: [0], counts: { ask: 3, answer: 5 } }, bootstrap: { quiet_hours: { active: false } }, route: { pid: 'zhs' }, platforms: [{ id: 'zhs', operations: ['qa', 'ask'] }], settings: { preferences: { qa_peers: true } } });
  assert.match(html, /问答互动/); assert.match(html, /qa-cells/); assert.match(html, /发布 1 条/); assert.match(html, /role="switch"[^>]*aria-checked="true"/);
  assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;')); assert.match(html, /讨论题/);
});
test('问答首屏只读统计和发布记录，草稿在刷新后保留', async () => {
  const state = { route: { pid: 'zhs' }, course: { id: 'course', recruit_id: 'recruit' }, qaCourses: {} };
  const calls = [];
  const api = async (path) => { calls.push(path); return path.endsWith('/posts') ? { posts: data.own_posts } : path.endsWith('/score') ? data.score : { preferences: { qa_peers: false }, models: [] }; };
  await loadQa(state, api, () => true);
  state.feature.drafts = ['手工编辑草稿']; state.feature.selected = [0];
  await loadQa(state, api, () => true);
  assert.deepEqual(state.feature.drafts, ['手工编辑草稿']); assert.ok(!calls.some((p) => p.endsWith('/catalog/qa')));
});
