// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWebUpdate } from './pwa';
import { currentVersion, recordLoadedVersion } from './changelog';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});

describe('registerWebUpdate', () => {
  it('does not register a service worker in the native app', () => {
    window.__TAURI_INTERNALS__ = {};
    const register = vi.fn();
    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true,
      value: { register }
    });
    const pwa = registerWebUpdate(() => {});
    expect(register).not.toHaveBeenCalled();
    pwa.stop();
    delete window.__TAURI_INTERNALS__;
  });

  it('records the loaded version before activating the waiting PWA update', async () => {
    const postMessage = vi.fn(() => {
      expect(localStorage.getItem('scratchwall.version.refreshFrom')).toBe(currentVersion);
    });
    const registration = Object.assign(new EventTarget(), {
      waiting: { state: 'installed', postMessage },
      installing: null,
      update: vi.fn(async () => {}),
    });
    const register = vi.fn(async () => registration);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: Object.assign(new EventTarget(), { register, controller: {} }),
    });
    const notify = vi.fn();
    const pwa = registerWebUpdate(notify);
    try {
      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      expect(register).toHaveBeenCalledWith('/sw.js');
      pwa.apply();
      expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      expect(recordLoadedVersion('next-release')).toBe(currentVersion);
    } finally {
      pwa.stop();
    }
  });
});
