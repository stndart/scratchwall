<script lang="ts">
  import { embeddingSettings } from '../lib/api';
  import type { EmbeddingSettings } from '../lib/semanticSearch';
  import { embeddingStatus } from '../lib/embeddingProgress';
  let { settings, eta, onchange }: { settings: EmbeddingSettings; eta?: number; onchange: (settings: EmbeddingSettings) => void } = $props();
  let busy = $state(false);
  let error = $state('');
  async function toggle(enabled: boolean) {
    busy = true; error = '';
    try { onchange(await embeddingSettings(enabled)); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
</script>
<div class="settings-section">
  <h3>Smart search</h3>
  <label class="enter-preference">
    <input type="checkbox" checked={settings.enabled} disabled={busy || (!settings.configured && !settings.enabled)} onchange={event => {
      const input = event.currentTarget;
      void toggle(input.checked).finally(() => { input.checked = settings.enabled; });
    }} />
    <span>Enable embeddings</span>
  </label>
  <p class="embedding-state" role="status">{embeddingStatus(settings, eta)}</p>
  {#if error}<p role="alert">{error}</p>{/if}
</div>
<style>
  .embedding-state { margin: 7px 0 0 23px; color: var(--muted); font-size: 12px; line-height: 1.5; }
</style>
