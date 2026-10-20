/* Cursus CoS: reads an email that was dragged in from Outlook (or any mail program).
   Understands .msg (Outlook's own file format), .eml (plain RFC 822 text), and, as a last resort,
   dropped text. Pure functions, no DOM, so it is tested under Node.

     CoS.mailfile.parse(name, bytes)  -> { subject, from, fromAddr, date, body, id } or null
     CoS.mailfile.fromText(text)      -> same shape, from whatever text was dropped
     CoS.mailfile.subtaskTitle(mail)  -> the line used when the email is saved as a completed subtask
     CoS.mailfile.noteText(mail)      -> the text used when the email is saved as a note */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { const CoS = (root.CoS = root.CoS || {}); CoS.mailfile = api; }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const td = (enc, bytes) => { try { return new TextDecoder(enc, { fatal: false }).decode(bytes); } catch (e) { return new TextDecoder('utf-8').decode(bytes); } };
  const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  /* ---------- .msg: a Windows "compound file" holding the message properties as little streams ---------- */
  function readCfb(buf){
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const sig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    if (u8.length < 512 || sig.some((b, i) => u8[i] !== b)) throw new Error('not a compound file');
    const ss = 1 << dv.getUint16(0x1E, true), mss = 1 << dv.getUint16(0x20, true);
    const nFat = dv.getUint32(0x2C, true), dirStart = dv.getUint32(0x30, true), cutoff = dv.getUint32(0x38, true);
    const miniStart = dv.getUint32(0x3C, true), nMini = dv.getUint32(0x40, true);
    let difStart = dv.getUint32(0x44, true); const nDif = dv.getUint32(0x48, true);
    const END = 0xFFFFFFFE, FREE = 0xFFFFFFFF;
    const sectorOff = n => (n + 1) * ss;
    const sector = n => { const o = sectorOff(n); if (o + ss > u8.length) throw new Error('sector out of range'); return u8.subarray(o, o + ss); };

    const fatIds = [];
    for (let i = 0; i < 109 && fatIds.length < nFat; i++) fatIds.push(dv.getUint32(0x4C + i * 4, true));
    for (let d = 0; d < nDif && difStart < END; d++){
      const s = sector(difStart), sv = new DataView(s.buffer, s.byteOffset, s.byteLength);
      for (let i = 0; i < ss / 4 - 1 && fatIds.length < nFat; i++) fatIds.push(sv.getUint32(i * 4, true));
      difStart = sv.getUint32(ss - 4, true);
    }
    const fat = [];
    for (const id of fatIds){ const s = sector(id), sv = new DataView(s.buffer, s.byteOffset, s.byteLength); for (let i = 0; i < ss / 4; i++) fat.push(sv.getUint32(i * 4, true)); }

    const chain = (start, table, guard) => { const out = []; let n = start; while (n < END && out.length <= guard){ out.push(n); n = table[n]; if (n === undefined || n === FREE) break; } return out; };
    const join = parts => { let len = 0; for (const p of parts) len += p.length; const o = new Uint8Array(len); let k = 0; for (const p of parts){ o.set(p, k); k += p.length; } return o; };
    const bigRead = (start, size) => join(chain(start, fat, fat.length).map(sector)).subarray(0, size);

    // directory
    const dir = bigRead(dirStart, chain(dirStart, fat, fat.length).length * ss);
    const dd = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    const entries = [];
    for (let o = 0; o + 128 <= dir.length; o += 128){
      const nl = Math.max(0, dd.getUint16(o + 0x40, true) - 2);
      const type = dir[o + 0x42];
      entries.push({ name: type ? td('utf-16le', dir.subarray(o, o + nl)) : '', type, left: dd.getUint32(o + 0x44, true), right: dd.getUint32(o + 0x48, true), child: dd.getUint32(o + 0x4C, true), start: dd.getUint32(o + 0x74, true), size: dd.getUint32(o + 0x78, true) });
    }
    const rootE = entries[0];
    if (!rootE || rootE.type !== 5) throw new Error('no root entry');

    // mini stream (small streams live inside one big stream owned by the root entry)
    let mini = null, miniFat = null;
    const loadMini = () => {
      if (mini) return;
      mini = bigRead(rootE.start, rootE.size);
      miniFat = [];
      for (const n of chain(miniStart, fat, nMini + 1)){ const s = sector(n), sv = new DataView(s.buffer, s.byteOffset, s.byteLength); for (let i = 0; i < ss / 4; i++) miniFat.push(sv.getUint32(i * 4, true)); }
    };
    const stream = e => {
      if (e.size < cutoff){
        loadMini();
        return join(chain(e.start, miniFat, miniFat.length).map(n => mini.subarray(n * mss, n * mss + mss))).subarray(0, e.size);
      }
      return bigRead(e.start, e.size);
    };

    // direct children of the root, found by walking its tree of siblings
    const top = {};
    const seen = new Set(), stack = [rootE.child];
    while (stack.length){
      const i = stack.pop();
      if (i >= entries.length || seen.has(i)) continue; seen.add(i);
      const e = entries[i]; if (!e.type) continue;
      if (e.type === 2) top[e.name.toUpperCase()] = e;
      stack.push(e.left, e.right);
    }
    return { top, stream };
  }

  const fileTime = (u8, o) => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const ms = (dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296) / 1e4 - 11644473600000;
    return ms > 0 && ms < 4102444800000 ? new Date(ms).toISOString() : '';
  };

  function parseMsg(buf){
    const { top, stream } = readCfb(buf);
    const text = id => {
      for (const t of ['001F', '001E']){
        const e = top['__SUBSTG1.0_' + id + t]; if (!e) continue;
        const b = stream(e);
        const s = t === '001F' ? td('utf-16le', b) : td('windows-1252', b);
        return s.replace(/\u0000+$/, '');
      }
      return '';
    };
    let subject = text('0037') || text('0E1D');
    subject = subject.replace(/^\u0001./, '').trim();
    const smtp = text('5D01') || text('0C1F');
    const fromAddr = /@/.test(smtp) ? smtp : (/@/.test(text('0065')) ? text('0065') : '');
    const from = text('0C1A') || text('0042') || fromAddr;
    let body = text('1000');
    if (!body){
      const h = top['__SUBSTG1.0_10130102'] || top['__SUBSTG1.0_1013001F'] || top['__SUBSTG1.0_1013001E'];
      if (h) body = htmlToText(td(/001F$/.test(h.name) ? 'utf-16le' : 'utf-8', stream(h)));
    }
    let date = '';
    const props = top['__PROPERTIES_VERSION1.0'];
    if (props){
      const p = stream(props), pv = new DataView(p.buffer, p.byteOffset, p.byteLength), found = {};
      for (let o = 32; o + 16 <= p.length; o += 16){
        const type = pv.getUint16(o, true), id = pv.getUint16(o + 2, true);
        if (type === 0x40) found[id] = fileTime(p, o + 8);
      }
      date = found[0x0E06] || found[0x0039] || '';
    }
    return { subject, from, fromAddr, date, body: body.replace(/\r\n/g, '\n').trim(), id: text('1035') };
  }

  /* ---------- .eml: headers, then a body that may be split into parts ---------- */
  function decodeWords(s){
    return String(s || '').replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, '$1').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (m, cs, enc, data) => {
      try{
        if (/^b$/i.test(enc)){ const bin = typeof atob === 'function' ? atob(data) : Buffer.from(data, 'base64').toString('binary'); return td(cs, Uint8Array.from(bin, c => c.charCodeAt(0))); }
        const raw = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16)));
        return td(cs, Uint8Array.from(raw, c => c.charCodeAt(0)));
      }catch(e){ return m; }
    });
  }
  function splitMime(raw){
    const m = /\r?\n\r?\n/.exec(raw);
    const head = m ? raw.slice(0, m.index) : raw, body = m ? raw.slice(m.index + m[0].length) : '';
    const headers = {};
    for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)){
      const i = line.indexOf(':'); if (i > 0){ const k = line.slice(0, i).trim().toLowerCase(); if (!(k in headers)) headers[k] = line.slice(i + 1).trim(); }
    }
    return { headers, body };
  }
  function decodeBody(body, enc, charset){
    enc = String(enc || '').toLowerCase(); let bytes;
    if (enc === 'base64'){ const bin = typeof atob === 'function' ? atob(body.replace(/\s+/g, '')) : Buffer.from(body, 'base64').toString('binary'); bytes = Uint8Array.from(bin, c => c.charCodeAt(0)); }
    else if (enc === 'quoted-printable'){
      const raw = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16)));
      bytes = Uint8Array.from(raw, c => c.charCodeAt(0) & 255);
    } else return body;
    return td(charset || 'utf-8', bytes);
  }
  function htmlToText(h){
    return String(h || '').replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function bodyText(part, depth){
    const type = (part.headers['content-type'] || 'text/plain').toLowerCase();
    const cs = (/charset="?([^";\s]+)/i.exec(type) || [])[1];
    if (/^multipart\//.test(type) && depth < 5){
      const bnd = (/boundary="?([^";]+)"?/i.exec(part.headers['content-type'] || '') || [])[1]; if (!bnd) return '';
      const parts = part.body.split('--' + bnd).slice(1).filter(p => !/^--/.test(p)).map(p => splitMime(p.replace(/^\r?\n/, '')));
      let plain = '', html = '';
      for (const p of parts){
        const t = (p.headers['content-type'] || 'text/plain').toLowerCase();
        if (/^multipart\//.test(t)){ const r = bodyText(p, depth + 1); if (r && !plain) plain = r; }
        else if (/^text\/plain/.test(t) && !/attachment/i.test(p.headers['content-disposition'] || '')){ if (!plain) plain = decodeBody(p.body, p.headers['content-transfer-encoding'], (/charset="?([^";\s]+)/i.exec(t) || [])[1]); }
        else if (/^text\/html/.test(t)){ if (!html) html = htmlToText(decodeBody(p.body, p.headers['content-transfer-encoding'], (/charset="?([^";\s]+)/i.exec(t) || [])[1])); }
      }
      return plain || html;
    }
    const txt = decodeBody(part.body, part.headers['content-transfer-encoding'], cs);
    return /^text\/html/.test(type) ? htmlToText(txt) : txt;
  }
  const addrOf = s => { const m = /<([^>]+)>/.exec(s || ''); return m ? m[1] : (/\S+@\S+/.exec(s || '') || [''])[0]; };
  function parseEml(raw){
    const part = splitMime(raw), h = part.headers;
    let date = ''; if (h.date){ const d = new Date(h.date); if (!isNaN(d)) date = d.toISOString(); }
    const fromRaw = decodeWords(h.from || '');
    const name = fromRaw.replace(/<[^>]*>/g, '').replace(/^["'\s]+|["'\s]+$/g, '');
    return { subject: decodeWords(h.subject || '').trim(), from: name || addrOf(fromRaw), fromAddr: addrOf(fromRaw), date, body: bodyText(part, 0).replace(/\r\n/g, '\n').trim(), id: (h['message-id'] || '').trim() };
  }

  /* ---------- entry points ---------- */
  function parse(name, bytes){
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let m = null;
    if (u8.length > 8 && u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) m = parseMsg(u8);
    else if (/\.(eml|mht|txt)$/i.test(name || '') || /^[A-Za-z-]+:/.test(td('utf-8', u8.subarray(0, 40)))) m = parseEml(td('utf-8', u8));
    if (!m || !(m.subject || m.body)) return null;
    if (!m.subject) m.subject = '(no subject)';
    return m;
  }
  function fromText(text){
    const t = String(text || '').replace(/\r\n/g, '\n').trim(); if (!t) return null;
    const hd = {}; for (const k of ['subject', 'from', 'sent', 'date']){ const m = new RegExp('^' + k + ':\\s*(.+)$', 'im').exec(t); if (m) hd[k] = m[1].trim(); }
    const first = t.split('\n').find(l => l.trim()) || '';
    let date = ''; const dv = hd.sent || hd.date; if (dv){ const d = new Date(dv); if (!isNaN(d)) date = d.toISOString(); }
    const fromRaw = hd.from || '';
    return { subject: hd.subject || clip(first.replace(/^https?:\/\/\S+$/, 'Linked email'), 120), from: fromRaw.replace(/<[^>]*>/g, '').trim(), fromAddr: addrOf(fromRaw), date, body: t, id: '' };
  }

  const shortDate = iso => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
  const subtaskTitle = m => clip('Email: ' + m.subject + (m.from ? ' (' + m.from + (m.date ? ', ' + shortDate(m.date) : '') + ')' : m.date ? ' (' + shortDate(m.date) + ')' : ''), 200);
  const noteText = m => clip(['Email: ' + m.subject, m.from ? 'From: ' + m.from + (m.fromAddr && m.fromAddr !== m.from ? ' <' + m.fromAddr + '>' : '') : '', m.date ? 'Date: ' + shortDate(m.date) : '', '', m.body].filter((x, i) => i === 3 || x).join('\n').trim(), 3900);

  return { parse, parseMsg, parseEml, fromText, subtaskTitle, noteText, htmlToText, readCfb };
});
