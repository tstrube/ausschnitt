// Two jobs: a friendly offline page, and showing new-page notifications
// (see src/newPageNotifier.ts).
//
// Network-wise it's deliberately minimal: everything goes to the network
// exactly as without a service worker (the app is useless without its
// server anyway, and caching dynamic pages would risk showing stale reading
// positions). It only swaps in the offline page when a page navigation
// can't reach the server, instead of the browser's own error screen -
// which, in an installed (standalone) app, has no address bar or reload
// button.
const CACHE = 'ausschnitt-offline-v2';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.add(OFFLINE_URL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.mode !== 'navigate') return;
    event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});

self.addEventListener('push', event => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch {
        // Not ours/malformed - still must show something, browsers require it.
    }
    const options = {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: { ...data, shownAt: Date.now() },
        tag: data.tag
    };
    event.waitUntil((async () => {
        // A notification with the same tag (this comic's last one, never
        // tapped) would be replaced silently - iOS ignores `renotify` - so
        // the new one goes out as a fresh alert instead. Except for the same
        // news arriving again within REPEAT_MS (one device subscribed
        // twice): that replaces it quietly.
        if (data.tag) {
            const existing = await self.registration.getNotifications({ tag: data.tag });
            const repeat = existing.some(n => n.data && Date.now() - n.data.shownAt < REPEAT_MS);
            if (!repeat) existing.forEach(n => n.close());
        }
        await self.registration.showNotification(data.title || 'Ausschnitt', options);
    })());
});

const REPEAT_MS = 60 * 1000;

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const data = event.notification.data || {};
    // No action buttons - iOS can't show them, so every platform gets the
    // same single tap, resolved server-side to the account's preference.
    // Through open.html, which shows a spinner while the reader loads.
    const url = data.comicId ? openUrl(data.comicId, data.direction) : '/';

    event.waitUntil((async () => {
        // Reuse an open Ausschnitt window rather than stacking new ones.
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windows) {
            if (new URL(client.url).origin !== self.location.origin) continue;
            try {
                await client.focus();
                await client.navigate(url);
                return;
            } catch {
                // Not controllable by this worker - fall through to a new window.
            }
        }
        await self.clients.openWindow(url);
    })());
});

// Kept in step with newPageNotifier.ts's ntfy click URL.
function openUrl(comicId, direction) {
    const params = new URLSearchParams({ to: `/reader/${comicId}/open/notification` });
    if (direction === 'rtl') params.set('dir', 'rtl');
    return `/open.html?${params}`;
}
