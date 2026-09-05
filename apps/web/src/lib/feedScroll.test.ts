import { describe, expect, it } from 'vitest';
import { isNearBottom, prependScrollDelta } from './feedScroll';

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
