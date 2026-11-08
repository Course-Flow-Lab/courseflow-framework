import fs from 'node:fs';
import path from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Db } from './db.ts';
import { Vault } from './vault.ts';
import { hashPassword, validateCredentials } from './auth.ts';
import { digest, nowSeconds, randomId } from './domain.ts';
import { savePreferences } from './preferences.ts';
import { AiService } from '../services/ai.ts';

export type ImportOptions = { source: string; destination: string; keyFile?: string; dryRun?: boolean; username?: string; passwordFile?: string; legacyOwner?: string };
type LegacyUser = { id: string; username: string; password: string; role: string; disabled: number; created?: number; max_jobs?: number };
type Saved = Record<string, any>;
type FileRecord = { name: string; bytes: Buffer };
const json = (file: string): any => JSON.parse(read(file).toString('utf8'));
function read(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('旧数据含符号链接、非普通文件或超过 32 MB 的单个文件');
  return fs.readFileSync(file);
}
function settings(directory: string, owner: string, key?: Buffer): Saved {
  const encrypted = path.join(directory, 'settings.enc');
  let value: unknown;
  if (fs.existsSync(encrypted)) {
    if (!key) throw new Error('旧配置已加密，需要原始 secret.key 或 --key-file');
    try {
      const envelope = json(encrypted);
      if (envelope.v !== 1) throw new Error();
      const nonce = Buffer.from(envelope.nonce, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      if (![12, 16].includes(nonce.length) || tag.length !== 16) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(owner)); cipher.setAuthTag(tag);
      value = JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString('utf8'));
    } catch { throw new Error('无法解密旧配置，请核对原始主密钥；原文件未修改'); }
  } else value = fs.existsSync(path.join(directory, 'settings.json')) ? json(path.join(directory, 'settings.json')) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('旧配置不是有效对象');
  return value as Saved;
}
function files(directory: string): FileRecord[] {
  const found: FileRecord[] = [];
  const walk = (relative: string, depth = 0) => {
    const absolute = path.join(directory, relative);
    if (!fs.existsSync(absolute)) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || depth > 12) throw new Error('旧归档含符号链接或目录层级过深');
    if (stat.isDirectory()) for (const child of fs.readdirSync(absolute)) walk(path.join(relative, child), depth + 1);
    else found.push({ name: relative.split(path.sep).join('/'), bytes: read(absolute) });
    if (found.length > 20_000) throw new Error('旧归档超过两万个文件，请拆分迁移');
  };
  for (const name of ['jobs.json','zhs-qa-posts.json','zhs-answers.json','mooc-answers.json','ai_results','tiku','exports']) walk(name);
  if (found.reduce((size, file) => size + file.bytes.length, 0) > 512 * 1024 * 1024) throw new Error('单个用户归档超过 512 MB，请拆分迁移');
  return found;
}
function validateUser(user: LegacyUser): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(user.id) || !/^[\p{L}\p{N}_.-]{2,32}$/u.test(user.username) || !['admin','user'].includes(user.role)) throw new Error('旧账号编号、用户名或角色无法识别');
  if (!user.password.startsWith('$argon2id$')) {
    const match = /^pbkdf2_sha256\$(\d+)\$([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*)$/.exec(user.password);
    if (!match || +match[1]! < 10_000 || +match[1]! > 4_000_000 || !Buffer.from(match[2]!, 'base64').length || Buffer.from(match[3]!, 'base64').length !== 32) throw new Error('旧密码摘要格式不受支持');
  }
}
function legacyAnswers(connection: DatabaseSync) {
  const result: Record<string, unknown> = {};
  for (const table of ['zhs_answers','mooc_answers']) if (connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
    const rows = connection.prepare(`SELECT key,correct,wrong,updated FROM ${table}`).all() as Array<{key: string; correct: string | null; wrong: string; updated: string | null}>;
    result[table] = Object.fromEntries(rows.map((r) => [r.key, { correct: r.correct ? JSON.parse(r.correct) : null, wrong: JSON.parse(r.wrong), updated: r.updated }]));
  }
  return result;
}

/** 仅读旧目录，先完成验证，再原子发布一个全新目标目录；从不启动任务或平台请求。 */
export async function importStudia(options: ImportOptions) {
  const source = fs.realpathSync(options.source);
  const destination = path.resolve(options.destination);
  if (fs.existsSync(destination)) throw new Error('目标目录必须尚不存在，不能覆盖现有 Courseflow 数据');
  const parent = fs.realpathSync(path.dirname(destination));
  const actual = path.join(parent, path.basename(destination));
  if (actual === source || actual.startsWith(source + path.sep) || source.startsWith(actual + path.sep)) throw new Error('新旧数据目录必须分开');
  for (let current = parent; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) throw new Error('运行数据必须放在 Git 仓库之外');
    if (path.dirname(current) === current) break;
  }
  const keyPath = options.keyFile ?? path.join(source, 'secret.key');
  const keyRaw = fs.existsSync(keyPath) ? read(keyPath) : undefined;
  const key = keyRaw ? Buffer.from(keyRaw.toString('utf8').trim(), 'base64url') : undefined;
  if (key && key.length !== 32) throw new Error('旧主密钥格式不正确，应为 Studia 的 32 字节 base64url 密钥');
  const database = path.join(source, 'studia.db');
  let users: LegacyUser[];
  let sharedAnswers: Record<string, unknown> = {};
  const hosted = fs.existsSync(database);
  if (hosted) {
    const legacy = new DatabaseSync(database, { readOnly: true });
    try {
      users = legacy.prepare('SELECT * FROM users ORDER BY id').all() as unknown as LegacyUser[];
      sharedAnswers = legacyAnswers(legacy);
    } finally { legacy.close(); }
  } else if (fs.existsSync(path.join(source, 'accounts.json'))) {
    const value = json(path.join(source, 'accounts.json'));
    users = Object.entries(value.users ?? {}).map(([id, value]) => ({ ...(value as LegacyUser), id }));
  } else {
    if (!options.username || (!options.passwordFile && !options.dryRun)) throw new Error('本机配置迁移需要 --username 和 --password-file 创建站点管理员');
    const password = options.passwordFile ? read(options.passwordFile).toString('utf8').replace(/\r?\n$/, '') : 'synthetic-dry-run-password';
    validateCredentials(options.username, password);
    users = [{ id: randomId(), username: options.username, password: await hashPassword(password), role: 'admin', disabled: 0 }];
  }
  if (!users.length || !users.some((u) => u.role === 'admin' && !u.disabled)) throw new Error('旧数据没有可用管理员，已停止迁移');
  const names = new Set<string>();
  const entries = users.map((user) => {
    validateUser(user);
    const name = user.username.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (names.has(name)) throw new Error('旧用户名存在大小写冲突，请先在旧系统处理');
    names.add(name);
    const directory = hosted || fs.existsSync(path.join(source, 'accounts.json')) ? path.join(source, 'users', user.id) : source;
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('旧用户目录不能是符号链接');
    const saved = settings(directory, hosted ? user.id : options.legacyOwner ?? user.id, key);
    return { user, directory, saved, archives: files(directory) };
  });
  const shared = settings(path.join(source, 'shared-model'), 'site-shared-model', key);
  const report = { users: users.length, archived_files: entries.reduce((n,e) => n + e.archives.length,0), personal_models: 0, shared_models: 0, archived_models: 0, platform_sessions: '仅加密封存，需重新连接平台', historical_tasks: '只读归档，不自动执行', dry_run: Boolean(options.dryRun) };
  if (options.dryRun) {
    const candidates = entries.reduce((n,e) => n + (Array.isArray(e.saved.ai_profiles?.items) ? e.saved.ai_profiles.items : e.saved.ai ? [e.saved.ai] : []).filter((p: Saved) => p.id !== 'builtin-default').length, 0);
    return { users: report.users, archived_files: report.archived_files, model_candidates: candidates, platform_sessions: report.platform_sessions, historical_tasks: report.historical_tasks, dry_run: true };
  }
  const staging = fs.mkdtempSync(path.join(parent, '.courseflow-studia-import-'));
  fs.chmodSync(staging, 0o700);
  let db: Db | undefined;
  try {
    const dbPath = path.join(staging, 'courseflow.db');
    fs.writeFileSync(dbPath, '', { mode: 0o600, flag: 'wx' });
    db = new Db(dbPath);
    const vault = Vault.open(path.join(staging, 'secret.key'), false);
    const ai = new AiService(db, vault);
    const now = nowSeconds();
    const seal = (owner: string, scope: string, value: unknown) => db!.run('INSERT INTO secrets VALUES(?1,?2,?3,?4)', owner, scope, new Uint8Array(vault.sealJson(owner, scope, value)), now);
    const modelProfiles = (saved: Saved): Saved[] => Array.isArray(saved.ai_profiles?.items) ? saved.ai_profiles.items : saved.ai ? [{ ...saved.ai, id: 'legacy' }] : [];
    const saveModel = (owner: string, profile: Saved, shared: boolean): string | null => {
      if (profile.id === 'builtin-default') return null;
      try {
        return ai.save(owner, { name: String(profile.provider_name || profile.name || '已导入模型'), base_url: profile.base_url, model: profile.model, api_key: profile.api_key, api_format: profile.api_format || 'auto', enabled: profile.enabled !== false, shared }).id;
      } catch { report.archived_models += 1; return null; }
    };
    db.transaction(() => {
      for (const { user } of entries) db!.run('INSERT INTO users(id,username,password_hash,role,disabled,created_at) VALUES(?1,?2,?3,?4,?5,?6)', user.id,user.username,user.password,user.role,user.disabled ? 1 : 0,Math.floor(user.created ?? now));
      const admin = users.find((u) => u.role === 'admin' && !u.disabled)!;
      const sharedProfile = modelProfiles(shared).find((p) => p.id === shared.ai_profiles?.active_id) ?? shared.ai ?? shared.config;
      const sharedModel = sharedProfile && shared.enabled === true ? saveModel(admin.id, sharedProfile, true) : null;
      if (sharedModel) report.shared_models += 1;
      for (const { user, directory, saved, archives } of entries) {
        seal(user.id, 'legacy/studia/settings', saved);
        const answers: Saved = { ...sharedAnswers };
        const models = new Map<string, string>();
        for (const profile of modelProfiles(saved)) { const id = saveModel(user.id, profile, false); if (id) { models.set(String(profile.id), id); report.personal_models += 1; } }
        const selected = saved.use_shared_model === true ? sharedModel : models.get(String(saved.ai_profiles?.active_id ?? 'legacy'));
        savePreferences(db!, user.id, { concurrency: Math.max(1, Math.min(8, Number(saved.concurrency?.study) || 1)), parallel_study: saved.zhs_parallel_study === true, speedup: saved.zhs_speedup === true, quiet_hours: saved.quiet_hours !== false, qa_peers: fs.existsSync(path.join(directory, 'qa-peers.on')), model_id: selected ?? null });
        for (const archive of archives) {
          const scope = `legacy/studia/file/${digest(archive.name)}`;
          db!.run('INSERT INTO secrets VALUES(?1,?2,?3,?4)', user.id, scope, new Uint8Array(vault.seal(user.id,scope,archive.bytes)),now);
          if (['zhs-answers.json','mooc-answers.json'].includes(archive.name)) {
            const value = JSON.parse(archive.bytes.toString('utf8'));
            const table = archive.name.startsWith('zhs') ? 'zhs_answers' : 'mooc_answers';
            answers[table] = { ...(answers[table] ?? {}), ...(value.items ?? {}) };
          }
        }
        seal(user.id, 'legacy/studia/answers', answers);
        seal(user.id, 'legacy/studia/manifest', { source: 'studia', imported_at: now, files: archives.map((a) => ({ name: a.name, size: a.bytes.length })), sessions_require_login: true, jobs_archived: true });
      }
    });
    db.close(); db = undefined;
    fs.mkdirSync(path.join(staging,'modules'), { mode: 0o700 });
    fs.writeFileSync(path.join(staging,'migration-report.json'), JSON.stringify(report,null,2)+'\n', { mode: 0o600 });
    fs.renameSync(staging, actual);
    return report;
  } catch (error) {
    db?.close(); fs.rmSync(staging, { recursive: true, force: true }); throw error;
  }
}

export function studiaArchive(db: Db, vault: Vault, owner: string, name?: string): unknown {
  const scope = name ? `legacy/studia/file/${digest(name)}` : 'legacy/studia/manifest';
  const row = db.get<{ sealed: Uint8Array }>('SELECT sealed FROM secrets WHERE owner=?1 AND scope=?2', owner, scope);
  if (!row) return null;
  return name ? vault.open(owner, scope, Buffer.from(row.sealed)) : vault.openJson(owner, scope, Buffer.from(row.sealed));
}
