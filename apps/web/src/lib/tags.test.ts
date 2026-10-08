import { describe, expect, it } from 'vitest';
import { normalizeTags, searchableText } from './tags';

describe('tags', () => {
  it('cleans explicitly entered tags and keeps Unicode names', () => {
    expect(normalizeTags(['#важное', ' dev-notes ', '', '#'])).toEqual(['важное', 'dev-notes']);
  });

  it('deduplicates tags case-insensitively', () => {
    expect(normalizeTags(['#Ideas', 'ideas', 'Later'])).toEqual(['Ideas', 'Later']);
  });

  it('keeps complete URLs substring searchable', () => {
    expect(searchableText(['https://youtube.com/watch?v=abc'])).toContain('yout');
  });
});

