import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime, type RuntimeConfig } from 'courseflow-framework';
import { createHttpServer } from 'courseflow-framework/http';

function temporaryConfig(t: test.TestContext): RuntimeConfig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'courseflow-runtime-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, dbPath: path.join(dataDir, 'courseflow.db'), keyPath: path.join(dataDir, 'secret.key'), modulesDir: path.join(dataDir, 'modules'), logLevel: 'error', quietOverrideUntil: null };
}

test('headless runtime loads a module without HTTP configuration or process signal handlers', async (t) => {
  const signals = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
  const runtime = await createRuntime(temporaryConfig(t));
  t.after(() => runtime.close());
  assert.equal('app' in runtime, false);
  assert.equal('setupCode' in runtime, false);
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)), signals);
  runtime.manager.install(fileURLToPath(new URL('../modules/simulator', import.meta.url)));
  await runtime.manager.describe('sim');
  assert.equal(runtime.manager.list()[0]?.running, true);
  let moduleStopped = false;
  const closeDb = runtime.db.close.bind(runtime.db);
  t.mock.method(runtime.db, 'close', () => {
    moduleStopped = runtime.manager.list()[0]?.running === false;
    closeDb();
  });
  await runtime.close();
  assert.equal(moduleStopped, true);
});

test('HTTP can close independently and the host then closes the runtime exactly once', async (t) => {
  const runtime = await createRuntime(temporaryConfig(t));
  t.after(() => runtime.close());
  const options = { bind: '127.0.0.1:0', publicUrl: 'http://127.0.0.1:5173', setupCode: 'synthetic-setup' };
  const http = createHttpServer(runtime, options);
  t.after(() => http.close());
  assert.equal((await http.inject('/api/bootstrap')).statusCode, 200);
  const wrongOrigin = await http.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin: 'http://127.0.0.1:8102' }, payload: { setup_code: 'synthetic-setup', username: 'admin', password: 'synthetic-passphrase-2026' } });
  assert.equal(wrongOrigin.statusCode, 403);
  const setup = await http.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin: options.publicUrl }, payload: { setup_code: 'synthetic-setup', username: 'admin', password: 'synthetic-passphrase-2026' } });
  assert.equal(setup.statusCode, 200);
  await http.close();
  assert.equal(runtime.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n, 1);
  const replacement = createHttpServer(runtime, options);
  assert.equal((await replacement.inject('/healthz')).statusCode, 200);
  await replacement.close();
  const close = runtime.close();
  assert.equal(runtime.close(), close);
  await close;
  assert.throws(() => runtime.db.get('SELECT 1'));
});

test('runtime still closes the database if an earlier shutdown step fails', async (t) => {
  const runtime = await createRuntime(temporaryConfig(t));
  const shutdown = runtime.jobs.shutdown.bind(runtime.jobs);
  t.mock.method(runtime.jobs, 'shutdown', async () => { await shutdown(); throw new Error('synthetic shutdown failure'); });
  await assert.rejects(runtime.close(), AggregateError);
  assert.throws(() => runtime.db.get('SELECT 1'));
});
