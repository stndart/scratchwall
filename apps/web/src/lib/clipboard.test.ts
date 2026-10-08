// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { filesFromClipboard, isTypingTarget } from './clipboard';

function file(name: string, type = 'image/png', lastModified = 1) {
  return new File([name], name, { type, lastModified });
}

function clipboard(partial: {
  items?: Array<{ kind: string; getAsFile: () => File | null }>;
  files?: File[];
}) {
  return {
    items: partial.items ?? [],
    files: partial.files ?? [],
  } as unknown as DataTransfer;
}

describe('filesFromClipboard', () => {
  it('prefers clipboard items over the alternative files representation', () => {
    const screenshot = file('screenshot.png');
    const extra = file('notes.txt', 'text/plain');
    expect(
      filesFromClipboard(
        clipboard({
          items: [{ kind: 'file', getAsFile: () => screenshot }],
          files: [extra],
        }),
      ),
    ).toEqual([screenshot]);
    expect(filesFromClipboard(clipboard({ files: [extra] }))).toEqual([extra]);
  });

  it('deduplicates the same file from items and files', () => {
    const image = file('shot.png');
    expect(
      filesFromClipboard(
        clipboard({
          items: [{ kind: 'file', getAsFile: () => image }],
          files: [image],
        }),
      ),
    ).toEqual([image]);
  });

  it('ignores non-file items and empty payloads', () => {
    expect(filesFromClipboard(undefined)).toEqual([]);
    expect(
      filesFromClipboard(
        clipboard({
          items: [{ kind: 'string', getAsFile: () => null }],
        }),
      ),
    ).toEqual([]);
  });

  it('does not duplicate a browser image whose two representations have different metadata', () => {
    expect(
      filesFromClipboard(
        clipboard({
          items: [
            {
              kind: 'file',
              getAsFile: () => file('image.png', 'image/png', 10),
            },
          ],
          files: [file('clipboard.png', 'image/png', 20)],
        }),
      ),
    ).toHaveLength(1);
  });

  it('falls back when file items cannot be read and keeps distinct file items', () => {
    const first = file('first.png');
    const second = file('second.png');
    expect(
      filesFromClipboard(
        clipboard({
          items: [{ kind: 'file', getAsFile: () => null }],
          files: [first],
        }),
      ),
    ).toEqual([first]);
    expect(
      filesFromClipboard(
        clipboard({
          items: [first, second].map((file) => ({
            kind: 'file',
            getAsFile: () => file,
          })),
        }),
      ),
    ).toEqual([first, second]);
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
    const child = document.createElement('span');
    editable.setAttribute('contenteditable', 'true');
    editable.append(child);
    expect(isTypingTarget(child)).toBe(true);
    expect(isTypingTarget(document.createElement('select'))).toBe(true);
  });
});
