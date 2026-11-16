import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesOrigin } from '../src/server/access.ts';
import { performFetch } from '../src/modules/net.ts';
import { ModuleManager } from '../src/modules/manager.ts';
import { fileURLToPath } from 'node:url';
import { boot, call, setupAdmin } from './support/harness.ts';

test('loopback aliases require the configured protocol and port', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(matchesOrigin(`http://${host}:8100`, 'http://127.0.0.1:8100'), true);
  for (const origin of ['null', 'http://localhost:8101', 'https://localhost:8100', 'http://evil.test:8100', 'http://localhost:8100/path']) assert.equal(matchesOrigin(origin, 'http://127.0.0.1:8100'), false);
  assert.equal(matchesOrigin('http://localhost:8100', 'https://example.com'), false);
});

test('legacy redirects are upgraded without transmitting cookies over HTTP', async t => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    urls.push(String(url));
    return urls.length === 1 ? new Response(null, { status: 302, headers: { location: 'http://i.mooc.chaoxing.com/space/index' } }) : new Response('ok');
  });
  const result = await performFetch({ method: 'GET', url: 'https://passport2.chaoxing.com/login', headers: {}, body: null }, { allow: ['*.chaoxing.com'], cookies: [], token: '', now: 0 });
  assert.equal(result.body, 'ok');
  assert.deepEqual(urls, ['https://passport2.chaoxing.com/login', 'https://i.mooc.chaoxing.com/space/index']);
});

test('redirects outside the manifest remain blocked', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302, headers: { location: 'http://evil.test/' } }));
  await assert.rejects(performFetch({ method: 'GET', url: 'https://chaoxing.com/', headers: {}, body: null }, { allow: ['*.chaoxing.com'], cookies: [], token: '', now: 0 }), /未授权/);
});

test('course lists reuse explicit directory progress without scanning other courses', async () => {
  const courses = [{ id: 'known', progress: 37, outline_available: true }, { id: 'missing', progress: null, outline_available: true }, { id: 'unknown', progress: null, outline_available: true }];
  const manager = Object.create(ModuleManager.prototype);
  manager.directoryProgress = new Map();
  manager.requireSession = () => 'synthetic';
  const scanned: string[] = [];
  manager.catalog = async (_platform: string, method: string, params: any) => {
    if (method === 'catalog.courses') return { courses: structuredClone(courses) };
    scanned.push(params.course.id);
    return { units: params.course.id === 'unknown' ? [{ state: 'completed' }, { state: 'unknown' }] : [{ state: 'completed' }, { state: 'in_progress' }] };
  };
  assert.equal((await manager.courses('synthetic', 'mock'))[1].progress, null);
  assert.deepEqual(scanned, [], 'listing courses must not scan every outline');
  const opened = structuredClone(courses[1]);
  await manager.units('synthetic', 'mock', opened);
  assert.equal(opened.progress, 50, 'the first directory response must contain the computed progress');
  await manager.units('synthetic', 'mock', structuredClone(courses[2]));
  const result = await manager.courses('synthetic', 'mock');
  assert.equal(result[0].progress, 37);
  assert.equal(result[1].progress, 50);
  assert.equal(result[1].progress_source, 'units');
  assert.equal(result[2].progress, null);
  assert.deepEqual(result[2].unit_progress, { completed: 1, total: 2, unknown: 1 });
  assert.deepEqual(scanned, ['missing', 'unknown']);
  manager.requireSession = () => 'new-connection';
  assert.equal((await manager.courses('synthetic', 'mock'))[1].progress, null);
});

test('目录 API 首次读取即返回完成度，保留平台百分比与部分未知状态', async t => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  const admin = await setupAdmin(runtime);
  const owner = (await call(runtime, { url: '/api/me', session: admin })).body.user.id;
  runtime.manager.install(fileURLToPath(new URL('../modules/simulator', import.meta.url)));
  const login = await call(runtime, { method: 'POST', url: '/api/platforms/sim/login', session: admin });
  await call(runtime, { method: 'POST', url: `/api/platforms/sim/login/${login.body.challenge.id}/poll`, session: admin });
  const course = (await runtime.manager.courses(owner, 'sim'))[0]!;
  let states = ['completed', 'completed'], official: number | null = null;
  (runtime.manager as any).catalog = async (_platform: string, method: string) => method === 'catalog.courses' ? { courses: [{ ...course, progress: official }] } : { units: states.map((state, index) => ({ id: String(index), state, kind: 'video' })) };
  const url = `/api/platforms/sim/courses/${course.id}/${course.recruit_id}/units`;
  const read = async () => (await call(runtime, { url, session: admin })).body.course;
  let result = await read();
  assert.equal(result.progress, 100); assert.equal(result.progress_source, 'units');
  assert.deepEqual(result.unit_progress, { completed: 2, total: 2, unknown: 0 });
  states = ['completed', 'unknown']; result = await read();
  assert.equal(result.progress, null); assert.deepEqual(result.unit_progress, { completed: 1, total: 2, unknown: 1 });
  official = 0; states = ['completed', 'completed']; result = await read();
  assert.equal(result.progress, 0); assert.equal(result.progress_source, undefined);
});

test('concurrent catalog readers share the scan and retry after failure', async () => {
  const manager = Object.create(ModuleManager.prototype);
  manager.catalogCalls = new Map();
  manager.sessions = { resolveFetch() {} };
  const pages: any[] = [];
  let finish!: (value: any) => void;
  manager.call = async (_platform: string, _method: string, params: any) => {
    pages.push(params);
    if (!params.cursor) return new Promise(resolve => { finish = resolve; });
    return { units: [{ id: 'second' }] };
  };
  const read = () => manager.catalog('cx', 'catalog.units', { session: 'synthetic', course: { id: 'one' } }, 'units');
  const first = read(), second = read();
  assert.equal(pages.length, 1);
  finish({ units: [{ id: 'first' }], next_cursor: 'next' });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(pages.length, 2);
  assert.deepEqual(a.units.map((unit: any) => unit.id), ['first', 'second']);
  a.units[0].id = 'changed';
  assert.equal(b.units[0].id, 'first', 'callers must not share mutable data');
  manager.call = async () => { throw Error('synthetic network failure'); };
  await assert.rejects(read(), /synthetic network failure/);
  manager.call = async () => ({ units: [] });
  assert.deepEqual((await read()).units, []);
});
