/* Cursus CoS host layer: the ONLY file that knows which platform it is running on.
   The app talks to `CoS.host`; this file maps that onto the right backend:

     web      localStorage, in-page reminders, browser downloads
     desktop  Electron (window.cosHost, from electron/preload.js): files in the user's app-data folder,
              native notifications from the main process (so reminders fire from the tray), file sync
     android  Capacitor plugins: Preferences, LocalNotifications (scheduled with the OS), Filesystem

   Every method is async and safe to call on every platform. Missing features resolve to a no-op. */
(function () {
  'use strict';
  const CoS = (window.CoS = window.CoS || {});
  const el = window.cosHost || null;
  const capObj = window.Capacitor;
  const isCap = !!(capObj && typeof capObj.isNativePlatform === 'function' && capObj.isNativePlatform());
  const platform = el ? 'desktop' : isCap ? 'android' : 'web';
  const P = isCap ? (capObj.Plugins || {}) : {};
  const noop = () => {};

  /* ---------- key/value storage ---------- */
  let kv;
  if (el) kv = el.kv;
  else if (isCap && P.Preferences) kv = {
    get: async key => (await P.Preferences.get({ key })).value,
    set: async (key, value) => { await P.Preferences.set({ key, value }); },
    remove: async key => { await P.Preferences.remove({ key }); }
  };
  else {
    const mem = {};
    kv = {
      async get(key){ try{ const v = localStorage.getItem(key); return v === null ? (mem[key] ?? null) : v; }catch(e){ return mem[key] ?? null; } },
      set(key, value){ try{ localStorage.setItem(key, value); delete mem[key]; return Promise.resolve(); }catch(e){ mem[key] = value; return Promise.reject(e); } },
      async remove(key){ delete mem[key]; try{ localStorage.removeItem(key); }catch(e){} }
    };
  }

  /* ---------- notifications ---------- */
  async function ensureNotifyPermission(){
    try{
      if (platform === 'android' && P.LocalNotifications){
        const cur = await P.LocalNotifications.checkPermissions();
        if (cur.display === 'granted') return true;
        return (await P.LocalNotifications.requestPermissions()).display === 'granted';
      }
      if (platform === 'web' && 'Notification' in window){
        if (Notification.permission === 'granted') return true;
        if (Notification.permission === 'denied') return false;
        return (await Notification.requestPermission()) === 'granted';
      }
    }catch(e){}
    return platform === 'desktop';
  }
  /* Immediate notification. Only the web build needs this (native hosts schedule reminders themselves). */
  async function notify({ title, body }){
    try{
      if (platform === 'web' && 'Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
      else if (el && el.notify) await el.notify({ title, body });
    }catch(e){}
  }
  /* Hand the host every upcoming reminder: [{id:int, taskId, title, at:epochMs}].
     Desktop: the main process fires them (even with the window hidden in the tray).
     Android: they are scheduled as OS local notifications. */
  async function syncReminders(list){
    try{
      if (el && el.setReminders) await el.setReminders(list);
      else if (platform === 'android' && P.LocalNotifications){
        const LN = P.LocalNotifications;
        if ((await LN.checkPermissions()).display !== 'granted') return;
        const pending = await LN.getPending();
        if (pending.notifications && pending.notifications.length) await LN.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) });
        if (list.length) await LN.schedule({ notifications: list.map(r => ({
          id: r.id, title: 'Cursus CoS', body: r.title, schedule: { at: new Date(r.at), allowWhileIdle: true }, extra: { taskId: r.taskId }
        })) });
      }
    }catch(e){}
  }
  function onOpenTask(cb){
    if (el && el.onOpenTask) el.onOpenTask(cb);
    else if (platform === 'android' && P.LocalNotifications) P.LocalNotifications.addListener('localNotificationActionPerformed', ev => {
      const id = ev && ev.notification && ev.notification.extra && ev.notification.extra.taskId; if (id) cb(id);
    });
  }
  /* Android hardware back button. cb returns true if it handled the press. */
  function onBack(cb){
    if (platform === 'android' && P.App) P.App.addListener('backButton', () => { if (!cb() && P.App.minimizeApp) P.App.minimizeApp(); });
  }

  /* ---------- files ---------- */
  async function saveFile({ name, text, mime }){
    try{
      if (el && el.saveFile) return await el.saveFile({ name, text, mime });
      if (platform === 'android' && P.Filesystem){
        const r = await P.Filesystem.writeFile({ path: name, data: text, directory: 'DOCUMENTS', encoding: 'utf8' });
        return { ok: true, where: 'Documents/' + name, uri: r.uri };
      }
      if (window.COS_BUILD === 'single') return { ok: false, error: 'Downloads are not available in the embedded page.' };
      const blob = new Blob([text], { type: mime || 'text/plain' }), a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return { ok: true, where: 'your Downloads folder' };
    }catch(e){ return { ok: false, error: String(e && e.message || e) }; }
  }
  async function openExternal(url){
    try{ if (el && el.openExternal) await el.openExternal(url); else if (/^mailto:/i.test(url)) window.location.href = url; else window.open(url, '_blank', 'noopener'); }catch(e){}
  }
  /* One HTTPS request, returned as { status, headers, text }. The Windows app sends it from the main process and the
     Android app uses the native HTTP layer (see capacitor.config.json), so neither is limited by browser cross-origin rules. */
  async function http({ url, method = 'GET', headers = {}, body }){
    if (el && el.http) return el.http({ url, method, headers, body });
    const r = await fetch(url, { method, headers, body, cache: 'no-store' });
    const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
    return { status: r.status, headers: h, text: await r.text() };
  }
  async function info(){
    if (el && el.info) { try{ return await el.info(); }catch(e){} }
    return { platform, version: '', dataPath: '' };
  }

  CoS.host = {
    platform,
    label: platform === 'desktop' ? 'Windows app' : platform === 'android' ? 'Android app' : 'Web browser',
    caps: {
      nativeReminders: platform !== 'web',
      fileSync: !!(el && el.sync),
      saveFile: true
    },
    ready: () => Promise.resolve(),
    log: text => { try{ if (el && el.log) el.log(text); }catch(e){} },
    kv, http, info, notify, ensureNotifyPermission, syncReminders, onOpenTask, onBack, saveFile, openExternal,
    fileSync: el && el.sync ? el.sync : null
  };
  void noop;
})();
