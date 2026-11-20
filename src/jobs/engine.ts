import type { Db } from '../core/db.ts';
import type { Vault } from '../core/vault.ts';
import type { ModuleManager, ModuleRow } from '../modules/manager.ts';
import type { Course, Manifest, Paper, Unit, Question } from '../modules/protocol.ts';
import { deferredChapterId } from '../modules/protocol.ts';
import { nowSeconds, randomId, sleep } from '../core/domain.ts';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.ts';
import { effectiveTaskPolicy } from '../core/task-policy.ts';
import { preferences, quietFor } from '../core/preferences.ts';
import type { AiService } from '../services/ai.ts';
import { AnswerMemory, validAnswer, ANSWER_SYSTEM, questionPrompt, parseModelAnswer } from '../services/answers.ts';
import { AUTO_SUBMISSION_UNCONFIRMED, autoChaoxingSubmission, LEGACY_SUBMISSION_UNCONFIRMED, runPrerequisiteQuiz, runWorkflow, type WorkflowContext } from './workflows.ts';
import { platformOwner, taskPlatformOwner } from '../core/platform-accounts.ts';

export type TaskRow = {
  id: string;
  owner: string;
  platform: string;
  account_id: string | null;
  operation: string;
  course_id: string;
  recruit_id: string;
  course_name: string;
  units: string;
  state: string;
  generation: number;
  progress: number | null;
  detail: string;
  checkpoint: Uint8Array | null;
  created_at: number;
  updated_at: number;
};

export type TaskView = {
  account_label: string | null;
  id: string;
  platform: string;
  account_id: string | null;
  operation: string;
  course_id: string;
  recruit_id: string;
  course_name: string;
  state: string;
  progress: number | null;
  detail: string;
  units: string[];
  completed: string[];
  created_at: number;
  updated_at: number;
  module_update?: { from_version: string; to_version: string; blocked_reason?: string };
};

export type Checkpoint = {
  completed: string[]; current?: string; seconds?: number; positions: Record<string, unknown>;
  prerequisite_quizzes?: { completed: string[]; records: Array<Record<string, unknown>> };
  [key: string]: any;
};
export type JobInput = { options: Record<string, unknown>; account: string; connection: string; version: string };

const MAX_UNITS = 200;
const MAX_CX_STUDY_UNITS = 20_000;
const STEP_CAP = 400;
const MODULE_VERSION_CHANGED = '平台模块版本已变化，请在任务详情中核对迁移状态';
type TaskModule = Pick<ModuleRow, 'version' | 'enabled' | 'manifest'>;

/**
 * The study driver. It owns everything the contract keeps out of a module: durability,
 * cancellation, quiet hours, checkpoint sealing and progress. A module only answers
 * `study.step` (spec §3.4).
 */
export class JobEngine {
  private db: Db;
  private vault: Vault;
  private manager: ModuleManager;
  private log: (level: string, message: string) => void;
  private controllers = new Map<string, AbortController>();
  private executions = new Map<string, Promise<void>>();
  private stopping = false;
  private scheduler?: NodeJS.Timeout;
  private ai?: AiService;
  private memory?: AnswerMemory;

  constructor(options: {
    db: Db;
    vault: Vault;
    manager: ModuleManager;
    log: (level: string, message: string) => void;
    recoverInterrupted?: boolean;
    ai?: AiService;
    memory?: AnswerMemory;
  }) {
    this.db = options.db;
    this.vault = options.vault;
    this.manager = options.manager;
    this.log = options.log;
    this.ai = options.ai;
    this.memory = options.memory;
    // A restart never silently replays an unfinished external write.
    if (options.recoverInterrupted !== false) this.db.run(
      "UPDATE tasks SET state = 'paused', generation = generation + 1, detail = '服务已重启，请核对进度后继续', updated_at = ?1 WHERE state IN ('queued','running')",
      nowSeconds(),
    );
    if (options.recoverInterrupted !== false) {
      this.scheduler = setInterval(() => this.schedule(), 1000);
      this.scheduler.unref();
    }
  }

  list(owner: string): TaskView[] {
    return this.db
      .all<TaskRow>("SELECT * FROM tasks WHERE owner = ?1 ORDER BY CASE WHEN state IN ('queued','running','paused') THEN 0 ELSE 1 END, created_at DESC LIMIT 120", owner)
      .map((row) => this.view(row));
  }

  get(owner: string, id: string): TaskView {
    const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?1 AND owner = ?2', id, owner);
    if (!row) throw notFound('找不到这个任务');
    return this.view(row);
  }

  events(owner: string, id: string): Array<{ kind: string; detail: string; created_at: number }> {
    this.get(owner, id);
    return this.db.all(
      'SELECT kind, detail, created_at FROM task_events WHERE task_id = ?1 ORDER BY id DESC LIMIT 100', id,
    );
  }

  details(owner: string, id: string): Record<string, unknown> {
    const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?1 AND owner=?2', id, owner);
    if (!row) throw notFound('找不到这个任务');
    const cp = this.loadCheckpoint(row);
    const records = cp.prerequisite_quizzes?.records;
    const workflow = records?.length ? { ...cp.workflow, records: [...records, ...(cp.workflow?.records ?? [])] } : cp.workflow ?? null;
    return { workflow, reviewed_seconds: cp.reviewed ?? 0 };
  }

  answers(owner: string, id: string, body: { answers?: Record<string, string[]>; text?: string; replace_existing?: boolean }): TaskView {
    const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?1 AND owner=?2', id, owner);
    if (!row) throw notFound('找不到这个任务');
    if (row.state !== 'paused') throw conflict('invalid_state', '请先暂停任务再补答');
    const cp = this.loadCheckpoint(row);
    const workflow = cp.workflow;
    if (!workflow) throw badRequest('当前任务没有需要补充的内容');
    if (workflow.kind === 'prerequisite_quiz' && !['answers', 'waiting_answers', 'waiting_submit'].includes(workflow.phase)) {
      throw conflict('invalid_state', '当前前置测验不在可补答阶段');
    }
    if (workflow.kind === 'activity' && workflow.phase === 'waiting_text') {
      if (typeof body.text !== 'string' || body.text.trim().length < 10 || body.text.length > 1500) throw badRequest('发布内容需 10–1500 字');
      cp.positions[workflow.item_id] = { ...(cp.positions[workflow.item_id] as object ?? {}), generated: body.text.trim() };
      workflow.phase = 'running';
    } else {
      const questions = workflow.attempt?.questions ?? workflow.questions;
      if (!Array.isArray(questions) || !body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) throw badRequest('当前任务没有可补答的题目');
      for (const [qid, supplied] of Object.entries(body.answers)) {
        const answer: unknown = supplied;
        const question = questions.find((q: { id: string }) => q.id === qid);
        if (!question) throw badRequest('补答包含不属于当前作答的题目');
        if (!validAnswer(question, answer)) { if (Array.isArray(answer) && answer.length === 0 && !workflow.preserve?.includes(qid)) continue; throw badRequest('补答格式与题型不符'); }
        if (workflow.preserve?.includes(qid) && JSON.stringify(workflow.answers[qid]) !== JSON.stringify(answer)) {
          if (!body.replace_existing) throw badRequest('修改平台已有答案前，请显式选择允许覆盖');
          workflow.preserve = workflow.preserve.filter((id: string) => id !== qid);
        }
        workflow.answers[qid] = answer;
      }
      workflow.phase = 'answers'; workflow.confirmed = false;
      if (workflow.kind === 'interaction') {
        cp.interactions ??= {}; cp.interactions[workflow.unit_id] = workflow.answers;
      }
    }
    this.saveCheckpoint(id, owner, cp); this.event(id, 'manual_answers', '用户已保存人工补充内容');
    return this.get(owner, id);
  }

  confirm(owner: string, id: string): TaskView {
    if (quietFor(this.db, owner).active) throw conflict('quiet_hours', '夜间暂停期间不能交卷');
    const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?1 AND owner=?2', id, owner);
    if (!row) throw notFound('找不到这个任务');
    const cp = this.loadCheckpoint(row);
    if (row.state !== 'paused' || cp.workflow?.phase !== 'waiting_submit') throw conflict('invalid_state', '当前任务不在等待交卷确认的阶段');
    this.requireCurrentModule(row);
    if (cp.workflow.attempt.expires_at != null && cp.workflow.attempt.expires_at <= nowSeconds()) throw badRequest('本次作答已经截止');
    cp.workflow.confirmed = true; this.saveCheckpoint(id, owner, cp);
    this.event(id, 'submit_confirmed', '用户已确认本次交卷');
    return this.resume(owner, id);
  }

  async reconcile(owner: string, id: string): Promise<TaskView> {
    const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?1 AND owner=?2', id, owner);
    if (!row) throw notFound('找不到这个任务');
    if (row.state !== 'paused') throw conflict('invalid_state', '请先暂停任务再回读提交结果');
    const cp = this.loadCheckpoint(row); const workflow = cp.workflow;
    if (!workflow?.attempt || !['submitting', 'readback'].includes(workflow.phase)) throw badRequest('当前任务没有待核对的交卷记录');
    const input = this.input(row);
    const sessionOwner = taskPlatformOwner(this.db, row);
    if (input.account !== this.manager.accountKey(sessionOwner, row.platform)) throw conflict('platform_account_changed', '平台账号已变化，请连接原账号再回读');
    const courses = await this.manager.courses(sessionOwner, row.platform);
    const course = courses.find((c) => c.id === row.course_id && c.recruit_id === row.recruit_id);
    if (!course) throw notFound('找不到原课程');
    const result = await this.manager.invoke(sessionOwner, row.platform, 'exam.readback', { course, attempt_id: workflow.attempt.id });
    if (!result.confirmed || result.attempt_id !== workflow.attempt.id) throw conflict('submission_unknown', '平台仍未确认本次作答，不会重新提交');
    const latest = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?1 AND owner=?2', id, owner);
    if (!latest || latest.generation !== row.generation || latest.state !== 'paused' ||
        !Buffer.from(latest.checkpoint ?? []).equals(Buffer.from(row.checkpoint ?? []))) {
      throw conflict('invalid_state', '任务已变化，请刷新任务详情');
    }
    for (const q of workflow.attempt.questions) {
      const answer = result.graded_answers?.[q.id];
      if (validAnswer(q, answer)) this.memory?.remember(owner, row.platform, `${course.id}/${course.recruit_id}`, q, answer);
      const reviewed = result.review?.questions?.find((r: any) => r.id === q.id);
      if (reviewed) { q.correct_answer = reviewed.correct_answer; q.explanation = reviewed.explanation; }
    }
    workflow.records ??= [];
    if (!workflow.records.some((r: any) => r.attempt?.id === workflow.attempt.id)) workflow.records.push({ paper: workflow.paper, attempt: workflow.attempt, answers: workflow.answers, explanations: workflow.explanations, score: result.score ?? null, confirmed: true, completed_at: nowSeconds() });
    if (row.operation === 'mastery' && (result.score == null || Number(result.score) < 100)) workflow.remaining = (workflow.remaining ?? 0) + 1;
    workflow.phase = 'next';
    if (workflow.lock) this.db.run("UPDATE operation_locks SET state='confirmed' WHERE id=?1", workflow.lock);
    this.saveCheckpoint(id, owner, cp); this.update(id, { detail: '平台已确认提交，可以继续后续任务' });
    this.event(id, 'submission_confirmed', '人工回读已确认平台提交');
    return this.get(owner, id);
  }

  move(owner: string, id: string, direction: string): TaskView {
    const task = this.get(owner, id);
    if (task.state !== 'queued') throw conflict('invalid_state', '只有排队中的任务可以调整顺序');
    const rows = this.db.all<{ id: string }>("SELECT t.id FROM tasks t LEFT JOIN task_order o ON o.task_id=t.id WHERE t.owner=?1 AND t.state='queued' ORDER BY coalesce(o.position,t.created_at)", owner);
    const index = rows.findIndex((r) => r.id === id); const next = index + (direction === 'up' ? -1 : direction === 'down' ? 1 : 0);
    if (!['up', 'down'].includes(direction)) throw badRequest('排序方向无效');
    if (next >= 0 && next < rows.length) { [rows[index], rows[next]] = [rows[next]!, rows[index]!]; this.db.transaction(() => rows.forEach((r, i) => this.db.run('INSERT INTO task_order VALUES(?1,?2) ON CONFLICT(task_id) DO UPDATE SET position=excluded.position', r.id, i))); }
    return this.get(owner, id);
  }

  private storedInput(row: TaskRow): JobInput | undefined {
    const stored = this.db.get<{ sealed: Uint8Array }>('SELECT sealed FROM task_inputs WHERE task_id=?1', row.id);
    if (!stored) return undefined;
    try {
      return this.vault.openJson<JobInput>(row.owner, `job/${row.id}/input`, Buffer.from(stored.sealed));
    } catch {
      throw conflict('checkpoint_unavailable', '任务输入无法解密，请核对站点密钥');
    }
  }
  private input(row: TaskRow): JobInput {
    const stored = this.storedInput(row);
    if (stored) return stored;
    const input: JobInput = { account: this.manager.accountKey(taskPlatformOwner(this.db, row), row.platform) ?? '', connection: this.manager.connectionId(taskPlatformOwner(this.db, row), row.platform) ?? '', version: this.manager.moduleVersion(row.platform), options: preferences(this.db, row.owner) as unknown as Record<string, unknown> };
    this.saveInput(row, input); return input;
  }
  private saveInput(row: TaskRow, input: JobInput): void {
    const sealed = this.vault.sealJson(row.owner, `job/${row.id}/input`, input);
    this.db.run('INSERT INTO task_inputs VALUES(?1,?2) ON CONFLICT(task_id) DO UPDATE SET sealed=excluded.sealed', row.id, new Uint8Array(sealed));
  }
  private installedModule(platform: string): TaskModule | undefined {
    return this.db.get<TaskModule>('SELECT version,enabled,manifest FROM modules WHERE id=?1', platform);
  }
  private requireCurrentModule(row: TaskRow): void {
    const input = this.storedInput(row);
    const module = input && this.installedModule(row.platform);
    if (module && module.version !== input.version) throw conflict('module_version_changed', MODULE_VERSION_CHANGED);
  }
  private canRecoverSubmission(row: TaskRow, input: JobInput, checkpoint: Checkpoint, manifest: Manifest): boolean {
    const workflow = checkpoint.workflow;
    return manifest.platform.supports_submission_retry === true && autoChaoxingSubmission(row, input, checkpoint) &&
      ['submitting', 'readback'].includes(workflow?.phase) && typeof workflow.attempt?.id === 'string' &&
      typeof workflow.lock === 'string' && Boolean(this.db.get(
        "SELECT 1 FROM operation_locks WHERE id=?1 AND task_id=?2 AND state IN ('pending','unknown')", workflow.lock, row.id,
      ));
  }
  private moduleUpdate(row: TaskRow, input: JobInput, module: TaskModule, checkpoint?: Checkpoint): NonNullable<TaskView['module_update']> {
    const result: NonNullable<TaskView['module_update']> = { from_version: input.version, to_version: module.version };
    const manifest = JSON.parse(module.manifest) as Manifest;
    // These ZHS packages predate the manifest field and share the same checkpoint format.
    const knownZhsUpgrade = row.platform === 'zhs' && module.version === '0.3.9' && input.version === '0.3.8';
    if (module.enabled !== 1) result.blocked_reason = '请先启用平台模块';
    else if (!manifest.platform.operations.includes(row.operation)) result.blocked_reason = '当前模块版本不支持此任务类型';
    else if (!knownZhsUpgrade && !manifest.checkpoint_compatible_from?.includes(input.version)) result.blocked_reason = '当前模块未声明兼容原版本的检查点';
    else if (!checkpoint) result.blocked_reason = '任务检查点无法读取，请核对站点密钥';
    else if (['opening', 'resetting'].includes(checkpoint.workflow?.phase)) result.blocked_reason = '请先在官方页面核对开卷或重做结果';
    else if ((['submitting', 'readback'].includes(checkpoint.workflow?.phase) || this.db.get("SELECT 1 FROM operation_locks WHERE task_id=?1 AND state IN ('pending','unknown')", row.id)) &&
        !this.canRecoverSubmission(row, input, checkpoint, manifest)) {
      result.blocked_reason = '请先回读并确认平台提交结果';
    }
    return result;
  }
  private canRun(row: TaskRow): boolean {
    const running = this.db.all<TaskRow>("SELECT * FROM tasks WHERE state='running' AND id!=?1", row.id);
    if (this.db.get<{ disabled: number }>('SELECT disabled FROM users WHERE id=?1', row.owner)?.disabled !== 0) return false;
    const user = effectiveTaskPolicy(this.db, row.owner);
    if (running.filter((r) => r.owner === row.owner).length >= user.concurrency) return false;
    const account = this.manager.accountKey(taskPlatformOwner(this.db, row), row.platform);
    for (const other of running) {
      if (this.manager.accountKey(taskPlatformOwner(this.db, other), other.platform) !== account) continue;
      const parallel = user.parallel_study && effectiveTaskPolicy(this.db, other.owner).parallel_study &&
        this.isParallelStudy(row) && this.isParallelStudy(other);
      if (!parallel || row.course_id === other.course_id && row.recruit_id === other.recruit_id) return false;
    }
    return true;
  }
  private isParallelStudy(row: TaskRow): boolean {
    if (row.operation !== 'study') return false;
    if (row.platform !== 'cx') return true;
    try { return this.storedInput(row)?.options.auto_prerequisite_quizzes !== true; }
    catch { return false; }
  }
  private recoverChaoxingSubmissions(): void {
    const paused = this.db.all<TaskRow>("SELECT * FROM tasks WHERE platform='cx' AND state='paused' AND detail IN (?1,?2)", LEGACY_SUBMISSION_UNCONFIRMED, AUTO_SUBMISSION_UNCONFIRMED);
    if (!paused.length) return;
    const module = this.installedModule('cx');
    if (module?.enabled !== 1) return;
    const manifest = JSON.parse(module.manifest) as Manifest;
    if (manifest.platform.supports_submission_retry !== true) return;
    for (const row of paused) {
      if (this.controllers.has(row.id) || quietFor(this.db, row.owner).active ||
          this.db.get<{ disabled: number }>('SELECT disabled FROM users WHERE id=?1', row.owner)?.disabled !== 0) continue;
      try {
        const input = this.storedInput(row);
        if (!input?.account) continue;
        if (row.detail === AUTO_SUBMISSION_UNCONFIRMED && input.version === module.version && row.operation !== 'study') continue;
        const checkpoint = this.loadCheckpoint(row);
        if (!this.canRecoverSubmission(row, input, checkpoint, manifest)) continue;
        const sessionOwner = taskPlatformOwner(this.db, row);
        if (input.account !== this.manager.accountKey(sessionOwner, row.platform)) continue;
        if (input.version !== module.version) {
          if (this.moduleUpdate(row, input, module, checkpoint).blocked_reason) continue;
          this.migrate(row.owner, row.id, module.version);
        }
        this.resume(row.owner, row.id);
        this.event(row.id, 'submission_recovery', '已排队，自动核对先前待确认的超星答卷');
      } catch (error) {
        this.log('warn', `任务 ${row.id} 无法恢复交卷核对：${(error as Error).message}`);
      }
    }
  }

  private schedule(): void {
    if (this.stopping) return;
    try {
      for (const row of this.db.all<TaskRow>("SELECT * FROM tasks WHERE state IN ('queued','running')")) {
        if (!quietFor(this.db, row.owner).active) continue;
        this.update(row.id, { state: 'paused', detail: '夜间暂停，将在 07:00 自动继续' });
        this.db.run('UPDATE tasks SET generation=generation+1 WHERE id=?1', row.id);
        this.controllers.get(row.id)?.abort(); this.manager.cancelJob(row.id); this.event(row.id, 'paused', '夜间暂停');
      }
      for (const row of this.db.all<TaskRow>("SELECT * FROM tasks WHERE state='paused' AND detail='夜间暂停，将在 07:00 自动继续'")) {
        if (quietFor(this.db, row.owner).active) continue;
        try { this.resume(row.owner, row.id); }
        catch (error) {
          if ((error as { code?: string }).code !== 'module_version_changed') throw error;
          this.update(row.id, { detail: MODULE_VERSION_CHANGED });
          this.event(row.id, 'paused', MODULE_VERSION_CHANGED);
        }
      }
      this.recoverChaoxingSubmissions();
      const queued = this.db.all<TaskRow>("SELECT t.* FROM tasks t LEFT JOIN task_order o ON o.task_id=t.id WHERE t.state='queued' ORDER BY coalesce(o.position,t.created_at)");
      for (const row of queued) if (!this.executions.has(row.id)) this.launch(row.id);
    } catch (error) { this.log('warn', `任务调度暂时失败：${(error as Error).message}`); }
  }

  private view(row: TaskRow): TaskView {
    let checkpoint: Checkpoint | undefined;
    try { checkpoint = this.loadCheckpoint(row); } catch { /* Keep the task visible after a read error. */ }
    let moduleUpdate: TaskView['module_update'];
    if (row.state === 'paused') {
      let input: JobInput | undefined;
      try { input = this.storedInput(row); } catch { /* The migration route reports the read error. */ }
      const module = input && this.installedModule(row.platform);
      if (input && module && input.version !== module.version) {
        moduleUpdate = this.moduleUpdate(row, input, module, checkpoint);
      }
    }
    return {
      id: row.id,
      platform: row.platform,
      account_id: row.account_id,
      account_label: row.account_id ? this.db.get<{ label: string }>('SELECT label FROM platform_accounts WHERE id=?1 AND owner=?2', row.account_id, row.owner)?.label ?? '已移除账号' : null,
      operation: row.operation,
      course_id: row.course_id,
      recruit_id: row.recruit_id,
      course_name: row.course_name,
      state: row.state,
      progress: row.progress,
      detail: row.detail,
      units: JSON.parse(row.units) as string[],
      completed: checkpoint?.completed ?? [],
      created_at: row.created_at,
      updated_at: row.updated_at,
      ...(moduleUpdate ? { module_update: moduleUpdate } : {}),
    };
  }

  create(
    owner: string,
    input: { platform: string; account_id?: string; course: Course; unit_ids: string[]; operation: string; options?: Record<string, unknown> },
  ): TaskView {
    const ownerRow = this.db.get<{ disabled: number; role: string }>('SELECT disabled,role FROM users WHERE id=?1', owner);
    if (ownerRow?.disabled !== 0) throw conflict('user_disabled', '此用户已停用');
    if (input.operation === 'trial' && ownerRow.role !== 'admin') throw forbidden('短时试跑仅供管理员诊断使用');
    const unitIds = [...new Set(input.unit_ids)];
    if (unitIds.length === 0) throw badRequest('请先选择学习单元');
    const maxUnits = input.platform === 'cx' && input.operation === 'study' ? MAX_CX_STUDY_UNITS : MAX_UNITS;
    if (unitIds.length > maxUnits) throw badRequest(`一次最多选择 ${maxUnits} 个单元`);
    if (!['study', 'trial', 'review', 'answer', 'mastery', 'meeting', 'qa', 'ask'].includes(input.operation)) throw badRequest('框架尚未提供此任务类型', 'unsupported_operation');
    const autoQuiz = input.options?.auto_prerequisite_quizzes;
    if (autoQuiz !== undefined && typeof autoQuiz !== 'boolean') throw badRequest('前置测验选项必须是布尔值');
    if (autoQuiz) {
      if (input.platform !== 'cx' || input.operation !== 'study' || !unitIds.some(deferredChapterId)) {
        throw badRequest('自动处理前置测验需要选择超星待解锁章节');
      }
      const module = this.installedModule(input.platform);
      const manifest = module && JSON.parse(module.manifest) as Manifest;
      if (!manifest?.platform.presentation?.actions?.some(action => action.id === 'auto_prerequisite_quizzes')) {
        throw badRequest('当前超星模块不支持自动处理前置测验，请更新模块');
      }
    }
    const count = this.db.get<{ count: number }>("SELECT count(*) AS count FROM tasks WHERE owner=?1 AND state IN ('queued','running','paused')", owner)?.count ?? 0;
    if (count >= 20) throw badRequest('最多保留 20 项未结束任务，请先停止不需要的任务');
    const sessionOwner = platformOwner(this.db, owner, input.platform, input.account_id);
    const account = this.manager.accountKey(sessionOwner, input.platform);
    const connection = this.manager.connectionId(sessionOwner, input.platform);
    if (!account || !connection) throw conflict('platform_not_connected', '请先连接平台账号');
    if (quietFor(this.db, owner).active) {
      throw conflict('quiet_hours', '夜间暂停期间不能新建任务');
    }
    const user = preferences(this.db, owner);
    if (input.operation === 'ask') {
      const texts = input.options?.texts;
      const cap = user.qa_allow_over_limit ? 50 : 10;
      if (!Array.isArray(texts) || texts.length < 1 || texts.length > cap || texts.some(text => typeof text !== 'string' || [...text.trim()].length < 10 || [...text].length > 1000)) throw badRequest(`请提供 1–${cap} 条有效提问草稿`);
    }
    if (input.operation === 'qa') {
      const limit = input.options?.limit ?? 5;
      const cap = user.qa_allow_over_limit ? 50 : 20;
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > cap) throw badRequest(`本次回答数量应为 1–${cap}`);
    }
    const id = randomId();
    const now = nowSeconds();
    this.db.run(
      `INSERT INTO tasks(id,owner,platform,operation,course_id,recruit_id,course_name,units,state,generation,detail,created_at,updated_at,account_id)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'queued',1,'正在排队',?9,?9,?10)`,
      id,
      owner,
      input.platform,
      input.operation,
      input.course.id,
      input.course.recruit_id,
      input.course.name,
      JSON.stringify(unitIds),
      now,
      input.account_id ?? null,
    );
    this.event(id, 'created', `已创建任务：${input.course.name}`);
    const data: JobInput = { account, connection, version: this.manager.moduleVersion(input.platform), options: { parallel_study: user.parallel_study, speedup: user.speedup, review_minutes: user.review_minutes, model_id: user.model_id, ...input.options, ...(['qa', 'ask'].includes(input.operation) ? { allow_over_limit: user.qa_allow_over_limit } : {}) } };
    const sealed = this.vault.sealJson(owner, `job/${id}/input`, data);
    this.db.run('INSERT INTO task_inputs VALUES(?1,?2)', id, new Uint8Array(sealed));
    const order = this.db.get<{ n: number }>('SELECT coalesce(max(position),0)+1 AS n FROM task_order')!.n;
    this.db.run('INSERT INTO task_order VALUES(?1,?2)', id, order);
    this.launch(id);
    return this.get(owner, id);
  }

  stop(owner: string, id: string): TaskView {
    const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?1 AND owner = ?2', id, owner);
    if (!row) throw notFound('找不到这个任务');
    if (['completed', 'failed', 'cancelled'].includes(row.state)) return this.view(row);
    this.db.run(
      "UPDATE tasks SET state = 'cancelled', generation = generation + 1, detail = '已由用户停止', updated_at = ?1 WHERE id = ?2",
      nowSeconds(),
      id,
    );
    this.event(id, 'cancelled', '任务已停止');
    this.controllers.get(id)?.abort();
    this.manager.cancelJob(id);
    return this.get(owner, id);
  }

  remove(owner: string, id: string): void {
    const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?1 AND owner=?2', id, owner);
    if (!row) throw notFound('找不到这个任务');
    if (row.state === 'running') throw conflict('task_running', '请先停止执行中的任务，再删除记录');
    if (this.controllers.has(id)) throw conflict('task_stopping', '任务正在停止，请稍后再删除记录');
    if (this.db.get("SELECT 1 FROM operation_locks WHERE task_id=?1 AND state IN ('pending','unknown')", id)) {
      throw conflict('submission_unknown', '此任务的交卷结果尚未核对，请先回读确认后再删除记录');
    }
    // Task-owned input, queue position and events cascade. Keep the independent
    // write ledger and operation locks so deletion cannot erase submission evidence.
    this.db.transaction(() => this.db.run('DELETE FROM tasks WHERE id=?1 AND owner=?2', id, owner));
    this.manager.cancelJob(id);
  }

  pause(owner: string, id: string): TaskView {
    const task = this.get(owner, id);
    if (task.state === 'paused') {
      this.db.run("UPDATE tasks SET detail='已由用户暂停' WHERE id=?1", id);
      return this.get(owner, id);
    }
    if (!['queued', 'running'].includes(task.state)) {
      throw conflict('invalid_state', '只有排队或运行中的任务可以暂停');
    }
    this.pauseActive(id, '已由用户暂停');
    return this.get(owner, id);
  }

  pauseForModuleUpdate(platform: string): void {
    const rows = this.db.all<{ id: string }>("SELECT id FROM tasks WHERE platform=?1 AND state IN ('queued','running')", platform);
    for (const row of rows) this.pauseActive(row.id, MODULE_VERSION_CHANGED);
  }

  private pauseActive(id: string, detail: string): void {
    this.db.run(
      "UPDATE tasks SET state = 'paused', generation = generation + 1, detail = ?1, updated_at = ?2 WHERE id = ?3",
      detail, nowSeconds(), id,
    );
    this.event(id, 'paused', detail);
    this.controllers.get(id)?.abort();
    this.manager.cancelJob(id);
  }

  migrate(owner: string, id: string, toVersion: unknown): TaskView {
    if (typeof toVersion !== 'string' || !toVersion) throw badRequest('请指定迁移的模块版本');
    return this.db.transaction(() => {
      const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?1 AND owner=?2', id, owner);
      if (!row) throw notFound('找不到这个任务');
      if (this.db.get<{ disabled: number }>('SELECT disabled FROM users WHERE id=?1', owner)?.disabled !== 0) throw conflict('user_disabled', '此用户已停用');
      if (row.state !== 'paused') throw conflict('invalid_state', '只有已暂停的任务可以迁移');
      if (this.controllers.has(id)) throw conflict('task_stopping', '任务正在停止，请稍后再迁移');
      const module = this.installedModule(row.platform);
      if (!module) throw conflict('module_unavailable', '平台模块未安装');
      if (module.version !== toVersion) throw conflict('module_version_changed', '模块版本已变化，请刷新任务后重新核对');
      const input = this.storedInput(row);
      if (!input) throw conflict('checkpoint_unavailable', '任务缺少原始模块版本和账号记录');
      if (input.version === module.version) return this.view(row);

      const update = this.moduleUpdate(row, input, module, this.loadCheckpoint(row));
      if (update.blocked_reason) throw conflict('task_migration_blocked', update.blocked_reason);
      const sessionOwner = taskPlatformOwner(this.db, row);
      if (!input.account || input.account !== this.manager.accountKey(sessionOwner, row.platform)) {
        throw conflict('platform_account_changed', '请连接任务原有的平台账号后再迁移');
      }

      this.saveInput(row, { ...input, version: module.version });
      this.update(id, { detail: `已迁移到模块 ${module.version}，可以继续任务` });
      this.event(id, 'module_migrated', `模块 ${input.version} → ${module.version}，保留原任务检查点`);
      return this.get(owner, id);
    });
  }

  resume(owner: string, id: string): TaskView {
    const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?1 AND owner = ?2', id, owner);
    if (!row) throw notFound('找不到这个任务');
    if (this.db.get<{ disabled: number }>('SELECT disabled FROM users WHERE id=?1', owner)?.disabled !== 0) throw conflict('user_disabled', '此用户已停用');
    if (row.state !== 'paused') throw conflict('invalid_state', '只有已暂停的任务可以继续');
    if (quietFor(this.db, owner).active) throw conflict('quiet_hours', '夜间暂停期间不能继续任务');
    this.requireCurrentModule(row);
    this.db.run(
      "UPDATE tasks SET state = 'queued', generation = generation + 1, detail = '等待继续', updated_at = ?1 WHERE id = ?2",
      nowSeconds(),
      id,
    );
    this.event(id, 'resumed', '继续任务');
    this.launch(id);
    return this.get(owner, id);
  }

  private launch(taskId: string): void {
    if (this.stopping) return;
    // Resume waits for the cancelled generation to finish before creating a new executor.
    const execution = (this.executions.get(taskId) ?? Promise.resolve()).then(() => this.run(taskId));
    this.executions.set(taskId, execution);
    const cleanup = () => {
      if (this.executions.get(taskId) === execution) this.executions.delete(taskId);
    };
    void execution.then(cleanup, (error: Error) => {
      cleanup();
      this.log('error', `任务执行器失败：${error.message}`);
    });
  }

  private event(taskId: string, kind: string, detail: string): void {
    this.db.run(
      'INSERT INTO task_events(task_id,kind,detail,created_at) VALUES(?1,?2,?3,?4)',
      taskId,
      kind,
      detail,
      nowSeconds(),
    );
  }

  private update(id: string, fields: Partial<Pick<TaskRow, 'state' | 'progress' | 'detail' | 'checkpoint' | 'units'>>): void {
    const sets: string[] = [];
    const values: Array<string | number | null | Uint8Array> = [];
    let index = 1;
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = ?${index}`);
      values.push(value as string | number | null | Uint8Array);
      index += 1;
    }
    sets.push(`updated_at = ?${index}`);
    values.push(nowSeconds());
    values.push(id);
    this.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?${index + 1}`, ...values);
  }

  private async run(taskId: string): Promise<void> {
    const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?1', taskId);
    if (!row || row.state !== 'queued' || this.stopping) return;
    if (!this.canRun(row)) return;
    if (this.controllers.has(taskId)) return;
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    const generation = row.generation;

    try {
      this.update(taskId, { state: 'running', detail: '准备目录' });
      const current = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?1', taskId)!;
      const input = this.input(current);
      if (input.version !== this.manager.moduleVersion(current.platform)) throw conflict('module_version_changed', MODULE_VERSION_CHANGED);
      const sessionOwner = taskPlatformOwner(this.db, current);
      if (input.account !== this.manager.accountKey(sessionOwner, current.platform)) throw conflict('platform_account_changed', '平台账号已变化，请为当前账号新建任务');
      if (input.connection !== this.manager.connectionId(sessionOwner, current.platform)) {
        input.connection = this.manager.connectionId(sessionOwner, current.platform)!;
        this.saveInput(current, input);
      }
      const unitIds = JSON.parse(current.units) as string[];
      const platform = await this.manager.describe(current.platform);
      const courses = await this.manager.courses(sessionOwner, current.platform);
      const course = courses.find(
        (item) => item.id === current.course_id && item.recruit_id === current.recruit_id,
      );
      if (!course) throw conflict('course_not_found', '课程已不在平台上，任务无法继续');
      const checkpoint = this.loadCheckpoint(current);
      const check = () => {
        if (controller.signal.aborted || !this.stillRunning(taskId, generation)) throw conflict('task_cancelled', '任务执行已取消');
        if (quietFor(this.db, current.owner).active) throw conflict('quiet_hours', '夜间暂停');
      };
      const workflowContext = (): WorkflowContext => {
        if (!this.ai || !this.memory) throw conflict('unsupported_operation', '模型和活动服务尚未初始化');
        return {
          db: this.db, manager: this.manager, ai: this.ai, memory: this.memory, platformOwner: sessionOwner, task: current, input, course, checkpoint, signal: controller.signal,
          check, save: () => { check(); this.saveCheckpoint(taskId, current.owner, checkpoint); },
          update: (detail, progress) => { check(); this.update(taskId, { detail, ...(progress === undefined ? {} : { progress }) }); },
          pause: (detail) => { check(); this.update(taskId, { state: 'paused', detail }); this.event(taskId, 'paused', detail); },
          event: (kind, detail) => { check(); this.event(taskId, kind, detail); },
        };
      };
      if (!['study', 'trial'].includes(current.operation)) {
        await runWorkflow(workflowContext());
        if (this.stillRunning(taskId, generation)) {
          const latest = this.get(current.owner, taskId);
          this.update(taskId, { state: 'completed', progress: 100, detail: (current.operation === 'review' || current.operation === 'mastery' && checkpoint.workflow?.remaining || checkpoint.skipped?.length) ? latest.detail : '任务完成' });
          this.event(taskId, 'completed', current.operation === 'review' ? latest.detail : '任务执行结束');
        }
        return;
      }
      let submissionUnconfirmed = false;
      const runQuiz = async (paper: Paper) => {
        const result = await runPrerequisiteQuiz(workflowContext(), paper);
        if (result === 'unconfirmed') {
          submissionUnconfirmed = true;
          this.event(taskId, 'submission_unconfirmed', '原答卷待确认，刷新超星目录并接续已开放的所选内容');
        }
        return result !== 'paused';
      };
      if (checkpoint.workflow?.kind === 'prerequisite_quiz' && !await runQuiz(checkpoint.workflow.paper as Paper)) return;
      const deferredStudy = current.platform === 'cx' && current.operation === 'study' && unitIds.some(deferredChapterId);
      const autoQuiz = deferredStudy && input.options.auto_prerequisite_quizzes === true;
      let units = await this.manager.units(sessionOwner, current.platform, course, deferredStudy || submissionUnconfirmed);
      if (controller.signal.aborted || !this.stillRunning(taskId, generation)) return;
      const selected = unitIds
        .map((id) => units.find((unit) => unit.id === id))
        .filter((unit): unit is Unit => unit !== undefined);
      if (!deferredStudy && selected.length === 0 && !submissionUnconfirmed) throw conflict('unit_not_found', '所选单元已不存在');

      // A unit the platform already reports as completed is not studied again: asking the
      // gateway to open it is what answers `421` on a finished course.
      for (const unit of selected) {
        if (unit.state === 'completed' && !checkpoint.completed.includes(unit.id)) {
          checkpoint.completed.push(unit.id);
        }
      }
      if (checkpoint.completed.length > 0) this.saveCheckpoint(taskId, current.owner, checkpoint);
      let pending = deferredStudy ? [] : selected.filter((unit) => !checkpoint.completed.includes(unit.id) && (!submissionUnconfirmed || unit.selectable));
      if (!deferredStudy && pending.length === 0 && !submissionUnconfirmed) {
        this.update(taskId, { state: 'completed', progress: 100, detail: '所选单元均已完成，无需继续学习' });
        this.event(taskId, 'completed', '所选单元均已完成');
        return;
      }
      let completed = checkpoint.completed.length;
      let scheduled = new Set(unitIds);
      if (deferredStudy) {
        let latestPrerequisiteBoundary = -1;
        for (const unit of units) {
          if (unit.selectable_after_unlock && scheduled.has(unit.id) && unit.chapter_order !== undefined) {
            latestPrerequisiteBoundary = Math.max(latestPrerequisiteBoundary, unit.chapter_order);
          }
        }
        const prerequisites = units.filter(unit => unit.chapter_order !== undefined && unit.chapter_order < latestPrerequisiteBoundary &&
          unit.state !== 'completed' && (unit.selectable || unit.selectable_after_unlock) && !checkpoint.completed.includes(unit.id));
        prerequisites.sort((first, next) => first.chapter_order! - next.chapter_order!);
        const ordered = new Set([...prerequisites.map(unit => unit.id), ...scheduled]);
        if (ordered.size > scheduled.size) {
          this.update(taskId, { units: JSON.stringify([...ordered]) });
          this.event(taskId, 'prerequisites_added', `已补选 ${ordered.size - scheduled.size} 个前置学习单元`);
        }
        scheduled = ordered;
      }
      const done = new Set(checkpoint.completed);
      let refreshAttempts = 0;
      let refresh = false;

      while (pending.length || deferredStudy) {
        if (!pending.length) {
          if (refresh) {
            this.update(taskId, { detail: '正在刷新超星目录，检查新解锁的单元' });
            units = await this.manager.units(sessionOwner, current.platform, course, true);
            if (!this.stillRunning(taskId, generation)) return;
          }
          const byId = new Map(units.map(unit => [unit.id, unit]));
          const byChapter = new Map<string, Unit[]>();
          for (const unit of units) {
            const chapter = byChapter.get(unit.chapter_id);
            if (chapter) chapter.push(unit); else byChapter.set(unit.chapter_id, [unit]);
          }
          const expanded = new Set<string>();
          let unlocked = 0;
          let boundary = Infinity;
          for (const id of scheduled) {
            const chapter = deferredChapterId(id);
            const unit = byId.get(id);
            if (autoQuiz && unit?.selectable_after_unlock && !done.has(id)) {
              boundary = Math.min(boundary, unit.chapter_order ?? Infinity);
            }
            const children = chapter && !unit ? byChapter.get(chapter) : undefined;
            if (children?.length) {
              for (const unit of children) expanded.add(unit.id);
              unlocked += 1;
            } else {
              expanded.add(id);
            }
          }
          if (unlocked) {
            scheduled = expanded;
            this.update(taskId, { units: JSON.stringify([...scheduled]) });
            this.event(taskId, 'units_discovered', `已接续 ${unlocked} 个解锁章节`);
          }
          for (const id of scheduled) {
            const unit = byId.get(id);
            if (unit?.state === 'completed' && !done.has(id)) {
              done.add(unit.id);
              checkpoint.completed.push(unit.id);
            } else if (unit?.selectable && !done.has(id) && (submissionUnconfirmed || (unit.chapter_order ?? -1) < boundary)) {
              pending.push(unit);
            }
          }
          completed = checkpoint.completed.length;
          this.saveCheckpoint(taskId, current.owner, checkpoint);
          if (!pending.length) {
            const blocked = [...scheduled].filter(id => !done.has(id));
            if (!blocked.length) break;
            const deferred = blocked.filter(deferredChapterId);
            if (refreshAttempts < 2 && deferred.length) {
              refreshAttempts += 1;
              await sleep(3000, controller.signal);
              if (!this.stillRunning(taskId, generation)) return;
              refresh = true;
              continue;
            }
            if (autoQuiz && deferred.length) {
              const result = await this.manager.invoke(sessionOwner, current.platform, 'catalog.papers', { course });
              check();
              const quizzes = (result.papers as Paper[]).filter((paper): paper is Paper & { chapter_id: string; chapter_order: number } =>
                paper.task_point === true && typeof paper.chapter_id === 'string' && typeof paper.chapter_order === 'number');
              const confirmed = new Set(checkpoint.prerequisite_quizzes?.completed);
              const waitingQuizzes = quizzes.filter(paper => !paper.done && !confirmed.has(paper.id));
              // An unlocked chapter may have only quizzes and therefore no ordinary units.
              const quizChapters = new Set(quizzes.map(paper => paper.chapter_id));
              const unfinishedQuizChapters = new Set(waitingQuizzes.map(paper => paper.chapter_id));
              for (const id of deferred) {
                const chapter = deferredChapterId(id)!;
                if (!byChapter.has(chapter) && quizChapters.has(chapter) && !unfinishedQuizChapters.has(chapter)) {
                  done.add(id);
                  checkpoint.completed.push(id);
                }
              }
              this.saveCheckpoint(taskId, current.owner, checkpoint);
              if (blocked.every(id => done.has(id))) break;

              const unfinishedStudyChapters = new Set(units.filter(unit => unit.state !== 'completed' && !done.has(unit.id))
                .map(unit => unit.chapter_id));
              const quiz = !submissionUnconfirmed && Number.isFinite(boundary)
                ? waitingQuizzes.filter(paper => paper.available && paper.chapter_order < boundary && !unfinishedStudyChapters.has(paper.chapter_id))
                  .sort((a, b) => a.chapter_order - b.chapter_order)[0]
                : undefined;
              if (quiz) {
                this.event(taskId, 'prerequisite_quiz', `解锁前置测验：${quiz.name}`);
                if (!await runQuiz(quiz)) return;
                refresh = true;
                refreshAttempts = 0;
                continue;
              }
            }
            const remaining = blocked.filter(id => !done.has(id));
            const name = byId.get(remaining[0])?.name;
            const detail = `${submissionUnconfirmed ? '原答卷待确认。' : ''}还有 ${remaining.length} 项所选内容待解锁或需人工处理${name ? `（${name}）` : ''}，处理后可继续此任务`;
            this.update(taskId, { state: 'paused', detail });
            this.event(taskId, 'paused', detail);
            return;
          }
          refresh = true;
          refreshAttempts = 0;
        }
        const unit = pending.shift()!;
        const total = deferredStudy ? scheduled.size : selected.length;
        this.update(taskId, {
          detail: `正在学习：${unit.name}`,
          progress: deferredStudy ? Math.min(99, Math.round(completed / total * 100)) : Math.max(current.progress ?? 0, Math.round(completed / total * 100)),
        });
        let steps = 0;
        while (steps < STEP_CAP) {
          if (controller.signal.aborted) return;
          if (!this.stillRunning(taskId, generation)) return;
          if (quietFor(this.db, current.owner).active) {
            this.update(taskId, { state: 'paused', detail: '夜间暂停，将在 07:00 自动继续' });
            this.event(taskId, 'paused', '夜间暂停');
            return;
          }
          steps += 1;
          const outcome = await this.manager.studyStep(
            sessionOwner,
            current.platform,
            course,
            unit,
            checkpoint.positions[unit.id] ?? null,
            { ...input.options, operation: current.operation, max_speed: input.options.speedup ? platform.platform.max_speed ?? 1 : 1, execution_id: `${taskId}/${generation}`, interaction_answers: checkpoint.interactions?.[unit.id] ?? {} },
            { id: taskId, generation },
          );
          // An in-flight step may settle after pause/stop. Its old generation cannot publish
          // progress, checkpoints or completion into the new task state.
          if (controller.signal.aborted || !this.stillRunning(taskId, generation)) return;
          const status = String(outcome.status ?? '');
          if (outcome.checkpoint !== undefined) { checkpoint.positions[unit.id] = outcome.checkpoint; this.saveCheckpoint(taskId, current.owner, checkpoint); }
          if (status === 'needs_ai' && Array.isArray(outcome.questions)) {
            const questions = outcome.questions as Question[];
            const answers = checkpoint.interactions?.[unit.id] ?? {};
            checkpoint.workflow = { kind: 'interaction', phase: 'waiting_answers', unit_id: unit.id, questions, answers, preserve: [] };
            for (const q of questions) q.images = (q.images ?? []).map((url) => this.manager.registerImage(sessionOwner, current.platform, url));
            for (const q of questions) {
              const courseKey = `${course.id}/${course.recruit_id}`;
              if (validAnswer(q, q.correct_answer)) this.memory?.remember(current.owner, current.platform, courseKey, q, q.correct_answer);
              if (!validAnswer(q, answers[q.id])) {
                const known = this.memory?.get(current.owner, current.platform, courseKey, q, course.kind);
                if (known) answers[q.id] = known;
              }
            }
            this.saveCheckpoint(taskId, current.owner, checkpoint);
            try {
              if ((!this.ai || input.options.use_ai === false) && questions.some(q => !validAnswer(q, answers[q.id]))) throw badRequest('请在任务详情中人工回答视频弹题');
              for (const q of questions) {
                if (validAnswer(q, answers[q.id])) continue;
                const images = await Promise.all((q.images ?? []).map((url) => this.manager.image(sessionOwner, current.platform, url)));
                const raw = await this.ai!.generate(current.owner, questionPrompt(q), { modelId: input.options.model_id as string | undefined, system: ANSWER_SYSTEM, images, signal: controller.signal });
                if (controller.signal.aborted || !this.stillRunning(taskId, generation)) return;
                answers[q.id] = parseModelAnswer(q, raw).answer;
              }
              checkpoint.interactions ??= {}; checkpoint.interactions[unit.id] = answers; checkpoint.workflow.phase = 'answered';
              this.saveCheckpoint(taskId, current.owner, checkpoint); continue;
            } catch (error) {
              if (controller.signal.aborted || !this.stillRunning(taskId, generation)) return;
              this.update(taskId, { state: 'paused', detail: `视频弹题需要补答：${(error as Error).message}` });
              return;
            }
          }
          if (status === 'in_progress') {
            checkpoint.positions[unit.id] = outcome.checkpoint ?? checkpoint.positions[unit.id] ?? null;
            this.saveCheckpoint(taskId, current.owner, checkpoint);
            const seconds = Number(
              (outcome.progress as { watched_seconds?: number } | undefined)?.watched_seconds ?? 0,
            );
            const duration = Number(unit.duration_seconds ?? 0);
            const fraction = duration > 0 && Number.isFinite(seconds)
              ? Math.max(0, Math.min(1, seconds / duration)) : 0;
            this.update(taskId, {
              detail: typeof outcome.detail === 'string' ? `${unit.name}：${outcome.detail}` : `正在学习：${unit.name}（已 ${Number.isFinite(seconds) ? seconds : 0} 秒）`,
              progress: Math.max(deferredStudy ? 0 : current.progress ?? 0,
                Math.min(99, Math.round(((completed + fraction) / total) * 100))),
            });
            const wait = Math.min(Number(outcome.wait_ms ?? 1000) || 1000, 60_000);
            await sleep(wait, controller.signal);
            continue;
          }
          if (status === 'completed') {
            checkpoint.completed.push(unit.id);
            done.add(unit.id);
            checkpoint.positions[unit.id] = outcome.checkpoint ?? null;
            completed = checkpoint.completed.length;
            this.saveCheckpoint(taskId, current.owner, checkpoint);
            this.update(taskId, {
              progress: Math.min(deferredStudy ? 99 : 100, Math.round((completed / total) * 100)),
              detail: `已完成：${unit.name}`,
            });
            this.event(taskId, 'unit_completed', unit.name);
            break;
          }
          if (status === 'needs_human' || status === 'blocked' || status === 'unknown') {
            this.update(taskId, {
              state: 'paused',
              detail: `需要人工处理：${String(outcome.reason ?? status)}`,
            });
            this.event(taskId, status, `${unit.name}：${String(outcome.reason ?? '')}`);
            return;
          }
          throw conflict('module_protocol_error', `模块返回了未知状态：${status}`);
        }
        if (!done.has(unit.id) && steps >= STEP_CAP) {
          this.update(taskId, { state: 'paused', detail: '单元步数过多，已暂停等待人工检查' });
          return;
        }
      }

      if (submissionUnconfirmed) {
        workflowContext().pause('已处理平台开放的所选内容，原答卷仍待确认。');
        return;
      }
      this.update(taskId, { state: 'completed', progress: 100, detail: '任务完成' });
      this.event(taskId, 'completed', '任务完成');
    } catch (error) {
      if (controller.signal.aborted || !this.stillRunning(taskId, generation)) return;
      const message = (error as Error).message;
      const code = (error as { code?: string }).code ?? '';
      const recoverable = !['study', 'trial'].includes(row.operation) || /^(platform_|module_|browser_|model_|ai_|quiet_hours|checkpoint_)/.test(code);
      this.update(taskId, { state: recoverable ? 'paused' : 'failed', detail: code === 'quiet_hours' ? '夜间暂停，将在 07:00 自动继续' : message });
      this.event(taskId, recoverable ? 'paused' : 'failed', message);
      this.log('warn', `任务 ${taskId} 失败：${message}`);
    } finally {
      this.manager.cancelJob(taskId);
      if (this.controllers.get(taskId) === controller) this.controllers.delete(taskId);
    }
  }

  private stillRunning(taskId: string, generation: number): boolean {
    const row = this.db.get<{ state: string; generation: number }>(
      'SELECT state, generation FROM tasks WHERE id = ?1',
      taskId,
    );
    return row !== undefined && row.state === 'running' && row.generation === generation;
  }

  private loadCheckpoint(row: TaskRow): Checkpoint {
    if (!row.checkpoint) return { completed: [], positions: {} };
    try {
      const checkpoint = JSON.parse(
        this.vault.open(row.owner, `job/${row.id}`, Buffer.from(row.checkpoint)).toString('utf8'),
      ) as Checkpoint;
      if (!Array.isArray(checkpoint?.completed) || !checkpoint.positions || typeof checkpoint.positions !== 'object' || Array.isArray(checkpoint.positions)) {
        throw new Error('Invalid checkpoint');
      }
      return checkpoint;
    } catch {
      throw conflict('checkpoint_unavailable', '任务检查点无法解密，请保留数据并核对密钥；不会重新执行未知步骤');
    }
  }

  private saveCheckpoint(taskId: string, owner: string, checkpoint: Checkpoint): void {
    const sealed = this.vault.seal(owner, `job/${taskId}`, Buffer.from(JSON.stringify(checkpoint)));
    this.update(taskId, { checkpoint: new Uint8Array(sealed) });
  }

  abortAll(): void {
    for (const [id, controller] of this.controllers) { controller.abort(); this.manager.cancelJob(id); }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.scheduler) clearInterval(this.scheduler);
    const ownedTasks = [...this.executions.keys()];
    this.abortAll();
    // Keep SQLite and module services alive until all in-flight continuations have settled.
    await Promise.allSettled(this.executions.values());
    for (const id of ownedTasks) {
      this.db.run(
        "UPDATE tasks SET state = 'paused', generation = generation + 1, detail = '服务已停止，请核对进度后继续', updated_at = ?1 WHERE id = ?2 AND state IN ('queued','running')",
        nowSeconds(), id,
      );
    }
  }
}
