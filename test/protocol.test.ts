import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateWhen,
  resolvePresentation,
  satisfiesRange,
  validateManifest,
} from '../src/modules/protocol.ts';
import { allowedHost, cookieHeaderFor, mergeCookies, parseSetCookie } from '../src/modules/net.ts';
import { quietStatus } from '../src/domain.ts';

const BASE_MANIFEST = {
  schemaVersion: 1,
  id: 'demo',
  name: 'Demo',
  version: '1.2.3',
  moduleApi: 1,
  engines: { framework: '>=0.1.0-0 <0.2.0' },
  runtime: { engine: 'node', entry: 'index.mjs' },
  platform: {
    id: 'demo',
    name: 'Demo',
    short: 'Demo',
    login: ['qr'],
    operations: ['study'],
    unit_kinds: ['video'],
    presentation: { tabs: [{ id: 'qa', label: '问答区', when: { 'course.kind': 'shared' } }] },
  },
  permissions: { network: ['example.com', '*.example.org'], browser: false, ai: true, storage: 'module' },
};

test('manifest validation accepts a well-formed module', () => {
  const manifest = validateManifest(structuredClone(BASE_MANIFEST));
  assert.equal(manifest.id, 'demo');
  assert.deepEqual(manifest.permissions.network, ['example.com', '*.example.org']);
});

test('manifest validation rejects unsafe or mismatched fields', () => {
  const cases: Array<[string, (copy: any) => void]> = [
    ['moduleApi mismatch', (copy) => (copy.moduleApi = 2)],
    ['entry escape', (copy) => (copy.runtime.entry = '../../etc/passwd')],
    ['id mismatch', (copy) => (copy.platform.id = 'other')],
    ['url in network permission', (copy) => (copy.permissions.network = ['https://example.com/x'])],
    ['unknown operation', (copy) => (copy.platform.operations = ['gossip'])],
    ['wildcard framework range', (copy) => (copy.engines.framework = '*')],
    ['unknown presentation condition', (copy) => (copy.platform.presentation.tabs[0].when = { 'user.id': 'x' })],
  ];
  for (const [label, mutate] of cases) {
    const copy = structuredClone(BASE_MANIFEST) as any;
    mutate(copy);
    assert.throws(() => validateManifest(copy), new RegExp('.*'), label);
  }
});

test('semver ranges gate framework compatibility', () => {
  assert.equal(satisfiesRange('0.1.0', '>=0.1.0-0 <0.2.0'), true);
  assert.equal(satisfiesRange('0.2.0', '>=0.1.0-0 <0.2.0'), false);
  assert.equal(satisfiesRange('1.4.9', '^1.2.0'), true);
  assert.equal(satisfiesRange('2.0.0', '^1.2.0'), false);
  assert.equal(satisfiesRange('0.2.5', '^0.2.0'), true);
  assert.equal(satisfiesRange('0.3.0', '^0.2.0'), false);
  assert.equal(satisfiesRange('3.1.0', '*'), true);
});

test('presentation conditions are resolved by the framework', () => {
  const descriptor = validateManifest(structuredClone(BASE_MANIFEST)).platform;
  const shared = resolvePresentation(descriptor, { kind: 'shared' });
  assert.deepEqual(shared.tabs.map((tab) => tab.id), ['qa']);
  const smart = resolvePresentation(descriptor, { kind: 'smart' });
  assert.deepEqual(smart.tabs, []);
  assert.equal(evaluateWhen(undefined, undefined), true);
});

test('network allowlist matches suffixes, not prefixes', () => {
  const allow = ['zhihuishu.com', '*.zhihuishu.com'];
  assert.equal(allowedHost(allow, 'passport.zhihuishu.com'), true);
  assert.equal(allowedHost(allow, 'zhihuishu.com'), true);
  assert.equal(allowedHost(allow, 'evil-zhihuishu.com'), false);
  assert.equal(allowedHost(allow, 'zhihuishu.com.evil.test'), false);
});

test('cookies are scoped by domain, path and transport', () => {
  const url = new URL('https://passport.zhihuishu.com/qrCodeLogin/getLoginQrImg');
  const cookie = parseSetCookie('SESSION=abc; Path=/; Secure; HttpOnly', url);
  assert.ok(cookie);
  assert.equal(cookie?.name, 'SESSION');
  assert.equal(cookie?.http_only, true);
  const jar = mergeCookies([], [cookie]);
  assert.match(cookieHeaderFor(jar, url, 0), /SESSION=abc/);
  assert.equal(cookieHeaderFor(jar, new URL('http://passport.zhihuishu.com/'), 0), '');
  assert.equal(cookieHeaderFor(jar, new URL('https://other.example.com/'), 0), '');
  assert.equal(cookieHeaderFor(jar, new URL('https://passport.zhihuishu.com/elsewhere'), 0), 'SESSION=abc');
});

test('quiet hours are fixed to UTC+8 regardless of host timezone', () => {
  const at = (utc: string): number => Math.floor(Date.parse(utc) / 1000);
  assert.equal(quietStatus(at('2026-11-07T14:59:00Z')).active, false); // 22:59 UTC+8
  assert.equal(quietStatus(at('2026-11-07T15:00:00Z')).active, true); // 23:00 UTC+8
  assert.equal(quietStatus(at('2026-11-07T22:59:00Z')).active, true); // 06:59 UTC+8
  assert.equal(quietStatus(at('2026-11-07T23:00:00Z')).active, false); // 07:00 UTC+8
  assert.equal(quietStatus(at('2026-11-08T06:00:00Z')).active, false); // 14:00 UTC+8
});
