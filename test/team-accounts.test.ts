import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../src/core/db.ts';
import { createSession, createUser } from '../src/core/auth.ts';
import { nowSeconds, digest } from '../src/core/domain.ts';
import { savePreferences } from '../src/core/preferences.ts';
import { accountQuota, platformOwner } from '../src/core/platform-accounts.ts';
import { boot, call, setupAdmin, waitFor, type HttpRuntime, type Session } from './support/harness.ts';

const password = 'synthetic-team-passphrase';
async function team(runtime: HttpRuntime, admin: Session, name = 'team', limit = 3) {
  const result = await call(runtime, { method: 'POST', url: '/api/admin/users', session: admin, body: { username: name, password, role: 'team', platform_account_limit: limit } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return { user: result.body.user, session: createSession(runtime.db, result.body.user.id, nowSeconds()) };
}
async function simulator(runtime: HttpRuntime, dir: string, id = 'sim') {
  const source = path.join(dir, id); fs.mkdirSync(source);
  const reference = fileURLToPath(new URL('../modules/simulator/', import.meta.url));
  const manifest = JSON.parse(fs.readFileSync(path.join(reference, 'courseflow.module.json'), 'utf8'));
  manifest.id = manifest.platform.id = id;
  fs.writeFileSync(path.join(source, 'courseflow.module.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(source, 'index.mjs'), fs.readFileSync(path.join(reference, 'index.mjs'), 'utf8').replace("account_raw: 'sim-10001'", 'account_raw: params.challenge'));
  runtime.manager.install(source);
}
async function add(runtime: HttpRuntime, session: Session, label: string, platform = 'sim') {
  const result = await call(runtime, { method: 'POST', url: `/api/platforms/${platform}/accounts`, session, body: { label } });
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.account;
}
async function login(runtime: HttpRuntime, session: Session, account: string, platform = 'sim') {
  const begin = await call(runtime, { method: 'POST', url: `/api/platforms/${platform}/login?account_id=${account}`, session });
  assert.equal(begin.status, 200, JSON.stringify(begin.body));
  const done = await call(runtime, { method: 'POST', url: `/api/platforms/${platform}/login/${begin.body.challenge.session}/poll?account_id=${account}`, session });
  assert.equal(done.status, 200, JSON.stringify(done.body)); assert.equal(done.body.state, 'connected');
}

test('团队角色及总配额由管理员设置，自助注册不能升级权限或更改配额', async t => {
  const { runtime } = await boot(); t.after(() => runtime.close()); const admin = await setupAdmin(runtime);
  const current = await team(runtime, admin);
  const endpoint = `/api/admin/users/${current.user.id}/platform-account-limit`;
  assert.equal((await call(runtime, { url: endpoint, method: 'POST', session: current.session, body: { limit: 999 } })).status, 403);
  assert.equal((await runtime.app.inject({ method: 'POST', url: endpoint, headers: { cookie: `cf_session=${admin.token}` }, payload: { limit: 1 } })).statusCode, 403);
  for (const limit of [-1, 1.5, '2', null, 1001]) assert.equal((await call(runtime, { url: endpoint, method: 'POST', session: admin, body: { limit } })).status, 400);
  assert.deepEqual((await call(runtime, { url: endpoint, method: 'POST', session: admin, body: { limit: 0 } })).body.account_quota, { limit: 0, used: 0, remaining: 0 });
  assert.equal((await call(runtime, { url: '/api/me', session: current.session })).body.user.role, 'team');
  assert.equal((await call(runtime, { url: '/api/modules', session: current.session })).status, 403);
  await call(runtime, { url: '/api/admin/registration', method: 'POST', session: admin, body: { invitation_required: false } });
  const registered = await call(runtime, { url: '/api/auth/register', method: 'POST', body: { username: 'public', password, role: 'team', platform_account_limit: 999 } });
  assert.equal(registered.status, 200); assert.equal(registered.body.user.role, 'user');
});

test('账号位按全部平台合并计数，并发创建不能超额，降额保留绑定，移除后可再次添加', async t => {
  const { runtime, dir } = await boot(); t.after(() => runtime.close()); const admin = await setupAdmin(runtime);
  await simulator(runtime, dir); await simulator(runtime, dir, 'other');
  const current = await team(runtime, admin, 'limited-team', 2);
  const requests = await Promise.all(['sim', 'other', 'sim', 'other'].map((pid, i) => call(runtime, { method: 'POST', url: `/api/platforms/${pid}/accounts`, session: current.session, body: { label: '账号' + i } })));
  assert.equal(requests.filter(r => r.status === 200).length, 2, JSON.stringify(requests));
  assert.equal(requests.filter(r => r.body.error?.code === 'platform_account_limit').length, 2, JSON.stringify(requests));
  assert.equal(accountQuota(runtime.db, current.user.id)!.used, 2);
  assert.equal((await call(runtime, { url: '/api/platforms/sim/login', method: 'POST', session: current.session })).body.error.code, 'platform_account_required');
  await call(runtime, { method: 'POST', url: `/api/admin/users/${current.user.id}/platform-account-limit`, session: admin, body: { limit: 1 } });
  assert.deepEqual(accountQuota(runtime.db, current.user.id), { limit: 1, used: 2, remaining: 0 });
  const accounts = runtime.db.all<{ id: string; platform: string }>('SELECT id,platform FROM platform_accounts WHERE owner=?1', current.user.id);
  for (const account of accounts) assert.equal((await call(runtime, { method: 'DELETE', url: `/api/platforms/${account.platform}/accounts/${account.id}`, session: current.session })).status, 200);
  await add(runtime, current.session, '释放后添加');
  assert.equal(accountQuota(runtime.db, current.user.id)!.used, 1);
});

test('同平台多账号通过真实离线模块运行，课程状态、任务、会话和日志相互隔离', async t => {
  const { runtime, dir } = await boot(); t.after(() => runtime.close()); const admin = await setupAdmin(runtime);
  await simulator(runtime, dir);
  const current = await team(runtime, admin);
  const first = await add(runtime, current.session, '甲同学'), second = await add(runtime, current.session, '乙同学');
  await login(runtime, current.session, first.id); await login(runtime, current.session, second.id);
  savePreferences(runtime.db, current.user.id, { concurrency: 2, quiet_hours: false });
  const coursePath = '/api/platforms/sim/courses/1001/9001';
  for (const account of [first, first, second]) assert.equal((await call(runtime, { url: `/api/platforms/sim/courses?account_id=${account.id}`, session: current.session })).status, 200);
  const state = (owner: string) => {
    const row = runtime.db.get<{ sealed: Uint8Array }>("SELECT sealed FROM module_state WHERE owner=?1 AND namespace='sim' AND state_key='visits'", owner)!;
    return runtime.vault.openJson<number>(owner, `module/sim/${digest(owner).slice(0, 16)}/sim/visits`, Buffer.from(row.sealed));
  };
  assert.equal(state(first.id), 2); assert.equal(state(second.id), 1);
  const tasks = [];
  for (const account of [first, second]) {
    const result = await call(runtime, { method: 'POST', url: `${coursePath}/study?account_id=${account.id}`, session: current.session, body: { unit_ids: ['1001-u1'] } });
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.task.account_id, account.id); tasks.push(result.body.task);
  }
  for (const task of tasks) await waitFor(runtime, current.session, task.id, 'completed');
  assert.equal(runtime.jobs.list(current.user.id).length, 2);
  for (const [index, account] of [first, second].entries()) {
    const response = await runtime.app.inject({ url: `/api/history/export?platform=sim&course=1001&recruit=9001&account_id=${account.id}`, headers: { cookie: `cf_session=${current.session.token}` } });
    assert.equal(response.statusCode, 200); assert.ok(response.body.includes(tasks[index].id)); assert.ok(!response.body.includes(tasks[1 - index].id));
  }
  const summaries = (await call(runtime, { url: '/api/platforms', session: current.session })).body;
  assert.equal(summaries.platforms[0].accounts.filter((a: any) => a.connected).length, 2);
  assert.doesNotMatch(JSON.stringify(summaries), /account_raw|cookies|sealed|session_id/);
});


test('绑定编号不能跨用户或跨平台使用，登录挑战不能切换绑定，移除后旧挑战失效', async t => {
  const { runtime, dir } = await boot(); t.after(() => runtime.close()); const admin = await setupAdmin(runtime);
  await simulator(runtime, dir); await simulator(runtime, dir, 'other');
  const current = await team(runtime, admin), other = await team(runtime, admin, 'other-team');
  const first = await add(runtime, current.session, '甲'), second = await add(runtime, current.session, '乙');
  const challenge = (await call(runtime, { method: 'POST', url: `/api/platforms/sim/login?account_id=${first.id}`, session: current.session })).body.challenge.session;
  for (const [session, pid, account] of [[other.session, 'sim', first.id], [current.session, 'other', first.id], [current.session, 'sim', 'missing']] as const) {
    const url = `/api/platforms/${pid}/courses?account_id=${account}`;
    assert.equal((await call(runtime, { url, session })).status, 404);
  }
  assert.equal((await call(runtime, { method: 'POST', url: `/api/platforms/sim/login/${challenge}/poll?account_id=${second.id}`, session: current.session })).status, 409);
  assert.equal((await call(runtime, { method: 'DELETE', url: `/api/platforms/sim/accounts/${first.id}`, session: other.session })).status, 404);
  await call(runtime, { method: 'DELETE', url: `/api/platforms/sim/accounts/${first.id}`, session: current.session });
  assert.throws(() => runtime.sessions.challenge(challenge, first.id));
  assert.equal((await call(runtime, { method: 'POST', url: `/api/platforms/sim/login/${challenge}/poll?account_id=${first.id}`, session: current.session })).status, 404);
  assert.equal(runtime.sessions.load(first.id, 'sim'), undefined);
});

test('默认单账号转为团队后计入总额且保留加密会话，新增绑定存在时不能降级角色', async t => {
  const { runtime, dir } = await boot(); t.after(() => runtime.close()); const admin = await setupAdmin(runtime);
  await simulator(runtime, dir);
  const member = await createUser(runtime.db, 'legacy-member', password, 'user', nowSeconds());
  const session = createSession(runtime.db, member.id, nowSeconds());
  assert.equal((await call(runtime, { url: '/api/platforms/sim/accounts', method: 'POST', session, body: { label: '禁止' } })).status, 403);
  const begin = (await call(runtime, { method: 'POST', url: '/api/platforms/sim/login', session })).body.challenge;
  await call(runtime, { method: 'POST', url: `/api/platforms/sim/login/${begin.session}/poll`, session });
  const stored = runtime.sessions.load(member.id, 'sim');
  const role = `/api/admin/users/${member.id}/role`;
  assert.equal((await call(runtime, { method: 'POST', url: role, session: admin, body: { role: 'team' } })).status, 200);
  assert.deepEqual(runtime.sessions.load(member.id, 'sim'), stored);
  assert.equal(accountQuota(runtime.db, member.id)!.used, 1);
  const account = (await call(runtime, { url: '/api/platforms', session })).body.platforms[0].accounts[0];
  assert.equal(account.legacy, true); assert.equal(platformOwner(runtime.db, member.id, 'sim', account.id), member.id);
  const extra = await add(runtime, session, '新增');
  assert.equal((await call(runtime, { method: 'POST', url: role, session: admin, body: { role: 'user' } })).body.error.code, 'team_accounts_remaining');
  await call(runtime, { method: 'DELETE', url: `/api/platforms/sim/accounts/${extra.id}`, session });
  assert.equal((await call(runtime, { method: 'POST', url: role, session: admin, body: { role: 'user' } })).status, 200);
  assert.equal((await call(runtime, { url: '/api/platforms/sim/courses', session })).status, 200);
});

test('停用团队后模块句柄失效，移除绑定停止其任务并撤销旧执行器，不影响其他账号', async t => {
  const { runtime, dir } = await boot(); const gate = Promise.withResolvers<any>();
  t.after(async () => { gate.resolve({ status: 'completed' }); await runtime.close(); });
  const admin = await setupAdmin(runtime); await simulator(runtime, dir);
  const current = await team(runtime, admin), account = await add(runtime, current.session, '甲'), keep = await add(runtime, current.session, '乙');
  await login(runtime, current.session, account.id); await login(runtime, current.session, keep.id);
  const handle = runtime.sessions.handleFor(account.id, 'sim')!;
  const course = (await runtime.manager.courses(account.id, 'sim'))[0]!;
  const entered = Promise.withResolvers<void>();
  runtime.manager.studyStep = async () => { entered.resolve(); return gate.promise; };
  const task = runtime.jobs.create(current.user.id, { account_id: account.id, platform: 'sim', operation: 'study', course, unit_ids: ['1001-u1'] });
  await entered.promise;
  await call(runtime, { method: 'DELETE', url: `/api/platforms/sim/accounts/${account.id}`, session: current.session });
  assert.equal(runtime.jobs.get(current.user.id, task.id).state, 'cancelled');
  assert.throws(() => runtime.sessions.resolveFetch(handle, 'sim'));
  assert.ok(runtime.sessions.load(keep.id, 'sim'));
  gate.resolve({ status: 'completed' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.jobs.get(current.user.id, task.id).state, 'cancelled');
  const remainingHandle = runtime.sessions.handleFor(keep.id, 'sim')!;
  await call(runtime, { method: 'POST', url: `/api/admin/users/${current.user.id}/status`, session: admin, body: { disabled: true } });
  assert.throws(() => runtime.sessions.resolveFetch(remainingHandle, 'sim'), /停用/);
});

test('版本 3 数据库原地迁移为版本 4，保留旧用户和任务且重开幂等', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courseflow-team-schema-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.db'), old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES users(id),platform TEXT NOT NULL,operation TEXT NOT NULL,course_id TEXT NOT NULL,recruit_id TEXT NOT NULL,course_name TEXT NOT NULL DEFAULT '',units TEXT NOT NULL DEFAULT '[]',state TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,progress REAL,detail TEXT NOT NULL DEFAULT '',checkpoint BLOB,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    INSERT INTO users VALUES('legacy','legacy','hash','user',0,123);
    INSERT INTO tasks(id,owner,platform,operation,course_id,recruit_id,state,created_at,updated_at) VALUES('task','legacy','sim','study','course','class','paused',123,123);
    PRAGMA user_version=3;`); old.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = new Db(file);
    assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 4);
    assert.equal(db.get<{ platform_account_limit: number }>("SELECT platform_account_limit FROM users WHERE id='legacy'")!.platform_account_limit, 10);
    assert.equal(db.get<{ account_id: null }>("SELECT account_id FROM tasks WHERE id='task'")!.account_id, null);
    assert.equal(db.get<{ created_at: number }>("SELECT created_at FROM users WHERE id='legacy'")!.created_at, 123);
    db.close();
  }
});

test('停用或卸载的平台仍可移除绑定并释放总配额', async t => {
  const { runtime, dir } = await boot(); t.after(() => runtime.close()); const admin = await setupAdmin(runtime);
  await simulator(runtime, dir);
  const current = await team(runtime, admin), account = await add(runtime, current.session, '待移除');
  runtime.manager.setEnabled('sim', false);
  let summary = (await call(runtime, { url: '/api/platforms', session: current.session })).body.platforms[0];
  assert.equal(summary.module.enabled, false); assert.equal(summary.accounts[0].id, account.id);
  runtime.manager.remove('sim');
  summary = (await call(runtime, { url: '/api/platforms', session: current.session })).body.platforms[0];
  assert.equal(summary.module.healthy, false); assert.equal(summary.accounts[0].id, account.id);
  assert.equal((await call(runtime, { method: 'DELETE', url: `/api/platforms/sim/accounts/${account.id}`, session: current.session })).status, 200);
  assert.equal(accountQuota(runtime.db, current.user.id)!.used, 0);
});

test('绑定使用团队模型和偏好，媒体只允许归属用户读取，重复平台身份不会覆盖已有绑定', async t => {
  const { runtime, dir } = await boot(); t.after(() => runtime.close()); const admin = await setupAdmin(runtime);
  await simulator(runtime, dir);
  const current = await team(runtime, admin), first = await add(runtime, current.session, '甲'), second = await add(runtime, current.session, '乙');
  await login(runtime, current.session, first.id);
  const original = runtime.sessions.load(first.id, 'sim')!;
  const challenge = runtime.sessions.openChallenge(second.id, 'sim', 60);
  assert.throws(() => runtime.sessions.complete(second.id, 'sim', challenge, original), /已绑定/);
  assert.deepEqual(runtime.sessions.load(first.id, 'sim'), original); assert.equal(runtime.sessions.load(second.id, 'sim'), undefined);
  let modelOwner = '';
  t.mock.method(runtime.ai, 'generate', async (owner: string) => { modelOwner = owner; return '合成答案'; });
  const handle = runtime.sessions.handleFor(first.id, 'sim')!;
  const answer = await (runtime.manager as any).hostCall('sim', 'cw.ai.generate', { session: handle, prompt: '合成题目' });
  assert.equal(answer.text, '合成答案'); assert.equal(modelOwner, current.user.id);
  const url = runtime.manager.registerImage(first.id, 'sim', 'https://synthetic.invalid/question.png');
  let imageOwner = '';
  t.mock.method(runtime.manager, 'image', async (owner: string) => { imageOwner = owner; return { mime: 'image/png', data: '' }; });
  assert.equal((await call(runtime, { url, session: admin })).status, 404);
  const response = await runtime.app.inject({ url, headers: { cookie: `cf_session=${current.session.token}` } });
  assert.equal(response.statusCode, 200); assert.equal(imageOwner, first.id);
});
