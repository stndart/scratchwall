<script lang="ts">
  import { onMount } from 'svelte';
  import { integrationRequest } from '../lib/api';
  import type { Space } from '../lib/types';
  let { spaces, subject }: { spaces: Space[]; subject: string } = $props();
  interface Token { id: string; name: string; spaceIds: string[]; expiresAt: number }
  let tokens: Token[] = $state([]);
  let name = $state('MCP');
  let selected: string[] = $state([]);
  let all = $state(false);
  let secret = $state('');
  let error = $state('');
  let busy = $state(false);
  async function load() {
    try { tokens = await integrationRequest(''); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  onMount(() => { void load(); });
  async function create() {
    busy = true; error = ''; secret = '';
    try {
      const result = await integrationRequest('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, spaceIds: all ? ['*'] : selected }) });
      secret = result.token;
      await load();
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  async function revoke(id: string) {
    busy = true; error = '';
    try { await integrationRequest(`/${encodeURIComponent(id)}/revoke`, { method: 'POST' }); secret = ''; await load(); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
</script>
<div class="settings-section">
  <h3>Connect an agent</h3>
  <p class="dialog-description">Read-only access to your synced memos. Tokens expire after 90 days and can be revoked here.</p>
  <p class="dialog-description">Your user ID: <code>{subject}</code></p>
  <label class="token-label">Connection name <input bind:value={name} maxlength="100" /></label>
  <label class="scope"><input type="checkbox" bind:checked={all} /> All spaces, including future spaces</label>
  {#if !all}<div class="scopes">
    {#each spaces as space (space.id)}
      <label class="scope"><input type="checkbox" bind:group={selected} value={space.id} /> {space.name}</label>
    {/each}
  </div>{/if}
  <button class="primary" disabled={busy || !name.trim() || (!all && !selected.length)} onclick={create}>Create token</button>
  {#if secret}
    <label class="token-label">Copy this token now; it is shown only once.
      <textarea readonly value={secret} aria-label="New agent token" rows="3"></textarea>
    </label>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#each tokens as token (token.id)}
    <div class="token-row"><span><strong>{token.name}</strong><small>
      {token.spaceIds.includes('*') ? 'All spaces' : token.spaceIds.map(id => spaces.find(s => s.id === id)?.name ?? 'Deleted space').join(', ')} · Expires {new Date(token.expiresAt * 1000).toLocaleDateString()}
    </small></span><button disabled={busy} onclick={() => revoke(token.id)}>Revoke</button></div>
  {/each}
</div>
<style>
  .token-label { display: grid; gap: .4rem; margin: .75rem 0; }
  input:not([type=checkbox]), textarea { width: 100%; box-sizing: border-box; padding: .6rem; color: inherit; background: transparent; border: 1px solid var(--border, #888); border-radius: .5rem; }
  .scopes { display: flex; flex-wrap: wrap; gap: .5rem 1rem; margin: .75rem 0; }
  .scope { display: flex; align-items: center; gap: .4rem; }
  .token-row { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-top: .75rem; }
  small { display: block; opacity: .7; }
</style>
