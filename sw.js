/*
 * Circus of Chaos — the service worker.
 *
 * Its ONLY job is to make the app open without a network and survive a bad one. It is deliberately timid,
 * because the failure mode of an eager service worker is the worst bug this project could ship: an app that
 * serves yesterday's code and cannot be refreshed out of it.
 *
 * The rule, and it is the whole design:
 *
 *   - Files with a content hash in the URL (`app.js?v=1a2b3c`) can be cached forever. If the file changes,
 *     the URL changes, so a stale copy is impossible by construction.
 *   - EVERYTHING ELSE goes to the network first, and only falls back to a cached copy if the network fails.
 *     index.html especially: it is what points at the hashed files, so a stale one pins a stale app.
 *   - The database is never touched. Live data is live.
 */
const CACHE = "coc-shell-v1";

/* The shell: the page, its data, and the icons. The hashed assets are not listed because index.html names
   them with a version that changes — they are cached as they are fetched instead. */
const SHELL = ["./", "./index.html", "./data/bundle.json", "./data/manifest.json", "./maps/index.json"];

self.addEventListener("install", (e) => {
  // Nothing waits: a new worker takes over at once rather than after every tab is closed, which is how an
  // update would otherwise sit unused for days.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Somebody else's server — above all the database — is none of our business.
  if (url.origin !== self.location.origin) return;

  const hashed = /[?&]v=[0-9a-f]{6,}/.test(url.search);
  if (hashed) {
    // Cache-first, forever: the URL is the version.
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    })());
    return;
  }

  // Network-first for everything else, with the cache as a parachute rather than a source of truth.
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && (url.pathname.endsWith(".json") || url.pathname.endsWith(".html") || url.pathname.endsWith("/"))) {
        (await caches.open(CACHE)).put(req, res.clone());
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req) || await caches.match("./index.html");
      if (hit) return hit;
      throw err;
    }
  })());
});
