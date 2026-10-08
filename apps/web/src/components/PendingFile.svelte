<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { formatBytes } from '../lib/media';
  export let file: File;
  export let onremove: () => void;
  export let disabled = false;
  let url = '';
  onMount(() => {
    if (file.type.startsWith('image/')) url = URL.createObjectURL(file);
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  });
</script>

<div class="pending-file">
  {#if url}<img src={url} alt="" />{:else}<span class="pending-file-icon"
      ><Icon name="file" /></span
    >{/if}
  <span
    ><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span
  >
  <button
    class="icon-button"
    {disabled}
    aria-label={`Remove ${file.name}`}
    onclick={onremove}><Icon name="close" size={16} /></button
  >
</div>
