// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import SpacesDrawer from './SpacesDrawer.svelte';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  HTMLDialogElement.prototype.show = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('spaces drawer movement', () => {
  it('follows a pull without making the original touch target inert, then settles into a modal', async () => {
    const view = render(SpacesDrawer, { open: false, pull: 0.25, onclose: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    const dialog = view.container.querySelector('dialog')!;
    expect(dialog.style.transform).toBe('translateX(-75%)');
    expect(dialog.getAttribute('aria-hidden')).toBe('true');
    expect(HTMLDialogElement.prototype.show).toHaveBeenCalledTimes(1);
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
    await view.rerender({ open: false, pull: 0.6 });
    expect(dialog.style.transform).toBe('translateX(-40%)');
    await view.rerender({ open: true, pull: undefined });
    expect(dialog.style.transform).toBe('translateX(0%)');
    expect(dialog.classList.contains('pulling')).toBe(false);
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(220);
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
  });

  it('slides an unfinished pull closed before removing the drawer', async () => {
    const view = render(SpacesDrawer, { open: false, pull: 0.3, onclose: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    await view.rerender({ open: false, pull: undefined });
    expect(view.container.querySelector('dialog')?.style.transform).toBe('translateX(-100%)');
    expect(view.container.querySelector('.drawer-shade')?.getAttribute('style')).toContain('opacity: 0');
    await vi.advanceTimersByTimeAsync(220);
    expect(view.container.querySelector('dialog')).toBeNull();
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
  });

  it('keeps a reopened drawer open and supports escape and reduced motion', async () => {
    const onclose = vi.fn();
    const view = render(SpacesDrawer, { open: true, onclose });
    await vi.advanceTimersByTimeAsync(0);
    await view.rerender({ open: false });
    await vi.advanceTimersByTimeAsync(100);
    await view.rerender({ open: true });
    await vi.advanceTimersByTimeAsync(220);
    const dialog = view.getByRole('dialog', { name: 'Your spaces' });
    await fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(onclose).toHaveBeenCalledTimes(1);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    await view.rerender({ open: false });
    expect(view.queryByRole('dialog')).toBeNull();
  });
});
