// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileDownloads } from './fileDownloads';

const firefoxAndroid = 'Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0';
const chromeAndroid = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36';
const firefoxDesktop = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0';
const pdf = { id: 'pdf', filename: 'report.pdf', mimeType: 'application/pdf' };
let downloads: ReturnType<typeof createFileDownloads>;

function platform(userAgent: string, standalone: boolean) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: standalone && query === '(display-mode: standalone)' }));
}

beforeEach(() => {
  downloads = createFileDownloads();
  platform(firefoxAndroid, true);
  URL.createObjectURL = vi.fn().mockReturnValueOnce('blob:first').mockReturnValue('blob:next');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  downloads.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('file downloads', () => {
  it('uses the Firefox Android PWA PDF workaround without changing the cached PDF bytes or filename', async () => {
    const blob = new Blob(['%PDF-1.4\noriginal bytes'], { type: 'application/pdf' });
    let link!: HTMLAnchorElement;
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function (this: HTMLAnchorElement) {
      link = this;
      expect(this.isConnected).toBe(true);
    });
    downloads.download(pdf, blob);
    const payload = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(payload.type).toBe('application/x-binary');
    expect(payload.size).toBe(blob.size);
    const text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(payload);
    });
    expect(text).toBe('%PDF-1.4\noriginal bytes');
    expect(blob.type).toBe('application/pdf');
    expect(link.href).toBe('blob:first');
    expect(link.download).toBe('report.pdf');
    expect(link.target).toBe('');
    expect(link.isConnected).toBe(false);
  });

  it.each([
    ['Firefox Android browser', firefoxAndroid, false],
    ['Chrome Android PWA', chromeAndroid, true],
    ['Firefox desktop PWA', firefoxDesktop, true],
  ])('preserves normal PDF handling in %s', (_name, userAgent, standalone) => {
    platform(userAgent, standalone);
    downloads.download(pdf, new Blob(['%PDF-1.4'], { type: 'application/pdf' }));
    expect((vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob).type).toBe('application/pdf');
  });

  it('recognizes PDF filenames with generic MIME metadata and leaves other file types alone', () => {
    downloads.download({ ...pdf, filename: 'REPORT.PDF', mimeType: 'application/octet-stream' }, new Blob(['%PDF-1.4']));
    downloads.download({ id: 'zip', filename: 'archive.zip', mimeType: 'application/zip' }, new Blob(['zip']));
    expect(vi.mocked(URL.createObjectURL).mock.calls.map(([blob]) => (blob as Blob).type)).toEqual(['application/x-binary', 'application/zip']);
  });

  it('reuses URLs and keeps them valid for delayed viewers until the app clears them', () => {
    vi.useFakeTimers();
    downloads.download(pdf, new Blob(['pdf']));
    vi.advanceTimersByTime(120_000);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    downloads.download(pdf, new Blob(['pdf']));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    downloads.clear();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:first');
    downloads.download(pdf, new Blob(['pdf']));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('does not create new download URLs if an asynchronous open finishes after the app is destroyed', () => {
    downloads.download(pdf, new Blob(['pdf']));
    downloads.dispose();
    downloads.download(pdf, new Blob(['pdf']));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:first');
  });
});
