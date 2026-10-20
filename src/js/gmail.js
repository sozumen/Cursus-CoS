/* Cursus CoS Gmail reader (read-only).

   - Sign-in: Google's "installed app" flow. The app opens your browser at Google, Google sends the browser back to a tiny
     web server that the Windows app runs on 127.0.0.1 for the length of the sign-in, and the app swaps the code for tokens
     (PKCE, so the code is useless to anyone else). Scope: gmail.readonly only. The app can read mail; it cannot send,
     change or delete anything.
   - Reading: it looks for recent messages whose subject mentions task / sub / subdone, downloads only the ones it has not
     seen, and hands them to the ingest logic (ingest.js) as plain { id, threadId, from, subject, date, body } objects.
   - Everything platform specific is injected (http, kv, loopback, openExternal, crypto, now), so this file is unit tested in
     Node with a fake Google. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { const CoS = (root.CoS = root.CoS || {}); CoS.gmailLib = factory(); }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN = 'https://oauth2.googleapis.com/token';
  const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  const KEY = 'cos.gmailauth', KEY2 = 'cos.gmailclient';   // KEY holds the sign-in; KEY2 outlives it: the client ID and secret, plus why the last sign-in ended
  const CLIENT_RE = /^[0-9]+-[0-9a-z_]+\.apps\.googleusercontent\.com$/i;

  const form = o => Object.keys(o).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');
  const parse = t => { try{ return t ? JSON.parse(t) : {}; }catch(e){ return {}; } };
  const b64url = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const fromB64url = s => { s = String(s || '').replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; try{ return decodeURIComponent(escape(atob(s))); }catch(e){ try{ return atob(s); }catch(x){ return ''; } } };
  const stripHtml = h => String(h || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

  function create(deps){
    const now = () => (deps.now || Date.now)();
    let tok = undefined, refreshing = null, lastErr = '';

    async function load(){
      if (tok !== undefined) return tok;
      try{ const raw = await deps.kv.get(KEY); tok = raw ? JSON.parse(raw) : null; }catch(e){ tok = null; }
      return tok;
    }
    let creds;
    async function loadCreds(){
      if (creds !== undefined) return creds;
      try{ const raw = await deps.kv.get(KEY2); creds = raw ? JSON.parse(raw) : null; }catch(e){ creds = null; }
      return creds || (creds = {});
    }
    async function saveCreds(c){ creds = c; try{ await deps.kv.set(KEY2, JSON.stringify(c)); }catch(e){} }
    async function store(t){ tok = t; if (t) lastErr = ''; try{ if (t) await deps.kv.set(KEY, JSON.stringify(t)); else await deps.kv.remove(KEY); }catch(e){} }

    function googleError(r){
      const j = parse(r.text), e = new Error(j.error_description ? String(j.error_description).split(/\r?\n/)[0] : (j.error && j.error.message) || `Google answered ${r.status}`);
      e.code = typeof j.error === 'string' ? j.error : (j.error && j.error.status) || ''; e.status = r.status; return e;
    }
    async function post(url, body){
      try{ return await deps.http({ url, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form(body) }); }
      catch(e){ const x = new Error('Could not reach Google. Check the connection.'); x.network = true; throw x; }
    }

    /* ---------- sign in ---------- */
    async function signIn(clientId, clientSecret){
      clientId = String(clientId || '').trim(); clientSecret = String(clientSecret || '').trim();
      { const sv = await loadCreds(); if (!clientSecret && sv.clientSecret && sv.clientId === clientId) clientSecret = sv.clientSecret; }
      if (!CLIENT_RE.test(clientId)) throw new Error('That does not look like a Google client ID. It ends in .apps.googleusercontent.com');
      if (!clientSecret) throw new Error('Paste the client secret too. Google gives one to every desktop-app client.');
      if (!deps.loopback || !deps.crypto && !globalThis.crypto) throw new Error('Gmail sign-in works in the Windows app.');
      const cr = deps.crypto || globalThis.crypto, rnd = n => b64url(cr.getRandomValues(new Uint8Array(n)));
      const verifier = rnd(32), state = rnd(16);
      const challenge = b64url(new Uint8Array(await cr.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      const { port } = await deps.loopback.start();
      const redirect = 'http://127.0.0.1:' + port;
      const url = AUTH + '?' + form({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' });
      await deps.openExternal(url);
      const back = await deps.loopback.wait();
      if (back.error) throw new Error(back.error === 'access_denied' ? 'Sign-in was cancelled or declined.' : (back.error_description || back.error));
      if (back.state !== state) throw new Error('The sign-in answer did not match this request. Try again.');
      const r = await post(TOKEN, { client_id: clientId, client_secret: clientSecret, code: back.code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect });
      if (r.status !== 200){
        const e = googleError(r);
        if (/invalid_client/.test(e.code)) e.message = 'Google does not accept that client ID and secret together. Check both were copied from the same "Desktop app" client.';
        throw e;
      }
      const j = parse(r.text);
      if (!j.refresh_token) throw new Error('Google did not give this app permission to stay signed in. Remove the app at myaccount.google.com/permissions and sign in again.');
      await store({ clientId, clientSecret, access: j.access_token, exp: now() + (j.expires_in || 3600) * 1000, refresh: j.refresh_token, iat: now(), email: '' });
      await saveCreds({ clientId, clientSecret, err: '' });
      try{ const p = await api('/profile'); if (p.status === 200){ tok.email = String(parse(p.text).emailAddress || '').toLowerCase(); await store(tok); } }catch(e){}
      return { email: tok.email };
    }
    async function signOut(){ await store(null); lastErr = ''; { const sv = await loadCreds(); if (sv.err) await saveCreds({ clientId: sv.clientId, clientSecret: sv.clientSecret, err: '' }); } }

    /* ---------- tokens ---------- */
    async function accessToken(){
      const t = await load();
      if (!t){ const e = new Error('Not signed in to Gmail.'); e.auth = true; throw e; }
      if (t.access && now() < t.exp - 60000) return t.access;
      if (!refreshing){
        refreshing = (async () => {
          const r = await post(TOKEN, { client_id: t.clientId, client_secret: t.clientSecret, refresh_token: t.refresh, grant_type: 'refresh_token' });
          if (r.status !== 200){
            const e = googleError(r);
            if (e.code === 'invalid_grant' || e.code === 'invalid_client'){
              lastErr = (e.code + ': ' + e.message).slice(0, 300); await store(null);
              { const sv = await loadCreds(); await saveCreds({ clientId: sv.clientId || t.clientId, clientSecret: sv.clientSecret || t.clientSecret, err: lastErr, errAt: new Date(now()).toISOString() }); }
              e.message = 'Google ended the Gmail sign-in (' + lastErr + '). Sign in again. If this happens every week, set the Google consent screen to "In production".'; e.auth = true;
            }
            throw e;
          }
          const j = parse(r.text);
          await store(Object.assign({}, t, { access: j.access_token, exp: now() + (j.expires_in || 3600) * 1000, iat: now(), refresh: j.refresh_token || t.refresh }));
          return tok.access;
        })().finally(() => { refreshing = null; });
      }
      return refreshing;
    }
    async function api(path){
      const token = await accessToken();
      return deps.http({ url: API + path, method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    }
    function apiError(r, what){
      const e = googleError(r);
      if (r.status === 401){ const x = new Error('Google refused the Gmail sign-in (' + (e.message || '401') + '). Sign in again.'); x.auth = true; return x; }
      if (r.status === 403) return new Error('Google did not allow that (' + e.message + '). Check the Gmail API is enabled for your project and the consent screen lists your address as a test user.');
      if (r.status === 429) return new Error('Google asked the app to slow down. It will try again later.');
      return new Error(`Gmail ${what} failed (${r.status}${e.message ? ': ' + e.message : ''}).`);
    }

    /* ---------- reading mail ---------- */
    function textOf(payload){
      let plain = '', html = '';
      (function walk(p){
        if (!p) return;
        const mt = String(p.mimeType || '').toLowerCase(), data = p.body && p.body.data;
        if (data && mt === 'text/plain' && !plain) plain = fromB64url(data);
        else if (data && mt === 'text/html' && !html) html = fromB64url(data);
        (p.parts || []).forEach(walk);
      })(payload);
      return (plain || stripHtml(html)).replace(/\r/g, '').trim();
    }
    function toMessage(m){
      const h = {}; for (const x of (m.payload && m.payload.headers) || []) h[String(x.name).toLowerCase()] = x.value;
      const from = String(h.from || ''), addr = (/<([^>]+)>/.exec(from) || [])[1] || from.trim();
      return { id: m.id, threadId: m.threadId || '', from: addr.toLowerCase(), fromName: from.replace(/<[^>]*>/, '').replace(/"/g, '').trim(), subject: h.subject || '', date: m.internalDate ? new Date(+m.internalDate).toISOString() : (h.date || ''), body: textOf(m.payload).slice(0, 4000) };
    }
    /* Recent messages that might carry a tag. `skip` is a Set of message ids already dealt with: those are not downloaded again. */
    async function fetchRecent(opts){
      opts = opts || {}; const days = Math.max(1, Math.min(60, +opts.days || 7)), skip = opts.skip || new Set(), max = Math.max(1, Math.min(50, +opts.max || 25));
      const q = `newer_than:${days}d subject:(task OR sub OR subdone OR subtask)`;
      const l = await api('/messages?maxResults=' + max + '&q=' + encodeURIComponent(q));
      if (l.status !== 200) throw apiError(l, 'search');
      const ids = (parse(l.text).messages || []).map(x => x.id).filter(id => !skip.has(id));
      const out = [];
      for (const id of ids){
        const r = await api('/messages/' + encodeURIComponent(id) + '?format=full');
        if (r.status === 404) continue;
        if (r.status !== 200) throw apiError(r, 'download');
        out.push(toMessage(parse(r.text)));
      }
      return { messages: out, listed: (parse(l.text).messages || []).length };
    }

    async function status(){
      const t = await load(), sv = await loadCreds();
      return { signedIn: !!t, email: (t && t.email) || '', error: t ? '' : (lastErr || sv.err || ''), errAt: t ? '' : (sv.errAt || ''), saved: { clientId: sv.clientId || '', hasSecret: !!sv.clientSecret } };
    }
    return { signIn, signOut, status, fetchRecent, accessToken, _toMessage: toMessage };
  }
  return { create, CLIENT_RE, SCOPE, KEY };
});
