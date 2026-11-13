import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHeaderCookies, performFetch, type Cookie } from '../src/modules/net.ts';
import { ModuleManager } from '../src/modules/manager.ts';
import { setTimeout as delay } from 'node:timers/promises';

const NOW = 1_700_000_000;

const jar: Cookie[] = [
  {
    name: 'jwt',
    value: 'jwt-value',
    domain: 'ucontent.unipus.cn',
    path: '/',
    secure: true,
    http_only: true,
    expires_at: NOW + 60,
  },
  {
    name: 'sso',
    value: 'sso-value',
    domain: 'sso.unipus.cn',
    path: '/sso',
    secure: false,
    http_only: false,
  },
];

const missingCookie = (error: unknown) =>
  (error as { code?: string }).code === 'platform_login_expired';

test('network redirects and response bodies share a single timeout budget', async t => {
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    const signal = init.signal!;
    signals.push(signal);
    if (signals.length === 1) return new Response(null, { status: 302, headers: { location: '/next' } });
    return new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }));
  });
  // Keep the test process alive while AbortSignal's unref'ed timer expires.
  const keepAlive = delay(500);
  await assert.rejects(performFetch({ method: 'GET', url: 'https://chaoxing.com/start', headers: {}, body: null },
    { allow: ['chaoxing.com'], cookies: [], token: '', now: NOW, timeoutMs: 30 }), { name: 'TimeoutError' });
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1], 'redirects must not reset the deadline');
  assert.equal(signals[0]!.aborted, true);
  await keepAlive;
});

test('host network timeout is validated before making a request', async t => {
  const manager = Object.create(ModuleManager.prototype);
  manager.sessions = { resolveFetch: () => ({}) };
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('invalid budget must not reach the network'); });
  for (const timeout_ms of [0, -1, 25001, 1.5, '1000']) {
    await assert.rejects(manager.hostFetch('cx', { session: 'synthetic', method: 'GET', url: 'https://chaoxing.com/', timeout_ms }),
      (error: any) => error.code === 'invalid_params');
  }
});

test('resolves a cookie placeholder in a request header', () => {
  const headers = resolveHeaderCookies(
    { authorization: 'jwt=${cookie:jwt}' },
    jar,
    new URL('https://ucontent.unipus.cn/course/api'),
    NOW,
  );
  assert.equal(headers.authorization, 'jwt=jwt-value');
});

test('leaves headers without placeholders unchanged', () => {
  const headers = resolveHeaderCookies(
    { accept: 'application/json', authorization: 'Bearer token' },
    jar,
    new URL('https://ucontent.unipus.cn/'),
    NOW,
  );
  assert.deepEqual(headers, { accept: 'application/json', authorization: 'Bearer token' });
});

test('rejects a cookie that does not match the request host', () => {
  assert.throws(
    () =>
      resolveHeaderCookies(
        { authorization: 'jwt=${cookie:jwt}' },
        jar,
        new URL('https://sso.unipus.cn/sso/login'),
        NOW,
      ),
    missingCookie,
  );
});

test('rejects a cookie that does not match the request path', () => {
  assert.throws(
    () =>
      resolveHeaderCookies(
        { authorization: 'sso=${cookie:sso}' },
        jar,
        new URL('https://sso.unipus.cn/other'),
        NOW,
      ),
    missingCookie,
  );
});

test('rejects an expired cookie', () => {
  assert.throws(
    () =>
      resolveHeaderCookies(
        { authorization: 'jwt=${cookie:jwt}' },
        jar,
        new URL('https://ucontent.unipus.cn/'),
        NOW + 120,
      ),
    missingCookie,
  );
});

test('rejects an unknown cookie name', () => {
  assert.throws(
    () =>
      resolveHeaderCookies(
        { authorization: 'x=${cookie:missing}' },
        jar,
        new URL('https://ucontent.unipus.cn/'),
        NOW,
      ),
    missingCookie,
  );
});
