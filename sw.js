// Service worker dell'app LVT: chiede sempre i dati freschi alla rete.
// Solo se la rete manca (es. palestra senza campo) mostra l'ultima copia salvata.
const CACHE = "lvt-app-v1";
const BASE = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  // solo richieste GET del nostro sito; i siti PGS/FIPAV/GitHub passano direttamente
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const chiave = url.origin + url.pathname;   // senza ?t=... così l'ultima copia si ritrova
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copia = res.clone(); caches.open(CACHE).then(c => c.put(chiave, copia)); }
      return res;
    }).catch(() => caches.match(chiave).then(r => r || caches.match("./index.html")))
  );
});
