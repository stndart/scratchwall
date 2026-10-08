import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNearBottom, prependScrollDelta, restoreAnchor } from './feedScroll';

afterEach(() => vi.unstubAllGlobals());

describe('isNearBottom', () => {
  it('treats the last 80px as stuck to the latest message', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 920, clientHeight: 100 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 100 })).toBe(false);
  });
});

describe('prependScrollDelta', () => {
  it('shifts scroll by the height added above the current memos', () => {
    expect(prependScrollDelta(400, 900)).toBe(500);
    expect(prependScrollDelta(400, 400)).toBe(0);
  });
});

describe('restoreAnchor', () => {
  function mockFeed(memoTop: number) {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    const setScrollTop = vi.fn();
    const feed = {
      get scrollTop() { return 500; },
      set scrollTop(value: number) { setScrollTop(value); },
      getBoundingClientRect: () => ({ top: 100 }),
      querySelector: () => ({ getBoundingClientRect: () => ({ top: memoTop }) }),
    } as unknown as HTMLElement;
    return { feed, setScrollTop };
  }

  it('does not write the scroll position when the memo has not moved', () => {
    const { feed, setScrollTop } = mockFeed(50);
    restoreAnchor(feed, { id: 'memo', offset: -50 });
    expect(setScrollTop).not.toHaveBeenCalled();
  });

  it('compensates for content added above the memo', () => {
    const { feed, setScrollTop } = mockFeed(250);
    restoreAnchor(feed, { id: 'memo', offset: -50 });
    expect(setScrollTop).toHaveBeenCalledExactlyOnceWith(700);
  });
});
