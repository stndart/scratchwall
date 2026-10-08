<script lang="ts">
  import { onMount } from 'svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import type { Attachment } from '../lib/types';
  import { getAttachment, putAttachment } from '../lib/repository';
  import { downloadAttachment } from '../lib/api';
  import { formatBytes, isVideoMime } from '../lib/media';

  export let attachment: Attachment;
  export let onclose: () => void;
  export let oncached: () => void;
  let url = '';
  let error = '';
  let loading = true;
  let playbackError = '';
  function mediaFailed(event: Event) {
    const video = event.currentTarget as HTMLVideoElement;
    playbackError = video.error?.code === 3
      ? 'This video could not be decoded. Download it to play in another app.'
      : 'This browser could not play the video format. Download it to play in another app.';
  }

  onMount(() => {
    let active = true;
    void (async () => {
      try {
        let blob = (await getAttachment(attachment.id))?.blob;
        if (!blob) {
          blob = await downloadAttachment(attachment.id);
          await putAttachment(
            { ...attachment, cacheState: 'cached', remoteReady: true },
            blob,
          );
          oncached();
        }
        if (active)
          url = URL.createObjectURL(
            new Blob([blob], { type: attachment.mimeType }),
          );
      } catch (value) {
        if (active)
          error =
            value instanceof Error
              ? value.message
              : 'Could not open this file. Connect to download it.';
      } finally {
        if (active) loading = false;
      }
    })();
    return () => {
      active = false;
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
    <span>{#if playbackError}<span role="alert">{playbackError}</span>{:else}{formatBytes(attachment.size)}{/if}</span>{#if url}<a
        class="secondary"
        href={url}
        download={attachment.filename}
        ><Icon name="download" size={17} />Download</a
      >{/if}
  </div>
</Dialog>
