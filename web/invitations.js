import { dateText, empty, esc, icon } from './views.js';

export function invitationsView(state) {
  if (state.me.user.role !== 'admin') return empty('此页面仅管理员可用', '请联系管理员获取邀请码。', '<a class="button" href="#/courses">返回课程</a>', 'user');
  const data = state.invitationAdmin;
  const heading = `<header class="page-heading"><div><div class="eyebrow">工作台管理</div><h1>注册与邀请</h1><p class="muted">设置注册方式，为新成员生成邀请码。</p></div><button class="button" data-action="invitations-refresh">${icon('refresh')}刷新记录</button></header>`;
  if (state.loading || !data) return heading + '<div class="empty-state"><p class="muted">正在读取注册设置…</p></div>';
  const codes = state.generatedInvitations || [];
  return heading + `<div class="stats-strip invitation-stats">${[['可用邀请码', data.stats.available], ['已使用', data.stats.used], ['已撤销', data.stats.revoked]].map(([label, count]) => `<div><span class="stat-value">${count}</span><span>${label}</span></div>`).join('')}</div>
    <div class="feature-grid invitation-controls"><section class="panel feature-panel"><h2>注册方式</h2><form id="registration-form"><label class="check-label"><input name="invitation_required" type="checkbox"${data.settings.invitation_required ? ' checked' : ''}>新用户注册必须提供邀请码</label><p class="muted">关闭后，任何人都可以使用用户名和密码注册成员账号。</p><p class="form-error" role="alert" hidden></p><button type="submit" class="button primary">保存注册设置</button></form></section>
    <section class="panel feature-panel"><h2>生成邀请码</h2><p class="muted">每个邀请码可注册一个成员账号，使用后失效。</p><form id="invitation-generate-form"><label>生成数量<input name="count" type="number" min="1" max="100" step="1" value="5" required></label><p class="form-error" role="alert" hidden></p><button type="submit" class="button primary">生成邀请码</button></form></section></div>
    ${codes.length ? `<section class="panel feature-panel generated-invitations"><div class="section-heading"><div><h2>新生成的 ${codes.length} 个邀请码</h2><p class="muted">完整邀请码仅在生成后显示，请及时复制保存。</p></div><button class="button" data-action="invitations-copy">复制全部</button></div><label for="generated-invitation-codes" class="sr-only">本次生成的邀请码</label><textarea id="generated-invitation-codes" readonly spellcheck="false" rows="${Math.min(10, codes.length + 1)}">${esc(codes.join('\n'))}</textarea><button class="text-button" data-action="invitations-hide">已保存，隐藏完整邀请码</button></section>` : ''}
    <section class="panel feature-panel invitation-history"><div class="section-heading"><div><h2>邀请码记录</h2><p class="muted">共 ${data.stats.total} 条，显示最近 100 条。完整邀请码不重复显示。</p></div></div>
    ${data.invitations.length ? `<div class="invitation-list">${data.invitations.map((i) => `<article class="invitation-record"><div class="invitation-record-main"><code>${esc(i.code_hint)}</code><p class="muted">${dateText(i.created_at)} · ${esc(i.created_by)} 生成</p>${i.used_at !== null ? `<p class="muted">${esc(i.used_by || '成员')} 于 ${dateText(i.used_at)} 使用</p>` : i.revoked_at !== null ? `<p class="muted">${dateText(i.revoked_at)} 撤销</p>` : ''}</div><div class="actions"><span class="badge ${i.used_at !== null ? 'state-completed' : i.revoked_at !== null ? '' : 'state-running'}">${i.used_at !== null ? '已使用' : i.revoked_at !== null ? '已撤销' : '可用'}</span>${i.used_at === null && i.revoked_at === null ? `<button class="button small danger" data-action="invitation-revoke" data-id="${esc(i.id)}" aria-label="撤销邀请码 ${esc(i.code_hint)}">撤销</button>` : ''}</div></article>`).join('')}</div>` : '<p class="muted">还没有邀请码。生成后即可发送给新成员。</p>'}</section>`;
}

export async function loadInvitations(state, api, current = () => true) {
  const result = await api('/api/admin/registration');
  if (current()) state.invitationAdmin = result;
}

export const invitationFormIds = ['registration-form', 'invitation-generate-form'];

export async function submitInvitations(form, { state, api, renderPage, toast }) {
  const who = state.me;
  const current = () => state.me === who;
  if (form.id === 'registration-form') {
    const result = await api('/api/admin/registration', { method: 'POST', body: { invitation_required: form.elements.invitation_required.checked } });
    if (!current()) return;
    state.invitationAdmin.settings = result.settings;
    state.bootstrap.registration = result.settings;
    toast('注册设置已保存。');
  } else {
    const result = await api('/api/admin/invitations', { method: 'POST', body: { count: Number(form.elements.count.value) } });
    if (!current()) return;
    state.generatedInvitations = [...(state.generatedInvitations || []), ...result.codes];
    toast(`已生成 ${result.codes.length} 个邀请码，请复制保存。`);
  }
  if (current() && state.route.page === 'invitations') renderPage();
  try { await loadInvitations(state, api, current); }
  catch { if (current()) toast('操作已完成，记录刷新失败；请保存邀请码后刷新记录。'); }
  if (current() && state.route.page === 'invitations') renderPage();
}

export async function invitationAction(target, { state, api, renderPage, toast }) {
  const action = target.dataset.action;
  if (!['invitations-refresh', 'invitations-copy', 'invitations-hide', 'invitation-revoke'].includes(action)) return false;
  const who = state.me;
  const current = () => state.me === who;
  if (action === 'invitations-copy') {
    try { await navigator.clipboard.writeText(state.generatedInvitations.join('\n')); toast('邀请码已复制。'); }
    catch { document.querySelector('#generated-invitation-codes')?.select(); toast('请复制已选中的邀请码。'); }
  } else if (action === 'invitations-hide') {
    state.generatedInvitations = [];
    renderPage();
  } else {
    if (action === 'invitation-revoke') await api('/api/admin/invitations/' + encodeURIComponent(target.dataset.id) + '/revoke', { method: 'POST' });
    await loadInvitations(state, api, current);
    if (current() && state.route.page === 'invitations') renderPage();
    if (current() && action === 'invitation-revoke') toast('邀请码已撤销。');
  }
  return true;
}
