// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import type { Attachment, Memo, Space } from './lib/types';
import App from './App.svelte';
import { tick } from 'svelte';
import MediaPreview from './components/MediaPreview.svelte';
import { getAttachment } from './lib/repository';
import { downloadAttachment, embeddingSettings, semanticSearch } from './lib/api';
import { SearchIndex } from './lib/search';
import { currentVersion } from './lib/changelog';
import { stopAttachmentDownloads } from './lib/attachmentDownloads';

const state = vi.hoisted(() => ({
  memos: [] as Memo[],
  spaces: [] as Space[],
  attachments: [] as Attachment[],
  putMemo: vi.fn(),
  putAttachment: vi.fn(),
  offline: false,
  me: vi.fn(),
  getSnapshot: vi.fn(),
  notifyUpdate: undefined as (() => void) | undefined,
  applyUpdate: vi.fn(),
  putSpaces: vi.fn(),
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
  putSpaces: (...args: unknown[]) => state.putSpaces(...args),
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
  embeddingSettings: vi.fn(async () => ({ enabled: false, configured: false, pending: 0, running: 0, done: 0, failed: 0, total: 0, completeness: 0 })),
  semanticSearch: vi.fn(),
  UnauthorizedError: class extends Error {},
}));
vi.mock('./lib/nativeAuth', () => ({
  isNative: () => false,
  initializeNativeAuth: async () => () => {},
}));
vi.mock('./lib/pwa', async (original) => ({
  ...(await original<typeof import('./lib/pwa')>()),
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
function makeAttachment(id: string, memoId: string, mimeType = 'image/png'): Attachment {
  return {
    id, memoId, filename: `${id}.${mimeType === 'image/png' ? 'png' : 'mp4'}`, mimeType,
    size: 12, thumbnail: mimeType === 'image/png' ? 'data:image/png;base64,eA==' : undefined,
    cacheState: 'cached', remoteReady: true, createdAt: '2026-10-01',
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
  vi.mocked(embeddingSettings).mockResolvedValue({ enabled: false, configured: false, pending: 0, running: 0, done: 0, failed: 0, total: 0, completeness: 0 });
  vi.mocked(semanticSearch).mockResolvedValue({ available: true, hits: [] });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  });
  state.memos = [];
  state.attachments = [];
  state.offline = false;
  state.me.mockImplementation(async () => {
    if (state.offline) throw new Error('Offline');
    return { subject: 'test', displayName: 'Test account', groups: [] };
  });
  state.spaces = [
    makeSpace('inbox', 'Inbox', true),
    { ...makeSpace('ideas', 'Ideas'), position: 1 },
  ];
  state.putSpaces.mockImplementation(async (updates: Array<{ space: Space }>) => {
    const changed = new Map(updates.map(({ space }) => [space.id, space]));
    state.spaces = state.spaces.map((space) => changed.get(space.id) ?? space).sort((a, b) => a.position - b.position);
  });
  state.getSnapshot.mockImplementation(async () => ({
    memos: state.memos,
    spaces: state.spaces,
    attachments: state.attachments,
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
  HTMLDialogElement.prototype.show = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
});
afterEach(async () => {
  cleanup();
  await stopAttachmentDownloads();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('web workspace interactions', () => {
  it('saves the selected task, preserves memo metadata and retains its state after reopening offline', async () => {
    const memo = { ...makeMemo('checklist'), body: '- [ ] Same\n```text\n- [ ] Same\n```\n- [ ] Same', tags: ['Keep'], attachmentIds: ['file'], bumpedAt: '2026-10-02' };
    state.memos = [memo];
    const view = await openApp();
    const boxes = view.getAllByRole('checkbox', { name: 'Same' }) as HTMLInputElement[];
    expect(boxes.every((box) => !box.disabled)).toBe(true);
    await fireEvent.click(boxes[1]);
    await waitFor(() => expect(state.putMemo).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(boxes[1].checked).toBe(true));
    expect(state.putMemo.mock.calls[0][0]).toMatchObject({ ...memo, body: expect.any(String), updatedAt: expect.any(String), syncState: 'pending' });
    const saved = state.putMemo.mock.calls[0][0] as Memo;
    expect(saved.body).toBe('- [ ] Same\n```text\n- [ ] Same\n```\n- [x] Same');
    expect(state.putMemo.mock.calls[0][1]).toMatchObject({ kind: 'upsert_memo', entityId: memo.id, payload: saved });
    expect(boxes[0].checked).toBe(false);
    view.unmount();
    state.offline = true;
    const reopened = await openApp();
    expect((reopened.getAllByRole('checkbox', { name: 'Same' })[1] as HTMLInputElement).checked).toBe(true);
    await fireEvent.click(reopened.getAllByRole('checkbox', { name: 'Same' })[1]);
    await waitFor(() => expect(state.memos[0].body).toBe(memo.body));
  });

  it('restores a task checkbox when saving fails and preserves the composer draft', async () => {
    state.memos = [{ ...makeMemo('checklist'), body: '- [ ] Task' }];
    const view = await openApp();
    const draft = view.getByRole('textbox', { name: 'Memo text' }) as HTMLTextAreaElement;
    await fireEvent.input(draft, { target: { value: 'Keep my draft' } });
    state.putMemo.mockRejectedValueOnce(new Error('Storage full'));
    const box = view.getByRole('checkbox', { name: 'Task' }) as HTMLInputElement;
    await fireEvent.click(box);
    await view.findByText('Storage full');
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    expect(state.memos[0].body).toBe('- [ ] Task');
    expect(draft.value).toBe('Keep my draft');
  });

  it('prevents overlapping task saves in one memo while leaving other memos available', async () => {
    state.memos = [{ ...makeMemo('one'), body: '- [ ] First\n- [ ] Second' }, { ...makeMemo('two'), body: '- [ ] Other' }];
    const view = await openApp();
    let finish!: () => void;
    state.putMemo.mockImplementationOnce((memo: Memo) => new Promise<void>((resolve) => {
      finish = () => { state.memos = state.memos.map((item) => item.id === memo.id ? memo : item); resolve(); };
    }));
    await fireEvent.click(view.getByRole('checkbox', { name: 'First' }));
    expect((view.getByRole('checkbox', { name: 'Second' }) as HTMLInputElement).disabled).toBe(true);
    expect((view.getByRole('checkbox', { name: 'Other' }) as HTMLInputElement).disabled).toBe(false);
    finish();
    await waitFor(() => expect((view.getByRole('checkbox', { name: 'Second' }) as HTMLInputElement).disabled).toBe(false));
    await fireEvent.click(view.getByRole('checkbox', { name: 'Second' }));
    await waitFor(() => expect(state.memos.find((memo) => memo.id === 'one')?.body).toBe('- [x] First\n- [x] Second'));
  });

  it('composes from a memo tag in the current space, inherits all filters on every send, and hides in all spaces', async () => {
    state.memos = [
      { ...makeMemo('Tagged memo'), tags: ['Reading', 'Important'] },
      { ...makeMemo('Other space'), spaceId: 'ideas', tags: ['Reading', 'Important'] },
    ];
    const view = await openApp();
    await fireEvent.click(view.getByRole('article').querySelector<HTMLButtonElement>('.tags button')!);
    expect(view.getByRole('button', { name: 'Inbox' }).getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(view.getByLabelText('Matching tags').querySelector('button')!);
    const search = view.getByRole('combobox', { name: 'Search your wall' }) as HTMLInputElement;
    expect(search.value).toBe('#Reading #Important');
    const textarea = view.getByRole('textbox', { name: 'Memo text' });
    await fireEvent.input(view.getByRole('combobox', { name: 'Add a tag' }), { target: { value: 'reading' } });
    await fireEvent.keyDown(view.getByRole('combobox', { name: 'Add a tag' }), { key: 'Enter' });
    for (const body of ['First filtered memo', 'Second filtered memo']) {
      await fireEvent.input(textarea, { target: { value: body } });
      await fireEvent.click(view.getByRole('button', { name: 'Save memo' }));
      await view.findByText(body);
      await view.findByRole('button', { name: 'Save memo' });
      expect(state.putMemo.mock.lastCall![0]).toMatchObject({ body, spaceId: 'inbox', tags: ['Reading', 'Important'] });
    }
    await fireEvent.input(textarea, { target: { value: 'Keep this draft' } });
    await fireEvent.click(view.getByRole('button', { name: 'All spaces' }));
    expect(view.queryByRole('textbox', { name: 'Memo text' })).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Inbox' }));
    expect((view.getByRole('textbox', { name: 'Memo text' }) as HTMLTextAreaElement).value).toBe('Keep this draft');
    await fireEvent.click(view.getByRole('button', { name: 'Remove filter Important' }));
    expect(search.value).toBe('#Reading');
    await fireEvent.click(view.getByRole('button', { name: 'Clear search' }));
    expect(view.queryByLabelText('Tags inherited from filters')).toBeNull();
    expect((view.getByRole('textbox', { name: 'Memo text' }) as HTMLTextAreaElement).value).toBe('Keep this draft');
  });

  it('allows an empty-result filtered memo and retains its tags if the scope changes while saving a file', async () => {
    let finishAttachment!: () => void;
    state.putAttachment.mockImplementationOnce(() => new Promise<void>((resolve) => { finishAttachment = resolve; }));
    const view = await openApp();
    await fireEvent.input(view.getByRole('combobox', { name: 'Search your wall' }), { target: { value: '#new #Важное' } });
    await fireEvent.click(view.getByRole('button', { name: 'Inbox' }));
    await paste(view.getByRole('textbox', { name: 'Memo text' }), [new File(['a'], 'file.txt')]);
    expect((view.getByRole('combobox', { name: 'Search your wall' }) as HTMLInputElement).value).toBe('#new #Важное');
    await fireEvent.click(view.getByRole('button', { name: 'Save memo' }));
    await waitFor(() => expect(finishAttachment).toBeTypeOf('function'));
    await fireEvent.click(view.getByRole('button', { name: 'All spaces' }));
    finishAttachment();
    await waitFor(() => expect(state.putMemo).toHaveBeenCalledTimes(1));
    expect(state.putMemo.mock.calls[0][0]).toMatchObject({ tags: ['new', 'Важное'], spaceId: 'inbox' });
    await waitFor(() => expect(view.getAllByRole('article')).toHaveLength(1));
  });

  it('keeps the mobile tag field focused after Enter and dismisses focus after saving', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)', addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const view = await openApp();
    const textarea = view.getByRole('textbox', { name: 'Memo text' });
    await fireEvent.input(textarea, { target: { value: 'Mobile memo' } });
    const tag = view.getByRole('combobox', { name: 'Add a tag' }) as HTMLInputElement;
    tag.focus();
    await fireEvent.input(tag, { target: { value: 'One' } });
    await fireEvent.keyDown(tag, { key: 'Enter' });
    expect(document.activeElement).toBe(tag);
    expect(tag.value).toBe('');
    expect(state.putMemo).not.toHaveBeenCalled();
    await fireEvent.input(tag, { target: { value: 'Two' } });
    await fireEvent.keyDown(tag, { key: ',' });
    expect(document.activeElement).toBe(tag);
    await fireEvent.click(view.getByRole('button', { name: 'Save memo' }));
    await view.findByText('Mobile memo');
    await waitFor(() => expect(document.activeElement?.closest('.composer')).toBeNull());
    expect(state.putMemo.mock.calls[0][0].tags).toEqual(['One', 'Two']);
  });

  it('preserves a failed mobile draft and restores input focus', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)', addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    state.putMemo.mockRejectedValueOnce(new Error('Storage full'));
    const view = await openApp();
    const textarea = view.getByRole('textbox', { name: 'Memo text' });
    await fireEvent.input(textarea, { target: { value: 'Keep on failure' } });
    await fireEvent.keyDown(textarea, { key: 'Enter' });
    await view.findByText('Storage full');
    expect((textarea as HTMLTextAreaElement).value).toBe('Keep on failure');
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it('opens the mobile spaces drawer from a right swipe', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 760px)', addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const view = await openApp();
    const heading = view.getByRole('heading', { name: /^Inbox/ });
    await fireEvent.touchStart(heading, { touches: [{ clientX: 40, clientY: 100 }] });
    await fireEvent.touchMove(heading, { touches: [{ clientX: 150, clientY: 110 }] });
    const preview = view.container.querySelector<HTMLDialogElement>('[data-swipe-preview]')!;
    expect(preview.open).toBe(true);
    expect(preview.style.transform).toMatch(/translateX\(-\d/);
    expect(preview.getAttribute('aria-hidden')).toBe('true');
    await fireEvent.touchEnd(heading, { touches: [], changedTouches: [{ clientX: 150, clientY: 110 }] });
    expect(view.getByRole('dialog', { name: 'Your spaces' })).toBeTruthy();
  });
  it('shows every tag compactly and searches across spaces from the mobile drawer', async () => {
    state.memos = [
      { ...makeMemo('first'), tags: ['Shared', 'важное'] },
      { ...makeMemo('second'), spaceId: 'ideas', tags: ['shared', 'Idea'] },
    ];
    const view = await openApp();
    const cloud = view.getByRole('region', { name: 'All tags' });
    expect(cloud.querySelectorAll('button')).toHaveLength(3);
    await fireEvent.input(view.getByRole('combobox', { name: 'Search your wall' }), { target: { value: '#Shared' } });
    await fireEvent.click(view.getByRole('button', { name: 'Inbox' }));
    await fireEvent.click(view.getByRole('button', { name: 'Open spaces' }));
    const drawer = view.getByRole('dialog', { name: 'Your spaces' });
    await fireEvent.click(Array.from(drawer.querySelectorAll('button')).find((button) => button.textContent === '#Idea')!);
    expect(view.queryByRole('dialog')).toBeNull();
    expect((view.getByRole('combobox', { name: 'Search your wall' }) as HTMLInputElement).value).toBe('#Idea');
    await waitFor(() => expect(view.getAllByRole('article')).toHaveLength(1));
    expect(view.getByText('second')).toBeTruthy();
  });

  it('persists space ordering and its sync operations without switching the active space', async () => {
    const view = await openApp();
    const ideas = view.getByRole('button', { name: /^Ideas/ });
    ideas.focus();
    await fireEvent.keyDown(ideas, { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(state.putSpaces).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(Array.from(view.container.querySelectorAll('.space-button')).map((button) => button.textContent?.trim())).toEqual(['Ideas0', 'Inbox0']));
    expect(state.putSpaces.mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ space: expect.objectContaining({ id: 'ideas', position: 0, syncState: 'pending' }), operation: expect.objectContaining({ kind: 'upsert_space', entityId: 'ideas' }) }),
      expect.objectContaining({ space: expect.objectContaining({ id: 'inbox', position: 1, isInbox: true }), operation: expect.objectContaining({ kind: 'upsert_space', entityId: 'inbox' }) }),
    ]));
    expect(view.getByRole('heading', { name: /^Inbox/ })).toBeTruthy();
    expect(document.activeElement).toBe(ideas);
    view.unmount();
    const reopened = await openApp();
    expect(reopened.container.querySelector('.space-button')?.textContent).toContain('Ideas');
  });

  it('restores space order if saving fails', async () => {
    state.putSpaces.mockRejectedValueOnce(new Error('Storage full'));
    const view = await openApp();
    await fireEvent.keyDown(view.getByRole('button', { name: 'Reorder Ideas' }), { key: 'ArrowUp' });
    await view.findByText('Storage full');
    await waitFor(() => expect(view.container.querySelector('.space-button')?.textContent).toContain('Inbox'));
  });

  it('shows installation help, uses each available prompt once, and hides install after success', async () => {
    const view = await openApp();
    const install = () => view.getByRole('button', { name: 'Install Scratchwall' });
    await fireEvent.click(install());
    expect(view.getByRole('dialog', { name: 'Install Scratchwall' })).toBeTruthy();
    expect(view.getByText(/Open in Safari, tap Share/)).toBeTruthy();
    const prompt = vi.fn(async () => {});
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt, userChoice: Promise.resolve({ outcome: 'dismissed' }),
    });
    window.dispatchEvent(event);
    await tick();
    expect(event.defaultPrevented).toBe(true);
    await fireEvent.click(view.getByRole('button', { name: 'Install now' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole('button', { name: 'Close dialog' }));
    await fireEvent.click(install());
    expect(prompt).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('appinstalled'));
    await tick();
    expect(view.queryByRole('dialog', { name: 'Install Scratchwall' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Install Scratchwall' })).toBeNull();
  });

  it('toggles cards with short clicks in selection mode and with the keyboard', async () => {
    state.memos = [makeMemo('first'), makeMemo('second')];
    const view = await openApp();
    await fireEvent.keyDown(view.getAllByRole('article')[0], { key: ' ' });
    expect(view.getByText('1 selected')).toBeTruthy();
    await fireEvent.click(view.getByText('second'));
    expect(view.getByText('2 selected')).toBeTruthy();
    await fireEvent.click(view.getByText('first'));
    expect(view.getByText('1 selected')).toBeTruthy();
    expect((view.getAllByRole('checkbox', { name: 'Select memo' })[1] as HTMLInputElement).checked).toBe(true);
  });

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

  it('offers a bottom shortcut only when far enough above the end of the feed', async () => {
    state.memos = Array.from({ length: 10 }, (_, index) => makeMemo(`memo-${index}`));
    const view = await openApp();
    const feed = mockFeedLayout(view, 1550);
    await fireEvent.scroll(feed);
    expect(view.queryByRole('button', { name: 'Scroll to bottom' })).toBeNull();
    feed.scrollTop = 500;
    await fireEvent.scroll(feed);
    await fireEvent.click(view.getByRole('button', { name: 'Scroll to bottom' }));
    expect(feed.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'smooth' });
    feed.scrollTop = 1600;
    await fireEvent.scroll(feed);
    expect(view.queryByRole('button', { name: 'Scroll to bottom' })).toBeNull();
  });

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
    cacheState: 'remote' as const,
    remoteReady: true,
    createdAt: '2026-10-01',
  };
  it('browses across messages and unrendered older memos with keys and buttons, staying in the space', async () => {
    state.memos = Array.from({ length: 202 }, (_, index) => makeMemo(`memo-${index.toString().padStart(3, '0')}`));
    state.memos[0].attachmentIds = ['old'];
    state.memos[200].attachmentIds = ['photo', 'document', 'clip'];
    state.memos[201].attachmentIds = ['new'];
    state.memos.push({ ...makeMemo('other-space'), spaceId: 'ideas', attachmentIds: ['other'] });
    state.attachments = [
      makeAttachment('new', 'memo-201'), makeAttachment('other', 'other-space'),
      makeAttachment('clip', 'memo-200', 'application/mp4'),
      { ...makeAttachment('document', 'memo-200'), mimeType: 'application/pdf' },
      makeAttachment('photo', 'memo-200'), makeAttachment('old', 'memo-000'),
    ];
    vi.mocked(getAttachment).mockImplementation(async (id) => ({ ...state.attachments.find((item) => item.id === id)!, blob: new Blob([id]) }));
    const view = await openApp();
    expect(view.queryByRole('button', { name: 'Open old.png' })).toBeNull();
    const draft = view.getByRole('textbox', { name: 'Memo text' }) as HTMLTextAreaElement;
    await fireEvent.input(draft, { target: { value: 'Keep my draft' } });
    const opener = view.getByRole('button', { name: 'Open photo.png' });
    opener.focus();
    await fireEvent.click(opener);
    const dialog = await view.findByRole('dialog', { name: 'photo.png' });
    await view.findByText('2 / 4');
    await fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    await view.findByRole('img', { name: 'old.png' });
    expect(view.getByText('1 / 4')).toBeTruthy();
    expect((view.getByRole('button', { name: 'Previous photo or video' }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(view.getByRole('dialog', { name: 'old.png' })).toBe(dialog);
    await fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    await within(dialog).findByRole('img', { name: 'photo.png' });
    await fireEvent.click(view.getByRole('button', { name: 'Next photo or video' }));
    await waitFor(() => expect(dialog.querySelector('video')?.getAttribute('aria-label')).toBe('clip.mp4'));
    expect(view.getByText('3 / 4')).toBeTruthy();
    expect(view.getByRole('link', { name: 'Download' }).getAttribute('download')).toBe('clip.mp4');
    await fireEvent.keyDown(dialog.querySelector('video')!, { key: 'ArrowRight' });
    await view.findByText('4 / 4');
    expect((view.getByRole('button', { name: 'Next photo or video' }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(view.getByRole('dialog', { name: 'new.png' })).toBe(dialog);
    expect(downloadAttachment).not.toHaveBeenCalled();
    await fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(view.queryByRole('group', { name: 'Space gallery' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(draft.value).toBe('Keep my draft');
  });

  it('uses a global search result’s own space and includes media outside the search', async () => {
    state.memos = [
      { ...makeMemo('inbox-photo'), attachmentIds: ['inbox'] },
      { ...makeMemo('ideas-one'), spaceId: 'ideas', attachmentIds: ['before'] },
      { ...makeMemo('ideas-two'), body: 'Needle', spaceId: 'ideas', attachmentIds: ['match'] },
    ];
    state.attachments = [makeAttachment('inbox', 'inbox-photo'), makeAttachment('before', 'ideas-one'), makeAttachment('match', 'ideas-two')];
    vi.mocked(getAttachment).mockImplementation(async (id) => ({ ...state.attachments.find((item) => item.id === id)!, blob: new Blob([id]) }));
    const view = await openApp();
    await fireEvent.input(view.getByRole('combobox', { name: 'Search your wall' }), { target: { value: 'Needle' } });
    await fireEvent.click(await view.findByRole('button', { name: 'Open match.png' }));
    await view.findByText('2 / 2');
    await fireEvent.keyDown(document, { key: 'ArrowLeft' });
    await view.findByRole('dialog', { name: 'before.png' });
    expect(view.getByText('1 / 2')).toBeTruthy();
    expect((view.getByRole('button', { name: 'Previous photo or video' }) as HTMLButtonElement).disabled).toBe(true);
  });

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
    expect(view.queryByRole('group', { name: 'Space gallery' })).toBeNull();
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

  it('shows streamed progress in the viewer and supports cancelling and retrying the same file', async () => {
    vi.mocked(getAttachment).mockResolvedValue(undefined);
    let finishDownload!: (blob: Blob) => void;
    vi.mocked(downloadAttachment).mockImplementation((_attachment, options) => new Promise((resolve, reject) => {
      finishDownload = resolve;
      options?.onProgress?.(6);
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));
    const view = render(MediaPreview, { attachment, onclose: vi.fn(), oncached: vi.fn() });
    const progress = await view.findByRole('progressbar', { name: 'Download photo.png' });
    await waitFor(() => expect(progress.getAttribute('value')).toBe('6'));
    expect(progress.getAttribute('max')).toBe('12');
    expect(view.getByText('6 B / 12 B · 50%')).toBeTruthy();
    await fireEvent.click(view.getByRole('button', { name: 'Cancel download' }));
    expect((await view.findByRole('alert')).textContent).toContain('Download cancelled');
    expect(state.putAttachment).not.toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: 'Retry download' }));
    await waitFor(() => expect(downloadAttachment).toHaveBeenCalledTimes(2));
    finishDownload(new Blob(['download']));
    await view.findByRole('img', { name: 'photo.png' });
    expect(state.putAttachment).toHaveBeenCalledOnce();
  });

  it('can leave an unavailable file, clears playback errors, and ignores modified arrow shortcuts', async () => {
    const video = { ...attachment, id: 'clip', filename: 'clip.mp4', mimeType: 'video/mp4' };
    const photo = { ...attachment, id: 'last', filename: 'last.png' };
    vi.mocked(getAttachment).mockImplementation(async (id) => id === attachment.id ? undefined : { ...(id === video.id ? video : photo), blob: new Blob([id]) });
    vi.mocked(downloadAttachment).mockRejectedValue(new Error('File unavailable offline'));
    const view = render(MediaPreview, { attachment, gallery: [attachment, video, photo], onclose: vi.fn(), oncached: vi.fn() });
    await view.findByRole('alert');
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }])
      await fireEvent.keyDown(document, { key: 'ArrowRight', ...modifier });
    expect(view.getByRole('dialog', { name: 'photo.png' })).toBeTruthy();
    await fireEvent.keyDown(document, { key: 'ArrowRight' });
    await view.findByRole('link', { name: 'Download' });
    expect(view.queryByRole('alert')).toBeNull();
    await fireEvent.error(view.container.querySelector('video')!);
    expect(view.getByRole('alert').textContent).toContain('could not play');
    await fireEvent.keyDown(document, { key: 'ArrowRight' });
    await view.findByRole('img', { name: 'last.png' });
    expect(view.queryByRole('alert')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('ignores a late download after navigating and releases the current URL and keyboard listener on unmount', async () => {
    const next = { ...attachment, id: 'next', filename: 'next.png' };
    const blob = new Blob(['download']);
    let finishDownload!: (blob: Blob) => void;
    vi.mocked(getAttachment).mockImplementation(async (id) => id === attachment.id ? undefined : { ...next, blob });
    vi.mocked(downloadAttachment).mockImplementation(() => new Promise((resolve) => { finishDownload = resolve; }));
    const oncached = vi.fn();
    const view = render(MediaPreview, { attachment, gallery: [attachment, next], onclose: vi.fn(), oncached });
    await waitFor(() => expect(downloadAttachment).toHaveBeenCalledWith(attachment, expect.objectContaining({ signal: expect.any(AbortSignal) })));
    await fireEvent.keyDown(document, { key: 'ArrowRight' });
    const image = await view.findByRole('img', { name: 'next.png' });
    finishDownload(blob);
    await waitFor(() => expect(oncached).toHaveBeenCalledTimes(1));
    expect(state.putAttachment).toHaveBeenCalledWith({ ...attachment, cacheState: 'cached', remoteReady: true }, blob);
    expect(image.getAttribute('src')).toBe('blob:test');
    expect(view.getByRole('link', { name: 'Download' }).getAttribute('download')).toBe('next.png');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    const key = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    document.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
  });
});


describe('account embedding search', () => {
  const enable = () => vi.mocked(embeddingSettings).mockResolvedValue({ enabled: true, configured: true, pending: 0, running: 0, done: 3, failed: 0, total: 3, completeness: 100 });
  const hits = [
    { memoId: 'exact', score: .1, rankScore: .01, revision: 1 },
    { memoId: 'photo', score: .9, rankScore: .02, revision: 2 },
    { memoId: 'note', score: .6, rankScore: .03, revision: 3 },
  ];
  it('restores the account checkbox if disabling embeddings fails', async () => {
    enable();
    const view = await openApp();
    await waitFor(() => expect(embeddingSettings).toHaveBeenCalled());
    await fireEvent.click(view.getByRole('button', { name: /Settings & preferences/ }));
    const checkbox = await view.findByRole('checkbox', { name: /Enable embeddings/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(await view.findByText('Ready · 100% indexed')).toBeTruthy();
    expect(view.queryByRole('progressbar')).toBeNull();
    vi.mocked(embeddingSettings).mockRejectedValueOnce(new Error('Server unreachable'));
    await fireEvent.click(checkbox);
    await view.findByText('Server unreachable');
    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect(embeddingSettings).toHaveBeenLastCalledWith(false);
  });

  it('keeps exact hits under the Ordered threshold, then switches to semantic relevance without inference', async () => {
    enable();
    state.memos = [
      { ...makeMemo('exact'), body: 'cats', createdAt: '2026-01-01', bumpedAt: '2026-10-01' },
      { ...makeMemo('photo'), body: 'photo of a pet', createdAt: '2026-02-01' },
      { ...makeMemo('note'), body: 'a feline', createdAt: '2026-03-01' },
    ];
    vi.mocked(semanticSearch).mockResolvedValue({ available: true, hits });
    const view = await openApp();
    await fireEvent.input(view.getByRole('combobox', { name: 'Search your wall' }), { target: { value: 'cats' } });
    await fireEvent.click(await view.findByRole('button', { name: 'Smart' }));
    const region = view.getByRole('region', { name: 'Search results' });
    const ids = () => Array.from(region.querySelectorAll('article')).map(el => el.getAttribute('data-memo-id'));
    await waitFor(() => expect(ids()).toEqual(['exact', 'note', 'photo']));
    await fireEvent.input(view.getByRole('slider', { name: 'Similarity threshold' }), { target: { value: '0.8' } });
    await waitFor(() => expect(ids()).toEqual(['exact', 'photo']));
    const calls = vi.mocked(semanticSearch).mock.calls.length;
    await fireEvent.click(view.getByRole('button', { name: 'Relevant' }));
    await waitFor(() => expect(ids()).toEqual(['exact', 'note', 'photo']));
    expect(view.queryByRole('slider')).toBeNull();
    expect(semanticSearch).toHaveBeenCalledTimes(calls);
    await fireEvent.click(view.getByRole('button', { name: 'Vector only' }));
    await waitFor(() => expect(ids()).toEqual(['note', 'photo', 'exact']));
  });

  it('appends search pagination after the newest-first results', async () => {
    state.memos = Array.from({ length: 205 }, (_, i) => ({ ...makeMemo(`memo-${String(i).padStart(3, '0')}`), body: 'cats', createdAt: new Date(2026, 0, i + 1).toISOString() }));
    const view = await openApp();
    await fireEvent.input(view.getByRole('combobox', { name: 'Search your wall' }), { target: { value: 'cats' } });
    const region = view.getByRole('region', { name: 'Search results' });
    await waitFor(() => expect(region.querySelectorAll('article')).toHaveLength(200));
    const more = view.getByRole('button', { name: 'Show more results · 5 remaining' });
    expect(more.previousElementSibling?.getAttribute('data-memo-id')).toBe('memo-005');
    expect(region.querySelector('article')?.getAttribute('data-memo-id')).toBe('memo-204');
    await fireEvent.click(more);
    await waitFor(() => expect(region.querySelectorAll('article')).toHaveLength(205));
    expect(region.querySelector('article')?.getAttribute('data-memo-id')).toBe('memo-204');
  });

  it('omits video in both semantic modes and keeps Exact search unchanged', async () => {
    enable();
    state.memos = [{ ...makeMemo('clip'), body: 'cats', attachmentIds: ['video'] }, { ...makeMemo('photo'), body: 'cat photo' }];
    state.attachments = [makeAttachment('video', 'clip', 'application/mp4')];
    vi.mocked(semanticSearch).mockResolvedValue({ available: true, hits: [{ ...hits[1], memoId: 'clip' }, hits[1]] });
    const view = await openApp();
    await fireEvent.input(view.getByRole('combobox', { name: 'Search your wall' }), { target: { value: 'cats' } });
    await fireEvent.click(await view.findByRole('button', { name: 'Smart' }));
    const region = view.getByRole('region', { name: 'Search results' });
    await waitFor(() => expect(region.querySelectorAll('article')).toHaveLength(2));
    await fireEvent.click(view.getByRole('checkbox', { name: 'Omit video' }));
    await waitFor(() => expect(region.querySelectorAll('article')).toHaveLength(1));
    await waitFor(() => expect(semanticSearch).toHaveBeenLastCalledWith('cats', undefined, expect.any(AbortSignal), true));
    expect(region.querySelector('article')?.getAttribute('data-memo-id')).toBe('photo');
    await fireEvent.click(view.getByRole('button', { name: /^Exact$/ }));
    await waitFor(() => expect(region.querySelector('article')?.getAttribute('data-memo-id')).toBe('clip'));
    expect(view.queryByRole('checkbox', { name: 'Omit video' })).toBeNull();
  });

  it('keeps results and scroll still while index status changes, with explicit refresh available', async () => {
    enable(); state.memos = [{ ...makeMemo('photo'), body: 'a pet' }];
    vi.mocked(semanticSearch).mockResolvedValue({ available: true, hits: [hits[1]] });
    const view = await openApp();
    await fireEvent.input(view.getByRole('combobox', { name: 'Search your wall' }), { target: { value: 'cats' } });
    await fireEvent.click(await view.findByRole('button', { name: 'Vector only' }));
    const region = view.getByRole('region', { name: 'Search results' });
    await waitFor(() => expect(region.querySelectorAll('article')).toHaveLength(1));
    const calls = vi.mocked(semanticSearch).mock.calls.length;
    await tick();
    await new Promise(resolve => setTimeout(resolve, 20));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000);
    vi.mocked(embeddingSettings).mockResolvedValue({ enabled: true, configured: true, pending: 2, running: 1, done: 4, failed: 0, total: 7, completeness: 57.1 });
    vi.mocked(HTMLElement.prototype.scrollTo).mockClear();
    await fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(embeddingSettings).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(semanticSearch).toHaveBeenCalledTimes(calls);
    expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();
    expect(region.querySelectorAll('article')).toHaveLength(1);
    expect(view.queryByText(/Still indexing/)).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Refresh search results' }));
    await waitFor(() => expect(semanticSearch).toHaveBeenCalledTimes(calls + 1));
    clock.mockRestore();
  });

  it('shows an availability notice, preserves Smart exact hits and keeps tag search literal', async () => {
    enable(); state.memos = [{ ...makeMemo('one'), body: 'cats', tags: ['Pets'] }];
    vi.mocked(semanticSearch).mockResolvedValue({ available: false, hits: [] });
    const view = await openApp();
    const input = view.getByRole('combobox', { name: 'Search your wall' });
    await fireEvent.input(input, { target: { value: 'cats' } });
    await fireEvent.click(await view.findByRole('button', { name: 'Smart' }));
    await view.findByText('Semantic search is unavailable. Exact matches remain available in Smart.');
    const region = view.getByRole('region', { name: 'Search results' });
    expect(region.querySelectorAll('article')).toHaveLength(1);
    await fireEvent.click(view.getByRole('button', { name: 'Vector only' }));
    await waitFor(() => expect(region.querySelectorAll('article')).toHaveLength(0));
    await fireEvent.input(input, { target: { value: '#pets' } });
    await waitFor(() => expect(region.querySelectorAll('article')).toHaveLength(1));
    expect((view.getByRole('button', { name: 'Smart' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
