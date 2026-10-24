export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (received: number) => void;
  onSaving?: () => void;
}

// Count bytes after the consumer accepts them, including native disk writes.
export async function consumeDownload(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number,
  consume: (chunk: Uint8Array) => void | Promise<void>,
  { signal, onProgress }: DownloadOptions = {}
) {
  const reader = stream.getReader();
  let received = 0;
  let complete = false;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    onProgress?.(0);
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (received + value.byteLength > expectedSize) throw new Error('Downloaded file exceeds its declared size');
      await consume(value);
      signal?.throwIfAborted();
      received += value.byteLength;
      onProgress?.(received);
    }
    if (received !== expectedSize) throw new Error('Downloaded file is incomplete');
    complete = true;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
