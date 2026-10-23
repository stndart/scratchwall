// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import SpaceList from './SpaceList.svelte';
import type { Space } from '../lib/types';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  HTMLElement.prototype.setPointerCapture = vi.fn();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(scrollable = false) {
  const spaces: Space[] = ['inbox', 'ideas', 'reading'].map((id, position) => ({
    id, name: id, position, isInbox: id === 'inbox', createdAt: '1', updatedAt: '1', syncState: 'synced',
  }));
  const onreorder = vi.fn(async () => {});
  const onselect = vi.fn();
  const target = scrollable ? document.createElement('div') : undefined;
  if (target) {
    target.className = 'sidebar-scroll';
    document.body.append(target);
  }
  const props = { spaces, selectedSpace: 'inbox', counts: new Map(), onreorder, onselect, onadd: vi.fn() };
  const view = render(SpaceList, target ? { target, props } : props);
  for (const row of view.container.querySelectorAll<HTMLElement>('[data-space-id]')) {
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => {
      const index = Array.from(view.container.querySelectorAll('[data-space-id]')).indexOf(row);
      return { top: index * 50, height: 50 } as DOMRect;
    });
  }
  return { view, onreorder, onselect, target };
}
async function pointer(target: HTMLElement, type: string, y: number, pointerType: string) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY: y });
  Object.assign(event, { pointerId: 1, pointerType });
  await fireEvent(target, event);
}
describe('space reordering', () => {
  function touch(target: HTMLElement, type: string, y: number) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const point = { identifier: 4, clientX: 60, clientY: y };
    Object.assign(event, { touches: type === 'touchend' || type === 'touchcancel' ? [] : [point], changedTouches: [point] });
    target.dispatchEvent(event);
    return event;
  }
  it.each(['inbox 0', 'Reorder inbox'])('keeps a short touch on %s from lifting or reordering the space', async (name) => {
    vi.useFakeTimers();
    const { view, onreorder, onselect } = setup();
    const button = view.getByRole('button', { name });
    await pointer(button, 'pointerdown', 25, 'touch');
    touch(button, 'touchstart', 25);
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector('.space-drag-ghost, [data-drag-placeholder]')).toBeNull();
    expect(touch(button, 'touchend', 25).defaultPrevented).toBe(false);
    await fireEvent.click(button);
    await vi.advanceTimersByTimeAsync(500);
    expect(document.querySelector('.space-drag-ghost, [data-drag-placeholder]')).toBeNull();
    expect(onreorder).not.toHaveBeenCalled();
    expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled();
    if (name === 'inbox 0') expect(onselect).toHaveBeenCalledWith('inbox');
    else expect(onselect).not.toHaveBeenCalled();
  });
  it('lets a pan starting on a grip cancel the pending hold without intercepting scrolling', async () => {
    vi.useFakeTimers();
    const { view, onreorder } = setup();
    const grip = view.getByRole('button', { name: 'Reorder inbox' });
    await pointer(grip, 'pointerdown', 25, 'touch');
    touch(grip, 'touchstart', 25);
    await vi.advanceTimersByTimeAsync(100);
    expect(touch(grip, 'touchmove', 45).defaultPrevented).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(document.querySelector('.space-drag-ghost, [data-drag-placeholder]')).toBeNull();
    expect(touch(grip, 'touchend', 145).defaultPrevented).toBe(false);
    expect(onreorder).not.toHaveBeenCalled();
  });
  it('cancels a pending lift when the spaces container starts scrolling', async () => {
    vi.useFakeTimers();
    const { view, onreorder, target } = setup(true);
    const grip = view.getByRole('button', { name: 'Reorder inbox' });
    touch(grip, 'touchstart', 25);
    await vi.advanceTimersByTimeAsync(100);
    await fireEvent.scroll(target!);
    await vi.advanceTimersByTimeAsync(500);
    expect(document.querySelector('.space-drag-ghost, [data-drag-placeholder]')).toBeNull();
    expect(onreorder).not.toHaveBeenCalled();
    view.unmount();
    target!.remove();
  });
  it('holds a space row to reorder on mobile and consumes the ending tap', async () => {
    vi.useFakeTimers();
    const { view, onreorder, onselect } = setup();
    const button = view.getByRole('button', { name: 'inbox 0' });
    touch(button, 'touchstart', 25);
    await vi.advanceTimersByTimeAsync(400);
    expect(view.container.querySelector('.reordering')).toBeTruthy();
    expect(document.querySelector<HTMLElement>('.space-drag-ghost')?.getAttribute('aria-hidden')).toBe('true');
    expect(touch(button, 'touchmove', 145).defaultPrevented).toBe(true);
    expect(document.querySelector<HTMLElement>('.space-drag-ghost')?.style.top).toBe('120px');
    await Promise.resolve();
    expect(touch(button, 'touchend', 145).defaultPrevented).toBe(true);
    await fireEvent.click(button);
    expect(onreorder).toHaveBeenCalledWith(['ideas', 'reading', 'inbox']);
    expect(onselect).not.toHaveBeenCalled();
    expect(document.querySelector('.space-drag-ghost')).toBeNull();
  });
  it('removes the floating row and placeholder when a drag is cancelled or unmounted', async () => {
    const { view } = setup();
    const grip = view.getByRole('button', { name: 'Reorder inbox' });
    await pointer(grip, 'pointerdown', 25, 'mouse');
    expect(document.querySelectorAll('.space-drag-ghost')).toHaveLength(1);
    await pointer(grip, 'pointermove', 80, 'mouse');
    expect(document.querySelector<HTMLElement>('.space-drag-ghost')?.style.top).toBe('55px');
    await pointer(grip, 'pointercancel', 80, 'mouse');
    expect(document.querySelector('.space-drag-ghost, [data-drag-placeholder]')).toBeNull();
    await pointer(grip, 'pointerdown', 25, 'mouse');
    view.unmount();
    expect(document.querySelector('.space-drag-ghost')).toBeNull();
  });
  it('keeps a new drag hidden behind its floating row when an earlier drop animation is interrupted', async () => {
    const { view } = setup();
    const grip = view.getByRole('button', { name: 'Reorder inbox' });
    await pointer(grip, 'pointerdown', 25, 'mouse');
    const floating = document.querySelector<HTMLElement>('.space-drag-ghost')!;
    let reject!: (reason: Error) => void;
    const finished = new Promise<Animation>((_, fail) => { reject = fail; });
    floating.animate = vi.fn(() => ({ finished, cancel: () => reject(new Error('Interrupted')) }) as unknown as Animation);
    await pointer(grip, 'pointermove', 145, 'mouse');
    await pointer(grip, 'pointerup', 145, 'mouse');
    expect(floating.animate).toHaveBeenCalled();
    await pointer(grip, 'pointerdown', 25, 'mouse');
    await tick();
    expect(document.querySelectorAll('.space-drag-ghost')).toHaveLength(1);
    expect(view.container.querySelector('[data-space-id="inbox"]')?.hasAttribute('data-drag-placeholder')).toBe(true);
  });
  it('cancels a pending hold when the user scrolls and rolls back a cancelled hold', async () => {
    vi.useFakeTimers();
    const { view, onreorder } = setup();
    const button = view.getByRole('button', { name: 'inbox 0' });
    touch(button, 'touchstart', 25);
    expect(touch(button, 'touchmove', 45).defaultPrevented).toBe(false);
    await vi.advanceTimersByTimeAsync(450);
    expect(view.container.querySelector('.reordering')).toBeNull();
    touch(button, 'touchstart', 25);
    await vi.advanceTimersByTimeAsync(400);
    touch(button, 'touchmove', 145);
    touch(button, 'touchcancel', 145);
    await tick();
    expect(view.container.querySelector('.reordering')).toBeNull();
    expect(onreorder).not.toHaveBeenCalled();
  });
  it.each(['mouse', 'touch'])('moves a space by %s without activating it', async (pointerType) => {
    vi.useFakeTimers();
    const { view, onreorder, onselect } = setup();
    const grip = view.getByRole('button', { name: 'Reorder inbox' });
    await pointer(grip, 'pointerdown', 25, pointerType);
    if (pointerType === 'touch') {
      touch(grip, 'touchstart', 25);
      await vi.advanceTimersByTimeAsync(400);
      expect(document.querySelector('.space-drag-ghost')).toBeTruthy();
      touch(grip, 'touchmove', 145);
      await tick();
    } else await pointer(grip, 'pointermove', 145, pointerType);
    expect(Array.from(view.container.querySelectorAll('[data-space-id]')).map((row) => (row as HTMLElement).dataset.spaceId)).toEqual(['ideas', 'reading', 'inbox']);
    if (pointerType === 'touch') touch(grip, 'touchend', 145);
    else await pointer(grip, 'pointerup', 145, pointerType);
    expect(onreorder).toHaveBeenCalledWith(['ideas', 'reading', 'inbox']);
    expect(onselect).not.toHaveBeenCalled();
  });
  it('restores a cancelled drag and does not save a stationary press', async () => {
    vi.useFakeTimers();
    const { view, onreorder } = setup();
    const grip = view.getByRole('button', { name: 'Reorder inbox' });
    await pointer(grip, 'pointerdown', 25, 'touch');
    touch(grip, 'touchstart', 25);
    await vi.advanceTimersByTimeAsync(400);
    touch(grip, 'touchmove', 145);
    await tick();
    expect(document.querySelector('.space-drag-ghost')).toBeTruthy();
    touch(grip, 'touchcancel', 145);
    await tick();
    expect(onreorder).not.toHaveBeenCalled();
    expect((view.container.querySelector('[data-space-id]') as HTMLElement).dataset.spaceId).toBe('inbox');
    await pointer(grip, 'pointerdown', 25, 'touch');
    touch(grip, 'touchstart', 25);
    touch(grip, 'touchend', 25);
    await pointer(grip, 'pointerup', 25, 'touch');
    expect(onreorder).not.toHaveBeenCalled();
  });
  it('keeps keyboard moves within list boundaries', async () => {
    const { view, onreorder } = setup();
    await fireEvent.keyDown(view.getByRole('button', { name: 'Reorder inbox' }), { key: 'ArrowUp' });
    expect(onreorder).not.toHaveBeenCalled();
    await fireEvent.keyDown(view.getByRole('button', { name: 'Reorder reading' }), { key: 'ArrowUp' });
    expect(onreorder).toHaveBeenCalledWith(['inbox', 'reading', 'ideas']);
  });
  it('allows ordinary touch scrolling but consumes an active drag and its ending tap', async () => {
    vi.useFakeTimers();
    const { view } = setup();
    const grip = view.getByRole('button', { name: 'Reorder inbox' });
    expect(touch(grip, 'touchmove', 25).defaultPrevented).toBe(false);
    await pointer(grip, 'pointerdown', 25, 'touch');
    touch(grip, 'touchstart', 25);
    expect(touch(grip, 'touchmove', 25).defaultPrevented).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(touch(grip, 'touchmove', 145).defaultPrevented).toBe(true);
    await pointer(grip, 'pointerup', 145, 'touch');
    expect(touch(grip, 'touchend', 145).defaultPrevented).toBe(true);
    expect(touch(grip, 'touchmove', 145).defaultPrevented).toBe(false);
  });
});
