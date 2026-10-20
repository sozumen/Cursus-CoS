/* Cursus CoS core: pure logic with no DOM, storage or platform code.
   Runs in the browser, in Electron's renderer and in Node (for tests).
   Everything that must behave identically on every device (automation rules, reminder timing,
   data normalising, sync merge) lives here. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CoS = root.CoS || {}; root.CoS.core = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA = 2;
  const APP = 'cursus-cos';
  const LEGACY_APPS = ['cos-tasks'];   // sync files written before the rename

  /* ---------- constants ---------- */
  const COLS = [
    { id:'consider',    name:'Consider',    h:215, s:16 },
    { id:'scheduled',   name:'Scheduled',   h:268, s:52 },
    { id:'long-term',   name:'Long-Term',   h:32,  s:42 },
    { id:'near-term',   name:'Near-Term',   h:203, s:70 },
    { id:'up-next',     name:'Up Next',     h:172, s:58 },
    { id:'in-progress', name:'In Progress', h:42,  s:80 },
    { id:'review',      name:'Review',      h:326, s:58 },
    { id:'done',        name:'Done',        h:142, s:48 }
  ];
  const COL = Object.fromEntries(COLS.map(c => [c.id, c]));
  /* Stages are per board (board.stages). COLS is only the standard set a new board starts with. Exactly one stage per
     board is flagged done:true (the "completed" stage). A stage's id never changes; its name can. */
  const stageKey = name => String(name == null ? '' : name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'stage';
  const defaultStages = () => COLS.map(c => Object.assign({}, c, c.id === 'done' ? { done:true } : {}));
  const STAGE_COLORS = [
    { name:'Slate', h:215, s:16 }, { name:'Purple', h:268, s:52 }, { name:'Brown', h:32, s:42 }, { name:'Blue', h:203, s:70 },
    { name:'Teal', h:172, s:58 }, { name:'Amber', h:42, s:80 }, { name:'Pink', h:326, s:58 }, { name:'Green', h:142, s:48 },
    { name:'Red', h:4, s:72 }, { name:'Orange', h:24, s:85 }, { name:'Indigo', h:240, s:60 }, { name:'Lime', h:84, s:55 }
  ];
  const MAX_STAGES = 20;
  function normalizeStages(b){
    const seen = new Set(), keys = new Set(), out = [];
    for (const x of (Array.isArray(b.stages) ? b.stages : [])){
      if (!x || typeof x.id !== 'string' || !x.id || seen.has(x.id) || out.length >= MAX_STAGES) continue;
      seen.add(x.id);
      let name = String(x.name == null ? x.id : x.name).trim().slice(0, 40) || x.id, base = name, n = 2;
      while (keys.has(stageKey(name))) name = base.slice(0, 36) + ' ' + n++;
      keys.add(stageKey(name));
      const h = Number.isFinite(+x.h) ? Math.max(0, Math.min(360, +x.h)) : 215, sat = Number.isFinite(+x.s) ? Math.max(0, Math.min(100, +x.s)) : 16;
      out.push(Object.assign({ id:x.id, name, h, s:sat }, x.done ? { done:true } : {}));
    }
    if (!out.length) out.push(...defaultStages());
    let d = out.findIndex(x => x.done);
    if (d < 0) d = out.findIndex(x => x.id === 'done');
    if (d < 0) d = out.length - 1;
    out.forEach((x, i) => { if (i === d) x.done = true; else delete x.done; });
    b.stages = out;
    return out;
  }
  const doneIdOf = b => { const s = b && b.stages && b.stages.find(x => x.done); return s ? s.id : 'done'; };
  const boardIn = (boards, id) => !boards ? null : Array.isArray(boards) ? boards.find(x => x.id === id) : boards.get ? boards.get(id) : null;
  /* Is this task in its board's completed stage? `boards` is optional: without it the standard 'done' id is assumed. */
  const isDoneTask = (t, boards) => { const b = boardIn(boards, t.boardId); return b ? t.status === doneIdOf(b) : t.status === 'done'; };
  /* The stage id on `to` that best matches a status from board `from`: same id, else same name, else the completed
     stage if it was completed, else the first stage that is not the completed one. */
  function mapStatus(status, from, to){
    const ts = to.stages;
    if (ts.some(x => x.id === status)) return status;
    const fs = from && from.stages && from.stages.find(x => x.id === status);
    if (fs){ const k = stageKey(fs.name), m = ts.find(x => stageKey(x.name) === k); if (m) return m.id; if (fs.done) return doneIdOf(to); }
    return (ts.find(x => !x.done) || ts[0]).id;
  }
  const PRI = { low:{label:'Low',rank:1,h:150,s:45}, medium:{label:'Medium',rank:2,h:40,s:80}, high:{label:'High',rank:3,h:4,s:72} };
  /* Importance is a number from 1 to 10. `priority` (low / medium / high) is still stored next to it as the band the number
     falls in (1-3, 4-7, 8-10), so a device running an older version keeps working; if the two ever disagree it was an
     older version that changed `priority`, and that change wins. */
  const IMP_BAND = { low:3, medium:5, high:8 };
  const bandOf = n => n >= 8 ? 'high' : n >= 4 ? 'medium' : 'low';
  const clampImp = v => { const n = Math.round(Number(v)); return v !== '' && v != null && n >= 1 && n <= 10 ? n : null; };
  const impColor = n => { const k = (clampImp(n) || 5) - 1; return { h: Math.round(150 - k * 146 / 9), s: Math.round(45 + k * 27 / 9) }; };
  /* A spec is what a rule, filter or colour rule stores to say which importances it means: a band name ("high"),
     a range ("4-7"), "N or more" ("6+") or one exact number ("7"). Empty means any. */
  function impMatch(imp, spec){
    if (spec == null || spec === '') return true;
    const s = String(spec); let m;
    if (IMP_BAND[s]) return bandOf(imp) === s;
    if ((m = s.match(/^(\d+)-(\d+)$/))) return imp >= +m[1] && imp <= +m[2];
    if ((m = s.match(/^(\d+)\+$/))) return imp >= +m[1];
    return Number(s) === imp;
  }
  const impOf = t => clampImp(t.importance) || IMP_BAND[t.priority] || 5;
  function syncImp(t){
    let n = clampImp(t.importance); if (n == null) n = IMP_BAND[t.priority] || 5;
    t.importance = n; t.priority = bandOf(n); return t;
  }
  function setImp(t, v){ const n = clampImp(v); if (n == null) return false; const ch = n !== t.importance; t.importance = n; t.priority = bandOf(n); return ch; }
  const FLAGS = {
    red:{h:4,s:72,name:'Red'}, orange:{h:24,s:85,name:'Orange'}, yellow:{h:48,s:85,name:'Yellow'},
    green:{h:145,s:48,name:'Green'}, blue:{h:214,s:78,name:'Blue'}, purple:{h:268,s:55,name:'Purple'}, pink:{h:326,s:65,name:'Pink'}
  };

  /* ---------- small utilities ---------- */
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const nowISO = () => new Date().toISOString();
  const clone = o => JSON.parse(JSON.stringify(o));
  const pad = n => String(n).padStart(2, '0');
  const fmtISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayStr = () => fmtISO(new Date());
  const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return fmtISO(d); };
  const diffDays = (a, b) => {
    const [ay, am, ad] = a.split('-').map(Number), [by, bm, bd] = b.split('-').map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 864e5);
  };
  function merge(a, b){
    for (const k in b){
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], b[k]);
      else a[k] = b[k];
    }
    return a;
  }
  function hashId(str){ let h = 5381; for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0; return h & 0x7fffffff; }

  /* ---------- tasks ---------- */
  function newTask(p = {}){
    const now = nowISO();
    const t = Object.assign({
      id: uid(), boardId:'', projectId:null, title:'', description:'', status:'consider', priority:'medium', importance:null,
      start:'', due:'', estimate:0, tags:[], deps:[], subitems:[], reminder:null, repeat:null, fired:{}, flag:'', parentId:null,
      source:'manual', external:null, order:0, locked:false, scheduledFlow:false, autoMoved:null,
      archived:false, archivedAt:'', doneAt:'', prevStatus:'',
      assignees:[], attachments:[], comments:[], custom:{},
      created:now, updated:now, log:[]
    }, p);
    return syncImp(t);
  }
  function logTask(t, text){ t.log = t.log || []; t.log.push({ at: nowISO(), text }); if (t.log.length > 40) t.log.shift(); }
  function isBlocked(t, all, boards){
    if (isDoneTask(t, boards) || !t.deps || !t.deps.length) return false;
    return t.deps.some(id => { const d = all.find(x => x.id === id); return d && !d.archived && !isDoneTask(d, boards); });
  }
  function dueState(t, today, boards){
    if (!t.due || isDoneTask(t, boards)) return '';
    const d = diffDays(today, t.due);
    return d < 0 ? 'overdue' : d === 0 ? 'today' : d <= 2 ? 'soon' : '';
  }

  /* Automation: returns [{t, from, to, why}] without mutating anything. */
  function autoMove(tasks, A, today, boards){
    const moves = [];
    if (!A || !A.enabled) return moves;
    for (const t of tasks){
      if (isDoneTask(t, boards) || t.locked || t.archived || isStuckChild(t, tasks)) continue;
      const st = t.status, blocked = isBlocked(t, tasks, boards);
      let target = null, why = '';
      if (A.scheduled && t.scheduledFlow && t.start && (st === 'scheduled' || st === 'near-term')){
        const dd = diffDays(today, t.start);
        if (dd <= A.upNextDays){
          target = blocked ? (st === 'scheduled' ? 'near-term' : null) : 'up-next';
          why = dd <= 0 ? 'start date reached' : `starts in ${dd}d`;
        } else if (st === 'scheduled' && dd <= A.nearTermDays){
          target = 'near-term'; why = `starts in ${dd}d`;
        }
      }
      const hi = `importance ${impOf(t)}`;
      if (!target && A.urgent && impOf(t) >= (clampImp(A.urgentMin) || 8) && t.due && (st === 'consider' || st === 'long-term' || st === 'near-term')){
        const dd = diffDays(today, t.due);
        if (dd <= A.urgentDays){
          target = blocked ? (st === 'near-term' ? null : 'near-term') : 'up-next';
          why = dd < 0 ? `${hi} and overdue` : dd === 0 ? `${hi}, due today` : `${hi}, due in ${dd}d`;
        } else if (dd <= A.soonDays && st !== 'near-term'){
          target = 'near-term'; why = `${hi}, due in ${dd}d`;
        }
      }
      const tb = boardIn(boards, t.boardId);   // the rules name the standard stages; a board without that stage is left alone
      if (target && target !== st && (!tb || tb.stages.some(x => x.id === target))) moves.push({ t, from: st, to: target, why });
    }
    return moves;
  }

  /* ---------- repeating tasks ----------
     A task with `repeat` makes one new copy when it is completed or deleted (the app calls nextOccurrence then). The copy carries
     the same repeat setting, so the series goes on; the finished one stops repeating, so it can never make a second copy. */
  const REPEAT_UNITS = { day:'day', weekday:'weekday', week:'week', month:'month', year:'year' };
  function addInterval(s, n, unit){
    if (unit === 'day') return addDays(s, n);
    if (unit === 'week') return addDays(s, 7 * n);
    if (unit === 'weekday'){ let d = s, left = Math.abs(n); const step = n < 0 ? -1 : 1; while (left > 0){ d = addDays(d, step); const w = parseD(d).getDay(); if (w !== 0 && w !== 6) left--; } return d; }
    const [y, m, dd] = s.split('-').map(Number), tm = y * 12 + (m - 1) + (unit === 'year' ? 12 * n : n), ny = Math.floor(tm / 12), nm = tm % 12;
    return `${ny}-${pad(nm + 1)}-${pad(Math.min(dd, new Date(ny, nm + 1, 0).getDate()))}`;   // Jan 31 plus a month is Feb 28/29
  }
  const normRepeat = r => {
    if (!r || typeof r !== 'object') return null;
    return { every: Math.max(1, Math.min(999, Math.round(Number(r.every)) || 1)), unit: REPEAT_UNITS[r.unit] || 'week', from: r.from === 'completion' ? 'completion' : 'schedule', stage: r.stage || '' };
  };
  function repeatLabel(r){ r = normRepeat(r); return r ? (r.every === 1 ? `Every ${r.unit}` : `Every ${r.every} ${r.unit}s`) : ''; }
  /* Dates of the next copy, for a task finished or deleted on `today`. "schedule" counts on from the due (else start) date,
     skipping any that are already past; "completion" counts from today. Start and due keep the same gap. */
  function nextDates(t, today){
    const r = normRepeat(t.repeat); if (!r) return null;
    const anchor = t.due || t.start; let na;
    if (!anchor || r.from === 'completion') na = addInterval(today, r.every, r.unit);
    else { let k = 1; na = addInterval(anchor, r.every, r.unit); while (na < today && k < 5000){ k++; na = addInterval(anchor, r.every * k, r.unit); } }
    if (!anchor) return { start:'', due:na };
    const delta = diffDays(anchor, na);
    return { start: t.start ? addDays(t.start, delta) : '', due: t.due ? addDays(t.due, delta) : '', delta };
  }
  function nextOccurrence(t, boards, today){
    const r = normRepeat(t.repeat); if (!r) return null;
    const dates = nextDates(t, today), b = boardIn(boards, t.boardId), stages = b ? b.stages : defaultStages();
    const status = (r.stage && stages.some(x => x.id === r.stage) && r.stage) || (dates.start && stages.some(x => x.id === 'scheduled') ? 'scheduled' : (stages.find(x => !x.done) || stages[0]).id);
    const rem = t.reminder ? Object.assign({}, t.reminder, { ack:null, notified:null, snoozedUntil:null }) : null;
    if (rem && rem.type === 'at' && rem.at){ const [dp, tp] = rem.at.split('T'); rem.at = addDays(dp, dates.delta || 0) + (tp ? 'T' + tp : ''); }
    return newTask({ boardId:t.boardId, projectId:t.projectId, title:t.title, description:t.description, status, importance:t.importance, start:dates.start, due:dates.due,
      estimate:t.estimate, tags:(t.tags || []).slice(), assignees:(t.assignees || []).slice(), flag:t.flag, reminder:rem, repeat:r, custom:clone(t.custom || {}), attachments:clone(t.attachments || []),
      subitems:(t.subitems || []).map(x => ({ id:uid(), title:x.title, done:false, taskId:null })), scheduledFlow: status === 'scheduled' });
  }
  /* A subtask made into a task can "stick" with its parent: it follows the parent between stages and boards. */
  const isStuckChild = (t, tasks) => { if (!t.parentId) return false; const p = tasks.find(x => x.id === t.parentId); return !!p && (p.subitems || []).some(x => x.taskId === t.id && x.stick); };

  /* Done tasks remember when they were finished (doneAt) so the Done column can show the latest first and
     the auto-archive rule can tell how old they are. Called before every save and when data is loaded. */
  function reconcileDone(tasks, now, boards){
    let n = 0;
    for (const t of tasks){
      if (isDoneTask(t, boards)){ if (!t.doneAt){ t.doneAt = t.updated || now || nowISO(); n++; } }
      else if (t.doneAt){ t.doneAt = ''; n++; }
    }
    return n;
  }
  /* Tasks the "archive Done tasks after N days" rule would archive. Pure; the caller applies it. */
  function autoArchive(tasks, A, nowMs, boards){
    if (!A || !A.enabled || !(A.archiveDays > 0)) return [];
    const cutoff = nowMs - A.archiveDays * 864e5;
    return tasks.filter(t => isDoneTask(t, boards) && !t.archived && t.doneAt && Date.parse(t.doneAt) < cutoff);
  }

  /* Reminder fire time (a Date) or null. `rt` is the "HH:MM" used for date-based reminders. */
  function fireTime(t, rt){
    const r = t.reminder; if (!r) return null;
    if (r.snoozedUntil) return new Date(r.snoozedUntil);
    if (r.type === 'at') return r.at ? new Date(r.at) : null;
    const base = r.type === 'before_due' ? t.due : t.start;
    if (!base) return null;
    const [hh, mm] = (rt || '09:00').split(':').map(Number);
    const d = parseD(base); d.setDate(d.getDate() - (r.days || 0)); d.setHours(hh, mm, 0, 0);
    return d;
  }
  function parseEst(str){
    if (str == null) return 0;
    const s = String(str).trim().toLowerCase(); if (!s) return 0;
    let m = 0, any = false;
    const h = s.match(/(\d+(?:\.\d+)?)\s*h/); if (h){ m += parseFloat(h[1]) * 60; any = true; }
    const mi = s.match(/(\d+(?:\.\d+)?)\s*m/); if (mi){ m += parseFloat(mi[1]); any = true; }
    if (!any){ const n = parseFloat(s); if (!isNaN(n)) m = n; }
    return Math.max(0, Math.round(m));
  }
  function fmtEst(min){
    if (!min) return '';
    const h = Math.floor(min / 60), m = min % 60;
    return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
  }

  /* ---------- settings (device-local) ---------- */
  const emptyFilters = () => ({ status:[], priority:[], tags:[], projects:[], due:'any', blocked:false, reminder:false, hideDone:false, email:false, archived:false });
  const DEFAULTS = () => ({
    theme:'auto', view:'board', colorBy:'status', boardsSel:[], filters:emptyFilters(),
    bg:{ type:'none', value:'', dim:0 }, calStarts:true, reminderTime:'09:00',
    automation:{ enabled:true, scheduled:true, nearTermDays:7, upNextDays:0, urgent:true, urgentMin:8, urgentDays:2, soonDays:7, archiveDays:0 },
    followUp:{ ask:true }, viewSel:{}, subscribed:[], personalTags:{}, ruleFired:{}, me:'', addons:{ ical:true, colors:true, email:true },
    importMaps:{ zenkit:{ stages:{}, priorities:{} } },
    importPrefs:{ zenkit:{ archiveDays:30, keepStageTag:true, workloadUnit:'hours' } },
    integrations:{ exchange:{ enabled:false, folder:'Inbox', targetBoard:'', targetColumn:'consider', onlyFlagged:false, mapImportance:true, mapFlagDue:true, mapCategories:true } }
  });
  const SYNC_DEFAULTS = () => ({ mode:'off', url:'', auth:'', clientId:'', last:null, error:'' });

/* ---------- boards: members, fields, views, rules, colors ----------
   A board carries its own configuration (saved views, which task fields show and in what order, custom fields,
   automation rules, colour rules, members) so it syncs with the board. normalizeBoard fills in anything missing,
   so boards written by earlier versions, or by another device, always come out complete. */
  const VIEW_TYPES = ['kanban', 'list', 'table', 'calendar'];
  /* Built-in task fields. zone says where the task editor puts it. */
  const BUILTIN_FIELDS = [
    { id:'stage',       name:'Stage',        zone:'side', icon:'tag',         fixed:true },
    { id:'description', name:'Description',  zone:'main', icon:'align-left' },
    { id:'dates',       name:'Start and Due Date', zone:'side', icon:'calendar' },
    { id:'reminder',    name:'Reminder',     zone:'side', icon:'bell' },
    { id:'repeat',      name:'Repeat',       zone:'side', icon:'repeat' },
    { id:'priority',    name:'Importance',   zone:'side', icon:'flag' },
    { id:'assignees',   name:'Assigned To',  zone:'side', icon:'user' },
    { id:'attachments', name:'Attachments',  zone:'main', icon:'paperclip' },
    { id:'estimate',    name:'Workload',     zone:'side', icon:'timer' },
    { id:'project',     name:'Project',      zone:'side', icon:'folder' },
    { id:'tags',        name:'Tags',         zone:'side', icon:'tag' },
    { id:'subitems',    name:'Subtasks',     zone:'main', icon:'list-checks' },
    { id:'deps',        name:'Dependencies', zone:'main', icon:'link-2' },
    { id:'flag',        name:'Flag color',   zone:'side', icon:'palette' }
  ];
  const FIELD_TYPES = { text:'Text', number:'Number', date:'Date', label:'Label', check:'Checkbox' };
  const newView = (type, name, p) => Object.assign({ id: uid(), type, name: name || ({ kanban:'Kanban', list:'List', table:'Table', calendar:'Calendar' })[type],
    group:'status', vgroup:'', agg:'both', sort:'manual', sortDir:1, detail:2 }, p || {});
  const defaultViews = () => VIEW_TYPES.map(t => newView(t, null, { id:'v-' + t }));   // fixed ids, so a board that has not been saved yet still resolves the same view next load
  function normalizeBoard(b){
    b.members = Array.isArray(b.members) ? b.members.filter(m => m && m.name) : [];
    b.folder = b.folder || '';
    const stages = normalizeStages(b);
    b.template = Object.assign({ status:'consider', priority:'medium', tags:[], estimate:0, assignees:[] }, b.template || {});
    { const tp = b.template; tp.importance = clampImp(tp.importance) || IMP_BAND[tp.priority] || 5; tp.priority = bandOf(tp.importance); }
    b.rules = Array.isArray(b.rules) ? b.rules : [];
    for (const r of b.rules) for (const a of (r && r.actions) || []) if (a && a.type === 'priority' && IMP_BAND[a.value]) a.value = String(IMP_BAND[a.value]);   // "set priority to high" is now "set importance to 8"
    if (!stages.some(x => x.id === b.template.status)) b.template.status = (stages.find(x => !x.done) || stages[0]).id;
    const f = b.fields = Object.assign({ order:[], hidden:[], custom:[] }, b.fields || {});
    f.custom = (f.custom || []).filter(c => c && c.id && c.name).map(c => Object.assign({ type:'text', options:[], desc:'' }, c, { type: FIELD_TYPES[c.type] ? c.type : 'text' }));
    const valid = new Set([...BUILTIN_FIELDS.map(x => x.id), ...f.custom.map(c => 'cf:' + c.id)]);
    const seen = new Set(); f.order = (f.order || []).filter(id => valid.has(id) && !seen.has(id) && seen.add(id));
    for (const id of valid) if (!seen.has(id)) f.order.push(id);
    if (!(f.layout >= 2)){   // version 2: Reminder and Repeat sit right under the dates (a board's own order is respected after this)
      f.layout = 2; f.order = f.order.filter(id => id !== 'reminder' && id !== 'repeat');
      const at = f.order.indexOf('dates'); f.order.splice(at < 0 ? f.order.length : at + 1, 0, 'reminder', 'repeat');
    }
    f.hidden = (f.hidden || []).filter(id => valid.has(id) && id !== 'stage');
    b.rules = Array.isArray(b.rules) ? b.rules.filter(r => r && r.id) : [];
    b.views = Array.isArray(b.views) && b.views.length ? b.views.filter(v => v && v.id && VIEW_TYPES.includes(v.type)).map(v => Object.assign(newView(v.type, v.name), v)) : [];
    if (!b.views.length) b.views = defaultViews();
    b.defaultView = b.views.some(v => v.id === b.defaultView) ? b.defaultView : '';
    b.colors = Object.assign({ by:'', rules:[] }, b.colors || {});
    return b;
  }
  const newBoard = (p = {}) => normalizeBoard(Object.assign({ id: uid(), name:'My board', h:205, updated: nowISO() }, p));

  /* ---------- data shape & normalising ----------
     State = { v, sample, boards[], projects[], tasks[], tombstones[], meta{deviceId, sync}, settings }
     boards / projects / tasks / tombstones are SHARED data (synced). meta + settings stay on the device. */
  function fixRefs(d){
    d.boards.forEach(normalizeBoard);
    if (!d.boards.length) d.boards.push(newBoard());
    const bmap = new Map(d.boards.map(b => [b.id, b])), bid = new Set(d.boards.map(b => b.id)), tid = new Set(d.tasks.map(t => t.id)), pid = new Set(d.projects.map(p => p.id));
    for (const t of d.tasks){
      if (!bid.has(t.boardId)) t.boardId = d.boards[0].id;
      if (IMP_BAND[t.priority] && clampImp(t.importance) && bandOf(clampImp(t.importance)) !== t.priority) t.importance = IMP_BAND[t.priority];   // changed by an older version
      syncImp(t); t.repeat = normRepeat(t.repeat);
      const tb = bmap.get(t.boardId);   // a stage deleted on another device, or a board that never had it
      if (!tb.stages.some(x => x.id === t.status)) t.status = t.status === 'done' ? doneIdOf(tb) : (tb.stages.find(x => !x.done) || tb.stages[0]).id;
      t.deps = (t.deps || []).filter(x => tid.has(x) && x !== t.id);
      if (t.projectId && !pid.has(t.projectId)) t.projectId = null;
      if (t.parentId && !tid.has(t.parentId)) t.parentId = null;
      for (const s of t.subitems || []) if (s.taskId && !tid.has(s.taskId)) s.taskId = null;
    }
    d.settings.boardsSel = (d.settings.boardsSel || []).filter(id => bid.has(id));
    d.settings.filters.projects = (d.settings.filters.projects || []).filter(id => pid.has(id));
    { const fp = d.settings.filters; const out = []; for (const v of fp.priority || []){ const ns = IMP_BAND[v] ? (v === 'low' ? ['1', '2', '3'] : v === 'medium' ? ['4', '5', '6', '7'] : ['8', '9', '10']) : [String(v)]; for (const n of ns) if (!out.includes(n)) out.push(n); } fp.priority = out; }   // filters saved with Low / Medium / High
    reconcileDone(d.tasks, undefined, d.boards);
    return d;
  }
  /* A backup can come from an older version, another device or a hand-edited file, so every collection is cleaned
     before use: entries must be objects, ids are filled in and unique, and anything that should be a list is a list. */
  const asArr = v => Array.isArray(v) ? v : [];
  function cleanRecords(list){
    const seen = new Map();
    for (const r of asArr(list)){
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      const rec = Object.assign({}, r); if (typeof rec.id !== 'string' || !rec.id){ rec.id = rec.id == null || rec.id === '' ? uid() : String(rec.id); }
      const cur = seen.get(rec.id); if (!cur || Date.parse(rec.updated) >= Date.parse(cur.updated) || !(Date.parse(cur.updated) > 0)) seen.set(rec.id, rec);
    }
    return [...seen.values()];
  }
  function normalize(d){
    d = d && typeof d === 'object' ? d : {};
    d.v = SCHEMA;
    d.boards = cleanRecords(d.boards).map(b => {
      b = Object.assign({ updated: nowISO() }, b);
      for (const k of ['stages', 'rules', 'views', 'members']) if (b[k] !== undefined && !Array.isArray(b[k])) b[k] = [];
      if (b.fields && typeof b.fields === 'object'){ b.fields = Object.assign({}, b.fields); for (const k of ['order', 'hidden', 'custom']) if (b.fields[k] !== undefined && !Array.isArray(b.fields[k])) b.fields[k] = []; } else b.fields = undefined;
      if (b.fields === undefined) delete b.fields;
      if (!b.template || typeof b.template !== 'object') delete b.template;
      if (b.colors && (typeof b.colors !== 'object' || (b.colors.rules != null && !Array.isArray(b.colors.rules)))) b.colors = { by:'', rules:[] };
      return b;
    });
    d.projects = cleanRecords(d.projects).map(p => Object.assign({ updated: nowISO() }, p));
    const TASK_SHAPE = newTask({});
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    d.tasks = cleanRecords(d.tasks).map(t => {
      // keep only values of the right type; anything else falls back to the default for that field
      for (const k of Object.keys(TASK_SHAPE)){
        if (!(k in t) || k === 'id' || TASK_SHAPE[k] === null) continue;
        const def = TASK_SHAPE[k], v = t[k];
        if (Array.isArray(def) ? !Array.isArray(v) : typeof def === 'string' ? typeof v !== 'string' : typeof def === 'number' ? typeof v !== 'number' || !isFinite(v) : typeof def === 'boolean' ? typeof v !== 'boolean' : isObj(def) ? !isObj(v) : false) delete t[k];
      }
      for (const k of ['start', 'due']) if (t[k] && !/^\d{4}-\d{2}-\d{2}/.test(t[k])) t[k] = '';
      if (t.reminder != null && !isObj(t.reminder)) t.reminder = null;
      if (t.external != null && !isObj(t.external)) t.external = null;
      if (Array.isArray(t.subitems)) t.subitems = t.subitems.filter(isObj);
      if (Array.isArray(t.comments)) t.comments = t.comments.filter(isObj);
      if (Array.isArray(t.log)) t.log = t.log.filter(isObj);
      if (IMP_BAND[t.priority] && clampImp(t.importance) && bandOf(clampImp(t.importance)) !== t.priority) t.importance = IMP_BAND[t.priority];
      return newTask(t);
    });
    const limit = Date.now() - 90 * 864e5;
    d.tombstones = asArr(d.tombstones).filter(x => x && x.id && x.kind && Date.parse(x.updated) > limit);
    d.meta = Object.assign({ deviceId: uid() + uid() }, d.meta && typeof d.meta === 'object' ? d.meta : {});
    d.meta.sync = Object.assign(SYNC_DEFAULTS(), d.meta.sync && typeof d.meta.sync === 'object' ? d.meta.sync : {});
    { const def = DEFAULTS();   // a setting of the wrong kind (text where a list belongs, say) falls back to its default
      const fit = (dv, v) => { if (v == null) return dv; if (Array.isArray(dv)) return Array.isArray(v) ? v : dv; if (isObj(dv)){ if (!isObj(v)) return dv; const o = Object.assign({}, v); for (const k of Object.keys(dv)) if (k in o) o[k] = fit(dv[k], o[k]); return o; } return typeof dv === typeof v ? v : dv; };
      d.settings = merge(def, fit(def, d.settings && typeof d.settings === 'object' ? d.settings : {})); }
    return fixRefs(d);
  }

  /* ---------- change stamping ----------
     Rather than remembering to touch `updated` at every mutation, the store compares each record with a
     hash taken the last time it was saved and stamps `updated` on anything that changed. */
  const recHash = r => { const c = Object.assign({}, r); delete c.updated; return JSON.stringify(c); };
  const COLLECTIONS = [['board', 'boards'], ['project', 'projects'], ['task', 'tasks']];
  function resetHashes(S, hashes){
    for (const k of Object.keys(hashes)) delete hashes[k];
    for (const [kind, coll] of COLLECTIONS) for (const r of S[coll]) hashes[kind + ':' + r.id] = recHash(r);
  }
  function stampChanges(S, hashes, now){
    let n = 0;
    for (const [kind, coll] of COLLECTIONS) for (const r of S[coll]){
      const k = kind + ':' + r.id, h = recHash(r);
      if (hashes[k] !== h){ r.updated = now; hashes[k] = h; n++; }
    }
    return n;
  }

  /* ---------- sync merge (last write wins per record, with tombstones for deletes) ---------- */
  function extractData(S){
    return { app: APP, schema: SCHEMA, deviceId: S.meta.deviceId, exportedAt: nowISO(), boards: S.boards, projects: S.projects, tasks: S.tasks, tombstones: S.tombstones };
  }
  const isSyncPayload = d => !!d && Array.isArray(d.boards) && Array.isArray(d.projects) && Array.isArray(d.tasks) && (d.app === undefined || d.app === APP || LEGACY_APPS.includes(d.app));
  const ts = r => Date.parse(r && r.updated) || 0;
  function mergeData(local, remote){
    const tomb = new Map();
    for (const t of [...(local.tombstones || []), ...(remote.tombstones || [])]){
      const k = t.kind + ':' + t.id, cur = tomb.get(k);
      if (!cur || ts(t) > ts(cur)) tomb.set(k, t);
    }
    const out = {};
    for (const [kind, coll] of COLLECTIONS){
      const m = new Map();
      for (const r of local[coll] || []) m.set(r.id, r);
      for (const r of remote[coll] || []){ const cur = m.get(r.id); m.set(r.id, cur && ts(cur) >= ts(r) ? cur : r); }
      out[coll] = [];
      for (const [id, r] of m){
        const t = tomb.get(kind + ':' + id);
        if (t && ts(t) >= ts(r)) continue;     // deleted more recently than last edit
        if (t) tomb.delete(kind + ':' + id);   // edited after the delete: the record lives
        out[coll].push(clone(r));
      }
    }
    out.tombstones = [...tomb.values()].map(clone);
    return out;
  }
  function signature(d){
    const part = c => (d[c] || []).map(r => r.id + '@' + (r.updated || '')).sort().join(',');
    return [part('boards'), part('projects'), part('tasks'), (d.tombstones || []).map(t => t.kind + ':' + t.id + '@' + t.updated).sort().join(',')].join('|');
  }

  /* ---------- sample data ---------- */
  function seed(){
    const t0 = todayStr(), d = n => addDays(t0, n), now = nowISO();
    const boards = [
      { id:'b_ops', name:'Operations', h:205, updated:now }, { id:'b_launch', name:'Product Launch', h:330, updated:now }, { id:'b_home', name:'Personal', h:150, updated:now }
    ];
    const projects = [
      { id:'p_vendor', name:'Q4 Vendor Review', h:262, updated:now }, { id:'p_move', name:'Office Move', h:32, updated:now }, { id:'p_site', name:'Website Relaunch', h:330, updated:now }
    ];
    const K = {}; let order = 0;
    const add = (k, o) => { const t = newTask(Object.assign({ order: (order += 10) }, o)); if (o.status === 'scheduled') t.scheduledFlow = true; K[k] = t; return t; };
    add('cloud',   { boardId:'b_ops', projectId:'p_vendor', title:'Renew cloud hosting contract', status:'consider', priority:'high', due:d(2), estimate:60, tags:['finance','vendor'], description:'Current term ends this month. Confirm seat count before signing.' });
    add('quotes',  { boardId:'b_ops', projectId:'p_vendor', title:'Collect vendor quotes', status:'in-progress', priority:'medium', start:d(-3), due:d(4), estimate:180, tags:['vendor'],
                     subitems:[{id:uid(),title:'Request quote from Acme Systems',done:true,taskId:null},{id:uid(),title:'Request quote from Northwind IT',done:false,taskId:null},{id:uid(),title:'Build pricing comparison sheet',done:false,taskId:null}] });
    add('short',   { boardId:'b_ops', projectId:'p_vendor', title:'Approve Q4 vendor shortlist', status:'review', priority:'medium', due:d(6), estimate:45, tags:['vendor'], flag:'purple' });
    add('access',  { boardId:'b_ops', title:'Quarterly access review', status:'scheduled', priority:'medium', start:d(4), due:d(10), estimate:120, tags:['security'] });
    add('fire',    { boardId:'b_ops', title:'Annual fire-safety inspection', status:'scheduled', priority:'low', start:d(30), due:d(34), tags:['facilities'] });
    add('desks',   { boardId:'b_ops', projectId:'p_move', title:'Order standing desks', status:'long-term', priority:'low', due:d(60), estimate:30, tags:['facilities'] });
    add('hand',    { boardId:'b_ops', title:'Update employee handbook', status:'long-term', priority:'medium', due:d(75), tags:['hr'] });
    add('movers',  { boardId:'b_ops', projectId:'p_move', title:'Book moving company', status:'near-term', priority:'high', due:d(9), estimate:40, reminder:{ type:'before_due', days:7 } });
    add('comms',   { boardId:'b_ops', projectId:'p_move', title:'Draft office-move comms plan', status:'up-next', priority:'medium', due:d(3), estimate:90, tags:['comms'] });
    add('expense', { boardId:'b_ops', title:'Submit expense report', status:'up-next', priority:'medium', due:d(-2), estimate:25, tags:['finance'], reminder:{ type:'at', at:d(-2) + 'T09:00' } });
    add('inv',     { boardId:'b_ops', title:'Reconcile October invoices', status:'done', priority:'low', due:d(-4), estimate:75, tags:['finance'] });
    add('msg',     { boardId:'b_launch', projectId:'p_site', title:'Finalize launch messaging', status:'in-progress', priority:'high', start:d(-2), due:d(3), estimate:240, tags:['marketing'], flag:'purple' });
    const pricing = add('pricing', { boardId:'b_launch', projectId:'p_site', title:'Design pricing page', status:'in-progress', priority:'medium', due:d(7), estimate:300, tags:['design'] });
    const cmp = add('cmp', { boardId:'b_launch', projectId:'p_site', title:'Plan comparison table', status:'up-next', priority:'medium', due:d(5), estimate:120, tags:['design'], parentId:pricing.id });
    pricing.subitems = [
      { id:uid(), title:'Hero layout', done:true, taskId:null },
      { id:uid(), title:'Plan comparison table', done:false, taskId:cmp.id },
      { id:uid(), title:'Mobile pass', done:false, taskId:null }
    ];
    add('qa',      { boardId:'b_launch', projectId:'p_site', title:'QA checklist for launch', status:'review', priority:'high', due:d(8), estimate:150, deps:[pricing.id], tags:['qa'] });
    add('press',   { boardId:'b_launch', title:'Assemble press kit', status:'consider', priority:'medium', tags:['marketing','pr'] });
    add('golive',  { boardId:'b_launch', projectId:'p_site', title:'Launch day: go live', status:'scheduled', priority:'high', start:d(21), due:d(21), estimate:120, tags:['launch'] });
    add('retro',   { boardId:'b_launch', title:'Post-launch retro', status:'long-term', priority:'low', due:d(35) });
    add('pass',    { boardId:'b_home', title:'Renew passport', status:'consider', priority:'medium', due:d(45), tags:['admin'] });
    add('dent',    { boardId:'b_home', title:'Dentist appointment', status:'scheduled', priority:'low', start:d(12), due:d(12) });
    add('hike',    { boardId:'b_home', title:'Plan weekend hike', status:'near-term', priority:'low', due:d(5), estimate:60, flag:'blue', tags:['outdoors'] });
    add('sow',     { boardId:'b_ops', title:'Review revised SOW from Contoso', description:'From: Dana Whitfield <dana.whitfield@contoso.com>\n\nAttached is the revised statement of work for the managed services renewal.', status:'consider', priority:'high', due:d(5), tags:['contracts','email'], source:'exchange', external:{ source:'exchange', id:'seed-sow-1', from:'Dana Whitfield' } });
    K.short.deps = [K.quotes.id];
    const tasks = Object.values(K);
    tasks.forEach(t => logTask(t, 'Created'));
    return normalize({ sample:true, boards, projects, tasks, tombstones:[] });
  }

  return {
    SCHEMA, APP, COLS, COL, STAGE_COLORS, MAX_STAGES, stageKey, defaultStages, normalizeStages, doneIdOf, isDoneTask, mapStatus, PRI, IMP_BAND, bandOf, clampImp, impOf, REPEAT_UNITS, addInterval, normRepeat, repeatLabel, nextDates, nextOccurrence, isStuckChild, impColor, impMatch, syncImp, setImp, FLAGS, VIEW_TYPES, BUILTIN_FIELDS, FIELD_TYPES,
    uid, nowISO, clone, pad, fmtISO, parseD, todayStr, addDays, diffDays, merge, hashId,
    newBoard, normalizeBoard, newView, defaultViews, newTask, logTask, isBlocked, dueState, autoMove, reconcileDone, autoArchive, fireTime, parseEst, fmtEst,
    emptyFilters, DEFAULTS, SYNC_DEFAULTS, normalize, fixRefs, recHash, resetHashes, stampChanges,
    extractData, isSyncPayload, mergeData, signature, seed
  };
});
