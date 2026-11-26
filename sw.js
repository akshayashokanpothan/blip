// Network-first with cache fallback, so Blip opens offline.
// Bump CACHE when you change app files so old copies are dropped.
const CACHE = 'blip-v77';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'assets/brand/brand-tokens.css', 'assets/logo/symbol-color.svg', 'icons/app-icon-192.png', 'icons/app-icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'config.js', 'sync.js', 'avatars.js', 'headlines.js', 'reminders.js', 'whatsnew.js', 'summary.js'];

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
    actions: taskActions(d.taskId),
    data: { taskId: d.taskId || null, act: d.act || null },
  }));
});

// Done and Snooze buttons, on task reminders only (not the day summary).
const SNOOZE_MIN = 10;
function taskActions(taskId) {
  if (!taskId || String(taskId).startsWith('summary-')) return [];
  return [{ action: 'done', title: 'Done' }, { action: 'snooze', title: `Snooze ${SNOOZE_MIN} min` }];
}
const blipWindow = async () => {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return wins.find((w) => new URL(w.url).origin === self.location.origin);
};

// A button on a reminder. With Blip open, the app does it. With Blip closed,
// the server does it (signed by send-reminders); failing that, Blip opens to do it.
async function runAction(action, n) {
  const { taskId, act } = n.data || {};
  const win = await blipWindow();
  if (win) { win.postMessage({ type: 'task-action', action, taskId }); return; }
  if (act?.api && act.sig) {
    try {
      const res = await fetch(`${act.api}/functions/v1/reminder-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, taskId, uid: act.uid, fireAt: act.fireAt, sig: act.sig, title: n.title, body: n.body }),
      });
      if (res.ok) return;
    } catch { /* offline: open Blip instead */ }
  }
  const url = new URL('./', self.registration.scope);
  url.searchParams.set('task', taskId);
  url.searchParams.set('act', action);
  await self.clients.openWindow(url.href);
}

// Tapping a reminder focuses Blip (or opens it) on that task.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const taskId = e.notification.data?.taskId;
  if ((e.action === 'done' || e.action === 'snooze') && taskId) {
    e.waitUntil(runAction(e.action, e.notification));
    return;
  }
  e.waitUntil((async () => {
    const win = await blipWindow();
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
