/* Cursus CoS: Windows (Electron) main process.
   Responsibilities the web page cannot do on its own:
     - keep data in files in the user's app-data folder (not browser storage)
     - fire reminders as native notifications, even when the window is closed to the tray
     - read/write a shared sync file (e.g. inside a OneDrive folder) and watch it for changes
     - native Save dialog for backups
   The UI itself is the same www/ build used on every platform. */
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, dialog, shell, nativeImage, nativeTheme, net } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const APP_ID = 'com.cursus.cos';

/* A crash leaves a note in %APPDATA%\Cursus CoS\crash.log (and a message box for errors in this process) so a failure can be diagnosed. */
function logCrash(kind, detail){
  try{ const f = path.join(app.getPath('userData'), 'crash.log'); fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${new Date().toISOString()} v${app.getVersion()} ${process.platform} ${kind}: ${detail && detail.stack ? detail.stack : (typeof detail === 'string' ? detail : JSON.stringify(detail))}\n`); }catch(e){}
}
process.on('uncaughtException', err => { logCrash('uncaughtException', err); try{ dialog.showErrorBox('Cursus CoS hit a problem', String(err && err.message || err) + '\n\nDetails are saved in crash.log in ' + app.getPath('userData')); }catch(e){} });
process.on('unhandledRejection', err => logCrash('unhandledRejection', err));
app.on('render-process-gone', (e, wc, d) => logCrash('render-process-gone', d));
app.on('child-process-gone', (e, d) => logCrash('child-process-gone', d));
/* Safe graphics: if the window crashes or stays blank on a particular PC (usually a graphics-driver problem), turn off GPU
   acceleration. Start with the --disable-gpu switch, or tick "Safe graphics mode" in the tray menu (takes effect on restart). */
try{ if (process.argv.includes('--disable-gpu') || JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8')).safeGraphics) app.disableHardwareAcceleration(); }catch(e){ if (process.argv.includes('--disable-gpu')) app.disableHardwareAcceleration(); }
app.setAppUserModelId(APP_ID);                 // required for Windows toast notifications
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const INDEX = path.join(__dirname, '..', 'www', 'index.html');
let win = null, tray = null, quitting = false;

/* ---------- small JSON config + key/value files ---------- */
const dataDir = () => path.join(app.getPath('userData'), 'data');
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { closeToTray: true, bounds: null, syncFile: '', safeGraphics: false };
function loadCfg(){ try{ cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile(), 'utf8'))); }catch(e){} }
function saveCfg(){ try{ fs.mkdirSync(path.dirname(cfgFile()), { recursive: true }); fs.writeFileSync(cfgFile(), JSON.stringify(cfg)); }catch(e){} }
async function writeAtomic(file, text){
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}
const kvFile = key => path.join(dataDir(), encodeURIComponent(key) + '.json');

/* ---------- window ---------- */
function createWindow(){
  const b = cfg.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1320, height: b.height || 860, x: b.x, y: b.y, minWidth: 380, minHeight: 560,
    show: false, title: 'Cursus CoS', icon: ICON, autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c1315' : '#e8edee',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true }
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => logCrash('did-fail-load', code + ' ' + desc + ' ' + url));
  win.webContents.on('unresponsive', () => logCrash('unresponsive', 'window not responding'));
  win.loadFile(INDEX);
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  win.on('close', e => {
    cfg.bounds = win.isMaximized() || win.isMinimized() ? cfg.bounds : win.getBounds(); saveCfg();
    if (!quitting && cfg.closeToTray){ e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
}
function showWindow(){ if (!win) createWindow(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function buildMenu(){
  const dev = !app.isPackaged;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(dev ? [{ role: 'reload' }, { role: 'toggleDevTools' }] : [])] }
  ]));
}
function buildTray(){
  let img = nativeImage.createFromPath(ICON); if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Cursus CoS');
  const refresh = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Cursus CoS', click: showWindow },
    { type: 'separator' },
    { label: 'Keep running in the tray when closed', type: 'checkbox', checked: cfg.closeToTray, click: m => { cfg.closeToTray = m.checked; saveCfg(); } },
    { label: 'Safe graphics mode (restart to apply)', type: 'checkbox', checked: !!cfg.safeGraphics, click: m => { cfg.safeGraphics = m.checked; saveCfg(); } },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: m => app.setLoginItemSettings({ openAtLogin: m.checked, args: ['--hidden'] }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
  refresh();
  tray.on('click', showWindow);
}

/* ---------- reminders ---------- */
let reminders = [];           // [{id, taskId, title, at}]
const fired = new Set();
function checkReminders(){
  const now = Date.now();
  for (const r of reminders){
    const key = r.id + ':' + r.at;
    if (r.at > now || fired.has(key)) continue;
    fired.add(key);
    if (win && win.isVisible() && win.isFocused()) continue;      // the page already shows a toast
    if (!Notification.isSupported()) continue;
    const n = new Notification({ title: 'Cursus CoS', body: r.title, icon: ICON });
    n.on('click', () => { showWindow(); if (win) win.webContents.send('open-task', r.taskId); });
    n.show();
  }
  reminders = reminders.filter(r => r.at > now - 6e4 && !fired.has(r.id + ':' + r.at));
}
setInterval(checkReminders, 15000);

/* ---------- sync file ---------- */
let watcher = null, lastWrite = 0, watchTimer = null;
function watchSyncFile(){
  if (watcher){ try{ watcher.close(); }catch(e){} watcher = null; }
  if (!cfg.syncFile) return;
  try{
    watcher = fs.watch(path.dirname(cfg.syncFile), (ev, name) => {
      if (!name || name !== path.basename(cfg.syncFile) || Date.now() - lastWrite < 1500) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { if (win) win.webContents.send('sync-changed'); }, 400);
    });
  }catch(e){}
}

/* ---------- IPC ---------- */
const handle = (ch, fn) => ipcMain.handle(ch, (ev, ...a) => fn(...a));
handle('kv:get', async key => { try{ return await fsp.readFile(kvFile(key), 'utf8'); }catch(e){ return null; } });
handle('kv:set', async (key, value) => { await writeAtomic(kvFile(key), String(value)); });
handle('kv:remove', async key => { try{ await fsp.unlink(kvFile(key)); }catch(e){} });
/* HTTPS requests for OneDrive sign-in and sync, made here so the page is not subject to browser cross-origin rules.
   Only Microsoft hosts are allowed. */
const NET_HOSTS = ['microsoftonline.com', 'microsoft.com', 'microsoftpersonalcontent.com', '1drv.com', '1drv.ms', 'sharepoint.com', 'onedrive.com', 'live.com', 'svc.ms'];
handle('net:fetch', async ({ url, method, headers, body }) => {
  const u = new URL(String(url));
  if (u.protocol !== 'https:' || !NET_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) throw new Error('That address is not allowed.');
  const doFetch = net && net.fetch ? net.fetch.bind(net) : fetch;
  const r = await doFetch(u.href, { method: String(method || 'GET'), headers: headers || {}, body: body == null ? undefined : String(body), redirect: 'follow' });
  const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
  return { status: r.status, headers: h, text: await r.text() };
});
handle('log:write', async text => { logCrash('page', String(text)); });
handle('app:info', async () => ({ platform: 'desktop', os: process.platform, version: app.getVersion(), dataPath: dataDir() }));
handle('reminders:set', async list => { reminders = Array.isArray(list) ? list.filter(r => r && Number.isFinite(r.at)) : []; checkReminders(); });
handle('notify', async ({ title, body }) => { if (Notification.isSupported()) new Notification({ title: String(title || 'Cursus CoS'), body: String(body || ''), icon: ICON }).show(); });
handle('open-external', async url => { if (/^https?:|^mailto:/i.test(String(url))) await shell.openExternal(String(url)); });
handle('file:save', async ({ name, text }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return { ok: false, error: 'Cancelled' };
  await writeAtomic(r.filePath, text);
  return { ok: true, where: r.filePath };
});
handle('sync:path', async () => cfg.syncFile || '');
handle('sync:choose', async () => {
  const r = await dialog.showSaveDialog(win, { title: 'Choose or create the sync file', defaultPath: cfg.syncFile || path.join(app.getPath('documents'), 'cursus-cos-sync.json'), buttonLabel: 'Use this file', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  cfg.syncFile = r.filePath; saveCfg(); watchSyncFile();
  return cfg.syncFile;
});
handle('sync:read', async () => {
  if (!cfg.syncFile) throw new Error('Choose a sync file first.');
  try{ return await fsp.readFile(cfg.syncFile, 'utf8'); }catch(e){ if (e.code === 'ENOENT') return null; throw e; }
});
handle('sync:write', async text => {
  if (!cfg.syncFile) throw new Error('Choose a sync file first.');
  lastWrite = Date.now(); await writeAtomic(cfg.syncFile, String(text)); lastWrite = Date.now();
});

/* ---------- lifecycle ---------- */
app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (quitting || !cfg.closeToTray) app.quit(); });
app.whenReady().then(() => {
  loadCfg(); buildMenu(); createWindow(); try{ buildTray(); }catch(e){ logCrash('tray', e); } watchSyncFile();
  app.on('activate', () => { if (!win) createWindow(); });
});
