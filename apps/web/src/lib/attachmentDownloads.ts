import { writable } from 'svelte/store';
import { downloadAttachment, downloadNativeAttachment } from './api';
import { attachmentSource, getAttachment, putAttachment } from './repository';
import { isNative } from './nativeAuth';
import type { Attachment } from './types';

export interface AttachmentDownload {
  phase: 'connecting' | 'downloading' | 'saving' | 'error' | 'cancelled';
  received: number;
  total: number;
  error?: string;
}

export const attachmentDownloads = writable<Record<string, AttachmentDownload>>({});
const flights = new Map<string, { controller: AbortController; promise: Promise<Blob | undefined>; saving: boolean }>();

export function ensureAttachmentAvailable(attachment: Attachment): Promise<Blob | undefined> {
  const existing = flights.get(attachment.id);
  if (existing) return existing.promise;
  const controller = new AbortController();
  const state: AttachmentDownload = { phase: 'connecting', received: 0, total: attachment.size };
  let lastUpdate = 0;
  const publish = () => attachmentDownloads.update((states) => ({ ...states, [attachment.id]: { ...state } }));
  const flight = { controller, promise: Promise.resolve().then(run), saving: false };
  flights.set(attachment.id, flight);
  publish();
  return flight.promise;

  async function run(): Promise<Blob | undefined> {
    try {
      const native = isNative();
      const local = native ? await attachmentSource(attachment.id) : (await getAttachment(attachment.id))?.blob;
      controller.signal.throwIfAborted();
      if (local) return native ? undefined : local as Blob;
      if (!attachment.remoteReady) throw new Error('This file has not finished uploading yet.');
      const options = {
        signal: controller.signal,
        onProgress(received: number) {
          state.phase = 'downloading';
          state.received = received;
          const now = performance.now();
          if (received === 0 || received === state.total || now - lastUpdate >= 100) {
            lastUpdate = now;
            publish();
          }
        },
        onSaving() {
          controller.signal.throwIfAborted();
          flight.saving = true;
          state.phase = 'saving';
          publish();
        }
      };
      if (native) {
        await downloadNativeAttachment(attachment, options);
        return undefined;
      }
      const blob = await downloadAttachment(attachment, options);
      options.onSaving();
      await putAttachment({ ...attachment, cacheState: 'cached', remoteReady: true }, blob);
      return blob;
    } catch (error) {
      state.phase = controller.signal.aborted ? 'cancelled' : 'error';
      state.error = error instanceof Error ? error.message : String(error);
      publish();
      throw error;
    } finally {
      flights.delete(attachment.id);
      if (state.phase !== 'error' && state.phase !== 'cancelled') {
        attachmentDownloads.update((states) => {
          const { [attachment.id]: _finished, ...rest } = states;
          return rest;
        });
      }
    }
  }
}

export function cancelAttachmentDownload(id: string) {
  const flight = flights.get(id);
  if (flight && !flight.saving) flight.controller.abort();
}

// Drain even a disk save before clearing the cache or changing accounts.
export async function stopAttachmentDownloads() {
  const active = [...flights.values()];
  for (const flight of active) flight.controller.abort();
  await Promise.allSettled(active.map(({ promise }) => promise));
  attachmentDownloads.set({});
}
