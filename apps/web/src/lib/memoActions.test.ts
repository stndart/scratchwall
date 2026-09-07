// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { Memo } from './types';
import { compareMemoOrder, isTapGesture, swipeAction, swipeIgnoresTarget } from './memoActions';

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

describe('tap vs swipe', () => {
  it('treats small movement as a tap and larger movement as a drag', () => {
    expect(isTapGesture(0, 0)).toBe(true);
    expect(isTapGesture(8, 4)).toBe(true);
    expect(isTapGesture(20, 0)).toBe(false);
    expect(isTapGesture(0, 20)).toBe(false);
  });
});

describe('swipe target filtering', () => {
  it('allows swipe to start on album images and ignores other controls', () => {
    const album = document.createElement('button');
    album.className = 'attachment image';
    const img = document.createElement('img');
    album.append(img);
    expect(swipeIgnoresTarget(img)).toBe(false);
    expect(swipeIgnoresTarget(album)).toBe(false);

    const file = document.createElement('button');
    file.className = 'attachment';
    expect(swipeIgnoresTarget(file)).toBe(true);

    const tag = document.createElement('button');
    expect(swipeIgnoresTarget(tag)).toBe(true);

    const link = document.createElement('a');
    link.href = 'https://example.test';
    expect(swipeIgnoresTarget(link)).toBe(true);

    const body = document.createElement('p');
    expect(swipeIgnoresTarget(body)).toBe(false);
  });
});
