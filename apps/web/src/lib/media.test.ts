import { describe, expect, it } from 'vitest';
import { attachmentStatusLabel, fileExtension, isAttachmentCached, isVideoMime, isVisualPreview, spaceMedia } from './media';
import type { Attachment, Memo } from './types';

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

describe('spaceMedia', () => {
  it('follows memo order, including bumps, and preserves each album while skipping other spaces and documents', () => {
    const memo = (id: string, createdAt: string, attachmentIds: string[], extra: Partial<Memo> = {}): Memo => ({
      id, spaceId: 'inbox', body: '', tags: [], attachmentIds, createdAt, updatedAt: createdAt, syncState: 'synced', ...extra,
    });
    const attachment = (id: string, mimeType: string): Attachment => ({
      id, memoId: '', filename: id, mimeType, size: 12, cacheState: 'remote', remoteReady: true, createdAt: '2026-10-01',
    });
    const memos = [
      memo('bumped', '2026-10-01', ['first-posted'], { bumpedAt: '2026-10-04' }),
      memo('album', '2026-10-03', ['photo', 'document', 'clip', 'missing']),
      memo('oldest', '2026-10-02', ['old-photo']),
      memo('elsewhere', '2026-10-03', ['other'], { spaceId: 'ideas' }),
    ];
    const attachments = [
      attachment('clip', 'application/mp4'), attachment('other', 'image/png'),
      attachment('first-posted', 'image/png'), attachment('document', 'application/pdf'),
      attachment('photo', 'image/jpeg'), attachment('old-photo', 'image/png'), attachment('orphan', 'video/webm'),
    ];
    expect(spaceMedia(memos, attachments, 'inbox').map((item) => item.id)).toEqual(['old-photo', 'photo', 'clip', 'first-posted']);
    expect(memos.map((item) => item.id)).toEqual(['bumped', 'album', 'oldest', 'elsewhere']);
    expect(spaceMedia(memos, attachments, 'unknown')).toEqual([]);
  });
});
