import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute } from '../web/api.js';
import { accountView, authView, navigation } from '../web/views.js';
import { invitationsView, submitInvitations } from '../web/invitations.js';

function adminState() {
  return {
    me: { user: { id: 'synthetic-admin', username: 'preview', role: 'admin' } },
    platforms: [], tasks: [], route: { page: 'invitations' }, bootstrap: {}, generatedInvitations: [],
    invitationAdmin: { settings: { invitation_required: true }, stats: { total: 0, available: 0, used: 0, revoked: 0 }, invitations: [] },
  };
}

test('注册表单随策略调整必填项，首次初始化不暴露注册切换入口', () => {
  const bootstrap = { setup_required: false, registration: { invitation_required: true } };
  assert.deepEqual(parseRoute('#/register'), { page: 'register' });
  const required = authView(bootstrap, 'register');
  assert.match(required, /name="invitation_code"[^>]* required/);
  assert.match(required, /name="password_confirmation"/);
  assert.match(required, /autocomplete="new-password"/);
  const optional = authView({ ...bootstrap, registration: { invitation_required: false } }, 'register');
  assert.doesNotMatch(optional, /name="invitation_code"[^>]* required/);
  assert.match(optional, /邀请码（选填）/);
  assert.match(authView(bootstrap), /href="#\/register"/);
  const setup = authView({ setup_required: true }, 'register');
  assert.match(setup, /name="setup_code"/);
  assert.doesNotMatch(setup, /href="#\/register"|name="invitation_code"/);
});

test('管理员可从桌面与手机账号页进入邀请管理，成员不显示管理入口或数据', () => {
  const state = adminState();
  assert.match(navigation(state), /href="#\/invitations"/);
  assert.match(accountView(state), /href="#\/invitations"/);
  state.invitationAdmin.invitations = [{ id: 'synthetic-id', code_hint: '<unsafe-code>', created_by: '<unsafe-user>', created_at: 1, used_by: null, used_at: null, revoked_at: null }];
  const html = invitationsView(state);
  assert.match(html, /&lt;unsafe-code&gt;/); assert.match(html, /&lt;unsafe-user&gt;/);
  assert.doesNotMatch(html, /<unsafe/);
  state.me.user.role = 'user';
  assert.doesNotMatch(navigation(state), /href="#\/invitations"/);
  assert.doesNotMatch(accountView(state), /href="#\/invitations"/);
  assert.doesNotMatch(invitationsView(state), /unsafe|registration-form|invitation-generate-form/);
});

test('生成成功后即使记录刷新失败，完整邀请码仍可见，避免一次性返回内容丢失', async () => {
  const state = adminState();
  const code = '12345-ABCDE-67890-FGHIJ-KLMNO';
  let renders = 0;
  const form = { id: 'invitation-generate-form', elements: { count: { value: '1' } } };
  await submitInvitations(form, {
    state,
    api: async (_path, options) => { if (options?.method === 'POST') return { codes: [code] }; throw new Error('synthetic-network-failure'); },
    renderPage: () => { renders += 1; assert.match(invitationsView(state), new RegExp(code)); }, toast: () => {},
  });
  assert.deepEqual(state.generatedInvitations, [code]); assert.ok(renders > 0);
});

test('生成请求返回前用户退出登录时，不将完整邀请码写入下一位用户的界面状态', async () => {
  const state = adminState();
  const form = { id: 'invitation-generate-form', elements: { count: { value: '1' } } };
  await submitInvitations(form, {
    state,
    api: async () => { state.me = null; return { codes: ['12345-ABCDE-67890-FGHIJ-KLMNO'] }; },
    renderPage: () => assert.fail('已退出，不应刷新邀请页面'), toast: () => assert.fail('已退出，不应显示邀请码提示'),
  });
  assert.deepEqual(state.generatedInvitations, []);
});
