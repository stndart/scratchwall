use crate::{AppState, ChangeNotice, auth::AuthUser, error::AppError, models::Attachment};
use axum::{
    Json,
    body::Body,
    extract::{Extension, Path, State},
    http::{HeaderMap, HeaderValue, Request, StatusCode, header},
    response::Response,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

// Bounded lock striping serializes retries for one upload without an unbounded lock map.
static UPLOAD_LOCKS: std::sync::LazyLock<Vec<tokio::sync::Mutex<()>>> =
    std::sync::LazyLock::new(|| (0..64).map(|_| tokio::sync::Mutex::new(())).collect());

async fn upload_lock(id: &str) -> tokio::sync::MutexGuard<'static, ()> {
    let digest = Sha256::digest(id.as_bytes());
    UPLOAD_LOCKS[digest[0] as usize % UPLOAD_LOCKS.len()]
        .lock()
        .await
}

async fn existing_attachment(
    state: &AppState,
    user_id: i64,
    id: &str,
) -> Result<Option<Attachment>, AppError> {
    let row = sqlx::query("SELECT * FROM attachments WHERE user_id=? AND id=?")
        .bind(user_id)
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if row.get::<i64, _>("deleted") != 0 {
        return Err(AppError::NotFound);
    }
    Ok(Some(Attachment {
        id: id.into(),
        memo_id: row.get("memo_id"),
        filename: row.get("filename"),
        mime_type: row.get("mime_type"),
        size: row.get("size"),
        thumbnail: row.get("thumbnail"),
        remote_ready: true,
        cache_state: "remote".into(),
        created_at: row.get("created_at"),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUpload {
    id: String,
    memo_id: String,
    filename: String,
    mime_type: String,
    size: u64,
    thumbnail: Option<String>,
}

#[derive(Serialize)]
pub struct UploadPosition {
    id: String,
    offset: u64,
    size: u64,
}

fn checked_uuid(value: &str) -> Result<String, AppError> {
    Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| AppError::BadRequest("invalid upload id".into()))
}

pub async fn create(
    Extension(user): Extension<AuthUser>,
    State(state): State<AppState>,
    Json(input): Json<CreateUpload>,
) -> Result<Json<UploadPosition>, AppError> {
    let id = checked_uuid(&input.id)?;
    let _guard = upload_lock(&id).await;
    if input.memo_id.len() > 64 || input.filename.is_empty() || input.filename.len() > 1024 {
        return Err(AppError::BadRequest("invalid attachment metadata".into()));
    }
    if input.size > state.config.max_attachment_bytes {
        return Err(AppError::BadRequest(format!(
            "attachment exceeds {} bytes",
            state.config.max_attachment_bytes
        )));
    }
    if let Some(existing) = existing_attachment(&state, user.user_id, &id).await? {
        if existing.memo_id != input.memo_id
            || existing.filename != input.filename
            || existing.size as u64 != input.size
            || existing.mime_type != input.mime_type
        {
            return Err(AppError::BadRequest(
                "upload id already belongs to different metadata".into(),
            ));
        }
        return Ok(Json(UploadPosition {
            id,
            offset: input.size,
            size: input.size,
        }));
    }
    let memo_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM memos WHERE user_id=? AND id=? AND deleted=0)",
    )
    .bind(user.user_id)
    .bind(&input.memo_id)
    .fetch_one(&state.db)
    .await?;
    if !memo_exists {
        return Err(AppError::NotFound);
    }
    if input
        .thumbnail
        .as_ref()
        .is_some_and(|value| value.len() > 512 * 1024)
    {
        return Err(AppError::BadRequest("thumbnail exceeds 512 KiB".into()));
    }
    let user_dir = state
        .config
        .data_dir
        .join("uploads")
        .join(user.user_id.to_string());
    tokio::fs::create_dir_all(&user_dir).await?;
    let temp_path = user_dir.join(format!("{id}.part"));
    let path_string = temp_path.to_string_lossy().to_string();
    sqlx::query("INSERT INTO uploads(user_id,id,memo_id,filename,mime_type,size,offset,thumbnail,temp_path,created_at) VALUES(?,?,?,?,?,?,0,?,?,unixepoch()) ON CONFLICT(user_id,id) DO NOTHING")
        .bind(user.user_id).bind(&id).bind(&input.memo_id).bind(&input.filename).bind(&input.mime_type).bind(input.size as i64).bind(&input.thumbnail).bind(&path_string).execute(&state.db).await?;
    tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&temp_path)
        .await?;
    let row = sqlx::query(
        "SELECT offset,size FROM uploads WHERE user_id=? AND id=? AND memo_id=? AND filename=? AND size=? AND mime_type=?",
    )
    .bind(user.user_id)
    .bind(&id)
    .bind(&input.memo_id)
    .bind(&input.filename)
    .bind(input.size as i64)
    .bind(&input.mime_type)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        AppError::BadRequest("upload id already belongs to different metadata".into())
    })?;
    Ok(Json(UploadPosition {
        id,
        offset: row.get::<i64, _>("offset") as u64,
        size: row.get::<i64, _>("size") as u64,
    }))
}

pub async fn status(
    Extension(user): Extension<AuthUser>,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<UploadPosition>, AppError> {
    let id = checked_uuid(&id)?;
    let row = sqlx::query("SELECT offset,size FROM uploads WHERE user_id=? AND id=?")
        .bind(user.user_id)
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(UploadPosition {
        id,
        offset: row.get::<i64, _>("offset") as u64,
        size: row.get::<i64, _>("size") as u64,
    }))
}

pub async fn append(
    Extension(user): Extension<AuthUser>,
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request<Body>,
) -> Result<Json<UploadPosition>, AppError> {
    let id = checked_uuid(&id)?;
    let _guard = upload_lock(&id).await;
    let claimed_offset: u64 = request
        .headers()
        .get("upload-offset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| AppError::BadRequest("missing Upload-Offset".into()))?;
    let row = sqlx::query("SELECT offset,size,temp_path FROM uploads WHERE user_id=? AND id=?")
        .bind(user.user_id)
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let offset = row.get::<i64, _>("offset") as u64;
    let size = row.get::<i64, _>("size") as u64;
    if claimed_offset != offset {
        return Err(AppError::BadRequest(format!(
            "offset mismatch; server offset is {offset}"
        )));
    }
    let path: String = row.get("temp_path");
    let mut file = tokio::fs::OpenOptions::new().write(true).open(path).await?;
    // An interrupted request may have written beyond the committed DB offset.
    file.set_len(offset).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut stream = request.into_body().into_data_stream();
    let mut written = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::BadRequest(e.to_string()))?;
        written = written
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| AppError::BadRequest("upload size overflow".into()))?;
        if offset + written > size {
            return Err(AppError::BadRequest(
                "chunk exceeds declared upload length".into(),
            ));
        }
        file.write_all(&chunk).await?;
    }
    file.sync_all().await?;
    let new_offset = offset + written;
    sqlx::query("UPDATE uploads SET offset=? WHERE user_id=? AND id=? AND offset=?")
        .bind(new_offset as i64)
        .bind(user.user_id)
        .bind(&id)
        .bind(offset as i64)
        .execute(&state.db)
        .await?;
    Ok(Json(UploadPosition {
        id,
        offset: new_offset,
        size,
    }))
}

pub async fn complete(
    Extension(user): Extension<AuthUser>,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Attachment>, AppError> {
    let id = checked_uuid(&id)?;
    let _guard = upload_lock(&id).await;
    if let Some(existing) = existing_attachment(&state, user.user_id, &id).await? {
        return Ok(Json(existing));
    }
    let row = sqlx::query("SELECT memo_id,filename,mime_type,size,offset,thumbnail,temp_path FROM uploads WHERE user_id=? AND id=?").bind(user.user_id).bind(&id).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    let size: i64 = row.get("size");
    let offset: i64 = row.get("offset");
    if size != offset {
        return Err(AppError::BadRequest(format!(
            "upload incomplete: {offset}/{size}"
        )));
    }
    let temp_path: String = row.get("temp_path");
    let mut file = tokio::fs::File::open(&temp_path).await?;
    if file.metadata().await?.len() != size as u64 {
        return Err(AppError::BadRequest(
            "persisted upload length mismatch".into(),
        ));
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hex::encode(hasher.finalize());
    let blob_dir = state
        .config
        .data_dir
        .join("blobs")
        .join(user.user_id.to_string());
    tokio::fs::create_dir_all(&blob_dir).await?;
    let blob_path = blob_dir.join(format!("{id}-{digest}"));
    // Keep the resumable source until the metadata commit, including across crashes.
    tokio::fs::copy(&temp_path, &blob_path).await?;
    tokio::fs::OpenOptions::new()
        .write(true)
        .open(&blob_path)
        .await?
        .sync_all()
        .await?;
    let mime_type: String = row.get("mime_type");
    let thumbnail =
        crate::thumbnails::ensure_for_file(&mime_type, row.get("thumbnail"), &blob_path).await;
    let attachment = Attachment {
        id: id.clone(),
        memo_id: row.get("memo_id"),
        filename: row.get("filename"),
        mime_type,
        size,
        thumbnail,
        remote_ready: true,
        cache_state: "remote".into(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    let mut transaction = state.db.begin().await?;
    let seq: i64 =
        sqlx::query_scalar("UPDATE users SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq")
            .bind(user.user_id)
            .fetch_one(&mut *transaction)
            .await?;
    let memo_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM memos WHERE user_id=? AND id=? AND deleted=0)",
    )
    .bind(user.user_id)
    .bind(&attachment.memo_id)
    .fetch_one(&mut *transaction)
    .await?;
    if !memo_exists {
        transaction.rollback().await?;
        let _ = tokio::fs::remove_file(&blob_path).await;
        return Err(AppError::NotFound);
    }
    sqlx::query("INSERT INTO attachments(user_id,id,memo_id,filename,mime_type,size,thumbnail,storage_key,created_at,deleted,server_seq) VALUES(?,?,?,?,?,?,?,?,?,0,?)")
        .bind(user.user_id).bind(&attachment.id).bind(&attachment.memo_id).bind(&attachment.filename).bind(&attachment.mime_type).bind(attachment.size).bind(&attachment.thumbnail).bind(blob_path.to_string_lossy().as_ref()).bind(&attachment.created_at).bind(seq).execute(&mut *transaction).await?;
    sqlx::query("DELETE FROM uploads WHERE user_id=? AND id=?")
        .bind(user.user_id)
        .bind(&id)
        .execute(&mut *transaction)
        .await?;
    sqlx::query("INSERT INTO changes(user_id,seq,entity_type,entity_id,operation,payload_json) VALUES(?,?,'attachment',?,'upsert',?)")
        .bind(user.user_id).bind(seq).bind(&id).bind(serde_json::to_string(&attachment)?).execute(&mut *transaction).await?;
    transaction.commit().await?;
    let _ = tokio::fs::remove_file(&temp_path).await;
    let _ = state.changes.send(ChangeNotice {
        user_id: user.user_id,
    });
    Ok(Json(attachment))
}

fn parse_range(value: Option<&str>, size: u64) -> Result<(u64, u64, bool), AppError> {
    let Some(value) = value else {
        return Ok((0, size.saturating_sub(1), false));
    };
    let value = value
        .strip_prefix("bytes=")
        .ok_or_else(|| AppError::BadRequest("invalid Range header".into()))?;
    if value.contains(',') {
        return Err(AppError::BadRequest(
            "multiple ranges are not supported".into(),
        ));
    }
    let (start, end) = value
        .split_once('-')
        .ok_or_else(|| AppError::BadRequest("invalid Range header".into()))?;
    if size == 0 {
        return Err(AppError::BadRequest("range outside file".into()));
    }
    if start.is_empty() {
        let suffix: u64 = end
            .parse()
            .map_err(|_| AppError::BadRequest("invalid range suffix".into()))?;
        if suffix == 0 {
            return Err(AppError::BadRequest("invalid range suffix".into()));
        }
        return Ok((size.saturating_sub(suffix.min(size)), size - 1, true));
    }
    let start: u64 = start
        .parse()
        .map_err(|_| AppError::BadRequest("invalid range start".into()))?;
    let end: u64 = if end.is_empty() {
        size.saturating_sub(1)
    } else {
        end.parse()
            .map_err(|_| AppError::BadRequest("invalid range end".into()))?
    };
    if start > end || end >= size {
        return Err(AppError::BadRequest("range outside file".into()));
    }
    Ok((start, end, true))
}

pub async fn download(
    Extension(user): Extension<AuthUser>,
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let id = checked_uuid(&id)?;
    let row = sqlx::query("SELECT filename,mime_type,size,storage_key FROM attachments WHERE user_id=? AND id=? AND deleted=0 AND storage_key IS NOT NULL").bind(user.user_id).bind(&id).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    let size = row.get::<i64, _>("size") as u64;
    let (start, end, partial) = parse_range(
        headers
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok()),
        size,
    )?;
    let path: String = row.get("storage_key");
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let length = if size == 0 { 0 } else { end - start + 1 };
    let stream = ReaderStream::new(file.take(length));
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let mime: String = row.get("mime_type");
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string()).unwrap(),
    );
    response
        .headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if partial {
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{size}")).unwrap(),
        );
    }
    let filename: String = row.get("filename");
    let safe_name = filename.replace(['\r', '\n', '"'], "_");
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{safe_name}\""))
            .unwrap_or(HeaderValue::from_static("attachment")),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture() -> (tempfile::TempDir, AppState, i64, String) {
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
        let memo_id = Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO memos(user_id,id,space_id,body,created_at,updated_at,server_seq) VALUES(?,?,'inbox','','now','now',0)")
            .bind(user_id).bind(&memo_id).execute(&db).await.unwrap();
        let config = crate::config::Config {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            data_dir: directory.path().into(),
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
        };
        let (changes, _) = tokio::sync::broadcast::channel(8);
        (
            directory,
            AppState {
                config: std::sync::Arc::new(config),
                db,
                http: reqwest::Client::new(),
                changes,
            },
            user_id,
            memo_id,
        )
    }

    fn input(id: &str, memo: &str, size: u64) -> CreateUpload {
        CreateUpload {
            id: id.into(),
            memo_id: memo.into(),
            filename: "test.txt".into(),
            mime_type: "text/plain".into(),
            size,
            thumbnail: None,
        }
    }

    #[tokio::test]
    async fn interrupted_upload_retries_without_corruption_and_completion_is_idempotent() {
        let (_directory, state, user_id, memo_id) = fixture().await;
        let id = Uuid::now_v7().to_string();
        let _ = create(
            Extension(AuthUser { user_id }),
            State(state.clone()),
            Json(input(&id, &memo_id, 6)),
        )
        .await
        .unwrap();
        let stream = futures_util::stream::iter(vec![
            Ok(axum::body::Bytes::from_static(b"bad")),
            Err(std::io::Error::other("connection interrupted")),
        ]);
        let interrupted = Request::builder()
            .header("upload-offset", "0")
            .body(Body::from_stream(stream))
            .unwrap();
        assert!(
            append(
                Extension(AuthUser { user_id }),
                State(state.clone()),
                Path(id.clone()),
                interrupted
            )
            .await
            .is_err()
        );
        assert_eq!(
            status(
                Extension(AuthUser { user_id }),
                State(state.clone()),
                Path(id.clone())
            )
            .await
            .unwrap()
            .0
            .offset,
            0
        );
        let retry = Request::builder()
            .header("upload-offset", "0")
            .body(Body::from("abcdef"))
            .unwrap();
        assert_eq!(
            append(
                Extension(AuthUser { user_id }),
                State(state.clone()),
                Path(id.clone()),
                retry
            )
            .await
            .unwrap()
            .0
            .offset,
            6
        );
        let first = complete(
            Extension(AuthUser { user_id }),
            State(state.clone()),
            Path(id.clone()),
        )
        .await
        .unwrap()
        .0;
        let second = complete(
            Extension(AuthUser { user_id }),
            State(state.clone()),
            Path(id.clone()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(first.created_at, second.created_at);
        assert_eq!(
            create(
                Extension(AuthUser { user_id }),
                State(state.clone()),
                Json(input(&id, &memo_id, 6))
            )
            .await
            .unwrap()
            .0
            .offset,
            6
        );
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=1-3"));
        let response = download(
            Extension(AuthUser { user_id }),
            State(state.clone()),
            Path(id.clone()),
            headers,
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 10)
                .await
                .unwrap()
                .as_ref(),
            b"bcd"
        );
        assert!(
            download(
                Extension(AuthUser {
                    user_id: user_id + 1
                }),
                State(state.clone()),
                Path(id.clone()),
                HeaderMap::new()
            )
            .await
            .is_err()
        );
        sqlx::query("UPDATE attachments SET deleted=1 WHERE user_id=? AND id=?")
            .bind(user_id)
            .bind(&id)
            .execute(&state.db)
            .await
            .unwrap();
        assert!(
            complete(Extension(AuthUser { user_id }), State(state), Path(id))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn size_limit_and_deleted_parent_are_enforced() {
        let (_directory, state, user_id, memo_id) = fixture().await;
        for size in [2_147_483_647, 2_147_483_648] {
            assert!(
                create(
                    Extension(AuthUser { user_id }),
                    State(state.clone()),
                    Json(input(&Uuid::now_v7().to_string(), &memo_id, size))
                )
                .await
                .is_ok()
            );
        }
        assert!(
            create(
                Extension(AuthUser { user_id }),
                State(state.clone()),
                Json(input(&Uuid::now_v7().to_string(), &memo_id, 2_147_483_649))
            )
            .await
            .is_err()
        );
        let id = Uuid::now_v7().to_string();
        let _ = create(
            Extension(AuthUser { user_id }),
            State(state.clone()),
            Json(input(&id, &memo_id, 0)),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE memos SET deleted=1 WHERE user_id=? AND id=?")
            .bind(user_id)
            .bind(&memo_id)
            .execute(&state.db)
            .await
            .unwrap();
        assert!(
            complete(
                Extension(AuthUser { user_id }),
                State(state.clone()),
                Path(id.clone())
            )
            .await
            .is_err()
        );
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE user_id=? AND id=?")
                .bind(user_id)
                .bind(id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn completing_a_video_upload_stores_a_jpeg_poster_alongside() {
        if !tokio::process::Command::new("ffmpeg")
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return;
        }
        let (directory, state, user_id, memo_id) = fixture().await;
        let clip = directory.path().join("clip.mp4");
        let status = tokio::process::Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=80x60:d=1",
                "-pix_fmt",
                "yuv420p",
                clip.to_str().unwrap(),
            ])
            .status()
            .await
            .unwrap();
        assert!(status.success());
        let bytes = tokio::fs::read(&clip).await.unwrap();
        let id = Uuid::now_v7().to_string();
        let _ = create(
            Extension(AuthUser { user_id }),
            State(state.clone()),
            Json(CreateUpload {
                id: id.clone(),
                memo_id,
                filename: "clip.mp4".into(),
                mime_type: "video/mp4".into(),
                size: bytes.len() as u64,
                thumbnail: None,
            }),
        )
        .await
        .unwrap();
        let put = Request::builder()
            .header("upload-offset", "0")
            .body(Body::from(bytes))
            .unwrap();
        let _ = append(
            Extension(AuthUser { user_id }),
            State(state.clone()),
            Path(id.clone()),
            put,
        )
        .await
        .unwrap();
        let attachment = complete(
            Extension(AuthUser { user_id }),
            State(state.clone()),
            Path(id.clone()),
        )
        .await
        .unwrap()
        .0;
        assert!(
            attachment
                .thumbnail
                .as_deref()
                .is_some_and(|value| value.starts_with("data:image/jpeg;base64,"))
        );
        let storage_key: String =
            sqlx::query_scalar("SELECT storage_key FROM attachments WHERE user_id=? AND id=?")
                .bind(user_id)
                .bind(&id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert!(crate::thumbnails::poster_path(std::path::Path::new(&storage_key)).is_file());
    }

    #[test]
    fn parses_byte_ranges() {
        assert_eq!(
            parse_range(Some("bytes=10-19"), 100).unwrap(),
            (10, 19, true)
        );
        assert_eq!(parse_range(Some("bytes=-8"), 100).unwrap(), (92, 99, true));
        assert_eq!(parse_range(Some("bytes=95-"), 100).unwrap(), (95, 99, true));
        assert!(parse_range(Some("bytes=100-101"), 100).is_err());
    }
}
