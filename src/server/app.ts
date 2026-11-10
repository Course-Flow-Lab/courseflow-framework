import Fastify, { type FastifyInstance } from 'fastify';
import { AppError, badRequest } from '../core/errors.ts';
import { createAccess, readCookie } from './access.ts';
import { identity } from '../core/auth.ts';
import { nowSeconds } from '../core/domain.ts';
import type { ServerContext, ServerServices } from './context.ts';
import type { Runtime } from '../runtime.ts';
import type { HttpConfig } from '../core/config.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerPlatformsRoutes } from './routes/platforms.ts';
import { registerTasksRoutes } from './routes/tasks.ts';
import { registerModulesRoutes } from './routes/modules.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerFeaturesRoutes } from './routes/features.ts';
import { registerLogsRoutes } from './routes/logs.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerRegistrationRoutes } from './routes/registration.ts';
import { registerLegacyRoutes } from './routes/legacy.ts';

export type HttpServerOptions = HttpConfig & { setupCode: string };

/** 只装配 HTTP API；调用方负责监听，并在关闭 HTTP 后关闭运行时。 */
export function createHttpServer(runtime: Runtime, options: HttpServerOptions): FastifyInstance {
  const services: ServerServices = {
    ...runtime,
    config: { ...runtime.config, bind: options.bind, publicUrl: options.publicUrl },
    setupCode: options.setupCode,
  };
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: false });
  const context: ServerContext = { ...services, access: createAccess(services.db, services.config) };
  const actors = new WeakMap<object, string | null>();
  app.addHook('onRequest', async (request) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || !request.url.startsWith('/api/')) return;
    const token = readCookie(request, 'cf_session');
    actors.set(request, token ? identity(services.db, token, nowSeconds())?.user.id ?? null : null);
  });
  app.addHook('onResponse', async (request, reply) => {
    if (!actors.has(request)) return;
    services.logs.audit(actors.get(request) ?? null, '接口操作', { method: request.method, route: request.routeOptions.url ?? request.url.split('?')[0]!, status: reply.statusCode });
  });

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
    if (status >= 500) services.log('error', `${request.method} ${request.routeOptions.url ?? request.url.split('?')[0]} 失败：${message}`);
    return reply.status(status >= 400 && status < 600 ? status : 500)
      .send({ error: { code: 'internal_error', message } });
  });
  registerSystemRoutes(app, context);
  registerAuthRoutes(app, context);
  registerRegistrationRoutes(app, context);
  registerAdminRoutes(app, context);
  registerLegacyRoutes(app, context);
  registerPlatformsRoutes(app, context);
  registerTasksRoutes(app, context);
  registerModulesRoutes(app, context);
  registerSettingsRoutes(app, context);
  registerFeaturesRoutes(app, context);
  registerLogsRoutes(app, context);
  return app;
}
