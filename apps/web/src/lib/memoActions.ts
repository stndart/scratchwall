import type { Memo } from './types';

export function memoOrderTime(memo: Memo): number {
  return Date.parse(memo.bumpedAt ?? memo.createdAt) || 0;
}

export function compareMemoOrder(left: Memo, right: Memo): number {
  return memoOrderTime(left) - memoOrderTime(right)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

export function swipeAction(deltaX: number, deltaY: number, threshold = 72): 'bump' | 'delete' | undefined {
  if (Math.abs(deltaY) > Math.abs(deltaX) || Math.abs(deltaX) < threshold) return undefined;
  return deltaX > 0 ? 'bump' : 'delete';
}
