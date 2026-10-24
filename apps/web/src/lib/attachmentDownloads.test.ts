// @vitest-environment jsdom
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentDownloads, cancelAttachmentDownload, ensureAttachmentAvailable, stopAttachmentDownloads } from './attachmentDownloads';
import { downloadAttachment, downloadNativeAttachment } from './api';
import { attachmentSource, getAttachment, putAttachment } from './repository';
import { isNative } from './nativeAuth';
import type { Attachment } from './types';

vi.mock('./api', () => ({ downloadAttachment: vi.fn(), downloadNativeAttachment: vi.fn() }));
vi.mock('./repository', () => ({ attachmentSource: vi.fn(), getAttachment: vi.fn(), putAttachment: vi.fn() }));
vi.mock('./nativeAuth', () => ({ isNative: vi.fn(() => false) }));

const attachment: Attachment = {
  id: 'file', memoId: 'memo', filename: 'large.zip', mimeType: 'application/zip',
  size: 10, remoteReady: true, cacheState: 'remote', createdAt: '1'
};

beforeEach(() => { vi.resetAllMocks(); });
afterEach(async () => { await stopAttachmentDownloads(); });

describe('attachment downloads', () => {
  it('shares one transfer between repeated opens and shows saving until persistence finishes', async () => {
    const blob = new Blob(['0123456789']);
    let finishSave!: () => void;
    vi.mocked(putAttachment).mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
    vi.mocked(downloadAttachment).mockImplementation(async (_attachment, options) => {
      options?.onProgress?.(5);
      expect(get(attachmentDownloads).file).toMatchObject({ phase: 'downloading', received: 5, total: 10 });
      options?.onProgress?.(10);
      return blob;
    });
    const first = ensureAttachmentAvailable(attachment);
    expect(ensureAttachmentAvailable(attachment)).toBe(first);
    await vi.waitFor(() => expect(get(attachmentDownloads).file?.phase).toBe('saving'));
    expect(downloadAttachment).toHaveBeenCalledOnce();
    expect(putAttachment).toHaveBeenCalledWith({ ...attachment, cacheState: 'cached' }, blob);
    finishSave();
    expect(await first).toBe(blob);
    expect(get(attachmentDownloads)).toEqual({});
  });

  it('retains an inline failure and lets retry start a new transfer', async () => {
    vi.mocked(downloadAttachment).mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(new Blob(['0123456789']));
    await expect(ensureAttachmentAvailable(attachment)).rejects.toThrow('Connection lost');
    expect(get(attachmentDownloads).file).toMatchObject({ phase: 'error', error: 'Connection lost' });
    expect(putAttachment).not.toHaveBeenCalled();
    await ensureAttachmentAvailable(attachment);
    expect(downloadAttachment).toHaveBeenCalledTimes(2);
    expect(get(attachmentDownloads)).toEqual({});
  });

  it('never reports offline availability when device storage rejects the file', async () => {
    vi.mocked(downloadAttachment).mockResolvedValue(new Blob(['0123456789']));
    vi.mocked(putAttachment).mockRejectedValue(new Error('Storage quota exceeded'));
    await expect(ensureAttachmentAvailable(attachment)).rejects.toThrow('Storage quota');
    expect(get(attachmentDownloads).file).toMatchObject({ phase: 'error', error: 'Storage quota exceeded' });
  });

  it('cancels an active download without saving partial bytes', async () => {
    vi.mocked(downloadAttachment).mockImplementation(async (_attachment, options) => new Promise((_resolve, reject) => {
      options?.onProgress?.(5);
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));
    const pending = ensureAttachmentAvailable(attachment);
    await vi.waitFor(() => expect(downloadAttachment).toHaveBeenCalledOnce());
    cancelAttachmentDownload(attachment.id);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(get(attachmentDownloads).file?.phase).toBe('cancelled');
    expect(putAttachment).not.toHaveBeenCalled();
  });

  it('drains a save before logout or clearing device storage', async () => {
    let finishSave!: () => void;
    vi.mocked(downloadAttachment).mockResolvedValue(new Blob());
    vi.mocked(putAttachment).mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
    const pending = ensureAttachmentAvailable(attachment);
    await vi.waitFor(() => expect(get(attachmentDownloads).file?.phase).toBe('saving'));
    let drained = false;
    const stop = stopAttachmentDownloads().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finishSave();
    await Promise.all([pending, stop]);
    expect(drained).toBe(true);
    expect(get(attachmentDownloads)).toEqual({});
  });

  it('uses the native disk stream without reading a large Blob back into memory', async () => {
    vi.mocked(isNative).mockReturnValue(true);
    vi.mocked(downloadNativeAttachment).mockImplementation(async (_attachment, options) => {
      options?.onProgress?.(10);
      options?.onSaving?.();
    });
    await ensureAttachmentAvailable(attachment);
    expect(attachmentSource).toHaveBeenCalledWith(attachment.id);
    expect(downloadNativeAttachment).toHaveBeenCalledOnce();
    expect(getAttachment).not.toHaveBeenCalled();
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it('opens existing offline bytes without downloading again', async () => {
    const blob = new Blob(['offline']);
    vi.mocked(getAttachment).mockResolvedValue({ ...attachment, blob });
    expect(await ensureAttachmentAvailable(attachment)).toBe(blob);
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(get(attachmentDownloads)).toEqual({});
  });
});
