<script lang="ts">
  import { inlineParts, memoBlocks, type InlinePart } from '../lib/memoText';
  import { highlightCode } from '../lib/codeHighlight';

  let { body }: { body: string } = $props();
  const blocks = $derived(memoBlocks(body).map((block) => block.type === 'code'
    ? { ...block, highlighted: highlightCode(block.value, block.language) }
    : { ...block, parts: inlineParts(block.value) }));
</script>

{#snippet inline(parts: InlinePart[])}
  {#each parts as part}{#if part.type === 'bold'}<strong>{@render inline(part.children)}</strong>{:else if part.type === 'italic'}<em>{@render inline(part.children)}</em>{:else if part.type === 'link'}<a href={part.href} target="_blank" rel="noreferrer">{part.value}</a>{:else if part.type === 'code'}<code class="memo-inline-code">{part.value}</code>{:else if 'value' in part}{part.value}{/if}{/each}
{/snippet}

<div class="memo-body">
  {#each blocks as block}
    {#if block.type === 'code'}
      <div class="memo-code-block">
        <div class="memo-code-language">{block.highlighted.language ?? 'Code'}</div>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to focus code to scroll long lines.) -->
        <pre class="memo-code" tabindex="0" aria-label={`${block.highlighted.language ?? 'Plain text'} code snippet`}><code class="hljs">{@html block.highlighted.html}</code></pre>
      </div>
    {:else}<span class="memo-prose">{@render inline(block.parts)}</span>{/if}
  {/each}
</div>
