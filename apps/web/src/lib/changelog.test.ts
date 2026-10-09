import { describe, expect, it } from 'vitest';
import { currentVersion, recordLoadedVersion, releases, rememberVersionBeforeRefresh } from './changelog';

function makeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('release history', () => {
  it('keeps a distinct version and short bullet list for each release', () => {
    expect(currentVersion).toBe(releases[0].version);
    expect(new Set(releases.map((release) => release.version)).size).toBe(releases.length);
    for (const release of releases) {
      expect(release.version.trim()).not.toBe('');
      expect(release.changes.length).toBeGreaterThan(0);
      expect(release.changes.length).toBeLessThanOrEqual(3);
      for (const change of release.changes) expect(change.length).toBeLessThan(120);
    }
  });

  it('does not invent a previous version on a first visit or same-version reload', () => {
    const storage = makeStorage();
    expect(recordLoadedVersion('one', storage)).toBeUndefined();
    rememberVersionBeforeRefresh('one', storage);
    expect(recordLoadedVersion('one', storage)).toBeUndefined();
    expect(recordLoadedVersion('two', storage)).toBe('one');
    expect(recordLoadedVersion('two', storage)).toBe('one');
  });

  it('remembers the actual version across skipped releases and later visits', () => {
    const storage = makeStorage();
    recordLoadedVersion('one', storage);
    rememberVersionBeforeRefresh('one', storage);
    expect(recordLoadedVersion('four', storage)).toBe('one');
    expect(recordLoadedVersion('four', storage)).toBe('one');
    rememberVersionBeforeRefresh('four', storage);
    expect(recordLoadedVersion('six', storage)).toBe('four');
  });

  it('also tracks a new release reached without using the refresh button', () => {
    const storage = makeStorage();
    recordLoadedVersion('one', storage);
    expect(recordLoadedVersion('three', storage)).toBe('one');
  });

  it('uses the refreshing tab version if another tab has already loaded the update', () => {
    const storage = makeStorage();
    recordLoadedVersion('one', storage);
    recordLoadedVersion('three', storage);
    rememberVersionBeforeRefresh('one', storage);
    expect(recordLoadedVersion('three', storage)).toBe('one');
  });

  it('does not block startup or refresh when storage is restricted', () => {
    const storage = {
      getItem: () => { throw new Error('Storage blocked'); },
      setItem: () => { throw new Error('Storage blocked'); },
      removeItem: () => { throw new Error('Storage blocked'); },
    };
    expect(() => rememberVersionBeforeRefresh('one', storage)).not.toThrow();
    expect(recordLoadedVersion('two', storage)).toBeUndefined();
  });
});
