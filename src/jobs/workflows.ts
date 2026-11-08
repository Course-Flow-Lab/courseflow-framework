import type { Db } from '../core/db.ts';
import type { Course, Attempt, Paper, Question } from '../modules/protocol.ts';
import type { ModuleManager } from '../modules/manager.ts';
import type { AiService } from '../services/ai.ts';
import { AnswerMemory, validAnswer, parseModelAnswer, questionPrompt, ANSWER_SYSTEM } from '../services/answers.ts';
import { digest, nowSeconds, randomId, sleep } from '../core/domain.ts';
import type { TaskRow, Checkpoint, JobInput } from './engine.ts';
import { conflict } from '../core/errors.ts';

export type WorkflowContext = {
  db: Db; manager: ModuleManager; ai: AiService; memory: AnswerMemory;
  task: TaskRow; input: JobInput; course: Course; checkpoint: Checkpoint; signal: AbortSignal;
  check: () => void; save: () => void; update: (detail: string, progress?: number) => void;
  pause: (detail: string) => void; event: (kind: string, detail: string) => void;
};
type AnswerState = {
  phase: string; index: number; round: number; cursor: number; attempt?: Attempt; paper?: Paper;
  answers: Record<string, string[]>; explanations: Record<string, string>; preserve: string[];
  confirmed?: boolean; nonce?: string; lock?: string; readbacks?: number; remaining?: number;
  records: Array<Record<string, unknown>>;
};
const scope = (c: WorkflowContext) => ({ id: c.task.id, generation: c.task.generation });
async function call(c: WorkflowContext, method: string, params: Record<string, unknown>) {
  c.check();
  const result = await c.manager.invoke(c.task.owner, c.task.platform, method, { course: c.course, operation: c.task.operation, ...params }, scope(c));
  c.check();
  return result;
}

export async function runWorkflow(c: WorkflowContext): Promise<void> {
  if (['answer', 'mastery'].includes(c.task.operation)) {
    let pending = false;
    const timer = setInterval(() => {
      const attempt = c.checkpoint.workflow?.attempt;
      if (!attempt || pending || c.signal.aborted) return;
      pending = true;
      void call(c, 'exam.heartbeat', { attempt_id: attempt.id, seconds: Math.max(1, nowSeconds() - (c.checkpoint.workflow.started_at ?? nowSeconds())) })
        .catch((error) => { if ((error as any).code !== 'unsupported_operation' && !c.signal.aborted) { try { c.pause('考试计时同步失败，请核对官方页面后继续'); } catch {} } })
        .finally(() => { pending = false; });
    }, 30_000);
    timer.unref();
    try { return await answer(c); } finally { clearInterval(timer); }
  }
  if (c.task.operation === 'review') return review(c);
  return activity(c);
}

async function review(c: WorkflowContext) {
  const all = await c.manager.units(c.task.owner, c.task.platform, c.course);
  c.check();
  const selected = new Set(JSON.parse(c.task.units) as string[]);
  const videos = all.filter((u) => selected.has(u.id) && u.kind === 'video' && u.state === 'completed' && (u.duration_seconds ?? 0) > 0);
  if (!videos.length) { c.pause('没有可复习的已完成视频，请先完成课程学习'); return; }
  const budget = Math.max(60, Math.min(3600, Number(c.input.options.review_minutes ?? 10) * 60));
  c.checkpoint.reviewed ??= 0; c.checkpoint.review_index ??= 0;
  const day = Math.floor((nowSeconds() + 28800) / 86400);
  while (c.checkpoint.reviewed < budget) {
    const index = c.checkpoint.review_index as number;
    const unit = videos[(day + index) % videos.length]!;
    const key = `${index}/${unit.id}`;
    while (true) {
      c.check();
      const result = await c.manager.studyStep(c.task.owner, c.task.platform, c.course, unit, c.checkpoint.positions[key] ?? null,
        { ...c.input.options, operation: 'review', speedup: false, max_speed: 1, review_seconds: Math.min(budget - c.checkpoint.reviewed, unit.duration_seconds!), execution_id: `${c.task.id}/${c.task.generation}` }, scope(c));
      c.check();
      if (result.checkpoint !== undefined) c.checkpoint.positions[key] = result.checkpoint;
      c.save();
      if (result.status === 'completed') {
        const seconds = Number((result.evidence as any)?.reviewed_seconds ?? unit.duration_seconds);
        c.checkpoint.reviewed += Math.min(budget - c.checkpoint.reviewed, seconds);
        if (!c.checkpoint.completed.includes(unit.id)) c.checkpoint.completed.push(unit.id);
        c.checkpoint.review_index++; c.save(); break;
      }
      if (result.status !== 'in_progress') { c.pause(String(result.reason ?? '复习需要到官方页面核对')); return; }
      const partial = Math.max(0, Number((result.progress as any)?.watched_seconds ?? 0));
      c.update(`每日复习：${Math.floor((c.checkpoint.reviewed + partial) / 60)} / ${budget / 60} 分钟`, Math.min(99, Math.round((c.checkpoint.reviewed + partial) / budget * 100)));
      await sleep(Math.max(1, Math.min(60_000, Number(result.wait_ms) || 1000)), c.signal);
    }
  }
  c.update(`每日复习完成：${Math.floor(c.checkpoint.reviewed / 60)} 分钟，保留原完成状态`, 100);
}

async function activity(c: WorkflowContext) {
  const ids = JSON.parse(c.task.units) as string[];
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index]!;
    if (c.checkpoint.completed.includes(id) || c.checkpoint.skipped?.some((s: any) => s.id === id)) continue;
    let step = 0;
    while (step++ < 30_000) {
      c.check();
      const position = c.checkpoint.positions[id] ?? null;
      const result = await call(c, 'activity.step', { operation: c.task.operation, item_id: id, checkpoint: position,
        options: { ...c.input.options, execution_id: `${c.task.id}/${c.task.generation}` } });
      if (result.diagnostic != null) {
        const diagnostic = JSON.stringify(result.diagnostic).slice(0, 4000);
        c.checkpoint.activity_diagnostics ??= {};
        if (c.checkpoint.activity_diagnostics[id] !== diagnostic) {
          c.checkpoint.activity_diagnostics[id] = diagnostic;
          c.event('diagnostic', `活动状态：${diagnostic}`);
        }
      }
      if (result.checkpoint !== undefined) c.checkpoint.positions[id] = result.checkpoint;
      c.save();
      if (result.status === 'completed') {
        c.checkpoint.completed.push(id); c.save();
        c.update(String(result.detail ?? '活动完成'), Math.round((index + 1) / ids.length * 100));
        c.event('item_completed', String(result.detail ?? id)); break;
      }
      if (result.status === 'needs_ai') {
        c.checkpoint.workflow = { kind: 'activity', phase: 'generating', prompt: result.prompt, item_id: id };
        c.save(); c.update('正在生成课程问答内容');
        try {
          if (c.input.options.use_ai === false) throw conflict('model_required', '本次任务选择手动填写发布内容');
          const output = await c.ai.generate(c.task.owner, String(result.prompt), { modelId: c.input.options.model_id as string | undefined, signal: c.signal });
          c.check();
          c.checkpoint.positions[id] = { ...(c.checkpoint.positions[id] as object ?? {}), generated: output };
          c.checkpoint.workflow = { kind: 'activity', phase: 'running', item_id: id }; c.save();
        } catch (error) {
          c.check(); c.checkpoint.workflow.phase = 'waiting_text'; c.save();
          c.pause(`需要手动填写发布内容或配置模型：${(error as Error).message}`); return;
        }
        continue;
      }
      if (['blocked', 'needs_human', 'unknown'].includes(result.status)) {
        if (c.task.operation === 'meeting' && result.status === 'blocked') {
          c.checkpoint.skipped ??= []; c.checkpoint.skipped.push({ id, reason: String(result.reason ?? '需要人工核对') });
          c.event('skipped', `见面课待人工处理：${String(result.reason)}`); c.save(); break;
        }
        c.pause(String(result.reason ?? '活动需要人工核对')); return;
      }
      if (result.status !== 'in_progress') throw conflict('module_protocol_error', '活动模块返回了未知状态');
      const fraction = Number(result.progress?.percent);
      c.update(String(result.detail ?? '正在执行课程活动'), Number.isFinite(fraction) ? Math.max(0, Math.min(99, Math.round((index + fraction / 100) / ids.length * 100))) : undefined);
      await sleep(Math.max(1, Math.min(60_000, Number(result.wait_ms) || 1000)), c.signal);
    }
    if (step >= 30_000) { c.pause('活动执行超过本次时长上限，请核对后继续'); return; }
  }
  if (c.checkpoint.skipped?.length) c.update(`见面课处理结束，${c.checkpoint.skipped.length} 项需要人工处理，请查看执行记录`, 100);
}

async function answer(c: WorkflowContext) {
  const mastery = c.task.operation === 'mastery';
  const ids = JSON.parse(c.task.units) as string[];
  const state: AnswerState = c.checkpoint.workflow ?? { phase: 'new', index: 0, round: 0, cursor: 0, answers: {}, explanations: {}, preserve: [], records: [] };
  c.checkpoint.workflow = state;
  const courseKey = `${c.course.id}/${c.course.recruit_id}`;
  const save = () => { c.check(); c.save(); };
  const acceptOpened=async (opened:any):Promise<boolean>=>{
      let batches=0;
      while (!opened.ready && opened.attempt) {
        if (++batches>100) throw conflict('module_protocol_error','试卷分页读取超过上限');
        state.phase = 'reading'; save(); c.update('正在分段读取试卷题目');
        opened = await call(c, 'exam.open', { paper_id: state.paper!.id, request_id: `${c.task.id}/${state.round}`, continuation: true });
      }
      if (!opened.ready || !opened.attempt || !Array.isArray(opened.attempt.questions) || !opened.attempt.questions.length) { c.pause('试卷尚未完整读取，请核对当前作答记录'); return false; }
      state.attempt = opened.attempt;
      (state as any).started_at = nowSeconds();
      for (const q of state.attempt!.questions) q.images = (q.images ?? []).map((url) => c.manager.registerImage(c.task.owner, c.task.platform, url));
      state.answers = {}; state.explanations = {}; state.preserve = []; state.cursor = 0; state.confirmed = false; state.phase = 'answers';
      for (const q of state.attempt!.questions) {
        if (validAnswer(q, q.answer)) { state.answers[q.id] = q.answer; state.preserve.push(q.id); }
        else { const known = c.memory.get(c.task.owner, c.task.platform, courseKey, q, c.course.kind); if (known) state.answers[q.id] = known; }
      }
      save();
    return true;
  };
  while (state.index < ids.length) {
    c.check();
    if (['opening', 'resetting'].includes(state.phase)) { c.pause('开卷或重做请求结果尚未核对，请检查官方作答记录；不会自动重复开卷'); return; }
    if (state.phase === 'new') {
      c.update(mastery ? '正在读取掌握度练习' : '正在读取作业考试');
      const result = await call(c, mastery ? 'catalog.mastery' : 'catalog.papers', {});
      const paper = (result.papers as Paper[]).find((p) => p.id === ids[state.index]);
      if (!paper) { c.pause('所选试卷已不在平台目录中，请刷新后核对'); return; }
      if (paper.done && !c.input.options.redo || mastery && paper.score != null && paper.score >= 100) {
        c.checkpoint.completed.push(paper.id); state.index++; save(); continue;
      }
      if (!paper.available || paper.ends_at != null && paper.ends_at <= nowSeconds()) { c.pause(paper.reason || '试卷尚未开放、已经截止或需要先在官方页面开考'); return; }
      const resource = digest(JSON.stringify([c.input.account, c.task.platform, courseKey, paper.id]));
      const unknown = c.db.get('SELECT 1 FROM operation_locks WHERE resource=?1 AND state IN (\'pending\',\'unknown\')', resource);
      if (unknown) { c.pause('这份试卷存在尚未核对的交卷请求，请先对原任务回读结果'); return; }
      state.paper = paper; state.phase = c.input.options.redo ? 'resetting' : 'opening'; state.nonce = c.input.options.redo ? randomId() : '';
      save();
      let opened;
      try { opened = await call(c, c.input.options.redo ? 'exam.redo' : 'exam.open', { paper_id: paper.id, request_id: `${c.task.id}/${state.round}` }); }
      catch (error) {
        if (mastery && (error as any).code === 'no_questions') { c.checkpoint.completed.push(paper.id); state.index++; state.phase = 'new'; c.event('skipped', '知识点暂无练习题，已跳过'); save(); continue; }
        throw error;
      }
      if (!await acceptOpened(opened)) return;
    }
    if (state.phase==='reading') {
      const opened=await call(c,'exam.open',{paper_id:state.paper!.id,request_id:`${c.task.id}/${state.round}`,continuation:true});
      if (!await acceptOpened(opened)) return;
    }
    const attempt = state.attempt!;
    if (attempt.expires_at != null && attempt.expires_at <= nowSeconds() && !['submitting', 'readback', 'next'].includes(state.phase)) { c.pause('本次作答已经截止，后续仅可回读或导出'); return; }
    if (['answers', 'waiting_answers'].includes(state.phase)) {
      state.phase = 'answers'; save();
      for (const question of attempt.questions) {
        if (validAnswer(question, state.answers[question.id])) continue;
        c.update(`正在处理题目 ${attempt.questions.indexOf(question) + 1} / ${attempt.questions.length}：${attempt.name}`);
        if (c.input.options.use_ai === false) { state.phase = 'waiting_answers'; save(); c.pause('请在任务详情中补全尚未作答的题目'); return; }
        try {
          const images = await Promise.all((question.images ?? []).slice(0, 8).map((url) => c.manager.image(c.task.owner, c.task.platform, url)));
          c.check();
          const generated = await c.ai.generate(c.task.owner, questionPrompt(question), { modelId: c.input.options.model_id as string | undefined, system: ANSWER_SYSTEM, images, signal: c.signal });
          c.check();
          const result = parseModelAnswer(question, generated);
          state.answers[question.id] = result.answer; state.explanations[question.id] = result.explanation; save();
        } catch (error) {
          c.check(); state.phase = 'waiting_answers'; save(); c.pause(`需要补答：${(error as Error).message}`); return;
        }
      }
      state.phase = 'draft'; state.cursor = 0; save();
    }
    if (state.phase === 'draft') {
      while (true) {
        c.update(`正在保存草稿：${attempt.name}`);
        const result = await call(c, 'exam.write', { attempt_id: attempt.id, answers: state.answers, preserve_ids: state.preserve, phase: 'draft', cursor: state.cursor });
        state.cursor = Number(result.cursor); save();
        if (result.done) break;
      }
      state.phase = 'waiting_submit'; save();
    }
    if (state.phase === 'waiting_submit') {
      if (!state.confirmed && c.input.options.auto_submit !== true) { c.pause(mastery ? '练习答案已生成，平台不支持草稿，请检查并确认提交' : '草稿已保存，请检查答案并确认本次交卷'); return; }
      const resource = digest(JSON.stringify([c.input.account, c.task.platform, courseKey, state.paper!.id]));
      const lock = digest(JSON.stringify([resource, attempt.id, state.nonce]));
      const existing = c.db.get<{ state: string }>('SELECT state FROM operation_locks WHERE id=?1', lock);
      if (existing) { state.phase = 'readback'; state.lock = lock; save(); }
      else {
        state.phase = 'submitting'; state.lock = lock;
        c.db.transaction(() => {
          c.db.run('INSERT INTO operation_locks(id,owner,platform,task_id,state,created_at,resource) VALUES(?1,?2,?3,?4,\'pending\',?5,?6)', lock, c.task.owner, c.task.platform, c.task.id, nowSeconds(), resource);
          save();
        });
        try {
          await call(c, 'exam.write', { attempt_id: attempt.id, answers: state.answers, phase: 'submit' });
          state.phase = 'readback'; state.readbacks = 0; save();
        } catch (error) {
          c.db.run("UPDATE operation_locks SET state='unknown' WHERE id=?1", lock);
          state.phase = 'readback';
          if (!c.signal.aborted) { save(); c.pause(`交卷结果待核对：${(error as Error).message}。继续时只回读，不重新交卷。`); }
          return;
        }
      }
    }
    if (state.phase === 'submitting') { state.phase = 'readback'; save(); }
    if (state.phase === 'readback') {
      c.update(`正在回读交卷结果：${attempt.name}`);
      const result = await call(c, 'exam.readback', { attempt_id: attempt.id });
      if (!result.confirmed || result.attempt_id !== attempt.id) {
        state.readbacks = (state.readbacks ?? 0) + 1; save();
        if (state.readbacks >= 6) { c.pause('平台尚未确认本次交卷，请稍后使用“回读提交结果”；不会自动重交'); return; }
        await sleep(1500, c.signal); continue;
      }
      if (state.lock) c.db.run("UPDATE operation_locks SET state='confirmed' WHERE id=?1", state.lock);
      for (const q of attempt.questions) {
        const known = result.graded_answers?.[q.id];
        if (validAnswer(q, known)) c.memory.remember(c.task.owner, c.task.platform, courseKey, q, known);
      }
      if (result.review?.questions) for (const q of attempt.questions) {
        const reviewed = result.review.questions.find((r: Question) => r.id === q.id);
        if (reviewed) { q.correct_answer = reviewed.correct_answer; q.explanation = reviewed.explanation; }
      }
      state.records.push({ paper: state.paper, attempt, answers: state.answers, explanations: state.explanations, score: result.score ?? null, confirmed: true, completed_at: nowSeconds() });
      c.event('submission_confirmed', `平台已确认：${attempt.name}${result.score == null ? '' : ` · ${result.score} 分`}`);
      if (mastery && result.score != null && Number(result.score) < 100 && state.round < 2) {
        state.round++; state.phase = 'new'; save(); continue;
      }
      if (mastery && (result.score == null || Number(result.score) < 100)) state.remaining = (state.remaining ?? 0) + 1;
      state.phase = 'next'; save();
    }
    if (state.phase === 'next') {
      c.checkpoint.completed.push(ids[state.index]!); state.index++; state.round = 0; state.phase = 'new'; state.readbacks = 0;
      c.update(`已确认 ${state.index} / ${ids.length} 份${mastery ? '练习' : '试卷'}`, Math.round(state.index / ids.length * 100)); save();
    }
  }
  if (mastery && state.remaining) c.update(`掌握度处理结束，仍有 ${state.remaining} 个知识点未确认达到 100%`, 100);
}
