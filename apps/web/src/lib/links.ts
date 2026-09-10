const TRAILING_WRAP: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
  '>': '<'
};

function httpUrlPattern(): RegExp {
  return /https?:\/\/[^\s<]+/giu;
}

function countChar(value: string, ch: string): number {
  let count = 0;
  for (const next of value) if (next === ch) count += 1;
  return count;
}

export function trimHttpUrl(raw: string): string {
  let value = raw;
  while (value.length) {
    const last = value[value.length - 1] ?? '';
    if ('. ,;:!?'.includes(last)) {
      value = value.slice(0, -1);
      continue;
    }
    const open = TRAILING_WRAP[last];
    if (open && countChar(value, last) > countChar(value, open)) {
      value = value.slice(0, -1);
      continue;
    }
    break;
  }
  return value;
}

export function httpUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(httpUrlPattern())) {
    const url = trimHttpUrl(match[0]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function firstHttpUrl(text: string): string | undefined {
  return httpUrls(text)[0];
}

export function isUrlOnlyBody(body: string, url: string): boolean {
  return body.split(url).join('').replace(/[\s.,;:!?()[\]{}<>]+/g, '') === '';
}

export function linkParts(text: string): Array<{ value: string; href?: string }> {
  const result: Array<{ value: string; href?: string }> = [];
  let cursor = 0;
  for (const match of text.matchAll(httpUrlPattern())) {
    const index = match.index ?? 0;
    if (index > cursor) result.push({ value: text.slice(cursor, index) });
    const raw = match[0];
    const href = trimHttpUrl(raw);
    const trailing = raw.slice(href.length);
    if (href) result.push({ value: href, href });
    if (trailing) result.push({ value: trailing });
    cursor = index + raw.length;
  }
  if (cursor < text.length) result.push({ value: text.slice(cursor) });
  return result;
}
