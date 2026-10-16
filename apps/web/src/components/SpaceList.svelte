<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import type { Space } from '../lib/types';

  let { spaces, selectedSpace, counts, disabled = false, onselect, onreorder, onadd }: {
    spaces: Space[];
    selectedSpace: string;
    counts: Map<string, number>;
    disabled?: boolean;
    onselect: (id: string) => void;
    onreorder: (ids: string[]) => Promise<boolean | void>;
    onadd: () => void;
  } = $props();
  let nav: HTMLElement;
  let dragged = $state('');
  let preview = $state<string[] | undefined>();
  let announcement = $state('');
  let pointerId: number | undefined;
  let pointerY = 0;
  let startY = 0;
  let moved = false;
  let consumeTouchEnd = false;
  let frame = 0;
  let holdTimer = 0;
  let touchHold: { id: string; identifier: number; x: number; y: number } | undefined;
  let suppressClickUntil = 0;
  const ordered = $derived(preview
    ? preview.map((id) => spaces.find((space) => space.id === id)).filter((space): space is Space => !!space)
    : spaces);

  function placeAtPointer() {
    if (!dragged || !preview) return;
    const rows = Array.from(nav.querySelectorAll<HTMLElement>('[data-space-id]'));
    const others = rows.filter((row) => row.dataset.spaceId !== dragged);
    const index = others.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return pointerY < rect.top + rect.height / 2;
    });
    const ids = others.map((row) => row.dataset.spaceId!);
    ids.splice(index < 0 ? ids.length : index, 0, dragged);
    if (ids.join() !== preview.join()) preview = ids;
  }

  function autoScroll() {
    if (!dragged) return;
    const scroll = nav.closest<HTMLElement>('.sidebar-scroll');
    if (scroll) {
      const rect = scroll.getBoundingClientRect();
      const delta = pointerY < rect.top + 36 ? -8 : pointerY > rect.bottom - 36 ? 8 : 0;
      if (delta) {
        scroll.scrollTop += delta;
        placeAtPointer();
      }
    }
    frame = requestAnimationFrame(autoScroll);
  }

  function start(event: PointerEvent, id: string) {
    if (disabled || spaces.length < 2 || event.button !== 0 || pointerId !== undefined) return;
    if (event.pointerType !== 'touch') event.preventDefault();
    // Capture on the stable nav: keyed rows move in the DOM during preview.
    nav.setPointerCapture(event.pointerId);
    pointerId = event.pointerId;
    pointerY = event.clientY;
    startY = pointerY;
    moved = false;
    consumeTouchEnd = false;
    dragged = id;
    preview = spaces.map((space) => space.id);
  }

  function move(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    if (event.pointerType !== 'touch') event.preventDefault();
    pointerY = event.clientY;
    if (!moved) {
      if (Math.abs(pointerY - startY) < 6) return;
      moved = true;
      frame = requestAnimationFrame(autoScroll);
    }
    placeAtPointer();
  }

  function cancel(release = true) {
    const captured = pointerId;
    cancelAnimationFrame(frame);
    dragged = '';
    preview = undefined;
    pointerId = undefined;
    clearTimeout(holdTimer);
    touchHold = undefined;
    if (release && captured !== undefined && nav?.hasPointerCapture?.(captured)) nav.releasePointerCapture(captured);
  }

  async function finish(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    const ids = preview;
    const name = spaces.find((space) => space.id === dragged)?.name;
    const position = ids?.indexOf(dragged);
    consumeTouchEnd = event.pointerType === 'touch' && moved;
    // Pointer-up releases capture automatically after event dispatch.
    cancel(false);
    if (ids && ids.some((id, index) => id !== spaces[index]?.id)) {
      if (await onreorder(ids) !== false) announcement = `${name} moved to position ${(position ?? 0) + 1}.`;
    }
  }

  function touchDrag(node: HTMLElement) {
    const begin = (event: TouchEvent) => {
      if (event.touches.length !== 1) { cancel(); return; }
      if (disabled || spaces.length < 2 || pointerId !== undefined) return;
      const button = event.target instanceof Element ? event.target.closest('.space-button') : null;
      const id = button?.closest<HTMLElement>('[data-space-id]')?.dataset.spaceId;
      if (!id) return;
      const touch = event.touches[0];
      touchHold = { id, identifier: touch.identifier, x: touch.clientX, y: touch.clientY };
      holdTimer = window.setTimeout(() => {
        if (!touchHold) return;
        dragged = id;
        preview = spaces.map((space) => space.id);
        startY = pointerY = touch.clientY;
        moved = false;
        announcement = `Moving ${spaces.find((space) => space.id === id)?.name}. Drag to reorder.`;
      }, 400);
    };
    // Consume native touch movement too, so a pan cannot swallow the next tap.
    const move = (event: TouchEvent) => {
      if (touchHold) {
        if (event.touches.length !== 1) { cancel(); return; }
        const touch = event.touches[0];
        if (touch.identifier !== touchHold.identifier) return;
        if (!dragged) {
          if (Math.hypot(touch.clientX - touchHold.x, touch.clientY - touchHold.y) > 8) cancel();
          return;
        }
        event.preventDefault();
        pointerY = touch.clientY;
        if (!moved && Math.abs(pointerY - startY) >= 6) {
          moved = true;
          frame = requestAnimationFrame(autoScroll);
        }
        if (moved) placeAtPointer();
        return;
      }
      if (dragged && moved) event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      if (touchHold) {
        const ids = preview;
        const id = dragged;
        if (id) {
          event.preventDefault();
          suppressClickUntil = performance.now() + 700;
        }
        cancel();
        if (ids && ids.some((value, index) => value !== spaces[index]?.id)) {
          void onreorder(ids).then((saved) => {
            if (saved !== false) announcement = `${spaces.find((space) => space.id === id)?.name} moved to position ${ids.indexOf(id) + 1}.`;
          });
        }
        return;
      }
      if (consumeTouchEnd) event.preventDefault();
      consumeTouchEnd = false;
    };
    const context = (event: Event) => { if (touchHold || dragged) event.preventDefault(); };
    const click = (event: Event) => {
      if (performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const abort = () => cancel();
    node.addEventListener('touchstart', begin, { passive: true });
    node.addEventListener('touchmove', move, { passive: false });
    node.addEventListener('touchend', end, { passive: false });
    node.addEventListener('touchcancel', abort);
    node.addEventListener('contextmenu', context);
    node.addEventListener('click', click, true);
    return { destroy: () => {
      node.removeEventListener('touchstart', begin);
      node.removeEventListener('touchmove', move);
      node.removeEventListener('touchend', end);
      node.removeEventListener('touchcancel', abort);
      node.removeEventListener('contextmenu', context);
      node.removeEventListener('click', click, true);
    } };
  }

  async function keyboardMove(event: KeyboardEvent, id: string, handle = false) {
    if (event.key === 'Escape' && dragged) {
      event.preventDefault();
      cancel();
      return;
    }
    if (!(handle || event.altKey) || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (disabled || dragged) return;
    const index = spaces.findIndex((space) => space.id === id);
    const destination = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (destination < 0 || destination >= spaces.length) return;
    const target = event.currentTarget as HTMLElement;
    const ids = spaces.map((space) => space.id);
    ids.splice(index, 1);
    ids.splice(destination, 0, id);
    const saved = await onreorder(ids);
    await tick();
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: 'nearest' });
    if (saved !== false) announcement = `${spaces.find((space) => space.id === id)?.name} moved to position ${destination + 1}.`;
  }

  onDestroy(() => cancel());
</script>

<nav bind:this={nav} use:touchDrag aria-label="Spaces" onpointermove={move} onpointerup={finish}
  onpointercancel={() => { if (!touchHold) cancel(false); }} onlostpointercapture={() => { if (!touchHold) cancel(false); }}>
  {#each ordered as space (space.id)}
    <div class="space-row" data-space-id={space.id} class:active={space.id === selectedSpace} class:reordering={dragged === space.id}>
      <button class="space-button"
        aria-current={space.id === selectedSpace ? 'page' : undefined}
        onclick={() => onselect(space.id)}
        onkeydown={(event) => keyboardMove(event, space.id)}>
        <Icon name={space.isInbox ? 'inbox' : 'folder'} size={19} />
        <span>{space.name}</span><small>{counts.get(space.id) ?? 0}</small>
      </button>
      <button class="space-grip" aria-label={`Reorder ${space.name}`}
        title="Hold and drag to reorder. Or use ↑ / ↓."
        disabled={disabled || spaces.length < 2}
        onpointerdown={(event) => start(event, space.id)}
        onkeydown={(event) => keyboardMove(event, space.id, true)}>
        <Icon name="grip" size={18} />
      </button>
    </div>
  {/each}
  <button class="new-space" onclick={onadd}><Icon name="plus" size={18} />New space</button>
  <span class="sr-only" role="status">{announcement}</span>
</nav>
