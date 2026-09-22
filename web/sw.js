// Service Worker: Kartentexturen (unveränderlich je ArtId) werden Cache-first vorgehalten,
// Match-Dateien und Kartendetails Netz-first (Fallback auf Cache, wenn der Server nicht läuft).
const CACHE = "mtga-stats-v4";
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const p = url.pathname;
  const artLike = p.startsWith("/art/");
  const dataLike = p.startsWith("/matches/") || p.startsWith("/api/card/");
  if (!artLike && !dataLike) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    if (artLike) {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(e.request);
      return hit || Response.error();
    }
  }));
});
