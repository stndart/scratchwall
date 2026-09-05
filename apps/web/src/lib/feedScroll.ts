export const BOTTOM_THRESHOLD = 80;

export function isNearBottom(
  element: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  threshold = BOTTOM_THRESHOLD
) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

export function prependScrollDelta(previousHeight: number, nextHeight: number) {
  return Math.max(0, nextHeight - previousHeight);
}

export function captureAnchor(feed: HTMLElement): { id: string; offset: number } | undefined {
  const top = feed.getBoundingClientRect().top;
  for (const memo of feed.querySelectorAll<HTMLElement>('[data-memo-id]')) {
    const id = memo.dataset.memoId;
    if (!id) continue;
    const rect = memo.getBoundingClientRect();
    if (rect.bottom > top) return { id, offset: rect.top - top };
  }
}

export function restoreAnchor(feed: HTMLElement, anchor: { id: string; offset: number }) {
  const memo = feed.querySelector<HTMLElement>(`[data-memo-id="${CSS.escape(anchor.id)}"]`);
  if (!memo) return;
  feed.scrollTop += memo.getBoundingClientRect().top - feed.getBoundingClientRect().top - anchor.offset;
}
