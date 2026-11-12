// Service worker dell'app LVT: chiede sempre i dati freschi alla rete.
// Solo se la rete manca (es. palestra senza campo) mostra l'ultima copia salvata.
const CACHE = "lvt-app-v2";
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

// ---------- NOTIFICHE ----------
// La spinta arriva vuota: il testo si legge dal Worker, così è sempre l'ultimo avviso inviato.
const WORKER = "https://lvt.cicciodesimone.workers.dev";
self.addEventListener("push", e => {
  e.waitUntil(
    fetch(`${WORKER}/push/ultima?t=${Date.now()}`, { cache: "no-store" }).then(r => r.json())
      .catch(() => ({ titolo: "LVT Volley", testo: "Ci sono novità sul sito" }))
      .then(n => self.registration.showNotification(n.titolo || "LVT Volley", {
        body: n.testo || "", icon: "icon-192.png", badge: "icon-192.png",
        tag: "lvt-" + (n.ts || Date.now()), data: { url: n.url || "./" }
      }))
  );
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const dest = new URL((e.notification.data && e.notification.data.url) || "./", self.location.href).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(lista => {
    const aperta = lista.find(c => c.url.startsWith(self.registration.scope));
    if (aperta) { aperta.navigate(dest).catch(() => {}); return aperta.focus(); }
    return self.clients.openWindow(dest);
  }));
});
