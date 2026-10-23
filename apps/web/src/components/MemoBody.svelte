<script lang="ts">
  import { inlineParts, memoBlocks, type InlinePart } from '../lib/memoText';
  import { highlightCode } from '../lib/codeHighlight';
  import CodeBlock from './CodeBlock.svelte';

  let { body, ontaskchange }: {
    body: string;
    ontaskchange?: (marker: number, completed: boolean) => Promise<boolean>;
  } = $props();
  let saving = $state(false);
  const blocks = $derived(memoBlocks(body).map((block) => block.type === 'code'
    ? { ...block, highlighted: highlightCode(block.value, block.language) }
    : block.type === 'tasks'
      ? { ...block, items: block.items.map((item) => ({ ...item, parts: inlineParts(item.value) })) }
      : { ...block, parts: inlineParts(block.value) }));

  async function changeTask(event: Event, marker: number) {
    const checkbox = event.currentTarget as HTMLInputElement;
    if (!ontaskchange || saving) return;
    saving = true;
    try {
      await ontaskchange(marker, checkbox.checked);
    } finally {
      checkbox.checked = body[marker]?.toLowerCase() === 'x';
      saving = false;
    }
  }
</script>

{#snippet inline(parts: InlinePart[])}
  {#each parts as part}{#if part.type === 'bold'}<strong>{@render inline(part.children)}</strong>{:else if part.type === 'italic'}<em>{@render inline(part.children)}</em>{:else if part.type === 'link'}<a href={part.href} target="_blank" rel="noreferrer">{part.value}</a>{:else if part.type === 'code'}<code class="memo-inline-code">{part.value}</code>{:else if 'value' in part}{part.value}{/if}{/each}
{/snippet}

<div class="memo-body">
  {#each blocks as block}
    {#if block.type === 'code'}
      <CodeBlock value={block.value} highlighted={block.highlighted} />
    {:else if block.type === 'tasks'}
      <ul class="memo-task-list">
        {#each block.items as item}
          <li class="memo-task" class:completed={item.completed}>
            <label class="memo-task-label">
              <input type="checkbox" checked={item.completed} disabled={!ontaskchange || saving}
                onchange={(event) => changeTask(event, item.marker)} aria-label={item.value ? undefined : 'Task'} />
              <span class="memo-task-text">{@render inline(item.parts)}</span>
            </label>
          </li>
        {/each}
      </ul>
    {:else}<span class="memo-prose">{@render inline(block.parts)}</span>{/if}
  {/each}
</div>
