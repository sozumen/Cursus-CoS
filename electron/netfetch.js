/* One HTTPS request for the page, made from the main process (so browser cross-origin rules do not apply).

   Why not net.fetch? Electron's net.fetch hands the Authorization header on to wherever a redirect leads. OneDrive answers a
   file download with a redirect to a pre-signed address on another host, and that host refuses a request carrying a bearer
   token ("unauthenticated"). So redirects are followed here by hand, and the sign-in header is dropped as soon as the
   address changes host. Every hop must also pass the allow-list. */
'use strict';

function create(net, allow){
  const MAX_HOPS = 6;
  const once = (u, method, headers, body) => new Promise((resolve, reject) => {
    let done = false; const end = (fn, v) => { if (!done){ done = true; fn(v); } };
    const req = net.request({ url: u, method, redirect: 'manual' });
    for (const [k, v] of Object.entries(headers || {})) { if (!/^(host|content-length|connection)$/i.test(k) && v != null) { try{ req.setHeader(k, String(v)); }catch(e){} } }
    req.on('redirect', (status, m, url) => { end(resolve, { redirect: url, status }); try{ req.abort(); }catch(e){} });
    req.on('error', e => end(reject, e));
    req.on('abort', () => end(reject, new Error('The request was cancelled.')));
    req.on('response', res => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        const h = {}; for (const [k, v] of Object.entries(res.headers || {})) h[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        end(resolve, { status: res.statusCode, headers: h, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', e => end(reject, e));
    });
    if (body != null && method !== 'GET' && method !== 'HEAD') req.write(Buffer.from(String(body), 'utf8'));
    req.end();
  });

  return async function fetchFollow({ url, method, headers, body }){
    let u = new URL(String(url)), m = String(method || 'GET').toUpperCase(), h = Object.assign({}, headers || {}), b = body;
    for (let hop = 0; hop <= MAX_HOPS; hop++){
      if (!allow(u)) throw new Error('That address is not allowed.');
      const r = await once(u.href, m, h, b);
      if (!r.redirect) return r;
      const next = new URL(r.redirect, u);
      if (next.host !== u.host) for (const k of Object.keys(h)) if (/^(authorization|cookie)$/i.test(k)) delete h[k];
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && m === 'POST')){ m = 'GET'; b = undefined; for (const k of Object.keys(h)) if (/^content-/i.test(k)) delete h[k]; }
      u = next;
    }
    throw new Error('Too many redirects.');
  };
}
module.exports = { create };
