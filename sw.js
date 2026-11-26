// Network-first with cache fallback, so Blip opens offline.
// Bump CACHE when you change app files so old copies are dropped.
const CACHE = 'blip-v62';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'assets/brand/brand-tokens.css', 'assets/logo/symbol-color.svg', 'icons/app-icon-192.png', 'icons/app-icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'config.js', 'sync.js', 'avatars.js', 'headlines.js', 'reminders.js', 'whatsnew.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== self.location.origin) return;
  // Tour videos stream straight from the network; they're too big to cache.
  if (new URL(e.request.url).pathname.includes('/tour/')) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// A reminder pushed by the server while Blip may be closed.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Blip', body: e.data?.text() || '' }; }
  const title = d.title || 'Blip reminder';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: 'icons/app-icon-192.png',
    badge: 'icons/app-icon-192.png',
    tag: d.tag || `blip-${d.taskId || 'x'}`,
    renotify: true,
    requireInteraction: Boolean(d.now),
    vibrate: [120, 80, 120, 80, 360], // Blip's buzz: short, short, long
    timestamp: d.ts || Date.now(),
    data: { taskId: d.taskId || null },
  }));
});

// Tapping a reminder focuses Blip (or opens it) on that task.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const taskId = e.notification.data?.taskId;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      if (taskId) win.postMessage({ type: 'open-task', taskId });
      return;
    }
    const url = new URL('./', self.registration.scope);
    if (taskId) url.searchParams.set('task', taskId);
    await self.clients.openWindow(url.href);
  })());
});
