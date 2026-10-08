<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  export let title: string;
  export let onclose: () => void;
  export let drawer = false;
  export let wide = false;
  export let media = false;
  let dialog: HTMLDialogElement;
  function closeDialog() {
    dialog.close();
    onclose();
  }
  onMount(() => {
    const opener = document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => {
      dialog.close();
      queueMicrotask(() => {
        if (opener instanceof HTMLElement && opener.isConnected && !document.querySelector('dialog[open]')) {
          opener.focus({ preventScroll: true });
        }
      });
    };
  });
</script>

<dialog
  bind:this={dialog}
  class:drawer
  class:wide
  class:media
  aria-label={title}
  oncancel={(event) => {
    event.preventDefault();
    closeDialog();
  }}
  onclick={(event) => {
    if (
      event.target === dialog &&
      (event.clientX < dialog.getBoundingClientRect().left ||
        event.clientX > dialog.getBoundingClientRect().right ||
        event.clientY < dialog.getBoundingClientRect().top ||
        event.clientY > dialog.getBoundingClientRect().bottom)
    )
      closeDialog();
  }}
>
  {#if !drawer}
    <div class="dialog-heading">
      <h2>{title}</h2>
      <button class="icon-button" aria-label="Close dialog" onclick={closeDialog}
        ><Icon name="close" /></button
      >
    </div>
  {/if}
  <slot />
</dialog>
