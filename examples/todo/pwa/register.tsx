import { useEffect, useState } from 'react';
import { useSdkLocale } from '@sempods/app-sdk/react';

/**
 * Registers the app's service worker. Call it once from the app entry, never on
 * library import. Resolves to undefined where service workers are unavailable
 * (plain HTTP other than loopback, blocked by policy) or registration fails:
 * the app keeps working as an ordinary page.
 */
export function registerAppWorker(
  url = '/sw.js',
): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return Promise.resolve(undefined);
  // The default scope is the worker's directory: '/' for /sw.js, '/tasks/' for
  // /tasks/sw.js. That scope is also the worker's base path.
  return navigator.serviceWorker.register(url).catch(() => undefined);
}

/**
 * Announces a downloaded version. It applies once every window of the app is
 * closed, so an update never reloads a page over unsaved drafts or unconfirmed
 * writes. App-owned recipe, not an SDK export.
 */
export function NewVersionNotice({
  registration,
}: {
  readonly registration: Promise<ServiceWorkerRegistration | undefined>;
}) {
  const [ready, setReady] = useState(false);
  const { language } = useSdkLocale();
  useEffect(() => {
    let active = true;
    let stop = () => {};
    void registration.then((r) => {
      if (!r || !active) return;
      // Only an update of a controlled page is news; a first install is not.
      const check = () => {
        if (active && r.waiting && navigator.serviceWorker.controller)
          setReady(true);
      };
      // Follow a worker that was already installing before this subscription
      // (updatefound fired earlier) as well as every later one.
      const watched = new Set<ServiceWorker>();
      const watch = (worker: ServiceWorker | null) => {
        if (!worker || watched.has(worker)) return;
        watched.add(worker);
        worker.addEventListener('statechange', check);
      };
      const found = () => watch(r.installing);
      r.addEventListener('updatefound', found);
      watch(r.installing);
      stop = () => {
        r.removeEventListener('updatefound', found);
        for (const worker of watched)
          worker.removeEventListener('statechange', check);
      };
      check();
    });
    return () => {
      active = false;
      stop();
    };
  }, [registration]);
  if (!ready) return null;
  return (
    <p role="status">
      {language === 'de'
        ? 'Eine neue Version ist bereit. Sie wird verwendet, sobald alle Fenster dieser App geschlossen sind.'
        : 'A new version is ready. It is used once every window of this app has been closed.'}
    </p>
  );
}
