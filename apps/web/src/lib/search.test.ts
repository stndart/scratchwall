import { describe, expect, it } from 'vitest';
import { addSearchTag, buildSearchDocuments, isVisibleMemo, parseSearchQuery, searchTagFilters, SearchIndex, suggestSearchTags } from './search';
import type { Attachment, Memo, Space } from './types';

const space: Space = {
  id: 'space', name: 'Video Links', position: 0, isInbox: false,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', syncState: 'synced'
};

function memo(id: string, body: string, tags = ['WatchLater']): Memo {
  return {
    id, spaceId: space.id, body, tags, attachmentIds: ['attachment'],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', syncState: 'synced'
  };
}

describe('local substring search documents', () => {
  it('indexes complete URLs, filenames, tags, and space names case-insensitively', () => {
    const attachment: Attachment = {
      id: 'attachment', memoId: 'memo', filename: 'Quarterly NOTES.PDF', mimeType: 'application/pdf',
      size: 10, remoteReady: true, cacheState: 'remote', createdAt: '2026-01-01T00:00:00Z'
    };
    const [document] = buildSearchDocuments([space], [memo('memo', 'https://YouTube.com/watch?v=abc')], [attachment]);
    for (const query of ['yout', 'notes.pdf', 'watchlater', 'video links']) {
      expect(document.haystack).toContain(query);
    }
  });

  it('scans 50,000 short normalized documents within the release target', () => {
    const index = new SearchIndex();
    const documents = Array.from({ length: 50_000 }, (_, index) => memo(String(index), `memo ${index} https://youtube.test/${index}`));
    index.update([space], documents, []);
    const started = performance.now();
    const matches = index.search('yout');
    const elapsed = performance.now() - started;
    expect(matches).toHaveLength(50_000);
    expect(elapsed).toBeLessThan(100);
  });
  it('updates only changed documents and removes deleted documents', () => {
    const index = new SearchIndex();
    const first = memo('one', 'youtube');
    index.update([space], [first, memo('two', 'other')], []);
    const retained = index.documents.get('one');
    index.update([space], [first], []);
    expect(index.documents.get('one')).toBe(retained);
    expect(index.documents.has('two')).toBe(false);
    index.update([{ ...space, name: 'New Space' }], [first], []);
    expect(index.search('new space')).toEqual(['one']);
  });

  it('treats a #tag query as a tag prefix filter without matching the body', () => {
    const index = new SearchIndex();
    index.update(
      [space],
      [memo('tagged', 'unrelated body'), memo('mention', 'please watchlater this', [])],
      []
    );
    expect(parseSearchQuery('#WatchLater')).toEqual({ kind: 'tag', needle: 'watchlater' });
    expect(index.search('#WatchLater')).toEqual(['tagged']);
    expect(index.search('#watchlater')).toEqual(['tagged']);
    expect(index.search('#watch')).toEqual(['tagged']);
    expect(index.search('watchlater')).toEqual(['tagged', 'mention']);
    expect(index.search('#missing')).toEqual([]);
  });

  it('lists tagged memos for # and matches Unicode and normalized tag prefixes', () => {
    const index = new SearchIndex();
    index.update([space], [
      memo('scratch', 'irrelevant', ['Scratch']),
      memo('unicode', 'irrelevant', ['Важное']),
      memo('width', 'irrelevant', ['Ｓｃｒａｔｃｈpad']),
      memo('body', '#scratch #важное', []),
    ], []);
    expect(parseSearchQuery(' # ')).toEqual({ kind: 'tag', needle: '' });
    expect(index.search('#')).toEqual(['scratch', 'unicode', 'width']);
    expect(index.search(' #ScRa ')).toEqual(['scratch', 'width']);
    expect(index.search('#ВАЖ')).toEqual(['unicode']);
    expect(index.search('')).toEqual([]);
  });

  it('suggests matching tags once and respects the search scope', () => {
    const memos = [
      memo('one', 'irrelevant', ['Scratch', 'scratch', 'Other']),
      { ...memo('two', 'irrelevant', ['Scratchpad', 'Elsewhere']), spaceId: 'other' },
    ];
    expect(suggestSearchTags(memos, '#', space.id, true)).toEqual(['Elsewhere', 'Other', 'Scratch', 'Scratchpad']);
    expect(suggestSearchTags(memos, '#scra', space.id, true)).toEqual(['Scratch', 'Scratchpad']);
    expect(suggestSearchTags(memos, '#SCRA', space.id, false)).toEqual(['Scratch']);
    expect(suggestSearchTags(memos, '#missing', space.id, true)).toEqual([]);
    expect(suggestSearchTags(memos, 'scratch', space.id, true)).toEqual([]);
  });

  it('can keep search results inside the current space', () => {
    const inbox = { id: 'inbox', spaceId: 'inbox' };
    const other = { id: 'other', spaceId: 'other' };
    const hits = new Set(['inbox', 'other']);
    expect(isVisibleMemo(inbox, '', hits, 'inbox', true)).toBe(true);
    expect(isVisibleMemo(other, '', hits, 'inbox', true)).toBe(false);
    expect(isVisibleMemo(inbox, 'scratch', hits, 'inbox', true)).toBe(true);
    expect(isVisibleMemo(other, 'scratch', hits, 'inbox', true)).toBe(true);
    expect(isVisibleMemo(inbox, 'scratch', hits, 'inbox', false)).toBe(true);
    expect(isVisibleMemo(other, 'scratch', hits, 'inbox', false)).toBe(false);
    expect(isVisibleMemo(inbox, 'scratch', new Set(), 'inbox', true)).toBe(false);
  });

  it('requires every tag filter and preserves tag names containing spaces', () => {
    const index = new SearchIndex();
    index.update([space], [
      memo('both', 'unrelated', ['Reading list', 'Важное']),
      memo('one', 'unrelated', ['Reading list']),
      memo('body', '#reading list #важное', []),
    ], []);
    expect(searchTagFilters(' #Reading list #ВАЖ #reading list ')).toEqual(['Reading list', 'ВАЖ']);
    expect(index.search('#reading list #ВАЖ')).toEqual(['both']);
    expect(index.search('#reading list #missing')).toEqual([]);
  });

  it('completes the last partial filter and appends suggestions after a complete filter', () => {
    const known = ['Reading list', 'Important'];
    expect(addSearchTag('#read', 'Reading list', known)).toBe('#Reading list');
    expect(addSearchTag('#Reading list #imp', 'Important', known)).toBe('#Reading list #Important');
    expect(addSearchTag('#Reading list', 'Important', known)).toBe('#Reading list #Important');
    expect(addSearchTag('#new #', 'Important', known)).toBe('#new #Important');
    expect(addSearchTag('#Important', 'important', known)).toBe('#Important');
    expect(suggestSearchTags([memo('one', '', known)], '#Reading list', space.id, false)).toEqual(['Important']);
  });
});
