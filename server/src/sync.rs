use crate::{
    AppState, ChangeNotice,
    auth::AuthUser,
    error::AppError,
    models::{Memo, Rejection, ServerChange, Space, SyncRequest, SyncResponse},
};
use axum::{
    Json,
    extract::{Extension, State},
};
use serde::Serialize;
use serde_json::Value;
use sqlx::{Row, Sqlite, Transaction};
use std::path::PathBuf;

async fn next_seq(
    transaction: &mut Transaction<'_, Sqlite>,
    user_id: i64,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("UPDATE users SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq")
        .bind(user_id)
        .fetch_one(&mut **transaction)
        .await
}

async fn record_change<T: Serialize>(
    transaction: &mut Transaction<'_, Sqlite>,
    user_id: i64,
    seq: i64,
    entity_type: &str,
    entity_id: &str,
    operation: &str,
    payload: Option<&T>,
) -> Result<(), AppError> {
    let json = payload.map(serde_json::to_string).transpose()?;
    sqlx::query("INSERT INTO changes(user_id,seq,entity_type,entity_id,operation,payload_json) VALUES(?,?,?,?,?,?)")
        .bind(user_id).bind(seq).bind(entity_type).bind(entity_id).bind(operation).bind(json).execute(&mut **transaction).await?;
    Ok(())
}

pub async fn sync(
    Extension(user): Extension<AuthUser>,
    State(state): State<AppState>,
    Json(input): Json<SyncRequest>,
) -> Result<Json<SyncResponse>, AppError> {
    if input.operations.len() > 500 {
        return Err(AppError::BadRequest(
            "at most 500 operations may be pushed at once".into(),
        ));
    }
    let mut transaction = state.db.begin().await?;
    let mut acknowledged = Vec::with_capacity(input.operations.len());
    let mut rejected = Vec::new();
    let mut files_to_delete: Vec<PathBuf> = Vec::new();
    let mut did_change = false;

    for operation in input.operations {
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO processed_ops(user_id,op_id,created_at) VALUES(?,?,unixepoch())",
        )
        .bind(user.user_id)
        .bind(&operation.id)
        .execute(&mut *transaction)
        .await?
        .rows_affected()
            == 1;
        acknowledged.push(operation.id.clone());
        if !inserted {
            continue;
        }
        let result: Result<(), AppError> = match operation.kind.as_str() {
            "upsert_space" => {
                let mut space: Space = serde_json::from_value(
                    operation
                        .payload
                        .clone()
                        .ok_or_else(|| AppError::BadRequest("missing space payload".into()))?,
                )?;
                let tombstone: Option<i64> =
                    sqlx::query_scalar("SELECT deleted FROM spaces WHERE user_id=? AND id=?")
                        .bind(user.user_id)
                        .bind(&space.id)
                        .fetch_optional(&mut *transaction)
                        .await?;
                if tombstone == Some(1) {
                    Err(AppError::BadRequest("space was permanently deleted".into()))
                } else {
                    space.is_inbox =
                        sqlx::query_scalar("SELECT is_inbox FROM spaces WHERE user_id=? AND id=?")
                            .bind(user.user_id)
                            .bind(&space.id)
                            .fetch_optional(&mut *transaction)
                            .await?
                            .unwrap_or(false);
                    space.sync_state = "synced".into();
                    let seq = next_seq(&mut transaction, user.user_id).await?;
                    sqlx::query("INSERT INTO spaces(user_id,id,name,position,is_inbox,created_at,updated_at,deleted,server_seq) VALUES(?,?,?,?,0,?,?,0,?) ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,position=excluded.position,updated_at=excluded.updated_at,server_seq=excluded.server_seq WHERE spaces.deleted=0")
                        .bind(user.user_id).bind(&space.id).bind(&space.name).bind(space.position).bind(&space.created_at).bind(&space.updated_at).bind(seq).execute(&mut *transaction).await?;
                    record_change(
                        &mut transaction,
                        user.user_id,
                        seq,
                        "space",
                        &space.id,
                        "upsert",
                        Some(&space),
                    )
                    .await?;
                    did_change = true;
                    Ok(())
                }
            }
            "delete_space" => {
                let row =
                    sqlx::query("SELECT is_inbox,deleted FROM spaces WHERE user_id=? AND id=?")
                        .bind(user.user_id)
                        .bind(&operation.entity_id)
                        .fetch_optional(&mut *transaction)
                        .await?;
                match row {
                    None => {
                        let seq = next_seq(&mut transaction, user.user_id).await?;
                        sqlx::query("INSERT INTO spaces(user_id,id,name,position,is_inbox,created_at,updated_at,deleted,server_seq) VALUES(?,?,'',0,0,'','',1,?)")
                            .bind(user.user_id).bind(&operation.entity_id).bind(seq).execute(&mut *transaction).await?;
                        record_change::<Value>(
                            &mut transaction,
                            user.user_id,
                            seq,
                            "space",
                            &operation.entity_id,
                            "delete",
                            None,
                        )
                        .await?;
                        did_change = true;
                        Ok(())
                    }
                    Some(row) if row.get::<i64, _>("is_inbox") != 0 => {
                        Err(AppError::BadRequest("Inbox cannot be deleted".into()))
                    }
                    Some(row) if row.get::<i64, _>("deleted") != 0 => Ok(()),
                    Some(_) => {
                        let stored: Vec<String> = sqlx::query_scalar("SELECT storage_key FROM attachments WHERE user_id=? AND deleted=0 AND memo_id IN (SELECT id FROM memos WHERE user_id=? AND space_id=?) AND storage_key IS NOT NULL")
                            .bind(user.user_id).bind(user.user_id).bind(&operation.entity_id).fetch_all(&mut *transaction).await?;
                        files_to_delete.extend(stored.into_iter().map(PathBuf::from));
                        sqlx::query("UPDATE attachments SET deleted=1 WHERE user_id=? AND memo_id IN (SELECT id FROM memos WHERE user_id=? AND space_id=?)").bind(user.user_id).bind(user.user_id).bind(&operation.entity_id).execute(&mut *transaction).await?;
                        sqlx::query("UPDATE memos SET deleted=1 WHERE user_id=? AND space_id=?")
                            .bind(user.user_id)
                            .bind(&operation.entity_id)
                            .execute(&mut *transaction)
                            .await?;
                        let seq = next_seq(&mut transaction, user.user_id).await?;
                        sqlx::query(
                            "UPDATE spaces SET deleted=1,server_seq=? WHERE user_id=? AND id=?",
                        )
                        .bind(seq)
                        .bind(user.user_id)
                        .bind(&operation.entity_id)
                        .execute(&mut *transaction)
                        .await?;
                        record_change::<Value>(
                            &mut transaction,
                            user.user_id,
                            seq,
                            "space",
                            &operation.entity_id,
                            "delete",
                            None,
                        )
                        .await?;
                        did_change = true;
                        Ok(())
                    }
                }
            }
            "upsert_memo" => {
                let mut memo: Memo = serde_json::from_value(
                    operation
                        .payload
                        .clone()
                        .ok_or_else(|| AppError::BadRequest("missing memo payload".into()))?,
                )?;
                let tombstone: Option<i64> =
                    sqlx::query_scalar("SELECT deleted FROM memos WHERE user_id=? AND id=?")
                        .bind(user.user_id)
                        .bind(&memo.id)
                        .fetch_optional(&mut *transaction)
                        .await?;
                let space_active: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM spaces WHERE user_id=? AND id=? AND deleted=0",
                )
                .bind(user.user_id)
                .bind(&memo.space_id)
                .fetch_one(&mut *transaction)
                .await?;
                if tombstone == Some(1) {
                    Err(AppError::BadRequest("memo was permanently deleted".into()))
                } else if space_active == 0 {
                    Err(AppError::BadRequest("target space does not exist".into()))
                } else {
                    memo.sync_state = "synced".into();
                    let seq = next_seq(&mut transaction, user.user_id).await?;
                    sqlx::query("INSERT INTO memos(user_id,id,space_id,body,tags_json,attachment_ids_json,created_at,updated_at,deleted,server_seq) VALUES(?,?,?,?,?,?,?, ?,0,?) ON CONFLICT(user_id,id) DO UPDATE SET space_id=excluded.space_id,body=excluded.body,tags_json=excluded.tags_json,attachment_ids_json=excluded.attachment_ids_json,updated_at=excluded.updated_at,server_seq=excluded.server_seq WHERE memos.deleted=0")
                        .bind(user.user_id).bind(&memo.id).bind(&memo.space_id).bind(&memo.body).bind(serde_json::to_string(&memo.tags)?).bind(serde_json::to_string(&memo.attachment_ids)?).bind(&memo.created_at).bind(&memo.updated_at).bind(seq).execute(&mut *transaction).await?;
                    record_change(
                        &mut transaction,
                        user.user_id,
                        seq,
                        "memo",
                        &memo.id,
                        "upsert",
                        Some(&memo),
                    )
                    .await?;
                    did_change = true;
                    Ok(())
                }
            }
            "delete_memo" => {
                let deleted: Option<i64> =
                    sqlx::query_scalar("SELECT deleted FROM memos WHERE user_id=? AND id=?")
                        .bind(user.user_id)
                        .bind(&operation.entity_id)
                        .fetch_optional(&mut *transaction)
                        .await?;
                if deleted != Some(1) {
                    let stored: Vec<String> = sqlx::query_scalar("SELECT storage_key FROM attachments WHERE user_id=? AND memo_id=? AND storage_key IS NOT NULL AND deleted=0").bind(user.user_id).bind(&operation.entity_id).fetch_all(&mut *transaction).await?;
                    files_to_delete.extend(stored.into_iter().map(PathBuf::from));
                    sqlx::query("UPDATE attachments SET deleted=1 WHERE user_id=? AND memo_id=?")
                        .bind(user.user_id)
                        .bind(&operation.entity_id)
                        .execute(&mut *transaction)
                        .await?;
                    let seq = next_seq(&mut transaction, user.user_id).await?;
                    sqlx::query("INSERT INTO memos(user_id,id,space_id,body,created_at,updated_at,deleted,server_seq) VALUES(?,?,'','','','',1,?) ON CONFLICT(user_id,id) DO UPDATE SET deleted=1,server_seq=excluded.server_seq")
                        .bind(user.user_id)
                        .bind(&operation.entity_id)
                        .bind(seq)
                        .execute(&mut *transaction)
                        .await?;
                    record_change::<Value>(
                        &mut transaction,
                        user.user_id,
                        seq,
                        "memo",
                        &operation.entity_id,
                        "delete",
                        None,
                    )
                    .await?;
                    did_change = true;
                }
                Ok(())
            }
            _ => Err(AppError::BadRequest(format!(
                "unknown operation kind {}",
                operation.kind
            ))),
        };
        if let Err(error) = result {
            rejected.push(Rejection {
                id: operation.id,
                reason: error.to_string(),
            });
        }
    }

    let limit = input.limit.unwrap_or(1000).clamp(1, 1000);
    let rows = sqlx::query("SELECT seq,entity_type,entity_id,operation,payload_json FROM changes WHERE user_id=? AND seq>? ORDER BY seq LIMIT ?")
        .bind(user.user_id).bind(input.cursor).bind(limit).fetch_all(&mut *transaction).await?;
    let mut changes = Vec::with_capacity(rows.len());
    for row in rows {
        let json: Option<String> = row.get("payload_json");
        changes.push(ServerChange {
            seq: row.get("seq"),
            entity_type: row.get("entity_type"),
            entity_id: row.get("entity_id"),
            operation: row.get("operation"),
            payload: json.map(|value| serde_json::from_str(&value)).transpose()?,
        });
    }
    let cursor = changes
        .last()
        .map(|change| change.seq)
        .unwrap_or(input.cursor);
    let latest: i64 = sqlx::query_scalar("SELECT next_seq FROM users WHERE id=?")
        .bind(user.user_id)
        .fetch_one(&mut *transaction)
        .await?;
    transaction.commit().await?;
    for path in files_to_delete {
        if let Err(error) = tokio::fs::remove_file(path).await
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%error, "unable to remove attachment blob");
        }
    }
    if did_change {
        let _ = state.changes.send(ChangeNotice {
            user_id: user.user_id,
        });
    }
    Ok(Json(SyncResponse {
        cursor,
        has_more: latest > cursor,
        acknowledged,
        rejected,
        changes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::Config,
        db,
        models::{PendingOperation, Profile, SyncRequest},
    };
    use axum::extract::{Extension, State};
    use std::{path::PathBuf, sync::Arc};
    use tempfile::tempdir;

    #[test]
    fn sync_limit_is_bounded() {
        assert_eq!(5000_i64.clamp(1, 1000), 1000);
        assert_eq!(0_i64.clamp(1, 1000), 1);
    }

    #[tokio::test]
    async fn operations_are_idempotent_isolated_and_tombstoned() {
        let directory = tempdir().unwrap();
        let pool = db::connect(directory.path()).await.unwrap();
        let config = Arc::new(Config {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            data_dir: directory.path().to_owned(),
            web_dir: PathBuf::new(),
            public_base_url: "http://localhost".into(),
            oidc_issuer: "https://issuer.test".into(),
            oidc_client_id: "client".into(),
            oidc_client_secret: "secret".into(),
            oidc_groups_claim: "groups".into(),
            allowed_groups: Arc::new(vec!["devs".into()]),
            session_key: [0; 32],
            max_attachment_bytes: 1024,
        });
        let (sender, _) = tokio::sync::broadcast::channel(8);
        let state = AppState {
            config,
            db: pool.clone(),
            http: reqwest::Client::new(),
            changes: sender,
        };
        let user1 = db::ensure_user(
            &pool,
            "https://issuer.test",
            &Profile {
                subject: "one".into(),
                display_name: "One".into(),
                groups: vec!["devs".into()],
            },
        )
        .await
        .unwrap();
        let user2 = db::ensure_user(
            &pool,
            "https://issuer.test",
            &Profile {
                subject: "two".into(),
                display_name: "Two".into(),
                groups: vec!["devs".into()],
            },
        )
        .await
        .unwrap();
        let inbox: String =
            sqlx::query_scalar("SELECT id FROM spaces WHERE user_id=? AND is_inbox=1")
                .bind(user1)
                .fetch_one(&pool)
                .await
                .unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let memo = Memo {
            id: uuid::Uuid::now_v7().to_string(),
            space_id: inbox,
            body: "https://youtube.com #link".into(),
            tags: vec!["link".into()],
            attachment_ids: vec![],
            created_at: now.clone(),
            updated_at: now.clone(),
            sync_state: "pending".into(),
        };
        let upsert = PendingOperation {
            id: "op-upsert".into(),
            kind: "upsert_memo".into(),
            entity_id: memo.id.clone(),
            payload: Some(serde_json::to_value(&memo).unwrap()),
            created_at: now.clone(),
            attempts: 0,
        };
        let response = sync(
            Extension(AuthUser { user_id: user1 }),
            State(state.clone()),
            Json(SyncRequest {
                cursor: 0,
                operations: vec![upsert],
                limit: Some(1000),
            }),
        )
        .await
        .unwrap()
        .0;
        assert!(
            response
                .changes
                .iter()
                .any(|change| change.entity_id == memo.id)
        );
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM changes WHERE user_id=? AND entity_id=?")
                .bind(user1)
                .bind(&memo.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let duplicate = PendingOperation {
            id: "op-upsert".into(),
            kind: "upsert_memo".into(),
            entity_id: memo.id.clone(),
            payload: Some(serde_json::to_value(&memo).unwrap()),
            created_at: now.clone(),
            attempts: 0,
        };
        let _ = sync(
            Extension(AuthUser { user_id: user1 }),
            State(state.clone()),
            Json(SyncRequest {
                cursor: response.cursor,
                operations: vec![duplicate],
                limit: None,
            }),
        )
        .await
        .unwrap();
        let after: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM changes WHERE user_id=? AND entity_id=?")
                .bind(user1)
                .bind(&memo.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, after);
        let other = sync(
            Extension(AuthUser { user_id: user2 }),
            State(state.clone()),
            Json(SyncRequest {
                cursor: 0,
                operations: vec![],
                limit: None,
            }),
        )
        .await
        .unwrap()
        .0;
        assert!(
            !other
                .changes
                .iter()
                .any(|change| change.entity_id == memo.id)
        );
        let delete = PendingOperation {
            id: "op-delete".into(),
            kind: "delete_memo".into(),
            entity_id: memo.id.clone(),
            payload: None,
            created_at: now.clone(),
            attempts: 0,
        };
        let _ = sync(
            Extension(AuthUser { user_id: user1 }),
            State(state.clone()),
            Json(SyncRequest {
                cursor: 0,
                operations: vec![delete],
                limit: None,
            }),
        )
        .await
        .unwrap();
        let stale = PendingOperation {
            id: "op-stale".into(),
            kind: "upsert_memo".into(),
            entity_id: memo.id.clone(),
            payload: Some(serde_json::to_value(&memo).unwrap()),
            created_at: now,
            attempts: 0,
        };
        let rejected = sync(
            Extension(AuthUser { user_id: user1 }),
            State(state),
            Json(SyncRequest {
                cursor: 0,
                operations: vec![stale],
                limit: None,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(rejected.rejected.len(), 1);
    }
}
