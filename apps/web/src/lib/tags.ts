export function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

export function normalizeTags(explicit: string[]): string[] {
  const values = new Map<string, string>();
  for (const value of explicit) {
    const cleaned = value.replace(/^#/, '').trim();
    if (cleaned && !values.has(normalize(cleaned))) values.set(normalize(cleaned), cleaned);
  }
  return [...values.values()];
}

export function searchableText(parts: Array<string | undefined>): string {
  return normalize(parts.filter(Boolean).join('\n'));
}
