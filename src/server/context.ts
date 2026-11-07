import type { Config } from '../core/config.ts';
import type { Db } from '../core/db.ts';
import type { JobEngine } from '../jobs/engine.ts';
import type { ModuleManager, Logger } from '../modules/manager.ts';
import type { createAccess } from './access.ts';

export type ServerServices = {
  config: Config;
  db: Db;
  manager: ModuleManager;
  jobs: JobEngine;
  setupCode: string;
  log: Logger;
};

export type ServerContext = ServerServices & { access: ReturnType<typeof createAccess> };
