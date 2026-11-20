import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { notFound } from '../../core/errors.ts';

export function registerTasksRoutes(app: FastifyInstance, context: ServerContext): void {
  const { jobs, browser, logs } = context;
  const { requireIdentity } = context.access;
  /** The module keeps the captcha page open only while it waits for manual input. */
  const withCaptcha = (task: ReturnType<typeof jobs.get>, owner: string) => ({
    ...task,
    manual_captcha: task.detail.includes('等待人工完成验证码') && browser.hasCaptcha(owner, task.id),
  });
  app.get('/api/tasks', async (request) => {
    const current = requireIdentity(request);
    return { tasks: jobs.list(current.user.id).map((task) => withCaptcha(task, current.user.id)) };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request) => {
    const current = requireIdentity(request);
    return {
      task: withCaptcha(jobs.get(current.user.id, request.params.id), current.user.id),
      events: jobs.events(current.user.id, request.params.id),
      ...jobs.details(current.user.id, request.params.id),
    };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id/captcha', async (request) => {
    const current = requireIdentity(request);
    const task = jobs.get(current.user.id, request.params.id);
    const view = await browser.captchaView(current.user.id, task.id);
    if (view.state === 'unavailable') throw notFound('当前没有等待人工处理的验证码');
    return view;
  });

  app.post<{ Params: { id: string }; Body: { type?: string; x?: number; y?: number; from?: { x?: number; y?: number }; to?: { x?: number; y?: number }; steps?: number } }>('/api/tasks/:id/captcha', async (request) => {
    const current = requireIdentity(request, { write: true });
    const task = jobs.get(current.user.id, request.params.id);
    const body = request.body ?? {};
    await browser.captchaMouse(current.user.id, task.id, body as Record<string, unknown>);
    logs.audit(current.user.id, '人工验证码操作', { task: task.id, action: String(body.type ?? 'unknown') });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { answers?: Record<string, string[]>; text?: string; replace_existing?: boolean } }>('/api/tasks/:id/answers', async (request) => {
    const who = requireIdentity(request, { write: true }); return { task: jobs.answers(who.user.id, request.params.id, request.body ?? {}) };
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/confirm', async (request) => {
    const who = requireIdentity(request, { write: true }); return { task: jobs.confirm(who.user.id, request.params.id) };
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/readback', async (request) => {
    const who = requireIdentity(request, { write: true }); return { task: await jobs.reconcile(who.user.id, request.params.id) };
  });
  app.post<{ Params: { id: string }; Body: { direction?: string } }>('/api/tasks/:id/move', async (request) => {
    const who = requireIdentity(request, { write: true }); return { task: jobs.move(who.user.id, request.params.id, request.body?.direction ?? '') };
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/pause', async (request) => {
    const current = requireIdentity(request, { write: true });
    return { task: jobs.pause(current.user.id, request.params.id) };
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/stop', async (request) => {
    const current = requireIdentity(request, { write: true });
    return { task: jobs.stop(current.user.id, request.params.id) };
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/resume', async (request) => {
    const current = requireIdentity(request, { write: true });
    return { task: jobs.resume(current.user.id, request.params.id) };
  });

  app.post<{ Params: { id: string }; Body: { to_version?: string } }>('/api/tasks/:id/migrate', async (request) => {
    const current = requireIdentity(request, { write: true });
    return { task: jobs.migrate(current.user.id, request.params.id, request.body?.to_version) };
  });
}
