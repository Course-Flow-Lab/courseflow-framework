import type { Db } from './db.ts';
import { badRequest } from './errors.ts';
import { nowSeconds, quietStatus } from './domain.ts';

export type Preferences = { model_id: string | null; concurrency: number; parallel_study: boolean; speedup: boolean; review_minutes: number; qa_peers: boolean; qa_allow_over_limit: boolean; quiet_hours: boolean };
const DEFAULTS: Preferences = { model_id: null, concurrency: 1, parallel_study: false, speedup: false, review_minutes: 10, qa_peers: false, qa_allow_over_limit: false, quiet_hours: true };
export function preferences(db: Db, owner: string): Preferences {
  const row = db.get<{ value: string }>('SELECT value FROM preferences WHERE owner=?1', owner);
  return { ...DEFAULTS, ...(row ? JSON.parse(row.value) : {}) };
}
export function savePreferences(db: Db, owner: string, input: Partial<Preferences>): Preferences {
  const value = { ...preferences(db, owner) };
  for (const key of ['parallel_study', 'speedup', 'qa_peers', 'quiet_hours', 'qa_allow_over_limit'] as const) {
    if (input[key] !== undefined) { if (typeof input[key] !== 'boolean') throw badRequest('偏好开关必须是布尔值'); value[key] = input[key]; }
  }
  for (const [key, low, high] of [['concurrency', 1, 8], ['review_minutes', 1, 60]] as const) {
    if (input[key] !== undefined) { const n = input[key]; if (!Number.isInteger(n) || n! < low || n! > high) throw badRequest(`${key} 超出允许范围`); value[key] = n!; }
  }
  if (input.model_id !== undefined) { if (input.model_id !== null && typeof input.model_id !== 'string') throw badRequest('模型编号无效'); value.model_id = input.model_id; }
  db.run('INSERT INTO preferences(owner,value) VALUES(?1,?2) ON CONFLICT(owner) DO UPDATE SET value=excluded.value', owner, JSON.stringify(value));
  return value;
}

export function quietFor(db: Db, owner: string, now = nowSeconds()) {
  return quietStatus(now, preferences(db, owner).quiet_hours);
}
