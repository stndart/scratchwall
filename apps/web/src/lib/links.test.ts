import { describe, expect, it } from 'vitest';
import { firstHttpUrl, httpUrls, isUrlOnlyBody, linkParts, trimHttpUrl } from './links';

describe('http url extraction', () => {
  it('strips trailing sentence punctuation and unmatched wrappers', () => {
    expect(trimHttpUrl('https://example.com.')).toBe('https://example.com');
    expect(trimHttpUrl('https://example.com/path).')).toBe('https://example.com/path');
    expect(trimHttpUrl('https://en.wikipedia.org/wiki/Hello_(world)')).toBe(
      'https://en.wikipedia.org/wiki/Hello_(world)'
    );
  });

  it('returns unique http(s) urls in order', () => {
    expect(httpUrls('see https://a.test/x, then https://b.test/y and https://a.test/x again'))
      .toEqual(['https://a.test/x', 'https://b.test/y']);
    expect(firstHttpUrl('no links here')).toBeUndefined();
    expect(firstHttpUrl('https://news.test/a')).toBe('https://news.test/a');
  });

  it('treats a memo as url-only when leftover text is just punctuation', () => {
    expect(isUrlOnlyBody('https://example.com', 'https://example.com')).toBe(true);
    expect(isUrlOnlyBody('  https://example.com. ', 'https://example.com')).toBe(true);
    expect(isUrlOnlyBody('look at https://example.com', 'https://example.com')).toBe(false);
    expect(isUrlOnlyBody('https://a.test https://b.test', 'https://a.test')).toBe(false);
  });

  it('keeps trailing punctuation outside the link', () => {
    expect(linkParts('See https://example.com.')).toEqual([
      { value: 'See ' },
      { value: 'https://example.com', href: 'https://example.com' },
      { value: '.' }
    ]);
  });
});
