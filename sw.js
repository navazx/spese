// Tiene l'app disponibile anche senza rete. I dati non passano da qui: li gestisce cloud.js.
const VERSIONE = "spese-v20";
const BASE = ["./", "index.html", "cloud.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable.png", "apple-touch-icon.png", "mercati.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSIONE).then(c => c.addAll(BASE.map(u => new Request(u, {cache: "reload"})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSIONE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Prima la rete, per avere l'ultima versione. Se manca o è lenta (più di 3 secondi) si apre la copia salvata
// e la rete continua in sottofondo per aggiornarla.
async function primaRete(req, e){
  const c = await caches.open(VERSIONE);
  const rete = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; });
  e.waitUntil(rete.catch(() => {}));
  try{
    return await Promise.race([rete, new Promise((_, no) => setTimeout(() => no(new Error("rete lenta")), 3000))]);
  }catch(_){
    const salvata = (await c.match(req, {ignoreSearch: true})) || (req.mode === "navigate" ? await c.match("index.html") : null);
    return salvata || rete.catch(() => Response.error());
  }
}
async function primaCache(req){
  const c = await caches.open(VERSIONE);
  const hit = await c.match(req);
  const rete = fetch(req).then(r => { if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; }).catch(() => null);
  return hit || (await rete) || Response.error();
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(primaRete(req, e));
  else if (/cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.host)) e.respondWith(primaCache(req));
  // tutto il resto (il database) va direttamente in rete
});
