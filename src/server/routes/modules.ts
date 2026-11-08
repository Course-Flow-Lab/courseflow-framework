import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { badRequest } from '../../core/errors.ts';

export function registerModulesRoutes(app: FastifyInstance, context: ServerContext): void {
  const { manager } = context;
  const { requireIdentity } = context.access;
  app.get('/api/modules', async (request) => {
    requireIdentity(request, { admin: true });
    return {
      builtins: [{ id: 'question-bank', name: '统一题库', interface_version: 1, running: true, description: '框架内置，按用户和课程加密隔离；平台确认正确后自动入库。' }],
      modules: manager.list().map((row) => ({
        id: row.id,
        name: row.manifestJson.name,
        version: row.version,
        engine: row.engine,
        sha256: row.sha256,
        enabled: row.enabled === 1,
        running: row.running,
        settings: JSON.parse(row.settings) as Record<string, unknown>,
        permissions: row.manifestJson.permissions,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/modules/:id/enable', async (request) => {
    requireIdentity(request, { write: true, admin: true });
    manager.setEnabled(request.params.id, true);
    void manager.warmUp(request.params.id);
    return { enabled: true };
  });

  app.post<{ Params: { id: string } }>('/api/modules/:id/disable', async (request) => {
    requireIdentity(request, { write: true, admin: true });
    manager.setEnabled(request.params.id, false);
    return { enabled: false };
  });

  app.post<{ Params: { id: string }; Body: { settings?: Record<string, unknown> } }>(
    '/api/modules/:id/config',
    async (request) => {
      requireIdentity(request, { write: true, admin: true });
      const settings = request.body?.settings;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw badRequest('请提供 settings 对象');
      manager.configure(request.params.id, settings);
      void manager.warmUp(request.params.id);
      return { settings };
    },
  );

  app.post<{ Body: { path?: string } }>('/api/modules/install', async (request) => {
    requireIdentity(request, { write: true, admin: true });
    const source = request.body?.path;
    if (!source) throw badRequest('请提供模块路径');
    const row = manager.install(source);
    return { module: { id: row.id, version: row.version, sha256: row.sha256 } };
  });
}
