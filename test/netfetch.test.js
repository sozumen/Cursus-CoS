const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../electron/netfetch.js');
const { EventEmitter } = require('node:events');

/* A stand-in for Electron's net.request: `routes` maps a URL to { redirect } or { status, text }. */
function fakeNet(routes, log){
  return { request({ url, method }){
    const req = new EventEmitter(); const headers = {};
    req.setHeader = (k, v) => { headers[k.toLowerCase()] = v; }; req.write = () => {}; req.abort = () => {};
    req.end = () => setImmediate(() => {
      log.push({ url, method, auth: headers.authorization || null });
      const r = routes[url] || { status: 404, text: '' };
      if (r.redirect) return req.emit('redirect', 302, 'GET', r.redirect, {});
      const res = new EventEmitter(); res.statusCode = r.status; res.headers = { 'Content-Type': 'text/plain' };
      req.emit('response', res); res.emit('data', Buffer.from(r.text)); res.emit('end');
    });
    return req;
  } };
}
test('redirects are followed by hand and the sign-in header is dropped when the host changes', async () => {
  const log = [];
  const net = fakeNet({
    'https://graph.microsoft.com/v1.0/x:/content': { redirect: 'https://public.bn.files.1drv.com/y/file' },
    'https://public.bn.files.1drv.com/y/file': { status: 200, text: 'THE FILE' },
    'https://graph.microsoft.com/a': { redirect: '/b' }, 'https://graph.microsoft.com/b': { status: 200, text: 'same host' }
  }, log);
  const f = create(net, u => u.protocol === 'https:');
  let r = await f({ url: 'https://graph.microsoft.com/v1.0/x:/content', method: 'GET', headers: { Authorization: 'Bearer t', Accept: 'application/json' } });
  assert.equal(r.status, 200); assert.equal(r.text, 'THE FILE'); assert.equal(r.headers['content-type'], 'text/plain');
  assert.deepEqual(log.map(l => l.auth), ['Bearer t', null], 'no token sent to the download host');
  log.length = 0;
  r = await f({ url: 'https://graph.microsoft.com/a', method: 'GET', headers: { Authorization: 'Bearer t' } });
  assert.equal(r.text, 'same host'); assert.deepEqual(log.map(l => l.auth), ['Bearer t', 'Bearer t'], 'same host keeps it');
});
test('every hop must pass the allow-list, and redirect loops stop', async () => {
  const log = [];
  const net = fakeNet({ 'https://graph.microsoft.com/a': { redirect: 'https://evil.example/steal' }, 'https://graph.microsoft.com/loop': { redirect: 'https://graph.microsoft.com/loop' } }, log);
  const f = create(net, u => u.hostname.endsWith('microsoft.com'));
  await assert.rejects(f({ url: 'https://graph.microsoft.com/a', method: 'GET', headers: { Authorization: 'x' } }), /not allowed/);
  assert.equal(log.length, 1, 'the disallowed address was never requested');
  await assert.rejects(f({ url: 'https://graph.microsoft.com/loop', method: 'GET', headers: {} }), /Too many redirects/);
});
