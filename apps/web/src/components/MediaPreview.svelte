<script lang="ts">
  import { onMount } from 'svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import type { Attachment } from '../lib/types';
  import { getAttachment, putAttachment } from '../lib/repository';
  import { downloadAttachment } from '../lib/api';
  import { formatBytes, isVideoMime } from '../lib/media';
  import { isTypingTarget } from '../lib/clipboard';

  export let attachment: Attachment;
  export let gallery: Attachment[] = [];
  export let onclose: () => void;
  export let oncached: () => void;
  let url = '';
  let error = '';
  let loading = true;
  let playbackError = '';
  let mounted = false;
  let loadVersion = 0;
  $: galleryIndex = gallery.findIndex((item) => item.id === attachment.id);
  $: hasGallery = galleryIndex >= 0 && gallery.length > 1;
  $: if (mounted) void loadAttachment(attachment);

  function navigate(direction: number) {
    const next = galleryIndex + direction;
    if (galleryIndex >= 0 && next >= 0 && next < gallery.length)
      attachment = gallery[next];
  }

  function handleKeydown(event: KeyboardEvent) {
    if (
      !hasGallery || event.defaultPrevented || event.isComposing ||
      event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
      isTypingTarget(event.target)
    ) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    navigate(event.key === 'ArrowRight' ? 1 : -1);
  }

  function mediaFailed(event: Event) {
    const video = event.currentTarget as HTMLVideoElement;
    playbackError = video.error?.code === 3
      ? 'This video could not be decoded. Download it to play in another app.'
      : 'This browser could not play the video format. Download it to play in another app.';
  }

  async function loadAttachment(current: Attachment) {
    const version = ++loadVersion;
    if (url) URL.revokeObjectURL(url);
    url = '';
    error = '';
    playbackError = '';
    loading = true;
    try {
      let blob = (await getAttachment(current.id))?.blob;
      if (!blob) {
        blob = await downloadAttachment(current.id);
        await putAttachment(
          { ...current, cacheState: 'cached', remoteReady: true },
          blob,
        );
        oncached();
      }
      if (version === loadVersion)
        url = URL.createObjectURL(new Blob([blob], { type: current.mimeType }));
    } catch (value) {
      if (version === loadVersion)
        error = value instanceof Error
          ? value.message
          : 'Could not open this file. Connect to download it.';
    } finally {
      if (version === loadVersion) loading = false;
    }
  }

  onMount(() => {
    mounted = true;
    window.addEventListener('keydown', handleKeydown, true);
    return () => {
      loadVersion += 1;
      window.removeEventListener('keydown', handleKeydown, true);
      if (url) URL.revokeObjectURL(url);
    };
  });
</script>

<Dialog title={attachment.filename} wide media {onclose}>
  <div class="media-preview" aria-busy={loading}>
    {#if loading}<div class="media-loading">
        <span class="spinner"></span>
        <p>Opening your file…</p>
      </div>
    {:else if error}<div class="media-loading" role="alert">
        <Icon name="warning" size={28} />
        <p>{error}</p>
      </div>
    {:else if isVideoMime(attachment.mimeType)}
      <!-- svelte-ignore a11y_media_has_caption (Original user uploads may not include captions.) -->
      <video src={url} controls playsinline preload="metadata" onerror={mediaFailed} aria-label={attachment.filename}></video>
    {:else}<img src={url} alt={attachment.filename} />{/if}
  </div>
  <div class="media-footer">
    <div class="media-details">
      {#if hasGallery}<div class="media-navigation" role="group" aria-label="Space gallery">
          <button
            class="icon-button media-previous"
            type="button"
            aria-label="Previous photo or video"
            title="Previous (←)"
            disabled={galleryIndex === 0}
            onclick={() => navigate(-1)}><Icon name="chevron" /></button>
          <span class="media-position" role="status">{galleryIndex + 1} / {gallery.length}</span>
          <button
            class="icon-button"
            type="button"
            aria-label="Next photo or video"
            title="Next (→)"
            disabled={galleryIndex === gallery.length - 1}
            onclick={() => navigate(1)}><Icon name="chevron" /></button>
        </div>{/if}
      <span>{#if playbackError}<span role="alert">{playbackError}</span>{:else}{formatBytes(attachment.size)}{/if}</span>
    </div>{#if url}<a
        class="secondary"
        href={url}
        download={attachment.filename}
        ><Icon name="download" size={17} />Download</a
      >{/if}
  </div>
</Dialog>
