# Scratchwall

A local-first wall for notes, links, images and files. Svelte web app/PWA, optional Tauri desktop/mobile clients, and an Axum/SQLite server. Devices keep offline copies and sync while the app is open.

## Install

You need Docker Compose and an OIDC provider. Scratchwall currently uses **VoidAuth-compatible endpoints** under the issuer: `/auth`, `/token`, `/jwks` and `/me` (UserInfo). It requires a confidential client, PKCE, refresh tokens and a groups claim; there is no password or development-bypass login.

1. Clone this repository and run `cp .env.example .env`.
2. Register an OIDC client with authorization-code and refresh-token grants, `Client Secret Basic`, and scopes `openid profile email groups offline_access`. Set its redirect URI to `<PUBLIC_BASE_URL>/auth/oidc/callback`; use `<PUBLIC_BASE_URL>/` for its home/logout URL. With VoidAuth, allow `offline_access` and enable Skip Consent.
3. Edit `.env`: set your public URL, issuer, client ID/secret, permitted group names, and a random session key (generate with `openssl rand -hex 32`). Users must belong to at least one permitted group.
4. Run `docker compose up -d --build`, then open the configured URL and sign in. Check `docker compose ps` and `docker compose logs --tail 100 scratchwall` if startup fails.

The default listens at `http://localhost:8080`. For public hosting, put a TLS reverse proxy in front and set `PUBLIC_BASE_URL` to your HTTPS origin. `BIND_ADDRESS`, `PORT` and `DATA_PATH` configure the listener and persistent volume. No external Docker network is required.

Keep deployment-specific networks, labels and targets in an ignored `compose.local.yml`; apply it with `docker compose -f compose.yml -f compose.local.yml up -d --build`. `.env`, `.env.*` (except the example), local JSON overrides, data, artifacts and signing keys are ignored. Keep these private files out of commits.

## Plugins

### scratchbot — Telegram capture

Optional, independent repository: [scratchbot](https://github.com/stndart/scratchbot). Clone it beside Scratchwall, rather than inside it or as a submodule:

```sh
git clone https://github.com/stndart/scratchbot.git ../scratchbot
```

Build/install using its README. Set a random `INGEST_TOKEN` in Scratchwall's `.env`; supply the same value as `SCRATCHWALL_INGEST_TOKEN` in the bot's private config, alongside `SCRATCHWALL_URL` and `TELEGRAM_BOT_TOKEN`. Restart Scratchwall after changing the token. Use `/login` in Telegram to bind your bot account through your normal Scratchwall login, then send notes/files. The bot's shared ingest credential cannot read your memos.

### Scratchwall MCP — agent access

The bundled plugin in [`plugins/mcp`](plugins/mcp) connects Codex, Cursor and other stdio MCP clients to **one user** and **one, several or all spaces**. It exposes live space discovery, paginated reads/search, memo text, tags and attachment metadata. It does not download attachment bytes or modify the wall. Only synced content is visible.

1. Install Node 24+ and pnpm 11, then run `pnpm install --frozen-lockfile` in this repository.
2. Open Scratchwall **Settings → Connect an agent**. Choose the spaces, create a token, and copy the token and displayed user ID. Tokens expire after 90 days; revoke or replace them in the same panel. “All spaces” includes future spaces; explicit grants follow space IDs through renames and exclude deleted spaces.
3. Copy `plugins/mcp/config.example.json` **outside the repo**, for example to `~/.config/scratchwall/mcp.json`. Set `url`, `user` (the exact OIDC subject, not your display name), `token`, and `spaces` (names or IDs, or `["*"]`). On Unix run `chmod 600 ~/.config/scratchwall/mcp.json`. IDs avoid duplicate-name ambiguity and survive renames.
4. Register it with one or both clients:

```sh
node plugins/mcp/install.mjs --config ~/.config/scratchwall/mcp.json --codex --cursor
```

The installer verifies credentials and spaces, preserves other Cursor servers, and registers absolute paths. Reload MCP servers or restart the clients to discover the tools. Keep the checkout at that path, or rerun the installer after moving it. For other clients, launch `node /absolute/path/to/plugins/mcp/server.mjs --config /private/config.json` as a stdio server.

Tool descriptions and server instructions advertise connected space names and tell agents to consult Scratchwall for requests such as “Check Backlog”. `scratchwall_list_spaces` always returns current names/IDs. Unknown, inaccessible and ambiguous spaces fail closed. The `check_scratchwall` prompt and `scratchwall://spaces` resource provide explicit discovery for clients that support them. These cues help tool selection; the client still decides when to call a tool.

An operator can provision a token without the UI, after the user has signed in once:

```sh
DATA_DIR=./data cargo run --manifest-path server/Cargo.toml -- \
  integration-token --user OIDC_SUBJECT --spaces 'Inbox,Backlog' --output /private/mcp.json
```

The output is created with mode 0600 on Unix and refuses to overwrite an existing file. This command requires the server's private `.env` and access to its database; regular users should use Settings.

## Development

Node 24+, pnpm 11+, Rust 1.97+. Commands run from the repo root:

```sh
pnpm install --frozen-lockfile
pnpm build
# .env is loaded automatically; override Docker paths for a local server.
DATA_DIR=./data WEB_DIR=./apps/web/dist LISTEN_ADDR=127.0.0.1:8080 pnpm server
```

Use a local OIDC callback/public URL in `.env` for local login. For hot reload, run `pnpm dev` in a second terminal; Vite proxies backend requests to port 8080.

Checks: `pnpm check`, `pnpm test`, `pnpm --filter @scratchwall/mcp test`, and `cargo clippy --manifest-path server/Cargo.toml --all-targets -- -D warnings`.

## Native clients and releases

For each web deployment, add a version and short changelog bullets as described in [Web release notes](apps/web/RELEASING.md). Settings shows the current version and remembers the user's previous version after refresh.

Install [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/). Set `VITE_API_BASE` to your server origin in private `.env`, then run `node scripts/native-config.mjs` to generate a matching private CSP override. The generic development origin is `http://localhost:8080`. `NATIVE_IDENTIFIER` optionally sets a private bundle identifier; preserve it when upgrading an existing app.

```sh
pnpm --dir apps/web tauri build --config src-tauri/tauri.local.json
# Android: SDK/NDK and a private signing key are also required.
pnpm --dir apps/web tauri android init --config src-tauri/tauri.local.json
pnpm --dir apps/web tauri android build --apk --config src-tauri/tauri.local.json
```

Android project files are generated locally. Keep release keystores/properties outside the repo and back them up. Windows build helpers are in `scripts/build-release.ps1`; the Linux container builder is `build/linux.Dockerfile`. For the Linux builder, pass `--build-arg VITE_API_BASE=https://your-server.example.com` and optionally `--build-arg NATIVE_IDENTIFIER=your.identifier`. Copy finished apps and `SHA256SUMS.txt` into `data/downloads` to serve them at `/downloads/`; clients check the manifest at launch and never auto-install updates.

## Data and everyday use

Persistent server state lives in `data/` (or `DATA_PATH`). To back up consistently, stop the container, archive that directory, then start it. Restore into an empty data directory while stopped. Preserve the session encryption key; losing it invalidates encrypted provider credentials. Notes/files are not end-to-end encrypted; protect server storage and device accounts. Attachments are limited to 2 GiB; browser quotas may be lower.

Choose **Install Scratchwall** in the sidebar, mobile spaces drawer, or Settings. Supported browsers open an install prompt; others show installation steps. **Ctrl/Cmd+K** searches, **N** focuses the composer, **Enter** saves, **Shift+Enter** adds a line, and **?** shows shortcuts. Settings can change Enter behavior. Memos support bold, italics, inline code and fenced code with a Copy button; other Markdown stays literal. Click a tag in the sidebar to search across spaces. Drafts are per-space and remain only while the app is open.

On mobile, swipe right across the wall to open spaces, then hold a space and drag to reorder it. On desktop, drag a space's grip. Keyboard users can focus a space and press **Alt+↑/↓**, or focus its grip and use **↑/↓**. Ordering is saved offline and synced across devices, including Inbox.

Click a memo's tag to filter within its space. Select more suggested tags or enter a query such as `#Reading #Important` to require all of them. The composer remains available in the current space, and each new memo inherits the filters. Choosing **All spaces** hides the composer. The down-arrow shortcut appears when you scroll far enough above the bottom. On mobile, sending a memo dismisses the keyboard; entering a tag keeps the tag field focused.

Hold a memo's surrounding area (or the desktop feed margin beside it) for a moment, then drag to select a range. Dragging back shrinks the range; starting on a selected memo removes that range from the selection. In selection mode, short clicks or taps toggle memos. Text selection, links, attachment controls, and code-copy buttons keep their usual behavior. **Space** toggles a focused memo; **Esc** exits selection mode.

## License

Scratchwall is released under the [MIT License](LICENSE).
