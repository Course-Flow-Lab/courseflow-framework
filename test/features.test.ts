import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createUser, createSession } from '../src/core/auth.ts';
import { nowSeconds, setQuietOverride } from '../src/core/domain.ts';
import { parseModelAnswer } from '../src/services/answers.ts';
import { exportReport } from '../src/services/exports.ts';
import { boot, call, setupAdmin, waitFor, type Session } from './support/harness.ts';
import type { Runtime } from '../src/runtime.ts';

async function connected(runtime: Runtime, session: Session) {
  runtime.manager.install(fileURLToPath(new URL('../modules/simulator', import.meta.url)));
  const login = await call(runtime, { method: 'POST', url: '/api/platforms/sim/login', session });
  await call(runtime, { method: 'POST', url: `/api/platforms/sim/login/${login.body.challenge.id}/poll`, session });
  const owner = (await call(runtime, { url: '/api/me', session })).body.user.id;
  const course = (await runtime.manager.courses(owner, 'sim'))[0]!;
  return { owner, course };
}
const question = (id: string, answer: string[] = []) => ({ id, kind: 'single', text: `题目 ${id}`, options: [{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }], answer, blanks: 0, images: [] });
const paper = { id: 'paper', name: '模拟作业', category: '作业', available: true, done: false, can_redo: true, score: null };
const attempt = { id: 'attempt-1', paper_id: 'paper', name: '模拟作业', questions: [question('old', ['a']), question('new')], expires_at: null };

test('人工补答保留原答案，确认后交卷，并加密保存可导出的确认记录', async (t) => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  const session = await setupAdmin(runtime); const { owner, course } = await connected(runtime, session);
  let opens = 0, submits = 0; const drafts: any[] = [];
  runtime.manager.invoke = async (_o, _p, method, params) => {
    if (method === 'catalog.papers') return { papers: [paper] };
    if (method === 'exam.open') { opens++; return { ready: true, attempt: structuredClone(attempt) }; }
    if (method === 'exam.write') { if (params.phase === 'submit') submits++; else drafts.push(params); return { done: true, cursor: 1 }; }
    if (method === 'exam.readback') return { confirmed: true, attempt_id: attempt.id, score: 95, graded_answers: { new: ['b'] } };
    throw new Error(method);
  };
  const task = runtime.jobs.create(owner, { platform: 'sim', course, unit_ids: ['paper'], operation: 'answer', options: { use_ai: false } });
  await waitFor(runtime, session, task.id, 'paused');
  assert.equal((runtime.jobs.details(owner, task.id).workflow as any).phase, 'waiting_answers');
  const overwrite = await call(runtime, { method: 'POST', url: `/api/tasks/${task.id}/answers`, session, body: { answers: { old: ['b'] } } });
  assert.equal(overwrite.status, 400);
  assert.equal((await call(runtime, { method: 'POST', url: `/api/tasks/${task.id}/answers`, session, body: { answers: { new: ['b'] } } })).status, 200);
  runtime.jobs.resume(owner, task.id); await waitFor(runtime, session, task.id, 'paused');
  assert.equal((runtime.jobs.details(owner, task.id).workflow as any).phase, 'waiting_submit');
  assert.equal(submits, 0); assert.deepEqual(drafts[0].preserve_ids, ['old']);
  runtime.jobs.confirm(owner, task.id); await waitFor(runtime, session, task.id, 'completed');
  assert.equal(opens, 1); assert.equal(submits, 1);
  const workflow = runtime.jobs.details(owner, task.id).workflow as any;
  assert.equal(workflow.records[0].confirmed, true); assert.equal(workflow.records[0].score, 95);
  assert.deepEqual(runtime.memory.get(owner, 'sim', `${course.id}/${course.recruit_id}`, question('new')), ['b']);
  const row = runtime.db.get<{ checkpoint: Uint8Array }>('SELECT checkpoint FROM tasks WHERE id=?1', task.id)!;
  assert.ok(!Buffer.from(row.checkpoint).includes(Buffer.from('模拟作业')));
  const response = await runtime.app.inject({ url: `/api/tasks/${task.id}/export?format=md`, headers: { cookie: `cf_session=${session.token}` } });
  assert.equal(response.statusCode, 200); assert.match(response.body, /平台已确认/); assert.match(response.body, /得分 95/);
});

test('交卷结果未知时回读而不重发，人工回读也保存确认记录', async (t) => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  const session = await setupAdmin(runtime); const { owner, course } = await connected(runtime, session);
  let submits = 0, confirmed = false;
  runtime.manager.invoke = async (_o, _p, method, params) => {
    if (method === 'catalog.papers') return { papers: [paper] };
    if (method === 'exam.open') return { ready: true, attempt: { ...attempt, questions: [question('old', ['a'])] } };
    if (method === 'exam.write') { if (params.phase === 'submit') { submits++; throw new Error('模拟交卷响应丢失'); } return { done: true, cursor: 1 }; }
    if (method === 'exam.readback') return { confirmed, attempt_id: attempt.id, score: 100 };
    throw new Error(method);
  };
  const task = runtime.jobs.create(owner, { platform: 'sim', course, unit_ids: ['paper'], operation: 'answer', options: { use_ai: false, auto_submit: true } });
  await waitFor(runtime, session, task.id, 'paused');
  assert.equal(submits, 1); assert.equal((runtime.jobs.details(owner, task.id).workflow as any).phase, 'readback');
  await assert.rejects(runtime.jobs.reconcile(owner, task.id), /仍未确认/);
  confirmed = true; await runtime.jobs.reconcile(owner, task.id);
  runtime.jobs.resume(owner, task.id); await waitFor(runtime, session, task.id, 'completed');
  assert.equal(submits, 1); assert.equal((runtime.jobs.details(owner, task.id).workflow as any).records.length, 1);
  assert.equal(runtime.db.get<{ state: string }>('SELECT state FROM operation_locks WHERE task_id=?1', task.id)?.state, 'confirmed');
});

test('分段读取试卷继续原作答，掌握度未满分最多三轮', async (t) => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  const session = await setupAdmin(runtime); const { owner, course } = await connected(runtime, session);
  const calls: any[] = []; let opens = 0;
  runtime.manager.invoke = async (_o, _p, method, params) => {
    calls.push({ method, ...params });
    if (method === 'catalog.mastery') return { papers: [paper] };
    if (method === 'exam.open') { if (!params.continuation) { opens++; return { ready: false, attempt }; } return { ready: true, attempt: { ...attempt, id: `round-${opens}`, questions: [question('old', ['a'])] } }; }
    if (method === 'exam.write') return { done: true, cursor: 1 };
    if (method === 'exam.readback') return { confirmed: true, attempt_id: `round-${opens}`, score: 50 };
    throw new Error(method);
  };
  const task = runtime.jobs.create(owner, { platform: 'sim', course, unit_ids: ['paper'], operation: 'mastery', options: { auto_submit: true } });
  const finished = await waitFor(runtime, session, task.id, 'completed');
  assert.equal(opens, 3); assert.match(finished.detail, /未确认达到 100%/);
  assert.equal(calls.filter((r) => r.method === 'exam.open' && r.continuation).length, 3);
  assert.ok(calls.every((r) => r.operation === 'mastery'));
});

test('模型密钥不回显、不串用，自动格式检查只在接口不支持时切换', async (t) => {
  const requests: any[] = []; let failAuth = false;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(raw), cookie: request.headers.cookie });
    response.setHeader('content-type', 'application/json');
    if (failAuth) { response.statusCode = 401; response.end(JSON.stringify({ error: { message: 'synthetic-key-must-not-echo' } })); }
    else if (request.url?.endsWith('/chat/completions')) { response.statusCode = 404; response.end(JSON.stringify({ error: { code: 'endpoint_not_found' } })); }
    else response.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK' }] }] }));
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const { runtime } = await boot(); t.after(() => runtime.close()); const session = await setupAdmin(runtime);
  const owner = (await call(runtime, { url: '/api/me', session })).body.user.id;
  const model = runtime.ai.save(owner, { name: '离线接口', model: 'fixture', base_url: `http://127.0.0.1:${(server.address() as any).port}/v1`, api_key: 'synthetic-key-must-not-echo', shared: true });
  assert.ok(!JSON.stringify(model).includes('synthetic-key')); assert.equal((await runtime.ai.probe(owner, model.id)).api_format, 'responses');
  assert.equal(requests.length, 2); assert.equal(requests[0].cookie, undefined); assert.equal(requests[1].body.store, false);
  assert.equal(await runtime.ai.generate(owner, '图片题', { modelId: model.id, images: [{ mime: 'image/png', data: 'synthetic-image' }] }), 'OK');
  assert.equal(requests.at(-1).body.input[0].content[1].type, 'input_image');
  const member = await createUser(runtime.db, 'member', 'synthetic-member-passphrase', 'user', nowSeconds());
  const memberSession = createSession(runtime.db, member.id, nowSeconds());
  const denied = await call(runtime, { method: 'POST', url: '/api/settings/models', session: memberSession, body: { shared: true } }); assert.equal(denied.status, 403);
  runtime.ai.save(owner, { enabled: false }, model.id);
  await assert.rejects(runtime.ai.generate(member.id, 'test', { modelId: model.id }), /停用/);
  const privateModel = runtime.ai.save(owner, { name: '仅本人', model: 'fixture', base_url: model.base_url, api_format: 'auto', api_key: 'synthetic-key' });
  failAuth = true; const before = requests.length;
  await assert.rejects(runtime.ai.probe(owner, privateModel.id), (error: Error) => /鉴权失败/.test(error.message) && !/synthetic-key/.test(error.message));
  assert.equal(requests.length, before + 1, '鉴权失败不能切换接口重试');
  assert.ok(!fs.readFileSync(runtime.config.dbPath).includes(Buffer.from('synthetic-key-must-not-echo')));
});

test('同账号默认排队，夜间暂停可自动恢复且人工暂停保留', async (t) => {
  const { runtime } = await boot(); const session = await setupAdmin(runtime); const { owner, course } = await connected(runtime, session);
  const gate = Promise.withResolvers<any>(); let entered = 0;
  t.after(async () => { gate.resolve({ status: 'completed' }); setQuietOverride(nowSeconds() + 3600); await runtime.close(); });
  runtime.manager.studyStep = async () => { entered++; return gate.promise; };
  const a = runtime.jobs.create(owner, { platform: 'sim', course, unit_ids: ['1001-u1'], operation: 'study' });
  await waitFor(runtime, session, a.id, 'running');
  const b = runtime.jobs.create(owner, { platform: 'sim', course, unit_ids: ['1001-u1'], operation: 'study' });
  await new Promise((resolve) => setTimeout(resolve, 1100)); assert.equal(entered, 1); assert.equal(runtime.jobs.get(owner, b.id).state, 'queued');
  runtime.jobs.pause(owner, b.id); assert.equal(runtime.jobs.get(owner, b.id).state, 'paused');
  const actualNow = Date.now;
  t.after(() => { Date.now = actualNow; });
  Date.now = () => Date.parse('2026-11-07T23:01:00+08:00'); setQuietOverride(null);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(runtime.jobs.get(owner, a.id).state, 'paused'); assert.match(runtime.jobs.get(owner, a.id).detail, /07:00 自动继续/);
  Date.now = () => Date.parse('2026-11-08T07:01:00+08:00');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(runtime.jobs.get(owner, a.id).state, 'queued');
  assert.equal(runtime.jobs.get(owner, b.id).state, 'paused');
  Date.now = actualNow;
});

test('题型答案校验和文档导出保留中文、图片与已确认状态', async () => {
  assert.deepEqual(parseModelAnswer(question('q'), '{"answer":"B","explanation":"依据"}').answer, ['b']);
  assert.throws(() => parseModelAnswer(question('q'), '{"answer":"C"}'), /选项不符/);
  const task: any = { id: 'test', course_name: '中文课程', operation: 'answer', state: 'completed', detail: '已确认' };
  const report = { task, workflow: { records: [{ attempt: { name: '含图作业', questions: [{ ...question('q'), images: ['/api/media/test'] }] }, answers: { q: ['a'] }, confirmed: true }] }, events: [{ kind: '完成', detail: '=SUM(A1:A3)', created_at: 1 }] };
  const result = await exportReport(report, 'docx', 'http://localhost:8099', async () => ({ mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }));
  assert.equal(result.data.readUInt32LE(0), 0x04034b50); assert.ok(result.data.includes(Buffer.from('中文课程'))); assert.ok(result.data.includes(Buffer.from('word/media/image1.png')));
  const md = await exportReport(report, 'md', 'http://localhost:8099', async () => { throw new Error(); }); assert.match(md.data.toString(), /平台已确认/);
  const csv = await exportReport(report, 'csv', '', async () => { throw new Error(); }); assert.match(csv.data.toString(), /'=SUM/);
});
