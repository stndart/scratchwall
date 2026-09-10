use crate::{AppState, auth::AuthUser, error::AppError};
use axum::{
    Json,
    extract::{Extension, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::{
    net::{IpAddr, SocketAddr},
    sync::OnceLock,
    time::Duration,
};
use url::Url;

const HTML_LIMIT: usize = 512 * 1024;
const ICON_LIMIT: usize = 48 * 1024;
const SUCCESS_TTL_SECS: i64 = 7 * 24 * 3600;
const FAILURE_TTL_SECS: i64 = 6 * 3600;
const MAX_REDIRECTS: usize = 3;
const TITLE_MAX: usize = 120;
const DESCRIPTION_MAX: usize = 180;

#[derive(Debug, Deserialize)]
pub struct PreviewQuery {
    url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    pub url: String,
    pub site: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
}

enum CachedPreview {
    Hit(LinkPreview),
    Negative,
    Miss,
}

pub async fn get_preview(
    Extension(_user): Extension<AuthUser>,
    State(state): State<AppState>,
    Query(query): Query<PreviewQuery>,
) -> Result<Response, AppError> {
    let url = guarded_url(&query.url)?;
    match cached_preview(&state.db, url.as_str()).await? {
        CachedPreview::Hit(preview) => return Ok(Json(preview).into_response()),
        CachedPreview::Negative => return Ok(StatusCode::NO_CONTENT.into_response()),
        CachedPreview::Miss => {}
    }
    let preview = match fetch_preview(&url).await {
        Ok(preview) => preview,
        Err(error) => {
            tracing::debug!(url = %url, error = %error, "link preview fetch failed");
            store_failure(&state.db, url.as_str()).await?;
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
    };
    store_preview(&state.db, &preview).await?;
    Ok(Json(preview).into_response())
}

pub fn guarded_url(raw: &str) -> Result<Url, AppError> {
    let trimmed = raw.trim();
    let parsed = Url::parse(trimmed).map_err(|_| AppError::BadRequest("invalid url".into()))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::BadRequest("url must be http or https".into()));
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err(AppError::BadRequest("url must not include credentials".into()));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::BadRequest("url host is required".into()))?;
    if host_is_blocked(host) {
        return Err(AppError::BadRequest("url host is not allowed".into()));
    }
    let mut url = parsed;
    url.set_fragment(None);
    Ok(url)
}

fn host_is_blocked(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".lan")
    {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return ip_is_blocked(ip);
    }
    false
}

fn ip_is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || a == 169 && b == 254
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unicast_link_local()
                || v6.is_unique_local()
                || v6.is_unspecified()
                || v6.is_multicast()
                || v6.to_ipv4_mapped()
                    .is_some_and(|mapped| ip_is_blocked(IpAddr::V4(mapped)))
        }
    }
}

async fn host_resolves_privately(host: &str) -> bool {
    if host_is_blocked(host) {
        return true;
    }
    let Ok(mut addrs) = tokio::net::lookup_host((host, 80)).await else {
        return true;
    };
    addrs.any(|addr: SocketAddr| ip_is_blocked(addr.ip()))
}

fn preview_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("Scratchwall/0.1.0 (+https://scratch.morad.uk)")
            .build()
            .expect("preview http client")
    })
}

async fn fetch_preview(start: &Url) -> Result<LinkPreview, anyhow::Error> {
    let (final_url, html) = fetch_html(start).await?;
    let html = String::from_utf8_lossy(&html);
    let parsed = parse_html(&html, &final_url);
    let site = site_label(&final_url);
    let favicon = match parsed.favicon.as_deref() {
        Some(href) => fetch_favicon(&final_url, href).await,
        None => fetch_favicon(&final_url, "/favicon.ico").await,
    };
    let title = parsed.title.or_else(|| Some(site.clone()));
    Ok(LinkPreview {
        url: start.as_str().to_owned(),
        site,
        title,
        description: parsed.description,
        favicon,
    })
}

async fn fetch_html(start: &Url) -> Result<(Url, Vec<u8>), anyhow::Error> {
    let mut current = start.clone();
    for _ in 0..=MAX_REDIRECTS {
        let host = current
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("missing host"))?;
        if host_is_blocked(host) || host_resolves_privately(host).await {
            anyhow::bail!("blocked host");
        }
        let response = preview_client().get(current.as_str()).send().await?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| anyhow::anyhow!("redirect without location"))?;
            current = current.join(location)?;
            guarded_url(current.as_str()).map_err(|error| anyhow::anyhow!("{error}"))?;
            continue;
        }
        if !response.status().is_success() {
            anyhow::bail!("preview status {}", response.status());
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !content_type.is_empty()
            && !content_type.contains("html")
            && !content_type.contains("xml")
            && !content_type.contains("text/plain")
        {
            anyhow::bail!("not html");
        }
        return Ok((current, read_limited(response, HTML_LIMIT).await?));
    }
    anyhow::bail!("too many redirects")
}

async fn read_limited(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, anyhow::Error> {
    let mut stream = response.bytes_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let remaining = limit.saturating_sub(out.len());
        if remaining == 0 {
            break;
        }
        out.extend_from_slice(&chunk[..remaining.min(chunk.len())]);
    }
    Ok(out)
}

async fn fetch_favicon(base: &Url, href: &str) -> Option<String> {
    if let Some(rest) = href.strip_prefix("data:image/")
        && rest.len() <= ICON_LIMIT * 2
    {
        return Some(href.to_owned());
    }
    let icon = base.join(href).ok()?;
    guarded_url(icon.as_str()).ok()?;
    let host = icon.host_str()?;
    if host_resolves_privately(host).await {
        return None;
    }
    let response = preview_client().get(icon.as_str()).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/x-icon")
        .split(';')
        .next()
        .unwrap_or("image/x-icon")
        .trim()
        .to_ascii_lowercase();
    if !content_type.starts_with("image/") {
        return None;
    }
    let bytes = read_limited(response, ICON_LIMIT).await.ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some(format!(
        "data:{content_type};base64,{}",
        STANDARD.encode(bytes)
    ))
}

#[derive(Default)]
struct ParsedHtml {
    title: Option<String>,
    description: Option<String>,
    favicon: Option<String>,
}

fn parse_html(html: &str, base: &Url) -> ParsedHtml {
    let mut parsed = ParsedHtml::default();
    let mut og_title = None;
    let mut og_description = None;
    let mut meta_description = None;
    let mut page_title = None;
    if let Some(title) = tag_inner(html, "title") {
        page_title = clip(decode_entities(&title), TITLE_MAX);
    }
    for tag in tags_named(html, "meta") {
        let property = attr(tag, "property")
            .or_else(|| attr(tag, "name"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let content = attr(tag, "content").unwrap_or_default();
        if content.is_empty() {
            continue;
        }
        match property.as_str() {
            "og:title" | "twitter:title" => {
                og_title = clip(decode_entities(&content), TITLE_MAX);
            }
            "og:description" | "twitter:description" => {
                og_description = clip(decode_entities(&content), DESCRIPTION_MAX);
            }
            "description" => {
                meta_description = clip(decode_entities(&content), DESCRIPTION_MAX);
            }
            _ => {}
        }
    }
    for tag in tags_named(html, "link") {
        let rel = attr(tag, "rel").unwrap_or_default().to_ascii_lowercase();
        if !rel.split_whitespace().any(|part| {
            part == "icon" || part == "shortcut" || part == "apple-touch-icon"
        }) {
            continue;
        }
        if let Some(href) = attr(tag, "href")
            && let Ok(absolute) = base.join(&href)
        {
            parsed.favicon = Some(absolute.into());
            if rel.split_whitespace().any(|part| part == "icon") {
                break;
            }
        }
    }
    parsed.title = og_title.or(page_title);
    parsed.description = og_description.or(meta_description);
    parsed
}

fn site_label(url: &Url) -> String {
    url.host_str()
        .unwrap_or(url.as_str())
        .trim_start_matches("www.")
        .to_owned()
}

fn clip(value: String, max: usize) -> Option<String> {
    let trimmed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= max {
        return Some(trimmed);
    }
    let mut out = String::new();
    for word in trimmed.split(' ') {
        if out.chars().count() + word.chars().count() + 1 > max.saturating_sub(1) {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    if out.is_empty() {
        out = trimmed.chars().take(max.saturating_sub(1)).collect();
    }
    out.push('…');
    Some(out)
}

fn tags_named<'a>(html: &'a str, name: &str) -> Vec<&'a str> {
    let haystack = html;
    let open = format!("<{name}");
    let mut tags = Vec::new();
    let lower = haystack.to_ascii_lowercase();
    let mut from = 0;
    while let Some(idx) = lower[from..].find(&open) {
        let start = from + idx;
        let rest = &haystack[start..];
        let end = rest.find('>').map(|at| start + at + 1).unwrap_or(haystack.len());
        tags.push(&haystack[start..end]);
        from = end;
        if tags.len() > 80 {
            break;
        }
    }
    tags
}

fn tag_inner(html: &str, name: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let start = lower.find(&open)?;
    let after = html[start..].find('>')? + start + 1;
    let stop_rel = lower[after..].find(&close)?;
    Some(html[after..after + stop_rel].to_owned())
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let key = format!("{name}=");
    let at = lower.find(&key)?;
    let rest = tag[at + key.len()..].trim_start();
    let (quote, rest) = match rest.as_bytes().first() {
        Some(b'"') => ('"', &rest[1..]),
        Some(b'\'') => ('\'', &rest[1..]),
        _ => {
            let end = rest.find(|ch: char| ch.is_whitespace() || ch == '>').unwrap_or(rest.len());
            return Some(rest[..end].to_owned());
        }
    };
    let end = rest.find(quote).unwrap_or(rest.len());
    Some(rest[..end].to_owned())
}

fn decode_entities(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        if let Some(end) = rest.find(';') {
            let entity = &rest[1..end];
            let decoded = match entity {
                "amp" => "&",
                "lt" => "<",
                "gt" => ">",
                "quot" => "\"",
                "apos" | "#39" | "#x27" => "'",
                "nbsp" => " ",
                other if other.starts_with('#') => {
                    let code = if let Some(hex) = other.strip_prefix("#x").or_else(|| other.strip_prefix("#X"))
                    {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        other[1..].parse().ok()
                    };
                    if let Some(ch) = code.and_then(char::from_u32) {
                        out.push(ch);
                        rest = &rest[end + 1..];
                        continue;
                    }
                    "&"
                }
                _ => "&",
            };
            if decoded == "&" && entity != "amp" {
                out.push('&');
                rest = &rest[1..];
                continue;
            }
            out.push_str(decoded);
            rest = &rest[end + 1..];
        } else {
            out.push_str(rest);
            return out;
        }
    }
    out.push_str(rest);
    out
}

async fn cached_preview(db: &sqlx::SqlitePool, url: &str) -> Result<CachedPreview, AppError> {
    let row = sqlx::query(
        "SELECT title,description,site,favicon,fetched_at,ok FROM link_previews WHERE url=?",
    )
    .bind(url)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Ok(CachedPreview::Miss);
    };
    let fetched_at: i64 = row.get("fetched_at");
    let ok: i64 = row.get("ok");
    let age = chrono::Utc::now().timestamp().saturating_sub(fetched_at);
    let ttl = if ok == 0 {
        FAILURE_TTL_SECS
    } else {
        SUCCESS_TTL_SECS
    };
    if age > ttl {
        return Ok(CachedPreview::Miss);
    }
    if ok == 0 {
        return Ok(CachedPreview::Negative);
    }
    Ok(CachedPreview::Hit(LinkPreview {
        url: url.into(),
        site: row.get("site"),
        title: row.get("title"),
        description: row.get("description"),
        favicon: row.get("favicon"),
    }))
}

async fn store_preview(db: &sqlx::SqlitePool, preview: &LinkPreview) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO link_previews(url,title,description,site,favicon,fetched_at,ok) VALUES(?,?,?,?,?,unixepoch(),1)
         ON CONFLICT(url) DO UPDATE SET title=excluded.title, description=excluded.description, site=excluded.site, favicon=excluded.favicon, fetched_at=excluded.fetched_at, ok=1",
    )
    .bind(&preview.url)
    .bind(&preview.title)
    .bind(&preview.description)
    .bind(&preview.site)
    .bind(&preview.favicon)
    .execute(db)
    .await?;
    Ok(())
}

async fn store_failure(db: &sqlx::SqlitePool, url: &str) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO link_previews(url,title,description,site,favicon,fetched_at,ok) VALUES(?,?,?,?,?,unixepoch(),0)
         ON CONFLICT(url) DO UPDATE SET fetched_at=excluded.fetched_at, ok=0",
    )
    .bind(url)
    .bind(Option::<String>::None)
    .bind(Option::<String>::None)
    .bind("")
    .bind(Option::<String>::None)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_and_odd_schemes() {
        for url in [
            "file:///etc/passwd",
            "ftp://example.com/a",
            "http://localhost/x",
            "http://127.0.0.1/x",
            "http://192.168.1.9/x",
            "http://10.0.0.4/x",
            "http://[::1]/x",
            "http://169.254.169.254/latest",
            "http://user:pass@example.com/",
        ] {
            assert!(guarded_url(url).is_err(), "{url}");
        }
        let ok = guarded_url("https://habr.com/ru/articles/1#frag").unwrap();
        assert_eq!(ok.as_str(), "https://habr.com/ru/articles/1");
        assert!(ok.fragment().is_none());
    }

    #[test]
    fn html_prefers_open_graph_and_resolves_favicon() {
        let html = r#"
            <html><head>
            <title>Raw &amp; Title</title>
            <meta property="og:title" content="OG Title">
            <meta name="description" content="meta desc that should lose">
            <meta property="og:description" content="A short starter text from the page.">
            <link rel="shortcut icon" href="/favicon.png">
            </head></html>
        "#;
        let parsed = parse_html(html, &Url::parse("https://news.example.com/a").unwrap());
        assert_eq!(parsed.title.as_deref(), Some("OG Title"));
        assert_eq!(
            parsed.description.as_deref(),
            Some("A short starter text from the page.")
        );
        assert_eq!(
            parsed.favicon.as_deref(),
            Some("https://news.example.com/favicon.png")
        );
    }

    #[test]
    fn falls_back_to_title_tag() {
        let html = "<html><head><title>  Hello   world </title></head></html>";
        let parsed = parse_html(html, &Url::parse("https://example.com/").unwrap());
        assert_eq!(parsed.title.as_deref(), Some("Hello world"));
        assert!(parsed.description.is_none());
    }

    #[test]
    fn clips_long_description() {
        let long = "word ".repeat(80);
        let clipped = clip(long, 40).unwrap();
        assert!(clipped.ends_with('…'));
        assert!(clipped.chars().count() <= 40);
    }

    fn test_config(data_dir: std::path::PathBuf) -> crate::config::Config {
        crate::config::Config {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            data_dir,
            web_dir: ".".into(),
            public_base_url: "https://scratch.test".into(),
            oidc_issuer: "https://issuer.test".into(),
            oidc_client_id: "test".into(),
            oidc_client_secret: "test".into(),
            oidc_groups_claim: "groups".into(),
            allowed_groups: std::sync::Arc::new(vec!["admins".into()]),
            session_key: [1; 32],
            max_attachment_bytes: 2_147_483_648,
            ingest_token_hash: None,
        }
    }

    async fn preview_state() -> (tempfile::TempDir, crate::AppState, i64) {
        let directory = tempfile::tempdir().unwrap();
        let db = crate::db::connect(directory.path()).await.unwrap();
        let user_id = crate::db::ensure_user(
            &db,
            "https://issuer.test",
            &crate::models::Profile {
                subject: "one".into(),
                display_name: "One".into(),
                groups: vec!["admins".into()],
            },
        )
        .await
        .unwrap();
        let (changes, _) = tokio::sync::broadcast::channel(8);
        let state = crate::AppState {
            config: std::sync::Arc::new(test_config(directory.path().into())),
            db,
            http: reqwest::Client::new(),
            changes,
        };
        (directory, state, user_id)
    }

    #[tokio::test]
    async fn preview_requires_auth_and_rejects_private_hosts() {
        let (_dir, state, user_id) = preview_state().await;
        let app = axum::Router::new()
            .route("/api/v1/previews", axum::routing::get(get_preview))
            .route_layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let unauth = reqwest::Client::new()
            .get(format!("http://{addr}/api/v1/previews?url=https://example.com"))
            .send()
            .await
            .unwrap();
        assert_eq!(unauth.status().as_u16(), 401);

        let error = get_preview(
            Extension(crate::auth::AuthUser { user_id }),
            State(state),
            Query(PreviewQuery {
                url: "http://127.0.0.1/".into(),
            }),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)));
    }
}
