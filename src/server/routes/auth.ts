import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { createSession, createUser, hasUsers, revokeSession, verifyPassword } from '../../core/auth.ts';
import { nowSeconds } from '../../core/domain.ts';
import { AppError, badRequest, unauthorized } from '../../core/errors.ts';
import { readCookie } from '../access.ts';

export function registerAuthRoutes(app: FastifyInstance, context: ServerContext): void {
  const { db, setupCode, log } = context;
  const { requireIdentity, setSessionCookie } = context.access;
  app.post<{ Body: { setup_code?: string; username?: string; password?: string } }>(
    '/api/auth/setup',
    async (request, reply) => {
      const body = request.body ?? {};
      if (!hasUsers(db)) {
        if (body.setup_code !== setupCode) {
          throw new AppError(403, 'invalid_setup_code', '设置码不正确，请查看服务终端输出');
        }
        if (!body.username || !body.password) throw badRequest('请填写用户名和密码');
        const user = await createUser(db, body.username, body.password, 'admin', nowSeconds());
        const session = createSession(db, user.id, nowSeconds());
        reply.header('set-cookie', setSessionCookie(session.token));
        log('info', `已创建管理员 ${user.username}`);
        return { user, csrf: session.csrf };
      }
      throw new AppError(409, 'setup_complete', '站点已完成初始化，请直接登录');
    },
  );

  app.post<{ Body: { username?: string; password?: string } }>('/api/auth/login', async (request, reply) => {
    const body = request.body ?? {};
    const username = (body.username ?? '').trim();
    if (!username || !body.password) throw badRequest('请填写用户名和密码');
    const row = db.get<{ id: string; username: string; role: string; disabled: number; password_hash: string }>(
      'SELECT id, username, role, disabled, password_hash FROM users WHERE username = ?1 COLLATE NOCASE',
      username,
    );
    const valid = row ? await verifyPassword(body.password, row.password_hash) : false;
    if (!row || !valid || row.disabled === 1) throw unauthorized('用户名或密码不正确');
    const session = createSession(db, row.id, nowSeconds());
    reply.header('set-cookie', setSessionCookie(session.token));
    return {
      user: { id: row.id, username: row.username, role: row.role },
      csrf: session.csrf,
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    requireIdentity(request, { write: true });
    const token = readCookie(request, 'cf_session');
    if (token) revokeSession(db, token);
    reply.header('set-cookie', 'cf_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return { ok: true };
  });

  app.get('/api/me', async (request) => {
    const current = requireIdentity(request);
    return { user: current.user, csrf: current.csrf };
  });
}
