import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime, type Runtime } from '../../src/runtime.ts';
import type { Config } from '../../src/config.ts';

export type Session = { token: string; csrf: string };

export type Reply = { status: number; body: any; setCookie: string | undefined };

export function configFor(dir: string): Config {
  return {
    bind: '127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:8099',
    dataDir: dir,
    dbPath: path.join(dir, 'courseflow.db'),
    keyPath: path.join(dir, 'secret.key'),
    modulesDir: path.join(dir, 'modules'),
    logLevel: 'error',
    quietOverrideUntil: Math.floor(Date.now() / 1000) + 3600,
  };
}

export async function boot(prefix = 'courseflow-test-'): Promise<{ runtime: Runtime; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const config = configFor(dir);
  fs.mkdirSync(config.modulesDir, { recursive: true });
  const runtime = await createRuntime(config, { setupCode: 'test-setup-code' });
  return { runtime, dir };
}

export async function call(
  runtime: Runtime,
  options: { method?: string; url: string; session?: Session; body?: unknown },
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.session) {
    headers.cookie = `cf_session=${options.session.token}`;
    headers['x-courseflow-csrf'] = options.session.csrf;
  }
  const response = await runtime.app.inject({
    method: (options.method ?? 'GET') as 'GET' | 'POST',
    url: options.url,
    headers,
    payload: options.body === undefined ? undefined : (options.body as object),
  });
  const setCookie = response.headers['set-cookie'];
  return {
    status: response.statusCode,
    body: response.body ? JSON.parse(response.body) : null,
    setCookie: Array.isArray(setCookie) ? setCookie[0] : (setCookie as string | undefined),
  };
}

export function tokenFrom(setCookie: string | undefined): string {
  const match = setCookie ? /cf_session=([^;]+)/.exec(setCookie) : null;
  assert.ok(match, 'expected a session cookie');
  return match[1]!;
}

export async function setupAdmin(runtime: Runtime): Promise<Session> {
  const reply = await call(runtime, {
    method: 'POST',
    url: '/api/auth/setup',
    body: { setup_code: 'test-setup-code', username: 'admin', password: 'synthetic-passphrase-2026' },
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return { token: tokenFrom(reply.setCookie), csrf: reply.body.csrf };
}

export async function waitFor(
  runtime: Runtime,
  session: Session,
  taskId: string,
  state: string,
  timeoutMs = 20_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tasks = (await call(runtime, { url: '/api/tasks', session })).body.tasks as any[];
    const task = tasks.find((item) => item.id === taskId);
    if (task && task.state === state) return task;
    if (task && ['failed', 'cancelled'].includes(task.state)) {
      assert.fail(`task ended as ${task.state}: ${task.detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`task did not reach ${state} in time`);
}
