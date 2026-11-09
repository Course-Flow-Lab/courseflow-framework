import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError, badGateway, badRequest, conflict } from '../core/errors.ts';

export type AsrOptions = {
  /** OpenAI-compatible transcription endpoint, e.g. https://asr.example.com/v1 */
  url?: string;
  /** Command template; `{input}` is the audio path and `{output}` an optional JSON result path. */
  command?: string;
  model?: string;
  timeoutMs?: number;
  maxBytes?: number;
  concurrency?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 6 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 2;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Host-side speech-to-text. Modules never spawn processes or write files: they hand audio
 * bytes to `cw.asr.transcribe` and the host runs a configured backend.
 */
export class AsrService {
  private url?: string;
  private command?: string;
  private model: string;
  private timeoutMs: number;
  private maxBytes: number;
  private limit: number;
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(options: AsrOptions = {}) {
    const url = String(options.url ?? '').trim();
    const command = String(options.command ?? '').trim();
    this.url = url ? url.replace(/\/+$/, '') : undefined;
    this.command = command || undefined;
    this.model = String(options.model ?? '').trim() || 'base.en';
    this.timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    this.maxBytes = Number.isFinite(options.maxBytes) && Number(options.maxBytes) > 0
      ? Number(options.maxBytes)
      : DEFAULT_MAX_BYTES;
    this.limit = Number.isInteger(options.concurrency) && Number(options.concurrency) > 0
      ? Number(options.concurrency)
      : DEFAULT_CONCURRENCY;
  }

  available(): boolean {
    return Boolean(this.url || this.command);
  }

  describe(): { available: boolean; backend: 'http' | 'command' | null; model: string } {
    return {
      available: this.available(),
      backend: this.url ? 'http' : this.command ? 'command' : null,
      model: this.model,
    };
  }

  async transcribe(audio: Buffer, mime = 'audio/mpeg'): Promise<string> {
    if (!this.available()) {
      throw conflict('asr_unavailable', '服务器未配置语音转写服务');
    }
    if (!audio || audio.length === 0) throw badRequest('音频为空');
    if (audio.length > this.maxBytes) {
      throw badRequest(`音频超过 ${Math.round(this.maxBytes / 1024 / 1024)}MB 上限`);
    }
    await this.acquire();
    try {
      const text = this.url ? await this.viaHttp(audio, mime) : await this.viaCommand(audio);
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
      if (!clean) throw badGateway('asr_empty', '语音转写没有返回文字');
      return clean;
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiting.shift();
    if (next) next();
  }

  private endpoint(): string {
    const base = this.url!;
    return /\/audio\/transcriptions$/.test(base) ? base : `${base}/audio/transcriptions`;
  }

  private async viaHttp(audio: Buffer, mime: string): Promise<string> {
    const extension = mime.includes('wav') ? 'wav' : mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : 'mp3';
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime }), `audio.${extension}`);
    form.append('model', this.model);
    let response: Response;
    try {
      response = await fetch(this.endpoint(), {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AppError(502, 'asr_unavailable', '语音转写服务连接失败或超时');
    }
    const raw = await response.text();
    if (raw.length > MAX_OUTPUT_BYTES) throw badGateway('asr_failed', '语音转写响应过大');
    if (!response.ok) {
      const message = ({ 401: '语音转写服务鉴权失败', 403: '语音转写服务拒绝访问', 429: '语音转写服务限流' } as Record<number, string>)[response.status]
        ?? `语音转写服务请求失败（HTTP ${response.status}）`;
      throw new AppError(502, 'asr_failed', message);
    }
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return raw;
    }
    return String(data?.text ?? data?.result ?? data?.data?.text ?? '');
  }

  private async viaCommand(audio: Buffer): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courseflow-asr-'));
    const input = path.join(dir, 'audio.mp3');
    const output = path.join(dir, 'result.json');
    try {
      fs.writeFileSync(input, audio, { mode: 0o600 });
      const usesOutput = this.command!.includes('{output}');
      const line = this.command!
        .replaceAll('{input}', quote(input))
        .replaceAll('{output}', quote(output));
      const result = await this.run(line);
      if (usesOutput && fs.existsSync(output)) {
        const raw = fs.readFileSync(output, 'utf8');
        return this.readResult(raw);
      }
      return this.readResult(result.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  private readResult(raw: string): string {
    const text = String(raw ?? '').trim();
    if (!text) return '';
    try {
      const data = JSON.parse(text);
      if (typeof data === 'string') return data;
      return String(data?.text ?? data?.result ?? data?.data?.text ?? '');
    } catch {
      return text;
    }
  }

  private run(line: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(line, { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new AppError(504, 'asr_timeout', '语音转写超时'));
      }, this.timeoutMs);
      child.stdout.on('data', (chunk) => {
        stdout = (stdout + String(chunk)).slice(-MAX_OUTPUT_BYTES);
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-4096);
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new AppError(502, 'asr_unavailable', `语音转写命令启动失败：${error.message}`));
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new AppError(502, 'asr_failed', `语音转写命令退出码 ${code}${stderr ? `：${stderr.slice(-200)}` : ''}`));
      });
    });
  }
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
