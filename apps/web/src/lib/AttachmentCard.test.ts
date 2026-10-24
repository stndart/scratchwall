// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import AttachmentCard from './AttachmentCard.svelte';
import type { Attachment } from './types';

const attachment: Attachment = {
  id: 'photo', memoId: 'memo', filename: 'photo.png', mimeType: 'image/png',
  size: 2048, thumbnail: 'data:image/png;base64,eA==', remoteReady: true, cacheState: 'cached', createdAt: '1',
};
const handlers = () => ({ onopen: vi.fn(), oncancel: vi.fn() });
afterEach(cleanup);

describe('attachment cards', () => {
  it('keeps a cached image overlay to filename and size, with offline status available as a tooltip', () => {
    const view = render(AttachmentCard, { attachment, visual: true, ...handlers() });
    const overlay = view.container.querySelector('.media-status')!;
    expect(overlay.textContent).toContain('photo.png');
    expect(overlay.textContent).toContain('2.00 KiB');
    expect(overlay.textContent).not.toContain('Available offline');
    expect(overlay.querySelector('.status-separator')).toBeNull();
    expect(overlay.querySelector('.attachment-status')?.getAttribute('title')).toBe('Available offline');
    expect(overlay.classList.contains('expanded')).toBe(false);
  });

  it('keeps offline availability visible on document cards', () => {
    const view = render(AttachmentCard, { attachment: { ...attachment, filename: 'report.pdf', mimeType: 'application/pdf' }, ...handlers() });
    expect(view.getByText('Available offline')).toBeTruthy();
  });

  it('still displays download progress and cancel controls over remote images', async () => {
    const callbacks = handlers();
    const view = render(AttachmentCard, {
      attachment: { ...attachment, cacheState: 'remote' }, visual: true,
      download: { phase: 'downloading', received: 1024, total: 2048 }, ...callbacks,
    });
    expect(view.getByText('50%')).toBeTruthy();
    expect(view.getByRole('progressbar', { name: 'Download photo.png' }).getAttribute('value')).toBe('1024');
    expect(view.container.querySelector('.media-status')?.classList.contains('expanded')).toBe(true);
    await fireEvent.click(view.getByRole('button', { name: 'Cancel download photo.png' }));
    expect(callbacks.oncancel).toHaveBeenCalledOnce();
  });

  it('retains upload failures and retry messages on image cards', async () => {
    const view = render(AttachmentCard, { attachment: { ...attachment, remoteReady: false, cacheState: 'error' }, visual: true, ...handlers() });
    expect(view.getByText('Upload failed · saved on this device')).toBeTruthy();
    await view.rerender({ attachment: { ...attachment, cacheState: 'remote' }, download: { phase: 'error', received: 0, total: 2048, error: 'Network error' } });
    expect(view.getByText('Download failed · retry')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Retry download photo.png' })).toBeTruthy();
  });
});
