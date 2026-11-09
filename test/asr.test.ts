import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AsrService } from '../src/services/asr.ts';

test('asr: unavailable without a backend', async () => {
  const service = new AsrService({});
  assert.equal(service.available(), false);
  await assert.rejects(service.transcribe(Buffer.from('abc')), /未配置语音转写服务/);
});

test('asr: rejects empty audio', async () => {
  const service = new AsrService({ command: 'echo {}' });
  await assert.rejects(service.transcribe(Buffer.alloc(0)), /音频为空/);
});

test('asr: runs the configured command and reads JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-asr-test-'));
  try {
    const script = path.join(dir, 'fake-asr.mjs');
    fs.writeFileSync(
      script,
      "import fs from 'node:fs'; console.log(JSON.stringify({ text: 'hello world ' + fs.statSync(process.argv[2]).size }));",
    );
    const service = new AsrService({
      command: `"${process.execPath}" "${script}" {input}`,
      timeoutMs: 20_000,
      concurrency: 1,
    });
    assert.equal(service.available(), true);
    assert.equal(service.describe().backend, 'command');
    const text = await service.transcribe(Buffer.from('abc'));
    assert.equal(text, 'hello world 3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('asr: reads a result file when the command writes one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-asr-out-'));
  try {
    const script = path.join(dir, 'fake-asr-out.mjs');
    fs.writeFileSync(
      script,
      "import fs from 'node:fs'; fs.writeFileSync(process.argv[3], JSON.stringify({ text: 'from file' }));",
    );
    const service = new AsrService({
      command: `"${process.execPath}" "${script}" {input} {output}`,
      timeoutMs: 20_000,
    });
    assert.equal(await service.transcribe(Buffer.from('x')), 'from file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('asr: surfaces command failures', async () => {
  const service = new AsrService({ command: `"${process.execPath}" -e "process.exit(3)" {input}`, timeoutMs: 20_000 });
  await assert.rejects(service.transcribe(Buffer.from('abc')), /退出码 3/);
});

function fakeCommand(t: test.TestContext, source: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-asr-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'fake.mjs');
  fs.writeFileSync(script, source);
  return { dir, command: `"${process.execPath}" "${script}" {input}` };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, '合成转写进程没有按时就绪');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('ASR shutdown cancels running and queued commands and stops descendants', async (t) => {
  const { dir, command } = fakeCommand(t, "import fs from 'node:fs';import path from 'node:path';const dir=path.dirname(new URL(import.meta.url).pathname);fs.writeFileSync(path.join(dir,'ready'),'1');setInterval(()=>fs.appendFileSync(path.join(dir,'ticks'),'x'),10);");
  const service = new AsrService({ command, concurrency: 1, timeoutMs: 30_000 });
  const first = service.transcribe(Buffer.from('first'));
  const firstResult = assert.rejects(first, (error: any) => error.code === 'asr_cancelled');
  await until(() => fs.existsSync(path.join(dir, 'ticks')));
  const queued = service.transcribe(Buffer.from('second'));
  const queuedResult = assert.rejects(queued, (error: any) => error.code === 'asr_cancelled');
  const started = Date.now();
  await service.shutdown();
  await Promise.all([firstResult, queuedResult]);
  assert.ok(Date.now() - started < 2000, '退出不能等待单段转写超时');
  const ticks = fs.readFileSync(path.join(dir, 'ticks'), 'utf8');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(fs.readFileSync(path.join(dir, 'ticks'), 'utf8'), ticks);
  await assert.rejects(service.transcribe(Buffer.from('late')), (error: any) => error.code === 'asr_cancelled');
});

test('ASR caller cancellation removes queued work without stopping unrelated work', async (t) => {
  const { dir, command } = fakeCommand(t, "import fs from 'node:fs';import path from 'node:path';const marker=path.join(path.dirname(new URL(import.meta.url).pathname),'calls');fs.appendFileSync(marker,'x');setTimeout(()=>console.log('{\"text\":\"ok\"}'),100);");
  const service = new AsrService({ command, concurrency: 1 });
  t.after(() => service.shutdown());
  const first = service.transcribe(Buffer.from('first'));
  await until(() => fs.existsSync(path.join(dir, 'calls')));
  const controller = new AbortController();
  const queued = service.transcribe(Buffer.from('queued'), 'audio/mpeg', { signal: controller.signal });
  const rejected = assert.rejects(queued, (error: any) => error.code === 'asr_cancelled');
  controller.abort();
  await rejected;
  assert.equal(await first, 'ok');
  assert.equal(await service.transcribe(Buffer.from('third')), 'ok');
  assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8'), 'xx');
});

test('ASR command timeout remains typed and releases its execution slot', async (t) => {
  const { command } = fakeCommand(t, 'setInterval(()=>{},1000);');
  const service = new AsrService({ command, timeoutMs: 100, concurrency: 1 });
  t.after(() => service.shutdown());
  for (let i = 0; i < 2; i++) await assert.rejects(service.transcribe(Buffer.from('audio')), (error: any) => error.code === 'asr_timeout');
});

test('six MiB ASR payload fits the module transport including JSON-RPC metadata', async () => {
  const { PassThrough } = await import('node:stream');
  const { LineChannel } = await import('../src/modules/rpc.ts');
  const input = new PassThrough(), output = new PassThrough();
  let message = '', failure: Error | undefined;
  const channel = new LineChannel(input, output, text => { message = text; }, error => { failure = error; });
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'cw.asr.transcribe', params: { session: 'synthetic-session', mime: 'audio/mpeg', audio: Buffer.alloc(6 * 1024 * 1024).toString('base64') } });
  input.write(payload + '\n');
  channel.dispose();input.destroy();output.destroy();
  assert.equal(failure, undefined);
  assert.equal(message.length, payload.length);
});

test('ASR HTTP uploads stay within concurrency limits and shutdown aborts stalled responses', async (t) => {
  const { createServer } = await import('node:http');
  let active = 0, peak = 0, requests = 0, stall = false, stalledClosed = false;
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/audio/transcriptions');
    assert.match(request.headers['content-type'] ?? '', /multipart\/form-data/);
    request.resume();
    active += 1;requests += 1;peak = Math.max(peak, active);
    const isStalled = stall;
    response.once('close', () => { active -= 1; if (isStalled) stalledClosed = true; });
    if (!isStalled) setTimeout(() => { response.writeHead(200, { 'content-type': 'application/json' });response.end(JSON.stringify({ text: 'synthetic transcript' })); }, 20);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections();server.close(); });
  const address = server.address() as { port: number };
  const service = new AsrService({ url: `http://127.0.0.1:${address.port}/v1`, concurrency: 2, timeoutMs: 3000 });
  t.after(() => service.shutdown());
  const results = await Promise.all(Array.from({ length: 8 }, () => service.transcribe(Buffer.from('synthetic audio'))));
  assert.deepEqual(results, Array(8).fill('synthetic transcript'));
  assert.equal(peak, 2);
  stall = true;
  const pending = service.transcribe(Buffer.from('stalled'));
  const rejected = assert.rejects(pending, (error: any) => error.code === 'asr_cancelled');
  await until(() => requests === 9);
  await service.shutdown();await rejected;
  await until(() => stalledClosed);
});
