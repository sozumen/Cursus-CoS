/* Cursus CoS UI: rendering, drag and drop, editors, automation wiring, sync wiring.
   Platform specifics live in host.js; pure logic lives in core.js. */
(() => {
'use strict';

const CoS = window.CoS, Host = CoS.host, Tools = CoS.tools;
const { COLS, COL, nextOccurrence, nextDates, normRepeat, repeatLabel, isStuckChild, IMP_BAND, bandOf, clampImp, impColor, impMatch, setImp, STAGE_COLORS, MAX_STAGES, stageKey, isDoneTask, doneIdOf, mapStatus, defaultStages, PRI, FLAGS, uid, nowISO, clone, pad, fmtISO, parseD, todayStr, addDays, diffDays, trackStages, staleSuggestions, rankOrder, rankScore, urgencyOf, normSavedView, daysInStage, hashId, newBoard, newView, BUILTIN_FIELDS, FIELD_TYPES, newTask, logTask, isBlocked, dueState, autoMove, autoArchive, reconcileDone, fireTime, parseEst, fmtEst, emptyFilters, normalize, fixRefs, resetHashes, stampChanges, extractData, isSyncPayload, mergeData, signature, seed } = CoS.core;

/* ---------- small helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ic = (n, c = 'w-4 h-4') => `<i data-lucide="${n}" class="${c}"></i>`;
const fmtD = s => { if (!s) return ''; const d = parseD(s); const o = { month:'short', day:'numeric' }; if (d.getFullYear() !== new Date().getFullYear()) o.year = '2-digit'; return d.toLocaleDateString('en-US', o); };
const fmtDT = d => d.toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
const hsl = (h, s, l) => `hsl(${h} ${s}% ${l}%)`;
function timeAgo(iso){
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago'; return Math.floor(s/86400) + 'd ago';
}

/* ---------- state & persistence (everything goes through the host layer) ---------- */
const KEY = 'cursus-cos.v1', KEY_BG = 'cursus-cos.bg';
/* Data saved under earlier names is read once, then saved under the new key. The old keys are left in place as a safety copy. */
const LEGACY_KEYS = ['cos-tasks.v2', 'laneway.v1'], LEGACY_BG_KEYS = ['cos-tasks.bg'];
let storageOK = true, bgCache = '';
let S = null;
const hashes = {};
async function loadState(){
  try{
    for (const k of [KEY, ...LEGACY_KEYS]){
      const raw = await Host.kv.get(k);
      if (!raw) continue;
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.tasks) && Array.isArray(d.boards)){
        if (k !== KEY) Host.kv.set(KEY, raw).catch(() => {});
        return normalize(d);
      }
    }
  }catch(e){ storageOK = false; }
  return seed();
}
let saveT = null, dirty = false;
function save(){ dirty = true; clearTimeout(saveT); saveT = setTimeout(persist, 120); }
function persist(){
  clearTimeout(saveT); dirty = false;
  if (!S) return Promise.resolve();
  reconcileDone(S.tasks, undefined, S.boards); stampChanges(S, hashes, nowISO());
  const p = Host.kv.set(KEY, JSON.stringify(S)).then(
    () => { if (!storageOK){ storageOK = true; renderNotice(); } },
    () => { if (storageOK){ storageOK = false; renderNotice(); } });
  pushReminders(); scheduleSync();
  return p;
}
/* Page errors are saved to crash.log in the Windows app, so a failure on someone's PC can be diagnosed. */
window.addEventListener('error', e => { try{ Host.log((e.message || 'error') + ' at ' + (e.filename || '') + ':' + (e.lineno || '') + '\n' + (e.error && e.error.stack || '')); }catch(x){} });
window.addEventListener('unhandledrejection', e => { try{ Host.log('unhandledrejection: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)); }catch(x){} });
const persistMeta = () => Host.kv.set(KEY, JSON.stringify(S)).catch(() => {});
window.addEventListener('pagehide', () => { persist(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });

const tombstone = (kind, id) => { S.tombstones = S.tombstones.filter(x => !(x.kind === kind && x.id === id)); S.tombstones.push({ kind, id, updated: nowISO() }); };
/* Replace the shared data wholesale (restore, load sample, erase). Records missing from `next` become tombstones
   so other devices delete them too; everything in `next` is stamped "now" so it wins on the next sync. */
function replaceAll(next, { keepSettings = true } = {}){
  const COLLS = [['board', 'boards'], ['project', 'projects'], ['task', 'tasks']];
  const keep = new Set(); for (const [k, c] of COLLS) for (const r of next[c]) keep.add(k + ':' + r.id);
  const now = nowISO(), tombs = [];
  for (const [k, c] of COLLS) for (const r of S[c]) if (!keep.has(k + ':' + r.id)) tombs.push({ kind:k, id:r.id, updated:now });
  for (const [, c] of COLLS) for (const r of next[c]) r.updated = now;
  if (Array.isArray(next.savedViews)){
    const kv = new Set(next.savedViews.map(v => v.id)), nw = nowISO();
    for (const v of S.savedViews || []) if (!kv.has(v.id)) tombs.push({ kind:'savedView', id:v.id, updated:nw });
    next.savedViews.forEach(v => { v.updated = nw; keep.add('savedView:' + v.id); });
    S.savedViews = next.savedViews;
  }
  S.boards = next.boards; S.projects = next.projects; S.tasks = next.tasks; S.sample = !!next.sample;
  S.tombstones = S.tombstones.filter(t => !keep.has(t.kind + ':' + t.id)).concat(tombs);
  if (!keepSettings && next.settings) S.settings = next.settings;
  fixRefs(S); resetHashes(S, hashes);
}
function resetToEmpty(){
  const b = newBoard();
  replaceAll({ boards:[b], projects:[], tasks:[], sample:false });
  S.settings.boardsSel = [b.id]; S.settings.filters = emptyFilters(); save(); render();
}

/* ---------- reminders handed to the host (native notifications) ---------- */
let remT = null;
function pushReminders(){
  clearTimeout(remT);
  remT = setTimeout(() => {
    if (!S || !Host.caps.nativeReminders) return;
    const rt = S.settings.reminderTime, now = Date.now(), list = [];
    for (const t of S.tasks){
      if (isDone(t) || !t.reminder || t.archived) continue;
      const ft = fireTime(t, rt); if (!ft || ft.getTime() <= now) continue;
      list.push({ id: hashId(t.id + ft.toISOString()), taskId: t.id, title: t.title, at: ft.getTime() });
    }
    list.sort((a, b) => a.at - b.at);
    Host.syncReminders(list.slice(0, 100));
  }, 800);
}

/* ---------- sync ---------- */
const syncState = { running:false, timer:0, again:false, hold:0 };
const OD = CoS.onedrive;
function scheduleSync(delay = 2500){
  if (!S || !S.meta.sync || S.meta.sync.mode === 'off') return;
  clearTimeout(syncState.timer); syncState.timer = setTimeout(() => syncNow(false), delay);
}
function applyMerged(m){
  const before = new Map(S.settings.subscribed.map(id => [id, (T(id) || {}).updated]));
  S.boards = m.boards; S.projects = m.projects; S.savedViews = m.savedViews || S.savedViews || []; S.tasks = m.tasks.map(newTask); S.tombstones = m.tombstones; S.sample = false;
  fixRefs(S); resetHashes(S, hashes); persistMeta(); pushReminders(); render();
  const changed = S.settings.subscribed.map(T).filter(t => t && before.has(t.id) && before.get(t.id) !== t.updated);
  if (changed.length){
    const msg = changed.length === 1 ? `"${changed[0].title}" was changed on another device.` : `${changed.length} tasks you follow were changed on another device.`;
    toast(msg, changed.length === 1 ? { label:'Open', fn:() => openTask(changed[0].id) } : null, 7000);
    if (document.hidden) Host.notify({ title:'Cursus CoS', body:msg });
  }
}
async function syncNow(manual){
  const c = S && S.meta.sync; if (!c || c.mode === 'off') return;
  if (syncState.running){ syncState.again = true; return; }   // a change alert arrived mid-sync: go round once more
  if (S.sample){ if (manual) toast('Clear the sample data first (Settings, Data).'); return; }
  if (!manual && syncState.hold > Date.now()) return;   // OneDrive refused us a moment ago: do not hammer it every 20 seconds
  if (manual) syncState.hold = 0;
  if (dirty){ reconcileDone(S.tasks, undefined, S.boards); trackStages(S.tasks); stampChanges(S, hashes, nowISO()); }   // edits still waiting for the save debounce must be stamped before merging
  if (c.mode === 'onedrive'){
    const st = await OD.status();
    if (!st.signedIn){ c.error = st.error || ''; ui.od.status = st; if (st.error) ui.od.msg = st.error; if (await odRenew()) return; if (manual) toast(st.error ? 'Sign in to OneDrive again. ' + st.error : 'Sign in to OneDrive first.', null, st.error ? 9000 : undefined); renderModal(); renderSyncStatus(); return; }
  }
  syncState.running = true; c.error = ''; renderSyncStatus();
  try{
    const ad = CoS.sync.make(c, Host); if (!ad) throw new Error('This sync method is not available on this device.');
    for (let attempt = 0; attempt < 2; attempt++){
      const remote = await ad.pull();
      const local = extractData(S);
      let merged = local;
      if (remote){
        if (!isSyncPayload(remote.data)) throw new Error('That file is not a Cursus CoS sync file.');
        merged = mergeData(local, remote.data);
        if (signature(merged) !== signature(local)) applyMerged(merged);
      }
      if (!remote || signature(merged) !== signature(remote.data)){
        try{ await ad.push(extractData(S), remote && remote.etag); }
        catch(e){ if (e && e.conflict && attempt === 0) continue; throw e; }
      }
      break;
    }
    c.last = nowISO(); c.error = '';
  }catch(e){
    c.error = String((e && e.message) || e);
    if (e && e.refused) syncState.hold = Date.now() + 5 * 60 * 1000;
    // Only show "signed out" when the sign-in really is gone. A refusal from OneDrive keeps the sign-in and shows the reason.
    if (e && e.auth && c.mode === 'onedrive'){ try{ ui.od.status = await OD.status(); }catch(x){ ui.od.status = { signedIn:false }; } }
  }
  syncState.running = false; persistMeta(); renderSyncStatus();
  if (c.mode === 'onedrive' && ui.od.status && !ui.od.status.signedIn) odRenew();
  if (syncState.again){ syncState.again = false; scheduleSync(300); }
}
function syncLabel(){
  const c = S.meta.sync;
  if (c.mode === 'off') return '';
  if (S.sample) return 'Paused: this is still the sample data. Clear it in Settings, Data, then sync.';
  if (c.mode === 'onedrive' && ui.od.status && !ui.od.status.signedIn) return 'Sign in to OneDrive in Settings, Sync' + (c.error ? ' (' + c.error + ')' : '');
  if (syncState.running) return 'Syncing…';
  if (c.error) return 'Sync problem: ' + c.error;
  return c.last ? 'Synced ' + timeAgo(c.last) : 'Not synced yet';
}
function renderSyncStatus(){
  const chip = $('#syncChip'); if (chip) chip.textContent = syncLabel();
  const line = $('#syncStatusLine'); if (line) line.textContent = syncLabel() || 'Sync is off.';
}
/* ---------- OneDrive ---------- */
/* A hosted web copy signs in by redirect (Microsoft's device-code address cannot be called from a browser page). */
const odWeb = () => Host.platform === 'web' && window.COS_BUILD !== 'single' && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname));
const odRedirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');
/* Web only: when the roughly daily Microsoft token has run out, go round once with prompt=none to get a new one without asking. */
async function odRenew(){
  const c = S && S.meta.sync;
  if (!odWeb() || !c || c.mode !== 'onedrive' || !c.clientId || ui.modal || ui.odRenewing) return false;
  try{
    const r = await OD.canRenewSilently(); if (!r.ok) return false;
    ui.odRenewing = true; persist();
    await OD.beginRedirect(c.clientId, odRedirectUri(), { silent:true, loginHint:r.hint });
    return true;
  }catch(e){ ui.odRenewing = false; return false; }
}
/* Runs at start-up: finish a sign-in that Microsoft just redirected back to this page. */
async function odResume(){
  if (!odWeb()) return;
  try{
    const res = await OD.completeRedirect(location.search);
    if (!res) return;
    try{ history.replaceState(null, '', odRedirectUri() + (location.hash || '')); }catch(e){}
    const c = S.meta.sync;
    if (res.ok){ ui.od.status = { signedIn:true, name:res.name }; c.error = ''; persistMeta(); toast(res.silent ? 'OneDrive sign-in renewed.' : 'Signed in to OneDrive.', null, 3000); return; }
    ui.od.status = { signedIn:false }; ui.od.msg = res.error;
    if (!(res.silent && res.needsSignIn)){ ui.settingsTab = 'sync'; ui.modal = { type:'settings' }; renderModal(); }
    renderSyncStatus();
  }catch(e){ ui.od.msg = String((e && e.message) || e); }
}
function odStatus(){
  OD.status().then(st => { ui.od.status = st; ui.od.live = st.live; if (ui.modal && ui.modal.type === 'settings' && ui.settingsTab === 'sync') renderModal(); renderSyncStatus(); }).catch(() => {});
}
function odWatch(){
  const c = S && S.meta.sync;
  if (!c || c.mode !== 'onedrive'){ OD.unwatch(); ui.od.live = false; return; }
  OD.status().then(st => {
    ui.od.status = st;
    if (!st.signedIn){ OD.unwatch(); return; }
    OD.watch(() => scheduleSync(400), l => { ui.od.live = l.on; ui.od.liveError = l.error; renderSyncStatus(); const n = $('#odLive'); if (n) n.textContent = odLiveText(); });
  });
}
const odLiveText = () => ui.od.live ? 'Live alerts: connected. Changes from other devices arrive within seconds.' : 'Live alerts: not connected' + (ui.od.liveError ? ' (' + ui.od.liveError + ')' : '') + '. The app still checks every 20 seconds.';
function odHTML(c){
  const o = ui.od, st = o.status;
  if (!st) odStatus();
  const err = o.msg ? `<p class="note" style="color:var(--danger);margin-top:8px" role="alert">${esc(o.msg)}</p>` : '';
  if (st && st.signedIn) return `<div class="field-row"><span style="min-width:0"><b style="font-weight:650">Signed in to OneDrive</b><br><span class="note">${esc(st.name || 'Microsoft account')}</span></span><button class="btn btn-sm" data-act="od-signout">Sign out</button></div>
    <p class="note">Your data is kept in OneDrive at <span class="mono">Apps / Cursus CoS / cursus-cos.json</span>. Edits are uploaded a couple of seconds after you make them.</p>
    <p class="note" id="odLive" style="margin-top:4px">${esc(odLiveText())}</p>${err}`;
  if (o.phase === 'waiting') return `<div class="card-box" style="margin-top:10px;text-align:center">
      <p class="note">1. Open <b>microsoft.com/link</b> &nbsp; 2. Enter this code &nbsp; 3. Approve the sign-in</p>
      <div class="mono" style="font-size:30px;letter-spacing:.18em;font-weight:700;margin:10px 0" aria-label="Sign-in code">${esc(o.code)}</div>
      <div class="flex gap-2" style="justify-content:center;flex-wrap:wrap"><button class="btn btn-primary" data-act="od-link">${ic('arrow-up-right')}Open microsoft.com/link</button><button class="btn" data-act="od-copy">${ic('copy')}Copy code</button><button class="btn btn-ghost" data-act="od-cancel">Cancel</button></div>
      <p class="note" style="margin-top:8px">Waiting for you to finish. The code works for about 15 minutes.</p></div>${err}`;
  return `<div style="margin-top:10px"><label class="lbl" for="odClient">Application (client) ID</label><input id="odClient" class="inp mono" data-sync="clientId" placeholder="1a2b3c4d-1234-5678-9abc-0123456789ab" value="${esc(c.clientId || '')}" autocomplete="off" spellcheck="false">
    <div class="flex gap-2 items-center" style="margin-top:10px"><button class="btn btn-primary" data-act="od-signin" ${o.phase === 'starting' ? 'disabled' : ''}>${ic('user-plus')}${o.phase === 'starting' ? 'Contacting Microsoft…' : 'Sign in with Microsoft'}</button></div>${err}
    ${odWeb() ? odWebSetupHTML() : odAppSetupHTML()}</div>`;
}
const odAppSetupHTML = () => `<details style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">Where do I get the client ID? (one-time setup, about 5 minutes)</summary>
      <ol class="note" style="margin:8px 0 0 22px;line-height:1.7;list-style:decimal">
        <li>Go to <b>entra.microsoft.com</b> (or portal.azure.com) and sign in with your personal Microsoft account. If it asks you to create a free directory, accept.</li>
        <li><b>App registrations</b> → <b>New registration</b>. Name: Cursus CoS. Supported account types: <b>Personal Microsoft accounts only</b>. Leave Redirect URI empty. Register.</li>
        <li>Open <b>Authentication</b> → under advanced settings set <b>Allow public client flows</b> to <b>Yes</b> → Save.</li>
        <li><b>API permissions</b> → Add a permission → Microsoft Graph → <b>Delegated</b> → add <b>Files.ReadWrite</b>. (User.Read is already there.)</li>
        <li>On <b>Overview</b>, copy the <b>Application (client) ID</b> and paste it above.</li></ol>
      <p class="note" style="margin-top:6px">The client ID is not a secret. Enter the same one on each device. ${Host.platform === 'web' ? 'This copy of the app is not on its own https address, so Microsoft may block the sign-in here. Use the hosted web copy, or the Windows or Android app.' : ''}</p></details>`;
const odWebSetupHTML = () => `<div class="card-box" style="margin-top:12px"><b style="font-weight:650">This page's address (add it in Microsoft Entra)</b>
      <div class="flex gap-2 items-center" style="margin-top:6px"><input class="inp mono" readonly value="${esc(odRedirectUri())}" aria-label="Redirect address" onfocus="this.select()"><button class="btn btn-sm" data-act="od-uri">${ic('copy')}Copy</button></div>
      <p class="note" style="margin-top:6px">Microsoft only sends you back to an address it has on file, and it must match this one exactly, including the final slash.</p></div>
    <details style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">One-time setup (about 5 minutes, or 1 minute if you already did it for the Windows app)</summary>
      <ol class="note" style="margin:8px 0 0 22px;line-height:1.7;list-style:decimal">
        <li>Go to <b>entra.microsoft.com</b>, <b>App registrations</b>. Open your Cursus CoS registration, or <b>New registration</b> (Supported account types: <b>Personal Microsoft accounts only</b>).</li>
        <li><b>Authentication</b> → <b>Add a platform</b> → <b>Single-page application</b>. Paste the address above as the Redirect URI. Save. (It must be under <i>Single-page application</i>, not <i>Web</i>.)</li>
        <li><b>API permissions</b> → Microsoft Graph → <b>Delegated</b> → <b>Files.ReadWrite</b> (User.Read is already there).</li>
        <li>On <b>Overview</b>, copy the <b>Application (client) ID</b> and paste it above, then press Sign in.</li></ol>
      <p class="note" style="margin-top:6px">The client ID is not a secret, and the same one works on every device and in the Windows and Android apps. Microsoft makes web sign-ins expire after about a day, so this page renews it quietly in the background and only asks you again if Microsoft needs a password.</p></details>`;
function syncTabHTML(){
  const c = S.meta.sync;
  if (Host.fileSync && ui.syncPath === undefined){
    ui.syncPath = null;
    Host.fileSync.path().then(p => { ui.syncPath = p || ''; if (ui.modal && ui.modal.type === 'settings' && ui.settingsTab === 'sync') renderModal(); }).catch(() => { ui.syncPath = ''; });
  }
  const modes = [['off', 'Off'], ['onedrive', 'OneDrive (personal Microsoft account)'], ...(Host.fileSync ? [['file', 'Shared file (Windows only: OneDrive, Dropbox, network drive)']] : []), ['http', 'Web address (WebDAV or your own server)']];
  return `<div class="card-box"><b style="font-weight:650">Keep your devices in step</b><p class="note" style="margin-top:4px">Each device keeps its own full copy. Sync merges changes task by task, the newest edit wins, and deletions carry over. Backgrounds and view settings stay on each device.</p></div>
    <div class="field-row" style="margin-top:8px"><span>Sync method</span><select class="inp" style="width:300px;max-width:70%" data-sync="mode" aria-label="Sync method">${modes.map(([v, l]) => `<option value="${v}" ${c.mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    ${c.mode === 'onedrive' ? odHTML(c) : ''}
    ${c.mode === 'file' ? `<div class="field-row"><span style="min-width:0"><b style="font-weight:650">Sync file</b><br><span class="note truncate" style="display:block;max-width:300px">${ui.syncPath ? esc(ui.syncPath) : 'None chosen yet'}</span></span><button class="btn" data-act="sync-choose">${ic('folder')}Choose file</button></div>
      <p class="note">Pick a file inside a folder that OneDrive, Dropbox or a network drive already keeps in sync. Every device points at the same file.</p>` : ''}
    ${c.mode === 'http' ? `<div style="margin-top:10px"><label class="lbl" for="syncUrl">Address of the sync file</label><input id="syncUrl" class="inp" data-sync="url" placeholder="https://server/dav/cursus-cos.json" value="${esc(c.url)}">
      <label class="lbl" for="syncAuth" style="margin-top:10px">Authorization header (optional)</label><input id="syncAuth" class="inp" data-sync="auth" placeholder="Bearer …  or  Basic base64(user:password)" value="${esc(c.auth)}" autocomplete="off"></div>
      <p class="note" style="margin-top:8px">Any address that answers GET and PUT with a file works, including WebDAV. In the Windows and Android apps there are no browser cross-origin limits.</p>` : ''}
    ${c.mode !== 'off' ? `<div class="flex items-center gap-3" style="margin-top:12px"><button class="btn btn-primary" data-act="sync-now">${ic('rotate-ccw')}Sync now</button><span id="syncStatusLine" class="note">${esc(syncLabel() || 'Sync is off.')}</span></div>` : ''}
    <p class="note" style="margin-top:14px">This device: <span class="mono">${esc(S.meta.deviceId.slice(0, 8))}</span></p>`;
}

const ui = { gm:{ phase:'idle', msg:'', status:null, busy:false }, od:{ phase:'idle', code:'', uri:'', msg:'', status:null, live:false, liveError:'' }, pop:null, modal:null, quick:null, search:'', sideOpen:false, cal:todayStr().slice(0,7), calSel:todayStr(), sort:{ key:'status', dir:1 }, settingsTab:'appearance', dragging:false, pending:false, lastDay:todayStr(), tableLimit:200, limits:{}, lanesOff:{}, groupsOff:{}, foldersOff:{}, ctx:null, rename:null, renameVal:'' };
const T = id => S.tasks.find(t => t.id === id);
const boardOf = id => S.boards.find(b => b.id === id);
const projOf = id => S.projects.find(p => p.id === id);
const boardName = id => (boardOf(id) || {}).name || '';
/* ---------- stages (each board has its own; see core.js) ---------- */
const stagesOf = bid => (boardOf(bid) || {}).stages || defaultStages();
const stg = t => Tools.stageOf(t, S.boards);
const isDone = t => isDoneTask(t, S.boards);
const doneIdFor = bid => doneIdOf(boardOf(bid));
const firstOpenStage = bid => { const st = stagesOf(bid); return (st.find(x => !x.done) || st[0]).id; };
const stageNameOf = (t, id) => (stagesOf(t.boardId).find(x => x.id === id) || { name:String(id) }).name;
const stageIndex = t => Math.max(0, stagesOf(t.boardId).findIndex(x => x.id === t.status));
const reopenStage = bid => (stagesOf(bid).some(x => x.id === 'near-term') ? 'near-term' : firstOpenStage(bid));
const projName = id => (projOf(id) || {}).name || '';
const primaryBoard = () => (selBoards()[0] || S.boards[0] || {}).id || '';
function selBoards(){
  const ids = new Set(S.settings.boardsSel);
  let list = S.boards.filter(b => ids.has(b.id));
  if (!list.length) list = S.boards.slice();
  return list;
}
const selIds = () => new Set(selBoards().map(b => b.id));
const nextOrder = st => 10 + Math.max(0, ...S.tasks.filter(t => t.status === st).map(t => t.order));
const topOrder = st => Math.min(0, ...S.tasks.filter(t => t.status === st).map(t => t.order)) - 10;

/* ---------- derived ---------- */
const repChip = t => t.repeat ? `<span class="rep-chip" title="${esc(repeatLabel(t.repeat))}">${ic('repeat', 'w-3 h-3')}</span>` : '';
const impChip = (t, style = '') => { const c = impColor(t.importance); return `<span class="pri tint-ink" style="--h:${c.h};--s:${c.s};${style}" title="Importance ${t.importance} of 10">${t.importance}/10</span>`; };
function subDone(t, s){ if (s.taskId){ const c = T(s.taskId); if (c) return isDone(c); } return !!s.done; }
function subProg(t){ const n = t.subitems.length; if (!n) return null; const d = t.subitems.filter(s => subDone(t, s)).length; return { d, n, pct: Math.round(d / n * 100) }; }
function ruleHit(r, t){
  const v = r.value, today = todayStr();
  switch (r.type){
    case 'priority': return impMatch(t.importance, v);
    case 'tag': return !!v && t.tags.includes(String(v).toLowerCase());
    case 'assignee': return !!v && t.assignees.includes(v);
    case 'stage': return t.status === v;
    case 'flag': return t.flag === v;
    case 'overdue': return dueState(t, today, S.boards) === 'overdue';
    case 'soon': { const d = dueState(t, today, S.boards); return d === 'soon' || d === 'today'; }
    case 'blocked': return isBlocked(t, S.tasks, S.boards);
    default: return false;
  }
}
function colorOf(t){
  const b = boardOf(t.boardId), cr = (b && b.colors) || { by:'', rules:[] }, on = S.settings.addons.colors;
  if (on) for (const r of cr.rules) if (FLAGS[r.color] && ruleHit(r, t)) return FLAGS[r.color];
  const m = (on && cr.by) || S.settings.colorBy;
  if (m.startsWith('cf:')){ const f = b && b.fields.custom.find(x => 'cf:' + x.id === m), o = f && f.options.find(x => x.id === t.custom[f.id]); return o ? { h:o.h == null ? 210 : o.h, s:60 } : null; }
  if (m === 'status'){ const c = stg(t); return { h:c.h, s:c.s }; }
  if (m === 'priority') return impColor(t.importance);
  if (t.flag && FLAGS[t.flag]) return FLAGS[t.flag];
  const ds = dueState(t, todayStr(), S.boards);
  if (ds === 'overdue') return FLAGS.red;
  if (isBlocked(t, S.tasks, S.boards)) return { h:220, s:10 };
  if (ds === 'soon' || ds === 'today') return FLAGS.yellow;
  return null;
}
function filterCount(){
  const f = S.settings.filters;
  return f.status.length + f.priority.length + f.tags.length + f.projects.length + (f.due !== 'any' ? 1 : 0) + (f.blocked ? 1 : 0) + (f.reminder ? 1 : 0) + (f.hideDone ? 1 : 0) + (f.email ? 1 : 0) + (f.archived ? 1 : 0);
}
function passes(t){
  const f = S.settings.filters, q = ui.search.trim().toLowerCase(), today = todayStr();
  if (q){
    const hay = (t.title + ' ' + t.description + ' ' + t.tags.join(' ') + ' ' + t.subitems.map(s => s.title).join(' ') + ' ' + projName(t.projectId) + ' ' + boardName(t.boardId) + ' ' + t.assignees.join(' ') + ' ' + pTags(t.id).join(' ') + ' ' + Object.values(t.custom || {}).filter(x => typeof x === 'string').join(' ') + ' ' + t.attachments.map(a => a.name).join(' ')).toLowerCase();
    if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  if (f.status.length && !f.status.includes(Tools.stageKeyOf(t, S.boards))) return false;
  if (f.priority.length && !f.priority.some(v => impMatch(t.importance, v))) return false;
  if (f.tags.length && !f.tags.some(x => t.tags.includes(x))) return false;
  if (f.projects.length && !f.projects.includes(t.projectId)) return false;
  if (f.due !== 'any'){
    if (f.due === 'none'){ if (t.due) return false; }
    else if (!t.due) return false;
    else {
      const dd = diffDays(today, t.due);
      if (f.due === 'overdue' && !(dd < 0 && !isDone(t))) return false;
      if (f.due === 'today' && dd !== 0) return false;
      if (f.due === 'week' && !(dd >= 0 && dd <= 7)) return false;
    }
  }
  if (f.blocked && !isBlocked(t, S.tasks, S.boards)) return false;
  if (f.reminder && !t.reminder) return false;
  if (f.hideDone && isDone(t)) return false;
  if (f.email && !isEmail(t)) return false;
  return true;
}
const isEmail = t => !!CoS.ingest.adapters[t.source];
/* Archived tasks are out of sight everywhere except the Archive view, which shows only them. */
const scope = () => { const ids = selIds(), arch = !!S.settings.filters.archived; return S.tasks.filter(t => ids.has(t.boardId) && !!t.archived === arch); };
const visible = () => scope().filter(passes);
const byOrder = (a, b) => a.order - b.order;
const allTags = () => [...new Set(scope().flatMap(t => t.tags))].sort();

/* ---------- reminders ---------- */
const reKey = (t, ft) => ft.toISOString();
function dueReminders(){
  const now = Date.now(), rt = S.settings.reminderTime;
  return S.tasks.filter(t => !isDone(t) && t.reminder && !t.archived).map(t => ({ t, ft: fireTime(t, rt) }))
    .filter(x => x.ft && x.ft.getTime() <= now && x.t.reminder.ack !== reKey(x.t, x.ft)).sort((a, b) => a.ft - b.ft);
}
function upcomingReminders(){
  const now = Date.now(), rt = S.settings.reminderTime, lim = now + 14 * 864e5;
  return S.tasks.filter(t => !isDone(t) && t.reminder && !t.archived).map(t => ({ t, ft: fireTime(t, rt) }))
    .filter(x => x.ft && x.ft.getTime() > now && x.ft.getTime() < lim).sort((a, b) => a.ft - b.ft);
}
function checkReminders(){
  let changed = false;
  for (const { t, ft } of dueReminders()){
    const key = reKey(t, ft);
    if (t.reminder.notified !== key){
      t.reminder.notified = key; changed = true;
      toast(`Reminder: ${t.title}`, { label:'Open', fn:() => openTask(t.id) }, 7000);
      if (!Host.caps.nativeReminders && document.hidden) Host.notify({ title:'Cursus CoS reminder', body:t.title });
    }
  }
  if (changed) save();
  const n = dueReminders().length;
  document.title = (n ? `(${n}) ` : '') + 'Cursus CoS';
  return changed;
}

/* ---------- mutations ---------- */
function applyMoves(moves){
  for (const m of moves){
    m.t.status = m.to; m.t.order = topOrder(m.to); m.t.pin = null; m.t.updated = nowISO();
    m.t.autoMoved = { at: nowISO(), why: m.why, from: m.from };
    logTask(m.t, `Auto-moved ${stageNameOf(m.t, m.from)} to ${stageNameOf(m.t, m.to)} (${m.why})`);
    followParent(m.t);
  }
}
/* ---------- tasks that have sat in a stage too long: flag them and ask whether to move them on ---------- */
const pendingReviews = () => S.tasks.filter(t => t.review && !t.archived && !isDone(t));
function runStale(){
  const A = S.settings.automation; let n = trackStages(S.tasks);
  const found = staleSuggestions(S.tasks, A, todayStr(), S.boards);
  for (const x of found){
    const t = x.t, flag = x.rule.flag || '';
    t.review = { to:x.to, from:x.from, rule:x.rule.id, days:x.days, at:nowISO(), flag, prevFlag:t.flag || '' };
    if (flag) t.flag = flag;
    logTask(t, `In ${stageNameOf(t, x.from)} for ${x.days} days: asked whether to move it to ${stageNameOf(t, x.to)}`);
    t.updated = nowISO(); n++;
  }
  if (found.length) ui.reviewAsked = false;
  if (pendingReviews().length) setTimeout(flushReviews, 0);
  return n;
}
function flushReviews(){
  if (!S || ui.modal || ui.dragging || ui.pop || ui.quick || ui.reviewAsked || $('#confirmRoot').innerHTML || !pendingReviews().length) return;
  ui.reviewAsked = true; openReview();
}
function openReview(){ closePop(); ui.modal = { type:'review' }; renderModal(); }
function endReview(t){ const r = t.review; t.review = null; if (r && r.flag && t.flag === r.flag) t.flag = r.prevFlag || ''; }   // take our flag off again, unless it was changed meanwhile
function reviewMove(id){
  const t = T(id); if (!t || !t.review) return;
  const to = t.review.to; endReview(t);
  if (stagesOf(t.boardId).some(x => x.id === to)) moveTask(id, to, topOrder(to), true);
}
function reviewKeep(id){
  const t = T(id); if (!t || !t.review) return;
  endReview(t); t.stageAt = nowISO(); logTask(t, `Kept in ${stageNameOf(t, t.status)} after review; the clock starts again`); t.updated = nowISO();
}
/* "Something else" for a task in review: move it to any stage of its board, mark it complete, archive it or delete it. */
function reviewOther(id, how){
  const t = T(id); if (!t || !t.review) return;
  const title = t.title;
  endReview(t);
  if (how === 'delete'){ deleteTask(id); return; }
  if (how === 'archive'){ archiveTasks([id], true, 'Archived from the review'); toast(`Archived "${title}".`, { label:'Undo', fn:() => { archiveTasks([id], false); render(); } }, 5000); return; }
  if (how === 'done'){ const dn = doneIdFor(t.boardId); t.prevStatus = t.status; moveTask(id, dn, topOrder(dn), true); return; }
  if (how.startsWith('stage:')){ const to = how.slice(6); if (to !== t.status && stagesOf(t.boardId).some(x => x.id === to)) moveTask(id, to, topOrder(to), true); }
}
function afterReview(){
  save(); render();
  if (!pendingReviews().length){ closeModal(); toast('All reviewed.', null, 2500); } else renderModal();
}
function reviewHTML(){
  const list = pendingReviews(), today = todayStr();
  const rows = list.map(t => { const r = t.review, to = stageNameOf(t, r.to), from = stageNameOf(t, t.status), n = daysInStage(t, today);
    return `<div class="field-row" style="align-items:flex-start;gap:12px"><span style="min-width:0;flex:1"><b style="font-weight:600;display:block;overflow-wrap:anywhere">${esc(t.title)}</b><span class="note">${esc(boardName(t.boardId))} · in ${esc(from)} for ${n} day${n === 1 ? '' : 's'}</span></span>
      <span class="flex gap-1" style="flex-shrink:0;flex-wrap:wrap;justify-content:flex-end"><button class="btn btn-sm btn-primary" data-act="rv-move" data-id="${t.id}">Move to ${esc(to)}</button><button class="btn btn-sm" data-act="rv-keep" data-id="${t.id}">Keep in ${esc(from)}</button>
        <select class="inp" style="width:auto;height:32px;padding:0 8px;font-size:13px" data-rv-more="${t.id}" aria-label="Something else for ${esc(t.title)}"><option value="">Something else…</option>
          <optgroup label="Move to">${stagesOf(t.boardId).filter(x => x.id !== t.status && !x.done).map(x => `<option value="stage:${esc(x.id)}">${esc(x.name)}</option>`).join('')}</optgroup>
          <optgroup label="Finish">${isDone(t) ? '' : '<option value="done">Mark complete</option>'}<option value="archive">Archive</option><option value="delete">Delete</option></optgroup></select></span></div>`; }).join('');
  return `<div class="m-back"><div class="m-panel" style="max-width:640px" role="dialog" aria-modal="true" aria-label="Review"><div class="m-head"><h2 class="font-display" style="font-weight:700;font-size:18px;flex:1">${list.length} task${list.length === 1 ? '' : 's'} to review</h2><button class="btn btn-ghost btn-icon" data-act="rv-close" aria-label="Decide later">${ic('x')}</button></div>
    <div class="m-body single"><p class="note" style="margin-bottom:8px">These have been in their column longer than your automation settings allow. They are flagged until you decide. <b>Keep</b> starts the clock again.</p>${rows || '<p class="note">Nothing to review.</p>'}</div>
    <div class="m-foot">${list.length > 1 ? `<button class="btn" data-act="rv-move-all">${ic('check-check')}Move all</button>` : ''}<span style="flex:1"></span><button class="btn" data-act="rv-close">Decide later</button></div></div></div>`;
}
function runAutomation(){
  const A = S.settings.automation;
  const od = runOverdueRules() + runDateRules() + runStale();
  const moves = autoMove(S.tasks, A, todayStr(), S.boards), old = autoArchive(S.tasks, A, Date.now(), S.boards);
  if (!moves.length && !old.length){ if (od) save(); return od; }
  if (moves.length){
    applyMoves(moves);
    const names = moves.slice(0, 2).map(m => `"${m.t.title}"`).join(', ');
    toast(`Automation moved ${moves.length} task${moves.length > 1 ? 's' : ''}: ${names}${moves.length > 2 ? '…' : ''}`, null, 6000);
  }
  if (old.length){
    const ids = old.map(t => t.id);
    archiveTasks(ids, true, 'Archived automatically');
    toast(`Archived ${old.length} Done task${old.length > 1 ? 's' : ''} finished more than ${A.archiveDays} days ago.`, { label:'Undo', fn:() => { archiveTasks(ids, false); render(); } }, 8000);
  }
  save();
  return moves.length + old.length + od;
}
function applyManualStatus(t, status){
  t.autoMoved = null;
  if (status === 'scheduled'){ t.scheduledFlow = true; t.locked = false; }
  else { t.scheduledFlow = false; t.locked = true; }
}
function afterStatus(t, old){
  const wasDone = !!(stagesOf(t.boardId).find(x => x.id === old) || {}).done;
  if (isDone(t) && !wasDone && t.repeat) announceRepeat(spawnRepeat(t, 'completed'));
  if (isDone(t)){
    t.inProcess = false;
    const freed = S.tasks.filter(x => x.deps.includes(t.id) && !isDone(x) && !isBlocked(x, S.tasks, S.boards));
    if (freed.length) toast(`Unblocked: ${freed.slice(0, 2).map(x => x.title).join(', ')}${freed.length > 2 ? '…' : ''}`, null, 5000);
  } else if (['in-progress', 'review'].includes(t.status) && isBlocked(t, S.tasks, S.boards)){
    const b = t.deps.map(T).find(d => d && !isDone(d));
    if (b) toast(`Heads up: blocked by "${b.title}"`, null, 5000);
  }
}
function moveTask(id, status, order, quiet, pin){
  const t = T(id); if (!t) return;
  const old = t.status;
  if (order != null) t.order = order;
  if (pin !== undefined) t.pin = pin; else if (status !== old) t.pin = null;   // a hand-placed slot belongs to its column
  if (status !== old){
    unstickChild(t);
    t.status = status; applyManualStatus(t, status);
    logTask(t, `Moved ${stageNameOf(t, old)} to ${stageNameOf(t, status)}`);
    afterStatus(t, old);
    fireRules(t, { type:'moved', value:status });
    followParent(t);
    if (!quiet) queueFollowUp(t);
  }
  t.updated = nowISO(); save(); render();
}
function changeBoard(id, boardId){
  const t = T(id); if (!t || t.boardId === boardId) return;
  unstickChild(t);
  t.status = mapStatus(t.status, boardOf(t.boardId), boardOf(boardId)); t.boardId = boardId; t.updated = nowISO(); logTask(t, `Moved to board "${boardName(boardId)}"`); followParent(t); save(); render();
  toast(`Moved to ${boardName(boardId)}`, null, 2500);
}
function setTaskDate(id, field, date){
  const t = T(id); if (!t) return;
  if (field === 'start'){ t.start = date; if (t.due && t.due < date) t.due = date; }
  else { t.due = date; if (t.start && t.start > date) t.start = date; }
  t.locked = false; t.updated = nowISO(); logTask(t, `${field === 'start' ? 'Start' : 'Due'} date set to ${fmtD(date)}`);
  runAutomation(); save(); render();
}
function quickCreate(status, title){
  const bid = primaryBoard(); status = stagesOf(bid).some(x => x.id === status) ? status : firstOpenStage(bid);
  const t = newTask(Object.assign(newTaskDefaults(bid), { title, status, order: nextOrder(status) }));
  if (status === 'scheduled') t.scheduledFlow = true;
  logTask(t, 'Created'); S.tasks.push(t); fireRules(t, { type:'created' }); save(); return t;
}
function deleteTask(id){
  const snap = JSON.stringify({ tasks:S.tasks, tombstones:S.tombstones });
  const t = T(id); if (!t) return;
  const nt = t.repeat ? spawnRepeat(t, 'deleted') : null;
  S.tasks = S.tasks.filter(x => x.id !== id);
  S.tasks.forEach(x => {
    x.deps = x.deps.filter(d => d !== id);
    if (x.parentId === id) x.parentId = null;
    x.subitems.forEach(s => { if (s.taskId === id) s.taskId = null; });
  });
  tombstone('task', id);
  save(); render();
  toast(`Deleted "${t.title}"${nt ? `. Next copy created for ${fmtD(nt.due || nt.start)}` : ''}`, { label:'Undo', fn:() => {
    const o = JSON.parse(snap); S.tasks = o.tasks.map(newTask); S.tombstones = o.tombstones; if (nt) tombstone('task', nt.id);
    const back = T(id); if (back) back.updated = nowISO();
    save(); render();
  } }, 7000);
}
/* Would making `taskId` wait on `depId` close a loop? `ov` (id to dependency list) stands in for edits not saved yet. */
function wouldCycle(taskId, depId, ov){
  const seen = new Set(); const stack = [depId];
  while (stack.length){
    const cur = stack.pop(); if (cur === taskId) return true;
    if (seen.has(cur)) continue; seen.add(cur);
    const deps = ov && ov.has(cur) ? ov.get(cur) : (T(cur) || {}).deps; if (deps) stack.push(...deps);
  }
  return false;
}
/* ---------- repeating tasks and stuck subtasks ---------- */
const repeatUndo = new WeakMap();
function spawnRepeat(t, why){
  const nt = t && t.repeat ? nextOccurrence(t, S.boards, todayStr()) : null; if (!nt) return null;
  nt.order = nextOrder(nt.status); logTask(nt, `Created by repeat (${why}: "${t.title}")`); S.tasks.push(nt);
  const saved = t.repeat; t.repeat = null; logTask(t, `Repeat: next copy created for ${fmtD(nt.due || nt.start)}`);
  repeatUndo.set(nt, () => { S.tasks = S.tasks.filter(x => x.id !== nt.id); tombstone('task', nt.id); const o = T(t.id); if (o && !o.repeat) o.repeat = saved; save(); render(); });
  return nt;
}
function announceRepeat(nt){
  if (!nt) return;
  toast(`Next "${nt.title}" created for ${fmtD(nt.due || nt.start)}.`, { label:'Undo', fn:repeatUndo.get(nt) }, 7000);
}
/* A subtask made into a task and marked "stick with parent" goes wherever its parent goes. */
function followParent(p){
  let n = 0;
  (p.subitems || []).forEach((s, i) => {
    const c = s.stick && s.taskId ? T(s.taskId) : null; if (!c || c.id === p.id) return;
    if (c.boardId === p.boardId && c.status === p.status) return;
    const wasDone = isDone(c);
    c.boardId = p.boardId; c.status = p.status; applyManualStatus(c, c.status); c.order = p.order + 0.001 * (i + 1); c.updated = nowISO();
    logTask(c, `Moved with its parent "${p.title}"`); n++;
    if (isDone(c) && !wasDone && c.repeat) announceRepeat(spawnRepeat(c, 'completed'));
  });
  return n;
}
/* Moving a stuck subtask by itself takes it off its parent. */
function unstickChild(t){
  const p = t.parentId ? T(t.parentId) : null, s = p && p.subitems.find(x => x.taskId === t.id && x.stick); if (!s) return false;
  s.stick = false; p.updated = nowISO(); logTask(p, `"${t.title}" no longer sticks with this task`); logTask(t, 'No longer sticks with its parent');
  toast(`"${t.title}" no longer sticks with its parent.`, null, 4500); return true;
}

/* ---------- toasts & confirm ---------- */
function toast(msg, action, ms = 4000){
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = `<span class="flex-1" style="flex:1;min-width:0">${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) $('button', el).onclick = () => { action.fn(); el.remove(); };
  $('#toasts').appendChild(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  setTimeout(() => el.remove(), ms);
}
function confirmBox({ title, body, ok = 'Confirm', danger = false }){
  return new Promise(res => {
    const r = $('#confirmRoot');
    r.innerHTML = `<div class="m-back" style="z-index:150"><div class="m-panel narrow" role="alertdialog" aria-modal="true"><div class="m-body single"><h2 class="font-display" style="font-weight:700;font-size:19px;margin-bottom:6px">${esc(title)}</h2><p class="note">${esc(body)}</p></div><div class="m-foot" style="justify-content:flex-end"><button class="btn" data-c="0">Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-c="1">${esc(ok)}</button></div></div></div>`;
    r.onclick = e => { const b = e.target.closest('[data-c]'); if (!b) return; r.innerHTML = ''; r.onclick = null; res(b.dataset.c === '1'); };
  });
}

/* ---------- rendering: sidebar ---------- */
function renderSidebar(){
  const sel = selIds(), allOn = sel.size === S.boards.length;
  const open = id => S.tasks.filter(t => t.boardId === id && !isDone(t) && !t.archived).length;
  const f = S.settings.filters;
  const rowFor = b => `
        <div class="side-row side-board ${sel.has(b.id) && !allOn ? 'on' : ''}" data-drop-board="${b.id}">
          <button class="chk" data-act="board-toggle" data-id="${b.id}" aria-label="Include ${esc(b.name)}" aria-pressed="${sel.has(b.id)}" style="${sel.has(b.id) ? '' : ''}">${sel.has(b.id) ? ic('check', 'w-3 h-3') : ''}</button>
          <button class="side-name" data-act="board-only" data-id="${b.id}"><span class="dot" style="background:${hsl(b.h, 65, 52)}"></span><span class="truncate">${esc(b.name)}</span></button>
          <span class="count">${open(b.id)}</span>
          <button class="side-edit" data-act="board-edit" data-id="${b.id}" aria-label="Edit ${esc(b.name)}">${ic('more-horizontal')}</button>
        </div>`;
  const folders = [...new Set(S.boards.map(b => b.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const boardsHTML = S.boards.filter(b => !b.folder).map(rowFor).join('') + folders.map(fo => `<button class="side-folder" data-act="folder-toggle" data-f="${esc(fo)}" aria-expanded="${!ui.foldersOff[fo]}">${ic(ui.foldersOff[fo] ? 'chevron-right' : 'chevron-down', 'w-3.5 h-3.5')}${ic('folder', 'w-4 h-4')}<span class="truncate">${esc(fo)}</span></button>${ui.foldersOff[fo] ? '' : '<div class="side-indent">' + S.boards.filter(b => b.folder === fo).map(rowFor).join('') + '</div>'}`).join('');
  $('#side').innerHTML = `
    <div class="flex items-center gap-2" style="padding:0 6px 10px">
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" style="color:var(--accent)"><rect x="2" y="3" width="5" height="18" rx="1.6" fill="currentColor" opacity=".35"/><rect x="9.5" y="3" width="5" height="12" rx="1.6" fill="currentColor" opacity=".65"/><rect x="17" y="3" width="5" height="7" rx="1.6" fill="currentColor"/></svg>
      <span class="brand">Cursus CoS</span>
    </div>
    <div class="side-scroll">
      <div class="side-h"><span>Views</span><button class="btn btn-ghost btn-sm btn-icon" data-act="sv-new" aria-label="Save a view" title="Save a view: a layout plus the boards and projects to show">${ic('plus')}</button></div>
      ${viewsSideHTML()}
      <div class="side-h"><span>Boards</span><button class="btn btn-ghost btn-sm btn-icon" data-act="board-new" aria-label="New board">${ic('plus')}</button></div>
      <button class="side-row ${allOn ? 'on' : ''}" data-act="board-all">${ic('layers', 'w-4 h-4')}<span class="flex-1" style="flex:1">All boards</span><span class="count">${S.tasks.filter(t => !isDone(t) && !t.archived).length}</span></button>
      ${boardsHTML}
      <p class="note" style="padding:4px 8px 0;font-size:11.5px">Tick several boards to see their tasks together.</p>
      <div class="side-h"><span>Projects</span><button class="btn btn-ghost btn-sm btn-icon" data-act="proj-new" aria-label="New project">${ic('plus')}</button></div>
      ${S.projects.length ? S.projects.map(p => {
        const ts = S.tasks.filter(t => t.projectId === p.id), dn = ts.filter(t => isDone(t)).length, on = f.projects.includes(p.id);
        return `<div class="side-row ${on ? 'on' : ''}">
          <button class="side-name" data-act="proj-filter" data-id="${p.id}" aria-pressed="${on}" style="height:auto;min-height:32px;padding:3px 0">
            <span class="dot" style="background:${hsl(p.h, 60, 52)}"></span>
            <span style="flex:1;min-width:0"><span class="truncate" style="display:block">${esc(p.name)}</span><span class="bar-mini" style="display:block"><i style="width:${ts.length ? Math.round(dn / ts.length * 100) : 0}%"></i></span></span>
          </button>
          <span class="count">${dn}/${ts.length}</span>
          <button class="side-edit" data-act="proj-edit" data-id="${p.id}" aria-label="Edit ${esc(p.name)}">${ic('more-horizontal')}</button>
        </div>`; }).join('') : `<p class="note" style="padding:4px 8px">Projects group tasks across boards.</p>`}
      <div class="side-h"><span>Smart views</span></div>
      <button class="side-row ${f.email ? 'on' : ''}" data-act="f-flag" data-k="email">${ic('mail')}<span style="flex:1">From email</span><span class="count">${S.tasks.filter(isEmail).length}</span></button>
      <button class="side-row ${f.due === 'overdue' ? 'on' : ''}" data-act="f-due" data-v="${f.due === 'overdue' ? 'any' : 'overdue'}">${ic('alert-triangle')}<span style="flex:1">Overdue</span><span class="count">${S.tasks.filter(t => !t.archived && dueState(t, todayStr(), S.boards) === 'overdue').length}</span></button>
      ${pendingReviews().length ? `<button class="side-row" data-act="review-open">${ic('hourglass')}<span style="flex:1">Needs review</span><span class="count">${pendingReviews().length}</span></button>` : ''}
      <button class="side-row ${f.archived ? 'on' : ''}" data-act="f-flag" data-k="archived">${ic('archive')}<span style="flex:1">Archive</span><span class="count">${S.tasks.filter(t => t.archived).length}</span></button>
    </div>
    ${S.meta.sync.mode !== 'off' ? `<div id="syncChip" class="note truncate" style="padding:6px 8px 0;font-size:11.5px">${esc(syncLabel())}</div>` : ''}
    <div class="side-foot">
      <button class="btn btn-ghost" style="flex:1;justify-content:flex-start" data-act="settings">${ic('settings')}Settings</button>
      <button class="btn btn-ghost btn-icon" data-act="theme-cycle" aria-label="Change theme" title="Theme: ${S.settings.theme}">${ic(S.settings.theme === 'dark' ? 'moon' : S.settings.theme === 'light' ? 'sun' : 'monitor')}</button>
    </div>`;
}

/* ---------- rendering: toolbar ---------- */
function statsText(){
  const sc = scope(), vis = visible(), today = todayStr();
  const open = sc.filter(t => !isDone(t)).length, late = sc.filter(t => dueState(t, today, S.boards) === 'overdue').length;
  const showing = vis.length !== sc.length ? `${vis.length} of ${sc.length} shown` : `${sc.length} tasks`;
  if (S.settings.filters.archived) return `Archive · ${showing}`;
  return `${showing} · ${open} open${late ? ` · ${late} overdue` : ''}`;
}
function renderToolbar(){
  const sel = selBoards(), all = sel.length === S.boards.length;
  const title = sel.length === 1 ? sel[0].name : all ? 'All boards' : `${sel.length} boards`;
  const f = filterCount(), due = dueReminders().length;
  $('#toolbar').innerHTML = `
    <div class="flex items-center gap-2" style="min-width:0;flex:1 1 220px">
      <button class="btn btn-ghost btn-icon only-mobile" data-act="side-open" aria-label="Open menu">${ic('menu')}</button>
      <div style="min-width:0"><h1 class="tb-title truncate">${esc(title)}</h1><p id="tbStats" class="tb-sub truncate">${esc(statsText())}</p></div>
    </div>
    <div class="tb-right flex items-center gap-2 flex-wrap" style="justify-content:flex-end">
      ${sel.length === 1 ? `<button class="btn btn-icon" data-act="board-settings" aria-label="Board settings" title="Board settings">${ic('settings-2')}</button>` : ''}
      <label class="search">${ic('search')}<input id="search" type="search" placeholder="Search tasks" value="${esc(ui.search)}" aria-label="Search tasks" autocomplete="off"></label>
      <button class="btn ${f ? 'on' : ''}" data-act="pop-filter" aria-haspopup="true">${ic('sliders-horizontal')}<span class="hide-sm">Filter</span>${f ? `<span class="badge">${f}</span>` : ''}</button>
      <button class="btn" data-act="pop-color" aria-haspopup="true">${ic('palette')}<span class="hide-sm">Color</span></button>
      <button class="btn btn-icon" data-act="pop-bell" aria-label="Reminders" aria-haspopup="true">${ic(due ? 'bell-ring' : 'bell')}${due ? `<span class="badge">${due}</span>` : ''}</button>
      <button class="btn" data-act="paste-open" title="Paste lines as tasks">${ic('clipboard-paste')}<span class="hide-sm">Paste tasks</span></button>
      <button class="btn btn-primary" data-act="new-task">${ic('plus')}<span>New task</span></button>
    </div>`;
}
function renderNotice(){
  const n = $('#notice'); const parts = [];
  if (S.settings.filters.archived) parts.push(`<span style="flex:1;min-width:0">You are looking at the Archive. Archived tasks stay out of your boards, calendar and reminders until you restore them.</span><button class="btn btn-sm" data-act="f-flag" data-k="archived">Back to active tasks</button>`);
  else if (S.sample) parts.push(`<span style="flex:1;min-width:0">You are looking at sample data. Edit freely, then clear it when you are ready to start your own.</span><button class="btn btn-sm" data-act="clear-sample">Clear sample data</button>`);
  else if (!storageOK) parts.push(`<span style="flex:1">This browser is blocking local storage, so changes will not survive a refresh. Use Settings → Data to copy a backup.</span>`);
  n.className = parts.length ? 'panel show' : 'panel'; n.innerHTML = parts.join('');
}

/* ---------- rendering: board view ---------- */
/* ---------- rendering: cards, board (Kanban), list ---------- */
const isSub = id => S.settings.subscribed.includes(id);
const pTags = id => S.settings.personalTags[id] || [];
const initials = n => String(n).trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
const avatar = n => `<span class="avatar" title="${esc(n)}" style="background:${hsl(hashId(n) % 360, 45, 44)}">${esc(initials(n))}</span>`;
const snippet = (s, n = 140) => { const x = String(s || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
function dateChip(t){
  if (!t.start && !t.due) return '';
  const today = todayStr(), ds = dueState(t, today, S.boards);
  let label = t.start && t.due && t.start !== t.due ? `${fmtD(t.start)} → ${fmtD(t.due)}` : t.due ? fmtD(t.due) : `Starts ${fmtD(t.start)}`;
  let cls = '';
  if (ds === 'overdue'){ cls = 'late'; label += ` · ${-diffDays(today, t.due)}d late`; }
  else if (ds === 'today'){ cls = 'today'; label += ' · today'; }
  else if (ds === 'soon') cls = 'soon';
  return `<span class="dchip ${cls}">${ic('calendar', 'w-3 h-3')}${esc(label)}</span>`;
}
const circleHTML = t => { const on = isDone(t); return `<button type="button" class="cbtn ${on ? 'on' : ''}" data-act="task-done" data-id="${t.id}" aria-pressed="${on}" aria-label="${on ? 'Mark not complete' : 'Mark complete'}: ${esc(t.title)}" title="${on ? 'Completed. Click to reopen.' : 'Mark complete'}">${on ? ic('check', 'w-3 h-3') : ''}</button>`; };
const procBtnHTML = t => `<button type="button" class="proc-btn ${t.inProcess ? 'on' : ''}" data-act="toggle-proc" data-id="${t.id}" aria-pressed="${!!t.inProcess}" aria-label="${t.inProcess ? 'In process. Click to clear' : 'Mark as in process'}" title="${t.inProcess ? 'In process (click to clear)' : 'Mark as in process: highlights the card without moving it'}">${ic('activity', 'w-4 h-4')}</button>`;
const menuBtnHTML = id => `<button type="button" class="card-menu" data-act="task-menu" data-id="${id}" aria-label="Task actions" aria-haspopup="menu">${ic('more-horizontal', 'w-4 h-4')}</button>`;
const titleHTML = (t, cls = 't-title') => ui.rename === t.id
  ? `<input class="t-rename" data-rename="${t.id}" value="${esc(ui.renameVal)}" maxlength="200" aria-label="Task title">`
  : `<h4 class="${cls}">${esc(t.title)}</h4>`;
const fieldShown = (t, id) => { const b = boardOf(t.boardId); return !b || !b.fields.hidden.includes(id); };
function cfChips(t, labelsOnly){
  const b = boardOf(t.boardId); if (!b) return '';
  return b.fields.custom.filter(f => !b.fields.hidden.includes('cf:' + f.id) && (!labelsOnly || f.type === 'label')).map(f => {
    const v = Tools.customText(f, t); if (!v) return '';
    const o = f.type === 'label' ? f.options.find(x => x.id === t.custom[f.id]) : null;
    return `<span class="tag cf" title="${esc(f.name)}" ${o ? `style="background:${hsl(o.h == null ? 210 : o.h, 55, 42)};color:#fff"` : ''}>${f.type === 'label' ? '' : esc(f.name) + (f.type === 'check' ? '' : ': ')}${f.type === 'check' ? '' : esc(v)}</span>`;
  }).join('');
}
function statusIcons(t){
  const blocked = isBlocked(t, S.tasks, S.boards), auto = t.autoMoved && Date.now() - new Date(t.autoMoved.at).getTime() < 48 * 36e5;
  return [
    blocked ? `<span class="ico" title="Blocked by unfinished dependencies">${ic('link-2', 'w-3.5 h-3.5')}${t.deps.length}</span>` : (t.deps.length ? `<span class="ico" title="Has dependencies (all done)">${ic('link-2', 'w-3.5 h-3.5')}${t.deps.length}</span>` : ''),
    t.reminder ? `<span class="ico" title="Reminder set">${ic('bell', 'w-3.5 h-3.5')}</span>` : '',
    isEmail(t) ? `<span class="ico" title="Created from email">${ic('mail', 'w-3.5 h-3.5')}</span>` : '',
    isSub(t.id) ? `<span class="ico" title="You are subscribed to this task">${ic('rss', 'w-3.5 h-3.5')}</span>` : '',
    t.parentId && T(t.parentId) ? `<span class="ico" title="Subitem of ${esc(T(t.parentId).title)}">${ic('corner-down-right', 'w-3.5 h-3.5')}</span>` : '',
    t.pin != null && rankOn() && !isDone(t) ? `<span class="ico" title="Placed by hand, so it stays here. Right-click, Let it rank automatically, to release it.">${ic('pin', 'w-3.5 h-3.5')}</span>` : '',
    auto ? `<span class="ico ico-zap" title="Moved automatically: ${esc(t.autoMoved.why)}">${ic('zap', 'w-3.5 h-3.5')}</span>` : '',
    t.review ? `<span class="ico" title="Waiting for your review: move to ${esc(stageNameOf(t, t.review.to))}?">${ic('hourglass', 'w-3.5 h-3.5')}</span>` : ''
  ].filter(Boolean).join('');
}
/* How much a card shows is the view's "task details" level: 0 title only, 1 adds priority and dates, 2 adds tags, progress and
   people, 3 adds the notes, custom fields, attachments and comments. */
function cardHTML(t, multi, lv = 2){
  const c = colorOf(t), blocked = isBlocked(t, S.tasks, S.boards), sp = subProg(t), p = projOf(t.projectId), b = boardOf(t.boardId), sf = id => fieldShown(t, id);
  const tags = sf('tags') ? t.tags : [], shown = tags.slice(0, 3), more = tags.length - shown.length, pt = pTags(t.id);
  const icons = statusIcons(t), people = sf('assignees') ? t.assignees : [];
  const cf = lv >= 3 ? cfChips(t, false) : lv >= 2 ? cfChips(t, true) : '';
  const meta = lv >= 1 ? `<div class="meta">${sf('priority') ? impChip(t) : ''}${sf('dates') ? dateChip(t) + repChip(t) : ''}${sf('estimate') && t.estimate ? `<span class="mono" style="display:inline-flex;align-items:center;gap:3px">${ic('timer', 'w-3 h-3')}${fmtEst(t.estimate)}</span>` : ''}</div>` : '';
  let body = '';
  if (lv >= 3 && t.description) body += `<p class="c-desc">${esc(snippet(t.description))}</p>`;
  if (lv >= 2 && (shown.length || pt.length || cf)) body += `<div class="flex flex-wrap gap-1">${shown.map(x => `<span class="tag">${esc(x)}</span>`).join('')}${more > 0 ? `<span class="tag">+${more}</span>` : ''}${pt.map(x => `<span class="tag ptag" title="Personal tag (only on this device)">${ic('star', 'w-3 h-3')}${esc(x)}</span>`).join('')}${cf}</div>`;
  if (lv >= 2 && ((multi && b) || (p && sf('project')))) body += `<div class="meta-row">${multi && b ? `<span class="inline-flex items-center gap-1 truncate"><span class="dot" style="background:${hsl(b.h, 65, 52)};width:7px;height:7px"></span>${esc(b.name)}</span>` : ''}${p && sf('project') ? `<span class="inline-flex items-center gap-1 truncate" style="color:var(--ink-2)">${ic('folder', 'w-3 h-3')}${esc(p.name)}</span>` : ''}</div>`;
  const counts = lv >= 3 ? `${t.attachments.length ? `<span class="ico" title="Attachments">${ic('paperclip', 'w-3.5 h-3.5')}${t.attachments.length}</span>` : ''}${t.comments.length ? `<span class="ico" title="Comments">${ic('message-square', 'w-3.5 h-3.5')}${t.comments.length}</span>` : ''}` : '';
  if (lv >= 2 && (sp || icons || counts || people.length)) body += `<div class="meta-row">${sp ? `<span class="inline-flex items-center gap-1 mono" style="font-size:11px">${ic('list-checks', 'w-3.5 h-3.5')}${sp.d}/${sp.n}</span><span class="sub-bar"><i style="width:${sp.pct}%"></i></span>` : '<span style="flex:1"></span>'}<span class="inline-flex items-center gap-2" style="margin-left:auto">${counts}${icons}${people.length ? `<span class="avatars">${people.slice(0, 3).map(avatar).join('')}${people.length > 3 ? `<span class="avatar more">+${people.length - 3}</span>` : ''}</span>` : ''}</span></div>`;
  return `<article class="card ${c ? 'tint' : 'plain'} ${blocked ? 'is-blocked' : ''} ${isDone(t) ? 'is-done' : ''} ${t.inProcess && !isDone(t) ? 'in-proc' : ''}" tabindex="0" data-drag="card" data-id="${t.id}" data-act="open-task" style="${c ? `--h:${c.h};--s:${c.s}` : ''}">
    <div class="c-top">${circleHTML(t)}${titleHTML(t)}${procBtnHTML(t)}${menuBtnHTML(t.id)}</div>${meta}${body}
  </article>`;
}
function quickHTML(gid, lane = ''){
  if (ui.quick === gid + '|' + lane) return `<input class="inp" data-quick="${esc(gid)}" data-lane="${esc(lane)}" placeholder="Task title, then Enter" maxlength="200" aria-label="New task title">`;
  return `<button class="quick-add" data-act="quick-open" data-gid="${esc(gid)}" data-lane="${esc(lane)}" data-status="${esc(gid)}">${ic('plus')}Add task</button>`;
}
const gctx = () => ({ projects:S.projects, boards:selBoards(), tasks:scope(), fields:viewFields(), today:todayStr() });
const groupFor = v => Tools.groupDefs(v.group, gctx());
const laneFor = v => { const H = groupFor(v); return v.vgroup && v.vgroup !== H.group ? Tools.groupDefs(v.vgroup, gctx()) : null; };
function aggHTML(items, agg){
  if (agg === 'none') return '';
  const est = items.reduce((a, t) => a + (t.estimate || 0), 0);
  return `${agg !== 'estimate' ? `<span class="count">${items.length}</span>` : ''}${agg !== 'count' ? `<span class="est mono">${fmtEst(est) || (agg === 'estimate' ? '0m' : '')}</span>` : ''}`;
}
const rankOn = () => !!S.settings.automation && S.settings.automation.rank !== false;
/* Manual order: cards placed by hand keep their slot (their pin); the rest rank by importance and urgency around them.
   Done columns keep plain manual order. */
const sortFor = (view, items, done) => view.sort === 'manual' ? (rankOn() && !done ? rankOrder(items, todayStr()) : items.slice().sort(byOrder)) : Tools.sortTasks(items, view.sort, view.sortDir);
let colIds = {};   // column key -> task ids in the order shown, for the column Sort button
function splitBy(def, items){
  const m = new Map(def.groups.map(g => [g.id, []]));
  for (const t of items){ const k = def.keyOf(t); (m.get(k) || m.get(def.groups[0].id)).push(t); }
  return m;
}
function colHTML(H, g, items, lane, view, multi, archMode){
  const lv = view.detail == null ? 2 : view.detail, lk = lane + '|' + g.id;
  const isDoneCol = H.group === 'status' && !!g.done, all = sortFor(view, items, isDoneCol);
  colIds[lk] = all.map(t => t.id);
  // Big columns (hundreds of finished tasks, say) show the first batch and a button for the rest.
  const lim = (isDoneCol ? 25 : 100) + (ui.limits[lk] || 0), list = all.slice(0, lim), hidden = all.length - list.length;
  const canAdd = H.editable && !archMode;
  return `<section class="col" data-gid="${esc(g.id)}" data-lane="${esc(lane)}" ${H.group === 'status' ? `data-status="${esc(g.id)}"` : ''} ${H.editable ? '' : 'data-drop="0"'} aria-label="${esc(g.name)}">
    <div class="col-h"><span class="dot" style="background:${hsl(g.h, Math.max(g.s, 30), 52)}"></span><h3>${esc(g.name)}</h3>${aggHTML(all, view.agg)}${!isDoneCol && !archMode && view.sort === 'manual' && all.length > 1 ? `<button class="btn btn-ghost btn-sm btn-icon" data-act="col-sort" data-key="${esc(lk)}" aria-label="Sort ${esc(g.name)} by importance and urgency" title="Sort this column: most important and urgent first">${ic('arrow-down-wide-narrow', 'w-3.5 h-3.5')}</button>` : ''}${isDoneCol && all.length && !archMode ? `<button class="btn btn-ghost btn-sm btn-icon" data-act="archive-done" aria-label="Archive done tasks" title="Archive done tasks">${ic('archive', 'w-3.5 h-3.5')}</button>` : ''}${canAdd ? `<button class="btn btn-ghost btn-sm btn-icon" data-act="quick-open" data-gid="${esc(g.id)}" data-lane="${esc(lane)}" aria-label="Add a task to ${esc(g.name)}" title="Add a task">${ic('plus', 'w-3.5 h-3.5')}</button>` : ''}</div>
    <div class="col-body" data-key="${esc(lk)}">${list.map(t => cardHTML(t, multi, lv)).join('')}</div>
    <div class="col-foot">${hidden > 0 ? `<button class="quick-add" data-act="col-more" data-key="${esc(lk)}">${ic('chevrons-down')}Show ${Math.min(50, hidden)} more (${hidden} hidden)</button>` : ''}${canAdd ? quickHTML(g.id, lane) : ''}</div>
  </section>`;
}
function kanbanHTML(tasks, view){
  const multi = selBoards().length > 1, archMode = !!S.settings.filters.archived, H = groupFor(view), L = laneFor(view);
  colIds = {};
  const cols = splitBy(H, tasks);
  if (!L) return `<div class="board" id="boardScroll">${H.groups.map(g => colHTML(H, g, cols.get(g.id), '', view, multi, archMode)).join('')}</div>`;
  const lanes = splitBy(L, tasks), shownLanes = L.groups.filter(g => lanes.get(g.id).length || L.group === 'status');
  return `<div class="board lanes" id="boardScroll">${(shownLanes.length ? shownLanes : L.groups.slice(0, 1)).map(lg => {
    const inLane = lanes.get(lg.id), per = splitBy(H, inLane), off = !!ui.lanesOff[lg.id];
    return `<section class="lane" data-lane-id="${esc(lg.id)}"><button class="lane-h" data-act="lane-toggle" data-lane="${esc(lg.id)}" aria-expanded="${!off}">${ic(off ? 'chevron-right' : 'chevron-down', 'w-4 h-4')}<span class="dot" style="background:${hsl(lg.h, Math.max(lg.s, 30), 52)}"></span><b>${esc(lg.name)}</b><span class="count">${inLane.length}</span></button>
      ${off ? '' : `<div class="lane-cols">${H.groups.map(g => colHTML(H, g, per.get(g.id), lg.id, view, multi, archMode)).join('')}</div>`}</section>`;
  }).join('')}</div>`;
}
function rowHTML(t, multi, lv){
  const c = colorOf(t), sp = subProg(t), sf = id => fieldShown(t, id), tags = sf('tags') ? t.tags : [], people = sf('assignees') ? t.assignees : [], b = boardOf(t.boardId);
  const chips = [lv >= 1 && sf('priority') ? impChip(t) : '', lv >= 1 && sf('dates') ? dateChip(t) + repChip(t) : '',
    lv >= 1 && sf('estimate') && t.estimate ? `<span class="mono" style="display:inline-flex;align-items:center;gap:3px">${ic('timer', 'w-3 h-3')}${fmtEst(t.estimate)}</span>` : '',
    lv >= 2 ? tags.slice(0, 3).map(x => `<span class="tag">${esc(x)}</span>`).join('') + pTags(t.id).map(x => `<span class="tag ptag">${ic('star', 'w-3 h-3')}${esc(x)}</span>`).join('') + cfChips(t, lv < 3) : '',
    lv >= 2 && multi && b ? `<span class="inline-flex items-center gap-1"><span class="dot" style="background:${hsl(b.h, 65, 52)};width:7px;height:7px"></span>${esc(b.name)}</span>` : '',
    lv >= 2 && sp ? `<span class="inline-flex items-center gap-1 mono" style="font-size:11px">${ic('list-checks', 'w-3.5 h-3.5')}${sp.d}/${sp.n}</span>` : '',
    lv >= 2 ? statusIcons(t) : '', lv >= 2 && people.length ? `<span class="avatars">${people.slice(0, 3).map(avatar).join('')}</span>` : ''].filter(Boolean).join('');
  return `<div class="lrow ${c ? 'tint' : 'plain'} ${isDone(t) ? 'is-done' : ''} ${t.inProcess && !isDone(t) ? 'in-proc' : ''}" tabindex="0" data-id="${t.id}" data-act="open-task" style="${c ? `--h:${c.h};--s:${c.s}` : ''}">
    ${circleHTML(t)}<div class="lr-main">${titleHTML(t, 'lr-title')}${lv >= 3 && t.description ? `<p class="c-desc">${esc(snippet(t.description, 180))}</p>` : ''}</div><div class="lr-meta">${chips}</div>${procBtnHTML(t)}${menuBtnHTML(t.id)}</div>`;
}
function listHTML(tasks, view){
  const multi = selBoards().length > 1, lv = view.detail == null ? 2 : view.detail, H = view.group ? groupFor(view) : null;
  const sections = H ? H.groups.map(g => ({ g, items: sortFor(view, tasks.filter(t => H.keyOf(t) === g.id), H.group === 'status' && !!g.done) })).filter(s => s.items.length) : [{ g:null, items: sortFor(view, tasks) }];
  if (!sections.length || !sections[0].items.length) return `<div class="list-wrap panel"><p class="note" style="padding:28px;text-align:center">No tasks match the current search and filters.</p></div>`;
  return `<div class="list-wrap panel">${sections.map(({ g, items }) => {
    const key = 'list|' + (g ? g.id : ''), off = g && ui.groupsOff[g.id], lim = 100 + (ui.limits[key] || 0), list = items.slice(0, lim), hidden = items.length - list.length;
    return `<section class="lsec">${g ? `<button class="lsec-h" data-act="group-toggle" data-gid="${esc(g.id)}" aria-expanded="${!off}">${ic(off ? 'chevron-right' : 'chevron-down', 'w-4 h-4')}<span class="dot" style="background:${hsl(g.h, Math.max(g.s, 30), 52)}"></span><b>${esc(g.name)}</b>${aggHTML(items, view.agg)}</button>` : ''}
      ${off ? '' : `<div class="lrows">${list.map(t => rowHTML(t, multi, lv)).join('')}${hidden > 0 ? `<button class="quick-add" data-act="col-more" data-key="${esc(key)}">${ic('chevrons-down')}Show ${Math.min(50, hidden)} more (${hidden} hidden)</button>` : ''}</div>`}</section>`;
  }).join('')}</div>`;
}

/* ---------- rendering: table view ---------- */
const SORTS = {
  title: t => t.title.toLowerCase(), board: t => boardName(t.boardId).toLowerCase(), project: t => projName(t.projectId).toLowerCase(),
  status: t => stageIndex(t), priority: t => -t.importance, start: t => t.start || '9999', due: t => t.due || '9999',
  est: t => t.estimate || 0, progress: t => { const p = subProg(t); return p ? p.pct : -1; }, assignee: t => (t.assignees[0] || '~').toLowerCase()
};
function tableHTML(tasks){
  const { key, dir } = ui.sort, fn = SORTS[key] || SORTS.status;
  const rows = tasks.slice().sort((a, b) => { const x = fn(a), y = fn(b); return (x < y ? -1 : x > y ? 1 : byOrder(a, b)) * dir; });
  const shownRows = rows.slice(0, ui.tableLimit), hiddenRows = rows.length - shownRows.length;
  const more = hiddenRows > 0 ? `<div style="padding:8px 10px 14px"><button class="btn" data-act="table-more">Show ${Math.min(200, hiddenRows)} more (${hiddenRows} hidden)</button></div>` : '';
  const th = (k, label) => `<th><button data-act="sort" data-k="${k}">${label}${ui.sort.key === k ? ic(dir > 0 ? 'chevron-down' : 'chevron-up', 'w-3 h-3') : ''}</button></th>`;
  const cfs = viewFields().filter(f => !selBoards().every(b => b.fields.hidden.includes('cf:' + f.id)));
  return `<div class="tbl-wrap panel"><table class="tbl"><thead><tr>${th('title', 'Task')}${th('board', 'Board')}${th('project', 'Project')}${th('status', 'Stage')}${th('priority', 'Importance')}${th('assignee', 'Assigned')}${th('start', 'Start')}${th('due', 'Due')}${th('est', 'Workload')}${th('progress', 'Subtasks')}${cfs.map(f => `<th><span class="th-plain">${esc(f.name)}</span></th>`).join('')}<th></th></tr></thead><tbody>${shownRows.map(t => {
    const c = colorOf(t), sp = subProg(t), b = boardOf(t.boardId), p = projOf(t.projectId), blocked = isBlocked(t, S.tasks, S.boards);
    const ds = dueState(t, todayStr(), S.boards);
    return `<tr class="row ${c ? 'tint' : 'plain'} ${isDone(t) ? 'is-done' : ''}" data-act="open-task" data-id="${t.id}" style="${c ? `--h:${c.h};--s:${c.s}` : ''}" tabindex="0">
      <td style="min-width:260px;max-width:380px"><div class="flex items-center gap-2">${circleHTML(t)}<div style="min-width:0;flex:1"><div style="font-weight:620">${ui.rename === t.id ? titleHTML(t) : esc(t.title)}</div>${t.tags.length ? `<div class="flex flex-wrap gap-1" style="margin-top:4px">${t.tags.slice(0, 4).map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : ''}</div></div></td>
      <td>${b ? `<span class="inline-flex items-center gap-1 truncate"><span class="dot" style="background:${hsl(b.h, 65, 52)}"></span>${esc(b.name)}</span>` : ''}</td>
      <td>${p ? `<span class="truncate" style="display:inline-block;max-width:150px">${esc(p.name)}</span>` : '<span style="color:var(--muted)">—</span>'}</td>
      <td><select class="cell-sel" data-tbl="status" data-id="${t.id}" aria-label="Stage">${stagesOf(t.boardId).map(c2 => `<option value="${c2.id}" ${c2.id === t.status ? 'selected' : ''}>${esc(c2.name)}</option>`).join('')}</select></td>
      <td><select class="cell-sel p-${t.priority}" data-tbl="priority" data-id="${t.id}" aria-label="Importance" style="font-weight:650">${[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(k => `<option value="${k}" ${k === t.importance ? 'selected' : ''}>${k}</option>`).join('')}</select></td>
      <td>${t.assignees.length ? `<span class="avatars">${t.assignees.slice(0, 3).map(avatar).join('')}</span>` : '<span style="color:var(--muted)">—</span>'}</td>
      <td class="mono">${fmtD(t.start) || '<span style="color:var(--muted)">—</span>'}</td>
      <td class="mono" style="${ds === 'overdue' ? 'color:var(--danger);font-weight:700' : ''}">${fmtD(t.due) || '<span style="color:var(--muted)">—</span>'}</td>
      <td class="mono">${fmtEst(t.estimate) || '<span style="color:var(--muted)">—</span>'}</td>
      <td style="min-width:110px">${sp ? `<div class="flex items-center gap-2"><span class="mono" style="font-size:12px">${sp.d}/${sp.n}</span><span class="sub-bar"><i style="width:${sp.pct}%"></i></span></div>` : '<span style="color:var(--muted)">—</span>'}</td>
      ${cfs.map(f => `<td>${esc(Tools.customText(f, t)) || '<span style="color:var(--muted)">—</span>'}</td>`).join('')}
      <td style="white-space:nowrap"><span class="inline-flex items-center gap-2">${blocked ? `<span title="Blocked">${ic('link-2', 'w-3.5 h-3.5')}</span>` : ''}${t.reminder ? ic('bell', 'w-3.5 h-3.5') : ''}${isEmail(t) ? ic('mail', 'w-3.5 h-3.5') : ''}${menuBtnHTML(t.id)}</span></td>
    </tr>`; }).join('')}</tbody></table>${more}${rows.length ? '' : `<p class="note" style="padding:28px;text-align:center">No tasks match the current search and filters.</p>`}</div>`;
}

/* ---------- rendering: calendar view ---------- */
function calHTML(tasks){
  const [Y, M] = ui.cal.split('-').map(Number), today = todayStr();
  const lead = new Date(Y, M - 1, 1).getDay(), dim = new Date(Y, M, 0).getDate(), rows = Math.ceil((lead + dim) / 7);
  const map = {}; const add = (d, x) => (map[d] = map[d] || []).push(x);
  tasks.forEach(t => { if (t.due) add(t.due, { t, k:'due' }); if (S.settings.calStarts && t.start && t.start !== t.due) add(t.start, { t, k:'start' }); });
  Object.values(map).forEach(a => a.sort((x, y) => (x.k === y.k ? 0 : x.k === 'due' ? -1 : 1) || y.t.importance - x.t.importance));
  const title = new Date(Y, M - 1, 1).toLocaleDateString('en-US', { month:'long', year:'numeric' });
  const chip = x => { const c = colorOf(x.t); return `<div class="cal-chip ${c ? 'tint' : 'plain'} ${x.k === 'start' ? 'is-start' : ''} ${isDone(x.t) ? 'is-done' : ''}" data-drag="cal" data-id="${x.t.id}" data-chip="${x.k}" data-act="open-task" tabindex="0" style="${c ? `--h:${c.h};--s:${c.s}` : ''}" title="${x.k === 'start' ? 'Starts: ' : ''}${esc(x.t.title)}">${x.k === 'start' ? '▸ ' : ''}${esc(x.t.title)}</div>`; };
  let cells = '';
  for (let i = 0; i < rows * 7; i++){
    const d = new Date(Y, M - 1, 1 - lead + i), ds = fmtISO(d), items = map[ds] || [];
    cells += `<div class="cal-day ${d.getMonth() !== M - 1 ? 'other' : ''} ${ds === today ? 'today' : ''} ${ds === ui.calSel ? 'sel' : ''}" data-date="${ds}" data-act="cal-sel" role="gridcell" aria-label="${ds}">
      <span class="dn">${d.getDate()}</span>${items.slice(0, 3).map(chip).join('')}${items.length > 3 ? `<span class="cal-more">+${items.length - 3} more</span>` : ''}</div>`;
  }
  const sel = map[ui.calSel] || [];
  const unsched = tasks.filter(t => !t.due && !isDone(t)).slice(0, 10);
  const mini = x => { const c = colorOf(x.t); return `<div class="mini ${c ? 'tint' : 'plain'}" data-drag="cal" data-id="${x.t.id}" data-chip="${x.k || 'due'}" data-act="open-task" tabindex="0" style="${c ? `--h:${c.h};--s:${c.s}` : ''}"><span class="truncate" style="flex:1;font-weight:600;font-size:13px">${esc(x.t.title)}</span>${impChip(x.t, 'font-size:10.5px')}</div>`; };
  return `<div class="cal-wrap"><div class="cal-main panel">
    <div class="cal-head"><h2>${title}</h2>
      <button class="btn btn-sm ${S.settings.calStarts ? 'on' : ''}" data-act="cal-starts" aria-pressed="${S.settings.calStarts}">Show start dates</button>
      <button class="btn btn-sm btn-icon" data-act="cal-prev" aria-label="Previous month">${ic('chevron-left')}</button>
      <button class="btn btn-sm" data-act="cal-today">Today</button>
      <button class="btn btn-sm btn-icon" data-act="cal-next" aria-label="Next month">${ic('chevron-right')}</button></div>
    <div class="cal-grid" role="grid">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(x => `<div class="cal-dow">${x}</div>`).join('')}${cells}</div></div>
    <aside class="day-panel panel"><div><h3 class="font-display" style="font-weight:700;font-size:17px">${parseD(ui.calSel).toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })}</h3><p class="note">${sel.length ? `${sel.length} item${sel.length > 1 ? 's' : ''}` : 'Nothing scheduled'}</p></div>
      <div class="flex flex-col gap-2">${sel.map(mini).join('')}</div>
      <input class="inp" data-cal-add placeholder="Add a task due this day" maxlength="200" aria-label="Add task due on selected day">
      ${unsched.length ? `<div><div class="sec-h" style="margin-top:6px">No due date · drag onto a day</div><div class="flex flex-col gap-2">${unsched.map(t => mini({ t, k:'due' })).join('')}</div></div>` : ''}
    </aside></div>`;
}

/* ---------- main render ---------- */
function renderContent(){
  const c = $('#content'), v = activeView(), tasks = visible();
  const bs = $('#boardScroll'), sl = bs ? bs.scrollLeft : 0, st = bs ? bs.scrollTop : 0, cs = $$('.col-body').map(el => [el.dataset.key, el.scrollTop]);
  const keep = c.firstElementChild ? c.firstElementChild.scrollTop : 0;
  c.innerHTML = v.type === 'kanban' ? kanbanHTML(tasks, v) : v.type === 'list' ? listHTML(tasks, v) : v.type === 'table' ? tableHTML(tasks) : calHTML(tasks);
  if (v.type === 'kanban'){
    const b = $('#boardScroll'); if (b){ b.scrollLeft = sl; b.scrollTop = st; }
    const bodies = $$('.col-body'); cs.forEach(([k, top]) => { const el = bodies.find(x => x.dataset.key === k); if (el) el.scrollTop = top; });
  } else if (c.firstElementChild) c.firstElementChild.scrollTop = keep;
  icons();
}
function icons(){ try{ if (window.lucide) window.lucide.createIcons(); }catch(e){} }
function render(){
  if (ui.dragging){ ui.pending = true; return; }
  renderSidebar(); renderToolbar(); renderViewbar(); renderNotice(); renderContent(); renderPop();
  document.documentElement.classList.toggle('side-open', ui.sideOpen);
  document.body.classList.toggle('side-open', ui.sideOpen);
  if (ui.quickFocus){ const i = $$('[data-quick]').find(x => x.dataset.quick + '|' + (x.dataset.lane || '') === ui.quickFocus); if (i) i.focus(); ui.quickFocus = null; }
  if (ui.rename){ const i = $(`[data-rename="${ui.rename}"]`); if (i && document.activeElement !== i){ i.focus(); } }
  icons();
}

/* ---------- popovers ---------- */
function openPop(name, el){
  if (ui.pop && ui.pop.name === name){ closePop(); return; }
  const r = el.getBoundingClientRect(); ui.pop = { name, focus: el.dataset.focus || '', rect:{ left:r.left, right:r.right, bottom:r.bottom } }; renderPop();
}
function closePop(){ ui.pop = null; $('#popRoot').innerHTML = ''; }
function chips(items, sel, act, k){ return `<div class="pop-chips">${items.map(([v, l]) => `<button class="chip ${sel.includes(v) ? 'on' : ''}" data-act="${act}" data-k="${k}" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div>`; }
function renderPop(){
  const root = $('#popRoot'); if (!ui.pop){ root.innerHTML = ''; return; }
  const f = S.settings.filters; let html = '';
  if (ui.pop.name === 'filter'){
    const tags = allTags(), sc = scope();
    const dueOpts = [['any', 'Any'], ['overdue', 'Overdue'], ['today', 'Today'], ['week', 'Next 7 days'], ['none', 'No date']];
    html = `<h4>Status</h4>${chips(Tools.unionStages(selBoards()).map(g => [g.key, g.name]), f.status, 'f-toggle', 'status')}
      <h4>Importance</h4>${chips([10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(k => [String(k), String(k)]), f.priority, 'f-toggle', 'priority')}
      <h4>Due</h4><div class="pop-chips">${dueOpts.map(([v, l]) => `<button class="chip ${f.due === v ? 'on' : ''}" data-act="f-due" data-v="${v}">${l}</button>`).join('')}</div>
      ${S.projects.length ? `<h4>Project</h4>${chips(S.projects.map(p => [p.id, p.name]), f.projects, 'f-toggle', 'projects')}` : ''}
      ${tags.length ? `<h4>Tags</h4>${chips(tags.map(x => [x, x]), f.tags, 'f-toggle', 'tags')}` : ''}
      <h4>Other</h4>
      ${[['blocked', 'Only blocked tasks'], ['reminder', 'Has a reminder'], ['email', 'Created from email'], ['hideDone', 'Hide done']].map(([k, l]) => `<button class="tog" data-act="f-flag" data-k="${k}"><span class="chk ${f[k] ? '' : ''}" style="${f[k] ? 'background:var(--accent);border-color:var(--accent);color:var(--accent-ink)' : ''}">${f[k] ? ic('check', 'w-3 h-3') : ''}</span>${l}</button>`).join('')}
      <div class="flex items-center justify-between" style="margin-top:10px"><span class="note">${visible().length} of ${sc.length} tasks match</span><button class="btn btn-sm" data-act="f-clear">Clear filters</button></div>`;
  } else if (ui.pop.name === 'color'){
    const m = S.settings.colorBy;
    const mode = (v, l, d) => `<button class="tog" data-act="color-by" data-v="${v}" style="align-items:flex-start"><span class="chk" style="border-radius:50%;margin-top:2px;${m === v ? 'background:var(--accent);border-color:var(--accent);box-shadow:0 0 0 3px var(--surface) inset' : ''}"></span><span><b style="font-weight:650">${l}</b><br><span class="note">${d}</span></span></button>`;
    const sw = (h, s, l) => `<span class="inline-flex items-center gap-2" style="margin:3px 12px 3px 0"><span class="dot tint" style="--h:${h};--s:${s};background-color:${hsl(h, s, 55)};width:12px;height:12px"></span><span style="font-size:12.5px">${l}</span></span>`;
    html = `<h4>Color whole task by</h4>${mode('status', 'Status', 'Each column has its own color.')}${mode('priority', 'Importance', 'A gradient from green (1) through amber to red (10).')}${mode('flag', 'Flag', 'Your own color flag, otherwise overdue (red), blocked (grey), due soon (yellow).')}
      <h4>Legend</h4><div class="flex flex-wrap">${m === 'status' ? Tools.unionStages(selBoards()).map(c => sw(c.h, Math.max(c.s, 30), c.name)).join('') : m === 'priority' ? [[2, 'Low (1–3)'], [5.5, 'Medium (4–7)'], [9, 'High (8–10)']].map(([n, l]) => { const c = impColor(Math.round(n)); return sw(c.h, c.s, l); }).join('') : Object.keys(FLAGS).map(k => sw(FLAGS[k].h, FLAGS[k].s, FLAGS[k].name)).join('') + sw(220, 10, 'Blocked')}</div>
      <p class="note" style="margin-top:10px">Striped cards are blocked by an unfinished dependency. Red dates are overdue. Set a flag color in the task editor.</p>${S.settings.addons.colors ? `<button class="btn btn-sm" style="margin-top:10px" data-act="board-colors">${ic('palette', 'w-3.5 h-3.5')}Color rules for this board…</button>` : ''}`;
  } else if (ui.pop.name === 'bell'){
    const due = dueReminders(), up = upcomingReminders();
    const row = (x, isDue) => `<div class="dep" style="margin-bottom:6px;flex-wrap:wrap"><button style="flex:1;min-width:140px;text-align:left" data-act="open-task" data-id="${x.t.id}"><span class="truncate" style="display:block;font-weight:620">${esc(x.t.title)}</span><span class="note mono" style="font-size:11.5px">${fmtDT(x.ft)}</span></button>
      ${isDue ? `<button class="btn btn-sm" data-act="rem-snooze" data-id="${x.t.id}" data-m="60">Snooze 1h</button><button class="btn btn-sm" data-act="rem-snooze" data-id="${x.t.id}" data-m="tomorrow">Tomorrow</button><button class="btn btn-sm btn-icon" data-act="rem-dismiss" data-id="${x.t.id}" aria-label="Dismiss">${ic('check')}</button>` : ''}</div>`;
    const canNotify = Host.platform === 'android' || (Host.platform === 'web' && 'Notification' in window && Notification.permission === 'default');
    html = `<h4>Due now</h4>${due.length ? due.map(x => row(x, true)).join('') : '<p class="note">No reminders waiting.</p>'}
      <h4>Coming up · next 14 days</h4>${up.length ? up.slice(0, 8).map(x => row(x, false)).join('') : '<p class="note">Add a reminder from any task.</p>'}
      <p class="note" style="margin-top:10px">${Host.caps.nativeReminders ? (Host.platform === 'desktop' ? 'Reminders are delivered by Windows even when the window is closed to the tray.' : 'Reminders are scheduled with Android, so they arrive even when the app is closed.') : 'Reminders fire while Cursus CoS is open in a browser tab.'}</p>
      ${canNotify ? `<button class="btn btn-sm" style="margin-top:8px" data-act="notif-enable">${ic('bell-ring')}Enable notifications</button>` : ''}`;
  } else if (ui.pop.name === 'view') html = viewPopHTML();
  else if (ui.pop.name === 'addview') html = addViewPopHTML();
  const r = ui.pop.rect, w = Math.min(360, window.innerWidth - 24);
  const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.right - w));
  root.innerHTML = `<div class="pop" role="dialog" style="left:${left}px;top:${Math.round(r.bottom + 8)}px">${html}</div>`;
  icons();
  if (ui.pop.focus){ const f = $(`.pop [data-vs="${ui.pop.focus}"]`); if (f) f.focus(); ui.pop.focus = ''; }
}

/* ---------- task modal ---------- */
function openTask(id, defaults){
  closePop();
  let d, isNew = false;
  if (id){ const t = T(id); if (!t) return; d = clone(t); }
  else { isNew = true; d = newTask(Object.assign(newTaskDefaults(primaryBoard()), defaults || {})); }
  ui.modal = { type:'task', draft:d, isNew, lockTouched:false, depQ:'', blockQ:'', bAdd:[], bRm:[], snap:JSON.stringify(d), tab:'comments' };
  renderModal();
  if (isNew) setTimeout(() => { const i = $('#mTitle'); if (i) i.focus(); }, 30);
}
/* ---------- making an existing task a subtask of another ---------- */
const isUnder = (id, ancestorId) => { const seen = new Set(); let cur = T(id); while (cur && cur.parentId && !seen.has(cur.id)){ seen.add(cur.id); if (cur.parentId === ancestorId) return true; cur = T(cur.parentId); } return false; };
function parentResultsHTML(){
  const m = ui.modal, d = m.draft, q = (m.parentQ || '').trim().toLowerCase();
  let list = S.tasks.filter(t => t.id !== d.id && !t.archived && t.id !== d.parentId && !isUnder(t.id, d.id));   // not itself, not one of its own subtasks (that would loop)
  list = q ? list.filter(t => t.title.toLowerCase().includes(q)) : list.filter(t => t.boardId === d.boardId && !isDone(t));
  const res = list.slice(0, 8);
  if (!res.length) return `<div class="dep-res"><p class="note" style="padding:10px">${q ? 'No matching tasks.' : 'Type to search all your tasks.'}</p></div>`;
  const multi = S.boards.length > 1;
  return `<div class="dep-res">${res.map(t => `<button type="button" data-act="parent-pick" data-id="${t.id}"><span class="dot" style="background:${hsl(stg(t).h, Math.max(stg(t).s, 30), 52)}"></span><span class="truncate" style="flex:1">${esc(t.title)}</span>${multi ? `<span class="note truncate" style="max-width:110px">${esc(boardName(t.boardId))}</span>` : ''}</button>`).join('')}</div>`;
}
function parentBlockHTML(m, d, parent){
  const picker = m.parentOpen ? `<div style="margin-top:8px"><input id="parentQ" class="inp" placeholder="Search for the parent task" value="${esc(m.parentQ || '')}" aria-label="Search for the parent task" autocomplete="off"><div id="parentResults">${parentResultsHTML()}</div></div>` : '';
  if (parent) return `<div class="parent-row" style="margin:2px 0 10px"><div class="flex items-center gap-2" style="flex-wrap:wrap"><span class="note">Subtask of</span><button class="truncate" style="color:var(--accent);font-weight:600;max-width:100%" data-act="open-task" data-id="${parent.id}">${esc(parent.title)}</button><span style="flex:1"></span><button class="btn btn-sm" data-act="${m.parentOpen ? 'parent-close' : 'parent-open'}">${m.parentOpen ? 'Cancel' : 'Change'}</button><button class="btn btn-sm" data-act="parent-rm">Make independent</button></div>${picker}</div>`;
  return `<div class="parent-row" style="margin:2px 0 10px">${m.parentOpen ? `<div class="flex items-center gap-2"><span class="note" style="flex:1">Make this a subtask of…</span><button class="btn btn-ghost btn-sm" data-act="parent-close">Cancel</button></div>` : `<button class="btn btn-sm" data-act="parent-open">${ic('corner-down-right')}Make this a subtask of…</button>`}${picker}</div>`;
}
/* Keeps both sides of the link in step: the child's parentId and the parent's subtask list. */
function syncParentLink(c, oldId, oldSubs){
  const newId = c.parentId || null;
  if (oldId !== newId){
    const op = oldId ? T(oldId) : null;
    if (op){ op.subitems = op.subitems.filter(x => x.taskId !== c.id); op.updated = nowISO(); logTask(op, `"${c.title}" is no longer a subtask of this task`); }
    const np = newId ? T(newId) : null;
    if (np && !np.subitems.some(x => x.taskId === c.id)){
      np.subitems.push({ id:uid(), title:c.title, done:false, taskId:c.id }); np.updated = nowISO();
      logTask(np, `"${c.title}" added as a subtask`); logTask(c, `Made a subtask of "${np.title}"`);
    } else if (!np) c.parentId = null;
    if (oldId && !newId) logTask(c, 'No longer a subtask');
  }
  // a linked subtask taken out of this task's own list is released
  for (const x of oldSubs || []) if (x.taskId && !c.subitems.some(y => y.taskId === x.taskId)){ const k = T(x.taskId); if (k && k.parentId === c.id){ k.parentId = null; k.updated = nowISO(); logTask(k, `No longer a subtask of "${c.title}"`); } }
}
function depResultsHTML(){
  const m = ui.modal, d = m.draft, q = (m.depQ || '').trim().toLowerCase(); if (!q) return '';
  const ov = depOverrides(m, d), res = S.tasks.filter(t => t.id !== d.id && !t.archived && !d.deps.includes(t.id) && t.title.toLowerCase().includes(q) && !wouldCycle(d.id, t.id, ov)).slice(0, 8);
  if (!res.length) return `<div class="dep-res"><p class="note" style="padding:10px">No matching tasks.</p></div>`;
  const multi = S.boards.length > 1;
  return `<div class="dep-res">${res.map(t => `<button type="button" data-act="dep-add" data-id="${t.id}"><span class="dot" style="background:${hsl(stg(t).h, Math.max(stg(t).s, 30), 52)}"></span><span class="truncate" style="flex:1">${esc(t.title)}</span>${multi ? `<span class="note truncate" style="max-width:110px">${esc(boardName(t.boardId))}</span>` : ''}</button>`).join('')}</div>`;
}
function blockResultsHTML(){
  const m = ui.modal, d = m.draft, q = (m.blockQ || '').trim().toLowerCase(); if (!q) return '';
  const have = blockingIds(m, d), ov = depOverrides(m, d);
  const res = S.tasks.filter(t => t.id !== d.id && !t.archived && !have.includes(t.id) && t.title.toLowerCase().includes(q) && !wouldCycle(t.id, d.id, ov)).slice(0, 8);
  if (!res.length) return `<div class="dep-res"><p class="note" style="padding:10px">No matching tasks.</p></div>`;
  const multi = S.boards.length > 1;
  return `<div class="dep-res">${res.map(t => `<button type="button" data-act="block-add" data-id="${t.id}"><span class="dot" style="background:${hsl(stg(t).h, Math.max(stg(t).s, 30), 52)}"></span><span class="truncate" style="flex:1">${esc(t.title)}</span>${multi ? `<span class="note truncate" style="max-width:110px">${esc(boardName(t.boardId))}</span>` : ''}</button>`).join('')}</div>`;
}
function modalHTML(){
  const m = ui.modal, d = m.draft, board = boardOf(d.boardId) || mainBoard(), cfg = board.fields;
  const parent = d.parentId ? T(d.parentId) : null;
  const blocking = blockingIds(m, d).map(T).filter(Boolean);
  const ft = d.reminder ? fireTime(d, S.settings.reminderTime) : null;
  const rem = d.reminder || { type:'none' };
  const sp = d.subitems.length;
  const members = [...new Set([...board.members.map(x => x.name), ...S.tasks.flatMap(t => t.assignees)])];
  const depChip = id => { const t = T(id); if (!t) return ''; return `<div class="dep"><span class="dot" style="background:${hsl(stg(t).h, Math.max(stg(t).s, 30), 52)}"></span><button class="truncate" style="flex:1;text-align:left" data-act="open-task" data-id="${t.id}">${esc(t.title)}</button><span class="note" style="font-size:11.5px">${stg(t).name}</span><button class="btn btn-ghost btn-sm btn-icon" data-act="dep-rm" data-id="${t.id}" aria-label="Remove dependency">${ic('x')}</button></div>`; };
  const F = {
    stage: () => `<div><label class="lbl" for="fStatus">Stage</label><select id="fStatus" class="inp" data-f="status">${stagesOf(d.boardId).map(c => `<option value="${c.id}" ${c.id === d.status ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <label class="lbl" for="fBoard" style="margin-top:10px">Board</label><select id="fBoard" class="inp" data-f="boardId">${S.boards.map(b => `<option value="${b.id}" ${b.id === d.boardId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>`,
    priority: () => `<div><span class="lbl">Importance <b class="mono" style="font-weight:650">${d.importance}</b><span class="note"> of 10 · ${d.priority === 'high' ? 'high' : d.priority === 'medium' ? 'medium' : 'low'}</span></span><div class="imp-seg" role="group" aria-label="Importance from 1 to 10">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(k => { const c = impColor(k); return `<button type="button" data-act="set-imp" data-v="${k}" class="tint-ink" style="--h:${c.h};--s:${c.s}" aria-pressed="${d.importance === k}" aria-label="Importance ${k}"><span>${k}</span></button>`; }).join('')}</div></div>`,
    dates: () => `<div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div><label class="lbl" for="fStart">Scheduled</label><input id="fStart" type="date" class="inp" data-f="start" value="${d.start}"></div><div><label class="lbl" for="fDue">Due</label><input id="fDue" type="date" class="inp" data-f="due" value="${d.due}"></div></div>`,
    estimate: () => `<div><label class="lbl" for="fEst">Workload (time estimate)</label><input id="fEst" class="inp" data-f="estimate" placeholder="e.g. 1h 30m" value="${esc(fmtEst(d.estimate))}"></div>`,
    assignees: () => `<div><label class="lbl" for="asgIn">Assigned to</label>
      <div class="flex flex-wrap gap-1" style="margin-bottom:${d.assignees.length ? 6 : 0}px">${d.assignees.map(n => `<span class="tag chipx">${avatar(n)}${esc(n)}<button type="button" data-act="asg-rm" data-v="${esc(n)}" aria-label="Remove ${esc(n)}">${ic('x', 'w-3 h-3')}</button></span>`).join('')}</div>
      <input id="asgIn" class="inp" list="asgList" placeholder="Add a member, then Enter" maxlength="60" autocomplete="off"><datalist id="asgList">${members.filter(n => !d.assignees.includes(n)).map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      ${members.filter(n => !d.assignees.includes(n)).length ? `<div class="flex flex-wrap gap-1" style="margin-top:6px">${members.filter(n => !d.assignees.includes(n)).slice(0, 6).map(n => `<button type="button" class="chip" data-act="asg-add" data-v="${esc(n)}">${ic('plus', 'w-3 h-3')}${esc(n)}</button>`).join('')}</div>` : ''}</div>`,
    project: () => `<div><label class="lbl" for="fProj">Project</label><select id="fProj" class="inp" data-f="projectId"><option value="">No project</option>${S.projects.map(p => `<option value="${p.id}" ${p.id === d.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>`,
    tags: () => `<div><label class="lbl" for="tagIn">Tags</label>
      <div class="flex flex-wrap gap-1" style="margin-bottom:${d.tags.length ? 6 : 0}px">${d.tags.map(x => `<span class="tag" style="display:inline-flex;align-items:center;gap:4px">${esc(x)}<button type="button" data-act="tag-rm" data-v="${esc(x)}" aria-label="Remove tag ${esc(x)}">${ic('x', 'w-3 h-3')}</button></span>`).join('')}</div>
      <input id="tagIn" class="inp" list="tagList" placeholder="Add tag, then Enter" maxlength="30" autocomplete="off"><datalist id="tagList">${[...new Set(S.tasks.flatMap(t => t.tags))].map(x => `<option value="${esc(x)}">`).join('')}</datalist></div>`,
    reminder: () => `<div><label class="lbl" for="fRem">Reminder</label>
      <select id="fRem" class="inp" data-r="type"><option value="none" ${rem.type === 'none' ? 'selected' : ''}>No reminder</option><option value="at" ${rem.type === 'at' ? 'selected' : ''}>At a specific time</option><option value="before_due" ${rem.type === 'before_due' ? 'selected' : ''}>Relative to due date</option><option value="before_start" ${rem.type === 'before_start' ? 'selected' : ''}>Relative to scheduled date</option></select>
      ${rem.type === 'at' ? `<input type="datetime-local" class="inp" style="margin-top:6px" data-r="at" value="${esc(rem.at || '')}" aria-label="Reminder time">` : ''}
      ${rem.type === 'before_due' || rem.type === 'before_start' ? `<select class="inp" style="margin-top:6px" data-r="days" aria-label="Lead time">${[[0, 'On the day'], [1, '1 day before'], [2, '2 days before'], [3, '3 days before'], [7, '1 week before']].map(([v, l]) => `<option value="${v}" ${(rem.days || 0) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
      ${rem.type !== 'none' ? `<p class="note" style="margin-top:6px">${ft ? `Fires ${fmtDT(ft)}` : `Set a ${rem.type === 'before_start' ? 'scheduled' : rem.type === 'before_due' ? 'due' : ''} date to schedule this.`}</p>` : ''}</div>`,
    repeat: () => { const r = d.repeat, nx = r ? nextDates(d, todayStr()) : null, nUnit = k => k + (r && r.every !== 1 ? 's' : '');
      return `<div><label class="lbl" for="fRep">Repeat</label>
      <select id="fRep" class="inp" data-rp="mode"><option value="" ${r ? '' : 'selected'}>Does not repeat</option><option value="on" ${r ? 'selected' : ''}>Repeats…</option></select>
      ${r ? `<div class="flex gap-2 items-center" style="margin-top:6px"><span class="note">Every</span><input type="number" class="inp num" min="1" max="999" data-rp="every" value="${r.every}" aria-label="Repeat every"><select class="inp" data-rp="unit" aria-label="Repeat unit">${['day', 'weekday', 'week', 'month', 'year'].map(u => `<option value="${u}" ${r.unit === u ? 'selected' : ''}>${nUnit(u)}</option>`).join('')}</select></div>
      <select class="inp" style="margin-top:6px" data-rp="from" aria-label="Count from"><option value="schedule" ${r.from === 'schedule' ? 'selected' : ''}>From the due or start date</option><option value="completion" ${r.from === 'completion' ? 'selected' : ''}>From the day it is finished</option></select>
      <select class="inp" style="margin-top:6px" data-rp="stage" aria-label="Stage for the new copy"><option value="" ${r.stage ? '' : 'selected'}>New copy goes to: automatic</option>${stagesOf(d.boardId).filter(c => !c.done).map(c => `<option value="${c.id}" ${r.stage === c.id ? 'selected' : ''}>New copy goes to: ${esc(c.name)}</option>`).join('')}</select>
      <p class="note" style="margin-top:6px">When this item is completed or deleted, a new copy is made${nx ? ` (if done today: ${nx.start && nx.due ? fmtD(nx.start) + ' to ' + fmtD(nx.due) : fmtD(nx.due || nx.start)})` : ''}. Only this item is affected, and the new copy repeats too.</p>` : ''}</div>`; },
    flag: () => `<div><span class="lbl">Flag color</span><div class="flex-row flag-row" role="group" aria-label="Flag color"><button type="button" class="flag-dot" data-act="set-flag" data-v="" aria-pressed="${!d.flag}" style="background:var(--surface-3);color:var(--muted)" aria-label="No flag">${ic('x', 'w-3 h-3')}</button>${Object.keys(FLAGS).map(k => `<button type="button" class="flag-dot" data-act="set-flag" data-v="${k}" aria-pressed="${d.flag === k}" style="background:${hsl(FLAGS[k].h, FLAGS[k].s, 52)}" aria-label="${FLAGS[k].name}"></button>`).join('')}</div></div>`,
    description: () => `<div><label class="lbl" for="mDesc">Description</label><textarea id="mDesc" class="inp" data-f="description" rows="4" placeholder="Context, links, acceptance criteria">${esc(d.description)}</textarea></div>`,
    subitems: () => `<div>
      <div class="sec-h">${ic('list-checks')}Subtasks${sp ? `<span class="mono" style="font-weight:500">${d.subitems.filter(s => subDone(d, s)).length}/${sp}</span>` : ''}</div>
      ${d.subitems.map((s, i) => { const lt = s.taskId ? T(s.taskId) : null, done = subDone(d, s);
        return `<div class="sub-row ${done ? 'done' : ''}"><button type="button" class="chk-b ${done ? 'on' : ''}" data-act="sub-toggle" data-i="${i}" aria-label="Toggle subitem" aria-pressed="${done}">${done ? ic('check', 'w-3 h-3') : ''}</button>
          <input type="text" id="sub_${i}" data-sub="${i}" value="${esc(s.title)}" aria-label="Subitem ${i + 1}" ${lt ? 'readonly' : ''}>
          ${lt ? `<label class="stick-b" title="Move this task whenever the parent moves between stages or boards"><input type="checkbox" data-sub-stick="${i}" ${s.stick ? 'checked' : ''}><span>Stick with parent</span></label><button class="btn btn-sm" data-act="open-task" data-id="${lt.id}" title="Open linked task">${ic('arrow-up-right', 'w-3 h-3')}${stg(lt).name}</button>` : `<button class="btn btn-sm" data-act="sub-promote" data-i="${i}" title="Create a full task from this subitem">${ic('arrow-up-right', 'w-3 h-3')}Make task</button>`}
          <button class="btn btn-ghost btn-sm btn-icon" data-act="sub-rm" data-i="${i}" aria-label="Remove subitem">${ic('x')}</button></div>`; }).join('')}
      <div class="flex gap-2" style="margin-top:6px"><input id="subNew" class="inp" placeholder="Add a subitem, then Enter" maxlength="200" aria-label="New subitem"><button class="btn" data-act="sub-add">${ic('plus')}Add</button></div></div>`,
    attachments: () => `<div><div class="sec-h">${ic('paperclip')}Attachments${d.attachments.length ? `<span class="mono" style="font-weight:500">${d.attachments.length}</span>` : ''}</div>
      <div class="flex flex-col gap-2">${d.attachments.map(a => `<div class="dep"><span style="color:var(--muted)">${ic('paperclip', 'w-4 h-4')}</span><button class="truncate" style="flex:1;text-align:left" data-act="att-open" data-u="${esc(a.url)}" title="${esc(a.url)}">${esc(a.name)}</button><button class="btn btn-ghost btn-sm btn-icon" data-act="att-copy" data-u="${esc(a.url)}" aria-label="Copy link or path" title="Copy link or path">${ic('copy', 'w-3.5 h-3.5')}</button><button class="btn btn-ghost btn-sm btn-icon" data-act="att-rm" data-id="${a.id}" aria-label="Remove attachment">${ic('x')}</button></div>`).join('')}</div>
      <div class="flex gap-2" style="margin-top:${d.attachments.length ? 8 : 0}px"><input id="attIn" class="inp" placeholder="Paste a link or file path, then Enter" maxlength="500" aria-label="New attachment link or path"><button class="btn" data-act="att-add">${ic('plus')}Add</button></div>
      <p class="note" style="margin-top:6px">Links and file paths only. The files themselves stay where they are.</p></div>`,
    deps: () => `<div>
      <div class="sec-h">${ic('link-2')}Waits on<span class="note" style="font-weight:500"> · must finish before this one</span></div>
      <div class="flex flex-col gap-2">${d.deps.map(depChip).join('')}</div>
      <input id="depQ" class="inp" style="margin-top:${d.deps.length ? 8 : 0}px" placeholder="Search for a task this one waits on" value="${esc(m.depQ || '')}" aria-label="Search tasks to add as dependency" autocomplete="off">
      <div id="depResults">${depResultsHTML()}</div>
      <div class="sec-h" style="margin-top:14px">${ic('git-branch')}Blocking<span class="note" style="font-weight:500"> · waits for this one</span></div>
      <div class="flex flex-col gap-2">${blocking.map(t => `<div class="dep"><span class="dot" style="background:${hsl(stg(t).h, Math.max(stg(t).s, 30), 52)}"></span><button class="truncate" style="flex:1;text-align:left" data-act="open-task" data-id="${t.id}">${esc(t.title)}</button><span class="note" style="font-size:11.5px">${stg(t).name}</span><button class="btn btn-ghost btn-sm btn-icon" data-act="block-rm" data-id="${t.id}" aria-label="Stop blocking this task">${ic('x')}</button></div>`).join('')}</div>
      <input id="blockQ" class="inp" style="margin-top:${blocking.length ? 8 : 0}px" placeholder="Search for a task that waits on this one" value="${esc(m.blockQ || '')}" aria-label="Search tasks to block" autocomplete="off">
      <div id="blockResults">${blockResultsHTML()}</div></div>`
  };
  const cf = f => {
    const v = d.custom[f.id], id = 'cf_' + f.id, lbl = `<label class="lbl" for="${id}">${esc(f.name)}</label>`;
    if (f.type === 'check') return `<div><span class="lbl">${esc(f.name)}</span><button type="button" class="tog" data-act="cf-check" data-id="${f.id}" role="checkbox" aria-checked="${!!v}"><span class="chk" style="${v ? 'background:var(--accent);border-color:var(--accent);color:var(--accent-ink)' : ''}">${v ? ic('check', 'w-3 h-3') : ''}</span><span>${v ? 'Yes' : 'No'}</span></button></div>`;
    if (f.type === 'label') return `<div>${lbl}<select id="${id}" class="inp" data-cf="${f.id}" data-t="label"><option value="">None</option>${f.options.map(o => `<option value="${o.id}" ${v === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></div>`;
    return `<div>${lbl}<input id="${id}" class="inp" data-cf="${f.id}" data-t="${f.type}" type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}" value="${esc(v == null ? '' : v)}" ${f.desc ? `placeholder="${esc(f.desc)}"` : ''}></div>`;
  };
  const visible = cfg.order.filter(id => !cfg.hidden.includes(id) || id === 'stage');
  const zone = id => id.startsWith('cf:') ? 'side' : (BUILTIN_FIELDS.find(x => x.id === id) || {}).zone;
  const block = id => id.startsWith('cf:') ? (cfg.custom.find(f => 'cf:' + f.id === id) ? cf(cfg.custom.find(f => 'cf:' + f.id === id)) : '') : (F[id] ? F[id]() : '');
  const main = visible.filter(id => zone(id) === 'main').map(block).join(''), side = visible.filter(id => zone(id) === 'side').map(block).join('');
  const tab = m.tab || 'comments', me = S.settings.me || 'You';
  const comments = `<div><div class="seg" role="tablist" style="margin-bottom:10px"><button data-act="mtab" data-v="comments" aria-pressed="${tab === 'comments'}">${ic('message-square', 'w-4 h-4')}Comments${d.comments.length ? ` (${d.comments.length})` : ''}</button><button data-act="mtab" data-v="activity" aria-pressed="${tab === 'activity'}">${ic('clock', 'w-4 h-4')}Activities</button></div>
    ${tab === 'comments' ? `${d.comments.map(c => `<div class="cmt">${avatar(c.by || 'You')}<div style="flex:1;min-width:0"><div class="cmt-h"><b>${esc(c.by || 'You')}</b><span class="note">${esc(fmtDT(new Date(c.at)))}</span><button class="btn btn-ghost btn-sm btn-icon" style="margin-left:auto" data-act="cmt-rm" data-id="${c.id}" aria-label="Delete comment">${ic('x', 'w-3.5 h-3.5')}</button></div><p class="cmt-t">${esc(c.text)}</p></div></div>`).join('')}
      <div class="flex gap-2 items-end" style="margin-top:8px"><textarea id="cmtIn" class="inp" rows="2" placeholder="Add comment as ${esc(me)} (Ctrl/⌘ + Enter to post)" aria-label="New comment"></textarea><button class="btn btn-primary" data-act="cmt-add">${ic('send', 'w-4 h-4')}Post</button></div>`
      : `${(d.log || []).length ? `<div class="flex flex-col gap-2">${d.log.slice().reverse().map(l => `<div class="note" style="display:flex;gap:8px"><span class="mono" style="flex:none;width:62px;font-size:11.5px">${timeAgo(l.at)}</span><span>${esc(l.text)}</span></div>`).join('')}</div>` : '<p class="note">Nothing yet.</p>'}`}</div>`;
  return `<div class="m-back" data-backdrop><div class="m-panel" role="dialog" aria-modal="true" aria-label="Task editor">
    <div class="m-head">
      <div class="flex items-center gap-2 truncate" style="flex:1;min-width:0;color:var(--muted);font-size:12.5px">
        <span class="dot" style="background:${hsl((boardOf(d.boardId) || { h:210 }).h, 65, 52)}"></span><span class="truncate">${esc(boardName(d.boardId))}</span>
        ${parent ? `<span>›</span><button class="truncate" style="color:var(--accent);font-weight:600" data-act="open-task" data-id="${parent.id}">Subitem of ${esc(parent.title)}</button>${isStuckChild(d, S.tasks) ? `<span class="pill" style="display:inline-flex;align-items:center;gap:4px">${ic('link-2', 'w-3 h-3')}Sticks with parent</span>` : ''}` : ''}
        ${isEmail(d) ? `<span class="pill" style="margin-left:6px;display:inline-flex;align-items:center;gap:4px">${ic('mail', 'w-3 h-3')}From email</span>` : ''}${d.source === 'zenkit' ? `<span class="pill" style="margin-left:6px">From Zenkit</span>` : ''}${d.archived ? `<span class="pill" style="margin-left:6px;display:inline-flex;align-items:center;gap:4px">${ic('archive', 'w-3 h-3')}Archived</span>` : ''}
      </div>
      <button class="btn btn-ghost btn-icon" data-act="close-modal" aria-label="Save and close" title="Save and close">${ic('x')}</button>
    </div>
    <div class="m-body">
      <div class="m-main">
        <input id="mTitle" class="m-title" data-f="title" placeholder="Task title" value="${esc(d.title)}" maxlength="200" aria-label="Task title">
        ${parentBlockHTML(m, d, parent)}
        ${main}${comments}
      </div>
      <div class="m-side">
        ${side}
        <button type="button" class="tog" data-act="toggle-lock"><span class="switch" role="switch" aria-checked="${!d.locked}"></span><span>Let automation move this task${d.locked ? '<br><span class="note">Paused because it was placed by hand.</span>' : ''}</span></button>
      </div>
    </div>
    <div class="m-foot">
      ${m.isNew ? '' : `<button class="btn btn-danger" data-act="del-task">${ic('trash-2')}Delete</button><button class="btn" data-act="dup-task">${ic('copy')}Duplicate</button><button class="btn" data-act="archive-task">${ic('archive')}${d.archived ? 'Restore' : 'Archive'}</button>`}
      <span style="flex:1"></span>
      <span class="note hide-sm">Saves when you close it</span>
      <button class="btn" data-act="cancel-task" title="Close and throw away the changes made in this window">Cancel</button>
      <button class="btn btn-primary" data-act="save-task">${m.isNew ? 'Create task' : 'Save and close'}</button>
    </div></div></div>`;
}

function renderModal(){
  const root = $('#modalRoot'); if (!ui.modal){ root.innerHTML = ''; return; }
  const act = document.activeElement, id = act && act.id, pos = act && act.selectionStart;
  const body = $('.m-body', root) || $('.bs-body', root), top = body ? body.scrollTop : 0;
  if (ui.modal.type === 'task') root.innerHTML = modalHTML();
  else if (ui.modal.type === 'settings') root.innerHTML = settingsHTML();
  else if (ui.modal.type === 'entity') root.innerHTML = entityHTML();
  else if (ui.modal.type === 'sview') root.innerHTML = savedViewHTML();
  else if (ui.modal.type === 'import') root.innerHTML = importHTML();
  else if (ui.modal.type === 'bset') root.innerHTML = bsetHTML();
  else if (ui.modal.type === 'ptags') root.innerHTML = ptagsHTML();
  else if (ui.modal.type === 'paste') root.innerHTML = pasteHTML();
  else if (ui.modal.type === 'followup') root.innerHTML = followUpHTML();
  else if (ui.modal.type === 'review') root.innerHTML = reviewHTML();
  const nb = $('.m-body', root) || $('.bs-body', root); if (nb) nb.scrollTop = top;
  if (id){ const el = document.getElementById(id); if (el){ el.focus(); try{ if (pos != null) el.setSelectionRange(pos, pos); }catch(e){} } }
  icons();
}
function closeModal(){ ui.modal = null; $('#modalRoot').innerHTML = ''; setTimeout(flushFollowUps, 0); setTimeout(flushReviews, 50); }
/* The task editor saves when it closes (X, Esc, clicking outside); only Cancel throws the changes away. */
function taskDirty(){
  const m = ui.modal; if (!m || m.type !== 'task' || !m.draft) return false;
  const est = $('#fEst'); if (est) m.draft.estimate = parseEst(est.value);
  return JSON.stringify(m.draft) !== m.snap || !!((m.bAdd || []).length || (m.bRm || []).length);
}
const taskSaveable = () => { const m = ui.modal; return !!m && m.type === 'task' && taskDirty() && !(m.isNew && !(m.draft.title || '').trim()); };
function closeTask(save, force){
  const m = ui.modal; if (!m || m.type !== 'task'){ closeModal(); return; }
  if (save && (force ? (m.isNew || taskDirty()) : taskSaveable())){ const wasNew = m.isNew, d = commitDraft(); closeModal(); render(); if (d) toast(wasNew ? 'Task created.' : 'Changes saved.', null, 1600); }
  else closeModal();
}
const closeTopModal = () => { if (ui.modal && ui.modal.type === 'task') closeTask(true); else closeModal(); };
/* Blocking is edited from this task's side, but the dependency lives on the other task, so it is applied when this one is saved. */
const blockingIds = (m, d) => { const base = S.tasks.filter(t => t.id !== d.id && t.deps.includes(d.id) && !m.bRm.includes(t.id)).map(t => t.id); return [...base, ...m.bAdd.filter(id => !base.includes(id))]; };
function depOverrides(m, d){
  const ov = new Map(); ov.set(d.id, d.deps);
  for (const id of m.bAdd){ const o = T(id); if (o) ov.set(id, [...new Set([...o.deps, d.id])]); }
  for (const id of m.bRm){ const o = T(id); if (o) ov.set(id, o.deps.filter(x => x !== d.id)); }
  return ov;
}
function applyBlocking(d, m){
  for (const id of m.bAdd || []){ const o = T(id); if (o && !o.deps.includes(d.id)){ o.deps.push(d.id); o.updated = nowISO(); logTask(o, `Now waits on "${d.title}"`); } }
  for (const id of m.bRm || []){ const o = T(id); if (o && o.deps.includes(d.id)){ o.deps = o.deps.filter(x => x !== d.id); o.updated = nowISO(); logTask(o, `No longer waits on "${d.title}"`); } }
  m.bAdd = []; m.bRm = [];
}
function commitDraft(){
  const m = ui.modal, d = m.draft; if (!d) return null;
  const est = $('#fEst'); if (est) d.estimate = parseEst(est.value);
  d.title = (d.title || '').trim() || 'Untitled task';
  const orig = T(d.id), oldParent = orig ? orig.parentId || null : null, oldSubs = orig ? clone(orig.subitems || []) : [];
  if (!orig){
    d.order = nextOrder(d.status); if (d.status === 'scheduled') d.scheduledFlow = true;
    logTask(d, 'Created'); S.tasks.push(d); m.isNew = false; fireRules(d, { type:'created' });
  } else {
    const userLock = d.locked, statusChanged = orig.status !== d.status;
    if (statusChanged || orig.boardId !== d.boardId) unstickChild(d);
    const inputsChanged = orig.importance !== d.importance || orig.start !== d.start || orig.due !== d.due;
    if (statusChanged){
      applyManualStatus(d, d.status); d.order = isDone(d) ? topOrder(d.status) : nextOrder(d.status);
      logTask(d, `Moved ${stageNameOf(orig, orig.status)} to ${stageNameOf(d, d.status)}`);
    } else if (inputsChanged){ d.locked = false; logTask(d, 'Updated'); }
    if (m.lockTouched) d.locked = userLock;
    d.updated = nowISO();
    const idx = S.tasks.findIndex(t => t.id === d.id); S.tasks[idx] = d;
    if (statusChanged){ afterStatus(d, orig.status); fireRules(d, { type:'moved', value:d.status }); queueFollowUp(d); }
    if (orig.importance !== d.importance) fireRules(d, { type:'priority', value:d.importance });
  }
  syncParentLink(d, oldParent, oldSubs);
  applyBlocking(d, m); followParent(d);
  if (d.reminder){ const k = fireTime(d, S.settings.reminderTime); if (k && d.reminder.ack && d.reminder.ack !== k.toISOString()){ d.reminder.ack = null; d.reminder.notified = null; } }
  runAutomation(); save(); return d;
}

/* ---------- paste lines as tasks ---------- */
function openPaste(text){
  const bid = primaryBoard(), tpl = (boardOf(bid) || {}).template || {};
  ui.modal = { type:'paste', text: text || '', boardId: bid, status: tpl.status || firstOpenStage(bid), projectId:'', subs:true };
  renderModal(); setTimeout(() => { const i = $('#pasteIn'); if (i) i.focus(); }, 30);
}
function pasteSummaryHTML(){
  const m = ui.modal, r = Tools.parseTaskLines(m.text, { subs: m.subs });
  if (!r.tasks.length) return '<p class="note">Nothing to add yet. Each line becomes a task.</p>';
  const rows = r.tasks.slice(0, 8).map(t => `<div class="paste-row"><span class="paste-box ${t.done ? 'on' : ''}">${t.done ? ic('check', 'w-3 h-3') : ''}</span><span class="truncate" style="flex:1">${esc(t.title)}</span>${t.tags.map(x => `<span class="tag">${esc(x)}</span>`).join('')}${t.subs.length ? `<span class="note">${t.subs.length} subtask${t.subs.length > 1 ? 's' : ''}</span>` : ''}</div>`).join('');
  return `<div class="paste-list">${rows}${r.tasks.length > 8 ? `<p class="note" style="padding:6px 8px">…and ${r.tasks.length - 8} more</p>` : ''}</div>${r.truncated ? '<p class="note" style="margin-top:6px">Only the first 500 lines are used.</p>' : ''}`;
}
function pasteHTML(){
  const m = ui.modal, r = Tools.parseTaskLines(m.text, { subs: m.subs }), n = r.tasks.length, stages = stagesOf(m.boardId);
  return `<div class="m-back"><div class="m-panel narrow" role="dialog" aria-modal="true" aria-label="Paste tasks"><div class="m-head"><h2 class="font-display" style="font-weight:700;font-size:18px;flex:1">Paste lines as tasks</h2><button class="btn btn-ghost btn-icon" data-act="close-modal" aria-label="Close">${ic('x')}</button></div>
    <div class="m-body single">
      <textarea id="pasteIn" class="inp" rows="8" placeholder="Paste lines here from OneNote, an email or a list. One task per line.&#10;Indented lines become subtasks. Bullets and check boxes are dropped, #words become tags." aria-label="Lines to turn into tasks">${esc(m.text)}</textarea>
      <div class="flex gap-2 flex-wrap" style="margin:8px 0 14px"><button class="btn btn-sm" data-act="paste-clip">${ic('clipboard-paste', 'w-3.5 h-3.5')}Paste from clipboard</button><button type="button" class="tog" data-act="paste-subs" role="checkbox" aria-checked="${m.subs}"><span class="chk" style="${m.subs ? 'background:var(--accent);border-color:var(--accent);color:var(--accent-ink)' : ''}">${m.subs ? ic('check', 'w-3 h-3') : ''}</span><span>Indented lines become subtasks</span></button></div>
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
        <div><label class="lbl" for="pasteBoard">Board</label><select id="pasteBoard" class="inp" data-paste="boardId">${S.boards.map(b => `<option value="${b.id}" ${b.id === m.boardId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
        <div><label class="lbl" for="pasteStage">Stage</label><select id="pasteStage" class="inp" data-paste="status">${stages.map(c => `<option value="${c.id}" ${c.id === m.status ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      </div>
      ${S.projects.length ? `<label class="lbl" for="pasteProj" style="margin-top:10px">Project</label><select id="pasteProj" class="inp" data-paste="projectId"><option value="">No project</option>${S.projects.map(p => `<option value="${p.id}" ${p.id === m.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
      <div class="sec-h" style="margin-top:16px">Preview</div><div id="pastePreview">${pasteSummaryHTML()}</div>
    </div>
    <div class="m-foot"><span style="flex:1"></span><button class="btn" data-act="close-modal">Cancel</button><button id="pasteAdd" class="btn btn-primary" data-act="paste-add" ${n ? '' : 'disabled'}>${n ? `Add ${n} task${n > 1 ? 's' : ''}` : 'Add tasks'}</button></div></div></div>`;
}
function addPastedTasks(){
  const m = ui.modal, r = Tools.parseTaskLines(m.text, { subs: m.subs }); if (!r.tasks.length) return;
  const ids = [];
  for (const p of r.tasks){
    const t = newTask(Object.assign(newTaskDefaults(m.boardId), { title:p.title, status: p.done ? doneIdFor(m.boardId) : m.status, projectId: m.projectId || null }));
    t.tags = [...new Set([...(t.tags || []), ...p.tags])];
    t.subitems = p.subs.map(x => ({ id:uid(), title:x.title, done:x.done, taskId:null }));
    if (t.status === 'scheduled') t.scheduledFlow = true;
    t.order = isDone(t) ? topOrder(t.status) : nextOrder(t.status);
    logTask(t, 'Created from pasted lines'); S.tasks.push(t); fireRules(t, { type:'created' }); ids.push(t.id);
  }
  closeModal(); save(); render();
  toast(`Added ${ids.length} task${ids.length > 1 ? 's' : ''}.`, { label:'Undo', fn:() => { const set = new Set(ids); S.tasks = S.tasks.filter(x => !set.has(x.id)); ids.forEach(i => tombstone('task', i)); save(); render(); } }, 8000);
}

/* ---------- follow-up prompt: when a task is moved to In Progress, ask when to follow up ---------- */
const fmtTime = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return new Date(2000, 0, 1, h || 0, m || 0).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' }); };
const isInProgress = t => { const st = stagesOf(t.boardId).find(x => x.id === t.status); return !!st && !st.done && (st.id === 'in-progress' || stageKey(st.name) === 'in-progress'); };
function queueFollowUp(t){
  const f = S.settings.followUp; if (!f || !f.ask || !isInProgress(t)) return;
  ui.fuQueue = ui.fuQueue || []; if (!ui.fuQueue.includes(t.id)) ui.fuQueue.push(t.id);
  setTimeout(flushFollowUps, 0);
}
function flushFollowUps(){
  if (ui.modal || ui.dragging || !ui.fuQueue || !ui.fuQueue.length) return;
  const t = T(ui.fuQueue.shift()); if (!t){ flushFollowUps(); return; }
  ui.modal = { type:'followup', id:t.id, name:`Follow up: ${t.title}`.slice(0, 200), date: addDays(todayStr(), 3), time:'' };
  renderModal(); setTimeout(() => { const i = $('#fuName'); if (i){ i.focus(); i.select(); } }, 30);
}
function followUpHTML(){
  const m = ui.modal, t = T(m.id), today = todayStr();
  const chips = [[1, 'Tomorrow'], [3, 'In 3 days'], [7, 'Next week'], [14, 'In 2 weeks'], [30, 'In a month']];
  return `<div class="m-back"><div class="m-panel narrow" role="dialog" aria-modal="true" aria-label="Follow up"><div class="m-head"><h2 class="font-display" style="font-weight:700;font-size:18px;flex:1">When do you want to follow up?</h2><button class="btn btn-ghost btn-icon" data-act="fu-skip" aria-label="Skip">${ic('x')}</button></div>
    <div class="m-body single">
      <p class="note" style="margin-bottom:12px">${t ? `“${esc(t.title)}” is now In Progress. ` : ''}A new task is created for the follow-up.</p>
      <label class="lbl" for="fuName">Name</label><input id="fuName" class="inp" value="${esc(m.name)}" maxlength="200">
      <span class="lbl" style="margin-top:14px">When</span>
      <div class="pop-chips">${chips.map(([n, l]) => `<button type="button" class="chip ${m.date === addDays(today, n) ? 'on' : ''}" data-act="fu-chip" data-days="${n}">${l}</button>`).join('')}</div>
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px;margin-top:10px"><div><label class="lbl" for="fuDate">Date</label><input id="fuDate" type="date" class="inp" value="${esc(m.date)}" min="${today}"></div><div><label class="lbl" for="fuTime">Time (optional)</label><input id="fuTime" type="time" class="inp" value="${esc(m.time)}"></div></div>
      <p class="note" style="margin-top:8px">${m.time ? 'You get a reminder at that time.' : `With no time, the reminder comes that morning at ${esc(fmtTime(S.settings.reminderTime))}.`}</p>
    </div>
    <div class="m-foot"><span style="flex:1"></span><button class="btn" data-act="fu-skip">Skip</button><button class="btn btn-primary" data-act="fu-save">${ic('calendar-clock')}Create follow-up</button></div></div></div>`;
}
function createFollowUp(srcId, name, date, time){
  const src = T(srcId); if (!src || !date) return null;
  const bid = src.boardId, status = stagesOf(bid).some(x => x.id === 'scheduled') ? 'scheduled' : firstOpenStage(bid);
  const when = time ? `${fmtD(date)} at ${fmtTime(time)}` : fmtD(date);
  const nt = newTask({ boardId:bid, projectId:src.projectId, title:(name || '').trim().slice(0, 200) || `Follow up: ${src.title}`.slice(0, 200), description:`Follow-up on "${src.title}" (${when}).`,
    status, importance:src.importance, start:date, due:date, tags:src.tags.slice(), assignees:(src.assignees || []).slice(), scheduledFlow: status === 'scheduled',
    reminder: time ? { type:'at', at:`${date}T${time}` } : { type:'before_start', days:0 }, attachments:[{ id:uid(), name:`Original: ${src.title}`.slice(0, 60), url:taskLink(src.id), added:nowISO() }] });
  nt.order = nextOrder(status); logTask(nt, `Follow-up on "${src.title}"`); S.tasks.push(nt);
  logTask(src, `Follow-up created for ${when}`); src.updated = nowISO();
  fireRules(nt, { type:'created' }); if (time) Host.ensureNotifyPermission();
  save(); render();
  toast(`Follow-up set for ${when}.`, { label:'Undo', fn:() => { S.tasks = S.tasks.filter(x => x.id !== nt.id); tombstone('task', nt.id); save(); render(); } }, 7000);
  return nt;
}

/* ---------- entity (board / project) modal ---------- */
const HUES = [205, 230, 262, 300, 330, 4, 28, 48, 100, 150, 175];
/* ---------- saved Views: a layout plus the boards and projects it shows ---------- */
const SV_ICON = { kanban:'layout-dashboard', list:'list', table:'table', calendar:'calendar' };
const svBoards = v => { const have = new Set(S.boards.map(b => b.id)), b = v.boards.filter(i => have.has(i)); return b.length ? b : S.boards.map(x => x.id); };
const svProjects = v => v.projects.filter(i => S.projects.some(p => p.id === i));
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
function svActive(v){
  return !S.settings.filters.archived && activeView().type === v.type && sameSet([...selIds()], svBoards(v)) && sameSet(S.settings.filters.projects, svProjects(v));
}
function svCount(v){
  const bs = new Set(svBoards(v)), ps = svProjects(v);
  return S.tasks.filter(t => bs.has(t.boardId) && !isDone(t) && !t.archived && (!ps.length || ps.includes(t.projectId))).length;
}
function viewsSideHTML(){
  const list = S.savedViews || [];
  if (!list.length) return `<p class="note" style="padding:4px 8px">A view remembers a layout and which boards and projects to show. Press + to save one.</p>`;
  return list.map(v => `<div class="side-row side-view ${svActive(v) ? 'on' : ''}">
          <button class="side-name" data-act="sv-apply" data-id="${v.id}" aria-pressed="${svActive(v)}" title="${esc(VLABEL[v.type])} view"><span style="color:${hsl(v.h, 60, 45)};display:inline-flex">${ic(SV_ICON[v.type] || 'layout-dashboard', 'w-4 h-4')}</span><span class="truncate">${esc(v.name)}</span></button>
          <span class="count">${svCount(v)}</span>
          <button class="side-edit" data-act="sv-edit" data-id="${v.id}" aria-label="Edit ${esc(v.name)}">${ic('more-horizontal')}</button>
        </div>`).join('');
}
function applySavedView(id){
  const v = (S.savedViews || []).find(x => x.id === id); if (!v) return;
  S.settings.boardsSel = svBoards(v);
  S.settings.filters.projects = svProjects(v);
  S.settings.filters.archived = false;
  const b = mainBoard();
  let lv = b.views.find(x => x.id === S.settings.viewSel[b.id] && x.type === v.type) || b.views.find(x => x.id === b.defaultView && x.type === v.type) || b.views.find(x => x.type === v.type);
  if (!lv){ lv = newView(v.type, null); b.views.push(lv); }
  S.settings.viewSel[b.id] = lv.id; S.settings.view = v.type === 'kanban' || v.type === 'list' ? 'board' : v.type;
  ui.sideOpen = false; ui.pop = null; save(); render();
}
function openSavedView(id){
  const ex = id ? (S.savedViews || []).find(x => x.id === id) : null;
  const allB = S.boards.length === selIds().size;
  ui.modal = { type:'sview', id: id || '', name: ex ? ex.name : '', vtype: ex ? ex.type : activeView().type,
    boards: ex ? ex.boards.slice() : (allB ? [] : [...selIds()]), projects: ex ? ex.projects.slice() : S.settings.filters.projects.slice(), h: ex ? ex.h : HUES[(S.savedViews || []).length % HUES.length] };
  renderModal(); setTimeout(() => { const i = $('#svName'); if (i) i.focus(); }, 30);
}
function savedViewHTML(){
  const m = ui.modal;
  const tog = (act, id, label, on, dot) => `<button type="button" class="tog" data-act="${act}" data-id="${esc(id)}" aria-pressed="${on}"><span class="chk" style="${on ? 'background:var(--accent);border-color:var(--accent);color:var(--accent-ink)' : ''}">${on ? ic('check', 'w-3 h-3') : ''}</span>${dot ? `<span class="dot" style="background:${dot}"></span>` : ''}<span class="truncate">${esc(label)}</span></button>`;
  return `<div class="m-back"><div class="m-panel narrow" role="dialog" aria-modal="true" aria-label="${m.id ? 'Edit view' : 'New view'}"><div class="m-head"><h2 class="font-display" style="font-weight:700;font-size:18px;flex:1">${m.id ? 'Edit view' : 'Save a view'}</h2><button class="btn btn-ghost btn-icon" data-act="close-modal" aria-label="Close">${ic('x')}</button></div>
    <div class="m-body single"><label class="lbl" for="svName">Name</label><input id="svName" class="inp" value="${esc(m.name)}" maxlength="40" placeholder="e.g. Launch board, This week">
      <span class="lbl" style="margin-top:14px">Layout</span>
      <div class="flex flex-wrap gap-2" role="group" aria-label="Layout">${['kanban', 'list', 'table', 'calendar'].map(t => `<button type="button" class="btn btn-sm ${m.vtype === t ? 'btn-primary' : ''}" data-act="sv-type" data-v="${t}" aria-pressed="${m.vtype === t}">${ic(SV_ICON[t], 'w-3.5 h-3.5')}${VLABEL[t]}</button>`).join('')}</div>
      <span class="lbl" style="margin-top:14px">Boards</span>
      <div class="flex flex-col" style="gap:2px">${S.boards.map(b => tog('sv-b', b.id, b.name, m.boards.includes(b.id), hsl(b.h, 65, 52))).join('')}</div>
      <p class="note" style="margin-top:4px">Tick none to show every board.</p>
      ${S.projects.length ? `<span class="lbl" style="margin-top:14px">Projects</span><div class="flex flex-col" style="gap:2px">${S.projects.map(p => tog('sv-p', p.id, p.name, m.projects.includes(p.id), hsl(p.h, 60, 52))).join('')}</div><p class="note" style="margin-top:4px">Tick none to show tasks from every project.</p>` : ''}
      <span class="lbl" style="margin-top:14px">Color</span><div class="flex flex-wrap gap-2">${HUES.map(h => `<button type="button" class="swatch" data-act="sv-hue" data-h="${h}" aria-pressed="${m.h === h}" aria-label="Hue ${h}" style="background:${hsl(h, 65, 52)}"></button>`).join('')}</div>
      ${m.id ? `<button type="button" class="btn btn-sm" style="margin-top:14px" data-act="sv-current">${ic('crosshair', 'w-3.5 h-3.5')}Use what I'm looking at now</button>` : ''}</div>
    <div class="m-foot">${m.id ? `<button class="btn btn-danger" data-act="sv-del">${ic('trash-2')}Delete</button>` : ''}<span style="flex:1"></span><button class="btn" data-act="close-modal">Cancel</button><button class="btn btn-primary" data-act="sv-save">${m.id ? 'Save' : 'Save view'}</button></div></div></div>`;
}

function openEntity(kind, id){
  const ex = id ? (kind === 'board' ? boardOf(id) : projOf(id)) : null;
  ui.modal = { type:'entity', kind, id, name: ex ? ex.name : '', h: ex ? ex.h : HUES[(kind === 'board' ? S.boards.length : S.projects.length) % HUES.length] };
  renderModal(); setTimeout(() => { const i = $('#entName'); if (i) i.select(); }, 30);
}
function entityHTML(){
  const m = ui.modal, nm = m.kind === 'board' ? 'board' : 'project';
  const count = m.id ? S.tasks.filter(t => (m.kind === 'board' ? t.boardId : t.projectId) === m.id).length : 0;
  return `<div class="m-back"><div class="m-panel narrow" role="dialog" aria-modal="true"><div class="m-head"><h2 class="font-display" style="font-weight:700;font-size:18px;flex:1">${m.id ? 'Edit' : 'New'} ${nm}</h2><button class="btn btn-ghost btn-icon" data-act="close-modal" aria-label="Close">${ic('x')}</button></div>
    <div class="m-body single"><label class="lbl" for="entName">Name</label><input id="entName" class="inp" value="${esc(m.name)}" maxlength="60" placeholder="${m.kind === 'board' ? 'e.g. Marketing' : 'e.g. Spring campaign'}">
      <span class="lbl" style="margin-top:16px">Color</span><div class="flex flex-wrap gap-2">${HUES.map(h => `<button type="button" class="swatch" data-act="ent-hue" data-h="${h}" aria-pressed="${m.h === h}" aria-label="Hue ${h}" style="background:${hsl(h, 65, 52)}"></button>`).join('')}</div>
      ${m.kind === 'project' ? `<p class="note" style="margin-top:14px">A project groups tasks from any board. Assign tasks to it in the task editor, then click it in the sidebar to focus.</p>` : ''}</div>
    <div class="m-foot">${m.id ? `<button class="btn btn-danger" data-act="ent-del">${ic('trash-2')}Delete${count ? ` (${count} task${count > 1 ? 's' : ''}${m.kind === 'project' ? ' kept' : ''})` : ''}</button>` : ''}<span style="flex:1"></span><button class="btn" data-act="close-modal">Cancel</button><button class="btn btn-primary" data-act="ent-save">${m.id ? 'Save' : 'Create'}</button></div></div></div>`;
}

/* ---------- archive ---------- */
function archiveTasks(ids, flag, why){
  const set = new Set(ids), now = nowISO();
  for (const t of S.tasks){
    if (!set.has(t.id) || !!t.archived === flag) continue;
    t.archived = flag; t.archivedAt = flag ? now : ''; t.updated = now;
    logTask(t, flag ? (why || 'Archived') : 'Restored from the archive');
  }
  save();
}

/* ---------- import from Zenkit (parsing and mapping live in js/zenkit.js) ---------- */
function loadZenkitFile(file){
  const rd = new FileReader();
  rd.onerror = () => toast('That file could not be read.');
  rd.onload = () => {
    let parsed;
    try{ parsed = CoS.zenkit.parse(JSON.parse(rd.result)); }
    catch(e){ toast(e instanceof SyntaxError ? 'That file is not valid JSON. In Zenkit, choose Export as JSON.' : e.message, null, 7000); return; }
    openImport(parsed, file.name);
  };
  rd.readAsText(file);
}
function openImport(parsed, fileName){
  const maps = S.settings.importMaps.zenkit, prefs = S.settings.importPrefs.zenkit;
  ui.modal = { type:'import', parsed, fileName, boardTarget:'new', newName: parsed.listName, removeSample: !!S.sample, includeArchived:false,
    archiveDays: prefs.archiveDays, keepStageTag: prefs.keepStageTag !== false, workloadUnit: prefs.workloadUnit || 'hours',
    stageMap: Object.assign({}, maps.stages), priMap: Object.assign({}, maps.priorities) };
  renderModal();
}
function importOpts(m){
  const existing = new Map(S.tasks.filter(t => t.external && t.external.source === 'zenkit' && t.external.id).map(t => [t.external.id, t.id]));
  const newBoard = m.boardTarget === 'new' || m.removeSample;
  return { boardId: newBoard ? '__new__' : m.boardTarget, stageMap: m.stageMap, priorityMap: m.priMap, includeArchived: m.includeArchived,
    archiveDoneDays: m.archiveDays, keepStageTag: m.keepStageTag, workloadUnit: m.workloadUnit, existing };
}
function importChange(el){
  const m = ui.modal, k = el.dataset.imp;
  if (k === 'stage') m.stageMap[el.dataset.key] = el.value;
  else if (k === 'pri') m.priMap[el.dataset.key] = el.value;
  else if (k === 'board') m.boardTarget = el.value;
  else if (k === 'days') m.archiveDays = Math.max(0, Math.min(3650, parseInt(el.value, 10) || 0));
  else if (k === 'unit') m.workloadUnit = el.value;
  renderModal();
}
function importHTML(){
  const m = ui.modal, p = m.parsed, Z = CoS.zenkit;
  const res = Z.build(p, importOpts(m)), s = res.stats;
  const sRows = Z.stageRows(p, m.includeArchived), pRows = Z.priorityRows(p, m.includeArchived);
  const check = on => `<span class="chk" style="${on ? 'background:var(--accent);border-color:var(--accent);color:var(--accent-ink)' : ''}">${on ? ic('check', 'w-3 h-3') : ''}</span>`;
  const tog = (k, label) => `<button type="button" class="tog" data-act="imp-toggle" data-k="${k}" role="checkbox" aria-checked="${!!m[k]}">${check(!!m[k])}<span>${label}</span></button>`;
  const colSelect = (id, val, key, label) => `<select id="${id}" class="inp" style="width:170px;flex:none" data-imp="stage" data-key="${esc(key)}" aria-label="${esc(label)}">${COLS.map(c => `<option value="${c.id}" ${val === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}</select>`;
  const newBoard = m.boardTarget === 'new' || m.removeSample;
  const chips = COLS.filter(c => s.byColumn[c.id]).map(c => `<span class="tag">${c.name} ${s.byColumn[c.id]}</span>`).join(' ');
  const sum = [];
  if (s.total) sum.push(`<b style="font-weight:650">${s.total} task${s.total === 1 ? '' : 's'}</b> will be created${s.archivedOnImport ? `, and ${s.archivedOnImport} of them go straight to the Archive` : ''}.`);
  else sum.push(s.skippedExisting ? 'Everything in this file has already been imported.' : 'Nothing to import with these settings.');
  if (s.total && s.active) sum.push(`On your board: ${chips || 'none'}`);
  if (s.subtasks) sum.push(`${s.subtasks} subtask${s.subtasks === 1 ? '' : 's'} linked to their parent tasks.`);
  if (s.skippedExisting) sum.push(`${s.skippedExisting} already imported earlier, so they are skipped.`);
  return `<div class="m-back"><div class="m-panel wide" role="dialog" aria-modal="true" aria-label="Import from Zenkit">
    <div class="m-head"><h2 class="font-display" style="font-weight:700;font-size:19px">Import from Zenkit</h2><span class="note truncate" style="flex:1;min-width:0">${esc(m.fileName)}</span><button class="btn btn-ghost btn-icon" data-act="close-modal" aria-label="Close">${ic('x')}</button></div>
    <div class="m-body single">
      <p style="margin-bottom:14px"><b style="font-weight:650">${esc(p.listName)}</b>: ${p.counts.live} task${p.counts.live === 1 ? '' : 's'}${p.counts.archived ? `, plus ${p.counts.archived} that were archived or deleted in Zenkit` : ''}.</p>
      <div class="sec-h">Where it goes</div>
      <div class="field-row"><label for="impBoard">Board</label><select id="impBoard" class="inp" style="width:230px;flex:none" data-imp="board" ${m.removeSample ? 'disabled' : ''}><option value="new">New board</option>${S.boards.map(b => `<option value="${b.id}" ${m.boardTarget === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
      ${newBoard ? `<div class="field-row"><label for="impName">New board name</label><input id="impName" class="inp" style="width:230px;flex:none" data-imp="newName" value="${esc(m.newName)}" maxlength="60"></div>` : ''}
      ${S.sample ? tog('removeSample', 'Remove the sample boards and tasks first') : ''}
      <div class="sec-h" style="margin-top:18px">Zenkit stages to columns</div>
      ${sRows.map((r, i) => { const val = m.stageMap[r.key] || r.guess; return `<div class="field-row"><span style="min-width:0"><span class="truncate" style="display:block;font-weight:600">${esc(r.name)}</span><span class="note">${r.count} task${r.count === 1 ? '' : 's'}</span></span>${colSelect('impStage' + i, val, r.key, 'Column for the Zenkit stage ' + r.name)}</div>`; }).join('')}
      <p class="note" style="margin-top:6px">These are first guesses. Change any of them, and your choices are remembered for the next import.</p>
      ${tog('keepStageTag', 'Also keep the Zenkit stage as a tag when it is not the same as the column name')}
      ${pRows.length ? `<div class="sec-h" style="margin-top:18px">Zenkit priorities</div>${pRows.map((r, i) => { const val = m.priMap[r.key] || r.guess; return `<div class="field-row"><span style="min-width:0"><span class="truncate" style="display:block;font-weight:600">${esc(r.name)}</span><span class="note">${r.count} task${r.count === 1 ? '' : 's'}</span></span><select id="impPri${i}" class="inp" style="width:170px;flex:none" data-imp="pri" data-key="${esc(r.key)}" aria-label="Priority for ${esc(r.name)}">${Object.keys(PRI).map(k => `<option value="${k}" ${val === k ? 'selected' : ''}>${PRI[k].label}</option>`).join('')}</select></div>`; }).join('')}` : ''}
      <div class="sec-h" style="margin-top:18px">Options</div>
      ${p.counts.archived ? tog('includeArchived', `Also import the ${p.counts.archived} tasks that were archived or deleted in Zenkit (they go to the Archive)`) : ''}
      <div class="field-row"><label for="impDays" style="min-width:0">Send Done tasks to the Archive when they finished more than this many days ago (0 keeps them all on the board)</label><span class="flex items-center gap-2"><input id="impDays" type="number" min="0" max="3650" class="inp num" data-imp="days" value="${m.archiveDays}"><span class="note">days</span></span></div>
      ${p.hasWorkload ? `<div class="field-row"><label for="impUnit">Zenkit Workload numbers are in</label><select id="impUnit" class="inp" style="width:170px;flex:none" data-imp="unit"><option value="hours" ${m.workloadUnit === 'hours' ? 'selected' : ''}>Hours</option><option value="minutes" ${m.workloadUnit === 'minutes' ? 'selected' : ''}>Minutes</option></select></div>` : ''}
      <div class="sec-h" style="margin-top:18px">What you will get</div>
      <div class="card-box" style="display:flex;flex-direction:column;gap:6px">${sum.map(x => `<div>${x}</div>`).join('')}</div>
      ${res.warnings.length ? `<ul class="note" style="margin:12px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:4px">${res.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    </div>
    <div class="m-foot"><span class="note" style="flex:1;min-width:0">Nothing is changed until you choose Import. You can undo right afterwards.</span><button class="btn" data-act="close-modal">Cancel</button><button class="btn btn-primary" data-act="imp-run" ${s.total ? '' : 'disabled'}>Import ${s.total} task${s.total === 1 ? '' : 's'}</button></div>
  </div></div>`;
}
function runImport(){
  const m = ui.modal, p = m.parsed, Z = CoS.zenkit;
  const res = Z.build(p, importOpts(m));
  if (!res.tasks.length){ toast('Nothing to import with these settings.'); return; }
  const snap = JSON.parse(JSON.stringify({ boards:S.boards, projects:S.projects, tasks:S.tasks, tombstones:S.tombstones, sample:S.sample, sel:S.settings.boardsSel }));
  const createBoard = m.boardTarget === 'new' || m.removeSample;
  const board = createBoard ? newBoard({ name:(m.newName || '').trim() || p.listName || 'Imported tasks', h:HUES[S.boards.length % HUES.length] }) : null;
  const boardId = createBoard ? board.id : m.boardTarget;
  res.tasks.forEach(t => { t.boardId = boardId; });
  if (!createBoard){ const tb = boardOf(boardId), fb = { stages: defaultStages() }; res.tasks.forEach(t => { t.status = mapStatus(t.status, fb, tb); }); }   // the importer speaks the standard stages
  if (m.removeSample && S.sample) replaceAll({ boards:[board], projects:[], tasks:res.tasks, sample:false });
  else { if (board) S.boards.push(board); res.tasks.forEach(t => S.tasks.push(t)); }
  S.sample = false;
  S.settings.boardsSel = [boardId];
  S.settings.filters.archived = false;
  // remember the choices for next time
  const maps = S.settings.importMaps.zenkit, prefs = S.settings.importPrefs.zenkit;
  for (const r of Z.stageRows(p, m.includeArchived)) maps.stages[r.key] = m.stageMap[r.key] || r.guess;
  for (const r of Z.priorityRows(p, m.includeArchived)) maps.priorities[r.key] = m.priMap[r.key] || r.guess;
  prefs.archiveDays = m.archiveDays; prefs.keepStageTag = m.keepStageTag; prefs.workloadUnit = m.workloadUnit;
  const name = boardName(boardId), n = res.tasks.length, a = res.stats.archivedOnImport;
  save(); closeModal(); render();
  toast(`Imported ${n} task${n === 1 ? '' : 's'} into "${name}"${a ? `. ${a} went straight to the Archive` : ''}.`, { label:'Undo', fn:() => {
    replaceAll({ boards:snap.boards, projects:snap.projects, tasks:snap.tasks.map(newTask), sample:snap.sample });
    S.settings.boardsSel = snap.sel.filter(id => S.boards.some(b => b.id === id));
    save(); render(); toast('Import undone.', null, 3000);
  } }, 15000);
}

/* ---------- saved views (tabs under the toolbar; they belong to the board and sync with it) ---------- */
const VICON = { kanban:'layout-dashboard', list:'list', table:'table', calendar:'calendar' };
const VLABEL = { kanban:'Kanban', list:'List', table:'Table', calendar:'Calendar' };
const mainBoard = () => boardOf(primaryBoard()) || S.boards[0];
const viewFields = () => selBoards().flatMap(b => b.fields.custom);
function activeView(){
  const b = mainBoard(), legacy = { board:'kanban', table:'table', calendar:'calendar' }[S.settings.view];
  return b.views.find(v => v.id === S.settings.viewSel[b.id]) || b.views.find(v => v.id === b.defaultView) || b.views.find(v => v.type === legacy) || b.views[0];
}
function selectView(id){
  const b = mainBoard(), v = b.views.find(x => x.id === id); if (!v) return;
  S.settings.viewSel[b.id] = v.id; S.settings.view = v.type === 'kanban' || v.type === 'list' ? 'board' : v.type;
  ui.pop = null; save(); render();
}
function renderViewbar(){
  const b = mainBoard(), v = activeView(), H = v.type === 'kanban' || v.type === 'list' ? groupFor(v) : null, grouped = H && (v.type === 'kanban' || v.group);
  const sortName = (Tools.SORT_KEYS.find(x => x[0] === v.sort) || [])[1] || '';
  const showTools = v.type === 'kanban' || v.type === 'list';
  $('#viewbar').innerHTML = `<div class="vtabs" role="tablist" aria-label="Views">${b.views.map(x => `<button class="vtab ${x.id === v.id ? 'on' : ''}" role="tab" aria-selected="${x.id === v.id}" data-act="view" data-v="${esc(x.id)}" data-type="${x.type}">${ic(VICON[x.type], 'w-4 h-4')}<span>${esc(x.name)}</span></button>`).join('')}<button class="vtab vplus" data-act="pop-addview" aria-label="Add a view" title="Add a view" aria-haspopup="true">${ic('plus', 'w-4 h-4')}</button></div>
    <div class="vtools">
      ${showTools ? `<button class="vbtn ${v.sort !== 'manual' ? 'on' : ''}" data-act="pop-view" data-focus="sort" aria-haspopup="true">${ic('arrow-up-down', 'w-4 h-4')}<span class="hide-sm">${v.sort === 'manual' ? 'Sort' : esc(sortName)}</span></button>` : ''}
      ${showTools ? `<button class="vbtn on" data-act="pop-view" data-focus="group" aria-haspopup="true">${ic('columns', 'w-4 h-4')}<span class="hide-sm">${grouped ? esc((Tools.groupOptions(viewFields()).find(o => o[0] === H.group) || [])[1] || 'Stage') : 'Group'}</span></button>` : ''}
      <button class="vbtn" data-act="pop-view" aria-label="View settings" title="View settings" aria-haspopup="true">${ic('more-horizontal', 'w-4 h-4')}</button>
    </div>`;
}
function updateView(key, val){
  const b = mainBoard(), v = activeView();
  if (key === 'detail' || key === 'sortDir') val = +val;
  v[key] = val; save();
  if (key === 'name') renderViewbar(); else { renderViewbar(); renderContent(); }
}
function addView(type){
  const b = mainBoard(), v = newView(type, null); let n = 2, base = v.name;
  while (b.views.some(x => x.name === v.name)) v.name = base + ' ' + n++;
  b.views.push(v); S.settings.viewSel[b.id] = v.id; S.settings.view = type === 'kanban' || type === 'list' ? 'board' : type;
  save(); closePop(); render();
  const btn = $('[data-act="pop-view"][aria-label="View settings"]'); if (btn) openPop('view', btn);
}
function dupView(){
  const b = mainBoard(), v = activeView(), c = clone(v); c.id = uid(); c.name = v.name + ' copy';
  b.views.splice(b.views.indexOf(v) + 1, 0, c); S.settings.viewSel[b.id] = c.id; save(); closePop(); render();
}
function delView(){
  const b = mainBoard(), v = activeView(); if (b.views.length < 2){ toast('Keep at least one view.'); return; }
  const i = b.views.indexOf(v); b.views.splice(i, 1); if (b.defaultView === v.id) b.defaultView = '';
  delete S.settings.viewSel[b.id]; S.settings.viewSel[b.id] = b.views[Math.max(0, i - 1)].id; save(); closePop(); render();
  toast(`Deleted the view "${v.name}".`, { label:'Undo', fn:() => { b.views.splice(i, 0, v); S.settings.viewSel[b.id] = v.id; save(); render(); } }, 6000);
}
const DETAIL_LABELS = ['Title only', 'Priority and dates', 'Tags, progress and people', 'Everything'];
function viewPopHTML(){
  const b = mainBoard(), v = activeView(), fields = viewFields(), kan = v.type === 'kanban', lst = v.type === 'list';
  const sel = (key, opts, val, label) => `<select class="inp vs-sel" data-vs="${key}" aria-label="${esc(label)}">${opts.map(([id, l]) => `<option value="${esc(id)}" ${id === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const row = (label, inner) => `<div class="vs-row"><span>${label}</span>${inner}</div>`;
  const group = (kan || lst) ? `<h4>Grouping</h4><div class="vs-card">
      ${row(kan ? 'Horizontal Grouping' : 'Group by', sel('group', Tools.groupOptions(fields, { allowNone: lst }), v.group, kan ? 'Horizontal grouping' : 'Group by'))}
      ${kan ? row('Vertical Grouping', sel('vgroup', Tools.groupOptions(fields, { allowNone: true }), v.vgroup, 'Vertical grouping')) : ''}
      ${row('Aggregation', sel('agg', [['both', 'Count and workload'], ['count', 'Count'], ['estimate', 'Workload'], ['none', 'None']], v.agg, 'Aggregation'))}</div>
    <h4>Sort Order</h4><div class="vs-card">${row('Sort by', `<span class="flex items-center gap-2" style="min-width:0">${sel('sort', Tools.SORT_KEYS, v.sort, 'Sort by')}<button class="btn btn-sm btn-icon" data-act="vs-dir" aria-label="Sort direction: ${v.sortDir > 0 ? 'ascending' : 'descending'}" title="${v.sortDir > 0 ? 'Ascending' : 'Descending'}" ${v.sort === 'manual' ? 'disabled' : ''}>${ic(v.sortDir > 0 ? 'arrow-up' : 'arrow-down', 'w-4 h-4')}</button></span>`)}</div>
    <h4>Task Details</h4><div class="vs-card" style="padding:12px"><input type="range" min="0" max="3" step="1" value="${v.detail == null ? 2 : v.detail}" data-vs="detail" style="width:100%" aria-label="Task details"><div class="note" id="vsDetailNote" style="margin-top:4px">${DETAIL_LABELS[v.detail == null ? 2 : v.detail]}</div></div>` : (v.type === 'table'
    ? `<p class="note" style="margin:10px 0 0">Click a column heading to sort the table. The columns shown follow the board's Fields settings.</p>` : `<p class="note" style="margin:10px 0 0">Drag a task onto another day to change its due date.</p>`);
  return `<h4>${VLABEL[v.type]} view</h4><label class="lbl" for="vsName" style="margin-top:2px">Name</label><input id="vsName" class="inp" data-vs="name" value="${esc(v.name)}" maxlength="40">
    ${group}
    <div class="flex flex-wrap gap-2" style="margin-top:14px"><button class="btn btn-sm" data-act="vs-dup">${ic('copy', 'w-3.5 h-3.5')}Duplicate</button>
      <button class="btn btn-sm" data-act="vs-default" ${b.defaultView === v.id ? 'disabled' : ''}>${ic('check', 'w-3.5 h-3.5')}${b.defaultView === v.id ? 'Default view' : 'Make default'}</button>
      <button class="btn btn-sm btn-danger" data-act="vs-del" ${b.views.length < 2 ? 'disabled' : ''}>${ic('trash-2', 'w-3.5 h-3.5')}Delete view</button></div>`;
}
const addViewPopHTML = () => `<h4>Add a view</h4>${[['kanban', 'Cards in columns you can drag between.'], ['list', 'A simple grouped list with check circles.'], ['table', 'Rows and columns, sortable.'], ['calendar', 'Tasks on a month calendar.']].map(([t, d]) => `<button class="pick" data-act="view-add" data-type="${t}">${ic(VICON[t], 'w-5 h-5')}<span><b>${VLABEL[t]}</b><br><span class="note">${d}</span></span></button>`).join('')}`;

/* ---------- task actions: complete, rename, right-click menu, personal tags, subscribe, move, copy ---------- */
function toggleDone(id){
  const t = T(id); if (!t) return;
  if (isDone(t)){
    const ok = t.prevStatus && t.prevStatus !== t.status && stagesOf(t.boardId).some(x => x.id === t.prevStatus && !x.done);
    const to = ok ? t.prevStatus : reopenStage(t.boardId); t.prevStatus = ''; moveTask(id, to, nextOrder(to), true);
  } else { const dn = doneIdFor(t.boardId); t.prevStatus = t.status; moveTask(id, dn, topOrder(dn)); }
}
function startRename(id){
  const t = T(id); if (!t) return;
  ui.rename = id; ui.renameVal = t.title; render();
  const i = $(`[data-rename="${id}"]`); if (i){ i.focus(); i.select(); }
}
function finishRename(id, commit){
  if (ui.rename !== id) return;
  const t = T(id), title = (ui.renameVal || '').trim();
  ui.rename = null; ui.renameVal = '';
  if (commit && t && title && title !== t.title){ t.title = title.slice(0, 200); t.updated = nowISO(); logTask(t, 'Renamed'); save(); }
  render();
}
function copyText(text, ok){
  const fallback = () => { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); let done = false; try{ done = document.execCommand('copy'); }catch(e){} ta.remove(); toast(done ? ok : 'Copy was blocked here.'); };
  try{ navigator.clipboard.writeText(text).then(() => toast(ok), fallback); }catch(e){ fallback(); }
}
const taskLink = id => location.href.split('#')[0] + '#task=' + id;
function duplicateTask(id, boardId){
  const d = T(id); if (!d) return null;
  const same = !boardId || boardId === d.boardId;
  const c = newTask(Object.assign(clone(d), { id:uid(), boardId: same ? d.boardId : boardId, title: same ? d.title + ' (copy)' : d.title, created:nowISO(), updated:nowISO(), log:[], parentId:null, archived:false, archivedAt:'', doneAt:'', prevStatus:'',
    subitems:d.subitems.map(s => ({ id:uid(), title:s.title, done:false, taskId:null })), deps: same ? d.deps.slice() : [], projectId: same ? d.projectId : null, comments:[], reminder:null, external:null, source:'manual' }));
  c.status = mapStatus(d.status, boardOf(d.boardId), boardOf(c.boardId)); c.order = nextOrder(c.status);
  logTask(c, same ? 'Duplicated' : `Copied from board "${boardName(d.boardId)}"`); S.tasks.push(c); save(); return c;
}
function archiveWithUndo(id){
  const t = T(id); if (!t) return;
  const was = !!t.archived; archiveTasks([id], !was); render();
  toast(was ? 'Restored from the archive.' : 'Archived. Find it under Archive in the sidebar.', { label:'Undo', fn:() => { archiveTasks([id], was); render(); } }, 6000);
}
function toggleSubscribe(id){
  const a = S.settings.subscribed, i = a.indexOf(id);
  if (i >= 0){ a.splice(i, 1); toast('Unsubscribed.', null, 2500); }
  else { a.push(id); toast('Subscribed. You get a notice when this task changes on another device.', null, 4500); }
  save(); render();
}
function openCtx(id, x, y){ closePop(); ui.ctx = { id, x, y, sub:null }; renderCtx(); }
function closeCtx(){ if (!ui.ctx) return; ui.ctx = null; const r = $('#ctxRoot'); if (r) r.innerHTML = ''; }
const ctxI = (act, icon, label, cls = '', extra = '') => `<button type="button" role="menuitem" class="ctx-i ${cls}" data-act="${act}" ${extra}>${ic(icon, 'w-4 h-4')}<span>${esc(label)}</span></button>`;
function renderCtx(){
  const root = $('#ctxRoot'); if (!ui.ctx){ root.innerHTML = ''; return; }
  const c = ui.ctx, t = T(c.id); if (!t){ closeCtx(); return; }
  const v = activeView(), H = (v.type === 'kanban' || v.type === 'list') && v.group ? groupFor(v) : null;
  let items;
  if (!c.sub){
    items = ctxI('ctx-done', isDone(t) ? 'circle' : 'check-circle-2', isDone(t) ? 'Mark not complete' : 'Mark complete')
      + ctxI('ctx-proc', 'activity', t.inProcess ? 'Clear in process' : 'Mark in process') + (t.pin != null && rankOn() ? ctxI('ctx-unpin', 'pin', 'Let it rank automatically') : '')
      + ctxI('ctx-rename', 'pencil', 'Rename') + ctxI('ctx-sub', 'layout-dashboard', 'Change Position', '', 'data-sub="position"')
      + '<div class="ctx-sep"></div>' + ctxI('ctx-share', 'external-link', 'Share link') + ctxI('ctx-ptags', 'star', 'Edit personal tags')
      + ctxI('ctx-dup', 'copy', 'Duplicate') + ctxI('ctx-parent', 'corner-down-right', t.parentId && T(t.parentId) ? 'Change parent task…' : 'Make a subtask of…') + ctxI('ctx-sub', 'arrow-right', 'Move Task', '', 'data-sub="move"') + ctxI('ctx-sub', 'copy', 'Copy Task', '', 'data-sub="copy"')
      + ctxI('ctx-subscribe', 'rss', isSub(t.id) ? 'Unsubscribe' : 'Subscribe')
      + '<div class="ctx-sep"></div>' + ctxI('ctx-archive', 'archive', t.archived ? 'Restore from archive' : 'Archive', 'danger') + ctxI('ctx-delete', 'trash-2', 'Delete', 'danger');
  } else if (c.sub === 'position'){
    const cur = H ? H.keyOf(t) : null;
    items = ctxI('ctx-back', 'chevron-left', 'Change Position', 'ctx-head') + ctxI('ctx-top', 'arrow-up', 'Move to top') + ctxI('ctx-bottom', 'arrow-down', 'Move to bottom')
      + (H && H.editable ? '<div class="ctx-sep"></div><div class="ctx-label">Move to ' + esc((Tools.groupOptions(viewFields()).find(o => o[0] === H.group) || ['', 'group'])[1]) + '</div>' + H.groups.filter(g => g.id !== cur).map(g => ctxI('ctx-to', 'arrow-right', g.name, '', `data-gid="${esc(g.id)}"`)).join('') : '');
  } else {
    const verb = c.sub === 'move' ? 'Move Task' : 'Copy Task';
    items = ctxI('ctx-back', 'chevron-left', verb + ' to board', 'ctx-head') + S.boards.filter(b => c.sub === 'copy' || b.id !== t.boardId).map(b => ctxI(c.sub === 'move' ? 'ctx-move-to' : 'ctx-copy-to', 'folder', b.name + (b.id === t.boardId ? ' (this board)' : ''), '', `data-b="${b.id}"`)).join('');
  }
  root.innerHTML = `<div class="ctx" role="menu" aria-label="Task actions" style="left:${c.x}px;top:${c.y}px">${items}</div>`;
  const m = $('.ctx', root), r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(c.x, window.innerWidth - r.width - 8)) + 'px'; m.style.top = Math.max(8, Math.min(c.y, window.innerHeight - r.height - 8)) + 'px';
  icons(); const f = $('.ctx-i', m); if (f) f.focus();
}
function movePosition(id, where){
  const v = activeView(); if (v.sort !== 'manual'){ toast('This view is sorted automatically. Set Sort to Manual to place tasks by hand.', null, 4500); return; }
  const t = T(id), H = groupFor(v), peers = scope().filter(x => x.id !== id && H.keyOf(x) === H.keyOf(t));
  if (!peers.length) return;
  t.order = where === 'top' ? Math.min(...peers.map(x => x.order)) - 10 : Math.max(...peers.map(x => x.order)) + 10;
  t.updated = nowISO(); save(); render();
}
function openPtags(id){ closeCtx(); ui.modal = { type:'ptags', id, tags: pTags(id).slice() }; renderModal(); setTimeout(() => { const i = $('#ptIn'); if (i) i.focus(); }, 30); }
function ptagsHTML(){
  const m = ui.modal, t = T(m.id);
  return `<div class="m-back"><div class="m-panel narrow" role="dialog" aria-modal="true" aria-label="Personal tags"><div class="m-head"><h2 class="font-display" style="font-weight:700;font-size:18px;flex:1">Personal tags</h2><button class="btn btn-ghost btn-icon" data-act="close-modal" aria-label="Close">${ic('x')}</button></div>
    <div class="m-body single"><p class="note" style="margin-bottom:10px">${t ? `For "${esc(t.title)}". ` : ''}Only you see these. They stay on this device and are not synced to other devices or people.</p>
      <div class="flex flex-wrap gap-1" style="margin-bottom:${m.tags.length ? 8 : 0}px">${m.tags.map(x => `<span class="tag ptag" style="display:inline-flex;align-items:center;gap:4px">${ic('star', 'w-3 h-3')}${esc(x)}<button type="button" data-act="pt-rm" data-v="${esc(x)}" aria-label="Remove ${esc(x)}">${ic('x', 'w-3 h-3')}</button></span>`).join('')}</div>
      <input id="ptIn" class="inp" placeholder="Add a personal tag, then Enter" maxlength="30" autocomplete="off"></div>
    <div class="m-foot"><span style="flex:1"></span><button class="btn" data-act="close-modal">Cancel</button><button class="btn btn-primary" data-act="pt-save">Save</button></div></div></div>`;
}

/* ---------- grouping edits (dragging between columns, quick add inside a column) ---------- */
/* Sets the field a group stands for. Returns true when something changed. A stage is handled by the caller. */
function setGroupValue(t, group, gid){
  if (group === 'priority'){ if (!setImp(t, gid)) return false; t.locked = false; return true; }
  if (group === 'project'){ if ((t.projectId || '') === gid) return false; t.projectId = gid || null; return true; }
  if (group === 'board'){ if (t.boardId === gid) return false; t.status = mapStatus(t.status, boardOf(t.boardId), boardOf(gid)); t.boardId = gid; return true; }
  if (group === 'assignee'){ if ((t.assignees[0] || '') === gid) return false; t.assignees = gid ? [gid, ...t.assignees.filter(x => x !== gid)] : []; return true; }
  if (group && group.startsWith('cf:')){
    const id = group.slice(3), f = viewFields().find(x => x.id === id); if (!f) return false;
    if (f.type === 'check'){ const on = gid === 'yes'; if (!!t.custom[id] === on) return false; t.custom[id] = on; return true; }
    if ((t.custom[id] || '') === gid) return false; if (gid) t.custom[id] = gid; else delete t.custom[id]; return true;
  }
  return false;
}
function dropTo(id, gid, lane, order, pin){
  const t = T(id); if (!t){ render(); return; }
  const v = activeView(), H = groupFor(v), L = laneFor(v); let toStatus = null, changed = [], refused = '';
  const apply = (def, val) => {
    if (!def || !def.editable || val == null) return;
    if (def.group === 'status'){
      const sid = Tools.stageIdByKey(boardOf(t.boardId), val);
      if (!sid){ refused = `"${boardName(t.boardId)}" has no "${(def.groups.find(g => g.id === val) || {}).name || val}" stage.`; return; }
      if (sid !== t.status) toStatus = sid; return;
    }
    if (setGroupValue(t, def.group, val)) changed.push((def.groups.find(g => g.id === val) || {}).name || val);
  };
  apply(L, lane); apply(H, gid);
  if (refused){ toast(refused, null, 4500); render(); return; }
  if (v.sort === 'manual' && order != null){ t.order = order; if (pin != null) t.pin = pin; }
  if (toStatus){ moveTask(id, toStatus, v.sort === 'manual' ? order : null, false, v.sort === 'manual' && pin != null ? pin : undefined); if (changed.length){ logTask(t, 'Moved to ' + changed.join(', ')); save(); } return; }
  if (changed.length){ logTask(t, 'Moved to ' + changed.join(', ')); if (changed.length && v.group === 'priority') fireRules(t, { type:'priority', value:t.importance }); }
  t.updated = nowISO(); save(); render();
}
function newTaskDefaults(boardId){
  const tpl = (boardOf(boardId) || {}).template || {};
  return { boardId, status: tpl.status || 'consider', importance: tpl.importance || IMP_BAND[tpl.priority] || 5, tags: (tpl.tags || []).slice(), estimate: tpl.estimate || 0, assignees: (tpl.assignees || []).slice() };
}
function quickCreateIn(gid, lane, title){
  const v = activeView(), H = groupFor(v), L = laneFor(v);
  const t = newTask(Object.assign(newTaskDefaults(primaryBoard()), { title }));
  t.status = firstOpenStage(t.boardId);
  const put = (def, val) => { if (!def || !def.editable || val == null) return; if (def.group === 'status') t.status = Tools.stageIdByKey(boardOf(t.boardId), val) || t.status; else setGroupValue(t, def.group, val); };
  put(L, lane); put(H, gid);
  if (t.status === 'scheduled') t.scheduledFlow = true;
  t.order = nextOrder(t.status);
  logTask(t, 'Created'); S.tasks.push(t); fireRules(t, { type:'created' }); save(); return t;
}

/* ---------- board rules (js/tools.js holds the engine; this applies what it decides) ---------- */
function fireRules(t, ev){
  const b = boardOf(t.boardId); if (!b || !b.rules.length) return false;
  const res = Tools.applyRules(b.rules, ev, t, { today: todayStr(), fired: S.settings.ruleFired, stages: b.stages });
  if (res.status && isStuckChild(t, S.tasks)){ res.status = null; res.notes = res.notes.filter(x => !/^moved to /.test(x)); if (!res.notes.length && !res.archive) return false; }   // it follows its parent instead
  if (!res.names.length) return false;
  logTask(t, `Rule "${res.names.join('", "')}": ${res.notes.join(', ')}`);
  const wasDone = isDone(t);
  if (res.status){ t.status = res.status; applyManualStatus(t, res.status); t.order = isDone(t) ? topOrder(res.status) : nextOrder(res.status); }
  if (res.archive){ t.archived = true; t.archivedAt = nowISO(); }
  t.updated = nowISO();
  if (res.status){ followParent(t); if (isDone(t) && !wasDone && t.repeat) announceRepeat(spawnRepeat(t, 'completed')); }
  return true;
}
/* "Start date" and "Due date" rules: each fires once per date a task has, as soon as the date is `offset` days away or past. */
function runDateRules(){
  let n = 0; const today = todayStr();
  for (const t of S.tasks){
    if (t.archived || isDone(t)) continue;
    const b = boardOf(t.boardId); if (!b || !b.rules.length) continue;
    for (const type of ['start', 'due']){
      const date = t[type]; if (!date || !b.rules.some(r => r.on !== false && r.trigger && r.trigger.type === type)) continue;
      const before = JSON.stringify(t.fired || {});
      const did = fireRules(t, { type, date, days: diffDays(date, today) });
      if (did || JSON.stringify(t.fired || {}) !== before) n++;
    }
  }
  return n;
}
function runOverdueRules(){
  let n = 0; const today = todayStr();
  for (const t of S.tasks){
    if (t.archived || isDone(t) || dueState(t, today, S.boards) !== 'overdue') continue;
    const b = boardOf(t.boardId); if (!b || !b.rules.some(r => r.on !== false && r.trigger && r.trigger.type === 'overdue')) continue;
    if (fireRules(t, { type:'overdue' })) n++;
  }
  const f = S.settings.ruleFired, keep = addDays(today, -3);
  for (const k of Object.keys(f)) if (f[k] < keep) delete f[k];
  return n;
}

/* ---------- task editor: members, attachments, comments ---------- */
function addAssignee(name){
  const d = ui.modal.draft; name = String(name || '').trim().slice(0, 60);
  if (!name || d.assignees.includes(name)) return;
  d.assignees.push(name); renderModal(); const i = $('#asgIn'); if (i) i.focus();
}
function addAttachment(){
  const i = $('#attIn'), raw = i ? i.value.trim() : ''; if (!raw) return;
  const name = raw.replace(/[?#].*$/, '').split(/[\\/]/).filter(Boolean).pop() || raw;
  ui.modal.draft.attachments.push({ id:uid(), name: name.length > 60 ? name.slice(0, 57) + '…' : name, url: raw, added: nowISO() });
  renderModal(); const n = $('#attIn'); if (n) n.focus();
}
/* Comments and attachment removals are saved straight away, like Zenkit, so nothing is lost if the editor is closed. */
function commitAndRefresh(){
  const d = commitDraft(); if (!d) return;
  ui.modal.draft = clone(T(d.id)); ui.modal.snap = JSON.stringify(ui.modal.draft); ui.modal.isNew = false; renderModal(); render();
}
function addComment(){
  const i = $('#cmtIn'), text = i ? i.value.trim() : ''; if (!text) return;
  ui.modal.draft.comments.push({ id:uid(), at:nowISO(), by:S.settings.me || 'You', text:text.slice(0, 4000) });
  commitAndRefresh(); const n = $('#cmtIn'); if (n) n.focus();
}
function setCf(el){
  const d = ui.modal.draft, id = el.dataset.cf; let v = el.value;
  if (el.dataset.t === 'number'){ v = v === '' ? '' : parseFloat(v); if (typeof v === 'number' && isNaN(v)) v = ''; }
  if (v === '') delete d.custom[id]; else d.custom[id] = v;
}
/* ---------- board settings (Settings, Access, Automations, Archive, Activities, Fields, Add-ons) ---------- */
function openBoardSettings(id, tab){
  closePop(); closeCtx();
  const b = boardOf(id || primaryBoard()); if (!b) return;
  ui.modal = { type:'bset', id:b.id, tab: tab || 'settings', fdEdit:null, icsDone:false, newField:{ name:'', type:'text', options:'' } };
  renderModal();
}
const bsetBoard = () => boardOf(ui.modal.id);
const BS_NAV = [['settings', 'settings', 'Settings'], ['stages', 'columns', 'Stages'], ['access', 'users', 'Access'], ['rules', 'zap', 'Automations'], ['archive', 'archive', 'Archive'], ['activity', 'activity', 'Activities'], ['fields', 'list', 'Fields']];
const BS_ADDONS = [['addons', 'puzzle', 'Manage Add-Ons', null], ['ical', 'calendar-days', 'iCalendar Subscription', 'ical'], ['colors', 'palette', 'Colored Tasks', 'colors'], ['email', 'mail', 'Email to Project', 'email']];
const BS_TITLES = { settings:'Settings', stages:'Stages', access:'Access', rules:'Automations', archive:'Archive', activity:'Activities', fields:'Fields', addons:'Manage Add-Ons', ical:'iCalendar Subscription', colors:'Colored Tasks', email:'Email to Project' };
const bsSel = (attrs, opts, val, label) => `<select class="inp" ${attrs} aria-label="${esc(label)}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const bsRow = (label, inner, note) => `<div class="field-row"><span style="min-width:0"><span style="font-weight:600">${label}</span>${note ? `<br><span class="note">${note}</span>` : ''}</span><span style="flex:none;max-width:60%">${inner}</span></div>`;
const IMP_SPECS = [['low', 'Low (1–3)'], ['medium', 'Medium (4–7)'], ['high', 'High (8–10)'], ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => [n + '+', n + ' or more'])];
function valCtl(kind, val, attrs, label, members, stages){
  const a = `${attrs} aria-label="${esc(label)}"`;
  if (kind === 'column') return bsSel(a, (stages || defaultStages()).map(c => [c.id, c.name]), val, label);
  if (kind === 'priority') return bsSel(a, IMP_SPECS, val, label);
  if (kind === 'importance') return bsSel(a, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(k => [String(k), String(k)]), IMP_BAND[val] || val, label);
  if (kind === 'offset') return bsSel(a, Tools.DATE_OFFSETS.map(([v, l]) => [String(v), l]), val == null || val === '' ? '0' : val, label);
  if (kind === 'flag') return bsSel(a, [['', 'No flag'], ...Object.keys(FLAGS).map(k => [k, FLAGS[k].name])], val, label);
  if (kind === 'member' && members && members.length) return bsSel(a, [['', 'Choose…'], ...members.map(n => [n, n]), ...(val && !members.includes(val) ? [[val, val]] : [])], val, label);
  if (kind === 'days') return `<input type="number" class="inp" style="width:90px" min="-365" max="365" value="${esc(val ?? 0)}" ${a}>`;
  if (kind === 'text' || kind === 'member') return `<input class="inp" style="width:150px" value="${esc(val ?? '')}" placeholder="${kind === 'member' ? 'Name' : 'tag'}" maxlength="40" ${a}>`;
  return '';
}
const RULE_DEFAULTS = { column:'done', priority:'high', importance:'8', offset:'0', text:'', member:'', days:'0', flag:'' };
const TRIG = Object.fromEntries(Tools.RULE_TRIGGERS.map(x => [x.id, x])), ACT = Object.fromEntries(Tools.RULE_ACTIONS.map(x => [x.id, x]));

/* ---------- stages editor (Board settings, Stages) ---------- */
const stCount = (b, id) => S.tasks.filter(t => t.boardId === b.id && t.status === id).length;
function bsStagesHTML(b){
  const del = ui.modal.stDel && b.stages.find(x => x.id === ui.modal.stDel);
  const colorIdx = st => STAGE_COLORS.findIndex(c => c.h === st.h && c.s === st.s);
  const rows = b.stages.map((st, i) => {
    const n = stCount(b, st.id), ci = colorIdx(st), nm = esc(st.name);
    return `<div class="fd-row st-row">
      <span class="dot" style="background:${hsl(st.h, Math.max(st.s, 30), 52)};width:12px;height:12px"></span>
      <input class="inp" style="flex:1;min-width:90px" value="${nm}" maxlength="40" data-st="name" data-id="${esc(st.id)}" aria-label="Stage name">
      <select class="inp" style="width:104px;flex:none" data-st="color" data-id="${esc(st.id)}" aria-label="Color for ${nm}">${ci < 0 ? '<option value="-1" selected>Custom</option>' : ''}${STAGE_COLORS.map((c, k) => `<option value="${k}" ${k === ci ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
      <button type="button" class="btn btn-sm ${st.done ? 'on' : ''}" data-act="st-done" data-id="${esc(st.id)}" aria-pressed="${!!st.done}" title="Tasks in the completed stage count as done" ${st.done ? 'disabled' : ''}>${ic('check', 'w-3.5 h-3.5')}${st.done ? 'Completed stage' : 'Make completed'}</button>
      <span class="note mono" style="width:34px;text-align:right" title="Tasks in this stage">${n}</span>
      <button class="btn btn-ghost btn-sm btn-icon" data-act="st-up" data-id="${esc(st.id)}" aria-label="Move ${nm} left" ${i === 0 ? 'disabled' : ''}>${ic('arrow-up', 'w-4 h-4')}</button>
      <button class="btn btn-ghost btn-sm btn-icon" data-act="st-down" data-id="${esc(st.id)}" aria-label="Move ${nm} right" ${i === b.stages.length - 1 ? 'disabled' : ''}>${ic('arrow-down', 'w-4 h-4')}</button>
      <button class="btn btn-ghost btn-sm btn-icon btn-danger" data-act="st-del" data-id="${esc(st.id)}" aria-label="Delete ${nm}" ${st.done ? 'disabled title="Make another stage the completed one first"' : ''}>${ic('trash-2', 'w-4 h-4')}</button></div>`;
  }).join('');
  const delPanel = del ? `<div class="card-box" style="margin-top:12px" role="alert"><b style="font-weight:650">Delete "${esc(del.name)}"?</b>
      <p class="note" style="margin:4px 0 8px">${stCount(b, del.id)} task${stCount(b, del.id) === 1 ? ' is' : 's are'} in this stage. Move ${stCount(b, del.id) === 1 ? 'it' : 'them'} to:</p>
      <div class="flex gap-2 flex-wrap items-center"><select class="inp" style="width:200px" data-st="delTo" aria-label="Move tasks to">${b.stages.filter(x => x.id !== del.id).map(x => `<option value="${esc(x.id)}" ${x.id === ui.modal.stTo ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <button class="btn btn-danger" data-act="st-del-ok">${ic('trash-2')}Delete stage</button><button class="btn btn-ghost" data-act="st-del-cancel">Cancel</button></div></div>` : '';
  return `<p class="note" style="margin-bottom:10px">Stages are this board's columns, in order from left to right. Rename, recolor, reorder, add or delete them freely. Exactly one stage is the <b>completed</b> stage: the circle on a card moves a task there, and tasks in it count as done.</p>
    <div class="fd-list">${rows}</div>${delPanel}
    <div class="card-box" style="margin-top:14px"><label class="lbl" for="stNew">Add a stage</label>
      <div class="flex gap-2"><input id="stNew" class="inp" placeholder="e.g. Waiting on someone" maxlength="40" data-st="new"><button class="btn btn-primary" data-act="st-add" ${b.stages.length >= MAX_STAGES ? 'disabled' : ''}>${ic('plus')}Add</button></div>
      <p class="note" style="margin-top:6px">${b.stages.length} of ${MAX_STAGES} stages. New stages go just before the completed one.</p></div>
    <p class="note" style="margin-top:12px">Automation (Settings, Automation) moves tasks between the standard stages (Consider, Scheduled, Long-Term, Near-Term, Up Next). It skips any board that no longer has the stage it would move a task to. When boards are shown together, stages with the same name share a column.</p>`;
}
function stageNameOk(b, name, exceptId){
  name = name.trim(); if (!name){ toast('A stage needs a name.'); return false; }
  const k = stageKey(name);
  if (b.stages.some(x => x.id !== exceptId && stageKey(x.name) === k)){ toast(`This board already has a stage called "${name}".`); return false; }
  return true;
}
function stApply(el){
  const b = bsetBoard(), st = b && b.stages.find(x => x.id === el.dataset.id), k = el.dataset.st;
  if (k === 'delTo'){ ui.modal.stTo = el.value; return; }
  if (!st) return;
  if (k === 'name'){
    if (!stageNameOk(b, el.value, st.id)){ renderModal(); return; }
    const oldK = stageKey(st.name), nm = el.value.trim().slice(0, 40); st.name = nm;
    const f = S.settings.filters.status, i = f.indexOf(oldK); if (i >= 0) f[i] = stageKey(nm);   // a saved stage filter follows the rename
    save(); render(); renderModal();
  } else if (k === 'color'){
    const c = STAGE_COLORS[+el.value]; if (!c) return; st.h = c.h; st.s = c.s; save(); render(); renderModal();
  }
}
function removeStage(b, id, to){
  const st = b.stages.find(x => x.id === id); if (!st || st.done || !b.stages.some(x => x.id === to)) return;
  const moved = S.tasks.filter(t => t.boardId === b.id && t.status === id);
  for (const t of moved){ t.status = to; t.order = nextOrder(to); t.updated = nowISO(); logTask(t, `Stage "${st.name}" was deleted; moved to "${(b.stages.find(x => x.id === to) || {}).name}"`); }
  b.stages = b.stages.filter(x => x.id !== id);
  for (const r of b.rules){ if (r.trigger && r.trigger.value === id) r.trigger.value = to; for (const a of r.actions || []) if (a.type === 'move' && a.value === id) a.value = to; }
  for (const r of b.colors.rules) if (r.type === 'stage' && r.value === id) r.value = to;
  if (b.template.status === id) b.template.status = to;
  const key = stageKey(st.name), f = S.settings.filters.status;
  if (f.includes(key) && !S.boards.some(x => x.stages.some(y => stageKey(y.name) === key))) S.settings.filters.status = f.filter(x => x !== key);
  ui.modal.stDel = null; save(); render(); renderModal();
  return moved.length;
}
function bsSettingsHTML(b){
  const tpl = b.template, members = b.members.map(x => x.name), folders = [...new Set(S.boards.map(x => x.folder).filter(Boolean))].sort();
  const act = (id, icon, label, extra = '') => `<button type="button" class="bs-act" data-act="${id}" ${extra}>${ic(icon, 'w-5 h-5')}<span>${label}</span>${ic('chevron-right', 'w-4 h-4')}</button>`;
  return `<div class="sec-h">Board</div>
    <label class="lbl" for="bsName">Name</label><input id="bsName" class="inp" data-bs="name" value="${esc(b.name)}" maxlength="60">
    <span class="lbl" style="margin-top:14px">Color</span><div class="flex flex-wrap gap-2">${HUES.map(h => `<button type="button" class="swatch" data-act="bs-hue" data-h="${h}" aria-pressed="${b.h === h}" aria-label="Hue ${h}" style="background:${hsl(h, 65, 52)}"></button>`).join('')}</div>
    <div class="sec-h" style="margin-top:22px">Default view</div>
    ${bsSel('data-bs="defaultView"', [['', b.views[0].name + ' (first view)'], ...b.views.map(v => [v.id, v.name])], b.defaultView, 'Default view')}
    <p class="note" style="margin-top:6px">The view this board opens in on a device that has not picked one yet.</p>
    <div class="sec-h" style="margin-top:22px">New task defaults</div>
    <p class="note" style="margin-bottom:8px">New tasks created on this board start with these values. A task made inside a column or group starts in that column or group.</p>
    ${bsRow('Stage', bsSel('data-bs="template.status"', b.stages.map(c => [c.id, c.name]), tpl.status, 'Default stage'))}
    ${bsRow('Importance', bsSel('data-bs="template.importance" data-t="int"', [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(k => [k, k]), tpl.importance, 'Default importance'))}
    ${bsRow('Tags', `<input class="inp" style="width:180px" data-bs="template.tags" data-t="tags" value="${esc(tpl.tags.join(', '))}" placeholder="comma, separated" aria-label="Default tags">`)}
    ${bsRow('Workload', `<input class="inp" style="width:110px" data-bs="template.estimate" data-t="est" value="${esc(fmtEst(tpl.estimate))}" placeholder="e.g. 30m" aria-label="Default workload">`)}
    ${members.length ? bsRow('Assigned to', bsSel('data-bs="template.assignees" data-t="one"', [['', 'Nobody'], ...members.map(n => [n, n])], tpl.assignees[0] || '', 'Default assignee')) : ''}
    <div class="sec-h" style="margin-top:22px">Location</div>
    ${bsRow('Folder', `<span class="flex items-center gap-2">${bsSel('data-bs="folder" data-t="folder"', [['', 'No folder'], ...folders.map(f => [f, f]), ['__new__', 'New folder…']], b.folder, 'Folder')}</span>`, 'Boards in a folder are grouped together in the sidebar.')}
    ${ui.modal.newFolder ? `<div class="field-row"><label for="bsFolderNew">New folder name</label><input id="bsFolderNew" class="inp" style="width:200px" data-bs-folder maxlength="40"></div>` : ''}
    <div class="sec-h" style="margin-top:22px">Actions</div>
    <div class="bs-acts"><label class="bs-act" for="csvFile" style="cursor:pointer">${ic('upload', 'w-5 h-5')}<span>Import CSV</span>${ic('chevron-right', 'w-4 h-4')}</label><input id="csvFile" type="file" accept=".csv,text/csv" style="width:0;height:0;opacity:0;position:absolute">
      ${act('bs-csv', 'file-spreadsheet', 'Export as CSV')}${act('bs-json', 'file-text', 'Export as JSON')}${act('bs-print-table', 'printer', 'Print as table')}${act('bs-print-list', 'list', 'Print as list')}${act('bs-email', 'mail', 'Email this list')}</div>
    <p class="note" style="margin-top:8px">CSV files open in Excel. Importing adds tasks and never changes the ones you already have. JSON is a copy of this board's data.</p>
    <div class="sec-h" style="margin-top:22px">Danger zone</div>
    <button class="btn btn-danger" data-act="bs-delete">${ic('trash-2')}Delete this board</button>`;
}
function bsAccessHTML(b){
  return `<p class="note" style="margin-bottom:12px">Members are the people you can assign tasks to on this board. Cursus CoS keeps your data on your devices, so there are no accounts or permissions here. Anyone you share a sync file or server with sees the whole board.</p>
    ${b.members.length ? b.members.map((x, i) => `<div class="field-row"><span class="flex items-center gap-2" style="min-width:0">${avatar(x.name)}<span style="min-width:0"><b style="font-weight:620;display:block" class="truncate">${esc(x.name)}</b>${x.email ? `<br><span class="note">${esc(x.email)}</span>` : ''}</span></span><button class="btn btn-ghost btn-sm btn-icon" data-act="mem-rm" data-i="${i}" aria-label="Remove ${esc(x.name)}">${ic('x')}</button></div>`).join('') : '<p class="note">No members yet.</p>'}
    <div class="sec-h" style="margin-top:18px">Add a member</div>
    <div class="flex gap-2 flex-wrap"><input id="memName" class="inp" style="flex:1;min-width:140px" placeholder="Name" maxlength="60" aria-label="Member name"><input id="memEmail" class="inp" style="flex:1;min-width:160px" placeholder="Email (optional)" maxlength="120" aria-label="Member email"><button class="btn btn-primary" data-act="mem-add">${ic('user-plus')}Add</button></div>
    <div class="sec-h" style="margin-top:22px">You</div>
    <div class="field-row"><label for="meName">Your name (shown on your comments)</label><input id="meName" class="inp" style="width:200px" data-set="me" data-type="str" value="${esc(S.settings.me || '')}" maxlength="60" placeholder="You"></div>`;
}
function bsRulesHTML(b){
  const members = b.members.map(x => x.name);
  const card = r => {
    const tk = TRIG[r.trigger.type] || TRIG.created, rid = esc(r.id), rk = (k, kind, val, label) => valCtl(kind, val, `data-rule="${rid}" data-k="${k}"`, label, members, b.stages);
    return `<div class="rule-card ${r.on === false ? 'off' : ''}">
      <div class="flex items-center gap-2"><button type="button" class="switch" role="switch" data-act="rule-on" data-id="${rid}" aria-checked="${r.on !== false}" aria-label="Rule on or off"></button><input class="inp" data-rule="${rid}" data-k="name" value="${esc(r.name)}" maxlength="60" aria-label="Rule name"><button class="btn btn-ghost btn-sm btn-icon" data-act="rule-del" data-id="${rid}" aria-label="Delete rule">${ic('trash-2', 'w-4 h-4')}</button></div>
      <div class="rule-line"><b>When</b>${bsSel(`data-rule="${rid}" data-k="trigger.type"`, Tools.RULE_TRIGGERS.map(x => [x.id, x.label]), r.trigger.type, 'Trigger')}${tk.value ? rk('trigger.value', tk.value, r.trigger.value, 'Trigger value') : ''}</div>
      <div class="rule-line"><b>Only if</b>${bsSel(`data-rule="${rid}" data-k="cond.priority"`, [['', 'any importance'], ...IMP_SPECS], (r.cond && r.cond.priority) || '', 'Only if importance')}<input class="inp" style="width:150px" data-rule="${rid}" data-k="cond.tag" value="${esc((r.cond && r.cond.tag) || '')}" placeholder="has tag (optional)" maxlength="40" aria-label="Only if tagged">${bsSel(`data-rule="${rid}" data-k="cond.stage"`, [['', 'in any stage'], ...b.stages.map(c => [c.id, 'in ' + c.name])], (r.cond && r.cond.stage) || '', 'Only if in stage')}</div>
      ${r.trigger.type === 'start' || r.trigger.type === 'due' ? `<p class="note" style="margin:-2px 0 6px">Runs once for each date, for tasks that are not done. Choose "in" a stage above so tasks you have already moved on are left alone.</p>` : ''}
      ${r.actions.map((a, i) => { const ad = ACT[a.type] || ACT.addTag; return `<div class="rule-line"><b>${i ? 'And' : 'Then'}</b>${bsSel(`data-rule="${rid}" data-k="actions.${i}.type"`, Tools.RULE_ACTIONS.map(x => [x.id, x.label]), a.type, 'Action')}${ad.value ? rk(`actions.${i}.value`, ad.value, a.value, 'Action value') : ''}<button class="btn btn-ghost btn-sm btn-icon" data-act="rule-a-del" data-id="${rid}" data-i="${i}" aria-label="Remove action" ${r.actions.length < 2 ? 'disabled' : ''}>${ic('x', 'w-4 h-4')}</button></div>`; }).join('')}
      <button class="btn btn-sm" data-act="rule-a-add" data-id="${rid}">${ic('plus', 'w-3.5 h-3.5')}Add action</button></div>`;
  };
  return `<p class="note" style="margin-bottom:12px">Rules run on this board when you move, create or change the importance of a task by hand, once a day for overdue tasks, and when a task's start or due date arrives (for example: when the start date arrives, move it to In Progress, only if it is in Scheduled). A rule never triggers another rule. The built-in Scheduled and urgent flow is in Settings, Automation.</p>
    ${b.rules.length ? b.rules.map(card).join('') : '<p class="note">No rules yet.</p>'}
    <button class="btn btn-primary" style="margin-top:10px" data-act="rule-add">${ic('plus')}Add a rule</button>`;
}
function bsArchiveHTML(b){
  const list = S.tasks.filter(t => t.boardId === b.id && t.archived).sort((x, y) => (y.archivedAt || '') < (x.archivedAt || '') ? -1 : 1);
  if (!list.length) return `<p class="note">Nothing is archived on this board. Archive finished tasks from the Done column or a task's menu, or set Settings, Automation to archive them for you.</p>`;
  return `<div class="flex gap-2 flex-wrap" style="margin-bottom:10px"><button class="btn" data-act="bs-restore-all">${ic('rotate-ccw')}Restore all (${list.length})</button><button class="btn" data-act="bs-open-archive">${ic('archive')}Open in the board</button><button class="btn btn-danger" data-act="bs-delete-archived">${ic('trash-2')}Delete all permanently</button></div>
    ${list.slice(0, 100).map(t => `<div class="field-row"><span style="min-width:0"><button class="truncate" style="display:block;text-align:left;font-weight:600;max-width:420px" data-act="open-task" data-id="${t.id}">${esc(t.title)}</button><span class="note">${stg(t).name}${t.archivedAt ? ` · archived ${timeAgo(t.archivedAt)}` : ''}</span></span><span class="flex gap-1"><button class="btn btn-sm" data-act="bs-restore" data-id="${t.id}">Restore</button><button class="btn btn-sm btn-danger btn-icon" data-act="bs-delete-one" data-id="${t.id}" aria-label="Delete permanently">${ic('trash-2', 'w-3.5 h-3.5')}</button></span></div>`).join('')}
    ${list.length > 100 ? `<p class="note" style="margin-top:8px">Showing the 100 most recent of ${list.length}.</p>` : ''}`;
}
function bsActivityHTML(b){
  const feed = Tools.boardActivity(S.tasks.filter(t => t.boardId === b.id), 120);
  if (!feed.length) return '<p class="note">No activity yet.</p>';
  return `<p class="note" style="margin-bottom:10px">The latest changes and comments on this board. Each task remembers its last 40 changes.</p>` + feed.map(x => `<div class="act-row">${x.kind === 'comment' ? avatar(x.by || 'You') : `<span class="avatar" style="background:var(--surface-3);color:var(--muted)">${ic('activity', 'w-3 h-3')}</span>`}<div style="min-width:0;flex:1"><div><button class="truncate" style="font-weight:620;max-width:100%;text-align:left" data-act="open-task" data-id="${x.task.id}">${esc(x.task.title)}</button> <span class="note">${esc(timeAgo(x.at))}</span></div><div class="${x.kind === 'comment' ? '' : 'note'}">${x.kind === 'comment' ? `<b style="font-weight:620">${esc(x.by || 'You')}:</b> ` : ''}${esc(x.text)}</div></div></div>`).join('');
}
function bsFieldsHTML(b){
  const cfg = b.fields, ed = ui.modal.fdEdit, nf = ui.modal.newField;
  const typeSel = (attrs, val, dis) => `<select class="inp" style="width:140px" ${attrs} ${dis ? 'disabled' : ''} aria-label="Field type">${Object.entries(FIELD_TYPES).map(([k, l]) => `<option value="${k}" ${val === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const rows = cfg.order.map((id, i) => {
    const cust = id.startsWith('cf:') ? cfg.custom.find(f => 'cf:' + f.id === id) : null, bi = BUILTIN_FIELDS.find(x => x.id === id), hidden = cfg.hidden.includes(id);
    const name = cust ? cust.name : bi.name, icon = cust ? ({ text:'type', number:'hash', date:'calendar', label:'tag', check:'check-square' })[cust.type] : bi.icon;
    return `<div class="fd-row ${hidden ? 'off' : ''}"><span class="fd-ic">${ic(icon, 'w-4 h-4')}</span><span class="fd-name">${esc(name)}${cust ? `<span class="note"> · ${FIELD_TYPES[cust.type]}</span>` : ''}</span>
      ${cust ? `<button class="btn btn-ghost btn-sm" data-act="fd-edit" data-id="${cust.id}">Edit</button>` : ''}
      <button class="btn btn-ghost btn-sm btn-icon" data-act="fd-up" data-id="${esc(id)}" aria-label="Move ${esc(name)} up" ${i === 0 ? 'disabled' : ''}>${ic('arrow-up', 'w-4 h-4')}</button>
      <button class="btn btn-ghost btn-sm btn-icon" data-act="fd-down" data-id="${esc(id)}" aria-label="Move ${esc(name)} down" ${i === cfg.order.length - 1 ? 'disabled' : ''}>${ic('arrow-down', 'w-4 h-4')}</button>
      <button class="btn btn-ghost btn-sm btn-icon" data-act="fd-eye" data-id="${esc(id)}" aria-label="${hidden ? 'Show' : 'Hide'} ${esc(name)}" aria-pressed="${!hidden}" ${id === 'stage' ? 'disabled title="The stage is always shown"' : ''}>${ic(hidden ? 'eye-off' : 'eye', 'w-4 h-4')}</button></div>`;
  }).join('');
  const f = ed && cfg.custom.find(x => x.id === ed);
  const form = f ? `<div class="card-box" style="margin-top:14px"><b style="font-weight:650">Edit "${esc(f.name)}"</b>
      <label class="lbl" for="fdName" style="margin-top:10px">Name</label><input id="fdName" class="inp" data-fd="name" value="${esc(f.name)}" maxlength="40">
      <label class="lbl" for="fdDesc" style="margin-top:10px">Description (shown as a hint)</label><input id="fdDesc" class="inp" data-fd="desc" value="${esc(f.desc || '')}" maxlength="80">
      ${f.type === 'label' ? `<label class="lbl" for="fdOpts" style="margin-top:10px">Labels, one per line</label><textarea id="fdOpts" class="inp" rows="4" data-fd="options">${esc(f.options.map(o => o.name).join('\n'))}</textarea>` : ''}
      <div class="flex gap-2" style="margin-top:12px"><button class="btn btn-danger" data-act="fd-del" data-id="${f.id}">${ic('trash-2')}Delete field</button><span style="flex:1"></span><button class="btn btn-primary" data-act="fd-done">Done</button></div>
      <p class="note" style="margin-top:6px">Deleting a field hides it everywhere. Values already entered on tasks are kept until you restore the field with the same name, which creates a new empty field.</p></div>` : '';
  return `<div class="fd-row fixed"><span class="fd-ic">${ic('align-left', 'w-4 h-4')}</span><span class="fd-name">Title</span><span class="note">Primary</span></div>
    <div class="fd-list">${rows}</div>
    <p class="note" style="margin-top:8px">Use the arrows to change the order of fields in the task editor. The eye hides a field from the editor, cards and table. Hidden fields keep their data.</p>${form}
    <div class="sec-h" style="margin-top:22px">Add a custom field</div>
    <div class="flex gap-2 flex-wrap"><input id="nfName" class="inp" style="flex:1;min-width:160px" data-nf="name" placeholder="Field name" value="${esc(nf.name)}" maxlength="40" aria-label="New field name">${typeSel('data-nf="type"', nf.type)}</div>
    ${nf.type === 'label' ? `<label class="lbl" for="nfOpts" style="margin-top:10px">Labels, one per line</label><textarea id="nfOpts" class="inp" rows="4" data-nf="options" placeholder="Red\nAmber\nGreen">${esc(nf.options)}</textarea>` : ''}
    <button class="btn btn-primary" style="margin-top:10px" data-act="fd-add">${ic('plus')}Add custom field</button>
    <p class="note" style="margin-top:6px">Text, number, date, label (pick one from a list) and checkbox fields. Label and checkbox fields can also group a Kanban board or list.</p>`;
}
function bsIcalHTML(b){
  const n = S.tasks.filter(t => t.boardId === b.id && !t.archived && (t.start || t.due) && (ui.modal.icsDone || !isDone(t))).length;
  return `<p class="note" style="margin-bottom:12px">Put this board's dates on your calendar. Each task with a scheduled or due date becomes an all-day event, and a task with both becomes one event spanning them.</p>
    <button type="button" class="tog" data-act="ics-done" role="checkbox" aria-checked="${!!ui.modal.icsDone}"><span class="chk" style="${ui.modal.icsDone ? 'background:var(--accent);border-color:var(--accent);color:var(--accent-ink)' : ''}">${ui.modal.icsDone ? ic('check', 'w-3 h-3') : ''}</span><span>Include finished tasks</span></button>
    <div class="flex gap-2 flex-wrap" style="margin-top:12px"><button class="btn btn-primary" data-act="ics-save" ${n ? '' : 'disabled'}>${ic('download')}Download calendar file (${n} event${n === 1 ? '' : 's'})</button><button class="btn" data-act="ics-copy" ${n ? '' : 'disabled'}>${ic('copy')}Copy calendar text</button></div>
    <p class="note" style="margin-top:12px">Open the .ics file in Outlook, Google Calendar or Apple Calendar to import the events. This is a snapshot: export again after your tasks change. A live subscription that updates by itself needs the file published at a web address, which a device-only app cannot host.</p>`;
}
function bsColorsHTML(b){
  const c = b.colors, fieldsL = b.fields.custom.filter(f => f.type === 'label'), members = b.members.map(x => x.name);
  const kinds = [['priority', 'Priority is', 'priority'], ['stage', 'Stage is', 'column'], ['tag', 'Has the tag', 'text'], ['assignee', 'Assigned to', 'member'], ['flag', 'Flag color is', 'flag'], ['overdue', 'Is overdue', null], ['soon', 'Is due soon', null], ['blocked', 'Is blocked', null]];
  return `<p class="note" style="margin-bottom:12px">Whole-card colors for this board. Rules are checked top to bottom and the first match wins. When no rule matches, the base setting below is used.</p>
    ${bsRow('Base color by', bsSel('data-bs="colors.by"', [['', 'Use the Color button setting'], ['status', 'Stage'], ['priority', 'Priority'], ['flag', 'Flag'], ...fieldsL.map(f => ['cf:' + f.id, f.name])], c.by, 'Base color'))}
    <div class="sec-h" style="margin-top:18px">Color rules</div>
    ${c.rules.length ? c.rules.map((r, i) => { const kd = kinds.find(k => k[0] === r.type) || kinds[0];
      return `<div class="rule-line"><span class="swatch-sm" style="background:${hsl(FLAGS[r.color].h, FLAGS[r.color].s, 52)}"></span>${bsSel(`data-cr="${i}" data-k="type"`, kinds.map(k => [k[0], k[1]]), r.type, 'Rule type')}${kd[2] ? valCtl(kd[2], r.value, `data-cr="${i}" data-k="value"`, 'Rule value', members, b.stages) : ''}<span>→</span>${bsSel(`data-cr="${i}" data-k="color"`, Object.keys(FLAGS).map(k => [k, FLAGS[k].name]), r.color, 'Color')}<button class="btn btn-ghost btn-sm btn-icon" data-act="cr-up" data-i="${i}" aria-label="Move rule up" ${i === 0 ? 'disabled' : ''}>${ic('arrow-up', 'w-4 h-4')}</button><button class="btn btn-ghost btn-sm btn-icon" data-act="cr-del" data-i="${i}" aria-label="Delete rule">${ic('x', 'w-4 h-4')}</button></div>`; }).join('') : '<p class="note">No color rules yet.</p>'}
    <button class="btn btn-primary" style="margin-top:10px" data-act="cr-add">${ic('plus')}Add a color rule</button>`;
}
function bsEmailHTML(b){
  const X = S.settings.integrations.exchange, here = X.targetBoard === b.id;
  return `<p class="note" style="margin-bottom:12px">When Exchange email is connected, flagged or incoming mail becomes tasks. Choose whether they land on this board. Connecting a mailbox needs the relay described in Settings, Email, so nothing arrives yet.</p>
    <div class="field-row"><span><b style="font-weight:650">Send incoming email to this board</b>${X.targetBoard && !here ? `<br><span class="note">Right now it goes to "${esc(boardName(X.targetBoard))}".</span>` : ''}</span><button type="button" class="switch" role="switch" data-act="email-here" aria-checked="${here}" aria-label="Send incoming email to this board"></button></div>
    ${bsRow('Lands in stage', bsSel('data-set="integrations.exchange.targetColumn" data-type="str"', Tools.unionStages(S.boards).map(c => [c.key, c.name]), X.targetColumn, 'Stage for email tasks'))}
    <button class="btn" style="margin-top:12px" data-act="open-email-settings">${ic('mail')}Open email settings</button>`;
}
function bsAddonsHTML(){
  const A = S.settings.addons, row = (k, icon, name, d) => `<div class="field-row"><span class="flex items-center gap-3" style="min-width:0">${ic(icon, 'w-5 h-5')}<span><b style="font-weight:650">${name}</b><br><span class="note">${d}</span></span></span>${sw('addons.' + k, A[k], name)}</div>`;
  return `<p class="note" style="margin-bottom:8px">Turn optional features on or off. A feature that is off disappears from this menu and stops affecting your boards. Its settings are kept.</p>
    ${row('ical', 'calendar-days', 'iCalendar Subscription', 'Export a board\'s dates to a calendar file.')}${row('colors', 'palette', 'Colored Tasks', 'Color rules and color by label for each board.')}${row('email', 'mail', 'Email to Project', 'Choose which board incoming email lands on.')}`;
}
function bsetHTML(){
  const m = ui.modal, b = bsetBoard(); if (!b) return '';
  const A = S.settings.addons, tab = m.tab;
  const nav = ([id, icon, label, sub]) => `<button class="bs-i ${tab === id ? 'on' : ''}" data-act="bs-tab" data-v="${id}">${ic(icon, 'w-5 h-5')}<span class="bs-l"><span>${label}</span>${id === 'access' ? `<span class="note">${b.members.length} member${b.members.length === 1 ? '' : 's'}</span>` : id === 'stages' ? `<span class="note">${b.stages.length} stages</span>` : ''}</span>${ic('chevron-right', 'w-4 h-4')}</button>`;
  const body = { settings:bsSettingsHTML, stages:bsStagesHTML, access:bsAccessHTML, rules:bsRulesHTML, archive:bsArchiveHTML, activity:bsActivityHTML, fields:bsFieldsHTML, ical:bsIcalHTML, colors:bsColorsHTML, email:bsEmailHTML, addons:bsAddonsHTML }[tab](b);
  return `<div class="m-back"><div class="m-panel bset" role="dialog" aria-modal="true" aria-label="Board settings">
    <nav class="bs-nav" aria-label="Board settings sections">
      <div class="bs-brand"><span class="dot" style="background:${hsl(b.h, 65, 52)};width:14px;height:14px"></span><b class="truncate">${esc(b.name)}</b></div>
      <div class="bs-group">${BS_NAV.map(nav).join('')}</div>
      <div class="bs-group"><div class="bs-card"><span class="flex items-center gap-2">${ic('cloud-off', 'w-5 h-5')}<span><b style="font-weight:620">Offline support</b><br><span class="note">Works without internet. ${S.meta.sync.mode !== 'off' ? esc(syncLabel()) : 'Sync is off.'}</span></span></span></div></div>
      <div class="bs-h">Add-Ons</div>
      <div class="bs-group">${BS_ADDONS.filter(x => !x[3] || A[x[3]]).map(([id, icon, label]) => nav([id, icon, label])).join('')}</div>
    </nav>
    <section class="bs-main"><header class="bs-head"><h2 class="font-display">${BS_TITLES[tab]}</h2><button class="btn btn-ghost" data-act="close-modal" style="color:var(--accent);font-weight:650">Done</button></header><div class="bs-body">${body}</div></section></div></div>`;
}
/* ---------- board files: CSV, JSON, calendar, print, email ---------- */
const fileSlug = s => String(s || 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'board';
async function deliverFile(name, text, mime, what){
  const r = await Host.saveFile({ name, text, mime });
  if (r && r.ok){ toast(`${what} saved to ${r.where || 'your device'}.`, null, 4500); return true; }
  copyText(text, `Saving files is blocked here, so the ${what.toLowerCase()} text was copied instead. Paste it into a new file.`);
  return false;
}
const boardTasksOf = b => S.tasks.filter(t => t.boardId === b.id);
function printTasks(mode){
  const b = bsetBoard(), tasks = boardTasksOf(b).filter(t => !t.archived);
  $('#printRoot').innerHTML = Tools.printHTML(tasks, mode, { title: b.name, boards: S.boards });
  document.body.classList.add('printing');
  try{ window.print(); }catch(e){ toast('Printing is not available here. Export a CSV instead.'); }
  setTimeout(() => { document.body.classList.remove('printing'); }, 600);
}
function emailList(){
  const b = bsetBoard(), tasks = boardTasksOf(b).filter(t => !t.archived && !isDone(t));
  const url = 'mailto:?subject=' + encodeURIComponent(b.name + ' tasks') + '&body=' + encodeURIComponent(Tools.mailBody(tasks, { title: b.name, boards: S.boards }));
  Host.openExternal(url);
}
function loadCsvFile(file){
  const b = bsetBoard(), rd = new FileReader();
  rd.onerror = () => toast('That file could not be read.');
  rd.onload = async () => {
    const res = Tools.csvToTasks(String(rd.result), { board:b, projects:S.projects });
    if (!res.tasks.length){ toast(res.warnings[0] || 'No tasks found in that file.', null, 6000); return; }
    const note = [`${res.tasks.length} task${res.tasks.length === 1 ? '' : 's'} will be added to "${b.name}".`, res.stats.skipped ? `${res.stats.skipped} row${res.stats.skipped === 1 ? ' has' : 's have'} no title and are skipped.` : '', res.newProjects.length ? `${res.newProjects.length} new project${res.newProjects.length === 1 ? '' : 's'} will be created.` : '', ...res.warnings].filter(Boolean).join(' ');
    if (!await confirmBox({ title:'Import this CSV?', body:note, ok:'Import' })) return;
    let order = {};
    for (const t of res.tasks){ order[t.status] = order[t.status] == null ? nextOrder(t.status) : order[t.status] + 10; t.order = order[t.status]; }
    res.newProjects.forEach(p => S.projects.push(p)); res.tasks.forEach(t => S.tasks.push(t)); save(); render(); renderModal();
    const ids = new Set(res.tasks.map(t => t.id)), pids = new Set(res.newProjects.map(p => p.id));
    toast(`Imported ${res.tasks.length} task${res.tasks.length === 1 ? '' : 's'}.`, { label:'Undo', fn:() => {
      S.tasks = S.tasks.filter(t => !ids.has(t.id)); S.projects = S.projects.filter(p => !pids.has(p.id));
      ids.forEach(i => tombstone('task', i)); pids.forEach(i => tombstone('project', i)); save(); render(); renderModal();
    } }, 10000);
  };
  rd.readAsText(file);
}
function deleteTasks(ids, label){
  const set = new Set(ids), snap = JSON.stringify({ tasks:S.tasks, tombstones:S.tombstones });
  const spawned = S.tasks.filter(x => set.has(x.id) && x.repeat).map(x => spawnRepeat(x, 'deleted')).filter(Boolean);
  S.tasks = S.tasks.filter(x => !set.has(x.id));
  S.tasks.forEach(x => { x.deps = x.deps.filter(d => !set.has(d)); if (set.has(x.parentId)) x.parentId = null; x.subitems.forEach(s => { if (set.has(s.taskId)) s.taskId = null; }); });
  ids.forEach(i => tombstone('task', i)); save(); render();
  toast(label, { label:'Undo', fn:() => { const o = JSON.parse(snap); S.tasks = o.tasks.map(newTask); S.tombstones = o.tombstones; spawned.forEach(n => tombstone('task', n.id)); S.tasks.forEach(t => { if (set.has(t.id)) t.updated = nowISO(); }); save(); render(); renderModal(); } }, 8000);
}
async function deleteBoard(id){
  if (S.boards.length < 2){ toast('Keep at least one board.'); return false; }
  const n = S.tasks.filter(t => t.boardId === id).length;
  if (!await confirmBox({ title:`Delete "${boardName(id)}"?`, body:`${n} task${n === 1 ? '' : 's'} on this board will be deleted too. This cannot be undone.`, ok:'Delete board', danger:true })) return false;
  const ids = new Set(S.tasks.filter(t => t.boardId === id).map(t => t.id));
  S.tasks = S.tasks.filter(t => !ids.has(t.id)); S.tasks.forEach(t => { t.deps = t.deps.filter(d => !ids.has(d)); t.subitems.forEach(s => { if (ids.has(s.taskId)) s.taskId = null; }); if (ids.has(t.parentId)) t.parentId = null; });
  S.boards = S.boards.filter(b => b.id !== id); S.settings.boardsSel = S.settings.boardsSel.filter(i => i !== id);
  ids.forEach(i => tombstone('task', i)); tombstone('board', id);
  save(); return true;
}

/* ---------- board settings: changes made in the dialog ---------- */
function bsApply(el){
  const b = bsetBoard(); if (!b) return;
  const path = el.dataset.bs, t = el.dataset.t; let v = el.value;
  if (t === 'tags') v = v.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  else if (t === 'est') v = parseEst(v);
  else if (t === 'int') v = parseInt(v, 10);
  else if (t === 'one') v = v ? [v] : [];
  else if (t === 'folder'){
    if (v === '__new__'){ ui.modal.newFolder = true; renderModal(); setTimeout(() => { const i = $('#bsFolderNew'); if (i) i.focus(); }, 0); return; }
    ui.modal.newFolder = false;
  }
  setPath(b, path, v); if (path === 'template.importance') b.template.priority = bandOf(v); save();
  if (path === 'name'){ renderSidebar(); renderToolbar(); icons(); const br = $('.bs-brand b'); if (br) br.textContent = b.name; return; }
  render(); renderModal();
}
function ruleApply(el){
  const b = bsetBoard(), r = b && b.rules.find(x => x.id === el.dataset.rule); if (!r) return;
  const k = el.dataset.k, v = el.value; r.cond = r.cond || {};
  setPath(r, k, k === 'cond.tag' ? v.trim().toLowerCase() : v);
  if (k === 'cond.priority' && !v) delete r.cond.priority;
  if (k === 'cond.stage' && !v) delete r.cond.stage;
  let redraw = el.tagName === 'SELECT';
  if (k === 'trigger.type'){ const tk = TRIG[v]; r.trigger.value = tk && tk.value ? (tk.value === 'column' ? doneIdOf(b) : RULE_DEFAULTS[tk.value]) : null; }
  const m = k.match(/^actions\.(\d+)\.type$/); if (m){ const ad = ACT[v]; r.actions[+m[1]].value = ad && ad.value ? (ad.value === 'column' ? doneIdOf(b) : RULE_DEFAULTS[ad.value]) : null; }
  save(); if (redraw) renderModal();
}
const CR_KIND = { priority:'priority', stage:'column', tag:'text', assignee:'member', flag:'flag' };
const CR_DEFAULTS = { priority:'high', stage:'done', tag:'', assignee:'', flag:'red', overdue:null, soon:null, blocked:null };
function crApply(el){
  const b = bsetBoard(), r = b && b.colors.rules[+el.dataset.cr]; if (!r) return;
  const k = el.dataset.k; r[k] = el.value;
  if (k === 'type') r.value = el.value === 'stage' ? doneIdOf(b) : CR_DEFAULTS[el.value];
  save(); render(); if (el.tagName === 'SELECT') renderModal();
}
const FIELD_HUES = [4, 28, 48, 145, 175, 214, 268, 326];
function parseOptions(text, old){
  const names = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean), seen = new Set();
  return names.filter(n => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())).map((n, i) => { const o = (old || []).find(x => x.name.toLowerCase() === n.toLowerCase()); return o || { id:uid(), name:n, h:FIELD_HUES[i % FIELD_HUES.length] }; });
}
function bsFieldChange(el){
  const b = bsetBoard(), m = ui.modal;
  if (el.dataset.nf){ m.newField[el.dataset.nf] = el.value; if (el.dataset.nf === 'type') renderModal(); return; }
  const f = b.fields.custom.find(x => x.id === m.fdEdit); if (!f) return;
  const k = el.dataset.fd;
  if (k === 'options') f.options = parseOptions(el.value, f.options);
  else if (k === 'name'){ f.name = el.value.trim() || f.name; } else f[k] = el.value;
  save(); render(); renderModal();
}
/* ---------- settings modal ---------- */
const BG_PRESETS = [
  { id:'dusk', name:'Dusk', css:'linear-gradient(135deg,#1d2b4a 0%,#5a3f6e 55%,#c97b5c 100%)' },
  { id:'glacier', name:'Glacier', css:'linear-gradient(160deg,#cfe3ea 0%,#e8eff4 48%,#d3e0f1 100%)' },
  { id:'moss', name:'Moss', css:'linear-gradient(145deg,#233d33 0%,#3c5e4a 60%,#7d9a6b 100%)' },
  { id:'harbor', name:'Harbor', css:'radial-gradient(1200px 700px at 12% 0%,#4f7fa8 0%,transparent 60%),radial-gradient(900px 600px at 100% 100%,#27465f 0%,transparent 55%),#16303f' },
  { id:'sand', name:'Sand', css:'linear-gradient(150deg,#efe3cf 0%,#e3cdb1 60%,#d2b48f 100%)' },
  { id:'graphite', name:'Graphite', css:'linear-gradient(160deg,#20262b 0%,#10151a 100%)' },
  { id:'rose', name:'Rosewater', css:'linear-gradient(140deg,#f4d9df 0%,#e9c3d2 50%,#c9a6c9 100%)' },
  { id:'aurora', name:'Aurora', css:'radial-gradient(900px 500px at 20% 10%,#3fa7a0 0%,transparent 60%),radial-gradient(900px 600px at 90% 20%,#6c5bd1 0%,transparent 55%),#102a2f' },
];
function sw(path, on, label){ return `<span class="field-row" style="padding:0;border:0"><button type="button" class="switch" role="switch" data-act="set-switch" data-path="${path}" aria-checked="${on}" aria-label="${esc(label)}"></button></span>`; }
function getPath(o, p){ return p.split('.').reduce((a, k) => a && a[k], o); }
function setPath(o, p, v){ const ks = p.split('.'); const last = ks.pop(); const t = ks.reduce((a, k) => a[k], o); t[last] = v; }
function settingsHTML(){
  const tab = ui.settingsTab, s = S.settings, A = s.automation, X = s.integrations.exchange;
  const tabs = [['appearance', 'Appearance'], ['automation', 'Automation'], ['sync', 'Sync'], ['integrations', 'Email'], ['data', 'Data']];
  let body = '';
  if (tab === 'appearance'){
    const bg = s.bg;
    body = `<div class="sec-h">Theme</div><div class="seg" role="group">${[['auto', 'Match system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button data-act="set-theme" data-v="${v}" aria-pressed="${s.theme === v}">${l}</button>`).join('')}</div>
      <div class="sec-h" style="margin-top:22px">Custom background</div>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:10px">
        <button class="bgtile" data-act="bg-none" aria-pressed="${bg.type === 'none'}" style="background:var(--surface-3);color:var(--ink);text-shadow:none">Plain</button>
        ${BG_PRESETS.map(p => `<button class="bgtile" data-act="bg-preset" data-id="${p.id}" aria-pressed="${bg.type === 'preset' && bg.value === p.id}" style="background:${p.css}">${p.name}</button>`).join('')}
      </div>
      <div class="flex flex-wrap items-center gap-3" style="margin-top:14px">
        <label class="btn" for="bgColor" style="cursor:pointer">${ic('palette')}Solid color</label><input id="bgColor" type="color" value="${bg.type === 'color' ? bg.value : '#3b5b6b'}" style="width:0;height:0;opacity:0;position:absolute">
        <label class="btn" for="bgFile" style="cursor:pointer">${ic('image')}Upload image</label><input id="bgFile" type="file" accept="image/*" style="width:0;height:0;opacity:0;position:absolute">
        ${bg.type === 'image' ? `<span class="note">Using your uploaded image</span>` : ''}
      </div>
      <div style="margin-top:16px"><label class="lbl" for="bgDim">Dim the background: ${Math.round((bg.dim || 0) * 100)}%</label><input id="bgDim" type="range" min="0" max="0.7" step="0.05" value="${bg.dim || 0}" style="width:100%"></div>
      <p class="note" style="margin-top:10px">Uploaded images are resized and stored only in this browser. Panels turn translucent over a background so text stays readable.</p>`;
  } else if (tab === 'automation'){
    const stOpts = Tools.unionStages(S.boards).filter(x => !x.done);
    const stageSel = (path, val) => `<select class="inp" style="width:auto;min-width:120px" data-set="${path}" data-type="str" aria-label="Column">${stOpts.map(c => `<option value="${c.key}" ${val === c.key ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}${stOpts.some(c => c.key === val) ? '' : `<option value="${esc(val)}" selected>${esc(val)} (no such column)</option>`}</select>`;
    const flagSel = (path, val) => `<select class="inp" style="width:auto;min-width:96px" data-set="${path}" data-type="str" aria-label="Flag color"><option value="" ${val ? '' : 'selected'}>No flag</option>${Object.keys(FLAGS).map(k => `<option value="${k}" ${val === k ? 'selected' : ''}>${FLAGS[k].name}</option>`).join('')}</select>`;
    const num = (path, v, min, max) => `<input type="number" class="inp num" data-set="${path}" data-type="num" min="${min}" max="${max}" value="${v}" aria-label="${path}">`;
    body = `<div class="field-row"><div><b style="font-weight:650">Automation</b><p class="note">Checked on load, every 30 seconds and after edits.</p></div>${sw('automation.enabled', A.enabled, 'Automation')}</div>
      <div class="card-box" style="margin-top:12px"><div class="field-row" style="padding:0;border:0"><div style="min-width:0"><b style="font-weight:650">Rank cards inside a column</b><p class="note">Important and urgent tasks rise to the top (importance and due date count equally). A card you drag into place stays there. Each column has a sort button that clears hand-placed cards and ranks them all.</p></div>${sw('automation.rank', A.rank !== false, 'Rank cards')}</div></div>
      <div class="card-box" style="margin-top:12px"><div class="field-row" style="padding-top:0"><div><b style="font-weight:650">Scheduled items follow their start date</b><p class="note">Applies to tasks you place in Scheduled.</p></div>${sw('automation.scheduled', A.scheduled, 'Scheduled rule')}</div>
        <div class="field-row"><span>Move to Near-Term when start is within</span><span class="flex items-center gap-2">${num('automation.nearTermDays', A.nearTermDays, 0, 90)}<span class="note">days</span></span></div>
        <div class="field-row"><span>Move to Up Next when start is within</span><span class="flex items-center gap-2">${num('automation.upNextDays', A.upNextDays, 0, 30)}<span class="note">days</span></span></div></div>
      <div class="card-box" style="margin-top:12px"><div class="field-row" style="padding-top:0"><div><b style="font-weight:650">Important and urgent</b><p class="note">Applies to tasks in Consider, Long-Term or Near-Term that are important enough.</p></div>${sw('automation.urgent', A.urgent, 'Urgent rule')}</div>
        <div class="field-row"><span>Counts as important at importance</span><span class="flex items-center gap-2">${num('automation.urgentMin', A.urgentMin == null ? 8 : A.urgentMin, 1, 10)}<span class="note">or more</span></span></div>
        <div class="field-row"><span>Move to Up Next when due within</span><span class="flex items-center gap-2">${num('automation.urgentDays', A.urgentDays, 0, 30)}<span class="note">days</span></span></div>
        <div class="field-row"><span>Move to Near-Term when due within</span><span class="flex items-center gap-2">${num('automation.soonDays', A.soonDays, 0, 90)}<span class="note">days</span></span></div></div>
      <div class="card-box" style="margin-top:12px"><div style="margin-bottom:6px"><b style="font-weight:650">Ask about tasks that have sat too long</b><p class="note">When a task has been in a column longer than this, it gets a flag and the app asks whether to move it on. Tasks with a start date still ahead are left alone. Choosing "Keep" starts the clock again.</p></div>
        ${(A.stale || []).map((r, i) => `<div class="field-row" style="align-items:flex-start;gap:12px"><span class="flex items-center gap-2" style="flex:1;min-width:0;flex-wrap:wrap;row-gap:8px">In ${stageSel(`automation.stale.${i}.from`, r.from)} for more than ${num(`automation.stale.${i}.days`, r.days, 1, 3650)} days, ask to move it to ${stageSel(`automation.stale.${i}.to`, r.to)} and flag it ${flagSel(`automation.stale.${i}.flag`, r.flag)}</span><span style="flex-shrink:0;padding-top:4px">${sw(`automation.stale.${i}.on`, r.on !== false, 'Rule ' + (i + 1))}</span></div>`).join('')}</div>
      <div class="card-box" style="margin-top:12px"><div class="field-row" style="padding:0;border:0"><div style="min-width:0"><b style="font-weight:650">Archive finished tasks</b><p class="note">Done tasks move to the Archive after this many days. 0 turns it off. Archived tasks leave boards, the calendar and reminders, and can be restored from Archive in the sidebar.</p></div><span class="flex items-center gap-2">${num('automation.archiveDays', A.archiveDays || 0, 0, 3650)}<span class="note">days</span></span></div></div>
      <div class="field-row"><div><b style="font-weight:650">Ask about a follow-up</b><p class="note">When you move a task to In Progress, ask when to follow up and create that task.</p></div>${sw('followUp.ask', (s.followUp || {}).ask !== false, 'Ask about a follow-up')}</div>
      <div class="field-row"><div><b style="font-weight:650">Reminder time for date-based reminders</b><p class="note">Used for "1 day before due" style reminders.</p></div><input type="time" class="inp" style="width:120px" data-set="reminderTime" data-type="str" value="${s.reminderTime}"></div>
      <p class="note" style="margin-top:6px">Tasks blocked by an unfinished dependency stop at Near-Term. A task you drag by hand is left alone until you change its importance or dates, or switch automation back on in its editor.</p>
      <button class="btn" style="margin-top:12px" data-act="auto-run">${ic('zap')}Run automation now</button>`;
  } else if (tab === 'integrations'){
    body = dropMailCardHTML() + '<div style="height:16px"></div>' + gmailCardHTML() + `<div class="card-box" style="margin-top:16px"><div class="flex items-center gap-3"><span style="width:38px;height:38px;border-radius:10px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center">${ic('mail', 'w-5 h-5')}</span><div style="flex:1"><b style="font-weight:650">Microsoft Exchange / Outlook</b><p class="note">Turns flagged or incoming mail into tasks.</p></div><span class="pill" style="font-size:12px;padding:3px 9px;border-radius:99px;background:var(--surface-3)">Not connected</span></div>
      <p class="note" style="margin-top:10px">The mapping layer is built and tested below. A live mailbox connection needs a small relay service that calls Microsoft Graph and hands messages to <code>CoS.api.ingestEmails()</code>, because the web page itself cannot hold a Microsoft sign-in. In the Windows app the poller can run in the app's main process instead.</p></div>
      <div class="sec-h" style="margin-top:18px">Import rules</div>
      <div class="field-row"><span>Target board</span><select class="inp" style="width:190px" data-set="integrations.exchange.targetBoard" data-type="str"><option value="">First selected board</option>${S.boards.map(b => `<option value="${b.id}" ${X.targetBoard === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
      <div class="field-row"><span>Lands in column</span><select class="inp" style="width:190px" data-set="integrations.exchange.targetColumn" data-type="str">${Tools.unionStages(S.boards).map(c => `<option value=\"${c.key}\" ${X.targetColumn === c.key ? 'selected' : ''}>${c.name}</option>`).join('')}</select></div>
      <div class="field-row"><span>Only import flagged messages</span>${sw('integrations.exchange.onlyFlagged', X.onlyFlagged, 'Only flagged')}</div>
      <div class="field-row"><span>High-importance email becomes importance 8</span>${sw('integrations.exchange.mapImportance', X.mapImportance, 'Map importance')}</div>
      <div class="field-row"><span>Follow-up flag date becomes due date</span>${sw('integrations.exchange.mapFlagDue', X.mapFlagDue, 'Map flag due')}</div>
      <div class="field-row"><span>Outlook categories become tags</span>${sw('integrations.exchange.mapCategories', X.mapCategories, 'Map categories')}</div>
      <div class="sec-h" style="margin-top:18px">Try it with a sample message</div>
      <p class="note" style="margin-bottom:8px">Paste a Microsoft Graph message (or an array of them), or load the sample. Messages already imported are skipped by id.</p>
      <textarea id="mailJson" class="inp" rows="6" style="font-family:var(--font-mono);font-size:12px" placeholder='{"id":"…","subject":"…","importance":"high"}'></textarea>
      <div class="flex gap-2" style="margin-top:8px"><button class="btn" data-act="mail-sample">Load sample</button><button class="btn btn-primary" data-act="mail-import">${ic('inbox')}Import as tasks</button></div>
      <div class="sec-h" style="margin-top:18px">For the relay</div><div class="codebox">CoS.api.ingestEmails(graphMessages, 'exchange')
// → { added: 2, skipped: 1 }</div>`;
  } else if (tab === 'sync'){
    body = syncTabHTML();
  } else {
    body = `<div class="card-box"><b style="font-weight:650">This device</b><p class="note" style="margin-top:4px">Running as: ${esc(Host.label)}${ui.info && ui.info.dataPath ? `<br>Data folder: <span class="mono">${esc(ui.info.dataPath)}</span>` : ''}${ui.info && ui.info.version ? `<br>Version ${esc(ui.info.version)}${ui.info.build ? ' (build ' + esc(ui.info.build) + ')' : ''}` : ''}</p>${Host.platform === 'android' ? `<button class="btn" style="margin-top:8px" data-act="app-update">Check for a newer version</button>` : ''}</div>
      <div class="card-box" style="margin-top:12px"><b style="font-weight:650">Import from Zenkit</b><p class="note" style="margin:4px 0 10px">In Zenkit, open the list's settings and choose Export as JSON. Choose that file here. You see a preview first and can change where each Zenkit stage goes before anything is imported.</p><label class="btn" for="zkFile" style="cursor:pointer">${ic('upload')}Choose Zenkit JSON file</label><input id="zkFile" type="file" accept="application/json,.json" style="width:0;height:0;opacity:0;position:absolute"></div>
      <div class="card-box" style="margin-top:12px"><b style="font-weight:650">Back up</b><p class="note" style="margin:4px 0 10px">Everything lives in this browser's local storage. Copy the backup somewhere safe, or move your data to another browser.</p><div class="flex flex-wrap gap-2"><button class="btn" data-act="data-save">${ic('download')}Save backup file</button><button class="btn" data-act="data-copy">${ic('copy')}Copy backup JSON</button></div></div>
      <div class="card-box" style="margin-top:12px"><b style="font-weight:650">Restore</b><p class="note" style="margin:4px 0 8px">Paste a backup or choose a file. This replaces your current data.</p><textarea id="restoreJson" class="inp" rows="4" style="font-family:var(--font-mono);font-size:12px" placeholder="Paste backup JSON"></textarea>
        <div class="flex flex-wrap gap-2" style="margin-top:8px"><label class="btn" for="restoreFile" style="cursor:pointer">${ic('upload')}Choose file</label><input id="restoreFile" type="file" accept="application/json,.json" style="width:0;height:0;opacity:0;position:absolute"><button class="btn btn-primary" data-act="data-restore">Restore</button></div></div>
      <div class="card-box" style="margin-top:12px"><b style="font-weight:650">Reset</b><p class="note" style="margin:4px 0 10px">Load the sample boards again, or erase everything and start empty.</p><div class="flex flex-wrap gap-2"><button class="btn" data-act="data-sample">Load sample data</button><button class="btn btn-danger" data-act="data-erase">${ic('trash-2')}Erase everything</button></div></div>`;
  }
  return `<div class="m-back"><div class="m-panel wide" role="dialog" aria-modal="true" aria-label="Settings"><div class="m-head"><h2 class="font-display" style="font-weight:700;font-size:19px;margin-right:12px">Settings</h2><div class="seg" role="tablist" style="overflow:auto">${tabs.map(([v, l]) => `<button data-act="set-tab" data-v="${v}" aria-pressed="${tab === v}">${l}</button>`).join('')}</div><span style="flex:1"></span><button class="btn btn-ghost btn-icon" data-act="close-modal" aria-label="Close">${ic('x')}</button></div><div class="m-body single">${body}</div></div></div>`;
}

/* ---------- background & theme ---------- */
let hostTheme = document.documentElement.getAttribute('data-theme');
function applyTheme(){
  const t = S.settings.theme, r = document.documentElement;
  if (t === 'auto'){ if (hostTheme) r.setAttribute('data-theme', hostTheme); else r.removeAttribute('data-theme'); }
  else r.setAttribute('data-theme', t);
}
function applyBg(){
  const bg = S.settings.bg, el = $('#bgLayer'); let css = '';
  if (bg.type === 'preset'){ const p = BG_PRESETS.find(x => x.id === bg.value); if (p) css = p.css; }
  else if (bg.type === 'color') css = bg.value;
  else if (bg.type === 'image' && bgCache) css = `url("${bgCache}") center / cover no-repeat`;
  el.style.background = css || 'none'; el.style.setProperty('--dim', String(bg.dim || 0));
  document.documentElement.classList.toggle('has-bg', !!css);
}
function setBgImage(file){
  const rd = new FileReader();
  rd.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = Host.platform === 'android' ? 1280 : 1920, sc = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let q = 0.82, url = c.toDataURL('image/jpeg', q);
      while (url.length > 2.4e6 && q > 0.35){ q -= 0.15; url = c.toDataURL('image/jpeg', q); }
      bgCache = url;
      Host.kv.set(KEY_BG, url).catch(() => toast('Image is too large for this device\'s storage, so it will only last this session.', null, 6000));
      S.settings.bg = { type:'image', value:'upload', dim: Math.max(S.settings.bg.dim || 0, 0.15) };
      save(); applyBg(); renderModal(); render();
    };
    img.onerror = () => toast('That file could not be read as an image.');
    img.src = rd.result;
  };
  rd.readAsDataURL(file);
}

/* ---------- email ingest (adapters live in js/ingest.js) ---------- */
function ingestEmails(msgs, adapter = 'exchange'){
  const ad = CoS.ingest.adapters[adapter]; if (!ad) throw new Error('Unknown adapter: ' + adapter);
  const cfg = S.settings.integrations[adapter] || {}; let added = 0, skipped = 0;
  for (const m of [].concat(msgs || [])){
    const draft = ad.toTask(m, cfg); if (!draft){ skipped++; continue; }
    if (S.tasks.some(t => t.external && t.external.source === adapter && t.external.id === draft.external.id)){ skipped++; continue; }
    const bid = cfg.targetBoard && boardOf(cfg.targetBoard) ? cfg.targetBoard : primaryBoard();
    const st = Tools.stageIdByKey(boardOf(bid), cfg.targetColumn || 'consider') || firstOpenStage(bid);
    const t = newTask(Object.assign(draft, { boardId: bid, status: st, source: adapter, order: nextOrder(st) }));
    if (st === 'scheduled') t.scheduledFlow = true;
    logTask(t, `Created from ${ad.name} message`); S.tasks.push(t); added++;
  }
  if (added){ runAutomation(); save(); render(); }
  return { added, skipped };
}
/* ---------- drag an email in from Outlook onto a task ---------- */
const dmCfg = () => Object.assign({ as:'subtask' }, S.settings.integrations.dropMail);
function mailTarget(e){
  if (e.target.closest && e.target.closest('input,textarea,select,[contenteditable]')) return null;
  const el = e.target.closest && e.target.closest('[data-act="open-task"][data-id]');
  if (el && !(ui.modal && ui.modal.type === 'task' && e.target.closest('.m-panel'))) return { id: el.dataset.id, el };
  if (ui.modal && ui.modal.type === 'task' && e.target.closest && e.target.closest('.m-panel')) return { id: ui.modal.draft.id, el: e.target.closest('.m-panel'), modal: true };
  return null;
}
function addMailsTo(t, mails){
  const as = dmCfg().as === 'note' ? 'note' : 'subtask', me = S.settings.me || 'You', MF = CoS.mailfile;
  let added = 0, dups = 0;
  for (const m of mails){
    const key = m.id || (m.subject + '|' + m.date);
    if (as === 'subtask'){
      if (t.subitems.some(x => x.mail === key)){ dups++; continue; }
      t.subitems.push({ id: uid(), title: MF.subtaskTitle(m), done: true, taskId: null, stick: false, mail: key });
    } else {
      if (t.comments.some(x => x.mail === key)){ dups++; continue; }
      t.comments.push({ id: uid(), at: nowISO(), by: me, text: MF.noteText(m), mail: key });
    }
    logTask(t, `Email "${clipStr(m.subject, 60)}" added as ${as === 'subtask' ? 'a completed subtask' : 'a note'}`); added++;
  }
  return { added, dups, as };
}
const clipStr = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
async function dropMails(tgt, files, text, parts){
  const mails = []; let bad = 0;
  for (const f of files){
    if (f.size > 30e6){ bad++; continue; }
    try{ const m = CoS.mailfile.parse(f.name, new Uint8Array(await f.arrayBuffer())); if (m) mails.push(m); else { bad++; ui.lastDrop += ' | ' + f.name + ': not recognised as an email'; } }catch(e){ bad++; ui.lastDrop += ' | ' + f.name + ': ' + (e && e.message); }
  }
  if (!files.length && parts){ let m = null; try{ m = CoS.mailfile.fromParts(parts); }catch(e){} if (m) mails.push(m); }
  if (!files.length && !mails.length && text){ const m = CoS.mailfile.fromText(text); if (m) mails.push(m); }
  if (!mails.length){ toast((files.length ? 'That file is not an email I can read. ' : 'Nothing readable came across from that drag. ') + 'Open Settings, Email to see exactly what arrived, and send it to the developer.', null, 15000); return; }
  let t = tgt.modal ? (ui.modal && ui.modal.type === 'task' ? ui.modal.draft : null) : T(tgt.id);
  if (!t){ toast('That task is no longer there.'); return; }
  const r = addMailsTo(t, mails);
  if (r.added){
    if (tgt.modal) commitAndRefresh(); else { t.updated = nowISO(); runAutomation(); save(); render(); }
  }
  const word = r.as === 'subtask' ? (r.added === 1 ? 'a completed subtask' : 'completed subtasks') : (r.added === 1 ? 'a note' : 'notes');
  toast((r.added ? `Added ${r.added === 1 ? 'the email' : r.added + ' emails'} to "${clipStr(t.title || 'this task', 40)}" as ${word}.` : 'That email is already on this task.') + (bad ? ` ${bad} file${bad > 1 ? 's' : ''} could not be read.` : ''));
}
let mailHot = null;
const hotMail = el => { if (mailHot === el) return; if (mailHot) mailHot.classList.remove('mail-hot'); mailHot = el; if (el) el.classList.add('mail-hot'); };
const dragHasMail = e => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).length);   // Outlook may offer only its own formats, so accept any outside drag
document.addEventListener('dragover', e => {
  if (!dragHasMail(e) || ui.dragging) return;
  const tgt = mailTarget(e); if (e.dataTransfer.types.includes('Files') || tgt) e.preventDefault();   // never let a dropped file navigate the window
  if (tgt){ e.dataTransfer.dropEffect = 'copy'; hotMail(tgt.el); } else hotMail(null);
});
document.addEventListener('dragleave', e => { if (!e.relatedTarget) hotMail(null); });
document.addEventListener('drop', e => {
  if (!dragHasMail(e) || ui.dragging) return;
  const isFile = e.dataTransfer.types.includes('Files'), tgt = mailTarget(e); hotMail(null);
  if (!tgt){ if (isFile){ e.preventDefault(); ui.lastDrop = `dropped outside any task; types=[${Array.from(e.dataTransfer.types).join(', ')}]`; toast('Drop the email onto a task to add it.'); } return; }
  e.preventDefault();
  const dt = e.dataTransfer, files = Array.from(dt.files || []);   // read now: the browser empties these after this handler
  const text = dt.getData('text/plain') || '', html = dt.getData('text/html') || '', uri = dt.getData('text/uri-list') || '';
  const items = Array.from(dt.items || []).map(i => `${i.kind}:${i.type || '?'}`);
  const parts = {}; for (const ty of Array.from(dt.types)){ if (ty === 'Files' || /^text\/(plain|html|uri-list)$/.test(ty) || ty === 'chromium/x-drag-id') continue; try{ const v = dt.getData(ty); if (v) parts[ty] = v; }catch(e){} }
  const partsDump = Object.entries(parts).map(([k, v]) => `${k}(${v.length}): ${v.slice(0, 900).replace(/\s+/g, ' ')}`).join(' || ');
  ui.lastDrop = `types=[${Array.from(dt.types).join(', ')}] files=[${files.map(f => f.name + ' ' + f.size + 'B').join('; ')}] items=[${items.join(', ')}] text=${text.length} chars html=${html.length} chars uri=${uri.slice(0, 80)} parts=${partsDump || 'none'}`;
  dropMails(tgt, files, text || (html ? CoS.mailfile.htmlToText(html) : '') || uri, parts);
});

/* ---------- Android: tell the person when a newer APK is on GitHub (a sideloaded app cannot update itself) ---------- */
const APK_URL = 'https://github.com/sozumen/Cursus-CoS/releases/download/android/Cursus-CoS.apk';
async function checkAppUpdate(manual){
  if (Host.platform !== 'android') return;
  try{
    const info = await Host.info(), mine = +info.build || 0;
    const r = await Host.http({ url: 'https://api.github.com/repos/sozumen/Cursus-CoS/releases/tags/android', method: 'GET', headers: { Accept: 'application/vnd.github+json' } });
    if (r.status !== 200){ if (manual) toast('Could not check for a new version right now.'); return; }
    const n = +((/Android build:\s*(\d+)/.exec((JSON.parse(r.text) || {}).body || '') || [])[1]) || 0;
    if (n > mine) toast(`A newer version of the app is ready (build ${n}, you have ${mine}).`, { label:'Download', fn:() => Host.openExternal(APK_URL) }, 20000);
    else if (manual) toast('You have the latest version.', null, 3000);
  }catch(e){ if (manual) toast('Could not check for a new version right now.'); }
}

/* ---------- Gmail: email in, as tasks and subtasks ---------- */
const GM = CoS.gmailLib.create({ http: r => Host.http(r), kv: { get: k => Host.kv.get(k), set: (k, v) => Host.kv.set(k, v), remove: k => Host.kv.remove(k) }, loopback: Host.loopback, openExternal: u => Host.openExternal(u) });
const gmCfg = () => S.settings.integrations.gmail;
function ingestGmail(msgs, own){
  const c = gmCfg(), ad = CoS.ingest.adapters.gmail, out = { tasks:0, subs:0, done:0, skipped:0, notes:[] };
  for (const m of msgs){
    const open = S.tasks.filter(t => !t.archived && !isDone(t));
    const p = ad.planGmail(m, open, c, own);
    if (p.action === 'skip'){ out.skipped++; continue; }
    if (p.action === 'task'){
      if (S.tasks.some(t => t.external && t.external.source === 'gmail' && t.external.id === p.draft.external.id)){ out.skipped++; continue; }
      const bid = c.targetBoard && boardOf(c.targetBoard) ? c.targetBoard : primaryBoard();
      const st = Tools.stageIdByKey(boardOf(bid), c.targetColumn || 'consider') || firstOpenStage(bid);
      const t = newTask(Object.assign(p.draft, { boardId: bid, status: st, source: 'gmail', order: nextOrder(st) }));
      if (st === 'scheduled') t.scheduledFlow = true;
      logTask(t, 'Created from a Gmail message'); if (p.note){ logTask(t, p.note); out.notes.push(p.note); }
      S.tasks.push(t); out.tasks++; continue;
    }
    const sid = 'gm_' + m.id, par = p.parent;
    if (S.tasks.some(t => t.subitems.some(x => x.id === sid))){ out.skipped++; continue; }
    const same = CoS.ingest.norm(p.title), found = p.done ? par.subitems.find(x => !x.taskId && !x.done && CoS.ingest.norm(x.title) === same) : null;
    if (found){ found.done = true; logTask(par, `Subtask "${found.title}" ticked off from an email`); out.done++; }
    else { par.subitems.push({ id: sid, title: p.title, done: p.done, taskId: null, stick: false }); logTask(par, `Subtask "${p.title}" added from an email`); out.subs++; }
    par.updated = nowISO();
  }
  if (out.tasks || out.subs || out.done){ runAutomation(); save(); render(); }
  return out;
}
async function gmailPoll(manual){
  const c = gmCfg(); if (!Host.loopback || !c.enabled || ui.gm.busy) return;
  const st = await GM.status(); ui.gm.status = st;
  if (!st.signedIn){ if (manual) toast('Sign in to Gmail first.'); return; }
  ui.gm.busy = true; gmRefresh();
  try{
    const seen = new Set(c.seen || []);
    for (const t of S.tasks){ if (t.external && t.external.source === 'gmail') seen.add(t.external.id); for (const x of t.subitems || []) if (/^gm_/.test(x.id)) seen.add(x.id.slice(3)); }
    const r = await GM.fetchRecent({ days: c.days, skip: seen });
    const res = ingestGmail(r.messages, st.email);
    c.seen = [...new Set([...(c.seen || []), ...r.messages.map(m => m.id)])].slice(-500);
    c.last = nowISO(); c.error = '';
    const bits = [res.tasks && `${res.tasks} new task${res.tasks > 1 ? 's' : ''}`, res.subs && `${res.subs} subtask${res.subs > 1 ? 's' : ''} added`, res.done && `${res.done} subtask${res.done > 1 ? 's' : ''} ticked off`].filter(Boolean);
    if (bits.length) toast('Gmail: ' + bits.join(', ') + '.', null, 6000);
    else if (manual) toast(r.messages.length ? 'Checked Gmail: nothing new that matches.' : 'Checked Gmail: no new tagged messages.', null, 3500);
    for (const n of res.notes.slice(0, 2)) toast(n, null, 7000);
  }catch(e){
    c.error = String((e && e.message) || e);
    if (e && e.auth) ui.gm.status = await GM.status();
    if (manual) toast(c.error, null, 8000);
  }
  ui.gm.busy = false; save(); gmRefresh();
}
function gmRefresh(){ if (ui.modal && ui.modal.type === 'settings' && ui.settingsTab === 'integrations') renderModal(); }
function dropMailCardHTML(){
  const c = dmCfg();
  return `<div class="card-box"><div class="flex items-center gap-3"><span style="width:38px;height:38px;border-radius:10px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center">${ic('mail-plus', 'w-5 h-5')}</span><div style="flex:1"><b style="font-weight:650">Drag an email onto a task</b><p class="note">In Outlook, drag a message onto a card, a row or an open task. It is saved there as:</p></div></div>
    <div class="field-row"><span>Saved as</span><select class="inp" style="width:230px" data-set="integrations.dropMail.as" data-type="str"><option value="subtask" ${c.as !== 'note' ? 'selected' : ''}>A completed subtask</option><option value="note" ${c.as === 'note' ? 'selected' : ''}>A note (comment) with the message text</option></select></div>
    ${ui.lastDrop ? `<p class="note mono" style="margin-top:8px;word-break:break-all;user-select:text">Last drop received: ${esc(ui.lastDrop)}</p>` : ''}
    <p class="note" style="margin-top:6px">The same email dropped twice is added once. Works with the Outlook desktop app; if a drop is not recognised, tell me what Outlook version you use.</p></div>`;
}
function gmailCardHTML(){
  const c = gmCfg(), g = ui.gm, st = g.status, desk = !!Host.loopback;
  if (!st && desk) GM.status().then(x => { ui.gm.status = x; gmRefresh(); });
  const head = `<div class="flex items-center gap-3"><span style="width:38px;height:38px;border-radius:10px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center">${ic('mail', 'w-5 h-5')}</span><div style="flex:1"><b style="font-weight:650">Gmail</b><p class="note">Email yourself a task, or a subtask on an existing one. Read-only: the app can never send, change or delete mail.</p></div><span class="pill" style="font-size:12px;padding:3px 9px;border-radius:99px;background:var(--surface-3)">${st && st.signedIn ? 'Connected' : 'Not connected'}</span></div>`;
  if (!desk) return `<div class="card-box">${head}<p class="note" style="margin-top:10px">Gmail connects in the Windows app (Google only lets a program running on your own computer sign in this way). Tasks it creates sync to this device through OneDrive like everything else.</p></div>`;
  const err = g.msg ? `<p class="note" style="color:var(--danger);margin-top:8px" role="alert">${esc(g.msg)}</p>` : '';
  const sels = `<div class="field-row"><span>Target board</span><select class="inp" style="width:190px" data-set="integrations.gmail.targetBoard" data-type="str"><option value="">First selected board</option>${S.boards.map(b => `<option value="${b.id}" ${c.targetBoard === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
      <div class="field-row"><span>New tasks land in column</span><select class="inp" style="width:190px" data-set="integrations.gmail.targetColumn" data-type="str">${Tools.unionStages(S.boards).map(x => `<option value="${x.key}" ${c.targetColumn === x.key ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="field-row"><div style="min-width:0"><span>Also accept mail from</span><p class="note">Your own address is always accepted. Add others, separated by commas.</p></div><input class="inp" style="width:230px" data-set="integrations.gmail.allowFrom" data-type="str" value="${esc(c.allowFrom || '')}" placeholder="partner@example.com" autocomplete="off" spellcheck="false"></div>
      <div class="field-row"><span>Look back</span><span class="flex items-center gap-2">${`<input type="number" class="inp" style="width:70px" min="1" max="60" data-set="integrations.gmail.days" data-type="num" value="${c.days || 7}">`}<span class="note">days</span></span></div>`;
  const how = `<div class="card-box" style="margin-top:10px;background:var(--surface-3)"><b style="font-weight:650">How to write the email</b>
      <p class="note" style="margin-top:4px">Put a tag in the subject (or on the first line of the body):</p>
      <ul class="note" style="margin:4px 0 0 18px;list-style:disc;line-height:1.7"><li><span class="mono">Order printer paper #task</span> makes a new task.</li><li><span class="mono">#sub Quarterly review: send invoice</span> adds an unfinished subtask to the task whose title is before the colon.</li><li><span class="mono">#subdone Quarterly review: send invoice</span> adds it already finished, or ticks it off if it is already there.</li><li>Replying inside the thread of a task that came from email needs no "Quarterly review:" part.</li></ul></div>`;
  if (st && st.signedIn) return `<div class="card-box">${head}
      <div class="field-row" style="margin-top:8px"><span style="min-width:0"><b style="font-weight:650">Signed in to Gmail</b><br><span class="note">${esc(st.email || 'Google account')}</span></span><span class="flex gap-2"><button class="btn btn-sm" data-act="gm-check" ${g.busy ? 'disabled' : ''}>${ic('rotate-ccw', 'w-3.5 h-3.5')}${g.busy ? 'Checking…' : 'Check now'}</button><button class="btn btn-sm" data-act="gm-signout">Sign out</button></span></div>
      <div class="field-row"><div><b style="font-weight:650">Read my mail for tagged messages</b><p class="note">Checks every 5 minutes while the app is open. ${c.last ? 'Last check ' + esc(timeAgo(c.last)) + '.' : ''}</p></div>${sw('integrations.gmail.enabled', c.enabled, 'Read Gmail')}</div>
      ${c.error ? `<p class="note" style="color:var(--danger)" role="alert">${esc(c.error)}</p>` : ''}${sels}${how}</div>`;
  return `<div class="card-box">${head}
      <label class="lbl" for="gmClient" style="margin-top:10px">Client ID</label><input id="gmClient" class="inp mono" value="${esc(c.clientId || '')}" data-gm="clientId" placeholder="1234567890-abc123.apps.googleusercontent.com" autocomplete="off" spellcheck="false">
      <label class="lbl" for="gmSecret" style="margin-top:10px">Client secret</label><input id="gmSecret" class="inp mono" type="password" data-gm="secret" value="${esc(g.secret || '')}" placeholder="GOCSPX-…" autocomplete="off" spellcheck="false">
      <div class="flex gap-2 items-center" style="margin-top:10px"><button class="btn btn-primary" data-act="gm-signin" ${g.phase === 'waiting' ? 'disabled' : ''}>${ic('user-plus')}${g.phase === 'waiting' ? 'Waiting for Google…' : 'Sign in with Google'}</button>${g.phase === 'waiting' ? `<button class="btn btn-ghost" data-act="gm-cancel">Cancel</button>` : ''}</div>${err}
      <details style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">Where do I get the client ID and secret? (one-time, about 10 minutes)</summary>
        <ol class="note" style="margin:8px 0 0 22px;line-height:1.7;list-style:decimal">
          <li>Go to <b>console.cloud.google.com</b> and sign in with the Gmail account. Create a project (any name, such as Cursus).</li>
          <li><b>APIs &amp; Services → Library</b> → search <b>Gmail API</b> → <b>Enable</b>.</li>
          <li><b>APIs &amp; Services → OAuth consent screen</b> (called <b>Google Auth Platform</b> in newer consoles) → set it up: app name Cursus CoS, your email, audience <b>External</b>. Under <b>Data access</b> add the scope <span class="mono">.../auth/gmail.readonly</span>. Under <b>Audience</b> add your Gmail address as a test user, then press <b>Publish app</b> (In production) so the sign-in does not expire every 7 days. Google will warn that the app is unverified: that is fine for your own use.</li>
          <li><b>Credentials → Create credentials → OAuth client ID</b> → type <b>Desktop app</b> → Create. Copy the <b>Client ID</b> and <b>Client secret</b> into the boxes above.</li>
          <li>Press Sign in. On the Google page choose <b>Advanced → Go to Cursus CoS (unsafe)</b>, then allow read access to your email.</li></ol>
        <p class="note" style="margin-top:6px">The client ID and secret stay on this computer. The secret of a desktop-app client is not confidential, but do not share it.</p></details></div>`;
}
const sampleMail = () => CoS.ingest.sampleMail(addDays, todayStr);
CoS.api = { dropTo, changeBoard, ingestEmails, ingestGmail, gmailPoll, get state(){ return S; }, ui, render, runAutomation, openTask, syncNow: () => syncNow(true), sampleMail };

/* ---------- drag engine (mouse + touch) ---------- */
const DG = { p:null, on:false, ghost:null, ph:null, src:null, x:0, y:0, raf:0, hot:null, target:null, timer:0, justDropped:false, off:{ x:0, y:0 } };
document.addEventListener('pointerdown', e => {
  if (DG.on) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const el = e.target.closest && e.target.closest('[data-drag]');
  if (!el || e.target.closest('button,input,select,textarea,a,[data-nodrag]')) return;
  DG.p = { el, id:el.dataset.id, kind:el.dataset.drag, chip:el.dataset.chip || '', x:e.clientX, y:e.clientY, type:e.pointerType };
  DG.x = e.clientX; DG.y = e.clientY;
  clearTimeout(DG.timer);
  if (e.pointerType !== 'mouse') DG.timer = setTimeout(() => { if (DG.p && !DG.on) dgActivate(); }, 260);
});
document.addEventListener('pointermove', e => {
  DG.x = e.clientX; DG.y = e.clientY;
  if (DG.p && !DG.on){
    const dist = Math.hypot(e.clientX - DG.p.x, e.clientY - DG.p.y);
    if (DG.p.type === 'mouse'){ if (dist > 5) dgActivate(); }
    else if (dist > 10){ clearTimeout(DG.timer); DG.p = null; }
  } else if (DG.on) dgMove();
}, { passive:true });
document.addEventListener('pointerup', () => { clearTimeout(DG.timer); if (DG.on) dgDrop(); DG.p = null; });
document.addEventListener('pointercancel', () => { clearTimeout(DG.timer); if (DG.on) dgCleanup(); DG.p = null; });
document.addEventListener('touchmove', e => { if (DG.on && e.cancelable) e.preventDefault(); }, { passive:false });
function dgActivate(){
  const p = DG.p; if (!p || !document.body.contains(p.el)) return;
  DG.on = true; ui.dragging = true;
  const el = p.el, r = el.getBoundingClientRect();
  DG.src = el; DG.off = { x: p.x - r.left, y: p.y - r.top };
  const g = el.cloneNode(true); g.removeAttribute('data-act'); g.removeAttribute('data-drag'); g.removeAttribute('tabindex'); g.classList.add('ghost');
  g.style.width = r.width + 'px'; g.style.left = r.left + 'px'; g.style.top = r.top + 'px';
  document.body.appendChild(g); DG.ghost = g;
  if (p.kind === 'card'){
    const ph = document.createElement('div'); ph.className = 'ph'; ph.style.height = r.height + 'px';
    el.parentNode.insertBefore(ph, el); el.style.display = 'none'; DG.ph = ph;
  } else el.classList.add('drag-src');
  document.body.classList.add('dragging');
  try{ if (navigator.vibrate) navigator.vibrate(8); }catch(e){}
  dgLoop(); dgMove();
}
function dgHot(el){ if (DG.hot === el) return; if (DG.hot) DG.hot.classList.remove('drop-hot'); DG.hot = el; if (el) el.classList.add('drop-hot'); }
function dgMove(){
  const g = DG.ghost; if (!g) return;
  g.style.left = (DG.x - DG.off.x) + 'px'; g.style.top = (DG.y - DG.off.y) + 'px';
  const els = document.elementsFromPoint(DG.x, DG.y);
  if (DG.p.kind === 'card'){
    const sb = els.map(e => e.closest && e.closest('[data-drop-board]')).find(Boolean);
    if (sb){ dgHot(sb); DG.target = { board: sb.dataset.dropBoard }; return; }
    const col = els.map(e => e.closest && e.closest('.col')).find(Boolean);
    if (!col || col.dataset.drop === '0'){ dgHot(null); DG.target = null; return; }
    dgHot(col); DG.target = { gid: col.dataset.gid, lane: col.dataset.lane || '' };
    const body = $('.col-body', col);
    const cards = [...body.querySelectorAll(':scope > .card')].filter(c => c !== DG.src);
    let before = null;
    for (const c of cards){ const rr = c.getBoundingClientRect(); if (DG.y < rr.top + rr.height / 2){ before = c; break; } }
    if (before){ if (before.previousElementSibling !== DG.ph) body.insertBefore(DG.ph, before); }
    else if (body.lastElementChild !== DG.ph) body.appendChild(DG.ph);
  } else {
    const day = els.map(e => e.closest && e.closest('.cal-day')).find(Boolean);
    dgHot(day || null); DG.target = day ? { date: day.dataset.date } : null;
  }
}
function dgLoop(){
  if (!DG.on) return;
  if (DG.p && DG.p.kind === 'card'){
    const bs = $('#boardScroll');
    if (bs){
      /* Scroll sideways while a card is held near either edge of the board; the closer to the edge, the faster. */
      const r = bs.getBoundingClientRect(), edge = 80;
      if (DG.x < r.left + edge) bs.scrollLeft -= Math.round(6 + 22 * Math.min(1, (r.left + edge - DG.x) / edge));
      else if (DG.x > r.right - edge) bs.scrollLeft += Math.round(6 + 22 * Math.min(1, (DG.x - (r.right - edge)) / edge));
      const body = DG.hot && DG.hot.classList.contains('col') ? $('.col-body', DG.hot) : null;
      if (body){ const cr = body.getBoundingClientRect(); if (DG.y < cr.top + 44) body.scrollTop -= 12; else if (DG.y > cr.bottom - 44) body.scrollTop += 12; }
      dgMove();
    }
  }
  DG.raf = requestAnimationFrame(dgLoop);
}
function dgCleanup(){
  cancelAnimationFrame(DG.raf);
  if (DG.ghost) DG.ghost.remove();
  if (DG.ph) DG.ph.remove();
  if (DG.src){ DG.src.style.display = ''; DG.src.classList.remove('drag-src'); }
  if (DG.hot) DG.hot.classList.remove('drop-hot');
  document.body.classList.remove('dragging');
  DG.on = false; DG.ghost = DG.ph = DG.src = DG.hot = null; ui.dragging = false;
  if (ui.pending){ ui.pending = false; render(); }
}
function dgDrop(){
  const kind = DG.p.kind, id = DG.p.id, tgt = DG.target, ph = DG.ph, chip = DG.p.chip;
  let order = null, pin = null;
  if (kind === 'card' && tgt && tgt.gid !== undefined && ph && ph.parentNode){
    pin = [...ph.parentNode.children].filter(n => n === ph || (n.classList.contains('card') && n !== DG.src)).indexOf(ph);
    const sib = (n, dir) => { while ((n = dir < 0 ? n.previousElementSibling : n.nextElementSibling)){ if (n.classList.contains('card') && n !== DG.src) return n; } return null; };
    const prev = sib(ph, -1), next = sib(ph, 1);
    const a = prev ? T(prev.dataset.id).order : null, b = next ? T(next.dataset.id).order : null;
    order = a == null && b == null ? 0 : a == null ? b - 10 : b == null ? a + 10 : (a + b) / 2;
  }
  dgCleanup();
  DG.justDropped = true; setTimeout(() => { DG.justDropped = false; }, 80);
  if (kind === 'card'){
    if (tgt && tgt.board) changeBoard(id, tgt.board);
    else if (tgt && tgt.gid !== undefined) dropTo(id, tgt.gid, tgt.lane, order, pin);
    else render();
  } else if (tgt && tgt.date) setTaskDate(id, chip === 'start' ? 'start' : 'due', tgt.date);
  else render();
}

/* ---------- events ---------- */
const ACTIONS = {
  'side-open'(){ ui.sideOpen = true; render(); },
  'side-close'(){ ui.sideOpen = false; render(); },
  view(el){ selectView(el.dataset.v); },
  'new-task'(){ if (S.settings.filters.archived){ S.settings.filters.archived = false; save(); render(); } const v = S.settings.view; openTask(null, v === 'calendar' ? { due: ui.calSel } : {}); },
  'open-task'(el){
    if (ui.pop) closePop();
    if (taskSaveable()){ commitDraft(); render(); }
    openTask(el.dataset.id);
  },
  'close-modal'(){ closeTopModal(); },
  'paste-open'(){ openPaste(); },
  'paste-subs'(){ ui.modal.subs = !ui.modal.subs; renderModal(); },
  'paste-clip'(){
    const m = ui.modal;
    try{ navigator.clipboard.readText().then(t => { if (ui.modal !== m) return; m.text = (m.text ? m.text.replace(/\s*$/, '\n') : '') + t; renderModal(); }, () => toast('The clipboard could not be read here. Paste into the box with Ctrl/⌘ + V.', null, 5000)); }
    catch(e){ toast('The clipboard could not be read here. Paste into the box with Ctrl/⌘ + V.', null, 5000); }
  },
  'paste-add'(){ addPastedTasks(); },
  'fu-chip'(el){ ui.modal.date = addDays(todayStr(), +el.dataset.days); renderModal(); },
  'fu-skip'(){ closeModal(); },
  'review-open'(){ openReview(); },
  'rv-close'(){ closeModal(); },
  'rv-move'(el){ reviewMove(el.dataset.id); afterReview(); },
  'rv-keep'(el){ reviewKeep(el.dataset.id); afterReview(); },
  'rv-move-all'(){ for (const t of pendingReviews()) reviewMove(t.id); afterReview(); },
  'fu-save'(){ const m = ui.modal; if (!m.date){ toast('Choose a date first.', null, 3000); return; } const { id, name, date, time } = m; closeModal(); createFollowUp(id, name, date, time); },
  'cancel-task'(){ closeModal(); },
  'quick-open'(el){ ui.quick = el.dataset.gid + '|' + (el.dataset.lane || ''); ui.quickFocus = ui.quick; render(); },
  sort(el){ const k = el.dataset.k; ui.sort = { key:k, dir: ui.sort.key === k ? -ui.sort.dir : 1 }; renderContent(); },
  'cal-prev'(){ const [y, m] = ui.cal.split('-').map(Number); const d = new Date(y, m - 2, 1); ui.cal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; renderContent(); },
  'cal-next'(){ const [y, m] = ui.cal.split('-').map(Number); const d = new Date(y, m, 1); ui.cal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; renderContent(); },
  'cal-today'(){ ui.cal = todayStr().slice(0, 7); ui.calSel = todayStr(); renderContent(); },
  'cal-sel'(el){ ui.calSel = el.dataset.date; renderContent(); },
  'cal-starts'(){ S.settings.calStarts = !S.settings.calStarts; save(); renderContent(); },
  'pop-filter'(el){ openPop('filter', el); },
  'pop-color'(el){ openPop('color', el); },
  'pop-bell'(el){ openPop('bell', el); },
  'f-toggle'(el){ const f = S.settings.filters, a = f[el.dataset.k], v = el.dataset.v; const i = a.indexOf(v); i >= 0 ? a.splice(i, 1) : a.push(v); save(); render(); },
  'f-due'(el){ S.settings.filters.due = el.dataset.v; save(); render(); },
  'f-flag'(el){ const f = S.settings.filters; f[el.dataset.k] = !f[el.dataset.k]; save(); render(); },
  'f-clear'(){ S.settings.filters = emptyFilters(); save(); render(); },
  'color-by'(el){ S.settings.colorBy = el.dataset.v; save(); render(); },
  'board-all'(){ S.settings.boardsSel = S.boards.map(b => b.id); save(); ui.sideOpen = false; render(); },
  'board-only'(el){ S.settings.boardsSel = [el.dataset.id]; save(); ui.sideOpen = false; render(); },
  'board-toggle'(el){ const sel = selIds(), id = el.dataset.id; if (sel.has(id)){ if (sel.size > 1) sel.delete(id); } else sel.add(id); S.settings.boardsSel = [...sel]; save(); render(); },
  'board-new'(){ openEntity('board'); },
  'board-edit'(el){ openBoardSettings(el.dataset.id); },
  'board-colors'(){ openBoardSettings(primaryBoard(), 'colors'); },
  'sv-new'(){ openSavedView(''); },
  'sv-edit'(el){ openSavedView(el.dataset.id); },
  'sv-apply'(el){ applySavedView(el.dataset.id); },
  'sv-type'(el){ ui.modal.name = ($('#svName') || {}).value || ui.modal.name; ui.modal.vtype = el.dataset.v; renderModal(); },
  'sv-hue'(el){ ui.modal.name = ($('#svName') || {}).value || ui.modal.name; ui.modal.h = +el.dataset.h; renderModal(); },
  'sv-b'(el){ const m = ui.modal, i = m.boards.indexOf(el.dataset.id); m.name = ($('#svName') || {}).value || m.name; if (i >= 0) m.boards.splice(i, 1); else m.boards.push(el.dataset.id); renderModal(); },
  'sv-p'(el){ const m = ui.modal, i = m.projects.indexOf(el.dataset.id); m.name = ($('#svName') || {}).value || m.name; if (i >= 0) m.projects.splice(i, 1); else m.projects.push(el.dataset.id); renderModal(); },
  'sv-current'(){ const m = ui.modal; m.name = ($('#svName') || {}).value || m.name; m.vtype = activeView().type; m.boards = S.boards.length === selIds().size ? [] : [...selIds()]; m.projects = S.settings.filters.projects.slice(); renderModal(); },
  'sv-save'(){
    const m = ui.modal, name = (($('#svName') || {}).value || '').trim(); if (!name){ toast('Give the view a name first.'); return; }
    S.savedViews = S.savedViews || [];
    const rec = normSavedView({ id: m.id || uid(), name, type: m.vtype, boards: m.boards.filter(i => boardOf(i)), projects: m.projects.filter(i => projOf(i)), h: m.h });
    const i = S.savedViews.findIndex(x => x.id === rec.id);
    if (i >= 0) S.savedViews[i] = rec; else S.savedViews.push(rec);
    save(); closeModal(); render();
    toast(`Saved the view "${name}".`, null, 2500);
  },
  async 'sv-del'(){
    const m = ui.modal, v = (S.savedViews || []).find(x => x.id === m.id); if (!v) return;
    if (!await confirmBox({ title:`Delete the view "${v.name}"?`, body:'Your boards, projects and tasks are not touched.', ok:'Delete view', danger:true })) return;
    S.savedViews = S.savedViews.filter(x => x.id !== v.id); tombstone('savedView', v.id);
    save(); closeModal(); render();
  },
  'proj-new'(){ openEntity('project'); },
  'proj-edit'(el){ openEntity('project', el.dataset.id); },
  'proj-filter'(el){ ACTIONS['f-toggle']({ dataset:{ k:'projects', v:el.dataset.id } }); },
  'ent-hue'(el){ ui.modal.h = +el.dataset.h; ui.modal.name = $('#entName').value; renderModal(); },
  'ent-save'(){
    const m = ui.modal, name = $('#entName').value.trim(); if (!name){ toast('Give it a name first.'); return; }
    if (m.kind === 'board'){ if (m.id){ const b = boardOf(m.id); b.name = name; b.h = m.h; } else { const b = newBoard({ name, h:m.h }); S.boards.push(b); S.settings.boardsSel = [b.id]; S.sample = S.sample; } }
    else { if (m.id){ const p = projOf(m.id); p.name = name; p.h = m.h; } else S.projects.push({ id:uid(), name, h:m.h }); }
    save(); closeModal(); render();
  },
  async 'ent-del'(){
    const m = ui.modal;
    if (m.kind === 'board'){
      if (S.boards.length < 2){ toast('Keep at least one board.'); return; }
      const n = S.tasks.filter(t => t.boardId === m.id).length;
      if (!await confirmBox({ title:`Delete "${boardName(m.id)}"?`, body:`${n} task${n === 1 ? '' : 's'} on this board will be deleted too. This cannot be undone.`, ok:'Delete board', danger:true })) return;
      const ids = new Set(S.tasks.filter(t => t.boardId === m.id).map(t => t.id));
      S.tasks = S.tasks.filter(t => !ids.has(t.id)); S.tasks.forEach(t => { t.deps = t.deps.filter(d => !ids.has(d)); t.subitems.forEach(s => { if (ids.has(s.taskId)) s.taskId = null; }); if (ids.has(t.parentId)) t.parentId = null; });
      S.boards = S.boards.filter(b => b.id !== m.id); S.settings.boardsSel = S.settings.boardsSel.filter(i => i !== m.id);
      ids.forEach(i => tombstone('task', i)); tombstone('board', m.id);
    } else {
      if (!await confirmBox({ title:`Delete "${projName(m.id)}"?`, body:'Tasks stay on their boards and simply lose the project.', ok:'Delete project', danger:true })) return;
      S.tasks.forEach(t => { if (t.projectId === m.id) t.projectId = null; }); S.projects = S.projects.filter(p => p.id !== m.id); tombstone('project', m.id);
      S.settings.filters.projects = S.settings.filters.projects.filter(i => i !== m.id);
    }
    save(); closeModal(); render();
  },
  'clear-sample': async () => {
    if (!await confirmBox({ title:'Clear the sample data?', body:'Sample boards, projects and tasks are removed and you get one empty board. Your own edits to sample items go with them.', ok:'Clear sample data', danger:true })) return;
    resetToEmpty(); toast('Sample data cleared. Add your first task with New task.');
  },
  settings(){ closePop(); ui.settingsTab = 'appearance'; ui.modal = { type:'settings' }; renderModal(); if (!ui.info) Host.info().then(i => { ui.info = i; if (ui.modal && ui.modal.type === 'settings' && ui.settingsTab === 'data') renderModal(); }); },
  'set-tab'(el){ ui.settingsTab = el.dataset.v; renderModal(); },
  'set-theme'(el){ S.settings.theme = el.dataset.v; applyTheme(); save(); renderModal(); render(); },
  'theme-cycle'(){ const o = ['auto', 'light', 'dark']; S.settings.theme = o[(o.indexOf(S.settings.theme) + 1) % 3]; applyTheme(); save(); render(); toast(`Theme: ${{ auto:'match system', light:'light', dark:'dark' }[S.settings.theme]}`, null, 1800); },
  'bg-none'(){ S.settings.bg = { type:'none', value:'', dim:0 }; save(); applyBg(); renderModal(); },
  'bg-preset'(el){ S.settings.bg = { type:'preset', value:el.dataset.id, dim: S.settings.bg.dim || 0 }; save(); applyBg(); renderModal(); },
  'set-switch'(el){ const p = el.dataset.path; setPath(S.settings, p, !getPath(S.settings, p)); save(); renderModal(); if (p.startsWith('automation')){ runAutomation(); render(); } },
  'auto-run'(){ const n = runAutomation(); render(); if (!n) toast('Nothing to move right now.', null, 2500); },
  'mail-sample'(){ $('#mailJson').value = JSON.stringify(sampleMail(), null, 2); },
  'mail-import'(){
    const raw = $('#mailJson').value.trim(); if (!raw){ toast('Paste a message or load the sample first.'); return; }
    try{ const r = ingestEmails(JSON.parse(raw)); toast(`Imported ${r.added} task${r.added === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped}` : ''}.`); }
    catch(e){ toast('That is not valid JSON.'); }
  },
  'data-copy'(){
    const data = JSON.stringify(S);
    const fallback = () => { const ta = document.createElement('textarea'); ta.value = data; document.body.appendChild(ta); ta.select(); try{ document.execCommand('copy'); toast('Backup copied.'); }catch(e){ toast('Copy was blocked. Select the text in the Restore box instead.'); $('#restoreJson').value = data; } ta.remove(); };
    try{ navigator.clipboard.writeText(data).then(() => toast('Backup copied.'), fallback); }catch(e){ fallback(); }
  },
  async 'data-save'(){
    const r = await Host.saveFile({ name:`cursus-cos-backup-${todayStr()}.json`, text: JSON.stringify(S, null, 2), mime:'application/json' });
    toast(r.ok ? `Backup saved to ${r.where || 'your device'}.` : 'Saving a file is blocked here. Use Copy backup JSON instead.', null, 4500);
  },
  'toggle-proc'(el){
    const t = T(el.dataset.id); if (!t) return;
    t.inProcess = !t.inProcess; t.updated = nowISO(); logTask(t, t.inProcess ? 'Marked in process' : 'No longer in process');
    save(); render();
  },
  'col-sort'(el){
    const ids = (colIds[el.dataset.key] || []).slice(), items = ids.map(T).filter(Boolean);
    if (items.length < 2) return;
    const before = items.map(t => [t.id, t.order, t.pin]);
    const ranked = rankOrder(items.map(t => Object.assign({}, t, { pin:null })), todayStr()).map(x => T(x.id));
    ranked.forEach((t, i) => { t.order = (i + 1) * 10; t.pin = null; t.updated = nowISO(); });
    save(); render();
    toast(`Sorted ${items.length} tasks: most important and urgent first.`, { label:'Undo', fn:() => { for (const [id, o, p] of before){ const t = T(id); if (t){ t.order = o; t.pin = p; } } save(); render(); } }, 6000);
  },
  async 'gm-signin'(){
    const g = ui.gm, c = gmCfg(), id = ($('#gmClient') || {}).value || c.clientId || '', sec = ($('#gmSecret') || {}).value || '';
    c.clientId = id.trim(); g.secret = sec; g.msg = ''; g.phase = 'waiting'; renderModal();
    try{
      const res = await GM.signIn(id, sec);
      g.phase = 'idle'; g.secret = ''; g.status = { signedIn:true, email:res.email }; c.enabled = true; c.error = ''; save(); renderModal();
      toast('Signed in to Gmail.', null, 3000); gmailPoll(true);
    }catch(e){ g.phase = 'idle'; g.msg = String((e && e.message) || e); renderModal(); }
  },
  'gm-cancel'(){ try{ Host.loopback && Host.loopback.cancel(); }catch(e){} ui.gm.phase = 'idle'; renderModal(); },
  'gm-check'(){ gmailPoll(true); },
  async 'gm-signout'(){
    if (!await confirmBox({ title:'Sign out of Gmail?', body:'The app stops reading your mail. Tasks it already made are kept.', ok:'Sign out' })) return;
    await GM.signOut(); ui.gm.status = { signedIn:false }; gmCfg().enabled = false; save(); renderModal();
  },
  'app-update'(){ checkAppUpdate(true); },
  'sync-now'(){ syncNow(true); },
  async 'od-signin'(){
    const c = S.meta.sync, o = ui.od, id = ($('#odClient') || {}).value || c.clientId || '';
    c.clientId = id.trim(); persistMeta(); o.msg = ''; o.phase = 'starting'; renderModal();
    if (odWeb()){
      try{ persist(); await OD.beginRedirect(id, odRedirectUri()); }   // leaves the page; Microsoft sends the browser back here
      catch(e){ o.phase = 'idle'; o.msg = String((e && e.message) || e); renderModal(); }
      return;
    }
    try{
      const res = await OD.signIn(id, code => { o.phase = 'waiting'; o.code = code.userCode; o.uri = code.uri; renderModal(); Host.openExternal(code.uri); });
      o.phase = 'idle'; o.status = { signedIn:true, name:res.name }; c.error = ''; persistMeta(); renderModal(); renderSyncStatus();
      odWatch(); syncNow(true); toast('Signed in to OneDrive.', null, 3000);
    }catch(e){ if (e && e.cancelled){ o.phase = 'idle'; } else { o.phase = 'idle'; o.msg = String((e && e.message) || e); } renderModal(); }
  },
  'od-cancel'(){ OD.cancel(); ui.od.phase = 'idle'; renderModal(); },
  'od-uri'(){ copyText(odRedirectUri(), 'Address copied.'); },
  'od-link'(){ Host.openExternal(ui.od.uri || 'https://microsoft.com/link'); },
  'od-copy'(){ copyText(ui.od.code, 'Code copied.'); },
  async 'od-signout'(){
    if (!await confirmBox({ title:'Sign out of OneDrive?', body:'This device stops syncing. The file in OneDrive and the data on this device are both kept.', ok:'Sign out' })) return;
    OD.unwatch(); await OD.signOut(); ui.od.status = { signedIn:false }; ui.od.live = false; ui.od.msg = ''; renderModal(); renderSyncStatus();
  },
  'archive-task'(){
    const d = commitDraft(); if (!d) return;
    const id = d.id, was = !!T(id).archived;
    archiveTasks([id], !was); closeModal(); render();
    toast(was ? 'Restored from the archive.' : 'Archived. You can find it under Archive in the sidebar.', { label:'Undo', fn:() => { archiveTasks([id], was); render(); } }, 6000);
  },
  async 'archive-done'(){
    const ids = scope().filter(t => isDone(t)).map(t => t.id); if (!ids.length) return;
    if (!await confirmBox({ title:`Archive ${ids.length} done task${ids.length === 1 ? '' : 's'}?`, body:'They leave the board, calendar and reminders. Find them under Archive in the sidebar, where you can restore any of them.', ok:'Archive' })) return;
    archiveTasks(ids, true); render();
    toast(`Archived ${ids.length} task${ids.length === 1 ? '' : 's'}.`, { label:'Undo', fn:() => { archiveTasks(ids, false); render(); } }, 8000);
  },
  'table-more'(){ ui.tableLimit += 200; renderContent(); },
  'imp-toggle'(el){ const m = ui.modal; m[el.dataset.k] = !m[el.dataset.k]; renderModal(); },
  'imp-run'(){ runImport(); },
  async 'sync-choose'(){
    try{ const p = await Host.fileSync.choose(); if (p){ ui.syncPath = p; renderModal(); syncNow(true); } }
    catch(e){ toast('Could not use that file: ' + (e && e.message || e)); }
  },
  async 'data-restore'(){
    const raw = $('#restoreJson').value.replace(/^\uFEFF/, '').trim(); if (!raw){ toast('Paste a backup first.'); return; }
    let d; try{ d = JSON.parse(raw); }catch(e){ toast('That is not valid JSON.'); return; }
    if (!d || !Array.isArray(d.tasks) || !Array.isArray(d.boards)){ toast('That does not look like a Cursus CoS backup.'); return; }
    if (!await confirmBox({ title:'Replace current data?', body:`The backup has ${d.tasks.length} tasks on ${d.boards.length} boards. Your current data will be overwritten.`, ok:'Restore', danger:true })) return;
    const before = JSON.stringify(S);   // kept so a failed restore leaves everything as it was
    try{
      const hadSettings = !!d.settings; const n = normalize(d); replaceAll(n, { keepSettings: !hadSettings }); save(); applyTheme(); applyBg(); closeModal(); render(); toast('Backup restored.');
    }catch(e){
      try{ S = normalize(JSON.parse(before)); resetHashes(S, hashes); save(); applyTheme(); applyBg(); render(); }catch(e2){}
      window.__restoreErr = e && e.stack; Host.log('restore failed: ' + (e && e.stack || e));
      toast('That backup could not be restored (' + (e && e.message || 'unknown error') + '). Your data was left unchanged.', null, 8000);
    }
  },
  async 'data-sample'(){ if (!await confirmBox({ title:'Load sample data?', body:'This replaces everything with the sample boards.', ok:'Load sample', danger:true })) return; replaceAll(seed()); save(); runAutomation(); closeModal(); render(); },
  async 'data-erase'(){ if (!await confirmBox({ title:'Erase everything?', body:'All boards, projects and tasks are deleted from this browser.', ok:'Erase', danger:true })) return; resetToEmpty(); closeModal(); },
  'rem-dismiss'(el){ const t = T(el.dataset.id); const ft = fireTime(t, S.settings.reminderTime); if (t && ft){ t.reminder.ack = ft.toISOString(); save(); render(); checkReminders(); } },
  'rem-snooze'(el){
    const t = T(el.dataset.id); if (!t) return; const m = el.dataset.m; let at;
    if (m === 'tomorrow'){ at = new Date(); at.setDate(at.getDate() + 1); const [hh, mm] = S.settings.reminderTime.split(':').map(Number); at.setHours(hh, mm, 0, 0); } else at = new Date(Date.now() + (+m) * 60000);
    t.reminder.snoozedUntil = at.toISOString(); t.reminder.ack = null; t.reminder.notified = null; save(); render(); checkReminders();
  },
  async 'notif-enable'(){ await Host.ensureNotifyPermission(); renderPop(); pushReminders(); },
  /* task modal */
  'set-imp'(el){ setImp(ui.modal.draft, el.dataset.v); renderModal(); },
  'set-flag'(el){ ui.modal.draft.flag = el.dataset.v; renderModal(); },
  'toggle-lock'(){ const m = ui.modal; m.draft.locked = !m.draft.locked; m.lockTouched = true; renderModal(); },
  'tag-rm'(el){ const d = ui.modal.draft; d.tags = d.tags.filter(x => x !== el.dataset.v); renderModal(); },
  'sub-add'(){ const i = $('#subNew'), v = i.value.trim(); if (!v) return; ui.modal.draft.subitems.push({ id:uid(), title:v, done:false, taskId:null }); renderModal(); $('#subNew').focus(); },
  'sub-rm'(el){ ui.modal.draft.subitems.splice(+el.dataset.i, 1); renderModal(); },
  'sub-toggle'(el){
    const d = ui.modal.draft, s = d.subitems[+el.dataset.i], lt = s.taskId ? T(s.taskId) : null;
    if (lt){ if (s.stick){ s.stick = false; toast(`"${lt.title}" no longer sticks with its parent.`, null, 4000); } const done = isDone(lt); lt.status = done ? reopenStage(lt.boardId) : doneIdFor(lt.boardId); lt.locked = true; lt.updated = nowISO(); logTask(lt, done ? 'Reopened from parent subitem' : 'Completed from parent subitem'); save(); render(); }
    else s.done = !s.done;
    renderModal();
  },
  'sub-promote'(el){
    const m = ui.modal, d = m.draft, s = d.subitems[+el.dataset.i]; if (!s || s.taskId) return;
    if (!d.title.trim()) d.title = 'Untitled task';
    const wasNew = m.isNew; const child = newTask({ title:s.title, boardId:d.boardId, projectId:d.projectId, importance:d.importance, due:d.due, tags:d.tags.slice(), parentId:d.id, status:'consider' });
    child.order = nextOrder('consider'); logTask(child, `Created from subitem of "${d.title}"`); s.taskId = child.id;
    S.tasks.push(child);
    commitDraft(); ui.modal.draft = clone(T(d.id)); ui.modal.snap = JSON.stringify(ui.modal.draft); renderModal(); render();
    toast(`Created a task from the subitem${wasNew ? ' (parent saved too)' : ''}.`, { label:'Open', fn:() => openTask(child.id) }, 5000);
  },
  'parent-open'(){ ui.modal.parentOpen = true; ui.modal.parentQ = ''; renderModal(); setTimeout(() => { const i = $('#parentQ'); if (i) i.focus(); }, 30); },
  'parent-close'(){ ui.modal.parentOpen = false; renderModal(); },
  'parent-pick'(el){ const m = ui.modal, d = m.draft, id = el.dataset.id; if (!T(id) || id === d.id || isUnder(id, d.id)) return; d.parentId = id; m.parentOpen = false; renderModal(); },
  'parent-rm'(){ const m = ui.modal; m.draft.parentId = null; m.parentOpen = false; renderModal(); },
  'dep-add'(el){ const m = ui.modal, d = m.draft; if (!d.deps.includes(el.dataset.id) && !wouldCycle(d.id, el.dataset.id, depOverrides(m, d))) d.deps.push(el.dataset.id); m.depQ = ''; renderModal(); },
  'block-add'(el){ const m = ui.modal, d = m.draft, id = el.dataset.id; if (!blockingIds(m, d).includes(id) && !wouldCycle(id, d.id, depOverrides(m, d))){ m.bRm = m.bRm.filter(x => x !== id); if (!(T(id) && T(id).deps.includes(d.id))) m.bAdd.push(id); } m.blockQ = ''; renderModal(); },
  'block-rm'(el){ const m = ui.modal, id = el.dataset.id; m.bAdd = m.bAdd.filter(x => x !== id); const o = T(id); if (o && o.deps.includes(m.draft.id) && !m.bRm.includes(id)) m.bRm.push(id); renderModal(); },
  'dep-rm'(el){ const d = ui.modal.draft; d.deps = d.deps.filter(x => x !== el.dataset.id); renderModal(); },
  'save-task'(){ closeTask(true, true); },
  'dup-task'(){ const d = commitDraft(); if (!d) return; const c = duplicateTask(d.id); closeModal(); render(); toast('Duplicated.', { label:'Open', fn:() => openTask(c.id) }, 4000); },
  'del-task'(){ const id = ui.modal.draft.id; closeModal(); deleteTask(id); },
  /* ---- views ---- */
  'pop-view'(el){ openPop('view', el); },
  'pop-addview'(el){ openPop('addview', el); },
  'view-add'(el){ addView(el.dataset.type); },
  'vs-dir'(){ const v = activeView(); updateView('sortDir', v.sortDir > 0 ? -1 : 1); },
  'vs-dup'(){ dupView(); },
  'vs-del'(){ delView(); },
  'vs-default'(){ const b = mainBoard(), v = activeView(); b.defaultView = v.id; save(); renderPop(); toast(`"${v.name}" is now the default view for this board.`, null, 3000); },
  'lane-toggle'(el){ ui.lanesOff[el.dataset.lane] = !ui.lanesOff[el.dataset.lane]; renderContent(); },
  'group-toggle'(el){ ui.groupsOff[el.dataset.gid] = !ui.groupsOff[el.dataset.gid]; renderContent(); },
  'col-more'(el){ const k = el.dataset.key; ui.limits[k] = (ui.limits[k] || 0) + 50; renderContent(); },
  'board-settings'(){ openBoardSettings(primaryBoard()); },
  'folder-toggle'(el){ ui.foldersOff[el.dataset.f] = !ui.foldersOff[el.dataset.f]; renderSidebar(); icons(); },
  /* ---- cards and the right-click menu ---- */
  'task-done'(el){ toggleDone(el.dataset.id); },
  'task-menu'(el){ const r = el.getBoundingClientRect(); openCtx(el.dataset.id, r.left, r.bottom + 4); },
  'ctx-done'(){ const id = ui.ctx.id; closeCtx(); toggleDone(id); },
  'ctx-rename'(){ const id = ui.ctx.id; closeCtx(); startRename(id); },
  'ctx-sub'(el){ ui.ctx.sub = el.dataset.sub; renderCtx(); },
  'ctx-back'(){ ui.ctx.sub = null; renderCtx(); },
  'ctx-share'(){ const id = ui.ctx.id; closeCtx(); copyText(taskLink(id), 'Link copied. Opening it in a browser shows this task.'); },
  'ctx-ptags'(){ openPtags(ui.ctx.id); },
  'ctx-parent'(){ const id = ui.ctx.id; closeCtx(); openTask(id); if (ui.modal && ui.modal.type === 'task') ACTIONS['parent-open'](); },
  'ctx-proc'(){ const id = ui.ctx.id; closeCtx(); ACTIONS['toggle-proc']({ dataset:{ id } }); },
  'ctx-unpin'(){ const t = T(ui.ctx.id); closeCtx(); if (t){ t.pin = null; t.updated = nowISO(); save(); render(); toast('It will rank by importance and urgency again.', null, 3000); } },
  'ctx-dup'(){ const id = ui.ctx.id; closeCtx(); const c = duplicateTask(id); render(); if (c) toast('Duplicated.', { label:'Open', fn:() => openTask(c.id) }, 4000); },
  'ctx-subscribe'(){ const id = ui.ctx.id; closeCtx(); toggleSubscribe(id); },
  'ctx-archive'(){ const id = ui.ctx.id; closeCtx(); archiveWithUndo(id); },
  'ctx-delete'(){ const id = ui.ctx.id; closeCtx(); deleteTask(id); },
  'ctx-top'(){ const id = ui.ctx.id; closeCtx(); movePosition(id, 'top'); },
  'ctx-bottom'(){ const id = ui.ctx.id; closeCtx(); movePosition(id, 'bottom'); },
  'ctx-to'(el){ const id = ui.ctx.id, v = activeView(); closeCtx(); dropTo(id, el.dataset.gid, null, v.group === 'status' ? nextOrder(el.dataset.gid) : null); },
  'ctx-move-to'(el){ const id = ui.ctx.id; closeCtx(); changeBoard(id, el.dataset.b); },
  'ctx-copy-to'(el){ const id = ui.ctx.id, b = el.dataset.b; closeCtx(); const c = duplicateTask(id, b); if (c){ if (b === T(id).boardId) c.title = T(id).title + ' (copy)'; render(); toast(`Copied to ${boardName(b)}.`, { label:'Open', fn:() => openTask(c.id) }, 4000); } },
  'pt-rm'(el){ const m = ui.modal; m.tags = m.tags.filter(x => x !== el.dataset.v); renderModal(); },
  'pt-save'(){ const m = ui.modal, i = $('#ptIn'); if (i && i.value.trim()) m.tags.push(i.value.trim().toLowerCase()); if (m.tags.length) S.settings.personalTags[m.id] = [...new Set(m.tags)]; else delete S.settings.personalTags[m.id]; save(); closeModal(); render(); },
  /* ---- task editor extras ---- */
  'asg-rm'(el){ const d = ui.modal.draft; d.assignees = d.assignees.filter(x => x !== el.dataset.v); renderModal(); },
  'asg-add'(el){ addAssignee(el.dataset.v); },
  'att-add'(){ addAttachment(); },
  'att-rm'(el){ const d = ui.modal.draft; d.attachments = d.attachments.filter(a => a.id !== el.dataset.id); renderModal(); },
  'att-open'(el){ const u = el.dataset.u; if (/^(https?:|mailto:)/i.test(u)) Host.openExternal(u); else copyText(u, 'That is a file path, so it was copied. Paste it into File Explorer or Finder.'); },
  'att-copy'(el){ copyText(el.dataset.u, 'Copied.'); },
  'cmt-add'(){ addComment(); },
  'cmt-rm'(el){ const d = ui.modal.draft; d.comments = d.comments.filter(c => c.id !== el.dataset.id); commitAndRefresh(); },
  'mtab'(el){ ui.modal.tab = el.dataset.v; renderModal(); },
  'cf-check'(el){ const d = ui.modal.draft, id = el.dataset.id; d.custom[id] = !d.custom[id]; if (!d.custom[id]) delete d.custom[id]; renderModal(); },
  /* ---- board settings ---- */
  'st-done'(el){
    const b = bsetBoard(), st = b.stages.find(x => x.id === el.dataset.id); if (!st || st.done) return;
    const n = stCount(b, st.id); b.stages.forEach(x => { delete x.done; }); st.done = true; save(); render(); renderModal();
    toast(`"${st.name}" is now the completed stage${n ? `, so its ${n} task${n === 1 ? '' : 's'} count as done` : ''}.`, null, 5000);
  },
  'st-up'(el){ const b = bsetBoard(), i = b.stages.findIndex(x => x.id === el.dataset.id); if (i > 0){ [b.stages[i - 1], b.stages[i]] = [b.stages[i], b.stages[i - 1]]; save(); render(); renderModal(); } },
  'st-down'(el){ const b = bsetBoard(), i = b.stages.findIndex(x => x.id === el.dataset.id); if (i >= 0 && i < b.stages.length - 1){ [b.stages[i + 1], b.stages[i]] = [b.stages[i], b.stages[i + 1]]; save(); render(); renderModal(); } },
  'st-add'(){
    const b = bsetBoard(), inp = $('#stNew'), name = (inp && inp.value || '').trim();
    if (b.stages.length >= MAX_STAGES){ toast(`A board can have up to ${MAX_STAGES} stages.`); return; }
    if (!stageNameOk(b, name, null)) return;
    const c = STAGE_COLORS[b.stages.length % STAGE_COLORS.length], at = b.stages.findIndex(x => x.done);
    b.stages.splice(at < 0 ? b.stages.length : at, 0, { id:'s_' + uid(), name:name.slice(0, 40), h:c.h, s:c.s });
    save(); render(); renderModal(); const n = $('#stNew'); if (n) n.focus();
  },
  'st-del'(el){
    const b = bsetBoard(), st = b.stages.find(x => x.id === el.dataset.id); if (!st || st.done) return;
    if (!stCount(b, st.id)){ removeStage(b, st.id, (b.stages.find(x => x.id !== st.id) || {}).id); return; }
    const i = b.stages.indexOf(st), pick = b.stages[i - 1] && !b.stages[i - 1].done ? b.stages[i - 1] : b.stages.find(x => x.id !== st.id);
    ui.modal.stDel = st.id; ui.modal.stTo = pick.id; renderModal();
  },
  'st-del-cancel'(){ ui.modal.stDel = null; renderModal(); },
  'st-del-ok'(){
    const b = bsetBoard(), id = ui.modal.stDel, to = ui.modal.stTo || ($('[data-st=delTo]') || {}).value;
    const n = removeStage(b, id, to); toast(`Stage deleted${n ? `, and ${n} task${n === 1 ? '' : 's'} moved` : ''}.`, null, 4000);
  },
  'bs-tab'(el){ ui.modal.tab = el.dataset.v; ui.modal.fdEdit = null; ui.modal.stDel = null; renderModal(); const b = $('.bs-body'); if (b) b.scrollTop = 0; },
  'bs-hue'(el){ bsetBoard().h = +el.dataset.h; save(); render(); renderModal(); },
  'bs-csv'(){ const b = bsetBoard(); deliverFile(`${fileSlug(b.name)}-${todayStr()}.csv`, Tools.tasksToCSV(boardTasksOf(b), { boards:S.boards, projects:S.projects, fields:b.fields.custom }), 'text/csv', 'CSV file'); },
  'bs-json'(){
    const b = bsetBoard(), tasks = boardTasksOf(b), pids = new Set(tasks.map(t => t.projectId).filter(Boolean));
    deliverFile(`${fileSlug(b.name)}-${todayStr()}.json`, JSON.stringify({ app:'cursus-cos', kind:'board', exportedAt:nowISO(), board:b, projects:S.projects.filter(p => pids.has(p.id)), tasks }, null, 2), 'application/json', 'JSON file');
  },
  'bs-print-table'(){ printTasks('table'); },
  'bs-print-list'(){ printTasks('list'); },
  'bs-email'(){ emailList(); },
  async 'bs-delete'(){ const id = ui.modal.id; if (await deleteBoard(id)){ closeModal(); render(); } },
  'mem-add'(){
    const b = bsetBoard(), n = $('#memName'), e = $('#memEmail'), name = n.value.trim(); if (!name){ toast('Enter a name first.'); return; }
    if (b.members.some(x => x.name.toLowerCase() === name.toLowerCase())){ toast('That member is already on the board.'); return; }
    b.members.push({ id:uid(), name, email:e.value.trim() }); save(); renderModal(); render();
  },
  'mem-rm'(el){ const b = bsetBoard(); b.members.splice(+el.dataset.i, 1); save(); renderModal(); },
  'rule-add'(){ const b = bsetBoard(); b.rules.push({ id:uid(), name:'Rule ' + (b.rules.length + 1), on:true, trigger:{ type:'moved', value:doneIdOf(b) }, cond:{}, actions:[{ type:'flag', value:'' }] }); save(); renderModal(); },
  'rule-del'(el){ const b = bsetBoard(); b.rules = b.rules.filter(r => r.id !== el.dataset.id); save(); renderModal(); },
  'rule-on'(el){ const r = bsetBoard().rules.find(x => x.id === el.dataset.id); if (r){ r.on = r.on === false; save(); renderModal(); } },
  'rule-a-add'(el){ const r = bsetBoard().rules.find(x => x.id === el.dataset.id); if (r){ r.actions.push({ type:'addTag', value:'' }); save(); renderModal(); } },
  'rule-a-del'(el){ const r = bsetBoard().rules.find(x => x.id === el.dataset.id); if (r && r.actions.length > 1){ r.actions.splice(+el.dataset.i, 1); save(); renderModal(); } },
  'bs-restore'(el){ archiveTasks([el.dataset.id], false); render(); renderModal(); },
  'bs-restore-all'(){ const b = bsetBoard(), ids = boardTasksOf(b).filter(t => t.archived).map(t => t.id); archiveTasks(ids, false); render(); renderModal(); toast(`Restored ${ids.length} task${ids.length === 1 ? '' : 's'}.`, null, 3000); },
  'bs-delete-one'(el){ const t = T(el.dataset.id); if (t) deleteTasks([t.id], `Deleted "${t.title}".`); renderModal(); },
  async 'bs-delete-archived'(){
    const b = bsetBoard(), ids = boardTasksOf(b).filter(t => t.archived).map(t => t.id); if (!ids.length) return;
    if (!await confirmBox({ title:`Delete ${ids.length} archived task${ids.length === 1 ? '' : 's'} permanently?`, body:'They are removed from every device that syncs. You can undo right afterwards.', ok:'Delete', danger:true })) return;
    deleteTasks(ids, `Deleted ${ids.length} archived task${ids.length === 1 ? '' : 's'}.`); renderModal();
  },
  'bs-open-archive'(){ const id = ui.modal.id; S.settings.boardsSel = [id]; S.settings.filters.archived = true; save(); closeModal(); render(); },
  'fd-up'(el){ const o = bsetBoard().fields.order, i = o.indexOf(el.dataset.id); if (i > 0){ [o[i - 1], o[i]] = [o[i], o[i - 1]]; save(); render(); renderModal(); } },
  'fd-down'(el){ const o = bsetBoard().fields.order, i = o.indexOf(el.dataset.id); if (i >= 0 && i < o.length - 1){ [o[i + 1], o[i]] = [o[i], o[i + 1]]; save(); render(); renderModal(); } },
  'fd-eye'(el){ const h = bsetBoard().fields.hidden, id = el.dataset.id, i = h.indexOf(id); if (id === 'stage') return; i >= 0 ? h.splice(i, 1) : h.push(id); save(); render(); renderModal(); },
  'fd-edit'(el){ ui.modal.fdEdit = el.dataset.id; renderModal(); },
  'fd-done'(){ ui.modal.fdEdit = null; renderModal(); },
  async 'fd-del'(el){
    const b = bsetBoard(), f = b.fields.custom.find(x => x.id === el.dataset.id); if (!f) return;
    if (!await confirmBox({ title:`Delete the field "${f.name}"?`, body:'It disappears from this board. Values already entered stay on the tasks but are not shown.', ok:'Delete field', danger:true })) return;
    b.fields.custom = b.fields.custom.filter(x => x.id !== f.id); b.fields.order = b.fields.order.filter(x => x !== 'cf:' + f.id); b.fields.hidden = b.fields.hidden.filter(x => x !== 'cf:' + f.id);
    b.views.forEach(v => { if (v.group === 'cf:' + f.id) v.group = 'status'; if (v.vgroup === 'cf:' + f.id) v.vgroup = ''; });
    ui.modal.fdEdit = null; save(); render(); renderModal();
  },
  'fd-add'(){
    const b = bsetBoard(), nf = ui.modal.newField, name = (nf.name || '').trim(); if (!name){ toast('Give the field a name first.'); return; }
    if (b.fields.custom.some(f => f.name.toLowerCase() === name.toLowerCase())){ toast('There is already a field with that name.'); return; }
    const f = { id:uid(), name, type:nf.type, options: nf.type === 'label' ? parseOptions(nf.options) : [], desc:'' };
    if (f.type === 'label' && !f.options.length){ toast('Add at least one label, one per line.'); return; }
    b.fields.custom.push(f); b.fields.order.push('cf:' + f.id); ui.modal.newField = { name:'', type:'text', options:'' }; save(); render(); renderModal();
  },
  'ics-done'(){ ui.modal.icsDone = !ui.modal.icsDone; renderModal(); },
  'ics-save'(){ const b = bsetBoard(), r = Tools.toICS(boardTasksOf(b), { name:b.name, includeDone:ui.modal.icsDone, boards:S.boards }); deliverFile(`${fileSlug(b.name)}.ics`, r.text, 'text/calendar', 'Calendar file'); },
  'ics-copy'(){ const b = bsetBoard(), r = Tools.toICS(boardTasksOf(b), { name:b.name, includeDone:ui.modal.icsDone, boards:S.boards }); copyText(r.text, 'Calendar text copied. Save it as a file ending in .ics.'); },
  'cr-add'(){ const b = bsetBoard(); b.colors.rules.push({ type:'priority', value:'high', color:'red' }); save(); render(); renderModal(); },
  'cr-del'(el){ const b = bsetBoard(); b.colors.rules.splice(+el.dataset.i, 1); save(); render(); renderModal(); },
  'cr-up'(el){ const r = bsetBoard().colors.rules, i = +el.dataset.i; if (i > 0){ [r[i - 1], r[i]] = [r[i], r[i - 1]]; save(); render(); renderModal(); } },
  'email-here'(){ const X = S.settings.integrations.exchange, id = ui.modal.id; X.targetBoard = X.targetBoard === id ? '' : id; save(); renderModal(); },
  'open-email-settings'(){ ui.settingsTab = 'integrations'; ui.modal = { type:'settings' }; renderModal(); }
};
let downOnBackdrop = false;
document.addEventListener('pointerdown', e => {
  downOnBackdrop = !!(ui.modal && (ui.modal.type === 'settings' || ui.modal.type === 'bset' || ui.modal.type === 'task') && e.target.classList && e.target.classList.contains('m-back') && e.target.closest('#modalRoot'));
}, true);
document.addEventListener('click', e => {
  if (DG.justDropped){ e.preventDefault(); return; }
  /* Settings closes when you click the dimmed area outside it (press and release both outside, so dragging a slider past the edge does not close it). */
  if (downOnBackdrop && ui.modal && (ui.modal.type === 'settings' || ui.modal.type === 'bset' || ui.modal.type === 'task') && e.target.classList && e.target.classList.contains('m-back') && e.target.closest('#modalRoot')){ downOnBackdrop = false; closeTopModal(); return; }
  downOnBackdrop = false;
  if (ui.ctx && !e.target.closest('.ctx')) closeCtx();
  const el = e.target.closest('[data-act]');
  if (ui.pop && !e.target.closest('.pop') && !(el && /^pop-/.test(el.dataset.act))) closePop();
  if (!el) return;
  if (el !== e.target && e.target.closest('select,input,textarea,label')) return;
  const fn = ACTIONS[el.dataset.act]; if (fn) fn(el, e);
});
document.addEventListener('contextmenu', e => {
  const el = e.target.closest && e.target.closest('#content [data-id][data-act="open-task"]');
  if (!el || e.target.closest('input,textarea,select')) return;
  e.preventDefault(); openCtx(el.dataset.id, e.clientX, e.clientY);
});
document.addEventListener('keydown', e => {
  const tgt = e.target, typing = tgt.matches && tgt.matches('input,textarea,select');
  if (tgt.dataset && tgt.dataset.rename){
    if (e.key === 'Enter'){ e.preventDefault(); finishRename(tgt.dataset.rename, true); }
    else if (e.key === 'Escape'){ e.preventDefault(); finishRename(tgt.dataset.rename, false); }
    return;
  }
  if (ui.ctx && (e.key === 'ArrowDown' || e.key === 'ArrowUp')){
    e.preventDefault(); const items = $$('.ctx-i'), i = items.indexOf(document.activeElement), n = items.length;
    if (n) items[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n].focus(); return;
  }
  if (e.key === 'Escape'){
    if ($('#confirmRoot').innerHTML) return;
    if (ui.ctx){ closeCtx(); return; }
    if (ui.pop){ closePop(); return; }
    if (ui.modal){ closeTopModal(); return; }
    if (ui.sideOpen){ ui.sideOpen = false; render(); return; }
    if (tgt.dataset && tgt.dataset.quick){ ui.quick = null; render(); return; }
  }
  if (e.key === 'Enter'){
    if (tgt.dataset && tgt.dataset.quick){ const v = tgt.value.trim(); if (v){ quickCreateIn(tgt.dataset.quick, tgt.dataset.lane || '', v); ui.quickFocus = tgt.dataset.quick + '|' + (tgt.dataset.lane || ''); render(); } e.preventDefault(); return; }
    if (tgt.dataset && tgt.dataset.calAdd !== undefined){ const v = tgt.value.trim(); if (v){ const t = quickCreate('consider', v); t.due = ui.calSel; save(); render(); toast('Task added to ' + fmtD(ui.calSel), null, 2000); } e.preventDefault(); return; }
    if (ui.modal && ui.modal.type === 'task'){
      if (tgt.id === 'subNew'){ e.preventDefault(); ACTIONS['sub-add'](); return; }
      if (tgt.id === 'asgIn'){ e.preventDefault(); addAssignee(tgt.value); return; }
      if (tgt.id === 'attIn'){ e.preventDefault(); addAttachment(); return; }
      if (tgt.id === 'cmtIn' && (e.metaKey || e.ctrlKey)){ e.preventDefault(); addComment(); return; }
      if (tgt.id === 'tagIn'){ e.preventDefault(); const v = tgt.value.trim().toLowerCase().replace(/,/g, ''); if (v && !ui.modal.draft.tags.includes(v)){ ui.modal.draft.tags.push(v); renderModal(); $('#tagIn').focus(); } return; }
      if (e.metaKey || e.ctrlKey){ e.preventDefault(); ACTIONS['save-task'](); return; }
    }
    if (ui.modal && ui.modal.type === 'followup' && tgt.id === 'fuName'){ e.preventDefault(); ACTIONS['fu-save'](); return; }
    if (ui.modal && ui.modal.type === 'entity' && tgt.id === 'entName'){ e.preventDefault(); ACTIONS['ent-save'](); return; }
    if (ui.modal && ui.modal.type === 'sview' && tgt.id === 'svName'){ e.preventDefault(); ACTIONS['sv-save'](); return; }
    if (ui.modal && ui.modal.type === 'ptags' && tgt.id === 'ptIn'){ e.preventDefault(); const v = tgt.value.trim().toLowerCase(); if (v && !ui.modal.tags.includes(v)){ ui.modal.tags.push(v); renderModal(); const i = $('#ptIn'); if (i) i.focus(); } return; }
    if (ui.modal && ui.modal.type === 'bset' && tgt.id === 'stNew'){ e.preventDefault(); ACTIONS['st-add'](); return; }
    if (ui.modal && ui.modal.type === 'bset' && (tgt.id === 'memName' || tgt.id === 'memEmail')){ e.preventDefault(); ACTIONS['mem-add'](); return; }
    if (!typing && tgt.matches && tgt.matches('[data-act="open-task"]')){ e.preventDefault(); openTask(tgt.dataset.id); return; }
  }
  if (typing || ui.modal) return;
  if (e.key === '/'){ e.preventDefault(); const s = $('#search'); if (s) s.focus(); }
  else if (e.key === 'n' && !e.metaKey && !e.ctrlKey){ e.preventDefault(); ACTIONS['new-task'](); }
  else if (e.key === 'F2'){ const c = tgt.closest && tgt.closest('#content [data-id][data-act="open-task"]'); if (c){ e.preventDefault(); startRename(c.dataset.id); } }
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.rename){ ui.renameVal = el.value; return; }
  if (el.dataset.vs){
    if (el.dataset.vs === 'detail'){ updateView('detail', el.value); const n = $('#vsDetailNote'); if (n) n.textContent = DETAIL_LABELS[+el.value]; }
    else if (el.dataset.vs === 'name') updateView('name', el.value.slice(0, 40) || 'View');
    return;
  }
  if (ui.modal && ui.modal.type === 'bset'){
    if (el.dataset.bs === 'name') bsApply(el);
    else if (el.dataset.rule && el.tagName === 'INPUT') ruleApply(el);
    else if (el.dataset.cr !== undefined && el.tagName === 'INPUT') crApply(el);
    else if (el.dataset.nf && el.tagName !== 'SELECT') ui.modal.newField[el.dataset.nf] = el.value;
    return;
  }
  if (el.dataset.imp === 'newName' && ui.modal && ui.modal.type === 'import'){ ui.modal.newName = el.value; return; }
  if (el.id === 'search'){ ui.search = el.value; renderContent(); const s = $('#tbStats'); if (s) s.textContent = statsText(); return; }
  if (el.id === 'parentQ' && ui.modal){ ui.modal.parentQ = el.value; $('#parentResults').innerHTML = parentResultsHTML(); icons(); return; }
  if (el.id === 'depQ' && ui.modal){ ui.modal.depQ = el.value; $('#depResults').innerHTML = depResultsHTML(); icons(); return; }
  if (el.id === 'pasteIn' && ui.modal && ui.modal.type === 'paste'){
    ui.modal.text = el.value; $('#pastePreview').innerHTML = pasteSummaryHTML(); icons();
    const n = Tools.parseTaskLines(el.value, { subs: ui.modal.subs }).tasks.length, b = $('#pasteAdd'); if (b){ b.disabled = !n; b.textContent = n ? `Add ${n} task${n > 1 ? 's' : ''}` : 'Add tasks'; } return;
  }
  if (el.id === 'fuName' && ui.modal && ui.modal.type === 'followup'){ ui.modal.name = el.value; return; }
  if (el.id === 'blockQ' && ui.modal){ ui.modal.blockQ = el.value; $('#blockResults').innerHTML = blockResultsHTML(); icons(); return; }
  if (el.id === 'bgDim'){ S.settings.bg.dim = +el.value; applyBg(); save(); const l = el.previousElementSibling; if (l) l.textContent = `Dim the background: ${Math.round(el.value * 100)}%`; return; }
  if (ui.modal && ui.modal.type === 'task'){
    const d = ui.modal.draft;
    if (el.dataset.f === 'title' || el.dataset.f === 'description'){ d[el.dataset.f] = el.value; return; }
    if (el.dataset.sub !== undefined){ d.subitems[+el.dataset.sub].title = el.value; return; }
    if (el.dataset.cf && el.dataset.t !== 'date' && el.dataset.t !== 'label'){ setCf(el); return; }
  }
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.imp && ui.modal && ui.modal.type === 'import'){ importChange(el); return; }
  if (el.id === 'zkFile' && el.files[0]){ const f = el.files[0]; el.value = ''; loadZenkitFile(f); return; }
  if (el.id === 'csvFile' && el.files[0]){ const f = el.files[0]; el.value = ''; loadCsvFile(f); return; }
  if (el.dataset.vs){ if (el.tagName === 'SELECT') updateView(el.dataset.vs, el.value); return; }
  if (ui.modal && ui.modal.type === 'bset'){
    if (el.dataset.bs){ bsApply(el); return; }
    if (el.dataset.bsFolder !== undefined){ const b = bsetBoard(); b.folder = el.value.trim().slice(0, 40); ui.modal.newFolder = false; save(); renderSidebar(); icons(); renderModal(); return; }
    if (el.dataset.rule){ ruleApply(el); return; }
    if (el.dataset.st && el.dataset.st !== 'new'){ stApply(el); return; }
    if (el.dataset.cr !== undefined){ crApply(el); return; }
    if (el.dataset.nf || el.dataset.fd){ bsFieldChange(el); return; }
  }
  if (el.dataset.tbl){
    const t = T(el.dataset.id); if (!t) return;
    if (el.dataset.tbl === 'status'){ const dn = stagesOf(t.boardId).some(x => x.id === el.value && x.done); moveTask(t.id, el.value, dn ? topOrder(el.value) : nextOrder(el.value)); }
    else { setImp(t, el.value); t.locked = false; t.updated = nowISO(); logTask(t, `Importance set to ${t.importance}`); fireRules(t, { type:'priority', value:t.importance }); runAutomation(); save(); render(); }
    return;
  }
  if (el.id === 'bgColor'){ S.settings.bg = { type:'color', value:el.value, dim:S.settings.bg.dim || 0 }; save(); applyBg(); renderModal(); return; }
  if (el.id === 'bgFile' && el.files[0]){ setBgImage(el.files[0]); return; }
  if (el.id === 'restoreFile' && el.files[0]){ const r = new FileReader(); r.onload = () => { $('#restoreJson').value = r.result; }; r.readAsText(el.files[0]); return; }
  if (el.dataset.rvMore !== undefined){ if (el.value){ reviewOther(el.dataset.rvMore, el.value); afterReview(); } return; }
  if (el.dataset.sync){
    const k = el.dataset.sync, c = S.meta.sync;
    if (k === 'mode' && el.value !== 'off' && S.sample){ toast('Clear the sample data first (Settings, Data), then turn sync on.', null, 5000); renderModal(); return; }
    c[k] = el.value; c.error = ''; persistMeta();
    if (k === 'mode'){ ui.od.msg = ''; renderModal(); renderSidebar(); icons(); odWatch(); if (el.value !== 'off') scheduleSync(300); }
    else if (c.mode !== 'off' && k !== 'clientId') scheduleSync(800);
    return;
  }
  if (el.dataset.set){
    if (el.dataset.set === 'integrations.gmail.allowFrom') gmCfg().seen = [];   // mail that was ignored before may be welcome now
    const v = el.dataset.type === 'num' ? Math.max(+el.min || 0, Math.min(+el.max || 999, parseInt(el.value, 10) || 0)) : el.value;
    setPath(S.settings, el.dataset.set, v); save(); if (el.dataset.set.startsWith('automation')){ runAutomation(); render(); } return;
  }
  if (ui.modal && ui.modal.type === 'paste' && el.dataset.paste){
    const m = ui.modal, k = el.dataset.paste; m[k] = el.value;
    if (k === 'boardId'){ const tpl = (boardOf(el.value) || {}).template || {}; m.status = tpl.status || firstOpenStage(el.value); }
    renderModal(); return;
  }
  if (ui.modal && ui.modal.type === 'followup'){ if (el.id === 'fuDate'){ ui.modal.date = el.value; renderModal(); } else if (el.id === 'fuTime'){ ui.modal.time = el.value; renderModal(); } return; }
  if (ui.modal && ui.modal.type === 'task'){
    const d = ui.modal.draft;
    if (el.dataset.cf){ setCf(el); return; }
    if (el.dataset.subStick !== undefined){ const s = d.subitems[+el.dataset.subStick]; if (s) s.stick = el.checked; renderModal(); return; }
    if (el.dataset.rp){
      const k = el.dataset.rp;
      if (k === 'mode') d.repeat = el.value ? { every:1, unit:'week', from:'schedule', stage:'' } : null;
      else d.repeat = normRepeat(Object.assign({}, d.repeat, { [k]: el.value }));
      renderModal(); return;
    }
    if (el.dataset.f){
      const f = el.dataset.f;
      if (f === 'estimate'){ d.estimate = parseEst(el.value); el.value = fmtEst(d.estimate); return; }
      if (f === 'boardId'){ d.status = mapStatus(d.status, boardOf(d.boardId), boardOf(el.value)); d.boardId = el.value; renderModal(); return; }   // the stage list belongs to the board
      if (f === 'projectId') d.projectId = el.value || null; else d[f] = el.value;
      if (f === 'start' || f === 'due') renderModal();
      return;
    }
    if (el.dataset.r){
      const k = el.dataset.r; d.reminder = d.reminder || { type:'none' };
      if (k === 'type'){
        if (el.value === 'none') d.reminder = null;
        else { Host.ensureNotifyPermission(); d.reminder = { type:el.value, days: el.value === 'at' ? 0 : 1, at: el.value === 'at' ? `${d.due || todayStr()}T${S.settings.reminderTime}` : '' }; }
      } else if (k === 'days') d.reminder.days = +el.value; else d.reminder.at = el.value;
      if (d.reminder){ d.reminder.ack = null; d.reminder.notified = null; d.reminder.snoozedUntil = null; }
      renderModal(); return;
    }
  }
});
document.addEventListener('focusout', e => {
  const el = e.target;
  if (el.dataset && el.dataset.rename){ finishRename(el.dataset.rename, true); return; }
  if (el.dataset && el.dataset.quick && !el.value.trim()){
    const foot = el.closest('.col-foot'); ui.quick = null; if (foot) foot.innerHTML = quickHTML(el.dataset.quick, el.dataset.lane || ''), icons();
  }
});
$('#modalRoot').addEventListener('mousedown', e => { /* backdrop clicks are ignored so edits are not lost by accident */ });
window.addEventListener('resize', () => { if (ui.pop) closePop(); closeCtx(); });

/* ---------- boot ---------- */
function tick(){
  const day = todayStr(); let changed = false;
  if (day !== ui.lastDay){ ui.lastDay = day; changed = true; }
  if (runAutomation()) changed = true;
  if (checkReminders()) changed = true;
  if (changed && !ui.modal) render(); else { const n = $('#tbStats'); if (n) n.textContent = statsText(); renderSyncStatus(); }
}
function registerSW(){
  try{
    if (Host.platform === 'web' && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol) && window.COS_BUILD !== 'single'){
      const had = !!navigator.serviceWorker.controller;   // false on the very first visit: nothing to announce then
      navigator.serviceWorker.register('sw.js').then(reg => {
        const look = () => reg.update().catch(() => {});
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') look(); });
        setInterval(look, 3600 * 1000);
      }).catch(() => {});
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) toast('A new version of Cursus CoS is ready. Your data is kept.', { label:'Reload', fn:() => location.reload() }, 60000); });
    }
  }catch(e){}
}
async function boot(){
  await Host.ready();
  S = await loadState();
  try{
    bgCache = (await Host.kv.get(KEY_BG)) || '';
    if (!bgCache) for (const k of LEGACY_BG_KEYS){ const v = await Host.kv.get(k); if (v){ bgCache = v; Host.kv.set(KEY_BG, v).catch(() => {}); break; } }
  }catch(e){}
  resetHashes(S, hashes);
  applyTheme(); applyBg();
  runAutomation(); checkReminders();
  render();
  setInterval(tick, 30000);
  Host.onOpenTask(id => { if (T(id)) openTask(id); });
  const fromHash = () => { const m = /task=([\w-]+)/.exec(location.hash || ''); if (m && T(m[1])) openTask(m[1]); };
  fromHash(); window.addEventListener('hashchange', fromHash);
  Host.onBack(() => {
    if ($('#confirmRoot').innerHTML){ $('#confirmRoot').innerHTML = ''; return true; }
    if (ui.pop){ closePop(); return true; }
    if (ui.modal){ closeTopModal(); return true; }
    if (ui.sideOpen){ ui.sideOpen = false; render(); return true; }
    return false;
  });
  if (Host.fileSync && Host.fileSync.onChange) Host.fileSync.onChange(() => scheduleSync(400));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(300); });
  window.addEventListener('focus', () => scheduleSync(300));
  let pollTick = 0;
  setInterval(() => {   // OneDrive: every 20 s while the app is on screen; other methods: every 60 s
    const m = S && S.meta.sync && S.meta.sync.mode; if (!m || m === 'off') return;
    if (m === 'onedrive'){ if (!document.hidden) scheduleSync(0); } else if (++pollTick % 3 === 0) scheduleSync(0);
  }, 20000);
  await odResume();
  pushReminders(); scheduleSync(1500); odWatch();
  if (Host.platform === 'android') setTimeout(() => { Host.kv.get('cos.updchk').then(v => { if (Date.now() - (+v || 0) > 12 * 36e5){ Host.kv.set('cos.updchk', String(Date.now())).catch(() => {}); checkAppUpdate(false); } }).catch(() => {}); }, 9000);
  if (Host.loopback){ setTimeout(() => gmailPoll(false), 6000); setInterval(() => { if (!document.hidden) gmailPoll(false); }, 5 * 60 * 1000); }
  registerSW();
}
boot().catch(e => { console.error(e); const c = $('#content'); if (c) c.innerHTML = '<p class="note" style="padding:24px">Cursus CoS could not start: ' + esc((e && e.message) || e) + '</p>'; });

})();
