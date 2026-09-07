mod auth;
mod config;
mod db;
mod error;
mod ingest;
mod models;
mod sync;
mod uploads;

use auth::AuthUser;
use axum::{
    Json, Router,
    body::Body,
    extract::{
        DefaultBodyLimit, Extension, Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderName, HeaderValue, Method, Request, StatusCode, header},
    middleware,
    response::{Html, IntoResponse, Response},
    routing::{get, patch, post},
};
use config::Config;
use serde::Serialize;
use sqlx::SqlitePool;
use std::{sync::Arc, time::Duration};
use tokio::sync::broadcast;
use tower_http::{
    compression::CompressionLayer,
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

#[derive(Clone)]
pub struct AppState {
    config: Arc<Config>,
    db: SqlitePool,
    http: reqwest::Client,
    changes: broadcast::Sender<ChangeNotice>,
}

#[derive(Debug, Clone)]
pub struct ChangeNotice {
    user_id: i64,
}

#[derive(Serialize)]
struct ReleaseManifest<'a> {
    version: &'a str,
    web: String,
    #[serde(rename = "windowsSetup")]
    windows_setup: String,
    #[serde(rename = "windowsPortable")]
    windows_portable: String,
    android: String,
    appimage: String,
    linux: String,
}

async fn health() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn manifest(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Json<ReleaseManifest<'static>> {
    let base = &state.config.public_base_url;
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let web = if user_agent.contains("android") {
        format!("{base}/downloads/Scratchwall-universal-release.apk")
    } else if user_agent.contains("windows") {
        format!("{base}/downloads/Scratchwall_0.1.0_x64-setup.exe")
    } else if user_agent.contains("linux") {
        format!("{base}/downloads/Scratchwall_0.1.0_amd64.AppImage")
    } else {
        format!("{base}/downloads/")
    };
    Json(ReleaseManifest {
        version: env!("CARGO_PKG_VERSION"),
        web,
        windows_setup: format!("{base}/downloads/Scratchwall_0.1.0_x64-setup.exe"),
        windows_portable: format!("{base}/downloads/scratchwall.exe"),
        android: format!("{base}/downloads/Scratchwall-universal-release.apk"),
        appimage: format!("{base}/downloads/Scratchwall_0.1.0_amd64.AppImage"),
        linux: format!("{base}/downloads/scratchwall"),
    })
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn downloads_catalog_html(base: &str, include_checksums: bool) -> String {
    let base = escape_html(base.trim_end_matches('/'));
    let version = escape_html(env!("CARGO_PKG_VERSION"));
    let artifacts = [
        (
            "Android",
            "Universal APK",
            format!("{base}/downloads/Scratchwall-universal-release.apk"),
        ),
        (
            "Windows",
            "Installer",
            format!("{base}/downloads/Scratchwall_0.1.0_x64-setup.exe"),
        ),
        (
            "Windows",
            "Portable EXE",
            format!("{base}/downloads/scratchwall.exe"),
        ),
        (
            "Linux",
            "AppImage",
            format!("{base}/downloads/Scratchwall_0.1.0_amd64.AppImage"),
        ),
        (
            "Linux",
            "ELF binary",
            format!("{base}/downloads/scratchwall"),
        ),
    ];
    let mut items = String::new();
    for (platform, label, href) in artifacts {
        let name = href.rsplit('/').next().unwrap_or(href.as_str());
        items.push_str(&format!(
            "<li><a href=\"{href}\"><strong>{platform}</strong><span>{label}</span><small>{name}</small></a></li>"
        ));
    }
    if include_checksums {
        items.push_str(&format!(
            "<li><a href=\"{base}/downloads/SHA256SUMS.txt\"><strong>Checksums</strong><span>SHA-256</span><small>SHA256SUMS.txt</small></a></li>"
        ));
    }
    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"/><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/><title>Scratchwall downloads</title><style>
:root {{ font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #eef0f7; background: #0d0f14; }}
body {{ max-width: 560px; margin: 0 auto; padding: 48px 20px; }}
a.back {{ color: #9f94ff; text-decoration: none; font-size: 14px; }}
h1 {{ margin: 18px 0 8px; font-size: 28px; }}
p {{ color: #969dac; line-height: 1.5; }}
ul {{ list-style: none; padding: 0; margin: 28px 0; }}
li {{ margin: 0 0 10px; }}
li a {{ display: grid; gap: 2px; padding: 14px 16px; border: 1px solid #2a2f3d; border-radius: 14px; background: #14171f; color: inherit; text-decoration: none; }}
li a:hover {{ border-color: #7c6cff; }}
strong {{ font-size: 13px; color: #9f94ff; letter-spacing: .04em; text-transform: uppercase; }}
span {{ font-size: 16px; }}
small {{ color: #969dac; }}
</style></head><body>
<a class=\"back\" href=\"/\">Scratchwall</a>
<h1>Downloads</h1>
<p>Install Scratchwall {version} on this device, or grab a build for another platform. The web app itself is at the home page.</p>
<ul>{items}</ul>
</body></html>"
    )
}

async fn downloads_page(State(state): State<AppState>) -> Html<String> {
    let checksums = state
        .config
        .data_dir
        .join("downloads")
        .join("SHA256SUMS.txt")
        .is_file();
    Html(downloads_catalog_html(
        &state.config.public_base_url,
        checksums,
    ))
}

async fn download_artifact(Path(name): Path<String>, State(state): State<AppState>) -> Response {
    let requested = std::path::Path::new(&name);
    if requested
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = state.config.data_dir.join("downloads").join(requested);
    let file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let headers = [
        (
            header::CONTENT_TYPE,
            HeaderValue::from_str(mime.essence_str())
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
        ),
        (
            header::CONTENT_DISPOSITION,
            HeaderValue::from_str(&format!("attachment; filename=\"{name}\""))
                .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
        ),
    ];
    (
        headers,
        Body::from_stream(tokio_util::io::ReaderStream::new(file)),
    )
        .into_response()
}

fn is_spa_shell(path: &str) -> bool {
    matches!(
        path,
        "/" | "/index.html" | "/sw.js" | "/registerSW.js" | "/manifest.webmanifest"
    )
}

fn allows_same_origin_frame(path: &str) -> bool {
    path == "/api/v1/auth/login" || path == "/auth/oidc/callback"
}

async fn security_headers(request: Request<Body>, next: middleware::Next) -> Response {
    let path = request.uri().path().to_string();
    let sensitive =
        path.starts_with("/api/") || path.starts_with("/auth/") || path.starts_with("/telegram/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "x-frame-options",
        HeaderValue::from_static(if allows_same_origin_frame(&path) {
            "SAMEORIGIN"
        } else {
            "DENY"
        }),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    if sensitive {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    } else {
        headers.insert("content-security-policy", HeaderValue::from_static("default-src 'self'; connect-src 'self' https://scratch.morad.uk wss://scratch.morad.uk; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"));
        if is_spa_shell(&path) {
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        }
    }
    response
}

async fn changes_ws(
    ws: WebSocketUpgrade,
    Extension(user): Extension<AuthUser>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| listen_for_changes(socket, user.user_id, state.changes.subscribe()))
}

async fn listen_for_changes(
    mut socket: WebSocket,
    user_id: i64,
    mut receiver: broadcast::Receiver<ChangeNotice>,
) {
    loop {
        match receiver.recv().await {
            Ok(notice) if notice.user_id == user_id => {
                if socket.send(Message::Text("changed".into())).await.is_err() {
                    break;
                }
            }
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(_)) => {
                if socket.send(Message::Text("changed".into())).await.is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "scratchwall=info,tower_http=info".into()),
        )
        .init();
    let config = Arc::new(Config::from_env()?);
    let database = db::connect(&config.data_dir).await?;
    let (changes, _) = broadcast::channel(128);
    let state = AppState {
        config: config.clone(),
        db: database,
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("Scratchwall/0.1.0")
            .build()?,
        changes,
    };

    let protected = Router::new()
        .route("/auth/me", get(auth::me))
        .route("/auth/logout", post(auth::logout))
        .route("/sync", post(sync::sync))
        .route("/changes", get(changes_ws))
        .route("/uploads", post(uploads::create))
        .route("/uploads/{id}", patch(uploads::append).get(uploads::status))
        .route("/uploads/{id}/complete", post(uploads::complete))
        .route(
            "/files/{id}",
            get(uploads::download).head(uploads::download),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));
    let ingest_limit = (config.max_attachment_bytes as usize)
        .saturating_mul(8)
        .saturating_add(1024 * 1024);
    let ingest_routes = Router::new()
        .route("/api/v1/ingest", post(ingest::ingest))
        .layer(DefaultBodyLimit::max(ingest_limit));
    let ingest_bind_routes = Router::new()
        .route(
            "/api/v1/ingest/telegram/bind",
            post(ingest::create_telegram_bind),
        )
        .route(
            "/auth/telegram/bind/{token}",
            get(ingest::complete_telegram_bind),
        )
        .route(
            "/telegram/bind/{token}",
            get(ingest::complete_telegram_bind),
        );

    tokio::fs::create_dir_all(config.data_dir.join("downloads")).await?;
    let static_files = ServeDir::new(&config.web_dir)
        .not_found_service(ServeFile::new(config.web_dir.join("index.html")));
    let cors = CorsLayer::new()
        .allow_origin([
            HeaderValue::from_static("http://tauri.localhost"),
            HeaderValue::from_static("https://tauri.localhost"),
            HeaderValue::from_static("tauri://localhost"),
        ])
        .allow_methods([
            Method::GET,
            Method::HEAD,
            Method::POST,
            Method::PATCH,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::RANGE,
            HeaderName::from_static("upload-offset"),
        ])
        .expose_headers([
            header::CONTENT_LENGTH,
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
        ])
        .allow_credentials(true);
    let app = Router::new()
        .route("/healthz", get(health))
        .route("/api/v1/auth/login", get(auth::login))
        .route("/api/v1/auth/native/exchange", post(auth::exchange))
        .route("/auth/oidc/callback", get(auth::callback))
        .route("/downloads/manifest.json", get(manifest))
        .route("/downloads", get(downloads_page))
        .route("/downloads/", get(downloads_page))
        .route("/downloads/{name}", get(download_artifact))
        .merge(ingest_routes)
        .merge(ingest_bind_routes)
        .nest("/api/v1", protected)
        .fallback_service(static_files)
        .layer(cors)
        .layer(middleware::from_fn(security_headers))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(config.listen_addr).await?;
    tracing::info!(address = %config.listen_addr, "Scratchwall listening");
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use std::sync::Arc;

    #[test]
    fn downloads_page_lists_release_artifacts() {
        let html = downloads_catalog_html("https://scratch.test", true);
        let response = Html(html.clone()).into_response();
        assert_eq!(response.status(), StatusCode::OK);
        for name in [
            "Scratchwall-universal-release.apk",
            "Scratchwall_0.1.0_x64-setup.exe",
            "scratchwall.exe",
            "Scratchwall_0.1.0_amd64.AppImage",
            "/downloads/scratchwall",
            "SHA256SUMS.txt",
        ] {
            assert!(html.contains(name), "missing {name}");
        }
    }

    #[test]
    fn downloads_page_omits_checksums_when_absent() {
        let html = downloads_catalog_html("https://scratch.test", false);
        assert!(!html.contains("SHA256SUMS.txt"));
    }

    #[test]
    fn spa_shell_paths_are_the_uncached_entry_points() {
        for path in [
            "/",
            "/index.html",
            "/sw.js",
            "/registerSW.js",
            "/manifest.webmanifest",
        ] {
            assert!(is_spa_shell(path), "{path}");
        }
        assert!(!is_spa_shell("/assets/index-abc.js"));
        assert!(!is_spa_shell("/api/v1/sync"));
    }

    #[test]
    fn silent_login_and_callback_may_be_framed_by_the_app() {
        assert!(allows_same_origin_frame("/api/v1/auth/login"));
        assert!(allows_same_origin_frame("/auth/oidc/callback"));
        assert!(!allows_same_origin_frame("/"));
        assert!(!allows_same_origin_frame("/api/v1/sync"));
    }

    #[tokio::test]
    async fn telegram_bind_pages_are_not_stored() {
        async fn ok() -> &'static str {
            "ok"
        }
        let app = Router::new()
            .route("/telegram/bind/{token}", get(ok))
            .layer(middleware::from_fn(security_headers));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{addr}/telegram/bind/token"))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
    }

    #[tokio::test]
    async fn spa_shell_sends_no_cache() {
        async fn ok() -> &'static str {
            "ok"
        }
        let app = Router::new()
            .route("/", get(ok))
            .route("/assets/app.js", get(ok))
            .layer(middleware::from_fn(security_headers));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::new();
        let shell = client.get(format!("http://{addr}/")).send().await.unwrap();
        assert_eq!(shell.status(), StatusCode::OK);
        assert_eq!(
            shell.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache"
        );
        let asset = client
            .get(format!("http://{addr}/assets/app.js"))
            .send()
            .await
            .unwrap();
        assert!(asset.headers().get(header::CACHE_CONTROL).is_none());
    }

    #[tokio::test]
    async fn downloads_http_serves_catalog_and_artifacts() {
        let directory = tempfile::tempdir().unwrap();
        let downloads_dir = directory.path().join("downloads");
        std::fs::create_dir_all(&downloads_dir).unwrap();
        std::fs::write(downloads_dir.join("SHA256SUMS.txt"), "abc").unwrap();
        let db = crate::db::connect(directory.path()).await.unwrap();
        let config = Arc::new(crate::config::Config {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            data_dir: directory.path().into(),
            web_dir: ".".into(),
            public_base_url: "https://scratch.test".into(),
            oidc_issuer: "https://issuer.test".into(),
            oidc_client_id: "test".into(),
            oidc_client_secret: "test".into(),
            oidc_groups_claim: "groups".into(),
            allowed_groups: Arc::new(vec!["admins".into()]),
            session_key: [1; 32],
            max_attachment_bytes: 2_147_483_648,
            ingest_token_hash: None,
        });
        let (changes, _) = tokio::sync::broadcast::channel(8);
        let state = AppState {
            config: config.clone(),
            db,
            http: reqwest::Client::new(),
            changes,
        };
        let app = Router::new()
            .route("/downloads/manifest.json", get(manifest))
            .route("/downloads", get(downloads_page))
            .route("/downloads/", get(downloads_page))
            .route("/downloads/{name}", get(download_artifact))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        for path in ["/downloads/", "/downloads"] {
            let catalog = client
                .get(format!("http://{addr}{path}"))
                .send()
                .await
                .unwrap();
            assert_eq!(catalog.status(), StatusCode::OK, "{path}");
            let body = catalog.text().await.unwrap();
            assert!(body.contains("Scratchwall-universal-release.apk"), "{path}");
            assert!(body.contains("SHA256SUMS.txt"), "{path}");
        }
        let sums = client
            .get(format!("http://{addr}/downloads/SHA256SUMS.txt"))
            .send()
            .await
            .unwrap();
        assert_eq!(sums.status(), StatusCode::OK);
        assert_eq!(sums.text().await.unwrap(), "abc");
        let manifest = client
            .get(format!("http://{addr}/downloads/manifest.json"))
            .send()
            .await
            .unwrap();
        assert_eq!(manifest.status(), StatusCode::OK);
        let payload: serde_json::Value = manifest.json().await.unwrap();
        assert_eq!(
            payload["android"],
            "https://scratch.test/downloads/Scratchwall-universal-release.apk"
        );
    }
}
