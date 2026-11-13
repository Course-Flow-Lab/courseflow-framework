import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesOrigin } from '../src/server/access.ts';
import { performFetch } from '../src/modules/net.ts';
import { ModuleManager } from '../src/modules/manager.ts';

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
    return { units: params.course.id === 'unknown' ? [{ state: 'unknown' }] : [{ state: 'completed' }, { state: 'in_progress' }] };
  };
  assert.equal((await manager.courses('synthetic', 'mock'))[1].progress, null);
  assert.deepEqual(scanned, [], 'listing courses must not scan every outline');
  await manager.units('synthetic', 'mock', courses[1]);
  await manager.units('synthetic', 'mock', courses[2]);
  const result = await manager.courses('synthetic', 'mock');
  assert.equal(result[0].progress, 37);
  assert.equal(result[1].progress, 50);
  assert.equal(result[1].progress_source, 'units');
  assert.equal(result[2].progress, null);
  assert.deepEqual(scanned, ['missing', 'unknown']);
  manager.requireSession = () => 'new-connection';
  assert.equal((await manager.courses('synthetic', 'mock'))[1].progress, null);
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
