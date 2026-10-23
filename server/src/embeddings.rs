//! Durable, account-scoped derived data. Only the API owns SQLite; workers use leases.
use crate::{AppState, ChangeNotice, auth::AuthUser, error::AppError};
use axum::{
    Json, Router,
    body::Body,
    extract::{Extension, Path, State},
    http::{HeaderMap, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, Sqlite, Transaction};
use std::{collections::HashMap, time::Duration};

pub const PIPELINE: &str = "e5-base-siglip2-large-ocr-v2-frames32";
const TEXT_DIM: usize = 768;
const VISUAL_DIM: usize = 1024;
const LEASE_SECONDS: i64 = 300;
const LIVE: &str = "m.deleted=0 AND sp.deleted=0 AND (s.attachment_id IS NULL OR (a.deleted=0 AND a.storage_key=s.storage_key AND a.id IN (SELECT value FROM json_each(m.attachment_ids_json))))";

#[derive(Clone, Default)]
pub struct EmbeddingConfig {
    pub url: Option<String>,
    pub token_hash: Option<String>,
    pub token: Option<String>,
}
impl EmbeddingConfig {
    pub fn from_env() -> Self {
        let token = std::env::var("EMBEDDING_TOKEN")
            .ok()
            .filter(|s| !s.is_empty());
        Self {
            url: std::env::var("EMBEDDING_URL")
                .ok()
                .filter(|s| !s.is_empty())
                .map(|s| s.trim_end_matches('/').to_string()),
            token_hash: token
                .as_ref()
                .map(|s| hex::encode(Sha256::digest(s.as_bytes()))),
            token,
        }
    }
    fn configured(&self) -> bool {
        self.url.is_some() && self.token.is_some()
    }
}

pub async fn migrate(pool: &sqlx::SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(
        r#"CREATE TABLE IF NOT EXISTS embedding_accounts (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
 reconcile_cursor TEXT NOT NULL DEFAULT '', reconcile_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS embedding_sources (
 id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source_key TEXT NOT NULL, memo_id TEXT NOT NULL, attachment_id TEXT, kind TEXT NOT NULL,
 fingerprint TEXT NOT NULL, generation INTEGER NOT NULL, pipeline TEXT NOT NULL,
 text TEXT NOT NULL DEFAULT '', storage_key TEXT,
 UNIQUE(user_id,source_key)
);
CREATE INDEX IF NOT EXISTS embedding_sources_memo ON embedding_sources(user_id,memo_id);
CREATE TABLE IF NOT EXISTS embedding_jobs (
 source_id INTEGER PRIMARY KEY REFERENCES embedding_sources(id) ON DELETE CASCADE,
 state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 retry_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
 claim_token TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS embedding_jobs_queue ON embedding_jobs(state,retry_at,lease_until);
CREATE TABLE IF NOT EXISTS embedding_units (
 source_id INTEGER NOT NULL REFERENCES embedding_sources(id) ON DELETE CASCADE,
 unit INTEGER NOT NULL, timestamp REAL, vector BLOB NOT NULL,
 PRIMARY KEY(source_id,unit)
);
"#,
    )
    .execute(pool)
    .await?;
    // A pipeline upgrade must resume backfill immediately, including accounts
    // whose previous hourly reconciliation had already finished.
    sqlx::query("UPDATE embedding_accounts SET reconcile_cursor='',reconcile_at=0 WHERE enabled=1 AND EXISTS(SELECT 1 FROM embedding_sources s WHERE s.user_id=embedding_accounts.user_id AND s.pipeline<>?)")
        .bind(PIPELINE).execute(pool).await?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    enabled: bool,
    configured: bool,
    pending: i64,
    running: i64,
    done: i64,
    failed: i64,
    total: i64,
    completeness: f64,
}
pub async fn settings(
    Extension(user): Extension<AuthUser>,
    State(state): State<AppState>,
) -> Result<Json<Settings>, AppError> {
    let mut tx = state.db.begin().await?;
    let enabled: bool =
        sqlx::query_scalar("SELECT enabled FROM embedding_accounts WHERE user_id=?")
            .bind(user.user_id)
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or(false);
    let rows = sqlx::query(&format!("SELECT j.state,COUNT(*) AS n FROM embedding_jobs j JOIN embedding_sources s ON s.id=j.source_id JOIN embedding_accounts ac ON ac.user_id=s.user_id JOIN memos m ON m.user_id=s.user_id AND m.id=s.memo_id JOIN spaces sp ON sp.user_id=m.user_id AND sp.id=m.space_id LEFT JOIN attachments a ON a.user_id=s.user_id AND a.id=s.attachment_id WHERE s.user_id=? AND ac.enabled=1 AND ac.generation=s.generation AND s.pipeline=? AND {LIVE} GROUP BY j.state")).bind(user.user_id).bind(PIPELINE).fetch_all(&mut *tx).await?;
    let mut out = Settings {
        enabled,
        configured: state.config.embeddings.configured(),
        pending: 0,
        running: 0,
        done: 0,
        failed: 0,
        total: if enabled {
            expected_sources(&mut tx, user.user_id).await?
        } else {
            0
        },
        completeness: 0.0,
    };
    for row in rows {
        let n = row.get("n");
        match row.get::<&str, _>("state") {
            "pending" => out.pending = n,
            "running" => out.running = n,
            "done" => out.done = n,
            "failed" => out.failed = n,
            _ => {}
        }
    }
    // Round down: only a fully indexed collection may display 100%.
    out.completeness = if !enabled {
        0.0
    } else if out.total == 0 {
        100.0
    } else {
        (out.done.min(out.total) * 1000 / out.total) as f64 / 10.0
    };
    tx.commit().await?;
    Ok(Json(out))
}

fn visual_kind(mime: &str) -> Option<&'static str> {
    if mime.starts_with("image/") {
        Some("image")
    } else if crate::thumbnails::is_video_mime(mime) {
        Some("video")
    } else {
        None
    }
}

fn source_text(body: String, tags: Vec<String>, filenames: impl Iterator<Item = String>) -> String {
    std::iter::once(body)
        .chain(tags)
        .chain(filenames)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Count desired sources from live content, independently of backfill/queue progress.
async fn expected_sources(tx: &mut Transaction<'_, Sqlite>, user: i64) -> Result<i64, AppError> {
    let files = sqlx::query("SELECT a.memo_id,a.filename,a.mime_type FROM attachments a JOIN memos m ON m.user_id=a.user_id AND m.id=a.memo_id JOIN spaces sp ON sp.user_id=m.user_id AND sp.id=m.space_id WHERE a.user_id=? AND a.deleted=0 AND m.deleted=0 AND sp.deleted=0 AND a.storage_key IS NOT NULL AND a.id IN (SELECT value FROM json_each(m.attachment_ids_json))").bind(user).fetch_all(&mut **tx).await?;
    let mut names: HashMap<String, Vec<String>> = HashMap::new();
    let mut total = 0;
    for file in files {
        match visual_kind(file.get("mime_type")) {
            Some("image") => total += 2, // visual + OCR (even images with no text)
            Some(_) => total += 1,
            None => {}
        }
        names
            .entry(file.get("memo_id"))
            .or_default()
            .push(file.get("filename"));
    }
    let memos = sqlx::query("SELECT m.id,m.body,m.tags_json FROM memos m JOIN spaces sp ON sp.user_id=m.user_id AND sp.id=m.space_id WHERE m.user_id=? AND m.deleted=0 AND sp.deleted=0").bind(user).fetch_all(&mut **tx).await?;
    for memo in memos {
        let id: String = memo.get("id");
        let text = source_text(
            memo.get("body"),
            serde_json::from_str(memo.get("tags_json"))?,
            names.remove(&id).unwrap_or_default().into_iter(),
        );
        if !text.trim().is_empty() {
            total += 1;
        }
    }
    Ok(total)
}
#[derive(Deserialize)]
pub struct Enable {
    enabled: bool,
}
pub async fn update_settings(
    Extension(user): Extension<AuthUser>,
    State(state): State<AppState>,
    Json(input): Json<Enable>,
) -> Result<Json<Settings>, AppError> {
    if input.enabled && !state.config.embeddings.configured() {
        return Err(AppError::BadRequest(
            "Embedding service is not configured".into(),
        ));
    }
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    let old: bool = sqlx::query_scalar("SELECT enabled FROM embedding_accounts WHERE user_id=?")
        .bind(user.user_id)
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or(false);
    if old != input.enabled {
        sqlx::query("INSERT INTO embedding_accounts(user_id,enabled,generation) VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,generation=generation+1,reconcile_cursor='',reconcile_at=0").bind(user.user_id).bind(input.enabled).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM embedding_sources WHERE user_id=?")
            .bind(user.user_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    // The durable account flag is the backfill request. Reconciliation resumes after a crash.
    let _ = state.changes.send(ChangeNotice {
        user_id: user.user_id,
    });
    settings(Extension(user), State(state)).await
}

/// Called within every memo/upload/ingest write transaction. No inference under locks.
pub async fn enqueue_memo(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    memo_id: &str,
) -> Result<(), AppError> {
    let account: Option<i64> = sqlx::query_scalar(
        "SELECT generation FROM embedding_accounts WHERE user_id=? AND enabled=1",
    )
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(generation) = account else {
        return Ok(());
    };
    let memo=sqlx::query("SELECT m.body,m.tags_json,m.attachment_ids_json FROM memos m JOIN spaces sp ON sp.user_id=m.user_id AND sp.id=m.space_id WHERE m.user_id=? AND m.id=? AND m.deleted=0 AND sp.deleted=0").bind(user_id).bind(memo_id).fetch_optional(&mut **tx).await?;
    let Some(memo) = memo else {
        sqlx::query("DELETE FROM embedding_sources WHERE user_id=? AND memo_id=?")
            .bind(user_id)
            .bind(memo_id)
            .execute(&mut **tx)
            .await?;
        return Ok(());
    };
    let ids: String = memo.get("attachment_ids_json");
    let files=sqlx::query("SELECT id,filename,mime_type,storage_key FROM attachments WHERE user_id=? AND memo_id=? AND deleted=0 AND storage_key IS NOT NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY id").bind(user_id).bind(memo_id).bind(&ids).fetch_all(&mut **tx).await?;
    let tags: Vec<String> = serde_json::from_str(memo.get("tags_json"))?;
    let body: String = memo.get("body");
    let text = source_text(
        body,
        tags,
        files.iter().map(|r| r.get::<String, _>("filename")),
    );
    let mut keys = Vec::new();
    if !text.trim().is_empty() {
        let key = format!("m:{memo_id}");
        upsert_source(
            tx,
            Source {
                user_id,
                key: &key,
                memo_id,
                attachment_id: None,
                kind: "text",
                text: &text,
                storage: None,
                generation,
            },
        )
        .await?;
        keys.push(key);
    }
    for file in files {
        let mime: String = file.get("mime_type");
        let Some(kind) = visual_kind(&mime) else {
            continue;
        };
        let id: String = file.get("id");
        let key = format!("a:{id}");
        let storage: String = file.get("storage_key");
        upsert_source(
            tx,
            Source {
                user_id,
                key: &key,
                memo_id,
                attachment_id: Some(&id),
                kind,
                text: "",
                storage: Some(&storage),
                generation,
            },
        )
        .await?;
        keys.push(key);
        if kind == "image" {
            let key = format!("ocr:{id}");
            upsert_source(
                tx,
                Source {
                    user_id,
                    key: &key,
                    memo_id,
                    attachment_id: Some(&id),
                    kind: "ocr",
                    text: "",
                    storage: Some(&storage),
                    generation,
                },
            )
            .await?;
            keys.push(key);
        }
    }
    sqlx::query("DELETE FROM embedding_sources WHERE user_id=? AND memo_id=? AND source_key NOT IN (SELECT value FROM json_each(?))").bind(user_id).bind(memo_id).bind(serde_json::to_string(&keys)?).execute(&mut **tx).await?;
    Ok(())
}
struct Source<'a> {
    user_id: i64,
    key: &'a str,
    memo_id: &'a str,
    attachment_id: Option<&'a str>,
    kind: &'a str,
    text: &'a str,
    storage: Option<&'a str>,
    generation: i64,
}
async fn upsert_source(tx: &mut Transaction<'_, Sqlite>, s: Source<'_>) -> Result<(), AppError> {
    let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&(
        PIPELINE, s.kind, s.text, s.storage,
    ))?));
    let old: Option<(i64, String, i64, String)> = sqlx::query_as(
        "SELECT id,fingerprint,generation,pipeline FROM embedding_sources WHERE user_id=? AND source_key=?",
    )
    .bind(s.user_id)
    .bind(s.key)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some((_, ref hash, generation, ref pipeline)) = old
        && hash == &fingerprint
        && generation == s.generation
        && pipeline == PIPELINE
    {
        return Ok(());
    }
    if let Some((id, _, _, _)) = old {
        sqlx::query("DELETE FROM embedding_sources WHERE id=?")
            .bind(id)
            .execute(&mut **tx)
            .await?;
    }
    let id:i64=sqlx::query_scalar("INSERT INTO embedding_sources(user_id,source_key,memo_id,attachment_id,kind,fingerprint,generation,pipeline,text,storage_key) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id").bind(s.user_id).bind(s.key).bind(s.memo_id).bind(s.attachment_id).bind(s.kind).bind(fingerprint).bind(s.generation).bind(PIPELINE).bind(s.text).bind(s.storage).fetch_one(&mut **tx).await?;
    sqlx::query("INSERT INTO embedding_jobs(source_id) VALUES(?)")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub async fn reconcile_once(state: &AppState) -> Result<(), AppError> {
    // Page by account/memo key; hold a write transaction for only one memo at a time.
    let users: Vec<(i64,i64,String)> =
        sqlx::query_as("SELECT user_id,generation,reconcile_cursor FROM embedding_accounts WHERE enabled=1 AND reconcile_at<=unixepoch()")
            .fetch_all(&state.db)
            .await?;
    for (user, generation, mut after) in users {
        'account: loop {
            let ids: Vec<String> = sqlx::query_scalar(
                "SELECT id FROM memos WHERE user_id=? AND id>? ORDER BY id LIMIT 100",
            )
            .bind(user)
            .bind(&after)
            .fetch_all(&state.db)
            .await?;
            if ids.is_empty() {
                sqlx::query("UPDATE embedding_accounts SET reconcile_cursor='',reconcile_at=unixepoch()+3600 WHERE user_id=? AND enabled=1 AND generation=?").bind(user).bind(generation).execute(&state.db).await?;
                break;
            }
            for id in &ids {
                let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
                enqueue_memo(&mut tx, user, id).await?;
                let updated=sqlx::query("UPDATE embedding_accounts SET reconcile_cursor=? WHERE user_id=? AND enabled=1 AND generation=?").bind(id).bind(user).bind(generation).execute(&mut *tx).await?.rows_affected();
                tx.commit().await?;
                if updated == 0 {
                    break 'account;
                }
                tokio::task::yield_now().await;
            }
            after = ids.last().unwrap().clone();
        }
    }
    Ok(())
}
pub async fn reconcile(state: AppState) {
    loop {
        if let Err(e) = reconcile_once(&state).await {
            tracing::warn!(error=%e,"embedding reconciliation failed");
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}

pub fn worker_routes() -> Router<AppState> {
    Router::new()
        .route("/claim", post(claim))
        .route("/{id}/heartbeat", post(heartbeat))
        .route("/{id}/result", post(result))
        .route("/{id}/file", get(file))
}
pub async fn require_worker(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: middleware::Next,
) -> Result<Response, AppError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    let hash = hex::encode(Sha256::digest(token.as_bytes()));
    if state.config.embeddings.token_hash.as_deref() != Some(hash.as_str()) {
        return Err(AppError::Unauthorized);
    }
    Ok(next.run(request).await)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    id: i64,
    claim_token: String,
    kind: String,
    text: String,
    completed: Vec<i64>,
    pipeline: String,
}
#[derive(Deserialize)]
pub struct Claim {
    pipeline: String,
}
pub async fn claim(
    State(state): State<AppState>,
    Json(input): Json<Claim>,
) -> Result<Json<Option<Job>>, AppError> {
    if input.pipeline != PIPELINE {
        return Err(AppError::BadRequest(
            "Worker pipeline version mismatch".into(),
        ));
    }
    let token = uuid::Uuid::new_v4().to_string();
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    // The UPDATE both selects and claims: concurrent workers cannot own the same lease.
    let id:Option<i64>=sqlx::query_scalar(&format!("UPDATE embedding_jobs SET state='running',claim_token=?,lease_until=unixepoch()+?,attempts=attempts+1 WHERE source_id=(SELECT s.id FROM embedding_sources s JOIN embedding_jobs j ON j.source_id=s.id JOIN embedding_accounts ac ON ac.user_id=s.user_id JOIN memos m ON m.user_id=s.user_id AND m.id=s.memo_id JOIN spaces sp ON sp.user_id=m.user_id AND sp.id=m.space_id LEFT JOIN attachments a ON a.user_id=s.user_id AND a.id=s.attachment_id WHERE ac.enabled=1 AND ac.generation=s.generation AND s.pipeline=? AND {LIVE} AND ((j.state='pending' AND j.retry_at<=unixepoch()) OR (j.state='running' AND j.lease_until<=unixepoch())) ORDER BY j.retry_at,s.id LIMIT 1) RETURNING source_id")).bind(&token).bind(LEASE_SECONDS).bind(PIPELINE).fetch_optional(&mut *tx).await?;
    let Some(id) = id else {
        tx.commit().await?;
        return Ok(Json(None));
    };
    let row = sqlx::query("SELECT kind,text,pipeline FROM embedding_sources WHERE id=?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let completed =
        sqlx::query_scalar("SELECT unit FROM embedding_units WHERE source_id=? ORDER BY unit")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    tx.commit().await?;
    Ok(Json(Some(Job {
        id,
        claim_token: token,
        kind: row.get("kind"),
        text: row.get("text"),
        pipeline: row.get("pipeline"),
        completed,
    })))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    claim_token: String,
}
async fn valid_lease(
    tx: &mut Transaction<'_, Sqlite>,
    id: i64,
    token: &str,
) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar(&format!("SELECT EXISTS(SELECT 1 FROM embedding_jobs j JOIN embedding_sources s ON s.id=j.source_id JOIN embedding_accounts ac ON ac.user_id=s.user_id JOIN memos m ON m.user_id=s.user_id AND m.id=s.memo_id JOIN spaces sp ON sp.user_id=m.user_id AND sp.id=m.space_id LEFT JOIN attachments a ON a.user_id=s.user_id AND a.id=s.attachment_id WHERE s.id=? AND j.claim_token=? AND j.state='running' AND j.lease_until>unixepoch() AND ac.enabled=1 AND ac.generation=s.generation AND s.pipeline=? AND {LIVE})")).bind(id).bind(token).bind(PIPELINE).fetch_one(&mut **tx).await?)
}
pub async fn heartbeat(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(lease): Json<Lease>,
) -> Result<StatusCode, AppError> {
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    if !valid_lease(&mut tx, id, &lease.claim_token).await? {
        return Err(AppError::NotFound);
    }
    sqlx::query("UPDATE embedding_jobs SET lease_until=unixepoch()+? WHERE source_id=?")
        .bind(LEASE_SECONDS)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultInput {
    claim_token: String,
    unit: Option<i64>,
    timestamp: Option<f64>,
    vector: Option<Vec<f32>>,
    #[serde(default)]
    done: bool,
    error: Option<String>,
}
fn vector_bytes(vector: &[f32], dim: usize) -> Result<Vec<u8>, AppError> {
    let norm = vector
        .iter()
        .map(|v| (*v as f64).powi(2))
        .sum::<f64>()
        .sqrt();
    if vector.len() != dim
        || !norm.is_finite()
        || norm < 1e-9
        || vector.iter().any(|v| !v.is_finite())
    {
        return Err(AppError::BadRequest("Invalid embedding vector".into()));
    }
    Ok(vector
        .iter()
        .flat_map(|v| ((*v as f64 / norm) as f32).to_le_bytes())
        .collect())
}
pub async fn result(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<ResultInput>,
) -> Result<StatusCode, AppError> {
    // Reserve the writer before checking the lease. A deferred read transaction
    // cannot upgrade its snapshot while sync/backfill has committed another write.
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    // Lost acknowledgements are safe to replay, including after final completion.
    let replay:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM embedding_jobs WHERE source_id=? AND claim_token=? AND state='done')").bind(id).bind(&input.claim_token).fetch_one(&mut *tx).await?;
    if replay {
        return Ok(StatusCode::NO_CONTENT);
    }
    if !valid_lease(&mut tx, id, &input.claim_token).await? {
        return Err(AppError::NotFound);
    }
    if let Some(error) = input.error {
        sqlx::query("UPDATE embedding_jobs SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,retry_at=unixepoch()+min(3600,30*(1 << min(attempts,7))),lease_until=0,error=? WHERE source_id=?").bind(error.chars().take(300).collect::<String>()).bind(id).execute(&mut *tx).await?;
    } else {
        if let Some(vector) = input.vector {
            let unit = input
                .unit
                .filter(|n| *n >= 0)
                .ok_or_else(|| AppError::BadRequest("Unit index required".into()))?;
            let kind: String = sqlx::query_scalar("SELECT kind FROM embedding_sources WHERE id=?")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
            let bytes = vector_bytes(
                &vector,
                if matches!(kind.as_str(), "text" | "ocr") {
                    TEXT_DIM
                } else {
                    VISUAL_DIM
                },
            )?;
            if input.timestamp.is_some_and(|t| !t.is_finite() || t < 0.0) {
                return Err(AppError::BadRequest("Invalid timestamp".into()));
            }
            sqlx::query("INSERT INTO embedding_units(source_id,unit,timestamp,vector) VALUES(?,?,?,?) ON CONFLICT(source_id,unit) DO NOTHING").bind(id).bind(unit).bind(input.timestamp).bind(bytes).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE embedding_jobs SET state=CASE WHEN ? THEN 'done' ELSE state END,error=NULL WHERE source_id=?").bind(input.done).bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let token = headers
        .get("x-claim-token")
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;
    let mut tx = state.db.begin().await?;
    if !valid_lease(&mut tx, id, token).await? {
        return Err(AppError::NotFound);
    }
    let path: String = sqlx::query_scalar(
        "SELECT storage_key FROM embedding_sources WHERE id=? AND storage_key IS NOT NULL",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    tx.commit().await?;
    let file = tokio::fs::File::open(path).await?;
    let size = file.metadata().await?.len();
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CACHE_CONTROL, "no-store".to_string()),
            (header::CONTENT_LENGTH, size.to_string()),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::new(file)),
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Search {
    query: String,
    space_id: Option<String>,
    #[serde(default)]
    threshold: f32,
    #[serde(default)]
    omit_video: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryVectors {
    pipeline: String,
    text: Vec<f32>,
    visual: Vec<f32>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    memo_id: String,
    score: f32,
    rank_score: f32,
    revision: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    available: bool,
    hits: Vec<Hit>,
    notice: Option<&'static str>,
}
// Relative relevance is a percentile of the SAME fused ranking used for
// Relevant order, not a cosine probability. Adjacent slider values cannot
// expose hundreds of tied generic text vectors in one jump.
fn relative_relevance(rank: usize, count: usize) -> f32 {
    if count <= 1 {
        1.0
    } else {
        1.0 - rank as f32 / (count - 1) as f32
    }
}
pub async fn search(
    Extension(user): Extension<AuthUser>,
    State(state): State<AppState>,
    Json(input): Json<Search>,
) -> Result<Json<SearchResponse>, AppError> {
    if input.query.trim().is_empty()
        || input.query.chars().count() > 2000
        || !input.threshold.is_finite()
        || !(0.0..=1.0).contains(&input.threshold)
    {
        return Err(AppError::BadRequest(
            "Invalid search query or threshold".into(),
        ));
    }
    let enabled: bool =
        sqlx::query_scalar("SELECT enabled FROM embedding_accounts WHERE user_id=?")
            .bind(user.user_id)
            .fetch_optional(&state.db)
            .await?
            .unwrap_or(false);
    let unavailable = || {
        Json(SearchResponse {
            available: false,
            hits: vec![],
            notice: Some("Semantic search is unavailable"),
        })
    };
    if !enabled || !state.config.embeddings.configured() {
        return Ok(unavailable());
    }
    let cfg = &state.config.embeddings;
    let response = state
        .http
        .post(format!("{}/query", cfg.url.as_deref().unwrap()))
        .bearer_auth(cfg.token.as_deref().unwrap())
        .timeout(Duration::from_secs(15))
        .json(&serde_json::json!({"query":input.query}))
        .send()
        .await;
    let vectors = match response {
        Ok(r) if r.status().is_success() => r.json::<QueryVectors>().await.ok(),
        _ => None,
    };
    let Some(vectors) = vectors.filter(|v| v.pipeline == PIPELINE) else {
        return Ok(unavailable());
    };
    let mut merged: HashMap<String, Hit> = HashMap::new();
    for (kind, query, dim) in [
        ("text", vectors.text, TEXT_DIM),
        ("visual", vectors.visual, VISUAL_DIM),
    ] {
        let bytes = match vector_bytes(&query, dim) {
            Ok(b) => b,
            Err(_) => return Ok(unavailable()),
        };
        // Scalar cosine search allows all ACL/live/scope predicates before grouping/limiting.
        // Group per memo first so videos and long memos cannot exhaust the candidate budget.
        let rows=sqlx::query(&format!("SELECT m.id,m.server_seq,MAX(1.0-vec_distance_cosine(u.vector,?)) AS cosine FROM embedding_units u JOIN embedding_sources s ON s.id=u.source_id JOIN embedding_accounts ac ON ac.user_id=s.user_id JOIN memos m ON m.user_id=s.user_id AND m.id=s.memo_id JOIN spaces sp ON sp.user_id=m.user_id AND sp.id=m.space_id LEFT JOIN attachments a ON a.user_id=s.user_id AND a.id=s.attachment_id WHERE s.user_id=? AND ac.enabled=1 AND ac.generation=s.generation AND s.pipeline=? AND {LIVE} AND (? IS NULL OR m.space_id=?) AND (?=0 OR NOT EXISTS(SELECT 1 FROM attachments av WHERE av.user_id=m.user_id AND av.memo_id=m.id AND av.deleted=0 AND av.id IN (SELECT value FROM json_each(m.attachment_ids_json)) AND (lower(trim(av.mime_type)) LIKE 'video/%' OR lower(trim(av.mime_type))='application/mp4'))) AND ((?='text' AND s.kind IN ('text','ocr')) OR (?='visual' AND s.kind IN ('image','video'))) GROUP BY m.id ORDER BY cosine DESC,m.id LIMIT 500")).bind(bytes).bind(user.user_id).bind(PIPELINE).bind(&input.space_id).bind(&input.space_id).bind(input.omit_video).bind(kind).bind(kind).fetch_all(&state.db).await?;
        for (rank, row) in rows.into_iter().enumerate() {
            let id: String = row.get("id");
            let rank_score = 1.0 / (60.0 + rank as f32 + 1.0);
            merged
                .entry(id.clone())
                .and_modify(|h| {
                    h.rank_score += rank_score;
                })
                .or_insert(Hit {
                    memo_id: id,
                    score: 0.0,
                    rank_score,
                    revision: row.get("server_seq"),
                });
        }
    }
    let mut hits: Vec<_> = merged.into_values().collect();
    hits.sort_by(|a, b| {
        b.rank_score
            .total_cmp(&a.rank_score)
            .then(a.memo_id.cmp(&b.memo_id))
    });
    let count = hits.len();
    for (rank, hit) in hits.iter_mut().enumerate() {
        hit.score = relative_relevance(rank, count);
    }
    hits.retain(|hit| hit.score >= input.threshold);
    Ok(Json(SearchResponse {
        available: true,
        hits,
        notice: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, db, models::Profile};
    use std::sync::Arc;

    async fn fixture() -> (tempfile::TempDir, AppState, i64, i64, String) {
        let dir = tempfile::tempdir().unwrap();
        let db = db::connect(dir.path()).await.unwrap();
        let mut users = Vec::new();
        for name in ["one", "two"] {
            users.push(
                db::ensure_user(
                    &db,
                    "https://issuer.test",
                    &Profile {
                        subject: name.into(),
                        display_name: name.into(),
                        groups: vec![],
                    },
                )
                .await
                .unwrap(),
            );
        }
        let space: String = sqlx::query_scalar("SELECT id FROM spaces WHERE user_id=?")
            .bind(users[0])
            .fetch_one(&db)
            .await
            .unwrap();
        let config = Config {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            data_dir: dir.path().into(),
            web_dir: "".into(),
            public_base_url: "http://localhost".into(),
            oidc_issuer: "https://issuer.test".into(),
            oidc_client_id: "".into(),
            oidc_client_secret: "".into(),
            oidc_groups_claim: "groups".into(),
            allowed_groups: Arc::new(vec![]),
            session_key: [0; 32],
            max_attachment_bytes: 1024,
            ingest_token_hash: None,
            embeddings: EmbeddingConfig {
                url: Some("http://127.0.0.1:1".into()),
                token: Some("test-token".into()),
                token_hash: Some(hex::encode(Sha256::digest(b"test-token"))),
            },
        };
        let (changes, _) = tokio::sync::broadcast::channel(8);
        (
            dir,
            AppState {
                config: Arc::new(config),
                db,
                http: reqwest::Client::new(),
                changes,
            },
            users[0],
            users[1],
            space,
        )
    }
    async fn put(state: &AppState, user: i64, space: &str, id: &str, body: &str) {
        let mut tx = state.db.begin().await.unwrap();
        sqlx::query("INSERT INTO memos(user_id,id,space_id,body,created_at,updated_at,server_seq) VALUES(?,?,?,?,'now','now',1) ON CONFLICT(user_id,id) DO UPDATE SET body=excluded.body,server_seq=server_seq+1").bind(user).bind(id).bind(space).bind(body).execute(&mut *tx).await.unwrap();
        enqueue_memo(&mut tx, user, id).await.unwrap();
        tx.commit().await.unwrap();
    }
    async fn enabled(state: &AppState, user: i64, value: bool) {
        let _ = update_settings(
            Extension(AuthUser { user_id: user }),
            State(state.clone()),
            Json(Enable { enabled: value }),
        )
        .await
        .unwrap();
    }
    async fn next(state: &AppState) -> Option<Job> {
        claim(
            State(state.clone()),
            Json(Claim {
                pipeline: PIPELINE.into(),
            }),
        )
        .await
        .unwrap()
        .0
    }
    fn checkpoint(job: &Job, unit: i64, done: bool) -> ResultInput {
        ResultInput {
            claim_token: job.claim_token.clone(),
            unit: Some(unit),
            timestamp: None,
            vector: Some(vec![1.; TEXT_DIM]),
            done,
            error: None,
        }
    }

    #[tokio::test]
    async fn checkpoints_wait_for_another_writer_instead_of_failing_snapshot_upgrade() {
        let (_dir, state, user, _, space) = fixture().await;
        enabled(&state, user, true).await;
        put(&state, user, &space, "memo", "cats").await;
        let job = next(&state).await.unwrap();
        let mut writer = state.db.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query("UPDATE users SET next_seq=next_seq+1 WHERE id=?")
            .bind(user)
            .execute(&mut *writer)
            .await
            .unwrap();
        let task_state = state.clone();
        let input = checkpoint(&job, 0, false);
        let id = job.id;
        let checkpoint_task =
            tokio::spawn(async move { result(State(task_state), Path(id), Json(input)).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!checkpoint_task.is_finished());
        writer.commit().await.unwrap();
        checkpoint_task.await.unwrap().unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM embedding_units WHERE source_id=?")
                .bind(job.id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn completeness_counts_unqueued_content_and_all_media_sources() {
        let (_dir, state, user, _, space) = fixture().await;
        enabled(&state, user, true).await;
        let empty = settings(Extension(AuthUser { user_id: user }), State(state.clone()))
            .await
            .unwrap()
            .0;
        assert_eq!(empty.completeness, 100.0);
        put(&state, user, &space, "memo", "cats").await;
        // Simulate content not yet reached by the initial backfill.
        sqlx::query("INSERT INTO memos(user_id,id,space_id,body,created_at,updated_at,server_seq) VALUES(?,'later',?,'dogs','now','now',2)").bind(user).bind(&space).execute(&state.db).await.unwrap();
        let mut tx = state.db.begin().await.unwrap();
        for (id, mime) in [("photo", "image/png"), ("clip", "application/mp4")] {
            sqlx::query("INSERT INTO attachments(user_id,id,memo_id,filename,mime_type,size,storage_key,created_at) VALUES(?,?,'memo',?,?,1,?,'now')").bind(user).bind(id).bind(id).bind(mime).bind(format!("/tmp/{id}")).execute(&mut *tx).await.unwrap();
        }
        sqlx::query("UPDATE memos SET attachment_ids_json='[\"photo\",\"clip\"]' WHERE user_id=? AND id='memo'").bind(user).execute(&mut *tx).await.unwrap();
        enqueue_memo(&mut tx, user, "memo").await.unwrap();
        tx.commit().await.unwrap();
        let initial = settings(Extension(AuthUser { user_id: user }), State(state.clone()))
            .await
            .unwrap()
            .0;
        assert_eq!(initial.total, 5);
        assert_eq!(initial.pending, 4);
        assert_eq!(initial.completeness, 0.0);
        let job = next(&state).await.unwrap();
        assert_eq!(job.kind, "text");
        result(
            State(state.clone()),
            Path(job.id),
            Json(checkpoint(&job, 0, true)),
        )
        .await
        .unwrap();
        let progress = settings(Extension(AuthUser { user_id: user }), State(state.clone()))
            .await
            .unwrap()
            .0;
        assert_eq!(progress.done, 1);
        assert_eq!(progress.total, 5);
        assert_eq!(progress.completeness, 20.0);
        enabled(&state, user, false).await;
        let disabled = settings(Extension(AuthUser { user_id: user }), State(state.clone()))
            .await
            .unwrap()
            .0;
        assert_eq!(disabled.completeness, 0.0);
        assert_eq!(disabled.total, 0);
    }

    #[tokio::test]
    async fn opt_in_backfill_deduplication_and_reenable_are_durable() {
        let (_dir, state, user, other, space) = fixture().await;
        put(&state, user, &space, "memo", "cats").await;
        let initial = settings(Extension(AuthUser { user_id: user }), State(state.clone()))
            .await
            .unwrap()
            .0;
        assert!(!initial.enabled);
        assert!(next(&state).await.is_none());
        enabled(&state, user, true).await;
        reconcile_once(&state).await.unwrap();
        reconcile_once(&state).await.unwrap();
        assert_eq!(
            settings(Extension(AuthUser { user_id: user }), State(state.clone()))
                .await
                .unwrap()
                .0
                .pending,
            1
        );
        assert_eq!(
            settings(Extension(AuthUser { user_id: other }), State(state.clone()))
                .await
                .unwrap()
                .0
                .pending,
            0
        );
        let old = next(&state).await.unwrap();
        result(
            State(state.clone()),
            Path(old.id),
            Json(checkpoint(&old, 0, true)),
        )
        .await
        .unwrap();
        // Repeated acknowledgement cannot duplicate vectors.
        result(
            State(state.clone()),
            Path(old.id),
            Json(checkpoint(&old, 0, true)),
        )
        .await
        .unwrap();
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM embedding_units")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(n, 1);
        enabled(&state, user, false).await;
        enabled(&state, user, true).await;
        reconcile_once(&state).await.unwrap();
        assert!(
            result(
                State(state.clone()),
                Path(old.id),
                Json(checkpoint(&old, 1, true))
            )
            .await
            .is_err()
        );
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM embedding_units")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(n, 0);
        assert!(next(&state).await.is_some());
    }

    #[tokio::test]
    async fn expired_lease_restarts_from_checkpoints_and_rejects_old_worker() {
        let (_dir, state, user, _, space) = fixture().await;
        enabled(&state, user, true).await;
        put(&state, user, &space, "memo", "cats").await;
        let old = next(&state).await.unwrap();
        result(
            State(state.clone()),
            Path(old.id),
            Json(checkpoint(&old, 0, false)),
        )
        .await
        .unwrap();
        assert!(next(&state).await.is_none());
        sqlx::query("UPDATE embedding_jobs SET lease_until=0")
            .execute(&state.db)
            .await
            .unwrap();
        // Reconnect to the persisted DB, as the server would following a restart.
        let reopened = db::connect(_dir.path()).await.unwrap();
        let mut restarted = state.clone();
        restarted.db = reopened;
        let new = next(&restarted).await.unwrap();
        assert_eq!(new.id, old.id);
        assert_ne!(new.claim_token, old.claim_token);
        assert_eq!(new.completed, vec![0]);
        assert!(
            result(
                State(state.clone()),
                Path(old.id),
                Json(checkpoint(&old, 1, true))
            )
            .await
            .is_err()
        );
        result(
            State(state.clone()),
            Path(new.id),
            Json(checkpoint(&new, 1, true)),
        )
        .await
        .unwrap();
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM embedding_units")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(n, 2);
    }

    #[tokio::test]
    async fn edits_supersede_inflight_work_and_bumps_do_not_reembed() {
        let (_dir, state, user, _, space) = fixture().await;
        enabled(&state, user, true).await;
        put(&state, user, &space, "memo", "cats").await;
        let old = next(&state).await.unwrap();
        put(&state, user, &space, "memo", "cats").await;
        assert!(next(&state).await.is_none());
        put(&state, user, &space, "memo", "dogs").await;
        assert!(
            result(
                State(state.clone()),
                Path(old.id),
                Json(checkpoint(&old, 0, true))
            )
            .await
            .is_err()
        );
        let new = next(&state).await.unwrap();
        assert_eq!(new.text, "dogs");
        sqlx::query("UPDATE memos SET deleted=1 WHERE user_id=?")
            .bind(user)
            .execute(&state.db)
            .await
            .unwrap();
        assert!(
            result(
                State(state.clone()),
                Path(new.id),
                Json(checkpoint(&new, 0, true))
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn query_filters_account_and_space_before_limiting_and_groups_units() {
        let (_dir, mut state, user, other, space) = fixture().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let query=Router::new().route("/query",post(||async {Json(serde_json::json!({"pipeline":PIPELINE,"text":vec![1.;TEXT_DIM],"visual":vec![1.;VISUAL_DIM]}))}));
        let service = tokio::spawn(async move { axum::serve(listener, query).await.unwrap() });
        Arc::make_mut(&mut state.config).embeddings.url = Some(url);
        enabled(&state, user, true).await;
        enabled(&state, other, true).await;
        put(&state, user, &space, "same-id", "cats").await;
        let other_space: String = sqlx::query_scalar("SELECT id FROM spaces WHERE user_id=?")
            .bind(other)
            .fetch_one(&state.db)
            .await
            .unwrap();
        put(&state, other, &other_space, "private", "cats").await;
        while let Some(job) = next(&state).await {
            result(
                State(state.clone()),
                Path(job.id),
                Json(checkpoint(&job, 0, false)),
            )
            .await
            .unwrap();
            result(
                State(state.clone()),
                Path(job.id),
                Json(checkpoint(&job, 1, true)),
            )
            .await
            .unwrap();
        }
        let run = |space_id| {
            search(
                Extension(AuthUser { user_id: user }),
                State(state.clone()),
                Json(Search {
                    query: "cats".into(),
                    space_id,
                    threshold: 0.5,
                    omit_video: false,
                }),
            )
        };
        let all = run(None).await.unwrap().0;
        assert!(all.available);
        assert_eq!(all.hits.len(), 1);
        assert_eq!(all.hits[0].memo_id, "same-id");
        assert!(run(Some(other_space)).await.unwrap().0.hits.is_empty());
        sqlx::query("UPDATE spaces SET deleted=1 WHERE user_id=?")
            .bind(user)
            .execute(&state.db)
            .await
            .unwrap();
        assert!(run(None).await.unwrap().0.hits.is_empty());
        service.abort();
        assert!(!run(None).await.unwrap().0.available);
    }

    #[tokio::test]
    async fn pipeline_upgrade_restarts_reconciliation_and_ocr_is_derived_only() {
        let (_dir, state, user, _, space) = fixture().await;
        enabled(&state, user, true).await;
        put(&state, user, &space, "photo", "original memo").await;
        let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query("INSERT INTO attachments(user_id,id,memo_id,filename,mime_type,size,storage_key,created_at) VALUES(?,'image','photo','meme.png','image/png',1,'/tmp/image','now')").bind(user).execute(&mut *tx).await.unwrap();
        sqlx::query(
            "UPDATE memos SET attachment_ids_json='[\"image\"]' WHERE user_id=? AND id='photo'",
        )
        .bind(user)
        .execute(&mut *tx)
        .await
        .unwrap();
        enqueue_memo(&mut tx, user, "photo").await.unwrap();
        tx.commit().await.unwrap();
        sqlx::query("UPDATE embedding_sources SET pipeline='old'")
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE embedding_accounts SET reconcile_cursor='zzz',reconcile_at=unixepoch()+3600",
        )
        .execute(&state.db)
        .await
        .unwrap();
        migrate(&state.db).await.unwrap();
        let cursor: String =
            sqlx::query_scalar("SELECT reconcile_cursor FROM embedding_accounts WHERE user_id=?")
                .bind(user)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(cursor, "");
        reconcile_once(&state).await.unwrap();
        let mut found_ocr = false;
        while let Some(job) = next(&state).await {
            let mut input = checkpoint(&job, 0, true);
            if job.kind == "image" {
                input.vector = Some(vec![1.; VISUAL_DIM]);
            }
            found_ocr |= job.kind == "ocr";
            result(State(state.clone()), Path(job.id), Json(input))
                .await
                .unwrap();
        }
        assert!(found_ocr);
        let body: String =
            sqlx::query_scalar("SELECT body FROM memos WHERE user_id=? AND id='photo'")
                .bind(user)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(body, "original memo");
        let progress = settings(Extension(AuthUser { user_id: user }), State(state.clone()))
            .await
            .unwrap()
            .0;
        assert_eq!((progress.done, progress.total), (3, 3));
        assert_eq!(progress.completeness, 100.0);
    }

    #[tokio::test]
    async fn video_omission_precedes_the_candidate_budget_and_covers_text_matches() {
        let (_dir, mut state, user, _, space) = fixture().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let service = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/query", post(|| async {
                Json(serde_json::json!({"pipeline":PIPELINE,"text":vec![1.;TEXT_DIM],"visual":vec![1.;VISUAL_DIM]}))
            }))).await.unwrap()
        });
        Arc::make_mut(&mut state.config).embeddings.url = Some(url);
        enabled(&state, user, true).await;
        // More video memos than the per-model candidate limit. The remaining
        // non-video memo must still be found when videos are omitted.
        let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await.unwrap();
        for i in 0..502 {
            let id = format!("memo-{i:04}");
            let video = i < 501;
            let ids = if video {
                format!("[\"{id}\"]")
            } else {
                "[]".into()
            };
            sqlx::query("INSERT INTO memos(user_id,id,space_id,body,attachment_ids_json,created_at,updated_at,server_seq) VALUES(?,?,?,'cat',?,'now','now',1)").bind(user).bind(&id).bind(&space).bind(ids).execute(&mut *tx).await.unwrap();
            if video {
                sqlx::query("INSERT INTO attachments(user_id,id,memo_id,filename,mime_type,size,storage_key,created_at) VALUES(?,?,?,'clip.mp4','application/mp4',1,'/tmp/clip','now')").bind(user).bind(&id).bind(&id).execute(&mut *tx).await.unwrap();
            }
            let source: i64 = sqlx::query_scalar("INSERT INTO embedding_sources(user_id,source_key,memo_id,kind,fingerprint,generation,pipeline) VALUES(?,?,?,'text','test',1,?) RETURNING id").bind(user).bind(&id).bind(&id).bind(PIPELINE).fetch_one(&mut *tx).await.unwrap();
            sqlx::query("INSERT INTO embedding_units(source_id,unit,vector) VALUES(?,0,?)")
                .bind(source)
                .bind(vector_bytes(&vec![1.; TEXT_DIM], TEXT_DIM).unwrap())
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
        let run = |omit_video| {
            search(
                Extension(AuthUser { user_id: user }),
                State(state.clone()),
                Json(Search {
                    query: "cat".into(),
                    space_id: None,
                    threshold: 0.,
                    omit_video,
                }),
            )
        };
        assert_eq!(run(false).await.unwrap().0.hits.len(), 500);
        let omitted = run(true).await.unwrap().0;
        assert_eq!(omitted.hits.len(), 1);
        assert_eq!(omitted.hits[0].memo_id, "memo-0501");
        service.abort();
    }

    #[test]
    fn relative_relevance_is_smooth_and_vectors_are_validated() {
        assert_eq!(relative_relevance(0, 249), 1.0);
        assert_eq!(relative_relevance(248, 249), 0.0);
        assert_eq!(relative_relevance(0, 1), 1.0);
        let count = |threshold| {
            (0..249)
                .filter(|&i| relative_relevance(i, 249) >= threshold)
                .count()
        };
        assert!((count(0.43) as i32 - count(0.44) as i32).abs() <= 3);
        assert!(vector_bytes(&[0., 0.], 2).is_err());
        assert!(vector_bytes(&[f32::NAN], 1).is_err());
        assert!(vector_bytes(&[1.], 384).is_err());
        assert!(vector_bytes(&[f32::MAX; 384], 384).is_ok());
    }
}
