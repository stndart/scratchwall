import type { Attachment, Memo, SearchDocument, Space } from './types';
import { normalize, searchableText } from './tags';

const TAG_QUERY = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)$/u;

export function parseSearchQuery(query: string): { kind: 'text' | 'tag'; needle: string } {
  const trimmed = query.trim();
  const tag = trimmed.match(TAG_QUERY);
  if (tag) return { kind: 'tag', needle: normalize(tag[1]) };
  return { kind: 'text', needle: searchableText([trimmed]).trim() };
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
    if (!parsed.needle) return [];
    const ids: string[] = [];
    for (const document of this.documents.values()) {
      const hit = parsed.kind === 'tag'
        ? document.tags.includes(parsed.needle)
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
