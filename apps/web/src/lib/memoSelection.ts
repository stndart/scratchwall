interface SelectionOptions {
  selecting: boolean;
  selected: Set<string>;
  memoIds: string[];
  onchange: (ids: Set<string>, selecting: boolean) => void;
}

const HOLD_MS = 400;
const SLOP = 8;
const INTERACTIVE = 'a, button, input, textarea, select, label, video, audio, pre, [contenteditable]';

// After a hold activates the range gesture, non-passive touchmove stops native
// panning. Before then, scrolling and text selection keep their usual behavior.
export function memoSelection(node: HTMLElement, initial: SelectionOptions) {
  let options = initial;
  let gesture: {
    id: string;
    pointerId: number;
    touch: boolean;
    x: number;
    y: number;
    active: boolean;
    base: Set<string>;
    add: boolean;
    wasSelecting: boolean;
  } | undefined;
  let hold = 0;
  let frame = 0;
  let pointerY = 0;
  let suppressClick = false;
  let clickTimer = 0;

  function memoAtY(y: number, nearest = false): string | undefined {
    const cards = Array.from(node.querySelectorAll<HTMLElement>('[data-memo-id]'));
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) return card.dataset.memoId;
    }
    if (nearest) {
      return cards.reduce<{ id?: string; distance: number }>((best, card) => {
        const rect = card.getBoundingClientRect();
        const distance = Math.min(Math.abs(y - rect.top), Math.abs(y - rect.bottom));
        return distance < best.distance ? { id: card.dataset.memoId, distance } : best;
      }, { distance: Infinity }).id;
    }
  }

  function hit(target: EventTarget | null, y: number, holding: boolean): string | undefined {
    if (!(target instanceof Element) || !node.contains(target) || target.closest(INTERACTIVE)) return;
    if (holding && target.closest('.memo-body, .memo-space, .tags, time')) return;
    const card = target.closest<HTMLElement>('[data-memo-id]');
    if (card) return card.dataset.memoId;
    if (target === node || target.matches('.feed-content')) return memoAtY(y);
  }

  function selectRange(y: number) {
    if (!gesture?.active) return;
    const id = memoAtY(y, true) ?? gesture.id;
    const start = options.memoIds.indexOf(gesture.id);
    const end = options.memoIds.indexOf(id);
    if (start < 0 || end < 0) return;
    const selected = new Set(gesture.base);
    for (const memoId of options.memoIds.slice(Math.min(start, end), Math.max(start, end) + 1)) {
      if (gesture.add) selected.add(memoId);
      else selected.delete(memoId);
    }
    options.onchange(selected, true);
  }

  function autoScroll() {
    if (!gesture?.active) return;
    const rect = node.getBoundingClientRect();
    const delta = pointerY < rect.top + 40 ? -10 : pointerY > rect.bottom - 40 ? 10 : 0;
    if (delta) {
      node.scrollTop += delta;
      selectRange(pointerY);
    }
    frame = requestAnimationFrame(autoScroll);
  }

  function activate() {
    if (!gesture || gesture.active) return;
    gesture.active = true;
    node.classList.add('range-selecting');
    const ids = new Set(gesture.base);
    if (gesture.add) ids.add(gesture.id);
    else ids.delete(gesture.id);
    options.onchange(ids, true);
    frame = requestAnimationFrame(autoScroll);
  }

  function reset(rollback = false) {
    clearTimeout(hold);
    cancelAnimationFrame(frame);
    if (rollback && gesture?.active) options.onchange(new Set(gesture.base), gesture.wasSelecting);
    gesture = undefined;
    node.classList.remove('range-selecting');
  }

  function begin(target: EventTarget | null, x: number, y: number, pointerId: number, touch: boolean) {
    clearTimeout(clickTimer);
    suppressClick = false;
    if (gesture) { reset(true); return; }
    const id = hit(target, y, true);
    if (!id) return;
    pointerY = y;
    gesture = { id, pointerId, touch, x, y, active: false,
      base: new Set(options.selected), add: !options.selected.has(id), wasSelecting: options.selecting };
    hold = window.setTimeout(activate, HOLD_MS);
  }

  function move(x: number, y: number): boolean {
    if (!gesture) return false;
    pointerY = y;
    if (!gesture.active && Math.hypot(x - gesture.x, y - gesture.y) > SLOP) {
      if (options.selecting && !gesture.touch) activate();
      else { reset(); return false; }
    }
    if (!gesture.active) return false;
    selectRange(y);
    return true;
  }

  function finish(cancel = false) {
    if (gesture?.active) {
      suppressClick = true;
      clickTimer = window.setTimeout(() => (suppressClick = false), 700);
    }
    reset(cancel);
  }

  function pointerDown(event: PointerEvent) {
    if (event.pointerType === 'touch' || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return;
    begin(event.target, event.clientX, event.clientY, event.pointerId, false);
  }
  function pointerMove(event: PointerEvent) {
    if (!gesture || gesture.touch || event.pointerId !== gesture.pointerId) return;
    if (move(event.clientX, event.clientY)) event.preventDefault();
  }
  function pointerUp(event: PointerEvent) {
    if (gesture && !gesture.touch && event.pointerId === gesture.pointerId) finish(event.type === 'pointercancel');
  }
  function touchStart(event: TouchEvent) {
    if (event.touches.length !== 1) { finish(true); return; }
    const touch = event.touches[0];
    begin(event.target, touch.clientX, touch.clientY, touch.identifier, true);
  }
  function touchMove(event: TouchEvent) {
    if (!gesture?.touch) return;
    if (event.touches.length !== 1) { finish(true); return; }
    const touch = event.touches[0];
    if (touch.identifier === gesture.pointerId && move(touch.clientX, touch.clientY)) event.preventDefault();
  }
  function touchEnd(event: TouchEvent) {
    if (!gesture?.touch) return;
    const ended = Array.from(event.changedTouches).some((touch) => touch.identifier === gesture?.pointerId);
    if (ended) {
      if (gesture.active) event.preventDefault();
      finish(event.type === 'touchcancel');
    }
  }
  function click(event: MouseEvent) {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!options.selecting || event.ctrlKey || event.metaKey || event.altKey || window.getSelection()?.toString()) return;
    const id = hit(event.target, event.clientY, false);
    if (!id) return;
    const ids = new Set(options.selected);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    options.onchange(ids, true);
    event.preventDefault();
  }
  function contextMenu(event: MouseEvent) {
    if (gesture) { event.preventDefault(); activate(); }
  }
  function cancelKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && gesture) finish(true);
  }
  function blur() { finish(true); }

  node.addEventListener('pointerdown', pointerDown);
  document.addEventListener('pointermove', pointerMove, { passive: false });
  document.addEventListener('pointerup', pointerUp);
  document.addEventListener('pointercancel', pointerUp);
  node.addEventListener('touchstart', touchStart, { passive: true });
  node.addEventListener('touchmove', touchMove, { passive: false });
  node.addEventListener('touchend', touchEnd, { passive: false });
  node.addEventListener('touchcancel', touchEnd, { passive: false });
  node.addEventListener('click', click, true);
  node.addEventListener('contextmenu', contextMenu);
  document.addEventListener('keydown', cancelKey);
  window.addEventListener('blur', blur);

  return {
    update(next: SelectionOptions) {
      if (gesture && (next.memoIds.join() !== options.memoIds.join() || (!next.selecting && gesture.active))) reset();
      options = next;
    },
    destroy() {
      reset();
      clearTimeout(clickTimer);
      node.removeEventListener('pointerdown', pointerDown);
      document.removeEventListener('pointermove', pointerMove);
      document.removeEventListener('pointerup', pointerUp);
      document.removeEventListener('pointercancel', pointerUp);
      node.removeEventListener('touchstart', touchStart);
      node.removeEventListener('touchmove', touchMove);
      node.removeEventListener('touchend', touchEnd);
      node.removeEventListener('touchcancel', touchEnd);
      node.removeEventListener('click', click, true);
      node.removeEventListener('contextmenu', contextMenu);
      document.removeEventListener('keydown', cancelKey);
      window.removeEventListener('blur', blur);
    },
  };
}
