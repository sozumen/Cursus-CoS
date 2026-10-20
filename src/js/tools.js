/* Cursus CoS tools: pure helpers with no DOM or storage, shared by the app and the tests.
   Grouping and sorting for views, board automation rules, CSV and calendar (.ics) files, print and email text,
   and the per-board activity feed. */
(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const api = factory(isNode ? require('./core.js') : root.CoS.core);
  if (isNode) module.exports = api; else { root.CoS = root.CoS || {}; root.CoS.tools = api; }
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';
  const { COLS, COL, PRI, IMP_BAND, bandOf, clampImp, impOf, impColor, impMatch, setImp, stageKey, isDoneTask, FLAGS, uid, nowISO, addDays, diffDays, fmtISO, todayStr, parseEst, fmtEst, newTask, logTask } = core;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  /* ====================== grouping and sorting ====================== */
  const GROUP_BASE = [['status', 'Stage'], ['priority', 'Importance'], ['project', 'Project'], ['assignee', 'Assigned To'], ['due', 'Due date'], ['board', 'Board']];
  /* Options for the "group by" menus: the built-ins plus every Label or Checkbox custom field on the boards in view. */
  function groupOptions(fields, { allowNone = false } = {}){
    const out = [];
    if (allowNone) out.push(['', 'None']);
    out.push(...GROUP_BASE);
    for (const f of fields || []) if (f.type === 'label' || f.type === 'check') out.push(['cf:' + f.id, f.name]);
    return out;
  }
  const DUE_GROUPS = [
    { id:'overdue', name:'Overdue', h:4, s:72 }, { id:'today', name:'Today', h:40, s:80 }, { id:'week', name:'Next 7 days', h:203, s:70 },
    { id:'later', name:'Later', h:215, s:16 }, { id:'none', name:'No due date', h:220, s:8 }
  ];
  /* ---------- stages (each board has its own) ---------- */
  const boardOfTask = (t, boards) => (boards || []).find(b => b.id === t.boardId);
  /* The stage object a task is in, falling back to a placeholder so a stray status never throws. */
  const stageOf = (t, boards) => { const b = boardOfTask(t, boards); return (b && b.stages && b.stages.find(x => x.id === t.status)) || COL[t.status] || { id:t.status, name:String(t.status), h:215, s:16 }; };
  const stageName = (t, boards) => stageOf(t, boards).name;
  /* The stages of several boards as one ordered list, merged by name (so two boards that both have "Review" share a
     column). Returns [{ key, id, name, h, s, done }]. */
  function unionStages(boards){
    const out = [], idx = new Map();
    for (const b of boards && boards.length ? boards : [{}]) for (const x of b.stages || core.defaultStages()){
      const k = stageKey(x.name);
      if (idx.has(k)){ if (x.done) out[idx.get(k)].done = true; continue; }
      idx.set(k, out.length); out.push({ key:k, id:x.id, name:x.name, h:x.h, s:x.s, done:!!x.done });
    }
    return out;
  }
  const stageKeyOf = (t, boards) => stageKey(stageOf(t, boards).name);
  /* The stage id on `board` whose name matches `key`, or null. Used when a card is dropped into a merged column. */
  const stageIdByKey = (board, key) => { const m = ((board && board.stages) || []).find(x => stageKey(x.name) === key); return m ? m.id : null; };
  const dueBucket = (t, today, boards) => {
    if (!t.due) return 'none';
    const d = diffDays(today, t.due);
    return d < 0 && !isDoneTask(t, boards) ? 'overdue' : d <= 0 ? 'today' : d <= 7 ? 'week' : 'later';
  };
  /* ctx = { projects, boards (the boards in view), tasks (in view), fields (custom fields), today }.
     Returns { group, editable, groups:[{id,name,h,s}], keyOf(task) }. A task always falls in exactly one group. */
  function groupDefs(group, ctx){
    const today = ctx.today || todayStr();
    if (group === 'priority') return { group, editable:true, groups: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(n => Object.assign({ id:String(n), name: n === 10 ? '10 (highest)' : n === 1 ? '1 (lowest)' : String(n) }, impColor(n))), keyOf: t => String(t.importance) };
    if (group === 'project') return { group, editable:true, groups:[{ id:'', name:'No project', h:220, s:8 }, ...(ctx.projects || []).map(p => ({ id:p.id, name:p.name, h:p.h, s:60 }))], keyOf: t => t.projectId || '' };
    if (group === 'board') return { group, editable:true, groups:(ctx.boards || []).map(b => ({ id:b.id, name:b.name, h:b.h, s:65 })), keyOf: t => t.boardId };
    if (group === 'assignee'){
      const names = []; const add = n => { if (n && !names.includes(n)) names.push(n); };
      for (const b of ctx.boards || []) for (const m of b.members || []) add(m.name);
      for (const t of ctx.tasks || []) for (const n of t.assignees || []) add(n);
      return { group, editable:true, groups:[{ id:'', name:'Unassigned', h:220, s:8 }, ...names.map(n => ({ id:n, name:n, h:core.hashId(n) % 360, s:50 }))], keyOf: t => (t.assignees && t.assignees[0]) || '' };
    }
    if (group === 'due') return { group, editable:false, groups: DUE_GROUPS, keyOf: t => dueBucket(t, today, ctx.boards) };
    if (group && group.startsWith('cf:')){
      const f = (ctx.fields || []).find(x => 'cf:' + x.id === group);
      if (f && f.type === 'check') return { group, editable:true, groups:[{ id:'no', name:'No', h:220, s:8 }, { id:'yes', name:'Yes', h:142, s:48 }], keyOf: t => (t.custom && t.custom[f.id]) ? 'yes' : 'no' };
      if (f && f.type === 'label') return { group, editable:true, groups:[{ id:'', name:'No ' + f.name.toLowerCase(), h:220, s:8 }, ...(f.options || []).map(o => ({ id:o.id, name:o.name, h:o.h == null ? 210 : o.h, s:60 }))], keyOf: t => (t.custom && t.custom[f.id]) || '' };
    }
    const U = unionStages(ctx.boards && ctx.boards.length ? ctx.boards : [{ stages: core.defaultStages() }]);
    return { group:'status', editable:true, groups: U.map(g => ({ id:g.key, name:g.name, h:g.h, s:g.s, done:g.done })), keyOf: t => stageKeyOf(t, ctx.boards) };
  }
  const SORT_KEYS = [['manual', 'Manual (default)'], ['due', 'Due date'], ['start', 'Start date'], ['priority', 'Importance'], ['title', 'Title'], ['estimate', 'Workload'], ['created', 'Date created'], ['updated', 'Last changed']];
  /* Tasks with no value for the sort key always go last, whichever direction is chosen. */
  function sortTasks(list, key, dir = 1){
    const val = {
      manual: t => t.order, due: t => t.due || null, start: t => t.start || null, priority: t => -t.importance,
      title: t => t.title.toLowerCase(), estimate: t => t.estimate || null, created: t => t.created || null, updated: t => t.updated || null
    }[key] || (t => t.order);
    return list.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return a.order - b.order;
      if (x == null) return 1; if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : a.order - b.order) * dir;
    });
  }

  /* ====================== board rules ====================== */
  const RULE_TRIGGERS = [
    { id:'created',  label:'A task is created', value:null },
    { id:'moved',    label:'A task moves to a stage', value:'column' },
    { id:'priority', label:'A task\'s importance is set to', value:'priority' },
    { id:'overdue',  label:'A task becomes overdue', value:null },
    { id:'start',    label:'A task\'s scheduled start date', value:'offset' },
    { id:'due',      label:'A task\'s due date', value:'offset' }
  ];
  /* How far from the date a "start" or "due" rule fires: negative is before the date, 0 the day itself, positive after. */
  const DATE_OFFSETS = [[-14, '2 weeks before'], [-7, '1 week before'], [-3, '3 days before'], [-2, '2 days before'], [-1, '1 day before'], [0, 'On the day'], [1, '1 day after'], [2, '2 days after'], [3, '3 days after'], [7, '1 week after']];
  const RULE_ACTIONS = [
    { id:'move',      label:'Move it to stage', value:'column' },
    { id:'priority',  label:'Set importance to', value:'importance' },
    { id:'addTag',    label:'Add the tag', value:'text' },
    { id:'removeTag', label:'Remove the tag', value:'text' },
    { id:'assign',    label:'Assign it to', value:'member' },
    { id:'due',       label:'Set the due date to this many days from today', value:'days' },
    { id:'dueClear',  label:'Clear the due date', value:null },
    { id:'flag',      label:'Set the flag color to', value:'flag' },
    { id:'archive',   label:'Archive it', value:null }
  ];
  /* Runs the board's rules for one event on one task. Plain fields are changed on the task directly; a stage change or an
     archive is returned instead, because the app has to do those through its own paths (locking, ordering, logging).
     ev = { type, value }.  ctx = { today, fired }  (fired remembers which overdue rules already ran for which task/day). */
  function applyRules(rules, ev, t, ctx = {}){
    const res = { names:[], notes:[], status:null, archive:false };
    const today = ctx.today || todayStr();
    for (const r of rules || []){
      if (!r || r.on === false || !r.trigger || r.trigger.type !== ev.type) continue;
      const isDate = ev.type === 'start' || ev.type === 'due';
      if (isDate){   // fires once the date is `offset` days away or past, and once only for each date the task has
        if (!(ev.days >= (Number(r.trigger.value) || 0)) || !ev.date || (t.fired && t.fired[r.id] === ev.date)) continue;
      } else if (r.trigger.value && (ev.type === 'priority' ? !impMatch(clampImp(ev.value) || IMP_BAND[ev.value] || 0, r.trigger.value) : r.trigger.value !== ev.value)) continue;
      const c = r.cond || {};
      if (c.priority && !impMatch(impOf(t), c.priority)) continue;
      if (c.tag && !t.tags.includes(String(c.tag).toLowerCase())) continue;
      if (c.stage && c.stage !== t.status) continue;
      if (isDate){ t.fired = Object.assign({}, t.fired || {}, { [r.id]: ev.date }); }
      if (ev.type === 'overdue'){
        const k = r.id + ':' + t.id, f = ctx.fired;
        if (f){ if (f[k] === today) continue; f[k] = today; }
      }
      let did = false;
      for (const a of r.actions || []){
        const v = a.value;
        const tgt = (ctx.stages || core.defaultStages()).find(x => x.id === v);
        if (a.type === 'move' && tgt && v !== t.status){ res.status = v; res.notes.push(`moved to ${tgt.name}`); did = true; }
        else if (a.type === 'priority' && clampImp(IMP_BAND[v] || v) && setImp(t, IMP_BAND[v] || v)){ res.notes.push(`importance set to ${t.importance}`); did = true; }
        else if (a.type === 'addTag' && v){ const g = String(v).trim().toLowerCase(); if (g && !t.tags.includes(g)){ t.tags.push(g); res.notes.push(`tagged ${g}`); did = true; } }
        else if (a.type === 'removeTag' && v){ const g = String(v).trim().toLowerCase(); if (t.tags.includes(g)){ t.tags = t.tags.filter(x => x !== g); res.notes.push(`removed tag ${g}`); did = true; } }
        else if (a.type === 'assign' && v){ if (!t.assignees.includes(v)){ t.assignees = [v, ...t.assignees]; res.notes.push(`assigned to ${v}`); did = true; } }
        else if (a.type === 'due'){ const n = parseInt(v, 10); if (!isNaN(n)){ const d = addDays(today, n); if (t.due !== d){ t.due = d; if (t.start && t.start > d) t.start = d; res.notes.push(`due ${d}`); did = true; } } }
        else if (a.type === 'dueClear' && t.due){ t.due = ''; res.notes.push('due date cleared'); did = true; }
        else if (a.type === 'flag' && (v === '' || FLAGS[v]) && (t.flag || '') !== v){ t.flag = v; res.notes.push(v ? `flag set to ${FLAGS[v].name}` : 'flag cleared'); did = true; }
        else if (a.type === 'archive' && !t.archived){ res.archive = true; res.notes.push('archived'); did = true; }
      }
      if (did) res.names.push(r.name || 'Rule');
    }
    return res;
  }

  /* ====================== activity feed ====================== */
  function boardActivity(tasks, limit = 200){
    const out = [];
    for (const t of tasks){
      for (const l of t.log || []) out.push({ at:l.at, task:t, text:l.text, kind:'log' });
      for (const c of t.comments || []) out.push({ at:c.at, task:t, text:c.text, by:c.by || '', kind:'comment' });
    }
    out.sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : 0));
    return out.slice(0, limit);
  }

  /* ====================== pasted lines ====================== */
  const DONE_BOX = /^(?:[-*+]\s*)?(?:\[\s*[xX\u2713\u2714]\s*\]|[\u2611\u2612\u2713\u2714\u2705\u25A0\u25FC])\s*/;
  const OPEN_BOX = /^(?:[-*+]\s*)?(?:\[\s*\]|[\u2610\u25A1\u2B1C\u25CB\u25FB])\s*/;
  const BULLET = /^(?:[-*+\u2022\u00B7\u25AA\u25AB\u25E6\u2023\u2013\u2014]|o|\d{1,3}[.)])\s+/;
  /* One task per non-empty line. Leading bullets, numbers and check boxes are dropped (a ticked box means done), #words become
     tags, and indented lines become subtasks of the line above them unless opts.subs is false. */
  function parseTaskLines(text, opts = {}){
    const max = opts.max || 500, subs = opts.subs !== false, tasks = [], stack = []; let count = 0, truncated = false, cur = null;
    for (const raw of String(text || '').replace(/\r/g, '').split('\n')){
      if (!raw.trim()) continue;
      const lead = raw.match(/^[ \t\u00a0]*/)[0].replace(/\t/g, '    ').replace(/\u00a0/g, ' ').length;
      while (stack.length && lead < stack[stack.length - 1]) stack.pop();
      if (!stack.length || lead > stack[stack.length - 1]) stack.push(lead);
      const depth = stack.length - 1;
      let s = raw.trim().replace(/\u00a0/g, ' '), done = false;
      if (DONE_BOX.test(s)){ done = true; s = s.replace(DONE_BOX, ''); } else if (OPEN_BOX.test(s)) s = s.replace(OPEN_BOX, ''); else s = s.replace(BULLET, '');
      const tags = []; s = s.replace(/(^|\s)#([\w-]{1,30})(?=\s|$)/g, (m, sp, tg) => { tags.push(tg.toLowerCase()); return sp; });
      s = s.replace(/\s+/g, ' ').trim().slice(0, 200); if (!/[\p{L}\p{N}]/u.test(s)) continue;   // a lone bullet or box is not a task
      if (depth > 0 && subs && cur){ cur.subs.push({ title:s, done }); count++; continue; }
      if (tasks.length >= max){ truncated = true; break; }
      cur = { title:s, done, tags:[...new Set(tags)], subs:[] }; tasks.push(cur); count++;
    }
    return { tasks, count, truncated };
  }

  /* ====================== CSV ====================== */
  function toCSV(rows){
    const cell = v => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return '\ufeff' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }
  function parseCSV(text){
    text = String(text || '').replace(/^\ufeff/, '');
    const first = text.split(/\r?\n/, 1)[0] || '';
    const count = ch => (first.match(new RegExp(ch === '\t' ? '\\t' : '\\' + ch, 'g')) || []).length;
    const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++){
      const c = text[i];
      if (q){
        if (c === '"'){ if (text[i + 1] === '"'){ cur += '"'; i++; } else q = false; } else cur += c;
      } else if (c === '"' && cur === '') q = true;
      else if (c === delim){ row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r'){ if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; rows.push(row); row = []; }
      else cur += c;
    }
    if (cur !== '' || row.length){ row.push(cur); rows.push(row); }
    return rows.filter(r => r.some(x => String(x).trim() !== ''));
  }
  const CSV_HEAD = ['Title', 'Description', 'Stage', 'Importance', 'Start', 'Due', 'Workload', 'Tags', 'Assigned To', 'Project', 'Board', 'Subtasks', 'Archived', 'Created'];
  function customText(f, t){
    const v = t.custom && t.custom[f.id]; if (v == null || v === '' || v === false) return '';
    if (f.type === 'label'){ const o = (f.options || []).find(x => x.id === v); return o ? o.name : ''; }
    if (f.type === 'check') return 'Yes';
    return String(v);
  }
  /* ctx = { boards, projects, fields (custom fields to include) } */
  function tasksToCSV(tasks, ctx = {}){
    const fields = ctx.fields || [], bn = id => ((ctx.boards || []).find(b => b.id === id) || {}).name || '', pn = id => ((ctx.projects || []).find(p => p.id === id) || {}).name || '';
    const rows = [[...CSV_HEAD, ...fields.map(f => f.name)]];
    for (const t of tasks) rows.push([t.title, t.description, stageName(t, ctx.boards), t.importance, t.start, t.due, fmtEst(t.estimate), t.tags.join('; '), (t.assignees || []).join('; '), pn(t.projectId), bn(t.boardId),
      (t.subitems || []).map(s => s.title).join('; '), t.archived ? 'Yes' : '', (t.created || '').slice(0, 10), ...fields.map(f => customText(f, t))]);
    return toCSV(rows);
  }
  function looseDate(s){
    s = String(s || '').trim(); if (!s) return '';
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); if (m){ const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; }
    const d = new Date(s); return isNaN(d) ? '' : fmtISO(d);
  }
  const STAGE_HINTS = [[/done|complete|closed|finished|resolved/, 'done'], [/review|approv|await|waiting/, 'review'], [/progress|doing|active|started|wip/, 'in-progress'],
    [/up ?next|next up|soon/, 'up-next'], [/near/, 'near-term'], [/long|someday|later|backlog|hold/, 'long-term'], [/sched/, 'scheduled'], [/consider|idea|inbox|new|todo|to-?do|open/, 'consider']];
  /* Pick a stage id from `stages` (default: the standard set) for a free-text stage name. */
  function guessStage(name, stages){
    stages = stages && stages.length ? stages : core.defaultStages();
    const first = (stages.find(x => !x.done) || stages[0]).id, done = (stages.find(x => x.done) || stages[stages.length - 1]).id;
    const k = slug(name); if (!k) return first;
    const exact = stages.find(c => slug(c.name) === k || c.id === name); if (exact) return exact.id;
    const low = String(name).toLowerCase();
    for (const [re, id] of STAGE_HINTS) if (re.test(low)){ if (id === 'done') return done; const m = stages.find(x => x.id === id); if (m) return m.id; }
    return first;
  }
  const guessPriority = v => { const s = String(v || '').toLowerCase(); return /high|urgent|critical|^p1/.test(s) ? 'high' : /low|minor|^p3/.test(s) ? 'low' : 'medium'; };
  /* A number from 1 to 10 is taken as it is; words (High, Low, Urgent, P1...) become 8, 3 or 5. */
  const guessImportance = v => { const n = clampImp(String(v == null ? '' : v).trim().replace(/\/10$/, '')); return n != null && /^\s*\d+(\.\d+)?\s*(\/\s*10)?\s*$/.test(String(v)) ? n : IMP_BAND[guessPriority(v)]; };
  const HEAD_ALIASES = {
    title:['title', 'name', 'task', 'summary', 'subject'], description:['description', 'notes', 'details', 'body'], stage:['stage', 'status', 'column', 'state', 'list'],
    priority:['priority', 'importance'], start:['start', 'start date', 'scheduled', 'begin'], due:['due', 'due date', 'deadline', 'end date'],
    estimate:['workload', 'estimate', 'time estimate', 'effort', 'hours'], tags:['tags', 'labels', 'categories'], assignees:['assigned to', 'assignee', 'assignees', 'owner', 'members'],
    project:['project'], subtasks:['subtasks', 'checklist', 'subitems'], done:['done', 'completed', 'complete'], archived:['archived']
  };
  /* ctx = { board (target board with custom fields), projects, now }. Returns { tasks, newProjects, stats, warnings, headers }. */
  function csvToTasks(text, ctx = {}){
    const rows = parseCSV(text), warnings = [];
    if (rows.length < 2) return { tasks:[], newProjects:[], stats:{ rows:0, skipped:0 }, warnings:['The file has no rows to import.'], headers:{} };
    const head = rows[0].map(h => String(h).trim().toLowerCase());
    const col = {}; for (const [k, names] of Object.entries(HEAD_ALIASES)){ const i = head.findIndex(h => names.includes(h)); if (i >= 0) col[k] = i; }
    if (col.title == null){ col.title = 0; warnings.push('No "Title" column found, so the first column is used for titles.'); }
    const fields = (ctx.board && ctx.board.fields && ctx.board.fields.custom) || [];
    const cfCols = []; for (const f of fields){ const i = head.indexOf(f.name.toLowerCase()); if (i >= 0) cfCols.push([f, i]); }
    const projects = (ctx.projects || []).slice(), newProjects = [], tasks = []; let skipped = 0;
    const get = (r, k) => (col[k] == null ? '' : String(r[col[k]] ?? '').trim());
    const truthy = v => /^(yes|y|true|1|x|done)$/i.test(String(v).trim());
    for (const r of rows.slice(1)){
      const title = get(r, 'title').slice(0, 200); if (!title){ skipped++; continue; }
      const t = newTask({ boardId: ctx.board ? ctx.board.id : '', title });
      t.description = get(r, 'description');
      const stages = ctx.board && ctx.board.stages;
      t.status = guessStage(get(r, 'stage'), stages);
      if (truthy(get(r, 'done'))) t.status = ((stages || core.defaultStages()).find(x => x.done) || {}).id || 'done';
      t.importance = guessImportance(get(r, 'priority')); t.priority = bandOf(t.importance);
      t.start = looseDate(get(r, 'start')); t.due = looseDate(get(r, 'due'));
      if (t.start && t.due && t.start > t.due) t.start = t.due;
      t.estimate = parseEst(get(r, 'estimate'));
      t.tags = get(r, 'tags').split(/[;,]/).map(x => x.trim().toLowerCase()).filter(Boolean);
      t.assignees = get(r, 'assignees').split(/[;,]/).map(x => x.trim()).filter(Boolean);
      t.subitems = get(r, 'subtasks').split(';').map(x => x.trim()).filter(Boolean).map(x => ({ id:uid(), title:x, done:false, taskId:null }));
      const pn = get(r, 'project');
      if (pn){ let p = projects.find(x => x.name.toLowerCase() === pn.toLowerCase()); if (!p){ p = { id:uid(), name:pn, h:262, updated:nowISO() }; projects.push(p); newProjects.push(p); } t.projectId = p.id; }
      for (const [f, i] of cfCols){
        const v = String(r[i] ?? '').trim(); if (!v) continue;
        if (f.type === 'label'){ const o = (f.options || []).find(x => x.name.toLowerCase() === v.toLowerCase()); if (o) t.custom[f.id] = o.id; }
        else if (f.type === 'check') t.custom[f.id] = truthy(v);
        else if (f.type === 'number'){ const n = parseFloat(v); if (!isNaN(n)) t.custom[f.id] = n; }
        else if (f.type === 'date') t.custom[f.id] = looseDate(v);
        else t.custom[f.id] = v;
      }
      if (t.status === 'scheduled') t.scheduledFlow = true; else t.locked = true;
      if (truthy(get(r, 'archived'))){ t.archived = true; t.archivedAt = nowISO(); }
      logTask(t, 'Imported from CSV');
      tasks.push(t);
    }
    return { tasks, newProjects, stats:{ rows: rows.length - 1, skipped }, warnings, headers: col };
  }

  /* ====================== calendar file (.ics) ====================== */
  const icsText = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  function fold(line){
    const out = []; let cur = '', bytes = 0;
    for (const ch of line){
      const n = byteLen(ch);
      if (bytes + n > 74){ out.push(cur); cur = ' ' + ch; bytes = 1 + n; } else { cur += ch; bytes += n; }
    }
    out.push(cur); return out.join('\r\n');
  }
  const byteLen = ch => { const c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; };
  /* One all-day event per task that has a date. A task with a start and a due date becomes one event spanning both. */
  function toICS(tasks, { name = 'Cursus CoS', now, includeDone = false, boards } = {}){
    const stamp = (now || new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const d8 = s => s.replace(/-/g, '');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cursus CoS//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:' + icsText(name)];
    let n = 0;
    for (const t of tasks){
      if ((!t.start && !t.due) || t.archived || (!includeDone && isDoneTask(t, boards))) continue;
      const s = t.start || t.due, e = t.due || t.start;
      lines.push('BEGIN:VEVENT', `UID:${t.id}@cursus-cos`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d8(s)}`, `DTEND;VALUE=DATE:${d8(addDays(e < s ? s : e, 1))}`,
        'SUMMARY:' + icsText(t.title));
      const desc = [t.description, `Stage: ${stageName(t, boards)}`, `Importance: ${t.importance}/10`].filter(Boolean).join('\n');
      lines.push('DESCRIPTION:' + icsText(desc));
      if (t.tags.length) lines.push('CATEGORIES:' + t.tags.map(icsText).join(','));
      lines.push(isDoneTask(t, boards) ? 'STATUS:COMPLETED' : 'STATUS:CONFIRMED', 'END:VEVENT'); n++;
    }
    lines.push('END:VCALENDAR');
    return { text: lines.map(fold).join('\r\n') + '\r\n', count: n };
  }

  /* ====================== print and email ====================== */
  /* ctx = { title, boardName(id), projName(id), fields } */
  function printHTML(tasks, mode, ctx = {}){
    const when = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    const head = `<h1>${esc(ctx.title || 'Tasks')}</h1><p class="sub">${tasks.length} task${tasks.length === 1 ? '' : 's'} · printed ${esc(when)}</p>`;
    if (mode === 'list'){
      const body = unionStages(ctx.boards).map(c => {
        const ts = tasks.filter(t => stageKeyOf(t, ctx.boards) === c.key).sort((a, b) => a.order - b.order); if (!ts.length) return '';
        return `<h2>${esc(c.name)} <span>${ts.length}</span></h2><ul>${ts.map(t => `<li><span class="bx">${isDoneTask(t, ctx.boards) ? '&#9745;' : '&#9744;'}</span> <b>${esc(t.title)}</b>${t.due ? ` <i>due ${esc(t.due)}</i>` : ''}${t.importance >= 8 ? ` <i>importance ${t.importance}/10</i>` : ''}${(t.assignees || []).length ? ` <i>${esc(t.assignees.join(', '))}</i>` : ''}${(t.subitems || []).length ? `<ul class="sub">${t.subitems.map(s => `<li>${s.done ? '&#9745;' : '&#9744;'} ${esc(s.title)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul>`;
      }).join('');
      return head + body;
    }
    const U = unionStages(ctx.boards), at = t => U.findIndex(c => c.key === stageKeyOf(t, ctx.boards));
    const rows = tasks.slice().sort((a, b) => at(a) - at(b) || a.order - b.order);
    return head + `<table><thead><tr><th>Task</th><th>Stage</th><th>Importance</th><th>Start</th><th>Due</th><th>Workload</th><th>Assigned</th><th>Tags</th></tr></thead><tbody>${rows.map(t =>
      `<tr><td>${esc(t.title)}</td><td>${esc(stageName(t, ctx.boards))}</td><td>${t.importance}</td><td>${esc(t.start)}</td><td>${esc(t.due)}</td><td>${esc(fmtEst(t.estimate))}</td><td>${esc((t.assignees || []).join(', '))}</td><td>${esc(t.tags.join(', '))}</td></tr>`).join('')}</tbody></table>`;
  }
  /* Plain text for an email body, kept short enough for a mailto: link. */
  function mailBody(tasks, ctx = {}, max = 1500){
    let out = `${ctx.title || 'Tasks'}\n\n`;
    for (const c of unionStages(ctx.boards)){
      const ts = tasks.filter(t => stageKeyOf(t, ctx.boards) === c.key).sort((a, b) => a.order - b.order); if (!ts.length) continue;
      out += `${c.name} (${ts.length})\n`;
      for (const t of ts){ const line = `- ${t.title}${t.due ? ` (due ${t.due})` : ''}\n`; if ((out + line).length > max) return out + `…and more. Export a CSV for the full list.\n`; out += line; }
      out += '\n';
    }
    return out;
  }

  return { esc, slug, stageOf, stageName, unionStages, stageKeyOf, stageIdByKey, groupOptions, groupDefs, dueBucket, DUE_GROUPS, SORT_KEYS, sortTasks, RULE_TRIGGERS, DATE_OFFSETS, RULE_ACTIONS, applyRules, boardActivity,
    customText, toCSV, parseCSV, tasksToCSV, csvToTasks, looseDate, guessStage, guessPriority, guessImportance, parseTaskLines, toICS, printHTML, mailBody };
});
