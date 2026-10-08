import { isNative } from './nativeAuth';

const CHECK_MS = 60 * 60 * 1000;

export function registerWebUpdate(onNeedRefresh: () => void): {
  apply: () => void;
  stop: () => void;
} {
  if (
    isNative() ||
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator)
  ) {
    return { apply: () => location.reload(), stop: () => {} };
  }

  let registration: ServiceWorkerRegistration | undefined;
  let waiting: ServiceWorker | undefined;
  let applying = false;

  const promptIfWaiting = (worker: ServiceWorker | null | undefined) => {
    if (
      !worker ||
      worker.state !== 'installed' ||
      !navigator.serviceWorker.controller
    )
      return;
    waiting = worker;
    onNeedRefresh();
  };

  const watchInstalling = (reg: ServiceWorkerRegistration) => {
    const worker = reg.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => promptIfWaiting(worker));
  };

  const onControllerChange = () => {
    if (applying) location.reload();
  };

  void navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => {
      registration = reg;
      promptIfWaiting(reg.waiting);
      watchInstalling(reg);
      reg.addEventListener('updatefound', () => watchInstalling(reg));
    })
    .catch(() => {
      /* Offline launch still works with the previously installed worker. */
    });

  const check = () => {
    void registration?.update().catch(() => {});
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') check();
  };
  const interval = window.setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', onVisible);
  navigator.serviceWorker.addEventListener(
    'controllerchange',
    onControllerChange,
  );

  return {
    apply: () => {
      const worker = waiting ?? registration?.waiting;
      if (!worker) {
        location.reload();
        return;
      }
      applying = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    },
    stop: () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        onControllerChange,
      );
    },
  };
}
