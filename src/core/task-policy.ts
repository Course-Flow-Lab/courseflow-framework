import type { Db } from './db.ts';
import { badRequest } from './errors.ts';
import { preferences } from './preferences.ts';

export type TaskPolicy = { max_concurrency: number; parallel_study: boolean; user_limits: Record<string, number> };
const KEY = 'task_policy';

export function taskPolicy(db: Db): TaskPolicy {
  const row = db.get<{ value: string }>('SELECT value FROM site_settings WHERE setting_key=?1', KEY);
  return { max_concurrency: 8, parallel_study: true, user_limits: {}, ...(row ? JSON.parse(row.value) : {}) };
}

export function taskLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 8) throw badRequest('并发任务上限需为 1–8 的整数');
  return value;
}

export function saveTaskPolicy(db: Db, input: { max_concurrency?: unknown; parallel_study?: unknown }): TaskPolicy {
  const value = taskPolicy(db);
  if (input.max_concurrency !== undefined) value.max_concurrency = taskLimit(input.max_concurrency);
  if (input.parallel_study !== undefined) {
    if (typeof input.parallel_study !== 'boolean') throw badRequest('并行学习开关必须是布尔值');
    value.parallel_study = input.parallel_study;
  }
  store(db, value);
  return value;
}

export function saveUserTaskLimit(db: Db, owner: string, limit: unknown): void {
  const value = taskPolicy(db);
  if (limit === null) delete value.user_limits[owner];
  else value.user_limits[owner] = taskLimit(limit);
  store(db, value);
}

function store(db: Db, value: TaskPolicy): void {
  db.run('INSERT INTO site_settings(setting_key,value) VALUES(?1,?2) ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value', KEY, JSON.stringify(value));
}

export function effectiveTaskPolicy(db: Db, owner: string) {
  const site = taskPolicy(db), user = preferences(db, owner);
  return { concurrency: Math.min(user.concurrency, site.user_limits[owner] ?? site.max_concurrency), parallel_study: site.parallel_study && user.parallel_study };
}
