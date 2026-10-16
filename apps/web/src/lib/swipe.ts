// Leave form controls and horizontally scrollable memo content to the browser.
export function swipeToOpen(node: HTMLElement, options: { enabled: () => boolean; open: () => void }) {
  let start: { x: number; y: number; time: number } | undefined;
  function begin(event: TouchEvent) {
    start = undefined;
    if (!options.enabled() || event.touches.length !== 1) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, button, a, select, [contenteditable], pre, .album, .attachments')) return;
    const touch = event.touches[0];
    start = { x: touch.clientX, y: touch.clientY, time: performance.now() };
  }
  function move(event: TouchEvent) {
    if (!start) return;
    if (event.touches.length !== 1 || !options.enabled()) { start = undefined; return; }
    const dx = event.touches[0].clientX - start.x;
    const dy = Math.abs(event.touches[0].clientY - start.y);
    if ((dy > 12 && dy > Math.abs(dx)) || dx < -12) start = undefined;
    else if (dx > 20 && dx > dy * 1.6 && event.cancelable) event.preventDefault();
  }
  function end(event: TouchEvent) {
    const origin = start;
    start = undefined;
    if (!origin || !options.enabled() || event.touches.length || event.changedTouches.length !== 1) return;
    const dx = event.changedTouches[0].clientX - origin.x;
    const dy = Math.abs(event.changedTouches[0].clientY - origin.y);
    if (dx >= 72 && dy < 48 && dx > dy * 1.6 && performance.now() - origin.time < 650) {
      if (event.cancelable) event.preventDefault();
      options.open();
    }
  }
  const cancel = () => { start = undefined; };
  node.addEventListener('touchstart', begin, { passive: true });
  node.addEventListener('touchmove', move, { passive: false });
  node.addEventListener('touchend', end, { passive: false });
  node.addEventListener('touchcancel', cancel);
  return { destroy() {
    node.removeEventListener('touchstart', begin);
    node.removeEventListener('touchmove', move);
    node.removeEventListener('touchend', end);
    node.removeEventListener('touchcancel', cancel);
  } };
}
