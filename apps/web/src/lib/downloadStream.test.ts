import { describe, expect, it, vi } from 'vitest';
import { consumeDownload } from './downloadStream';

function chunks(...sizes: number[]) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const size of sizes) controller.enqueue(new Uint8Array(size));
    controller.close();
  } });
}

describe('streamed downloads', () => {
  it('reports actual consumed bytes in order, waiting for disk writes', async () => {
    const progress: number[] = [];
    const writes: number[] = [];
    await consumeDownload(chunks(2, 3, 5), 10, async (chunk) => {
      await Promise.resolve();
      expect(progress.at(-1)).toBe(writes.reduce((sum, size) => sum + size, 0));
      writes.push(chunk.byteLength);
    }, { onProgress: (received) => progress.push(received) });
    expect(progress).toEqual([0, 2, 5, 10]);
  });

  it('rejects incomplete and oversized files before they can be cached', async () => {
    await expect(consumeDownload(chunks(2), 3, () => {})).rejects.toThrow('incomplete');
    const consume = vi.fn();
    await expect(consumeDownload(chunks(4), 3, consume)).rejects.toThrow('exceeds');
    expect(consume).not.toHaveBeenCalled();
  });

  it('finishes an empty file without dividing by zero', async () => {
    const progress = vi.fn();
    await consumeDownload(chunks(), 0, () => {}, { onProgress: progress });
    expect(progress).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('cancels a stalled reader and releases its lock', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const download = consumeDownload(stream, 10, () => {}, { signal: controller.signal });
    controller.abort();
    await expect(download).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it('cancels the network stream when saving fails', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4)); }, cancel
    });
    await expect(consumeDownload(stream, 4, () => { throw new Error('Disk full'); })).rejects.toThrow('Disk full');
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});
