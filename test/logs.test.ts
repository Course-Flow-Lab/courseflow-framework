import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LogStore, logRange } from '../src/services/logs.ts';
import { nowSeconds } from '../src/core/domain.ts';
import { createUser, createSession } from '../src/core/auth.ts';
import { boot, call, setupAdmin } from './support/harness.ts';

test('日志按北京时间跨日导出，过滤范围并隐藏凭据和地址参数', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'courseflow-log-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new LogStore(directory);
  const midnight = Date.parse('2026-11-08T00:00:00+08:00') / 1000;
  store.runtime('info', '范围之前', midnight - 2);
  store.runtime('info', '第一天 password="synthetic-private-password"', midnight - 1);
  store.runtime('warn', '第二天 https://synthetic-user:synthetic-pass@example.test/player?ticket=synthetic-ticket#token', midnight);
  store.runtime('error', 'Authorization: Bearer synthetic-auth-token', midnight + 1);
  store.runtime('info', 'Cookie: session=synthetic-cookie; secret=synthetic-secret', midnight + 2);
  store.runtime('info', '范围之后', midnight + 3);
  const exported = await store.export('app', midnight - 1, midnight + 2);
  assert.match(exported, /2026-11-07 23:59:59 \+08:00/); assert.match(exported, /2026-11-08 00:00:00 \+08:00/);
  assert.match(exported, /https:\/\/example.test\/player/);
  assert.doesNotMatch(exported, /synthetic-|范围之前|范围之后/);
  const files = fs.readdirSync(path.join(directory, 'logs'));
  assert.equal(files.length, 2);
  for (const file of files) assert.equal(fs.statSync(path.join(directory, 'logs', file)).mode & 0o777, 0o600);
  assert.match(await store.export('audit', midnight, midnight + 1), /没有日志/);
  for (const range of [[NaN, midnight], [0, midnight], [midnight, midnight], [midnight, midnight + 93 * 86400]]) assert.throws(() => logRange(...range as [number, number]), /92 天/);
});

test('日志下载区分管理员与个人任务，完整导出超过一百条事件且不记录请求体', async (t) => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  const admin = await setupAdmin(runtime);
  const owner = (await call(runtime, { url: '/api/me', session: admin })).body.user.id;
  const member = await createUser(runtime.db, 'log-member', 'synthetic-log-passphrase', 'user', nowSeconds());
  const user = createSession(runtime.db, member.id, nowSeconds());
  const now = nowSeconds();
  runtime.logs.runtime('info', '合成运行日志');
  runtime.logs.audit(owner, '合成操作记录');
  for (const [id, actor] of [['log-admin-task', owner], ['log-member-task', member.id]]) {
    runtime.db.run("INSERT INTO tasks(id,owner,platform,operation,state,course_id,recruit_id,created_at,updated_at) VALUES(?1,?2,'zhs','meeting','paused','synthetic-course','synthetic-class',?3,?3)", id, actor, now);
  }
  for (let i = 0; i < 120; i++) runtime.db.run("INSERT INTO task_events(task_id,kind,detail,created_at) VALUES('log-admin-task','diagnostic',?1,?2)", `合成诊断 ${i}`, now);
  runtime.db.run("INSERT INTO task_events(task_id,kind,detail,created_at) VALUES('log-member-task','diagnostic','成员自己的记录',?1)", now);
  const query = `from=${now - 60}&to=${now + 60}`;
  const download = (url: string, session = admin) => runtime.app.inject({ url, headers: { cookie: `cf_session=${session.token}` } });
  assert.equal((await runtime.app.inject({ url: '/api/logs/export?kind=app&' + query })).statusCode, 401);
  assert.equal((await download('/api/logs/export?kind=app&' + query, user)).statusCode, 403);
  assert.equal((await download('/api/logs/export?kind=audit&' + query, user)).statusCode, 403);
  assert.equal((await download('/api/logs/export?kind=other&' + query)).statusCode, 400);
  assert.equal((await download('/api/logs/export?kind=app&from=bad&to=1')).statusCode, 400);
  const app = await download('/api/logs/export?kind=app&' + query);
  assert.equal(app.statusCode, 200); assert.match(app.body, /合成运行日志/);
  assert.match(String(app.headers['content-disposition']), /attachment; filename="courseflow-app-/);
  assert.equal(app.headers['cache-control'], 'no-store');
  const boundary = Date.parse('2026-11-08T00:00:00+08:00') / 1000;
  const crossDay = await download(`/api/logs/export?kind=app&from=${boundary}&to=${boundary + 1}`);
  assert.match(String(crossDay.headers['content-disposition']), /courseflow-app-2026-11-08\.log/);
  await call(runtime, { method: 'POST', url: '/api/auth/login', body: { username: 'missing', password: 'synthetic-secret-request-body' } });
  const audit = await download('/api/logs/export?kind=audit&' + query);
  assert.match(audit.body, /合成操作记录/); assert.match(audit.body, /\/api\/auth\/login/); assert.match(audit.body, /401/);
  assert.doesNotMatch(audit.body, /synthetic-secret-request-body/);
  const task = await download('/api/tasks/log-admin-task/logs');
  assert.equal(task.statusCode, 200); assert.match(task.body, /合成诊断 0\n/); assert.match(task.body, /合成诊断 119/);
  assert.equal((await download('/api/tasks/log-admin-task/logs', user)).statusCode, 404);
  assert.equal((await download('/api/logs/export?kind=site_tasks&' + query, user)).statusCode, 403);
  const site = await download('/api/logs/export?kind=site_tasks&' + query);
  assert.match(site.body, /合成诊断/); assert.match(site.body, /成员自己的记录/); assert.match(site.body, /log-member/);
  const personal = await download('/api/logs/export?kind=tasks&' + query, user);
  assert.equal(personal.statusCode, 200); assert.match(personal.body, /成员自己的记录/); assert.doesNotMatch(personal.body, /合成诊断/);
});

test('任务与执行记录导出仅支持纯文本，按账号及不透明课程标识过滤', async t => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  const session = await setupAdmin(runtime), owner = (await call(runtime, { url: '/api/me', session })).body.user.id;
  const member = await createUser(runtime.db, 'plain-log-member', 'synthetic-plain-log-password', 'user', nowSeconds());
  for (const [id, user, course] of [['plain-a', owner, '课程/一'], ['plain-b', owner, '课程/二'], ['plain-other', member.id, '课程/一']]) {
    runtime.db.run("INSERT INTO tasks(id,owner,platform,operation,state,course_id,recruit_id,course_name,created_at,updated_at) VALUES(?1,?2,'zhs','study','completed',?3,'班级/甲','模拟课程',?4,?4)", id!, user!, course!, nowSeconds());
    runtime.db.run("INSERT INTO task_events(task_id,kind,detail,created_at) VALUES(?1,'info',?2,?3)", id!, `记录 ${id}`, nowSeconds());
  }
  const headers = { cookie: `cf_session=${session.token}` };
  for (const url of ['/api/tasks/plain-a/export', '/api/tasks/plain-a/logs', '/api/history/export']) {
    const response = await runtime.app.inject({ url, headers });
    assert.equal(response.statusCode, 200); assert.match(String(response.headers['content-type']), /text\/plain/);
    assert.match(String(response.headers['content-disposition']), /\.log"$/); assert.equal(response.headers['cache-control'], 'no-store');
    assert.doesNotMatch(response.body, /记录 plain-other/);
  }
  for (const format of ['json', 'csv', 'md', 'docx']) {
    for (const url of ['/api/tasks/plain-a/export', '/api/history/export']) assert.equal((await runtime.app.inject({ url: `${url}?format=${format}`, headers })).statusCode, 400);
  }
  const query = new URLSearchParams({ platform: 'zhs', course: '课程/一', recruit: '班级/甲' });
  const filtered = await runtime.app.inject({ url: '/api/history/export?' + query, headers });
  assert.match(filtered.body, /记录 plain-a/); assert.doesNotMatch(filtered.body, /记录 plain-b|记录 plain-other/);
});
