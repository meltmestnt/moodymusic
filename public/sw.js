// moodymusic service worker
// Strategy:
//   - Precache the app icon + manifest so the install card has assets ready.
//   - Stale-while-revalidate same-origin GETs (HTML, JS, CSS, fonts) — opens
//     the installed app fast even on flaky networks, while a background fetch
//     keeps the cache fresh.
//   - Bypass /api/* entirely. Those endpoints depend on session cookies and
//     return user-specific data that we don't want serving from cache.
//   - Bypass the Next.js dev/HMR endpoints (won't matter in prod, but a
//     defensive guard).

const CACHE = "moodymusic-v1";
const PRECACHE = ["/icon.svg", "/icon-maskable.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Use individual put()s with no-store fetches so a single 404 doesn't
      // poison the whole install.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const res = await fetch(url, { cache: "no-store" });
            if (res.ok) await cache.put(url, res);
          } catch {
            /* ignore — non-critical */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/_next/webpack-hmr")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          // Only cache successful basic (same-origin) responses. Skip
          // opaque/redirect/error responses to avoid storing partial data.
          if (res && res.status === 200 && res.type === "basic") {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => undefined);

      return cached || (await network) || new Response("offline", { status: 503 });
    })(),
  );
});
