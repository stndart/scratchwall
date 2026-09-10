import { describe, expect, it } from 'vitest';
import { attachmentStatusLabel, fileExtension, isAttachmentCached } from './media';

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
