import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { createUser, hashPassword, validateCredentials, type Role } from '../../core/auth.ts';
import { badRequest, conflict, notFound } from '../../core/errors.ts';
import { nowSeconds } from '../../core/domain.ts';
import { taskPolicy, saveTaskPolicy, saveUserTaskLimit, effectiveTaskPolicy } from '../../core/task-policy.ts';
import { taskLogs } from '../../services/logs.ts';

type Target = { id: string; username: string; role: Role; disabled: number };
const states = ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'];
const active = "('queued','running','paused')";

export function registerAdminRoutes(app: FastifyInstance, c: ServerContext): void {
  const { db, jobs, access, logs } = c;
  function user(id: string): Target {
    const row = db.get<Target>('SELECT id,username,role,disabled FROM users WHERE id=?1', id);
    if (!row) throw notFound('用户不存在');
    return row;
  }
  function task(id: string) {
    const row = db.get<{ owner: string }>('SELECT owner FROM tasks WHERE id=?1', id);
    if (!row) throw notFound('任务不存在');
    return { ...jobs.get(row.owner, id), owner: row.owner, username: user(row.owner).username };
  }
  function audit(actor: string, action: string, target: string) { logs.audit(actor, action, { target }); }
  function noteTask(id: string, actor: string, action: string) {
    db.run('INSERT INTO task_events(task_id,kind,detail,created_at) VALUES(?1,\'admin\',?2,?3)', id, `管理员 ${user(actor).username}：${action}`, nowSeconds());
    if (action.startsWith('暂停')) db.run("UPDATE tasks SET detail='已由管理员暂停' WHERE id=?1", id);
    if (action.startsWith('停止')) db.run("UPDATE tasks SET detail='已由管理员停止' WHERE id=?1", id);
    audit(actor, action, id);
  }
  function pauseUser(id: string, actor: string) {
    const rows = db.all<{ id: string }>(`SELECT id FROM tasks WHERE owner=?1 AND state IN ${active}`, id);
    for (const row of rows) { jobs.pause(id, row.id); noteTask(row.id, actor, '暂停用户任务'); }
    return rows.length;
  }
  function protectAdmin(target: Target, actor: string) {
    if (target.id === actor) throw badRequest('不能停用自己或修改自己的管理员角色');
    const count = db.get<{ total: number }>("SELECT count(*) AS total FROM users WHERE role='admin' AND disabled=0")!.total;
    if (target.role === 'admin' && !target.disabled && count <= 1) throw conflict('last_admin', '必须保留至少一名启用的管理员');
  }
  app.get('/api/admin/overview', async (request, reply) => {
    access.requireIdentity(request, { admin: true }); reply.header('cache-control', 'no-store');
    return {
      users: db.get("SELECT count(*) AS total,coalesce(sum(disabled=0),0) AS enabled,coalesce(sum(role='admin' AND disabled=0),0) AS admins FROM users"),
      tasks: Object.fromEntries(states.map(state => [state, db.get<{ total: number }>('SELECT count(*) AS total FROM tasks WHERE state=?1', state)!.total])),
      modules: c.manager.list().map(row => ({ id: row.id, version: row.version, enabled: row.enabled === 1, running: row.running })),
    };
  });
  app.get('/api/admin/users', async (request, reply) => {
    access.requireIdentity(request, { admin: true }); reply.header('cache-control', 'no-store');
    const policy = taskPolicy(db);
    const users = db.all<Target & { created_at: number; active_tasks: number; running_tasks: number }>(`SELECT u.id,u.username,u.role,u.disabled,u.created_at,
      (SELECT count(*) FROM tasks t WHERE t.owner=u.id AND t.state IN ${active}) AS active_tasks,
      (SELECT count(*) FROM tasks t WHERE t.owner=u.id AND t.state='running') AS running_tasks FROM users u ORDER BY u.created_at,u.id`);
    return { users: users.map(row => ({ ...row, task_limit: policy.user_limits[row.id] ?? null, effective_concurrency: effectiveTaskPolicy(db, row.id).concurrency })), default_task_limit: policy.max_concurrency };
  });
  app.post<{ Body: { username?: unknown; password?: unknown; role?: unknown } }>('/api/admin/users', async (request, reply) => {
    const who = access.requireIdentity(request, { admin: true, write: true });
    const body = request.body ?? {};
    if (typeof body.username !== 'string' || typeof body.password !== 'string') throw badRequest('请填写用户名和密码');
    const role = body.role ?? 'user';
    if (role !== 'user' && role !== 'admin') throw badRequest('用户角色无效');
    const created = await createUser(db, body.username.trim(), body.password, role, nowSeconds());
    audit(who.user.id, '创建用户', created.id); reply.header('cache-control', 'no-store');
    return { user: created };
  });
  app.post<{ Params: { id: string }; Body: { disabled?: unknown } }>('/api/admin/users/:id/status', async (request) => {
    const who = access.requireIdentity(request, { admin: true, write: true }), target = user(request.params.id);
    if (typeof request.body?.disabled !== 'boolean') throw badRequest('用户状态必须是布尔值');
    const disabled = request.body.disabled;
    if (disabled) protectAdmin(target, who.user.id);
    db.transaction(() => {
      db.run('UPDATE users SET disabled=?1 WHERE id=?2', Number(disabled), target.id);
      if (disabled) db.run('DELETE FROM sessions WHERE user_id=?1', target.id);
    });
    const paused = disabled ? pauseUser(target.id, who.user.id) : 0;
    audit(who.user.id, disabled ? '停用用户' : '启用用户', target.id);
    return { ok: true, paused };
  });
  app.post<{ Params: { id: string }; Body: { role?: unknown } }>('/api/admin/users/:id/role', async (request) => {
    const who = access.requireIdentity(request, { admin: true, write: true }), target = user(request.params.id), role = request.body?.role;
    if (role !== 'user' && role !== 'admin') throw badRequest('用户角色无效');
    if (role !== target.role) {
      protectAdmin(target, who.user.id);
      db.run('UPDATE users SET role=?1 WHERE id=?2', role, target.id);
      audit(who.user.id, '修改用户角色', target.id);
    }
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { password?: unknown } }>('/api/admin/users/:id/password', async (request) => {
    const who = access.requireIdentity(request, { admin: true, write: true }), target = user(request.params.id), password = request.body?.password;
    if (typeof password !== 'string') throw badRequest('请填写新密码');
    validateCredentials(target.username, password);
    const hash = await hashPassword(password);
    db.transaction(() => {
      db.run('UPDATE users SET password_hash=?1 WHERE id=?2', hash, target.id);
      db.run('DELETE FROM sessions WHERE user_id=?1', target.id);
    });
    audit(who.user.id, '重置用户密码', target.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { limit?: unknown } }>('/api/admin/users/:id/limit', async (request) => {
    const who = access.requireIdentity(request, { admin: true, write: true }), target = user(request.params.id);
    saveUserTaskLimit(db, target.id, request.body?.limit);
    audit(who.user.id, '修改用户任务上限', target.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/pause-tasks', async (request) => {
    const who = access.requireIdentity(request, { admin: true, write: true }), target = user(request.params.id);
    return { paused: pauseUser(target.id, who.user.id) };
  });
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/stop-tasks', async (request) => {
    const who = access.requireIdentity(request, { admin: true, write: true }), target = user(request.params.id);
    const rows = db.all<{ id: string }>(`SELECT id FROM tasks WHERE owner=?1 AND state IN ${active}`, target.id);
    for (const row of rows) { jobs.stop(target.id, row.id); noteTask(row.id, who.user.id, '停止用户任务'); }
    return { stopped: rows.length };
  });
  app.get('/api/admin/settings', async (request, reply) => {
    access.requireIdentity(request, { admin: true }); reply.header('cache-control', 'no-store');
    const { user_limits, ...settings } = taskPolicy(db);
    return { settings };
  });
  app.post<{ Body: { max_concurrency?: unknown; parallel_study?: unknown } }>('/api/admin/settings', async (request) => {
    const who = access.requireIdentity(request, { admin: true, write: true });
    const { user_limits, ...settings } = saveTaskPolicy(db, request.body ?? {});
    audit(who.user.id, '修改站点任务策略', 'site');
    return { settings };
  });
  app.get<{ Querystring: { owner?: string; state?: string; offset?: string } }>('/api/admin/tasks', async (request, reply) => {
    access.requireIdentity(request, { admin: true }); reply.header('cache-control', 'no-store');
    const query = request.query, offset = Number(query.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw badRequest('分页位置无效');
    const params: (string | number)[] = [], conditions: string[] = [];
    if (query.owner) { params.push(user(query.owner).id); conditions.push(`owner=?${params.length}`); }
    if (query.state) {
      if (!states.includes(query.state)) throw badRequest('任务状态无效');
      params.push(query.state); conditions.push(`state=?${params.length}`);
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const total = db.get<{ total: number }>('SELECT count(*) AS total FROM tasks' + where, ...params)!.total;
    params.push(offset);
    const rows = db.all<{ id: string }>(`SELECT id FROM tasks${where} ORDER BY CASE WHEN state IN ${active} THEN 0 ELSE 1 END, created_at DESC,id LIMIT 100 OFFSET ?${params.length}`, ...params);
    return { tasks: rows.map(row => task(row.id)), total, offset, limit: 100 };
  });
  app.get<{ Params: { id: string } }>('/api/admin/tasks/:id', async (request, reply) => {
    access.requireIdentity(request, { admin: true }); reply.header('cache-control', 'no-store');
    const found = task(request.params.id);
    return { task: found, events: jobs.events(found.owner, found.id) };
  });
  app.post<{ Params: { id: string; action: string }; Body: { direction?: string } }>('/api/admin/tasks/:id/:action', async (request) => {
    const who = access.requireIdentity(request, { admin: true, write: true }), found = task(request.params.id);
    const action = request.params.action;
    const labels: Record<string, string> = { pause: '暂停任务', resume: '继续任务', stop: '停止任务', move: '调整任务顺序' };
    if (!labels[action]) throw notFound('任务操作不存在');
    const result = action === 'move' ? jobs.move(found.owner, found.id, request.body?.direction ?? '')
      : action === 'pause' ? jobs.pause(found.owner, found.id) : action === 'resume' ? jobs.resume(found.owner, found.id) : jobs.stop(found.owner, found.id);
    noteTask(found.id, who.user.id, labels[action]!);
    return { task: { ...result, owner: found.owner, username: found.username } };
  });
  app.get<{ Params: { id: string } }>('/api/admin/tasks/:id/logs', async (request, reply) => {
    const who = access.requireIdentity(request, { admin: true }), found = task(request.params.id);
    audit(who.user.id, '导出站点任务日志', found.id);
    return reply.header('cache-control', 'no-store').header('content-disposition', `attachment; filename="courseflow-task-${found.id}.log"`).type('text/plain; charset=utf-8')
      .send(taskLogs(db, 0, Math.max(nowSeconds(), found.updated_at), { owner: found.owner, task: found.id }));
  });
}
