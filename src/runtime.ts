import type { FastifyInstance } from 'fastify';
import type { Config } from './core/config.ts';
import { Db } from './core/db.ts';
import { Vault } from './core/vault.ts';
import { Sessions } from './core/sessions.ts';
import { randomToken, setQuietOverride } from './core/domain.ts';
import { ModuleManager } from './modules/manager.ts';
import { JobEngine } from './jobs/engine.ts';
import { createApp } from './server/app.ts';
import { FRAMEWORK_VERSION } from './version.ts';

export const VERSION = FRAMEWORK_VERSION;
export { FRAMEWORK_VERSION };

export type Runtime = {
  config: Config;
  db: Db;
  vault: Vault;
  sessions: Sessions;
  manager: ModuleManager;
  jobs: JobEngine;
  app: FastifyInstance;
  setupCode: string;
  close: () => Promise<void>;
};

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

function makeLogger(threshold: Level) {
  const minimum = LEVELS.indexOf(threshold);
  return (level: string, message: string): void => {
    const index = LEVELS.indexOf(level as Level);
    if (index < 0 || index < minimum) return;
    process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`);
  };
}

/** Composition root shared by the CLI, HTTP server and integration tests. */
export async function createRuntime(
  config: Config,
  options: { setupCode?: string; logLevel?: Level; recoverTasks?: boolean } = {},
): Promise<Runtime> {
  const log = makeLogger((options.logLevel ?? config.logLevel ?? 'info') as Level);
  setQuietOverride(Number.isFinite(config.quietOverrideUntil) ? config.quietOverrideUntil : null);
  const db = new Db(config.dbPath);
  try {
    const hasSecrets = db.get<{ present: number }>(
      'SELECT EXISTS(SELECT 1 FROM secrets) AS present',
    )?.present === 1;
    const vault = Vault.open(config.keyPath, hasSecrets);
    const sessions = new Sessions(db, vault);
    const manager = new ModuleManager({ db, vault, sessions, modulesDir: config.modulesDir, log });
    const jobs = new JobEngine({ db, vault, manager, log, recoverInterrupted: options.recoverTasks });
    const setupCode = options.setupCode ?? randomToken().slice(0, 32);
    const app = createApp({ config, db, manager, jobs, setupCode, log });
    let closing: Promise<void> | undefined;
    return {
      config, db, vault, sessions, manager, jobs, app, setupCode,
      close: () => closing ??= (async () => {
        await app.close();
        await jobs.shutdown();
        await manager.stopAll();
        db.close();
      })(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
