import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS secrets (
  owner TEXT NOT NULL,
  scope TEXT NOT NULL,
  sealed BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, scope)
);
CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  engine TEXT NOT NULL,
  entry TEXT NOT NULL,
  path TEXT NOT NULL,
  manifest TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  settings TEXT NOT NULL DEFAULT '{}',
  installed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS module_state (
  module TEXT NOT NULL,
  owner TEXT NOT NULL,
  namespace TEXT NOT NULL,
  state_key TEXT NOT NULL,
  sealed BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (module, owner, namespace, state_key)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  operation TEXT NOT NULL,
  course_id TEXT NOT NULL,
  recruit_id TEXT NOT NULL,
  course_name TEXT NOT NULL DEFAULT '',
  units TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  progress REAL,
  detail TEXT NOT NULL DEFAULT '',
  checkpoint BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS write_ledger (
  id TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  owner TEXT NOT NULL,
  stage TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id);
`;

export type SqlValue = string | number | bigint | null | Uint8Array;

export class Db {
  raw: DatabaseSync;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    this.raw.exec(SCHEMA);
    const version = this.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version === 0) this.raw.exec('PRAGMA user_version = 1');
  }

  run(sql: string, ...params: SqlValue[]): { changes: number } {
    const result = this.raw.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.raw.exec('COMMIT');
      return value;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}
