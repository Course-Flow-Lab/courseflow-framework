import type { Db } from './db.ts';
import { nowSeconds, randomId } from './domain.ts';
import { badRequest, conflict, forbidden, notFound } from './errors.ts';

export const DEFAULT_TEAM_ACCOUNT_LIMIT = 10;
export type PlatformAccount = { id: string; owner: string; platform: string; label: string; legacy: number; created_at: number };

export function validateAccountLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1000) throw badRequest('平台账号总上限需为 0–1000 的整数');
  return value;
}

export function platformAccounts(db: Db, owner: string, platform?: string): PlatformAccount[] {
  return db.all<PlatformAccount>('SELECT * FROM platform_accounts WHERE owner=?1' + (platform ? ' AND platform=?2' : '') + ' ORDER BY created_at,id', ...[owner, ...(platform ? [platform] : [])]);
}

/** 将已有单账号连接登记为稳定的默认绑定，保留原有加密作用域及任务。 */
export function adoptLegacyAccounts(db: Db, owner: string): void {
  for (const row of db.all<{ scope: string; updated_at: number }>("SELECT scope,updated_at FROM secrets WHERE owner=?1 AND scope LIKE '%/session'", owner)) {
    const platform = row.scope.slice(0, -8);
    if (!db.get('SELECT 1 FROM platform_accounts WHERE owner=?1 AND platform=?2 AND legacy=1', owner, platform)) {
      db.run('INSERT INTO platform_accounts(id,owner,platform,label,legacy,created_at) VALUES(?1,?2,?3,?4,1,?5)', `pa_${randomId()}`, owner, platform, '原有账号', row.updated_at);
    }
  }
}

export function accountQuota(db: Db, owner: string) {
  const user = db.get<{ role: string; platform_account_limit: number }>('SELECT role,platform_account_limit FROM users WHERE id=?1', owner);
  if (user?.role !== 'team') return null;
  const used = db.get<{ n: number }>('SELECT count(*) AS n FROM platform_accounts WHERE owner=?1', owner)!.n;
  return { limit: user.platform_account_limit, used, remaining: Math.max(0, user.platform_account_limit - used) };
}

export function requirePlatformAccount(db: Db, owner: string, platform: string, id: string): PlatformAccount {
  const account = db.get<PlatformAccount>('SELECT * FROM platform_accounts WHERE id=?1 AND owner=?2 AND platform=?3', id, owner, platform);
  if (!account) throw notFound('找不到自己的平台账号');
  return account;
}

export const accountScope = (account: PlatformAccount): string => account.legacy ? account.owner : account.id;

/** HTTP 显式选择绑定，模块继续只接收不透明的会话句柄。 */
export function platformOwner(db: Db, owner: string, platform: string, accountId?: unknown): string {
  if (accountId !== undefined && accountId !== null) {
    if (typeof accountId !== 'string' || !accountId) throw badRequest('平台账号编号无效');
    return accountScope(requirePlatformAccount(db, owner, platform, accountId));
  }
  const user = db.get<{ role: string }>('SELECT role FROM users WHERE id=?1', owner);
  if (user?.role === 'team' && !db.get('SELECT 1 FROM platform_accounts WHERE owner=?1 AND platform=?2 AND legacy=1', owner, platform)) {
    throw badRequest('请先添加并选择一个平台账号', 'platform_account_required');
  }
  return owner;
}

/** 平台会话和模块状态按绑定隔离；权限、模型和任务偏好仍归站点用户。 */
export function principalOwner(db: Db, scope: string): string {
  return db.get<{ owner: string }>('SELECT owner FROM platform_accounts WHERE id=?1', scope)?.owner ?? scope;
}

export function taskPlatformOwner(db: Db, task: { owner: string; platform: string; account_id: string | null }): string {
  return task.account_id ? accountScope(requirePlatformAccount(db, task.owner, task.platform, task.account_id)) : task.owner;
}

export function createPlatformAccount(db: Db, owner: string, platform: string, label: unknown): PlatformAccount {
  if (typeof label !== 'string' || !label.trim() || [...label.trim()].length > 60) throw badRequest('账号备注需 1–60 个字符');
  return db.transaction(() => {
    if (db.get<{ disabled: number }>('SELECT disabled FROM users WHERE id=?1', owner)?.disabled !== 0) throw forbidden('站点账号已停用或不存在');
    const quota = accountQuota(db, owner);
    if (!quota) throw forbidden('只有团队账号可以添加多个平台账号');
    if (quota.used >= quota.limit) throw conflict('platform_account_limit', '已达到跨平台账号总上限，请移除不需要的绑定或联系管理员');
    const id = `pa_${randomId()}`;
    db.run('INSERT INTO platform_accounts(id,owner,platform,label,created_at) VALUES(?1,?2,?3,?4,?5)', id, owner, platform, label.trim(), nowSeconds());
    return requirePlatformAccount(db, owner, platform, id);
  });
}
