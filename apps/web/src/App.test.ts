// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import type { Memo, Space } from './lib/types';
import App from './App.svelte';
import { tick } from 'svelte';
import MediaPreview from './components/MediaPreview.svelte';
import { getAttachment } from './lib/repository';
import { downloadAttachment } from './lib/api';
import { SearchIndex } from './lib/search';
import { currentVersion } from './lib/changelog';

const state = vi.hoisted(() => ({
  memos: [] as Memo[],
  spaces: [] as Space[],
  putMemo: vi.fn(),
  putAttachment: vi.fn(),
  offline: false,
  me: vi.fn(),
  getSnapshot: vi.fn(),
  notifyUpdate: undefined as (() => void) | undefined,
  applyUpdate: vi.fn(),
}));
vi.mock('./lib/repository', () => ({
  getSnapshot: () => state.getSnapshot(),
  getProfile: async () => ({
    subject: 'test',
    displayName: 'Test account',
    groups: [],
  }),
  setProfile: vi.fn(),
  putMemo: (...args: unknown[]) => state.putMemo(...args),
  putAttachment: (...args: unknown[]) => state.putAttachment(...args),
  putSpace: async (space: Space) => {
    state.spaces = [
      ...state.spaces.filter((item) => item.id !== space.id),
      space,
    ];
  },
  deleteMemoLocal: vi.fn(),
  deleteSpaceLocal: vi.fn(),
  clearLocalData: vi.fn(),
  clearAttachmentCache: vi.fn(),
  attachmentSource: vi.fn(),
  openNativeAttachment: vi.fn(),
  getAttachment: vi.fn(),
}));
vi.mock('./lib/api', () => ({
  apiOrigin: () => '',
  cancelRequests: vi.fn(),
  connectChanges: () => () => {},
  downloadAttachment: vi.fn(),
  downloadNativeAttachment: vi.fn(),
  fetchLinkPreview: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  me: () => state.me(),
  syncUntilCaughtUp: vi.fn(),
  uploadPendingAttachments: vi.fn(),
  UnauthorizedError: class extends Error {},
}));
vi.mock('./lib/nativeAuth', () => ({
  isNative: () => false,
  initializeNativeAuth: async () => () => {},
}));
vi.mock('./lib/pwa', () => ({
  registerWebUpdate: (callback: () => void) => {
    state.notifyUpdate = callback;
    return { apply: () => state.applyUpdate(), stop: vi.fn() };
  },
}));
vi.mock('./lib/media', async (original) => ({
  ...(await original<typeof import('./lib/media')>()),
  createThumbnail: async () => undefined,
}));

function makeSpace(id: string, name: string, isInbox = false): Space {
  return {
    id,
    name,
    isInbox,
    position: 0,
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01',
    syncState: 'synced',
  };
}
function makeMemo(id: string): Memo {
  return {
    id,
    spaceId: 'inbox',
    body: id,
    tags: [],
    attachmentIds: [],
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01',
    syncState: 'synced',
  };
}
function paste(target: HTMLElement, files: File[] = [], text = '') {
  return fireEvent.paste(target, {
    clipboardData: {
      items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
      files: files.map(
        (file) =>
          new File([file], 'alternate.png', {
            type: file.type,
            lastModified: file.lastModified + 1,
          }),
      ),
      getData: () => text,
    },
  });
}
async function openApp() {
  const view = render(App);
  await view.findByRole('textbox', { name: 'Memo text' });
  return view;
}
beforeEach(() => {
  vi.clearAllMocks();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  });
  state.memos = [];
  state.offline = false;
  state.me.mockImplementation(async () => {
    if (state.offline) throw new Error('Offline');
    return { subject: 'test', displayName: 'Test account', groups: [] };
  });
  state.spaces = [
    makeSpace('inbox', 'Inbox', true),
    makeSpace('ideas', 'Ideas'),
  ];
  state.getSnapshot.mockImplementation(async () => ({
    memos: state.memos,
    spaces: state.spaces,
    attachments: [],
  }));
  state.putMemo.mockImplementation(async (memo: Memo) => {
    state.memos = [...state.memos.filter((item) => item.id !== memo.id), memo];
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false })),
  );
  vi.stubGlobal(
    'Worker',
    class {
      index = new SearchIndex();
      onmessage?: (event: { data: { type: string; query: string; ids: string[] } }) => void;
      postMessage(message: { type: string; spaces?: Space[]; memos?: Memo[]; query?: string }) {
        if (message.type === 'update') this.index.update(message.spaces ?? [], message.memos ?? [], []);
        if (message.type === 'query') {
          const query = message.query ?? '';
          const ids = this.index.search(query);
          queueMicrotask(() => this.onmessage?.({ data: { type: 'results', query, ids } }));
        }
      }
      terminate() {}
    },
  );
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  vi.unstubAllGlobals();
});

describe('web workspace interactions', () => {
  it('shows tags for #, finds partial matches, and scopes suggestions with results', async () => {
    state.memos = [
      { ...makeMemo('Scratch note'), tags: ['scratch'] },
      { ...makeMemo('Ideas note'), spaceId: 'ideas', tags: ['Scratchpad', 'other'] },
      { ...makeMemo('Only body #scratch') },
    ];
    const view = await openApp();
    const search = view.getByRole('combobox', { name: 'Search your wall' });
    const suggestions = () => Array.from(view.container.querySelectorAll('.search-tags button')).map((button) => button.textContent);
    const dropdown = view.container.querySelector<HTMLDataListElement>(`#${search.getAttribute('list')}`)!;
    expect(dropdown.tagName).toBe('DATALIST');
    const dropdownSuggestions = () => Array.from(dropdown.options).map((option) => option.value);
    await fireEvent.input(search, { target: { value: '#' } });
    expect(suggestions()).toEqual(['#other', '#scratch', '#Scratchpad']);
    expect(dropdownSuggestions()).toEqual(['#other', '#scratch', '#Scratchpad']);
    await waitFor(() => expect(view.getAllByRole('article')).toHaveLength(2));
    await fireEvent.input(search, { target: { value: '#scra' } });
    expect(suggestions()).toEqual(['#scratch', '#Scratchpad']);
    expect(dropdownSuggestions()).toEqual(['#scratch', '#Scratchpad']);
    await waitFor(() => expect(view.getAllByRole('article')).toHaveLength(2));
    expect(view.queryByText('Only body #scratch')).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Inbox' }));
    expect(suggestions()).toEqual(['#scratch']);
    expect(dropdownSuggestions()).toEqual(['#scratch']);
    expect(view.getAllByRole('article')).toHaveLength(1);
    await fireEvent.click(view.container.querySelector('.search-tags button')!);
    expect((search as HTMLInputElement).value).toBe('#scratch');
    expect(document.activeElement).toBe(search);
    await fireEvent.input(search, { target: { value: '#missing' } });
    expect(view.getByText('No matching tags in this search scope.')).toBeTruthy();
    await waitFor(() => expect(view.queryAllByRole('article')).toHaveLength(0));
    expect(dropdownSuggestions()).toEqual([]);
    await fireEvent.input(search, { target: { value: 'scratch' } });
    expect(dropdownSuggestions()).toEqual([]);
  });

  it('shows the changelog inside Settings and preserves the actual previous release', async () => {
    localStorage.setItem('scratchwall.version.loaded', '0.1.0');
    const view = await openApp();
    expect(view.queryByRole('heading', { name: 'Changelog' })).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: /Settings & preferences/ }));
    expect(view.getByRole('heading', { name: 'Changelog' })).toBeTruthy();
    const previous = view.getByText('Previous').closest('li')!;
    expect(previous.textContent).toContain('0.1.0');
    expect(previous.classList.contains('previous')).toBe(true);
    expect(view.getByText('Current').closest('li')!.textContent).toContain(currentVersion);
    await fireEvent.click(view.getByRole('button', { name: 'Close dialog' }));
    await fireEvent.click(view.getByRole('button', { name: /Settings & preferences/ }));
    expect(view.getByText('Previous').closest('li')!.textContent).toContain('0.1.0');
  });

  function mockFeedLayout(view: Awaited<ReturnType<typeof openApp>>, scrollTop: number) {
    const feed = view.getByRole('region', { name: 'Memos' });
    Object.defineProperties(feed, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, get: () => feed.querySelectorAll('[data-memo-id]').length * 200 },
    });
    feed.scrollTop = scrollTop;
    vi.spyOn(feed, 'getBoundingClientRect').mockImplementation(() => ({ top: 0 }) as DOMRect);
    for (const memo of feed.querySelectorAll<HTMLElement>('[data-memo-id]')) {
      vi.spyOn(memo, 'getBoundingClientRect').mockImplementation(() => {
        const top = Array.from(feed.querySelectorAll('[data-memo-id]')).indexOf(memo) * 200 - feed.scrollTop;
        return { top, bottom: top + 200 } as DOMRect;
      });
    }
    return feed;
  }

  async function backgroundRefresh() {
    const reads = state.getSnapshot.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(state.getSnapshot).toHaveBeenCalledTimes(reads + 2));
    await tick();
  }

  it('leaves a stopped scroll near the bottom alone during unchanged background syncs', async () => {
    state.memos = Array.from({ length: 10 }, (_, index) => makeMemo(`memo-${index}`));
    const view = await openApp();
    await view.findByText('Up to date');
    const feed = mockFeedLayout(view, 1550);
    await fireEvent.scroll(feed);
    vi.mocked(feed.scrollTo).mockClear();
    await backgroundRefresh();
    expect(feed.scrollTo).not.toHaveBeenCalled();
    expect(feed.scrollTop).toBe(1550);
  });

  it('preserves the latest scroll position when a background database read finishes', async () => {
    state.memos = Array.from({ length: 10 }, (_, index) => makeMemo(`memo-${index}`));
    const view = await openApp();
    await view.findByText('Up to date');
    const feed = mockFeedLayout(view, 600);
    await fireEvent.scroll(feed);
    let finishRead!: () => void;
    state.getSnapshot.mockImplementationOnce(() => new Promise((resolve) => {
      finishRead = () => resolve({ memos: state.memos, spaces: state.spaces, attachments: [] });
    }));
    const reads = state.getSnapshot.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(finishRead).toBeTypeOf('function'));
    feed.scrollTop = 850;
    await fireEvent.scroll(feed);
    finishRead();
    await waitFor(() => expect(state.getSnapshot).toHaveBeenCalledTimes(reads + 2));
    await tick();
    expect(feed.scrollTop).toBe(850);
  });

  it('keeps the current memo in place when sync inserts older content', async () => {
    state.memos = Array.from({ length: 10 }, (_, index) => makeMemo(`memo-${index}`));
    const view = await openApp();
    await view.findByText('Up to date');
    const feed = mockFeedLayout(view, 650);
    await fireEvent.scroll(feed);
    state.getSnapshot.mockImplementationOnce(async () => {
      state.memos = [{ ...makeMemo('older-memo'), createdAt: '2026-09-30' }, ...state.memos];
      return { memos: state.memos, spaces: state.spaces, attachments: [] };
    });
    await backgroundRefresh();
    expect(feed.scrollTop).toBe(850);
  });

  it('follows new content at the bottom without snapping on the next unchanged refresh', async () => {
    state.memos = Array.from({ length: 10 }, (_, index) => makeMemo(`memo-${index}`));
    const view = await openApp();
    await view.findByText('Up to date');
    const feed = mockFeedLayout(view, 1600);
    await fireEvent.scroll(feed);
    vi.mocked(feed.scrollTo).mockClear();
    state.getSnapshot.mockImplementationOnce(async () => {
      state.memos = [...state.memos, { ...makeMemo('new-memo'), createdAt: '2026-10-02' }];
      return { memos: state.memos, spaces: state.spaces, attachments: [] };
    });
    await backgroundRefresh();
    expect(feed.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 2200, behavior: 'auto' });
  });

  it('keeps Shift+Enter for multiline input and saves with Enter', async () => {
    const view = await openApp();
    const textarea = view.getByRole('textbox', { name: 'Memo text' });
    await fireEvent.input(textarea, {
      target: { value: 'First line\nSecond line' },
    });
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(state.putMemo).not.toHaveBeenCalled();
    await fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(state.putMemo).toHaveBeenCalledTimes(1));
    expect(state.putMemo.mock.calls[0][0].body).toBe('First line\nSecond line');
    await waitFor(() =>
      expect((textarea as HTMLTextAreaElement).value).toBe(''),
    );
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });
  it('renders saved code snippets and edits their original source', async () => {
    const body = 'Example\n```js\n  const url = "https://code.test";\n```\n**Keep this**';
    state.memos = [{ ...makeMemo('snippet'), body }];
    const view = await openApp();
    expect(view.getByLabelText('js code snippet').textContent).toBe('  const url = "https://code.test";\n');
    expect(view.getByText('Keep this').tagName).toBe('STRONG');
    expect(view.queryByRole('link', { name: /code.test/ })).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Edit memo' }));
    const textarea = view.getByRole('textbox', { name: 'Memo text' });
    expect((textarea as HTMLTextAreaElement).value).toBe(body);
    await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(state.putMemo).toHaveBeenCalledTimes(1));
    expect(state.putMemo.mock.calls[0][0].body).toBe(body);
  });
  it('lets each device choose multiline Enter and still sends with Ctrl+Enter', async () => {
    const view = await openApp();
    await fireEvent.click(view.getByRole('button', { name: /Settings & preferences/ }));
    const checkbox = view.getByRole('checkbox', { name: /Enter sends a memo/ });
    await fireEvent.click(checkbox);
    expect(localStorage.getItem('scratchwall.enterSends')).toBe('false');
    await fireEvent.click(view.getByRole('button', { name: 'Close dialog' }));
    const textarea = view.getByRole('textbox', { name: 'Memo text' });
    await fireEvent.input(textarea, { target: { value: 'Draft' } });
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    textarea.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(state.putMemo).not.toHaveBeenCalled();
    await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(state.putMemo).toHaveBeenCalledTimes(1));
    view.unmount();
    const reopened = await openApp();
    expect(reopened.getByRole('textbox', { name: 'Memo text' }).getAttribute('enterkeyhint')).toBe('enter');
  });
  it('opens cached memos before a slow session validation finishes', async () => {
    let completeAuth!: (profile: { subject: string; displayName: string; groups: string[] }) => void;
    state.me.mockImplementation(() => new Promise((resolve) => { completeAuth = resolve; }));
    state.memos = [makeMemo('Instant local thought')];
    const view = await openApp();
    expect(view.getByText('Instant local thought')).toBeTruthy();
    expect(view.queryByText('Opening your wall…')).toBeNull();
    completeAuth({ subject: 'test', displayName: 'Test account', groups: [] });
    await view.findByText('Up to date');
  });
  it('keeps the up-to-date status steady during subsequent background syncs', async () => {
    const { syncUntilCaughtUp } = await import('./lib/api');
    const view = await openApp();
    await view.findByText('Up to date');
    let finish!: () => void;
    vi.mocked(syncUntilCaughtUp).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(view.getByText('Up to date')).toBeTruthy();
    expect(view.queryByText('Syncing your wall')).toBeNull();
    finish();
    await tick();
  });
  it('does not send when an IME confirms input or a held Enter repeats', async () => {
    const view = await openApp();
    const textarea = view.getByRole('textbox', { name: 'Memo text' });
    await fireEvent.input(textarea, { target: { value: 'Draft' } });
    await fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    await fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    await fireEvent.keyDown(textarea, { key: 'Enter', repeat: true });
    expect(state.putMemo).not.toHaveBeenCalled();
  });
  it('suggests only tags from the current space and lets new tags be entered', async () => {
    state.memos = [
      { ...makeMemo('inbox-note'), tags: ['InboxOnly', 'shared'] },
      { ...makeMemo('ideas-note'), spaceId: 'ideas', tags: ['IdeasOnly', 'shared'] },
    ];
    const view = await openApp();
    const suggestions = () => Array.from(view.container.querySelectorAll('#tag-suggestions option')).map((option) => option.getAttribute('value'));
    expect(suggestions()).toEqual(['InboxOnly', 'shared']);
    await fireEvent.click(view.getByRole('button', { name: /^Ideas/ }));
    expect(suggestions()).toEqual(['IdeasOnly', 'shared']);
    await fireEvent.input(view.getByRole('combobox', { name: 'Add a tag' }), { target: { value: 'NewTag' } });
    await fireEvent.keyDown(view.getByRole('combobox', { name: 'Add a tag' }), { key: 'Enter' });
    await fireEvent.input(view.getByRole('textbox', { name: 'Memo text' }), { target: { value: '#plainwords #важное' } });
    await fireEvent.click(view.getByRole('button', { name: 'Save memo' }));
    await waitFor(() => expect(state.putMemo).toHaveBeenCalledTimes(1));
    expect(state.putMemo.mock.calls[0][0]).toMatchObject({ spaceId: 'ideas', body: '#plainwords #важное', tags: ['NewTag'] });
  });
  it('does not restore a removed tag from hashtags when editing a memo', async () => {
    state.memos = [{ ...makeMemo('hashtag-note'), body: 'Keep #somewordsfromtext as text', tags: ['somewordsfromtext'] }];
    const view = await openApp();
    await fireEvent.click(view.getByRole('button', { name: 'Edit memo' }));
    await fireEvent.click(view.getByRole('button', { name: 'Remove tag somewordsfromtext' }));
    await fireEvent.click(view.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(state.putMemo).toHaveBeenCalledTimes(1));
    expect(state.putMemo.mock.calls[0][0]).toMatchObject({ body: 'Keep #somewordsfromtext as text', tags: [] });
  });
  it('attaches a pasted image once and leaves image pastes in search alone', async () => {
    const view = await openApp();
    const image = new File(['image'], 'image.png', {
      type: 'image/png',
      lastModified: 10,
    });
    await paste(view.getByRole('combobox', { name: 'Search your wall' }), [
      image,
    ]);
    expect(view.queryByRole('button', { name: 'Remove image.png' })).toBeNull();
    await paste(view.getByRole('textbox', { name: 'Memo text' }), [image]);
    expect(
      view.getAllByRole('button', { name: 'Remove image.png' }),
    ).toHaveLength(1);
    await fireEvent.click(view.getByRole('button', { name: 'Save memo' }));
    await waitFor(() => expect(state.putAttachment).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(state.putMemo).toHaveBeenCalledTimes(1));
    expect(state.putMemo.mock.calls[0][0].attachmentIds).toHaveLength(1);
  });
  it('routes background paste to the composer and supports search / compose shortcuts', async () => {
    const view = await openApp();
    await paste(
      view.getByRole('heading', { name: /^Inbox/ }),
      [],
      'A pasted thought',
    );
    const textarea = view.getByRole('textbox', { name: 'Memo text' });
    expect((textarea as HTMLTextAreaElement).value).toBe('A pasted thought');
    await fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(document.activeElement).toBe(
      view.getByRole('combobox', { name: 'Search your wall' }),
    );
    await fireEvent.keyDown(document.body, { key: 'n' });
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    await fireEvent.keyDown(textarea, { key: 'n' });
    expect((textarea as HTMLTextAreaElement).value).toBe('A pasted thought');
  });
  it('keeps separate drafts when switching spaces', async () => {
    const view = await openApp();
    const textarea = view.getByRole('textbox', { name: 'Memo text' });
    await fireEvent.input(textarea, { target: { value: 'Inbox draft' } });
    await fireEvent.click(view.getByRole('button', { name: /^Ideas/ }));
    expect((textarea as HTMLTextAreaElement).value).toBe('');
    await fireEvent.input(textarea, { target: { value: 'Ideas draft' } });
    await fireEvent.click(view.getByRole('button', { name: /^Inbox/ }));
    expect((textarea as HTMLTextAreaElement).value).toBe('Inbox draft');
    await fireEvent.click(view.getByRole('button', { name: /^Ideas/ }));
    expect((textarea as HTMLTextAreaElement).value).toBe('Ideas draft');
  });
  it('restores a new memo draft after saving an edit', async () => {
    state.memos = [makeMemo('Original memo')];
    const view = await openApp();
    const textarea = view.getByRole('textbox', { name: 'Memo text' });
    await fireEvent.input(textarea, {
      target: { value: 'Unfinished thought' },
    });
    await fireEvent.click(view.getByRole('button', { name: 'Edit memo' }));
    expect((textarea as HTMLTextAreaElement).value).toBe('Original memo');
    await fireEvent.input(textarea, { target: { value: 'Updated memo' } });
    await fireEvent.click(view.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect((textarea as HTMLTextAreaElement).value).toBe(
        'Unfinished thought',
      ),
    );
    expect(state.putMemo.mock.calls[0][0]).toMatchObject({
      id: 'Original memo',
      body: 'Updated memo',
    });
  });
  it('opens a native modal, focuses the name field, and closes on cancel', async () => {
    const view = await openApp();
    const opener = view.getAllByRole('button', { name: 'New space' })[0];
    opener.focus();
    await fireEvent.click(opener);
    const dialog = view.getByRole('dialog', { name: 'Make a little space' });
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(
      view.getByRole('textbox', { name: 'Space name' }),
    );
    await paste(view.getByRole('textbox', { name: 'Space name' }), [
      new File(['x'], 'image.png', { type: 'image/png' }),
    ]);
    expect(view.queryByRole('button', { name: 'Remove image.png' })).toBeNull();
    await fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(view.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
  it('supports arrow navigation between spaces and between memo cards', async () => {
    state.memos = [makeMemo('first'), makeMemo('second')];
    const view = await openApp();
    const inbox = view.getByRole('button', { name: /^Inbox/ });
    inbox.focus();
    await fireEvent.keyDown(inbox, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      view.getByRole('button', { name: /^Ideas/ }),
    );
    const cards = view.getAllByRole('article');
    cards[0].focus();
    await fireEvent.keyDown(cards[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cards[1]);
    await fireEvent.keyDown(cards[1], { key: 'Home' });
    expect(document.activeElement).toBe(cards[0]);
  });
  it('prevents repeated saves and destination changes while a save is pending', async () => {
    let completeSave: () => void = () => {};
    state.putMemo.mockImplementation(
      () => new Promise<void>((resolve) => (completeSave = resolve)),
    );
    const view = await openApp();
    const textarea = view.getByRole('textbox', { name: 'Memo text' });
    await fireEvent.input(textarea, { target: { value: 'Save this once' } });
    await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    await fireEvent.click(view.getByRole('button', { name: /^Ideas/ }));
    expect(state.putMemo).toHaveBeenCalledTimes(1);
    expect(view.getByRole('heading', { name: /^Inbox/ })).toBeTruthy();
    completeSave();
    await waitFor(() =>
      expect((textarea as HTMLTextAreaElement).value).toBe(''),
    );
  });
  it('holds PWA updates for drafts in every space and enables refresh after clearing them', async () => {
    const view = await openApp();
    const textarea = view.getByRole('textbox', { name: 'Memo text' });
    await fireEvent.input(textarea, { target: { value: 'Inbox draft' } });
    await fireEvent.click(view.getByRole('button', { name: /^Ideas/ }));
    state.notifyUpdate?.();
    await tick();
    const refresh = view.getByRole('button', {
      name: 'Refresh',
    }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
    await fireEvent.click(view.getByRole('button', { name: /^Inbox/ }));
    await fireEvent.input(textarea, { target: { value: '' } });
    expect(refresh.disabled).toBe(false);
    await fireEvent.click(refresh);
    expect(state.applyUpdate).toHaveBeenCalledTimes(1);
  });
  it('opens a cached wall when the network is unavailable', async () => {
    state.offline = true;
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    state.memos = [makeMemo('Cached thought')];
    const view = await openApp();
    expect(view.getByText('Cached thought')).toBeTruthy();
    expect(view.getByText('Test account')).toBeTruthy();
    expect(view.getByText('Working offline')).toBeTruthy();
  });
});

describe('web media viewer', () => {
  const attachment = {
    id: 'image',
    memoId: 'memo',
    filename: 'photo.png',
    mimeType: 'image/png',
    size: 12,
    cacheState: 'local' as const,
    remoteReady: false,
    createdAt: '2026-10-01',
  };
  it('opens cached images inside the app and releases the preview URL on close', async () => {
    vi.mocked(getAttachment).mockResolvedValue({
      ...attachment,
      blob: new Blob(['image']),
    });
    const view = render(MediaPreview, {
      attachment,
      onclose: vi.fn(),
      oncached: vi.fn(),
    });
    const image = await view.findByRole('img', { name: 'photo.png' });
    expect(image.getAttribute('src')).toBe('blob:test');
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(
      view.getByRole('link', { name: 'Download' }).getAttribute('download'),
    ).toBe('photo.png');
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });
  it('keeps a download available when the browser cannot decode a video', async () => {
    const videoAttachment = { ...attachment, filename: 'clip.mp4', mimeType: 'video/mp4' };
    vi.mocked(getAttachment).mockResolvedValue({ ...videoAttachment, blob: new Blob(['video']) });
    const view = render(MediaPreview, { attachment: videoAttachment, onclose: vi.fn(), oncached: vi.fn() });
    await view.findByRole('link', { name: 'Download' });
    const video = view.container.querySelector('video')!;
    await fireEvent.error(video);
    expect(view.getByRole('alert').textContent).toContain('could not play');
    expect(view.getByRole('link', { name: 'Download' })).toBeTruthy();
    expect(view.getByRole('dialog').classList.contains('media')).toBe(true);
  });
  it('shows download errors within the viewer', async () => {
    vi.mocked(getAttachment).mockResolvedValue(undefined);
    vi.mocked(downloadAttachment).mockRejectedValue(
      new Error('File unavailable offline'),
    );
    const view = render(MediaPreview, {
      attachment,
      onclose: vi.fn(),
      oncached: vi.fn(),
    });
    expect((await view.findByRole('alert')).textContent).toContain(
      'File unavailable offline',
    );
  });
});
