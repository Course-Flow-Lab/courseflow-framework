import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, call, setupAdmin, waitFor, type Session } from './support/harness.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleDir = path.resolve(here, '..', '..', 'courseflow-zhs');
const binary = path.join(moduleDir, 'target', 'release', 'courseflow-zhs');
const available = fs.existsSync(binary);

/**
 * The same contract, a different language and runtime. This test is skipped unless the Rust module
 * has been built (`cargo build --release` in ../courseflow-zhs).
 */
test(
  'the Rust 智慧树 module loads and runs through the same contract',
  { skip: available ? false : 'build ../courseflow-zhs first: cargo build --release' },
  async (t) => {
    const { runtime } = await boot('courseflow-zhs-');
    t.after(async () => runtime.close());

    const installed = runtime.manager.install(moduleDir);
    assert.equal(installed.id, 'zhs');
    assert.equal(installed.engine, 'binary');
    // The module's default source is `live`; this test runs offline against recorded fixtures.
    runtime.manager.configure('zhs', { source: 'fixture' });
    assert.equal(fs.existsSync(path.join(installed.path, 'target/release/courseflow-zhs')), true);

    const session: Session = await setupAdmin(runtime);

    const platforms = (await call(runtime, { url: '/api/platforms', session })).body.platforms as any[];
    assert.equal(platforms.length, 1);
    assert.equal(platforms[0].id, 'zhs');
    assert.equal(platforms[0].module.healthy, true);
    assert.match(platforms[0].operations.join(' '), /study/);

    // fixture source: begin -> waiting -> connected
    const begin = await call(runtime, { method: 'POST', url: '/api/platforms/zhs/login', session });
    assert.equal(begin.status, 200);
    assert.match(begin.body.challenge.image, /^data:image\/png;base64,/);
    const challenge = begin.body.challenge.id as string;
    await call(runtime, { method: 'POST', url: `/api/platforms/zhs/login/${challenge}/poll`, session });
    const second = await call(runtime, {
      method: 'POST',
      url: `/api/platforms/zhs/login/${challenge}/poll`,
      session,
    });
    assert.equal(second.body.state, 'connected');

    const courses = (await call(runtime, { url: '/api/platforms/zhs/courses', session })).body
      .courses as any[];
    assert.equal(courses.length, 2);
    const shared = courses.find((course) => course.kind === 'shared');
    assert.ok(shared, 'expected a shared course in the fixture');
    assert.equal(shared.family, 'shared');
    assert.equal(typeof shared.progress, 'number');

    const units = (
      await call(runtime, {
        url: `/api/platforms/zhs/courses/${shared.id}/${shared.recruit_id}/units`,
        session,
      })
    ).body;
    assert.equal(units.units.length, 3);
    // 智慧树 declares the Q&A tab only for shared courses; the framework resolves that.
    assert.deepEqual(units.ui.tabs.map((tab: any) => tab.id), ['qa']);
    assert.deepEqual(units.ui.actions.map((action: any) => action.id), ['trial']);
    assert.equal(units.units.find((unit: any) => unit.kind === 'document').selectable, false);

    // a zero-duration unit completes in one step, which keeps this test fast
    const documentUnit = units.units.find((unit: any) => unit.kind === 'document');
    const created = await call(runtime, {
      method: 'POST',
      url: `/api/platforms/zhs/courses/${shared.id}/${shared.recruit_id}/study`,
      session,
      body: { unit_ids: [documentUnit.id] },
    });
    assert.equal(created.status, 200);
    const finished = await waitFor(runtime, session, created.body.task.id, 'completed', 10_000);
    assert.equal(finished.progress, 100);
    assert.deepEqual(finished.completed, [documentUnit.id]);

    // the framework still cannot read the module's checkpoint
    const row = runtime.db.get<{ checkpoint: Uint8Array | null }>(
      'SELECT checkpoint FROM tasks WHERE id = ?1',
      created.body.task.id,
    );
    assert.ok(row?.checkpoint);
    assert.ok(!Buffer.from(row!.checkpoint!).includes(Buffer.from(documentUnit.id)));
  },
);
