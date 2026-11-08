import { createHash } from 'node:crypto';

export const INTERFACE_VERSION = 1;
const KINDS = new Set(['single', 'multiple', 'judge', 'blank', 'essay']);
const clean = (value) => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();

export function validateQuestion(question) {
  if (!question || !KINDS.has(question.kind) || typeof question.text !== 'string' || !clean(question.text) || question.text.length > 100_000) throw new TypeError('题干或题型无效');
  if (!Array.isArray(question.options) || question.options.length > 200) throw new TypeError('题目选项无效');
  const ids = new Set();
  for (const option of question.options) {
    if (typeof option?.id !== 'string' || !option.id || ids.has(option.id) || typeof option.text !== 'string' || !clean(option.text)) throw new TypeError('选项编号必须唯一，选项内容不能为空');
    ids.add(option.id);
  }
  if (['single', 'multiple'].includes(question.kind) && !ids.size) throw new TypeError('选择题缺少选项');
  if (question.kind === 'blank' && (!Number.isInteger(question.blanks) || question.blanks < 1 || question.blanks > 200)) throw new TypeError('填空数量无效');
  if (question.images !== undefined && (!Array.isArray(question.images) || question.images.some((v) => typeof v !== 'string'))) throw new TypeError('题目图片无效');
}

export function validateAnswer(question, answer) {
  if (!Array.isArray(answer) || answer.some((a) => typeof a !== 'string' || !a.trim() || a.length > 20_000)) return false;
  if (question.kind === 'single') return answer.length === 1 && question.options.some((o) => o.id === answer[0]);
  if (question.kind === 'multiple') return answer.length > 0 && new Set(answer).size === answer.length && answer.every((a) => question.options.some((o) => o.id === a));
  if (question.kind === 'judge') return answer.length === 1 && ['true', 'false'].includes(answer[0]);
  if (question.kind === 'blank') return question.blanks > 0 && answer.length === question.blanks;
  return question.kind === 'essay' && answer.length === 1;
}

function scopeParts(scope) {
  const values = [scope?.owner, scope?.platform, scope?.course];
  if (values.some((v) => typeof v !== 'string' || !v || v.length > 1000)) throw new TypeError('题库需要所属用户、平台和课程范围');
  return values;
}

export function fingerprint(scope, question) {
  validateQuestion(question);
  const payload = [...scopeParts(scope), question.kind, clean(question.text), question.options.map((o) => clean(o.text)).sort(), question.images ?? [], question.blanks ?? 0, clean(question.context)];
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function canonicalAnswer(question, answer) {
  if (!validateAnswer(question, answer)) throw new TypeError('答案格式与题型不符');
  if (['single', 'multiple'].includes(question.kind)) {
    const texts = question.options.map((o) => clean(o.text));
    if (new Set(texts).size !== texts.length) throw new TypeError('选项文字重复，不能可靠复用答案');
    return answer.map((id) => clean(question.options.find((o) => o.id === id).text)).sort();
  }
  return answer.map((value) => value.trim());
}

function currentAnswer(question, texts) {
  if (!Array.isArray(texts)) return null;
  let answer = texts;
  if (['single', 'multiple'].includes(question.kind)) {
    const options = new Map(question.options.map((o) => [clean(o.text), o.id]));
    if (options.size !== question.options.length || texts.some((v) => !options.has(v))) return null;
    answer = texts.map((text) => options.get(text));
  }
  return validateAnswer(question, answer) ? [...answer] : null;
}

/** 存储适配器负责持久化与加密，库本身不读取文件、不访问网络。 */
export class QuestionBank {
  constructor(store) { this.store = store; }

  lookup(scope, question) {
    const key = fingerprint(scope, question);
    const row = this.store.get(key);
    const wrong = (row?.wrong ?? []).map((v) => currentAnswer(question, v)).filter(Boolean);
    const correct = currentAnswer(question, row?.correct);
    const keyOf = (values) => JSON.stringify(question.kind === 'multiple' ? [...values].sort() : values);
    return { correct: correct && !wrong.some((v) => keyOf(v) === keyOf(correct)) ? correct : null, wrong, updated_at: row?.updated_at ?? null };
  }

  record(scope, question, answer, evidence) {
    const key = fingerprint(scope, question);
    if (!['correct', 'incorrect'].includes(evidence?.result) || !['platform', 'reviewed'].includes(evidence?.source)) throw new TypeError('只记录平台判定或明确复核过的答案');
    const value = canonicalAnswer(question, answer);
    const previous = this.store.get(key);
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    let correct = previous?.correct ?? null;
    let wrong = (previous?.wrong ?? []).map((v) => [...v]);
    if (evidence.result === 'correct') {
      correct = value;
      wrong = wrong.filter((v) => !equal(v, value));
    } else {
      if (equal(correct, value)) correct = null;
      if (!wrong.some((v) => equal(v, value))) wrong.push(value);
      wrong = wrong.slice(-20);
    }
    this.store.put(key, { version: 1, correct, wrong, updated_at: evidence.at ?? Math.floor(Date.now() / 1000) });
  }
}

/** 数据源只返回候选答案；查询结果不会自动成为“平台已确认答案”。 */
export async function queryProviders(providers, question, context = {}) {
  validateQuestion(question);
  for (const provider of providers) {
    context.signal?.throwIfAborted();
    try {
      const result = await provider.query(question, context);
      if (result && validateAnswer(question, result.answer)) return { ...result, provider: provider.id };
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason;
      context.onError?.(provider.id, error);
    }
  }
  return null;
}

/** HTTP 的发送与凭据注入由调用者提供，适配器仅负责协议映射。 */
export function createJsonProvider({ id, request, parse }, transport) {
  if (!id || typeof request !== 'function' || typeof parse !== 'function' || typeof transport !== 'function') throw new TypeError('题库数据源适配器无效');
  return { id, async query(question, context) { return parse(await transport(request(question), context), question); } };
}

/** 外部答案只做明确匹配，不猜测相似选项或随机选项。 */
export function candidate(question, raw) {
  let values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  if (question.kind === 'judge') values = values.map((v) => ['true','1','正确','对','yes'].includes(String(v).trim().toLowerCase()) ? 'true' : ['false','0','错误','错','no'].includes(String(v).trim().toLowerCase()) ? 'false' : String(v));
  else values = values.map((v) => String(v).trim());
  if (question.kind === 'multiple' && values.length === 1 && !question.options.some((o) => clean(o.text) === clean(values[0]))) values = /^[A-Z]+$/.test(values[0]) ? [...values[0]] : values[0].split(/[,，\r\n]+/).map((v) => v.trim()).filter(Boolean);
  if (['single','multiple'].includes(question.kind)) values = values.map((v) => {
    const matching = question.options.filter((o) => clean(o.text) === clean(v));
    const id = question.options.find((o) => o.id === v);
    if (matching.length === 1 && (!id || id.id === matching[0].id)) return matching[0].id;
    if (matching.length) return '';
    return id?.id ?? '';
  });
  if (question.kind === 'blank' && values.length === 1 && question.blanks > 1) values = values[0].split(/\r?\n/).map((v) => v.trim());
  return validateAnswer(question, values) ? { answer: values } : null;
}

function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) || url.username || url.password) throw new TypeError('题库地址必须为 HTTPS，本机测试可使用 HTTP');
  return url;
}
export function createYanxiProvider({ url, token, id = 'yanxi' }, transport) {
  return createJsonProvider({ id, request: q => { const target = endpoint(url); target.searchParams.set('question',q.text); target.searchParams.set('token',token); return { method:'GET',url:target.toString() }; }, parse: (data,q) => data?.code ? candidate(q,data.data?.answer) : null },transport);
}
export function createTikuAdapterProvider({ url, id = 'tiku-adapter' }, transport) {
  return createJsonProvider({ id, request: q => ({ method:'POST',url:endpoint(url).toString(),headers:{'content-type':'application/json'},body:JSON.stringify({ question:q.text,options:q.options.map(o=>o.text),type:({single:0,multiple:1,blank:2,judge:3,essay:4})[q.kind] }) }), parse:(data,q)=>candidate(q,data?.answer?.bestAnswer) },transport);
}
export function createTikuLikeProvider({ url, token, model = '', search = true, vision = false, id = 'tiku-like' }, transport) {
  return createJsonProvider({ id, request:q=>({method:'POST',url:endpoint(url).toString(),headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({query:q.text,model,search,vision})}), parse:(data,q)=> { const out=data?.results?.output; if(!out)return null; const answer=out.answer; return candidate(q,out.questionType==='CHOICE'?answer?.selectedOptions:out.questionType==='FILL_IN_BLANK'?answer?.blanks:out.questionType==='JUDGMENT'?answer?.isCorrect:answer?.otherText); } },transport);
}
