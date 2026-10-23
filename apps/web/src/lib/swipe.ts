// Leave form controls and horizontally scrollable memo content to the browser.
export function swipeToOpen(node: HTMLElement, options: {
  enabled: () => boolean;
  open: () => void;
  width?: () => number;
  progress?: (value: number | undefined) => void;
}) {
  let start: { x: number; y: number; time: number; identifier: number } | undefined;
  let dragging = false;
  function cancel() {
    start = undefined;
    if (dragging) options.progress?.(undefined);
    dragging = false;
  }
  function begin(event: TouchEvent) {
    cancel();
    if (!options.enabled() || event.touches.length !== 1) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, button, label, a, select, [contenteditable], pre, .album, .attachments')) return;
    const touch = event.touches[0];
    start = { x: touch.clientX, y: touch.clientY, time: performance.now(), identifier: touch.identifier };
  }
  function move(event: TouchEvent) {
    if (!start) return;
    if (event.touches.length !== 1 || event.touches[0].identifier !== start.identifier || !options.enabled()) { cancel(); return; }
    const dx = event.touches[0].clientX - start.x;
    const dy = Math.abs(event.touches[0].clientY - start.y);
    if (!dragging && ((dy > 12 && dy > Math.abs(dx)) || dx < -12)) { cancel(); return; }
    if (!dragging && dx > 12 && dx > dy * 1.6) dragging = true;
    if (dragging) {
      if (event.cancelable) event.preventDefault();
      options.progress?.(Math.max(0, Math.min(1, dx / (options.width?.() ?? 310))));
    }
  }
  function end(event: TouchEvent) {
    const origin = start;
    if (!origin || !options.enabled() || event.touches.length || event.changedTouches.length !== 1 || event.changedTouches[0].identifier !== origin.identifier) { cancel(); return; }
    const dx = event.changedTouches[0].clientX - origin.x;
    const dy = Math.abs(event.changedTouches[0].clientY - origin.y);
    const deliberate = dx >= (options.width?.() ?? 310) * 0.4;
    const flick = dx >= 72 && performance.now() - origin.time < 650;
    if ((deliberate || flick) && (dragging || (dy < 48 && dx > dy * 1.6))) {
      if (event.cancelable) event.preventDefault();
      options.open();
    }
    cancel();
  }
  node.addEventListener('touchstart', begin, { passive: true });
  node.addEventListener('touchmove', move, { passive: false });
  node.addEventListener('touchend', end, { passive: false });
  node.addEventListener('touchcancel', cancel);
  return { destroy() {
    cancel();
    node.removeEventListener('touchstart', begin);
    node.removeEventListener('touchmove', move);
    node.removeEventListener('touchend', end);
    node.removeEventListener('touchcancel', cancel);
  } };
}
