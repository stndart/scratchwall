use crate::models::{Profile, Space};
use anyhow::Result;
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{path::Path, str::FromStr};
use uuid::Uuid;

pub async fn connect(data_dir: &Path) -> Result<SqlitePool> {
    tokio::fs::create_dir_all(data_dir.join("blobs")).await?;
    tokio::fs::create_dir_all(data_dir.join("uploads")).await?;
    let url = format!(
        "sqlite://{}",
        data_dir.join("scratchwall.sqlite3").display()
    );
    let options = SqliteConnectOptions::from_str(&url)?
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;
    sqlx::query("PRAGMA journal_mode=WAL")
        .execute(&pool)
        .await?;
    sqlx::query("PRAGMA synchronous=NORMAL")
        .execute(&pool)
        .await?;
    migrate(&pool).await?;
    cleanup_stale_state(&pool, data_dir).await?;
    Ok(pool)
}

async fn cleanup_stale_state(pool: &SqlitePool, data_dir: &Path) -> Result<()> {
    let upload_root = data_dir.join("uploads").canonicalize()?;
    let stale: Vec<String> =
        sqlx::query_scalar("SELECT temp_path FROM uploads WHERE created_at < unixepoch() - 86400")
            .fetch_all(pool)
            .await?;
    for path in stale {
        let candidate = std::path::PathBuf::from(path);
        if let Ok(resolved) = candidate.canonicalize()
            && resolved.starts_with(&upload_root)
        {
            let _ = tokio::fs::remove_file(resolved).await;
        }
    }
    sqlx::query("DELETE FROM uploads WHERE created_at < unixepoch() - 86400")
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM auth_flows WHERE expires_at < unixepoch()")
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM native_codes WHERE expires_at < unixepoch()")
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE expires_at < unixepoch()")
        .execute(pool)
        .await?;
    Ok(())
}

async fn migrate(pool: &SqlitePool) -> Result<()> {
    sqlx::raw_sql(r#"
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  display_name TEXT NOT NULL,
  groups_json TEXT NOT NULL DEFAULT '[]',
  next_seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE(issuer, subject)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_flows (
  state_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  oidc_verifier TEXT NOT NULL,
  mode TEXT NOT NULL,
  native_challenge TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oidc_credentials (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS native_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spaces (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  is_inbox INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  server_seq INTEGER NOT NULL,
  PRIMARY KEY(user_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_inbox_per_user ON spaces(user_id) WHERE is_inbox=1 AND deleted=0;
CREATE TABLE IF NOT EXISTS memos (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  attachment_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  server_seq INTEGER NOT NULL,
  PRIMARY KEY(user_id, id)
);
CREATE INDEX IF NOT EXISTS memos_by_space ON memos(user_id, space_id, created_at);
CREATE TABLE IF NOT EXISTS attachments (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  memo_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  thumbnail TEXT,
  storage_key TEXT,
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  server_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, id)
);
CREATE TABLE IF NOT EXISTS uploads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  memo_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  offset INTEGER NOT NULL DEFAULT 0,
  thumbnail TEXT,
  temp_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, id)
);
CREATE TABLE IF NOT EXISTS changes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT,
  PRIMARY KEY(user_id, seq)
);
CREATE TABLE IF NOT EXISTS processed_ops (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  op_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, op_id)
);
"#).execute(pool).await?;
    Ok(())
}

pub async fn ensure_user(pool: &SqlitePool, issuer: &str, profile: &Profile) -> Result<i64> {
    let groups = serde_json::to_string(&profile.groups)?;
    sqlx::query("INSERT INTO users(issuer, subject, display_name, groups_json) VALUES(?,?,?,?) ON CONFLICT(issuer,subject) DO UPDATE SET display_name=excluded.display_name, groups_json=excluded.groups_json")
        .bind(issuer).bind(&profile.subject).bind(&profile.display_name).bind(groups).execute(pool).await?;
    let user_id: i64 = sqlx::query_scalar("SELECT id FROM users WHERE issuer=? AND subject=?")
        .bind(issuer)
        .bind(&profile.subject)
        .fetch_one(pool)
        .await?;
    let exists: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM spaces WHERE user_id=? AND is_inbox=1")
            .bind(user_id)
            .fetch_one(pool)
            .await?;
    if exists == 0 {
        let id = Uuid::now_v7().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let mut transaction = pool.begin().await?;
        let seq: i64 = sqlx::query_scalar(
            "UPDATE users SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq",
        )
        .bind(user_id)
        .fetch_one(&mut *transaction)
        .await?;
        sqlx::query("INSERT INTO spaces(user_id,id,name,position,is_inbox,created_at,updated_at,server_seq) VALUES(?,?,?,?,1,?,?,?)")
            .bind(user_id).bind(&id).bind("Inbox").bind(0).bind(&now).bind(&now).bind(seq).execute(&mut *transaction).await?;
        let space = Space {
            id: id.clone(),
            name: "Inbox".into(),
            position: 0,
            is_inbox: true,
            created_at: now.clone(),
            updated_at: now,
            sync_state: "synced".into(),
        };
        sqlx::query("INSERT INTO changes(user_id,seq,entity_type,entity_id,operation,payload_json) VALUES(?,?,'space',?,'upsert',?)")
            .bind(user_id).bind(seq).bind(id).bind(serde_json::to_string(&space)?).execute(&mut *transaction).await?;
        transaction.commit().await?;
    }
    Ok(user_id)
}

pub async fn profile_for_user(pool: &SqlitePool, user_id: i64) -> Result<Profile> {
    let row = sqlx::query("SELECT subject,display_name,groups_json FROM users WHERE id=?")
        .bind(user_id)
        .fetch_one(pool)
        .await?;
    Ok(Profile {
        subject: row.get("subject"),
        display_name: row.get("display_name"),
        groups: serde_json::from_str(row.get::<&str, _>("groups_json"))?,
    })
}
