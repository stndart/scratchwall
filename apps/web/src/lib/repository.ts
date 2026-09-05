import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Attachment, Memo, PendingOperation, Profile, ServerChange, Space } from './types';
import { isNative } from './nativeAuth';
import type Database from '@tauri-apps/plugin-sql';

interface ScratchwallDb extends DBSchema {
  spaces: { key: string; value: Space; indexes: { position: number } };
  memos: { key: string; value: Memo; indexes: { spaceId: string; createdAt: string } };
  attachments: { key: string; value: Attachment & { blob?: Blob }; indexes: { memoId: string } };
  operations: { key: string; value: PendingOperation; indexes: { createdAt: string } };
  meta: { key: string; value: unknown };
}

let database: Promise<IDBPDatabase<ScratchwallDb>> | undefined;
let nativeDatabasePromise: Promise<Database> | undefined;
const NATIVE_ATTACHMENT_DIR = 'attachments';

type Statement = { sql: string; values: unknown[] };
async function nativeTransaction(statements: Statement[]) {
  await nativeDatabase();
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('local_transaction', { statements });
}
function operationStatement(operation?: PendingOperation): Statement[] {
  return operation ? [{ sql: 'INSERT OR REPLACE INTO operations(id,value_json,created_at) VALUES($1,$2,$3)', values: [operation.id, JSON.stringify(operation), operation.createdAt] }] : [];
}

function safeFilename(filename: string) {
  return filename.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/[. ]+$/u, '').slice(-150) || 'attachment';
}

async function writeNativeBlob(id: string, blob: Blob, filename: string): Promise<string> {
  const { BaseDirectory, mkdir, open } = await import('@tauri-apps/plugin-fs');
  const directory = `${NATIVE_ATTACHMENT_DIR}/${id}`;
  await mkdir(directory, { baseDir: BaseDirectory.AppData, recursive: true });
  const path = `${directory}/${safeFilename(filename)}`;
  const file = await open(path, { baseDir: BaseDirectory.AppData, create: true, truncate: true, write: true });
  try {
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
      await file.write(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
    }
  } finally { await file.close(); }
  return path;
}

export async function cacheNativeStream(attachment: Attachment, stream: ReadableStream<Uint8Array>) {
  const { BaseDirectory, mkdir, open, remove } = await import('@tauri-apps/plugin-fs');
  const filename = safeFilename(attachment.filename);
  const directory = `${NATIVE_ATTACHMENT_DIR}/${attachment.id}`;
  await mkdir(directory, { baseDir: BaseDirectory.AppData, recursive: true });
  const path = `${directory}/${filename}`;
  const file = await open(path, { baseDir: BaseDirectory.AppData, create: true, truncate: true, write: true });
  const reader = stream.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > attachment.size) throw new Error('Downloaded file exceeds its declared size');
      await file.write(value);
    }
    if (size !== attachment.size) throw new Error('Downloaded file is incomplete');
  } catch (error) {
    await file.close();
    await remove(path, { baseDir: BaseDirectory.AppData });
    throw error;
  } finally { reader.releaseLock(); }
  await file.close();
  await (await nativeDatabase()).execute('UPDATE attachments SET value_json=$1,blob_path=$2 WHERE id=$3', [JSON.stringify({ ...attachment, remoteReady: true, cacheState: 'cached' }), path, attachment.id]);
}

export async function openNativeAttachment(id: string) {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_attachment', { id });
}

async function readNativeBlob(path: string): Promise<Blob | undefined> {
  const { BaseDirectory, readFile } = await import('@tauri-apps/plugin-fs');
  try {
    const bytes = await readFile(path, { baseDir: BaseDirectory.AppData });
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Blob([copy.buffer]);
  } catch {
    return undefined;
  }
}

async function removeNativeBlob(path: string | null | undefined) {
  if (!path) return;
  const { BaseDirectory, remove } = await import('@tauri-apps/plugin-fs');
  try { await remove(path, { baseDir: BaseDirectory.AppData }); } catch { /* already absent */ }
}

async function nativeAttachmentPaths(where = '', parameters: unknown[] = []): Promise<string[]> {
  const rows = await (await nativeDatabase()).select<Array<{ blob_path: string | null }>>(`SELECT blob_path FROM attachments${where}`, parameters);
  return rows.map((row) => row.blob_path).filter((path): path is string => Boolean(path));
}

async function nativeDatabase(): Promise<Database> {
  nativeDatabasePromise ??= import('@tauri-apps/plugin-sql').then(({ default: Database }) => Database.load('sqlite:scratchwall.sqlite'));
  return nativeDatabasePromise;
}

async function nativeRows<T>(table: string, order = ''): Promise<T[]> {
  const rows = await (await nativeDatabase()).select<Array<{ value_json: string }>>(`SELECT value_json FROM ${table}${order}`);
  return rows.map((row) => JSON.parse(row.value_json) as T);
}

async function nativePutOperation(operation?: PendingOperation) {
  if (!operation) return;
  await (await nativeDatabase()).execute('INSERT OR REPLACE INTO operations(id,value_json,created_at) VALUES($1,$2,$3)', [operation.id, JSON.stringify(operation), operation.createdAt]);
}

function db(): Promise<IDBPDatabase<ScratchwallDb>> {
  database ??= openDB<ScratchwallDb>('scratchwall-v1', 1, {
    upgrade(store) {
      const spaces = store.createObjectStore('spaces', { keyPath: 'id' });
      spaces.createIndex('position', 'position');
      const memos = store.createObjectStore('memos', { keyPath: 'id' });
      memos.createIndex('spaceId', 'spaceId');
      memos.createIndex('createdAt', 'createdAt');
      const attachments = store.createObjectStore('attachments', { keyPath: 'id' });
      attachments.createIndex('memoId', 'memoId');
      const operations = store.createObjectStore('operations', { keyPath: 'id' });
      operations.createIndex('createdAt', 'createdAt');
      store.createObjectStore('meta');
    }
  });
  return database;
}

export async function getSnapshot() {
  if (isNative()) {
    const [spaces, memos, attachments] = await Promise.all([
      nativeRows<Space>('spaces', ' ORDER BY position'),
      nativeRows<Memo>('memos', ' ORDER BY created_at'),
      nativeRows<Attachment>('attachments')
    ]);
    return { spaces, memos, attachments };
  }
  const store = await db();
  const [spaces, memos, attachments] = await Promise.all([
    store.getAllFromIndex('spaces', 'position'),
    store.getAllFromIndex('memos', 'createdAt'),
    store.getAll('attachments')
  ]);
  return { spaces, memos, attachments };
}

export async function putSpace(space: Space, operation?: PendingOperation) {
  if (isNative()) {
    await nativeTransaction([{ sql: 'INSERT OR REPLACE INTO spaces(id,value_json,position) VALUES($1,$2,$3)', values: [space.id, JSON.stringify(space), space.position] }, ...operationStatement(operation)]);
    return;
  }
  const transaction = (await db()).transaction(['spaces', 'operations'], 'readwrite');
  await transaction.objectStore('spaces').put(space);
  if (operation) await transaction.objectStore('operations').put(operation);
  await transaction.done;
}

export async function putMemo(memo: Memo, operation?: PendingOperation) {
  if (isNative()) {
    await nativeTransaction([{ sql: 'INSERT OR REPLACE INTO memos(id,value_json,space_id,created_at) VALUES($1,$2,$3,$4)', values: [memo.id, JSON.stringify(memo), memo.spaceId, memo.createdAt] }, ...operationStatement(operation)]);
    return;
  }
  const transaction = (await db()).transaction(['memos', 'operations'], 'readwrite');
  await transaction.objectStore('memos').put(memo);
  if (operation) await transaction.objectStore('operations').put(operation);
  await transaction.done;
}

export async function putAttachment(attachment: Attachment, blob?: Blob) {
  if (isNative()) {
    const blobPath = blob ? await writeNativeBlob(attachment.id, blob, attachment.filename) : null;
    try {
      await (await nativeDatabase()).execute('INSERT OR REPLACE INTO attachments(id,value_json,memo_id,blob_path) VALUES($1,$2,$3,COALESCE($4,(SELECT blob_path FROM attachments WHERE id=$1)))', [attachment.id, JSON.stringify(attachment), attachment.memoId, blobPath]);
    } catch (error) {
      if (blobPath) await removeNativeBlob(blobPath);
      throw error;
    }
    return;
  }
  const transaction = (await db()).transaction('attachments', 'readwrite');
  const previous = await transaction.store.get(attachment.id);
  await transaction.store.put({ ...attachment, blob: blob ?? previous?.blob });
  await transaction.done;
}

export async function attachmentSource(id: string): Promise<{ size: number; slice: (start: number, end: number) => Promise<Blob> } | undefined> {
  if (!isNative()) {
    const value = await getAttachment(id);
    return value?.blob ? { size: value.blob.size, slice: async (start, end) => value.blob!.slice(start, end) } : undefined;
  }
  const rows = await (await nativeDatabase()).select<Array<{ value_json: string; blob_path: string | null }>>('SELECT value_json,blob_path FROM attachments WHERE id=$1', [id]);
  const path = rows[0]?.blob_path;
  if (!path) return undefined;
  return {
    size: (JSON.parse(rows[0].value_json) as Attachment).size,
    slice: async (start, end) => {
      const { BaseDirectory, open, SeekMode } = await import('@tauri-apps/plugin-fs');
      const file = await open(path, { baseDir: BaseDirectory.AppData, read: true });
      try {
        await file.seek(start, SeekMode.Start);
        const buffer = new Uint8Array(end - start);
        let offset = 0;
        while (offset < buffer.length) {
          const count = await file.read(buffer.subarray(offset));
          if (!count) throw new Error('Local attachment is incomplete');
          offset += count;
        }
        return new Blob([buffer.buffer]);
      } finally { await file.close(); }
    }
  };
}

export async function getAttachment(id: string) {
  if (isNative()) {
    const rows = await (await nativeDatabase()).select<Array<{ value_json: string; blob_path: string | null }>>('SELECT value_json,blob_path FROM attachments WHERE id=$1', [id]);
    if (!rows[0]) return undefined;
    const value = JSON.parse(rows[0].value_json) as Attachment;
    return { ...value, blob: rows[0].blob_path ? await readNativeBlob(rows[0].blob_path) : undefined };
  }
  return (await db()).get('attachments', id);
}

export async function deleteMemoLocal(id: string, operation: PendingOperation) {
  if (isNative()) {
    const paths = await nativeAttachmentPaths(' WHERE memo_id=$1', [id]);
    await nativeTransaction([
      { sql: 'DELETE FROM attachments WHERE memo_id=$1', values: [id] },
      { sql: 'DELETE FROM memos WHERE id=$1', values: [id] }, ...operationStatement(operation)
    ]);
    await Promise.all(paths.map(removeNativeBlob));
    return;
  }
  const store = await db();
  const attachmentIds = (await store.getAllFromIndex('attachments', 'memoId', id)).map((item) => item.id);
  const transaction = store.transaction(['memos', 'attachments', 'operations'], 'readwrite');
  await transaction.objectStore('memos').delete(id);
  await Promise.all(attachmentIds.map((attachmentId) => transaction.objectStore('attachments').delete(attachmentId)));
  await transaction.objectStore('operations').put(operation);
  await transaction.done;
}

export async function deleteSpaceLocal(id: string, operation: PendingOperation) {
  if (isNative()) {
    const paths = await nativeAttachmentPaths(' WHERE memo_id IN (SELECT id FROM memos WHERE space_id=$1)', [id]);
    await nativeTransaction([
      { sql: 'DELETE FROM attachments WHERE memo_id IN (SELECT id FROM memos WHERE space_id=$1)', values: [id] },
      { sql: 'DELETE FROM memos WHERE space_id=$1', values: [id] },
      { sql: 'DELETE FROM spaces WHERE id=$1', values: [id] }, ...operationStatement(operation)
    ]);
    await Promise.all(paths.map(removeNativeBlob));
    return;
  }
  const store = await db();
  const memos = await store.getAllFromIndex('memos', 'spaceId', id);
  const memoIds = new Set(memos.map((memo) => memo.id));
  const attachments = (await store.getAll('attachments')).filter((item) => memoIds.has(item.memoId));
  const transaction = store.transaction(['spaces', 'memos', 'attachments', 'operations'], 'readwrite');
  await transaction.objectStore('spaces').delete(id);
  await Promise.all(memos.map((memo) => transaction.objectStore('memos').delete(memo.id)));
  await Promise.all(attachments.map((item) => transaction.objectStore('attachments').delete(item.id)));
  await transaction.objectStore('operations').put(operation);
  await transaction.done;
}

export async function pendingOperations(): Promise<PendingOperation[]> {
  if (isNative()) return nativeRows<PendingOperation>('operations', ' ORDER BY created_at');
  return (await db()).getAllFromIndex('operations', 'createdAt');
}

export async function rejectOperation(id: string, error: string) {
  if (isNative()) {
    const native = await nativeDatabase();
    const rows = await native.select<Array<{ value_json: string }>>('SELECT value_json FROM operations WHERE id=$1', [id]);
    if (rows[0]) {
      const operation = JSON.parse(rows[0].value_json) as PendingOperation;
      const statements: Statement[] = [{ sql: 'DELETE FROM operations WHERE id=$1', values: [id] }];
      if (operation.kind === 'upsert_memo') statements.push({ sql: "UPDATE memos SET value_json=json_set(value_json,'$.syncState','error') WHERE id=$1", values: [operation.entityId] });
      if (operation.kind === 'upsert_space') statements.push({ sql: "UPDATE spaces SET value_json=json_set(value_json,'$.syncState','error') WHERE id=$1", values: [operation.entityId] });
      await nativeTransaction(statements);
    }
    return;
  }
  const store = await db();
  const transaction = store.transaction(['operations', 'spaces', 'memos'], 'readwrite');
  const operation = await transaction.objectStore('operations').get(id);
  if (operation) {
    await transaction.objectStore('operations').delete(id);
    if (operation.kind === 'upsert_memo') {
      const memo = await transaction.objectStore('memos').get(operation.entityId);
      if (memo) await transaction.objectStore('memos').put({ ...memo, syncState: 'error' });
    }
    if (operation.kind === 'upsert_space') {
      const space = await transaction.objectStore('spaces').get(operation.entityId);
      if (space) await transaction.objectStore('spaces').put({ ...space, syncState: 'error' });
    }
  }
  await transaction.done;
}

export async function applyServerChanges(changes: ServerChange[], acknowledged: string[], cursor: number) {
  if (isNative()) {
    const statements: Statement[] = [];
    const pathsToRemove = new Set<string>();
    const native = { execute: async (sql: string, values: unknown[]) => { statements.push({ sql, values }); } };
    for (const id of acknowledged) await native.execute('DELETE FROM operations WHERE id=$1', [id]);
    for (const change of changes) {
      if (change.operation === 'delete') {
        if (change.entityType === 'space') {
          await native.execute("DELETE FROM operations WHERE json_extract(value_json,'$.payload.spaceId')=$1 OR json_extract(value_json,'$.entityId') IN (SELECT id FROM memos WHERE space_id=$1)", [change.entityId]);
        }
        await native.execute("DELETE FROM operations WHERE json_extract(value_json,'$.entityId')=$1", [change.entityId]);
      }
      if (change.entityType === 'space') {
        if (change.operation === 'delete') {
          const paths = await nativeAttachmentPaths(' WHERE memo_id IN (SELECT id FROM memos WHERE space_id=$1)', [change.entityId]);
          paths.forEach((path) => pathsToRemove.add(path));
          await native.execute('DELETE FROM attachments WHERE memo_id IN (SELECT id FROM memos WHERE space_id=$1)', [change.entityId]);
          await native.execute('DELETE FROM memos WHERE space_id=$1', [change.entityId]);
          await native.execute('DELETE FROM spaces WHERE id=$1', [change.entityId]);
        } else {
          const value = { ...(change.payload as Space), syncState: 'synced' };
          await native.execute('INSERT OR REPLACE INTO spaces(id,value_json,position) VALUES($1,$2,$3)', [value.id, JSON.stringify(value), value.position]);
        }
      } else if (change.entityType === 'memo') {
        if (change.operation === 'delete') {
          const paths = await nativeAttachmentPaths(' WHERE memo_id=$1', [change.entityId]);
          paths.forEach((path) => pathsToRemove.add(path));
          await native.execute('DELETE FROM attachments WHERE memo_id=$1', [change.entityId]);
          await native.execute('DELETE FROM memos WHERE id=$1', [change.entityId]);
        } else {
          const value = { ...(change.payload as Memo), syncState: 'synced' };
          await native.execute('INSERT OR REPLACE INTO memos(id,value_json,space_id,created_at) VALUES($1,$2,$3,$4)', [value.id, JSON.stringify(value), value.spaceId, value.createdAt]);
        }
      } else if (change.entityType === 'attachment') {
        if (change.operation === 'delete') {
          const paths = await nativeAttachmentPaths(' WHERE id=$1', [change.entityId]);
          paths.forEach((path) => pathsToRemove.add(path));
          await native.execute('DELETE FROM attachments WHERE id=$1', [change.entityId]);
        }
        else {
          const rows = await (await nativeDatabase()).select<Array<{ blob_path: string | null }>>('SELECT blob_path FROM attachments WHERE id=$1', [change.entityId]);
          const value = { ...(change.payload as Attachment) };
          if (rows[0]?.blob_path) value.cacheState = 'cached';
          await native.execute('INSERT OR REPLACE INTO attachments(id,value_json,memo_id,blob_path) VALUES($1,$2,$3,(SELECT blob_path FROM attachments WHERE id=$1))', [value.id, JSON.stringify(value), value.memoId]);
        }
      }
    }
    // Keep mutations captured after the request was sent on top of pulled changes.
    await native.execute("INSERT OR REPLACE INTO spaces(id,value_json,position) SELECT json_extract(value_json,'$.entityId'),json_extract(value_json,'$.payload'),json_extract(value_json,'$.payload.position') FROM operations WHERE json_extract(value_json,'$.kind')='upsert_space' ORDER BY created_at,id", []);
    await native.execute("INSERT OR REPLACE INTO memos(id,value_json,space_id,created_at) SELECT json_extract(value_json,'$.entityId'),json_extract(value_json,'$.payload'),json_extract(value_json,'$.payload.spaceId'),json_extract(value_json,'$.payload.createdAt') FROM operations WHERE json_extract(value_json,'$.kind')='upsert_memo' ORDER BY created_at,id", []);
    await native.execute("DELETE FROM memos WHERE id IN (SELECT json_extract(value_json,'$.entityId') FROM operations WHERE json_extract(value_json,'$.kind')='delete_memo') OR space_id IN (SELECT json_extract(value_json,'$.entityId') FROM operations WHERE json_extract(value_json,'$.kind')='delete_space')", []);
    await native.execute("DELETE FROM spaces WHERE id IN (SELECT json_extract(value_json,'$.entityId') FROM operations WHERE json_extract(value_json,'$.kind')='delete_space')", []);
    await native.execute('INSERT OR REPLACE INTO meta(key,value_json) VALUES(\'cursor\',$1)', [JSON.stringify(cursor)]);
    await nativeTransaction(statements);
    await Promise.all([...pathsToRemove].map(removeNativeBlob));
    return;
  }
  const transaction = (await db()).transaction(['spaces', 'memos', 'attachments', 'operations', 'meta'], 'readwrite');
  for (const id of acknowledged) await transaction.objectStore('operations').delete(id);
  for (const change of changes) {
    if (change.operation === 'delete') {
      const childMemos = change.entityType === 'space'
        ? await transaction.objectStore('memos').index('spaceId').getAll(change.entityId) : [];
      const deletedMemoIds = new Set(childMemos.map((memo) => memo.id));
      if (change.entityType === 'memo') deletedMemoIds.add(change.entityId);
      for (const item of await transaction.objectStore('attachments').getAll()) {
        if (deletedMemoIds.has(item.memoId)) await transaction.objectStore('attachments').delete(item.id);
      }
      for (const id of deletedMemoIds) await transaction.objectStore('memos').delete(id);
      for (const operation of await transaction.objectStore('operations').getAll()) {
        if (operation.entityId === change.entityId || deletedMemoIds.has(operation.entityId)
          || (change.entityType === 'space' && operation.kind === 'upsert_memo' && (operation.payload as Memo)?.spaceId === change.entityId)) {
          await transaction.objectStore('operations').delete(operation.id);
        }
      }
    }
    if (change.entityType === 'space') {
      if (change.operation === 'delete') await transaction.objectStore('spaces').delete(change.entityId);
      else await transaction.objectStore('spaces').put({ ...(change.payload as Space), syncState: 'synced' });
    } else if (change.entityType === 'memo') {
      if (change.operation === 'delete') await transaction.objectStore('memos').delete(change.entityId);
      else await transaction.objectStore('memos').put({ ...(change.payload as Memo), syncState: 'synced' });
    } else if (change.entityType === 'attachment') {
      if (change.operation === 'delete') await transaction.objectStore('attachments').delete(change.entityId);
      else {
        const previous = await transaction.objectStore('attachments').get(change.entityId);
        await transaction.objectStore('attachments').put({
          ...(change.payload as Attachment),
          cacheState: previous?.blob ? 'cached' : (change.payload as Attachment).cacheState,
          blob: previous?.blob
        });
      }
    }
  }
  const pending = await transaction.objectStore('operations').index('createdAt').getAll();
  for (const operation of pending) {
    if (operation.kind === 'upsert_space') await transaction.objectStore('spaces').put(operation.payload as Space);
    if (operation.kind === 'upsert_memo') await transaction.objectStore('memos').put(operation.payload as Memo);
    if (operation.kind === 'delete_memo') await transaction.objectStore('memos').delete(operation.entityId);
    if (operation.kind === 'delete_space') {
      await transaction.objectStore('spaces').delete(operation.entityId);
      for (const memo of await transaction.objectStore('memos').index('spaceId').getAll(operation.entityId)) {
        await transaction.objectStore('memos').delete(memo.id);
      }
    }
  }
  await transaction.objectStore('meta').put(cursor, 'cursor');
  await transaction.done;
}

export async function getCursor(): Promise<number> {
  if (isNative()) {
    const rows = await (await nativeDatabase()).select<Array<{ value_json: string }>>("SELECT value_json FROM meta WHERE key='cursor'");
    return rows[0] ? Number(JSON.parse(rows[0].value_json)) : 0;
  }
  return Number((await (await db()).get('meta', 'cursor')) ?? 0);
}

export async function getProfile(): Promise<Profile | undefined> {
  if (isNative()) {
    const rows = await (await nativeDatabase()).select<Array<{ value_json: string }>>("SELECT value_json FROM meta WHERE key='profile'");
    return rows[0] ? JSON.parse(rows[0].value_json) as Profile : undefined;
  }
  return (await db()).get('meta', 'profile') as Promise<Profile | undefined>;
}

export async function setProfile(profile: Profile) {
  if (isNative()) {
    await (await nativeDatabase()).execute("INSERT OR REPLACE INTO meta(key,value_json) VALUES('profile',$1)", [JSON.stringify(profile)]);
    return;
  }
  await (await db()).put('meta', profile, 'profile');
}

export async function clearLocalData() {
  if (isNative()) {
    const native = await nativeDatabase();
    const { BaseDirectory, remove } = await import('@tauri-apps/plugin-fs');
    try { await remove(NATIVE_ATTACHMENT_DIR, { baseDir: BaseDirectory.AppData, recursive: true }); } catch { /* already empty */ }
    for (const table of ['spaces', 'memos', 'attachments', 'operations', 'meta']) await native.execute(`DELETE FROM ${table}`);
    return;
  }
  const store = await db();
  const transaction = store.transaction(['spaces', 'memos', 'attachments', 'operations', 'meta'], 'readwrite');
  await Promise.all([...transaction.objectStoreNames].map((name) => transaction.objectStore(name).clear()));
  await transaction.done;
}

export async function clearAttachmentCache() {
  if (isNative()) {
    const native = await nativeDatabase();
    const rows = await native.select<Array<{ id: string; value_json: string; blob_path: string | null }>>('SELECT id,value_json,blob_path FROM attachments');
    for (const row of rows) {
      const attachment = JSON.parse(row.value_json) as Attachment;
      if (attachment.remoteReady) {
        await removeNativeBlob(row.blob_path);
        attachment.cacheState = 'remote';
        await native.execute('UPDATE attachments SET value_json=$1,blob_path=NULL,blob=NULL WHERE id=$2', [JSON.stringify(attachment), row.id]);
      }
    }
    return;
  }
  const store = await db();
  const values = await store.getAll('attachments');
  const transaction = store.transaction('attachments', 'readwrite');
  for (const value of values) {
    if (value.remoteReady) await transaction.store.put({ ...value, blob: undefined, cacheState: 'remote' });
  }
  await transaction.done;
}
