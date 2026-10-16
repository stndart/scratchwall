// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoSelection } from './memoSelection';

let destroy: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => { destroy?.(); document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture(selected: string[] = [], selecting = false) {
  const node = document.createElement('div');
  node.className = 'feed';
  node.innerHTML = '<div class="feed-content">' + ['a', 'b', 'c', 'd'].map((id) =>
    `<article data-memo-id="${id}"><div class="memo-body"><span>Text ${id}</span><a href="#link">Link</a><pre>code</pre><button>Copy</button></div><footer> </footer></article>`).join('') + '</div>';
  document.body.append(node);
  vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 700 } as DOMRect);
  const cards = Array.from(node.querySelectorAll<HTMLElement>('article'));
  cards.forEach((card, index) => {
    vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => ({ top: 100 + index * 120, bottom: 200 + index * 120 }) as DOMRect);
  });
  let options = { selecting, selected: new Set(selected), memoIds: ['a', 'b', 'c', 'd'], onchange: vi.fn() };
  const action = memoSelection(node, options);
  destroy = action.destroy;
  options.onchange.mockImplementation((ids: Set<string>, mode: boolean) => {
    options = { ...options, selected: ids, selecting: mode };
    action.update(options);
  });
  return { node, cards, changed: options.onchange, selected: () => [...options.selected], selecting: () => options.selecting };
}
function pointer(target: EventTarget, type: string, y: number, extra: Record<string, unknown> = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: y, ...extra });
  Object.assign(event, { pointerId: 1, pointerType: 'mouse' });
  target.dispatchEvent(event);
  return event;
}
function touch(target: EventTarget, type: string, y: number, fingers = 1) {
  const touches = Array.from({ length: fingers }, (_, identifier) => ({ identifier, clientX: 10, clientY: y }));
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { touches: type === 'touchend' || type === 'touchcancel' ? [] : touches, changedTouches: touches });
  target.dispatchEvent(event);
  return event;
}

describe('memo selection gestures', () => {
  it('holds a side margin to select its row and drags a reversible range without losing earlier selections', () => {
    const wall = fixture(['d'], true);
    pointer(wall.node, 'pointerdown', 150);
    vi.advanceTimersByTime(400);
    expect(wall.selected()).toEqual(['d', 'a']);
    pointer(document, 'pointermove', 395);
    expect(wall.selected()).toEqual(['d', 'a', 'b', 'c']);
    pointer(document, 'pointermove', 275);
    expect(wall.selected()).toEqual(['d', 'a', 'b']);
    pointer(document, 'pointerup', 275);
    wall.node.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 275 }));
    expect(wall.selected()).toEqual(['d', 'a', 'b']);
  });
  it('removes a range starting on a selected card and restores it when dragging back', () => {
    const wall = fixture(['a', 'b', 'c', 'd'], true);
    pointer(wall.cards[1], 'pointerdown', 270);
    vi.advanceTimersByTime(400);
    pointer(document, 'pointermove', 510);
    expect(wall.selected()).toEqual(['a']);
    pointer(document, 'pointermove', 390);
    expect(wall.selected()).toEqual(['a', 'd']);
    pointer(document, 'pointerup', 390);
  });
  it('keeps taps and scrolling passive until a hold activates selection', () => {
    const wall = fixture();
    pointer(wall.cards[0], 'pointerdown', 150);
    pointer(document, 'pointerup', 150);
    vi.advanceTimersByTime(500);
    expect(wall.changed).not.toHaveBeenCalled();
    touch(wall.cards[0], 'touchstart', 150);
    expect(touch(wall.cards[0], 'touchmove', 170).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(500);
    expect(wall.changed).not.toHaveBeenCalled();
  });
  it('selects by touch after a hold, blocks scrolling during the range, and suppresses the resulting click', () => {
    const wall = fixture();
    touch(wall.cards[0], 'touchstart', 150);
    vi.advanceTimersByTime(400);
    expect(wall.selecting()).toBe(true);
    expect(touch(wall.cards[0], 'touchmove', 390).defaultPrevented).toBe(true);
    expect(wall.selected()).toEqual(['a', 'b', 'c']);
    expect(touch(wall.cards[0], 'touchend', 390).defaultPrevented).toBe(true);
    wall.cards[0].click();
    expect(wall.selected()).toEqual(['a', 'b', 'c']);
  });
  it('restores the original selection on touch cancellation or a second finger', () => {
    const wall = fixture(['d'], true);
    touch(wall.cards[0], 'touchstart', 150);
    vi.advanceTimersByTime(400);
    touch(wall.cards[0], 'touchmove', 390);
    touch(wall.cards[0], 'touchcancel', 390);
    expect(wall.selected()).toEqual(['d']);
    expect(wall.node.classList.contains('range-selecting')).toBe(false);
    touch(wall.cards[0], 'touchstart', 150);
    vi.advanceTimersByTime(400);
    touch(wall.cards[0], 'touchstart', 150, 2);
    expect(wall.selected()).toEqual(['d']);
  });
  it.each(['.memo-body span', 'a', 'pre', 'button'])('leaves %s long presses and dragging alone', (selector) => {
    const wall = fixture(['d'], true);
    const target = wall.cards[0].querySelector(selector)!;
    pointer(target, 'pointerdown', 150);
    vi.advanceTimersByTime(500);
    expect(pointer(document, 'pointermove', 390).defaultPrevented).toBe(false);
    expect(wall.changed).not.toHaveBeenCalled();
    expect(wall.selected()).toEqual(['d']);
  });
  it('does not activate a card from the gap between rows, a right click, or Ctrl-click', () => {
    const wall = fixture();
    pointer(wall.node, 'pointerdown', 210);
    vi.advanceTimersByTime(500);
    pointer(wall.cards[0], 'pointerdown', 150, { button: 2 });
    vi.advanceTimersByTime(500);
    pointer(wall.cards[0], 'pointerdown', 150, { ctrlKey: true });
    vi.advanceTimersByTime(500);
    expect(wall.changed).not.toHaveBeenCalled();
  });
  it('auto-scrolls while selecting at the edge and stops on release', () => {
    const wall = fixture();
    pointer(wall.cards[0], 'pointerdown', 150);
    vi.advanceTimersByTime(400);
    pointer(document, 'pointermove', 690);
    vi.advanceTimersByTime(32);
    expect(wall.node.scrollTop).toBe(20);
    pointer(document, 'pointerup', 690);
    vi.advanceTimersByTime(32);
    expect(wall.node.scrollTop).toBe(20);
  });
  it('short clicks toggle ordinary text in selection mode but leave links, code, and buttons alone', () => {
    const wall = fixture(['d'], true);
    (wall.cards[0].querySelector('span') as HTMLElement).click();
    expect(wall.selected()).toEqual(['d', 'a']);
    for (const selector of ['a', 'pre', 'button']) (wall.cards[1].querySelector(selector) as HTMLElement).click();
    expect(wall.selected()).toEqual(['d', 'a']);
  });
});
