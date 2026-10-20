const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/js/core.js');
const { isSyncPayload, reconcileDone, autoArchive, isBlocked, autoMove, parseEst, fmtEst, fireTime, normalize, stampChanges, resetHashes, mergeData, signature, seed, newTask, addDays, todayStr } = core;

const mk = o => Object.assign({ id: Math.random().toString(36).slice(2), status: 'consider', priority: 'medium', start: '', due: '', deps: [], locked: false, scheduledFlow: false }, o);
const A = { enabled: true, scheduled: true, nearTermDays: 7, upNextDays: 0, urgent: true, urgentDays: 2, soonDays: 7 };

test('automation rules', () => {
  const today = '2026-10-16';
  const T = [
    mk({ id: 'a', priority: 'high', due: '2026-10-18' }),                                   // up-next
    mk({ id: 'b', priority: 'high', due: '2026-10-21' }),                                   // near-term
    mk({ id: 'c', priority: 'high', due: '2026-10-18', locked: true }),                     // manual: untouched
    mk({ id: 'd', status: 'scheduled', scheduledFlow: true, start: '2026-10-20' }),         // near-term
    mk({ id: 'e', status: 'near-term', scheduledFlow: true, start: '2026-10-16' }),         // up-next
    mk({ id: 'f', status: 'scheduled', scheduledFlow: true, start: '2026-11-30' }),         // stays
    mk({ id: 'g', priority: 'high', due: '2026-10-17', deps: ['h'] }),                      // blocked: near-term only
    mk({ id: 'h', status: 'in-progress' }),
    mk({ id: 'i', priority: 'low', due: '2026-10-17' }),                                    // low priority: stays
    mk({ id: 'j', status: 'done', priority: 'high', due: '2026-10-16' })                    // done: stays
  ];
  const moves = autoMove(T, A, today).map(m => m.t.id + ':' + m.to).sort();
  assert.deepEqual(moves, ['a:up-next', 'b:near-term', 'd:near-term', 'e:up-next', 'g:near-term']);
  assert.deepEqual(autoMove(T, Object.assign({}, A, { enabled: false }), today), []);
});

test('estimates and reminder times', () => {
  assert.equal(parseEst('1h 30m'), 90); assert.equal(parseEst('90'), 90); assert.equal(parseEst('2h'), 120); assert.equal(parseEst('1.5h'), 90);
  assert.equal(fmtEst(90), '1h 30m'); assert.equal(fmtEst(120), '2h'); assert.equal(fmtEst(45), '45m'); assert.equal(fmtEst(0), '');
  const d = fireTime({ reminder: { type: 'before_due', days: 1 }, due: '2026-10-20' }, '09:00');
  assert.equal(d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + d.getHours(), '2026-10-19 9');
  assert.equal(fireTime({ reminder: { type: 'before_due', days: 0 }, due: '' }, '09:00'), null);
});

test('normalize repairs old and broken data', () => {
  const d = normalize({ boards: [{ id: 'b1', name: 'One' }], tasks: [{ id: 't1', boardId: 'gone', deps: ['nope', 't1'], projectId: 'zzz', parentId: 'zzz' }] });
  assert.equal(d.tasks[0].boardId, 'b1');
  assert.deepEqual(d.tasks[0].deps, []);
  assert.equal(d.tasks[0].projectId, null);
  assert.equal(d.tasks[0].parentId, null);
  assert.ok(d.meta.deviceId && d.meta.sync.mode === 'off');
  assert.ok(d.boards[0].updated);
  const empty = normalize(null);
  assert.equal(empty.boards.length, 1);
  const old = new Date(Date.now() - 100 * 864e5).toISOString();
  const t = normalize({ boards: [], tombstones: [{ kind: 'task', id: 'x', updated: old }, { kind: 'task', id: 'y', updated: new Date().toISOString() }] });
  assert.deepEqual(t.tombstones.map(x => x.id), ['y']);
});

test('stampChanges stamps only what changed', () => {
  const S = seed(), hashes = {};
  resetHashes(S, hashes);
  const before = S.tasks.map(t => t.updated);
  assert.equal(stampChanges(S, hashes, '2030-01-01T00:00:00.000Z'), 0);
  S.tasks[0].title = 'Edited';
  S.tasks.push(newTask({ boardId: S.boards[0].id, title: 'Brand new' }));
  assert.equal(stampChanges(S, hashes, '2030-01-01T00:00:00.000Z'), 2);
  assert.equal(S.tasks[0].updated, '2030-01-01T00:00:00.000Z');
  assert.equal(S.tasks[1].updated, before[1]);
  assert.equal(stampChanges(S, hashes, '2031-01-01T00:00:00.000Z'), 0);
});

const rec = (id, title, updated) => ({ id, title, updated });
const data = (tasks, tombstones = []) => ({ boards: [], projects: [], tasks, tombstones });

test('merge: newest edit wins, unions additions', () => {
  const local = data([rec('1', 'local newer', '2026-01-02T00:00:00Z'), rec('2', 'only local', '2026-01-01T00:00:00Z')]);
  const remote = data([rec('1', 'remote older', '2026-01-01T00:00:00Z'), rec('3', 'only remote', '2026-01-01T00:00:00Z')]);
  const m = mergeData(local, remote);
  assert.deepEqual(m.tasks.map(t => t.title).sort(), ['local newer', 'only local', 'only remote']);
  const m2 = mergeData(data([rec('1', 'local older', '2026-01-01T00:00:00Z')]), data([rec('1', 'remote newer', '2026-01-02T00:00:00Z')]));
  assert.equal(m2.tasks[0].title, 'remote newer');
});

test('merge: deletes propagate, later edits resurrect', () => {
  const tomb = [{ kind: 'task', id: '1', updated: '2026-01-05T00:00:00Z' }];
  const del = mergeData(data([], tomb), data([rec('1', 'edited before delete', '2026-01-02T00:00:00Z')]));
  assert.equal(del.tasks.length, 0); assert.equal(del.tombstones.length, 1);
  const alive = mergeData(data([], tomb), data([rec('1', 'edited after delete', '2026-01-09T00:00:00Z')]));
  assert.equal(alive.tasks.length, 1); assert.equal(alive.tombstones.length, 0);
});

test('merge: converges regardless of order and is idempotent', () => {
  const a = data([rec('1', 'a1', '2026-01-03T00:00:00Z'), rec('2', 'a2', '2026-01-01T00:00:00Z')], [{ kind: 'task', id: '9', updated: '2026-01-04T00:00:00Z' }]);
  const b = data([rec('1', 'b1', '2026-01-02T00:00:00Z'), rec('2', 'b2', '2026-01-05T00:00:00Z'), rec('9', 'b9', '2026-01-01T00:00:00Z')]);
  const ab = mergeData(a, b), ba = mergeData(b, a);
  assert.equal(signature(ab), signature(ba));
  assert.equal(signature(mergeData(ab, b)), signature(ab));
  assert.equal(signature(mergeData(ab, a)), signature(ab));
  assert.deepEqual(ab.tasks.map(t => t.title).sort(), ['a1', 'b2']);
});

test('sample data is well formed', () => {
  const S = seed();
  assert.equal(S.sample, true);
  assert.ok(S.tasks.length > 15 && S.boards.length === 3);
  assert.ok(S.tasks.every(t => S.boards.some(b => b.id === t.boardId)));
  const due = S.tasks.filter(t => t.due).every(t => /^\d{4}-\d{2}-\d{2}$/.test(t.due));
  assert.ok(due);
  assert.equal(addDays(todayStr(), 0), todayStr());
});

test('sync files written under the earlier app name are still accepted', () => {
  const base = { boards: [], projects: [], tasks: [] };
  assert.ok(isSyncPayload(Object.assign({ app: 'cursus-cos' }, base)));
  assert.ok(isSyncPayload(Object.assign({ app: 'cos-tasks' }, base)));
  assert.ok(isSyncPayload(base));
  assert.ok(!isSyncPayload(Object.assign({ app: 'some-other-app' }, base)));
});

test('archived tasks are ignored by automation and never block anything', () => {
  const today = '2026-10-16';
  const arch = mk({ id: 'a', priority: 'high', due: '2026-10-17', archived: true });
  assert.deepEqual(autoMove([arch], A, today), []);
  const blocker = mk({ id: 'b', status: 'in-progress', archived: true });
  const waits = mk({ id: 'w', deps: ['b'] });
  assert.equal(isBlocked(waits, [blocker, waits]), false);
  assert.equal(isBlocked(waits, [Object.assign({}, blocker, { archived: false }), waits]), true);
});

test('doneAt follows the status and auto-archive picks only old Done tasks', () => {
  const now = Date.parse('2026-10-17T12:00:00Z'), day = 864e5;
  const iso = n => new Date(now - n * day).toISOString();
  const T = [
    mk({ id: '1', status: 'done', updated: iso(40) }),                    // no doneAt yet: taken from updated
    mk({ id: '2', status: 'done', doneAt: iso(5), updated: iso(5) }),
    mk({ id: '3', status: 'in-progress', doneAt: iso(50) }),              // reopened: doneAt cleared
    mk({ id: '4', status: 'done', doneAt: iso(90), archived: true })
  ];
  assert.equal(reconcileDone(T, new Date(now).toISOString()), 2);
  assert.equal(T[0].doneAt, iso(40)); assert.equal(T[2].doneAt, '');
  assert.equal(reconcileDone(T), 0);
  assert.deepEqual(autoArchive(T, Object.assign({}, A, { archiveDays: 30 }), now).map(t => t.id), ['1']);
  assert.deepEqual(autoArchive(T, Object.assign({}, A, { archiveDays: 0 }), now), []);
  assert.deepEqual(autoArchive(T, Object.assign({}, A, { archiveDays: 30, enabled: false }), now), []);
});

test('normalize adds the new fields to older data', () => {
  const d = normalize({ boards: [{ id: 'b', name: 'B' }], tasks: [{ id: 't', boardId: 'b', status: 'done', updated: '2026-01-01T00:00:00.000Z' }] });
  assert.equal(d.tasks[0].archived, false); assert.equal(d.tasks[0].doneAt, '2026-01-01T00:00:00.000Z');
  assert.equal(d.settings.automation.archiveDays, 0); assert.equal(d.settings.filters.archived, false);
  assert.deepEqual(d.settings.importMaps.zenkit, { stages: {}, priorities: {} });
});

/* ---------- per-board stages ---------- */
test('stages: a board starts with the standard eight, one completed stage, and old data gains them', () => {
  const b = core.newBoard({ name:'X' });
  assert.deepEqual(b.stages.map(s => s.id), core.COLS.map(c => c.id));
  assert.deepEqual(b.stages.filter(s => s.done).map(s => s.id), ['done']);
  const old = core.normalize({ boards:[{ id:'b1', name:'Old' }], tasks:[{ id:'t1', boardId:'b1', title:'t', status:'review' }] });
  assert.equal(old.boards[0].stages.length, 8); assert.equal(old.tasks[0].status, 'review');
});

test('stages: normalising fixes bad input (names, duplicates, colors, completed flag, limits)', () => {
  const b = core.normalizeBoard({ id:'b', name:'B', stages:[
    { id:'a', name:'  Backlog  ', h:999, s:-5 }, { id:'a', name:'dup id' }, { id:'b2', name:'backlog' }, { id:'c', name:'', h:'x' },
    { id:'d', name:'Shipped', done:true }, { id:'e', name:'Also done', done:true }, null, { name:'no id' }
  ] });
  assert.deepEqual(b.stages.map(s => s.id), ['a', 'b2', 'c', 'd', 'e']);
  assert.equal(b.stages[0].name, 'Backlog'); assert.equal(b.stages[0].h, 360); assert.equal(b.stages[0].s, 0);
  assert.notEqual(core.stageKey(b.stages[1].name), core.stageKey(b.stages[0].name), 'duplicate names are made unique');
  assert.equal(b.stages[2].name, 'c');
  assert.deepEqual(b.stages.filter(s => s.done).map(s => s.id), ['d'], 'exactly one completed stage, the first flagged');
  const none = core.normalizeBoard({ id:'x', stages:[{ id:'p', name:'P' }, { id:'q', name:'Q' }] });
  assert.equal(none.stages[1].done, true, 'with no flag the last stage is the completed one');
  assert.equal(core.normalizeBoard({ id:'y', stages:[] }).stages.length, 8);
  const many = core.normalizeBoard({ id:'m', stages:Array.from({ length:40 }, (_, i) => ({ id:'s' + i, name:'S' + i })) });
  assert.equal(many.stages.length, core.MAX_STAGES);
  assert.equal(core.stageKey('In Progress'), 'in-progress'); assert.equal(core.stageKey('Q&A / Review'), 'q-a-review'); assert.equal(core.stageKey('完了'), '完了'); assert.equal(core.stageKey('!!!'), 'stage');
});

test('stages: done-ness follows the board, in blocked, due, auto-move, done dates and auto-archive', () => {
  const boards = [core.newBoard({ id:'b', stages:[{ id:'todo', name:'To do' }, { id:'doing', name:'Doing' }, { id:'shipped', name:'Shipped', done:true }] })];
  const mk = p => core.newTask(Object.assign({ boardId:'b' }, p));
  const dep = mk({ id:'d', status:'doing' }), t = mk({ id:'t', status:'todo', deps:['d'], due:'2020-01-01' });
  assert.equal(core.isBlocked(t, [dep, t], boards), true);
  dep.status = 'shipped'; assert.equal(core.isBlocked(t, [dep, t], boards), false);
  assert.equal(core.dueState(t, '2026-01-01', boards), 'overdue');
  t.status = 'shipped'; assert.equal(core.dueState(t, '2026-01-01', boards), '');
  assert.equal(core.reconcileDone([t, dep], '2026-02-01T00:00:00Z', boards), 2); assert.ok(t.doneAt);
  t.status = 'todo'; core.reconcileDone([t], undefined, boards); assert.equal(t.doneAt, '');
  dep.doneAt = '2000-01-01T00:00:00Z'; assert.equal(core.autoArchive([dep], { enabled:true, archiveDays:5 }, Date.now(), boards).length, 1);
  // a board without the standard stage ids is left alone by the schedule rules
  const sch = mk({ id:'s', status:'todo', priority:'high', due:'2026-01-02' });
  const A = { enabled:true, scheduled:true, urgent:true, upNextDays:0, nearTermDays:3, urgentDays:2, soonDays:5 };
  assert.deepEqual(core.autoMove([sch], A, '2026-01-01', boards), []);
  const std = [core.newBoard({ id:'b' })], t2 = mk({ id:'u', status:'consider', priority:'high', due:'2026-01-02' });
  assert.equal(core.autoMove([t2], A, '2026-01-01', std)[0].to, 'up-next');
  // without boards the standard 'done' id is assumed (older callers)
  assert.equal(core.isDoneTask({ status:'done' }), true);
});

test('stages: repairing tasks whose stage no longer exists, and mapping when a task changes board', () => {
  const d = core.normalize({ boards:[{ id:'b', name:'B', stages:[{ id:'a', name:'A' }, { id:'z', name:'Z', done:true }] }],
    tasks:[{ id:'1', boardId:'b', title:'x', status:'gone' }, { id:'2', boardId:'b', title:'y', status:'done' }, { id:'3', boardId:'b', title:'w', status:'a' }] });
  assert.deepEqual(d.tasks.map(t => t.status), ['a', 'z', 'a']);
  assert.equal(d.tasks[1].doneAt !== '', true);
  const std = core.newBoard({ id:'s' }), cus = core.newBoard({ id:'c', stages:[{ id:'k1', name:'Up Next' }, { id:'k2', name:'Shipped', done:true }, { id:'k3', name:'Other' }] });
  assert.equal(core.mapStatus('review', std, std), 'review');
  assert.equal(core.mapStatus('up-next', std, cus), 'k1', 'same name');
  assert.equal(core.mapStatus('done', std, cus), 'k2', 'completed to completed');
  assert.equal(core.mapStatus('consider', std, cus), 'k1', 'first non-completed stage');
  assert.equal(core.mapStatus('k3', cus, std), 'consider');
  assert.equal(core.mapStatus('k2', cus, std), 'done');
  const unknown = core.newBoard({ id:'u', template:{ status:'nope' }, stages:[{ id:'only', name:'Only' }] });
  assert.equal(unknown.template.status, 'only');
});

/* ---------- importance 1-10 ---------- */
test('importance: a number from 1 to 10, with the old low / medium / high kept in step', () => {
  assert.equal(newTask({ priority: 'high' }).importance, 8);
  assert.equal(newTask({ priority: 'low' }).importance, 3);
  assert.equal(newTask({}).importance, 5);
  const t = newTask({ importance: 6 }); assert.equal(t.priority, 'medium');
  assert.equal(newTask({ importance: 9 }).priority, 'high'); assert.equal(newTask({ importance: 3 }).priority, 'low');
  assert.equal(newTask({ importance: 99 }).importance, 5, 'out of range falls back to the default');
  const { impMatch, setImp } = core;
  assert.ok(impMatch(8, 'high') && !impMatch(7, 'high') && impMatch(5, 'medium') && impMatch(4, '4-7') && !impMatch(8, '4-7') && impMatch(6, '6+') && !impMatch(5, '6+') && impMatch(7, '7') && impMatch(1, ''));
  const u = newTask({}); assert.equal(setImp(u, '10'), true); assert.equal(u.importance, 10); assert.equal(u.priority, 'high'); assert.equal(setImp(u, 'x'), false);
});
test('importance: data from an older version or an older device is read correctly', () => {
  const d = normalize({ boards: [], projects: [], tasks: [{ id: 'a', title: 'old', priority: 'high' }, { id: 'b', title: 'new', priority: 'medium', importance: 6 }, { id: 'c', title: 'older device changed it', priority: 'high', importance: 5 }] });
  const by = id => d.tasks.find(t => t.id === id);
  assert.equal(by('a').importance, 8); assert.equal(by('b').importance, 6); assert.equal(by('c').importance, 8, 'the change made by the older version wins');
  assert.equal(d.boards[0].template.importance, 5);
  const e = normalize({ boards: [{ id: 'x', name: 'X', template: { priority: 'high' }, rules: [{ id: 'r', trigger: { type: 'created' }, actions: [{ type: 'priority', value: 'low' }] }] }], tasks: [] });
  assert.equal(e.boards[0].template.importance, 8); assert.equal(e.boards[0].rules[0].actions[0].value, '3');
  const f = normalize({ settings: { filters: { priority: ['high', 'low'] } } });
  assert.equal(f.settings.filters.priority.join(','), '8,9,10,1,2,3');
});
test('importance: the urgent rule uses the importance you choose', () => {
  const today = '2026-10-16', t = mk({ id: 'z', importance: 6, due: '2026-10-17' });
  assert.equal(autoMove([t], Object.assign({}, A, { urgentMin: 8 }), today).length, 0);
  assert.deepEqual(autoMove([t], Object.assign({}, A, { urgentMin: 6 }), today).map(m => m.to), ['up-next']);
});

/* ---------- repeating tasks ---------- */
test('repeat: month and year steps stay on the calendar, weekdays skip weekends', () => {
  const { addInterval } = core;
  assert.equal(addInterval('2026-01-31', 1, 'month'), '2026-02-28'); assert.equal(addInterval('2028-01-31', 1, 'month'), '2028-02-29');
  assert.equal(addInterval('2026-11-15', 3, 'month'), '2027-02-15'); assert.equal(addInterval('2024-02-29', 1, 'year'), '2025-02-28');
  assert.equal(addInterval('2026-10-16', 3, 'weekday'), '2026-10-21'); assert.equal(addInterval('2026-10-16', 1, 'weekday'), '2026-10-19');
  assert.equal(addInterval('2026-10-16', 2, 'week'), '2026-10-30'); assert.equal(addInterval('2026-10-16', 10, 'day'), '2026-10-26');
});
test('repeat: next dates follow the schedule or the finish day and keep the gap between start and due', () => {
  const t = newTask({ start: '2026-09-29', due: '2026-10-01', repeat: { every: 1, unit: 'week' } });
  assert.deepEqual(core.nextDates(t, '2026-09-30'), { start: '2026-10-06', due: '2026-10-08', delta: 7 }, 'finished early: the next one on schedule');
  assert.equal(core.nextDates(t, '2026-10-22').due, '2026-10-22', 'weeks late: skips the dates already past');
  const c = newTask({ due: '2026-10-01', repeat: { every: 2, unit: 'week', from: 'completion' } });
  assert.equal(core.nextDates(c, '2026-10-20').due, '2026-11-03');
  const none = newTask({ repeat: { every: 3, unit: 'day' } }); assert.equal(core.nextDates(none, '2026-10-20').due, '2026-10-23', 'no dates yet: counts from today');
  assert.equal(core.nextDates(newTask({}), '2026-10-20'), null);
  assert.equal(core.repeatLabel({ every: 1, unit: 'month' }), 'Every month'); assert.equal(core.repeatLabel({ every: 3, unit: 'week' }), 'Every 3 weeks');
});
test('repeat: the new copy carries the task over, resets subtasks, and goes to a sensible stage', () => {
  const boards = [core.newBoard({ id: 'b' })];
  const t = newTask({ boardId: 'b', title: 'Water plants', importance: 7, due: '2026-10-20', tags: ['home'], assignees: ['Sam'], status: 'done', repeat: { every: 1, unit: 'week' },
    subitems: [{ id: 's1', title: 'Front room', done: true, taskId: 'gone' }], reminder: { type: 'at', at: '2026-10-20T08:30', ack: 'x' }, comments: [{ id: 'c', text: 'hi' }] });
  const n = core.nextOccurrence(t, boards, '2026-10-20');
  assert.notEqual(n.id, t.id); assert.equal(n.title, 'Water plants'); assert.equal(n.importance, 7); assert.equal(n.due, '2026-10-27'); assert.equal(n.tags.join(), 'home'); assert.equal(n.assignees.join(), 'Sam');
  assert.equal(n.status, 'consider', 'no start date: first open stage'); assert.ok(n.repeat && n.repeat.every === 1, 'the series goes on');
  assert.equal(n.subitems.length, 1); assert.equal(n.subitems[0].done, false); assert.equal(n.subitems[0].taskId, null); assert.equal(n.comments.length, 0);
  assert.equal(n.reminder.at, '2026-10-27T08:30'); assert.equal(n.reminder.ack, null);
  const s = core.nextOccurrence(Object.assign({}, t, { start: '2026-10-19' }), boards, '2026-10-20'); assert.equal(s.status, 'scheduled'); assert.equal(s.scheduledFlow, true);
  const w = core.nextOccurrence(Object.assign({}, t, { repeat: { every: 1, unit: 'week', stage: 'review' } }), boards, '2026-10-20'); assert.equal(w.status, 'review');
});
test('fields: Reminder and Repeat sit right under the dates, also on boards saved with the old order', () => {
  const old = core.normalizeBoard({ id: 'o', name: 'Old', fields: { order: ['stage', 'description', 'dates', 'priority', 'assignees', 'attachments', 'estimate', 'project', 'tags', 'subitems', 'deps', 'reminder', 'flag'], hidden: [], custom: [] } });
  const i = old.fields.order.indexOf('dates'); assert.deepEqual(old.fields.order.slice(i, i + 3), ['dates', 'reminder', 'repeat']);
  const fresh = core.newBoard({ id: 'n', name: 'New' }); const j = fresh.fields.order.indexOf('dates'); assert.deepEqual(fresh.fields.order.slice(j, j + 3), ['dates', 'reminder', 'repeat']);
  const again = core.normalizeBoard(JSON.parse(JSON.stringify(old))); assert.deepEqual(again.fields.order, old.fields.order);
  const moved = JSON.parse(JSON.stringify(old)); moved.fields.order = moved.fields.order.filter(x => x !== 'reminder').concat('reminder');
  assert.equal(core.normalizeBoard(moved).fields.order.slice(-1)[0], 'reminder', 'a board you arranged yourself is left alone');
});
test('stick with parent: automation leaves a stuck subtask to its parent', () => {
  const parent = mk({ id: 'p', subitems: [{ id: 's', title: 'x', taskId: 'k', stick: true }] });
  const kid = mk({ id: 'k', parentId: 'p', importance: 9, priority: 'high', due: '2026-10-17' });
  assert.equal(core.isStuckChild(kid, [parent, kid]), true);
  assert.equal(autoMove([parent, kid], A, '2026-10-16').length, 0);
  parent.subitems[0].stick = false; assert.equal(autoMove([parent, kid], A, '2026-10-16').length, 1);
});

/* ---------- tasks that have sat in a stage too long ---------- */
const { staleSuggestions, trackStages, daysInStage, normStale, STALE_DEFAULT } = core;
const daysAgoISO = n => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(12, 0, 0, 0); return d.toISOString(); };
const stale = (o, extra) => Object.assign(newTask(Object.assign({ boardId: 'b1', title: 'x' }, o)), extra || {});
const board = () => core.newBoard({ id: 'b1', name: 'B' });

test('stale rules: defaults are 30 days in Long-Term and 7 days in Near-Term', () => {
  const d = STALE_DEFAULT();
  assert.deepEqual(d.map(r => [r.from, r.days, r.to]), [['long-term', 30, 'near-term'], ['near-term', 7, 'up-next']]);
  assert.equal(core.DEFAULTS().automation.stale.length, 2);
});

test('stale rules: "more than" the days, never on a start date still ahead, skips done, archived and already-asked tasks', () => {
  const B = [board()], today = todayStr(), A2 = core.DEFAULTS().automation;
  const ts = [
    stale({ id: 'l31', status: 'long-term' }, { stageAt: daysAgoISO(31) }),                                  // asked
    stale({ id: 'l30', status: 'long-term' }, { stageAt: daysAgoISO(30) }),                                  // exactly 30: not yet
    stale({ id: 'lfut', status: 'long-term', start: addDays(today, 5) }, { stageAt: daysAgoISO(90) }),       // starts in the future: left alone
    stale({ id: 'lpast', status: 'long-term', start: addDays(today, -5) }, { stageAt: daysAgoISO(90) }),     // start already passed: asked
    stale({ id: 'n8', status: 'near-term' }, { stageAt: daysAgoISO(8) }),                                    // asked, to Up Next
    stale({ id: 'n7', status: 'near-term' }, { stageAt: daysAgoISO(7) }),
    stale({ id: 'c99', status: 'consider' }, { stageAt: daysAgoISO(99) }),                                   // no rule for Consider
    stale({ id: 'done', status: 'done' }, { stageAt: daysAgoISO(99) }),
    stale({ id: 'arch', status: 'long-term', archived: true }, { stageAt: daysAgoISO(99) }),
    stale({ id: 'pend', status: 'long-term' }, { stageAt: daysAgoISO(99), review: { to: 'near-term' } })
  ];
  const r = staleSuggestions(ts, A2, today, B);
  assert.deepEqual(r.map(x => x.t.id + '>' + x.to).sort(), ['l31>near-term', 'lpast>near-term', 'n8>up-next']);
  assert.equal(r.find(x => x.t.id === 'l31').days, 31);
});

test('stale rules: a blocked task is not pushed to Up Next, a missing target stage or a disabled rule is skipped, automation off asks nothing', () => {
  const b = board(), B = [b], today = todayStr();
  const dep = stale({ id: 'dep', status: 'in-progress' });
  const blocked = stale({ id: 'bl', status: 'near-term', deps: ['dep'] }, { stageAt: daysAgoISO(20) });
  assert.equal(staleSuggestions([dep, blocked], core.DEFAULTS().automation, today, B).length, 0);
  const A2 = core.DEFAULTS().automation; A2.stale[0].on = false;
  assert.equal(staleSuggestions([stale({ status: 'long-term' }, { stageAt: daysAgoISO(50) })], A2, today, B).length, 0);
  const A3 = core.DEFAULTS().automation; A3.stale[0].to = 'nowhere';
  assert.equal(staleSuggestions([stale({ status: 'long-term' }, { stageAt: daysAgoISO(50) })], A3, today, B).length, 0);
  const A4 = core.DEFAULTS().automation; A4.enabled = false;
  assert.equal(staleSuggestions([stale({ status: 'long-term' }, { stageAt: daysAgoISO(50) })], A4, today, B).length, 0);
});

test('stale rules: a changed stage restarts the clock and drops a pending question (taking our flag off again)', () => {
  const t = stale({ status: 'long-term', flag: '' }, { stageAt: daysAgoISO(40) });
  assert.equal(daysInStage(t), 40);
  assert.equal(trackStages([t]), 0, 'nothing changed yet');
  t.review = { to: 'near-term', flag: 'orange', prevFlag: 'blue' }; t.flag = 'orange';
  t.status = 'near-term';                                   // moved by hand, a rule, another device...
  assert.equal(trackStages([t]), 1);
  assert.equal(t.stageId, 'near-term'); assert.equal(daysInStage(t), 0);
  assert.equal(t.review, null); assert.equal(t.flag, 'blue', 'flag restored');
  const u = stale({ status: 'long-term' }); u.review = { to: 'near-term', flag: 'orange', prevFlag: '' }; u.flag = 'purple'; u.status = 'near-term';
  trackStages([u]); assert.equal(u.flag, 'purple', 'a flag changed meanwhile is left alone');
});

test('stale rules: older data gets its clock from the move history, else the creation date; settings are cleaned', () => {
  const at = '2026-01-05T10:00:00.000Z';
  const n = normalize({ boards: [], projects: [], tasks: [
    { id: 'a', boardId: 'x', title: 'a', status: 'long-term', created: '2025-12-01T00:00:00.000Z', log: [{ at: '2025-12-10T00:00:00.000Z', text: 'Moved Consider to Long-Term' }, { at, text: 'Moved Near-Term to Long-Term' }, { at: '2026-02-01T00:00:00.000Z', text: 'Moved to board "Ops"' }] },
    { id: 'b', boardId: 'x', title: 'b', status: 'consider', created: '2025-11-11T00:00:00.000Z', log: [] },
    { id: 'c', boardId: 'x', title: 'c', status: 'consider', review: 'junk' }
  ] });
  const by = id => n.tasks.find(t => t.id === id);
  assert.equal(by('a').stageAt, at); assert.equal(by('b').stageAt, '2025-11-11T00:00:00.000Z'); assert.equal(by('c').review, null);
  assert.deepEqual(normStale([null, { from: 'a', to: 'a' }, { from: 'Long Term', days: '12', to: 'Near-Term', flag: 'nope' }, { from: 'x', to: 'y', days: -4, on: false }]).map(r => [r.from, r.days, r.to, r.flag, r.on]),
    [['long-term', 12, 'near-term', 'orange', true], ['x', 1, 'y', 'orange', false]]);
  const m = normalize({ boards: [], projects: [], tasks: [], settings: { automation: { stale: 'oops' } } });
  assert.equal(m.settings.automation.stale.length, 2, 'bad setting falls back to the defaults');
});

/* ---------- ranking inside a column ---------- */
test('rank: importance and urgency lift a task; a hand-placed (pinned) one keeps its slot', () => {
  const T = core.newTask, today = '2026-10-20';
  assert.equal(core.urgencyOf({ due: '' }, today), 0);
  assert.equal(core.urgencyOf({ due: '2026-10-19' }, today), 10);
  assert.ok(core.urgencyOf({ due: '2026-10-21' }, today) > core.urgencyOf({ due: '2026-11-30' }, today));
  const low = T({ title: 'low', importance: 2, order: 1 }), mid = T({ title: 'mid', importance: 6, order: 2 });
  const hot = T({ title: 'hot', importance: 9, due: '2026-10-21', order: 3 }), soon = T({ title: 'soon', importance: 4, due: '2026-10-19', order: 4 });
  assert.deepEqual(core.rankOrder([low, mid, hot, soon], today).map(t => t.title), ['hot', 'soon', 'mid', 'low']);
  const held = T({ title: 'held', importance: 1, order: 5, pin: 0 });
  assert.deepEqual(core.rankOrder([low, mid, hot, soon, held], today).map(t => t.title), ['held', 'hot', 'soon', 'mid', 'low'], 'pinned to the top');
  held.pin = 99;
  assert.equal(core.rankOrder([low, mid, hot, soon, held], today).pop().title, 'held', 'a slot past the end means last');
  const a = T({ title: 'a', pin: 1, order: 1 }), b = T({ title: 'b', pin: 1, order: 2 });
  assert.equal(core.rankOrder([a, b, low], today).length, 3, 'two cards pinned to one slot both keep a place');
  assert.deepEqual(core.rankOrder([], today), []);
});
test('rank: damaged pin / inProcess values are repaired', () => {
  const d = core.normalize({ tasks: [{ id: 'x', title: 'x', boardId: 'b', pin: 'top', inProcess: 'yes' }], boards: [{ id: 'b', name: 'b' }] });
  assert.equal(d.tasks[0].pin, null); assert.equal(d.tasks[0].inProcess, false);
});
