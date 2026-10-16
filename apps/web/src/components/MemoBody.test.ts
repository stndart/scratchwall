// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import MemoBody from './MemoBody.svelte';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('memo body rendering', () => {
  it('copies only the chosen raw code block, including whitespace and literal HTML', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const raw = '  <div>literal & text</div>\n\n';
    const view = render(MemoBody, { body: 'Before\n```html\n' + raw + '```\n```text\nsecond\n```' });
    const buttons = view.getAllByRole('button', { name: 'Copy code' });
    await fireEvent.click(buttons[0]);
    await waitFor(() => expect(buttons[0].textContent).toContain('Copied'));
    expect(buttons[1].textContent?.trim()).toBe('Copy');
    expect(writeText).toHaveBeenCalledWith(raw);
    await fireEvent.click(buttons[1]);
    expect(writeText).toHaveBeenLastCalledWith('second\n');
  });
  it('reports a clipboard failure without claiming success', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('Denied'); }) } });
    const view = render(MemoBody, { body: '```text\ncode\n```' });
    await fireEvent.click(view.getByRole('button', { name: 'Copy code' }));
    await view.findByText('Could not copy. Select the code to copy it manually.');
    expect(view.queryByText('Copied')).toBeNull();
  });
  it('renders highlighted snippets as keyboard-accessible preformatted code', () => {
    const code = '  const greeting = "Hello";\n' + 'x'.repeat(400) + '\n';
    const view = render(MemoBody, { body: 'Before\n```js\n' + code + '```\nAfter' });
    const pre = view.getByLabelText('js code snippet');
    expect(pre.tagName).toBe('PRE');
    expect(pre.getAttribute('tabindex')).toBe('0');
    expect(pre.textContent).toBe(code);
    expect(pre.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(pre.querySelector('.hljs-string')?.textContent).toBe('"Hello"');
    expect(view.getByText('Before')).toBeTruthy();
    expect(view.getByText('After')).toBeTruthy();
  });

  it.each(['python', 'ts', 'json', 'sql', 'bash', 'html', 'css', 'rust', 'go', 'java', 'cpp', 'csharp', 'yaml', 'php', 'powershell'])(
    'accepts %s code fences', (language) => {
      const view = render(MemoBody, { body: '```' + language + '\nif true\n```' });
      expect(view.getByLabelText(language + ' code snippet').textContent).toBe('if true\n');
    },
  );

  it('detects unlabeled code and falls back safely for unknown or plain text languages', () => {
    const view = render(MemoBody, { body: '```\n{"hello": true, "count": 42}\n```\n```unknown\n<img src=x onerror=alert(1)>\n```\n```text\n**plain**\n```' });
    expect(view.container.querySelector('.hljs-attr')).toBeTruthy();
    expect(view.getByLabelText('unknown code snippet').textContent).toBe('<img src=x onerror=alert(1)>\n');
    expect(view.getByLabelText('unknown code snippet').querySelector('img')).toBeNull();
    expect(view.getByLabelText('text code snippet').querySelector('span')).toBeNull();
  });

  it('escapes raw HTML and leaves headings and tables literal while formatting inline text', () => {
    const view = render(MemoBody, { body: '# Heading\n| a | b |\n<img src=x>\n**bold** *italic* `https://code.test` https://prose.test' });
    expect(view.container.querySelector('h1, table, img')).toBeNull();
    expect(view.container.textContent).toContain('# Heading\n| a | b |\n<img src=x>');
    expect(view.container.querySelector('strong')?.textContent).toBe('bold');
    expect(view.container.querySelector('em')?.textContent).toBe('italic');
    expect(view.container.querySelectorAll('a')).toHaveLength(1);
    expect(view.container.querySelector('a')?.getAttribute('href')).toBe('https://prose.test');
  });

  it('preserves very large snippets without running costly highlighting', () => {
    const code = '<script>' + 'x'.repeat(20_001) + '</script>\n';
    const view = render(MemoBody, { body: '```js\n' + code + '```' });
    expect(view.container.querySelector('pre')?.textContent).toBe(code);
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelector('.hljs span')).toBeNull();
  });
});
