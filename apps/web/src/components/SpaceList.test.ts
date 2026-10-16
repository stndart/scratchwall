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
function setup() {
  const spaces: Space[] = ['inbox', 'ideas', 'reading'].map((id, position) => ({
    id, name: id, position, isInbox: id === 'inbox', createdAt: '1', updatedAt: '1', syncState: 'synced',
  }));
  const onreorder = vi.fn(async () => {});
  const onselect = vi.fn();
  const view = render(SpaceList, { spaces, selectedSpace: 'inbox', counts: new Map(), onreorder, onselect, onadd: vi.fn() });
  for (const row of view.container.querySelectorAll<HTMLElement>('[data-space-id]')) {
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => {
      const index = Array.from(view.container.querySelectorAll('[data-space-id]')).indexOf(row);
      return { top: index * 50, height: 50 } as DOMRect;
    });
  }
  return { view, onreorder, onselect };
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
  it('holds a space row to reorder on mobile and consumes the ending tap', async () => {
    vi.useFakeTimers();
    const { view, onreorder, onselect } = setup();
    const button = view.getByRole('button', { name: 'inbox 0' });
    touch(button, 'touchstart', 25);
    await vi.advanceTimersByTimeAsync(400);
    expect(view.container.querySelector('.reordering')).toBeTruthy();
    expect(touch(button, 'touchmove', 145).defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(touch(button, 'touchend', 145).defaultPrevented).toBe(true);
    await fireEvent.click(button);
    expect(onreorder).toHaveBeenCalledWith(['ideas', 'reading', 'inbox']);
    expect(onselect).not.toHaveBeenCalled();
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
    const { view, onreorder, onselect } = setup();
    const grip = view.getByRole('button', { name: 'Reorder inbox' });
    await pointer(grip, 'pointerdown', 25, pointerType);
    await pointer(grip, 'pointermove', 145, pointerType);
    expect(Array.from(view.container.querySelectorAll('[data-space-id]')).map((row) => (row as HTMLElement).dataset.spaceId)).toEqual(['ideas', 'reading', 'inbox']);
    await pointer(grip, 'pointerup', 145, pointerType);
    expect(onreorder).toHaveBeenCalledWith(['ideas', 'reading', 'inbox']);
    expect(onselect).not.toHaveBeenCalled();
  });
  it('restores a cancelled drag and does not save a stationary press', async () => {
    const { view, onreorder } = setup();
    const grip = view.getByRole('button', { name: 'Reorder inbox' });
    await pointer(grip, 'pointerdown', 25, 'touch');
    await pointer(grip, 'pointermove', 145, 'touch');
    await pointer(grip, 'pointercancel', 145, 'touch');
    expect(onreorder).not.toHaveBeenCalled();
    expect((view.container.querySelector('[data-space-id]') as HTMLElement).dataset.spaceId).toBe('inbox');
    await pointer(grip, 'pointerdown', 25, 'touch');
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
    const { view } = setup();
    const grip = view.getByRole('button', { name: 'Reorder inbox' });
    function touch(type: string) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      grip.dispatchEvent(event);
      return event;
    }
    expect(touch('touchmove').defaultPrevented).toBe(false);
    await pointer(grip, 'pointerdown', 25, 'touch');
    expect(touch('touchmove').defaultPrevented).toBe(false);
    await pointer(grip, 'pointermove', 145, 'touch');
    expect(touch('touchmove').defaultPrevented).toBe(true);
    await pointer(grip, 'pointerup', 145, 'touch');
    expect(touch('touchend').defaultPrevented).toBe(true);
    expect(touch('touchmove').defaultPrevented).toBe(false);
  });
});
