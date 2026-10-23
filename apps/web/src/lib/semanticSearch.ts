import type { Memo } from './types';
import { compareMemoOrder } from './memoActions';

export type SearchMode = 'exact' | 'smart' | 'vector';
export type SearchOrder = 'ordered' | 'relevant';
export interface EmbeddingSettings {
  enabled: boolean; configured: boolean;
  pending: number; running: number; done: number; failed: number;
  total: number; completeness: number;
}
export interface SemanticHit { memoId: string; score: number; rankScore: number; revision: number }
export interface SemanticResponse { available: boolean; hits: SemanticHit[]; notice?: string }
export const defaultEmbeddingSettings: EmbeddingSettings = { enabled: false, configured: false, pending: 0, running: 0, done: 0, failed: 0, total: 0, completeness: 0 };

export function searchResults(
  memos: Memo[], exact: Set<string>, hits: SemanticHit[], mode: SearchMode,
  order: SearchOrder, threshold: number,
): Memo[] {
  // Unsynced changes must not receive a stale semantic match from the server.
  const semantic = new Map(hits.filter(h => h.score >= threshold).map(h => [h.memoId, h]));
  const found = memos.filter(memo =>
    (mode !== 'vector' && exact.has(memo.id)) ||
    (mode !== 'exact' && memo.syncState === 'synced' && semantic.has(memo.id))
  );
  if (order === 'ordered' || mode === 'exact') return found.sort((a, b) => compareMemoOrder(b, a));
  const score = (memo: Memo) => (mode === 'smart' && exact.has(memo.id) ? 1 : 0) +
    (memo.syncState === 'synced' ? semantic.get(memo.id)?.rankScore ?? 0 : 0);
  return found.sort((a, b) => score(b) - score(a) || compareMemoOrder(b, a));
}
