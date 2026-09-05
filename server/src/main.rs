mod auth;
mod config;
mod db;
mod error;
mod models;
mod sync;
mod uploads;

use auth::AuthUser;
use axum::{
    Json, Router,
    body::Body,
    extract::{
        Extension, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderName, HeaderValue, Method, Request, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
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

async fn security_headers(request: Request<Body>, next: middleware::Next) -> Response {
    let sensitive =
        request.uri().path().starts_with("/api/") || request.uri().path().starts_with("/auth/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    if sensitive {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    } else {
        headers.insert("content-security-policy", HeaderValue::from_static("default-src 'self'; connect-src 'self' https://scratch.morad.uk wss://scratch.morad.uk; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"));
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

    let downloads = ServeDir::new(config.data_dir.join("downloads"));
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
        .nest_service("/downloads", downloads)
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
