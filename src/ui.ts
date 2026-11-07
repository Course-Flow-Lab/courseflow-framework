export const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Courseflow</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="bar">
  <strong>Courseflow</strong>
  <span id="status" class="muted">正在读取…</span>
  <span class="spacer"></span>
  <button id="logout" class="ghost hidden">退出</button>
</header>
<main id="app"></main>
<script src="/app.js" type="module"></script>
</body>
</html>
`;

export const STYLE_CSS = `:root {
  --bg:#0f1115; --panel:#171a21; --line:#262b35; --text:#e6e9ef; --muted:#8b93a7; --accent:#4f8cff; --ok:#39b57a; --warn:#d2a13a; --err:#e05a5a;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin:0; font: 14px/1.55 ui-sans-serif, system-ui, "Noto Sans CJK SC", sans-serif; background:var(--bg); color:var(--text); }
.bar { display:flex; gap:12px; align-items:center; padding:12px 20px; border-bottom:1px solid var(--line); background:var(--panel); position:sticky; top:0; }
.spacer { flex:1; }
.muted { color:var(--muted); }
main { max-width: 980px; margin: 0 auto; padding: 24px 20px 64px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px; margin-bottom:16px; }
h1,h2,h3 { margin:0 0 12px; font-weight:600; }
h1 { font-size:20px; } h2 { font-size:16px; } h3 { font-size:14px; color:var(--muted); font-weight:500; }
label { display:block; margin:10px 0 4px; color:var(--muted); font-size:12px; }
input, select, button, textarea { font:inherit; color:inherit; }
input, select { width:100%; padding:9px 11px; border-radius:8px; border:1px solid var(--line); background:#0d1016; }
button { padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:#202734; cursor:pointer; }
button:hover { border-color:var(--accent); }
button.primary { background:var(--accent); border-color:var(--accent); color:#06101f; font-weight:600; }
button.ghost { background:transparent; }
button:disabled { opacity:.5; cursor:not-allowed; }
.row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.grid { display:grid; gap:12px; }
.pill { padding:2px 8px; border-radius:999px; border:1px solid var(--line); font-size:12px; color:var(--muted); }
.pill.ok { color:var(--ok); border-color:color-mix(in srgb, var(--ok) 40%, var(--line)); }
.pill.warn { color:var(--warn); border-color:color-mix(in srgb, var(--warn) 40%, var(--line)); }
.pill.err { color:var(--err); border-color:color-mix(in srgb, var(--err) 40%, var(--line)); }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:500; font-size:12px; }
.hidden { display:none !important; }
.error { color:var(--err); margin-top:10px; white-space:pre-wrap; }
.qr { width:180px; height:180px; border-radius:8px; background:#fff; padding:6px; object-fit:contain; }
.bar-track { height:6px; border-radius:999px; background:#0d1016; overflow:hidden; }
.bar-fill { height:100%; background:var(--accent); transition:width .3s; }
a { color:var(--accent); }
code { background:#0d1016; padding:1px 5px; border-radius:4px; font-size:12px; }
`;

export const APP_JS = String.raw`
const state = { csrf: '', me: null, bootstrap: null, platforms: [], modules: [], courses: [], tasks: [], course: null, units: [], selected: new Set(), poll: null };
const $ = (sel) => document.querySelector(sel);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (state.csrf && options.method && options.method !== 'GET') headers['x-courseflow-csrf'] = state.csrf;
  const response = await fetch(path, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    const error = new Error(data?.error?.message || response.statusText);
    error.code = data?.error?.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function render() {
  const app = $('#app');
  const bootstrap = state.bootstrap;
  $('#status').textContent = state.me ? state.me.user.username + (state.me.user.role === 'admin' ? '（管理员）' : '') : (bootstrap?.setup_required ? '需要初始化' : '未登录');
  $('#logout').classList.toggle('hidden', !state.me);
  if (bootstrap?.setup_required) { app.innerHTML = setupView(); return; }
  if (!state.me) { app.innerHTML = loginView(); return; }
  app.innerHTML = platformsView() + coursesView() + tasksView() + (state.me.user.role === 'admin' ? modulesView() : '');
}

function setupView() {
  return '<div class="card"><h1>初始化 Courseflow</h1><p class="muted">首次启动时，终端会打印一次性设置码。</p>' +
    '<label>设置码</label><input id="setup-code" autocomplete="off">' +
    '<label>管理员用户名</label><input id="setup-user" autocomplete="username">' +
    '<label>密码（至少 12 个字符）</label><input id="setup-pass" type="password" autocomplete="new-password">' +
    '<div class="row" style="margin-top:14px"><button class="primary" id="setup-submit">创建管理员</button></div><div id="setup-error" class="error"></div></div>';
}

function loginView() {
  return '<div class="card"><h1>登录</h1>' +
    '<label>用户名</label><input id="login-user" autocomplete="username">' +
    '<label>密码</label><input id="login-pass" type="password" autocomplete="current-password">' +
    '<div class="row" style="margin-top:14px"><button class="primary" id="login-submit">登录</button></div><div id="login-error" class="error"></div></div>';
}

function platformsView() {
  const rows = state.platforms.map((p) => {
    const connected = p.connected ? '<span class="pill ok">已连接 ' + esc(p.display_name || '') + '</span>' : '<span class="pill">未连接</span>';
    const healthy = p.module.healthy ? '<span class="pill ok">模块运行中</span>' : '<span class="pill warn">模块未运行</span>';
    const actions = p.connected
      ? '<button data-courses="' + esc(p.id) + '">查看课程</button> <button class="ghost" data-disconnect="' + esc(p.id) + '">断开</button>'
      : '<button data-login="' + esc(p.id) + '">连接</button>';
    return '<tr><td><strong>' + esc(p.name) + '</strong><br><span class="muted">' + esc(p.id) + ' · ' + esc(p.operations.join(' / ')) + '</span></td><td>' + connected + '<br>' + healthy + '</td><td>' + actions + '</td></tr>';
  }).join('');
  return '<div class="card"><h2>平台</h2>' +
    (rows ? '<table><thead><tr><th>平台</th><th>状态</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="muted">尚未安装任何平台模块。用 <code>npm run cli -- module add &lt;path&gt;</code> 安装。</p>') +
    '</div>' + (state.loginChallenge ? challengeView() : '');
}

function challengeView() {
  const challenge = state.loginChallenge;
  return '<div class="card"><h2>连接 ' + esc(challenge.platform) + '</h2>' +
    (challenge.image ? '<img class="qr" src="' + esc(challenge.image) + '" alt="登录二维码">' : '<p class="muted">正在等待平台…</p>') +
    '<p class="muted">状态：' + esc(challenge.state || 'waiting') + '</p></div>';
}

function coursesView() {
  if (!state.courses.length) return '';
  const rows = state.courses.map((course) =>
    '<tr><td><strong>' + esc(course.name) + '</strong><br><span class="muted">' + esc(course.kind_label || course.kind) + ' · ' + esc(course.id) + '/' + esc(course.recruit_id) + '</span></td>' +
    '<td>' + (course.progress == null ? '—' : esc(course.progress) + '%') + '</td>' +
    '<td><button data-course="' + esc(course.id + '/' + course.recruit_id) + '">打开目录</button></td></tr>').join('');
  return '<div class="card"><h2>课程</h2><table><thead><tr><th>课程</th><th>进度</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' + unitsView();
}

function unitsView() {
  if (!state.course) return '';
  const rows = state.units.map((unit) => {
    const disabled = !unit.selectable ? ' disabled' : '';
    const checked = state.selected.has(unit.id) ? ' checked' : '';
    return '<tr><td><input type="checkbox" data-unit="' + esc(unit.id) + '" style="width:auto"' + checked + disabled + '></td>' +
      '<td>' + esc(unit.name) + (unit.selectable_note ? '<br><span class="muted">' + esc(unit.selectable_note) + '</span>' : '') + '</td>' +
      '<td><span class="pill">' + esc(unit.kind) + '</span></td><td><span class="pill">' + esc(unit.state) + '</span></td></tr>';
  }).join('');
  return '<div class="card"><h2>' + esc(state.course.name) + '</h2>' +
    (rows ? '<table><thead><tr><th></th><th>单元</th><th>类型</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="muted">目录为空。</p>') +
    '<div class="row" style="margin-top:12px"><button class="primary" id="study-submit"' + (state.selected.size ? '' : ' disabled') + '>开始学习所选单元（' + state.selected.size + '）</button></div></div>';
}

function tasksView() {
  if (!state.tasks.length) return '';
  const rows = state.tasks.map((task) =>
    '<tr><td><strong>' + esc(task.course_name) + '</strong><br><span class="muted">' + esc(task.detail) + '</span></td>' +
    '<td><span class="pill ' + (task.state === 'completed' ? 'ok' : task.state === 'failed' ? 'err' : task.state === 'paused' ? 'warn' : '') + '">' + esc(task.state) + '</span></td>' +
    '<td>' + (task.progress == null ? '—' : '<div class="bar-track"><div class="bar-fill" style="width:' + Number(task.progress) + '%"></div></div>') + '</td>' +
    '<td>' + (['queued','running','paused'].includes(task.state) ? '<button data-task-stop="' + esc(task.id) + '">停止</button>' : '') +
    (task.state === 'paused' ? ' <button data-task-resume="' + esc(task.id) + '">继续</button>' : '') + '</td></tr>').join('');
  return '<div class="card"><h2>任务</h2><table><thead><tr><th>任务</th><th>状态</th><th>进度</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function modulesView() {
  const rows = state.modules.map((m) =>
    '<tr><td><strong>' + esc(m.id) + '</strong> ' + esc(m.version) + '<br><span class="muted">' + esc(m.engine) + ' · ' + esc(m.sha256.slice(0, 12)) + '…</span></td>' +
    '<td>' + (m.enabled ? '<span class="pill ok">启用</span>' : '<span class="pill">停用</span>') + ' ' + (m.running ? '<span class="pill ok">运行中</span>' : '<span class="pill warn">未运行</span>') + '</td>' +
    '<td>' + (m.enabled ? '<button data-disable="' + esc(m.id) + '">停用</button>' : '<button data-enable="' + esc(m.id) + '">启用</button>') + '</td></tr>').join('');
  return '<div class="card"><h2>模块</h2>' + (rows ? '<table><thead><tr><th>模块</th><th>状态</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="muted">尚未安装模块。</p>') + '</div>';
}

async function loadAll() {
  state.bootstrap = await api('/api/bootstrap');
  try { state.me = await api('/api/me'); state.csrf = state.me.csrf; } catch { state.me = null; }
  if (state.me) {
    state.platforms = (await api('/api/platforms')).platforms;
    state.tasks = (await api('/api/tasks')).tasks;
    if (state.me.user.role === 'admin') state.modules = (await api('/api/modules')).modules;
  }
  render();
  scheduleRefresh();
}

function scheduleRefresh() {
  if (state.poll) clearTimeout(state.poll);
  if (!state.me) return;
  state.poll = setTimeout(async () => {
    try {
      state.tasks = (await api('/api/tasks')).tasks;
      render();
    } catch {}
    scheduleRefresh();
  }, 3000);
}

async function openCourse(key) {
  const [id, rid] = key.split('/');
  const pid = state.activePlatform;
  const data = await api('/api/platforms/' + encodeURIComponent(pid) + '/courses/' + encodeURIComponent(id) + '/' + encodeURIComponent(rid) + '/units');
  state.course = { ...data.course, platform_id: pid };
  state.units = data.units;
  state.selected = new Set();
  render();
}

document.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const dataset = target.dataset;
  try {
    if (target.id === 'setup-submit') {
      await api('/api/auth/setup', { method: 'POST', body: { setup_code: $('#setup-code').value, username: $('#setup-user').value, password: $('#setup-pass').value } });
      await loadAll();
    } else if (target.id === 'login-submit') {
      await api('/api/auth/login', { method: 'POST', body: { username: $('#login-user').value, password: $('#login-pass').value } });
      await loadAll();
    } else if (target.id === 'logout') {
      await api('/api/auth/logout', { method: 'POST' });
      state.me = null; state.platforms = []; state.tasks = []; state.courses = []; state.course = null;
      await loadAll();
    } else if (dataset.login) {
      state.activePlatform = dataset.login;
      const result = await api('/api/platforms/' + encodeURIComponent(dataset.login) + '/login', { method: 'POST' });
      state.loginChallenge = { ...result.challenge, platform: dataset.login, state: 'waiting' };
      render();
      pollChallenge(dataset.login, result.challenge.id);
    } else if (dataset.courses) {
      state.activePlatform = dataset.courses;
      state.courses = (await api('/api/platforms/' + encodeURIComponent(dataset.courses) + '/courses')).courses;
      state.course = null;
      render();
    } else if (dataset.disconnect) {
      await api('/api/platforms/' + encodeURIComponent(dataset.disconnect) + '/disconnect', { method: 'POST' });
      state.courses = []; state.course = null;
      await loadAll();
    } else if (dataset.course) {
      await openCourse(dataset.course);
    } else if (dataset.unit) {
      if (state.selected.has(dataset.unit)) state.selected.delete(dataset.unit); else state.selected.add(dataset.unit);
      render();
    } else if (target.id === 'study-submit') {
      const pid = state.course.platform_id;
      const path = '/api/platforms/' + encodeURIComponent(pid) + '/courses/' + encodeURIComponent(state.course.id) + '/' + encodeURIComponent(state.course.recruit_id) + '/study';
      await api(path, { method: 'POST', body: { unit_ids: [...state.selected] } });
      state.tasks = (await api('/api/tasks')).tasks;
      render();
    } else if (dataset.taskStop) {
      await api('/api/tasks/' + encodeURIComponent(dataset.taskStop) + '/stop', { method: 'POST' });
      state.tasks = (await api('/api/tasks')).tasks; render();
    } else if (dataset.taskResume) {
      await api('/api/tasks/' + encodeURIComponent(dataset.taskResume) + '/resume', { method: 'POST' });
      state.tasks = (await api('/api/tasks')).tasks; render();
    } else if (dataset.enable) {
      await api('/api/modules/' + encodeURIComponent(dataset.enable) + '/enable', { method: 'POST' });
      state.modules = (await api('/api/modules')).modules; render();
    } else if (dataset.disable) {
      await api('/api/modules/' + encodeURIComponent(dataset.disable) + '/disable', { method: 'POST' });
      state.modules = (await api('/api/modules')).modules; render();
    }
  } catch (error) {
    const box = $('#setup-error') || $('#login-error');
    if (box) box.textContent = error.message;
    else alert(error.message);
  }
});

async function pollChallenge(pid, id) {
  try {
    const result = await api('/api/platforms/' + encodeURIComponent(pid) + '/login/' + encodeURIComponent(id) + '/poll', { method: 'POST' });
    if (!state.loginChallenge) return;
    state.loginChallenge.state = result.state;
    render();
    if (result.state === 'connected') {
      state.loginChallenge = null;
      await loadAll();
      return;
    }
    if (result.state === 'expired' || result.state === 'failed') { state.loginChallenge = null; render(); return; }
    setTimeout(() => pollChallenge(pid, id), 2000);
  } catch (error) {
    state.loginChallenge = null;
    render();
    alert(error.message);
  }
}

loadAll().catch((error) => { $('#status').textContent = '加载失败：' + error.message; });
`;
