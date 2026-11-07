import type { FastifyRequest } from 'fastify';
import type { Config } from '../core/config.ts';
import type { Db } from '../core/db.ts';
import { identity, type Identity } from '../core/auth.ts';
import { nowSeconds } from '../core/domain.ts';
import { AppError, unauthorized, forbidden } from '../core/errors.ts';

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index >= 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function createAccess(db: Db, config: Config) {
  function requireOrigin(request: FastifyRequest): void {
    if (request.headers.origin && request.headers.origin !== config.publicUrl) {
      throw new AppError(403, 'invalid_origin', '请求来源与站点地址不一致');
    }
  }
  return {
    requireOrigin,
    requireIdentity(request: FastifyRequest, options: { write?: boolean; admin?: boolean } = {}): Identity {
      const token = readCookie(request, 'cf_session');
      if (!token) throw unauthorized();
      const current = identity(db, token, nowSeconds());
      if (!current) throw unauthorized('站点会话已过期，请重新登录');
      if (options.admin && current.user.role !== 'admin') throw forbidden();
      if (options.write && request.headers['x-courseflow-csrf'] !== current.csrf) {
        throw new AppError(403, 'invalid_csrf', '页面会话已变化，请刷新后重试');
      }
      requireOrigin(request);
      return current;
    },
    setSessionCookie(token: string): string {
      const secure = config.publicUrl.startsWith('https:') ? '; Secure' : '';
      return `cf_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure}`;
    },
  };
}
