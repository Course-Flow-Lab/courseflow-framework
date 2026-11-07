import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/core/db.ts';
import { createSession, createUser, registerUser } from '../src/core/auth.ts';
import { generateInvitations, invitationOverview, registrationSettings, revokeInvitation, saveRegistrationSettings } from '../src/core/invitations.ts';
import { digest, nowSeconds } from '../src/core/domain.ts';
import { boot, call, setupAdmin, tokenFrom } from './support/harness.ts';

const PASSWORD = 'synthetic-invitation-passphrase';
const signup = (username: string, invitation_code?: unknown) => ({ username, password: PASSWORD, invitation_code });

test('初始化前不可注册；初始化后默认要求邀请码，不能用注册接口创建管理员', async (t) => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  assert.equal((await call(runtime, { url: '/api/bootstrap' })).body.registration.invitation_required, true);
  const before = await call(runtime, { method: 'POST', url: '/api/auth/register', body: signup('member') });
  assert.equal(before.status, 409); assert.equal(before.body.error.code, 'setup_required');
  assert.equal(runtime.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n, 0);
  await setupAdmin(runtime);
  const without = await call(runtime, { method: 'POST', url: '/api/auth/register', body: { ...signup('member'), role: 'admin' } });
  assert.equal(without.status, 400); assert.equal(without.body.error.code, 'invitation_required');
  assert.equal((await call(runtime, { method: 'POST', url: '/api/auth/setup', body: {} })).status, 409);
});

test('管理员批量生成指定格式的邀请码，数据库和列表不保存或回显完整邀请码', async (t) => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  const admin = await setupAdmin(runtime);
  const generated = await call(runtime, { method: 'POST', url: '/api/admin/invitations', session: admin, body: { count: 100 } });
  assert.equal(generated.status, 200);
  const codes = generated.body.codes as string[];
  assert.equal(codes.length, 100); assert.equal(new Set(codes).size, 100);
  for (const code of codes) assert.match(code, /^[A-Z0-9]{5}(?:-[A-Z0-9]{5}){4}$/);
  const overview = await call(runtime, { url: '/api/admin/registration', session: admin });
  assert.deepEqual(overview.body.stats, { total: 100, available: 100, used: 0, revoked: 0 });
  assert.equal(overview.body.invitations.length, 100);
  const stored = JSON.stringify(runtime.db.all('SELECT * FROM invitations'));
  for (const code of codes) {
    assert.ok(!stored.includes(code));
    assert.ok(!JSON.stringify(overview.body).includes(code));
    assert.ok(runtime.db.get('SELECT 1 FROM invitations WHERE code_hash=?1', digest(code)));
  }
  assert.ok(!JSON.stringify(overview.body).includes('code_hash'));
  const response = await runtime.app.inject({ url: '/api/admin/registration', headers: { cookie: `cf_session=${admin.token}` } });
  assert.equal(response.headers['cache-control'], 'no-store');
  for (const count of [0, -1, 101, 1.5, '2', null, true]) {
    assert.equal((await call(runtime, { method: 'POST', url: '/api/admin/invitations', session: admin, body: { count } })).status, 400);
  }
  const now = nowSeconds();
  assert.doesNotMatch(await runtime.logs.export('audit', now - 60, now + 60), new RegExp(codes[0]!));
});

test('邀请码管理严格要求管理员、CSRF 和同源请求', async (t) => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  const admin = await setupAdmin(runtime);
  const user = await createUser(runtime.db, 'member', PASSWORD, 'user', nowSeconds());
  const member = createSession(runtime.db, user.id, nowSeconds());
  for (const [method, url, body] of [
    ['GET', '/api/admin/registration', undefined],
    ['POST', '/api/admin/registration', { invitation_required: false }],
    ['POST', '/api/admin/invitations', { count: 1 }],
    ['POST', '/api/admin/invitations/missing/revoke', {}],
  ] as const) {
    assert.equal((await call(runtime, { method, url, body })).status, 401);
    assert.equal((await call(runtime, { method, url, body, session: member })).status, 403);
    if (method === 'POST') {
      const noCsrf = await runtime.app.inject({ method, url, payload: body, headers: { cookie: `cf_session=${admin.token}` } });
      assert.equal(noCsrf.statusCode, 403);
      const crossOrigin = await runtime.app.inject({ method, url, payload: body, headers: { cookie: `cf_session=${admin.token}`, 'x-courseflow-csrf': admin.csrf, origin: 'https://other.example' } });
      assert.equal(crossOrigin.statusCode, 403);
    }
  }
  const crossOrigin = await runtime.app.inject({ method: 'POST', url: '/api/auth/register', payload: signup('cross-origin'), headers: { origin: 'https://other.example' } });
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(registrationSettings(runtime.db).invitation_required, true);
});

test('邀请码注册成功即登录为成员；同一码不能重复注册，已有账号不受开关影响', async (t) => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  const admin = await setupAdmin(runtime);
  const code = (await call(runtime, { method: 'POST', url: '/api/admin/invitations', session: admin })).body.codes[0] as string;
  const registered = await call(runtime, { method: 'POST', url: '/api/auth/register', body: { ...signup('  new-member  ', ` ${code.toLowerCase()} `), role: 'admin' } });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  assert.equal(registered.body.user.username, 'new-member'); assert.equal(registered.body.user.role, 'user');
  assert.ok(!('password_hash' in registered.body.user));
  const session = { token: tokenFrom(registered.setCookie), csrf: registered.body.csrf };
  assert.equal((await call(runtime, { url: '/api/me', session })).body.user.id, registered.body.user.id);
  assert.equal((await call(runtime, { url: '/api/admin/registration', session })).status, 403);
  const again = await call(runtime, { method: 'POST', url: '/api/auth/register', body: signup('another-member', code) });
  assert.equal(again.status, 400); assert.equal(again.body.error.code, 'invalid_invitation');
  assert.ok(!runtime.db.get('SELECT 1 FROM users WHERE username=?1', 'another-member'));
  const overview = invitationOverview(runtime.db);
  assert.equal(overview.stats.used, 1); assert.equal(overview.invitations[0]!.used_by, 'new-member');
  await call(runtime, { method: 'POST', url: '/api/auth/logout', session });
  assert.equal((await call(runtime, { method: 'POST', url: '/api/auth/login', body: signup('NEW-MEMBER') })).status, 200);
  assert.equal((await call(runtime, { method: 'POST', url: '/api/admin/invitations/' + overview.invitations[0]!.id + '/revoke', session: admin })).status, 409);
});

test('无效凭据、重复用户名和注册事务失败都不会消耗邀请码或遗留半个账号', async (t) => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  await setupAdmin(runtime);
  const actor = runtime.db.get<{ id: string }>('SELECT id FROM users')!.id;
  const code = generateInvitations(runtime.db, actor, 1, nowSeconds())[0]!;
  for (const body of [
    { ...signup('valid-member', code), password: 'short' },
    signup('!', code),
    { ...signup('valid-member', code), password: 123 },
    { ...signup('valid-member', code), username: ['wrong'] },
    signup('valid-member', 123),
  ]) assert.equal((await call(runtime, { method: 'POST', url: '/api/auth/register', body })).status, 400);
  const duplicate = await call(runtime, { method: 'POST', url: '/api/auth/register', body: signup('ADMIN', code) });
  assert.equal(duplicate.status, 409); assert.equal(duplicate.body.error.code, 'username_taken');
  assert.equal(invitationOverview(runtime.db).stats.available, 1);
  runtime.db.exec("CREATE TRIGGER synthetic_session_failure BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'synthetic-session-failure'); END");
  await assert.rejects(registerUser(runtime.db, 'rollback-member', PASSWORD, code, nowSeconds()), /synthetic-session-failure/);
  assert.ok(!runtime.db.get("SELECT 1 FROM users WHERE username='rollback-member'"));
  assert.equal(invitationOverview(runtime.db).stats.available, 1);
  runtime.db.exec('DROP TRIGGER synthetic_session_failure');
  assert.equal((await call(runtime, { method: 'POST', url: '/api/auth/register', body: signup('valid-member', code) })).status, 200);
});

test('关闭邀请码要求后可直接注册，重新开启立即生效；主动填写的邀请码仍需有效', async (t) => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  const admin = await setupAdmin(runtime);
  for (const value of ['false', 0, null]) assert.equal((await call(runtime, { method: 'POST', url: '/api/admin/registration', session: admin, body: { invitation_required: value } })).status, 400);
  assert.equal((await call(runtime, { method: 'POST', url: '/api/admin/registration', session: admin, body: { invitation_required: false } })).status, 200);
  assert.equal((await call(runtime, { url: '/api/bootstrap' })).body.registration.invitation_required, false);
  assert.equal((await call(runtime, { method: 'POST', url: '/api/auth/register', body: signup('open-member') })).status, 200);
  assert.equal((await call(runtime, { method: 'POST', url: '/api/auth/register', body: signup('invalid-member', 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE') })).status, 400);
  await call(runtime, { method: 'POST', url: '/api/admin/registration', session: admin, body: { invitation_required: true } });
  assert.equal((await call(runtime, { method: 'POST', url: '/api/auth/register', body: signup('closed-member') })).status, 400);
  assert.equal((await call(runtime, { method: 'POST', url: '/api/auth/login', body: signup('open-member') })).status, 200);
});

test('并发注册只能使用邀请码一次；哈希计算期间撤销邀请码或收紧规则也不能绕过', async (t) => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  await setupAdmin(runtime);
  const actor = runtime.db.get<{ id: string }>('SELECT id FROM users')!.id;
  const code = generateInvitations(runtime.db, actor, 1, nowSeconds())[0]!;
  const results = await Promise.allSettled(['concurrent-one', 'concurrent-two'].map((name) => registerUser(runtime.db, name, PASSWORD, code, nowSeconds())));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(invitationOverview(runtime.db).stats.used, 1);
  const revokedCode = generateInvitations(runtime.db, actor, 1, nowSeconds())[0]!;
  const pending = registerUser(runtime.db, 'late-revoked', PASSWORD, revokedCode, nowSeconds());
  const id = runtime.db.get<{ id: string }>('SELECT id FROM invitations WHERE code_hash=?1', digest(revokedCode))!.id;
  revokeInvitation(runtime.db, id, nowSeconds());
  await assert.rejects(pending, /邀请码无效/);
  saveRegistrationSettings(runtime.db, false);
  const open = registerUser(runtime.db, 'late-closed', PASSWORD, undefined, nowSeconds());
  saveRegistrationSettings(runtime.db, true);
  await assert.rejects(open, /请填写管理员提供的邀请码/);
  assert.ok(!runtime.db.get("SELECT 1 FROM users WHERE username IN ('late-revoked','late-closed')"));
  assert.equal((await call(runtime, { method: 'POST', url: '/api/admin/invitations/missing/revoke', session: createSession(runtime.db, actor, nowSeconds()) })).status, 404);
});

test('已有版本 2 数据库原地升级保留用户，新设置和邀请码在重新打开后保留', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'courseflow-invitation-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'courseflow.db');
  const old = new Db(file);
  const admin = await createUser(old, 'migration-admin', PASSWORD, 'admin', nowSeconds());
  old.exec('DROP TABLE invitations; DROP TABLE site_settings; PRAGMA user_version=2');
  old.close();
  const migrated = new Db(file);
  assert.equal(migrated.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 3);
  assert.equal(migrated.get<{ username: string }>('SELECT username FROM users WHERE id=?1', admin.id)!.username, 'migration-admin');
  assert.equal(registrationSettings(migrated).invitation_required, true);
  saveRegistrationSettings(migrated, false);
  generateInvitations(migrated, admin.id, 1, nowSeconds());
  migrated.close();
  const reopened = new Db(file); t.after(() => reopened.close());
  assert.equal(registrationSettings(reopened).invitation_required, false);
  assert.equal(invitationOverview(reopened).stats.available, 1);
});
