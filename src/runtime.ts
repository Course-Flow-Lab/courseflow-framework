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
import { AiService } from './services/ai.ts';
import { AnswerMemory } from './services/answers.ts';
import { BrowserService } from './services/browser.ts';
import { LogStore, redactLog } from './services/logs.ts';
import { configureProxy } from './core/network.ts';

export const VERSION = FRAMEWORK_VERSION;
export { FRAMEWORK_VERSION };

export type Runtime = {
  config: Config;
  db: Db;
  vault: Vault;
  sessions: Sessions;
  manager: ModuleManager;
  jobs: JobEngine;
  ai: AiService;
  memory: AnswerMemory;
  browser: BrowserService;
  logs: LogStore;
  app: FastifyInstance;
  setupCode: string;
  close: () => Promise<void>;
};

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

function makeLogger(threshold: Level, logs: LogStore) {
  const minimum = LEVELS.indexOf(threshold);
  return (level: string, message: string): void => {
    const index = LEVELS.indexOf(level as Level);
    if (index < 0 || index < minimum) return;
    const safe = redactLog(message);
    logs.runtime(level, safe);
    process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${safe}\n`);
  };
}

/** Composition root shared by the CLI, HTTP server and integration tests. */
export async function createRuntime(
  config: Config,
  options: { setupCode?: string; logLevel?: Level; recoverTasks?: boolean } = {},
): Promise<Runtime> {
  configureProxy();
  const logs = new LogStore(config.dataDir);
  const log = makeLogger((options.logLevel ?? config.logLevel ?? 'info') as Level, logs);
  setQuietOverride(Number.isFinite(config.quietOverrideUntil) ? config.quietOverrideUntil : null);
  const db = new Db(config.dbPath);
  try {
    const hasSecrets = db.get<{ present: number }>(
      'SELECT (EXISTS(SELECT 1 FROM secrets) OR EXISTS(SELECT 1 FROM ai_models) OR EXISTS(SELECT 1 FROM task_inputs) OR EXISTS(SELECT 1 FROM module_state) OR EXISTS(SELECT 1 FROM answer_memory) OR EXISTS(SELECT 1 FROM media_assets)) AS present',
    )?.present === 1;
    const vault = Vault.open(config.keyPath, hasSecrets);
    const sessions = new Sessions(db, vault);
    const ai = new AiService(db, vault);
    const memory = new AnswerMemory(db, vault);
    const browser = new BrowserService(config.dataDir);
    const manager = new ModuleManager({ db, vault, sessions, modulesDir: config.modulesDir, log, ai, browser });
    const jobs = new JobEngine({ db, vault, manager, log, ai, memory, recoverInterrupted: options.recoverTasks });
    const setupCode = options.setupCode ?? randomToken().slice(0, 32);
    const app = createApp({ config, db, manager, jobs, setupCode, log, ai, memory, browser, logs });
    log('info', `Courseflow ${VERSION} 运行时已就绪`);
    let closing: Promise<void> | undefined;
    return {
      config, db, vault, sessions, manager, jobs, app, setupCode, ai, memory, browser, logs,
      close: () => closing ??= (async () => {
        await app.close();
        await jobs.shutdown();
        await manager.stopAll();
        await browser.shutdown();
        db.close();
      })(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
