// Service worker del spike. Cache-first versionado.
// Decisión consciente: NO se llama a skipWaiting() ni clients.claim(), para que una versión nueva
// no tome el control en mitad de un entrenamiento; se activa al cerrar todas las pestañas.
const VERSION = 'spike-v5';
const ASSETS = [
  './', './index.html', './engine.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './cue-10.wav', './cue-30.wav', './cue-10x90.wav', './cue-rest.wav',
];

self.addEventListener('install', (event) => {
  // EXCEPCIÓN de v2 (solo spike): skipWaiting para que el teléfono tome esta versión sin pasos extra.
  // En la app real NO se activará una versión nueva durante un entrenamiento (ver Plan Maestro §10.5).
  self.skipWaiting();
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Safari exige respuestas 206 para audio/video con cabecera Range; la caché devuelve 200 completo.
async function rangeResponse(request, hit) {
  const buf = await hit.arrayBuffer();
  const m = /bytes=(\d+)-(\d*)/.exec(request.headers.get('range') || '');
  if (!m) return hit;
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), buf.byteLength - 1) : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': hit.headers.get('Content-Type') || 'audio/wav',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + buf.byteLength,
      'Content-Length': String(end - start + 1),
    },
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // v4: la app real vive en ./app/ dentro de este mismo sitio; este SW del spike NO debe tocarla
  // (antes, una navegación fuera de la caché devolvía el index.html del spike).
  if (url.pathname.startsWith(new URL('./app/', self.registration.scope).pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    let hit = await cache.match(req.url, { ignoreSearch: true });
    if (!hit && req.mode === 'navigate') hit = await cache.match('./index.html');
    if (hit) return req.headers.has('range') ? rangeResponse(req, hit) : hit;
    return fetch(req);
  })());
});
