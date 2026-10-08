# Scratchwall

Scratchwall is a fast, local-first wall for short notes, links, images, and files. It keeps a full offline memo database on each signed-in device and synchronizes only while the app is open.

## What is included

- Responsive Svelte 5 web app and installable PWA.
- Tauri 2 desktop/mobile wrapper with native SQLite metadata storage.
- Axum server with per-user SQLite data, permanent tombstones, cursor sync, WebSocket invalidation, and resumable streamed uploads.
- One-service Docker Compose deployment for `scratch.morad.uk`.
- Windows NSIS/portable, Linux AppImage/raw ELF, and Android APK build configuration.

## Development

Requirements: Node 24+, pnpm 11+, Rust 1.97+, and the platform prerequisites documented by Tauri.

```powershell
pnpm install
pnpm build
cargo test --manifest-path server/Cargo.toml
$env:PUBLIC_BASE_URL='http://127.0.0.1:8080'
$env:DATA_DIR='./data'
$env:WEB_DIR='./apps/web/dist'
# Also set OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and a random SESSION_ENCRYPTION_KEY.
cargo run --manifest-path server/Cargo.toml
```

The web app is then available on `http://127.0.0.1:8080`. A real VoidAuth client is required to sign in; there is deliberately no password or development-bypass login.

For hot reload, run the server and `pnpm dev` in separate terminals. Vite proxies backend routes to port 8080.

## Web and PWA interface

The web app uses a responsive workspace with a spaces drawer on mobile, light/dark/system appearance, attachment previews, and an in-app image/video viewer. Install from the browser menu (or Share → Add to Home Screen on iOS).

- **Ctrl/Cmd+K** focuses search; **N** focuses the composer when you aren't typing.
- **Enter** saves a memo; **Shift+Enter** inserts a new line. Change this in Settings → Writing on each device; **Ctrl/Cmd+Enter** always saves.
- **Tab** reaches every action; **↑/↓** moves between focused spaces or memo cards.
- **Escape** closes dialogs or cancels search, selection, or editing. **?** opens shortcut help.

Tag suggestions come from the current space. Use **Add a tag** to label memos; hashtags in memo text stay plain text.

Memos support a small set of formatting: `**bold**`, `*italics*`, inline code in single backticks, and code snippets between triple backticks. Add a language after the opening fence (for example, `js`, `python`, `sql`, or `html`) for syntax coloring, or omit it for automatic detection. Code blocks preserve spacing and scroll horizontally for long lines. Use `text` for an uncolored block; unknown languages also display as plain code. Headings, lists, tables, and HTML stay literal text. Escape a formatting character with a backslash to keep it literal.

Drafts stay separate per space while the app is open, and editing a saved memo preserves your unfinished draft. Save drafts before reloading; the PWA update button stays disabled while any space has a draft.

Run `pnpm --filter @scratchwall/web test` for web regression tests and `pnpm check` / `pnpm build` for type and production checks.

## VoidAuth client

Create one OIDC app with these exact values:

- Name: `Scratchwall`
- Home Page URL: `https://scratch.morad.uk`
- Allowed Groups: `admins`, `devs`
- Skip Consent: enabled
- MFA Required: disabled (the provider's normal account policy still applies)
- Auth Method: `Client Secret Basic`
- Redirect URL: `https://scratch.morad.uk/auth/oidc/callback`
- Response Type: `code`
- Grant Types: `authorization_code`, `refresh_token`
- Allowed scopes: include `offline_access` (VoidAuth's client default is `openid offline_access profile email groups`)
- PostLogout URL: `https://scratch.morad.uk/`

Scratchwall requests `offline_access` plus `prompt=consent` so VoidAuth issues a refresh token. Keep **Skip Consent** enabled so that consent prompt is completed automatically and no extra dialog appears. After deploying this, sign in once so the server can store a refresh token; older hour-long sessions cannot be repaired in place.

If login fails with a missing-refresh-token error, add `offline_access` to the client's allowed scopes (or confirm Skip Consent is on). VoidAuth refresh tokens last 14 days and rotate while Scratchwall is used; open the app at least every couple of weeks to keep the grant alive.

Put the generated client ID and secret in `.env`. Scratchwall validates the ID-token signature, issuer, audience, expiration and nonce; it then calls UserInfo and fails closed unless the configured group claim contains `admins` or `devs`.

## Deployment

Copy `.env.example` to `.env`, set the OIDC credentials, and replace `SESSION_ENCRYPTION_KEY` with a random value of at least 32 characters. The deployment has one application container, no dependency services, and uses the existing external `homelabinternals` network.

```powershell
docker compose up -d --build
docker compose ps
docker compose logs --tail 100 scratchwall
```

Persistent state is entirely under `./data`: the SQLite database, uploads, attachments, and release downloads. The image runs with `restart: unless-stopped`; docker-gen discovers it through `VIRTUAL_HOST=scratch.morad.uk` and `VIRTUAL_PORT=8080`.

### Backup and restore

Use a short stop to keep SQLite and blobs consistent:

```powershell
docker compose stop scratchwall
tar.exe -cf scratchwall-backup.tar data
docker compose start scratchwall
```

To restore, stop Scratchwall, move the current `data` directory somewhere recoverable, run `tar.exe -xf scratchwall-backup.tar` from the project directory, then start Scratchwall. Do not merge two data directories. Use tar rather than PowerShell's ZIP archive command, which cannot reliably archive individual 2 GiB attachments.

## Native builds

### Windows x64

```powershell
pnpm --dir apps/web build
pnpm --dir apps/web tauri build --bundles nsis
```

The installer is under `apps/web/src-tauri/target/release/bundle/nsis`; the portable executable is `apps/web/src-tauri/target/release/scratchwall.exe`.

### Linux x86_64

Build the reproducible Ubuntu 22.04 image and copy artifacts to `artifacts/linux`:

```powershell
docker build -f build/linux.Dockerfile -t scratchwall-linux-builder .
docker create --name scratchwall-linux-artifacts scratchwall-linux-builder
docker cp scratchwall-linux-artifacts:/artifacts ./artifacts/linux
docker rm scratchwall-linux-artifacts
```

### Android 10+

Install the Android SDK/NDK prerequisites, then initialize once and build a universal APK:

```powershell
pnpm --dir apps/web tauri android init
pnpm --dir apps/web tauri android build --apk
```

Keep the release keystore outside the repository (recommended location: `%USERPROFILE%\.scratchwall\signing\scratchwall-release.jks`) and back it up. Losing it prevents installing future versions over an existing APK.

## Release downloads

Copy final artifacts and a `SHA256SUMS.txt` file to `data/downloads`. The server exposes them at `/downloads/` and publishes `/downloads/manifest.json`; clients check that manifest only at launch and never install updates automatically.

## Security and limits

- Notes and files are not end-to-end encrypted; protect the host volume and device accounts.
- TLS termination is supplied by the existing reverse proxy.
- Every data query and file request is scoped to the verified OIDC issuer/subject.
- The application attachment limit defaults to exactly 2 GiB and is configurable with `MAX_ATTACHMENT_BYTES`.
- Browser storage quotas can be lower than 2 GiB. Scratchwall rejects an offline attachment before claiming it was saved if the device cannot persist it.
