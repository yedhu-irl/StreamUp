/**
 * Service Worker Stream Proxy Registration & Readiness Barrier
 * Prevents Vite dev-server race condition where HTML is returned instead of 206 stream.
 */

let isRegistered = false;
let registrationPromise: Promise<boolean> | null = null;

export async function ensureStreamServiceWorker(): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }

  if (isRegistered && navigator.serviceWorker.controller) {
    return true;
  }

  if (registrationPromise) {
    return registrationPromise;
  }

  registrationPromise = (async () => {
    try {
      // Register dedicated stream proxy Service Worker
      await navigator.serviceWorker.register('/sw-stream.js', { scope: '/' });
      await navigator.serviceWorker.ready;

      // Poll until controller is active and intercepts /tg-stream/ping
      const startTime = Date.now();
      while (Date.now() - startTime < 8000) {
        if (navigator.serviceWorker.controller) {
          try {
            const res = await fetch('/tg-stream/ping', { cache: 'no-store' });
            if (res.ok) {
              const text = await res.text();
              if (text === 'ok') {
                isRegistered = true;
                return true;
              }
            }
          } catch (e) {
            // Service worker not yet claiming this client
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      console.warn('Service worker registration ping barrier timed out, proceeding anyway.');
      return true;
    } catch (err) {
      console.error('Failed to register sw-stream.js:', err);
      return false;
    } finally {
      registrationPromise = null;
    }
  })();

  return registrationPromise;
}

