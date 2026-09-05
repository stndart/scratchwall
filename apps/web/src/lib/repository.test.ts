// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyServerChanges, clearLocalData, getAttachment, getCursor, getSnapshot, pendingOperations, putAttachment, putMemo, putSpace, rejectOperation } from './repository';
import type { Memo, PendingOperation, Space } from './types';

const space: Space = { id: 'space', name: 'Inbox', position: 0, isInbox: true, createdAt: '1', updatedAt: '1', syncState: 'synced' };
const memo: Memo = { id: 'memo', spaceId: space.id, body: 'https://youtube.com', tags: [], attachmentIds: ['file'], createdAt: '1', updatedAt: '1', syncState: 'pending' };
function operation(id: string, payload = memo): PendingOperation {
  return { id, kind: 'upsert_memo', entityId: memo.id, payload, createdAt: id, attempts: 0 };
}
beforeEach(async () => { await clearLocalData(); await putSpace(space); });

describe('offline repository', () => {
  it('keeps edits captured while an older operation is in flight', async () => {
    await putMemo(memo, operation('1'));
    const edited = { ...memo, body: 'newer offline edit' };
    await putMemo(edited, operation('2', edited));
    await applyServerChanges([{ seq: 1, entityType: 'memo', entityId: memo.id, operation: 'upsert', payload: memo }], ['1'], 1);
    expect((await getSnapshot()).memos[0].body).toBe(edited.body);
    expect((await pendingOperations()).map((op) => op.id)).toEqual(['2']);
    expect(await getCursor()).toBe(1);
  });
  it('cascades space tombstones and discards stale pending edits and files', async () => {
    await putMemo(memo, operation('1'));
    await putAttachment({ id: 'file', memoId: memo.id, filename: 'x.txt', mimeType: 'text/plain', size: 1, remoteReady: false, cacheState: 'local', createdAt: '1' }, new Blob(['x']));
    await applyServerChanges([{ seq: 2, entityType: 'space', entityId: space.id, operation: 'delete' }], [], 2);
    expect(await getSnapshot()).toEqual({ spaces: [], memos: [], attachments: [] });
    expect(await pendingOperations()).toEqual([]);
    expect(await getAttachment('file')).toBeUndefined();
  });
  it('wipes records, pending operations, and cursor', async () => {
    await putMemo(memo, operation('1'));
    await clearLocalData();
    expect((await getSnapshot()).memos).toEqual([]);
    expect(await pendingOperations()).toEqual([]);
    expect(await getCursor()).toBe(0);
  });
  it('keeps downloaded bytes and cached state when the server echoes attachment metadata', async () => {
    const attachment = { id: 'file', memoId: memo.id, filename: 'x.txt', mimeType: 'text/plain', size: 1, remoteReady: false, cacheState: 'local' as const, createdAt: '1' };
    await putAttachment(attachment, new Blob(['x']));
    await applyServerChanges([{ seq: 3, entityType: 'attachment', entityId: 'file', operation: 'upsert', payload: { ...attachment, remoteReady: true, cacheState: 'remote' } }], [], 3);
    const stored = await getAttachment('file');
    expect(stored?.cacheState).toBe('cached');
    expect(stored?.blob).toBeDefined();
  });
  it('discards permanently rejected operations and marks their local entity', async () => {
    await putMemo(memo, operation('rejected'));
    await rejectOperation('rejected', 'target space does not exist');
    expect(await pendingOperations()).toEqual([]);
    expect((await getSnapshot()).memos[0].syncState).toBe('error');
  });
});
