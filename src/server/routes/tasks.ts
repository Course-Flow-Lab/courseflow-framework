import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';

export function registerTasksRoutes(app: FastifyInstance, context: ServerContext): void {
  const { jobs } = context;
  const { requireIdentity } = context.access;
  app.get('/api/tasks', async (request) => {
    const current = requireIdentity(request);
    return { tasks: jobs.list(current.user.id) };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request) => {
    const current = requireIdentity(request);
    return {
      task: jobs.get(current.user.id, request.params.id),
      events: jobs.events(current.user.id, request.params.id),
    };
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
}
