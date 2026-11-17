import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGlobalDispatcher, setGlobalDispatcher, ProxyAgent } from 'undici';
import { CaptchaService } from '../src/services/captcha.ts';
import { boot, setupAdmin } from './support/harness.ts';

const image = Buffer.from('synthetic-image').toString('base64');

test('captcha sends only image inputs, normalizes results, and bypasses the platform proxy', async t => {
  const received: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push({ path: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ result: request.url === '/ocr' ? ' 1234 ' : { target: [122, 90, 179, 138], target_x: 2, target_y: 89 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const service = new CaptchaService({ url: `http://127.0.0.1:${(server.address() as any).port}` });
  t.after(() => service.shutdown());
  const previous = getGlobalDispatcher(), proxy = new ProxyAgent('http://127.0.0.1:1');
  setGlobalDispatcher(proxy);
  t.after(async () => { setGlobalDispatcher(previous); await proxy.close(); });
  assert.deepEqual(await service.recognize('ocr', { image, session: 'private-handle', token: 'private-token' }), { text: '1234' });
  assert.deepEqual(await service.recognize('slide_match', { target_image: image, background_image: image }), { target: [122, 90, 179, 138], target_x: 2, target_y: 89 });
  assert.deepEqual(received[0].body, { image });
  assert.deepEqual(received[1].body, { target_image: image, background_image: image, simple_target: false });
  assert.equal(received[0].headers.cookie, undefined);
});

test('captcha checks configuration and image limits before making a request', async t => {
  const missing = new CaptchaService(); t.after(() => missing.shutdown());
  assert.equal(missing.available(), false);
  await assert.rejects(missing.recognize('ocr', { image }), (e: any) => e.code === 'captcha_unavailable');
  const service = new CaptchaService({ url: 'http://127.0.0.1:1' }); t.after(() => service.shutdown());
  for (const value of ['', 'https://example.invalid/image.png', '%%%=', Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')]) {
    await assert.rejects(service.recognize('ocr', { image: value }), (e: any) => e.status === 400 || e.statusCode === 400);
  }
});

test('captcha serializes model use, cancels queued work, and sanitizes backend errors', async t => {
  let requests = 0, active = 0, peak = 0, stall = false;
  const server = createServer((request, response) => {
    request.resume(); requests++; active++; peak = Math.max(peak, active);
    response.once('close', () => { active--; });
    if (!stall) setTimeout(() => { response.end(JSON.stringify({ result: 'ok' })); }, 30);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const service = new CaptchaService({ url: `http://127.0.0.1:${(server.address() as any).port}`, timeoutMs: 1000 });
  t.after(() => service.shutdown());
  await Promise.all(Array.from({ length: 4 }, () => service.recognize('ocr', { image })));
  assert.equal(peak, 1);
  stall = true;
  const running = service.recognize('ocr', { image });
  const runningRejected = assert.rejects(running, (e: any) => e.code === 'captcha_cancelled');
  const controller = new AbortController();
  const queued = service.recognize('ocr', { image }, controller.signal);
  const queuedRejected = assert.rejects(queued, (e: any) => e.code === 'captcha_cancelled');
  controller.abort(); await queuedRejected;
  await new Promise(resolve => setTimeout(resolve, 30));
  await service.shutdown(); await runningRejected;
  assert.equal(requests, 5);
  await assert.rejects(service.recognize('ocr', { image }), (e: any) => e.code === 'captcha_cancelled');
});

test('captcha rejects malformed and oversized replies and times out stalled bodies', async t => {
  let result: unknown = { target: [50, 10], target_x: 50, target_y: 10 };
  let stall = false;
  const server = createServer((request, response) => {
    request.resume();
    if (stall) { response.writeHead(200); response.write('{'); }
    else response.end(JSON.stringify({ result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const service = new CaptchaService({ url: `http://127.0.0.1:${(server.address() as any).port}`, timeoutMs: 150 });
  t.after(() => service.shutdown());
  await assert.rejects(service.recognize('slide_match', { target_image: image, background_image: image }), (e: any) => e.code === 'captcha_backend_error');
  result = 'x'.repeat(20_000);
  await assert.rejects(service.recognize('ocr', { image }), (e: any) => e.code === 'captcha_backend_error');
  stall = true;
  await assert.rejects(service.recognize('ocr', { image }), (e: any) => e.code === 'captcha_timeout');
});

test('captcha RPC requires module permission and a matching live platform session', async t => {
  const { runtime, dir } = await boot(); t.after(() => runtime.close());
  await setupAdmin(runtime);
  const owner = runtime.db.get<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
  const source = path.join(dir, 'captcha-module');
  fs.cpSync(fileURLToPath(new URL('../modules/simulator', import.meta.url)), source, { recursive: true });
  const file = path.join(source, 'courseflow.module.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  runtime.manager.install(source);
  const session = runtime.sessions.openChallenge(owner, 'sim', 60);
  const host = (method: string, params: any) => (runtime.manager as any).hostCall('sim', method, params);
  await assert.rejects(host('cw.captcha.status', { session }), (e: any) => e.code === 'permission_denied');
  manifest.permissions.captcha = true;
  fs.writeFileSync(file, JSON.stringify(manifest)); runtime.manager.install(source);
  assert.equal((await host('cw.captcha.status', { session })).available, false);
  const other = runtime.sessions.openChallenge(owner, 'other', 60);
  await assert.rejects(host('cw.captcha.ocr', { session: other, image }), (e: any) => e.code === 'net_blocked');
  t.mock.method(runtime.captcha, 'recognize', async (method: string, params: any) => {
    assert.equal(method, 'ocr'); assert.equal(params.image, image); return { text: '1234' };
  });
  assert.deepEqual(await host('cw.captcha.ocr', { session, image }), { text: '1234' });
  runtime.sessions.dropChallenge(session);
  await assert.rejects(host('cw.captcha.ocr', { session, image }));
});
