// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadAttachment, silentLoginUrl } from './api';
import type { Attachment } from './types';

afterEach(() => vi.unstubAllGlobals());

describe('silent login url', () => {
  it('asks the server for a prompt=none web login', () => {
    expect(silentLoginUrl()).toContain('/api/v1/auth/login?mode=web&silent=1');
  });
});

const attachment: Attachment = { id: 'file', memoId: 'memo', filename: 'sample.txt', mimeType: 'text/plain', size: 5, remoteReady: true, cacheState: 'remote', createdAt: '1' };

describe('download API', () => {
  it('streams byte progress into a Blob with the original MIME type', async () => {
    const progress: number[] = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('he'));
      controller.enqueue(new TextEncoder().encode('llo'));
      controller.close();
    } }))));
    const blob = await downloadAttachment(attachment, { onProgress: (received) => progress.push(received) });
    expect(progress).toEqual([0, 2, 5]);
    expect(blob.type).toBe('text/plain');
    const text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(text).toBe('hello');
  });

  it('does not return a Blob when the response is truncated', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('hi')));
    await expect(downloadAttachment(attachment)).rejects.toThrow('incomplete');
  });

  it('forwards cancellation to both fetch and the response reader', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    vi.stubGlobal('fetch', fetch);
    const pending = downloadAttachment(attachment, { signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
