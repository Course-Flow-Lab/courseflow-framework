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
