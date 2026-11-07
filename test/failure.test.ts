import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot as bootRuntime } from './support/harness.ts';

const boot = () => bootRuntime('courseflow-broken-');

function writeModule(dir: string, manifest: object, entrySource: string): string {
  const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'courseflow-module-'));
  fs.writeFileSync(path.join(moduleDir, 'courseflow.module.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(moduleDir, 'index.mjs'), entrySource);
  return moduleDir;
}

const MANIFEST = {
  schemaVersion: 1,
  id: 'broken',
  name: '坏模块',
  version: '0.1.0',
  moduleApi: 1,
  engines: { framework: '>=0.1.0-0 <0.2.0' },
  runtime: { engine: 'node', entry: 'index.mjs' },
  platform: {
    id: 'broken',
    name: '坏模块',
    short: '坏',
    login: ['qr'],
    operations: ['study'],
    unit_kinds: ['video'],
  },
  permissions: { network: [], browser: false, ai: false, storage: 'module' },
};

test('a module that dies on start does not take the framework down', async (t) => {
  const { runtime } = await boot();
  t.after(async () => runtime.close());

  const dir = writeModule(
    '',
    MANIFEST,
    "process.stdout.write('not json\\n'); process.exit(3);\n",
  );
  runtime.manager.install(dir);

  // The platform is still listed from the manifest, but marked unhealthy.
  const platforms = await runtime.manager.platforms('user-1');
  assert.equal(platforms.length, 1);
  assert.equal(platforms[0].id, 'broken');
  assert.equal(platforms[0].module.healthy, false);

  // And the server still answers.
  const health = await runtime.app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200);
  assert.equal(JSON.parse(health.body).status, 'ok');
});

test('a module with a protocol-violating stdout is rejected at load time', async (t) => {
  const { runtime } = await boot();
  t.after(async () => runtime.close());

  const dir = writeModule(
    '',
    { ...MANIFEST, id: 'chatty', platform: { ...MANIFEST.platform, id: 'chatty' } },
    "setInterval(() => process.stdout.write('hello, this is not json\\n'), 10);\n",
  );
  runtime.manager.install(dir);
  await assert.rejects(() => runtime.manager.describe('chatty'), /没有响应|超时|module/);
});

test('install rejects a manifest that escapes its directory or mismatches the API', async (t) => {
  const { runtime } = await boot();
  t.after(async () => runtime.close());

  const escaping = writeModule(
    '',
    { ...MANIFEST, id: 'escape', platform: { ...MANIFEST.platform, id: 'escape' }, runtime: { engine: 'node', entry: '../outside.mjs' } },
    '',
  );
  assert.throws(() => runtime.manager.install(escaping), /相对路径/);

  const wrongApi = writeModule(
    '',
    { ...MANIFEST, id: 'future', platform: { ...MANIFEST.platform, id: 'future' }, moduleApi: 99 },
    '',
  );
  assert.throws(() => runtime.manager.install(wrongApi), /moduleApi/);

  const wrongRange = writeModule(
    '',
    { ...MANIFEST, id: 'strict', platform: { ...MANIFEST.platform, id: 'strict' }, engines: { framework: '>=9.0.0' } },
    '',
  );
  assert.throws(() => runtime.manager.install(wrongRange), /框架/);
});
