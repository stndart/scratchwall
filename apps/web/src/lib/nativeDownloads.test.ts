// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheNativeStream } from './repository';
import type { Attachment } from './types';

const mocks = vi.hoisted(() => ({ write: vi.fn(), close: vi.fn(), remove: vi.fn(), execute: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppData: 1 }, mkdir: vi.fn(),
  open: vi.fn(async () => ({ write: mocks.write, close: mocks.close })), remove: mocks.remove
}));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => ({ execute: mocks.execute }) } }));

const attachment: Attachment = { id: 'file', memoId: 'memo', filename: 'file.zip', mimeType: 'application/zip', size: 4, remoteReady: true, cacheState: 'remote', createdAt: '1' };
function stream() { return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4)); controller.close(); } }); }

beforeEach(() => {
  vi.resetAllMocks();
  mocks.write.mockImplementation(async (chunk: Uint8Array) => chunk.byteLength);
  mocks.close.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue(undefined);
});

describe('native download persistence', () => {
  it('handles partial disk writes and reports progress only after the whole chunk is saved', async () => {
    mocks.write.mockImplementation(async (chunk: Uint8Array) => Math.min(2, chunk.byteLength));
    const progress: number[] = [];
    await cacheNativeStream(attachment, stream(), { onProgress: (received) => progress.push(received), onSaving() {
      expect(progress).toEqual([0, 4]);
      expect(mocks.execute).not.toHaveBeenCalled();
    } });
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.execute.mock.calls[0][1][0]).toContain('"cacheState":"cached"');
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('removes incomplete disk files after cancellation', async () => {
    const controller = new AbortController();
    const pending = cacheNativeStream(attachment, new ReadableStream(), { signal: controller.signal });
    await vi.waitFor(() => expect(mocks.write).not.toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('removes a partial file when the disk is full', async () => {
    mocks.write.mockRejectedValue(new Error('Disk full'));
    await expect(cacheNativeStream(attachment, stream())).rejects.toThrow('Disk full');
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('removes downloaded bytes if saving metadata fails', async () => {
    mocks.execute.mockRejectedValue(new Error('Database full'));
    await expect(cacheNativeStream(attachment, stream())).rejects.toThrow('Database full');
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
});
