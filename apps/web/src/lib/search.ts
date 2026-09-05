import type { Attachment, Memo, SearchDocument, Space } from './types';
import { searchableText } from './tags';

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
      const fields = [memo.body, memo.tags.join(' '), names.get(memo.spaceId), ...(files.get(memo.id) ?? [])];
      const signature = JSON.stringify([memo.spaceId, fields]);
      if (this.signatures.get(memo.id) === signature) continue;
      this.signatures.set(memo.id, signature);
      this.documents.set(memo.id, { id: memo.id, spaceId: memo.spaceId, haystack: searchableText(fields) });
    }
    for (const id of this.documents.keys()) {
      if (!alive.has(id)) { this.documents.delete(id); this.signatures.delete(id); }
    }
  }

  search(query: string): string[] {
    const needle = searchableText([query]).trim();
    const ids: string[] = [];
    for (const document of this.documents.values()) if (document.haystack.includes(needle)) ids.push(document.id);
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
  return memos.map((memo) => ({
    id: memo.id,
    spaceId: memo.spaceId,
    haystack: searchableText([
      memo.body,
      memo.tags.join(' '),
      spaceNames.get(memo.spaceId),
      ...(attachmentNames.get(memo.id) ?? [])
    ])
  }));
}
