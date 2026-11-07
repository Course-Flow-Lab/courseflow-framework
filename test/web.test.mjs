import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, courseHref, coursePath } from '../web/api.js';
import { courseCards, courseView } from '../web/views.js';

test('course URLs preserve opaque identifiers, including slashes and Unicode', () => {
  const course = { id: '课程/1', recruit_id: 'term?1#2' };
  const href = courseHref('example', course);
  assert.deepEqual(parseRoute(href), { page: 'course', pid: 'example', id: course.id, rid: course.recruit_id });
  assert.equal(coursePath('example', course), '/api/platforms/example/courses/%E8%AF%BE%E7%A8%8B%2F1/term%3F1%232');
  assert.deepEqual(parseRoute('#/platform/%zz'), { page: 'not-found' });
});

test('module-provided text is escaped and progress stays within native progress bounds', () => {
  const html = courseCards([{
    id: 'id', recruit_id: 'rid', name: '<img src=x onerror=alert(1)>', kind: 'video', progress: 999,
    platform: { id: 'example', name: '<script>platform</script>' },
  }], 1);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('value="100"'));
  assert.ok(!html.includes('style='), 'CSP must not need inline progress styles');
});

test('unsupported contributed tabs remain disabled and completed units cannot be selected', () => {
  const html = courseView({
    loading: false, route: { pid: 'example' },
    course: { name: 'Course', outline_available: true, kind: 'shared' },
    platforms: [{ id: 'example', name: 'Platform', operations: ['study'] }],
    units: [{ id: 'done', name: 'Done', state: 'completed', selectable: true, kind: 'video' }],
    presentation: { tabs: [{ id: 'answer', label: '答题' }] }, selected: new Set(),
    bootstrap: { quiet_hours: { active: false }, capabilities: { jobs: ['study'] } },
  });
  assert.match(html, /disabled title="框架尚未接入此功能"/);
  assert.match(html, /data-unit="done" disabled/);
});
