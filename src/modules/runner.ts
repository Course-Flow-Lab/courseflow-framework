import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DescribeResult,
  Manifest,
  RpcMessage,
  RpcRequest,
  RpcResponse,
} from './protocol.ts';
import { CALL_TIMEOUT_MS, DESCRIBE_TIMEOUT_MS, MODULE_API } from './protocol.ts';
import { LineChannel } from './rpc.ts';
import { AppError, fromModuleError } from '../errors.ts';

export const FRAMEWORK_VERSION = '0.1.0';

export type HostCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type RunnerInit = {
  manifest: Manifest;
  dir: string;
  settings: Record<string, unknown>;
  callHost: HostCall;
  onExit: (runner: ModuleRunner, error: Error) => void;
  log: (level: string, message: string) => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const MAX_OVERRUNS = 2;

/**
 * One child process, one NDJSON channel. Requests are multiplexed; host calls from the module are
 * answered concurrently so a handler awaiting `cw.net.fetch` cannot deadlock the reader (spec §7).
 */
export class ModuleRunner {
  readonly id: string;
  readonly version: string;
  readonly manifest: Manifest;
  private dir: string;
  private settings: Record<string, unknown>;
  private callHost: HostCall;
  private onExit: RunnerInit['onExit'];
  private log: (level: string, message: string) => void;
  private child: ChildProcess | undefined;
  private channel: LineChannel | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private describeResult: DescribeResult | undefined;
  private overruns = 0;
  private stopping = false;
  private startedAt = 0;

  constructor(init: RunnerInit) {
    this.manifest = init.manifest;
    this.id = init.manifest.id;
    this.version = init.manifest.version;
    this.dir = init.dir;
    this.settings = init.settings;
    this.callHost = init.callHost;
    this.onExit = init.onExit;
    this.log = init.log;
  }

  get alive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.stopping;
  }

  get describe(): DescribeResult | undefined {
    return this.describeResult;
  }

  get uptimeSeconds(): number {
    return this.startedAt === 0 ? 0 : Math.floor(Date.now() / 1000) - this.startedAt;
  }

  async start(): Promise<DescribeResult> {
    if (this.describeResult) return this.describeResult;
    const entryPath = path.join(this.dir, this.manifest.runtime.entry);
    if (!fs.existsSync(entryPath)) {
      throw new AppError(502, 'module_unavailable', `模块入口不存在：${this.manifest.runtime.entry}`);
    }
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TZ: 'UTC',
      CF_MODULE_ID: this.id,
      CF_MODULE_SETTINGS: JSON.stringify(this.settings),
    };
    const args =
      this.manifest.runtime.engine === 'node'
        ? ['--permission', `--allow-fs-read=${this.dir}`, '--max-old-space-size=512', entryPath]
        : [];
    const command = this.manifest.runtime.engine === 'node' ? process.execPath : entryPath;
    const child = spawn(command, args, {
      cwd: this.dir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stopping = false;
    this.startedAt = Math.floor(Date.now() / 1000);
    this.channel = new LineChannel(child.stdout!, child.stdin!, (line) => this.onLine(line), (error) =>
      this.failAll(error),
    );
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.log('debug', line.trimEnd());
      }
    });
    child.on('error', (error) => {
      this.failAll(new AppError(502, 'module_crashed', `模块启动失败：${error.message}`));
      this.describeResult = undefined;
    });
    child.on('exit', (code, signal) => {
      const reason = this.stopping
        ? '模块已停止'
        : `模块进程退出（code=${String(code)}, signal=${String(signal)}）`;
      this.channel?.dispose();
      this.channel = undefined;
      this.child = undefined;
      this.failAll(new AppError(502, 'module_crashed', reason));
      if (this.stopping) return;
      this.describeResult = undefined;
      this.onExit(this, new Error(reason));
    });

    const result = (await this.call(
      'platform.describe',
      {
        module_api: MODULE_API,
        framework_version: FRAMEWORK_VERSION,
        limits: { call_timeout_ms: CALL_TIMEOUT_MS },
      },
      DESCRIBE_TIMEOUT_MS,
    )) as DescribeResult;
    this.assertDescribe(result);
    this.describeResult = result;
    this.overruns = 0;
    return result;
  }

  private assertDescribe(result: DescribeResult): void {
    if (!result || typeof result !== 'object') {
      throw new AppError(502, 'module_protocol_error', '模块 describe 结果不是对象');
    }
    if (result.module?.module_api !== MODULE_API) {
      throw new AppError(
        502,
        'module_api_mismatch',
        `模块报告 module_api ${String(result.module?.module_api)}，本服务支持 ${MODULE_API}`,
      );
    }
    if (result.platform?.id !== this.id) {
      throw new AppError(
        502,
        'module_protocol_error',
        `模块 describe 返回的平台 ${String(result.platform?.id)} 与清单 ${this.id} 不一致`,
      );
    }
  }

  call(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    if (!this.channel || !this.alive) {
      return Promise.reject(new AppError(503, 'module_unavailable', `模块 ${this.id} 未运行`));
    }
    const id = this.nextId++;
    const payload: RpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.overruns += 1;
        if (this.overruns >= MAX_OVERRUNS) {
          this.kill(`模块 ${this.id} 连续超时，已终止`);
        }
        reject(
          new AppError(504, 'module_timeout', `模块 ${this.id} 在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.channel?.write(JSON.stringify(payload));
    });
  }

  private onLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.log('warn', `模块 ${this.id} 输出了非 JSON 内容，已忽略`);
      return;
    }
    if ('result' in message || 'error' in message) {
      const response = message as RpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if ('error' in response) pending.reject(fromModuleError(response.error));
      else pending.resolve(response.result);
      return;
    }
    const request = message as RpcRequest;
    if (typeof request.method !== 'string') return;
    if (typeof request.id !== 'number') {
      this.onNotification(request.method, request.params);
      return;
    }
    void this.handleHostRequest(request);
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'cw.log') return;
    const payload = (params ?? {}) as { level?: unknown; message?: unknown };
    const level = typeof payload.level === 'string' ? payload.level : 'info';
    const message = typeof payload.message === 'string' ? payload.message : '';
    if (message) this.log(level, message);
  }

  private async handleHostRequest(request: RpcRequest): Promise<void> {
    try {
      const result = await this.callHost(
        request.method,
        (request.params ?? {}) as Record<string, unknown>,
      );
      this.channel?.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: result ?? {} }));
    } catch (error) {
      const shape =
        error instanceof AppError
          ? { code: error.code, message: error.message }
          : { code: 'module_error', message: (error as Error).message };
      this.channel?.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: shape }));
    }
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private kill(reason: string): void {
    this.log('error', reason);
    this.child?.kill('SIGKILL');
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.describeResult = undefined;
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done();
      }, 5000);
      child.once('exit', done);
      child.kill('SIGTERM');
    });
    this.channel?.dispose();
    this.channel = undefined;
    this.child = undefined;
    this.failAll(new AppError(503, 'module_unavailable', `模块 ${this.id} 已停止`));
  }
}
