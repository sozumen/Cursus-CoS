/* Service worker for the installable web (PWA) build only. The build script fills in the file list.
   The Windows (Electron) and Android (Capacitor) apps ship their files inside the app and never load this. */
const CACHE = 'cursus-cos-__BUILD__';
const OLD_PREFIX = 'cos-tasks-';   // caches from the earlier name, deleted on activate
const FILES = __FILES__;
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => (k.startsWith('cursus-cos-') || k.startsWith(OLD_PREFIX)) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));   // ignoreSearch: the page also opens as /?code=... when Microsoft sends you back after sign-in
});
