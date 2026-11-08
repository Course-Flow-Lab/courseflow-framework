import { loadScore, scoreView, scoreAction } from './score.js';
import { qaView, loadQa, qaAction, submitDraft, captureQa, qaBudget } from './qa.js';
import { coursePath } from './api.js';
import { esc, icon, empty, modalFrame, taskDetailView, dateText, stateLabel } from './views.js';

export const operationNames = { study: '课程学习', trial: '短时试跑', review: '每日复习', answer: '作业与考试', mastery: '掌握度练习', meeting: '见面课', qa: '回答课程问题', ask: '发布课程提问' };
const supportedTabs = new Set(['study', 'review', 'answer', 'mastery', 'meeting', 'qa', 'score', 'records']);
export const supportsTab = (id) => supportedTabs.has(id);
const button = (label, action, extra = '', primary = false) => `<button class="button${primary ? ' primary' : ''}" data-action="${action}" ${extra}>${label}</button>`;
const errorBox = '<p class="form-error" role="alert" hidden></p>';
const numberField = (name, text, value, min, max) => `<label>${text}<input name="${name}" type="number" min="${min}" max="${max}" value="${esc(value)}" required></label>`;
const toggle = (name, text, checked = false) => `<label class="check-label"><input type="checkbox" name="${name}"${checked ? ' checked' : ''}>${text}</label>`;
const formFooter = (label) => `${errorBox}<div class="actions">${button('取消', 'modal-close')}<button type="submit" class="button primary">${label}</button></div>`;
const downloadLinks = (path, formats) => `<div class="actions export-links">${formats.map(([id, label]) => `<a class="button small" href="${path}?format=${id}" download>${label}</a>`).join('')}</div>`;
const reportLinks = (id) => downloadLinks('/api/tasks/' + encodeURIComponent(id) + '/export', [['md', 'Markdown'], ['docx', 'Word'], ['json', 'JSON'], ['csv', 'CSV']]);
const optionLabel = (q, values) => (values || []).map((value) => q.options?.find((o) => o.id === value)?.text || ({ true: '正确', false: '错误' })[value] || value).join('；') || '未作答';

export async function load(state, api, current, render = () => {}) {
  if (state.route.page === 'settings') { const result = await api('/api/settings'); if (current()) state.settings = result; return; }
  if (state.route.page !== 'course' || !state.course) return;
  const tab = state.route.tab || 'study';
  if (tab === 'qa') return loadQa(state, api, current);
  if (tab === 'score') return loadScore(state, api, current, render);
  state.feature = { tab, data: null, drafts: [], error: '' };
  const sections = { answer: 'papers', mastery: 'mastery', meeting: 'meetings', score: 'score' };
  if (!sections[tab]) return;
  const data = await api(coursePath(state.route.pid, state.course) + '/catalog/' + sections[tab]);
  if (current()) state.feature.data = data;
}

export function courseContent(state) {
  if (state.loading || !state.course) return null;
  const tab = state.route.tab || 'study';
  if (tab === 'study') return null;
  if (!supportsTab(tab)) return empty('此功能暂不可用', '请从课程功能栏选择其他页面。');
  const f = state.feature || {};
  const root = coursePath(state.route.pid, state.course);
  const quiet = state.bootstrap.quiet_hours.active;
  const operations = state.platforms.find((p) => p.id === state.route.pid)?.operations || [];
  const run = (op, text) => button(text, 'feature-job', `data-operation="${op}"${quiet || !operations.includes(op) ? ' disabled' : ''}`, true);
  if (tab === 'records') {
    const tasks = state.tasks.filter((t) => t.platform === state.route.pid && t.course_id === state.course.id && t.recruit_id === state.course.recruit_id);
    return `<section class="panel feature-panel"><div class="section-heading"><h2>本课程执行记录</h2>${downloadLinks('/api/history/export', [['json', '全部记录 JSON'], ['csv', '全部记录 CSV']])}</div>${tasks.map((t) => `<div class="record-row"><div><strong>${esc(operationNames[t.operation] || t.operation)}</strong><p class="muted">${esc(t.detail)}</p><small>${dateText(t.updated_at)} · ${esc(stateLabel(t.state))}</small></div>${button('详情与导出', 'task-detail', `data-id="${esc(t.id)}"`)}</div>`).join('') || '<p class="muted">本课程还没有执行记录。</p>'}</section>`;
  }
  if (tab === 'review') {
    const videos = state.units.filter((u) => u.kind === 'video' && u.state === 'completed');
    return `<section class="panel feature-panel"><div class="section-heading"><div><h2>每日复习</h2><p class="muted">按日期轮换已完成视频，使用原速累计复习时长。原课程完成状态会保留。</p></div>${run('review', '开始复习')}</div>${videos.map((u) => `<label class="choice-row"><input name="feature-item" type="checkbox" value="${esc(u.id)}" checked><span>${esc(u.name)}</span><small class="muted">已完成</small></label>`).join('') || empty('还没有可复习的视频', '先完成课程学习后，再回来复习。')}</section>`;
  }
  if (tab === 'qa') return qaView(state);
  if (tab === 'score') return scoreView(state);
  const data = f.data;
  if (!data) return `<div class="banner">${f.error ? esc(f.error) : '尚未读取到平台数据，请刷新重试。'}</div>`;
  if (tab === 'answer' || tab === 'mastery') {
    return `<section class="panel feature-panel"><div class="section-heading"><div><h2>${tab === 'mastery' ? '知识点掌握度' : '作业与考试'}</h2><p class="muted">默认保留平台已有答案。生成并保存草稿后，可在任务详情检查和确认提交。</p></div>${run(tab, tab === 'mastery' ? '处理所选练习' : '处理所选试卷')}</div><div class="assessment-list">${(data.papers || []).map((p) => `<article class="assessment-row"><label class="check-label"><input name="feature-item" type="checkbox" value="${esc(p.id)}"${!p.available || p.done && !p.can_redo ? ' disabled' : ''}><span><strong>${esc(p.name)}</strong><small class="muted">${esc(p.category)} · ${p.done ? '已完成' : p.available ? '可作答' : '暂不可作答'}${p.score != null ? ` · ${esc(p.score)} 分` : ''}${p.attempts_left != null ? ` · 剩余 ${esc(p.attempts_left)} 次` : ''}${p.ends_at ? ` · 截止 ${dateText(p.ends_at)}` : ''}</small>${p.reason ? `<small>${esc(p.reason)}</small>` : ''}</span></label>${p.done && p.can_review !== false ? button('查看已提交内容', 'paper-review', `data-id="${esc(p.id)}"`) : ''}</article>`).join('') || empty('没有待处理的试卷', '平台目录中暂未提供作业、考试或知识点练习。')}</div></section>`;
  }
  if (tab === 'meeting') return `<section class="panel feature-panel"><div class="section-heading"><div><h2>见面课回放签到</h2><p class="muted">通过官方播放器按原速播放，加载观看历史后续播，并以平台签到状态确认结果。</p></div>${run('meeting', '处理所选见面课')}</div>${(data.meetings || []).map((m) => `<label class="choice-row"><input name="feature-item" type="checkbox" value="${esc(m.id)}"${m.replay_available ? ' checked' : ''}><span><strong>${esc(m.name)}</strong><small class="muted">${m.replay_available ? '有回放' : '暂无可用回放，执行时会记录原因'}</small></span></label>`).join('') || empty('暂无见面课', '平台还没有提供见面课记录。')}</section>`;

  return '';
}

export function settingsView(state) {
  if (state.loading || !state.settings) return '<div class="loading-state"><span class="spinner"></span>正在读取设置…</div>';
  const { preferences: p, models, browser } = state.settings;
  return `<header class="page-heading"><div><div class="eyebrow">工作台偏好</div><h1>模型与任务设置</h1><p class="muted">密钥加密保存，可选择个人模型或管理员提供的共享模型。</p></div>${button('添加模型', 'model-add', '', true)}</header><div class="feature-grid"><section class="panel feature-panel"><h2>任务偏好</h2><form id="preferences-form"><label>默认模型<select name="model_id"><option value="">暂不使用模型，手动补答</option>${models.map((m) => `<option value="${esc(m.id)}"${p.model_id === m.id ? ' selected' : ''}${!m.enabled ? ' disabled' : ''}>${esc(m.name)}${m.shared ? ' · 共享' : ''}${!m.enabled ? ' · 已停用' : ''}</option>`).join('')}</select></label>${numberField('concurrency', '最多同时执行的任务', p.concurrency, 1, 8)}${numberField('review_minutes', '每日复习分钟数', p.review_minutes, 1, 60)}${toggle('quiet_hours', '启用夜间暂停（北京时间 23:00–07:00）', p.quiet_hours !== false)}${toggle('parallel_study', '允许同一账号跨课程并行学习', p.parallel_study)}${toggle('speedup', '课程学习使用最高 1.5 倍速', p.speedup)}${toggle('qa_allow_over_limit', '允许超额问答（有风险：可能不计分、触发平台限制并增加模型费用）', p.qa_allow_over_limit)}${toggle('qa_peers', '允许与同课程的其他工作台成员互助问答', p.qa_peers)}<p class="muted">互助仅在双方开启时共享已发布问题的编号。同一课程的任务始终排队；作答、交卷和问答保持账号串行。</p>${errorBox}<button class="button primary" type="submit">保存偏好</button></form><div class="banner">官方浏览器：${browser.available ? 'Chromium 可用' : '尚未找到 Chromium，见面课和问答暂不可用'}。${p.quiet_hours !== false ? '北京时间 23:00–07:00 自动暂停，早上继续夜间暂停的任务。' : '已关闭夜间暂停，你的任务可以全天运行。'}</div></section><section class="panel feature-panel"><h2>可用模型</h2>${models.map((m) => `<article class="model-card"><div class="section-heading"><div><h3>${esc(m.name)}</h3><small class="muted">${esc(m.model)} · ${m.shared ? '共享模型' : '个人模型'}</small></div><span class="badge${m.enabled ? ' state-completed' : ''}">${m.enabled ? '已启用' : '已停用'}</span></div><p class="model-url">${esc(m.base_url)}</p><small class="muted">${({ auto: '待检查接口格式', chat_completions: 'Chat Completions', responses: 'Responses' })[m.api_format]}</small><div class="actions">${button('连接检查', 'model-probe', `data-id="${esc(m.id)}"${!m.enabled ? ' disabled' : ''}`)}${m.owned ? `${button('编辑', 'model-edit', `data-id="${esc(m.id)}"`)}${button(m.enabled ? '停用' : '启用', 'model-toggle', `data-id="${esc(m.id)}"`)}${button('删除', 'model-delete', `data-id="${esc(m.id)}"`)}` : ''}</div></article>`).join('') || empty('还没有模型配置', '可添加兼容 Chat Completions 或 Responses 的服务，也可以手动补答。')}</section></div>` + legacyArchives(state.settings.legacy);
}
function legacyArchives(legacy) {
  if (!legacy) return '';
  return `<section class="panel feature-panel"><h2>旧站点迁移档案</h2><p class="muted">旧任务和报告作为只读档案保存，不会自动执行。共 ${legacy.total} 个文件，显示前 100 个。</p><details><summary>查看迁移文件</summary><div class="actions">${legacy.files.map(file => `<a class="button small" download href="/api/legacy/studia/archive?name=${encodeURIComponent(file.name)}">${esc(file.name)}</a>`).join('')}</div></details></section>`;
}
function modelForm(state, model = {}) {
  return modalFrame(model.id ? '编辑模型' : '添加模型', `<form id="model-form" data-id="${esc(model.id || '')}"><label>显示名称<input name="name" maxlength="100" required value="${esc(model.name || '')}" placeholder="例如：我的课程助手"></label><label>模型服务地址<input name="base_url" type="url" required value="${esc(model.base_url || '')}" placeholder="https://服务地址/v1"></label><label>模型标识<input name="model" maxlength="200" required value="${esc(model.model || '')}" placeholder="填写服务商提供的模型名称"></label><label>API Key<input name="api_key" type="password" autocomplete="new-password"${model.id ? '' : ' required'} placeholder="${model.id ? '留空保留原密钥' : '只在保存时提交，不会回显'}"></label><label>接口格式<select name="api_format">${[['auto', '自动检测（保存后运行连接检查）'], ['chat_completions', 'Chat Completions'], ['responses', 'Responses']].map(([id, name]) => `<option value="${id}"${(model.api_format || 'auto') === id ? ' selected' : ''}>${name}</option>`).join('')}</select></label>${toggle('enabled', '启用此模型', model.enabled !== false)}${state.me.user.role === 'admin' ? toggle('shared', '向工作台所有成员共享此模型', model.shared) : ''}<p class="muted">连接检查会向所填服务发送一次简短请求，可能消耗少量额度。</p>${formFooter('保存模型')}</form>`);
}

export async function openJob(operation, ctx) {
  const { state, api, openModal } = ctx;
  if (state.route.tab === 'qa') captureQa(state);
  state.settings = await api('/api/settings');
  const p = state.settings.preferences;
  let ids = operation === 'study' || operation === 'trial' ? [...state.selected] : [...document.querySelectorAll('[name="feature-item"]:checked')].map((i) => i.value);
  if (!['qa', 'ask'].includes(operation) && !ids.length) throw new Error('请先选择要处理的项目。');
  if (operation === 'trial' && (ids.length !== 1 || state.units.find((u) => u.id === ids[0])?.kind !== 'video')) throw new Error('短时试跑请选择一个视频单元。');
  const texts = operation === 'ask' ? [...document.querySelectorAll('[name="draft-selected"]:checked')].map((i) => document.querySelector(`[data-draft="${Number(i.value)}"]`).value.trim()) : [];
  if (operation === 'ask' && (!texts.length || texts.some((t) => t.length < 10 || t.length > 1000))) throw new Error('请选择长度为 10–1000 字的提问草稿。');
  const writing = ['answer', 'mastery'].includes(operation);
  const body = `<form id="job-form"><p>课程：<strong>${esc(state.course.name)}</strong></p><p class="muted">${operation === 'ask' ? `将发布 ${texts.length} 个已选提问，请确认正文。` : operation === 'qa' ? '会将生成的回答发布到平台课程讨论区。' : `已选择 ${ids.length} 个项目。`}</p>${writing || operation === 'qa' ? `<label>使用模型<select name="model_id"><option value="">${writing ? '手动补答' : '请先选择模型，或在任务暂停后手工填写'}</option>${state.settings.models.filter((m) => m.enabled).map((m) => `<option value="${esc(m.id)}"${p.model_id === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>` : ''}${writing ? `${toggle('auto_submit', '答案生成后自动提交（未勾选时先等待我确认）')}${toggle('redo', '明确重做所选试卷（仅平台允许时可用）')}<p class="muted">已有答案会保留。只有在任务详情明确允许覆盖后才修改已有作答。掌握度最多处理三轮，未达到满分会保留说明。</p>` : ''}${operation === 'study' ? toggle('speedup', '允许最高 1.5 倍速', p.speedup) : ''}${operation === 'trial' ? numberField('trial_seconds', '试跑秒数', 60, 30, 180) : ''}${operation === 'review' ? numberField('review_minutes', '本次复习分钟数', p.review_minutes, 1, 60) : ''}${operation === 'qa' ? `${numberField('limit', '最多回答数量', Math.min(state.feature?.counts?.answer || 5, qaBudget(state).room.answer || 1), 1, Math.max(1, qaBudget(state).room.answer))}${numberField('max_answers', '仅处理回答数不超过', 0, 0, 100)}` : ''}${['qa', 'ask'].includes(operation) && p.qa_allow_over_limit ? '<div class="banner risk-banner">超额模式已开启：额外内容可能不计分、触发平台限制，并消耗更多模型额度。请核对本次数量。</div>' : ''}${operation === 'ask' ? texts.map((t) => `<blockquote>${esc(t)}</blockquote>`).join('') : ''}${formFooter(operation === 'ask' ? '确认发布提问' : operation === 'qa' ? '确认开始发布回答' : '创建任务')}</form>`;
  openModal('job', modalFrame(operationNames[operation], body), { operation, ids, texts });
}

function questionsView(workflow, editable) {
  const questions = workflow.attempt?.questions || workflow.questions || [];
  return questions.map((q, index) => {
    const values = workflow.answers?.[q.id] || q.answer || [];
    let fields;
    if (['single', 'multiple', 'judge'].includes(q.kind)) {
      const choices = q.kind === 'judge' ? [{ id: 'true', text: '正确' }, { id: 'false', text: '错误' }] : q.options || [];
      fields = choices.map((o) => `<label class="choice-row"><input data-qid="${esc(q.id)}" type="${q.kind === 'multiple' ? 'checkbox' : 'radio'}" name="q-${index}" value="${esc(o.id)}"${values.includes(o.id) ? ' checked' : ''}${editable ? '' : ' disabled'}><span>${esc(o.text)}</span></label>`).join('');
    } else if (q.kind === 'blank' || q.kind === 'essay') fields = Array.from({ length: q.kind === 'blank' ? q.blanks : 1 }, (_, n) => `<label>${q.kind === 'blank' ? `第 ${n + 1} 空` : '回答'}<textarea data-qid="${esc(q.id)}" data-slot="${n}" rows="${q.kind === 'blank' ? 2 : 4}" maxlength="20000"${editable ? '' : ' readonly'}>${esc(values[n] || '')}</textarea></label>`).join('');
    else fields = '<p class="banner">此题型需要在官方页面完成，框架不会猜测作答格式。</p>';
    return `<article class="question-card" data-question="${esc(q.id)}" data-kind="${esc(q.kind)}"><div class="section-heading"><h3>${index + 1}. ${esc(q.text || '图片题')}</h3>${workflow.preserve?.includes(q.id) ? '<span class="tag">保留平台已有答案</span>' : ''}</div>${(q.images || []).map((url) => `<img class="question-image" src="${esc(url)}" alt="第 ${index + 1} 题图片" loading="lazy">`).join('')}${fields}${q.correct_answer?.length ? `<p>平台公布答案：${esc(optionLabel(q, q.correct_answer))}</p>` : ''}${q.explanation || workflow.explanations?.[q.id] ? `<p class="muted">${esc(q.explanation || workflow.explanations[q.id])}</p>` : ''}</article>`;
  }).join('');
}
export function taskDetail(result, quiet) {
  const { task, events, workflow: w } = result;
  let base = taskDetailView(task, events, quiet);
  let content = `<p class="muted">任务类型：${esc(operationNames[task.operation] || task.operation)}</p>${reportLinks(task.id)}`;
  if (result.reviewed_seconds) content += `<p class="banner">本次已复习 ${Math.round(result.reviewed_seconds / 60 * 10) / 10} 分钟，原完成状态已保留。</p>`;
  if (task.state === 'queued') content += `<div class="actions">${button('在队列中上移', 'task-move', `data-id="${esc(task.id)}" data-direction="up"`)}${button('在队列中下移', 'task-move', `data-id="${esc(task.id)}" data-direction="down"`)}</div>`;
  if (w) {
    if (w.kind === 'activity' && w.phase === 'waiting_text') content += `<form id="answers-form" data-id="${esc(task.id)}"><label>待发布的回答<textarea name="text" rows="6" minlength="10" maxlength="1500" required></textarea></label>${errorBox}<button class="button primary" type="submit">保存并继续发布</button></form>`;
    else if (w.attempt?.questions || w.questions) {
      const editable = task.state === 'paused' && ['answers', 'waiting_answers', 'waiting_submit'].includes(w.phase);
      content += `<form id="answers-form" data-id="${esc(task.id)}">${w.attempt?.expires_at ? `<div class="banner">本次作答截止：${dateText(w.attempt.expires_at)}</div>` : ''}${questionsView(w, editable)}${editable ? `${w.preserve?.length ? toggle('replace_existing', '我允许本次人工修改覆盖平台已有答案') : ''}${errorBox}<button class="button" type="submit">保存答案并继续</button>` : ''}</form>`;
    }
    if (task.state === 'paused' && w.phase === 'waiting_submit') content += `<div class="submit-confirm"><p>请检查上方答案，确认后将向平台提交本次作答。</p>${button('确认本次交卷', 'task-confirm', `data-id="${esc(task.id)}"${quiet ? ' disabled' : ''}`, true)}</div>`;
    if (task.state === 'paused' && ['submitting', 'readback'].includes(w.phase)) content += `<div class="banner">交卷结果待核对。此操作只读取平台结果，不会重新交卷。</div>${button('回读提交结果', 'task-readback', `data-id="${esc(task.id)}"`)}`;
    if (w.records?.length) content += `<h3 class="section-title">已确认的作答</h3>${w.records.map((r) => `<p>${esc(r.attempt?.name || r.paper?.name)} · ${r.score == null ? '平台未提供分数' : `${esc(r.score)} 分`} · 已确认提交</p>`).join('')}`;
  }
  return base.replace('<h3 class="section-title">执行记录</h3>', content + '<h3 class="section-title">执行记录</h3>');
}

export async function action(target, ctx) {
  const { state, api, openModal, closeModal, renderPage, refreshTasks, showTask, toast } = ctx;
  if (await qaAction(target, ctx)) return true;
  if (await scoreAction(target, ctx)) return true;
  const action = target.dataset.action, id = target.dataset.id;
  if (action === 'study' || action === 'feature-job') { await openJob(action === 'study' ? 'study' : target.dataset.operation, ctx); return true; }
  if (action?.startsWith('model-')) {
    if (action === 'model-add' || action === 'model-edit') openModal('model', modelForm(state, state.settings.models.find((m) => m.id === id)));
    else if (action === 'model-delete') openModal('model-delete', modalFrame('删除模型配置', `<p>删除后，使用此模型的新请求会暂停，已有密钥不会被替换。</p>${button('取消', 'modal-close')}${button('确认删除', 'model-remove', `data-id="${esc(id)}"`)}`));
    else if (action === 'model-remove') { await api('/api/settings/models/' + encodeURIComponent(id), { method: 'DELETE' }); closeModal(); state.settings = await api('/api/settings'); renderPage(); }
    else if (action === 'model-probe') { const r = await api('/api/settings/models/' + encodeURIComponent(id) + '/probe', { method: 'POST' }); state.settings = await api('/api/settings'); renderPage(); toast('连接检查通过：' + r.api_format); }
    else if (action === 'model-toggle') { const m = state.settings.models.find((m) => m.id === id); await api('/api/settings/models/' + encodeURIComponent(id), { method: 'POST', body: { enabled: !m.enabled } }); state.settings = await api('/api/settings'); renderPage(); }
    return true;
  }
  if (['task-confirm', 'task-readback', 'task-move'].includes(action)) {
    const method = ({ 'task-confirm': 'confirm', 'task-readback': 'readback', 'task-move': 'move' })[action];
    await api('/api/tasks/' + encodeURIComponent(id) + '/' + method, { method: 'POST', ...(action === 'task-move' ? { body: { direction: target.dataset.direction } } : {}) });
    await refreshTasks(); await showTask(id); return true;
  }
  if (action === 'paper-review') {
    const root = coursePath(state.route.pid, state.course) + '/papers/' + encodeURIComponent(id);
    const request = encodeURIComponent(crypto.randomUUID());
    let r = await api(root + '/review?request_id=' + request);
    for (let n = 0; !r.ready && n < 100; n++) r = await api(root + '/review?request_id=' + request);
    if (!r.ready) throw new Error('试卷尚未完整读取，请稍后重试。');
    openModal('review', modalFrame('已提交试卷 · 只读', downloadLinks(root + '/export', [['md', 'Markdown'], ['docx', 'Word'], ['json', 'JSON'], ['csv', 'CSV']]) + questionsView({ attempt: r.attempt }, false), true)); return true;
  }
  return false;
}

export async function submit(form, ctx) {
  const { state, api, closeModal, renderPage, refreshTasks, showTask, toast } = ctx;
  const data = Object.fromEntries(new FormData(form));
  if (form.id === 'preferences-form') {
    await api('/api/settings/preferences', { method: 'POST', body: { model_id: data.model_id || null, concurrency: Number(data.concurrency), review_minutes: Number(data.review_minutes), parallel_study: data.parallel_study === 'on', speedup: data.speedup === 'on', qa_peers: data.qa_peers === 'on', qa_allow_over_limit: data.qa_allow_over_limit === 'on', quiet_hours: data.quiet_hours === 'on' } });
    state.settings = await api('/api/settings'); state.bootstrap = await api('/api/bootstrap'); renderPage(); toast('任务偏好已保存。');
  } else if (form.id === 'model-form') {
    await api('/api/settings/models' + (form.dataset.id ? '/' + encodeURIComponent(form.dataset.id) : ''), { method: 'POST', body: { ...data, enabled: data.enabled === 'on', shared: data.shared === 'on' } });
    closeModal(); state.settings = await api('/api/settings'); renderPage(); toast('模型已保存，可以运行连接检查。');
  } else if (form.id === 'job-form') {
    const m = state.modal;
    const options = { ...(data.model_id !== undefined ? { model_id: data.model_id || null, use_ai: Boolean(data.model_id) } : {}), auto_submit: data.auto_submit === 'on', redo: data.redo === 'on', speedup: data.speedup === 'on', ...(data.review_minutes ? { review_minutes: Number(data.review_minutes) } : {}), ...(data.trial_seconds ? { limit_seconds: Number(data.trial_seconds) } : {}), ...(data.limit ? { limit: Number(data.limit), max_answers: Number(data.max_answers) } : {}), ...(m.texts?.length ? { texts: m.texts } : {}) };
    const r = await api(coursePath(state.route.pid, state.course) + '/jobs', { method: 'POST', body: { operation: m.operation, item_ids: m.ids, options } });
    closeModal(); await refreshTasks(); toast('任务已创建，可在任务详情中查看进度和补答。'); await showTask(r.task.id);
  } else if (form.id === 'answers-form') {
    let body;
    if (typeof data.text === 'string') body = { text: data.text };
    else {
      const answers = {};
      form.querySelectorAll('[data-question]').forEach((q) => {
        const inputs = [...q.querySelectorAll('[data-qid]')];
        const value = inputs.filter((i) => i.type !== 'radio' && i.type !== 'checkbox' || i.checked).map((i) => i.value.trim());
        if (value.some(Boolean)) answers[q.dataset.question] = value;
      });
      body = { answers, replace_existing: data.replace_existing === 'on' };
    }
    await api('/api/tasks/' + encodeURIComponent(form.dataset.id) + '/answers', { method: 'POST', body });
    await api('/api/tasks/' + encodeURIComponent(form.dataset.id) + '/resume', { method: 'POST' });
    await refreshTasks(); await showTask(form.dataset.id);
  } else if (form.id === 'draft-form') await submitDraft(form, ctx);
}
export const formIds = ['preferences-form', 'model-form', 'job-form', 'answers-form', 'draft-form'];
