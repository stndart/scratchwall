# Web release notes

Before deploying a web update, prepend an entry to `src/lib/changelog.ts` with a
distinct version (for example, `2026.10.09.1` for another deployment on the same
day) and one to three short bullets describing the changes. Keep older entries.
The first entry identifies the running web version; it is bundled with the app
and cached by the PWA along with the matching release notes.

Settings shows the changelog with **Current** and **Previous** labels. Refresh
records the version that is actually loaded, and the next version uses it as
the previous version even when the user skipped releases. Later visits retain
that label. Opening a newer release directly also records the last seen version.
First-time visitors have no previous label; versions used before this tracking
was introduced cannot be recovered.

Web release identifiers are independent of the native download manifest version.
