import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { badRequest } from '../../core/errors.ts';
import { nowSeconds } from '../../core/domain.ts';
import { logRange, taskLogs, type LogKind } from '../../services/logs.ts';

export function registerLogsRoutes(app: FastifyInstance, c: ServerContext): void {
  app.get<{ Querystring: { kind?: string; from?: string; to?: string } }>('/api/logs/export', async (request, reply) => {
    const who = c.access.requireIdentity(request);
    const kind = request.query.kind as LogKind;
    if (!['app', 'audit', 'tasks'].includes(kind)) throw badRequest('请选择运行日志、操作记录或任务日志');
    if (kind !== 'tasks') c.access.requireIdentity(request, { admin: true });
    const { start, end } = logRange(request.query.from, request.query.to);
    c.logs.audit(who.user.id, '导出日志', { kind, from: start, to: end });
    const text = kind === 'tasks' ? taskLogs(c.db, start, end, { owner: who.user.id }) : await c.logs.export(kind, start, end);
    return reply.header('cache-control', 'no-store').header('content-disposition', `attachment; filename="courseflow-${kind}-${new Date((start + 28800) * 1000).toISOString().slice(0, 10)}.log"`).type('text/plain; charset=utf-8').send(text);
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id/logs', async (request, reply) => {
    const who = c.access.requireIdentity(request);
    const task = c.jobs.get(who.user.id, request.params.id);
    const text = taskLogs(c.db, 0, Math.max(nowSeconds(), task.updated_at), { owner: who.user.id, task: task.id });
    c.logs.audit(who.user.id, '导出任务日志', { task: task.id });
    return reply.header('cache-control', 'no-store').header('content-disposition', `attachment; filename="courseflow-task-${task.id}.log"`).type('text/plain; charset=utf-8').send(text);
  });
}
