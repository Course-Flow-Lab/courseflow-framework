import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../src/core/vault.ts';

function tempKey(): { dir: string; key: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courseflow-vault-'));
  return { dir, key: path.join(dir, 'secret.key') };
}

test('seal/open round-trips and is randomized', () => {
  const { key } = tempKey();
  const vault = Vault.open(key, false);
  const first = vault.seal('alice', 'zhs/session', Buffer.from('cookie'));
  const second = vault.seal('alice', 'zhs/session', Buffer.from('cookie'));
  assert.notEqual(first.toString('hex'), second.toString('hex'));
  assert.equal(first[0], 1);
  assert.equal(first.length, 1 + 12 + 6 + 16);
  assert.equal(vault.open('alice', 'zhs/session', first).toString(), 'cookie');
});

test('owner and scope are bound as additional authenticated data', () => {
  const { key } = tempKey();
  const vault = Vault.open(key, false);
  const sealed = vault.seal('alice', 'zhs/session', Buffer.from('cookie'));
  assert.throws(() => vault.open('bob', 'zhs/session', sealed));
  assert.throws(() => vault.open('alice', 'cx/session', sealed));
});

test('tampering is detected', () => {
  const { key } = tempKey();
  const vault = Vault.open(key, false);
  const sealed = vault.seal('alice', 'job/1', Buffer.from('{"completed":[]}'));
  const damaged = Buffer.from(sealed);
  damaged[20] ^= 1;
  assert.throws(() => vault.open('alice', 'job/1', damaged));
});

test('a missing key is not regenerated when secrets already exist', () => {
  const { key } = tempKey();
  const vault = Vault.open(key, false);
  const sealed = vault.seal('alice', 'zhs/session', Buffer.from('cookie'));
  fs.rmSync(key);
  assert.throws(() => Vault.open(key, true), /secret\.key/);
  assert.equal(fs.existsSync(key), false);

  const reopened = Vault.open(key, false);
  assert.throws(() => reopened.open('alice', 'zhs/session', sealed));
});

test('the key file stays readable only by the owner', () => {
  const { key } = tempKey();
  Vault.open(key, false);
  const mode = fs.statSync(key).mode & 0o777;
  assert.equal(mode, 0o600);
});
