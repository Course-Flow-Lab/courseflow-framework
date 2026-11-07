import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { browserCookies } from '../src/services/browser.ts';
import { cookieHeaderFor, parseSetCookie, resolveHeaderCookies } from '../src/modules/net.ts';

const allow = ['zhihuishu.com', '*.zhihuishu.com'];
test('平台父域 Cookie 进入 Chromium 后仍可用于回放子域，旧会话也可恢复', () => {
  const url = new URL('https://passport.zhihuishu.com/login');
  const shared = parseSetCookie('session=synthetic; Domain=.zhihuishu.com; Path=/; Secure; HttpOnly', url)!;
  const host = parseSetCookie('local=synthetic-host; Path=/; Secure', url)!;
  assert.equal(shared.host_only, false); assert.equal(host.host_only, true);
  assert.equal(cookieHeaderFor([shared, host], new URL('https://lc.zhihuishu.com/live/vod_room.html'), 1), 'session=synthetic');
  const cookies = browserCookies([shared, host], allow, 1);
  assert.equal(cookies[0]!.domain, '.zhihuishu.com');
  assert.equal(cookies[1]!.domain, 'passport.zhihuishu.com');
  assert.equal(cookies[0]!.httpOnly, true);
  const { host_only, ...legacy } = shared;
  assert.equal(browserCookies([legacy], allow, 1)[0]!.domain, '.zhihuishu.com');
  assert.throws(() => resolveHeaderCookies({ token: '${cookie:local}' }, [host], new URL('https://child.passport.zhihuishu.com/'), 1), /Cookie/);
  assert.equal(browserCookies([{ ...shared, expires_at: 10 }], allow, 11).length, 0);
});

const scriptFile = new URL('../../courseflow-zhs/src/zhs/features/meeting.js', import.meta.url);
test('官方播放器等待观看历史，标志复位后仍能续播，兼容页面 Map 与原生 Map', { skip: !fs.existsSync(scriptFile) && '相邻智慧树模块源码不存在，跳过模块页面脚本检查' }, () => {
  const script = fs.readFileSync(scriptFile, 'utf8');
  let starts = 0;
  class OfficialMap { size() { return 2; } }
  const video = { currentTime: 12, muted: false, playbackRate: 2, paused: true, ended: false, play: async () => {} };
  const page: any = {
    location: { hostname: 'passport.zhihuishu.com' }, Map: OfficialMap,
    document: { querySelector: (selector: string) => selector.includes('video') ? video : { textContent: '20%' } },
    videoFlag: false, watchHistoryFlag: false, courseEndStatus: 1, videoStartEndmap: new OfficialMap(),
    videoInfo: [{ id: 'first', duration: 125 }, { id: 'second', duration: 120 }], watchHistoryBack: ['1', '2'], curVideoId: 'first',
    onPaly: (id: string, index: number) => { starts++; assert.equal(id, 'first'); assert.equal(index, 0); },
  };
  page.window = page; const context = vm.createContext(page);
  assert.equal(vm.runInContext(script, context).auth_redirect, true); assert.equal(starts, 0);
  page.location.hostname = 'lc.zhihuishu.com';
  assert.equal(vm.runInContext(script, context).loading, true); assert.equal(starts, 0);
  page.__courseflowObserved = { '/getWatchHistory': { loaded: true } };
  const playing = vm.runInContext(script, context);
  assert.equal(playing.position, 12); assert.equal(starts, 1); assert.equal(page.seekTime, 120);
  assert.equal(page.Map, OfficialMap); assert.equal(video.playbackRate, 1);
  vm.runInContext(script, context); assert.equal(starts, 1);
  video.currentTime = 20;
  assert.equal(vm.runInContext(script, context).position, 20);
  page.__courseflowStarted = false; page.videoStartEndmap = new Map([['first', [0, 3]]]);
  assert.equal(vm.runInContext(script, context).position, 20); assert.equal(starts, 2);
  page.__courseflowObserved = { '/getWatchHistory': { error: '登录已过期', code: 'platform_login_expired' } };
  assert.equal(vm.runInContext(script, context).authentication_required, true);
});
