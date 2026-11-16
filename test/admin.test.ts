import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createUser, createSession, verifyPassword } from '../src/core/auth.ts';
import { nowSeconds } from '../src/core/domain.ts';
import { savePreferences } from '../src/core/preferences.ts';
import { effectiveTaskPolicy } from '../src/core/task-policy.ts';
import { boot, call, setupAdmin } from './support/harness.ts';

test('全站任务默认按最近更新排序，并支持稳定的创建时间和状态排序', async t => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  const admin = await setupAdmin(runtime);
  const owner = (await call(runtime, { url: '/api/me', session: admin })).body.user.id;
  for (const [id, state, created, updated] of [['old-running', 'running', 1, 10], ['new-completed', 'completed', 40, 20], ['recent-paused', 'paused', 20, 90], ['equal-a', 'completed', 30, 30], ['equal-b', 'completed', 30, 30]] as const) {
    runtime.db.run("INSERT INTO tasks(id,owner,platform,operation,state,course_id,recruit_id,created_at,updated_at) VALUES(?1,?2,'sim','study',?3,'course','class',?4,?5)", id, owner, state, created, updated);
  }
  const read = async (sort?: string) => (await call(runtime, { url: '/api/admin/tasks' + (sort ? '?sort=' + sort : ''), session: admin })).body;
  const current = await read(); assert.equal(current.sort, 'updated');
  assert.deepEqual(current.tasks.map((task: any) => task.id), ['recent-paused', 'equal-a', 'equal-b', 'new-completed', 'old-running']);
  assert.deepEqual((await read('created')).tasks.map((task: any) => task.id), ['new-completed', 'equal-a', 'equal-b', 'recent-paused', 'old-running']);
  assert.deepEqual((await read('oldest')).tasks.map((task: any) => task.id), ['old-running', 'recent-paused', 'equal-a', 'equal-b', 'new-completed']);
  assert.deepEqual((await read('state')).tasks.map((task: any) => task.id), ['old-running', 'recent-paused', 'equal-a', 'equal-b', 'new-completed']);
  assert.equal((await call(runtime, { url: '/api/admin/tasks?sort=invalid', session: admin })).status, 400);
});

test('管理员删除任务及其本站记录，保留独立写入凭证并隔离成员权限', async t => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  const admin = await setupAdmin(runtime);
  const member = await createUser(runtime.db, 'delete-member', 'synthetic-delete-member-password', 'user', nowSeconds());
  const session = createSession(runtime.db, member.id, nowSeconds());
  const id = 'delete/任务';
  for (const target of [id, 'keep-task']) runtime.db.run("INSERT INTO tasks(id,owner,platform,operation,state,course_id,recruit_id,created_at,updated_at) VALUES(?1,?2,'sim','answer','completed','course','class',?3,?3)", target, member.id, nowSeconds());
  runtime.db.run('INSERT INTO task_events(task_id,kind,detail,created_at) VALUES(?1,\'info\',\'合成记录\',?2)', id, nowSeconds());
  runtime.db.run('INSERT INTO task_inputs VALUES(?1,?2)', id, new Uint8Array(runtime.vault.sealJson(member.id, 'synthetic-input', {})));
  runtime.db.run('INSERT INTO task_order VALUES(?1,1)', id);
  runtime.db.run("INSERT INTO operation_locks VALUES('confirmed-delete',?1,'sim',?2,'confirmed',?3,'synthetic-resource')", member.id, id, nowSeconds());
  runtime.db.run("INSERT INTO write_ledger VALUES('write-delete','sim',?1,'submit','POST','https://synthetic.invalid/submit','acknowledged',?2)", member.id, nowSeconds());
  const url = '/api/admin/tasks/' + encodeURIComponent(id);
  assert.equal((await call(runtime, { method: 'DELETE', url })).status, 401);
  assert.equal((await call(runtime, { method: 'DELETE', url, session })).status, 403);
  assert.equal((await runtime.app.inject({ method: 'DELETE', url, headers: { cookie: `cf_session=${admin.token}` } })).statusCode, 403);
  assert.equal((await runtime.app.inject({ method: 'DELETE', url, headers: { cookie: `cf_session=${admin.token}`, 'x-courseflow-csrf': admin.csrf, origin: 'https://other.invalid' } })).statusCode, 403);
  assert.deepEqual((await call(runtime, { method: 'DELETE', url, session: admin })).body, { deleted: true, id });
  for (const [table, column] of [['tasks', 'id'], ['task_events', 'task_id'], ['task_inputs', 'task_id'], ['task_order', 'task_id']]) assert.equal(runtime.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?1`, id)!.n, 0);
  assert.ok(runtime.db.get('SELECT 1 FROM tasks WHERE id=\'keep-task\''));
  assert.ok(runtime.db.get('SELECT 1 FROM operation_locks WHERE id=\'confirmed-delete\''));
  assert.ok(runtime.db.get('SELECT 1 FROM write_ledger WHERE id=\'write-delete\''));
  assert.equal((await call(runtime, { url, session: admin })).status, 404);
  assert.match(await runtime.logs.export('audit', nowSeconds() - 60, nowSeconds() + 60), /删除站点任务/);
});

test('删除不越过正在执行的请求或未核对交卷，排队任务可直接移除', async t => {
  const { runtime } = await boot();
  const gate = Promise.withResolvers<any>(), entered = Promise.withResolvers<void>();
  t.after(async () => { gate.resolve({ status: 'completed' }); await runtime.close(); });
  const admin = await setupAdmin(runtime);
  const owner = (await call(runtime, { url: '/api/me', session: admin })).body.user.id;
  runtime.manager.install(fileURLToPath(new URL('../modules/simulator', import.meta.url)));
  const login = await call(runtime, { method: 'POST', url: '/api/platforms/sim/login', session: admin });
  await call(runtime, { method: 'POST', url: `/api/platforms/sim/login/${login.body.challenge.id}/poll`, session: admin });
  const course = (await runtime.manager.courses(owner, 'sim'))[0]!;
  runtime.manager.studyStep = async () => { entered.resolve(); return gate.promise; };
  const running = runtime.jobs.create(owner, { platform: 'sim', course, unit_ids: ['1001-u1'], operation: 'study' });
  await entered.promise;
  const remove = (id: string) => call(runtime, { method: 'DELETE', url: '/api/admin/tasks/' + encodeURIComponent(id), session: admin });
  assert.equal((await remove(running.id)).status, 409);
  const queued = runtime.jobs.create(owner, { platform: 'sim', course, unit_ids: ['1001-u2'], operation: 'study' });
  assert.equal((await remove(queued.id)).status, 200);
  runtime.jobs.stop(owner, running.id);
  assert.equal((await remove(running.id)).body.error.code, 'task_stopping');
  gate.resolve({ status: 'completed' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await remove(running.id)).status, 200);
  runtime.db.run("INSERT INTO tasks(id,owner,platform,operation,state,course_id,recruit_id,created_at,updated_at) VALUES('unknown-delete',?1,'sim','answer','paused','course','class',?2,?2)", owner, nowSeconds());
  runtime.db.run("INSERT INTO operation_locks VALUES('unknown-delete',?1,'sim','unknown-delete','unknown',?2,'unknown-resource')", owner, nowSeconds());
  assert.equal((await remove('unknown-delete')).body.error.code, 'submission_unknown');
  assert.ok(runtime.db.get("SELECT 1 FROM tasks WHERE id='unknown-delete'"));
});

test('管理接口隔离成员权限、CSRF、用户密码和管理员身份', async t => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  const admin = await setupAdmin(runtime);
  const me = (await call(runtime, { url: '/api/me', session: admin })).body.user;
  const created = await call(runtime, { method: 'POST', url: '/api/admin/users', session: admin, body: { username: 'member', password: 'synthetic-member-password' } });
  assert.equal(created.status, 200);
  const member = created.body.user, session = createSession(runtime.db, member.id, nowSeconds());
  for (const url of ['/api/admin/users', '/api/admin/overview', '/api/admin/tasks', '/api/admin/settings', '/api/admin/tasks/missing']) {
    assert.equal((await call(runtime, { url })).status, 401);
    assert.equal((await call(runtime, { url, session })).status, 403);
  }
  for (const url of ['/api/admin/users', '/api/admin/settings', `/api/admin/users/${member.id}/status`, `/api/admin/users/${member.id}/password`, '/api/admin/tasks/missing/stop']) {
    assert.equal((await call(runtime, { url, method: 'POST', session, body: {} })).status, 403);
    assert.equal((await runtime.app.inject({ method: 'POST', url, headers: { cookie: `cf_session=${admin.token}` }, payload: {} })).statusCode, 403);
  }
  const users = (await call(runtime, { url: '/api/admin/users', session: admin })).body;
  assert.equal(users.users.length, 2);
  assert.doesNotMatch(JSON.stringify(users), /password_hash|synthetic-member-password|csrf/);
  const selfDisable = await call(runtime, { method: 'POST', url: `/api/admin/users/${me.id}/status`, session: admin, body: { disabled: true } });
  assert.equal(selfDisable.status, 400);
  assert.equal((await call(runtime, { method: 'POST', url: `/api/admin/users/${me.id}/role`, session: admin, body: { role: 'user' } })).status, 400);
  assert.equal((await call(runtime, { method: 'POST', url: `/api/admin/users/${member.id}/role`, session: admin, body: { role: 'admin' } })).status, 200);
  assert.equal((await call(runtime, { url: '/api/admin/settings', session })).status, 200);
  assert.equal((await call(runtime, { method: 'POST', url: `/api/admin/users/${member.id}/role`, session: admin, body: { role: 'user' } })).status, 200);
  assert.equal((await call(runtime, { url: '/api/admin/settings', session })).status, 403);
  assert.equal((await call(runtime, { method: 'POST', url: `/api/admin/users/${member.id}/password`, session: admin, body: { password: 'short' } })).status, 400);
  assert.equal((await call(runtime, { method: 'POST', url: `/api/admin/users/${member.id}/password`, session: admin, body: { password: 'synthetic-reset-password' } })).status, 200);
  assert.equal((await call(runtime, { url: '/api/me', session })).status, 401);
  const hash = runtime.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?1', member.id)!.password_hash;
  assert.equal(await verifyPassword('synthetic-reset-password', hash), true);
  assert.equal(await verifyPassword('synthetic-member-password', hash), false);
  assert.equal((await call(runtime, { method: 'POST', url: '/api/auth/login', body: { username: 'member', password: 'synthetic-reset-password' } })).status, 200);
  const audit = await runtime.logs.export('audit', nowSeconds() - 60, nowSeconds() + 60);
  assert.match(audit, /重置用户密码|创建用户/);
  assert.doesNotMatch(audit, /synthetic-reset-password|synthetic-member-password/);
});

test('全站任务分页、跨用户控制和日志下载保持普通用户的所有权边界', async t => {
  const { runtime } = await boot(); t.after(() => runtime.close());
  const admin = await setupAdmin(runtime);
  const member = await createUser(runtime.db, 'task-member', 'synthetic-task-member-password', 'user', nowSeconds());
  const session = createSession(runtime.db, member.id, nowSeconds());
  for (let i = 0; i < 105; i++) runtime.db.run("INSERT INTO tasks(id,owner,platform,operation,state,course_id,recruit_id,course_name,created_at,updated_at) VALUES(?1,?2,'sim','study','completed','模拟/课程','班级','模拟课程',?3,?3)", `task-${i}`, member.id, nowSeconds());
  runtime.db.run("UPDATE tasks SET state='queued' WHERE id IN ('task-0','task-1')");
  runtime.db.run("INSERT INTO task_events(task_id,kind,detail,created_at) VALUES('task-0','info','成员任务记录',?1)", nowSeconds());
  const result = await call(runtime, { url: '/api/admin/tasks?state=completed', session: admin });
  assert.equal(result.body.total, 103); assert.equal(result.body.tasks.length, 100);
  assert.equal(result.body.tasks[0].username, 'task-member');
  assert.equal((await call(runtime, { url: '/api/admin/tasks?state=completed&offset=100', session: admin })).body.tasks.length, 3);
  assert.equal((await call(runtime, { url: '/api/admin/tasks?state=oops', session: admin })).status, 400);
  assert.equal((await call(runtime, { url: '/api/admin/tasks?offset=-1', session: admin })).status, 400);
  assert.equal((await call(runtime, { url: '/api/tasks/task-0', session: admin })).status, 404);
  assert.equal((await call(runtime, { url: '/api/admin/tasks/task-0', session })).status, 403);
  assert.equal((await call(runtime, { method: 'POST', url: '/api/admin/tasks/task-0/move', session: admin, body: { direction: 'down' } })).status, 200);
  assert.equal((await call(runtime, { method: 'POST', url: '/api/admin/tasks/task-0/pause', session: admin })).body.task.state, 'paused');
  const detail = (await call(runtime, { url: '/api/admin/tasks/task-0', session: admin })).body;
  assert.ok(detail.events.some((event: any) => event.kind === 'admin'));
  assert.equal(detail.workflow, undefined);
  const download = await runtime.app.inject({ url: '/api/admin/tasks/task-0/logs', headers: { cookie: `cf_session=${admin.token}` } });
  assert.equal(download.statusCode, 200); assert.match(String(download.headers['content-type']), /text\/plain/); assert.match(download.body, /成员任务记录/);
  assert.equal((await call(runtime, { method: 'POST', url: `/api/admin/users/${member.id}/status`, session: admin, body: { disabled: true } })).status, 200);
  assert.equal(runtime.jobs.get(member.id, 'task-1').state, 'paused');
  assert.equal((await call(runtime, { url: '/api/me', session })).status, 401);
  assert.equal((await call(runtime, { method: 'POST', url: '/api/admin/tasks/task-1/resume', session: admin })).status, 409);
  assert.equal((await call(runtime, { method: 'POST', url: `/api/admin/users/${member.id}/status`, session: admin, body: { disabled: false } })).status, 200);
  assert.equal(runtime.jobs.get(member.id, 'task-1').state, 'paused', '启用用户不自动重放任务');
  assert.equal((await call(runtime, { method: 'POST', url: `/api/admin/users/${member.id}/stop-tasks`, session: admin })).body.stopped, 2);
  assert.equal(runtime.jobs.get(member.id, 'task-0').state, 'cancelled');
});

test('站点与用户并发限制实际控制模拟任务调度', async t => {
  const { runtime } = await boot();
  const admin = await setupAdmin(runtime), owner = (await call(runtime, { url: '/api/me', session: admin })).body.user.id;
  runtime.manager.install(fileURLToPath(new URL('../modules/simulator', import.meta.url)));
  const login = await call(runtime, { method: 'POST', url: '/api/platforms/sim/login', session: admin });
  await call(runtime, { method: 'POST', url: `/api/platforms/sim/login/${login.body.challenge.id}/poll`, session: admin });
  savePreferences(runtime.db, owner, { concurrency: 3, parallel_study: true });
  const gate = Promise.withResolvers<Record<string, unknown>>();
  t.after(async () => { gate.resolve({ status: 'completed' }); await runtime.close(); });
  runtime.manager.studyStep = async () => gate.promise;
  assert.equal((await call(runtime, { method: 'POST', url: '/api/admin/settings', session: admin, body: { max_concurrency: 0 } })).status, 400);
  await call(runtime, { method: 'POST', url: '/api/admin/settings', session: admin, body: { max_concurrency: 1, parallel_study: false } });
  assert.deepEqual(effectiveTaskPolicy(runtime.db, owner), { concurrency: 1, parallel_study: false });
  const visible = (await call(runtime, { url: '/api/settings', session: admin })).body.task_policy;
  assert.deepEqual(visible, { limit: 1, parallel_study: false, effective_concurrency: 1 });
  const courses = await runtime.manager.courses(owner, 'sim');
  const units = await runtime.manager.units(owner, 'sim', courses[0]!);
  runtime.manager.units = async () => units;
  const first = runtime.jobs.create(owner, { platform: 'sim', course: courses[0]!, unit_ids: ['1001-u1'], operation: 'study' });
  const second = runtime.jobs.create(owner, { platform: 'sim', course: courses[1]!, unit_ids: ['1001-u1'], operation: 'study' });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(runtime.jobs.get(owner, first.id).state, 'running');
  assert.equal(runtime.jobs.get(owner, second.id).state, 'queued');
  await call(runtime, { method: 'POST', url: `/api/admin/users/${owner}/limit`, session: admin, body: { limit: 2 } });
  await call(runtime, { method: 'POST', url: '/api/admin/settings', session: admin, body: { parallel_study: true } });
  const deadline = Date.now() + 3000;
  while (runtime.jobs.get(owner, second.id).state !== 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(runtime.jobs.get(owner, second.id).state, 'running');
  await call(runtime, { method: 'POST', url: `/api/admin/users/${owner}/limit`, session: admin, body: { limit: null } });
  assert.equal(effectiveTaskPolicy(runtime.db, owner).concurrency, 1);
});
