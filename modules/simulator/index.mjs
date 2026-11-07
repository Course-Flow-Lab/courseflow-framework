// Reference Courseflow module (v1 draft). No network, no dependencies, one NDJSON message per line.
// It exists to prove the contract and to let the framework be developed without a real platform.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const manifest = JSON.parse(readFileSync(new URL('./courseflow.module.json', import.meta.url), 'utf8'));

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const log = (level, message) => process.stderr.write(`[sim] ${level} ${message}\n`);

let nextId = 1;
const pending = new Map();

function hostCall(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  write({ jsonrpc: '2.0', id, method, params });
  return promise;
}

const courses = [
  {
    id: '1001',
    recruit_id: '9001',
    name: '模拟共享课：数据结构',
    kind: 'shared',
    kind_label: '共享课',
    family: 'shared',
    progress: 42,
    outline_available: true,
  },
  {
    id: '1002',
    recruit_id: '9002',
    name: '模拟智慧课程：操作系统',
    kind: 'smart',
    kind_label: '智慧课程',
    family: 'smart',
    progress: null,
    outline_available: false,
  },
];

const units = [
  { id: '1001-u1', name: '第 1 章 · 绪论', chapter_id: 'c1', chapter_name: '第 1 章', lesson_id: 'l1', kind: 'video', duration_seconds: 180, watched_seconds: 60, state: 'in_progress', video_id: 'v1', selectable: true },
  { id: '1001-u2', name: '第 1 章 · 线性表', chapter_id: 'c1', chapter_name: '第 1 章', lesson_id: 'l2', kind: 'video', duration_seconds: 120, watched_seconds: 0, state: 'not_started', video_id: 'v2', selectable: true },
  { id: '1001-u3', name: '第 2 章 · 阅读材料', chapter_id: 'c2', chapter_name: '第 2 章', lesson_id: 'l3', kind: 'document', duration_seconds: 0, watched_seconds: 0, state: 'completed', video_id: null, selectable: false, selectable_note: '文档单元暂不进入学习队列' },
];

const challenges = new Map();

async function describe() {
  return {
    module: { name: 'courseflow-simulator', version: manifest.version, module_api: 1 },
    platform: manifest.platform,
  };
}

async function authBegin(params) {
  const { now } = await hostCall('cw.clock.now', {});
  const id = String(params.session ?? '');
  challenges.set(id, { expires_at: now + 120, polls: 0 });
  return {
    challenge: {
      id,
      kind: 'qr',
      image:
        'data:image/svg+xml;base64,' +
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#fff"/><text x="60" y="66" font-size="14" text-anchor="middle" fill="#111">sim qr</text></svg>',
        ).toString('base64'),
      expires_at: now + 120,
    },
  };
}

function authPoll(params) {
  const challenge = challenges.get(String(params.challenge ?? ''));
  if (!challenge) return { state: 'expired' };
  challenge.polls += 1;
  return { state: challenge.polls >= 1 ? 'connected' : 'waiting' };
}

function authComplete(params) {
  const id = String(params.challenge ?? '');
  if (!challenges.delete(id)) throw { code: 'invalid_params', message: '登录挑战不存在' };
  return { display_name: '演示学生', account_raw: 'sim-10001' };
}

// Exercises `cw.state` (spec §4.2) on every course read: the second call must observe the value
// the first call stored, which fails loudly if the framework routes or seals state incorrectly.
async function catalogCourses(params) {
  const session = params.session;
  const stored = await hostCall('cw.state', { namespace: 'sim', key: 'visits', session });
  const previous = Number(stored?.value ?? 0);
  const visits = previous + 1;
  await hostCall('cw.state', { namespace: 'sim', key: 'visits', value: visits, session });
  if (previous + 1 !== visits) {
    throw { code: 'module_error', message: 'cw.state 往返不一致' };
  }
  return { courses, visits };
}

function catalogUnits(params) {
  if (params.course?.id !== '1001') return { units: [] };
  return { units };
}

function studyStep(params) {
  const unit = params.unit ?? {};
  const duration = Number(unit.duration_seconds ?? 0);
  const current = Number(params.checkpoint?.seconds ?? 0);
  const next = Math.min(duration, current + 60);
  if (duration === 0 || next >= duration) {
    return { status: 'completed', evidence: { watched_seconds: next } };
  }
  return {
    status: 'in_progress',
    progress: { watched_seconds: next },
    wait_ms: 200,
    checkpoint: { seconds: next },
  };
}

async function dispatch(method, params) {
  switch (method) {
    case 'platform.describe':
      return describe();
    case 'auth.begin':
      return authBegin(params);
    case 'auth.poll':
      return authPoll(params);
    case 'auth.complete':
      return authComplete(params);
    case 'auth.verify':
      return { display_name: '演示学生' };
    case 'catalog.courses':
      return catalogCourses(params);
    case 'catalog.units':
      return catalogUnits(params);
    case 'study.step':
      return studyStep(params);
    default:
      throw { code: 'unsupported_operation', message: `模拟模块没有实现 ${method}` };
  }
}

async function handleRequest(request) {
  try {
    const result = await dispatch(request.method, request.params ?? {});
    write({ jsonrpc: '2.0', id: request.id, result: result ?? {} });
  } catch (error) {
    write({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: error.code ?? 'module_error', message: error.message ?? String(error) },
    });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    log('warn', 'ignored non-JSON input');
    return;
  }
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(message.error);
    else waiter.resolve(message.result);
    return;
  }
  if (typeof message.method === 'string' && message.id !== undefined) {
    void handleRequest(message);
  }
});

lines.on('close', () => {
  process.exit(0);
});
