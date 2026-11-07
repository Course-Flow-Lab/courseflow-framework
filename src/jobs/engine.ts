import type { Db } from '../core/db.ts';
import type { Vault } from '../core/vault.ts';
import type { ModuleManager } from '../modules/manager.ts';
import type { Course, Unit, Question } from '../modules/protocol.ts';
import { nowSeconds, quietStatus, randomId, sleep } from '../core/domain.ts';
import { badRequest, conflict, notFound } from '../core/errors.ts';
import { preferences } from '../core/preferences.ts';
import type { AiService } from '../services/ai.ts';
import { AnswerMemory, validAnswer, ANSWER_SYSTEM, questionPrompt, parseModelAnswer } from '../services/answers.ts';
import { runWorkflow, type WorkflowContext } from './workflows.ts';

export type TaskRow = {
  id: string;
  owner: string;
  platform: string;
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
  id: string;
  platform: string;
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
};

export type Checkpoint = { completed: string[]; current?: string; seconds?: number; positions: Record<string, unknown>; [key: string]: any };
export type JobInput = { options: Record<string, unknown>; account: string; connection: string; version: string };

const MAX_UNITS = 200;
const STEP_CAP = 400;

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
    return { workflow: cp.workflow ?? null, reviewed_seconds: cp.reviewed ?? 0 };
  }

  answers(owner: string, id: string, body: { answers?: Record<string, string[]>; text?: string; replace_existing?: boolean }): TaskView {
    const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?1 AND owner=?2', id, owner);
    if (!row) throw notFound('找不到这个任务');
    if (row.state !== 'paused') throw conflict('invalid_state', '请先暂停任务再补答');
    const cp = this.loadCheckpoint(row);
    const workflow = cp.workflow;
    if (!workflow) throw badRequest('当前任务没有需要补充的内容');
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
    if (quietStatus(nowSeconds()).active) throw conflict('quiet_hours', '夜间暂停期间不能交卷');
    const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?1 AND owner=?2', id, owner);
    if (!row) throw notFound('找不到这个任务');
    const cp = this.loadCheckpoint(row);
    if (row.state !== 'paused' || cp.workflow?.phase !== 'waiting_submit') throw conflict('invalid_state', '当前任务不在等待交卷确认的阶段');
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
    if (input.account !== this.manager.accountKey(owner, row.platform)) throw conflict('platform_account_changed', '平台账号已变化，请连接原账号再回读');
    const courses = await this.manager.courses(owner, row.platform);
    const course = courses.find((c) => c.id === row.course_id && c.recruit_id === row.recruit_id);
    if (!course) throw notFound('找不到原课程');
    const result = await this.manager.invoke(owner, row.platform, 'exam.readback', { course, attempt_id: workflow.attempt.id });
    if (!result.confirmed || result.attempt_id !== workflow.attempt.id) throw conflict('submission_unknown', '平台仍未确认本次作答，不会重新提交');
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

  private input(row: TaskRow): JobInput {
    const stored = this.db.get<{ sealed: Uint8Array }>('SELECT sealed FROM task_inputs WHERE task_id=?1', row.id);
    if (stored) return this.vault.openJson<JobInput>(row.owner, `job/${row.id}/input`, Buffer.from(stored.sealed));
    const input: JobInput = { account: this.manager.accountKey(row.owner, row.platform) ?? '', connection: this.manager.connectionId(row.owner, row.platform) ?? '', version: this.manager.moduleVersion(row.platform), options: preferences(this.db, row.owner) as unknown as Record<string, unknown> };
    this.saveInput(row, input); return input;
  }
  private saveInput(row: TaskRow, input: JobInput): void {
    const sealed = this.vault.sealJson(row.owner, `job/${row.id}/input`, input);
    this.db.run('INSERT INTO task_inputs VALUES(?1,?2) ON CONFLICT(task_id) DO UPDATE SET sealed=excluded.sealed', row.id, new Uint8Array(sealed));
  }
  private canRun(row: TaskRow): boolean {
    const running = this.db.all<TaskRow>("SELECT * FROM tasks WHERE state='running' AND id!=?1", row.id);
    const user = preferences(this.db, row.owner);
    if (running.filter((r) => r.owner === row.owner).length >= user.concurrency) return false;
    const account = this.manager.accountKey(row.owner, row.platform);
    for (const other of running) {
      if (this.manager.accountKey(other.owner, other.platform) !== account) continue;
      const parallel = user.parallel_study && preferences(this.db, other.owner).parallel_study && row.operation === 'study' && other.operation === 'study';
      if (!parallel || row.course_id === other.course_id && row.recruit_id === other.recruit_id) return false;
    }
    return true;
  }
  private schedule(): void {
    if (this.stopping) return;
    try {
      const quiet = quietStatus(nowSeconds()).active;
      if (quiet) {
        for (const row of this.db.all<TaskRow>("SELECT * FROM tasks WHERE state IN ('queued','running')")) {
          this.update(row.id, { state: 'paused', detail: '夜间暂停，将在 07:00 自动继续' });
          this.db.run('UPDATE tasks SET generation=generation+1 WHERE id=?1', row.id);
          this.controllers.get(row.id)?.abort(); this.manager.cancelJob(row.id); this.event(row.id, 'paused', '夜间暂停');
        }
        return;
      }
      for (const row of this.db.all<TaskRow>("SELECT * FROM tasks WHERE state='paused' AND detail='夜间暂停，将在 07:00 自动继续'")) this.resume(row.owner, row.id);
      const queued = this.db.all<TaskRow>("SELECT t.* FROM tasks t LEFT JOIN task_order o ON o.task_id=t.id WHERE t.state='queued' ORDER BY coalesce(o.position,t.created_at)");
      for (const row of queued) if (!this.executions.has(row.id)) this.launch(row.id);
    } catch (error) { this.log('warn', `任务调度暂时失败：${(error as Error).message}`); }
  }

  private view(row: TaskRow): TaskView {
    let checkpoint: Checkpoint = { completed: [], positions: {} };
    if (row.checkpoint) {
      try {
        checkpoint = JSON.parse(
          this.vault.open(row.owner, `job/${row.id}`, Buffer.from(row.checkpoint)).toString('utf8'),
        ) as Checkpoint;
      } catch {
        checkpoint = { completed: [], positions: {} };
      }
    }
    return {
      id: row.id,
      platform: row.platform,
      operation: row.operation,
      course_id: row.course_id,
      recruit_id: row.recruit_id,
      course_name: row.course_name,
      state: row.state,
      progress: row.progress,
      detail: row.detail,
      units: JSON.parse(row.units) as string[],
      completed: checkpoint.completed,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  create(
    owner: string,
    input: { platform: string; course: Course; unit_ids: string[]; operation: string; options?: Record<string, unknown> },
  ): TaskView {
    const unitIds = [...new Set(input.unit_ids)];
    if (unitIds.length === 0) throw badRequest('请先选择学习单元');
    if (unitIds.length > MAX_UNITS) throw badRequest('一次最多选择 200 个单元');
    if (!['study', 'trial', 'review', 'answer', 'mastery', 'meeting', 'qa', 'ask'].includes(input.operation)) throw badRequest('框架尚未提供此任务类型', 'unsupported_operation');
    const count = this.db.get<{ count: number }>("SELECT count(*) AS count FROM tasks WHERE owner=?1 AND state IN ('queued','running','paused')", owner)?.count ?? 0;
    if (count >= 20) throw badRequest('最多保留 20 项未结束任务，请先停止不需要的任务');
    const account = this.manager.accountKey(owner, input.platform);
    const connection = this.manager.connectionId(owner, input.platform);
    if (!account || !connection) throw conflict('platform_not_connected', '请先连接平台账号');
    if (quietStatus(nowSeconds()).active) {
      throw conflict('quiet_hours', '夜间暂停期间不能新建任务');
    }
    const id = randomId();
    const now = nowSeconds();
    this.db.run(
      `INSERT INTO tasks(id,owner,platform,operation,course_id,recruit_id,course_name,units,state,generation,detail,created_at,updated_at)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'queued',1,'正在排队',?9,?9)`,
      id,
      owner,
      input.platform,
      input.operation,
      input.course.id,
      input.course.recruit_id,
      input.course.name,
      JSON.stringify(unitIds),
      now,
    );
    this.event(id, 'created', `已创建任务：${input.course.name}`);
    const user = preferences(this.db, owner);
    const data: JobInput = { account, connection, version: this.manager.moduleVersion(input.platform), options: { parallel_study: user.parallel_study, speedup: user.speedup, review_minutes: user.review_minutes, model_id: user.model_id, ...input.options } };
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

  pause(owner: string, id: string): TaskView {
    const task = this.get(owner, id);
    if (task.state === 'paused') {
      this.db.run("UPDATE tasks SET detail='已由用户暂停' WHERE id=?1", id);
      return this.get(owner, id);
    }
    if (!['queued', 'running'].includes(task.state)) {
      throw conflict('invalid_state', '只有排队或运行中的任务可以暂停');
    }
    this.db.run(
      "UPDATE tasks SET state = 'paused', generation = generation + 1, detail = '已由用户暂停', updated_at = ?1 WHERE id = ?2",
      nowSeconds(), id,
    );
    this.event(id, 'paused', '已由用户暂停');
    this.controllers.get(id)?.abort();
    this.manager.cancelJob(id);
    return this.get(owner, id);
  }

  resume(owner: string, id: string): TaskView {
    const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?1 AND owner = ?2', id, owner);
    if (!row) throw notFound('找不到这个任务');
    if (row.state !== 'paused') throw conflict('invalid_state', '只有已暂停的任务可以继续');
    if (quietStatus(nowSeconds()).active) throw conflict('quiet_hours', '夜间暂停期间不能继续任务');
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

  private update(id: string, fields: Partial<Pick<TaskRow, 'state' | 'progress' | 'detail' | 'checkpoint'>>): void {
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
      if (input.account !== this.manager.accountKey(current.owner, current.platform)) throw conflict('platform_account_changed', '平台账号已变化，请为当前账号新建任务');
      if (input.connection !== this.manager.connectionId(current.owner, current.platform)) {
        input.connection = this.manager.connectionId(current.owner, current.platform)!;
        this.saveInput(current, input);
      }
      if (input.version !== this.manager.moduleVersion(current.platform)) throw conflict('module_version_changed', '平台模块已更新，请核对后重新创建任务');
      const unitIds = JSON.parse(current.units) as string[];
      const platform = await this.manager.describe(current.platform);
      const courses = await this.manager.courses(current.owner, current.platform);
      const course = courses.find(
        (item) => item.id === current.course_id && item.recruit_id === current.recruit_id,
      );
      if (!course) throw conflict('course_not_found', '课程已不在平台上，任务无法继续');
      if (!['study', 'trial'].includes(current.operation)) {
        if (!this.ai || !this.memory) throw conflict('unsupported_operation', '模型和活动服务尚未初始化');
        const checkpoint = this.loadCheckpoint(current);
        const check = () => { if (controller.signal.aborted || !this.stillRunning(taskId, generation)) throw conflict('task_cancelled', '任务执行已取消'); };
        const context: WorkflowContext = {
          db: this.db, manager: this.manager, ai: this.ai, memory: this.memory, task: current, input, course, checkpoint, signal: controller.signal,
          check, save: () => { check(); this.saveCheckpoint(taskId, current.owner, checkpoint); },
          update: (detail, progress) => { check(); this.update(taskId, { detail, ...(progress === undefined ? {} : { progress }) }); },
          pause: (detail) => { check(); this.update(taskId, { state: 'paused', detail }); this.event(taskId, 'paused', detail); },
          event: (kind, detail) => { check(); this.event(taskId, kind, detail); },
        };
        await runWorkflow(context);
        if (this.stillRunning(taskId, generation)) {
          const latest = this.get(current.owner, taskId);
          this.update(taskId, { state: 'completed', progress: 100, detail: (current.operation === 'review' || current.operation === 'mastery' && checkpoint.workflow?.remaining || checkpoint.skipped?.length) ? latest.detail : '任务完成' });
          this.event(taskId, 'completed', current.operation === 'review' ? latest.detail : '任务执行结束');
        }
        return;
      }
      const units = await this.manager.units(current.owner, current.platform, course);
      if (controller.signal.aborted || !this.stillRunning(taskId, generation)) return;
      const selected = unitIds
        .map((id) => units.find((unit) => unit.id === id))
        .filter((unit): unit is Unit => unit !== undefined);
      if (selected.length === 0) throw conflict('unit_not_found', '所选单元已不存在');

      let checkpoint = this.loadCheckpoint(current);
      // A unit the platform already reports as completed is not studied again: asking the
      // gateway to open it is what answers `421` on a finished course.
      for (const unit of selected) {
        if (unit.state === 'completed' && !checkpoint.completed.includes(unit.id)) {
          checkpoint.completed.push(unit.id);
        }
      }
      if (checkpoint.completed.length > 0) this.saveCheckpoint(taskId, current.owner, checkpoint);
      const pending = selected.filter((unit) => !checkpoint.completed.includes(unit.id));
      if (pending.length === 0) {
        this.update(taskId, { state: 'completed', progress: 100, detail: '所选单元均已完成，无需继续学习' });
        this.event(taskId, 'completed', '所选单元均已完成');
        return;
      }
      let completed = checkpoint.completed.length;

      for (const unit of pending) {
        this.update(taskId, {
          detail: `正在学习：${unit.name}`,
          progress: Math.max(current.progress ?? 0, Math.round((completed / selected.length) * 100)),
        });
        let steps = 0;
        while (steps < STEP_CAP) {
          if (controller.signal.aborted) return;
          if (!this.stillRunning(taskId, generation)) return;
          if (quietStatus(nowSeconds()).active) {
            this.update(taskId, { state: 'paused', detail: '夜间暂停，将在 07:00 自动继续' });
            this.event(taskId, 'paused', '夜间暂停');
            return;
          }
          steps += 1;
          const outcome = await this.manager.studyStep(
            current.owner,
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
            for (const q of questions) q.images = (q.images ?? []).map((url) => this.manager.registerImage(current.owner, current.platform, url));
            this.saveCheckpoint(taskId, current.owner, checkpoint);
            try {
              if (!this.ai || input.options.use_ai === false) throw badRequest('请在任务详情中人工回答视频弹题');
              for (const q of questions) {
                if (validAnswer(q, answers[q.id])) continue;
                const images = await Promise.all((q.images ?? []).map((url) => this.manager.image(current.owner, current.platform, url)));
                const raw = await this.ai.generate(current.owner, questionPrompt(q), { modelId: input.options.model_id as string | undefined, system: ANSWER_SYSTEM, images, signal: controller.signal });
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
              detail: `正在学习：${unit.name}（已 ${Number.isFinite(seconds) ? seconds : 0} 秒）`,
              progress: Math.max(current.progress ?? 0,
                Math.min(99, Math.round(((completed + fraction) / selected.length) * 100))),
            });
            const wait = Math.min(Number(outcome.wait_ms ?? 1000) || 1000, 60_000);
            await sleep(wait, controller.signal);
            continue;
          }
          if (status === 'completed') {
            checkpoint.completed.push(unit.id);
            checkpoint.positions[unit.id] = outcome.checkpoint ?? null;
            completed = checkpoint.completed.length;
            this.saveCheckpoint(taskId, current.owner, checkpoint);
            this.update(taskId, {
              progress: Math.round((completed / selected.length) * 100),
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
        if (steps >= STEP_CAP) {
          this.update(taskId, { state: 'paused', detail: '单元步数过多，已暂停等待人工检查' });
          return;
        }
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
      return JSON.parse(
        this.vault.open(row.owner, `job/${row.id}`, Buffer.from(row.checkpoint)).toString('utf8'),
      ) as Checkpoint;
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
