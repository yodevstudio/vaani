// W2: minimal offline-first service worker. No build step — this precache
// list is maintained by hand, same "no tooling" constraint as the rest of
// this project. Bump CACHE_NAME whenever a precached file's content
// changes, so activate's cleanup below replaces the old cache instead of
// serving stale assets forever.
const CACHE_NAME = 'vaani-cache-2026.08.15';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/vaani.css',
  './js/amount-policy.js',
  './js/app.js',
  './js/assemble.js',
  './js/eligibility.js',
  './js/janaadhaar-sim.js',
  './js/normalise.js',
  './js/operator.js',
  './js/pwa.js',
  './js/router.js',
  './js/speech.js',
  './data/lexicon.json',
  './data/samples.json',
  './data/schemes.json',
  './data/slots.json',
  './assets/fonts/Inter-Variable.ttf',
  './assets/fonts/NotoSansDevanagari-Variable.ttf',
  './assets/icons/icon.svg',
  './assets/docs/aadhaar.svg',
  './assets/docs/age_cert.svg',
  './assets/docs/bank_passbook.svg',
  './assets/docs/birth_cert.svg',
  './assets/docs/category_proof.svg',
  './assets/docs/child_aadhaar.svg',
  './assets/docs/degree_marksheet.svg',
  './assets/docs/disability_cert.svg',
  './assets/docs/document.svg',
  './assets/docs/domicile_cert.svg',
  './assets/docs/income_cert.svg',
  './assets/docs/jan_aadhaar.svg',
  './assets/docs/land_record.svg',
  './assets/docs/mamta_card.svg',
  './assets/docs/marital_status_proof.svg',
  './assets/docs/ration_card.svg',
  './assets/docs/school_admission_cert.svg',
  './assets/docs/school_enrollment_cert.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// Cache-first: an installed app should feel instant and work offline: only
// a URL that was never precached (or a future addition not yet cached)
// falls through to the network.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
