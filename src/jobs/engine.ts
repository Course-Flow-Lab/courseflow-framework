import type { Db } from '../core/db.ts';
import type { Vault } from '../core/vault.ts';
import type { ModuleManager } from '../modules/manager.ts';
import type { Course, Unit } from '../modules/protocol.ts';
import { nowSeconds, quietStatus, randomId, sleep } from '../core/domain.ts';
import { badRequest, conflict, notFound } from '../core/errors.ts';

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

type Checkpoint = { completed: string[]; current?: string; seconds?: number; positions: Record<string, unknown> };

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

  constructor(options: {
    db: Db;
    vault: Vault;
    manager: ModuleManager;
    log: (level: string, message: string) => void;
    recoverInterrupted?: boolean;
  }) {
    this.db = options.db;
    this.vault = options.vault;
    this.manager = options.manager;
    this.log = options.log;
    // A restart never silently replays an unfinished external write.
    if (options.recoverInterrupted !== false) this.db.run(
      "UPDATE tasks SET state = 'paused', generation = generation + 1, detail = '服务已重启，请核对进度后继续', updated_at = ?1 WHERE state IN ('queued','running')",
      nowSeconds(),
    );
  }

  list(owner: string): TaskView[] {
    return this.db
      .all<TaskRow>('SELECT * FROM tasks WHERE owner = ?1 ORDER BY created_at DESC LIMIT 50', owner)
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
    input: { platform: string; course: Course; unit_ids: string[]; operation: string },
  ): TaskView {
    const unitIds = [...new Set(input.unit_ids)];
    if (unitIds.length === 0) throw badRequest('请先选择学习单元');
    if (unitIds.length > MAX_UNITS) throw badRequest('一次最多选择 200 个单元');
    if (input.operation !== 'study') throw badRequest('当前只实现了学习任务', 'unsupported_operation');
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
    return this.get(owner, id);
  }

  pause(owner: string, id: string): TaskView {
    const task = this.get(owner, id);
    if (task.state === 'paused') return task;
    if (!['queued', 'running'].includes(task.state)) {
      throw conflict('invalid_state', '只有排队或运行中的任务可以暂停');
    }
    this.db.run(
      "UPDATE tasks SET state = 'paused', generation = generation + 1, detail = '已由用户暂停', updated_at = ?1 WHERE id = ?2",
      nowSeconds(), id,
    );
    this.event(id, 'paused', '已由用户暂停');
    this.controllers.get(id)?.abort();
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
    if (this.controllers.has(taskId)) return;
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    const generation = row.generation;

    try {
      this.update(taskId, { state: 'running', detail: '准备目录' });
      const current = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?1', taskId)!;
      const unitIds = JSON.parse(current.units) as string[];
      const platform = await this.manager.describe(current.platform);
      const courses = await this.manager.courses(current.owner, current.platform);
      const course = courses.find(
        (item) => item.id === current.course_id && item.recruit_id === current.recruit_id,
      );
      if (!course) throw conflict('course_not_found', '课程已不在平台上，任务无法继续');
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
            this.update(taskId, { state: 'paused', detail: '夜间暂停，07:00 后可手动继续' });
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
            { max_speed: platform.platform.max_speed ?? 1 },
          );
          // An in-flight step may settle after pause/stop. Its old generation cannot publish
          // progress, checkpoints or completion into the new task state.
          if (controller.signal.aborted || !this.stillRunning(taskId, generation)) return;
          const status = String(outcome.status ?? '');
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
      this.update(taskId, { state: 'failed', detail: message });
      this.event(taskId, 'failed', message);
      this.log('warn', `任务 ${taskId} 失败：${message}`);
    } finally {
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
      return { completed: [], positions: {} };
    }
  }

  private saveCheckpoint(taskId: string, owner: string, checkpoint: Checkpoint): void {
    const sealed = this.vault.seal(owner, `job/${taskId}`, Buffer.from(JSON.stringify(checkpoint)));
    this.update(taskId, { checkpoint: new Uint8Array(sealed) });
  }

  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
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
