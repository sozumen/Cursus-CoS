const test = require('node:test');
const assert = require('node:assert/strict');
const Z = require('../src/js/zenkit.js');
const { makeExport, NOW } = require('./zenkit.fixture.js');
const parsed = Z.parse(makeExport());
const build = (o) => Z.build(parsed, Object.assign({ boardId: 'B', now: NOW }, o));
const byTitle = (r, t) => r.tasks.find(x => x.title === t);

test('rejects files that are not Zenkit exports', () => {
  assert.throws(() => Z.parse({ foo: 1 }), /does not look like a Zenkit/);
  assert.throws(() => Z.parse(null), /does not look like a Zenkit/);
});

test('parse finds fields, counts and unmapped fields', () => {
  assert.equal(parsed.listName, 'Test list');
  assert.equal(parsed.counts.archived, 1);
  assert.equal(parsed.counts.live, parsed.entries.length - 1);
  assert.deepEqual(parsed.unmapped, ['Budget code']);
  assert.equal(parsed.hasWorkload, true);
  assert.equal(Z.stageRows(parsed, false).find(r => r.name === 'Done').count, 33);
  assert.equal(Z.stageRows(parsed, true).find(r => r.name === 'Done').count, 34);
  assert.equal(Z.stageRows(parsed, false).find(r => r.name === '(no stage)').count, 1);
  assert.deepEqual(Z.priorityRows(parsed, false).map(r => r.name + ':' + r.guess), ['High Importance:high']);
});

test('default stage and priority guesses', () => {
  const g = { 'To-Do': 'near-term', 'Major Project': 'long-term', 'Scheduled': 'scheduled', 'Up Next': 'up-next', 'In Progress': 'in-progress', 'On Hold': 'long-term',
    'Done': 'done', 'Await Reply': 'review', 'Idea for discussion': 'consider', 'Not started': 'near-term', 'Completed': 'done', 'Something odd': 'consider', 'Review': 'review' };
  for (const [name, col] of Object.entries(g)) assert.equal(Z.guessColumn(name), col, name);
  const p = { 'Critical': 'high', 'High Importance': 'high', 'Normal Importance': 'normal' && 'medium', 'Nice to have': 'low', 'Whatever': 'medium' };
  for (const [name, v] of Object.entries(p)) assert.equal(Z.guessPriority(name), v, name);
});

test('a task carries over its fields', () => {
  const t = byTitle(build(), 'Plan offsite');
  assert.equal(t.status, 'near-term'); assert.equal(t.priority, 'high'); assert.equal(t.due, '2026-11-01'); assert.equal(t.estimate, 90);
  assert.deepEqual(t.tags.sort(), ['@dana-lee', '@user-202', 'budget', 'recurring', 'to-do'].sort());
  assert.deepEqual(t.subitems.map(s => [s.title, s.done]), [['Book room', true], ['Order lunch', false]]);
  assert.ok(t.description.includes('Notes here') && t.description.includes('agenda.pdf (2 KB)'));
  assert.equal(t.source, 'zenkit'); assert.equal(t.external.id, 'plan'); assert.equal(t.locked, true); assert.equal(t.scheduledFlow, false);
  assert.equal(t.created, '2025-03-01T10:00:00.000Z'); assert.equal(t.boardId, 'B');
});

test('stages that have their own column are not tagged; folded stages keep a tag', () => {
  const r = build();
  assert.deepEqual(byTitle(r, 'Launch plan').tags, []);                              // In Progress -> In Progress
  assert.ok(byTitle(r, 'Parked item').tags.includes('on-hold') && byTitle(r, 'Parked item').status === 'long-term');
  assert.ok(byTitle(r, 'Big thing').tags.includes('major-project'));
  assert.ok(byTitle(r, 'Waiting on Sam').tags.includes('await-reply') && byTitle(r, 'Waiting on Sam').status === 'review');
  assert.ok(byTitle(r, 'Rethink pricing').tags.includes('idea-for-discussion') && byTitle(r, 'Rethink pricing').status === 'consider');
  assert.equal(byTitle(r, 'No stage here').status, 'consider');
  const off = build({ keepStageTag: false });
  assert.ok(!byTitle(off, 'Parked item').tags.includes('on-hold'));
});

test('the stage mapping can be changed', () => {
  const r = build({ stageMap: { 'on hold': 'review', 'to-do': 'up-next' }, priorityMap: { 'high importance': 'low' } });
  assert.equal(byTitle(r, 'Parked item').status, 'review');
  assert.equal(byTitle(r, 'Plan offsite').status, 'up-next');
  assert.equal(byTitle(r, 'Plan offsite').priority, 'low');
  assert.equal(build({ workloadUnit: 'minutes' }).tasks.find(t => t.title === 'Plan offsite').estimate, 2);   // 1.5 minutes, rounded
});

test('Scheduled tasks stay under automation; dates and ranges', () => {
  const r = build();
  const s = byTitle(r, 'Ship it');
  assert.equal(s.scheduledFlow, true); assert.equal(s.locked, false); assert.equal(s.start, '2026-11-05'); assert.equal(s.due, '2026-11-10');
  const range = byTitle(r, 'Date range');
  assert.equal(range.start, '2026-12-01'); assert.equal(range.due, '2026-12-05');
});

test('subtasks become linked tasks in checklist-then-path order; dependencies are mapped', () => {
  const r = build();
  const parent = byTitle(r, 'Launch plan'), a = byTitle(r, 'Design hero'), b = byTitle(r, 'Write copy');
  assert.equal(a.parentId, parent.id); assert.equal(b.parentId, parent.id);
  assert.deepEqual(parent.subitems.map(s => [s.title, s.taskId]), [['Design hero', a.id], ['Write copy', b.id]]);
  assert.equal(r.stats.subtasks, 2);
  assert.deepEqual(byTitle(r, 'Ship it').deps, [parent.id]);
  assert.equal(byTitle(r, 'Missing dependency').deps.length, 0); assert.equal(r.stats.droppedDependencies, 1);
});

test('re-importing skips tasks that already exist and still links to them', () => {
  const existing = new Map([['parent1', 'OLD-PARENT']]);
  const r = build({ existing });
  assert.equal(r.stats.skippedExisting, 1);
  assert.ok(!byTitle(r, 'Launch plan'));
  assert.equal(byTitle(r, 'Write copy').parentId, 'OLD-PARENT');
  assert.deepEqual(byTitle(r, 'Ship it').deps, ['OLD-PARENT']);
});

test('Done tasks: bulk-edit day is ignored, old ones go to the archive, recent ones stay', () => {
  const r = build();
  assert.deepEqual(r.stats.bulkEdit, { day: '2026-10-16', count: 30 });
  const bulk = r.tasks.filter(t => t.title.startsWith('Bulk done'));
  assert.equal(bulk.length, 30);
  const withDue = bulk.filter(t => /^Bulk done [012]$/.test(t.title)), noDate = bulk.filter(t => !/^Bulk done [012]$/.test(t.title));
  assert.ok(noDate.every(t => t.archived), 'Done tasks with no usable date are judged by creation date and archived');
  assert.ok(withDue.every(t => !t.archived && new Date(t.doneAt).getDate() === 14), 'a due date 3 days ago counts as the finish date');
  assert.equal(byTitle(r, 'Finished recently').archived, false);
  assert.equal(byTitle(r, 'Finished recently').doneAt, '2026-10-12T10:00:00.000Z');
  assert.equal(byTitle(r, 'Finished two days ago').archived, false);
  assert.equal(byTitle(r, 'Design hero').status, 'done');
  const keep = build({ archiveDoneDays: 0 });
  assert.equal(keep.tasks.filter(t => t.archived).length, 0);
  assert.equal(r.stats.archivedOnImport, 27); assert.equal(r.stats.active, r.tasks.length - 27);
});

test('Done column is ordered newest first; other columns keep the Zenkit order', () => {
  const r = build({ archiveDoneDays: 0 });
  const done = r.tasks.filter(t => t.status === 'done').sort((a, b) => a.order - b.order);
  for (let i = 1; i < done.length; i++) assert.ok(Date.parse(done[i - 1].doneAt) >= Date.parse(done[i].doneAt));
  const nt = r.tasks.filter(t => t.status === 'near-term').sort((a, b) => a.order - b.order).map(t => t.title);
  assert.deepEqual(nt.slice(0, 2), ['Plan offsite', 'Write copy']);
});

test('tasks archived or deleted in Zenkit only come in when asked, and arrive archived', () => {
  assert.ok(!byTitle(build(), 'Archived in Zenkit'));
  const r = build({ includeArchived: true });
  const t = byTitle(r, 'Archived in Zenkit');
  assert.equal(t.archived, true); assert.equal(t.archivedAt, '2026-05-05T00:00:00.000Z');
});

test('long titles, html notes and warnings', () => {
  const r = build();
  const long = r.tasks.find(t => t.title.endsWith('...'));
  assert.equal(long.title.length, 200); assert.ok(long.description.includes('Full title: ' + 'x'.repeat(250)));
  assert.equal(byTitle(r, 'Html notes').description, 'Hello world\nSecond & last');
  const w = r.warnings.join(' | ');
  for (const bit of ['bulk change', 'recurring', 'attachments', 'comments', 'Dependencies', 'longer than 200', 'Budget code']) assert.ok(w.includes(bit), bit);
});
