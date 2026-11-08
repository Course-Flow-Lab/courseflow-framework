import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { studiaArchive } from '../../core/studia-import.ts';
import { notFound } from '../../core/errors.ts';

type Manifest = { files: Array<{ name: string; size: number }>; imported_at: number };
export function legacySummary(context: ServerContext, owner: string) {
  const manifest = studiaArchive(context.db, context.vault, owner) as Manifest | null;
  return manifest ? { imported_at: manifest.imported_at, total: manifest.files.length, files: manifest.files.slice(0,100) } : null;
}
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/(password|api.?key|cookie|access.?token|authorization|csrf|secret)/i.test(key)).map(([key,value]) => [key,redact(value)]));
  return value;
}
export function registerLegacyRoutes(app: FastifyInstance, context: ServerContext): void {
  app.get('/api/legacy/studia', async (request) => {
    const who = context.access.requireIdentity(request);
    return { legacy: legacySummary(context, who.user.id) };
  });
  app.get<{ Querystring: { name?: string } }>('/api/legacy/studia/archive', async (request, reply) => {
    const who = context.access.requireIdentity(request);
    const manifest = studiaArchive(context.db, context.vault, who.user.id) as Manifest | null;
    const name = request.query.name;
    if (!name || !manifest?.files.some((file) => file.name === name)) throw notFound('找不到自己的迁移档案');
    let bytes = studiaArchive(context.db, context.vault, who.user.id, name) as Buffer | null;
    if (!bytes) throw notFound('找不到自己的迁移档案');
    if (name.endsWith('.json')) bytes = Buffer.from(JSON.stringify(redact(JSON.parse(bytes.toString('utf8'))), null, 2));
    const filename = name.split('/').pop()!.replace(/[^A-Za-z0-9_.-]/g, '_') || 'archive.bin';
    return reply.header('cache-control','no-store').header('x-content-type-options','nosniff').header('content-disposition',`attachment; filename="studia-${filename}"`).type('application/octet-stream').send(bytes);
  });
}
