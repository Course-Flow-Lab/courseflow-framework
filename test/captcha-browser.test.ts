import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { BrowserService } from '../src/services/browser.ts';
import type { Live } from '../src/core/sessions.ts';

test('captcha browser exposes a popup screenshot and forwards manual pointer input', {
  skip: !fs.existsSync(process.env.CF_CHROMIUM ?? '/usr/bin/chromium') && '未安装 Chromium', timeout: 20_000,
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courseflow-captcha-manual-'));
  const browser = new BrowserService(dir);
  t.after(async () => { await browser.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const entry: Live = { handle: 'synthetic-session', owner: 'synthetic-owner', platform: 'zhs', kind: 'session',
    cookies: [], token: '', expires_at: 0, job: { id: 'synthetic-job', generation: 1 } };
  const opened = await browser.open(entry, ['captcha.synthetic.invalid'], { url: 'https://captcha.synthetic.invalid/stuStudy', purpose: 'captcha' });
  assert.equal(opened.manual, true);
  await browser.evaluate(entry, opened.page, `(() => {
    const popup = document.createElement('div');
    popup.className = 'yidun--popup';
    popup.style.cssText = 'position:fixed;left:20px;top:30px;width:320px;height:160px;background:#fff';
    document.body.appendChild(popup);
    return true;
  })()`);
  assert.equal(browser.hasCaptcha(entry.owner, entry.job!.id), true);
  const view = await browser.captchaView(entry.owner, entry.job!.id);
  assert.equal(view.state, 'ready');
  assert.match(String(view.image), /^iVBOR/);
  assert.equal(view.x, 20); assert.equal(view.y, 30); assert.equal(view.width, 320); assert.equal(view.height, 160);
  assert.deepEqual(await browser.captchaMouse(entry.owner, entry.job!.id, { type: 'click', x: 50, y: 60 }), { ok: true });
  await assert.rejects(browser.captchaMouse('another-owner', entry.job!.id, { type: 'click', x: 50, y: 60 }), (e: any) => e.status === 404);
  await browser.close(opened.page);
  assert.equal(browser.hasCaptcha(entry.owner, entry.job!.id), false);
});

test('captcha browser bootstraps the official origin and returns original image bytes without CORS fetches', {
  skip: !fs.existsSync(process.env.CF_CHROMIUM ?? '/usr/bin/chromium') && '未安装 Chromium', timeout: 20_000,
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courseflow-captcha-browser-'));
  const browser = new BrowserService(dir);
  t.after(async () => { await browser.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const entry: Live = { handle: 'synthetic-session', owner: 'synthetic-owner', platform: 'zhs', kind: 'session', cookies: [], token: '', expires_at: 0 };
  const opened = await browser.open(entry, ['captcha.synthetic.invalid'], { url: 'https://captcha.synthetic.invalid/stuStudy', purpose: 'captcha' });
  let ready: any;
  for (let i = 0; i < 20; i++) {
    ready = await browser.evaluate(entry, opened.page, '({origin:location.origin,ready:!!document.getElementById("courseflow-captcha")})');
    if (ready?.ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(ready, { origin: 'https://captcha.synthetic.invalid', ready: true });
  const page = (browser as any).pages.get(opened.page);
  const observe = page.cdp.onEvent;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/wAAAABJRU5ErkJggg==';
  page.cdp.onEvent = (event: any) => {
    if (event.method === 'Fetch.requestPaused') {
      void page.cdp.call('Fetch.fulfillRequest', { requestId: event.params.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: png }, page.sessionId);
    } else observe(event);
  };
  await page.cdp.call('Fetch.enable', { patterns: [{ urlPattern: 'https://images.synthetic.invalid/*', resourceType: 'Image', requestStage: 'Request' }] }, page.sessionId);
  await browser.evaluate(entry, opened.page, '(async()=>{const img=new Image();const loaded=new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject});img.src="https://images.synthetic.invalid/piece.png";document.body.append(img);await loaded;return true})()');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(await browser.image(entry, opened.page, 'https://images.synthetic.invalid/piece.png'), { image: png, mime: 'image/png' });
  await assert.rejects(browser.image(entry, opened.page, 'https://images.synthetic.invalid/unloaded.png'), (e: any) => e.code === 'browser_image_unavailable');
  await assert.rejects(browser.image({ ...entry, owner: 'another-owner' }, opened.page, 'https://images.synthetic.invalid/piece.png'), (e: any) => e.status === 404);
});

const scriptFile = new URL('../../courseflow-zhs/src/zhs/captcha.js', import.meta.url);
test('ZHS widget handles ready callbacks, original image geometry, unsupported types, and validation tokens', {
  skip: !fs.existsSync(scriptFile) && '相邻智慧树模块源码不存在',
}, async () => {
  const script = fs.readFileSync(scriptFile, 'utf8');
  let config: any, popups = 0, time = 0, loads = 0;
  let kind = 'yidun--jigsaw';
  const elements: Record<string, any> = {
    '.yidun--popup': { classList: { contains: (name: string) => name === kind } },
    '.yidun_bg-img': { complete: true, naturalWidth: 320, src: 'https://synthetic.invalid/bg', getBoundingClientRect: () => ({ x: 10, width: 160 }) },
    '.yidun_jigsaw': { complete: true, naturalWidth: 60, src: 'https://synthetic.invalid/piece', getBoundingClientRect: () => ({ x: 15 }) },
    '.yidun_slider': { getBoundingClientRect: () => ({ x: 10, y: 180, width: 40, height: 40 }) },
  };
  const page: any = { Date: { now: () => (time += 4001) }, setTimeout: (fn: any) => fn(),
    document: { createElement: () => ({}), head: { appendChild: (loader: any) => { loads++; loader.onload(); } }, querySelector: (selector: string) => elements[selector] },
    // The official wrapper hands the popup instance to captchaIns; popUp()
    // loads the challenge. onSuccessAble receives {data: onVerifyData}.
    initAbleYidunFallback: (options: any) => { config = options; options.captchaIns({ popUp: () => { popups++; } }); },
  };
  page.window = page;
  const context = vm.createContext(page);
  const first = await vm.runInContext(script, context);
  assert.equal(first.state, 'puzzle'); assert.equal(first.width, 160); assert.equal(first.natural_width, 320);
  assert.equal(first.piece_left, 5); assert.equal(first.slider_x, 30); assert.equal(popups, 1);
  kind = 'yidun--space'; assert.equal((await vm.runInContext(script, context)).state, 'unsupported');
  kind = 'yidun--jigsaw'; page.__courseflowCaptchaWaitToken = true;
  assert.equal((await vm.runInContext(script, context)).state, 'loading');
  config.onSuccessAble(null, { data: { validate: 'synthetic-token' } });
  assert.equal((await vm.runInContext(script, context)).token, 'synthetic-token'); assert.equal(loads, 1);
});
