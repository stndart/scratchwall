import { describe, expect, it } from 'vitest';
import { firstMemoUrl, inlineParts, memoBlocks } from './memoText';

describe('memo code fences', () => {
  it('preserves code whitespace and separates surrounding text and multiple snippets', () => {
    expect(memoBlocks('Before\n```js\n  const x = 1;\n\n\tconsole.log(x);\n```\nAfter\n```python\nprint(1)\n```')).toEqual([
      { type: 'text', value: 'Before\n' },
      { type: 'code', language: 'js', value: '  const x = 1;\n\n\tconsole.log(x);\n' },
      { type: 'text', value: 'After\n' },
      { type: 'code', language: 'python', value: 'print(1)\n' },
    ]);
  });

  it('supports Windows newlines, unlabeled blocks and Telegram style inline fences', () => {
    expect(memoBlocks('```\r\n  hello\r\n```\r\nEnd')).toEqual([
      { type: 'code', language: undefined, value: '  hello\r\n' },
      { type: 'text', value: 'End' },
    ]);
    expect(memoBlocks('A ```const x = 1;``` B')).toEqual([
      { type: 'text', value: 'A ' },
      { type: 'code', language: undefined, value: 'const x = 1;' },
      { type: 'text', value: ' B' },
    ]);
  });

  it('keeps shorter fences and backticks in code and ignores trailing code on a closing line', () => {
    expect(memoBlocks('````text\n```\nconst s = `x`;\n```` still code\n````')).toEqual([
      { type: 'code', language: 'text', value: '```\nconst s = `x`;\n```` still code\n' },
    ]);
  });

  it('keeps unfinished fences and other block markdown literal', () => {
    const body = '# Heading\n- list\n| a | b |\n```js\nconst x = 1;';
    expect(memoBlocks(body)).toEqual([{ type: 'text', value: body }]);
    expect(memoBlocks('\\```js\nconst x = 1;\n```')).toEqual([{ type: 'text', value: '\\```js\nconst x = 1;\n```' }]);
    expect(inlineParts('```unfinished `inline`')).toEqual([
      { type: 'text', value: '```unfinished ' },
      { type: 'code', value: 'inline' },
    ]);
  });
});

describe('limited inline memo formatting', () => {
  it('supports bold, italics, nested emphasis and literal inline code', () => {
    expect(inlineParts('**bold *and italic*** `**literal**`')).toEqual([
      { type: 'bold', children: [
        { type: 'text', value: 'bold ' },
        { type: 'italic', children: [{ type: 'text', value: 'and italic' }] },
      ] },
      { type: 'text', value: ' ' },
      { type: 'code', value: '**literal**' },
    ]);
  });

  it('preserves escaped, unmatched, and identifier formatting characters', () => {
    expect(inlineParts('\\*literal\\* and a*b*c and **unfinished')).toEqual([
      { type: 'text', value: '*' },
      { type: 'text', value: 'literal' },
      { type: 'text', value: '*' },
      { type: 'text', value: ' and a*b*c and **unfinished' },
    ]);
  });

  it('retains URL punctuation and only previews links outside code', () => {
    expect(inlineParts('See https://example.com.')).toEqual([
      { type: 'text', value: 'See ' },
      { type: 'link', value: 'https://example.com', href: 'https://example.com' },
      { type: 'text', value: '.' },
    ]);
    expect(firstMemoUrl('```js\nconst url = "https://code.test";\n```\n`https://inline.test` **https://prose.test**')).toBe('https://prose.test');
    expect(firstMemoUrl('```https://code.test```')).toBeUndefined();
    expect(inlineParts('HTTPS://EXAMPLE.COM')[0]).toMatchObject({ type: 'link', href: 'HTTPS://EXAMPLE.COM' });
  });
});
