import { describe, expect, it } from 'vitest';
import { buildSearchDocuments, isVisibleMemo, parseSearchQuery, SearchIndex } from './search';
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

  it('treats a bare #tag query as an exact tag filter, not a body substring', () => {
    const index = new SearchIndex();
    index.update(
      [space],
      [memo('tagged', 'unrelated body'), memo('mention', 'please watchlater this', [])],
      []
    );
    expect(parseSearchQuery('#WatchLater')).toEqual({ kind: 'tag', needle: 'watchlater' });
    expect(index.search('#WatchLater')).toEqual(['tagged']);
    expect(index.search('#watchlater')).toEqual(['tagged']);
    expect(index.search('watchlater')).toEqual(['tagged', 'mention']);
    expect(index.search('#missing')).toEqual([]);
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
});
