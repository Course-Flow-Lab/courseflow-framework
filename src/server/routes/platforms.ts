import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { AppError, badRequest } from '../../core/errors.ts';
import { accountQuota, accountScope, createPlatformAccount, requirePlatformAccount, taskPlatformOwner } from '../../core/platform-accounts.ts';

export function registerPlatformsRoutes(app: FastifyInstance, context: ServerContext): void {
  const { manager, jobs } = context;
  const { requireIdentity, platformOwner } = context.access;
  function pauseAccountTasks(owner: string, platform: string, scope: string) {
    const tasks = context.db.all<{ id: string; owner: string; platform: string; account_id: string | null }>("SELECT id,owner,platform,account_id FROM tasks WHERE owner=?1 AND platform=?2 AND state IN ('queued','running')", owner, platform);
    for (const task of tasks) if (taskPlatformOwner(context.db, task) === scope) jobs.pause(owner, task.id);
  }
  app.get('/api/platforms', async (request) => {
    const current = requireIdentity(request);
    return { platforms: await manager.platforms(current.user.id), account_quota: accountQuota(context.db, current.user.id) };
  });

  app.post<{ Params: { pid: string }; Body: { label?: unknown } }>('/api/platforms/:pid/accounts', async request => {
    const current = requireIdentity(request, { write: true });
    await manager.describe(request.params.pid);
    const account = createPlatformAccount(context.db, current.user.id, request.params.pid, request.body?.label);
    return { account: { id: account.id, label: account.label, connected: false }, account_quota: accountQuota(context.db, current.user.id) };
  });

  app.delete<{ Params: { pid: string; account: string } }>('/api/platforms/:pid/accounts/:account', async request => {
    const current = requireIdentity(request, { write: true });
    const { pid, account: id } = request.params;
    const account = requirePlatformAccount(context.db, current.user.id, pid, id);
    const tasks = context.db.all<{ id: string }>("SELECT id FROM tasks WHERE owner=?1 AND platform=?2 AND (account_id=?3 OR (?4=1 AND account_id IS NULL)) AND state IN ('queued','running','paused')", current.user.id, pid, id, account.legacy);
    for (const task of tasks) jobs.stop(current.user.id, task.id);
    const scope = accountScope(account);
    await manager.disconnect(scope, pid);
    context.db.transaction(() => {
      if (!account.legacy) for (const table of ['module_state', 'qa_posts', 'media_assets']) context.db.run(`DELETE FROM ${table} WHERE owner=?1`, scope);
      context.db.run('DELETE FROM platform_accounts WHERE id=?1', id);
    });
    return { removed: true, account_quota: accountQuota(context.db, current.user.id) };
  });

  app.post<{ Params: { pid: string }; Body: { method?: string } }>(
    '/api/platforms/:pid/login',
    async (request) => {
      const current = requireIdentity(request, { write: true });
      const method = request.body?.method ?? 'qr';
      const challenge = await manager.loginBegin(platformOwner(request, current.user.id, request.params.pid), request.params.pid, method);
      return { challenge };
    },
  );

  app.post<{ Params: { pid: string; id: string } }>(
    '/api/platforms/:pid/login/:id/poll',
    async (request) => {
      const current = requireIdentity(request, { write: true });
      const owner = platformOwner(request, current.user.id, request.params.pid);
      const result = await manager.loginPoll(owner, request.params.pid, request.params.id);
      if (result.state === 'connected') pauseAccountTasks(current.user.id, request.params.pid, owner);
      return result;
    },
  );

  app.post<{
    Params: { pid: string; id: string };
    Body: { fields?: Record<string, string> };
  }>(
    '/api/platforms/:pid/login/:id/submit',
    async (request) => {
      const current = requireIdentity(request, { write: true });
      const fields = request.body?.fields;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        throw badRequest('请提供登录字段');
      }
      for (const [name, value] of Object.entries(fields)) {
        if (typeof value !== 'string') throw badRequest(`登录字段 ${name} 必须是字符串`);
      }
      return manager.loginSubmit(
        platformOwner(request, current.user.id, request.params.pid),
        request.params.pid,
        request.params.id,
        fields,
      );
    },
  );

  app.post<{ Params: { pid: string } }>('/api/platforms/:pid/disconnect', async (request) => {
    const current = requireIdentity(request, { write: true });
    const owner = platformOwner(request, current.user.id, request.params.pid);
    pauseAccountTasks(current.user.id, request.params.pid, owner);
    await manager.disconnect(owner, request.params.pid);
    return { connected: false };
  });

  app.get<{ Params: { pid: string } }>('/api/platforms/:pid/courses', async (request) => {
    const current = requireIdentity(request);
    const courses = await manager.courses(platformOwner(request, current.user.id, request.params.pid), request.params.pid);
    return { courses };
  });

  app.get<{ Params: { pid: string; id: string; rid: string } }>(
    '/api/platforms/:pid/courses/:id/:rid/units',
    async (request) => {
      const current = requireIdentity(request);
      const { pid, id, rid } = request.params;
      const owner = platformOwner(request, current.user.id, pid);
      const courses = await manager.courses(owner, pid);
      const course = courses.find((item) => item.id === id && item.recruit_id === rid);
      if (!course) throw new AppError(404, 'not_found', '找不到这门课程');
      const units = await manager.units(owner, pid, course);
      const descriptor = await manager.describe(pid);
      return {
        course,
        units,
        ui: manager.presentation(descriptor.platform, course),
      };
    },
  );

  app.post<{ Params: { pid: string; id: string; rid: string }; Body: { unit_ids?: string[]; operation?: string } }>(
    '/api/platforms/:pid/courses/:id/:rid/study',
    async (request) => {
      const current = requireIdentity(request, { write: true });
      const { pid, id, rid } = request.params;
      const unitIds = request.body?.unit_ids;
      if (!Array.isArray(unitIds) || unitIds.some((value) => typeof value !== 'string')) {
        throw badRequest('请提供 unit_ids');
      }
      const courses = await manager.courses(platformOwner(request, current.user.id, pid), pid);
      const course = courses.find((item) => item.id === id && item.recruit_id === rid);
      if (!course) throw new AppError(404, 'not_found', '找不到这门课程');
      return {
        task: jobs.create(current.user.id, {
          platform: pid,
          account_id: (request.query as { account_id?: string }).account_id,
          course,
          unit_ids: unitIds,
          operation: request.body?.operation ?? 'study',
        }),
      };
    },
  );
}
