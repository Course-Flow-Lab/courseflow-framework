import { badRequest } from '../core/errors.ts';

export const MODULE_API = 1;
const configuredTimeout = Number(process.env.CF_CALL_TIMEOUT_MS);
export const CALL_TIMEOUT_MS = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0 && configuredTimeout <= 2_147_483_647 ? configuredTimeout : 30_000;
export const DESCRIBE_TIMEOUT_MS = 5_000;

export type LoginMethod = 'qr' | 'password' | 'browser';
export type EngineKind = 'binary' | 'node';

export type When = Record<string, string>;

export type PresentationTab = { id: string; label: string; when?: When };

export type PlatformDescriptor = {
  id: string;
  name: string;
  short: string;
  login: LoginMethod[];
  operations: string[];
  unit_kinds: string[];
  max_speed?: number;
  keepalive_seconds?: number;
  score_sections?: PresentationTab[];
  presentation?: { tabs?: PresentationTab[]; actions?: PresentationTab[] };
};

export type Manifest = {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  moduleApi: number;
  engines: { framework: string };
  runtime: { engine: EngineKind; entry: string; files: string[] };
  platform: PlatformDescriptor;
  permissions: {
    network: string[];
    browser: boolean;
    ai: boolean;
    asr?: boolean;
    question_bank?: boolean;
    storage: 'module';
  };
};

export type DescribeResult = {
  module: { name: string; version: string; module_api: number };
  platform: PlatformDescriptor;
};

export type Course = {
  progress_source?: 'units';
  id: string;
  recruit_id: string;
  name: string;
  kind: string;
  kind_label?: string;
  family?: string;
  progress?: number | null;
  outline_available: boolean;
};

export type Unit = {
  id: string;
  name: string;
  chapter_id: string;
  chapter_name: string;
  lesson_id: string;
  kind: string;
  duration_seconds?: number | null;
  watched_seconds?: number | null;
  state: 'not_started' | 'in_progress' | 'completed' | 'unknown';
  video_id?: string | null;
  selectable: boolean;
  selectable_note?: string;
};

export type Question = { id: string; text: string; kind: string; options: Array<{ id: string; text: string }>; answer: string[]; correct_answer?: string[]; explanation?: string; images?: string[]; blanks: number };
export type Paper = { id: string; name: string; category: string; available: boolean; done: boolean; can_redo?: boolean; can_review?: boolean; reason?: string; score?: number | null; attempts_left?: number | null; ends_at?: number | null };
export type Attempt = { id: string; paper_id: string; name: string; questions: Question[]; expires_at: number | null };

export type RpcRequest = { jsonrpc: '2.0'; id: number; method: string; params?: unknown };
export type RpcResponse =
  | { jsonrpc: '2.0'; id: number; result: unknown }
  | { jsonrpc: '2.0'; id: number; error: { code: string; message: string; data?: unknown } };
export type RpcNotification = { jsonrpc: '2.0'; method: string; params?: unknown };
export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

const ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const OPERATIONS = new Set([
  'trial',
  'study',
  'review',
  'meeting',
  'answer',
  'mastery',
  'qa',
  'ask',
  'discuss',
  'evaluate',
]);
const UNIT_KINDS = new Set(['video', 'audio', 'document', 'reading', 'empty']);
const LOGIN = new Set<LoginMethod>(['qr', 'password', 'browser']);

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`清单字段 ${field} 应为对象`, 'invalid_manifest');
  }
  return value as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, field: string, where: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest(`清单字段 ${where}${field} 应为非空字符串`, 'invalid_manifest');
  }
  return value;
}

function stringList(
  source: Record<string, unknown>,
  field: string,
  where: string,
): string[] {
  const value = source[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw badRequest(`清单字段 ${where}${field} 应为字符串数组`, 'invalid_manifest');
  }
  return value as string[];
}

/** Minimal semver range support: `*`, `^x.y.z`, and space-separated comparators (`>=1.0.0 <2.0.0`). */
export function satisfiesRange(version: string, range: string): boolean {
  const parse = (text: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  };
  const compare = (a: number[], b: number[]): number => {
    for (let index = 0; index < 3; index += 1) {
      const left = a[index] ?? 0;
      const right = b[index] ?? 0;
      if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
  };
  const current = parse(version);
  if (!current) return false;
  if (range.trim() === '*' || range.trim() === '') return true;
  for (const raw of range.trim().split(/\s+/)) {
    const match = /^(>=|<=|>|<|=|\^)?(.+)$/.exec(raw);
    if (!match) return false;
    const operator = match[1] ?? '=';
    const target = parse(match[2]);
    if (!target) return false;
    const comparison = compare(current, target);
    if (operator === '=' && comparison !== 0) return false;
    if (operator === '>' && comparison <= 0) return false;
    if (operator === '>=' && comparison < 0) return false;
    if (operator === '<' && comparison >= 0) return false;
    if (operator === '<=' && comparison > 0) return false;
    if (operator === '^') {
      const upper =
        target[0] === 0 ? [0, (target[1] ?? 0) + 1, 0] : [target[0] + 1, 0, 0];
      if (comparison < 0 || compare(current, upper) >= 0) return false;
    }
  }
  return true;
}

export function validateManifest(raw: unknown): Manifest {
  const source = record(raw, '');
  if (source.schemaVersion !== 1) throw badRequest('清单 schemaVersion 应为 1', 'invalid_manifest');
  const id = stringField(source, 'id', '');
  if (!ID_PATTERN.test(id)) throw badRequest('清单 id 格式不正确', 'invalid_manifest');
  const name = stringField(source, 'name', '');
  const version = stringField(source, 'version', '');
  if (!/^\d+\.\d+\.\d+/.test(version)) throw badRequest('清单 version 应为语义化版本', 'invalid_manifest');
  if (source.moduleApi !== MODULE_API) {
    throw badRequest(
      `模块要求 moduleApi ${String(source.moduleApi)}，本服务支持 ${MODULE_API}`,
      'module_api_mismatch',
    );
  }
  const engines = record(source.engines, 'engines');
  const frameworkRange = stringField(engines, 'framework', 'engines.');
  if (frameworkRange.trim() === '*') {
    throw badRequest('清单 engines.framework 不能为 *', 'invalid_manifest');
  }
  const runtime = record(source.runtime, 'runtime');
  const engine = stringField(runtime, 'engine', 'runtime.');
  if (engine !== 'binary' && engine !== 'node') {
    throw badRequest('清单 runtime.engine 应为 binary 或 node', 'invalid_manifest');
  }
  const entry = stringField(runtime, 'entry', 'runtime.');
  if (entry.startsWith('/') || entry.split('/').includes('..')) {
    throw badRequest('清单 runtime.entry 必须是模块目录内的相对路径', 'invalid_manifest');
  }
  const files = stringList(runtime, 'files', 'runtime.');
  for (const file of files) {
    if (file.startsWith('/') || file.split('/').includes('..')) {
      throw badRequest(`清单 runtime.files 必须是相对路径：${file}`, 'invalid_manifest');
    }
  }
  const platformRaw = record(source.platform, 'platform');
  const platformId = stringField(platformRaw, 'id', 'platform.');
  if (platformId !== id) throw badRequest('清单 platform.id 必须与 id 一致', 'invalid_manifest');
  const login = stringList(platformRaw, 'login', 'platform.').map((method) => {
    if (!LOGIN.has(method as LoginMethod)) {
      throw badRequest(`不支持的登录方式 ${method}`, 'invalid_manifest');
    }
    return method as LoginMethod;
  });
  if (login.length === 0) throw badRequest('清单 platform.login 不能为空', 'invalid_manifest');
  const operations = stringList(platformRaw, 'operations', 'platform.');
  for (const operation of operations) {
    if (!OPERATIONS.has(operation)) {
      throw badRequest(`不支持的操作 ${operation}`, 'invalid_manifest');
    }
  }
  const unitKinds = stringList(platformRaw, 'unit_kinds', 'platform.');
  for (const kind of unitKinds) {
    if (!UNIT_KINDS.has(kind)) throw badRequest(`不支持的单元类型 ${kind}`, 'invalid_manifest');
  }
  const permissions = record(source.permissions, 'permissions');
  const network = stringList(permissions, 'network', 'permissions.');
  for (const host of network) {
    if (host.includes('/') || host.includes(':') || !HOST_PATTERN.test(host)) {
      throw badRequest(`网络权限应为主机后缀，而不是 URL：${host}`, 'invalid_manifest');
    }
  }
  const presentationRaw = platformRaw.presentation;
  const presentation =
    presentationRaw === undefined
      ? undefined
      : (() => {
          const node = record(presentationRaw, 'platform.presentation');
          return {
            tabs: readEntries(node.tabs, 'platform.presentation.tabs'),
            actions: readEntries(node.actions, 'platform.presentation.actions'),
          };
        })();
  return {
    schemaVersion: 1,
    id,
    name,
    version,
    moduleApi: MODULE_API,
    engines: { framework: frameworkRange },
    runtime: { engine, entry, files },
    platform: {
      id,
      name: stringField(platformRaw, 'name', 'platform.'),
      short:
        typeof platformRaw.short === 'string'
          ? platformRaw.short
          : stringField(platformRaw, 'name', 'platform.'),
      login,
      operations,
      unit_kinds: unitKinds,
      max_speed: typeof platformRaw.max_speed === 'number' ? platformRaw.max_speed : undefined,
      keepalive_seconds: typeof platformRaw.keepalive_seconds === 'number' && Number.isInteger(platformRaw.keepalive_seconds) && platformRaw.keepalive_seconds >= 60 ? platformRaw.keepalive_seconds : undefined,
      score_sections: readScoreSections(platformRaw.score_sections),
      presentation,
    },
    permissions: {
      network,
      browser: permissions.browser === true,
      ai: permissions.ai === true,
      asr: permissions.asr === true,
      question_bank: permissions.question_bank === true,
      storage: 'module',
    },
  };
}

function readEntries(value: unknown, where: string): PresentationTab[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw badRequest(`${where} 应为数组`, 'invalid_manifest');
  return value.map((item) => {
    const entry = record(item, where);
    const when = entry.when === undefined ? undefined : record(entry.when, `${where}[].when`);
    if (when) {
      for (const key of Object.keys(when)) {
        if (key !== 'course.kind' && key !== 'course.family') {
          throw badRequest(`不支持的展示条件 ${key}`, 'invalid_manifest');
        }
      }
    }
    return {
      id: stringField(entry, 'id', `${where}[].`),
      label: stringField(entry, 'label', `${where}[].`),
      when: when as When | undefined,
    };
  });
}

function readScoreSections(value: unknown): PresentationTab[] {
  const entries = readEntries(value, 'platform.score_sections');
  if (entries.length > 8 || new Set(entries.map(entry => entry.id)).size !== entries.length || entries.some(entry => !/^[a-z][a-z0-9_-]{0,31}$/.test(entry.id))) {
    throw badRequest('成绩分区最多八个，编号必须唯一并使用小写字母、数字、短横线或下划线', 'invalid_manifest');
  }
  return entries;
}

export function evaluateWhen(
  when: When | undefined,
  course: { kind?: string; family?: string } | undefined,
): boolean {
  if (!when) return true;
  for (const [key, expected] of Object.entries(when)) {
    const actual = key === 'course.kind' ? course?.kind : course?.family;
    if (actual !== expected) return false;
  }
  return true;
}

/** Resolve presentation entries for a course (spec §1: the framework evaluates `when`, not the UI). */
export function resolvePresentation(
  descriptor: PlatformDescriptor,
  course: { kind?: string; family?: string } | undefined,
): { tabs: PresentationTab[]; actions: PresentationTab[]; score_sections?: PresentationTab[] } {
  const pick = (list: PresentationTab[] | undefined): PresentationTab[] =>
    (list ?? []).filter((entry) => evaluateWhen(entry.when, course));
  return { tabs: pick(descriptor.presentation?.tabs), actions: pick(descriptor.presentation?.actions), ...(descriptor.score_sections?.length ? { score_sections: pick(descriptor.score_sections) } : {}) };
}
