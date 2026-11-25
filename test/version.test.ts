import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FRAMEWORK_VERSION } from '../src/version.ts';
import { FRAMEWORK_VERSION as PUBLIC_VERSION } from '../src/index.ts';
import { FRAMEWORK_VERSION as MODULE_HOST_VERSION } from '../src/modules/runner.ts';

test('health, public runtime and module host versions match the package and lockfile', () => {
  const read = (name: string) => JSON.parse(fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
  const pkg = read('package.json');
  const lock = read('package-lock.json');
  assert.equal(FRAMEWORK_VERSION, pkg.version);
  assert.equal(PUBLIC_VERSION, pkg.version);
  assert.equal(MODULE_HOST_VERSION, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});
