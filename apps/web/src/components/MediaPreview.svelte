<script lang="ts">
  import { onMount } from 'svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import type { Attachment } from '../lib/types';
  import { getAttachment } from '../lib/repository';
  import { attachmentDownloads, cancelAttachmentDownload, ensureAttachmentAvailable } from '../lib/attachmentDownloads';
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
  $: download = $attachmentDownloads[attachment.id];
  $: percent = download?.total ? Math.min(100, Math.floor(download.received / download.total * 100)) : 0;
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
        blob = await ensureAttachmentAvailable(current);
        if (!blob) throw new Error('Could not read this file');
        oncached();
      }
      if (version === loadVersion)
        url = URL.createObjectURL(new Blob([blob], { type: current.mimeType }));
    } catch (value) {
      if (version === loadVersion)
        error = $attachmentDownloads[current.id]?.phase === 'cancelled' ? 'Download cancelled.' : value instanceof Error
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
        {#if download}
          <div class="preview-transfer">
            <p>{download.phase === 'connecting' ? 'Connecting…' : download.phase === 'saving' ? 'Saving to device…' : 'Downloading'}</p>
            <span class="preview-transfer-details">{`${formatBytes(download.received)} / ${formatBytes(download.total)}${download.phase === 'downloading' ? ` · ${percent}%` : ''}`}</span>
            <progress max={download.total || 1} value={download.phase === 'connecting' ? undefined : download.received} aria-label={`Download ${attachment.filename}`}></progress>
            {#if download.phase !== 'saving'}<button class="secondary" type="button" onclick={() => cancelAttachmentDownload(attachment.id)}>Cancel download</button>{/if}
          </div>
        {:else}
          <span class="spinner"></span>
          <p>Opening your file…</p>
        {/if}
      </div>
    {:else if error}<div class="media-loading" role="alert">
        <Icon name="warning" size={28} />
        <p>{error}</p>
        <button class="secondary" type="button" onclick={() => void loadAttachment(attachment)}>Retry download</button>
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
      <span>{#if playbackError}<span role="alert">{playbackError}</span>{:else if !loading || !download}{formatBytes(attachment.size)}{/if}</span>
    </div>{#if url}<a
        class="secondary"
        href={url}
        download={attachment.filename}
        ><Icon name="download" size={17} />Download</a
      >{/if}
  </div>
</Dialog>

<style>
  .preview-transfer { display: grid; justify-items: center; gap: 12px; width: min(320px, 100%); }
  .preview-transfer p { margin: 0; }
  .preview-transfer-details { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--muted); }
  progress { width: 100%; height: 4px; border: 0; border-radius: 999px; overflow: hidden; accent-color: var(--accent); }
  progress::-webkit-progress-bar { background: var(--line); }
  progress::-webkit-progress-value { background: var(--accent); }
  progress::-moz-progress-bar { background: var(--accent); }
</style>
