<script lang="ts">
  import { onDestroy } from 'svelte';
  import Icon from './Icon.svelte';
  import { copyText } from '../lib/clipboard';

  let { value, highlighted }: {
    value: string;
    highlighted: { html: string; language?: string };
  } = $props();
  let status = $state('');
  let copying = $state(false);
  let timer: ReturnType<typeof setTimeout>;

  async function copy() {
    if (copying) return;
    copying = true;
    clearTimeout(timer);
    try {
      await copyText(value);
      status = 'Copied';
    } catch {
      status = 'Could not copy. Select the code to copy it manually.';
    } finally {
      copying = false;
      timer = setTimeout(() => (status = ''), 3000);
    }
  }
  onDestroy(() => clearTimeout(timer));
</script>

<div class="memo-code-block">
  <div class="memo-code-header">
    <span class="memo-code-language">{highlighted.language ?? 'Code'}</span>
    <span class="memo-copy-status" role="status">{status === 'Copied' ? '' : status}</span>
    <button class="memo-code-copy" aria-label="Copy code" onclick={copy} disabled={copying}>
      <Icon name={status === 'Copied' ? 'check' : 'copy'} size={14} />
      <span aria-live="polite">{status === 'Copied' ? 'Copied' : 'Copy'}</span>
    </button>
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to focus code to scroll long lines.) -->
  <pre class="memo-code" tabindex="0" aria-label={`${highlighted.language ?? 'Plain text'} code snippet`}><code class="hljs">{@html highlighted.html}</code></pre>
</div>
