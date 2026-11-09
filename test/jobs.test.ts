import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.ts';
import { Db } from '../src/core/db.ts';
import { createUser, createSession } from '../src/core/auth.ts';
import { nowSeconds } from '../src/core/domain.ts';
import { boot, call, setupAdmin, waitFor, configFor, withHttp, type HttpRuntime, type Session } from './support/harness.ts';

async function connect(runtime: HttpRuntime, session: Session) {
  runtime.manager.install(fileURLToPath(new URL('../modules/simulator', import.meta.url)));
  const begin = await call(runtime, { method: 'POST', url: '/api/platforms/sim/login', session });
  await call(runtime, { method: 'POST', url: `/api/platforms/sim/login/${begin.body.challenge.id}/poll`, session });
}

test('pause and immediate resume drain the old generation before a new step runs', async (t) => {
  const { runtime } = await boot();
  const session = await setupAdmin(runtime);
  await connect(runtime, session);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<Record<string, unknown>>();
  t.after(async () => { gate.resolve({ status: 'completed' }); await runtime.close(); });
  const original = runtime.manager.studyStep.bind(runtime.manager);
  let calls = 0;
  runtime.manager.studyStep = async (...args) => {
    calls += 1;
    if (calls === 1) { entered.resolve(); return gate.promise; }
    return original(...args);
  };
  const created = await call(runtime, { method: 'POST', url: '/api/platforms/sim/courses/1001/9001/study', session, body: { unit_ids: ['1001-u1'] } });
  const id = created.body.task.id;
  await entered.promise;
  const paused = await call(runtime, { method: 'POST', url: `/api/tasks/${id}/pause`, session });
  assert.equal(paused.body.task.state, 'paused');
  const resumed = await call(runtime, { method: 'POST', url: `/api/tasks/${id}/resume`, session });
  assert.equal(resumed.status, 200);
  assert.equal(calls, 1, 'the old step still owns the executor');
  gate.resolve({ status: 'completed' });
  const finished = await waitFor(runtime, session, id, 'completed');
  assert.ok(calls > 1, 'the stale completion must not complete the resumed task');
  assert.deepEqual(finished.completed, ['1001-u1']);
  const detail = await call(runtime, { url: `/api/tasks/${id}`, session });
  assert.ok(detail.body.events.some((e: { kind: string }) => e.kind === 'paused'));
  const user = await createUser(runtime.db, 'another', 'synthetic-another-passphrase', 'user', nowSeconds());
  const other = createSession(runtime.db, user.id, nowSeconds());
  assert.equal((await call(runtime, { url: `/api/tasks/${id}`, session: other })).status, 404);
});

test('a stopped task cannot be completed by an in-flight result', async (t) => {
  const { runtime } = await boot();
  const session = await setupAdmin(runtime);
  await connect(runtime, session);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<Record<string, unknown>>();
  t.after(async () => { gate.resolve({ status: 'completed' }); await runtime.close(); });
  runtime.manager.studyStep = async () => { entered.resolve(); return gate.promise; };
  const created = await call(runtime, { method: 'POST', url: '/api/platforms/sim/courses/1001/9001/study', session, body: { unit_ids: ['1001-u1'] } });
  const id = created.body.task.id;
  await entered.promise;
  await call(runtime, { method: 'POST', url: `/api/tasks/${id}/stop`, session });
  gate.resolve({ status: 'completed' });
  await runtime.jobs.shutdown();
  assert.equal(runtime.jobs.get((await call(runtime, { url: '/api/me', session })).body.user.id, id).state, 'cancelled');
});

test('a task reports partial progress before its current unit completes', async (t) => {
  const { runtime } = await boot();
  const session = await setupAdmin(runtime);
  await connect(runtime, session);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<Record<string, unknown>>();
  t.after(async () => { gate.resolve({ status: 'completed' }); await runtime.close(); });
  let steps = 0;
  runtime.manager.studyStep = async () => {
    steps += 1;
    if (steps === 1) return { status: 'in_progress', progress: { watched_seconds: 60 }, wait_ms: 1 };
    entered.resolve();
    return gate.promise;
  };
  const created = await call(runtime, { method: 'POST', url: '/api/platforms/sim/courses/1001/9001/study', session, body: { unit_ids: ['1001-u1'] } });
  const id = created.body.task.id;
  await entered.promise;
  const detail = await call(runtime, { url: `/api/tasks/${id}`, session });
  assert.equal(detail.body.task.state, 'running');
  assert.ok(detail.body.task.progress > 0 && detail.body.task.progress < 100);
  assert.deepEqual(detail.body.task.completed, []);
  await call(runtime, { method: 'POST', url: `/api/tasks/${id}/pause`, session });
  gate.resolve({ status: 'completed' });
});

test('restart pauses orphaned tasks while module CLI runtimes leave them alone', async (t) => {
  const { runtime, dir } = await boot();
  const session = await setupAdmin(runtime);
  await connect(runtime, session);
  const created = await call(runtime, { method: 'POST', url: '/api/platforms/sim/courses/1001/9001/study', session, body: { unit_ids: ['1001-u1'] } });
  const id = created.body.task.id;
  await waitFor(runtime, session, id, 'completed');
  await runtime.close();
  const db = new Db(configFor(dir).dbPath);
  db.run("UPDATE tasks SET state='running' WHERE id=?1", id);
  db.close();
  const cli = await createRuntime(configFor(dir), { recoverTasks: false });
  await cli.close();
  const check = new Db(configFor(dir).dbPath);
  assert.equal(check.get<{ state: string }>('SELECT state FROM tasks WHERE id=?1', id)?.state, 'running');
  check.close();
  const restarted = withHttp(await createRuntime(configFor(dir)), configFor(dir));
  t.after(() => restarted.close());
  const tasks = await call(restarted, { url: '/api/tasks', session });
  const task = tasks.body.tasks.find((item: { id: string }) => item.id === id);
  assert.equal(task.state, 'paused');
  assert.match(task.detail, /重启/);
  assert.deepEqual(task.completed, ['1001-u1'], 'the sealed checkpoint survives restart');
});
