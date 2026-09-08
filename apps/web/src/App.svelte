<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Attachment, Memo, PendingOperation, Profile, Space } from './lib/types';
  import { uuidv7 } from './lib/ids';
  import { mergeTags } from './lib/tags';
  import {
    clearLocalData,
    clearAttachmentCache,
    attachmentSource,
    openNativeAttachment,
    deleteMemoLocal,
    deleteSpaceLocal,
    getAttachment,
    getProfile,
    getSnapshot,
    putAttachment,
    putMemo,
    putSpace,
    setProfile
  } from './lib/repository';
  import { apiOrigin, cancelRequests, connectChanges, downloadAttachment, downloadNativeAttachment, login, logout, me, syncUntilCaughtUp, UnauthorizedError, uploadPendingAttachments } from './lib/api';
  import { createThumbnail, fileExtension, formatBytes, isAttachmentCached } from './lib/media';
  import { captureAnchor, isNearBottom, prependScrollDelta, restoreAnchor } from './lib/feedScroll';
  import { initializeNativeAuth, isNative } from './lib/nativeAuth';
  import { filesFromClipboard, isTypingTarget } from './lib/clipboard';
  import { autosizeTextarea } from './lib/composer';
  import { compareMemoOrder, isTapGesture, swipeAction, swipeIgnoresTarget } from './lib/memoActions';

  const MAX_ATTACHMENT_BYTES = 2_147_483_648;
  let spaces: Space[] = [];
  let memos: Memo[] = [];
  let attachments: Attachment[] = [];
  let profile: Profile | undefined;
  let selectedSpace = '';
  let body = '';
  let tagDraft = '';
  let explicitTags: string[] = [];
  let selectedFiles: File[] = [];
  let query = '';
  let resultIds = new Set<string>();
  let renderLimit = 200;
  let searching = false;
  let syncing = false;
  let online = navigator.onLine;
  let reachable = navigator.onLine;
  let authChecked = false;
  let sidebarOpen = false;
  let editing: Memo | undefined;
  let error = '';
  let authExpired = false;
  let updateAvailable: { version: string; url: string } | undefined;
  let feed: HTMLDivElement;
  let fileInput: HTMLInputElement;
  let dragDepth = 0;
  let draggingFiles = false;
  let searchWorker: Worker;
  let disconnectSocket: (() => void) | undefined;
  let syncFlight: Promise<void> | undefined;
  let stickToBottom = true;
  let selecting = false;
  let selectedMemoIds = new Set<string>();
  let movingMemoIds: string[] = [];
  let swipe: { memo: Memo; element: HTMLElement; startX: number; startY: number; x: number; y: number } | undefined;
  let suppressAttachmentOpen = false;
  let suppressAttachmentOpenTimer = 0;

  $: activeSpace = spaces.find((space) => space.id === selectedSpace);
  $: visibleMemos = memos.filter((memo) =>
    query.trim() ? resultIds.has(memo.id) : memo.spaceId === selectedSpace
  ).sort(compareMemoOrder);
  $: renderedMemos = query.trim()
    ? visibleMemos.slice(0, renderLimit)
    : visibleMemos.slice(Math.max(0, visibleMemos.length - renderLimit));
  $: allTags = [...new Set(memos.flatMap((memo) => memo.tags))].sort((a, b) => a.localeCompare(b));

  function operation(kind: PendingOperation['kind'], entityId: string, payload?: Space | Memo): PendingOperation {
    return { id: uuidv7(), kind, entityId, payload, createdAt: new Date().toISOString(), attempts: 0 };
  }

  async function scrollNewest(smooth = false) {
    await tick();
    stickToBottom = true;
    feed?.scrollTo({ top: feed.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function onFeedScroll() {
    if (feed) stickToBottom = isNearBottom(feed);
  }

  async function showMore() {
    const previousHeight = feed?.scrollHeight ?? 0;
    const prepend = !query.trim();
    renderLimit += 200;
    await tick();
    if (feed && prepend) feed.scrollTop += prependScrollDelta(previousHeight, feed.scrollHeight);
  }

  function openSpace(id: string) {
    selectedSpace = id;
    query = '';
    renderLimit = 200;
    sidebarOpen = false;
    selecting = false;
    selectedMemoIds = new Set();
    void scrollNewest();
  }

  async function refresh(scroll = false) {
    const anchor = !scroll && !stickToBottom && feed ? captureAnchor(feed) : undefined;
    const snapshot = await getSnapshot();
    spaces = snapshot.spaces;
    memos = snapshot.memos;
    attachments = snapshot.attachments;
    if (!selectedSpace || !spaces.some((space) => space.id === selectedSpace)) {
      selectedSpace = spaces.find((space) => space.isInbox)?.id ?? spaces[0]?.id ?? '';
    }
    searchWorker?.postMessage({ type: 'update', spaces, memos, attachments: attachments.map(({ id, memoId, filename }) => ({ id, memoId, filename })) });
    if (query) searchWorker?.postMessage({ type: 'query', query });
    await tick();
    if (scroll || stickToBottom) await scrollNewest(scroll);
    else if (anchor && feed) restoreAnchor(feed, anchor);
  }

  async function sync() {
    if (!profile || !online || syncing || document.visibilityState === 'hidden') return;
    syncing = true;
    error = '';
    syncFlight = (async () => {
    try {
      await syncUntilCaughtUp();
      await refresh();
      await uploadPendingAttachments(attachments);
      await syncUntilCaughtUp();
      await refresh();
      reachable = true;
      authExpired = false;
    } catch (value) {
      reachable = false;
      if (value instanceof UnauthorizedError) {
        error = value.message;
        authExpired = true;
      } else {
        error = 'Server unavailable; changes remain safely on this device.';
      }
    } finally {
      syncing = false;
    }
    })();
    await syncFlight;
  }

  async function addSpace() {
    const name = prompt('Space name')?.trim();
    if (!name) return;
    const now = new Date().toISOString();
    const space: Space = {
      id: uuidv7(), name, position: spaces.length, isInbox: false,
      createdAt: now, updatedAt: now, syncState: 'pending'
    };
    await putSpace(space, operation('upsert_space', space.id, space));
    selectedSpace = space.id;
    await refresh();
    void sync();
  }

  async function renameSpace(space: Space) {
    const name = prompt('Rename space', space.name)?.trim();
    if (!name || name === space.name) return;
    const changed = { ...space, name, updatedAt: new Date().toISOString(), syncState: 'pending' as const };
    await putSpace(changed, operation('upsert_space', space.id, changed));
    await refresh();
    void sync();
  }

  async function removeSpace(space: Space) {
    if (space.isInbox || !confirm(`Permanently delete “${space.name}” and every memo and file in it?`)) return;
    await deleteSpaceLocal(space.id, operation('delete_space', space.id));
    await refresh();
    void sync();
  }

  function addTag(value = tagDraft) {
    const cleaned = value.replace(/^#/, '').trim();
    if (cleaned && !explicitTags.some((tag) => tag.toLocaleLowerCase() === cleaned.toLocaleLowerCase())) {
      explicitTags = [...explicitTags, cleaned];
    }
    tagDraft = '';
  }

  async function submitMemo() {
    if ((!body.trim() && selectedFiles.length === 0) || !selectedSpace) return;
    if (selectedFiles.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
      error = 'One or more files exceed the 2 GiB attachment limit.';
      return;
    }
    const now = new Date().toISOString();
    const id = editing?.id ?? uuidv7();
    const attachmentIds = editing?.attachmentIds ? [...editing.attachmentIds] : [];
    try {
      for (const file of selectedFiles) {
        const attachment: Attachment = {
          id: uuidv7(), memoId: id, filename: file.name, mimeType: file.type || 'application/octet-stream',
          size: file.size, thumbnail: await createThumbnail(file), remoteReady: false,
          cacheState: 'local', createdAt: now
        };
        await putAttachment(attachment, file);
        attachmentIds.push(attachment.id);
      }
    } catch {
      error = 'This device does not have enough local storage for the selected file.';
      return;
    }
    const memo: Memo = {
      id,
      spaceId: editing?.spaceId ?? selectedSpace,
      body: body.trim(),
      tags: mergeTags(body, explicitTags),
      attachmentIds,
      createdAt: editing?.createdAt ?? now,
      bumpedAt: editing?.bumpedAt,
      updatedAt: now,
      syncState: 'pending'
    };
    await putMemo(memo, operation('upsert_memo', memo.id, memo));
    body = '';
    explicitTags = [];
    selectedFiles = [];
    editing = undefined;
    if (fileInput) fileInput.value = '';
    await refresh(true);
    void sync();
  }

  function editMemo(memo: Memo) {
    editing = memo;
    body = memo.body;
    explicitTags = [...memo.tags];
    selectedFiles = [];
  }

  function toggleMemoSelection(id: string) {
    const next = new Set(selectedMemoIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedMemoIds = next;
  }

  function leaveSelection() {
    selecting = false;
    selectedMemoIds = new Set();
  }

  async function updateMemos(ids: Iterable<string>, update: (memo: Memo, now: string) => Memo) {
    const now = new Date().toISOString();
    const wanted = new Set(ids);
    for (const memo of memos.filter((item) => wanted.has(item.id))) {
      const changed = update(memo, now);
      await putMemo(changed, operation('upsert_memo', changed.id, changed));
    }
    await refresh();
    void sync();
  }

  async function bumpMemos(ids: Iterable<string>) {
    await updateMemos(ids, (memo, now) => ({ ...memo, bumpedAt: now, updatedAt: now, syncState: 'pending' }));
    await scrollNewest(true);
    leaveSelection();
  }

  function startMove(ids: Iterable<string>) {
    movingMemoIds = [...ids];
  }

  async function moveMemos(spaceId: string) {
    const ids = movingMemoIds;
    movingMemoIds = [];
    await updateMemos(ids, (memo, now) => ({ ...memo, spaceId, updatedAt: now, syncState: 'pending' }));
    leaveSelection();
  }

  async function removeMemo(memo: Memo) {
    if (!confirm('Permanently delete this memo and its files?')) return;
    await deleteMemoLocal(memo.id, operation('delete_memo', memo.id));
    await refresh();
    void sync();
  }

  async function removeMemos(ids: Iterable<string>) {
    const wanted = new Set(ids);
    const selected = memos.filter((memo) => wanted.has(memo.id));
    if (!selected.length || !confirm(`Permanently delete ${selected.length} selected ${selected.length === 1 ? 'memo' : 'memos'} and their files?`)) return;
    for (const memo of selected) await deleteMemoLocal(memo.id, operation('delete_memo', memo.id));
    leaveSelection();
    await refresh();
    void sync();
  }

  function attachmentsFor(memo: Memo): Attachment[] {
    const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
    return memo.attachmentIds.map((id) => byId.get(id) ?? {
      id,
      memoId: memo.id,
      filename: 'Syncing…',
      mimeType: 'application/octet-stream',
      size: 0,
      remoteReady: false,
      cacheState: 'remote',
      createdAt: memo.createdAt
    });
  }

  function isAlbumImage(attachment: Attachment) {
    return attachment.mimeType.startsWith('image/') && Boolean(attachment.thumbnail);
  }

  function downloadBlob(blob: Blob, filename: string, preview = false) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.rel = 'noopener';
    if (preview) link.target = '_blank';
    else link.download = filename || 'download';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  function openAlbumImage(attachment: Attachment) {
    if (suppressAttachmentOpen) return;
    void openAttachment(attachment);
  }

  async function openAttachment(attachment: Attachment) {
    if (isNative()) {
      try {
        if (!await attachmentSource(attachment.id)) await downloadNativeAttachment(attachment);
        await openNativeAttachment(attachment.id);
        await refresh();
      } catch (value) { error = value instanceof Error ? value.message : String(value); }
      return;
    }
    const cached = await getAttachment(attachment.id);
    let blob = cached?.blob;
    if (!blob) {
      try {
        blob = await downloadAttachment(attachment.id);
        await putAttachment({ ...attachment, cacheState: 'cached', remoteReady: true }, blob);
        await refresh();
      } catch (value) {
        error = value instanceof Error ? value.message : String(value);
        return;
      }
    }
    downloadBlob(blob, attachment.filename, attachment.mimeType.startsWith('image/'));
  }

  async function downloadFiles(ids: Iterable<string>) {
    const memoIds = new Set(ids);
    const files = attachments.filter((attachment) => memoIds.has(attachment.memoId));
    if (!files.length) {
      error = 'The selected memos do not contain files.';
      return;
    }
    for (const attachment of files) {
      try {
        let blob = (await getAttachment(attachment.id))?.blob;
        if (!blob && isNative()) {
          await downloadNativeAttachment(attachment);
          blob = (await getAttachment(attachment.id))?.blob;
        } else if (!blob) {
          blob = await downloadAttachment(attachment.id);
          await putAttachment({ ...attachment, cacheState: 'cached', remoteReady: true }, blob);
        }
        if (!blob) throw new Error(`Could not read ${attachment.filename}`);
        downloadBlob(blob, attachment.filename);
      } catch (value) {
        error = value instanceof Error ? value.message : String(value);
        return;
      }
    }
    await refresh();
  }

  function startSwipe(event: PointerEvent, memo: Memo) {
    if (event.pointerType !== 'touch' || selecting || swipeIgnoresTarget(event.target)) return;
    const element = event.currentTarget as HTMLElement;
    swipe = { memo, element, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
    element.setPointerCapture(event.pointerId);
  }

  function moveSwipe(event: PointerEvent) {
    if (!swipe) return;
    swipe.x = event.clientX;
    swipe.y = event.clientY;
    const deltaX = swipe.x - swipe.startX;
    const deltaY = swipe.y - swipe.startY;
    if (Math.abs(deltaX) <= Math.abs(deltaY)) return;
    const offset = Math.max(-120, Math.min(120, deltaX));
    swipe.element.style.setProperty('--swipe-x', `${offset}px`);
    swipe.element.dataset.swipe = offset > 0 ? 'bump' : 'delete';
  }

  function finishSwipe(cancelled = false) {
    if (!swipe) return;
    const current = swipe;
    swipe = undefined;
    current.element.style.setProperty('--swipe-x', '0px');
    delete current.element.dataset.swipe;
    if (cancelled) return;
    const deltaX = current.x - current.startX;
    const deltaY = current.y - current.startY;
    if (!isTapGesture(deltaX, deltaY)) {
      suppressAttachmentOpen = true;
      window.clearTimeout(suppressAttachmentOpenTimer);
      suppressAttachmentOpenTimer = window.setTimeout(() => { suppressAttachmentOpen = false; }, 50);
    }
    const action = swipeAction(deltaX, deltaY);
    if (action === 'bump') void bumpMemos([current.memo.id]);
    if (action === 'delete') void removeMemo(current.memo);
  }

  function linkParts(text: string): Array<{ value: string; href?: string }> {
    const pattern = /https?:\/\/[^\s<]+/giu;
    const result: Array<{ value: string; href?: string }> = [];
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > cursor) result.push({ value: text.slice(cursor, index) });
      result.push({ value: match[0], href: match[0] });
      cursor = index + match[0].length;
    }
    if (cursor < text.length) result.push({ value: text.slice(cursor) });
    return result;
  }

  async function clearFiles() {
    if (!confirm('Remove downloaded attachment copies from this device? Your memos and server files stay intact.')) return;
    await clearAttachmentCache();
    await refresh();
  }

  function handleComposerKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submitMemo();
    }
  }

  function handleFiles(fileList: FileList | null) {
    if (fileList) selectedFiles = [...selectedFiles, ...Array.from(fileList)];
  }

  function hasDragFiles(event: DragEvent) {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
  }

  function handleDragEnter(event: DragEvent) {
    if (!hasDragFiles(event) && !draggingFiles) return;
    event.preventDefault();
    dragDepth += 1;
    draggingFiles = true;
  }

  function handleDragLeave() {
    if (!draggingFiles) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) draggingFiles = false;
  }

  function handleDragOver(event: DragEvent) {
    if (!hasDragFiles(event) && !draggingFiles) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragDepth = 0;
    draggingFiles = false;
    handleFiles(event.dataTransfer?.files ?? null);
  }

  function handlePaste(event: ClipboardEvent) {
    if (!profile) return;
    const files = filesFromClipboard(event.clipboardData);
    if (files.length) {
      event.preventDefault();
      selectedFiles = [...selectedFiles, ...files];
      return;
    }
    if (isTypingTarget(event.target) || query) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    event.preventDefault();
    body = body ? `${body}${text}` : text;
  }

  async function signIn() {
    error = '';
    authExpired = false;
    try { await login(); }
    catch (value) { error = value instanceof Error ? value.message : String(value); }
  }

  async function signOut() {
    if (!confirm('Log out and wipe every locally cached memo and file from this device?')) return;
    profile = undefined;
    localStorage.setItem('scratchwall.loggedOut', 'true');
    disconnectSocket?.();
    cancelRequests();
    await syncFlight;
    try { await logout(); } catch { /* local logout still wins */ }
    await clearLocalData();
    profile = undefined;
    await refresh();
  }

  onMount(() => {
    searchWorker = new Worker(new URL('./lib/search.worker.ts', import.meta.url), { type: 'module' });
    searchWorker.onmessage = (event) => {
      if (event.data.type === 'results' && event.data.query === query) {
        resultIds = new Set(event.data.ids);
        searching = false;
      }
    };
    const onOnline = () => { online = true; void sync(); };
    const onOffline = () => { online = false; reachable = false; };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const onVisibility = () => { if (document.visibilityState === 'visible') void sync(); };
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('paste', handlePaste);
    // Native clients cannot attach their bearer token to a browser WebSocket.
    // A visible-only timer keeps all open clients inside the two-second convergence target.
    const foregroundSync = window.setInterval(() => {
      if (document.visibilityState === 'visible' && online && profile) void sync();
    }, 2_000);

    let removeDeepLink = () => {};
    void (async () => {
      removeDeepLink = await initializeNativeAuth(async (authenticated) => {
        error = '';
        const previous = await getProfile();
        if (previous && previous.subject !== authenticated.subject) await clearLocalData();
        profile = authenticated;
        await setProfile(authenticated);
        await sync();
      }, (value) => {
        error = value instanceof Error ? value.message : String(value);
      });
      await refresh();
      profile = await getProfile();
      if (new URL(location.href).searchParams.get('auth') === 'required') {
        authExpired = true;
        error = 'Sign in required';
        history.replaceState({}, '', `${location.pathname}${location.hash}`);
      }
      try {
        if (localStorage.getItem('scratchwall.loggedOut')) throw new Error('Sign in to continue');
        const current = await me();
        if (profile && profile.subject !== current.subject) await clearLocalData();
        profile = current;
        await setProfile(current);
        authExpired = false;
      } catch (value) {
        if (value instanceof UnauthorizedError) {
          authExpired = true;
          error = value.message;
        } else if (online && !profile) {
          error = value instanceof Error ? value.message : String(value);
        }
      }
      authChecked = true;
      if (profile) {
        await scrollNewest();
        await sync();
        disconnectSocket = connectChanges(() => void sync());
      }
      try {
        const manifest = await fetch(`${apiOrigin()}/downloads/manifest.json`).then((response) => response.ok ? response.json() : undefined);
        if (manifest?.version && manifest.version.localeCompare('0.1.0', undefined, { numeric: true }) > 0) {
          updateAvailable = { version: manifest.version, url: `${apiOrigin()}/downloads/` };
        }
      } catch { /* launch checks are best effort */ }
    })();

    return () => {
      disconnectSocket?.();
      searchWorker.terminate();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('paste', handlePaste);
      window.clearInterval(foregroundSync);
      removeDeepLink();
    };
  });

  $: if (searchWorker) {
    searching = Boolean(query.trim());
    searchWorker.postMessage({ type: 'query', query });
  }
</script>

{#if !authChecked}
  <main class="gate"><div class="spinner"></div><p>Opening your wall…</p></main>
{:else if !profile}
  <main class="gate">
    <div class="brand-mark">S</div>
    <h1>Scratchwall</h1>
    <p>Your quiet, fast place for links, files, and short notes.</p>
    <button class="primary" onclick={signIn} disabled={!online}>Continue with VoidAuth</button>
    <a class="gate-download" href={`${apiOrigin()}/downloads/`}>Download apps</a>
    {#if error}<p class="gate-error">{error}</p>{/if}
    {#if !online}<small>Connect once to sign in on this device.</small>{/if}
  </main>
{:else}
  <div class="shell" role="application" ondragenter={handleDragEnter} ondragleave={handleDragLeave} ondragover={handleDragOver} ondrop={handleDrop}>
    <aside class:open={sidebarOpen}>
      <div class="sidebar-head">
        <div class="wordmark"><span>S</span> Scratchwall</div>
        <button class="icon-button mobile" aria-label="Close menu" onclick={() => sidebarOpen = false}>×</button>
      </div>
      <nav aria-label="Spaces">
        {#each spaces as space}
          <div class:active={space.id === selectedSpace} class="space-row">
            <button class="space-button" onclick={() => openSpace(space.id)}>
              <span>{space.isInbox ? '⌂' : '·'}</span><span>{space.name}</span>
            </button>
            {#if !space.isInbox}
              <button class="more" aria-label={`Rename ${space.name}`} onclick={() => renameSpace(space)}>✎</button>
              <button class="more danger" aria-label={`Delete ${space.name}`} onclick={() => removeSpace(space)}>×</button>
            {/if}
          </div>
        {/each}
      </nav>
      <button class="new-space" onclick={addSpace}>＋ New space</button>
      <div class="sidebar-foot">
        <div class="sidebar-status">
          <span title={reachable ? 'Online' : 'Offline'} class:online={reachable} class="status-dot"></span>
          <span>{syncing ? 'Syncing…' : reachable ? 'Synced locally' : 'Offline — saved locally'}</span>
        </div>
        <div class="sidebar-actions">
          <button class="link-button" onclick={() => sync()}>Sync</button>
          <a class="link-button" href={`${apiOrigin()}/downloads/`}>Downloads</a>
          <button class="link-button" onclick={clearFiles}>Clear files</button>
          <button class="link-button" onclick={signOut}>Log out</button>
        </div>
      </div>
    </aside>

    <section class="workspace">
      <header>
        <button class="icon-button mobile" aria-label="Open menu" onclick={() => sidebarOpen = true}>☰</button>
        <div>
          <h1>{query ? 'Search' : activeSpace?.name ?? 'Scratchwall'}</h1>
          <small>{query ? `${visibleMemos.length} matches across all spaces` : `${visibleMemos.length} memos`}</small>
        </div>
        <button class="select-toggle" class:active={selecting} onclick={() => selecting ? leaveSelection() : selecting = true}>
          {selecting ? 'Cancel' : 'Select'}
        </button>
        <label class="search">
          <span>⌕</span>
          <input bind:value={query} oninput={() => renderLimit = 200} placeholder="Search everything" aria-label="Search everything" />
          {#if searching}<span class="tiny-spinner"></span>{/if}
        </label>
      </header>

      {#if updateAvailable}
        <a class="update" href={updateAvailable.url} target="_blank" rel="noreferrer">Scratchwall {updateAvailable.version} is available</a>
      {/if}
      {#if error}
        <div class="error-banner" role="status">
          <span class="banner-text">{error}</span>
          {#if authExpired}<button class="banner-sign-in" onclick={signIn}>Sign in again</button>{/if}
          <button class="banner-dismiss" aria-label="Dismiss" onclick={() => { error = ''; }}>×</button>
        </div>
      {/if}

      {#if selecting}
        <div class="batch-bar" aria-label="Selected memo actions">
          <strong>{selectedMemoIds.size} selected</strong>
          <button onclick={() => selectedMemoIds = new Set(renderedMemos.map(({ id }) => id))}>All shown</button>
          <button disabled={!selectedMemoIds.size} onclick={() => bumpMemos(selectedMemoIds)}>Bump</button>
          <button disabled={!selectedMemoIds.size} onclick={() => startMove(selectedMemoIds)}>Move</button>
          <button disabled={!selectedMemoIds.size} onclick={() => downloadFiles(selectedMemoIds)}>Download files</button>
          <button class="danger" disabled={!selectedMemoIds.size} onclick={() => removeMemos(selectedMemoIds)}>Delete</button>
        </div>
      {/if}

      <div class="feed" bind:this={feed} onscroll={onFeedScroll}>
        {#if visibleMemos.length === 0}
          <div class="empty">
            <div>{query ? '⌕' : '✦'}</div>
            <h2>{query ? 'Nothing found' : 'A clean wall'}</h2>
            <p>{query ? 'Try another word, filename, URL fragment, or tag.' : 'Paste a thought, link, image, or file below.'}</p>
          </div>
        {/if}
        {#if visibleMemos.length > renderedMemos.length}
          <button class="load-more" onclick={() => showMore()}>
            {query ? `Show more results (${visibleMemos.length - renderedMemos.length} remaining)` : 'Show 200 older memos'}
          </button>
        {/if}
        {#each renderedMemos as memo (memo.id)}
          <div
            role="group"
            aria-label="Memo"
            data-memo-id={memo.id}
            class="memo-wrap"
            class:selected={selectedMemoIds.has(memo.id)}
            onpointerdown={(event) => startSwipe(event, memo)}
            onpointermove={moveSwipe}
            onpointerup={() => finishSwipe()}
            onpointercancel={() => finishSwipe(true)}
          >
          <article class="memo" class:pending={memo.syncState === 'pending'} class:error={memo.syncState === 'error'}>
            {#if selecting}
              <button class="select-memo" class:selected={selectedMemoIds.has(memo.id)} aria-label={`${selectedMemoIds.has(memo.id) ? 'Deselect' : 'Select'} memo`} onclick={() => toggleMemoSelection(memo.id)}>
                {selectedMemoIds.has(memo.id) ? '✓' : ''}
              </button>
            {/if}
            {#if memo.body}<p>{#each linkParts(memo.body) as part}{#if part.href}<a href={part.href} target="_blank" rel="noreferrer">{part.value}</a>{:else}{part.value}{/if}{/each}</p>{/if}
            {#if memo.tags.length}
              <div class="tags">{#each memo.tags as tag}<button onclick={() => query = tag}>#{tag}</button>{/each}</div>
            {/if}
            {#if memo.attachmentIds.length}
              {@const items = attachmentsFor(memo)}
              {@const images = items.filter(isAlbumImage)}
              {@const files = items.filter((attachment) => !isAlbumImage(attachment))}
              {#if images.length}
                <div class="album" class:album-single={images.length === 1} class:album-multi={images.length > 1} class:bleed-top={!memo.body && !memo.tags.length}>
                  {#if images.length === 1}
                    <button class:remote={!isAttachmentCached(images[0].cacheState)} class="attachment image" onclick={() => openAlbumImage(images[0])}>
                      <span class="file-preview"><img src={images[0].thumbnail} alt="" draggable="false" />{#if !isAttachmentCached(images[0].cacheState)}<span class="dl-mark" aria-hidden="true">↓</span>{/if}</span>
                    </button>
                  {:else}
                    <button class:remote={!isAttachmentCached(images[0].cacheState)} class="attachment image hero" onclick={() => openAlbumImage(images[0])}>
                      <span class="file-preview"><img src={images[0].thumbnail} alt="" draggable="false" />{#if !isAttachmentCached(images[0].cacheState)}<span class="dl-mark" aria-hidden="true">↓</span>{/if}</span>
                    </button>
                    <div class="album-rest">
                      {#each images.slice(1) as attachment (attachment.id)}
                        <button class:remote={!isAttachmentCached(attachment.cacheState)} class="attachment image" onclick={() => openAlbumImage(attachment)}>
                          <span class="file-preview"><img src={attachment.thumbnail} alt="" draggable="false" />{#if !isAttachmentCached(attachment.cacheState)}<span class="dl-mark" aria-hidden="true">↓</span>{/if}</span>
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
              {#if files.length}
                <div class="attachments">
                  {#each files as attachment (attachment.id)}
                    <button class:remote={!isAttachmentCached(attachment.cacheState)} class="attachment" onclick={() => openAttachment(attachment)}>
                      <span class="file-badge"><span class="ext">{fileExtension(attachment.filename)}</span>{#if !isAttachmentCached(attachment.cacheState)}<span class="dl-mark" aria-hidden="true">↓</span>{/if}</span>
                      <span class="file-meta"><strong>{attachment.filename}</strong><small>{attachment.size ? `${attachment.mimeType} · ${formatBytes(attachment.size)} · ${attachment.cacheState}` : 'File is still syncing to this device'}</small></span>
                    </button>
                  {/each}
                </div>
              {/if}
            {/if}
            <footer>
              <time datetime={memo.createdAt} title={memo.bumpedAt ? `Bumped ${new Date(memo.bumpedAt).toLocaleString()}` : undefined}>{new Date(memo.createdAt).toLocaleString()}</time>
              <span class="sync-mark" title={memo.syncState}>{memo.syncState === 'pending' ? '◌' : memo.syncState === 'error' ? '!' : '✓'}</span>
              <span class="memo-actions">
                <button aria-label="Bump memo" title="Bump" onclick={() => bumpMemos([memo.id])}>⤒</button>
                <button aria-label="Move memo" title="Move" onclick={() => startMove([memo.id])}>▣</button>
                <button aria-label="Edit memo" title="Edit" onclick={() => editMemo(memo)}>✎</button>
                <button class="danger" aria-label="Delete memo" title="Delete" onclick={() => removeMemo(memo)}>⌫</button>
              </span>
            </footer>
          </article>
          </div>
        {/each}
      </div>

      {#if !query}
        <div class="composer" class:editing>
          {#if editing}<div class="editing-note">Editing memo <button onclick={() => { editing = undefined; body = ''; explicitTags = []; }}>Cancel</button></div>{/if}
          {#if selectedFiles.length}
            <div class="queued-files">
              {#each selectedFiles as file, index}<span>{file.name}<button onclick={() => selectedFiles = selectedFiles.filter((_, i) => i !== index)}>×</button></span>{/each}
            </div>
          {/if}
          {#if explicitTags.length}
            <div class="tags selected">{#each explicitTags as tag}<button onclick={() => explicitTags = explicitTags.filter((value) => value !== tag)}>#{tag} ×</button>{/each}</div>
          {/if}
          <div class="compose-row">
            <button class="attach" aria-label="Attach files" onclick={() => fileInput.click()}>＋</button>
            <input bind:this={fileInput} class="hidden" type="file" multiple onchange={(event) => handleFiles(event.currentTarget.files)} />
            <textarea bind:value={body} use:autosizeTextarea={body} onkeydown={handleComposerKey} rows="1" enterkeyhint="send" placeholder="Write or paste a memo…" aria-label="Memo text"></textarea>
            <button class="send" aria-label="Send memo" onclick={submitMemo}>↑</button>
          </div>
          <div class="tag-row">
            <input bind:value={tagDraft} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); addTag(); } }} placeholder="Add tag" aria-label="Add tag" />
            {#each allTags.filter((tag) => !explicitTags.includes(tag)).slice(0, 6) as tag}<button onclick={() => addTag(tag)}>#{tag}</button>{/each}
          </div>
        </div>
      {/if}
      {#if draggingFiles}
        <div class="drop-overlay" aria-hidden="true">Drop files to attach</div>
      {/if}
      {#if movingMemoIds.length}
        <div class="dialog-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) movingMemoIds = []; }}>
          <div class="move-dialog" role="dialog" aria-modal="true" aria-labelledby="move-title">
            <div><h2 id="move-title">Move {movingMemoIds.length === 1 ? 'memo' : `${movingMemoIds.length} memos`}</h2><button class="icon-button" aria-label="Close" onclick={() => movingMemoIds = []}>×</button></div>
            <p>Choose a destination folder.</p>
            <div class="move-options">
              {#each spaces as space}
                <button onclick={() => moveMemos(space.id)}>{space.isInbox ? '⌂' : '·'} {space.name}</button>
              {/each}
            </div>
          </div>
        </div>
      {/if}
    </section>
  </div>
{/if}
