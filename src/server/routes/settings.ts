import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { preferences, savePreferences, type Preferences } from '../../core/preferences.ts';
import type { ModelInput } from '../../services/ai.ts';
import { badRequest, forbidden } from '../../core/errors.ts';
import { legacySummary } from './legacy.ts';

export function registerSettingsRoutes(app: FastifyInstance, c: ServerContext): void {
  const { requireIdentity } = c.access;
  app.get('/api/settings', async (request) => {
    const who = requireIdentity(request);
    return { preferences: preferences(c.db, who.user.id), models: c.ai.list(who.user.id), browser: { available: c.browser.available() }, asr: c.asr.describe(), legacy: legacySummary(c, who.user.id) };
  });
  app.post<{ Body: Partial<Preferences> }>('/api/settings/preferences', async (request) => {
    const who = requireIdentity(request, { write: true });
    const body = request.body ?? {};
    if (body.model_id && !c.ai.list(who.user.id).some((m) => m.id === body.model_id && m.enabled)) throw badRequest('请选择可用的模型');
    return { preferences: savePreferences(c.db, who.user.id, body) };
  });
  app.post<{ Body: ModelInput }>('/api/settings/models', async (request) => {
    const who = requireIdentity(request, { write: true });
    if (request.body?.shared && who.user.role !== 'admin') throw forbidden('只有管理员可以添加共享模型');
    return { model: c.ai.save(who.user.id, request.body ?? {}) };
  });
  app.post<{ Params: { id: string }; Body: ModelInput }>('/api/settings/models/:id', async (request) => {
    const who = requireIdentity(request, { write: true });
    if (request.body?.shared && who.user.role !== 'admin') throw forbidden('只有管理员可以配置共享模型');
    return { model: c.ai.save(who.user.id, request.body ?? {}, request.params.id) };
  });
  app.delete<{ Params: { id: string } }>('/api/settings/models/:id', async (request) => {
    const who = requireIdentity(request, { write: true }); c.ai.remove(who.user.id, request.params.id); return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/settings/models/:id/probe', async (request) => {
    const who = requireIdentity(request, { write: true }); return c.ai.probe(who.user.id, request.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/media/:id', async (request, reply) => {
    const who = requireIdentity(request);
    const image = await c.manager.readImage(who.user.id, request.params.id);
    return reply.header('cache-control', 'private, max-age=300').header('x-content-type-options', 'nosniff').type(image.mime).send(Buffer.from(image.data, 'base64'));
  });
}
