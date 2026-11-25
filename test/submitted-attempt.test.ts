import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './support/harness.ts';
import { runPrerequisiteQuiz, runWorkflow, type WorkflowContext } from '../src/jobs/workflows.ts';
import type { TaskRow } from '../src/jobs/engine.ts';
import type { Attempt, Paper } from '../src/modules/protocol.ts';

const paper: Paper = { id: 'quiz', name: 'Already submitted quiz', category: 'quiz', available: true, done: false, can_redo: false, score: null };
const attempt: Attempt = { id: 'original-attempt', paper_id: paper.id, name: paper.name, expires_at: null, questions: [
  { id: 'q', kind: 'single', text: 'Question', options: [{ id: 'A', text: 'A' }], answer: [], images: [], blanks: 0 },
] };

for (const phase of ['new', 'answers', 'waiting_answers', 'draft', 'waiting_submit', 'readback']) {
  test(`Chaoxing confirmed cached attempt resumes from ${phase} without model, draft, or submit`, async t => {
    const { runtime } = await boot(); t.after(() => runtime.close());
    const events: string[] = [], calls: string[] = [];
    const task = { id: 'task', owner: 'owner', platform: 'cx', operation: 'study', generation: 4 } as TaskRow;
    const context: WorkflowContext = {
      db: runtime.db, manager: runtime.manager, ai: runtime.ai, memory: runtime.memory,
      platformOwner: 'account-owner', task, input: { options: { auto_prerequisite_quizzes: true }, account: 'account', connection: 'connection', version: '0.1.9' },
      course: { id: 'course', recruit_id: 'class', name: 'Course', kind: 'chaoxing', outline_available: true },
      checkpoint: { completed: ['retained-unit'], positions: { 'retained-unit': { position: 42 } },
        ...(phase === 'new' ? {} : { workflow: { kind: 'prerequisite_quiz', phase, index: 0, round: 0, cursor: 3,
          paper, attempt: structuredClone(attempt), answers: { q: ['A'] }, explanations: {}, preserve: ['q'], records: [] } }),
      },
      signal: new AbortController().signal, check() {}, save() {}, update() {},
      pause(detail) { assert.fail('Unexpected pause: ' + detail); }, event(kind) { events.push(kind); },
    };
    t.mock.method(runtime.ai, 'generate', async () => assert.fail('Must not regenerate submitted answers'));
    t.mock.method(runtime.manager, 'invoke', async (owner: string, platform: string, method: string, params: Record<string, unknown>) => {
      assert.equal(owner, 'account-owner'); assert.equal(platform, 'cx'); calls.push(method);
      if (method === 'exam.open') return { ready: true, attempt: structuredClone(attempt) };
      assert.equal(method, 'exam.readback', 'Submitted answers must never be written again');
      assert.equal(params.attempt_id, attempt.id);
      assert.equal(params.check_retry, undefined, 'Recovery must start read-only');
      return { confirmed: true, attempt_id: attempt.id, score: 90, graded_answers: {} };
    });
    assert.equal(await runPrerequisiteQuiz(context, paper), 'completed');
    assert.equal(context.checkpoint.workflow, undefined);
    assert.deepEqual(context.checkpoint.completed, ['retained-unit']);
    assert.deepEqual(context.checkpoint.positions, { 'retained-unit': { position: 42 } });
    assert.deepEqual(context.checkpoint.prerequisite_quizzes?.completed, [paper.id]);
    const records = context.checkpoint.prerequisite_quizzes!.records;
    assert.equal(records.length, 1); assert.equal(records[0]!.confirmed, true); assert.equal(records[0]!.score, 90);
    assert.deepEqual(events, ['submission_confirmed']);
    assert.equal(runtime.db.get<{ n: number }>('SELECT COUNT(*) n FROM operation_locks')!.n, 0);
    assert.equal(calls.filter(method => method === 'exam.open').length, phase === 'new' ? 1 : 0);
  });
}

for (const status of ['unsubmitted', 'different-attempt', 'confirmed']) {
  test(`Chaoxing readback preflight ${status} preserves the ordinary answer task workflow`, async t => {
    const { runtime } = await boot(); t.after(() => runtime.close());
    const calls: string[] = [], saved: string[] = [];
    let submitted = false;
    const context: WorkflowContext = {
      db: runtime.db, manager: runtime.manager, ai: runtime.ai, memory: runtime.memory,
      platformOwner: 'account-owner', task: { id: 'task', owner: 'owner', platform: 'cx', operation: 'answer', units: '["quiz"]', generation: 0 } as TaskRow,
      input: { options: { use_ai: false, auto_submit: true }, account: 'account', connection: 'connection', version: '0.1.9' },
      course: { id: 'course', recruit_id: 'class', name: 'Course', kind: 'chaoxing', outline_available: true },
      checkpoint: { completed: [], positions: {}, workflow: { phase: 'draft', index: 0, round: 0, cursor: 0,
        paper, attempt: structuredClone(attempt), answers: { q: ['A'] }, explanations: {}, preserve: [], records: [] } },
      signal: new AbortController().signal, check() {}, save() { saved.push(this.checkpoint.workflow.phase); }, update() {},
      pause(detail) { assert.fail('Unexpected pause: ' + detail); }, event() {},
    };
    t.mock.method(runtime.manager, 'invoke', async (_owner: string, _platform: string, method: string, params: Record<string, unknown>) => {
      if (method === 'exam.readback') {
        calls.push('readback');
        return { confirmed: submitted || status !== 'unsubmitted', attempt_id: !submitted && status === 'different-attempt' ? 'someone-else' : attempt.id };
      }
      assert.equal(method, 'exam.write'); calls.push(String(params.phase));
      assert.deepEqual(params.answers, { q: ['A'] });
      if (params.phase === 'submit') submitted = true;
      return { done: true, cursor: 1 };
    });
    await runWorkflow(context);
    assert.deepEqual(context.checkpoint.completed, [paper.id]);
    assert.equal(context.checkpoint.workflow.records.length, 1);
    assert.equal(context.checkpoint.workflow.records[0].confirmed, true);
    if (status === 'confirmed') {
      assert.deepEqual(calls, ['readback', 'readback']);
      assert.ok(!saved.includes('submitting'));
    } else {
      assert.deepEqual(calls, ['readback', 'draft', 'submit', 'readback']);
      assert.ok(saved.includes('submitting'));
      assert.equal(runtime.db.get<{ state: string }>('SELECT state FROM operation_locks')!.state, 'confirmed');
    }
  });
}
