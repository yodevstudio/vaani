// W2: installable + offline support. Owns exactly one concern — service
// worker registration — kept separate from app.js the same way every other
// self-contained capability in this project gets its own module.

// Registers only over genuine HTTPS — deliberately not carving out the
// usual localhost secure-context exception, so this project's documented
// local dev flow (`python -m http.server`, plain HTTP) is never affected
// by a cached service worker. This session has hit stale-cache confusion
// from a caching layer before; the app's own local-testing path should
// never be at risk of that.
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:') return;
  navigator.serviceWorker.register('sw.js').then(
    (reg) => console.log('[VAANI] service worker registered, scope:', reg.scope),
    (err) => console.error('[VAANI] service worker registration failed:', err)
  );
}
