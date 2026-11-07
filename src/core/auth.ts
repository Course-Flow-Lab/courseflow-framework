import argon2 from 'argon2';
import { pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { digest, randomId, randomToken } from './domain.ts';
import { badRequest, conflict } from './errors.ts';
import { registrationInvitation, useInvitation } from './invitations.ts';

export const SESSION_TTL = 7 * 86400;

// Must match the Rust implementation (argon2 0.5 defaults) so hashes verify across runtimes.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export type Role = 'admin' | 'user';

export type User = {
  id: string;
  username: string;
  role: Role;
  disabled: number;
  password_hash: string;
};

export type Identity = {
  user: { id: string; username: string; role: Role };
  csrf: string;
};

export function validateCredentials(username: string, password: string): void {
  const length = [...username].length;
  if (length < 2 || length > 32) throw badRequest('用户名需 2–32 个字符');
  if (!/^[\p{L}\p{N}_.-]+$/u.test(username)) {
    throw badRequest('用户名只能包含文字、数字、下划线、点和短横线');
  }
  if ([...password].length < 12) throw badRequest('密码至少 12 个字符');
  if (Buffer.byteLength(password) > 256) throw badRequest('密码不能超过 256 字节');
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith('pbkdf2_sha256$')) {
    const [roundsText, saltText, hashText] = stored.slice('pbkdf2_sha256$'.length).split('$');
    if (!roundsText || !saltText || !hashText) return false;
    const rounds = Number(roundsText);
    if (!Number.isInteger(rounds) || rounds < 10_000 || rounds > 4_000_000) return false;
    const salt = Buffer.from(saltText, 'base64');
    const expected = Buffer.from(hashText, 'base64');
    if (salt.length === 0 || salt.length > 128 || expected.length !== 32) return false;
    const actual = pbkdf2Sync(password, salt, rounds, 32, 'sha256');
    return timingSafeEqual(actual, expected);
  }
  try {
    return await argon2.verify(stored, password);
  } catch {
    return false;
  }
}

export function createSession(
  db: Db,
  userId: string,
  now: number,
): { token: string; csrf: string } {
  const token = randomToken();
  const csrf = digest(randomToken());
  db.run(
    'INSERT INTO sessions(token_hash,user_id,csrf,created_at,expires_at) VALUES(?1,?2,?3,?4,?5)',
    digest(token),
    userId,
    csrf,
    now,
    now + SESSION_TTL,
  );
  return { token, csrf };
}

export function identity(db: Db, token: string, now: number): Identity | undefined {
  const row = db.get<{ id: string; username: string; role: Role; csrf: string; disabled: number }>(
    `SELECT u.id, u.username, u.role, u.disabled, s.csrf
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
    digest(token),
    now,
  );
  if (!row || row.disabled === 1) return undefined;
  return { user: { id: row.id, username: row.username, role: row.role }, csrf: row.csrf };
}

export function revokeSession(db: Db, token: string): void {
  db.run('DELETE FROM sessions WHERE token_hash = ?1', digest(token));
}

export function hasUsers(db: Db): boolean {
  return db.get<{ present: number }>('SELECT EXISTS(SELECT 1 FROM users) AS present')?.present === 1;
}

export async function createUser(
  db: Db,
  username: string,
  password: string,
  role: Role,
  now: number,
): Promise<{ id: string; username: string; role: Role }> {
  validateCredentials(username, password);
  const hash = await hashPassword(password);
  return db.transaction(() => insertUser(db, username, hash, role, now));
}

function insertUser(db: Db, username: string, hash: string, role: Role, now: number) {
  if (db.get('SELECT 1 FROM users WHERE username = ?1 COLLATE NOCASE', username)) {
    throw conflict('username_taken', '这个用户名已存在');
  }
  const id = randomId();
  db.run(
    'INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?1,?2,?3,?4,?5)',
    id,
    username,
    hash,
    role,
    now,
  );
  return { id, username, role };
}

export async function registerUser(db: Db, username: string, password: string, code: unknown, now: number) {
  validateCredentials(username, password);
  if (!hasUsers(db)) throw conflict('setup_required', '请先由管理员完成站点初始化');
  registrationInvitation(db, code);
  const hash = await hashPassword(password);
  return db.transaction(() => {
    const invitation = registrationInvitation(db, code);
    const user = insertUser(db, username, hash, 'user', now);
    if (invitation) useInvitation(db, invitation, user.id, now);
    const session = createSession(db, user.id, now);
    return { user, session };
  });
}
