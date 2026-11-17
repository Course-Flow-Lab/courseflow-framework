import { Agent, fetch } from 'undici';
import { AppError, badGateway, badRequest, conflict } from '../core/errors.ts';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
type Waiter = { resolve: () => void; reject: (error: unknown) => void; signal: AbortSignal; abort: () => void };

/** Shared, local ddddocr backend. Images stay in memory; platform cookies never enter it. */
export class CaptchaService {
  private url?: string;
  private dispatcher = new Agent();
  private timeoutMs: number;
  private active = false;
  private waiting: Waiter[] = [];
  private stopping = new AbortController();
  private operations = new Set<Promise<unknown>>();
  private closing?: Promise<void>;

  constructor(options: { url?: string; timeoutMs?: number } = {}) {
    const value = options.url?.trim();
    if (value) {
      let url: URL;
      try { url = new URL(value); } catch { throw new Error('CF_CAPTCHA_URL 不是合法地址'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('CF_CAPTCHA_URL 必须是无凭据、查询或片段的 HTTP(S) 地址');
      }
      this.url = url.href.replace(/\/+$/, '');
    }
    this.timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs! > 0
      ? Math.min(options.timeoutMs!, 20_000) : 10_000;
  }

  available(): boolean { return Boolean(this.url); }

  recognize(method: 'ocr' | 'slide_match', params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const operation = this.run(method, params, AbortSignal.any([
      this.stopping.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : []),
    ]));
    this.operations.add(operation);
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }

  shutdown(): Promise<void> {
    return this.closing ??= (async () => {
      this.stopping.abort();
      await Promise.allSettled(this.operations);
      await this.dispatcher.close();
    })();
  }

  private image(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw badRequest('验证码图片须为不超过 2 MiB 的 Base64 数据');
    }
    const image = Buffer.from(value, 'base64');
    if (!image.length || image.length > MAX_IMAGE_BYTES) throw badRequest('验证码图片为空或超过 2 MiB');
    return value;
  }

  private async run(method: 'ocr' | 'slide_match', params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    let acquired = false;
    try {
      signal.throwIfAborted();
      if (!this.url) throw conflict('captcha_unavailable', '服务器未配置验证码识别服务');
      const body = method === 'ocr' ? { image: this.image(params.image) } : {
        target_image: this.image(params.target_image), background_image: this.image(params.background_image),
        simple_target: params.simple_target === true,
      };
      await this.acquire(signal);
      acquired = true;
      signal.throwIfAborted();
      // Use a dedicated dispatcher: the platform proxy must not receive local captcha images.
      const response = await fetch(`${this.url}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        dispatcher: this.dispatcher, signal, redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw badGateway('captcha_backend_error', '验证码识别服务拒绝了请求');
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body!) {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) throw badGateway('captcha_backend_error', '验证码识别服务响应过大');
        chunks.push(chunk);
      }
      let result: any;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')).result; }
      catch { throw badGateway('captcha_backend_error', '验证码识别服务响应格式无效'); }
      if (method === 'ocr') {
        if (typeof result !== 'string' || !result.trim() || result.length > 512) {
          throw badGateway('captcha_backend_error', '验证码识别没有返回有效文字');
        }
        return { text: result.trim() };
      }
      const coordinate = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 4096;
      if (!Array.isArray(result?.target) || result.target.length !== 4 || !result.target.every(coordinate) ||
        !coordinate(result.target_x) || !coordinate(result.target_y) ||
        result.target[2] <= result.target[0] || result.target[3] <= result.target[1]) {
        throw badGateway('captcha_backend_error', '滑块识别没有返回有效坐标');
      }
      return { target: result.target, target_x: result.target_x, target_y: result.target_y };
    } catch (error) {
      if (signal.aborted) {
        const timeout = signal.reason?.name === 'TimeoutError';
        throw new AppError(timeout ? 504 : 409, timeout ? 'captcha_timeout' : 'captcha_cancelled', timeout ? '验证码识别超时' : '验证码识别已取消');
      }
      if (error instanceof AppError) throw error;
      throw badGateway('captcha_backend_error', '验证码识别服务暂不可用');
    } finally {
      if (acquired) this.release();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    // ddddocr instances have mutable model state; serialize requests across platform modules.
    if (!this.active) { this.active = true; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, abort: () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      } };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(); }
    else this.active = false;
  }
}
