import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { boot, call, setupAdmin } from './support/harness.ts';
import { createUser } from '../src/core/auth.ts';
import { isOvernight, nowSeconds, setQuietOverride } from '../src/core/domain.ts';
import { savePreferences } from '../src/core/preferences.ts';

const at = (time: string) => Date.parse(`2026-11-21T${time}+08:00`);

test('后台保活的全局夜间窗口包含 23:00、不包含 07:00，忽略任务暂停覆盖', () => {
  for (const [time, expected] of [['22:59:59', false], ['23:00:00', true], ['00:00:00', true], ['06:59:59', true], ['07:00:00', false]] as const) {
    assert.equal(isOvernight(at(time) / 1000), expected, time);
  }
});

test('所有用户和团队绑定的后台保活夜间均不运行，早晨按原间隔恢复', async t => {
  const { runtime } = await boot();
  const actualNow = Date.now;
  t.after(async () => { Date.now = actualNow; await runtime.close(); });
  const session = await setupAdmin(runtime);
  const owner = (await call(runtime, { url: '/api/me', session })).body.user.id;
  const team = await createUser(runtime.db, 'keepalive-team', 'synthetic-team-passphrase', 'team', nowSeconds());
  savePreferences(runtime.db, owner, { quiet_hours: false });
  savePreferences(runtime.db, team.id, { quiet_hours: false });
  const module = runtime.manager.install(fileURLToPath(new URL('../modules/simulator', import.meta.url)));
  const manifest = JSON.parse(module.manifest);
  manifest.platform.keepalive_seconds = 300;
  runtime.db.run('UPDATE modules SET manifest=?1 WHERE id=?2', JSON.stringify(manifest), module.id);
  runtime.db.run('INSERT INTO platform_accounts(id,owner,platform,label,legacy,created_at) VALUES(?1,?2,?3,?4,0,?5)', 'keepalive-binding', team.id, 'sim', '合成账号', nowSeconds());
  for (const scope of [owner, 'keepalive-binding']) runtime.sessions.save(scope, 'sim', {
    cookies: [], token: '', display_name: '合成账号', account_raw: scope, connected_at: nowSeconds(), session_id: scope,
  });
  const invocations: string[] = [];
  t.mock.method(runtime.manager, 'invoke', async (scope: string) => { invocations.push(scope); return { valid: true }; });
  const manager = runtime.manager as any;
  // The task development override deliberately remains active for the entire night.
  setQuietOverride(at('23:59:59') / 1000 + 86400);
  for (const time of ['23:00:00', '00:00:00', '06:59:59']) {
    Date.now = () => at(time);
    await manager.maintain();
  }
  assert.deepEqual(invocations, []);
  assert.equal(manager.maintained.size, 0, '跳过夜间保活不能消耗白天的间隔');
  Date.now = () => at('07:00:00');
  await manager.maintain();
  assert.deepEqual(invocations, [owner, 'keepalive-binding']);
  Date.now = () => at('07:04:59');
  await manager.maintain();
  assert.equal(invocations.length, 2);
  Date.now = () => at('07:05:00');
  await manager.maintain();
  assert.equal(invocations.length, 4);
  Date.now = () => at('23:00:00');
  await manager.maintain();
  assert.equal(invocations.length, 4);
});

test('保活扫描跨过 23:00 时停止，模块启动跨过夜间边界也不派发保活', async t => {
  const { runtime } = await boot();
  const actualNow = Date.now;
  t.after(async () => { Date.now = actualNow; await runtime.close(); });
  const session = await setupAdmin(runtime);
  const owner = (await call(runtime, { url: '/api/me', session })).body.user.id;
  const module = runtime.manager.install(fileURLToPath(new URL('../modules/simulator', import.meta.url)));
  const manifest = JSON.parse(module.manifest);
  manifest.platform.keepalive_seconds = 300;
  runtime.db.run('UPDATE modules SET manifest=?1 WHERE id=?2', JSON.stringify(manifest), module.id);
  for (const scope of [owner, 'second-synthetic-scope']) runtime.sessions.save(scope, 'sim', {
    cookies: [], token: '', display_name: '合成账号', account_raw: scope, connected_at: nowSeconds(), session_id: scope,
  });
  const manager = runtime.manager as any;
  let requests = 0;
  const invoke = t.mock.method(runtime.manager, 'invoke', async () => {
    requests++;
    Date.now = () => at('23:00:00');
    return { valid: true };
  });
  Date.now = () => at('22:59:59');
  await manager.maintain();
  assert.equal(requests, 1, '夜间边界之后不能处理扫描中的第二个账号');
  invoke.mock.restore();
  let starts = 0, dispatches = 0;
  t.mock.method(manager, 'ensureRunner', async () => {
    starts++;
    Date.now = () => at('23:00:00');
    return { call: async () => { dispatches++; return { valid: true }; } };
  });
  await assert.rejects(runtime.manager.invoke(owner, 'sim', 'auth.keepalive', {}), { code: 'keepalive_overnight' });
  assert.equal(starts, 0);
  Date.now = () => at('22:59:59');
  await assert.rejects(runtime.manager.invoke(owner, 'sim', 'auth.keepalive', {}), { code: 'keepalive_overnight' });
  assert.equal(starts, 1); assert.equal(dispatches, 0);
  // A scan whose module startup crosses curfew must not consume a keep-alive interval.
  manager.maintained.clear();
  Date.now = () => at('22:59:59');
  await manager.maintain();
  assert.equal(starts, 2); assert.equal(dispatches, 0);
  assert.equal(manager.maintained.size, 0, '模块启动跨过夜间边界时不能记录为已保活');
  // User-initiated authentication checks are independent of background keep-alive.
  await runtime.manager.invoke(owner, 'sim', 'auth.verify', {});
  assert.equal(dispatches, 1);
});
