import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, call, setupAdmin, waitFor, type Session } from './support/harness.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const simulatorDir = path.join(repoRoot, 'modules', 'simulator');

test('framework hosts a module end to end', async (t) => {
  const { runtime } = await boot();
  t.after(async () => runtime.close());

  // health and bootstrap are public
  const health = await call(runtime, { url: '/healthz' });
  assert.equal(health.status, 200);
  assert.equal(health.body.module_api, 1);
  const bootstrap = await call(runtime, { url: '/api/bootstrap' });
  assert.equal(bootstrap.body.setup_required, true);

  // an unauthenticated admin route is rejected
  assert.equal((await call(runtime, { url: '/api/modules' })).status, 401);

  // first run requires the terminal setup code
  const wrong = await call(runtime, {
    method: 'POST',
    url: '/api/auth/setup',
    body: { setup_code: 'nope', username: 'admin', password: 'synthetic-passphrase-2026' },
  });
  assert.equal(wrong.status, 403);
  const session: Session = await setupAdmin(runtime);

  // no platform until a module is installed
  assert.deepEqual((await call(runtime, { url: '/api/platforms', session })).body.platforms, []);

  // install the reference module and list it as admin
  const installed = runtime.manager.install(simulatorDir);
  assert.equal(installed.id, 'sim');
  assert.equal(installed.sha256.length, 64);
  const modules = (await call(runtime, { url: '/api/modules', session })).body.modules as any[];
  assert.equal(modules.length, 1);
  assert.equal(modules[0].enabled, true);

  // the descriptor comes from the module's handshake, not from the manifest alone
  const platforms = (await call(runtime, { url: '/api/platforms', session })).body.platforms as any[];
  assert.equal(platforms.length, 1);
  assert.equal(platforms[0].id, 'sim');
  assert.equal(platforms[0].connected, false);
  assert.equal(platforms[0].module.healthy, true);
  assert.deepEqual(platforms[0].operations, ['study']);

  // QR login: begin -> poll (the mock lands on connected) -> complete
  const begin = await call(runtime, { method: 'POST', url: '/api/platforms/sim/login', session });
  assert.equal(begin.status, 200);
  assert.match(begin.body.challenge.image, /^data:image\/svg\+xml/);
  const challengeId = begin.body.challenge.id as string;
  const poll = await call(runtime, {
    method: 'POST',
    url: `/api/platforms/sim/login/${challengeId}/poll`,
    session,
  });
  assert.equal(poll.body.state, 'connected');

  const connected = (await call(runtime, { url: '/api/platforms', session })).body.platforms as any[];
  assert.equal(connected[0].connected, true);
  assert.equal(connected[0].display_name, '演示学生');

  // the sealed session never leaves the data directory
  const secret = runtime.db.get<{ sealed: Uint8Array }>(
    'SELECT sealed FROM secrets WHERE scope = ?1',
    'sim/session',
  );
  assert.ok(secret);
  assert.ok(!Buffer.from(secret!.sealed).toString('utf8').includes('演示学生'));

  // catalog
  const courses = (await call(runtime, { url: '/api/platforms/sim/courses', session })).body
    .courses as any[];
  assert.equal(courses.length, 2);
  assert.equal(courses[0].kind, 'shared');

  // The simulator reads and writes `cw.state` on every course call; a second successful call
  // proves the value round-tripped through the sealed store.
  const second = await call(runtime, { url: '/api/platforms/sim/courses', session });
  assert.equal(second.status, 200);
  assert.equal(second.body.courses.length, 2);
  const state = runtime.db.get<{ sealed: Uint8Array }>(
    'SELECT sealed FROM module_state WHERE module = ?1 AND namespace = ?2 AND state_key = ?3',
    'sim',
    'sim',
    'visits',
  );
  assert.ok(state, 'cw.state 应写入 module_state');
  assert.ok(!Buffer.from(state!.sealed).toString('utf8').includes('visits'));

  const units = (await call(runtime, { url: '/api/platforms/sim/courses/1001/9001/units', session }))
    .body;
  assert.equal(units.units.length, 3);
  assert.equal(units.units[2].selectable, false);
  // presentation is resolved server-side for this course kind
  assert.deepEqual(
    units.ui.tabs.map((tab: any) => tab.id),
    ['study', 'qa'],
  );

  // study job: two units, short steps, driven by study.step
  const created = await call(runtime, {
    method: 'POST',
    url: '/api/platforms/sim/courses/1001/9001/study',
    session,
    body: { unit_ids: ['1001-u1', '1001-u2'] },
  });
  assert.equal(created.status, 200);
  const taskId = created.body.task.id as string;
  const finished = await waitFor(runtime, session, taskId, 'completed');
  assert.equal(finished.progress, 100);
  assert.deepEqual(finished.completed, ['1001-u1', '1001-u2']);

  // A unit the platform already reports as completed is never studied again.
  const doneUnit = await call(runtime, {
    method: 'POST',
    url: '/api/platforms/sim/courses/1001/9001/study',
    session,
    body: { unit_ids: ['1001-u3'] },
  });
  const skipped = await waitFor(runtime, session, doneUnit.body.task.id, 'completed', 5000);
  assert.equal(skipped.progress, 100);
  assert.match(skipped.detail, /均已完成/);

  // the checkpoint is sealed in the database
  const row = runtime.db.get<{ checkpoint: Uint8Array | null }>(
    'SELECT checkpoint FROM tasks WHERE id = ?1',
    taskId,
  );
  assert.ok(row?.checkpoint);
  assert.ok(!Buffer.from(row!.checkpoint!).toString('utf8').includes('1001-u1'));

  // disabling the module removes the platform without taking the framework down
  await call(runtime, { method: 'POST', url: '/api/modules/sim/disable', session });
  const after = (await call(runtime, { url: '/api/platforms', session })).body.platforms as any[];
  assert.deepEqual(after, []);
  const stillOk = await call(runtime, { url: '/healthz' });
  assert.equal(stillOk.body.status, 'ok');
});

test('only the terminal setup code creates the first administrator', async (t) => {
  const { runtime } = await boot();
  t.after(async () => runtime.close());
  const created = await call(runtime, {
    method: 'POST',
    url: '/api/auth/setup',
    body: { setup_code: 'test-setup-code', username: 'root', password: 'another-passphrase-2026' },
  });
  assert.equal(created.status, 200);
  const again = await call(runtime, {
    method: 'POST',
    url: '/api/auth/setup',
    body: { setup_code: 'test-setup-code', username: 'other', password: 'another-passphrase-2026' },
  });
  assert.equal(again.status, 409);
  const login = await call(runtime, {
    method: 'POST',
    url: '/api/auth/login',
    body: { username: 'root', password: 'wrong-password-000' },
  });
  assert.equal(login.status, 401);
});

test('a module installed as a directory copies only what it declares', async (t) => {
  const { runtime } = await boot();
  t.after(async () => runtime.close());
  assert.ok(fs.existsSync(path.join(simulatorDir, 'courseflow.module.json')));
  const row = runtime.manager.install(simulatorDir);
  const installed = fs.readdirSync(path.join(row.path)).sort();
  assert.deepEqual(installed, ['courseflow.module.json', 'index.mjs']);
});
