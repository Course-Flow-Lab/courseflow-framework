import type { RuntimeConfig } from './core/config.ts';
import fs from 'node:fs';
import { Db } from './core/db.ts';
import { Vault } from './core/vault.ts';
import { Sessions } from './core/sessions.ts';
import { setQuietOverride } from './core/domain.ts';
import { ModuleManager, type Logger } from './modules/manager.ts';
import { JobEngine } from './jobs/engine.ts';
import { FRAMEWORK_VERSION } from './version.ts';
import { AiService } from './services/ai.ts';
import { AsrService } from './services/asr.ts';
import { AnswerMemory } from './services/answers.ts';
import { QuestionBankService } from './question-bank/service.ts';
import { BrowserService } from './services/browser.ts';
import { LogStore, redactLog } from './services/logs.ts';
import { configureProxy } from './core/network.ts';

export const VERSION = FRAMEWORK_VERSION;
export { FRAMEWORK_VERSION };

export type Runtime = {
  config: RuntimeConfig;
  db: Db;
  vault: Vault;
  sessions: Sessions;
  manager: ModuleManager;
  jobs: JobEngine;
  ai: AiService;
  memory: AnswerMemory;
  questionBank: QuestionBankService;
  asr: AsrService;
  browser: BrowserService;
  logs: LogStore;
  log: Logger;
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

/** 后端运行时；HTTP、监听端口和进程信号由调用方管理。 */
export async function createRuntime(
  config: RuntimeConfig,
  options: { logLevel?: Level; recoverTasks?: boolean } = {},
): Promise<Runtime> {
  configureProxy();
  fs.mkdirSync(config.modulesDir, { recursive: true, mode: 0o700 });
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
    const memory = new QuestionBankService(db, vault);
    const asr = new AsrService({
      url: process.env.CF_ASR_URL,
      command: process.env.CF_ASR_COMMAND,
      model: process.env.CF_ASR_MODEL,
      timeoutMs: Number(process.env.CF_ASR_TIMEOUT_MS) || undefined,
      maxBytes: Number(process.env.CF_ASR_MAX_BYTES) || undefined,
      concurrency: Number(process.env.CF_ASR_CONCURRENCY) || undefined,
    });
    const browser = new BrowserService(config.dataDir);
    const manager = new ModuleManager({ db, vault, sessions, modulesDir: config.modulesDir, log, ai, asr, browser, memory });
    const jobs = new JobEngine({ db, vault, manager, log, ai, memory, recoverInterrupted: options.recoverTasks });
    log('info', `Courseflow ${VERSION} 运行时已就绪`);
    let closing: Promise<void> | undefined;
    return {
      config, db, vault, sessions, manager, jobs, log, ai, memory, questionBank: memory, asr, browser, logs,
      close: () => closing ??= (async () => {
        const errors: unknown[] = [];
        for (const close of [() => asr.shutdown(), () => jobs.shutdown(), () => manager.stopAll(), () => browser.shutdown(), () => db.close()]) {
          try { await close(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, '后端运行时未能完全关闭');
      })(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
