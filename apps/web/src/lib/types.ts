export type SyncState = 'synced' | 'pending' | 'error';

export interface Space {
  id: string;
  name: string;
  position: number;
  isInbox: boolean;
  createdAt: string;
  updatedAt: string;
  syncState: SyncState;
}

export interface Memo {
  id: string;
  spaceId: string;
  body: string;
  tags: string[];
  attachmentIds: string[];
  createdAt: string;
  bumpedAt?: string;
  updatedAt: string;
  syncState: SyncState;
}

export interface Attachment {
  id: string;
  memoId: string;
  filename: string;
  mimeType: string;
  size: number;
  thumbnail?: string;
  remoteReady: boolean;
  cacheState: 'local' | 'cached' | 'remote' | 'error';
  createdAt: string;
}

export type OperationKind =
  | 'upsert_space'
  | 'delete_space'
  | 'upsert_memo'
  | 'delete_memo';

export interface PendingOperation {
  id: string;
  kind: OperationKind;
  entityId: string;
  payload?: Space | Memo;
  createdAt: string;
  attempts: number;
  error?: string;
}

export interface ServerChange {
  seq: number;
  entityType: 'space' | 'memo' | 'attachment';
  entityId: string;
  operation: 'upsert' | 'delete';
  payload?: Space | Memo | Attachment;
}

export interface SyncRequest {
  cursor: number;
  operations: PendingOperation[];
  limit?: number;
}

export interface SyncResponse {
  cursor: number;
  hasMore: boolean;
  acknowledged: string[];
  rejected: Array<{ id: string; reason: string }>;
  changes: ServerChange[];
}

export interface Profile {
  subject: string;
  displayName: string;
  groups: string[];
}

export interface SearchDocument {
  id: string;
  spaceId: string;
  tags: string[];
  haystack: string;
}
