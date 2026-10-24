import { isStandalone } from './pwa';
import type { Attachment } from './types';

export function createFileDownloads() {
  // A PDF viewer or Android download manager may keep reading after the click.
  // Reuse each file's URL until the app closes or its cached files are cleared.
  const urls = new Map<string, string>();
  let disposed = false;

  function clear() {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  }

  return {
    download(attachment: Pick<Attachment, 'id' | 'filename' | 'mimeType'>, blob: Blob) {
      if (disposed) return;
      let url = urls.get(attachment.id);
      if (!url) {
        const pdf = attachment.mimeType.toLowerCase().split(';')[0].trim() === 'application/pdf'
          || /\.pdf$/i.test(attachment.filename);
        const firefoxAndroidPwa = isStandalone()
          && /Android/i.test(navigator.userAgent)
          && /Firefox\//i.test(navigator.userAgent);
        // Firefox Android's PWA PDF viewer opens about:blank for blob links.
        // application/octet-stream also triggers it; x-binary uses the downloader.
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1945314
        const mimeType = pdf && firefoxAndroidPwa
          ? 'application/x-binary'
          : attachment.mimeType || blob.type || 'application/octet-stream';
        url = URL.createObjectURL(blob.type === mimeType ? blob : blob.slice(0, blob.size, mimeType));
        urls.set(attachment.id, url);
      }
      const link = document.createElement('a');
      link.href = url;
      link.rel = 'noopener';
      link.download = attachment.filename || 'download';
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
      }
    },
    clear,
    dispose() {
      disposed = true;
      clear();
    },
  };
}
