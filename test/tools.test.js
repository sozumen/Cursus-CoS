const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/js/core.js');
const T = require('../src/js/tools.js');
const { newTask, newBoard } = core;

const mk = (o = {}) => newTask(Object.assign({ boardId: 'b1', title: 'Task', order: 0 }, o));

test('boards come out complete: views, field order, hidden fields, custom fields', () => {
  const b = core.normalizeBoard({ id: 'x', name: 'X', h: 1, fields: { order: ['tags', 'nope', 'cf:c1'], hidden: ['stage', 'tags', 'ghost'], custom: [{ id: 'c1', name: 'Team', type: 'label', options: [{ id: 'o1', name: 'A' }] }, { id: 'c2', name: 'Bad', type: 'weird' }] } });
  assert.deepEqual(b.views.map(v => v.type), ['kanban', 'list', 'table', 'calendar']);
  assert.equal(b.fields.order[0], 'tags'); assert.ok(b.fields.order.includes('cf:c2') && b.fields.order.includes('stage') && !b.fields.order.includes('nope'));
  assert.deepEqual(b.fields.hidden, ['tags'], 'stage can never be hidden, unknown ids are dropped');
  assert.equal(b.fields.custom[1].type, 'text');
  const again = core.normalizeBoard(JSON.parse(JSON.stringify(b)));
  assert.deepEqual(again, b, 'normalizing twice changes nothing');
  assert.deepEqual(newBoard().views.map(v => v.id), ['v-kanban', 'v-list', 'v-table', 'v-calendar']);
});

test('a task from an older version gets the new fields', () => {
  const t = core.normalize({ boards: [{ id: 'b', name: 'B', h: 1 }], tasks: [{ id: 't', boardId: 'b', title: 'Old' }] }).tasks[0];
  assert.deepEqual([t.assignees, t.attachments, t.comments, t.custom, t.prevStatus], [[], [], [], {}, '']);
});

const ctx = { today: '2026-10-17', projects: [{ id: 'p1', name: 'Alpha', h: 10 }], boards: [{ id: 'b1', name: 'One', h: 5, members: [{ name: 'Ann' }] }], fields: [{ id: 'f1', name: 'Team', type: 'label', options: [{ id: 'o1', name: 'Red', h: 4 }] }, { id: 'f2', name: 'Urgent', type: 'check' }] };
test('grouping: every task lands in exactly one group, for every grouping', () => {
  const tasks = [mk({ status: 'done', priority: 'high', projectId: 'p1', assignees: ['Ann', 'Bob'], due: '2026-10-01', custom: { f1: 'o1', f2: true } }), mk({ due: '2026-10-17' }), mk({ due: '2026-10-20' }), mk({ due: '2026-12-01' }), mk({ assignees: ['Zed'] }), mk({ due: '2026-10-10' })];
  ctx.tasks = tasks;
  for (const g of ['status', 'priority', 'project', 'assignee', 'due', 'board', 'cf:f1', 'cf:f2', 'bogus']){
    const d = T.groupDefs(g, ctx), ids = new Set(d.groups.map(x => x.id));
    for (const t of tasks) assert.ok(ids.has(d.keyOf(t)), `${g}: ${JSON.stringify(d.keyOf(t))} has a group`);
  }
  const due = T.groupDefs('due', ctx);
  assert.deepEqual(tasks.map(t => due.keyOf(t)), ['today', 'today', 'week', 'later', 'none', 'overdue'], 'done tasks are not overdue');
  assert.equal(due.editable, false);
  const asg = T.groupDefs('assignee', ctx);
  assert.deepEqual(asg.groups.map(g => g.name), ['Unassigned', 'Ann', 'Bob', 'Zed'], 'members first, then anyone assigned');
  assert.equal(asg.keyOf(tasks[0]), 'Ann', 'first assignee decides the group');
  assert.deepEqual(T.groupOptions(ctx.fields, { allowNone: true }).map(o => o[0]), ['', 'status', 'priority', 'project', 'assignee', 'due', 'board', 'cf:f1', 'cf:f2']);
});

test('sorting: dates and empty values go last in either direction', () => {
  const a = mk({ title: 'b', due: '2026-10-05', order: 1 }), b = mk({ title: 'a', due: '', order: 2 }), c = mk({ title: 'c', due: '2026-10-01', order: 3 });
  const names = l => l.map(t => t.title).join('');
  assert.equal(names(T.sortTasks([a, b, c], 'due', 1)), 'cba');      // c (Oct 1), b (Oct 5), then the undated task
  assert.equal(names(T.sortTasks([a, b, c], 'due', -1)), 'bca');     // latest first, undated still last
  assert.equal(names(T.sortTasks([a, b, c], 'title', 1)), 'abc'.replace('abc', 'abc'));
  assert.equal(names(T.sortTasks([c, b, a], 'manual', 1)), 'bac');   // by order 1, 2, 3 -> titles b, a, c
  const hi = mk({ priority: 'high', title: 'hi' }), lo = mk({ priority: 'low', title: 'lo' });
  assert.equal(T.sortTasks([lo, hi], 'priority', 1)[0].title, 'hi');
});

test('rules: triggers, conditions, actions, and no-ops', () => {
  const rules = [
    { id: 'r1', name: 'Done cleanup', on: true, trigger: { type: 'moved', value: 'done' }, actions: [{ type: 'removeTag', value: 'urgent' }, { type: 'flag', value: '' }, { type: 'dueClear' }] },
    { id: 'r2', name: 'High goes next', on: true, trigger: { type: 'created' }, cond: { priority: 'high' }, actions: [{ type: 'move', value: 'up-next' }, { type: 'addTag', value: 'Hot' }, { type: 'assign', value: 'Ann' }] },
    { id: 'r3', name: 'Off', on: false, trigger: { type: 'created' }, actions: [{ type: 'priority', value: 'low' }] },
    { id: 'r4', name: 'Overdue bump', on: true, trigger: { type: 'overdue' }, actions: [{ type: 'priority', value: 'high' }, { type: 'archive' }, { type: 'due', value: 3 }] }
  ];
  const t = mk({ priority: 'high', tags: ['urgent'], flag: 'red', due: '2026-10-01', status: 'done' });
  let r = T.applyRules(rules, { type: 'moved', value: 'done' }, t, { today: '2026-10-17' });
  assert.deepEqual(r.names, ['Done cleanup']); assert.deepEqual([t.tags, t.flag, t.due], [[], '', '']);
  r = T.applyRules(rules, { type: 'moved', value: 'done' }, t, { today: '2026-10-17' });
  assert.deepEqual(r.names, [], 'second run changes nothing, so nothing is reported');
  const n = mk({ priority: 'high' });
  r = T.applyRules(rules, { type: 'created' }, n, { today: '2026-10-17' });
  assert.equal(r.status, 'up-next'); assert.deepEqual([n.tags, n.assignees, n.priority], [['hot'], ['Ann'], 'high']);
  const low = mk({ priority: 'low' });
  assert.equal(T.applyRules(rules, { type: 'created' }, low, {}).names.length, 0, 'condition not met; disabled rule ignored');
  const od = mk({ due: '2026-10-10' }), fired = {};
  r = T.applyRules(rules, { type: 'overdue' }, od, { today: '2026-10-17', fired });
  assert.equal(r.archive, true); assert.deepEqual([od.priority, od.due], ['high', '2026-10-20']);
  assert.equal(T.applyRules(rules, { type: 'overdue' }, od, { today: '2026-10-17', fired }).names.length, 0, 'an overdue rule runs once per task per day');
  assert.equal(T.applyRules(rules, { type: 'overdue' }, od, { today: '2026-10-18', fired }).names.length, 1, 'and again the next day');
});

test('activity feed merges log lines and comments, newest first', () => {
  const a = mk({ title: 'A' }); a.log = [{ at: '2026-10-01T10:00:00Z', text: 'Created' }]; a.comments = [{ id: '1', at: '2026-10-03T10:00:00Z', by: 'Ann', text: 'Looks good' }];
  const b = mk({ title: 'B' }); b.log = [{ at: '2026-10-02T10:00:00Z', text: 'Updated' }];
  const f = T.boardActivity([a, b]);
  assert.deepEqual(f.map(x => x.text), ['Looks good', 'Updated', 'Created']); assert.equal(f[0].kind, 'comment'); assert.equal(T.boardActivity([a, b], 1).length, 1);
});

test('CSV: quoting, delimiters and round trip', () => {
  const txt = T.toCSV([['a', 'b,c', 'say "hi"', 'line\nbreak']]);
  assert.deepEqual(T.parseCSV(txt)[0], ['a', 'b,c', 'say "hi"', 'line\nbreak']);
  assert.deepEqual(T.parseCSV('x;y\r\n1;2\r\n'), [['x', 'y'], ['1', '2']], 'semicolons from European Excel');
  assert.deepEqual(T.parseCSV('x\ty\n1\t2'), [['x', 'y'], ['1', '2']]);
  assert.deepEqual(T.parseCSV('﻿a,b\n\n,\n1,2'), [['a', 'b'], ['1', '2']], 'BOM, blank lines');
  const board = core.normalizeBoard({ id: 'b1', name: 'B', h: 1, fields: { custom: [{ id: 'f1', name: 'Team', type: 'label', options: [{ id: 'o1', name: 'Red' }] }, { id: 'f2', name: 'Urgent', type: 'check' }] } });
  const tasks = [mk({ title: 'Plan, then "do"', description: 'two\nlines', status: 'in-progress', priority: 'high', start: '2026-10-01', due: '2026-10-09', estimate: 90, tags: ['a', 'b'], assignees: ['Ann'], projectId: 'p1', custom: { f1: 'o1', f2: true }, subitems: [{ id: 's', title: 'x', done: false, taskId: null }] }), mk({ title: 'Plain' })];
  const csv = T.tasksToCSV(tasks, { boards: [board], projects: [{ id: 'p1', name: 'Alpha' }], fields: board.fields.custom });
  const back = T.csvToTasks(csv, { board, projects: [{ id: 'p1', name: 'Alpha' }] });
  assert.equal(back.tasks.length, 2); assert.equal(back.newProjects.length, 0, 'existing project is reused by name');
  const t = back.tasks[0];
  assert.deepEqual([t.title, t.description, t.status, t.priority, t.start, t.due, t.estimate, t.tags, t.assignees, t.projectId], ['Plan, then "do"', 'two\nlines', 'in-progress', 'high', '2026-10-01', '2026-10-09', 90, ['a', 'b'], ['Ann'], 'p1']);
  assert.deepEqual([t.custom.f1, t.custom.f2, t.subitems.length], ['o1', true, 1]);
  assert.equal(back.tasks[1].priority, 'medium');
});

test('CSV import from a spreadsheet with its own headings', () => {
  const csv = 'Task,Status,Priority,Deadline,Done,Project\r\nCall vendor,Waiting on reply,Urgent,3/9/2027,,Vendors\r\nFile taxes,,Low,2027-04-15,yes,Vendors\r\n,Open,,,,\r\n,,,,,\r\n';
  const r = T.csvToTasks(csv, { board: { id: 'b1' }, projects: [] });
  assert.equal(r.tasks.length, 2); assert.equal(r.stats.skipped, 1);
  assert.deepEqual(r.tasks.map(t => [t.status, t.priority, t.due]), [['review', 'high', '2027-03-09'], ['done', 'low', '2027-04-15']]);
  assert.equal(r.newProjects.length, 1); assert.equal(r.tasks[0].projectId, r.tasks[1].projectId);
  assert.ok(T.csvToTasks('Name\r\n', {}).warnings.length, 'header-only file is explained');
  assert.match(T.csvToTasks('foo,bar\r\n1,2', { board: { id: 'b' } }).warnings[0], /first column/);
  assert.equal(T.looseDate('12/31/26'), '2026-12-31'); assert.equal(T.looseDate('2026-10-05T00:00:00Z'), '2026-10-05'); assert.equal(T.looseDate('nonsense'), '');
});

test('calendar file: all-day events, ranges, escaping, folding, skips done and undated', () => {
  const tasks = [mk({ id: 'a', title: 'Ship; it, now', start: '2026-10-05', due: '2026-10-07', tags: ['x', 'y'], description: 'line1\nline2' }), mk({ id: 'b', title: 'Due only', due: '2026-10-09' }), mk({ id: 'c', title: 'No date' }), mk({ id: 'd', title: 'Finished', due: '2026-10-01', status: 'done' }), mk({ id: 'e', title: 'x'.repeat(200), due: '2026-10-02' })];
  const { text, count } = T.toICS(tasks, { name: 'My, board', now: new Date('2026-10-17T12:00:00Z') });
  assert.equal(count, 3); assert.match(text, /^BEGIN:VCALENDAR\r\n/); assert.match(text, /END:VCALENDAR\r\n$/);
  assert.match(text, /UID:a@cursus-cos/); assert.match(text, /DTSTART;VALUE=DATE:20261005\r\nDTEND;VALUE=DATE:20261008/, 'range ends the day after the due date');
  assert.match(text, /DTSTART;VALUE=DATE:20261009\r\nDTEND;VALUE=DATE:20261010/);
  assert.match(text, /SUMMARY:Ship\\; it\\, now/); assert.match(text, /X-WR-CALNAME:My\\, board/); assert.match(text, /CATEGORIES:x,y/); assert.match(text, /line1\\nline2/);
  assert.ok(!/No date|Finished/.test(text));
  for (const l of text.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, 'folded to 75 bytes: ' + l.length);
  assert.match(T.toICS(tasks, { includeDone: true }).text, /STATUS:COMPLETED/);
});

test('print and email text escape content and stay short', () => {
  const tasks = [mk({ title: '<b>Bold</b> & co', status: 'done', due: '2026-10-09', subitems: [{ id: 's', title: 'Sub <i>', done: true, taskId: null }] }), mk({ title: 'Open one', status: 'near-term' })];
  const tbl = T.printHTML(tasks, 'table', { title: 'My <board>' }), list = T.printHTML(tasks, 'list', { title: 'My board' });
  assert.ok(!tbl.includes('<b>Bold') && tbl.includes('&lt;b&gt;Bold') && tbl.includes('My &lt;board&gt;'));
  assert.match(list, /&#9745;/); assert.match(list, /Near-Term/); assert.ok(!list.includes('<i>Sub'));
  const many = Array.from({ length: 400 }, (_, i) => mk({ title: 'Task number ' + i }));
  const body = T.mailBody(many, { title: 'Big' }, 1500);
  assert.ok(body.length < 1700 && /and more/.test(body)); assert.ok(!/and more/.test(T.mailBody(tasks, { title: 'S' })));
});

/* ---------- per-board stages ---------- */
test('stages: grouping merges boards by stage name, keeps order, and flags the completed column', () => {
  const A = core.newBoard({ id:'a', stages:[{ id:'a1', name:'Backlog' }, { id:'a2', name:'Doing' }, { id:'a3', name:'Shipped', done:true }] });
  const B = core.newBoard({ id:'b', stages:[{ id:'b1', name:'backlog' }, { id:'b2', name:'Review' }, { id:'b3', name:'Done', done:true }] });
  const U = T.unionStages([A, B]);
  assert.deepEqual(U.map(x => x.name), ['Backlog', 'Doing', 'Shipped', 'Review', 'Done']);
  const d = T.groupDefs('status', { boards:[A, B], projects:[], tasks:[], fields:[] });
  assert.deepEqual(d.groups.map(g => g.id), ['backlog', 'doing', 'shipped', 'review', 'done']);
  assert.deepEqual(d.groups.filter(g => g.done).map(g => g.id), ['shipped', 'done']);
  const ta = core.newTask({ boardId:'a', status:'a1' }), tb = core.newTask({ boardId:'b', status:'b1' });
  assert.equal(d.keyOf(ta), 'backlog'); assert.equal(d.keyOf(tb), 'backlog', 'same-named stages share a column');
  assert.equal(T.stageIdByKey(B, 'backlog'), 'b1'); assert.equal(T.stageIdByKey(B, 'doing'), null);
  assert.equal(T.stageName(ta, [A, B]), 'Backlog');
  // a standard board still yields the standard eight, with the same ids as before
  const std = T.groupDefs('status', { boards:[core.newBoard({ id:'s' })], projects:[], tasks:[], fields:[] });
  assert.deepEqual(std.groups.map(g => g.id), core.COLS.map(c => c.id));
});

test('stages: rules move only to stages the board has; CSV and ICS use the board stage names', () => {
  const stages = [{ id:'x1', name:'Inbox' }, { id:'x2', name:'Finished', done:true }];
  const t = core.newTask({ boardId:'b', status:'x1' });
  const r = T.applyRules([{ id:'r', name:'R', trigger:{ type:'priority', value:'high' }, actions:[{ type:'move', value:'x2' }] }], { type:'priority', value:'high' }, t, { stages });
  assert.equal(r.status, 'x2'); assert.match(r.notes[0], /Finished/);
  const none = T.applyRules([{ id:'r', name:'R', trigger:{ type:'priority', value:'high' }, actions:[{ type:'move', value:'review' }] }], { type:'priority', value:'high' }, t, { stages });
  assert.equal(none.status, null, 'review does not exist on this board');
  const b = core.newBoard({ id:'b', stages });
  const csv = T.tasksToCSV([t], { boards:[b], projects:[] });
  assert.match(csv, /Inbox/);
  const imp = T.csvToTasks('Title,Stage\nA,Finished\nB,inbox\nC,done\nD,whatever', { board:b, projects:[] });
  assert.deepEqual(imp.tasks.map(x => x.status), ['x2', 'x1', 'x2', 'x1']);
  const ics = T.toICS([Object.assign(t, { due:'2026-03-01', status:'x2' })], { boards:[b], includeDone:true });
  assert.match(ics.text, /Stage: Finished/); assert.match(ics.text, /STATUS:COMPLETED/);
  assert.match(T.printHTML([t], 'list', { title:'x', boards:[b] }), /Finished/);
  assert.match(T.mailBody([t], { title:'x', boards:[b] }), /Finished/);
  assert.equal(T.guessStage('weird', stages), 'x1'); assert.equal(T.guessStage('closed', stages), 'x2');
});

test('date rules: a start or due rule fires once per date, from the offset on, for the stage it names', () => {
  const stages = core.defaultStages();
  const rule = { id: 'r1', name: 'Begin', on: true, trigger: { type: 'start', value: '0' }, cond: { stage: 'scheduled' }, actions: [{ type: 'move', value: 'in-progress' }] };
  const t = core.newTask({ id: 't', status: 'scheduled', start: '2026-10-20' });
  const ev = days => ({ type: 'start', date: '2026-10-20', days });
  assert.equal(T.applyRules([rule], ev(-1), t, { stages }).status, null, 'the day before: not yet');
  assert.equal(t.fired.r1, undefined);
  assert.equal(T.applyRules([rule], ev(0), t, { stages }).status, 'in-progress');
  assert.equal(t.fired.r1, '2026-10-20');
  assert.equal(T.applyRules([rule], ev(3), t, { stages }).status, null, 'only once for that date');
  t.start = '2026-11-02'; assert.equal(T.applyRules([rule], { type: 'start', date: '2026-11-02', days: 0 }, t, { stages }).status, 'in-progress', 'a new date fires again');
  const elsewhere = core.newTask({ id: 'u', status: 'review', start: '2026-10-20' });
  assert.equal(T.applyRules([rule], ev(0), elsewhere, { stages }).status, null, 'a task already moved on is left alone');
  const before = { id: 'r2', trigger: { type: 'due', value: '-2' }, actions: [{ type: 'flag', value: 'red' }] };
  const d = core.newTask({ id: 'd', due: '2026-10-20' });
  assert.equal(T.applyRules([before], { type: 'due', date: '2026-10-20', days: -3 }, d, { stages }).names.length, 0);
  assert.equal(T.applyRules([before], { type: 'due', date: '2026-10-20', days: -2 }, d, { stages }).names.length, 1); assert.equal(d.flag, 'red');
});
test('importance in rules, groups, sorting, CSV and print', () => {
  const stages = core.defaultStages();
  const t = core.newTask({ id: 'a', importance: 4 });
  const r = { id: 'r', name: 'Bump', trigger: { type: 'priority', value: '8+' }, cond: { priority: '4-7' }, actions: [{ type: 'priority', value: '10' }] };
  assert.equal(T.applyRules([r], { type: 'priority', value: 5 }, t, { stages }).names.length, 0, 'below the trigger');
  assert.equal(T.applyRules([r], { type: 'priority', value: 9 }, t, { stages }).names.length, 1); assert.equal(t.importance, 10); assert.equal(t.priority, 'high');
  const g = T.groupDefs('priority', {}); assert.equal(g.groups.length, 10); assert.equal(g.groups[0].id, '10'); assert.equal(g.groups[9].id, '1'); assert.equal(g.keyOf(t), '10');
  const hi = core.newTask({ id: 'h', importance: 9 }), lo = core.newTask({ id: 'l', importance: 2 }), mid = core.newTask({ id: 'm', importance: 5 });
  assert.deepEqual(T.sortTasks([lo, mid, hi], 'priority', 1).map(x => x.id), ['h', 'm', 'l']);
  const csv = T.tasksToCSV([hi], { boards: [core.newBoard({ id: 'b' })], projects: [] }); assert.match(csv, /Importance/); assert.match(csv.split('\r\n')[1], /,9,/);
  assert.equal(T.guessImportance('7'), 7); assert.equal(T.guessImportance('High'), 8); assert.equal(T.guessImportance('low'), 3); assert.equal(T.guessImportance(''), 5); assert.equal(T.guessImportance('7/10'), 7);
});

test('paste lines: bullets, numbers and check boxes are dropped, ticks mean done, #words are tags, indents are subtasks', () => {
  const r = T.parseTaskLines('- [ ] Call Dana #work #Urgent\n   o Ask about SOW\n\t\t• deeper still\n☑ Send invoice\n[x] Pay rent\n1) Buy milk\n2. Plan trip\n\n   \n* Water plants  ');
  assert.deepEqual(r.tasks.map(t => t.title), ['Call Dana', 'Send invoice', 'Pay rent', 'Buy milk', 'Plan trip', 'Water plants']);
  assert.deepEqual(r.tasks[0].tags, ['work', 'urgent']); assert.equal(r.tasks[0].subs.length, 2, 'deeper levels are subtasks of the same task');
  assert.deepEqual(r.tasks.map(t => t.done), [false, true, true, false, false, false]);
  assert.equal(r.count, 8);
  assert.deepEqual(T.parseTaskLines('a\n  b\nc', { subs: false }).tasks.map(t => t.title), ['a', 'b', 'c']);
  assert.equal(T.parseTaskLines('').tasks.length, 0); assert.equal(T.parseTaskLines('- \n[ ]\n#only').tasks.length, 0, 'lines with nothing but a marker are skipped');
  const many = T.parseTaskLines(Array.from({ length: 600 }, (_, i) => 'task ' + i).join('\n')); assert.equal(many.tasks.length, 500); assert.equal(many.truncated, true);
  assert.equal(T.parseTaskLines('-5 degrees today').tasks[0].title, '-5 degrees today', 'a minus sign is not a bullet');
});
