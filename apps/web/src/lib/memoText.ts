import { firstHttpUrl, trimHttpUrl } from './links';

export type MemoBlock =
  | { type: 'text'; value: string }
  | { type: 'tasks'; items: { value: string; completed: boolean; marker: number }[] }
  | { type: 'code'; value: string; language?: string };

export type InlinePart =
  | { type: 'text' | 'code'; value: string }
  | { type: 'link'; value: string; href: string }
  | { type: 'bold' | 'italic'; children: InlinePart[] };

function escapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  while (text[--index] === '\\') backslashes += 1;
  return backslashes % 2 === 1;
}

function appendProse(blocks: MemoBlock[], body: string, start: number, end: number): void {
  const text = body.slice(start, end);
  const tasks = /^[ \t]{0,3}[-*+][ \t]+\[([ xX])\](?:[ \t]+([^\r\n]*)|(?=\r?$))(?:\r?\n|$)/gm;
  let cursor = 0;
  for (const match of text.matchAll(tasks)) {
    // A code fence can split a line; only complete prose lines are task items.
    if (match.index === 0 && start > 0 && body[start - 1] !== '\n') continue;
    if (match.index + match[0].length === text.length && end < body.length && body[end - 1] !== '\n') continue;
    if (match.index > cursor) blocks.push({ type: 'text', value: text.slice(cursor, match.index) });
    const previous = blocks.at(-1);
    const item = {
      value: match[2] ?? '',
      completed: match[1].toLowerCase() === 'x',
      marker: start + match.index + match[0].indexOf('[') + 1,
    };
    if (previous?.type === 'tasks') previous.items.push(item);
    else blocks.push({ type: 'tasks', items: [item] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) blocks.push({ type: 'text', value: text.slice(cursor) });
}

// Only paired backtick fences are special; unfinished fences stay editable text.
export function memoBlocks(body: string): MemoBlock[] {
  const blocks: MemoBlock[] = [];
  const fences = /`{3,}/g;
  let cursor = 0;
  let opening: RegExpExecArray | null;
  while ((opening = fences.exec(body))) {
    if (escapedAt(body, opening.index)) continue;
    const marker = opening[0];
    const afterMarker = fences.lastIndex;
    const newline = body.indexOf('\n', afterMarker);
    const header = newline < 0 ? null : body.slice(afterMarker, newline).match(/^[ \t]*([\w+#.-]+)?[ \t]*\r?$/);
    const codeStart = header ? newline + 1 : afterMarker;
    const closingPattern = header
      ? new RegExp('^[ \\t]{0,3}`{' + marker.length + ',}[ \\t]*(?:\\r?\\n|$)', 'gm')
      : new RegExp('(?<!`)' + marker + '(?!`)', 'g');
    closingPattern.lastIndex = codeStart;
    const closing = closingPattern.exec(body);
    if (!closing) continue;

    appendProse(blocks, body, cursor, opening.index);
    blocks.push({ type: 'code', value: body.slice(codeStart, closing.index), language: header?.[1]?.toLowerCase() });
    cursor = closingPattern.lastIndex;
    fences.lastIndex = cursor;
  }
  appendProse(blocks, body, cursor, body.length);
  return blocks;
}

export function setMemoTask(body: string, marker: number, completed: boolean): string {
  const task = memoBlocks(body).some((block) => block.type === 'tasks' && block.items.some((item) => item.marker === marker));
  if (!task || (body[marker].toLowerCase() === 'x') === completed) return body;
  return body.slice(0, marker) + (completed ? 'x' : ' ') + body.slice(marker + 1);
}

export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const pattern = /\\([\\`*])|(?<!`)(`{1,2})(?!`)([^`\r\n]+)\2(?!`)|\*\*(?=\S)([^\r\n]+?\S|\S)\*\*(?!\*)|\*(?=\S)([^*\r\n]+?\S|\S)\*|https?:\/\/[^\s<]+/giu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    // Don't turn multiplication or stars inside identifiers into emphasis.
    if ((match[4] || match[5]) && /[\p{L}\p{N}_]/u.test(text[index - 1] ?? '')) continue;
    if (index > cursor) parts.push({ type: 'text', value: text.slice(cursor, index) });
    if (match[1]) parts.push({ type: 'text', value: match[1] });
    else if (match[2]) parts.push({ type: 'code', value: match[3] });
    else if (match[4]) parts.push({ type: 'bold', children: inlineParts(match[4]) });
    else if (match[5]) parts.push({ type: 'italic', children: inlineParts(match[5]) });
    else {
      const href = trimHttpUrl(match[0]);
      parts.push({ type: 'link', value: href, href });
      const trailing = match[0].slice(href.length);
      if (trailing) parts.push({ type: 'text', value: trailing });
    }
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push({ type: 'text', value: text.slice(cursor) });
  return parts;
}

function prose(parts: InlinePart[]): string {
  return parts.map((part) => {
    if (part.type === 'code') return ' ';
    if ('children' in part) return prose(part.children);
    return part.value;
  }).join('');
}

export function firstMemoUrl(body: string): string | undefined {
  for (const block of memoBlocks(body)) {
    if (block.type === 'code') continue;
    for (const text of block.type === 'tasks' ? block.items.map((item) => item.value) : [block.value]) {
      const url = firstHttpUrl(prose(inlineParts(text)));
      if (url) return url;
    }
  }
  return undefined;
}
