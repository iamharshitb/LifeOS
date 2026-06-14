// ══════════════════════════════════════════════════════════
//  LifeOS Service Worker — Offline-first, Cache-first
// ══════════════════════════════════════════════════════════

const CACHE_NAME   = 'lifeos-v2';
const FONT_CACHE   = 'lifeos-fonts-v1';

// Core app shell — everything needed to work offline
const APP_SHELL = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
];

// Google Fonts (cache separately, long TTL)
const FONT_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

// ── Install: pre-cache app shell ─────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== FONT_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: Cache-first for shell, network-first for API ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept Anthropic API or Google Calendar calls
  if (url.hostname.includes('anthropic.com') ||
      url.hostname.includes('googleapis.com') && url.pathname.includes('/v1/messages')) {
    return; // let them pass through to network
  }

  // Fonts → cache-first, long TTL
  if (FONT_ORIGINS.some(o => event.request.url.startsWith(o))) {
    event.respondWith(
      caches.open(FONT_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            cache.put(event.request, response.clone());
            return response;
          });
        })
      )
    );
    return;
  }

  // App shell & assets → cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Only cache same-origin successful GET responses
        if (
          response.ok &&
          event.request.method === 'GET' &&
          url.origin === self.location.origin
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// ── Background Sync: laundry reminders ───────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'laundry-check') {
    event.waitUntil(sendLaundryNotification());
  }
});

async function sendLaundryNotification() {
  const clients = await self.clients.matchAll();
  // Notification handled in app.js via checkAndNotify()
}

// ── Push notifications ────────────────────────────────────
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'LifeOS', {
      body:  data.body  || 'Check your wardrobe.',
      icon:  './icons/icon-192.svg',
      badge: './icons/icon-192.svg',
      data:  { url: data.url || './' }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data?.url || './')
  );
});
