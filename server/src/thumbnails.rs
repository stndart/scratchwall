use crate::{AppState, error::AppError, models::Attachment, sync};
use base64::{Engine, engine::general_purpose::STANDARD};
use image::ImageEncoder;
use sqlx::Row;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

pub const THUMBNAIL_MAX_EDGE: u32 = 960;
pub const THUMBNAIL_MAX_BYTES: usize = 512 * 1024;
const VIDEO_POSTER_TIMEOUT: Duration = Duration::from_secs(20);

pub fn is_video_mime(mime: &str) -> bool {
    let mime = mime.trim();
    mime.starts_with("video/") || mime.eq_ignore_ascii_case("application/mp4")
}

pub fn is_usable(thumbnail: &Option<String>) -> bool {
    thumbnail.as_deref().is_some_and(|value| {
        value.starts_with("data:image/") && !value.is_empty() && value.len() <= THUMBNAIL_MAX_BYTES
    })
}

pub fn poster_path(blob_path: &Path) -> PathBuf {
    let mut name = blob_path
        .file_name()
        .map(|value| value.to_os_string())
        .unwrap_or_default();
    name.push(".thumb.jpg");
    blob_path.with_file_name(name)
}

pub fn image_data_url(bytes: &[u8]) -> Option<String> {
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
    jpeg_data_url(&encoded)
}

fn jpeg_data_url(encoded: &[u8]) -> Option<String> {
    if encoded.is_empty() || encoded.len() > THUMBNAIL_MAX_BYTES {
        return None;
    }
    let url = format!("data:image/jpeg;base64,{}", STANDARD.encode(encoded));
    (url.len() <= THUMBNAIL_MAX_BYTES).then_some(url)
}

pub async fn ensure_for_file(
    mime_type: &str,
    existing: Option<String>,
    blob_path: &Path,
) -> Option<String> {
    if is_usable(&existing) {
        return existing;
    }
    if mime_type.starts_with("image/") {
        let bytes = tokio::fs::read(blob_path).await.ok()?;
        return image_data_url(&bytes);
    }
    if is_video_mime(mime_type) {
        return video_poster(blob_path).await;
    }
    None
}

pub async fn video_poster(blob_path: &Path) -> Option<String> {
    let poster = poster_path(blob_path);
    if let Some(url) = jpeg_file_data_url(&poster).await {
        return Some(url);
    }
    if !blob_path.is_file() {
        return None;
    }
    extract_frame(blob_path, &poster, true).await;
    if !poster.is_file() {
        extract_frame(blob_path, &poster, false).await;
    }
    jpeg_file_data_url(&poster).await
}

async fn jpeg_file_data_url(path: &Path) -> Option<String> {
    let bytes = tokio::fs::read(path).await.ok()?;
    jpeg_data_url(&bytes)
}

async fn extract_frame(input: &Path, output: &Path, seek: bool) -> bool {
    if let Some(parent) = output.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let mut command = Command::new("ffmpeg");
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostdin")
        .arg("-y");
    if seek {
        command.arg("-ss").arg("0.5");
    }
    command
        .arg("-i")
        .arg(input)
        .arg("-an")
        .arg("-frames:v")
        .arg("1")
        .arg("-vf")
        .arg("scale=960:960:force_original_aspect_ratio=decrease")
        .arg("-q:v")
        .arg("4")
        .arg(output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    match tokio::time::timeout(VIDEO_POSTER_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) if status.success() => true,
        _ => {
            let _ = child.kill().await;
            let _ = tokio::fs::remove_file(output).await;
            false
        }
    }
}

pub async fn backfill_missing_video_posters(state: AppState) {
    let rows = match sqlx::query(
        "SELECT user_id,id,memo_id,filename,mime_type,size,thumbnail,storage_key,created_at
         FROM attachments
         WHERE deleted=0
           AND (thumbnail IS NULL OR thumbnail='')
           AND (mime_type LIKE 'video/%' OR lower(mime_type)='application/mp4')",
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(error = %error, "video poster backfill query failed");
            return;
        }
    };
    if rows.is_empty() {
        return;
    }
    tracing::info!(count = rows.len(), "generating missing video posters");
    let mut generated = 0usize;
    for row in rows {
        let storage_key: Option<String> = row.get("storage_key");
        let Some(storage_key) = storage_key.filter(|value| !value.is_empty()) else {
            continue;
        };
        let path = PathBuf::from(&storage_key);
        let mime_type: String = row.get("mime_type");
        let Some(thumbnail) = video_poster(&path).await else {
            tracing::debug!(path = %path.display(), mime = %mime_type, "video poster skipped");
            continue;
        };
        let user_id: i64 = row.get("user_id");
        let id: String = row.get("id");
        let attachment = Attachment {
            id: id.clone(),
            memo_id: row.get("memo_id"),
            filename: row.get("filename"),
            mime_type,
            size: row.get("size"),
            thumbnail: Some(thumbnail.clone()),
            remote_ready: true,
            cache_state: "remote".into(),
            created_at: row.get("created_at"),
        };
        if persist_thumbnail(&state, user_id, &attachment)
            .await
            .is_ok()
        {
            generated += 1;
        }
    }
    tracing::info!(generated, "video poster backfill finished");
}

async fn persist_thumbnail(
    state: &AppState,
    user_id: i64,
    attachment: &Attachment,
) -> Result<(), AppError> {
    let mut transaction = state.db.begin().await?;
    let seq = sync::next_seq(&mut transaction, user_id).await?;
    let updated = sqlx::query(
        "UPDATE attachments SET thumbnail=?, server_seq=? WHERE user_id=? AND id=? AND deleted=0 AND (thumbnail IS NULL OR thumbnail='')",
    )
    .bind(&attachment.thumbnail)
    .bind(seq)
    .bind(user_id)
    .bind(&attachment.id)
    .execute(&mut *transaction)
    .await?
    .rows_affected();
    if updated == 0 {
        transaction.rollback().await?;
        return Ok(());
    }
    sync::record_change(
        &mut transaction,
        user_id,
        seq,
        "attachment",
        &attachment.id,
        "upsert",
        Some(attachment),
    )
    .await?;
    transaction.commit().await?;
    let _ = state.changes.send(crate::ChangeNotice { user_id });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    async fn ffmpeg_available() -> bool {
        Command::new("ffmpeg")
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[test]
    fn video_mime_includes_mp4_and_quicktime() {
        assert!(is_video_mime("video/mp4"));
        assert!(is_video_mime("video/quicktime"));
        assert!(is_video_mime("application/mp4"));
        assert!(!is_video_mime("image/jpeg"));
        assert!(!is_video_mime("application/pdf"));
    }

    #[test]
    fn png_thumbnail_is_a_bounded_jpeg_data_url() {
        let thumb = image_data_url(&tiny_png()).unwrap();
        assert!(thumb.starts_with("data:image/jpeg;base64,"));
        assert!(thumb.len() <= THUMBNAIL_MAX_BYTES);
        assert!(is_usable(&Some(thumb)));
        assert!(!is_usable(&Some(String::new())));
        assert!(!is_usable(&None));
    }

    #[test]
    fn poster_sits_next_to_the_blob() {
        let blob = PathBuf::from("/data/blobs/1/abc-deadbeef");
        assert_eq!(
            poster_path(&blob),
            PathBuf::from("/data/blobs/1/abc-deadbeef.thumb.jpg")
        );
    }

    #[tokio::test]
    async fn ffmpeg_writes_a_jpeg_poster_alongside_a_clip() {
        if !ffmpeg_available().await {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("clip.mp4");
        let status = Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=64x48:d=1",
                "-pix_fmt",
                "yuv420p",
                input.to_str().unwrap(),
            ])
            .status()
            .await
            .unwrap();
        assert!(status.success());
        let thumb = video_poster(&input).await.expect("poster");
        assert!(thumb.starts_with("data:image/jpeg;base64,"));
        assert!(poster_path(&input).is_file());
        assert!(is_usable(&Some(thumb)));
    }
}
