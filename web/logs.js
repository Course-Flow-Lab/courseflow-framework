import { esc, icon } from './views.js';

export function logsView(state) {
  const now = Date.now(), offset = 8 * 3600 * 1000;
  const local = (time) => new Date(time + offset).toISOString().slice(0, 16);
  const midnight = Math.floor((now + offset) / 86400000) * 86400000 - offset;
  const admin = state.me.user.role === 'admin';
  return `<header class="page-heading"><div><div class="eyebrow">运行与排查</div><h1>日志导出</h1><p class="muted">按北京时间选择范围，下载可用于排查问题的文本日志。</p></div></header><section class="panel feature-panel log-panel"><div class="section-heading"><h2>导出日志</h2><span class="tag">最长 92 天</span></div><form id="logs-form"><div class="log-range"><label>从（北京时间）<input type="datetime-local" name="from" value="${esc(local(midnight))}" required></label><label>到（北京时间）<input type="datetime-local" name="to" value="${esc(local(now + 60000))}" required></label><label>日志类型<select name="kind">${admin ? '<option value="app">运行日志</option><option value="audit">操作记录</option>' : ''}<option value="tasks">我的任务日志</option></select></label><button class="button primary" type="submit">${icon('download')}导出日志</button></div><p class="form-error" role="alert" hidden></p></form><div class="log-notes"><p>任务日志包含已有任务的执行、暂停、错误和播放器诊断记录，也可在任务详情单独导出。</p>${admin ? '<p>运行日志与操作记录从本版本开始保存；运行日志记录服务和模块消息，操作记录包含操作类型、时间与结果。</p>' : ''}<p class="muted">单次最多 20 MB；范围较大时请分段导出。</p></div></section>`;
}

export async function submitLogs(form, api, toast) {
  const data = new FormData(form);
  const from = Math.floor(Date.parse(data.get('from') + '+08:00') / 1000);
  const to = Math.ceil(Date.parse(data.get('to') + '+08:00') / 1000);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= 0 || from >= to || to - from > 92 * 86400) throw new Error('请选择正确的时间段，最长 92 天。');
  const result = await api('/api/logs/export?' + new URLSearchParams({ kind: data.get('kind'), from: String(from), to: String(to) }), { download: true });
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement('a');
  link.href = url; link.download = result.filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('日志已导出。');
}
