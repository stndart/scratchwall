<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './components/Icon.svelte';
  import Dialog from './components/Dialog.svelte';
  import Changelog from './components/Changelog.svelte';
  import AgentSettings from './components/AgentSettings.svelte';
  import PendingFile from './components/PendingFile.svelte';
  import MediaPreview from './components/MediaPreview.svelte';
  import MemoBody from './components/MemoBody.svelte';
  import type {
    Attachment,
    LinkPreview,
    Memo,
    PendingOperation,
    Profile,
    Space,
  } from './lib/types';
  import { uuidv7 } from './lib/ids';
  import { normalizeTags } from './lib/tags';
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
    setProfile,
  } from './lib/repository';
  import {
    apiOrigin,
    cancelRequests,
    connectChanges,
    downloadAttachment,
    downloadNativeAttachment,
    fetchLinkPreview,
    login,
    logout,
    me,
    syncUntilCaughtUp,
    UnauthorizedError,
    uploadPendingAttachments,
  } from './lib/api';
  import {
    attachmentStatusLabel,
    createThumbnail,
    fileExtension,
    formatBytes,
    isAttachmentCached,
    isVideoMime,
    isVisualPreview,
  } from './lib/media';
  import {
    captureAnchor,
    isNearBottom,
    prependScrollDelta,
    restoreAnchor,
  } from './lib/feedScroll';
  import { initializeNativeAuth, isNative } from './lib/nativeAuth';
  import { registerWebUpdate } from './lib/pwa';
  import { recordLoadedVersion } from './lib/changelog';
  import { filesFromClipboard, isTypingTarget } from './lib/clipboard';
  import { autosizeTextarea } from './lib/composer';
  import { compareMemoOrder } from './lib/memoActions';
  import { isVisibleMemo, parseSearchQuery, suggestSearchTags } from './lib/search';
  import { isUrlOnlyBody } from './lib/links';
  import { firstMemoUrl } from './lib/memoText';

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
  let searchAllSpaces = true;
  let resultIds = new Set<string>();
  let renderLimit = 200;
  let searching = false;
  let syncing = false;
  let hasSynced = false;
  let submitting = false;
  let online = navigator.onLine;
  let reachable = navigator.onLine;
  let authChecked = false;
  let checkingSession = true;
  let sidebarOpen = false;
  let editing: Memo | undefined;
  let error = '';
  let authExpired = false;
  let updateAvailable: { version: string; url: string } | undefined;
  let pwaNeedsRefresh = false;
  let applyWebUpdate = () => location.reload();
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
  let composerInput: HTMLTextAreaElement;
  let searchInput: HTMLInputElement;
  let settingsOpen = false;
  let previousVersion: string | undefined;
  let previewAttachment: Attachment | undefined;
  let shortcutsOpen = false;
  let spaceForm: { space?: Space } | undefined;
  let spaceName = '';
  let spaceSaving = false;
  let theme = localStorage.getItem('scratchwall.theme') ?? 'system';
  let enterSends = localStorage.getItem('scratchwall.enterSends') !== 'false';
  let savedMessage = '';
  let savedTimer = 0;
  let installPrompt:
    | (Event & {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: string }>;
      })
    | undefined;
  let drafts = new Map<
    string,
    { body: string; tags: string[]; files: File[] }
  >();
  let previewTick = 0;
  const previewCache = new Map<string, LinkPreview | null>();
  const previewQueued = new Set<string>();
  let previewQueue: string[] = [];
  let previewBusy = false;

  $: activeSpace = spaces.find((space) => space.id === selectedSpace);
  $: visibleMemos = memos
    .filter((memo) =>
      isVisibleMemo(memo, query, resultIds, selectedSpace, searchAllSpaces),
    )
    .sort(compareMemoOrder);
  $: renderedMemos = query.trim()
    ? visibleMemos.slice(0, renderLimit)
    : visibleMemos.slice(Math.max(0, visibleMemos.length - renderLimit));
  $: spaceTags = normalizeTags(
    memos.filter((memo) => memo.spaceId === selectedSpace).flatMap((memo) => memo.tags),
  ).sort((a, b) => a.localeCompare(b));
  $: spaceNames = new Map(spaces.map((space) => [space.id, space.name]));
  $: tagSearch = parseSearchQuery(query).kind === 'tag';
  $: searchTags = suggestSearchTags(memos, query, selectedSpace, searchAllSpaces);
  $: hasDraft =
    !!body.trim() ||
    !!selectedFiles.length ||
    !!explicitTags.length ||
    !!tagDraft.trim() ||
    !!editing ||
    [...drafts.values()].some(
      (draft) => draft.body.trim() || draft.tags.length || draft.files.length,
    );
  $: queueLinkPreviews(renderedMemos);

  function operation(
    kind: PendingOperation['kind'],
    entityId: string,
    payload?: Space | Memo,
  ): PendingOperation {
    return {
      id: uuidv7(),
      kind,
      entityId,
      payload,
      createdAt: new Date().toISOString(),
      attempts: 0,
    };
  }

  async function scrollNewest(smooth = false) {
    await tick();
    stickToBottom = true;
    feed?.scrollTo({
      top: feed.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  function onFeedScroll() {
    if (feed) stickToBottom = isNearBottom(feed);
  }

  async function showMore() {
    const previousHeight = feed?.scrollHeight ?? 0;
    const prepend = !query.trim();
    renderLimit += 200;
    await tick();
    if (feed && prepend)
      feed.scrollTop += prependScrollDelta(previousHeight, feed.scrollHeight);
  }

  function openSpace(id: string) {
    if (submitting) return;
    if (id !== selectedSpace) {
      if (!editing)
        drafts.set(selectedSpace, {
          body,
          tags: explicitTags,
          files: selectedFiles,
        });
      const draft = drafts.get(id);
      drafts.delete(id);
      drafts = new Map(drafts);
      body = draft?.body ?? '';
      explicitTags = draft?.tags ?? [];
      selectedFiles = draft?.files ?? [];
      editing = undefined;
      tagDraft = '';
    }
    selectedSpace = id;
    query = '';
    renderLimit = 200;
    sidebarOpen = false;
    selecting = false;
    selectedMemoIds = new Set();
    void scrollNewest();
  }

  async function refresh(scroll = false) {
    const snapshot = await getSnapshot();
    // Read the viewport immediately before changing the DOM: a database read
    // can finish after the user has continued scrolling.
    const followBottom = feed ? isNearBottom(feed) : stickToBottom;
    const previousHeight = feed?.scrollHeight;
    const anchor =
      !scroll && !followBottom && feed ? captureAnchor(feed) : undefined;
    spaces = snapshot.spaces;
    memos = snapshot.memos;
    attachments = snapshot.attachments;
    if (!selectedSpace || !spaces.some((space) => space.id === selectedSpace)) {
      selectedSpace =
        spaces.find((space) => space.isInbox)?.id ?? spaces[0]?.id ?? '';
    }
    searchWorker?.postMessage({
      type: 'update',
      spaces,
      memos,
      attachments: attachments.map(({ id, memoId, filename }) => ({
        id,
        memoId,
        filename,
      })),
    });
    if (query) searchWorker?.postMessage({ type: 'query', query });
    await tick();
    if (scroll) await scrollNewest(true);
    else if (followBottom && feed && feed.scrollHeight !== previousHeight)
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'auto' });
    else if (anchor && feed) restoreAnchor(feed, anchor);
  }

  async function sync() {
    if (!profile || checkingSession || !online || syncing || document.visibilityState === 'hidden')
      return;
    syncing = true;
    syncFlight = (async () => {
      try {
        await syncUntilCaughtUp();
        await refresh();
        await uploadPendingAttachments(attachments);
        await syncUntilCaughtUp();
        await refresh();
        reachable = true;
        hasSynced = true;
        if (authExpired) error = '';
        authExpired = false;
      } catch (value) {
        reachable = false;
        if (value instanceof UnauthorizedError) {
          error = value.message;
          authExpired = true;
        }
      } finally {
        syncing = false;
      }
    })();
    await syncFlight;
  }

  function addSpace() {
    spaceName = '';
    spaceForm = {};
  }

  function renameSpace(space: Space) {
    spaceName = space.name;
    spaceForm = { space };
  }

  async function saveSpace() {
    const name = spaceName.trim();
    if (!name || !spaceForm || spaceSaving) return;
    spaceSaving = true;
    try {
      const now = new Date().toISOString();
      const existing = spaceForm.space;
      const space: Space = existing
        ? { ...existing, name, updatedAt: now, syncState: 'pending' }
        : {
            id: uuidv7(),
            name,
            position: spaces.length,
            isInbox: false,
            createdAt: now,
            updatedAt: now,
            syncState: 'pending',
          };
      await putSpace(space, operation('upsert_space', space.id, space));
      await refresh();
      spaceForm = undefined;
      if (!existing) openSpace(space.id);
      void sync();
    } catch (value) {
      error =
        value instanceof Error ? value.message : 'Could not save this space.';
    } finally {
      spaceSaving = false;
    }
  }

  async function removeSpace(space: Space) {
    if (
      space.isInbox ||
      !confirm(
        `Permanently delete “${space.name}” and every memo and file in it?`,
      )
    )
      return;
    await deleteSpaceLocal(space.id, operation('delete_space', space.id));
    drafts.delete(space.id);
    drafts = new Map(drafts);
    if (selectedSpace === space.id) {
      editing = undefined;
      body = '';
      selectedFiles = [];
      explicitTags = [];
      tagDraft = '';
    }
    await refresh();
    void sync();
  }

  function addTag(value = tagDraft) {
    const cleaned = value.replace(/^#/, '').trim();
    if (
      cleaned &&
      !explicitTags.some(
        (tag) => tag.toLocaleLowerCase() === cleaned.toLocaleLowerCase(),
      )
    ) {
      explicitTags = [...explicitTags, cleaned];
    }
    tagDraft = '';
  }

  async function submitMemo() {
    if (
      submitting ||
      (!body.trim() && selectedFiles.length === 0) ||
      !selectedSpace
    )
      return;
    if (selectedFiles.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
      error = 'One or more files exceed the 2 GiB attachment limit.';
      return;
    }
    submitting = true;
    if (tagDraft.trim()) addTag();
    const wasEditing = !!editing;
    const now = new Date().toISOString();
    const id = editing?.id ?? uuidv7();
    const attachmentIds = editing?.attachmentIds
      ? [...editing.attachmentIds]
      : [];
    try {
      try {
        for (const file of selectedFiles) {
          const attachment: Attachment = {
            id: uuidv7(),
            memoId: id,
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            thumbnail: await createThumbnail(file),
            remoteReady: false,
            cacheState: 'local',
            createdAt: now,
          };
          await putAttachment(attachment, file);
          attachmentIds.push(attachment.id);
        }
      } catch {
        error =
          'This device does not have enough local storage for the selected file.';
        return;
      }
      const memo: Memo = {
        id,
        spaceId: editing?.spaceId ?? selectedSpace,
        body: body.trim(),
        tags: normalizeTags(explicitTags),
        attachmentIds,
        createdAt: editing?.createdAt ?? now,
        bumpedAt: editing?.bumpedAt,
        updatedAt: now,
        syncState: 'pending',
      };
      await putMemo(memo, operation('upsert_memo', memo.id, memo));
      body = '';
      explicitTags = [];
      selectedFiles = [];
      editing = undefined;
      if (wasEditing) cancelEditing();
      else drafts.delete(selectedSpace);
      drafts = new Map(drafts);
      savedMessage = 'Memo saved on this device';
      window.clearTimeout(savedTimer);
      savedTimer = window.setTimeout(() => (savedMessage = ''), 3000);
      if (fileInput) fileInput.value = '';
      await refresh(true);
      void sync();
    } catch (value) {
      error =
        value instanceof Error ? value.message : 'Could not save this memo.';
    } finally {
      submitting = false;
      await tick();
      composerInput?.focus();
    }
  }

  function editMemo(memo: Memo) {
    if (submitting) return;
    if (!editing)
      drafts.set(selectedSpace, {
        body,
        tags: explicitTags,
        files: selectedFiles,
      });
    drafts = new Map(drafts);
    query = '';
    editing = memo;
    body = memo.body;
    explicitTags = [...memo.tags];
    selectedFiles = [];
    void tick().then(() => composerInput?.focus());
  }

  function cancelEditing() {
    editing = undefined;
    const draft = drafts.get(selectedSpace);
    drafts.delete(selectedSpace);
    drafts = new Map(drafts);
    body = draft?.body ?? '';
    explicitTags = draft?.tags ?? [];
    selectedFiles = draft?.files ?? [];
    tagDraft = '';
    void tick().then(() => composerInput?.focus());
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

  async function updateMemos(
    ids: Iterable<string>,
    update: (memo: Memo, now: string) => Memo,
  ) {
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
    await updateMemos(ids, (memo, now) => ({
      ...memo,
      bumpedAt: now,
      updatedAt: now,
      syncState: 'pending',
    }));
    await scrollNewest(true);
    leaveSelection();
  }

  function startMove(ids: Iterable<string>) {
    movingMemoIds = [...ids];
  }

  async function moveMemos(spaceId: string) {
    const ids = movingMemoIds;
    movingMemoIds = [];
    await updateMemos(ids, (memo, now) => ({
      ...memo,
      spaceId,
      updatedAt: now,
      syncState: 'pending',
    }));
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
    if (
      !selected.length ||
      !confirm(
        `Permanently delete ${selected.length} selected ${selected.length === 1 ? 'memo' : 'memos'} and their files?`,
      )
    )
      return;
    for (const memo of selected)
      await deleteMemoLocal(memo.id, operation('delete_memo', memo.id));
    leaveSelection();
    await refresh();
    void sync();
  }

  function attachmentsFor(memo: Memo): Attachment[] {
    const byId = new Map(
      attachments.map((attachment) => [attachment.id, attachment]),
    );
    return memo.attachmentIds.map(
      (id) =>
        byId.get(id) ?? {
          id,
          memoId: memo.id,
          filename: 'Syncing…',
          mimeType: 'application/octet-stream',
          size: 0,
          remoteReady: false,
          cacheState: 'remote',
          createdAt: memo.createdAt,
        },
    );
  }

  function isAlbumImage(attachment: Attachment) {
    return isVisualPreview(attachment);
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.rel = 'noopener';
    link.download = filename || 'download';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  function openAlbumImage(attachment: Attachment) {
    void openAttachment(attachment);
  }

  async function openAttachment(attachment: Attachment) {
    if (isNative()) {
      try {
        if (!(await attachmentSource(attachment.id)))
          await downloadNativeAttachment(attachment);
        await openNativeAttachment(attachment.id);
        await refresh();
      } catch (value) {
        error = value instanceof Error ? value.message : String(value);
      }
      return;
    }
    if (
      attachment.mimeType.startsWith('image/') ||
      isVideoMime(attachment.mimeType)
    ) {
      previewAttachment = attachment;
      return;
    }
    const cached = await getAttachment(attachment.id);
    let blob = cached?.blob;
    if (!blob) {
      try {
        blob = await downloadAttachment(attachment.id);
        await putAttachment(
          { ...attachment, cacheState: 'cached', remoteReady: true },
          blob,
        );
        await refresh();
      } catch (value) {
        error = value instanceof Error ? value.message : String(value);
        return;
      }
    }
    downloadBlob(blob, attachment.filename);
  }

  async function downloadFiles(ids: Iterable<string>) {
    const memoIds = new Set(ids);
    const files = attachments.filter((attachment) =>
      memoIds.has(attachment.memoId),
    );
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
          await putAttachment(
            { ...attachment, cacheState: 'cached', remoteReady: true },
            blob,
          );
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

  function queueLinkPreviews(memosToShow: Memo[]) {
    if (!online || authExpired) return;
    for (const memo of memosToShow) {
      const url = firstMemoUrl(memo.body);
      if (!url || previewCache.has(url) || previewQueued.has(url)) continue;
      previewQueued.add(url);
      previewQueue.push(url);
    }
    void drainLinkPreviews();
  }

  async function drainLinkPreviews() {
    if (previewBusy) return;
    previewBusy = true;
    while (previewQueue.length) {
      const url = previewQueue.shift();
      if (!url) continue;
      try {
        previewCache.set(url, await fetchLinkPreview(url));
      } catch (error) {
        if (
          error instanceof UnauthorizedError ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
          previewQueued.delete(url);
          for (const pending of previewQueue) previewQueued.delete(pending);
          previewQueue = [];
          break;
        }
        previewCache.set(url, null);
      }
      previewTick += 1;
    }
    previewBusy = false;
  }

  function memoPreview(body: string): LinkPreview | null | undefined {
    void previewTick;
    const url = firstMemoUrl(body);
    return url ? previewCache.get(url) : undefined;
  }

  function hideMemoBody(
    body: string,
    preview: LinkPreview | null | undefined,
  ): boolean {
    const url = firstMemoUrl(body);
    return Boolean(preview && url && isUrlOnlyBody(body, url));
  }

  async function clearFiles() {
    if (
      !confirm(
        'Remove downloaded attachment copies from this device? Your memos and server files stay intact.',
      )
    )
      return;
    await clearAttachmentCache();
    await refresh();
  }

  function handleComposerKey(event: KeyboardEvent) {
    if (
      event.key === 'Enter' &&
      (event.ctrlKey || event.metaKey || (enterSends && !event.shiftKey && !event.altKey)) &&
      !event.isComposing && event.keyCode !== 229
    ) {
      event.preventDefault();
      if (!event.repeat) void submitMemo();
    }
  }

  function handleFiles(fileList: FileList | null) {
    if (submitting) return;
    if (fileList) {
      query = '';
      selectedFiles = [...new Set([...selectedFiles, ...Array.from(fileList)])];
      if (fileInput) fileInput.value = '';
      void tick().then(() => composerInput?.focus());
    }
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
    if (!hasDragFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    draggingFiles = false;
    handleFiles(event.dataTransfer?.files ?? null);
  }

  function handlePaste(event: ClipboardEvent) {
    if (
      !profile ||
      submitting ||
      event.defaultPrevented ||
      document.querySelector('dialog[open]')
    )
      return;
    if (isTypingTarget(event.target) && event.target !== composerInput) return;
    const files = filesFromClipboard(event.clipboardData);
    if (files.length) {
      event.preventDefault();
      query = '';
      selectedFiles = [...new Set([...selectedFiles, ...files])];
      void tick().then(() => composerInput?.focus());
      return;
    }
    if (isTypingTarget(event.target) || query) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    event.preventDefault();
    body = body ? `${body}${text}` : text;
    void tick().then(() => composerInput?.focus());
  }

  function handleGlobalKey(event: KeyboardEvent) {
    if (event.isComposing) return;
    navigateSpaces(event);
    navigateFeed(event);
    if (!profile || document.querySelector('dialog[open]')) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'k') {
      event.preventDefault();
      searchInput?.focus();
      searchInput?.select();
    } else if (event.key === 'Escape' && !submitting) {
      if (query) {
        query = '';
        void scrollNewest();
      } else if (selecting) leaveSelection();
      else if (editing) cancelEditing();
    } else if (
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !isTypingTarget(event.target)
    ) {
      if (key === 'n') {
        event.preventDefault();
        query = '';
        void tick().then(() => composerInput?.focus());
      }
      if (key === '?') {
        event.preventDefault();
        shortcutsOpen = true;
      }
    }
  }

  function navigateSpaces(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.matches('.space-button')) return;
    const buttons = Array.from(
      target
        .closest('nav')!
        .querySelectorAll<HTMLButtonElement>('.space-button'),
    );
    const index = buttons.indexOf(target as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
            buttons.length;
    event.preventDefault();
    buttons[next]?.focus();
  }

  function navigateFeed(event: KeyboardEvent) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (
      !target.matches('.memo') ||
      !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
    )
      return;
    const cards = Array.from(feed.querySelectorAll<HTMLElement>('.memo'));
    const index = cards.indexOf(target);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? cards.length - 1
          : Math.max(
              0,
              Math.min(
                cards.length - 1,
                index + (event.key === 'ArrowDown' ? 1 : -1),
              ),
            );
    event.preventDefault();
    cards[next]?.focus();
  }

  function setTheme(value: string) {
    theme = value;
    localStorage.setItem('scratchwall.theme', value);
    document.documentElement.dataset.theme = value;
  }

  async function installApp() {
    await installPrompt?.prompt();
    await installPrompt?.userChoice;
    installPrompt = undefined;
  }

  function dateLabel(date: string) {
    const value = new Date(date);
    const today = new Date();
    if (value.toDateString() === today.toDateString()) return 'Today';
    today.setDate(today.getDate() - 1);
    if (value.toDateString() === today.toDateString()) return 'Yesterday';
    return value.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year:
        value.getFullYear() !== new Date().getFullYear()
          ? 'numeric'
          : undefined,
    });
  }

  async function signIn() {
    error = '';
    authExpired = false;
    try {
      await login();
    } catch (value) {
      error = value instanceof Error ? value.message : String(value);
    }
  }

  async function signOut() {
    if (
      !confirm(
        'Log out and wipe every locally cached memo and file from this device?',
      )
    )
      return;
    profile = undefined;
    localStorage.setItem('scratchwall.loggedOut', 'true');
    settingsOpen = false;
    sidebarOpen = false;
    shortcutsOpen = false;
    previewAttachment = undefined;
    spaceForm = undefined;
    movingMemoIds = [];
    editing = undefined;
    body = '';
    tagDraft = '';
    selectedFiles = [];
    explicitTags = [];
    query = '';
    drafts = new Map();
    disconnectSocket?.();
    cancelRequests();
    await syncFlight;
    try {
      await logout();
    } catch {
      /* local logout still wins */
    }
    await clearLocalData();
    profile = undefined;
    await refresh();
  }

  onMount(() => {
    previousVersion = recordLoadedVersion();
    searchWorker = new Worker(
      new URL('./lib/search.worker.ts', import.meta.url),
      { type: 'module' },
    );
    searchWorker.onmessage = (event) => {
      if (event.data.type === 'results' && event.data.query === query) {
        resultIds = new Set(event.data.ids);
        searching = false;
      }
    };
    const onOnline = () => {
      online = true;
      void sync();
    };
    const onOffline = () => {
      online = false;
      reachable = false;
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void sync();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const pwa = registerWebUpdate(() => {
      pwaNeedsRefresh = true;
    });
    applyWebUpdate = pwa.apply;
    document.documentElement.dataset.theme = theme;
    document.addEventListener('paste', handlePaste);
    document.addEventListener('keydown', handleGlobalKey);
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      installPrompt = event as typeof installPrompt;
    };
    const onInstalled = () => {
      installPrompt = undefined;
    };
    window.addEventListener('beforeinstallprompt', onInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    // Native clients cannot attach their bearer token to a browser WebSocket.
    // A visible-only timer keeps all open clients inside the two-second convergence target.
    const foregroundSync = window.setInterval(() => {
      if (document.visibilityState === 'visible' && online && profile)
        void sync();
    }, 2_000);

    let removeDeepLink = () => {};
    void (async () => {
      removeDeepLink = await initializeNativeAuth(
        async (authenticated) => {
          error = '';
          const previous = await getProfile();
          if (previous && previous.subject !== authenticated.subject)
            await clearLocalData();
          profile = authenticated;
          checkingSession = false;
          await setProfile(authenticated);
          await sync();
        },
        (value) => {
          error = value instanceof Error ? value.message : String(value);
        },
      );
      const cachedProfile = await getProfile();
      profile = localStorage.getItem('scratchwall.loggedOut') ? undefined : cachedProfile;
      await refresh();
      // Local memos are usable while session validation or silent renewal runs.
      if (profile) authChecked = true;
      if (new URL(location.href).searchParams.get('auth') === 'required') {
        authExpired = true;
        error = 'Sign in required';
        history.replaceState({}, '', `${location.pathname}${location.hash}`);
      }
      try {
        if (localStorage.getItem('scratchwall.loggedOut'))
          throw new Error('Sign in to continue');
        const current = await me();
        if (cachedProfile && cachedProfile.subject !== current.subject) {
          await clearLocalData();
          body = '';
          selectedFiles = [];
          explicitTags = [];
          editing = undefined;
          drafts = new Map();
          await refresh();
        }
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
      checkingSession = false;
      authChecked = true;
      if (profile) {
        await scrollNewest();
        await sync();
        disconnectSocket = connectChanges(() => void sync());
      }
      try {
        if (!isNative()) return;
        const manifest = await fetch(
          `${apiOrigin()}/downloads/manifest.json`,
        ).then((response) => (response.ok ? response.json() : undefined));
        if (
          manifest?.version &&
          manifest.version.localeCompare('0.1.0', undefined, {
            numeric: true,
          }) > 0
        ) {
          updateAvailable = {
            version: manifest.version,
            url: `${apiOrigin()}/downloads/`,
          };
        }
      } catch {
        /* launch checks are best effort */
      }
    })();

    return () => {
      disconnectSocket?.();
      searchWorker.terminate();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('paste', handlePaste);
      document.removeEventListener('keydown', handleGlobalKey);
      window.removeEventListener('beforeinstallprompt', onInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      window.clearTimeout(savedTimer);
      window.clearInterval(foregroundSync);
      pwa.stop();
      removeDeepLink();
    };
  });

  $: if (searchWorker) {
    searching = Boolean(query.trim());
    searchWorker.postMessage({ type: 'query', query });
  }
</script>

{#snippet navigation()}
  <div class="sidebar-head">
    <a
      class="wordmark"
      href="/"
      onclick={(event) => {
        event.preventDefault();
        const inbox = spaces.find((space) => space.isInbox);
        if (inbox) openSpace(inbox.id);
      }}
      ><span class="brand-mark"><Icon name="note" size={19} /></span
      >scratchwall<span class="brand-period">.</span></a
    >
    <button
      class="icon-button mobile"
      aria-label="Close spaces"
      onclick={() => (sidebarOpen = false)}><Icon name="close" /></button
    >
  </div>
  <div class="sidebar-label">
    <span>Your spaces</span><button
      class="icon-button"
      title="New space"
      aria-label="New space"
      onclick={() => {
        sidebarOpen = false;
        addSpace();
      }}><Icon name="plus" size={17} /></button
    >
  </div>
  <nav aria-label="Spaces">
    {#each spaces as space (space.id)}
      <div class="space-row" class:active={space.id === selectedSpace}>
        <button
          class="space-button"
          aria-current={space.id === selectedSpace ? 'page' : undefined}
          onclick={() => openSpace(space.id)}
        >
          <Icon name={space.isInbox ? 'inbox' : 'folder'} size={19} /><span
            >{space.name}</span
          ><small
            >{memos.filter((memo) => memo.spaceId === space.id).length}</small
          >
        </button>
      </div>
    {/each}
    <button
      class="new-space"
      onclick={() => {
        sidebarOpen = false;
        addSpace();
      }}><Icon name="plus" size={18} />New space</button
    >
  </nav>
  <div class="sidebar-bottom">
    <div class="local-note">
      <Icon name="cloud" size={19} />
      <div>
        <strong
          >{!online || !reachable
            ? 'Working offline'
            : memos.some((memo) => memo.syncState !== 'synced') ||
                spaces.some((space) => space.syncState !== 'synced') ||
                attachments.some((attachment) => !attachment.remoteReady)
              ? 'Changes saved locally'
              : !hasSynced
                ? 'Syncing your wall'
                : 'Up to date'}</strong
        ><small
          >{!online || !reachable
            ? 'Your changes stay on this device'
            : 'Saved on this device, synced to yours'}</small
        >
      </div>
    </div>
    {#if installPrompt}<button class="sidebar-action" onclick={installApp}
        ><Icon name="download" size={18} />Install Scratchwall</button
      >{/if}
    <button
      class="sidebar-action"
      onclick={() => {
        sidebarOpen = false;
        shortcutsOpen = true;
      }}
      ><Icon name="keyboard" size={18} />Keyboard shortcuts<span>?</span
      ></button
    >
    <button
      class="account-button"
      onclick={() => {
        sidebarOpen = false;
        settingsOpen = true;
      }}
      ><span class="avatar"
        >{profile?.displayName?.slice(0, 1).toUpperCase() || 'S'}</span
      ><span
        ><strong>{profile?.displayName || 'Your account'}</strong><small
          >Settings & preferences</small
        ></span
      ><Icon name="settings" size={18} /></button
    >
  </div>
{/snippet}

{#if !authChecked}
  <main class="gate" aria-busy="true">
    <span class="brand-mark"><Icon name="note" size={28} /></span>
    <div class="spinner"></div>
    <p>Opening your wall…</p>
  </main>
{:else if !profile}
  <main class="gate">
    <div class="gate-card">
      <span class="brand-mark"><Icon name="note" size={28} /></span>
      <span class="eyebrow">A little space for everything</span>
      <h1>Catch a thought.<br />Keep it close.</h1>
      <p>
        Your notes, links, and files. One quiet wall.<br />Ready whenever
        inspiration finds you.
      </p>
      <button class="primary" onclick={signIn} disabled={!online}
        >Continue with VoidAuth<Icon name="chevron" size={18} /></button
      >
      <div class="gate-features">
        <span><Icon name="check" size={15} />Works offline</span><span
          ><Icon name="check" size={15} />Syncs across devices</span
        >
      </div>
      {#if error}<p class="gate-error" role="alert">{error}</p>{/if}
      {#if !online}<p class="gate-error">
          Connect to sign in on this device.
        </p>{/if}
    </div>
    <span class="gate-brand">scratchwall.</span>
  </main>
{:else}
  <div
    class="shell"
    role="group"
    aria-label="Your wall"
    ondragenter={handleDragEnter}
    ondragleave={handleDragLeave}
    ondragover={handleDragOver}
    ondrop={handleDrop}
  >
    <aside class="sidebar">{@render navigation()}</aside>
    <main class="workspace" id="workspace">
      <header class="workspace-header">
        <div class="breadcrumb">
          <button
            class="icon-button mobile"
            aria-label="Open spaces"
            aria-expanded={sidebarOpen}
            onclick={() => (sidebarOpen = true)}><Icon name="menu" /></button
          ><Icon
            name={activeSpace?.isInbox ? 'inbox' : 'folder'}
            size={18}
          /><span>Your spaces</span><Icon name="chevron" size={14} /><strong
            >{activeSpace?.name ?? 'Scratchwall'}</strong
          >
        </div>
        <label class="search"
          ><Icon name="search" size={18} /><input
            bind:this={searchInput}
            bind:value={query}
            oninput={() => (renderLimit = 200)}
            placeholder="Search your wall"
            aria-label="Search your wall"
          />{#if searching}<span class="tiny-spinner" aria-label="Searching"
            ></span>{:else if query}<button
              class="icon-button"
              aria-label="Clear search"
              onclick={() => {
                query = '';
                searchInput.focus();
                void scrollNewest();
              }}><Icon name="close" size={16} /></button
            >{:else}<kbd>Ctrl K</kbd>{/if}</label
        >
      </header>
      <div class="space-heading">
        <div>
          <span class="eyebrow"
            >{query
              ? 'Find something you saved'
              : 'A space to clear your head'}</span
          >
          <h1>
            <span class="space-title"
              >{query
                ? 'Search results'
                : (activeSpace?.name ?? 'Your wall')}</span
            ><span class="memo-count">{visibleMemos.length}</span>
          </h1>
          <p>
            {query
              ? `Results for “${query}”`
              : activeSpace?.isInbox
                ? 'Thoughts, links, and things worth keeping.'
                : 'Everything you want to keep in one place.'}
          </p>
        </div>
        <div class="heading-actions">
          <button
            class="secondary"
            class:active={selecting}
            aria-pressed={selecting}
            onclick={() => (selecting ? leaveSelection() : (selecting = true))}
            ><Icon name={selecting ? 'close' : 'select'} size={17} /><span
              >{selecting ? 'Done' : 'Select'}</span
            ></button
          >{#if activeSpace && !activeSpace.isInbox && !query}<button
              class="icon-button"
              title="Rename space"
              aria-label="Rename space"
              onclick={() => activeSpace && renameSpace(activeSpace)}
              ><Icon name="edit" size={18} /></button
            ><button
              class="icon-button danger"
              title="Delete space"
              aria-label="Delete space"
              onclick={() => activeSpace && removeSpace(activeSpace)}
              ><Icon name="trash" size={18} /></button
            >{/if}
        </div>
      </div>
      {#if query}<div class="search-scope">
          <span>Search in</span><button
            class:active={searchAllSpaces}
            aria-pressed={searchAllSpaces}
            onclick={() => (searchAllSpaces = true)}>All spaces</button
          ><button
            class:active={!searchAllSpaces}
            aria-pressed={!searchAllSpaces}
            onclick={() => (searchAllSpaces = false)}
            >{activeSpace?.name ?? 'This space'}</button
          >
        </div>{/if}
      {#if tagSearch}<div class="search-tags" aria-label="Matching tags">
          {#if searchTags.length}
            <span>Tags</span>
            {#each searchTags as tag}<button
                onclick={() => {
                  query = `#${tag}`;
                  renderLimit = 200;
                  searchInput.focus();
                }}>#{tag}</button>{/each}
          {:else}<span>No matching tags in this search scope.</span>{/if}
        </div>{/if}
      {#if error}<div class="error-banner" role="status">
          <Icon name="warning" size={18} /><span>{error}</span
          >{#if authExpired}<button class="secondary" onclick={signIn}
              >Sign in again</button
            >{/if}<button
            class="icon-button"
            aria-label="Dismiss error"
            onclick={() => (error = '')}><Icon name="close" size={17} /></button
          >
        </div>{/if}
      {#if selecting}<div class="batch-bar">
          <strong>{selectedMemoIds.size} selected</strong><button
            onclick={() =>
              (selectedMemoIds = new Set(renderedMemos.map(({ id }) => id)))}
            >Select shown</button
          ><button
            disabled={!selectedMemoIds.size}
            onclick={() => bumpMemos(selectedMemoIds)}
            ><Icon name="arrow" size={16} />Bump</button
          ><button
            disabled={!selectedMemoIds.size}
            onclick={() => startMove(selectedMemoIds)}
            ><Icon name="move" size={16} />Move</button
          ><button
            disabled={!selectedMemoIds.size}
            onclick={() => downloadFiles(selectedMemoIds)}
            ><Icon name="download" size={16} />Files</button
          ><button
            class="danger"
            disabled={!selectedMemoIds.size}
            onclick={() => removeMemos(selectedMemoIds)}
            ><Icon name="trash" size={16} />Delete</button
          >
        </div>{/if}
      <div
        class="feed"
        bind:this={feed}
        onscroll={onFeedScroll}
        role="region"
        aria-label={query ? 'Search results' : 'Memos'}
      >
        <div class="feed-content">
          {#if visibleMemos.length === 0}<div class="empty">
              <span class="empty-icon"
                ><Icon name={query ? 'search' : 'note'} size={32} /></span
              ><span class="eyebrow"
                >{query ? 'Keep looking' : 'Make room for an idea'}</span
              >
              <h2>{query ? 'No matches just yet' : 'Your wall starts here'}</h2>
              <p>
                {query
                  ? 'Try a different word, a filename, or a #tag.'
                  : 'A thought, a useful link, a picture you love.\nDrop it here and come back to it anytime.'}
              </p>
              {#if query}<button
                  class="secondary"
                  onclick={() => {
                    query = '';
                    void scrollNewest();
                  }}>Clear search</button
                >{:else}<button
                  class="secondary"
                  onclick={() => composerInput?.focus()}
                  ><Icon name="plus" size={17} />Write your first memo</button
                >{/if}
            </div>{/if}
          {#if visibleMemos.length > renderedMemos.length}<button
              class="load-more"
              onclick={showMore}
              >{query
                ? `Show more results · ${visibleMemos.length - renderedMemos.length} remaining`
                : 'Load older memos'}</button
            >{/if}
          {#each renderedMemos as memo, index (memo.id)}
            {@const preview =
              previewTick >= 0 ? memoPreview(memo.body) : undefined}
            {#if !query && (index === 0 || dateLabel(memo.bumpedAt ?? memo.createdAt) !== dateLabel(renderedMemos[index - 1].bumpedAt ?? renderedMemos[index - 1].createdAt))}<div
                class="date-divider"
              >
                <span>{dateLabel(memo.bumpedAt ?? memo.createdAt)}</span>
              </div>{/if}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (Cards are focusable so arrow keys can navigate readable memos.) -->
            <article
              class="memo"
              tabindex="0"
              data-memo-id={memo.id}
              class:selected={selectedMemoIds.has(memo.id)}
              class:error={memo.syncState === 'error'}
              aria-label={`Memo from ${new Date(memo.createdAt).toLocaleString()}`}
            >
              {#if selecting}<label class="select-memo"
                  ><input
                    type="checkbox"
                    checked={selectedMemoIds.has(memo.id)}
                    onchange={() => toggleMemoSelection(memo.id)}
                    aria-label="Select memo"
                  /></label
                >{/if}
              {#if query && searchAllSpaces}<div class="memo-space">
                  <Icon name="folder" size={14} />{spaceNames.get(
                    memo.spaceId,
                  ) ?? 'Unknown space'}
                </div>{/if}
              {#if memo.body && !hideMemoBody(memo.body, preview)}<MemoBody body={memo.body} />{/if}
              {#if preview}<a
                  class="link-preview"
                  href={preview.url}
                  target="_blank"
                  rel="noreferrer"
                  ><span class="link-site-icon"
                    >{#if preview.favicon}<img
                        src={preview.favicon}
                        alt=""
                        loading="lazy"
                      />{:else}<Icon name="move" size={20} />{/if}</span
                  ><span class="copy"
                    ><small>{preview.site}</small><strong
                      >{preview.title ?? preview.site}</strong
                    >{#if preview.description}<span class="snippet"
                        >{preview.description}</span
                      >{/if}</span
                  ><Icon name="move" size={16} /></a
                >{/if}
              {#if memo.attachmentIds.length}
                {@const items = attachmentsFor(memo)}
                {@const images = items.filter(isAlbumImage)}
                {@const files = items.filter(
                  (attachment) => !isAlbumImage(attachment),
                )}
                {#if images.length}<div
                    class="album"
                    class:album-single={images.length === 1}
                  >
                    {#each images as attachment (attachment.id)}<button
                        class="image-attachment"
                        class:video={isVideoMime(attachment.mimeType)}
                        aria-label={`Open ${attachment.filename}`}
                        onclick={() => openAlbumImage(attachment)}
                        ><img
                          src={attachment.thumbnail}
                          alt={attachment.filename}
                          loading="lazy"
                          draggable="false"
                        />{#if isVideoMime(attachment.mimeType)}<span
                            class="video-play"
                            aria-hidden="true"

                          ></span>{/if}{#if !isAttachmentCached(attachment.cacheState)}<span
                            class="download-badge"
                            ><Icon name="download" size={15} /></span
                          >{/if}</button
                      >{/each}
                  </div>{/if}
                {#if files.length}<div class="attachments">
                    {#each files as attachment (attachment.id)}<button
                        class="attachment"
                        onclick={() => openAttachment(attachment)}
                        ><span class="file-badge"
                          >{fileExtension(attachment.filename)}</span
                        ><span class="file-meta"
                          ><strong>{attachment.filename}</strong><small
                            >{attachment.size
                              ? `${formatBytes(attachment.size)} · ${attachmentStatusLabel(attachment.cacheState, attachment.remoteReady)}`
                              : 'Still syncing to this device'}</small
                          ></span
                        ><Icon name="download" size={18} /></button
                      >{/each}
                  </div>{/if}
              {/if}
              {#if memo.tags.length}<div class="tags">
                  {#each memo.tags as tag}<button
                      onclick={() => {
                        query = `#${tag}`;
                        renderLimit = 200;
                      }}>#{tag}</button
                    >{/each}
                </div>{/if}
              <footer class="memo-footer">
                <time
                  datetime={memo.createdAt}
                  title={new Date(memo.createdAt).toLocaleString()}
                  >{new Date(memo.createdAt).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}</time
                ><span
                  class="sync-mark"
                  title={memo.syncState === 'synced'
                    ? 'Synced'
                    : memo.syncState === 'pending'
                      ? 'Saved locally, waiting to sync'
                      : 'Sync failed'}
                  aria-label={memo.syncState === 'synced'
                    ? 'Synced'
                    : memo.syncState === 'pending'
                      ? 'Saved locally, waiting to sync'
                      : 'Sync failed'}
                  ><Icon
                    name={memo.syncState === 'synced'
                      ? 'check'
                      : memo.syncState === 'pending'
                        ? 'cloud'
                        : 'warning'}
                    size={14}
                  /></span
                >{#if memo.bumpedAt}<span class="bumped-label">Bumped</span
                  >{/if}
                <div class="memo-actions">
                  <button
                    class="icon-button"
                    aria-label="Bump memo"
                    title="Bump to newest"
                    onclick={() => bumpMemos([memo.id])}
                    ><Icon name="arrow" size={17} /></button
                  ><button
                    class="icon-button"
                    aria-label="Move memo"
                    title="Move to space"
                    onclick={() => startMove([memo.id])}
                    ><Icon name="move" size={17} /></button
                  ><button
                    class="icon-button"
                    aria-label="Edit memo"
                    title="Edit memo"
                    onclick={() => editMemo(memo)}
                    ><Icon name="edit" size={17} /></button
                  ><button
                    class="icon-button danger"
                    aria-label="Delete memo"
                    title="Delete memo"
                    onclick={() => removeMemo(memo)}
                    ><Icon name="trash" size={17} /></button
                  >
                </div>
              </footer>
            </article>
          {/each}
        </div>
      </div>
      {#if !query}
        <div class="composer-area">
          <form
            class="composer"
            class:editing
            onsubmit={(event) => {
              event.preventDefault();
              void submitMemo();
            }}
          >
            {#if editing}<div class="editing-note">
                <Icon name="edit" size={15} /><span
                  >Editing memo{editing.spaceId !== selectedSpace
                    ? ` in ${spaceNames.get(editing.spaceId) ?? 'another space'}`
                    : ''}</span
                ><button
                  type="button"
                  disabled={submitting}
                  onclick={cancelEditing}>Cancel</button
                >
              </div>{/if}
            {#if selectedFiles.length}<div class="queued-files">
                {#each selectedFiles as file, index (file)}<PendingFile
                    {file}
                    disabled={submitting}
                    onremove={() =>
                      (selectedFiles = selectedFiles.filter(
                        (_, i) => i !== index,
                      ))}
                  />{/each}
              </div>{/if}
            <textarea
              bind:this={composerInput}
              bind:value={body}
              use:autosizeTextarea={body}
              onkeydown={handleComposerKey}
              disabled={submitting}
              rows="2"
              enterkeyhint={enterSends ? 'send' : 'enter'}
              placeholder="What's on your mind?"
              aria-label="Memo text"
            ></textarea>
            {#if explicitTags.length}<div class="tags selected">
                {#each explicitTags as tag}<button
                    type="button"
                    disabled={submitting}
                    aria-label={`Remove tag ${tag}`}
                    onclick={() =>
                      (explicitTags = explicitTags.filter(
                        (value) => value !== tag,
                      ))}>#{tag}<Icon name="close" size={12} /></button
                  >{/each}
              </div>{/if}
            <div class="composer-toolbar">
              <button
                type="button"
                class="icon-button"
                aria-label="Attach files"
                title="Attach files"
                disabled={submitting}
                onclick={() => fileInput.click()}
                ><Icon name="attach" size={19} /></button
              ><input
                bind:this={fileInput}
                class="hidden"
                type="file"
                multiple
                onchange={(event) => handleFiles(event.currentTarget.files)}
              /><label class="tag-input"
                ><Icon name="tag" size={16} /><input
                  bind:value={tagDraft}
                  disabled={submitting}
                  onkeydown={(event) => {
                    if (event.key === 'Enter' || event.key === ',') {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                  onblur={() => {
                    if (tagDraft.trim()) addTag();
                  }}
                  placeholder="Add a tag"
                  aria-label="Add a tag"
                  list="tag-suggestions"
                /></label
              ><datalist id="tag-suggestions"
                >{#each spaceTags.filter((tag) => !explicitTags.some((selected) => selected.toLocaleLowerCase() === tag.toLocaleLowerCase())) as tag}<option
                    value={tag}
                  ></option>{/each}</datalist
              ><span class="save-shortcut">{enterSends ? 'Enter to send · Shift + Enter for a new line' : 'Ctrl / ⌘ + Enter to send'}</span><button
                class="send"
                type="submit"
                disabled={submitting || (!body.trim() && !selectedFiles.length)}
                >{#if submitting}<span class="tiny-spinner"
                  ></span>Saving{:else}<span
                    >{editing ? 'Save changes' : 'Save memo'}</span
                  ><Icon name="arrow" size={17} />{/if}</button
              >
            </div>
          </form>
          <div class="composer-caption">
            <span>Paste anything. Drop files. Make it yours.</span><span
              class="saved-message"
              role="status">{savedMessage}</span
            ><span class="local-indicator"
              ><span class="status-dot" class:online={online && reachable}
              ></span>{online && reachable
                ? 'Local-first · online'
                : 'Offline · saved on this device'}</span
            >
          </div>
        </div>
      {/if}
      {#if draggingFiles}<div class="drop-overlay" aria-hidden="true">
          <div>
            <Icon name="attach" size={36} />
            <h2>Drop it on your wall</h2>
            <p>Files will be attached to your next memo.</p>
          </div>
        </div>{/if}
    </main>
  </div>
{/if}

{#if sidebarOpen}<Dialog
    title="Your spaces"
    drawer
    onclose={() => (sidebarOpen = false)}>{@render navigation()}</Dialog
  >{/if}
{#if spaceForm}<Dialog
    title={spaceForm.space ? 'Rename space' : 'Make a little space'}
    onclose={() => (spaceForm = undefined)}
    ><form
      onsubmit={(event) => {
        event.preventDefault();
        void saveSpace();
      }}
    >
      <p class="dialog-description">
        {spaceForm.space
          ? 'Give this space a new name.'
          : 'A home for a project, a topic, or whatever you collect.'}
      </p>
      <label class="form-label"
        >Space name<input
          data-initial-focus
          bind:value={spaceName}
          maxlength="100"
          placeholder="e.g. Ideas, Reading, Weekend plans"
          required
        /></label
      >
      <div class="dialog-actions">
        <button
          type="button"
          class="secondary"
          onclick={() => (spaceForm = undefined)}>Cancel</button
        ><button class="primary" disabled={!spaceName.trim() || spaceSaving}
          >{spaceSaving
            ? 'Saving…'
            : spaceForm.space
              ? 'Save name'
              : 'Create space'}</button
        >
      </div>
    </form></Dialog
  >{/if}
{#if movingMemoIds.length}<Dialog
    title={`Move ${movingMemoIds.length === 1 ? 'memo' : `${movingMemoIds.length} memos`}`}
    onclose={() => (movingMemoIds = [])}
    ><p class="dialog-description">
      Choose a space for your {movingMemoIds.length === 1 ? 'memo' : 'memos'}.
    </p>
    <div class="move-options">
      {#each spaces as space}<button onclick={() => moveMemos(space.id)}
          ><Icon name={space.isInbox ? 'inbox' : 'folder'} size={20} /><span
            >{space.name}</span
          ><Icon name="chevron" size={16} /></button
        >{/each}
    </div></Dialog
  >{/if}
{#if shortcutsOpen}<Dialog
    title="A few useful shortcuts"
    onclose={() => (shortcutsOpen = false)}
    ><dl class="shortcut-list">
      <div>
        <dt>Search your wall</dt>
        <dd><kbd>Ctrl / ⌘</kbd><kbd>K</kbd></dd>
      </div>
      <div>
        <dt>Write a memo</dt>
        <dd><kbd>N</kbd></dd>
      </div>
      <div>
        <dt>Save a memo</dt>
        <dd>{#if !enterSends}<kbd>Ctrl / ⌘</kbd>{/if}<kbd>Enter</kbd></dd>
      </div>
      <div>
        <dt>Add a new line</dt>
        <dd>{#if enterSends}<kbd>Shift</kbd>{/if}<kbd>Enter</kbd></dd>
      </div>
      <div>
        <dt>Close dialog / cancel</dt>
        <dd><kbd>Esc</kbd></dd>
      </div>
      <div>
        <dt>Move through spaces or memos</dt>
        <dd><kbd>↑</kbd><kbd>↓</kbd></dd>
      </div>
      <div>
        <dt>Show shortcuts</dt>
        <dd><kbd>?</kbd></dd>
      </div>
    </dl>
    <p class="dialog-description">
      Tab reaches every action. Single-key shortcuts work when you aren't
      typing.
    </p></Dialog
  >{/if}
{#if settingsOpen}<Dialog
    title="Make yourself at home"
    onclose={() => (settingsOpen = false)}
    ><div class="settings-section">
      <h3>Appearance</h3>
      <div class="theme-options">
        {#each ['system', 'light', 'dark'] as value}<button
            class:active={theme === value}
            aria-pressed={theme === value}
            onclick={() => setTheme(value)}
            >{value[0].toUpperCase() + value.slice(1)}</button
          >{/each}
      </div>
    </div>
    <div class="settings-section">
      <h3>Writing</h3>
      <label class="enter-preference">
        <input type="checkbox" bind:checked={enterSends}
          onchange={(event) => localStorage.setItem('scratchwall.enterSends', String(event.currentTarget.checked))} />
        <span>Enter sends a memo<small>Shift + Enter adds a new line. Turn off to send with Ctrl / ⌘ + Enter.</small></span>
      </label>
    </div>
    <div class="settings-section">
      <h3>Your device</h3>
      <p class="dialog-description">
        Memos are saved locally first. Open Scratchwall online to sync your
        changes.
      </p>
      <button
        class="settings-action"
        disabled={syncing || !online}
        onclick={() => sync()}
        ><Icon name="sync" size={18} /><span
          >{syncing ? 'Syncing…' : 'Sync now'}</span
        ></button
      ><button class="settings-action" onclick={clearFiles}
        ><Icon name="file" size={18} /><span
          >Clear downloaded files<small>Keeps your memos and server files</small
          ></span
        ></button
      >{#if installPrompt}<button class="settings-action" onclick={installApp}
          ><Icon name="download" size={18} /><span>Install Scratchwall</span
          ></button
        >{:else}<p class="install-help">
          Install from your browser's menu. On iPhone or iPad, use Share → Add
          to Home Screen.
        </p>{/if}
    </div>
    <div class="settings-section">
      <a
        class="settings-action"
        href={`${apiOrigin()}/downloads/`}
        target="_blank"
        rel="noreferrer"
        ><Icon name="download" size={18} /><span
          >Download apps{#if updateAvailable}<small
              >Version {updateAvailable.version} is available</small
            >{/if}</span
        ></a
      >
    </div>
    <Changelog {previousVersion} />
    <AgentSettings {spaces} subject={profile?.subject ?? ''} />
    <div class="settings-section">
      <button class="settings-action danger" onclick={signOut}
        ><Icon name="logout" size={18} /><span
          >Log out<small>Clears this device's local data</small></span
        ></button
      >
    </div></Dialog
  >{/if}
{#if pwaNeedsRefresh}<div class="pwa-toast" role="status">
    <Icon name="sync" size={19} /><span>A fresh version is ready</span><button
      class="primary"
      type="button"
      disabled={submitting || hasDraft}
      title={hasDraft
        ? 'Save your draft before refreshing'
        : 'Load the new version'}
      onclick={() => applyWebUpdate()}>Refresh</button
    >
  </div>{/if}

{#if previewAttachment}
  <MediaPreview
    attachment={previewAttachment}
    onclose={() => (previewAttachment = undefined)}
    oncached={() => {
      void refresh();
    }}
  />
{/if}
