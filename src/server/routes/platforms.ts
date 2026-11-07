import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { AppError, badRequest } from '../../core/errors.ts';

export function registerPlatformsRoutes(app: FastifyInstance, context: ServerContext): void {
  const { manager, jobs } = context;
  const { requireIdentity } = context.access;
  app.get('/api/platforms', async (request) => {
    const current = requireIdentity(request);
    return { platforms: await manager.platforms(current.user.id) };
  });

  app.post<{ Params: { pid: string }; Body: { method?: string } }>(
    '/api/platforms/:pid/login',
    async (request) => {
      const current = requireIdentity(request, { write: true });
      const method = request.body?.method ?? 'qr';
      const challenge = await manager.loginBegin(current.user.id, request.params.pid, method);
      return { challenge };
    },
  );

  app.post<{ Params: { pid: string; id: string } }>(
    '/api/platforms/:pid/login/:id/poll',
    async (request) => {
      const current = requireIdentity(request, { write: true });
      const result = await manager.loginPoll(current.user.id, request.params.pid, request.params.id);
      if (result.state === 'connected') for (const task of jobs.list(current.user.id)) if (task.platform === request.params.pid && ['queued', 'running'].includes(task.state)) jobs.pause(current.user.id, task.id);
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
        current.user.id,
        request.params.pid,
        request.params.id,
        fields,
      );
    },
  );

  app.post<{ Params: { pid: string } }>('/api/platforms/:pid/disconnect', async (request) => {
    const current = requireIdentity(request, { write: true });
    for (const task of jobs.list(current.user.id)) if (task.platform === request.params.pid && ['queued', 'running'].includes(task.state)) jobs.pause(current.user.id, task.id);
    await manager.disconnect(current.user.id, request.params.pid);
    return { connected: false };
  });

  app.get<{ Params: { pid: string } }>('/api/platforms/:pid/courses', async (request) => {
    const current = requireIdentity(request);
    const courses = await manager.courses(current.user.id, request.params.pid);
    return { courses };
  });

  app.get<{ Params: { pid: string; id: string; rid: string } }>(
    '/api/platforms/:pid/courses/:id/:rid/units',
    async (request) => {
      const current = requireIdentity(request);
      const { pid, id, rid } = request.params;
      const courses = await manager.courses(current.user.id, pid);
      const course = courses.find((item) => item.id === id && item.recruit_id === rid);
      if (!course) throw new AppError(404, 'not_found', '找不到这门课程');
      const units = await manager.units(current.user.id, pid, course);
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
      const courses = await manager.courses(current.user.id, pid);
      const course = courses.find((item) => item.id === id && item.recruit_id === rid);
      if (!course) throw new AppError(404, 'not_found', '找不到这门课程');
      return {
        task: jobs.create(current.user.id, {
          platform: pid,
          course,
          unit_ids: unitIds,
          operation: request.body?.operation ?? 'study',
        }),
      };
    },
  );
}
