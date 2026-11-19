import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.ts';
import { Db } from '../src/core/db.ts';
import { createUser, createSession } from '../src/core/auth.ts';
import { nowSeconds } from '../src/core/domain.ts';
import type { JobInput, TaskRow } from '../src/jobs/engine.ts';
import { boot, call, setupAdmin, waitFor, configFor, withHttp, type HttpRuntime, type Session } from './support/harness.ts';

async function connect(runtime: HttpRuntime, session: Session) {
  runtime.manager.install(fileURLToPath(new URL('../modules/simulator', import.meta.url)));
  const begin = await call(runtime, { method: 'POST', url: '/api/platforms/sim/login', session });
  await call(runtime, { method: 'POST', url: `/api/platforms/sim/login/${begin.body.challenge.id}/poll`, session });
}

function upgradedSimulator(directory: string, version: string, compatibleFrom: string[] = [], operations = ['study']): string {
  const target = path.join(directory, `simulator-${version}`);
  fs.cpSync(new URL('../modules/simulator', import.meta.url), target, { recursive: true });
  const manifestPath = path.join(target, 'courseflow.module.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  manifest.checkpoint_compatible_from = compatibleFrom;
  manifest.platform.operations = operations;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return target;
}

test('a compatible module upgrade pauses execution and migrates the original task and checkpoint', async (t) => {
  const { runtime, dir } = await boot();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<Record<string, unknown>>();
  t.after(async () => { gate.resolve({ status: 'completed' }); await runtime.close(); });
  const session = await setupAdmin(runtime);
  const owner = (await call(runtime, { url: '/api/me', session })).body.user.id;
  await connect(runtime, session);

  const original = runtime.manager.studyStep.bind(runtime.manager);
  let migrating = true;
  const resumed: Array<{ unit: string; checkpoint: unknown }> = [];
  runtime.manager.studyStep = async (...args) => {
    const unit = args[3];
    if (!migrating) {
      resumed.push({ unit: unit.id, checkpoint: args[4] });
      return original(...args);
    }
    if (unit.id === '1001-u1') return { status: 'completed' };
    if (!args[4]) return { status: 'in_progress', wait_ms: 1, checkpoint: { seconds: 60 }, progress: { watched_seconds: 60 } };
    entered.resolve();
    return gate.promise;
  };
  const created = await call(runtime, { method: 'POST', url: '/api/platforms/sim/courses/1001/9001/study', session, body: { unit_ids: ['1001-u1', '1001-u2'] } });
  assert.equal(created.status, 200);
  const id = created.body.task.id;
  const taskPath = `/api/tasks/${id}`;
  const row = () => runtime.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?1', id)!;
  const readInput = () => runtime.vault.openJson<JobInput>(owner, `job/${id}/input`, Buffer.from(runtime.db.get<{ sealed: Uint8Array }>('SELECT sealed FROM task_inputs WHERE task_id=?1', id)!.sealed));
  await entered.promise;
  const before = row(), input = readInput();
  const modulePath = upgradedSimulator(dir, '0.1.1', ['0.1.0']);
  const installed = await call(runtime, { method: 'POST', url: '/api/modules/install', session, body: { path: modulePath } });
  assert.equal(installed.status, 200);
  const paused = (await call(runtime, { url: taskPath, session })).body.task;
  assert.equal(paused.state, 'paused');
  assert.equal(paused.progress, before.progress);
  assert.deepEqual(paused.completed, ['1001-u1']);
  assert.deepEqual(paused.module_update, { from_version: '0.1.0', to_version: '0.1.1' });

  const migrate = (version = '0.1.1', by = session) => call(runtime, { method: 'POST', url: taskPath + '/migrate', session: by, body: { to_version: version } });
  assert.equal((await migrate()).body.error.code, 'task_stopping');
  assert.equal((await call(runtime, { method: 'POST', url: taskPath + '/resume', session })).body.error.code, 'module_version_changed');
  gate.resolve({ status: 'completed', checkpoint: { stale: true } });
  await new Promise(resolve => setImmediate(resolve));

  const other = await createUser(runtime.db, 'migration-other', 'synthetic-migration-password', 'user', nowSeconds());
  assert.equal((await migrate('0.1.1', createSession(runtime.db, other.id, nowSeconds()))).status, 404);
  assert.equal((await migrate('0.1.2')).body.error.code, 'module_version_changed');
  const accountMock = t.mock.method(runtime.manager, 'accountKey', () => 'different-platform-account');
  assert.equal((await migrate()).body.error.code, 'platform_account_changed');
  accountMock.mock.restore();
  assert.deepEqual(readInput(), input);

  const migrated = await migrate();
  assert.equal(migrated.status, 200);
  assert.equal(migrated.body.task.state, 'paused');
  assert.equal(migrated.body.task.module_update, undefined);
  assert.deepEqual(row().checkpoint, before.checkpoint);
  assert.deepEqual(readInput(), { ...input, version: '0.1.1' });
  assert.equal((await migrate()).status, 200);
  assert.equal(runtime.jobs.events(owner, id).filter(event => event.kind === 'module_migrated').length, 1);

  migrating = false;
  assert.equal((await call(runtime, { method: 'POST', url: taskPath + '/resume', session })).status, 200);
  const finished = await waitFor(runtime, session, id, 'completed');
  assert.deepEqual(finished.completed, ['1001-u1', '1001-u2']);
  assert.deepEqual(resumed, [{ unit: '1001-u2', checkpoint: { seconds: 60 } }]);
});

test('migration preserves unresolved requests and requires declared checkpoint compatibility', async (t) => {
  const { runtime, dir } = await boot();
  t.after(() => runtime.close());
  const session = await setupAdmin(runtime);
  const owner = (await call(runtime, { url: '/api/me', session })).body.user.id;
  await connect(runtime, session);
  const id = 'old-exam';
  const now = nowSeconds();
  const input: JobInput = { version: '0.1.0', account: runtime.manager.accountKey(owner, 'sim')!, connection: runtime.manager.connectionId(owner, 'sim')!, options: { redo: true } };
  runtime.db.run("INSERT INTO tasks(id,owner,platform,operation,state,course_id,recruit_id,created_at,updated_at) VALUES(?1,?2,'sim','answer','paused','1001','9001',?3,?3)", id, owner, now);
  const sealed = new Uint8Array(runtime.vault.sealJson(owner, `job/${id}/input`, input));
  runtime.db.run('INSERT INTO task_inputs VALUES(?1,?2)', id, sealed);
  const checkpoint = (phase: string) => new Uint8Array(runtime.vault.sealJson(owner, `job/${id}`, { completed: [], positions: {}, workflow: { phase } }));
  const migrate = (version: string) => call(runtime, { method: 'POST', url: `/api/admin/tasks/${id}/migrate`, session, body: { to_version: version } });

  runtime.manager.install(upgradedSimulator(dir, '0.1.1', [], ['study', 'answer']));
  assert.match((await migrate('0.1.1')).body.error.message, /未声明兼容/);
  runtime.manager.install(upgradedSimulator(dir, '0.1.2', ['0.1.0'], ['study', 'answer']));
  const opening = checkpoint('opening');
  runtime.db.run('UPDATE tasks SET checkpoint=?1 WHERE id=?2', opening, id);
  assert.match((await migrate('0.1.2')).body.error.message, /开卷或重做/);
  assert.deepEqual(runtime.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?1', id)!.checkpoint, opening);

  const readback = checkpoint('readback');
  runtime.db.run('UPDATE tasks SET checkpoint=?1 WHERE id=?2', readback, id);
  runtime.db.run("INSERT INTO operation_locks VALUES('unresolved',?1,'sim',?2,'unknown',?3,'synthetic-exam')", owner, id, now);
  assert.match((await migrate('0.1.2')).body.error.message, /回读并确认/);
  assert.deepEqual(runtime.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?1', id)!.checkpoint, readback);
  assert.deepEqual(runtime.db.get<{ sealed: Uint8Array }>('SELECT sealed FROM task_inputs WHERE task_id=?1', id)!.sealed, sealed);
  assert.equal(runtime.db.get<{ state: string }>("SELECT state FROM operation_locks WHERE id='unresolved'")!.state, 'unknown');

  runtime.db.run("UPDATE operation_locks SET state='confirmed' WHERE id='unresolved'");
  const confirmed = checkpoint('next');
  runtime.db.run('UPDATE tasks SET checkpoint=?1 WHERE id=?2', confirmed, id);
  const migrated = await migrate('0.1.2');
  assert.equal(migrated.status, 200);
  assert.equal(migrated.body.task.owner, owner);
  assert.equal(migrated.body.task.state, 'paused');
  assert.deepEqual(runtime.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?1', id)!.checkpoint, confirmed);
});

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
