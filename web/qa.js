import { coursePath } from './api.js';
import { esc, icon, dateText, empty } from './views.js';

const lanes = { ask: { title: '提问', cap: 10, daily: 10, initial: 3 }, answer: { title: '回答', cap: 20, daily: 20, initial: 5 } };
const finite = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value));
const count = (value, names) => { for (const key of names) { const n = finite(value?.[key]); if (n != null) return Math.floor(n); } return null; };
const btn = (text, action, attributes = '', primary = false) => `<button class="button${primary ? ' primary' : ''}" data-action="${action}" ${attributes}>${text}</button>`;

export function qaSummary(data, now = Date.now() / 1000, allowOverLimit = false) {
  const raw = data?.score?.qa;
  const counts = { ask: count(raw, ['questions', 'validQuestionAmount', 'effectiveQuestion']), answer: count(raw, ['answers', 'validAnswerAmount', 'effectiveAnswer']), received: count(raw, ['received', 'getAnswer']) };
  const today = { ask: 0, answer: 0 };
  const day = Math.floor((now + 28800) / 86400);
  for (const post of data?.own_posts || []) {
    if (Math.floor((Number(post.created_at) + 28800) / 86400) !== day) continue;
    if (post.kind === 'question') today.ask++;
    if (post.kind === 'answer') today.answer++;
  }
  const room = {};
  for (const [kind, lane] of Object.entries(lanes)) room[kind] = allowOverLimit ? 50 : Math.max(0, Math.min(lane.daily - today[kind], counts[kind] == null ? lane.cap : lane.cap - counts[kind] - today[kind]));
  return { counts, today, room, overLimit: allowOverLimit };
}

export const qaBudget = state => qaSummary(state.feature?.data, undefined, state.settings?.preferences.qa_allow_over_limit === true);

export async function loadQa(state, api, current) {
  const key = JSON.stringify([state.route.pid, state.course.id, state.course.recruit_id]);
  state.qaCourses ??= {};
  const f = state.feature = state.qaCourses[key] ??= { tab: 'qa', data: null, drafts: [], selected: [], counts: { ask: 3, answer: 5 }, topic: '' };
  const root = coursePath(state.route.pid, state.course);
  const [score, posts, settings] = await Promise.allSettled([api(root + '/catalog/score'), api(root + '/catalog/posts'), api('/api/settings')]);
  if (!current()) return;
  f.data = { score: score.status === 'fulfilled' ? score.value : null, own_posts: posts.status === 'fulfilled' ? posts.value.posts : [] };
  f.error = [score, posts].filter((r) => r.status === 'rejected').map((r) => r.reason.message).join('；');
  if (settings.status === 'fulfilled') state.settings = settings.value;
}

function laneView(kind, f, summary, off) {
  const lane = lanes[kind], valid = summary.counts[kind], posted = summary.today[kind], room = summary.room[kind];
  const filled = Math.min(lane.cap, valid || 0), pending = Math.min(posted, lane.cap - filled);
  const n = Math.min(Math.max(1, f.counts[kind] || lane.initial), Math.max(1, room));
  const cells = Array.from({ length: lane.cap }, (_, i) => `<i class="qa-cell${i < filled ? ' counted' : i < filled + pending ? ' pending' : ''}"></i>`).join('');
  const reason = !room ? (valid != null && valid + posted >= lane.cap ? '已达到本项有效条数目标' : '已达到本工作台今日发布上限') : '';
  const steps = `<div class="qa-stepper" aria-label="${lane.title}数量">${btn('−', 'qa-step', `data-kind="${kind}" data-delta="-1" aria-label="减少${lane.title}数量"${off || n <= 1 ? ' disabled' : ''}`)}<output aria-live="polite">${n}</output>${btn('＋', 'qa-step', `data-kind="${kind}" data-delta="1" aria-label="增加${lane.title}数量"${off || n >= room ? ' disabled' : ''}`)}</div>`;
  const action = kind === 'ask' ? `<button class="button" form="draft-form" type="submit"${off || !room || f.generating ? ' disabled' : ''}>${f.generating ? '正在起草…' : f.drafts.length ? '换一批' : `出 ${n} 条题`}</button>` : btn(`答 ${n} 条`, 'feature-job', `data-operation="qa"${off || !room ? ' disabled' : ''}`, true);
  return `<section class="qa-lane"><header><h3>${lane.title}</h3><span class="qa-number">${valid ?? '—'}<small> / ${lane.cap}</small></span></header><div class="qa-cells" role="img" aria-label="${lane.title}：平台有效 ${valid ?? '未知'} 条，今日已发 ${posted} 条">${cells}</div><p class="muted">${summary.overLimit ? '超额模式 · 每批最多 50 条，不保证额外计分' : reason || `今天还能${kind === 'ask' ? '问' : '答'} ${room} 条${kind === 'ask' ? ` · 收获回答 ${summary.counts.received ?? '—'}` : ''}`}</p><div class="qa-lane-actions">${steps}${action}</div></section>`;
}

export function qaView(state) {
  const f = state.feature;
  if (!f?.data) return '<div class="loading-state"><span class="spinner"></span>正在读取问答互动…</div>';
  const summary = qaBudget(state), quiet = state.bootstrap.quiet_hours.active;
  const operations = state.platforms.find((p) => p.id === state.route.pid)?.operations || [];
  const score = finite(f.data.score?.interactive), max = finite(f.data.score?.rules?.learnedInteractiveScoreShare ?? f.data.score?.rules?.interactive);
  const selected = f.selected.filter((i) => f.drafts[i]?.trim()).length;
  const drafts = f.drafts.map((text, i) => `<div class="qa-draft-row"><label class="qa-draft-select"><input type="checkbox" name="draft-selected" value="${i}" aria-label="选择提问 ${i + 1}"${f.selected.includes(i) ? ' checked' : ''}></label><textarea data-draft="${i}" rows="2" minlength="10" maxlength="1000" aria-label="提问草稿 ${i + 1}">${esc(text)}</textarea>${btn('删掉', 'qa-drop-draft', `data-index="${i}" aria-label="删掉提问 ${i + 1}"`)}</div>`).join('');
  const posts = [...(f.data.own_posts || [])].sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 50);
  return `<section id="qa-board" class="qa-workspace"><div class="section-heading"><h2>问答互动</h2>${btn(`${icon('refresh')}刷新`, 'qa-refresh')}</div><div class="panel qa-board"><header class="qa-head"><div class="qa-score"><strong>${score ?? '—'}</strong><span> / ${max ?? '—'} 分</span></div><p class="muted">平台统计可能延迟更新<br>实心为平台有效条数，斜纹为本工作台今天发布</p></header>${f.error ? `<div class="banner">部分统计未能读取：${esc(f.error)}</div>` : ''}<div class="qa-lanes">${laneView('ask', f, summary, quiet || !operations.includes('ask'))}${laneView('answer', f, summary, quiet || !operations.includes('qa'))}</div><form id="draft-form"><input type="hidden" name="count" value="${Math.min(f.counts.ask || 3, Math.max(1, summary.room.ask))}"><details class="qa-draft-options"><summary>补充提问主题（可选）</summary><label>章节或讨论方向<textarea name="topic" rows="2" maxlength="3000" placeholder="例如：本章重点概念、实际应用或常见误区">${esc(f.topic)}</textarea></label></details><p class="form-error" role="alert" hidden></p></form>${f.draftError ? `<p class="form-error qa-draft-error" role="alert">${esc(f.draftError)}</p>` : ''}<div id="question-drafts">${drafts}</div><div class="qa-draft-actions"><span class="muted">先编辑、勾选，再确认发布；任务内逐条发送。</span><div class="actions">${btn('手工添加', 'qa-add-draft')}${btn(`发布 ${selected} 条`, 'feature-job', `id="qa-publish" data-operation="ask"${quiet || !selected || selected > summary.room.ask || f.generating ? ' disabled' : ''}`, true)}</div></div><div class="qa-peer-row qa-risk-row"><div><strong>允许超额问答 <span class="badge risk-badge">有风险</span></strong><p class="muted">超过提问 10 条／回答 20 条的计分目标和本工作台每日上限，可能不再计分、触发平台限制或增加模型费用；每批最多 50 条，仍逐条发送。</p></div><button class="qa-switch${state.settings?.preferences.qa_allow_over_limit ? ' on' : ''}" data-action="qa-over-limit" role="switch" aria-label="允许超额问答（有风险）" aria-checked="${Boolean(state.settings?.preferences.qa_allow_over_limit)}"><span></span></button></div><div class="qa-peer-row"><div><strong>站内互答</strong><p class="muted">双方开启后，优先回答同课程成员的提问；你的提问也可供同学回答。</p></div><button class="qa-switch${state.settings?.preferences.qa_peers ? ' on' : ''}" data-action="qa-peers" role="switch" aria-label="站内互答" aria-checked="${Boolean(state.settings?.preferences.qa_peers)}"><span></span></button></div></div><div class="section-heading qa-published-heading"><h2>已发布</h2><small class="muted">最近 50 条本工作台记录</small></div><div class="panel qa-published">${posts.length ? posts.map((p, i) => `<details class="qa-post" data-post="${i}"><summary><span class="qa-stamp${p.kind === 'question' ? ' question' : ''}">${p.kind === 'question' ? '问' : p.kind === 'answer' ? '答' : '录'}</span><span class="qa-post-title">${esc(p.question || (p.kind === 'answer' ? `回答问题 ${p.question_id || ''}` : p.content))}<small class="muted">${p.created_at ? dateText(p.created_at) : '离线记录'}${p.platform_id ? ` · ${esc(p.platform_id)}` : ''}</small></span>${icon('arrow')}</summary><p class="qa-post-content">${esc(p.content)}</p></details>`).join('') : empty('还没在这门课发过', '确认发布成功后，提问和回答会保存在这里。', '', 'book')}</div><details class="panel qa-community"><summary>浏览课程讨论</summary><div class="qa-community-body">${f.community ? communityView(f.community) : `${btn('读取讨论列表', 'qa-community')}${f.communityError ? `<p class="form-error">${esc(f.communityError)}</p>` : ''}`}</div></details></section>`;
}
function communityView(data) {
  return `${(data.posts || []).map((p) => `<article class="discussion"><p>${esc(p.content)}</p><small class="muted">${esc(p.chapter || '课程讨论')} · ${esc(p.answers ?? 0)} 条回答${p.mine ? ' · 我的提问' : ''}</small></article>`).join('') || '<p class="muted">这一页暂无问题。</p>'}${btn('下一页', 'qa-next', `data-cursor="${Number(data.cursor || 0) + 1}"`)}`;
}

export function captureQa(state) {
  if (state.route.page !== 'course' || state.route.tab !== 'qa' || !document.querySelector('#qa-board')) return;
  const f = state.feature;
  f.drafts = [...document.querySelectorAll('[data-draft]')].map((input) => input.value);
  f.selected = [...document.querySelectorAll('[name="draft-selected"]:checked')].map((input) => Number(input.value));
  f.topic = document.querySelector('[name="topic"]')?.value || '';
}
export function qaChange(target, state) {
  if (target.name !== 'draft-selected') return false;
  captureQa(state);
  const button = document.querySelector('#qa-publish'), n = state.feature.selected.filter((i) => state.feature.drafts[i]?.trim()).length;
  if (button) { button.textContent = `发布 ${n} 条`; button.disabled = !n || n > qaBudget(state).room.ask || state.bootstrap.quiet_hours.active; }
  return true;
}
export async function qaAction(target, ctx) {
  const action = target.dataset.action;
  if (!['qa-step', 'qa-refresh', 'qa-drop-draft', 'qa-add-draft', 'qa-peers', 'qa-community', 'qa-next', 'qa-over-limit'].includes(action)) return false;
  const { state, api, renderPage, toast } = ctx, f = state.feature;
  captureQa(state);
  if (action === 'qa-step') {
    const kind = target.dataset.kind, room = qaBudget(state).room[kind];
    f.counts[kind] = Math.max(1, Math.min(Math.max(1, room), f.counts[kind] + Number(target.dataset.delta))); renderPage();
  } else if (action === 'qa-refresh') await ctx.loadRoute(true);
  else if (action === 'qa-drop-draft') {
    const index = Number(target.dataset.index); f.drafts.splice(index, 1); f.selected = f.selected.filter((i) => i !== index).map((i) => i > index ? i - 1 : i); renderPage();
  } else if (action === 'qa-add-draft') { if (f.drafts.length >= (state.settings?.preferences.qa_allow_over_limit ? 50 : 10)) throw new Error('已达到当前模式的草稿数量上限。'); f.selected.push(f.drafts.length); f.drafts.push(''); renderPage(); }
  else if (action === 'qa-over-limit') {
    const response = await api('/api/settings/preferences', { method: 'POST', body: { qa_allow_over_limit: !state.settings?.preferences.qa_allow_over_limit } });
    state.settings = { ...state.settings, preferences: response.preferences }; renderPage();
    toast(response.preferences.qa_allow_over_limit ? '已开启超额问答，请留意平台限制与额外模型费用。' : '已恢复默认问答限制。');
  } else if (action === 'qa-peers') {
    const response = await api('/api/settings/preferences', { method: 'POST', body: { qa_peers: !state.settings?.preferences.qa_peers } });
    state.settings = { ...state.settings, preferences: response.preferences }; renderPage(); toast(response.preferences.qa_peers ? '已开启站内互答。' : '已关闭站内互答。');
  } else {
    const root = coursePath(state.route.pid, state.course), cursor = action === 'qa-next' ? Number(target.dataset.cursor) : 0;
    try {
      let data = await api(root + '/catalog/qa' + (f.community?.page ? '?page=' + encodeURIComponent(f.community.page) + '&cursor=' + cursor : ''));
      for (let n = 0; data.ready === false && n < 35 && state.feature === f; n++) { await new Promise((resolve) => setTimeout(resolve, 1000)); data = await api(root + '/catalog/qa?page=' + encodeURIComponent(data.page || '') + '&cursor=' + cursor); }
      if (data.ready === false) throw new Error('官方问答区尚未就绪，请稍后重试。');
      f.community = data; f.communityError = '';
    } catch (error) { f.communityError = error.message; f.community = null; }
    if (state.feature === f) { renderPage(); document.querySelector('.qa-community').open = true; }
  }
  return true;
}
export async function submitDraft(form, ctx) {
  const { state, api, renderPage } = ctx;
  captureQa(state);
  const f = state.feature, root = coursePath(state.route.pid, state.course), count = Math.min(f.counts.ask, qaBudget(state).room.ask);
  if (!count) throw new Error('今天的提问额度已用完。');
  f.generating = true; f.draftError = ''; renderPage();
  try {
    const drafts = [];
    for (let offset = 0; offset < count; offset += 10) {
      if (state.feature !== f) return;
      const result = await api(root + '/drafts', { method: 'POST', body: { topic: f.topic, count: Math.min(10, count - offset) } });
      if (state.feature !== f) return;
      drafts.push(...result.drafts);
      f.drafts = [...drafts]; f.selected = f.drafts.map((_, i) => i); renderPage();
    }
  }
  catch (error) { f.draftError = error.message; }
  finally { f.generating = false; if (state.feature === f) renderPage(); }
}
