import { ProxyAgent, setGlobalDispatcher } from 'undici';

/** Proxy URL from the environment, if any. */
export function proxyUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value =
    env.CF_HTTP_PROXY ??
    env.HTTPS_PROXY ??
    env.https_proxy ??
    env.HTTP_PROXY ??
    env.http_proxy ??
    '';
  return value.trim() || null;
}

/** Hide credentials before a proxy URL is written to logs. */
export function maskProxyUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '***';
  }
}

/**
 * Route outbound `fetch` through an HTTP(S) proxy.
 *
 * Node's fetch does not honor `HTTPS_PROXY` by itself, so the framework sets
 * an undici dispatcher once at startup. `CF_HTTP_PROXY` wins over the standard
 * variables. Returns the masked URL when a proxy was installed.
 */
export function configureProxy(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = proxyUrl(env);
  if (!value) return null;
  try {
    setGlobalDispatcher(new ProxyAgent(value));
    return maskProxyUrl(value);
  } catch {
    return null;
  }
}
