import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomId } from '../core/domain.ts';
import { AppError, badRequest, conflict, notFound } from '../core/errors.ts';
import type { Live } from '../core/sessions.ts';
import { allowedHost, type Cookie } from '../modules/net.ts';

/** CDP 用前导点表示域 Cookie。旧数据未记录 host_only，沿用宿主原有的域匹配语义。 */
export function browserCookies(jar: Cookie[], allow: string[], now = Math.floor(Date.now() / 1000)) {
  return jar.filter((cookie) => allowedHost(allow, cookie.domain.replace(/^\./, '')) &&
    (!cookie.expires_at || cookie.expires_at <= 0 || cookie.expires_at > now)).map((cookie) => ({
      name: cookie.name, value: cookie.value,
      domain: (cookie.host_only === true ? '' : '.') + cookie.domain.replace(/^\./, ''),
      path: cookie.path || '/', secure: cookie.secure, httpOnly: cookie.http_only,
      ...(cookie.expires_at && cookie.expires_at > 0 ? { expires: cookie.expires_at } : {}),
    }));
}

type Event = { method: string; params: any; sessionId?: string };
class Cdp {
  private socket: WebSocket;
  private next = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  onEvent: (event: Event) => void = () => {};
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      let message: any;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id) {
        const call = this.pending.get(message.id);
        if (!call) return;
        clearTimeout(call.timer); this.pending.delete(message.id);
        if (message.error) call.reject(conflict('browser_protocol_error', '官方浏览器操作未能完成'));
        else call.resolve(message.result ?? {});
      } else this.onEvent(message);
    });
    socket.addEventListener('close', () => this.close());
  }
  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(conflict('browser_unavailable', 'Chromium 调试连接超时')); }, 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(conflict('browser_unavailable', 'Chromium 调试连接失败')); }, { once: true });
    });
    return new Cdp(socket);
  }
  call(method: string, params: any = {}, sessionId?: string, timeoutMs = 20_000): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(conflict('browser_timeout', '官方页面操作超时，请稍后继续')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(conflict('browser_closed', '官方浏览器已关闭')); }
    });
  }
  close(): void {
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(conflict('browser_closed', '官方浏览器已关闭')); }
    this.pending.clear();
    if (this.socket.readyState < 2) this.socket.close();
  }
}

type Page = { id: string; owner: string; platform: string; connectionId?: string; jobId?: string; generation?: number; child: ChildProcess; cdp: Cdp; sessionId: string; profile: string; allow: string[]; touched: number; observed: Record<string, unknown>; pendingObserved: Map<string, { path: string; status: number }> };

/** 每个页面使用独立的无痕浏览器上下文，任务结束或暂停时立即关闭。 */
export class BrowserService {
  private pages = new Map<string, Page>();
  private directory: string;
  private executable: string;
  private timer: NodeJS.Timeout;
  constructor(dataDir: string, executable = process.env.CF_CHROMIUM ?? '/usr/bin/chromium') {
    this.directory = path.join(dataDir, 'browser-runtime');
    this.executable = executable;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.timer = setInterval(() => {
      for (const page of this.pages.values()) if (!page.jobId && Date.now() - page.touched > 90_000) void this.close(page.id);
    }, 30_000);
    this.timer.unref();
  }
  available(): boolean { return fs.existsSync(this.executable); }
  private require(id: string, entry: Live): Page {
    const page = this.pages.get(id);
    if (!page || page.owner !== entry.owner || page.platform !== entry.platform || page.connectionId !== entry.connectionId || page.jobId !== entry.job?.id || page.generation !== entry.job?.generation) throw notFound('官方浏览器页面已失效，请重新打开');
    page.touched = Date.now();
    return page;
  }
  async open(entry: Live, allow: string[], input: Record<string, unknown>, check: () => void = () => {}) {
    if (!this.available()) throw conflict('browser_unavailable', '未找到 Chromium，请设置 CF_CHROMIUM 后重启服务');
    const url = typeof input.url === 'string' ? input.url : '';
    let target: URL;
    try { target = new URL(url); } catch { throw badRequest('官方页面地址无效'); }
    if (target.protocol !== 'https:' || !allowedHost(allow, target.hostname) || target.username || target.password) throw badRequest('官方页面超出模块网络权限');
    if (this.pages.size >= 4) throw conflict('browser_limit', '官方浏览器页面已达到并发上限，请稍后继续');
    const profile = fs.mkdtempSync(path.join(this.directory, 'page-'));
    const child = spawn(this.executable, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-background-networking', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let cdp: Cdp | undefined;
    try {
      const socketUrl = await new Promise<string>((resolve, reject) => {
        let tail = '';
        const timer = setTimeout(() => reject(conflict('browser_unavailable', 'Chromium 启动超时')), 10_000);
        child.once('error', () => { clearTimeout(timer); reject(conflict('browser_unavailable', 'Chromium 启动失败')); });
        child.once('exit', () => { clearTimeout(timer); reject(conflict('browser_unavailable', 'Chromium 已退出')); });
        child.stderr!.on('data', (chunk) => {
          tail = (tail + String(chunk)).slice(-4096);
          const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/.exec(tail);
          if (match) { clearTimeout(timer); resolve(match[1]!); }
        });
      });
      cdp = await Cdp.connect(socketUrl);
      const { browserContextId } = await cdp.call('Target.createBrowserContext');
      const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank', browserContextId });
      const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
      await cdp.call('Page.enable', {}, sessionId);
      await cdp.call('Network.enable', {}, sessionId);
      await cdp.call('Runtime.enable', {}, sessionId);
      const cookies = browserCookies(entry.cookies, allow);
      if (cookies.length) await cdp.call('Network.setCookies', { cookies }, sessionId);
      const page: Page = { id: randomId(), owner: entry.owner, platform: entry.platform, connectionId: entry.connectionId, jobId: entry.job?.id, generation: entry.job?.generation, child, cdp, sessionId, profile, allow, touched: Date.now(), observed: {}, pendingObserved: new Map() };
      this.pages.set(page.id, page);
      const patterns = Array.isArray(input.observe_urls) ? input.observe_urls.filter((s): s is string => typeof s === 'string' && s.startsWith('/') && s.length < 150).slice(0, 10) : [];
      cdp.onEvent = (event) => { if (event.sessionId === sessionId) void this.observe(page, patterns, event).catch(() => {}); };
      child.once('exit', () => { this.pages.delete(page.id); cdp!.close(); fs.rmSync(profile, { recursive: true, force: true }); });
      check();
      await cdp.call('Page.navigate', { url }, sessionId);
      check();
      return { page: page.id };
    } catch (error) {
      for (const [id, page] of this.pages) if (page.child === child) this.pages.delete(id);
      cdp?.close(); child.kill('SIGTERM');
      fs.rmSync(profile, { recursive: true, force: true });
      throw error;
    }
  }
  private async observe(page: Page, patterns: string[], event: Event) {
    if (event.method === 'Network.responseReceived' && event.params.response?.url?.startsWith('https:')) {
      const response = event.params.response;
      const pathname = new URL(response.url).pathname;
      const pattern = patterns.find((p) => pathname.endsWith(p));
      if (pattern) page.pendingObserved.set(event.params.requestId, { path: pattern, status: response.status });
    } else if (event.method === 'Network.loadingFinished') {
      const pending = page.pendingObserved.get(event.params.requestId);
      if (!pending) return;
      page.pendingObserved.delete(event.params.requestId);
      const { body } = await page.cdp.call('Network.getResponseBody', { requestId: event.params.requestId }, page.sessionId);
      let parsed: any;
      try { parsed = JSON.parse(body); } catch { page.observed[pending.path] = { error: '平台观看记录响应无法解析' }; return; }
      const code = String(parsed.status ?? parsed.code ?? '');
      const error = pending.status >= 400 || parsed.success === false || !['', '0', '200'].includes(code);
      page.observed[pending.path] = { loaded: !error, ...(error ? { code: ['401', '403'].includes(code) || [401, 403].includes(pending.status) ? 'platform_login_expired' : 'platform_verification_required', error: ['401', '403'].includes(code) || [401, 403].includes(pending.status) ? '平台登录已过期' : '平台观看记录读取或保存失败，请核对验证提示' } : {}) };
    }
  }
  async evaluate(entry: Live, id: string, expression: string): Promise<unknown> {
    const page = this.require(id, entry);
    if (expression.length > 2_000_000) throw badRequest('官方页面脚本过长');
    const location = await page.cdp.call('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, page.sessionId);
    const url = new URL(location.result?.value || 'about:blank');
    if (url.href === 'about:blank') return { loading: true };
    if (url.protocol !== 'https:' || !allowedHost(page.allow, url.hostname)) throw conflict('platform_login_expired', '官方页面已跳转，请重新连接平台');
    await page.cdp.call('Runtime.evaluate', { expression: `window.__courseflowObserved=${JSON.stringify(page.observed)}` }, page.sessionId);
    const value = await page.cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 42_000 }, page.sessionId, 45_000);
    if (value.exceptionDetails) throw new AppError(502, 'browser_page_error', '官方页面尚未就绪或操作失败，请稍后继续');
    const result = value.result?.value ?? null;
    if (JSON.stringify(result).length > 4_000_000) throw conflict('browser_page_error', '官方页面返回内容过大');
    return result;
  }
  async close(id: string): Promise<void> {
    const page = this.pages.get(id);
    if (!page) return;
    this.pages.delete(id); page.cdp.close(); page.child.kill('SIGTERM');
    const timer = setTimeout(() => page.child.kill('SIGKILL'), 3000); timer.unref();
    if (page.child.exitCode === null && page.child.signalCode === null) await new Promise<void>((resolve) => page.child.once('exit', () => resolve()));
    clearTimeout(timer); fs.rmSync(page.profile, { recursive: true, force: true });
  }
  cancelJob(id: string): Promise<unknown[]> { return Promise.all([...this.pages.values()].filter((p) => p.jobId === id).map((p) => this.close(p.id))); }
  async closeOwned(entry: Live, id: string): Promise<void> { this.require(id, entry); await this.close(id); }
  async shutdown(): Promise<void> { clearInterval(this.timer); await Promise.all([...this.pages.keys()].map((id) => this.close(id))); }
}
