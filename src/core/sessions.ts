import type { Db } from './db.ts';
import type { Vault } from './vault.ts';
import type { Cookie } from '../modules/net.ts';
import { digest, nowSeconds, randomId } from './domain.ts';
import { conflict, notFound, unauthorized } from './errors.ts';

export type PlatformSession = {
  cookies: Cookie[];
  token: string;
  display_name: string;
  account_raw: string;
  connected_at: number;
  session_id: string;
};

export type JobScope = { id: string; generation: number };
export type Live = {
  handle: string;
  owner: string;
  platform: string;
  kind: 'challenge' | 'session';
  cookies: Cookie[];
  token: string;
  expires_at: number;
  connectionId?: string;
  job?: JobScope;
};

const scopeFor = (platform: string): string => `${platform}/session`;

/**
 * Session handles are issued by the framework, never by a module (spec §3). A module that sees
 * `s_…` or `ch_…` cannot learn the cookie jar behind it, and a module cannot name another
 * platform's session because the platform id is checked against the module id.
 */
export class Sessions {
  private db: Db;
  private vault: Vault;
  private live = new Map<string, Live>();

  constructor(db: Db, vault: Vault) {
    this.db = db;
    this.vault = vault;
  }

  openChallenge(owner: string, platform: string, ttlSeconds: number): string {
    const handle = `ch_${randomId()}`;
    this.live.set(handle, {
      handle,
      owner,
      platform,
      kind: 'challenge',
      cookies: [],
      token: '',
      expires_at: nowSeconds() + ttlSeconds,
    });
    return handle;
  }

  challenge(handle: string, owner: string): Live {
    const entry = this.live.get(handle);
    if (!entry || entry.kind !== 'challenge' || entry.owner !== owner) {
      throw conflict('login_not_found', '二维码已更新，请重新扫码');
    }
    if (entry.expires_at <= nowSeconds()) {
      this.live.delete(handle);
      throw conflict('login_not_found', '登录挑战已过期，请重新发起');
    }
    return entry;
  }

  dropChallenge(handle: string): void {
    this.live.delete(handle);
  }

  /** Called from a `cw.net.fetch` with a `ch_` handle. */
  resolveFetch(handle: string, platform: string): Live {
    const entry = this.live.get(handle);
    if (!entry) throw unauthorized('会话不存在或已过期，请重新连接平台');
    if (entry.platform !== platform) {
      throw conflict('net_blocked', '模块不能使用其他平台的会话');
    }
    if (entry.kind === 'session' && entry.connectionId !== this.load(entry.owner, platform)?.session_id) {
      throw conflict('platform_login_expired', '平台连接已更新，请核对账号后重新继续任务');
    }
    if (entry.job) {
      const task = this.db.get<{ state: string; generation: number }>('SELECT state,generation FROM tasks WHERE id=?1 AND owner=?2', entry.job.id, entry.owner);
      if (!task || task.state !== 'running' || task.generation !== entry.job.generation) throw conflict('task_cancelled', '任务执行已取消，旧执行器不能继续访问平台');
    }
    return entry;
  }

  /** A live `s_` handle for an already connected account, created on demand after a restart. */
  handleFor(owner: string, platform: string): string | undefined {
    for (const entry of this.live.values()) {
      if (entry.owner === owner && entry.platform === platform && entry.kind === 'session' && !entry.job) {
        return entry.handle;
      }
    }
    const stored = this.load(owner, platform);
    if (!stored) return undefined;
    const handle = `s_${randomId()}`;
    this.live.set(handle, {
      handle,
      owner,
      platform,
      kind: 'session',
      cookies: stored.cookies,
      token: stored.token,
      expires_at: 0,
      connectionId: stored.session_id,
    });
    return handle;
  }

  complete(
    owner: string,
    platform: string,
    handle: string,
    identity: { display_name: string; account_raw: string },
  ): PlatformSession {
    const challenge = this.challenge(handle, owner);
    const session: PlatformSession = {
      cookies: challenge.cookies,
      token: challenge.token,
      display_name: identity.display_name,
      account_raw: identity.account_raw,
      connected_at: nowSeconds(),
      session_id: randomId(),
    };
    this.save(owner, platform, session);
    for (const [id, entry] of this.live) {
      if (entry.owner === owner && entry.platform === platform) this.live.delete(id);
    }
    this.handleFor(owner, platform);
    return session;
  }

  /** Refresh the cookie jar after a `cw.net.fetch` from a persisted session. */
  refresh(handle: string): void {
    const entry = this.live.get(handle);
    if (!entry || entry.kind !== 'session') return;
    const stored = this.load(entry.owner, entry.platform);
    if (!stored) return;
    this.save(entry.owner, entry.platform, {
      ...stored,
      cookies: entry.cookies,
      token: entry.token,
    });
    for (const alias of this.live.values()) {
      if (alias.owner === entry.owner && alias.platform === entry.platform && alias.kind === 'session') { alias.cookies = entry.cookies; alias.token = entry.token; }
    }
  }

  jobHandle(owner: string, platform: string, job: JobScope): string {
    const base = this.handleFor(owner, platform);
    if (!base) throw conflict('platform_not_connected', '尚未连接平台账号');
    for (const entry of this.live.values()) {
      if (entry.owner === owner && entry.platform === platform && entry.job?.id === job.id && entry.job.generation === job.generation) return entry.handle;
    }
    const handle = `j_${randomId()}`;
    this.live.set(handle, { ...this.live.get(base)!, handle, job });
    return handle;
  }

  cancelJob(id: string): void {
    for (const [handle, entry] of this.live) if (entry.job?.id === id) this.live.delete(handle);
  }

  load(owner: string, platform: string): PlatformSession | undefined {
    const row = this.db.get<{ sealed: Uint8Array }>(
      'SELECT sealed FROM secrets WHERE owner = ?1 AND scope = ?2',
      owner,
      scopeFor(platform),
    );
    if (!row) return undefined;
    return this.vault.openJson<PlatformSession>(owner, scopeFor(platform), Buffer.from(row.sealed));
  }

  save(owner: string, platform: string, session: PlatformSession): void {
    const sealed = this.vault.sealJson(owner, scopeFor(platform), session);
    this.db.run(
      `INSERT INTO secrets(owner,scope,sealed,updated_at) VALUES(?1,?2,?3,?4)
       ON CONFLICT(owner,scope) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at`,
      owner,
      scopeFor(platform),
      new Uint8Array(sealed),
      nowSeconds(),
    );
  }

  remove(owner: string, platform: string): void {
    for (const [handle, entry] of this.live) {
      if (entry.owner === owner && entry.platform === platform) this.live.delete(handle);
    }
    this.db.run('DELETE FROM secrets WHERE owner = ?1 AND scope = ?2', owner, scopeFor(platform));
  }

  accountKey(owner: string, platform: string): string | undefined {
    const session = this.load(owner, platform);
    if (!session) return undefined;
    return digest(`${platform}/account/${session.account_raw}`);
  }

  connected(owner: string, platform: string): { display_name: string; connected_at: number } | undefined {
    const session = this.load(owner, platform);
    if (!session) return undefined;
    return { display_name: session.display_name, connected_at: session.connected_at };
  }

  require(handle: string, platform: string): Live {
    const entry = this.live.get(handle);
    if (!entry) throw notFound('平台会话不存在，请重新连接');
    if (entry.platform !== platform) throw conflict('net_blocked', '模块不能使用其他平台的会话');
    return entry;
  }
}
