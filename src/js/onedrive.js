/* Cursus CoS OneDrive sync (personal Microsoft accounts).

   - Sign-in, apps: the OAuth "device code" flow. The app shows a short code; you enter it at microsoft.com/link.
     No redirect page and no client secret. Used by the Windows and Android apps.
   - Sign-in, web: a browser is not allowed to call the device-code address, so a hosted web copy uses the
     "authorization code with PKCE" flow instead: the page sends you to Microsoft and Microsoft sends you back to the
     same page (a redirect address registered as a Single-page application). Microsoft limits web refresh tokens to
     about a day, so the page quietly asks for a new one (prompt=none) when the old one runs out.
   - Storage: one JSON file at  OneDrive / Apps / Cursus CoS / cursus-cos.json  (Microsoft Graph).
   - Conflicts: the file's eTag is sent with If-Match, so a lost race is detected and the sync retries (core.mergeData).
   - Speed: pull() asks for the file's metadata first and only downloads the file when its eTag changed.
   - Live alerts: Graph hands out a websocket address (/subscriptions/socketIo). Microsoft pushes a message there when
     the file changes, so no server of your own is needed. If it drops, the app reconnects; polling is the safety net.

   Everything platform specific is injected (http, kv, io, now, sleep), so this file is unit tested in Node with a
   fake Graph server and a fake socket. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { const CoS = (root.CoS = root.CoS || {}); CoS.onedriveLib = factory(); }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const SCOPE = 'Files.ReadWrite offline_access User.Read';
  const FILE_PATH = 'Apps/Cursus CoS/cursus-cos.json';
  const KEY = 'cos.msauth';
  const PENDING = 'cos.msauth.pending', HINT = 'cos.msauth.hint', SILENT = 'cos.msauth.silent';
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const form = o => Object.keys(o).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');
  const parse = t => { try{ return t ? JSON.parse(t) : {}; }catch(e){ return {}; } };
  const encPath = p => p.split('/').map(encodeURIComponent).join('/');
  const clone = x => JSON.parse(JSON.stringify(x));
  const b64url = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

  function create(deps){
    // looked up on every call, so tests (and hosts) can swap them after creation
    const now = () => (deps.now || Date.now)();
    const sleep = ms => (deps.sleep ? deps.sleep(ms) : new Promise(r => setTimeout(r, ms)));
    const setT = (f, ms) => (deps.setTimeout ? deps.setTimeout(f, ms) : setTimeout(f, ms)), clearT = id => (deps.clearTimeout ? deps.clearTimeout(id) : clearTimeout(id));
    let tok = undefined;          // undefined = not loaded yet, null = signed out
    let refreshing = null, flow = null, cache = null, lastErr = '';   // lastErr: why the sign-in was dropped, shown instead of a bare "sign in"

    /* ---------- token storage ---------- */
    async function load(){
      if (tok !== undefined) return tok;
      try{ const raw = await deps.kv.get(KEY); tok = raw ? JSON.parse(raw) : null; }catch(e){ tok = null; }
      return tok;
    }
    async function store(t){ if (t) lastErr = ''; tok = t; try{ if (t) await deps.kv.set(KEY, JSON.stringify(t)); else await deps.kv.remove(KEY); }catch(e){} }

    function oauthError(r){
      const j = parse(r.text), e = new Error(j.error_description ? String(j.error_description).split(/\r?\n/)[0] : `Microsoft answered ${r.status}`);
      e.code = j.error || ''; e.status = r.status; return e;
    }
    async function post(url, body){
      let r;
      try{ r = await deps.http({ url, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form(body) }); }
      catch(e){
        const x = new Error('Could not reach Microsoft. Check the connection. (A web browser may block this sign-in; the Windows and Android apps do not have that limit.)');
        x.network = true; throw x;
      }
      return r;
    }

    /* ---------- sign in (device code) ---------- */
    async function signIn(clientId, onCode){
      clientId = String(clientId || '').trim();
      if (!GUID.test(clientId)) throw new Error('That does not look like an Application (client) ID. It is a code like 1a2b3c4d-1234-5678-9abc-0123456789ab.');
      cancel();
      const mine = (flow = { cancelled: false });
      const r = await post(AUTH + '/devicecode', { client_id: clientId, scope: SCOPE });
      if (r.status !== 200){
        const e = oauthError(r);
        if (/AADSTS700016|AADSTS70002|AADSTS7000218|unauthorized_client/i.test(e.message + e.code)) e.message = 'Microsoft does not recognise that client ID, or the app is not set up as a public client. Re-check the app registration steps.';
        throw e;
      }
      const d = parse(r.text);
      if (!d.device_code || !d.user_code) throw new Error('Microsoft sent an unexpected sign-in answer.');
      const expiresAt = now() + (d.expires_in || 900) * 1000;
      let interval = Math.max(2, +d.interval || 5);
      if (onCode) onCode({ userCode: d.user_code, uri: d.verification_uri || 'https://microsoft.com/link', expiresAt });
      for (;;){
        await sleep(interval * 1000);
        if (mine.cancelled) { const e = new Error('Sign-in cancelled.'); e.cancelled = true; throw e; }
        if (now() > expiresAt) throw new Error('The code expired. Start the sign-in again.');
        const t = await post(AUTH + '/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: d.device_code });
        if (mine.cancelled) { const e = new Error('Sign-in cancelled.'); e.cancelled = true; throw e; }
        if (t.status === 200){
          const j = parse(t.text);
          await store({ clientId, access: j.access_token, exp: now() + (j.expires_in || 3600) * 1000, refresh: j.refresh_token || '', name: '' });
          flow = null;
          await learnName();
          return { name: tok.name };
        }
        const e = oauthError(t);
        if (e.code === 'authorization_pending') continue;
        if (e.code === 'slow_down'){ interval += 5; continue; }
        if (e.code === 'authorization_declined') throw new Error('Sign-in was declined.');
        if (e.code === 'expired_token') throw new Error('The code expired. Start the sign-in again.');
        throw e;
      }
    }
    async function learnName(){
      try{ const me = await graph('GET', '/me?$select=displayName,userPrincipalName'); if (me.status === 200){ const m = parse(me.text); tok.name = m.userPrincipalName || m.displayName || ''; await store(tok); } }catch(e){}
      try{ if (deps.kv.set && tok.name) await deps.kv.set(HINT, tok.name); }catch(e){}
    }

    /* ---------- sign in (web: authorization code + PKCE, by redirect) ---------- */
    async function beginRedirect(clientId, redirectUri, opts){
      opts = opts || {};
      clientId = String(clientId || '').trim();
      if (!GUID.test(clientId)) throw new Error('That does not look like an Application (client) ID. It is a code like 1a2b3c4d-1234-5678-9abc-0123456789ab.');
      const cr = deps.crypto || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
      if (!cr || !cr.subtle || !deps.navigate) throw new Error('This browser cannot do the web sign-in. Use the Windows or Android app, or a current browser over https.');
      const rnd = n => b64url(cr.getRandomValues(new Uint8Array(n)));
      const verifier = rnd(32), state = rnd(16);
      const challenge = b64url(new Uint8Array(await cr.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      await deps.kv.set(PENDING, JSON.stringify({ verifier, state, clientId, redirectUri, silent: !!opts.silent, at: now() }));
      const q = { client_id: clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query', scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: opts.silent ? 'none' : 'select_account' };
      if (opts.silent && opts.loginHint) q.login_hint = opts.loginHint;
      if (opts.silent) { try{ await deps.kv.set(SILENT, String(now())); }catch(e){} }
      const url = AUTH + '/authorize?' + form(q);
      deps.navigate(url);
      return url;
    }
    /* Call on page load with location.search. Returns null when the address is not a sign-in answer meant for us,
       otherwise { ok, name, silent, error }. The caller removes ?code=... from the address bar. */
    async function completeRedirect(search){
      const q = new URLSearchParams(search || '');
      if (!q.get('state') || !(q.get('code') || q.get('error'))) return null;
      let p = null; try{ p = parse(await deps.kv.get(PENDING)); }catch(e){}
      if (!p || !p.state || p.state !== q.get('state')) return null;
      try{ await deps.kv.remove(PENDING); }catch(e){}
      if (q.get('error')){
        const code = q.get('error'), desc = String(q.get('error_description') || '').split(/\r?\n/)[0];
        const quiet = /login_required|interaction_required|consent_required|account_selection_required/.test(code);
        return { ok: false, silent: !!p.silent, needsSignIn: quiet, error: quiet ? 'Your Microsoft sign-in ended. Sign in again.' : code === 'access_denied' ? 'Sign-in was cancelled or declined.' : (desc || code) };
      }
      const r = await post(AUTH + '/token', { client_id: p.clientId, grant_type: 'authorization_code', code: q.get('code'), redirect_uri: p.redirectUri, code_verifier: p.verifier, scope: SCOPE });
      if (r.status !== 200){
        const e = oauthError(r);
        if (/AADSTS9002326|cross-origin token redemption/i.test(e.message + e.code)) e.message = 'Microsoft refused the sign-in because the redirect address is not registered as a "Single-page application". In the app registration, Authentication, remove it from "Web" and add it under "Single-page application".';
        else if (/AADSTS50011|redirect_uri/i.test(e.message + e.code)) e.message = 'Microsoft does not recognise this page address. Add it exactly as shown as a Single-page application redirect URI.';
        return { ok: false, silent: !!p.silent, error: e.message };
      }
      const j = parse(r.text);
      await store({ clientId: p.clientId, access: j.access_token, exp: now() + (j.expires_in || 3600) * 1000, refresh: j.refresh_token || '', name: '', web: true });
      await learnName();
      try{ await deps.kv.remove(SILENT); }catch(e){}
      return { ok: true, name: tok.name, silent: !!p.silent };
    }
    /* Whether it is sensible to try a silent renewal now: signed out by expiry (a name was remembered), and not already tried in the last 10 minutes. */
    async function canRenewSilently(){
      let hint = '', last = 0;
      try{ hint = (await deps.kv.get(HINT)) || ''; last = +(await deps.kv.get(SILENT)) || 0; }catch(e){}
      return { ok: !!hint && now() - last > 10 * 60 * 1000, hint };
    }
    function cancel(){ if (flow) flow.cancelled = true; }
    async function signOut(){ cancel(); cache = null; await store(null); try{ await deps.kv.remove(HINT); await deps.kv.remove(SILENT); }catch(e){} }

    /* ---------- access token ---------- */
    async function accessToken(force){
      const t = await load();
      if (!t || !t.refresh && !t.access){ const e = new Error('Not signed in to OneDrive. Open Settings, Sync to sign in.'); e.auth = true; throw e; }
      if (!force && t.access && now() < t.exp - 60000) return t.access;
      if (!t.refresh){ lastErr = 'Microsoft did not give this app a renewal token (no refresh token was issued).'; await store(null); const e = new Error('Your Microsoft sign-in ended: ' + lastErr + ' Sign in again.'); e.auth = true; throw e; }
      if (!refreshing){
        refreshing = (async () => {
          const r = await post(AUTH + '/token', { grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh, scope: SCOPE });
          if (r.status !== 200){
            const e = oauthError(r);
            if (e.code === 'invalid_grant' || e.code === 'interaction_required' || e.code === 'invalid_client'){ lastErr = (e.code + ': ' + e.message).slice(0, 300); await store(null); e.message = 'Your Microsoft sign-in ended (' + lastErr + '). Sign in again.'; e.auth = true; }
            throw e;
          }
          const j = parse(r.text);
          await store(Object.assign({}, t, { access: j.access_token, exp: now() + (j.expires_in || 3600) * 1000, refresh: j.refresh_token || t.refresh }));
          return tok.access;
        })().finally(() => { refreshing = null; });
      }
      return refreshing;
    }

    /* ---------- Graph ---------- */
    async function graph(method, pathOrUrl, opts){
      opts = opts || {};
      const url = /^https:/.test(pathOrUrl) ? pathOrUrl : GRAPH + pathOrUrl;
      for (let attempt = 0; attempt < 2; attempt++){
        const token = await accessToken(attempt > 0);
        const r = await deps.http({ url, method, headers: Object.assign({ Authorization: 'Bearer ' + token, Accept: 'application/json' }, opts.headers || {}), body: opts.body });
        if (r.status === 401 && attempt === 0) continue;
        r.req = method + ' ' + url.replace(GRAPH, '').replace(/\?.*$/, '').replace(/^\/me\/drive\/root:\/Apps\/Cursus%20CoS\//, '…/');
        return r;
      }
    }
    function graphError(r, what){
      const j = parse(r.text), m = (j.error && j.error.message) || '';
      if (r.status === 401) { const e = new Error('OneDrive refused the sign-in' + (m ? ' (' + String((j.error && j.error.code) || '401') + ': ' + m + ')' : ' (401)') + ' at ' + (r.req || 'OneDrive') + '. Sign in again; if it keeps happening, tell the developer this message.'); e.auth = true; e.refused = true; e.req = r.req; return e; }
      if (r.status === 403) return new Error('OneDrive did not allow that. Check the app has the Files.ReadWrite permission.');
      if (r.status === 429) return new Error('OneDrive asked the app to slow down. It will retry shortly.');
      if (r.status === 507) return new Error('Your OneDrive is full.');
      return new Error(`OneDrive ${what} failed (${r.status}${m ? ': ' + m : ''}).`);
    }
    const itemPath = () => '/me/drive/root:/' + encPath(FILE_PATH);

    /* ---------- the sync adapter ---------- */
    /* A 401 on the file but not on the drive itself tells a different story from a bad token: say which. */
    async function probe(e){
      try{
        if (!e || !e.refused) return e;
        const d = await graph('GET', '/me/drive?$select=id,driveType');
        e.message = e.message.replace(/\. Sign in again;/, ` (the drive itself ${d.status === 200 ? 'answered fine' : 'also failed: ' + d.status}). Sign in again;`);
      }catch(x){}
      return e;
    }
    function adapter(){
      const inner = adapter0();
      return {
        async pull(){ try{ return await inner.pull(); }catch(e){ throw await probe(e); } },
        async push(d, t){ try{ return await inner.push(d, t); }catch(e){ throw await probe(e); } }
      };
    }
    function adapter0(){
      return {
        async pull(){
          const sel = '?$select=id,eTag,size,@microsoft.graph.downloadUrl';
          const m = await graph('GET', itemPath() + sel);
          if (m.status === 404){ cache = null; return null; }
          if (m.status !== 200) throw graphError(m, 'read');
          const item = parse(m.text), etag = item.eTag;
          if (cache && etag && cache.etag === etag) return { data: clone(cache.data), etag };
          let r;
          const dl = item['@microsoft.graph.downloadUrl'];
          if (dl){ try{ r = await deps.http({ url: dl, method: 'GET', headers: { Accept: 'application/json' } }); }catch(e){ r = null; } }   // a browser may block the download address (cross-origin): fall back to Graph
          if (!r || r.status !== 200) r = await graph('GET', itemPath() + ':/content');
          if (r.status !== 200) throw graphError(r, 'download');
          if (!String(r.text).trim()){ cache = null; return null; }
          let data; try{ data = JSON.parse(r.text); }catch(e){ throw new Error('The file in OneDrive is not valid JSON.'); }
          cache = { etag, data };
          return { data: clone(data), etag };
        },
        async push(data, etag){
          const headers = { 'Content-Type': 'application/json' };
          let url = itemPath() + ':/content';
          if (etag) headers['If-Match'] = etag; else url += '?@microsoft.graph.conflictBehavior=fail';
          const r = await graph('PUT', url, { headers, body: JSON.stringify(data) });
          if (r.status === 412 || r.status === 409){ cache = null; const e = new Error('Another device updated the data first. Retrying.'); e.conflict = true; throw e; }
          if (r.status !== 200 && r.status !== 201) throw graphError(r, 'upload');
          const item = parse(r.text);
          cache = item.eTag ? { etag: item.eTag, data: clone(data) } : null;   // our own upload does not need downloading again
        }
      };
    }

    /* ---------- live change alerts ---------- */
    const live = { on: false, running: false, error: '' };
    let stopWatch = null;
    function watch(onChange, onState){
      if (stopWatch) stopWatch();
      let stopped = false, socket = null, timer = 0, renew = 0, delay = 4000;
      const set = (on, error) => { live.on = on; live.error = error || ''; if (onState) onState(Object.assign({}, live)); };
      const drop = () => { clearT(renew); if (socket){ try{ socket.removeAllListeners && socket.removeAllListeners(); socket.close(); }catch(e){} socket = null; } };
      const later = () => { if (stopped) return; clearT(timer); timer = setT(connect, delay); delay = Math.min(delay * 2, 300000); };
      async function connect(){
        if (stopped) return;
        drop();
        const io = deps.io && deps.io();
        if (!io){ set(false, 'Live alerts are not available here.'); return; }
        try{
          const r = await graph('GET', '/me/drive/root/subscriptions/socketIo', { headers: { 'Content-Type': 'application/json' } });
          if (stopped) return;
          if (r.status !== 200) throw graphError(r, 'live alerts');
          const url = parse(r.text).notificationUrl;
          if (!url) throw new Error('OneDrive sent no live-alert address.');
          socket = io(url, { transports: ['websocket'], reconnection: false });
          const mine = socket;
          mine.on('connect', () => { if (socket === mine){ delay = 4000; set(true); } });
          mine.on('notification', () => { if (socket === mine && onChange) onChange(); });
          const lost = msg => { if (socket !== mine || stopped) return; drop(); set(false, msg); later(); };
          mine.on('disconnect', () => lost('Live alerts disconnected.'));
          mine.on('connect_error', e => lost('Live alerts could not connect' + (e && e.message ? ': ' + e.message : '.')));
          renew = setT(() => { if (socket === mine){ drop(); connect(); } }, 50 * 60 * 1000);   // take a fresh address now and then
        }catch(e){
          if (e && e.auth){ set(false, e.message); return; }   // signed out: stop quietly
          set(false, String((e && e.message) || e)); later();
        }
      }
      connect();
      stopWatch = () => { stopped = true; clearT(timer); drop(); set(false); stopWatch = null; };
      return stopWatch;
    }
    const unwatch = () => { if (stopWatch) stopWatch(); };

    async function status(){
      const t = await load();
      return { signedIn: !!t, error: t ? '' : lastErr, name: (t && t.name) || '', clientId: (t && t.clientId) || '', live: live.on, liveError: live.error };
    }

    return { signIn, beginRedirect, completeRedirect, canRenewSilently, cancel, signOut, adapter, watch, unwatch, status, accessToken, _live: live, _deps: deps };
  }

  return { create, AUTH, GRAPH, SCOPE, FILE_PATH, KEY, GUID };
});
