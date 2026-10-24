<script lang="ts">
  import type { Attachment } from './types';
  import type { AttachmentDownload } from './attachmentDownloads';
  import { attachmentStatusLabel, fileExtension, formatBytes, isAttachmentCached, isVideoMime } from './media';

  export let attachment: Attachment;
  export let download: AttachmentDownload | undefined = undefined;
  export let online = true;
  export let visual = false;
  export let hero = false;
  export let onopen: () => void;
  export let oncancel: () => void;

  $: active = Boolean(download && ['connecting', 'downloading', 'saving'].includes(download.phase));
  $: failed = download?.phase === 'error' || download?.phase === 'cancelled';
  $: available = isAttachmentCached(attachment.cacheState);
  $: percent = download?.total ? Math.min(100, Math.floor(download.received / download.total * 100)) : 0;
  $: label = download?.phase === 'connecting' ? 'Connecting…'
    : download?.phase === 'downloading' ? 'Downloading'
    : download?.phase === 'saving' ? 'Saving to device…'
    : download?.phase === 'error' ? 'Download failed · retry'
    : download?.phase === 'cancelled' ? 'Cancelled · retry'
    : !online && !available && attachment.remoteReady ? 'Connect to download'
    : attachmentStatusLabel(attachment.cacheState, attachment.remoteReady);
  $: action = active ? label : failed ? 'Retry download' : available ? 'Open' : 'Download';
</script>

{#snippet status()}
  <span class="attachment-status" class:available={!download && available && attachment.remoteReady} class:failed title={download?.phase === 'error' ? download.error : label}>
    <span class="status-size">{#if download?.phase === 'downloading'}{formatBytes(download.received)} / {formatBytes(download.total)}{:else}{formatBytes(attachment.size)}{/if}</span>
    <span class="status-separator" aria-hidden="true">·</span>
    <span class="status-label">{#if download?.phase === 'downloading'}{percent}%{:else}{#if !download && available && attachment.remoteReady}<span aria-hidden="true">✓ </span>{/if}{label}{/if}</span>
  </span>
  {#if active && download}
    <progress
      max={download.total || 1}
      value={download.phase === 'connecting' || (download.phase === 'downloading' && !download.total) ? undefined : download.received}
      aria-label={`Download ${attachment.filename}`}
      aria-valuetext={download.phase === 'saving' ? 'Saving to device' : `${formatBytes(download.received)} of ${formatBytes(download.total)}`}
    ></progress>
  {/if}
{/snippet}

<div class="attachment-card" class:visual class:hero class:active class:failed>
  <button
    type="button"
    class="attachment"
    class:image={visual}
    class:image-attachment={visual}
    class:hero
    class:video={visual && isVideoMime(attachment.mimeType)}
    class:remote={!available}
    disabled={active || (!available && (!online || !attachment.remoteReady))}
    aria-label={`${action} ${attachment.filename}`}
    aria-describedby={download?.phase === 'error' ? `attachment-error-${attachment.id}` : undefined}
    onclick={onopen}
  >
    {#if visual}
      <span class="file-preview">
        <img src={attachment.thumbnail} alt="" loading="lazy" draggable="false" />
        {#if isVideoMime(attachment.mimeType)}<span class="video-play" aria-hidden="true"></span>{/if}
        <span class="media-status">
          <span class="media-file" title={attachment.filename}>{attachment.filename}</span>
          {@render status()}
        </span>
      </span>
    {:else}
      <span class="file-badge" aria-hidden="true">{active ? '↓' : failed ? '↻' : fileExtension(attachment.filename)}</span>
      <span class="file-meta">
        <strong title={attachment.filename}>{attachment.filename}</strong>
        {@render status()}
      </span>
    {/if}
  </button>
  {#if download?.phase === 'error'}<span id={`attachment-error-${attachment.id}`} hidden>{download.error}</span>{/if}
  {#if active && download?.phase !== 'saving'}
    <button type="button" class="cancel-download" aria-label={`Cancel download ${attachment.filename}`} title="Cancel download" onclick={oncancel}>×</button>
  {/if}
</div>

<style>
  .attachment-card { position: relative; min-width: 0; }
  .attachment-card:not(.visual) { display: flex; }
  .attachment-card:not(.visual) .attachment { flex: 1; align-items: center; gap: 0; padding: 9px; }
  .visual .attachment { display: block; width: 100%; padding: 0; border: 0; border-radius: 0; background: var(--soft); }
  .file-preview { position: relative; display: block; }
  .file-badge { height: 42px; margin-right: 10px; }
  .attachment:disabled { cursor: default; opacity: 1; }
  .attachment:not(:disabled):hover { border-color: var(--accent); }
  .attachment:focus-visible, .cancel-download:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
  .active .attachment { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); }
  .failed .attachment { border-color: var(--danger); }
  .file-meta { flex: 1; }
  .file-meta strong { line-height: 20px; }
  .active:not(.visual) .file-meta strong { padding-right: 28px; }
  .attachment-status { display: flex; align-items: baseline; gap: 5px; min-width: 0; margin-top: 3px; color: var(--muted); font-size: 11px; font-weight: 500; line-height: 16px; }
  .status-size { flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .status-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--accent); }
  .failed .status-label { color: var(--danger); }
  progress { display: block; width: 100%; height: 3px; margin: 6px 0 0; overflow: hidden; border: 0; border-radius: 999px; background: #ffffff20; accent-color: var(--accent); }
  .attachment-card:not(.visual) progress { position: absolute; right: 9px; bottom: 4px; left: 9px; width: calc(100% - 18px); margin: 0; }
  progress::-webkit-progress-bar { border-radius: 999px; background: #ffffff20; }
  progress::-webkit-progress-value { border-radius: 999px; background: var(--accent); }
  progress::-moz-progress-bar { border-radius: 999px; background: var(--accent); }
  progress:indeterminate { background: linear-gradient(90deg, #ffffff15 25%, var(--accent) 50%, #ffffff15 75%); background-size: 200% 100%; animation: loading 1.4s linear infinite; }
  progress:indeterminate::-webkit-progress-bar { background: transparent; }
  .cancel-download { position: absolute; top: 4px; right: 4px; display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); color: inherit; font-size: 20px; cursor: pointer; }
  .media-status { position: absolute; inset: auto 0 0; padding: 30px 12px 10px; background: linear-gradient(transparent, #080b12ed 30%); color: #fff; }
  .media-file { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: #e1e5ef; }
  .visual .attachment-status { color: #c5cbd8; }
  .visual .status-label { color: #c5e4b9; }
  .visual.failed .status-label { color: #ffb4c1; }
  .visual progress { accent-color: #a4c49a; }
  .visual progress::-webkit-progress-value { background: #a4c49a; }
  .visual progress::-moz-progress-bar { background: #a4c49a; }
  .visual .cancel-download { background: #11141be6; border-color: #ffffff30; color: white; }
  @keyframes loading { to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { progress:indeterminate { animation: none; } }
</style>
