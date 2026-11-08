import type { Db } from '../core/db.ts';
import type { Vault } from '../core/vault.ts';
import type { Question } from '../modules/protocol.ts';
import { digest, nowSeconds } from '../core/domain.ts';
import { QuestionBank, validateAnswer, type Entry, type Evidence } from './index.js';

const validAnswer = (question: Question, answer: unknown): answer is string[] => validateAnswer(question as Parameters<typeof validateAnswer>[0], answer);

export class QuestionBankService {
  private db: Db;
  private vault: Vault;
  constructor(db: Db, vault: Vault) { this.db = db; this.vault = vault; }
  private id(owner: string, platform: string, course: string, q: Question): string { return digest(JSON.stringify([owner, platform, course, q.kind, q.text, q.options, q.images, q.blanks])); }
  private bank(owner: string, platform: string, course: string): QuestionBank {
    return new QuestionBank({
      get: (key) => {
        const id = `qb:${key}`;
        const row = this.db.get<{ sealed: Uint8Array }>('SELECT sealed FROM answer_memory WHERE id=?1 AND owner=?2', id, owner);
        return row ? this.vault.openJson<Entry>(owner, `question-bank/${id}`, Buffer.from(row.sealed)) : undefined;
      },
      put: (key, entry) => {
        const id = `qb:${key}`;
        const sealed = this.vault.sealJson(owner, `question-bank/${id}`, entry);
        this.db.run('INSERT INTO answer_memory VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET sealed=excluded.sealed,updated_at=excluded.updated_at', id, owner, platform, course, new Uint8Array(sealed), entry.updated_at);
      },
    });
  }
  lookup(owner: string, platform: string, course: string, q: Question, family?: string) {
    const result = this.bank(owner, platform, course).lookup({ owner, platform, course }, q as Parameters<QuestionBank['lookup']>[1]);
    if (result.updated_at !== null) return result;
    const legacy = this.legacy(owner, platform, course, q);
    return legacy ? { ...result, correct: legacy } : this.studia(owner, platform, course, q, family) ?? result;
  }
  private studia(owner: string, platform: string, course: string, q: Question, family?: string) {
    if (platform !== 'zhs') return null;
    const scope = 'legacy/studia/answers';
    const row = this.db.get<{ sealed: Uint8Array }>('SELECT sealed FROM secrets WHERE owner=?1 AND scope=?2', owner, scope);
    if (!row) return null;
    const data = this.vault.openJson<{zhs_answers?: Record<string, {correct?: string[]; wrong?: string[][]}>}>(owner, scope, Buffer.from(row.sealed));
    const pythonJson = (value: any): string => Array.isArray(value) ? `[${value.map(pythonJson).join(', ')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}: ${pythonJson(value[k])}`).join(', ')}}` : JSON.stringify(value);
    const kinds = q.kind === 'single' ? [1,14] : q.kind === 'multiple' ? [2] : q.kind === 'blank' ? [3] : [];
    const map = (texts: string[] | undefined): string[] | null => {
      if (!texts) return null;
      const options = new Map(q.options.map(o => [o.text.trim(),o.id]));
      if (q.kind !== 'blank' && options.size !== q.options.length) return null;
      const values = q.kind === 'blank' ? texts : texts.map(t => options.get(t.trim()) ?? '');
      return validAnswer(q, values) ? [...values] : null;
    };
    const oldScope = family === 'shared' ? `shared/${course.split('/')[0]}` : family === 'smart' ? `ai/${course.split('/')[0]}` : undefined;
    for (const kind of kinds) for (const scoped of oldScope ? [true, false] : [false]) {
      const key = digest(pythonJson({ kind, title:q.text, options:q.options.map(o=>o.text).sort(), blanks:q.blanks || 0, ...(scoped ? { scope: oldScope } : {}) }));
      const item = data.zhs_answers?.[key];
      if (!item) continue;
      const wrong = (item.wrong ?? []).map(map).filter((v): v is string[] => v !== null);
      let correct = map(item.correct);
      if (correct && wrong.some(v => JSON.stringify(q.kind === 'multiple' ? [...v].sort() : v) === JSON.stringify(q.kind === 'multiple' ? [...correct!].sort() : correct))) correct = null;
      return { correct, wrong, updated_at: null };
    }
    return null;
  }
  get(owner: string, platform: string, course: string, q: Question, family?: string): string[] | null {
    try { return this.lookup(owner, platform, course, q, family).correct; }
    catch (error) { if (error instanceof TypeError) return this.legacy(owner, platform, course, q); throw error; }
  }
  private legacy(owner: string, platform: string, course: string, q: Question): string[] | null {
    const id = this.id(owner, platform, course, q);
    const row = this.db.get<{ sealed: Uint8Array }>('SELECT sealed FROM answer_memory WHERE id=?1 AND owner=?2', id, owner);
    if (!row) return null;
    const answer = this.vault.openJson<string[]>(owner, `answer/${id}`, Buffer.from(row.sealed));
    return validAnswer(q, answer) ? answer : null;
  }
  remember(owner: string, platform: string, course: string, q: Question, answer: string[]): void {
    if (!validAnswer(q, answer)) return;
    try { this.record(owner, platform, course, q, answer, { result: 'correct', source: 'platform', at: nowSeconds() }); }
    catch (error) { if (!(error instanceof TypeError)) throw error; }
  }
  record(owner: string, platform: string, course: string, q: Question, answer: string[], evidence: Evidence): void {
    this.bank(owner, platform, course).record({ owner, platform, course }, q as Parameters<QuestionBank['record']>[1], answer, evidence);
  }
}
