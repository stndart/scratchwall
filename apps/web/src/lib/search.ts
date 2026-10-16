import type { Attachment, Memo, SearchDocument, Space } from './types';
import { normalize, normalizeTags, searchableText } from './tags';

export function parseSearchQuery(query: string): { kind: 'text' | 'tag'; needle: string } {
  const trimmed = query.trim();
  if (trimmed.startsWith('#')) return { kind: 'tag', needle: normalize(trimmed.slice(1)) };
  return { kind: 'text', needle: searchableText([trimmed]).trim() };
}

// A space followed by # starts another filter; spaces within tag names stay intact.
export function searchTagFilters(query: string): string[] {
  return query.trim().startsWith('#')
    ? normalizeTags(query.trim().slice(1).split(/\s+#/u))
    : [];
}

export function addSearchTag(query: string, tag: string, knownTags: string[]): string {
  const tags = searchTagFilters(query);
  const last = tags.at(-1);
  if (last && !/\s+#\s*$/u.test(query) && !knownTags.some((known) => normalize(known) === normalize(last))) tags.pop();
  return normalizeTags([...tags, tag]).map((value) => `#${value}`).join(' ');
}

export function suggestSearchTags(
  memos: Memo[],
  query: string,
  selectedSpace: string,
  searchAllSpaces: boolean
): string[] {
  const parsed = parseSearchQuery(query);
  if (parsed.kind !== 'tag') return [];
  const tags = searchTagFilters(query);
  const available = normalizeTags(
    memos.filter((memo) => searchAllSpaces || memo.spaceId === selectedSpace).flatMap((memo) => memo.tags)
  );
  const last = /\s+#\s*$/u.test(query) ? '' : tags.at(-1) ?? '';
  const complete = available.some((tag) => normalize(tag) === normalize(last));
  return available.filter((tag) =>
    !tags.some((selected) => normalize(selected) === normalize(tag)) &&
    (complete || normalize(tag).startsWith(normalize(last)))
  )
    .sort((a, b) => a.localeCompare(b));
}

function documentFrom(memo: Memo, spaceName: string | undefined, filenames: string[]): SearchDocument {
  return {
    id: memo.id,
    spaceId: memo.spaceId,
    tags: memo.tags.map((tag) => normalize(tag)),
    haystack: searchableText([memo.body, memo.tags.join(' '), spaceName, ...filenames])
  };
}

export class SearchIndex {
  private signatures = new Map<string, string>();
  readonly documents = new Map<string, SearchDocument>();

  update(spaces: Space[], memos: Memo[], attachments: Attachment[]) {
    const names = new Map(spaces.map((space) => [space.id, space.name]));
    const files = new Map<string, string[]>();
    for (const file of attachments) {
      const values = files.get(file.memoId) ?? [];
      values.push(file.filename);
      files.set(file.memoId, values);
    }
    const alive = new Set<string>();
    for (const memo of memos) {
      alive.add(memo.id);
      const filenames = files.get(memo.id) ?? [];
      const signature = JSON.stringify([memo.spaceId, memo.body, memo.tags, names.get(memo.spaceId), filenames]);
      if (this.signatures.get(memo.id) === signature) continue;
      this.signatures.set(memo.id, signature);
      this.documents.set(memo.id, documentFrom(memo, names.get(memo.spaceId), filenames));
    }
    for (const id of this.documents.keys()) {
      if (!alive.has(id)) { this.documents.delete(id); this.signatures.delete(id); }
    }
  }

  search(query: string): string[] {
    const parsed = parseSearchQuery(query);
    const filters = searchTagFilters(query).map(normalize);
    if (parsed.kind === 'text' && !parsed.needle) return [];
    const ids: string[] = [];
    for (const document of this.documents.values()) {
      const hit = parsed.kind === 'tag'
        ? (filters.length ? filters : ['']).every((filter) => document.tags.some((tag) => tag.startsWith(filter)))
        : document.haystack.includes(parsed.needle);
      if (hit) ids.push(document.id);
    }
    return ids;
  }
}

export function buildSearchDocuments(spaces: Space[], memos: Memo[], attachments: Attachment[]): SearchDocument[] {
  const spaceNames = new Map(spaces.map((space) => [space.id, space.name]));
  const attachmentNames = new Map<string, string[]>();
  for (const attachment of attachments) {
    const values = attachmentNames.get(attachment.memoId) ?? [];
    values.push(attachment.filename);
    attachmentNames.set(attachment.memoId, values);
  }
  return memos.map((memo) => documentFrom(memo, spaceNames.get(memo.spaceId), attachmentNames.get(memo.id) ?? []));
}

export function isVisibleMemo(
  memo: Pick<Memo, 'id' | 'spaceId'>,
  query: string,
  resultIds: Set<string>,
  selectedSpace: string,
  searchAllSpaces: boolean
): boolean {
  if (!query.trim()) return memo.spaceId === selectedSpace;
  if (!resultIds.has(memo.id)) return false;
  return searchAllSpaces || memo.spaceId === selectedSpace;
}
