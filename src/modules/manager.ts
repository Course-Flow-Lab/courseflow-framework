import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Db } from '../core/db.ts';
import type { Vault } from '../core/vault.ts';
import type { Sessions } from '../core/sessions.ts';
import type { JobScope } from '../core/sessions.ts';
import type { AiService } from '../services/ai.ts';
import type { BrowserService } from '../services/browser.ts';
import { preferences, quietFor } from '../core/preferences.ts';
import { digest, nowSeconds, randomId } from '../core/domain.ts';
import { AppError, badRequest, notFound } from '../core/errors.ts';
import type { Course, DescribeResult, Manifest, PlatformDescriptor, Unit } from './protocol.ts';
import { resolvePresentation, satisfiesRange, validateManifest } from './protocol.ts';
import { mapPlatformStatus, mergeCookies, performFetch, type Cookie, NetError } from './net.ts';
import { ModuleRunner } from './runner.ts';
import { FRAMEWORK_VERSION } from '../version.ts';

export type ModuleRow = {
  id: string;
  version: string;
  engine: 'binary' | 'node';
  entry: string;
  path: string;
  manifest: string;
  sha256: string;
  enabled: number;
  settings: string;
  installed_at: number;
};

export type Logger = (level: string, message: string) => void;

export type PlatformSummary = PlatformDescriptor & {
  connected: boolean;
  display_name: string | null;
  connected_at: number | null;
  module: { name: string; version: string; sha256: string; enabled: boolean; healthy: boolean };
};

const RESTART_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];

export class ModuleManager {
  private db: Db;
  private vault: Vault;
  private sessions: Sessions;
  private modulesDir: string;
  private log: Logger;
  private runners = new Map<string, ModuleRunner>();
  private starting = new Map<string, Promise<ModuleRunner>>();
  private restartAttempts = new Map<string, number>();
  private restartTimers = new Map<string, NodeJS.Timeout>();
  private ai?: AiService;
  private browser?: BrowserService;
  private hostOperations = new Set<Promise<unknown>>();
  private maintenanceTimer: NodeJS.Timeout;
  private maintaining?: Promise<void>;
  private maintained = new Map<string, number>();
  private jobSignals = new Map<string, AbortController>();

  constructor(options: {
    db: Db;
    vault: Vault;
    sessions: Sessions;
    modulesDir: string;
    log: Logger;
    ai?: AiService;
    browser?: BrowserService;
  }) {
    this.db = options.db;
    this.vault = options.vault;
    this.sessions = options.sessions;
    this.modulesDir = options.modulesDir;
    this.log = options.log;
    this.ai = options.ai;
    this.browser = options.browser;
    this.maintenanceTimer = setInterval(() => { if (!this.maintaining) this.maintaining = this.maintain().finally(() => { this.maintaining = undefined; }); }, 60_000);
    this.maintenanceTimer.unref();
  }

  // ---------------------------------------------------------------- installation

  install(sourcePath: string): ModuleRow {
    const resolved = path.resolve(sourcePath);
    if (!fs.existsSync(resolved)) throw badRequest(`找不到模块路径：${sourcePath}`, 'module_not_found');
    const staged = this.stageSource(resolved);
    const staging = staged.dir;
    try {
      const manifestPath = path.join(staging, 'courseflow.module.json');
      if (!fs.existsSync(manifestPath)) {
        throw badRequest('模块缺少 courseflow.module.json', 'invalid_manifest');
      }
      const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
      if (!satisfiesRange(FRAMEWORK_VERSION, manifest.engines.framework)) {
        throw badRequest(
          `模块要求框架 ${manifest.engines.framework}，当前为 ${FRAMEWORK_VERSION}`,
          'module_range_mismatch',
        );
      }
      const entryPath = path.join(staging, manifest.runtime.entry);
      if (!fs.existsSync(entryPath)) {
        throw badRequest(`模块入口不存在：${manifest.runtime.entry}`, 'invalid_manifest');
      }
      if (manifest.runtime.engine === 'binary') {
        fs.chmodSync(entryPath, 0o755);
      }
      const sha256 = hashFiles(staging, [
        'courseflow.module.json',
        manifest.runtime.entry,
        ...manifest.runtime.files,
      ]);
      const target = path.join(this.modulesDir, manifest.id, manifest.version);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(staging, target, { recursive: true });
      const existing = this.db.get<ModuleRow>('SELECT * FROM modules WHERE id = ?1', manifest.id);
      this.db.run(
        `INSERT INTO modules(id,version,engine,entry,path,manifest,sha256,enabled,settings,installed_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?9)
         ON CONFLICT(id) DO UPDATE SET version=excluded.version, engine=excluded.engine,
           entry=excluded.entry, path=excluded.path, manifest=excluded.manifest,
           sha256=excluded.sha256, installed_at=excluded.installed_at`,
        manifest.id,
        manifest.version,
        manifest.runtime.engine,
        manifest.runtime.entry,
        target,
        JSON.stringify(manifest),
        sha256,
        existing?.settings ?? '{}',
        nowSeconds(),
      );
      void this.stopRunner(manifest.id);
      return this.db.get<ModuleRow>('SELECT * FROM modules WHERE id = ?1', manifest.id)!;
    } finally {
      staged.cleanup();
    }
  }

  /**
   * A directory install copies only the manifest, the entry point and `runtime.files` — never a
   * build directory (`target/`, `node_modules/`) that happens to sit next to them.
   */
  private stageSource(source: string): { dir: string; cleanup: () => void } {
    const temporary = fs.mkdtempSync(path.join(this.modulesDir, '.stage-'));
    const cleanup = (): void => fs.rmSync(temporary, { recursive: true, force: true });
    if (fs.statSync(source).isFile()) {
      try {
        execFileSync('tar', ['-xzf', source, '-C', temporary], { stdio: 'pipe' });
      } catch (error) {
        cleanup();
        throw badRequest(`模块包无法解压：${(error as Error).message}`, 'invalid_artifact');
      }
      const packageDir = path.join(temporary, 'package');
      if (fs.existsSync(packageDir)) return { dir: packageDir, cleanup };
      return { dir: temporary, cleanup };
    }
    const manifestPath = path.join(source, 'courseflow.module.json');
    if (!fs.existsSync(manifestPath)) {
      cleanup();
      throw badRequest('模块缺少 courseflow.module.json', 'invalid_manifest');
    }
    const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    fs.copyFileSync(manifestPath, path.join(temporary, 'courseflow.module.json'));
    const sources = [manifest.runtime.entry, ...manifest.runtime.files];
    for (const relative of sources) {
      const from = path.join(source, relative);
      if (!fs.existsSync(from)) {
        cleanup();
        throw badRequest(`模块清单声明的文件不存在：${relative}`, 'invalid_manifest');
      }
      const to = path.join(temporary, relative);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    }
    return { dir: temporary, cleanup };
  }

  list(): Array<ModuleRow & { manifestJson: Manifest; running: boolean }> {
    const rows = this.db.all<ModuleRow>('SELECT * FROM modules ORDER BY id');
    return rows.map((row) => ({
      ...row,
      manifestJson: JSON.parse(row.manifest) as Manifest,
      running: this.runners.get(row.id)?.alive ?? false,
    }));
  }

  setEnabled(id: string, enabled: boolean): void {
    const row = this.requireRow(id);
    this.db.run('UPDATE modules SET enabled = ?1 WHERE id = ?2', enabled ? 1 : 0, row.id);
    if (!enabled) {
      this.clearRestart(row.id);
      void this.stopRunner(row.id);
    }
  }

  configure(id: string, settings: Record<string, unknown>): void {
    const row = this.requireRow(id);
    this.db.run('UPDATE modules SET settings = ?1 WHERE id = ?2', JSON.stringify(settings), row.id);
    this.clearRestart(row.id);
    // Do not start anything here: the CLI must be able to exit. The server warms the module up
    // explicitly, and any platform call starts it on demand anyway.
    void this.stopRunner(row.id);
  }

  remove(id: string): void {
    const row = this.requireRow(id);
    this.clearRestart(row.id);
    void this.stopRunner(row.id);
    this.db.run('DELETE FROM modules WHERE id = ?1', row.id);
    this.db.run('DELETE FROM module_state WHERE module = ?1', row.id);
    fs.rmSync(path.join(this.modulesDir, row.id), { recursive: true, force: true });
  }

  private requireRow(id: string): ModuleRow {
    const row = this.db.get<ModuleRow>('SELECT * FROM modules WHERE id = ?1', id);
    if (!row) throw notFound('模块未安装');
    return row;
  }

  // ---------------------------------------------------------------- runners

  private async ensureRunner(id: string): Promise<ModuleRunner> {
    const existing = this.runners.get(id);
    if (existing?.alive) return existing;
    const inFlight = this.starting.get(id);
    if (inFlight) return inFlight;
    const row = this.requireRow(id);
    if (row.enabled !== 1) {
      throw new AppError(503, 'module_unavailable', `模块 ${id} 已停用`);
    }
    const manifest = JSON.parse(row.manifest) as Manifest;
    const runner = new ModuleRunner({
      manifest,
      dir: path.join(this.modulesDir, id, row.version),
      settings: JSON.parse(row.settings) as Record<string, unknown>,
      callHost: (method, params) => {
        const operation = this.hostCall(id, method, params);
        this.hostOperations.add(operation);
        void operation.then(() => this.hostOperations.delete(operation), () => this.hostOperations.delete(operation));
        return operation;
      },
      log: (level, message) => this.log(level, `[${id}] ${message}`),
      onExit: (exited) => this.onRunnerExit(exited),
    });
    this.runners.set(id, runner);
    const start = runner
      .start()
      .then((described) => {
        this.restartAttempts.delete(id);
        this.log('info', `模块 ${id} ${row.version} 已加载（${described.platform.name}）`);
        return runner;
      })
      .catch(async (error: Error) => {
        this.runners.delete(id);
        await runner.stop().catch(() => {});
        throw error;
      })
      .finally(() => {
        this.starting.delete(id);
      });
    this.starting.set(id, start);
    return start;
  }

  private onRunnerExit(runner: ModuleRunner): void {
    this.runners.delete(runner.id);
    const attempts = (this.restartAttempts.get(runner.id) ?? 0) + 1;
    this.restartAttempts.set(runner.id, attempts);
    if (attempts > RESTART_BACKOFF_MS.length) {
      this.log('error', `模块 ${runner.id} 连续失败，已停止自动重启`);
      return;
    }
    const delay = RESTART_BACKOFF_MS[attempts - 1] ?? 30_000;
    const row = this.db.get<ModuleRow>('SELECT * FROM modules WHERE id = ?1', runner.id);
    if (!row || row.enabled !== 1) return;
    const timer = setTimeout(() => {
      this.restartTimers.delete(runner.id);
      void this.ensureRunner(runner.id).catch((error: Error) => {
        this.log('warn', `模块 ${runner.id} 重启失败：${error.message}`);
      });
    }, delay);
    timer.unref();
    this.restartTimers.set(runner.id, timer);
    this.log('warn', `模块 ${runner.id} 将在 ${Math.round(delay / 1000)} 秒后重启`);
  }

  private clearRestart(id: string): void {
    const timer = this.restartTimers.get(id);
    if (timer) clearTimeout(timer);
    this.restartTimers.delete(id);
    this.restartAttempts.delete(id);
  }

  private async stopRunner(id: string): Promise<void> {
    const runner = this.runners.get(id);
    this.runners.delete(id);
    if (runner) await runner.stop().catch(() => {});
  }

  /** Start a module now, swallowing failures (the server's admin actions use this). */
  async warmUp(id: string): Promise<void> {
    try {
      await this.ensureRunner(id);
    } catch (error) {
      this.log('warn', `模块 ${id} 启动失败：${(error as Error).message}`);
    }
  }

  private async maintain(): Promise<void> {
    const rows = this.db.all<{ owner: string; scope: string }>("SELECT owner,scope FROM secrets WHERE scope LIKE '%/session'");
    for (const row of rows) {
      const platform = row.scope.slice(0, -8);
      const module = this.db.get<ModuleRow>('SELECT * FROM modules WHERE id=?1 AND enabled=1', platform);
      if (!module) continue;
      const interval = (JSON.parse(module.manifest) as Manifest).platform.keepalive_seconds;
      const key = `${row.owner}/${platform}`;
      if (!interval || nowSeconds() - (this.maintained.get(key) ?? 0) < interval) continue;
      this.maintained.set(key, nowSeconds());
      try { await this.invoke(row.owner, platform, 'auth.keepalive', {}); }
      catch { this.log('warn', `平台 ${platform} 登录保活失败，可在平台连接中重新扫码`); }
    }
  }

  async stopAll(): Promise<void> {
    clearInterval(this.maintenanceTimer);
    await this.maintaining;
    for (const controller of this.jobSignals.values()) controller.abort();
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
    await Promise.all([...this.runners.keys()].map((id) => this.stopRunner(id)));
    await Promise.allSettled([...this.hostOperations]);
  }

  // ---------------------------------------------------------------- platform operations

  enabledIds(): string[] {
    return this.db.all<{ id: string }>('SELECT id FROM modules WHERE enabled = 1 ORDER BY id').map((row) => row.id);
  }

  async platforms(owner: string): Promise<PlatformSummary[]> {
    const summaries: PlatformSummary[] = [];
    for (const row of this.list().filter((module) => module.enabled === 1)) {
      let descriptor: PlatformDescriptor | undefined;
      try {
        const runner = await this.ensureRunner(row.id);
        descriptor = runner.describe?.platform;
      } catch (error) {
        this.log('warn', `模块 ${row.id} 不可用：${(error as Error).message}`);
        descriptor = row.manifestJson.platform;
      }
      if (!descriptor) continue;
      const connected = this.sessions.connected(owner, row.id);
      summaries.push({
        ...descriptor,
        connected: connected !== undefined,
        display_name: connected?.display_name ?? null,
        connected_at: connected?.connected_at ?? null,
        module: {
          name: row.manifestJson.name,
          version: row.version,
          sha256: row.sha256,
          enabled: row.enabled === 1,
          healthy: this.runners.get(row.id)?.alive ?? false,
        },
      });
    }
    return summaries;
  }

  async describe(platform: string): Promise<DescribeResult> {
    const runner = await this.ensureRunner(platform);
    if (!runner.describe) throw new AppError(503, 'module_unavailable', '模块尚未完成握手');
    return runner.describe;
  }

  async loginBegin(owner: string, platform: string, method: string): Promise<Record<string, unknown>> {
    const handle = this.sessions.openChallenge(owner, platform, 180);
    try {
      const result = (await this.call(platform, 'auth.begin', { method, session: handle })) as {
        challenge?: Record<string, unknown>;
      };
      if (!result?.challenge) throw new AppError(502, 'module_protocol_error', '模块没有返回登录挑战');
      return { ...result.challenge, session: handle, platform };
    } catch (error) {
      this.sessions.dropChallenge(handle);
      throw error;
    }
  }

  async loginPoll(
    owner: string,
    platform: string,
    challenge: string,
  ): Promise<{ state: string; challenge: string }> {
    this.sessions.challenge(challenge, owner);
    const result = (await this.call(platform, 'auth.poll', {
      challenge,
      session: challenge,
    })) as { state?: string };
    const state = typeof result?.state === 'string' ? result.state : 'waiting';
    if (state === 'connected') {
      const identity = (await this.call(platform, 'auth.complete', {
        challenge,
        session: challenge,
      })) as { display_name?: string; account_raw?: string };
      if (typeof identity?.display_name !== 'string' || typeof identity?.account_raw !== 'string') {
        throw new AppError(502, 'module_protocol_error', '模块没有返回账号信息');
      }
      this.sessions.complete(owner, platform, challenge, {
        display_name: identity.display_name,
        account_raw: identity.account_raw,
      });
      return { state: 'connected', challenge };
    }
    if (state === 'expired' || state === 'failed') this.sessions.dropChallenge(challenge);
    return { state, challenge };
  }

  async loginSubmit(
    owner: string,
    platform: string,
    challenge: string,
    fields: Record<string, string>,
  ): Promise<{ state: string; message?: string }> {
    this.sessions.challenge(challenge, owner);
    const result = (await this.call(platform, 'auth.submit', {
      challenge,
      session: challenge,
      fields,
    })) as { state?: string; message?: string };
    const state = typeof result?.state === 'string' ? result.state : 'waiting';
    if (state === 'expired') this.sessions.dropChallenge(challenge);
    return {
      state,
      ...(typeof result?.message === 'string' ? { message: result.message } : {}),
    };
  }

  async disconnect(owner: string, platform: string): Promise<void> {
    this.sessions.remove(owner, platform);
  }

  async courses(owner: string, platform: string): Promise<Course[]> {
    const handle = this.requireSession(owner, platform);
    const result = (await this.call(platform, 'catalog.courses', { session: handle })) as {
      courses?: Course[];
    };
    if (!Array.isArray(result?.courses)) {
      throw new AppError(502, 'module_protocol_error', '模块没有返回课程列表');
    }
    return result.courses;
  }

  async units(owner: string, platform: string, course: Course): Promise<Unit[]> {
    const handle = this.requireSession(owner, platform);
    const result = (await this.call(platform, 'catalog.units', {
      session: handle,
      course,
    })) as { units?: Unit[] };
    if (!Array.isArray(result?.units)) {
      throw new AppError(502, 'module_protocol_error', '模块没有返回目录');
    }
    return result.units;
  }

  async studyStep(
    owner: string,
    platform: string,
    course: Course,
    unit: Unit,
    checkpoint: unknown,
    options: Record<string, unknown>,
    job?: JobScope,
  ): Promise<Record<string, unknown>> {
    const handle = job ? this.sessions.jobHandle(owner, platform, job) : this.requireSession(owner, platform);
    if (job && !this.jobSignals.has(job.id)) this.jobSignals.set(job.id, new AbortController());
    return (await this.call(platform, 'study.step', {
      session: handle,
      course,
      unit,
      checkpoint: checkpoint ?? null,
      options,
    })) as Record<string, unknown>;
  }

  presentation(platform: PlatformDescriptor, course: Course) {
    return resolvePresentation(platform, course);
  }

  accountKey(owner: string, platform: string): string | undefined { return this.sessions.accountKey(owner, platform); }
  connectionId(owner: string, platform: string): string | undefined { return this.sessions.load(owner, platform)?.session_id; }
  moduleVersion(platform: string): string { return this.requireRow(platform).version; }
  async invoke(owner: string, platform: string, method: string, params: Record<string, unknown>, job?: JobScope): Promise<any> {
    const session = job ? this.sessions.jobHandle(owner, platform, job) : this.requireSession(owner, platform);
    if (job && !this.jobSignals.has(job.id)) this.jobSignals.set(job.id, new AbortController());
    return this.call(platform, method, { ...params, session });
  }
  cancelJob(id: string): void {
    this.jobSignals.get(id)?.abort(); this.jobSignals.delete(id); this.sessions.cancelJob(id);
    void this.browser?.cancelJob(id);
  }
  async image(owner: string, platform: string, url: string): Promise<{ mime: string; data: string }> {
    if (url.startsWith('/api/media/')) {
      const id = url.slice('/api/media/'.length);
      const asset = this.db.get<{ sealed: Uint8Array }>('SELECT sealed FROM media_assets WHERE id=?1 AND owner=?2 AND platform=?3', id, owner, platform);
      if (!asset) throw notFound('找不到题目图片');
      url = this.vault.openJson<string>(owner, `media/${id}`, Buffer.from(asset.sealed));
    }
    const handle = this.requireSession(owner, platform);
    const session = this.sessions.resolveFetch(handle, platform);
    const manifest = JSON.parse(this.requireRow(platform).manifest) as Manifest;
    const response = await performFetch({ method: 'GET', url, headers: {}, body: null }, { allow: manifest.permissions.network, cookies: session.cookies, token: session.token, now: nowSeconds(), binary: true });
    const mime = response.headers['content-type']?.split(';')[0] ?? '';
    if (response.status !== 200 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw new AppError(502, 'image_unavailable', '题目图片暂时无法读取');
    return { mime, data: response.body };
  }
  registerImage(owner: string, platform: string, source: string): string {
    const id = digest(JSON.stringify([owner, platform, source]));
    const sealed = this.vault.sealJson(owner, `media/${id}`, source);
    this.db.run('INSERT OR IGNORE INTO media_assets VALUES(?1,?2,?3,?4)', id, owner, platform, new Uint8Array(sealed));
    return `/api/media/${id}`;
  }
  async readImage(owner: string, id: string) {
    const row = this.db.get<{ platform: string }>('SELECT platform FROM media_assets WHERE id=?1 AND owner=?2', id, owner);
    if (!row) throw notFound('找不到自己的题目图片');
    return this.image(owner, row.platform, `/api/media/${id}`);
  }

  private requireSession(owner: string, platform: string): string {
    const handle = this.sessions.handleFor(owner, platform);
    if (!handle) throw new AppError(409, 'platform_not_connected', '尚未连接这个平台，请先登录');
    return handle;
  }

  private async call(platform: string, method: string, params: unknown): Promise<unknown> {
    const runner = await this.ensureRunner(platform);
    return runner.call(method, params);
  }

  // ---------------------------------------------------------------- host services

  private async hostCall(moduleId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'cw.clock.now':
        return { now: nowSeconds() };
      case 'cw.log':
        this.log(
          typeof params.level === 'string' ? params.level : 'info',
          `[${moduleId}] ${String(params.message ?? '')}`,
        );
        return {};
      case 'cw.net.fetch':
        return this.hostFetch(moduleId, params);
      case 'cw.session.identity':
        return this.sessionIdentity(moduleId, params);
      case 'cw.ai.generate': {
        const entry = this.sessions.resolveFetch(this.requireSessionParam(params), moduleId);
        const manifest = JSON.parse(this.requireRow(moduleId).manifest) as Manifest;
        if (!manifest.permissions.ai || !this.ai) throw new AppError(403, 'permission_denied', '模块未声明模型权限');
        return { text: await this.ai.generate(entry.owner, String(params.prompt ?? ''), { signal: AbortSignal.timeout(25_000) }) };
      }
      case 'cw.browser.open':
      case 'cw.browser.evaluate':
      case 'cw.browser.close': {
        const session = this.requireSessionParam(params);
        const entry = this.sessions.resolveFetch(session, moduleId);
        const manifest = JSON.parse(this.requireRow(moduleId).manifest) as Manifest;
        if (!manifest.permissions.browser || !this.browser) throw new AppError(403, 'permission_denied', '模块未声明官方浏览器权限');
        if (params.stage !== undefined && params.stage !== 'read' && quietFor(this.db, entry.owner).active) throw new AppError(409, 'quiet_hours', '夜间暂停期间不执行页面写入');
        if (method === 'cw.browser.open') return this.browser.open(entry, manifest.permissions.network, params, () => { this.sessions.resolveFetch(session, moduleId); });
        if (method === 'cw.browser.evaluate') return this.browser.evaluate(entry, String(params.page ?? ''), String(params.expression ?? ''));
        await this.browser.closeOwned(entry, String(params.page ?? '')); return {};
      }
      case 'cw.peers.record': {
        const entry = this.sessions.resolveFetch(this.requireSessionParam(params), moduleId);
        const record = params.record as Record<string, unknown>;
        if (!record || !['question', 'answer'].includes(String(record.kind)) || typeof record.platform_id !== 'string') throw badRequest('发布记录无效');
        const id = digest(JSON.stringify([entry.owner, moduleId, record.course_id, record.recruit_id, record.platform_id]));
        const sealed = this.vault.sealJson(entry.owner, `qa/${id}`, record);
        this.db.run('INSERT OR IGNORE INTO qa_posts VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)', id, entry.owner, moduleId, String(record.course_id), String(record.recruit_id), String(record.question_id ?? ''), String(record.kind), record.platform_id, new Uint8Array(sealed), nowSeconds());
        return {};
      }
      case 'cw.peers.list': {
        const entry = this.sessions.resolveFetch(this.requireSessionParam(params), moduleId);
        if (!preferences(this.db, entry.owner).qa_peers) return { questions: [] };
        const rows = this.db.all<{ platform_id: string }>(`SELECT q.platform_id FROM qa_posts q JOIN preferences p ON p.owner=q.owner WHERE q.owner!=?1 AND q.platform=?2 AND q.course_id=?3 AND q.recruit_id=?4 AND q.kind='question' AND json_extract(p.value,'$.qa_peers')=1 ORDER BY q.created_at DESC LIMIT 100`, entry.owner, moduleId, String(params.course_id), String(params.recruit_id));
        return { questions: rows.map((r) => r.platform_id) };
      }
      // `cw.state` is the canonical method (spec §4.2): the presence of `value` selects a write.
      // `cw.state.get` / `cw.state.set` are accepted as explicit aliases.
      case 'cw.state':
      case 'cw.state.get':
      case 'cw.state.set': {
        const writes =
          method === 'cw.state.set' ||
          (method === 'cw.state' && Object.prototype.hasOwnProperty.call(params, 'value'));
        return writes ? this.stateSet(moduleId, params) : this.stateGet(moduleId, params);
      }
      default:
        throw new AppError(501, 'unsupported_operation', `框架不提供 ${method}`);
    }
  }

  private async hostFetch(moduleId: string, params: Record<string, unknown>): Promise<unknown> {
    const session = params.session;
    const method = params.method;
    const url = params.url;
    if (typeof session !== 'string' || typeof method !== 'string' || typeof url !== 'string') {
      throw badRequest('cw.net.fetch 参数不完整', 'invalid_params');
    }
    const entry = this.sessions.resolveFetch(session, moduleId);
    const row = this.requireRow(moduleId);
    const manifest = JSON.parse(row.manifest) as Manifest;

    const stage = typeof params.stage === 'string' ? params.stage : 'read';
    if (stage !== 'read' && quietFor(this.db, entry.owner).active) {
      throw new AppError(409, 'quiet_hours', '夜间暂停期间不执行会改变平台状态的学习请求');
    }

    let target = url;
    let body: string | null = null;
    const encoding = typeof params.encoding === 'string' ? params.encoding : 'raw';
    const rawBody = params.body;
    if (encoding === 'json') body = JSON.stringify(rawBody ?? null);
    else if (encoding === 'form') body = new URLSearchParams(rawBody as Record<string, string>).toString();
    else if (encoding === 'query') {
      const query = new URLSearchParams(rawBody as Record<string, string>).toString();
      target = `${url}${url.includes('?') ? '&' : '?'}${query}`;
    } else if (typeof rawBody === 'string') body = rawBody;

    const headers: Record<string, string> = {};
    if (params.headers && typeof params.headers === 'object') {
      for (const [key, value] of Object.entries(params.headers as Record<string, unknown>)) {
        if (typeof value === 'string') headers[key] = value;
      }
    }
    if (body !== null && !headers['content-type'] && !headers['Content-Type']) {
      if (encoding === 'json') headers['Content-Type'] = 'application/json';
      if (encoding === 'form') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const commit = params.commit === true;
    const ledgerId = randomId();
    if (commit) {
      this.db.run(
        `INSERT INTO write_ledger(id,module,owner,stage,method,url,state,created_at)
         VALUES(?1,?2,?3,?4,?5,?6,'pending',?7)`,
        ledgerId,
        moduleId,
        entry.owner,
        stage,
        method.toUpperCase(),
        url,
        nowSeconds(),
      );
    }

    let outcome;
    try {
      outcome = await performFetch(
        { method: method.toUpperCase(), url: target, headers, body },
        {
          allow: manifest.permissions.network,
          cookies: entry.cookies,
          token: entry.token,
          now: nowSeconds(),
          binary: params.binary === true,
          signal: entry.job ? this.jobSignals.get(entry.job.id)?.signal : undefined,
          beforeRequest: () => {
            this.sessions.resolveFetch(session, moduleId);
            if (stage !== 'read' && quietFor(this.db, entry.owner).active) throw new AppError(409, 'quiet_hours', '夜间暂停期间不执行平台写入');
          },
        },
      );
    } catch (error) {
      if (commit) {
        this.db.run("UPDATE write_ledger SET state = 'unknown' WHERE id = ?1", ledgerId);
      }
      if (error instanceof NetError) throw new AppError(502, error.code, error.message);
      throw new AppError(502, 'platform_unavailable', `请求失败：${(error as Error).message}`);
    }

    entry.cookies = mergeCookies(entry.cookies, outcome.setCookies as Cookie[]);
    this.sessions.refresh(session);
    if (commit) {
      this.db.run("UPDATE write_ledger SET state = 'acknowledged' WHERE id = ?1", ledgerId);
    }

    const statusError = mapPlatformStatus(outcome.status);
    if (statusError) throw new AppError(409, statusError.code, statusError.message);

    this.log('debug', `[${moduleId}] ${method.toUpperCase()} ${new URL(target).host} → ${outcome.status}`);
    return { status: outcome.status, headers: outcome.headers, body: outcome.body };
  }

  /**
   * The platform identity a module learned at `auth.complete`, so a module can use it later
   * without the framework ever handing over a cookie. Spec §4.5.
   */
  private sessionIdentity(moduleId: string, params: Record<string, unknown>): unknown {
    const session = this.requireSessionParam(params);
    const entry = this.sessions.resolveFetch(session, moduleId);
    const stored = this.sessions.load(entry.owner, entry.platform);
    if (!stored) return { account_raw: '', display_name: '', connected_at: null };
    let userId = '';
    try { const raw = stored.cookies.find((c) => c.name === 'CASLOGC')?.value; if (raw) userId = String(JSON.parse(decodeURIComponent(raw)).userId ?? ''); } catch { /* 其他平台不需要此身份字段。 */ }
    return {
      account_raw: stored.account_raw,
      display_name: stored.display_name,
      connected_at: stored.connected_at,
      user_id: userId,
    };
  }

  private stateGet(moduleId: string, params: Record<string, unknown>): unknown {
    const session = this.requireSessionParam(params);
    const entry = this.sessions.resolveFetch(session, moduleId);
    const namespace = String(params.namespace ?? 'default');
    const key = String(params.key ?? '');
    const row = this.db.get<{ sealed: Uint8Array }>(
      'SELECT sealed FROM module_state WHERE module=?1 AND owner=?2 AND namespace=?3 AND state_key=?4',
      moduleId,
      entry.owner,
      namespace,
      key,
    );
    if (!row) return { value: null };
    const scope = `module/${moduleId}/${ownerDigest(entry.owner)}/${namespace}/${key}`;
    return { value: this.vault.openJson(entry.owner, scope, Buffer.from(row.sealed)) };
  }

  private stateSet(moduleId: string, params: Record<string, unknown>): unknown {
    const session = this.requireSessionParam(params);
    const entry = this.sessions.resolveFetch(session, moduleId);
    const namespace = String(params.namespace ?? 'default');
    const key = String(params.key ?? '');
    const scope = `module/${moduleId}/${ownerDigest(entry.owner)}/${namespace}/${key}`;
    const sealed = this.vault.sealJson(entry.owner, scope, params.value ?? null);
    this.db.run(
      `INSERT INTO module_state(module,owner,namespace,state_key,sealed,updated_at)
       VALUES(?1,?2,?3,?4,?5,?6)
       ON CONFLICT(module,owner,namespace,state_key) DO UPDATE SET sealed=excluded.sealed, updated_at=excluded.updated_at`,
      moduleId,
      entry.owner,
      namespace,
      key,
      new Uint8Array(sealed),
      nowSeconds(),
    );
    return {};
  }

  private requireSessionParam(params: Record<string, unknown>): string {
    if (typeof params.session !== 'string') throw badRequest('缺少会话标识', 'invalid_params');
    return params.session;
  }
}

function ownerDigest(owner: string): string {
  return digest(owner).slice(0, 16);
}

/**
 * Hash exactly the files the module declares, so a directory install and a packed `.tgz` of the
 * same module produce the same sha256.
 */
function hashFiles(root: string, relativePaths: string[]): string {
  const hash = createHash('sha256');
  const walk = (absolute: string, relative: string): void => {
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        walk(path.join(absolute, name), `${relative}/${name}`);
      }
      return;
    }
    hash.update(relative);
    hash.update(fs.readFileSync(absolute));
  };
  for (const relative of [...new Set(relativePaths)].sort()) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) continue;
    walk(absolute, relative);
  }
  return hash.digest('hex');
}
