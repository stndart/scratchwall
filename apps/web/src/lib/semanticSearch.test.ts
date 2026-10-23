import { describe, expect, it } from 'vitest';
import { searchResults, type SemanticHit } from './semanticSearch';
import type { Memo } from './types';

const memo = (id: string, createdAt: string, bumpedAt?: string): Memo => ({
  id, spaceId: 'inbox', body: '', tags: [], attachmentIds: [], createdAt, bumpedAt,
  updatedAt: createdAt, syncState: 'synced',
});
const memos = [memo('exact', '2026-01-01', '2026-10-01'), memo('visual', '2026-02-01'), memo('text', '2026-03-01')];
const hits: SemanticHit[] = [
  { memoId: 'exact', score: .1, rankScore: .01, revision: 1 },
  { memoId: 'visual', score: .9, rankScore: .02, revision: 2 },
  { memoId: 'text', score: .6, rankScore: .03, revision: 3 },
];
const ids = (results: Memo[]) => results.map(m => m.id);
describe('semantic membership and independent ordering', () => {
  it('preserves exact results and bumped ordering even at threshold 1', () => {
    expect(ids(searchResults(memos, new Set(['exact', 'visual']), hits, 'exact', 'relevant', 1))).toEqual(['exact', 'visual']);
  });
  it('keeps Smart exact matches regardless of threshold and orders by bump time', () => {
    expect(ids(searchResults(memos, new Set(['exact']), hits, 'smart', 'ordered', .7))).toEqual(['exact', 'visual']);
    expect(ids(searchResults(memos, new Set(['exact']), hits, 'smart', 'ordered', 1))).toEqual(['exact']);
  });
  it('ranks Smart exact hits first and remaining hits by fused embedding ranks', () => {
    expect(ids(searchResults(memos, new Set(['exact']), hits, 'smart', 'relevant', 0))).toEqual(['exact', 'text', 'visual']);
  });
  it('uses only semantic membership in Vector only and treats the threshold inclusively', () => {
    expect(ids(searchResults(memos, new Set(['exact']), hits, 'vector', 'ordered', .6))).toEqual(['text', 'visual']);
    expect(ids(searchResults(memos, new Set(['exact']), hits, 'vector', 'relevant', 0))).toEqual(['text', 'visual', 'exact']);
  });
  it('excludes stale semantic results for local edits but retains local exact matches', () => {
    const edited = memos.map(m => ({ ...m, syncState: 'pending' as const }));
    expect(searchResults(edited, new Set(['exact']), hits, 'vector', 'relevant', 0)).toEqual([]);
    expect(ids(searchResults(edited, new Set(['exact']), hits, 'smart', 'relevant', 0))).toEqual(['exact']);
  });
});
