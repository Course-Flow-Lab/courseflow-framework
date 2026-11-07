import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import { Db } from './db.ts';
import { Vault } from './vault.ts';
import { Sessions } from './sessions.ts';
import { ModuleManager } from './modules/manager.ts';
import { JobEngine } from './jobs.ts';
import { MODULE_API } from './modules/protocol.ts';
import { FRAMEWORK_VERSION } from './modules/runner.ts';
import { nowSeconds, quietStatus, randomToken, setQuietOverride } from './domain.ts';
import { AppError, unauthorized, forbidden, badRequest } from './errors.ts';
import {
  createSession,
  createUser,
  hasUsers,
  identity,
  revokeSession,
  verifyPassword,
  type Identity,
} from './auth.ts';
import { APP_JS, INDEX_HTML, STYLE_CSS } from './ui.ts';

export const VERSION = FRAMEWORK_VERSION;

export type Runtime = {
  config: Config;
  db: Db;
  vault: Vault;
  sessions: Sessions;
  manager: ModuleManager;
  jobs: JobEngine;
  app: FastifyInstance;
  setupCode: string;
  close: () => Promise<void>;
};

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

function makeLogger(threshold: Level): (level: string, message: string) => void {
  const minimum = LEVELS.indexOf(threshold);
  return (level, message) => {
    const index = LEVELS.indexOf(level as Level);
    if (index < 0 || index < minimum) return;
    const stamp = new Date().toISOString();
    process.stderr.write(`${stamp} ${level.toUpperCase().padEnd(5)} ${message}\n`);
  };
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export async function createRuntime(
  config: Config,
  options: { setupCode?: string; logLevel?: Level } = {},
): Promise<Runtime> {
  const log = makeLogger((options.logLevel ?? config.logLevel ?? 'info') as Level);
  setQuietOverride(Number.isFinite(config.quietOverrideUntil) ? config.quietOverrideUntil : null);
  const db = new Db(config.dbPath);
  const hasSecrets =
    db.get<{ present: number }>('SELECT EXISTS(SELECT 1 FROM secrets) AS present')?.present === 1;
  const vault = Vault.open(config.keyPath, hasSecrets);
  const sessions = new Sessions(db, vault);
  const manager = new ModuleManager({
    db,
    vault,
    sessions,
    modulesDir: config.modulesDir,
    log,
  });
  const jobs = new JobEngine({ db, vault, manager, log });
  const setupCode = options.setupCode ?? randomToken().slice(0, 32);

  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: false });

  // POST endpoints accept an omitted body: `curl -X POST -H 'content-type: application/json'`.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (text === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new Error('请求体不是合法 JSON'), undefined);
    }
  });

  function requireIdentity(
    request: FastifyRequest,
    options: { write?: boolean; admin?: boolean } = {},
  ): Identity {
    const token = readCookie(request, 'cf_session');
    if (!token) throw unauthorized();
    const current = identity(db, token, nowSeconds());
    if (!current) throw unauthorized('站点会话已过期，请重新登录');
    if (options.admin && current.user.role !== 'admin') throw forbidden();
    if (options.write) {
      const csrf = request.headers['x-courseflow-csrf'];
      if (csrf !== current.csrf) {
        throw new AppError(403, 'invalid_csrf', '页面会话已变化，请刷新后重试');
      }
    }
    const origin = request.headers.origin;
    if (origin && origin !== config.publicUrl) {
      throw new AppError(403, 'invalid_origin', '请求来源与站点地址不一致');
    }
    return current;
  }

  function setSessionCookie(token: string): string {
    const secure = config.publicUrl.startsWith('https:') ? '; Secure' : '';
    return `cf_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure}`;
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.status).send({ error: { code: error.code, message: error.message } });
      return;
    }
    const failure = error as { statusCode?: number; message?: string };
    const status = failure.statusCode ?? 500;
    const message = failure.message ?? '服务内部错误';
    if (status >= 500) log('error', `${request.method} ${request.url} 失败：${message}`);
    reply
      .status(status >= 400 && status < 600 ? status : 500)
      .send({ error: { code: 'internal_error', message } });
  });

  // ------------------------------------------------------------------ shell

  app.get('/', async (_request, reply) => {
    reply.header('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self'");
    reply.header('x-content-type-options', 'nosniff');
    return reply.type('text/html; charset=utf-8').send(INDEX_HTML);
  });
  app.get('/app.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(APP_JS));
  app.get('/style.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(STYLE_CSS));

  app.get('/healthz', async () => ({
    status: 'ok',
    name: 'courseflow-framework',
    version: VERSION,
    module_api: MODULE_API,
    modules: manager.list().map((row) => ({
      id: row.id,
      version: row.version,
      enabled: row.enabled === 1,
      running: row.running,
    })),
  }));

  // ------------------------------------------------------------------ auth

  app.get('/api/bootstrap', async () => ({
    name: 'Courseflow',
    version: VERSION,
    module_api: MODULE_API,
    setup_required: !hasUsers(db),
    quiet_hours: quietStatus(nowSeconds()),
    capabilities: { modules: true, platforms: true, jobs: ['study'], sse: false },
  }));

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

  // ------------------------------------------------------------------ platforms

  app.get('/api/platforms', async (request) => {
    const current = requireIdentity(request);
    return { platforms: await manager.platforms(current.user.id) };
  });

  app.post<{ Params: { pid: string }; Body: { method?: string } }>(
    '/api/platforms/:pid/login',
    async (request) => {
      const current = requireIdentity(request, { write: true });
      const method = request.body?.method ?? 'qr';
      const challenge = await manager.loginBegin(current.user.id, request.params.pid, method);
      return { challenge };
    },
  );

  app.post<{ Params: { pid: string; id: string } }>(
    '/api/platforms/:pid/login/:id/poll',
    async (request) => {
      const current = requireIdentity(request, { write: true });
      return manager.loginPoll(current.user.id, request.params.pid, request.params.id);
    },
  );

  app.post<{ Params: { pid: string } }>('/api/platforms/:pid/disconnect', async (request) => {
    const current = requireIdentity(request, { write: true });
    await manager.disconnect(current.user.id, request.params.pid);
    return { connected: false };
  });

  app.get<{ Params: { pid: string } }>('/api/platforms/:pid/courses', async (request) => {
    const current = requireIdentity(request);
    const courses = await manager.courses(current.user.id, request.params.pid);
    return { courses };
  });

  app.get<{ Params: { pid: string; id: string; rid: string } }>(
    '/api/platforms/:pid/courses/:id/:rid/units',
    async (request) => {
      const current = requireIdentity(request);
      const { pid, id, rid } = request.params;
      const courses = await manager.courses(current.user.id, pid);
      const course = courses.find((item) => item.id === id && item.recruit_id === rid);
      if (!course) throw new AppError(404, 'not_found', '找不到这门课程');
      const units = await manager.units(current.user.id, pid, course);
      const descriptor = await manager.describe(pid);
      return {
        course,
        units,
        ui: manager.presentation(descriptor.platform, course),
      };
    },
  );

  app.post<{ Params: { pid: string; id: string; rid: string }; Body: { unit_ids?: string[]; operation?: string } }>(
    '/api/platforms/:pid/courses/:id/:rid/study',
    async (request) => {
      const current = requireIdentity(request, { write: true });
      const { pid, id, rid } = request.params;
      const unitIds = request.body?.unit_ids;
      if (!Array.isArray(unitIds) || unitIds.some((value) => typeof value !== 'string')) {
        throw badRequest('请提供 unit_ids');
      }
      const courses = await manager.courses(current.user.id, pid);
      const course = courses.find((item) => item.id === id && item.recruit_id === rid);
      if (!course) throw new AppError(404, 'not_found', '找不到这门课程');
      return {
        task: jobs.create(current.user.id, {
          platform: pid,
          course,
          unit_ids: unitIds,
          operation: request.body?.operation ?? 'study',
        }),
      };
    },
  );

  // ------------------------------------------------------------------ tasks

  app.get('/api/tasks', async (request) => {
    const current = requireIdentity(request);
    return { tasks: jobs.list(current.user.id) };
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/stop', async (request) => {
    const current = requireIdentity(request, { write: true });
    return { task: jobs.stop(current.user.id, request.params.id) };
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/resume', async (request) => {
    const current = requireIdentity(request, { write: true });
    return { task: jobs.resume(current.user.id, request.params.id) };
  });

  // ------------------------------------------------------------------ modules (admin)

  app.get('/api/modules', async (request) => {
    requireIdentity(request, { admin: true });
    return {
      modules: manager.list().map((row) => ({
        id: row.id,
        name: row.manifestJson.name,
        version: row.version,
        engine: row.engine,
        sha256: row.sha256,
        enabled: row.enabled === 1,
        running: row.running,
        settings: JSON.parse(row.settings) as Record<string, unknown>,
        permissions: row.manifestJson.permissions,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/modules/:id/enable', async (request) => {
    requireIdentity(request, { write: true, admin: true });
    manager.setEnabled(request.params.id, true);
    void manager.warmUp(request.params.id);
    return { enabled: true };
  });

  app.post<{ Params: { id: string } }>('/api/modules/:id/disable', async (request) => {
    requireIdentity(request, { write: true, admin: true });
    manager.setEnabled(request.params.id, false);
    return { enabled: false };
  });

  app.post<{ Params: { id: string }; Body: { settings?: Record<string, unknown> } }>(
    '/api/modules/:id/config',
    async (request) => {
      requireIdentity(request, { write: true, admin: true });
      const settings = request.body?.settings;
      if (!settings || typeof settings !== 'object') throw badRequest('请提供 settings 对象');
      manager.configure(request.params.id, settings);
      void manager.warmUp(request.params.id);
      return { settings };
    },
  );

  app.post<{ Body: { path?: string } }>('/api/modules/install', async (request) => {
    requireIdentity(request, { write: true, admin: true });
    const source = request.body?.path;
    if (!source) throw badRequest('请提供模块路径');
    const row = manager.install(source);
    return { module: { id: row.id, version: row.version, sha256: row.sha256 } };
  });

  return {
    config,
    db,
    vault,
    sessions,
    manager,
    jobs,
    app,
    setupCode,
    close: async () => {
      jobs.abortAll();
      await manager.stopAll();
      await app.close();
      db.close();
    },
  };
}

export { FRAMEWORK_VERSION };
