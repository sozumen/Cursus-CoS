/* Cursus CoS email ingest adapters.
   An adapter turns one incoming message (in the provider's own shape) into a task draft.
   Today only the Microsoft Graph / Exchange mapping exists. The thing that FETCHES mail
   (a Graph poller in the Windows app's main process, or a relay service) is not built yet;
   whatever it is, it just calls CoS.api.ingestEmails(messages, 'exchange'). */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const CoS = (root.CoS = root.CoS || {});

  const adapters = {
    exchange: {
      name: 'Microsoft Exchange',
      toTask(m, cfg){
        if (!m || !m.id) return null;
        const flagged = m.flag && m.flag.flagStatus === 'flagged';
        if (cfg.onlyFlagged && !flagged) return null;
        const from = m.from && m.from.emailAddress ? m.from.emailAddress : {};
        const dueRaw = cfg.mapFlagDue && m.flag && m.flag.dueDateTime && m.flag.dueDateTime.dateTime;
        const startRaw = cfg.mapFlagDue && m.flag && m.flag.startDateTime && m.flag.startDateTime.dateTime;
        const tags = ['email'].concat(cfg.mapCategories ? (m.categories || []).map(x => String(x).toLowerCase()) : []);
        return {
          title: (m.subject || '(no subject)').slice(0, 200),
          description: `From: ${from.name || ''} <${from.address || 'unknown'}>\n\n${m.bodyPreview || ''}`.trim(),
          priority: cfg.mapImportance && m.importance === 'high' ? 'high' : cfg.mapImportance && m.importance === 'low' ? 'low' : 'medium',
          due: dueRaw ? dueRaw.slice(0, 10) : '', start: startRaw ? startRaw.slice(0, 10) : '',
          tags: [...new Set(tags)],
          external: { source: 'exchange', id: m.id, conversationId: m.conversationId || '', webLink: m.webLink || '', from: from.name || from.address || '', received: m.receivedDateTime || '' }
        };
      }
    }
  };

  /* ---------- Gmail: tags in the subject ----------
     #task                      a new task (the tag is optional text; this just makes it explicit)
     #sub  Parent: the item     an unfinished subtask on the task named before the colon
     #subdone  Parent: the item a finished subtask (or, if that item already exists unfinished, it gets ticked off)
     A reply in the thread of a task that came from email needs no "Parent:" part: the thread says which task it is.
     The tag may also be the first line of the body, which is handy when you reply and do not want to edit the subject. */
  const TAG_RE = /(^|[\s(\[])#(subdone|subtask|sub|task)\b[:\-]?/i;
  const KIND = { task: 'task', sub: 'sub', subtask: 'sub', subdone: 'subdone' };
  const stripRe = s => String(s || '').replace(/^\s*((re|fwd?|aw|sv)\s*:\s*)+/i, '').trim();
  function parseTag(subject, body){
    let m = TAG_RE.exec(stripRe(subject));
    if (m){ const t = stripRe(subject); return { kind: KIND[m[2].toLowerCase()], text: (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').replace(/^[\s:\-]+|[\s]+$/g, '').trim(), where: 'subject' }; }
    const first = String(body || '').split('\n').map(x => x.trim()).find(Boolean) || '';
    m = /^#(subdone|subtask|sub|task)\b[:\-]?\s*(.*)$/i.exec(first);
    if (m) return { kind: KIND[m[1].toLowerCase()], text: m[2].trim(), where: 'body', subjectText: stripRe(subject) };
    return null;
  }
  const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const toks = s => new Set(norm(s).split(' ').filter(w => w.length > 1));
  /* The task a subtask email belongs to. `open` are the tasks to choose from. */
  function findParent(hint, threadId, open){
    if (threadId){
      const t = open.find(x => x.external && x.external.source === 'gmail' && x.external.threadId === threadId);
      if (t) return t;
    }
    const h = norm(hint); if (!h) return null;
    const exact = open.find(x => norm(x.title) === h); if (exact) return exact;
    const part = open.filter(x => { const n = norm(x.title); return n && (n.includes(h) || h.includes(n)) && Math.min(n.length, h.length) >= 4; })
      .sort((a, b) => Math.abs(norm(a.title).length - h.length) - Math.abs(norm(b.title).length - h.length));
    if (part.length) return part[0];
    const ht = toks(hint); if (!ht.size) return null;
    let best = null, bs = 0;
    for (const x of open){ const xt = toks(x.title); let n = 0; for (const w of ht) if (xt.has(w)) n++; const sc = n / (ht.size + xt.size - n || 1); if (sc > bs){ bs = sc; best = x; } }
    return bs >= 0.6 ? best : null;
  }
  const addrOf = a => String(a || '').toLowerCase().trim();
  function senderOk(from, own, allowFrom){
    const list = String(allowFrom || '').split(/[,;\s]+/).map(addrOf).filter(Boolean); if (own) list.push(addrOf(own));
    return !!addrOf(from) && list.includes(addrOf(from));
  }
  /* What to do with one message: { action:'task', draft } | { action:'sub', parent, title, done, note } | { action:'skip', reason }.
     `open` are the existing tasks a subtask may attach to. */
  function planGmail(m, open, cfg, own){
    if (!m || !m.id) return { action: 'skip', reason: 'empty' };
    if (!senderOk(m.from, own, cfg.allowFrom)) return { action: 'skip', reason: 'sender' };
    const tag = parseTag(m.subject, m.body); if (!tag) return { action: 'skip', reason: 'no tag' };
    const ext = { source: 'gmail', id: m.id, threadId: m.threadId || '', from: m.fromName || m.from || '', received: m.date || '' };
    const asTask = note => ({ action: 'task', note, draft: {
      title: ((tag.where === 'body' ? (tag.text || tag.subjectText) : tag.text) || '(no subject)').slice(0, 200),
      description: `From: ${m.fromName ? m.fromName + ' ' : ''}<${m.from}>\n\n${String(m.body || '').replace(/^\s*#\w+[^\n]*\n?/, '').trim().slice(0, 1500)}`.trim(),
      priority: 'medium', tags: ['email'], external: ext } });
    if (tag.kind === 'task') return asTask('');
    let hint = '', text = tag.text;
    const i = text.indexOf(':');
    if (i > 0 && !/^https?$/i.test(text.slice(0, i))){ hint = text.slice(0, i).trim(); text = text.slice(i + 1).trim(); }
    const parent = findParent(hint, m.threadId, open);
    if (!parent){
      if (!hint && !text) return { action: 'skip', reason: 'empty subtask' };
      const t = asTask(hint ? `No task matched "${hint}", so this became a new task.` : 'The email did not say which task it belongs to, so this became a new task.');
      t.draft.title = (hint ? hint + ': ' : '') + text || t.draft.title; t.draft.title = t.draft.title.slice(0, 200); return t;
    }
    if (!text && hint && !parent) return { action: 'skip', reason: 'empty subtask' };
    if (!text) text = tag.where === 'body' ? (tag.subjectText || '') : hint;   // "#sub Parent" alone: nothing to add
    if (!text || norm(text) === norm(parent.title)) return { action: 'skip', reason: 'empty subtask' };
    return { action: 'sub', parent, title: text.slice(0, 200), done: tag.kind === 'subdone', ext };
  }
  adapters.gmail = { name: 'Gmail', parseTag, planGmail };

  function sampleMail(addDays, todayStr){
    const d = n => addDays(todayStr(), n);
    return { id: 'AAMkAGI2-sample-001', subject: 'Please review the revised SOW by Friday', bodyPreview: 'Hi team, attached is the revised statement of work for the managed services renewal. Pricing in section 4 has changed.',
      receivedDateTime: new Date().toISOString(), importance: 'high', isRead: false,
      flag: { flagStatus: 'flagged', dueDateTime: { dateTime: d(3) + 'T17:00:00.0000000', timeZone: 'UTC' } }, categories: ['Contracts', 'Finance'],
      from: { emailAddress: { name: 'Dana Whitfield', address: 'dana.whitfield@contoso.com' } }, webLink: 'https://outlook.office.com/mail/', conversationId: 'AAQkAGI2-conv-001', hasAttachments: true };
  }

  CoS.ingest = { adapters, sampleMail, norm, parseTag, findParent, senderOk, planGmail };
  if (typeof module === 'object' && module.exports) module.exports = CoS.ingest;
})();
