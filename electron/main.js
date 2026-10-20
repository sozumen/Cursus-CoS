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
    { label: 'Check for updates (version ' + app.getVersion() + ')', click: () => checkForUpdates(true) },
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
const NET_HOSTS = ['microsoftonline.com', 'microsoft.com', 'microsoftpersonalcontent.com', '1drv.com', '1drv.ms', 'sharepoint.com', 'onedrive.com', 'live.com', 'svc.ms', 'livefilestore.com', 'microsoftusercontent.com', 'googleapis.com', 'google.com'];
const netFetch = require('./netfetch.js').create(net, u => u.protocol === 'https:' && NET_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h)));
handle('net:fetch', async ({ url, method, headers, body }) => netFetch({ url, method, headers, body }));
/* Sign-in for Google (Gmail): Google sends the browser back to http://127.0.0.1:<port>. This runs a one-shot web server for that,
   only while a sign-in is waiting, and only answers the one request that carries Google's answer. */
let loop = null;
const closeLoop = () => { if (loop){ try{ loop.server.close(); }catch(e){} clearTimeout(loop.timer); loop = null; } };
handle('loopback:start', async () => {
  closeLoop();
  const http = require('http'); let done; const answer = new Promise(r => { done = r; });
  const server = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://127.0.0.1').searchParams;
    if (!q.get('code') && !q.get('error')){ res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><meta charset="utf-8"><title>Cursus CoS</title><body style="font:16px system-ui;margin:12vh auto;max-width:28em;text-align:center"><h2>All done</h2><p>You are connected to Cursus CoS. You can close this tab and go back to the app.</p></body>');
    done({ code: q.get('code') || '', state: q.get('state') || '', error: q.get('error') || '', error_description: q.get('error_description') || '' });
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  loop = { server, answer, timer: 0 };
  return { port: server.address().port };
});
handle('loopback:wait', async () => {
  if (!loop) throw new Error('No sign-in is waiting.');
  const me = loop;
  const timeout = new Promise((_, no) => { me.timer = setTimeout(() => no(new Error('The sign-in took too long. Try again.')), 5 * 60 * 1000); });
  try{ return await Promise.race([me.answer, timeout]); } finally { if (loop === me) closeLoop(); }
});
handle('loopback:cancel', async () => { closeLoop(); });
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

/* ---------- safety net: a dated copy of the data, once a day ----------
   Updates never touch the data folder, but a bad release should never be able to cost you your tasks. The last 7 days are kept
   in  %APPDATA%\Cursus CoS\backups  (copy a folder back into  data  to go back to that day). */
async function dailyBackup(){
  try{
    const day = new Date().toISOString().slice(0, 10), root = path.join(app.getPath('userData'), 'backups'), dest = path.join(root, day);
    if (!fs.existsSync(dataDir()) || fs.existsSync(dest)) return;
    await fsp.mkdir(dest, { recursive: true });
    for (const f of await fsp.readdir(dataDir())) if (f.endsWith('.json')) await fsp.copyFile(path.join(dataDir(), f), path.join(dest, f));
    const old = (await fsp.readdir(root)).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().slice(0, -7);
    for (const n of old) await fsp.rm(path.join(root, n), { recursive: true, force: true });
  }catch(e){ logCrash('backup', e); }
}

/* ---------- updates ----------
   The installed (Setup) app checks the GitHub Releases page for a newer version, downloads it in the background and offers to
   restart. Your data lives in %APPDATA%, outside the program folder, so it is carried over untouched. The portable exe and
   development runs do not update themselves. */
let updater = null, updateState = { status: 'idle', version: '' };
function setupUpdates(){
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;
  try{ updater = require('electron-updater').autoUpdater; }catch(e){ logCrash('update', e); return; }
  updater.autoDownload = true; updater.autoInstallOnAppQuit = true; updater.logger = null;
  updater.on('checking-for-update', () => { updateState.status = 'checking'; });
  updater.on('update-not-available', () => { updateState.status = 'current'; });
  updater.on('update-available', info => { updateState = { status: 'downloading', version: info.version }; });
  updater.on('error', e => { updateState.status = 'error'; logCrash('update', e); });
  updater.on('update-downloaded', async info => {
    updateState = { status: 'ready', version: info.version };
    const r = await dialog.showMessageBox(win && win.isVisible() ? win : undefined, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1, title: 'Cursus CoS update',
      message: 'Version ' + info.version + ' is ready.', detail: 'Your tasks and settings are kept. Restart to finish updating, or it will install the next time you quit.' });
    if (r.response === 0){ quitting = true; updater.quitAndInstall(); }
  });
}
function checkForUpdates(manual){
  if (!updater){ if (manual) dialog.showMessageBox({ type: 'info', title: 'Cursus CoS', message: 'Updates are only checked in the installed app.', detail: 'This copy (portable or development) does not update itself. Install the Setup version from the project\'s Releases page.' }); return; }
  updater.checkForUpdates().then(r => {
    if (manual && r && r.updateInfo && r.updateInfo.version === app.getVersion()) dialog.showMessageBox({ type: 'info', title: 'Cursus CoS', message: 'You have the latest version (' + app.getVersion() + ').' });
  }).catch(e => { logCrash('update', e); if (manual) dialog.showErrorBox('Could not check for updates', String(e && e.message || e)); });
}

/* ---------- lifecycle ---------- */
app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (quitting || !cfg.closeToTray) app.quit(); });
app.whenReady().then(() => {
  loadCfg(); dailyBackup(); buildMenu(); createWindow(); try{ buildTray(); }catch(e){ logCrash('tray', e); } watchSyncFile();
  setupUpdates(); setTimeout(() => checkForUpdates(false), 15000); setInterval(() => checkForUpdates(false), 6 * 3600 * 1000);
  app.on('activate', () => { if (!win) createWindow(); });
});
