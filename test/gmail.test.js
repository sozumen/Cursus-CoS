const test = require('node:test');
const assert = require('node:assert/strict');
const { create, CLIENT_RE } = require('../src/js/gmail.js');
const ingest = require('../src/js/ingest.js');

const CLIENT = '123456789012-abcdefghijk.apps.googleusercontent.com', SECRET = 'GOCSPX-secret';
const json = (status, o) => ({ status, headers: {}, text: JSON.stringify(o) });
const b64 = s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* A fake Google: OAuth token endpoint, Gmail profile / search / message. */
function fakeGoogle(messages){
  const g = { log: [], access: 'acc1', refresh: 'ref1', n: 0, revoked: false, expiresIn: 3600, messages };
  g.http = async r => {
    g.log.push(r.method + ' ' + r.url.replace(/\?.*/, ''));
    if (r.url.startsWith('https://oauth2.googleapis.com/token')){
      const b = new URLSearchParams(r.body);
      if (b.get('client_id') !== CLIENT || b.get('client_secret') !== SECRET) return json(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
      if (b.get('grant_type') === 'authorization_code'){
        if (b.get('code') !== 'CODE' || !b.get('code_verifier')) return json(400, { error: 'invalid_grant', error_description: 'Bad code' });
        return json(200, g.noRefresh ? { access_token: g.access, expires_in: g.expiresIn } : { access_token: g.access, expires_in: g.expiresIn, refresh_token: g.refresh });
      }
      if (g.revoked) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      g.access = 'acc' + (++g.n + 1); return json(200, { access_token: g.access, expires_in: g.expiresIn });
    }
    if ((r.headers.Authorization || '') !== 'Bearer ' + g.access) return json(401, { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } });
    if (r.url.endsWith('/profile')) return json(200, { emailAddress: 'Me@Gmail.com' });
    if (r.url.includes('/messages?')){ g.query = decodeURIComponent((/q=([^&]*)/.exec(r.url) || [])[1] || ''); return json(200, { messages: g.messages.map(m => ({ id: m.id, threadId: m.threadId })) }); }
    const m = g.messages.find(x => r.url.includes('/messages/' + x.id));
    return m ? json(200, m) : json(404, { error: { message: 'Not Found' } });
  };
  return g;
}
const msg = (id, subject, text, from = 'Me <me@gmail.com>', thread = 't' + id) => ({ id, threadId: thread, internalDate: String(Date.UTC(2026, 9, 20, 12)), payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: subject }, { name: 'From', value: from }], parts: [{ mimeType: 'text/plain', body: { data: b64(text) } }, { mimeType: 'text/html', body: { data: b64('<p>' + text + '</p>') } }] } });

function setup(g, extra){
  const store = {}, clock = { t: 1e12 };
  const deps = Object.assign({ http: g.http, now: () => clock.t, kv: { get: async k => store[k] ?? null, set: async (k, v) => { store[k] = v; }, remove: async k => { delete store[k]; } },
    openExternal: async u => { deps.opened = u; }, crypto: globalThis.crypto,
    loopback: { start: async () => ({ port: 4567 }), wait: async () => { const u = new URL(deps.opened); return { code: 'CODE', state: u.searchParams.get('state') }; } } }, extra);
  return { gm: create(deps), store, clock, deps };
}

test('sign in: browser opens at Google with PKCE and read-only scope, the answer is exchanged, the address is learned', async () => {
  const g = fakeGoogle([]), { gm, store, deps } = setup(g);
  const r = await gm.signIn(CLIENT, SECRET);
  const u = new URL(deps.opened);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:4567'); assert.equal(u.searchParams.get('code_challenge_method'), 'S256'); assert.equal(u.searchParams.get('code_challenge').length, 43);
  assert.equal(r.email, 'me@gmail.com');
  const saved = JSON.parse(store['cos.gmailauth']); assert.equal(saved.refresh, 'ref1'); assert.equal((await gm.status()).signedIn, true);
});
test('sign in: bad client id, missing secret, wrong secret, declined, wrong state, no refresh token', async () => {
  const g = fakeGoogle([]);
  await assert.rejects(setup(g).gm.signIn('nope', SECRET), /client ID/);
  await assert.rejects(setup(g).gm.signIn(CLIENT, ''), /secret/);
  await assert.rejects(setup(g).gm.signIn(CLIENT, 'WRONG'), /client ID and secret together/);
  await assert.rejects(setup(g, { loopback: { start: async () => ({ port: 1 }), wait: async () => ({ error: 'access_denied' }) } }).gm.signIn(CLIENT, SECRET), /declined/);
  await assert.rejects(setup(g, { loopback: { start: async () => ({ port: 1 }), wait: async () => ({ code: 'CODE', state: 'other' }) } }).gm.signIn(CLIENT, SECRET), /did not match/);
  g.noRefresh = true; await assert.rejects(setup(g).gm.signIn(CLIENT, SECRET), /stay signed in/);
  assert.ok(CLIENT_RE.test(CLIENT));
});
test('reading: searches recent tagged mail, downloads only unseen messages, decodes text/plain, falls back to html', async () => {
  const html = { id: 'h1', threadId: 'th', internalDate: '1', payload: { mimeType: 'text/html', headers: [{ name: 'Subject', value: '#task html only' }, { name: 'From', value: '"Pat" <pat@x.com>' }], body: { data: b64('<div>Hello<br>there &amp; you</div>') } } };
  const g = fakeGoogle([msg('m1', 'Buy paper #task', 'two reams é'), msg('m2', '#sub Review: x', ''), html]), { gm } = setup(g);
  await gm.signIn(CLIENT, SECRET);
  const r = await gm.fetchRecent({ days: 3, skip: new Set(['m2']) });
  assert.match(g.query, /newer_than:3d subject:\(task OR sub OR subdone/);
  assert.deepEqual(r.messages.map(m => m.id), ['m1', 'h1']);
  assert.equal(r.messages[0].from, 'me@gmail.com'); assert.equal(r.messages[0].body, 'two reams é'); assert.equal(r.messages[0].subject, 'Buy paper #task');
  assert.equal(r.messages[1].fromName, 'Pat'); assert.match(r.messages[1].body, /Hello\nthere & you/);
  assert.ok(!g.log.some(l => l.includes('/messages/m2')), 'a message already dealt with is not downloaded again');
});
test('tokens: renewed only when expired, a revoked sign-in is cleared with the reason, no token loop on a 401', async () => {
  const g = fakeGoogle([]), { gm, clock, store } = setup(g);
  await gm.signIn(CLIENT, SECRET);
  const tokenCalls = () => g.log.filter(l => /oauth2/.test(l)).length;
  const before = tokenCalls(); await gm.fetchRecent(); await gm.fetchRecent(); assert.equal(tokenCalls(), before, 'fresh token reused');
  clock.t += 3600 * 1000; await gm.fetchRecent(); assert.equal(tokenCalls(), before + 1, 'renewed once after expiry');
  g.access = 'something else'; await assert.rejects(gm.fetchRecent(), e => e.auth && /sign in again/i.test(e.message)); assert.equal(tokenCalls(), before + 1, 'a 401 does not trigger more token requests');
  g.access = 'acc2'; g.revoked = true; clock.t += 3600 * 1000;
  await assert.rejects(gm.fetchRecent(), e => e.auth && /invalid_grant/.test(e.message));
  assert.equal(store['cos.gmailauth'], undefined); const st = await gm.status(); assert.equal(st.signedIn, false); assert.match(st.error, /invalid_grant/);
});

/* ---------- reading the tags ---------- */
const T = (title, ext, extra) => Object.assign({ title, external: ext || null, subitems: [] }, extra || {});
const OWN = 'me@gmail.com';
test('tags: #task, #sub and #subdone in the subject or on the first line, with Re:/Fwd: ignored', () => {
  assert.deepEqual(ingest.parseTag('Buy paper #task', ''), { kind: 'task', text: 'Buy paper', where: 'subject' });
  assert.equal(ingest.parseTag('#sub Review: send it', '').kind, 'sub');
  assert.equal(ingest.parseTag('Re: Fwd: #subdone Review: sent', '').text, 'Review: sent');
  assert.equal(ingest.parseTag('(#SubDone) Review: sent', '').kind, 'subdone');
  const b = ingest.parseTag('Re: Call vendor', '\n#subdone got the quote\nthanks');
  assert.equal(b.kind, 'subdone'); assert.equal(b.text, 'got the quote'); assert.equal(b.where, 'body');
  assert.equal(ingest.parseTag('about the subtle subject', 'nothing'), null); assert.equal(ingest.parseTag('#tasks list', ''), null);
});
test('plan: new tasks, subtasks by title or thread, completion ticks an existing item, strangers and untagged mail are skipped', () => {
  const open = [T('Quarterly review'), T('Renew cloud hosting contract'), T('Call vendor', { source: 'gmail', threadId: 'T1' }), T('Vendor quotes')];
  const plan = (m, cfg) => ingest.planGmail(Object.assign({ from: OWN, body: '' }, m), open, cfg || {}, OWN);
  let p = plan({ id: '1', subject: 'Buy printer paper #task', body: 'two reams' }); assert.equal(p.action, 'task'); assert.equal(p.draft.title, 'Buy printer paper'); assert.deepEqual(p.draft.tags, ['email']); assert.equal(p.draft.external.source, 'gmail');
  p = plan({ id: '2', subject: '#sub Quarterly review: send invoice' }); assert.equal(p.action, 'sub'); assert.equal(p.parent.title, 'Quarterly review'); assert.equal(p.title, 'send invoice'); assert.equal(p.done, false);
  p = plan({ id: '3', subject: 'Re: Call vendor', threadId: 'T1', body: '#subdone got the quote' }); assert.equal(p.parent.title, 'Call vendor'); assert.equal(p.done, true); assert.equal(p.title, 'got the quote');
  p = plan({ id: '4', subject: '#subdone cloud hosting: sign the order' }); assert.equal(p.parent.title, 'Renew cloud hosting contract', 'closest title');
  p = plan({ id: '5', subject: '#sub Nonexistent thing: step' }); assert.equal(p.action, 'task'); assert.match(p.note, /No task matched/); assert.equal(p.draft.title, 'Nonexistent thing: step');
  assert.equal(plan({ id: '6', subject: 'hello' }).reason, 'no tag');
  assert.equal(plan({ id: '7', subject: '#task spam', from: 'evil@x.com' }).reason, 'sender');
  assert.equal(plan({ id: '8', subject: '#task from a friend', from: 'friend@x.com' }, { allowFrom: 'friend@x.com, other@x.com' }).action, 'task');
  p = plan({ id: '9', subject: '#sub Quarterly review' }); assert.equal(p.action, 'task'); assert.match(p.note, /did not say which task/);
  p = plan({ id: '10', subject: '#sub quarterly review of vendors: typo' }); assert.equal(p.parent.title, 'Quarterly review', 'the title is part of what was written');
  p = plan({ id: '11', subject: '#sub totally different words: step' }); assert.equal(p.action, 'task', 'a weak match is never guessed');
});
