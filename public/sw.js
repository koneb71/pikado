/*
 * Pikado — offline shell.
 *
 * Hand-written on purpose. Vite hashes every emitted asset filename, so a
 * precache manifest would have to be generated at build time; instead this
 * worker caches nothing but the navigation shell up front and fills the rest of
 * the cache from real traffic. The first visit populates it, every later visit
 * runs from it.
 *
 * Three strategies, chosen by what the URL actually is:
 *
 *   navigation      network-first  — the newest index.html wins when there is a
 *                                   network; the cached shell answers when
 *                                   there is not.
 *   /assets/…       cache-first    — the filename contains a content hash, so
 *                                   the bytes behind it can never change.
 *   other same-origin
 *                   stale-while-revalidate — instant from cache, refreshed in
 *                                   the background for next time.
 *
 * Cross-origin requests are never intercepted. The only one Pikado makes is the
 * optional Google Fonts stylesheet in src/text/fonts.js, which already handles
 * its own failure; putting it behind the cache would only turn a clean, fast
 * failure into a slow one.
 */

/* Bump this to invalidate every cached response. Activation deletes any cache
   whose name is not exactly the current one, so this single edit is the whole
   cache-busting mechanism. */
const VERSION = 'v1';

const CACHE = `pikado-${VERSION}`;

/* Both entries are the same document, but a navigation can arrive as either
   URL and Cache API matching is by URL, not by resource. */
const SHELL = ['./', './index.html'];

/* Relative to the worker's own URL, which is the deployment root — so this
   works unchanged whether Pikado is served from / or from a subdirectory. */
const SHELL_FALLBACK = new URL('./index.html', self.location.href).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individually, not addAll(): addAll() is atomic, so one 404 on a redundant
    // shell URL would fail the whole install and leave the app with no worker.
    await Promise.all(SHELL.map(async (path) => {
      try {
        const url = new URL(path, self.location.href);
        const res = await fetch(url, { cache: 'reload' });
        if (isCacheable(res)) await cache.put(url, res.clone());
      } catch {
        /* No network on first run — the shell gets cached by the first
           successful navigation instead. */
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) => (
      name !== CACHE && name.startsWith('pikado-') ? caches.delete(name) : null
    )));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // Cross-origin, and anything that is not plain http(s), is left entirely
  // alone: no interception means no behaviour change and no opaque responses
  // ending up in the cache.
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  // A range request answers 206, which the Cache API cannot store, and letting
  // the browser handle it keeps media seeking working.
  if (req.headers.has('range')) return;

  if (req.mode === 'navigate') {
    event.respondWith(navigationFirst(req));
    return;
  }
  if (isImmutableAsset(url)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(event, req));
});

/* ------------------------------------------------------------------ */
/* Strategies                                                          */
/* ------------------------------------------------------------------ */

/**
 * Navigation: try the network, fall back to the cached shell.
 *
 * Network-first rather than cache-first because index.html names the hashed
 * asset files. Serving a stale shell online would point the page at assets that
 * activation has already evicted.
 */
async function navigationFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (isCacheable(res)) {
      // Store under both shell URLs so a later "/" or "/index.html" navigation
      // hits regardless of which one the user arrived through.
      const copy = res.clone();
      await Promise.all(SHELL.map((path) => (
        cache.put(new URL(path, self.location.href), copy.clone())
      )));
    }
    return res;
  } catch {
    const cached = (await cache.match(req, { ignoreSearch: true }))
      || (await cache.match(SHELL_FALLBACK));
    if (cached) return cached;
    return offlineResponse('Pikado has not been cached for offline use yet.');
  }
}

/** Hashed assets are immutable, so a cache hit is always correct. */
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (isCacheable(res)) await cache.put(req, res.clone());
    /*
     * A hashed asset that is neither cached NOR on the server means this client is
     * running a shell from a previous deploy: the hash it is asking for no longer
     * exists. Nothing here can serve it, but the page's self-heal (see index.html)
     * needs the failure to be visible rather than swallowed, so the real status is
     * passed through instead of being turned into a friendly offline page.
     */
    return res;
  } catch {
    return offlineResponse('This asset is not available offline.');
  }
}

/** Answer from cache at once; refresh in the background for the next load. */
async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: false });

  const refresh = (async () => {
    try {
      const res = await fetch(req);
      if (isCacheable(res)) await cache.put(req, res.clone());
      return res;
    } catch {
      return null;
    }
  })();

  if (cached) {
    // Keep the worker alive for the revalidation even though the response has
    // already been handed back.
    event.waitUntil(refresh);
    return cached;
  }
  const fresh = await refresh;
  return fresh || offlineResponse('That file is not available offline.');
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Vite writes content-hashed filenames into this directory. */
function isImmutableAsset(url) {
  return url.pathname.includes('/assets/');
}

/**
 * Only clean, complete, same-origin 200s are worth storing.
 *
 * `type === 'opaque'` means a no-cors cross-origin response whose status is
 * always 0 — caching one would store a body we cannot even inspect, and serve
 * it back as an unexplained failure.
 */
function isCacheable(res) {
  return !!res && res.status === 200 && res.type !== 'opaque' && res.type !== 'opaqueredirect';
}

function offlineResponse(message) {
  return new Response(message, {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
