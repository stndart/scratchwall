use crate::{
    AppState, ChangeNotice, auth,
    error::AppError,
    models::{Attachment, Memo, Space},
    sync,
};
use axum::{
    Json,
    extract::{Multipart, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Redirect, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use image::ImageEncoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::path::{Path as FsPath, PathBuf};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const THUMBNAIL_MAX_EDGE: u32 = 960;
const THUMBNAIL_MAX_BYTES: usize = 512 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestResponse {
    pub memo_id: String,
    pub space_id: String,
}

struct StagedFile {
    filename: String,
    mime_type: String,
    size: i64,
    digest: String,
    temp_path: PathBuf,
    thumbnail: Option<String>,
}

pub async fn ingest(
    State(state): State<AppState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Json<IngestResponse>, AppError> {
    verify_ingest_token(&state, &headers)?;
    let parsed = match parse_multipart(&state, multipart).await {
        Ok(parsed) => parsed,
        Err((error, temps)) => {
            for path in temps {
                let _ = tokio::fs::remove_file(path).await;
            }
            return Err(error);
        }
    };
    let user_id = resolve_ingest_user(&state, parsed.telegram_user_id).await?;
    match commit_ingest(&state, user_id, parsed).await {
        Ok(response) => Ok(Json(response)),
        Err((error, temps)) => {
            for path in temps {
                let _ = tokio::fs::remove_file(path).await;
            }
            Err(error)
        }
    }
}

fn verify_ingest_token(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let Some(expected) = state.config.ingest_token_hash.as_deref() else {
        return Err(AppError::Unauthorized);
    };
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    if !hashes_match(expected, &auth::token_hash(provided)) {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}

async fn resolve_ingest_user(state: &AppState, telegram_user_id: i64) -> Result<i64, AppError> {
    sqlx::query_scalar("SELECT user_id FROM telegram_binds WHERE telegram_user_id=?")
        .bind(telegram_user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::Denied("telegram account is not connected".into()))
}

fn hashes_match(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramBindRequest {
    telegram_user_id: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramBindResponse {
    pub url: Option<String>,
    pub display_name: Option<String>,
}

pub async fn create_telegram_bind(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<TelegramBindRequest>,
) -> Result<Json<TelegramBindResponse>, AppError> {
    verify_ingest_token(&state, &headers)?;
    if let Some(display_name) = bound_display_name(&state, input.telegram_user_id).await? {
        return Ok(Json(TelegramBindResponse {
            url: None,
            display_name: Some(display_name),
        }));
    }
    let token = auth::random_token(32);
    let expires = Utc::now().timestamp() + 600;
    sqlx::query("DELETE FROM telegram_bind_challenges WHERE telegram_user_id=?")
        .bind(input.telegram_user_id)
        .execute(&state.db)
        .await?;
    sqlx::query(
        "INSERT INTO telegram_bind_challenges(token_hash,telegram_user_id,expires_at) VALUES(?,?,?)",
    )
    .bind(auth::token_hash(&token))
    .bind(input.telegram_user_id)
    .bind(expires)
    .execute(&state.db)
    .await?;
    Ok(Json(TelegramBindResponse {
        url: Some(format!(
            "{}/telegram/bind/{token}",
            state.config.public_base_url
        )),
        display_name: None,
    }))
}

pub async fn complete_telegram_bind(
    State(state): State<AppState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    match complete_telegram_bind_inner(&state, &token, &headers).await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(error = %error, "telegram bind failed");
            bind_html(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not connect Telegram. Try /login again.",
            )
        }
    }
}

async fn complete_telegram_bind_inner(
    state: &AppState,
    token: &str,
    headers: &HeaderMap,
) -> Result<Response, AppError> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT telegram_user_id FROM telegram_bind_challenges WHERE token_hash=? AND expires_at>?",
    )
    .bind(auth::token_hash(token))
    .bind(Utc::now().timestamp())
    .fetch_optional(&state.db)
    .await?;
    if found.is_none() {
        return Ok(bind_html(
            StatusCode::BAD_REQUEST,
            "This connect link is invalid or expired. Send /login in Telegram for a new one.",
        ));
    }
    let Some(user_id) = auth::session_user_id(state, headers).await? else {
        let next = format!("/telegram/bind/{token}");
        return Ok(
            Redirect::to(&format!("/api/v1/auth/login?mode=web&next={next}")).into_response(),
        );
    };
    let telegram_user_id: Option<i64> = sqlx::query_scalar(
        "DELETE FROM telegram_bind_challenges WHERE token_hash=? AND expires_at>? RETURNING telegram_user_id",
    )
    .bind(auth::token_hash(token))
    .bind(Utc::now().timestamp())
    .fetch_optional(&state.db)
    .await?;
    let Some(telegram_user_id) = telegram_user_id else {
        return Ok(bind_html(
            StatusCode::BAD_REQUEST,
            "This connect link is invalid or expired. Send /login in Telegram for a new one.",
        ));
    };
    sqlx::query(
        "INSERT INTO telegram_binds(telegram_user_id,user_id,created_at) VALUES(?,?,unixepoch()) ON CONFLICT(telegram_user_id) DO UPDATE SET user_id=excluded.user_id",
    )
    .bind(telegram_user_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;
    let display_name = crate::db::profile_for_user(&state.db, user_id)
        .await
        .map_err(AppError::Internal)?
        .display_name;
    Ok(bind_html(
        StatusCode::OK,
        &format!(
            "Telegram connected as {}. You can close this tab.",
            escape_html(&display_name)
        ),
    ))
}

async fn bound_display_name(
    state: &AppState,
    telegram_user_id: i64,
) -> Result<Option<String>, AppError> {
    Ok(
        sqlx::query_scalar("SELECT u.display_name FROM telegram_binds b JOIN users u ON u.id=b.user_id WHERE b.telegram_user_id=?")
            .bind(telegram_user_id)
            .fetch_optional(&state.db)
            .await?,
    )
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn bind_html(status: StatusCode, message: &str) -> Response {
    let html = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scratchwall</title></head><body style="font-family:system-ui;background:#101218;color:#eef0f7;display:grid;place-items:center;min-height:100vh;margin:0"><main style="text-align:center;padding:24px;max-width:28rem"><p>{message}</p></main></body></html>"#
    );
    (status, Html(html)).into_response()
}

struct ParsedIngest {
    telegram_user_id: i64,
    space: String,
    body: String,
    idempotency_key: String,
    files: Vec<StagedFile>,
}

async fn parse_multipart(
    state: &AppState,
    mut multipart: Multipart,
) -> Result<ParsedIngest, (AppError, Vec<PathBuf>)> {
    let mut telegram_user_id: Option<i64> = None;
    let mut space = String::new();
    let mut body = String::new();
    let mut idempotency_key = String::new();
    let mut files = Vec::new();
    let staging = state.config.data_dir.join("uploads").join("ingest");
    if let Err(error) = tokio::fs::create_dir_all(&staging).await {
        return Err((error.into(), Vec::new()));
    }

    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(error) => {
                return Err((
                    AppError::BadRequest(error.to_string()),
                    staged_paths(&files),
                ));
            }
        };
        let name = field.name().unwrap_or("").to_string();
        let result = match name.as_str() {
            "telegramUserId" => field_text(field).await.and_then(|value| {
                let parsed = value
                    .trim()
                    .parse::<i64>()
                    .map_err(|_| AppError::BadRequest("telegramUserId is invalid".into()))?;
                telegram_user_id = Some(parsed);
                Ok(())
            }),
            "space" => field_text(field).await.map(|value| space = value),
            "body" => field_text(field).await.map(|value| body = value),
            "idempotencyKey" => field_text(field).await.map(|value| idempotency_key = value),
            "file" => match stage_file(state, &staging, field).await {
                Ok(Some(file)) => {
                    files.push(file);
                    Ok(())
                }
                Ok(None) => Ok(()),
                Err(error) => Err(error),
            },
            _ => {
                let _ = field.bytes().await;
                Ok(())
            }
        };
        if let Err(error) = result {
            return Err((error, staged_paths(&files)));
        }
    }

    let space = space.trim().to_string();
    let temps = staged_paths(&files);
    let Some(telegram_user_id) = telegram_user_id else {
        return Err((
            AppError::BadRequest("telegramUserId is required".into()),
            temps,
        ));
    };
    if space.is_empty() || space.len() > 200 {
        return Err((AppError::BadRequest("space name is required".into()), temps));
    }
    let idempotency_key = idempotency_key.trim().to_string();
    if idempotency_key.is_empty() || idempotency_key.len() > 256 {
        return Err((
            AppError::BadRequest("idempotencyKey is required".into()),
            temps,
        ));
    }
    if body.is_empty() && files.is_empty() {
        return Err((
            AppError::BadRequest("body or file is required".into()),
            temps,
        ));
    }
    Ok(ParsedIngest {
        telegram_user_id,
        space,
        body,
        idempotency_key,
        files,
    })
}

fn staged_paths(files: &[StagedFile]) -> Vec<PathBuf> {
    files.iter().map(|file| file.temp_path.clone()).collect()
}

async fn field_text(field: axum::extract::multipart::Field<'_>) -> Result<String, AppError> {
    field
        .text()
        .await
        .map_err(|error| AppError::BadRequest(error.to_string()))
}

async fn stage_file(
    state: &AppState,
    staging: &FsPath,
    mut field: axum::extract::multipart::Field<'_>,
) -> Result<Option<StagedFile>, AppError> {
    let filename = safe_filename(field.file_name().unwrap_or("file"));
    let mime_type = field
        .content_type()
        .map(ToOwned::to_owned)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            mime_guess::from_path(&filename)
                .first_or_octet_stream()
                .essence_str()
                .to_owned()
        });
    let temp_path = staging.join(format!("ingest-{}.part", Uuid::now_v7()));
    let mut file = tokio::fs::File::create(&temp_path).await?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|error| AppError::BadRequest(error.to_string()))?
    {
        size += chunk.len() as u64;
        if size > state.config.max_attachment_bytes {
            drop(file);
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(AppError::BadRequest(format!(
                "attachment exceeds {} bytes",
                state.config.max_attachment_bytes
            )));
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    if size == 0 {
        drop(file);
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Ok(None);
    }
    let digest = hex::encode(hasher.finalize());
    let is_image = mime_type.starts_with("image/");
    let thumbnail = if is_image {
        let bytes = tokio::fs::read(&temp_path).await.ok();
        bytes
            .as_deref()
            .and_then(|data| thumbnail_data_url(data, true))
    } else {
        None
    };
    Ok(Some(StagedFile {
        filename,
        mime_type,
        size: size as i64,
        digest,
        temp_path,
        thumbnail,
    }))
}

fn safe_filename(name: &str) -> String {
    let base = name.replace('\\', "/");
    let base = base.rsplit('/').next().unwrap_or("file");
    let cleaned: String = base
        .chars()
        .filter(|ch| *ch != '\0' && *ch != '\n' && *ch != '\r' && *ch != '"')
        .take(1024)
        .collect();
    if cleaned.is_empty() {
        "file".into()
    } else {
        cleaned
    }
}

fn thumbnail_data_url(bytes: &[u8], is_image: bool) -> Option<String> {
    if !is_image {
        return None;
    }
    let decoded = image::load_from_memory(bytes).ok()?;
    let thumb = decoded.thumbnail(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE);
    let rgb = thumb.to_rgb8();
    let mut encoded = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 76)
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .ok()?;
    if encoded.is_empty() || encoded.len() > THUMBNAIL_MAX_BYTES {
        return None;
    }
    Some(format!(
        "data:image/jpeg;base64,{}",
        STANDARD.encode(encoded)
    ))
}

fn starts_with_ignore_ascii(value: &str, prefix: &str) -> bool {
    value.len() >= prefix.len()
        && value.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

fn strip_urls(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while !rest.is_empty() {
        if starts_with_ignore_ascii(rest, "https://") || starts_with_ignore_ascii(rest, "http://") {
            let skip = rest.find(char::is_whitespace).unwrap_or(rest.len());
            out.push(' ');
            rest = &rest[skip..];
        } else {
            let ch = rest.chars().next().expect("rest is non-empty");
            out.push(ch);
            rest = &rest[ch.len_utf8()..];
        }
    }
    out
}

fn is_tag_start(ch: char) -> bool {
    ch.is_alphabetic() || ch.is_numeric()
}

fn is_tag_continue(ch: char) -> bool {
    is_tag_start(ch) || ch == '_' || ch == '-'
}

pub(crate) fn parse_tags(body: &str) -> Vec<String> {
    let cleaned = strip_urls(body);
    let chars: Vec<char> = cleaned.chars().collect();
    let mut tags = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' {
            let prev_ok = i == 0 || !is_tag_continue(chars[i - 1]);
            if prev_ok && i + 1 < chars.len() && is_tag_start(chars[i + 1]) {
                let start = i + 1;
                let mut end = start + 1;
                while end < chars.len() && is_tag_continue(chars[end]) {
                    end += 1;
                }
                let tag: String = chars[start..end].iter().collect();
                let key = tag.to_lowercase();
                if !tags.iter().any(|(existing, _)| existing == &key) {
                    tags.push((key, tag));
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
    tags.into_iter().map(|(_, tag)| tag).collect()
}

async fn commit_ingest(
    state: &AppState,
    user_id: i64,
    parsed: ParsedIngest,
) -> Result<IngestResponse, (AppError, Vec<PathBuf>)> {
    let temps: Vec<PathBuf> = parsed
        .files
        .iter()
        .map(|file| file.temp_path.clone())
        .collect();
    let result = commit_ingest_inner(state, user_id, parsed).await;
    match result {
        Ok(response) => {
            for path in &temps {
                let _ = tokio::fs::remove_file(path).await;
            }
            Ok(response)
        }
        Err(error) => Err((error, temps)),
    }
}

async fn commit_ingest_inner(
    state: &AppState,
    user_id: i64,
    parsed: ParsedIngest,
) -> Result<IngestResponse, AppError> {
    if let Some(existing) = existing_ingest(&state.db, user_id, &parsed.idempotency_key).await? {
        return Ok(existing);
    }

    let memo_id = Uuid::now_v7().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let tags = parse_tags(&parsed.body);
    let mut prepared = Vec::with_capacity(parsed.files.len());
    let blob_dir = state
        .config
        .data_dir
        .join("blobs")
        .join(user_id.to_string());
    tokio::fs::create_dir_all(&blob_dir).await?;

    for file in parsed.files {
        let attachment_id = Uuid::now_v7().to_string();
        let blob_path = blob_dir.join(format!("{}-{}", attachment_id, file.digest));
        tokio::fs::copy(&file.temp_path, &blob_path).await?;
        tokio::fs::OpenOptions::new()
            .write(true)
            .open(&blob_path)
            .await?
            .sync_all()
            .await?;
        prepared.push((attachment_id, blob_path, file));
    }

    let mut transaction = state.db.begin().await?;
    if let Some(existing) =
        existing_ingest_tx(&mut transaction, user_id, &parsed.idempotency_key).await?
    {
        transaction.rollback().await?;
        for (_, blob_path, _) in prepared {
            let _ = tokio::fs::remove_file(blob_path).await;
        }
        return Ok(existing);
    }

    let space = ensure_space(&mut transaction, user_id, &parsed.space, &now).await?;
    let attachment_ids: Vec<String> = prepared.iter().map(|(id, _, _)| id.clone()).collect();
    let memo = Memo {
        id: memo_id.clone(),
        space_id: space.id.clone(),
        body: parsed.body,
        tags,
        attachment_ids,
        created_at: now.clone(),
        bumped_at: Some(now.clone()),
        updated_at: now.clone(),
        sync_state: "synced".into(),
    };
    let seq = sync::next_seq(&mut transaction, user_id).await?;
    sqlx::query("INSERT INTO memos(user_id,id,space_id,body,tags_json,attachment_ids_json,created_at,updated_at,deleted,server_seq) VALUES(?,?,?,?,?,?,?,?,0,?)")
        .bind(user_id)
        .bind(&memo.id)
        .bind(&memo.space_id)
        .bind(&memo.body)
        .bind(serde_json::to_string(&memo.tags)?)
        .bind(serde_json::to_string(&memo.attachment_ids)?)
        .bind(&memo.created_at)
        .bind(&memo.updated_at)
        .bind(seq)
        .execute(&mut *transaction)
        .await?;
    sync::record_change(
        &mut transaction,
        user_id,
        seq,
        "memo",
        &memo.id,
        "upsert",
        Some(&memo),
    )
    .await?;

    for (attachment_id, blob_path, file) in &prepared {
        let attachment = Attachment {
            id: attachment_id.clone(),
            memo_id: memo.id.clone(),
            filename: file.filename.clone(),
            mime_type: file.mime_type.clone(),
            size: file.size,
            thumbnail: file.thumbnail.clone(),
            remote_ready: true,
            cache_state: "remote".into(),
            created_at: now.clone(),
        };
        let seq = sync::next_seq(&mut transaction, user_id).await?;
        sqlx::query("INSERT INTO attachments(user_id,id,memo_id,filename,mime_type,size,thumbnail,storage_key,created_at,deleted,server_seq) VALUES(?,?,?,?,?,?,?,?,?,0,?)")
            .bind(user_id)
            .bind(&attachment.id)
            .bind(&attachment.memo_id)
            .bind(&attachment.filename)
            .bind(&attachment.mime_type)
            .bind(attachment.size)
            .bind(&attachment.thumbnail)
            .bind(blob_path.to_string_lossy().as_ref())
            .bind(&attachment.created_at)
            .bind(seq)
            .execute(&mut *transaction)
            .await?;
        sync::record_change(
            &mut transaction,
            user_id,
            seq,
            "attachment",
            &attachment.id,
            "upsert",
            Some(&attachment),
        )
        .await?;
    }

    sqlx::query("INSERT INTO ingest_ops(user_id,idempotency_key,memo_id,space_id,created_at) VALUES(?,?,?,?,unixepoch())")
        .bind(user_id)
        .bind(&parsed.idempotency_key)
        .bind(&memo.id)
        .bind(&space.id)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    let _ = state.changes.send(ChangeNotice { user_id });
    tracing::info!(user_id, memo_id = %memo.id, space = %space.name, files = prepared.len(), "ingest complete");
    Ok(IngestResponse {
        memo_id: memo.id,
        space_id: space.id,
    })
}

async fn existing_ingest(
    pool: &sqlx::SqlitePool,
    user_id: i64,
    key: &str,
) -> Result<Option<IngestResponse>, AppError> {
    let row = sqlx::query(
        "SELECT memo_id,space_id FROM ingest_ops WHERE user_id=? AND idempotency_key=?",
    )
    .bind(user_id)
    .bind(key)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| IngestResponse {
        memo_id: row.get("memo_id"),
        space_id: row.get("space_id"),
    }))
}

async fn existing_ingest_tx(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    user_id: i64,
    key: &str,
) -> Result<Option<IngestResponse>, AppError> {
    let row = sqlx::query(
        "SELECT memo_id,space_id FROM ingest_ops WHERE user_id=? AND idempotency_key=?",
    )
    .bind(user_id)
    .bind(key)
    .fetch_optional(&mut **transaction)
    .await?;
    Ok(row.map(|row| IngestResponse {
        memo_id: row.get("memo_id"),
        space_id: row.get("space_id"),
    }))
}

async fn ensure_space(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    user_id: i64,
    name: &str,
    now: &str,
) -> Result<Space, AppError> {
    if let Some(row) = sqlx::query(
        "SELECT id,name,position,is_inbox,created_at,updated_at FROM spaces WHERE user_id=? AND deleted=0 AND LOWER(name)=LOWER(?) ORDER BY position ASC, created_at ASC LIMIT 1",
    )
    .bind(user_id)
    .bind(name)
    .fetch_optional(&mut **transaction)
    .await?
    {
        return Ok(Space {
            id: row.get("id"),
            name: row.get("name"),
            position: row.get("position"),
            is_inbox: row.get::<i64, _>("is_inbox") != 0,
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            sync_state: "synced".into(),
        });
    }
    let position: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM spaces WHERE user_id=? AND deleted=0",
    )
    .bind(user_id)
    .fetch_one(&mut **transaction)
    .await?;
    let space = Space {
        id: Uuid::now_v7().to_string(),
        name: name.to_owned(),
        position,
        is_inbox: false,
        created_at: now.to_owned(),
        updated_at: now.to_owned(),
        sync_state: "synced".into(),
    };
    let seq = sync::next_seq(transaction, user_id).await?;
    sqlx::query("INSERT INTO spaces(user_id,id,name,position,is_inbox,created_at,updated_at,deleted,server_seq) VALUES(?,?,?,?,0,?,?,0,?)")
        .bind(user_id)
        .bind(&space.id)
        .bind(&space.name)
        .bind(space.position)
        .bind(&space.created_at)
        .bind(&space.updated_at)
        .bind(seq)
        .execute(&mut **transaction)
        .await?;
    sync::record_change(
        transaction,
        user_id,
        seq,
        "space",
        &space.id,
        "upsert",
        Some(&space),
    )
    .await?;
    Ok(space)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{auth::token_hash, config::Config, db, models::Profile};
    use axum::{
        Router,
        extract::DefaultBodyLimit,
        routing::{get, post},
    };
    use std::sync::Arc;

    fn tiny_png() -> Vec<u8> {
        let mut pixels = image::RgbImage::new(8, 8);
        for pixel in pixels.pixels_mut() {
            *pixel = image::Rgb([220, 40, 40]);
        }
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(
                pixels.as_raw(),
                pixels.width(),
                pixels.height(),
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        bytes
    }

    fn config(data_dir: PathBuf, ingest_token_hash: Option<String>) -> Config {
        Config {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            data_dir,
            web_dir: ".".into(),
            public_base_url: "https://scratch.test".into(),
            oidc_issuer: "https://issuer.test".into(),
            oidc_client_id: "test".into(),
            oidc_client_secret: "test".into(),
            oidc_groups_claim: "groups".into(),
            allowed_groups: Arc::new(vec!["admins".into()]),
            session_key: [1; 32],
            max_attachment_bytes: 2_147_483_648,
            ingest_token_hash,
        }
    }

    async fn start_server(
        ingest_token: &str,
        extra_user: bool,
    ) -> (tempfile::TempDir, String, reqwest::Client) {
        let directory = tempfile::tempdir().unwrap();
        let db = db::connect(directory.path()).await.unwrap();
        db::ensure_user(
            &db,
            "https://issuer.test",
            &Profile {
                subject: "one".into(),
                display_name: "One".into(),
                groups: vec!["admins".into()],
            },
        )
        .await
        .unwrap();
        if extra_user {
            db::ensure_user(
                &db,
                "https://issuer.test",
                &Profile {
                    subject: "two".into(),
                    display_name: "Two".into(),
                    groups: vec!["admins".into()],
                },
            )
            .await
            .unwrap();
        }
        let (changes, _) = tokio::sync::broadcast::channel(8);
        let state = AppState {
            config: Arc::new(config(
                directory.path().into(),
                Some(token_hash(ingest_token)),
            )),
            db,
            http: reqwest::Client::new(),
            changes,
        };
        let app = Router::new()
            .route("/api/v1/ingest", post(ingest))
            .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
            .route("/api/v1/ingest/telegram/bind", post(create_telegram_bind))
            .route("/telegram/bind/{token}", get(complete_telegram_bind))
            .route("/api/v1/auth/login", get(crate::auth::login))
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
        (directory, format!("http://{addr}"), client)
    }

    async fn bind_telegram(
        directory: &tempfile::TempDir,
        telegram_user_id: i64,
        display_name: &str,
    ) {
        let pool = pool(directory).await;
        let user_id: i64 = sqlx::query_scalar("SELECT id FROM users WHERE display_name=?")
            .bind(display_name)
            .fetch_one(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO telegram_binds(telegram_user_id,user_id,created_at) VALUES(?,?,unixepoch())",
        )
        .bind(telegram_user_id)
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap();
    }

    async fn insert_session(directory: &tempfile::TempDir, display_name: &str, token: &str) {
        let pool = pool(directory).await;
        let user_id: i64 = sqlx::query_scalar("SELECT id FROM users WHERE display_name=?")
            .bind(display_name)
            .fetch_one(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sessions(id,token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?,unixepoch())",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(token_hash(token))
        .bind(user_id)
        .bind(chrono::Utc::now().timestamp() + 3600)
        .execute(&pool)
        .await
        .unwrap();
    }

    async fn pool(directory: &tempfile::TempDir) -> sqlx::SqlitePool {
        sqlx::SqlitePool::connect(&format!(
            "sqlite://{}",
            directory.path().join("scratchwall.sqlite3").display()
        ))
        .await
        .unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    async fn post_ingest(
        client: &reqwest::Client,
        base: &str,
        token: &str,
        telegram_user_id: Option<i64>,
        space: &str,
        body: &str,
        key: &str,
        file: Option<(&str, &str, Vec<u8>)>,
    ) -> reqwest::Response {
        let mut form = reqwest::multipart::Form::new()
            .text("space", space.to_owned())
            .text("body", body.to_owned())
            .text("idempotencyKey", key.to_owned());
        if let Some(telegram_user_id) = telegram_user_id {
            form = form.text("telegramUserId", telegram_user_id.to_string());
        }
        if let Some((filename, mime, bytes)) = file {
            form = form.part(
                "file",
                reqwest::multipart::Part::bytes(bytes)
                    .file_name(filename.to_owned())
                    .mime_str(mime)
                    .unwrap(),
            );
        }
        client
            .post(format!("{base}/api/v1/ingest"))
            .bearer_auth(token)
            .multipart(form)
            .send()
            .await
            .unwrap()
    }

    async fn post_bind(
        client: &reqwest::Client,
        base: &str,
        token: &str,
        telegram_user_id: i64,
    ) -> reqwest::Response {
        client
            .post(format!("{base}/api/v1/ingest/telegram/bind"))
            .bearer_auth(token)
            .json(&serde_json::json!({ "telegramUserId": telegram_user_id }))
            .send()
            .await
            .unwrap()
    }

    #[test]
    fn parse_tags_skips_urls_and_keeps_hashtags() {
        assert_eq!(
            parse_tags("see https://example.com/a#frag and #Meme plus #meme"),
            vec!["Meme".to_string()]
        );
        assert_eq!(
            parse_tags("#watch-later ok"),
            vec!["watch-later".to_string()]
        );
    }

    #[test]
    fn png_thumbnail_is_a_jpeg_data_url() {
        let thumb = thumbnail_data_url(&tiny_png(), true).unwrap();
        assert!(thumb.starts_with("data:image/jpeg;base64,"));
        assert!(thumb.len() < THUMBNAIL_MAX_BYTES);
    }

    #[tokio::test]
    async fn ingest_creates_space_memo_blob_and_is_idempotent() {
        let token = "ingest-secret";
        let (directory, base, client) = start_server(token, false).await;
        bind_telegram(&directory, 42, "One").await;
        let png = tiny_png();
        let first = post_ingest(
            &client,
            &base,
            token,
            Some(42),
            "Memes",
            "lol #telegram",
            "tg:1:2",
            Some(("cat.png", "image/png", png.clone())),
        )
        .await;
        assert_eq!(first.status(), axum::http::StatusCode::OK);
        let payload: serde_json::Value = first.json().await.unwrap();
        let memo_id = payload["memoId"].as_str().unwrap().to_owned();
        let space_id = payload["spaceId"].as_str().unwrap().to_owned();

        let pool = sqlx::SqlitePool::connect(&format!(
            "sqlite://{}",
            directory.path().join("scratchwall.sqlite3").display()
        ))
        .await
        .unwrap();
        let space_name: String =
            sqlx::query_scalar("SELECT name FROM spaces WHERE id=? AND deleted=0")
                .bind(&space_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(space_name, "Memes");
        let body: String = sqlx::query_scalar("SELECT body FROM memos WHERE id=?")
            .bind(&memo_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(body, "lol #telegram");
        let tags: String = sqlx::query_scalar("SELECT tags_json FROM memos WHERE id=?")
            .bind(&memo_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(tags.contains("telegram"));
        let attachment_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE memo_id=? AND deleted=0")
                .bind(&memo_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(attachment_count, 1);
        let thumbnail: Option<String> =
            sqlx::query_scalar("SELECT thumbnail FROM attachments WHERE memo_id=?")
                .bind(&memo_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            thumbnail
                .as_deref()
                .is_some_and(|value| value.starts_with("data:image/jpeg;base64,"))
        );
        let storage_key: String =
            sqlx::query_scalar("SELECT storage_key FROM attachments WHERE memo_id=?")
                .bind(&memo_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(PathBuf::from(&storage_key).is_file());
        let change_types: Vec<String> = sqlx::query_scalar(
            "SELECT entity_type FROM changes WHERE entity_id=? OR entity_id=? OR entity_id IN (SELECT id FROM attachments WHERE memo_id=?) ORDER BY seq",
        )
        .bind(&space_id)
        .bind(&memo_id)
        .bind(&memo_id)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(change_types.iter().any(|value| value == "space"));
        assert!(change_types.iter().any(|value| value == "memo"));
        assert!(change_types.iter().any(|value| value == "attachment"));

        let replay = post_ingest(
            &client,
            &base,
            token,
            Some(42),
            "Memes",
            "lol #telegram",
            "tg:1:2",
            Some(("cat.png", "image/png", png)),
        )
        .await;
        assert_eq!(replay.status(), axum::http::StatusCode::OK);
        let replay_payload: serde_json::Value = replay.json().await.unwrap();
        assert_eq!(replay_payload["memoId"], memo_id);
        let memo_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM memos WHERE deleted=0")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(memo_count, 1);
    }

    #[tokio::test]
    async fn ingest_rejects_a_bad_token() {
        let (_directory, base, client) = start_server("ingest-secret", false).await;
        let response = post_ingest(
            &client,
            &base,
            "wrong",
            Some(42),
            "Memes",
            "hi",
            "tg:9:9",
            None,
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn ingest_requires_telegram_user_id() {
        let (_directory, base, client) = start_server("ingest-secret", true).await;
        let response = post_ingest(
            &client,
            &base,
            "ingest-secret",
            None,
            "Memes",
            "hi",
            "tg:9:9",
            None,
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let body = response.text().await.unwrap();
        assert!(
            body.contains("telegramUserId is required"),
            "expected a telegramUserId error, got {body}"
        );
    }

    #[tokio::test]
    async fn ingest_rejects_unbound_telegram_user() {
        let (_directory, base, client) = start_server("ingest-secret", true).await;
        let response = post_ingest(
            &client,
            &base,
            "ingest-secret",
            Some(99),
            "Memes",
            "hi",
            "tg:9:9",
            None,
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
        let body = response.text().await.unwrap();
        assert!(
            body.contains("telegram account is not connected"),
            "expected a useful ingest binding error, got {body}"
        );
    }

    #[tokio::test]
    async fn ingest_binds_by_telegram_user() {
        let (directory, base, client) = start_server("ingest-secret", true).await;
        bind_telegram(&directory, 7, "Two").await;
        let response = post_ingest(
            &client,
            &base,
            "ingest-secret",
            Some(7),
            "Memes",
            "hi",
            "tg:9:9",
            None,
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let payload: serde_json::Value = response.json().await.unwrap();
        let memo_id = payload["memoId"].as_str().unwrap().to_owned();
        let pool = pool(&directory).await;
        let display_name: String = sqlx::query_scalar(
            "SELECT u.display_name FROM memos m JOIN users u ON u.id=m.user_id WHERE m.id=?",
        )
        .bind(&memo_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(display_name, "Two");
    }

    #[tokio::test]
    async fn telegram_bind_challenge_redirects_then_completes() {
        let token = "ingest-secret";
        let (directory, base, client) = start_server(token, false).await;
        let created = post_bind(&client, &base, token, 42).await;
        assert_eq!(created.status(), axum::http::StatusCode::OK);
        let payload: serde_json::Value = created.json().await.unwrap();
        let url = payload["url"].as_str().unwrap();
        assert!(url.starts_with("https://scratch.test/telegram/bind/"));
        let bind_token = url.rsplit('/').next().unwrap();
        let path = format!("/telegram/bind/{bind_token}");

        let redirect = client.get(format!("{base}{path}")).send().await.unwrap();
        assert_eq!(redirect.status(), axum::http::StatusCode::SEE_OTHER);
        let location = redirect
            .headers()
            .get(axum::http::header::LOCATION)
            .unwrap()
            .to_str()
            .unwrap();
        assert_eq!(location, format!("/api/v1/auth/login?mode=web&next={path}"));

        insert_session(&directory, "One", "session-token").await;
        let complete = client
            .get(format!("{base}{path}"))
            .header("cookie", "scratchwall_session=session-token")
            .send()
            .await
            .unwrap();
        assert_eq!(complete.status(), axum::http::StatusCode::OK);
        let html = complete.text().await.unwrap();
        assert!(html.contains("Telegram connected as One"));

        let already = post_bind(&client, &base, token, 42).await;
        let already_payload: serde_json::Value = already.json().await.unwrap();
        assert!(already_payload["url"].is_null());
        assert_eq!(already_payload["displayName"], "One");

        let ingest = post_ingest(
            &client,
            &base,
            token,
            Some(42),
            "Memes",
            "hi",
            "tg:bind:1",
            None,
        )
        .await;
        assert_eq!(ingest.status(), axum::http::StatusCode::OK);
    }

    #[tokio::test]
    async fn login_stores_only_a_safe_telegram_next() {
        let token = "ingest-secret";
        let (directory, base, client) = start_server(token, false).await;
        let good = client
            .get(format!(
                "{base}/api/v1/auth/login?mode=web&next=/telegram/bind/abcDEF_12"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(good.status(), axum::http::StatusCode::TEMPORARY_REDIRECT);
        let pool = pool(&directory).await;
        let return_path: Option<String> = sqlx::query_scalar("SELECT return_path FROM auth_flows")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(return_path.as_deref(), Some("/telegram/bind/abcDEF_12"));

        sqlx::query("DELETE FROM auth_flows")
            .execute(&pool)
            .await
            .unwrap();
        let bad = client
            .get(format!(
                "{base}/api/v1/auth/login?mode=web&next=https://evil.example"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(bad.status(), axum::http::StatusCode::TEMPORARY_REDIRECT);
        let return_path: Option<String> = sqlx::query_scalar("SELECT return_path FROM auth_flows")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(return_path, None);
    }
}
