import { describe, expect, it } from 'vitest';
import { mergeTags, parseTags, searchableText } from './tags';

describe('tags', () => {
  it('parses unicode tags and ignores URL fragments', () => {
    expect(parseTags('hello #важное and #dev-notes https://x.test/#no')).toEqual(['важное', 'dev-notes']);
  });

  it('deduplicates tags case-insensitively', () => {
    expect(mergeTags('#Ideas', ['ideas', 'Later'])).toEqual(['Ideas', 'Later']);
  });

  it('keeps complete URLs substring searchable', () => {
    expect(searchableText(['https://youtube.com/watch?v=abc'])).toContain('yout');
  });
});

