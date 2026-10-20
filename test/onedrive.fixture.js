const assert = require('node:assert/strict');
const { FILE_PATH } = require('../src/js/onedrive.js');
const CLIENT = '1a2b3c4d-1234-5678-9abc-0123456789ab';
const json = (status, obj) => ({ status, headers: {}, text: JSON.stringify(obj) });

/* A tiny fake of the three Microsoft services involved: sign-in, Graph files, and the live-alert address. */
function fakeMicrosoft(opts = {}){
  const s = { pendingPolls: opts.pendingPolls ?? 2, slowDown: opts.slowDown ?? true, access: 'acc1', refresh: 'ref1', n: 1, file: null, etag: 0, log: [], expireAccessNow: false, revoked: false, subscriptions: 0 };
  const item = () => ({ id: 'x', eTag: 'e' + s.etag, size: s.file.length, '@microsoft.graph.downloadUrl': 'https://dl.test/f' });
  s.http = async ({ url, method = 'GET', headers = {}, body }) => {
    s.log.push(method + ' ' + url.replace(/\?.*/, ''));
    const u = new URL(url);
    if (u.hostname === 'login.microsoftonline.com'){
      const f = Object.fromEntries(new URLSearchParams(body));
      if (u.pathname.endsWith('/devicecode')){
        assert.equal(u.pathname, '/consumers/oauth2/v2.0/devicecode'); assert.equal(f.client_id, CLIENT); assert.match(f.scope, /Files\.ReadWrite/); assert.match(f.scope, /offline_access/);
        return json(200, { device_code: 'dev', user_code: 'ABCD1234', verification_uri: 'https://microsoft.com/link', expires_in: 900, interval: 5 });
      }
      if (f.grant_type === 'urn:ietf:params:oauth:grant-type:device_code'){
        if (s.pendingPolls-- > 0) return json(400, { error: 'authorization_pending' });
        if (s.slowDown){ s.slowDown = false; return json(400, { error: 'slow_down' }); }
        return json(200, { access_token: s.access, refresh_token: s.refresh, expires_in: 3600 });
      }
      if (f.grant_type === 'authorization_code'){
        s.codeRedemptions = (s.codeRedemptions || 0) + 1; s.lastRedeem = f;
        if (s.rejectCode) return json(400, { error: 'invalid_request', error_description: s.rejectCode });
        return json(200, { access_token: s.access, refresh_token: s.refresh, expires_in: 3600 });
      }
      if (f.grant_type === 'refresh_token'){
        if (s.revoked || f.refresh_token !== s.refresh) return json(400, { error: 'invalid_grant', error_description: 'AADSTS70000 revoked\r\nTrace' });
        s.n++; s.access = 'acc' + s.n; s.refresh = 'ref' + s.n;
        return json(200, { access_token: s.access, refresh_token: s.refresh, expires_in: 3600 });
      }
    }
    if (u.hostname === 'dl.test'){ assert.equal(headers.Authorization, undefined, 'download URL must not get the token'); return { status: 200, headers: {}, text: s.file }; }
    // Graph
    assert.equal(u.hostname, 'graph.microsoft.com');
    if (s.expireAccessNow && headers.Authorization === 'Bearer ' + s.access){ s.expireAccessNow = false; s.access = 'rotated'; return json(401, { error: { message: 'expired' } }); }
    if (headers.Authorization !== 'Bearer ' + s.access) return json(401, { error: { message: 'bad token' } });
    if (u.pathname === '/v1.0/me') return json(200, { displayName: 'Pat', userPrincipalName: 'pat@example.com' });
    if (u.pathname === '/v1.0/me/drive/root/subscriptions/socketIo'){ s.subscriptions++; assert.equal(headers['Content-Type'], 'application/json'); return json(200, { notificationUrl: 'https://ws.test/cb?k=' + s.subscriptions }); }
    const itemUrl = '/v1.0/me/drive/root:/' + FILE_PATH.split('/').map(encodeURIComponent).join('/');
    if (u.pathname === itemUrl && method === 'GET'){ if (s.file == null) return json(404, { error: { code: 'itemNotFound' } }); return json(200, item()); }
    if (u.pathname === itemUrl + ':/content' && method === 'PUT'){
      if (headers['If-Match']){ if (s.file == null || headers['If-Match'] !== 'e' + s.etag) return json(412, { error: { code: 'preconditionFailed' } }); }
      else if (s.file != null || u.searchParams.get('@microsoft.graph.conflictBehavior') !== 'fail') return json(409, { error: { code: 'nameAlreadyExists' } });
      s.file = body; s.etag++; return json(headers['If-Match'] ? 200 : 201, item());
    }
    return json(404, { error: { code: 'unknown ' + method + ' ' + u.pathname } });
  };
  return s;
}
function fakeIo(){
  const sockets = [];
  const io = (url, o) => {
    const h = {}, sk = { url, o, closed: false, on(e, f){ h[e] = f; }, removeAllListeners(){ Object.keys(h).forEach(k => delete h[k]); }, close(){ this.closed = true; }, emit(e, ...a){ h[e] && h[e](...a); } };
    sockets.push(sk); return sk;
  };
  io.sockets = sockets; return io;
}

module.exports = { CLIENT, json, fakeMicrosoft, fakeIo };
