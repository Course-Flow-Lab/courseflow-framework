import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { badRequest } from '../core/errors.ts';
import { nowSeconds } from '../core/domain.ts';
import type { Db } from '../core/db.ts';

const DAY = 86400;
const LIMIT = 20 * 1024 * 1024;
export type LogKind = 'app' | 'audit' | 'tasks';
type Entry = { time: number; level: string; message: string };

export function logRange(from: unknown, to: unknown) {
  const start = Number(from), end = Number(to);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || start >= end || end - start > 92 * DAY) {
    throw badRequest('请选择正确的时间段，最长 92 天');
  }
  return { start, end };
}

export function redactLog(value: unknown): string {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try { const url = new URL(raw); return url.origin + url.pathname; } catch { return '[地址已隐藏]'; }
    })
    .replace(/\bBearer\s+[^\s,;"'}]+/gi, 'Bearer [已隐藏]')
    .replace(/(["']?(?:cookie|set-cookie|authorization)["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[已隐藏]')
    .replace(/(["']?(?:password|passwd|secret|secret_key|api[_-]?key|access[_-]?token|refresh[_-]?token|csrf|cf_session)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1[已隐藏]')
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, 8000);
}
const dayText = (time: number) => new Date((time + 28800) * 1000).toISOString().slice(0, 10);
const line = (entry: Entry) => `[${new Date((entry.time + 28800) * 1000).toISOString().slice(0, 19).replace('T', ' ')} +08:00] ${entry.level.toUpperCase()} ${redactLog(entry.message)}\n`;
const overLimit = '\n……超过 20 MB，后续内容已省略，请缩短时间范围。\n';

/** 日志保存在私有数据目录；不保存请求体、Cookie、密钥或页面原始内容。 */
export class LogStore {
  private directory: string;
  constructor(dataDir: string) {
    this.directory = path.join(dataDir, 'logs');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  runtime(level: string, message: string, time = nowSeconds()): void { this.append('app', { time, level, message }); }
  audit(actor: string | null, action: string, fields: Record<string, string | number> = {}, time = nowSeconds()): void {
    this.append('audit', { time, level: 'info', message: JSON.stringify({ actor: actor ?? '未登录', action, ...fields }) });
  }
  private append(kind: 'app' | 'audit', entry: Entry): void {
    try {
      fs.appendFileSync(path.join(this.directory, `${kind}-${dayText(entry.time)}.jsonl`), JSON.stringify({ ...entry, message: redactLog(entry.message) }) + '\n', { mode: 0o600 });
    } catch { process.stderr.write('日志写入失败，请检查数据目录空间与权限。\n'); }
  }
  async export(kind: 'app' | 'audit', start: number, end: number): Promise<string> {
    const output: string[] = [];
    let size = 0;
    for (let day = Math.floor((start + 28800) / DAY); day <= Math.floor((end + 28800) / DAY); day++) {
      const file = path.join(this.directory, `${kind}-${dayText(day * DAY - 28800)}.jsonl`);
      if (!fs.existsSync(file)) continue;
      const stream = fs.createReadStream(file, { encoding: 'utf8' });
      const reader = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const raw of reader) {
          let entry: Entry;
          try { entry = JSON.parse(raw); } catch { continue; }
          if (!Number.isFinite(entry.time) || entry.time < start || entry.time > end || typeof entry.message !== 'string' || typeof entry.level !== 'string') continue;
          const text = line(entry);
          if (size + Buffer.byteLength(text) > LIMIT) return output.join('') + overLimit;
          output.push(text); size += Buffer.byteLength(text);
        }
      } finally { reader.close(); stream.destroy(); }
    }
    return output.join('') || '这段时间没有日志。\n';
  }
}

export function taskLogs(db: Db, start: number, end: number, scope: { owner?: string; task?: string } = {}): string {
  const parameters: (string | number)[] = [start, end];
  const conditions = ['e.created_at>=?1', 'e.created_at<=?2'];
  if (scope.owner) { parameters.push(scope.owner); conditions.push(`t.owner=?${parameters.length}`); }
  if (scope.task) { parameters.push(scope.task); conditions.push(`t.id=?${parameters.length}`); }
  const rows = db.raw.prepare(`SELECT e.created_at,e.task_id,e.kind,e.detail,t.platform,t.operation FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE ${conditions.join(' AND ')} ORDER BY e.created_at,e.id`).iterate(...parameters);
  const output: string[] = []; let size = 0;
  for (const row of rows) {
    const text = line({ time: Number(row.created_at), level: String(row.kind), message: `[${row.platform}/${row.operation}] 任务 ${row.task_id}：${row.detail}` });
    if (size + Buffer.byteLength(text) > LIMIT) return output.join('') + overLimit;
    output.push(text); size += Buffer.byteLength(text);
  }
  return output.join('') || '这段时间没有任务日志。\n';
}
