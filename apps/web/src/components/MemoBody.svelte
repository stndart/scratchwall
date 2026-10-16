<script lang="ts">
  import { inlineParts, memoBlocks, type InlinePart } from '../lib/memoText';
  import { highlightCode } from '../lib/codeHighlight';
  import CodeBlock from './CodeBlock.svelte';

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
      <CodeBlock value={block.value} highlighted={block.highlighted} />
    {:else}<span class="memo-prose">{@render inline(block.parts)}</span>{/if}
  {/each}
</div>
