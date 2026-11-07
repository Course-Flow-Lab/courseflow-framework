import { randomInt } from 'node:crypto';
import type { Db } from './db.ts';
import { digest, randomId } from './domain.ts';
import { badRequest, conflict, notFound } from './errors.ts';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CODE_PATTERN = /^[A-Z0-9]{5}(?:-[A-Z0-9]{5}){4}$/;

export function registrationSettings(db: Db): { invitation_required: boolean } {
  const row = db.get<{ value: string }>("SELECT value FROM site_settings WHERE setting_key = 'invitation_required'");
  return { invitation_required: row?.value !== 'false' };
}

export function saveRegistrationSettings(db: Db, required: unknown): { invitation_required: boolean } {
  if (typeof required !== 'boolean') throw badRequest('请选择是否要求新用户提供邀请码');
  db.run("INSERT INTO site_settings(setting_key,value) VALUES('invitation_required',?1) ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value", String(required));
  return registrationSettings(db);
}

export function generateInvitations(db: Db, actor: string, count: unknown, now: number): string[] {
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100) {
    throw badRequest('每次可生成 1–100 个邀请码');
  }
  return db.transaction(() => Array.from({ length: count }, () => {
    const code = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')).join('-');
    const hint = `${code.slice(0, 5)}-•••••-•••••-•••••-${code.slice(-5)}`;
    db.run('INSERT INTO invitations(id,code_hash,code_hint,created_by,created_at) VALUES(?1,?2,?3,?4,?5)', randomId(), digest(code), hint, actor, now);
    return code;
  }));
}

/** 调用者在创建用户的同一事务内再次检查，避免配置变化或并发注册重复用码。 */
export function registrationInvitation(db: Db, input: unknown): string | undefined {
  if (input !== undefined && typeof input !== 'string') throw badRequest('邀请码必须是文本');
  const code = (input ?? '').trim().toUpperCase();
  if (!code) {
    if (registrationSettings(db).invitation_required) throw badRequest('请填写管理员提供的邀请码', 'invitation_required');
    return undefined;
  }
  const row = CODE_PATTERN.test(code) ? db.get<{ id: string }>(
    'SELECT id FROM invitations WHERE code_hash = ?1 AND used_at IS NULL AND revoked_at IS NULL', digest(code),
  ) : undefined;
  if (!row) throw badRequest('邀请码无效、已使用或已撤销，请联系管理员', 'invalid_invitation');
  return row.id;
}

export function useInvitation(db: Db, id: string, user: string, now: number): void {
  const { changes } = db.run('UPDATE invitations SET used_by=?1, used_at=?2 WHERE id=?3 AND used_at IS NULL AND revoked_at IS NULL', user, now, id);
  if (changes !== 1) throw conflict('invitation_unavailable', '邀请码已使用或已撤销，请联系管理员');
}

export function revokeInvitation(db: Db, id: string, now: number): void {
  const row = db.get<{ used_at: number | null; revoked_at: number | null }>('SELECT used_at,revoked_at FROM invitations WHERE id=?1', id);
  if (!row) throw notFound('找不到这个邀请码');
  if (row.used_at !== null) throw conflict('invitation_used', '已使用的邀请码不能撤销');
  if (row.revoked_at === null) db.run('UPDATE invitations SET revoked_at=?1 WHERE id=?2 AND used_at IS NULL', now, id);
}

export function invitationOverview(db: Db) {
  const invitations = db.all<{
    id: string; code_hint: string; created_at: number; created_by: string;
    used_by: string | null; used_at: number | null; revoked_at: number | null;
  }>(`SELECT i.id, i.code_hint, i.created_at, creator.username AS created_by,
      member.username AS used_by, i.used_at, i.revoked_at
      FROM invitations i JOIN users creator ON creator.id=i.created_by
      LEFT JOIN users member ON member.id=i.used_by
      ORDER BY i.created_at DESC, i.rowid DESC LIMIT 100`);
  const stats = db.get<{ total: number; available: number; used: number; revoked: number }>(
    `SELECT COUNT(*) AS total, COUNT(CASE WHEN used_at IS NULL AND revoked_at IS NULL THEN 1 END) AS available,
     COUNT(used_at) AS used, COUNT(revoked_at) AS revoked FROM invitations`,
  )!;
  return { settings: registrationSettings(db), invitations, stats };
}
