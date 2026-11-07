export class NetError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NetError';
    this.code = code;
  }
}

export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  http_only: boolean;
  expires_at?: number | null;
};

const BLOCKED_REQUEST_HEADERS = new Set(['cookie', 'host', 'content-length', 'connection', 'transfer-encoding']);

export function allowedHost(patterns: string[], host: string): boolean {
  const target = host.toLowerCase();
  return patterns.some((pattern) => {
    const suffix = pattern.toLowerCase();
    if (suffix.startsWith('*.')) {
      const base = suffix.slice(2);
      return target === base || target.endsWith(`.${base}`);
    }
    return target === suffix || target.endsWith(`.${suffix}`);
  });
}

function domainMatches(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.toLowerCase().replace(/^\./, '');
  const target = host.toLowerCase();
  return target === domain || target.endsWith(`.${domain}`);
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  const prefix = cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`;
  return requestPath.startsWith(prefix);
}

export function cookieHeaderFor(jar: Cookie[], url: URL, now: number): string {
  const path = url.pathname === '' ? '/' : url.pathname;
  const pairs: string[] = [];
  for (const cookie of jar) {
    if (cookie.expires_at && cookie.expires_at > 0 && cookie.expires_at <= now) continue;
    if (cookie.secure && url.protocol !== 'https:') continue;
    if (!domainMatches(cookie.domain, url.hostname)) continue;
    if (!pathMatches(cookie.path || '/', path)) continue;
    pairs.push(`${cookie.name}=${cookie.value}`);
  }
  return pairs.join('; ');
}

export function parseSetCookie(header: string, url: URL): Cookie | undefined {
  const [pair, ...attributes] = header.split(';').map((part) => part.trim());
  if (!pair) return undefined;
  const separator = pair.indexOf('=');
  if (separator <= 0) return undefined;
  const cookie: Cookie = {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
    domain: url.hostname,
    path: '/',
    secure: false,
    http_only: false,
  };
  for (const attribute of attributes) {
    const index = attribute.indexOf('=');
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const value = index < 0 ? '' : attribute.slice(index + 1).trim();
    if (key === 'domain' && value) cookie.domain = value.replace(/^\./, '');
    else if (key === 'path' && value) cookie.path = value;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.http_only = true;
    else if (key === 'max-age') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expires_at = Math.floor(Date.now() / 1000) + seconds;
    } else if (key === 'expires') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) cookie.expires_at = Math.floor(parsed / 1000);
    }
  }
  return cookie;
}

export function mergeCookies(jar: Cookie[], incoming: Cookie[]): Cookie[] {
  const next = [...jar];
  for (const cookie of incoming) {
    const index = next.findIndex(
      (existing) => existing.name === cookie.name && existing.domain === cookie.domain && existing.path === cookie.path,
    );
    if (cookie.expires_at && cookie.expires_at > 0 && cookie.expires_at <= Math.floor(Date.now() / 1000)) {
      if (index >= 0) next.splice(index, 1);
      continue;
    }
    if (index >= 0) next[index] = cookie;
    else next.push(cookie);
  }
  return next;
}

export type FetchRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
};

export type FetchOutcome = {
  status: number;
  headers: Record<string, string>;
  body: string;
  setCookies: Cookie[];
  finalUrl: string;
};

const MAX_REDIRECTS = 8;

const COOKIE_PLACEHOLDER = /\$\{cookie:([A-Za-z0-9_.-]+)\}/g;

/**
 * Resolve `${cookie:NAME}` placeholders in request headers from the session jar.
 *
 * This lets a module use a cookie value it cannot read (for example a platform
 * token derived from the `jwt` cookie) without handing the whole jar to the
 * module. Only headers are substituted; URL and body are untouched. The cookie
 * must match the request host/path and must not be expired.
 */
export function resolveHeaderCookies(
  headers: Record<string, string>,
  jar: Cookie[],
  url: URL,
  now: number,
): Record<string, string> {
  const path = url.pathname === '' ? '/' : url.pathname;
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    resolved[name] = value.replace(COOKIE_PLACEHOLDER, (_match, cookieName: string) => {
      const cookie = jar.find(
        (item) =>
          item.name === cookieName &&
          (!item.expires_at || item.expires_at <= 0 || item.expires_at > now) &&
          (!item.secure || url.protocol === 'https:') &&
          domainMatches(item.domain, url.hostname) &&
          pathMatches(item.path || '/', path),
      );
      if (!cookie) {
        throw new NetError(
          'platform_login_expired',
          `请求头需要 Cookie ${cookieName}，但当前会话没有`,
        );
      }
      return cookie.value;
    });
  }
  return resolved;
}

/**
 * The single outbound path for modules. Composition of this function is where the framework keeps
 * quiet hours, allowlists, credential injection and the write ledger enforceable (spec §4.1).
 */
export async function performFetch(
  request: FetchRequest,
  options: {
    allow: string[];
    cookies: Cookie[];
    token: string;
    now: number;
    binary?: boolean;
    beforeRequest?: () => void;
    signal?: AbortSignal;
  },
): Promise<FetchOutcome> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new NetError('net_blocked', '请求地址不正确');
  }
  if (url.protocol !== 'https:') throw new NetError('net_blocked', '模块只能请求 https 地址');
  if (!allowedHost(options.allow, url.hostname)) {
    throw new NetError('net_blocked', `模块没有访问 ${url.hostname} 的权限`);
  }
  for (const header of Object.keys(request.headers)) {
    if (BLOCKED_REQUEST_HEADERS.has(header.toLowerCase())) {
      throw new NetError('net_blocked', `模块不能设置请求头 ${header}`);
    }
  }
  const jar = [...options.cookies];
  const collected: Cookie[] = [];
  let current = url;
  let method = request.method.toUpperCase();
  let body = request.body;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    options.beforeRequest?.();
    const headers = resolveHeaderCookies(request.headers, jar, current, options.now);
    const cookie = cookieHeaderFor(jar, current, options.now);
    if (cookie) headers.cookie = cookie;
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    headers['user-agent'] = headers['user-agent'] ?? 'Courseflow/0.1';

    const response = await fetch(current, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : (body ?? undefined),
      redirect: 'manual',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
    });

    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const header of setCookies) {
      const parsed = parseSetCookie(header, current);
      if (!parsed) continue;
      collected.push(parsed);
      const index = jar.findIndex(
        (existing) =>
          existing.name === parsed.name &&
          existing.domain === parsed.domain &&
          existing.path === parsed.path,
      );
      if (index >= 0) jar[index] = parsed;
      else jar.push(parsed);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: await boundedBody(response, options.binary),
          setCookies: collected,
          finalUrl: current.toString(),
        };
      }
      const next = new URL(location, current);
      if (next.protocol !== 'https:' || !allowedHost(options.allow, next.hostname)) {
        throw new NetError('net_blocked', `重定向到未授权的主机 ${next.hostname}`);
      }
      if (response.status === 303 || (response.status <= 302 && method === 'POST')) {
        method = 'GET';
        body = null;
      }
      current = next;
      await response.body?.cancel();
      continue;
    }

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await boundedBody(response, options.binary),
      setCookies: collected,
      finalUrl: current.toString(),
    };
  }
  throw new NetError('net_blocked', '重定向次数过多');
}

async function boundedBody(response: Response, binary = false): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8_000_000) throw new NetError('platform_protocol_changed', '平台响应超过大小限制');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  return bytes.toString(binary ? 'base64' : 'utf8');
}

export function mapPlatformStatus(status: number): NetError | undefined {
  if (status === 401) return new NetError('platform_login_expired', '平台登录已过期，请重新连接');
  if ([403, 418, 429].includes(status)) {
    return new NetError('platform_verification_required', '平台要求验证或限制了请求，请到官方页面处理后重试');
  }
  return undefined;
}
