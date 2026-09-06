// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { filesFromClipboard, isTypingTarget } from './clipboard';

function file(name: string, type = 'image/png', lastModified = 1) {
  return new File([name], name, { type, lastModified });
}

function clipboard(partial: { items?: Array<{ kind: string; getAsFile: () => File | null }>; files?: File[] }) {
  return {
    items: partial.items ?? [],
    files: partial.files ?? []
  } as unknown as DataTransfer;
}

describe('filesFromClipboard', () => {
  it('reads files from clipboard items and falls back to the files list', () => {
    const screenshot = file('screenshot.png');
    const extra = file('notes.txt', 'text/plain');
    expect(filesFromClipboard(clipboard({
      items: [{ kind: 'file', getAsFile: () => screenshot }],
      files: [extra]
    }))).toEqual([screenshot, extra]);
  });

  it('deduplicates the same file from items and files', () => {
    const image = file('shot.png');
    expect(filesFromClipboard(clipboard({
      items: [{ kind: 'file', getAsFile: () => image }],
      files: [image]
    }))).toEqual([image]);
  });

  it('ignores non-file items and empty payloads', () => {
    expect(filesFromClipboard(undefined)).toEqual([]);
    expect(filesFromClipboard(clipboard({
      items: [{ kind: 'string', getAsFile: () => null }]
    }))).toEqual([]);
  });
});

describe('isTypingTarget', () => {
  it('treats form fields and contenteditable as typing targets', () => {
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
