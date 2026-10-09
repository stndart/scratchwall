export interface Release {
  version: string;
  changes: string[];
}

// Newest first. Add a distinct version and short notes for every deployment.
export const releases: Release[] = [
  {
    version: '2026.10.09',
    changes: [
      'Changelog in Settings remembers your previous version.',
      'Search suggests tags and finds partial #tag matches.',
      'Scoped, read-only access for connected agents.',
    ],
  },
  {
    version: '0.1.0',
    changes: [
      'Refreshed memo interface and steadier scrolling.',
      'Code formatting in memos.',
    ],
  },
];

export const currentVersion = releases[0].version;

const LOADED_VERSION = 'scratchwall.version.loaded';
const REFRESH_FROM = 'scratchwall.version.refreshFrom';
const PREVIOUS_VERSION = 'scratchwall.version.previous';
type VersionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function rememberVersionBeforeRefresh(
  version = currentVersion,
  storage?: VersionStorage,
): void {
  try {
    (storage ?? localStorage).setItem(REFRESH_FROM, version);
  } catch {
    // Storage restrictions must never prevent an update.
  }
}

export function recordLoadedVersion(
  version = currentVersion,
  storage?: VersionStorage,
): string | undefined {
  try {
    const target = storage ?? localStorage;
    const refreshFrom = target.getItem(REFRESH_FROM);
    const from = refreshFrom ?? target.getItem(LOADED_VERSION);
    if (from && from !== version) {
      target.setItem(PREVIOUS_VERSION, from);
      target.removeItem(REFRESH_FROM);
    }
    target.setItem(LOADED_VERSION, version);
    const previous = target.getItem(PREVIOUS_VERSION);
    return previous && previous !== version ? previous : undefined;
  } catch {
    return undefined;
  }
}
