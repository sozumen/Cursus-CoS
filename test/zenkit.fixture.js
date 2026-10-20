/* Made-up Zenkit export used by the importer and UI tests. */
const NOW_DEFAULT = null;

/* A small made-up export with the same shape as a real Zenkit "Export as JSON" file. */
const F = { title: 'f-title', desc: 'f-desc', stage: 'f-stage', pri: 'f-pri', tags: 'f-tags', due: 'f-due', sched: 'f-sched', work: 'f-work', who: 'f-who', files: 'f-files', sub: 'f-sub', dep: 'f-dep' };
const cat = (id, name) => ({ id, name });
const elements = [
  { uuid: F.title, name: 'Title', elementcategory: 1, isPrimary: true },
  { uuid: 'f-created', name: 'Created', elementcategory: 8, isAutoCreated: true },
  { uuid: F.desc, name: 'Description', elementcategory: 1 },
  { uuid: F.stage, name: 'Stage', elementcategory: 6, elementData: { predefinedCategories: [cat(1, 'To-Do'), cat(2, 'Major Project'), cat(3, 'Scheduled'), cat(4, 'Up Next'), cat(5, 'In Progress'), cat(6, 'On Hold'), cat(7, 'Done'), cat(8, 'Await Reply'), cat(9, 'Idea for discussion')] } },
  { uuid: F.pri, name: 'Priority', elementcategory: 6, elementData: { predefinedCategories: [cat(21, 'Critical'), cat(22, 'High Importance'), cat(23, 'Normal Importance'), cat(24, 'Nice to have')] } },
  { uuid: F.tags, name: 'Tags', elementcategory: 6, elementData: { predefinedCategories: [cat(31, 'Budget'), cat(32, 'Board')] } },
  { uuid: F.due, name: 'Due Date', elementcategory: 4 }, { uuid: F.sched, name: 'Scheduled', elementcategory: 4 },
  { uuid: F.work, name: 'Workload', elementcategory: 2 }, { uuid: F.who, name: 'Assigned To', elementcategory: 14 },
  { uuid: F.files, name: 'Attachments', elementcategory: 15 }, { uuid: F.sub, name: 'Subtasks', elementcategory: 18 }, { uuid: F.dep, name: 'Dependencies', elementcategory: 19 },
  { uuid: 'f-extra', name: 'Budget code', elementcategory: 1 }
];
const NOW = new Date('2026-10-17T12:00:00Z');
let seq = 0;
function entry(uuid, o) {
  seq++;
  const e = { id: seq, uuid, shortId: seq, created_at: o.created || '2025-03-01T10:00:00.000Z', updated_at: o.updated || '2026-10-16T09:00:00.000Z', deprecated_at: o.archived || null,
    created_by: 101, created_by_displayname: 'Dana Lee', sortOrder: String(o.sort == null ? seq : o.sort), comment_count: o.comments || 0, checklists: o.checklists || [], occurrence: o.occurrence || null };
  e[F.title + '_text'] = o.title; e[F.desc + '_text'] = o.desc || ''; e[F.desc + '_textType'] = o.html ? 'html' : 'plain';
  e[F.stage + '_categories'] = o.stage ? [o.stage] : []; e[F.pri + '_categories'] = o.pri ? [o.pri] : []; e[F.tags + '_categories'] = o.tags || [];
  e[F.due + '_date'] = o.due || null; e[F.due + '_endDate'] = o.dueEnd || null; e[F.sched + '_date'] = o.sched || null;
  e[F.work + '_number'] = o.work || 0; e[F.who + '_persons'] = o.who || [];
  e[F.files + '_files'] = (o.files || []).map((f, i) => 'file' + i); e[F.files + '_filesData'] = o.files || [];
  e[F.sub + '_parents'] = o.parents || []; e[F.sub + '_path'] = o.path || '00000001'; e[F.dep + '_references'] = o.deps || [];
  return e;
}
const DONE = 7;
function makeExport() {
  const entries = [
    entry('plan', { title: 'Plan offsite', stage: 1, tags: [31], pri: 22, due: '2026-11-01', work: 1.5, who: [101, 202], files: [{ fileName: 'agenda.pdf', size: 2048 }], desc: 'Notes here', occurrence: { id: 1 },
      checklists: [{ name: 'Checklist', items: [{ text: 'Book room', checked: true }, { text: 'Order lunch', checked: false }] }], comments: 2, sort: 1.5 }),
    entry('parent1', { title: 'Launch plan', stage: 5, sort: 2 }),
    entry('kid2', { title: 'Write copy', stage: 1, parents: ['parent1'], path: '00000001.00000002', sort: 3 }),
    entry('kid1', { title: 'Design hero', stage: 7, parents: ['parent1'], path: '00000001.00000001', sort: 4, updated: '2026-10-11T08:00:00.000Z' }),
    entry('ship', { title: 'Ship it', stage: 3, sched: '2026-11-05', due: '2026-11-10T12:00:00.000Z', deps: ['parent1'], sort: 5 }),
    entry('idea', { title: 'Rethink pricing', stage: 9, sort: 6 }), entry('wait', { title: 'Waiting on Sam', stage: 8, sort: 7 }),
    entry('park', { title: 'Parked item', stage: 6, sort: 8 }), entry('big', { title: 'Big thing', stage: 2, sort: 9 }), entry('nostage', { title: 'No stage here', sort: 10 }),
    entry('long', { title: 'x'.repeat(250), stage: 1, sort: 11 }), entry('baddep', { title: 'Missing dependency', stage: 1, deps: ['nope'], sort: 12 }),
    entry('html', { title: 'Html notes', stage: 1, html: true, desc: '<p>Hello&nbsp;<b>world</b></p><p>Second &amp; last</p>', sort: 13 }),
    entry('range', { title: 'Date range', stage: 1, due: '2026-12-01', dueEnd: '2026-12-05', sort: 14 }),
    entry('zarch', { title: 'Archived in Zenkit', stage: DONE, archived: '2026-05-05T00:00:00.000Z', updated: '2026-05-05T00:00:00.000Z' })
  ];
  for (let i = 0; i < 30; i++) entries.push(entry('bulk' + i, { title: 'Bulk done ' + i, stage: DONE, created: '2025-01-01T10:00:00.000Z', updated: '2026-10-16T09:00:00.000Z', due: i < 3 ? '2026-10-14' : null }));
  entries.push(entry('recent1', { title: 'Finished recently', stage: DONE, created: '2025-01-01T10:00:00.000Z', updated: '2026-10-12T10:00:00.000Z' }));
  entries.push(entry('recent2', { title: 'Finished two days ago', stage: DONE, created: '2025-01-01T10:00:00.000Z', updated: '2026-10-15T22:00:00.000Z' }));
  return { list: { name: 'Test list' }, elements, entries, activities: [] };
}
module.exports = { makeExport, NOW };
