import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { hasUsers } from '../../core/auth.ts';
import { nowSeconds, quietStatus } from '../../core/domain.ts';
import { MODULE_API } from '../../modules/protocol.ts';
import { FRAMEWORK_VERSION as VERSION } from '../../version.ts';

export function registerSystemRoutes(app: FastifyInstance, { db, manager }: ServerContext): void {
  app.get('/healthz', async () => ({
    status: 'ok',
    name: 'courseflow-framework',
    version: VERSION,
    module_api: MODULE_API,
    modules: manager.list().map((row) => ({
      id: row.id,
      version: row.version,
      enabled: row.enabled === 1,
      running: row.running,
    })),
  }));

  app.get('/api/bootstrap', async () => ({
    name: 'Courseflow',
    version: VERSION,
    module_api: MODULE_API,
    setup_required: !hasUsers(db),
    quiet_hours: quietStatus(nowSeconds()),
    capabilities: { modules: true, platforms: true, jobs: ['study', 'trial', 'review', 'answer', 'mastery', 'meeting', 'qa', 'ask'], task_controls: ['pause', 'resume', 'stop', 'move', 'answers', 'confirm', 'readback'], models: true, exports: ['md', 'docx', 'json', 'csv'], sse: false },
  }));

}
