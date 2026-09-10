import { registerSW } from 'virtual:pwa-register';
import { isNative } from './nativeAuth';

const CHECK_MS = 60 * 60 * 1000;

export function registerWebUpdate(onNeedRefresh: () => void): { apply: () => void; stop: () => void } {
  if (isNative() || !('serviceWorker' in navigator)) {
    return { apply: () => location.reload(), stop: () => {} };
  }
  let registration: ServiceWorkerRegistration | undefined;
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh,
    onRegisteredSW(_url, registered) {
      registration = registered;
    }
  });
  const check = () => { void registration?.update(); };
  const onVisible = () => {
    if (document.visibilityState === 'visible') check();
  };
  const interval = window.setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', onVisible);
  return {
    apply: () => { void updateSW(true); },
    stop: () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}
