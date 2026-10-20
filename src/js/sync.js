/* Cursus CoS sync adapters.
   An adapter moves one JSON document (the "sync payload" built by core.extractData) to and from somewhere.
   The merge itself (last write wins per record, tombstones for deletes) is core.mergeData, so every
   adapter is just transport:

     pull() -> { data, etag? } | null     (null = nothing there yet)
     push(data, etag?)                     (throw an error with .conflict = true on a lost race)

   Adding another backend (Microsoft Graph / OneDrive, S3, a custom API) means writing one more adapter. */
(function () {
  'use strict';
  const CoS = (window.CoS = window.CoS || {});

  /* A JSON file the desktop app can read and write: OneDrive / Dropbox folder, network share, USB stick. */
  function fileAdapter(host){
    if (!host.fileSync) return null;
    return {
      async pull(){
        const txt = await host.fileSync.read();
        if (!txt) return null;
        try{ return { data: JSON.parse(txt) }; }catch(e){ throw new Error('The sync file is not valid JSON.'); }
      },
      async push(data){ await host.fileSync.write(JSON.stringify(data)); }
    };
  }

  /* Any URL that answers GET and PUT with a JSON document: WebDAV (Nextcloud, ownCloud, a NAS), or a small
     server you write yourself. Uses ETag / If-Match so two devices cannot silently overwrite each other. */
  function httpAdapter(cfg){
    if (!cfg.url) return null;
    const headers = extra => Object.assign({}, cfg.auth ? { Authorization: cfg.auth } : {}, extra || {});
    return {
      async pull(){
        const r = await fetch(cfg.url, { headers: headers({ Accept: 'application/json' }), cache: 'no-store' });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`Server answered ${r.status} ${r.statusText}`.trim());
        const txt = await r.text();
        if (!txt.trim()) return null;
        return { data: JSON.parse(txt), etag: r.headers.get('ETag') || undefined };
      },
      async push(data, etag){
        const r = await fetch(cfg.url, { method: 'PUT', headers: headers(Object.assign({ 'Content-Type': 'application/json' }, etag ? { 'If-Match': etag } : {})), body: JSON.stringify(data) });
        if (r.status === 412){ const e = new Error('Another device updated the data first. Retrying.'); e.conflict = true; throw e; }
        if (!r.ok) throw new Error(`Server answered ${r.status} ${r.statusText}`.trim());
      }
    };
  }

  /* OneDrive (personal Microsoft account): see onedrive.js. One shared instance holds the sign-in and live alerts. */
  CoS.onedrive = CoS.onedriveLib.create({
    http: req => CoS.host.http(req),
    kv: { get: k => CoS.host.kv.get(k), set: (k, v) => CoS.host.kv.set(k, v), remove: k => CoS.host.kv.remove(k) },
    io: () => (typeof window.io === 'function' ? window.io : null),
    navigate: url => { window.location.assign(url); }
  });

  CoS.sync = {
    make(cfg, host){
      if (!cfg || cfg.mode === 'off') return null;
      if (cfg.mode === 'file') return fileAdapter(host);
      if (cfg.mode === 'http') return httpAdapter(cfg);
      if (cfg.mode === 'onedrive') return CoS.onedrive.adapter();
      return null;
    }
  };
})();
