import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, createUser } from '../src/core/auth.ts';
import { nowSeconds } from '../src/core/domain.ts';
import { boot, call, setupAdmin } from './support/harness.ts';

test('web assets are served independently of cwd without exposing source or runtime data', async (t) => {
  const { runtime } = await boot();
  t.after(() => runtime.close());
  const html = await runtime.app.inject('/');
  assert.equal(html.statusCode, 200);
  assert.match(html.body, /id="sidebar-nav"/);
  assert.match(String(html.headers['content-security-policy']), /style-src 'self'/);
  assert.ok(!String(html.headers['content-security-policy']).includes('unsafe-inline'));
  for (const file of ['/app.js', '/api.js', '/views.js', '/features.js', '/qa.js', '/logs.js', '/style.css']) {
    const response = await runtime.app.inject(file);
    assert.equal(response.statusCode, 200, file);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
  for (const file of ['/src/runtime.ts', '/secret.key', '/courseflow.db']) {
    assert.equal((await runtime.app.inject(file)).statusCode, 404);
  }
});

test('route split preserves admin, CSRF and owner boundaries', async (t) => {
  const { runtime } = await boot();
  t.after(() => runtime.close());
  const admin = await setupAdmin(runtime);
  const user = await createUser(runtime.db, 'member', 'synthetic-member-passphrase', 'user', nowSeconds());
  const member = createSession(runtime.db, user.id, nowSeconds());
  assert.equal((await call(runtime, { url: '/api/modules', session: member })).status, 403);
  const noCsrf = await runtime.app.inject({ method: 'POST', url: '/api/modules/missing/disable', headers: { cookie: `cf_session=${admin.token}` } });
  assert.equal(noCsrf.statusCode, 403);
  const wrongOrigin = await runtime.app.inject({ method: 'POST', url: '/api/auth/logout', headers: {
    cookie: `cf_session=${admin.token}`, 'x-courseflow-csrf': admin.csrf, origin: 'https://another.example',
  } });
  assert.equal(wrongOrigin.statusCode, 403);
  assert.equal((await call(runtime, { url: '/api/tasks/missing', session: member })).status, 404);
});

test('malformed JSON is a client error', async (t) => {
  const { runtime } = await boot();
  t.after(() => runtime.close());
  const response = await runtime.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{broken' });
  assert.equal(response.statusCode, 400);
});
