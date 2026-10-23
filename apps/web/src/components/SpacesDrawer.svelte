<script lang="ts">
  import { onDestroy, tick } from 'svelte';

  export let open = false;
  export let pull: number | undefined = undefined;
  export let onclose: () => void;

  let visible = false;
  let reveal = 0;
  let dialog: HTMLDialogElement;
  let modal = false;
  let opener: Element | null;
  let timer = 0;
  let revision = 0;

  function duration() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 220;
  }

  function restoreFocus() {
    if (opener instanceof HTMLElement && opener.isConnected && !document.querySelector('dialog[open]')) {
      opener.focus({ preventScroll: true });
    }
  }

  function makeModal() {
    if (!dialog || modal) return;
    if (dialog.open) dialog.close();
    dialog.showModal();
    modal = true;
  }

  async function present(wanted: boolean, progress: number | undefined) {
    const current = ++revision;
    clearTimeout(timer);
    if (wanted || progress !== undefined) {
      const fresh = !visible;
      if (fresh) {
        opener = document.activeElement;
        reveal = progress ?? 0;
        visible = true;
        await tick();
      } else {
        reveal = progress ?? 1;
        if (!dialog) await tick();
      }
      if (current !== revision) return;
      if (progress !== undefined) {
        if (!dialog.open) dialog.show();
        reveal = progress;
      } else if (fresh || !dialog.open) {
        makeModal();
        dialog.getBoundingClientRect();
        reveal = 1;
      } else {
        reveal = 1;
        // Keep the original touch target active until the pull has settled.
        if (!modal && duration()) timer = window.setTimeout(makeModal, duration());
        else makeModal();
      }
    } else if (visible) {
      reveal = 0;
      const hide = () => {
        dialog?.close();
        modal = false;
        visible = false;
        void tick().then(restoreFocus);
      };
      if (dialog?.open && duration()) timer = window.setTimeout(hide, duration());
      else hide();
    }
  }

  $: void present(open, pull);

  onDestroy(() => {
    revision += 1;
    clearTimeout(timer);
    dialog?.close();
    queueMicrotask(restoreFocus);
  });
</script>

{#if visible}
  <button class="drawer-shade" class:pulling={pull !== undefined} style:opacity={reveal}
    tabindex="-1" aria-label="Dismiss spaces" aria-hidden={pull !== undefined} onclick={onclose}></button>
  <dialog bind:this={dialog} class="drawer" class:pulling={pull !== undefined}
    style:transform={`translateX(${(reveal - 1) * 100}%)`}
    data-swipe-preview={pull !== undefined ? '' : undefined} inert={pull !== undefined}
    aria-label="Your spaces" aria-hidden={pull !== undefined}
    oncancel={(event) => { event.preventDefault(); onclose(); }}
    onclick={(event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onclose();
    }}>
    <slot />
  </dialog>
{/if}
