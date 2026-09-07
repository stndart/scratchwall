import { describe, expect, it } from 'vitest';
import type { Memo } from './types';
import { compareMemoOrder, swipeAction } from './memoActions';

const memo = (id: string, createdAt: string, bumpedAt?: string): Memo => ({
  id, spaceId: 'space', body: '', tags: [], attachmentIds: [], createdAt, bumpedAt,
  updatedAt: bumpedAt ?? createdAt, syncState: 'synced'
});

describe('memo ordering', () => {
  it('places bumped memos after newer unbumped memos without changing creation time', () => {
    const old = memo('old', '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z');
    const newer = memo('new', '2026-01-02T00:00:00Z');
    expect([old, newer].sort(compareMemoOrder).map(({ id }) => id)).toEqual(['new', 'old']);
  });
});

describe('swipe action', () => {
  it('maps horizontal right and left swipes and ignores short or vertical gestures', () => {
    expect(swipeAction(80, 8)).toBe('bump');
    expect(swipeAction(-80, 8)).toBe('delete');
    expect(swipeAction(40, 2)).toBeUndefined();
    expect(swipeAction(80, 100)).toBeUndefined();
  });
});
