import { describe, expect, it } from 'vitest';
import { attachmentStatusLabel, fileExtension, isAttachmentCached, isVideoMime, isVisualPreview } from './media';

describe('fileExtension', () => {
  it('uses the last suffix in uppercase', () => {
    expect(fileExtension('notes.pdf')).toBe('PDF');
    expect(fileExtension('Quarterly NOTES.PDF')).toBe('PDF');
    expect(fileExtension('archive.tar.gz')).toBe('GZ');
    expect(fileExtension('path/to/report.docx')).toBe('DOCX');
  });

  it('falls back when there is no usable suffix', () => {
    expect(fileExtension('README')).toBe('FILE');
    expect(fileExtension('.gitignore')).toBe('FILE');
    expect(fileExtension('file.')).toBe('FILE');
    expect(fileExtension('')).toBe('FILE');
  });
});

describe('isAttachmentCached', () => {
  it('treats local and cached copies as present', () => {
    expect(isAttachmentCached('local')).toBe(true);
    expect(isAttachmentCached('cached')).toBe(true);
    expect(isAttachmentCached('remote')).toBe(false);
    expect(isAttachmentCached('error')).toBe(false);
  });
});

describe('attachmentStatusLabel', () => {
  it('tells the user when a local file is still uploading', () => {
    expect(attachmentStatusLabel('local', false)).toBe('Uploading…');
    expect(attachmentStatusLabel('error', false)).toBe('Upload failed');
    expect(attachmentStatusLabel('cached', true)).toBe('cached');
    expect(attachmentStatusLabel('remote', true)).toBe('remote');
  });
});

describe('isVisualPreview', () => {
  it('shows image and video posters, but not file badges without a still', () => {
    expect(isVisualPreview({ mimeType: 'image/jpeg', thumbnail: 'data:image/jpeg;base64,x' })).toBe(true);
    expect(isVisualPreview({ mimeType: 'video/mp4', thumbnail: 'data:image/jpeg;base64,x' })).toBe(true);
    expect(isVideoMime('application/mp4')).toBe(true);
    expect(isVisualPreview({ mimeType: 'video/mp4' })).toBe(false);
    expect(isVisualPreview({ mimeType: 'application/pdf', thumbnail: 'data:image/jpeg;base64,x' })).toBe(false);
    expect(isVisualPreview({ mimeType: 'image/png' })).toBe(false);
  });
});
