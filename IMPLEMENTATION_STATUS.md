# Implementation status

Updated 2026-09-05. Scratchwall v0.1.0 is implemented and deployed at <https://scratch.morad.uk>. This file records what was directly verified and the remaining platform-specific smoke-test limits.

## Verified

- The single `scratchwall:local` Compose service runs on the external `homelabinternals` network with `restart: unless-stopped`, no service dependencies, a bind-mounted `./data:/data`, and a passing container healthcheck.
- A confidential VoidAuth client is registered with the specified redirect/logout URLs, Client Secret Basic authentication, skipped consent, and the `admins`/`devs` group allowlist. Real credentials live only in the ignored `.env` file.
- Production OIDC sign-in succeeds through `https://scratch.morad.uk`; the backend validates matching ID-token/UserInfo subjects, fails closed on missing group membership, encrypts provider credentials, and periodically rechecks membership.
- Web/PWA capture, Unicode tags, named spaces, substring search, optimistic writes, editing/deletion flows, attachments, thumbnails, on-demand originals, offline reload, and foreground synchronization are implemented behind a shared repository interface.
- A production browser capture appeared in 69 ms. Two open clients converged in 147 ms. A stored YouTube URL was found by the substring `yout`; the worker's 50,000-memo benchmark completes under 100 ms on this machine.
- A production offline reload retained memos after the backend was stopped. The app reports the server as unavailable while preserving local writes, and API/auth/download routes are excluded from PWA navigation fallback.
- Production image upload and inline thumbnail rendering succeeded. Server integration tests cover resumable upload interruption/completion retry, MIME metadata, orphan cleanup, file authorization, HTTP Range downloads, and attachment size boundaries.
- Browser-local server echoes retain cached attachment bytes. Native metadata/operation application uses Rust-side SQLite transactions; attachment originals are written and uploaded in bounded chunks through the native filesystem.
- Eleven frontend tests and eight backend tests pass. Svelte/TypeScript checking reports zero errors and warnings; Rust formatting and Clippy with warnings denied pass for both Rust projects.
- Windows x64 portable EXE and NSIS installer, a universal Android APK, and Ubuntu 22.04-built x86_64 raw ELF/AppImage are produced from the same source. Release files and SHA-256 checksums are published under `/downloads`.
- The data volume survived a real stop/offline/reload/start cycle with memos and an attachment present. The final acceptance pass also performed `docker compose restart` and verified the same records remained.

## Verification limits

- No disallowed live VoidAuth account was available. The denial path is covered by automated UserInfo membership tests, while the allowed-account path was exercised against the real provider.
- Browser automation policy prevented opening the uploaded attachment from the rendered memo. Authorized streaming and Range behavior are covered by backend integration tests.
- The Windows portable process passed a local launch smoke test; the NSIS installation wizard was not driven automatically.
- The APK is checked as a signed universal release package. No Android device/emulator is connected for a runtime launch test.
- The Linux ELF/AppImage are inspected in the reproducible Ubuntu 22.04 builder. This Windows host does not provide a Linux graphical session for an interactive WebKit launch.
- Native foreground invalidation uses visible-only two-second polling; web clients use WebSocket invalidations. No background worker, scheduled polling while closed, or automatic updater is installed.
- Search/history rendering is incrementally capped at 200 entries with an explicit “show more” control rather than full scroll virtualization.

The supplied plan remains unchanged. The limits above are test-environment constraints, not hidden development bypasses.
