/* Cursus CoS Zenkit importer: pure logic, no DOM. Runs in the browser and in Node (for tests).

   parse(json)          reads a Zenkit "Export as JSON" file into a neutral shape
   build(parsed, opts)  turns that into Cursus CoS tasks (nothing is saved here)
   guessColumn(name)    first guess for where a Zenkit stage should land; the import dialog lets you change it

   What the Zenkit export contains (checked against a real export):
     list      the list itself
     elements  the list's fields (Title, Stage, Due Date, Tags ...), each with a uuid and a numeric category
     entries   the tasks. Values live under "<field uuid>_<kind>" keys, e.g. "<uuid>_text", "<uuid>_categories".
               Entries with deprecated_at set were archived or deleted in Zenkit.
   Not in the export: comment text, attachment files, the repeat schedule of recurring tasks. */
(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const core = isNode ? require('./core.js') : root.CoS.core;
  const api = factory(core);
  if (isNode) module.exports = api; else { root.CoS = root.CoS || {}; root.CoS.zenkit = api; }
})(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';
  const { COLS, newTask, logTask, uid, fmtISO } = core;
  const COL_IDS = new Set(COLS.map(c => c.id));
  const CAT = { TEXT: 1, NUMBER: 2, DATE: 4, SELECT: 6, PERSON: 14, FILES: 15, SUBTASKS: 18, DEPENDENCIES: 19 };
  const SYSTEM_CATS = new Set([8, 9, 11, 12]);   // created / updated / created by / updated by
  const key = s => String(s == null ? '' : s).trim().toLowerCase();
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  /* ---------- guesses (all overridable in the import dialog) ---------- */
  const COLUMN_GUESS = [
    ['near-term',   /not[ -]?started|to[ -]?do|todo/],
    ['done',        /\b(done|complete|completed|closed|finished|resolved|shipped)\b/],
    ['in-progress', /in[ -]?progress|doing|working|started|active|wip/],
    ['review',      /review|testing|\bqa\b|approv|verify|await|waiting|reply|feedback/],
    ['long-term',   /hold|paused|later|someday|backlog|project|long|roadmap|parked/],
    ['scheduled',   /schedul|planned|upcoming|calendar/],
    ['up-next',     /up[ -]?next|next|ready|queue/],
    ['near-term',   /open|new|now|soon|near|current|this week/],
    ['consider',    /idea|consider|discuss|triage|inbox|maybe|propos|research/]
  ];
  function guessColumn(name){
    const s = key(name), sl = slug(name);
    for (const c of COLS) if (sl === c.id || sl === slug(c.name)) return c.id;   // exact match wins
    for (const [col, re] of COLUMN_GUESS) if (re.test(s)) return col;
    return 'consider';
  }
  function guessPriority(name){
    const s = key(name);
    if (/normal|medium|moderate|standard|default/.test(s)) return 'medium';
    if (/low|nice|minor|someday|trivial/.test(s)) return 'low';
    if (/crit|urgent|blocker|highest|high|asap|top|\bp0\b|\bp1\b/.test(s)) return 'high';
    return 'medium';
  }

  /* ---------- small converters ---------- */
  function htmlToText(s){
    return String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n').trim();
  }
  function toDate(v){
    if (!v) return '';
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    return isNaN(d) ? '' : fmtISO(d);
  }
  const fmtSize = n => !n ? '' : n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

  /* ---------- parse ---------- */
  function parse(json){
    if (!json || typeof json !== 'object' || !json.list || !Array.isArray(json.elements) || !Array.isArray(json.entries))
      throw new Error('This does not look like a Zenkit JSON export. It should contain "list", "elements" and "entries".');
    const els = json.elements.filter(e => e && !e.deprecated_at);
    const byCat = c => els.filter(e => e.elementcategory === c);
    const first = (arr, re, skip) => arr.find(e => !(skip || []).includes(e) && re.test(e.name || ''));

    const title = els.find(e => e.isPrimary) || byCat(CAT.TEXT)[0] || null;
    const texts = byCat(CAT.TEXT).filter(e => e !== title);
    const description = first(texts, /desc|note|detail|summary/i) || texts[0] || null;
    const selects = byCat(CAT.SELECT);
    const stage = first(selects, /stage|status|state|column|phase/i) || selects[0] || null;
    const priority = first(selects, /prior|importan|urgen/i, [stage]) || null;
    const tags = first(selects, /tag|label|categor/i, [stage, priority]) || null;
    const dates = byCat(CAT.DATE);
    const due = first(dates, /due|deadline|finish|end/i) || dates[0] || null;
    const scheduled = first(dates, /schedul|start|begin|plan/i, [due]) || dates.find(e => e !== due) || null;
    const workload = first(byCat(CAT.NUMBER), /workload|estimate|effort|time|hours|duration/i) || null;
    const assigned = byCat(CAT.PERSON)[0] || null, files = byCat(CAT.FILES)[0] || null;
    const subtasks = byCat(CAT.SUBTASKS)[0] || null, deps = byCat(CAT.DEPENDENCIES)[0] || null;
    const used = new Set([title, description, stage, priority, tags, due, scheduled, workload, assigned, files, subtasks, deps].filter(Boolean));
    const unmapped = els.filter(e => !used.has(e) && !SYSTEM_CATS.has(e.elementcategory) && !e.isAutoCreated).map(e => e.name).filter(Boolean);

    const catMap = el => {
      const m = new Map();
      const list = el && el.elementData && el.elementData.predefinedCategories;
      for (const c of list || []) m.set(c.id, c.name || '');
      return m;
    };
    const stageCats = catMap(stage), priCats = catMap(priority), tagCats = catMap(tags);

    // ids -> names, learned from who created / updated entries
    const people = new Map();
    for (const e of json.entries){
      if (e.created_by != null && e.created_by_displayname) people.set(e.created_by, e.created_by_displayname);
      if (e.updated_by != null && e.updated_by_displayname) people.set(e.updated_by, e.updated_by_displayname);
    }
    const get = (e, el, suf) => (el ? e[el.uuid + '_' + suf] : undefined);
    const names = (e, el, cats) => (get(e, el, 'categories') || []).map(id => cats.get(id)).filter(Boolean);

    const entries = json.entries.map((e, i) => {
      const so = parseFloat(e.sortOrder);
      const dueDate = toDate(get(e, due, 'date')), dueEnd = toDate(get(e, due, 'endDate'));
      const filesData = get(e, files, 'filesData');
      const fl = Array.isArray(filesData) ? filesData : [];
      const textType = get(e, description, 'textType');
      const rawDesc = get(e, description, 'text') || '';
      return {
        uuid: e.uuid, shortId: e.shortId, archived: !!e.deprecated_at, archivedAt: e.deprecated_at || '',
        title: String(get(e, title, 'text') || e.displayString || '').trim(),
        description: textType === 'html' ? htmlToText(rawDesc) : String(rawDesc).trim(),
        stageNames: names(e, stage, stageCats), priorityNames: names(e, priority, priCats), tagNames: names(e, tags, tagCats),
        // a due date with an end date is a range: start .. end
        start: toDate(get(e, scheduled, 'date')) || (dueEnd ? dueDate : ''), due: dueEnd || dueDate,
        workload: typeof get(e, workload, 'number') === 'number' ? get(e, workload, 'number') : 0,
        assignees: (get(e, assigned, 'persons') || []).map(id => people.get(id) || ('user-' + id)),
        attachments: fl.map(f => ({ name: f.fileName || 'file', size: f.size || 0 })),
        parents: get(e, subtasks, 'parents') || [], path: String(get(e, subtasks, 'path') || ''),
        deps: get(e, deps, 'references') || [],
        checklists: (e.checklists || []).map(c => ({ name: c.name || '', items: (c.items || []).filter(x => x && x.text).map(x => ({ text: String(x.text), checked: !!x.checked })) })),
        commentCount: e.comment_count || 0, recurring: !!e.occurrence,
        created: e.created_at || '', updated: e.updated_at || '', sortOrder: isNaN(so) ? i : so
      };
    });
    return {
      listName: String(json.list.name || 'Zenkit list'), entries, unmapped,
      stages: [...stageCats.values()], priorities: [...priCats.values()], hasWorkload: !!workload && entries.some(e => e.workload),
      counts: { live: entries.filter(e => !e.archived).length, archived: entries.filter(e => e.archived).length }
    };
  }

  /* Stage names in use (with task counts) for the mapping table. Tasks with no stage are listed as ''. */
  function stageRows(parsed, includeArchived){
    const rows = new Map();
    for (const name of parsed.stages) rows.set(key(name), { name, key: key(name), count: 0, guess: guessColumn(name) });
    for (const e of parsed.entries){
      if (e.archived && !includeArchived) continue;
      const nm = e.stageNames[0] || '';
      const k = key(nm);
      if (!rows.has(k)) rows.set(k, { name: nm || '(no stage)', key: k, count: 0, guess: guessColumn(nm) });
      rows.get(k).count++;
    }
    return [...rows.values()];
  }
  function priorityRows(parsed, includeArchived){
    const rows = new Map();
    for (const e of parsed.entries){
      if (e.archived && !includeArchived) continue;
      for (const nm of e.priorityNames.slice(0, 1)){
        if (!rows.has(key(nm))) rows.set(key(nm), { name: nm, key: key(nm), count: 0, guess: guessPriority(nm) });
        rows.get(key(nm)).count++;
      }
    }
    return [...rows.values()];
  }

  /* ---------- build ---------- */
  function build(parsed, opts){
    const o = Object.assign({ boardId: '', stageMap: {}, priorityMap: {}, includeArchived: false, archiveDoneDays: 30, keepStageTag: true,
      workloadUnit: 'hours', existing: new Map(), now: new Date() }, opts || {});
    const nowISO = o.now.toISOString(), today = fmtISO(o.now);
    const existing = o.existing instanceof Map ? o.existing : new Map();
    const included = parsed.entries.filter(e => o.includeArchived || !e.archived);

    const colFor = e => {
      const nm = e.stageNames[0];
      if (!nm) return 'consider';
      const mapped = o.stageMap[key(nm)];
      return COL_IDS.has(mapped) ? mapped : guessColumn(nm);
    };
    const priFor = e => {
      const nm = e.priorityNames[0];
      if (!nm) return 'medium';
      const m = o.priorityMap[key(nm)];
      return m === 'low' || m === 'medium' || m === 'high' ? m : guessPriority(nm);
    };

    // Zenkit stamps "updated" on every task when something is changed in bulk, which makes it useless as a finish date.
    // If one day holds a large share of the Done tasks' updates, ignore it and use the due date or the creation date.
    const doneE = included.filter(e => colFor(e) === 'done');
    const perDay = {};
    for (const e of doneE){ const d = (e.updated || '').slice(0, 10); perDay[d] = (perDay[d] || 0) + 1; }
    const threshold = Math.max(25, Math.ceil(doneE.length * 0.2));
    const bulkDays = new Set(Object.keys(perDay).filter(d => perDay[d] >= threshold));
    const doneAtFor = e => {
      if (e.updated && !bulkDays.has(e.updated.slice(0, 10))) return e.updated;
      if (e.due && e.due <= today) return new Date(e.due + 'T12:00:00').toISOString();
      return e.created || e.updated || nowISO;
    };

    const stats = { total: 0, active: 0, byColumn: {}, archivedOnImport: 0, subtasks: 0, checklistItems: 0, recurring: 0, attachments: 0, comments: 0,
      dependencies: 0, droppedDependencies: 0, skippedExisting: 0, skippedArchived: parsed.entries.length - included.length, longTitles: 0,
      bulkEdit: null };
    for (const c of COLS) stats.byColumn[c.id] = 0;
    if (bulkDays.size){ const d = [...bulkDays][0]; stats.bulkEdit = { day: d, count: perDay[d] }; }

    const pairs = [], byUuid = new Map();
    for (const e of included){
      if (existing.has(e.uuid)){ stats.skippedExisting++; continue; }
      const status = colFor(e);
      const stageNm = e.stageNames[0] || '';
      const tags = [];
      const addTag = t => { t = String(t || '').trim().toLowerCase().slice(0, 30); if (t && !tags.includes(t)) tags.push(t); };
      e.tagNames.forEach(addTag);
      if (o.keepStageTag && stageNm && slug(stageNm) !== slug(COLS.find(c => c.id === status).name)) addTag(slug(stageNm));
      if (e.recurring){ addTag('recurring'); stats.recurring++; }
      e.assignees.forEach(a => addTag('@' + slug(a)));

      let title = e.title || '(untitled)';
      const notes = [];
      if (e.description) notes.push(e.description);
      if (title.length > 200){ notes.push('Full title: ' + title); title = title.slice(0, 197) + '...'; stats.longTitles++; }
      if (e.attachments.length){ notes.push('Attachments in Zenkit (the files are not imported): ' + e.attachments.map(a => a.name + (a.size ? ' (' + fmtSize(a.size) + ')' : '')).join(', ')); stats.attachments++; }
      if (e.commentCount) stats.comments++;

      const subitems = [];
      for (const cl of e.checklists) for (const it of cl.items){
        subitems.push({ id: uid(), title: (e.checklists.length > 1 && cl.name ? cl.name + ': ' : '') + it.text.slice(0, 190), done: it.checked, taskId: null });
        stats.checklistItems++;
      }
      const doneLike = status === 'done';
      const doneAt = doneLike ? doneAtFor(e) : '';
      const toArchive = e.archived || (doneLike && o.archiveDoneDays > 0 && Date.parse(doneAt) < o.now.getTime() - o.archiveDoneDays * 864e5);
      const t = newTask({
        boardId: o.boardId, title, description: notes.join('\n\n'), status, priority: priFor(e), start: e.start, due: e.due,
        estimate: e.workload ? Math.round(e.workload * (o.workloadUnit === 'minutes' ? 1 : 60)) : 0,
        tags, subitems, source: 'zenkit', external: { source: 'zenkit', id: e.uuid, shortId: e.shortId, list: parsed.listName },
        // same rule as placing a task by hand: only Scheduled tasks stay under automation's control
        locked: status !== 'scheduled', scheduledFlow: status === 'scheduled',
        created: e.created || nowISO, updated: nowISO, doneAt,
        archived: !!toArchive, archivedAt: toArchive ? (e.archivedAt || nowISO) : ''
      });
      logTask(t, 'Imported from Zenkit (' + parsed.listName + ')');
      if (toArchive) stats.archivedOnImport++;
      pairs.push([e, t]); byUuid.set(e.uuid, t);
    }

    // order: keep Zenkit's manual order in each column; Done shows the most recently finished first
    const groups = {};
    for (const p of pairs) (groups[p[1].status] = groups[p[1].status] || []).push(p);
    for (const [st, list] of Object.entries(groups)){
      list.sort(st === 'done' ? (a, b) => Date.parse(b[1].doneAt) - Date.parse(a[1].doneAt) : (a, b) => a[0].sortOrder - b[0].sortOrder);
      list.forEach((p, i) => { p[1].order = (i + 1) * 10; });
    }

    // subtasks become linked tasks; dependencies are mapped to the new ids
    const idOf = u => (byUuid.has(u) ? byUuid.get(u).id : existing.get(u) || null);
    const kids = new Map();
    for (const [e, t] of pairs){
      const pu = e.parents.find(p => p !== e.uuid && idOf(p));
      if (pu){ t.parentId = idOf(pu); if (byUuid.has(pu)){ if (!kids.has(pu)) kids.set(pu, []); kids.get(pu).push([e, t]); } }
      for (const du of e.deps){ const id = idOf(du); if (id && id !== t.id && !t.deps.includes(id)){ t.deps.push(id); stats.dependencies++; } else if (!id) stats.droppedDependencies++; }
    }
    for (const [pu, list] of kids){
      list.sort((a, b) => (a[0].path < b[0].path ? -1 : a[0].path > b[0].path ? 1 : 0));
      const parent = byUuid.get(pu);
      for (const [, ct] of list){ parent.subitems.push({ id: uid(), title: ct.title, done: ct.status === 'done', taskId: ct.id }); stats.subtasks++; }
    }

    const tasks = pairs.map(p => p[1]);
    stats.total = tasks.length;
    for (const t of tasks) if (!t.archived){ stats.active++; stats.byColumn[t.status]++; }

    const warnings = [];
    if (stats.bulkEdit) warnings.push(`Zenkit shows ${stats.bulkEdit.count} Done tasks as updated on ${stats.bulkEdit.day}, which looks like a bulk change. Their age is judged by due date or creation date instead.`);
    if (stats.recurring) warnings.push(`${stats.recurring} recurring task${stats.recurring === 1 ? '' : 's'}: the export has no repeat schedule, so ${stats.recurring === 1 ? 'it comes' : 'they come'} in as one-off tasks tagged "recurring".`);
    if (stats.attachments) warnings.push(`${stats.attachments} task${stats.attachments === 1 ? ' has' : 's have'} attachments. The files are not in this export, so their names are added to the task notes.`);
    if (stats.comments) warnings.push(`${stats.comments} task${stats.comments === 1 ? ' has' : 's have'} comments in Zenkit. Comment text is not in the export.`);
    if (stats.dependencies) warnings.push('Dependencies are imported as "depends on". The export does not say which way a link points, so check them.');
    if (stats.longTitles) warnings.push(`${stats.longTitles} title${stats.longTitles === 1 ? ' was' : 's were'} longer than 200 characters. The full title is kept in the notes.`);
    if (parsed.unmapped.length) warnings.push('Fields that are not imported: ' + parsed.unmapped.join(', ') + '.');
    return { tasks, stats, warnings };
  }

  return { parse, build, stageRows, priorityRows, guessColumn, guessPriority, slug, key };
});
