import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const configModule = fileURLToPath(new URL('../src/core/config.ts', import.meta.url));

test('default runtime data stays in the unified workspace, not XDG storage', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'courseflow-config-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const xdgDataHome = path.join(home, 'other-data');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_DATA_HOME: xdgDataHome };
  delete env.CF_DATA_DIR;
  const config = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { loadConfig } from ${JSON.stringify(configModule)}; console.log(JSON.stringify(loadConfig()));`,
  ], { env, encoding: 'utf8' }));
  assert.equal(config.dataDir, path.join(home, 'local', 'data'));
  assert.equal(fs.existsSync(xdgDataHome), false);
  assert.equal(fs.statSync(config.dataDir).mode & 0o777, 0o700);
});

test('explicit runtime data directories remain supported for containers and fixtures', async (t) => {
  const { loadConfig } = await import('../src/core/config.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'courseflow-explicit-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = loadConfig({ CF_DATA_DIR: path.join(directory, 'data') });
  assert.equal(config.dataDir, path.join(directory, 'data'));
  assert.equal(config.modulesDir, path.join(directory, 'data', 'modules'));
});
