import { coursePath } from './api.js';
import { esc, icon } from './views.js';

const numeric = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const format = value => numeric(value) == null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value));
const routeKey = state => JSON.stringify([state.route.pid, state.course?.id, state.course?.recruit_id, state.route.tab]);

export async function loadScore(state, api, current, render = () => {}) {
  const sections = state.presentation?.score_sections?.length ? state.presentation.score_sections : [{ id: '', label: '课程成绩' }];
  const feature = state.feature = { tab: 'score', data: {}, sections: sections.map(section => ({ ...section, loading: true, data: null, error: '' })) };
  const key = routeKey(state);
  const active = () => current() && state.feature === feature && routeKey(state) === key;
  render();
  await Promise.all(feature.sections.map(section => fillSection(state, api, feature, section, active, render)));
}

async function fillSection(state, api, feature, section, active, render) {
  section.loading = true; section.error = '';
  try {
    const data = await api(coursePath(state.route.pid, state.course) + '/catalog/score' + (section.id ? '?part=' + encodeURIComponent(section.id) : ''));
    if (!active()) return;
    section.data = data; section.updatedAt = Date.now();
  } catch (error) { if (active()) section.error = error.message; }
  finally { if (active()) { section.loading = false; render(); } }
}

export async function scoreAction(target, { state, api, renderPage }) {
  if (target.dataset.action !== 'score-refresh' || state.feature?.tab !== 'score') return false;
  const feature = state.feature, key = routeKey(state);
  const active = () => state.feature === feature && routeKey(state) === key;
  const sections = target.dataset.part ? feature.sections.filter(section => section.id === target.dataset.part) : feature.sections;
  for (const section of sections) { section.loading = true; section.error = ''; }
  renderPage();
  await Promise.all(sections.map(section => fillSection(state, api, feature, section, active, renderPage)));
  return true;
}

function metricView(metric, index) {
  const value = numeric(metric.value), max = numeric(metric.max);
  const unit = typeof metric.unit === 'string' ? metric.unit : '';
  const progress = value != null && max != null && max > 0 ? Math.max(0, Math.min(100, value / max * 100)) : null;
  return `<article class="score-metric${index === 0 ? ' leading' : ''}"><div class="score-metric-top"><span>${esc(metric.label)}</span>${value == null ? '<span class="score-unavailable">待平台提供</span>' : ''}</div><div class="score-value"><strong>${format(value)}</strong><span>${esc(unit)}${max != null && max > 0 ? ` / ${format(max)} ${esc(unit)}` : ''}</span></div>${progress == null ? '' : `<progress max="100" value="${progress}" aria-label="${esc(metric.label)}进度"></progress>`}${metric.detail ? `<p class="muted">${esc(metric.detail)}</p>` : ''}</article>`;
}

function fallbackMetrics(data) {
  const fields = [['总评成绩', data?.scores?.totalScore], ['平时成绩', data?.scores?.usualScore], ['视频学习', data?.scores?.courseScore], ['学习习惯', data?.habit], ['课程互动', data?.interactive]];
  return fields.map(([label, value]) => ({ label, value, unit: '分' }));
}

function sectionView(section) {
  const data = section.data, metrics = data?.metrics || fallbackMetrics(data);
  const loading = section.loading && !data;
  return `<section class="panel score-section score-${esc(section.id || 'overview')}"><header class="score-section-heading"><div><span class="eyebrow">${section.loading ? '正在同步' : section.error ? '需要重试' : '平台数据'}</span><h2>${esc(data?.title || section.label)}</h2></div><button class="icon-button" data-action="score-refresh" data-part="${esc(section.id)}" aria-label="刷新${esc(section.label)}"${section.loading ? ' disabled' : ''}>${icon('refresh')}</button></header>${loading ? '<div class="score-skeleton" role="status"><span class="spinner"></span><p>正在读取这个分区…</p></div>' : ''}${section.error ? `<div class="banner score-error" role="alert">${esc(section.error)}<button class="text-button" data-action="score-refresh" data-part="${esc(section.id)}">重试此区</button></div>` : ''}${data ? `<p class="score-description muted">${esc(data.description || '以下为平台确认的数据，未提供的项目不作估算。')}</p><div class="score-metrics">${metrics.map(metricView).join('')}</div>${data.note ? `<p class="score-note">${esc(data.note)}</p>` : ''}<footer class="score-section-footer">同步于 ${new Date(section.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}${section.loading ? ' · 正在刷新' : ''}</footer>` : ''}</section>`;
}

export function scoreView(state) {
  const root = coursePath(state.route.pid, state.course);
  const sections = state.feature?.sections || [];
  const settled = sections.filter(section => !section.loading).length;
  return `<div class="section-heading score-page-heading"><div><div class="eyebrow">学习表现</div><h2>我的成绩</h2><p class="muted">成绩、习惯与互动分开查看，各区域独立同步。${settled} / ${sections.length} 个分区已返回。</p></div><div class="actions"><button class="button" data-action="score-refresh">${icon('refresh')}刷新全部</button><a class="button small" href="${root}/scores/export?format=json" download>导出 JSON</a><a class="button small" href="${root}/scores/export?format=csv" download>导出 CSV</a></div></div><div class="score-dashboard">${sections.map(sectionView).join('')}</div>`;
}
