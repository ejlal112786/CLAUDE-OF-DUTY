/* ============================================================================
 * sw.js — service worker for OPERATION: BLACK VECTOR
 *
 * Purpose: make the whole game available offline for single-player use.
 *
 * Design rules followed here:
 *  - Only ever intercepts SAME-ORIGIN, HTTP(S), GET requests.
 *  - Vercel platform routes (/_vercel, /api, /__*) are never intercepted, so
 *    normal online deployment keeps working exactly as before.
 *  - Navigations are network-first with an offline cache fallback, so an online
 *    visitor always gets the freshest HTML while an offline visitor still boots.
 *  - Static assets are cache-first (stale-while-revalidate): never break a
 *    resource that is already cached, even if the network fails.
 *  - The cache name is explicitly versioned; old versions are deleted on
 *    activate. Bump CACHE_VERSION to ship a new offline snapshot.
 *  - Update detection is user-driven: the page shows a banner and only reloads
 *    when the player chooses to, so a mission is never interrupted.
 * ==========================================================================*/

const CACHE_VERSION = 'v1.1.0';
const CACHE_NAME = `obv-${CACHE_VERSION}`;
const SHELL = './index.html';

/* Everything required for a complete offline single-player session. */
const PRECACHE = [
  './index.html',
  './style.css',
  './manifest.webmanifest',

  './js/main.js',
  './js/pwa.js',
  './js/game.js',
  './js/player.js',
  './js/playerbody.js',
  './js/weapons.js',
  './js/enemies.js',
  './js/physics.js',
  './js/world.js',
  './js/audio.js',
  './js/particles.js',
  './js/missions.js',
  './js/tacmap.js',
  './js/vehicles.js',
  './js/throwables.js',
  './js/loadout.js',
  './js/progress.js',
  './js/ui.js',
  './js/touch.js',

  './assets/vendor/three.module.js',

  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/maskable-192.png',
  './assets/icons/maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-32.png',
];

/* ---------------------------------------------------------------- install -- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Settle individually so one missing optional file cannot brick the install.
    const results = await Promise.allSettled(
      PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })))
    );
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? PRECACHE[i] : null))
      .filter(Boolean);
    if (failed.length) {
      console.warn('[sw] precache incomplete, missing:', failed);
    } else {
      console.log(`[sw] precached ${PRECACHE.length} resources (${CACHE_NAME})`);
    }
    // Take control immediately so the very first load is already offline-capable.
    await self.skipWaiting();
  })());
});

/* --------------------------------------------------------------- activate -- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Remove every obsolete version of our cache (and only ours).
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('obv-') && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );
    // Refresh the shell so the offline entry point is current.
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.add(new Request(SHELL, { cache: 'reload' }));
    } catch (e) { /* offline during activate — cached copy stays */ }
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------------ fetch -- */
function isOwnRequest(url) {
  if (url.origin !== self.location.origin) return false;          // cross-origin
  if (!/^https?:$/.test(url.protocol)) return false;              // chrome/data/etc
  const p = url.pathname;
  // Never touch Vercel platform / reserved routes, and never shadow hidden files.
  if (p.startsWith('/_vercel') || p.startsWith('/api/') || p.startsWith('/__')) return false;
  if (p.startsWith('/.well-known/')) return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                                // no mutations
  const url = new URL(req.url);
  if (!isOwnRequest(url)) return;                                  // default handling

  const wantsHTML =
    req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  /* --- Navigations: network-first, fall back to the cached shell ---------- */
  if (wantsHTML) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok && fresh.type === 'basic') {
          const cache = await caches.open(CACHE_NAME);
          cache.put(SHELL, fresh.clone());
        }
        return fresh;
      } catch (err) {
        const cache = await caches.open(CACHE_NAME);
        return (
          (await cache.match(SHELL)) ||
          (await cache.match('./index.html')) ||
          new Response('Offline and no cached copy of the game is available.', {
            status: 503,
            statusText: 'Offline',
            headers: { 'Content-Type': 'text/plain' },
          })
        );
      }
    })());
    return;
  }

  /* --- Static assets: cache-first, revalidate in the background ----------- */
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(req);
    if (hit) {
      // Keep the cache warm while online; failure here is irrelevant because we
      // are already serving a valid cached response.
      fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
        })
        .catch(() => {});
      return hit;
    }
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      return (
        (await cache.match(SHELL)) ||
        new Response('', { status: 504, statusText: 'Offline' })
      );
    }
  })());
});

/* ---------------------------------------------------------------- message -- */
/* The page posts SKIP_WAITING when the player accepts an update. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
