const TAG_PATTERN = /(^|[^\p{L}\p{N}_-])#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;

export function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

export function parseTags(body: string): string[] {
  const withoutUrls = body.replace(/https?:\/\/\S+/giu, ' ');
  const values = new Map<string, string>();
  for (const match of withoutUrls.matchAll(TAG_PATTERN)) {
    const value = match[2];
    values.set(normalize(value), value);
  }
  return [...values.values()];
}

export function mergeTags(body: string, explicit: string[]): string[] {
  const values = new Map<string, string>();
  for (const value of [...parseTags(body), ...explicit]) {
    const cleaned = value.replace(/^#/, '').trim();
    if (cleaned && !values.has(normalize(cleaned))) values.set(normalize(cleaned), cleaned);
  }
  return [...values.values()];
}

export function searchableText(parts: Array<string | undefined>): string {
  return normalize(parts.filter(Boolean).join('\n'));
}
