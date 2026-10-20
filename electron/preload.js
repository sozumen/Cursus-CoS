/* Exposes a small, explicit API to the page as window.cosHost. The page gets no Node access.
   src/js/host.js is the only code that reads this. */
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('cosHost', {
  platform: 'desktop',
  kv: {
    get: key => call('kv:get', key),
    set: (key, value) => call('kv:set', key, value),
    remove: key => call('kv:remove', key)
  },
  info: () => call('app:info'),
  log: text => call('log:write', String(text).slice(0, 4000)),
  http: req => call('net:fetch', req),
  loopback: { start: () => call('loopback:start'), wait: () => call('loopback:wait'), cancel: () => call('loopback:cancel') },
  setReminders: list => call('reminders:set', list),
  notify: opts => call('notify', opts),
  saveFile: opts => call('file:save', opts),
  openExternal: url => call('open-external', url),
  onOpenTask: cb => { ipcRenderer.on('open-task', (e, id) => cb(id)); },
  sync: {
    path: () => call('sync:path'),
    choose: () => call('sync:choose'),
    read: () => call('sync:read'),
    write: text => call('sync:write', text),
    onChange: cb => { ipcRenderer.on('sync-changed', () => cb()); }
  }
});
