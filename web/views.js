import { courseHref } from './api.js';

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  tasks: '<path d="M9 6h12M9 12h12M9 18h12M3 6l1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/>',
  module: '<path d="M12 3 3 8l9 5 9-5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  book: '<path d="M12 5v16M12 5C9 2 4 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-2-1-7-2-10 1Z"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
};
export const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.book}</svg>`;
export const activeTasks = (tasks) => tasks.filter((t) => ['queued', 'running', 'paused'].includes(t.state));
export const percent = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
export const labels = { queued: '排队中', running: '执行中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已停止', not_started: '未开始', in_progress: '进行中', unknown: '待核对' };
export const stateLabel = (value) => labels[value] || value;
export const badge = (value) => `<span class="badge state-${esc(value)}">${esc(stateLabel(value))}</span>`;
export const progress = (value, label = '进度') => `<progress max="100" value="${percent(value)}" aria-label="${esc(label)}">${Math.round(percent(value))}%</progress>`;
export const dateText = (seconds) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai', hour12: false }).format(new Date(seconds * 1000));
const duration = (seconds) => seconds == null ? '时长未知' : seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
export const empty = (title, text, action = '', symbol = 'book') => `<div class="empty-state"><span class="empty-icon">${icon(symbol)}</span><h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</div>`;
const heading = (eyebrow, title, description, tools = '') => `<header class="page-heading"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p class="muted">${esc(description)}</p></div><div class="actions">${tools}</div></header>`;

export function authView(bootstrap, mode = 'login') {
  const setup = bootstrap?.setup_required;
  const register = !setup && mode === 'register';
  const required = bootstrap?.registration?.invitation_required !== false;
  return `<form id="auth-form" data-mode="${setup ? 'setup' : register ? 'register' : 'login'}" class="auth-card"><a class="brand" href="#/courses"><span class="brand-mark" aria-hidden="true">≋</span>Courseflow</a><div class="eyebrow">你的课程工作台</div><h1>${setup ? '从这里，开始有序学习' : register ? '创建你的工作台账号' : '欢迎回来'}</h1><p class="muted">${setup ? '创建管理员账号，连接你的第一个课程平台。' : register ? required ? '使用管理员提供的邀请码，加入课程工作台。' : '注册账号，开始管理你的课程与进度。' : '连接课程，继续上次的进度。'}</p>
    ${setup ? '<label>管理员设置码<input name="setup_code" autocomplete="off" placeholder="填写服务终端中的一次性设置码" required></label>' : ''}
    <label>用户名<input name="username" autocomplete="username" minlength="2" maxlength="32" placeholder="你的用户名" required></label>
    <label>密码<input name="password" type="password" autocomplete="${setup || register ? 'new-password' : 'current-password'}"${setup || register ? ' minlength="12"' : ''} placeholder="${setup || register ? '至少 12 个字符' : '输入登录密码'}" required></label>
    ${register ? `<label>确认密码<input name="password_confirmation" type="password" autocomplete="new-password" minlength="12" placeholder="再输入一次密码" required></label><label>邀请码${required ? '' : '（选填）'}<input name="invitation_code" class="invitation-input" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="29" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"${required ? ' required' : ''}></label>` : ''}
    <p class="form-error" role="alert" hidden></p><button class="button primary full" type="submit">${setup ? '创建管理员并进入' : register ? '注册并进入工作台' : '登录工作台'}${icon('arrow')}</button>
    ${setup ? '' : `<p class="auth-switch">${register ? '已有账号？<a href="#/login">返回登录</a>' : '还没有账号？<a href="#/register">注册账号</a>'}</p>`}<div class="auth-foot">课程 · 进度 · 任务，一处管理</div></form>`;
}

export function navigation(state) {
  const route = state.route;
  const link = (href, text, symbol, active, count = '') => `<a class="nav-item${active ? ' active' : ''}" href="${href}"${active ? ' aria-current="page"' : ''}>${icon(symbol)}<span>${esc(text)}</span>${count !== '' ? `<span class="nav-count">${count}</span>` : ''}</a>`;
  return `<div class="nav-group">${link('#/courses', '所有课程', 'grid', route.page === 'courses' && !route.pid)}${link('#/tasks', '任务中心', 'tasks', route.page === 'tasks', activeTasks(state.tasks).length || '')}</div>
    <div class="nav-label">课程平台<span>${state.platforms.length}</span></div><div class="nav-group platform-nav">${state.platforms.map((p) => `<a class="nav-item${route.pid === p.id ? ' active' : ''}" href="#/platform/${encodeURIComponent(p.id)}"${route.pid === p.id ? ' aria-current="page"' : ''}><span class="platform-mark">${esc([...p.short].slice(0, 1).join(''))}</span><span>${esc(p.name)}</span><span class="status-dot ${p.connected && p.module.healthy ? '' : 'offline'}" title="${p.module.healthy ? p.connected ? '已连接' : '未连接' : '模块未运行'}"></span></a>`).join('') || '<p class="nav-hint">连接平台后，课程会出现在这里。</p>'}</div>
    <div class="nav-label">工作台</div><div class="nav-group">${link('#/settings', '模型与任务设置', 'module', route.page === 'settings')}${link('#/connections', '平台连接', 'link', route.page === 'connections')}${link('#/logs', '日志导出', 'download', route.page === 'logs')}${state.me.user.role === 'admin' ? link('#/invitations', '注册与邀请', 'user', route.page === 'invitations') + link('#/modules', '模块管理', 'module', route.page === 'modules') : ''}</div>`;
}

export function coursesView(state) {
  const platform = state.platforms.find((p) => p.id === state.route.pid);
  if (state.route.pid && !platform) return empty('平台暂不可用', '模块可能已停用，请在平台连接中查看。', '<a class="button" href="#/connections">查看平台连接</a>', 'link');
  const all = state.platforms.filter((p) => !state.route.pid || p.id === state.route.pid);
  const courses = all.flatMap((p) => (state.courseLists[p.id] || []).map((c) => ({ ...c, platform: p })));
  const query = state.search.trim().toLocaleLowerCase();
  const filtered = courses.filter((c) => (!query || `${c.name} ${c.platform.name}`.toLocaleLowerCase().includes(query)) &&
    (state.filter === 'all' || (state.filter === 'completed' ? c.progress != null && c.progress >= 100 : c.progress == null || c.progress < 100)));
  const completed = courses.filter((c) => c.progress != null && c.progress >= 100).length;
  const tools = `<button class="button" data-action="refresh-courses"${state.loading ? ' disabled' : ''}>${icon('refresh')}刷新课程</button><a class="button primary" href="#/connections">${icon('link')}连接平台</a>`;
  const intro = heading('学习空间', platform ? platform.name : '所有课程', platform ? (platform.connected ? `${platform.display_name || '平台账号'} · 接着上次的进度，继续学习。` : '连接平台账号后，即可读取课程与学习进度。') : '把课程放在一起，让学习有条不紊。', tools);
  if (state.loading) return intro + '<div class="loading-state"><span class="spinner"></span>正在读取课程…</div>';
  if (!all.length) return intro + empty('连接你的第一个课程平台', '安装平台模块，连接账号，课程就会出现在这里。', `<a class="button primary" href="#/${state.me.user.role === 'admin' ? 'modules' : 'connections'}">${icon('link')}${state.me.user.role === 'admin' ? '添加平台模块' : '查看平台连接'}</a>`, 'grid');
  const errors = all.filter((p) => state.courseErrors[p.id]).map((p) => `<div class="banner error-banner">${esc(p.name)}：${esc(state.courseErrors[p.id])}<button class="text-button" data-action="refresh-courses">重试</button></div>`).join('');
  if (!courses.length) return intro + errors + empty(all.some((p) => p.connected) ? '暂无课程' : '还差一步，连接平台账号', all.some((p) => p.connected) ? '你可以刷新课程，或到平台确认当前学期的课程。' : '连接后即可在这里查看课程目录和学习进度。', '<a class="button primary" href="#/connections">管理平台连接</a>', 'link');
  return intro + errors + `<div class="stats-strip"><div><span class="stat-value">${courses.length}</span><span>门课程</span></div><div><span class="stat-value">${courses.length - completed}</span><span>待完成</span></div><div><span class="stat-value">${completed}</span><span>已完成</span></div><div><span class="stat-value">${activeTasks(state.tasks).length}</span><span>项当前任务</span></div></div>
    <div class="course-toolbar"><div class="segmented" aria-label="课程筛选">${[['all', '全部课程'], ['active', '待完成'], ['completed', '已完成']].map(([id, text]) => `<button data-action="filter" data-value="${id}" class="${state.filter === id ? 'active' : ''}" aria-pressed="${state.filter === id}">${text}</button>`).join('')}</div><label class="search-field">${icon('search')}<input id="course-search" type="search" placeholder="搜索课程或平台…" aria-label="搜索课程或平台" value="${esc(state.search)}"></label></div><div id="course-results">${courseCards(filtered, courses.length)}</div>`;
}

export function courseCards(courses, total) {
  if (!courses.length) return empty('没有找到匹配的课程', '试试其他关键词或筛选条件。', '<button class="button" data-action="clear-search">清除筛选</button>', 'search');
  return `<div class="course-grid">${courses.map((course) => `<a class="course-card" href="${courseHref(course.platform.id, course)}"><div class="course-card-top"><span class="course-symbol">${icon('book')}</span><span class="tag">${esc(course.kind_label || course.kind)}</span></div><h2>${esc(course.name)}</h2><p class="course-platform"><span class="status-dot"></span>${esc(course.platform.name)}</p><div class="course-progress-label"><span>学习进度</span><strong>${course.progress == null ? '待同步' : Math.round(percent(course.progress)) + '%'}</strong></div>${progress(course.progress, course.name + '学习进度')}<div class="course-card-foot"><span>${course.outline_available ? '查看课程目录' : '查看课程信息'}</span>${icon('arrow')}</div></a>`).join('')}</div><p class="list-foot">显示 ${courses.length} 门课程 · 共 ${total} 门</p>`;
}

export function courseView(state, featureContent = null) {
  if (state.loading) return '<div class="loading-state"><span class="spinner"></span>正在读取课程目录…</div>';
  if (!state.course) return empty('无法打开课程', '请返回课程列表重试。', '<a class="button" href="#/courses">返回课程</a>');
  const course = state.course;
  const platform = state.platforms.find((p) => p.id === state.route.pid);
  const pending = state.units.filter((u) => u.selectable && u.state !== 'completed');
  const done = state.units.filter((u) => u.state === 'completed').length;
  const tabs = [{ id: 'study', label: '学习目录' }, ...(state.presentation?.tabs || []).filter((t) => t.id !== 'study')];
  const chapters = new Map();
  for (const unit of state.units) {
    const key = unit.chapter_id || unit.chapter_name || '';
    if (!chapters.has(key)) chapters.set(key, { name: unit.chapter_name || '课程单元', units: [] });
    chapters.get(key).units.push(unit);
  }
  return `<a class="back-link" href="#/platform/${encodeURIComponent(state.route.pid)}">← 返回${esc(platform?.name || '平台课程')}</a>` +
    heading(course.kind_label || course.kind, course.name, `${platform?.name || ''} · ${state.units.length} 个单元 · ${done} 个已完成`, `<button class="button" data-action="refresh-course">${icon('refresh')}刷新目录</button>`) +
    `<div class="detail-overview"><div><span class="muted">课程进度</span><strong>${course.progress == null ? '待同步' : Math.round(percent(course.progress)) + '%'}</strong></div>${progress(course.progress)}<span class="muted">${done} / ${state.units.length} 单元已完成</span></div><div class="detail-tabs" aria-label="课程功能">${tabs.map((t) => `<a href="${courseHref(state.route.pid, course)}${t.id === 'study' ? '' : '/' + encodeURIComponent(t.id)}" class="${t.id === (state.route.tab || 'study') ? 'active' : ''}">${esc(t.label)}</a>`).join('')}</div>${featureContent !== null ? featureContent : ''}
    ${featureContent !== null ? '' : `
    ${!course.outline_available ? '<div class="banner">此课程的目录暂未由平台模块提供。</div>' : ''}
    ${state.units.length ? `<div class="selection-toolbar"><label class="check-label"><input id="select-all" type="checkbox"${pending.length && pending.every((u) => state.selected.has(u.id)) ? ' checked' : ''}${pending.length ? '' : ' disabled'}>选择未完成单元</label><span id="selection-count" class="muted">已选择 ${state.selected.size} 个</span><span class="spacer"></span>${platform?.operations.includes('trial') && state.presentation?.actions?.some((a) => a.id === 'trial') ? '<button class="button" data-action="feature-job" data-operation="trial">短时试跑</button>' : ''}<button id="study-button" class="button primary" data-action="study"${!state.selected.size || state.bootstrap.quiet_hours.active || !state.bootstrap.capabilities.jobs.includes('study') || !platform?.operations.includes('study') ? ' disabled' : ''}>${icon('play')}开始学习</button></div>
    <div class="outline">${[...chapters.values()].map((chapter) => `<section class="chapter"><header><h2>${esc(chapter.name)}</h2><span class="muted">${chapter.units.filter((u) => u.state === 'completed').length} / ${chapter.units.length}</span></header>${chapter.units.map((u) => `<label class="unit-row${u.state === 'completed' ? ' completed' : ''}"><input type="checkbox" data-unit="${esc(u.id)}"${state.selected.has(u.id) ? ' checked' : ''}${!u.selectable || u.state === 'completed' ? ' disabled' : ''} aria-label="选择 ${esc(u.name)}"><span class="unit-symbol">${icon(u.state === 'completed' ? 'check' : u.kind === 'video' ? 'play' : 'book')}</span><span class="unit-info"><strong>${esc(u.name)}</strong><small class="muted">${esc(({ video: '视频', audio: '音频', document: '文档', reading: '阅读', empty: '章节' })[u.kind] || u.kind)} · ${duration(u.duration_seconds)}${u.selectable_note ? ' · ' + esc(u.selectable_note) : ''}</small></span>${badge(u.state)}</label>`).join('')}</section>`).join('')}</div>` : empty('暂无学习单元', '刷新目录后可查看平台提供的学习单元。')}`}`;
}

export function taskActions(task, quiet = false) {
  return `${['running', 'queued'].includes(task.state) ? `<button class="button small" data-action="task-pause" data-id="${esc(task.id)}">暂停</button>` : ''}${task.state === 'paused' ? `<button class="button small" data-action="task-resume" data-id="${esc(task.id)}"${quiet ? ' disabled title="夜间暂停期间不能继续任务"' : ''}>继续</button>` : ''}${['queued', 'running', 'paused'].includes(task.state) ? `<button class="text-button danger" data-action="task-stop" data-id="${esc(task.id)}">停止</button>` : ''}`;
}

export function tasksView(state) {
  return heading('学习动态', '任务中心', '查看学习进度，或从上次的检查点继续。', `<button class="button" data-action="refresh-tasks">${icon('refresh')}刷新</button>`) +
    `<div class="segmented task-filters">${[['all', '全部任务'], ['active', '进行中'], ['ended', '已结束']].map(([id, text]) => `<button data-action="task-filter" data-value="${id}" class="${state.taskFilter === id ? 'active' : ''}" aria-pressed="${state.taskFilter === id}">${text}</button>`).join('')}</div><div id="task-list">${taskList(state)}</div>`;
}

export function taskList(state) {
  const tasks = state.tasks.filter((t) => state.taskFilter === 'all' || (state.taskFilter === 'active' ? activeTasks([t]).length : !activeTasks([t]).length));
  return tasks.length ? `<div class="task-list">${tasks.map((t) => `<article class="task-card"><div class="task-symbol">${icon(t.state === 'completed' ? 'check' : 'tasks')}</div><div class="task-main"><div class="task-title"><button class="title-button" data-action="task-detail" data-id="${esc(t.id)}">${esc(t.course_name)}</button>${badge(t.state)}</div><p class="muted">${esc(t.detail)}</p>${progress(t.progress)}<div class="task-meta">${t.completed.length} / ${t.units.length} 单元 · ${Math.round(percent(t.progress))}%<span>更新于 ${dateText(t.updated_at)}</span></div></div><div class="actions">${taskActions(t, state.bootstrap.quiet_hours.active)}<button class="icon-button" data-action="task-detail" data-id="${esc(t.id)}" aria-label="查看任务详情">${icon('arrow')}</button></div></article>`).join('')}</div>` : empty('这里暂时没有任务', '打开课程，选择学习单元，即可创建任务。', '<a class="button primary" href="#/courses">查看课程</a>', 'tasks');
}

export function taskbarView(state) {
  const tasks = activeTasks(state.tasks);
  if (!tasks.length) return '';
  const task = tasks.find((t) => t.state === 'running') || tasks[0];
  return `<span class="taskbar-symbol">${icon(task.state === 'paused' ? 'clock' : 'play')}</span><div class="taskbar-info"><button class="title-button" data-action="task-detail" data-id="${esc(task.id)}">${esc(task.course_name)}</button><span class="muted">${esc(task.detail)}</span></div><div class="taskbar-progress">${progress(task.progress)}<small>${Math.round(percent(task.progress))}%</small></div><div class="taskbar-actions">${taskActions(task, state.bootstrap.quiet_hours.active)}</div><a class="button small" href="#/tasks">全部任务<span class="count-bubble">${tasks.length}</span></a>`;
}

export function connectionsView(state) {
  return heading('平台与账号', '平台连接', '连接你的平台账号，课程与进度由平台实时提供。', state.me.user.role === 'admin' ? '<a class="button" href="#/modules">管理平台模块</a>' : '') +
    (state.platforms.length ? `<div class="connection-grid">${state.platforms.map((p) => `<article class="connection-card"><div class="connection-heading"><span class="platform-tile">${esc([...p.short].slice(0, 2).join(''))}</span><div><h2>${esc(p.name)}</h2><span class="muted">${p.connected ? esc(p.display_name || '已连接账号') : '尚未连接账号'}</span></div><span class="badge ${p.connected ? 'state-completed' : ''}">${p.connected ? '已连接' : '未连接'}</span></div><div class="connection-meta"><span class="status-dot ${p.module.healthy ? '' : 'offline'}"></span>${p.module.healthy ? '平台服务运行中' : '模块暂不可用'}<span>v${esc(p.module.version)}</span></div><div class="connection-actions">${p.connected ? `<a class="button primary" href="#/platform/${encodeURIComponent(p.id)}">查看课程${icon('arrow')}</a><button class="text-button danger" data-action="disconnect" data-id="${esc(p.id)}">断开连接</button>` : `${!p.module.healthy ? '<small class="muted">模块暂不可用</small>' : `${p.login.includes('qr') ? `<button class="button primary" data-action="connect" data-id="${esc(p.id)}" data-method="qr">${icon('link')}扫码连接</button>` : ''}${p.login.includes('password') ? `<button class="button primary" data-action="connect" data-id="${esc(p.id)}" data-method="password">${icon('link')}账号密码连接</button>` : ''}${p.login.length ? '' : '<small class="muted">此模块没有声明登录方式</small>'}`}`}</div></article>`).join('')}</div>` : empty('还没有可连接的平台', '管理员添加并启用平台模块后，即可连接账号。', state.me.user.role === 'admin' ? '<a class="button primary" href="#/modules">添加平台模块</a>' : '', 'link'));
}

export function modulesView(state) {
  if (state.me.user.role !== 'admin') return empty('此页面仅管理员可用', '你可以在平台连接中管理自己的账号。', '<a class="button" href="#/connections">平台连接</a>', 'module');
  return heading('工作台管理', '平台模块', '独立安装与更新平台能力，统一管理运行状态。', `<button class="button primary" data-action="install">＋ 添加模块</button>`) +
    (state.builtinModules || []).map(module => `<section class="panel builtin-module"><div class="section-heading"><div><span class="eyebrow">内置模块 · 接口 v${esc(module.interface_version)}</span><h2>${esc(module.name)}</h2></div><span class="badge state-completed">随框架运行</span></div><p class="muted">${esc(module.description)}</p><p class="muted">仅平台确认正确或明确复核的答案会被记忆，模型候选不会自动成为正确答案。</p></section>`).join('') +
    (state.modules.length ? `<div class="module-list">${state.modules.map((m) => `<article class="module-card"><div class="module-top"><span class="module-symbol">${icon('module')}</span><div><h2>${esc(m.name || m.id)}</h2><div class="muted">${esc(m.id)} · v${esc(m.version)}</div></div><span class="spacer"></span><span class="badge ${m.running ? 'state-completed' : m.enabled ? 'state-paused' : ''}">${m.running ? '运行中' : m.enabled ? '等待启动' : '已停用'}</span></div><dl class="module-info"><div><dt>运行方式</dt><dd>${m.engine === 'node' ? 'Node.js 模块' : '独立二进制'}</dd></div><div><dt>网络权限</dt><dd>${m.permissions.network.length ? esc(m.permissions.network.join('、')) : '无外部网络'}</dd></div><div><dt>内容指纹</dt><dd><code title="${esc(m.sha256)}">${esc(m.sha256.slice(0, 16))}…</code></dd></div></dl><div class="module-foot"><span class="muted">${m.enabled ? '已启用' : '已停用'}</span><div class="actions"><button class="button small" data-action="configure" data-id="${esc(m.id)}">模块设置</button><button class="button small${m.enabled ? '' : ' primary'}" data-action="module-${m.enabled ? 'disable' : 'enable'}" data-id="${esc(m.id)}">${m.enabled ? '停用' : '启用'}</button></div></div></article>`).join('')}</div>` : empty('为工作台添加平台能力', '从服务器上的模块目录或 .tgz 安装包添加平台。', '<button class="button primary" data-action="install">＋ 添加第一个模块</button>', 'module'));
}

export function accountView(state) {
  return heading('个人空间', '我的账号', '管理当前登录与工作台偏好。') + `<section class="panel account-panel"><span class="avatar large">${esc([...state.me.user.username][0].toUpperCase())}</span><h2>${esc(state.me.user.username)}</h2><span class="badge">${state.me.user.role === 'admin' ? '管理员' : '成员'}</span><div class="account-stats"><div><strong>${state.platforms.filter((p) => p.connected).length}</strong><span>已连接平台</span></div><div><strong>${activeTasks(state.tasks).length}</strong><span>当前任务</span></div></div><div class="settings-row"><span>模型与任务偏好</span><a class="button" href="#/settings">打开设置</a></div><div class="settings-row"><span>运行与任务日志</span><a class="button" href="#/logs">日志导出</a></div>${state.me.user.role === 'admin' ? '<div class="settings-row"><span>新成员注册与邀请码</span><a class="button" href="#/invitations">注册与邀请</a></div>' : ''}<div class="settings-row"><span>界面主题</span><button class="button" data-action="theme">切换深浅主题</button></div><div class="settings-row"><span>站点会话</span><button class="button danger" data-action="logout">退出登录</button></div></section>`;
}

export function modalFrame(title, body, wide = false) {
  return `<div class="modal-content${wide ? ' wide' : ''}"><header class="modal-heading"><h2 id="modal-title">${esc(title)}</h2><button class="icon-button" data-action="modal-close" aria-label="关闭">${icon('close')}</button></header>${body}</div>`;
}

export function taskDetailView(task, events, quiet) {
  return modalFrame('任务详情', `<div class="task-detail-title"><h3>${esc(task.course_name)}</h3>${badge(task.state)}</div><p class="muted">${esc(task.detail)}</p>${progress(task.progress)}<p class="muted">已完成 ${task.completed.length} / ${task.units.length} 个单元 · ${Math.round(percent(task.progress))}%</p><div class="actions">${taskActions(task, quiet)}<a class="button" href="/api/tasks/${encodeURIComponent(task.id)}/logs" download>${icon('download')}导出日志</a></div><h3 class="section-title">执行记录</h3><div class="event-list">${events.map((e) => `<div class="event-row"><span class="event-dot"></span><div><p>${esc(e.detail)}</p><time class="muted">${dateText(e.created_at)}</time></div></div>`).join('') || '<p class="muted">暂无执行记录。</p>'}</div>`, true);
}
