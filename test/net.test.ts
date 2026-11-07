import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHeaderCookies, type Cookie } from '../src/modules/net.ts';

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
