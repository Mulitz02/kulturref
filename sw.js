// App-Gerüst offline verfügbar halten; Daten kommen live aus Firebase (mit eigenem Offline-Cache)
const CACHE = "kulturref-v1";
const CORE = ["./", "index.html", "app.js", "config.js", "style.css", "manifest.webmanifest", "icon-192.png", "apple-touch-icon.png"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)); return res; })
    .catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
});
