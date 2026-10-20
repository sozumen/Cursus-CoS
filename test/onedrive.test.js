const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/js/onedrive.js');
const core = require('../src/js/core.js');

const { CLIENT, json, fakeMicrosoft, fakeIo } = require('./onedrive.fixture.js');
function setup(ms, extra = {}){
  const store = {}, clock = { t: 1e12 }, timers = [];
  const deps = {
    http: ms.http, now: () => clock.t, sleep: async n => { clock.t += n; },
    kv: { get: async k => store[k] ?? null, set: async (k, v) => { store[k] = v; }, remove: async k => { delete store[k]; } },
    setTimeout: (f, n) => { const t = { f, n }; timers.push(t); return t; }, clearTimeout: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    io: () => deps._io
  };
  Object.assign(deps, extra);
  return { od: create(deps), store, clock, timers, deps };
}

test('sign in: shows a code, waits through pending and slow_down, stores tokens, learns the account name', async () => {
  const ms = fakeMicrosoft(), { od, store } = setup(ms);
  let shown = null;
  const r = await od.signIn(CLIENT, c => { shown = c; });
  assert.equal(shown.userCode, 'ABCD1234'); assert.match(shown.uri, /microsoft\.com\/link/);
  assert.equal(r.name, 'pat@example.com');
  const saved = JSON.parse(store['cos.msauth']); assert.equal(saved.refresh, 'ref1'); assert.equal(saved.clientId, CLIENT);
  assert.deepEqual(await od.status(), { signedIn: true, name: 'pat@example.com', clientId: CLIENT, live: false, liveError: '' });
});

test('sign in: rejects a malformed client id, an expired code, a cancel, and a decline', async () => {
  const ms = fakeMicrosoft();
  await assert.rejects(setup(ms).od.signIn("not-a-guid"), /Application \(client\) ID/);
  const m2 = fakeMicrosoft({ pendingPolls: 1e9 }), a = setup(m2);
  await assert.rejects(a.od.signIn(CLIENT), /expired/);
  const m3 = fakeMicrosoft({ pendingPolls: 1e9 }), b = setup(m3);
  const p = b.od.signIn(CLIENT, () => b.od.cancel()); await assert.rejects(p, e => e.cancelled);
  const m4 = fakeMicrosoft(); const orig = m4.http; m4.http = async r => (/token/.test(r.url) && /device_code/.test(r.body) ? json(400, { error: 'authorization_declined' }) : orig(r));
  await assert.rejects(setup(m4).od.signIn(CLIENT), /declined/);
});

test('a bad client id gives a plain explanation; no network gives a plain explanation', async () => {
  const bad = async () => json(400, { error: 'unauthorized_client', error_description: 'AADSTS700016: Application not found' });
  await assert.rejects(setup({ http: bad }).od.signIn(CLIENT), /does not recognise that client ID/);
  const down = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(setup({ http: down }).od.signIn(CLIENT), /Could not reach Microsoft/);
});

test('tokens: refreshes when expired, rotates the refresh token, retries a 401 once, signs out cleanly when revoked', async () => {
  const ms = fakeMicrosoft(), { od, clock, store } = setup(ms);
  await od.signIn(CLIENT);
  clock.t += 3600 * 1000;                              // access token has expired
  const t = await od.accessToken(); assert.equal(t, 'acc2'); assert.equal(JSON.parse(store['cos.msauth']).refresh, 'ref2');
  ms.expireAccessNow = true;                           // server rejects the token mid-flight
  const ad = od.adapter(); assert.equal(await ad.pull(), null);
  assert.ok(ms.log.filter(l => /oauth2/.test(l) && /token/.test(l)).length >= 3);
  ms.revoked = true; clock.t += 3600 * 1000;
  await assert.rejects(od.accessToken(), e => e.auth && /Sign in again/.test(e.message));
  assert.equal(store['cos.msauth'], undefined); assert.equal((await od.status()).signedIn, false);
});

test('adapter: first push creates the file, pull skips the download while the eTag is unchanged, a stale push is a conflict', async () => {
  const ms = fakeMicrosoft(), { od } = setup(ms);
  await od.signIn(CLIENT);
  const ad = od.adapter();
  assert.equal(await ad.pull(), null);
  await ad.push({ a: 1 }, undefined);
  assert.equal(JSON.parse(ms.file).a, 1);
  ms.log.length = 0;
  let r = await ad.pull(); assert.deepEqual(r.data, { a: 1 });
  assert.ok(!ms.log.some(l => /dl\.test/.test(l)), 'our own upload is remembered, no download');
  ms.file = JSON.stringify({ a: 2 }); ms.etag++;       // another device wrote it
  r = await ad.pull(); assert.equal(r.data.a, 2); assert.ok(ms.log.some(l => /dl\.test/.test(l)));
  const stale = r.etag;
  ms.file = JSON.stringify({ a: 3 }); ms.etag++;
  await assert.rejects(ad.push({ a: 9 }, stale), e => e.conflict);
  const fresh = await ad.pull(); await ad.push({ a: 4 }, fresh.etag); assert.equal(JSON.parse(ms.file).a, 4);
  // creating when someone else created first
  const ms2 = fakeMicrosoft(); const b = setup(ms2); await b.od.signIn(CLIENT); ms2.file = '{}'; ms2.etag = 1;
  await assert.rejects(b.od.adapter().push({ x: 1 }, undefined), e => e.conflict);
});

test('adapter: malformed file and server errors give readable messages', async () => {
  const ms = fakeMicrosoft(), a = setup(ms), od = a.od; await od.signIn(CLIENT);
  ms.file = 'not json'; ms.etag = 5;
  await assert.rejects(od.adapter().pull(), /not valid JSON/);
  const orig = a.deps.http;
  a.deps.http = async r => (r.method === 'PUT' ? json(507, {}) : orig(r));
  await assert.rejects(od.adapter().push({}, 'e5'), /OneDrive is full/);
  a.deps.http = async r => (r.method === 'PUT' ? json(429, {}) : orig(r));
  await assert.rejects(od.adapter().push({}, 'e5'), /slow down/);
});

test('two devices converge through the fake OneDrive using the real merge', async () => {
  const ms = fakeMicrosoft(), A = setup(ms), B = setup(ms);
  await A.od.signIn(CLIENT); await B.od.signIn(CLIENT);
  const mk = id => core.newTask({ id, title: 'T ' + id, boardId: 'b' });
  const dev = (name, tasks) => ({ name, d: { v: 1, boards: [{ id: 'b', name: 'B' }], projects: [], tasks, tombstones: [] } });
  const pushMerge = async (od, local) => {
    const ad = od.adapter(); const remote = await ad.pull();
    const merged = remote ? core.mergeData(local, remote.data) : local;
    await ad.push(merged, remote && remote.etag); return merged;
  };
  const stamp = (t, at) => Object.assign(t, { updated: at });
  const a1 = stamp(mk('1'), '2026-01-01T00:00:00.000Z'), b2 = stamp(mk('2'), '2026-01-01T00:00:01.000Z');
  const mA = await pushMerge(A.od, dev('A', [a1]).d);
  const mB = await pushMerge(B.od, dev('B', [b2]).d);
  assert.deepEqual(mB.tasks.map(t => t.id).sort(), ['1', '2']);
  const mA2 = await pushMerge(A.od, mA); assert.deepEqual(mA2.tasks.map(t => t.id).sort(), ['1', '2']);
});

test('live alerts: connects with websocket only, signals changes, reconnects with a new address after a drop, stops cleanly', async () => {
  const ms = fakeMicrosoft(), io = fakeIo(), a = setup(ms, { _io: io });
  a.deps._io = io;
  await a.od.signIn(CLIENT);
  let changes = 0; const states = [];
  const stop = a.od.watch(() => changes++, s => states.push(s.on));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(io.sockets.length, 1); assert.deepEqual(io.sockets[0].o.transports, ['websocket']); assert.match(io.sockets[0].url, /ws\.test\/cb\?k=1/);
  io.sockets[0].emit('connect'); assert.equal((await a.od.status()).live, true);
  io.sockets[0].emit('notification', { resource: 'x' }); io.sockets[0].emit('notification'); assert.equal(changes, 2);
  io.sockets[0].emit('disconnect');
  assert.equal((await a.od.status()).live, false); assert.equal(io.sockets[0].closed, true);
  assert.equal(a.timers.length, 1, 'a reconnect is scheduled'); a.timers.shift().f();
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(io.sockets.length, 2); assert.match(io.sockets[1].url, /k=2/);
  io.sockets[1].emit('connect');
  stop();
  assert.equal(io.sockets[1].closed, true); assert.equal(a.timers.length, 0);
  io.sockets[1].emit('notification'); assert.equal(changes, 2, 'no signals after stop');
});

test('live alerts: failing to connect backs off and keeps retrying; missing socket library is reported, not fatal; signed out stops quietly', async () => {
  const ms = fakeMicrosoft(), io = fakeIo(), a = setup(ms); a.deps._io = io;
  await a.od.signIn(CLIENT);
  a.od.watch(() => {});
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  io.sockets[0].emit('connect_error', new Error('nope'));
  const t1 = a.timers[0].n; a.timers.shift().f();
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  io.sockets[1].emit('connect_error', new Error('nope'));
  assert.ok(a.timers[0].n > t1, 'backoff grows');
  a.od.unwatch();
  const b = setup(fakeMicrosoft()); await b.od.signIn(CLIENT); b.deps._io = null;
  b.od.watch(() => {}); await new Promise(r => setImmediate(r));
  assert.match((await b.od.status()).liveError, /not available/);
  b.od.unwatch();
  const c = setup(fakeMicrosoft()); c.deps._io = io; // never signed in
  c.od.watch(() => {}); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(c.timers.length, 0, 'no retry loop when signed out'); c.od.unwatch();
});

/* ---------- web sign-in: authorization code + PKCE by redirect ---------- */
const nodeCrypto = require('node:crypto');
const REDIR = 'https://pat.github.io/cursus-cos/';
const webSetup = ms => { const nav = []; const x = setup(ms, { navigate: u => nav.push(u), crypto: nodeCrypto.webcrypto }); x.nav = nav; return x; };
const q = u => Object.fromEntries(new URL(u).searchParams);

test('web sign-in: sends the browser to Microsoft with PKCE, then trades the returned code for tokens', async () => {
  const ms = fakeMicrosoft(), { od, nav, store } = webSetup(ms);
  const url = await od.beginRedirect(CLIENT, REDIR);
  assert.equal(nav.length, 1); assert.equal(nav[0], url);
  assert.match(url, /^https:\/\/login\.microsoftonline\.com\/consumers\/oauth2\/v2\.0\/authorize\?/);
  const a = q(url);
  assert.equal(a.client_id, CLIENT); assert.equal(a.redirect_uri, REDIR); assert.equal(a.response_type, 'code');
  assert.equal(a.code_challenge_method, 'S256'); assert.equal(a.prompt, 'select_account'); assert.match(a.scope, /Files\.ReadWrite/); assert.match(a.scope, /offline_access/);
  // the page reloads at the redirect address with ?code=...&state=...
  const r = await od.completeRedirect('?code=AUTHCODE&state=' + a.state + '&session_state=zz');
  assert.deepEqual(r, { ok: true, name: 'pat@example.com', silent: false });
  const f = ms.lastRedeem;
  assert.equal(f.code, 'AUTHCODE'); assert.equal(f.redirect_uri, REDIR); assert.equal(f.client_id, CLIENT);
  assert.equal(nodeCrypto.createHash('sha256').update(f.code_verifier).digest('base64url'), a.code_challenge, 'verifier matches the challenge that was sent');
  assert.equal(JSON.parse(store['cos.msauth']).web, true);
  assert.equal(store['cos.msauth.pending'], undefined, 'one-time state is gone');
  assert.equal(await od.completeRedirect('?code=AUTHCODE&state=' + a.state), null, 'a replayed answer is ignored');
});

test('web sign-in: ignores addresses that are not ours, a wrong state, and malformed ids', async () => {
  const ms = fakeMicrosoft(), { od } = webSetup(ms);
  assert.equal(await od.completeRedirect(''), null); assert.equal(await od.completeRedirect('?task=3'), null);
  await od.beginRedirect(CLIENT, REDIR);
  assert.equal(await od.completeRedirect('?code=x&state=forged'), null);
  assert.equal(ms.codeRedemptions, undefined, 'no code was redeemed for a forged state');
  await assert.rejects(od.beginRedirect('nope', REDIR), /Application \(client\) ID/);
  const noCrypto = setup(ms, { navigate: () => {}, crypto: {} });
  await assert.rejects(noCrypto.od.beginRedirect(CLIENT, REDIR), /cannot do the web sign-in/);
});

test('web sign-in: declined, expired, and misregistered apps give plain messages', async () => {
  const ms = fakeMicrosoft(), { od, nav } = webSetup(ms);
  let a = q(await od.beginRedirect(CLIENT, REDIR));
  let r = await od.completeRedirect('?error=access_denied&state=' + a.state);
  assert.equal(r.ok, false); assert.match(r.error, /cancelled or declined/);
  ms.rejectCode = 'AADSTS9002326: Cross-origin token redemption is permitted only for the Single-Page Application client-type.';
  a = q(await od.beginRedirect(CLIENT, REDIR));
  r = await od.completeRedirect('?code=c&state=' + a.state);
  assert.equal(r.ok, false); assert.match(r.error, /Single-page application/); assert.equal((await od.status()).signedIn, false);
  ms.rejectCode = 'AADSTS50011: The redirect URI does not match';
  a = q(await od.beginRedirect(CLIENT, REDIR)); r = await od.completeRedirect('?code=c&state=' + a.state);
  assert.match(r.error, /does not recognise this page address/); void nav;
});

test('web sign-in: the day-long token is renewed silently (prompt=none), not more than once every 10 minutes, and never after Sign out', async () => {
  const ms = fakeMicrosoft(), { od, clock, nav } = webSetup(ms);
  const a = q(await od.beginRedirect(CLIENT, REDIR)); await od.completeRedirect('?code=c&state=' + a.state);
  assert.deepEqual(await od.canRenewSilently(), { ok: true, hint: 'pat@example.com' });
  clock.t += 25 * 3600 * 1000; ms.revoked = true;                      // refresh token has aged out
  await assert.rejects(od.accessToken(), e => e.auth);
  assert.equal((await od.status()).signedIn, false);
  const c = await od.canRenewSilently(); assert.equal(c.ok, true);
  const s = q(await od.beginRedirect(CLIENT, REDIR, { silent: true, loginHint: c.hint }));
  assert.equal(s.prompt, 'none'); assert.equal(s.login_hint, 'pat@example.com'); assert.equal(nav.length, 2);
  assert.equal((await od.canRenewSilently()).ok, false, 'not again straight away');
  const r = await od.completeRedirect('?error=login_required&state=' + s.state);
  assert.deepEqual([r.ok, r.silent, r.needsSignIn], [false, true, true]);
  clock.t += 11 * 60 * 1000; assert.equal((await od.canRenewSilently()).ok, true);
  ms.revoked = false; ms.refresh = 'ref9';
  const s2 = q(await od.beginRedirect(CLIENT, REDIR, { silent: true, loginHint: c.hint }));
  assert.equal((await od.completeRedirect('?code=c2&state=' + s2.state)).ok, true);
  assert.equal((await od.status()).signedIn, true);
  await od.signOut(); assert.deepEqual(await od.canRenewSilently(), { ok: false, hint: '' });
});
