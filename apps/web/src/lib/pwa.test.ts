// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { registerWebUpdate } from './pwa';

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
});
