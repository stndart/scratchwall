import { describe, expect, it } from 'vitest';
import { firstMemoUrl, inlineParts, memoBlocks, setMemoTask } from './memoText';

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

describe('memo task lists', () => {
  it('groups consecutive tasks and keeps surrounding prose and blank lines', () => {
    expect(memoBlocks('Before\n- [ ] Pending\n- [x] Done\n\n- [X] Also done\nAfter')).toMatchObject([
      { type: 'text', value: 'Before\n' },
      { type: 'tasks', items: [
        { value: 'Pending', completed: false },
        { value: 'Done', completed: true },
      ] },
      { type: 'text', value: '\n' },
      { type: 'tasks', items: [{ value: 'Also done', completed: true }] },
      { type: 'text', value: 'After' },
    ]);
  });

  it('accepts Markdown bullet markers, indentation, empty labels and Windows newlines', () => {
    expect(memoBlocks('  * [ ] One\r\n+\t[X]\tTwo\r\n- [ ]\r\n- [x]')).toMatchObject([
      { type: 'tasks', items: [
        { value: 'One', completed: false },
        { value: 'Two', completed: true },
        { value: '', completed: false },
        { value: '', completed: true },
      ] },
    ]);
  });

  it('leaves ordinary bullets, escaped markers, invalid checkboxes and inline examples literal', () => {
    const body = '- plain list\n\\- [ ] Escaped\n- [y] Invalid\n- [] Missing space\n- [x]Missing separator\nMention - [ ] inline\n`- [x] inline code`';
    expect(memoBlocks(body)).toEqual([{ type: 'text', value: body }]);
  });

  it('keeps task syntax inside fenced code literal and resumes tasks after the fence', () => {
    expect(memoBlocks('- [ ] Before\n```text\n- [x] Literal\n```\n- [X] After')).toMatchObject([
      { type: 'tasks', items: [{ value: 'Before', completed: false }] },
      { type: 'code', language: 'text', value: '- [x] Literal\n' },
      { type: 'tasks', items: [{ value: 'After', completed: true }] },
    ]);
    expect(memoBlocks('```code```- [ ] Same line')).toEqual([
      { type: 'code', language: undefined, value: 'code' },
      { type: 'text', value: '- [ ] Same line' },
    ]);
    expect(memoBlocks('- [ ] Before ```code```')).toEqual([
      { type: 'text', value: '- [ ] Before ' },
      { type: 'code', language: undefined, value: 'code' },
    ]);
  });

  it('finds preview links in tasks while excluding code and keeping document order', () => {
    const body = '- [ ] `https://inline.test`\n- [x] **https://task.test**\nAfter https://after.test';
    expect(firstMemoUrl(body)).toBe('https://task.test');
    expect(firstMemoUrl('Before https://before.test\n' + body)).toBe('https://before.test');
  });

  it('changes only the chosen task marker, preserving duplicate labels, formatting and line endings', () => {
    const source = 'Before\r\n  * [ ] Same **label**\r\n```text\r\n- [ ] Same **label**\r\n```\r\n+ [X]\tSame **label**\r\n';
    const tasks = memoBlocks(source).flatMap((block) => block.type === 'tasks' ? block.items : []);
    expect(tasks.map((task) => source[task.marker])).toEqual([' ', 'X']);
    expect(setMemoTask(source, tasks[0].marker, true)).toBe(source.replace('  * [ ]', '  * [x]'));
    expect(setMemoTask(source, tasks[1].marker, false)).toBe(source.replace('+ [X]', '+ [ ]'));
    expect(setMemoTask(source, tasks[1].marker, true)).toBe(source);
    expect(setMemoTask(source, source.indexOf('- [ ]') + 3, true)).toBe(source);
    expect(setMemoTask(source, -1, true)).toBe(source);
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
