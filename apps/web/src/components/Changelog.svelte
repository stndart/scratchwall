<script lang="ts">
  import { currentVersion, releases } from '../lib/changelog';

  export let previousVersion: string | undefined = undefined;
</script>

<section class="settings-section" aria-labelledby="changelog-title">
  <h3 id="changelog-title">Changelog</h3>
  {#if previousVersion && !releases.some((release) => release.version === previousVersion)}
    <p class="previous-hint">Your previous version: {previousVersion}</p>
  {/if}
  <ol class="releases">
    {#each releases as release}
      <li class:previous={release.version === previousVersion}>
        <div class="release-heading">
          <strong>{release.version}</strong>
          {#if release.version === currentVersion}<span class="badge">Current</span>{/if}
          {#if release.version === previousVersion}<span class="badge">Previous</span>{/if}
        </div>
        <ul>{#each release.changes as change}<li>{change}</li>{/each}</ul>
      </li>
    {/each}
  </ol>
</section>

<style>
  .releases { list-style: none; margin: 0; padding: 0; }
  .releases > li { padding: 10px; border-radius: 7px; }
  .releases > li + li { margin-top: 6px; }
  .releases > li.previous { background: var(--accent-soft); box-shadow: inset 3px 0 var(--accent); }
  .release-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; }
  .badge { padding: 3px 6px; border-radius: 4px; background: var(--soft); color: var(--accent); font-size: 10px; }
  ul { margin: 8px 0 0; padding-left: 16px; color: var(--muted); font-size: 12px; line-height: 1.6; }
  .previous-hint { color: var(--muted); font-size: 12px; }
</style>
