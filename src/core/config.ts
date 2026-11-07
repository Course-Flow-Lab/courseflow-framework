import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export type Config = {
  bind: string;
  publicUrl: string;
  dataDir: string;
  dbPath: string;
  keyPath: string;
  modulesDir: string;
  logLevel: string;
  quietOverrideUntil: number | null;
};

function defaultDataDir(): string {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, 'courseflow');
  return path.join(homedir(), '.local', 'share', 'courseflow');
}

function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CF_PUBLIC_URL 不是合法的源地址');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('CF_PUBLIC_URL 必须是完整的 http(s) 源地址，不含路径或查询');
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bind = env.CF_BIND ?? '127.0.0.1:8099';
  const publicUrl = parseOrigin(
    env.CF_PUBLIC_URL ?? `http://${bind.startsWith('0.0.0.0:') ? `127.0.0.1:${bind.split(':')[1]}` : bind}`,
  );
  const dataDir = path.resolve(env.CF_DATA_DIR ?? defaultDataDir());
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const modulesDir = path.join(dataDir, 'modules');
  fs.mkdirSync(modulesDir, { recursive: true, mode: 0o700 });
  return {
    bind,
    publicUrl,
    dataDir,
    dbPath: path.join(dataDir, 'courseflow.db'),
    keyPath: path.join(dataDir, 'secret.key'),
    modulesDir,
    logLevel: env.CF_LOG ?? 'info',
    quietOverrideUntil: env.CF_QUIET_HOURS_DISABLED_UNTIL
      ? Number(env.CF_QUIET_HOURS_DISABLED_UNTIL)
      : null,
  };
}

export function bindAddress(bind: string): { host: string; port: number } {
  const index = bind.lastIndexOf(':');
  if (index < 0) throw new Error('CF_BIND 应为 host:port');
  const host = bind.slice(0, index);
  const port = Number(bind.slice(index + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('CF_BIND 端口不正确');
  return { host: host || '127.0.0.1', port };
}
