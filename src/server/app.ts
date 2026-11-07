import Fastify, { type FastifyInstance } from 'fastify';
import { AppError, badRequest } from '../core/errors.ts';
import { createAccess } from './access.ts';
import type { ServerContext, ServerServices } from './context.ts';
import { registerWebRoutes } from './web.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerPlatformsRoutes } from './routes/platforms.ts';
import { registerTasksRoutes } from './routes/tasks.ts';
import { registerModulesRoutes } from './routes/modules.ts';

export function createApp(services: ServerServices): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: false });
  const context: ServerContext = { ...services, access: createAccess(services.db, services.config) };

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    try {
      done(null, text === '' ? {} : JSON.parse(text));
    } catch {
      done(badRequest('请求体不是合法 JSON'), undefined);
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    const failure = error as { statusCode?: number; message?: string };
    const status = failure.statusCode ?? 500;
    const message = failure.message ?? '服务内部错误';
    if (status >= 500) services.log('error', `${request.method} ${request.url} 失败：${message}`);
    return reply.status(status >= 400 && status < 600 ? status : 500)
      .send({ error: { code: 'internal_error', message } });
  });
  registerWebRoutes(app);
  registerSystemRoutes(app, context);
  registerAuthRoutes(app, context);
  registerPlatformsRoutes(app, context);
  registerTasksRoutes(app, context);
  registerModulesRoutes(app, context);
  return app;
}
