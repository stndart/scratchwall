import type { Attachment, Memo, Space } from './types';
import { SearchIndex } from './search';

const index = new SearchIndex();

self.onmessage = (event: MessageEvent<{ type: string; spaces?: Space[]; memos?: Memo[]; attachments?: Attachment[]; query?: string }>) => {
  const message = event.data;
  if (message.type === 'update') {
    index.update(message.spaces ?? [], message.memos ?? [], message.attachments ?? []);
    self.postMessage({ type: 'ready', count: index.documents.size });
  } else if (message.type === 'query') {
    const ids = index.search(message.query ?? '');
    self.postMessage({ type: 'results', query: message.query, ids });
  }
};
