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

test('missing course progress uses known directory states and preserves platform totals', async () => {
  const courses = [{ id: 'known', progress: 37, outline_available: true }, { id: 'missing', progress: null, outline_available: true }, { id: 'unknown', progress: null, outline_available: true }, { id: 'failed', progress: null, outline_available: true }];
  const manager = Object.create(ModuleManager.prototype);
  manager.directoryProgress = new Map();
  manager.requireSession = () => 'synthetic';
  manager.catalog = async () => ({ courses });
  manager.units = async (_owner: string, _platform: string, course: { id: string }) => {
    if (course.id === 'failed') throw Error('offline');
    return course.id === 'unknown' ? [{ state: 'unknown' }] : [{ state: 'completed' }, { state: 'in_progress' }];
  };
  const result = await manager.courses('synthetic', 'mock');
  assert.equal(result[0].progress, 37);
  assert.equal(result[1].progress, 50);
  assert.equal(result[1].progress_source, 'units');
  assert.equal(result[2].progress, null);
  assert.equal(result[3].progress, null);
});
