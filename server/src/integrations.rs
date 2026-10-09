//! Read-only agent credentials. These never authenticate the sync/write API.
use crate::{
    AppState,
    auth::{self, AuthUser},
    error::AppError,
};
use axum::{
    Json,
    body::Body,
    extract::{Extension, Path, Query, State},
    http::{HeaderMap, Request, header},
    middleware::Next,
    response::Response,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

const TTL: i64 = 90 * 24 * 60 * 60;
#[derive(Clone)]
pub struct Grant {
    user_id: i64,
    spaces: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRequest {
    name: String,
    space_ids: Vec<String>,
}

pub async fn issue(
    state: &AppState,
    user_id: i64,
    name: &str,
    ids: &[String],
) -> Result<Value, AppError> {
    if name.trim().is_empty() || name.len() > 100 || ids.is_empty() {
        return Err(AppError::BadRequest(
            "Supply a name and at least one space (or * for all spaces)".into(),
        ));
    }
    let scopes = if ids == ["*"] {
        None
    } else {
        for id in ids {
            let exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM spaces WHERE user_id=? AND id=? AND deleted=0",
            )
            .bind(user_id)
            .bind(id)
            .fetch_one(&state.db)
            .await?;
            if exists != 1 {
                return Err(AppError::BadRequest(
                    "Unknown space; sync your spaces first".into(),
                ));
            }
        }
        Some(serde_json::to_string(ids)?)
    };
    let id = Uuid::new_v4().to_string();
    let token = format!("sw_read_{}", auth::random_token(32));
    let expires = Utc::now().timestamp() + TTL;
    sqlx::query("INSERT INTO integration_tokens(id,user_id,name,token_hash,spaces_json,created_at,expires_at) VALUES(?,?,?,?,?,unixepoch(),?)")
        .bind(&id).bind(user_id).bind(name.trim()).bind(auth::token_hash(&token)).bind(scopes).bind(expires).execute(&state.db).await?;
    Ok(json!({"id": id, "token": token, "expiresAt": expires}))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<TokenRequest>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(
        issue(&state, user.user_id, &input.name, &input.space_ids).await?,
    ))
}
pub async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Value>, AppError> {
    let rows = sqlx::query("SELECT id,name,spaces_json,created_at,expires_at FROM integration_tokens WHERE user_id=? ORDER BY created_at DESC")
        .bind(user.user_id).fetch_all(&state.db).await?;
    Ok(Json(json!(rows.iter().map(|r| json!({"id": r.get::<String,_>("id"), "name": r.get::<String,_>("name"), "spaceIds": r.get::<Option<String>,_>("spaces_json").map(|v| serde_json::from_str::<Value>(&v).unwrap_or(json!([]))).unwrap_or(json!(["*"])), "createdAt": r.get::<i64,_>("created_at"), "expiresAt": r.get::<i64,_>("expires_at")})).collect::<Vec<_>>())))
}
pub async fn revoke(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    sqlx::query("DELETE FROM integration_tokens WHERE user_id=? AND id=?")
        .bind(user.user_id)
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({"revoked": true})))
}

async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<Grant, AppError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer sw_read_"))
        .ok_or(AppError::Unauthorized)?;
    let row = sqlx::query("SELECT user_id,spaces_json FROM integration_tokens WHERE token_hash=? AND expires_at>unixepoch()")
        .bind(auth::token_hash(&format!("sw_read_{token}"))).fetch_optional(&state.db).await?.ok_or(AppError::Unauthorized)?;
    let grant = Grant {
        user_id: row.get("user_id"),
        spaces: row.get("spaces_json"),
    };
    auth::renew_membership(state, grant.user_id).await?;
    Ok(grant)
}
pub async fn require_token(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let grant = authenticate(&state, request.headers()).await?;
    request.extensions_mut().insert(grant);
    Ok(next.run(request).await)
}

pub async fn context(
    State(state): State<AppState>,
    Extension(grant): Extension<Grant>,
) -> Result<Json<Value>, AppError> {
    let user = sqlx::query("SELECT subject,display_name FROM users WHERE id=?")
        .bind(grant.user_id)
        .fetch_one(&state.db)
        .await?;
    let rows = sqlx::query("SELECT id,name,is_inbox FROM spaces WHERE user_id=? AND deleted=0 AND (? IS NULL OR id IN (SELECT value FROM json_each(?))) ORDER BY position,id")
        .bind(grant.user_id).bind(&grant.spaces).bind(&grant.spaces).fetch_all(&state.db).await?;
    Ok(Json(
        json!({"user": {"subject": user.get::<String,_>("subject"), "displayName": user.get::<String,_>("display_name")}, "spaces": rows.iter().map(|r| json!({"id": r.get::<String,_>("id"), "name": r.get::<String,_>("name"), "isInbox": r.get::<bool,_>("is_inbox")})).collect::<Vec<_>>(), "allSpaces": grant.spaces.is_none(), "access": "read-only"}),
    ))
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoQuery {
    space_id: Option<String>,
    q: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
}
fn memo_json(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id": r.get::<String,_>("id"), "spaceId": r.get::<String,_>("space_id"), "spaceName": r.get::<String,_>("space_name"), "body": r.get::<String,_>("body"), "tags": serde_json::from_str::<Value>(&r.get::<String,_>("tags_json")).unwrap_or(json!([])), "attachmentIds": serde_json::from_str::<Value>(&r.get::<String,_>("attachment_ids_json")).unwrap_or(json!([])), "createdAt": r.get::<String,_>("created_at"), "updatedAt": r.get::<String,_>("updated_at")})
}
pub async fn memos(
    State(state): State<AppState>,
    Extension(grant): Extension<Grant>,
    Query(query): Query<MemoQuery>,
) -> Result<Json<Value>, AppError> {
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).max(0);
    // instr treats user search text literally, including SQL wildcard characters.
    let rows = sqlx::query("SELECT m.*,s.name AS space_name FROM memos m JOIN spaces s ON s.user_id=m.user_id AND s.id=m.space_id WHERE m.user_id=? AND m.deleted=0 AND s.deleted=0 AND (? IS NULL OR s.id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR s.id=?) AND (? IS NULL OR instr(lower(m.body || ' ' || m.tags_json),lower(?))>0) ORDER BY m.updated_at DESC,m.id DESC LIMIT ? OFFSET ?")
        .bind(grant.user_id).bind(&grant.spaces).bind(&grant.spaces).bind(&query.space_id).bind(&query.space_id).bind(&query.q).bind(&query.q).bind(limit+1).bind(offset).fetch_all(&state.db).await?;
    Ok(Json(
        json!({"memos": rows.iter().take(limit as usize).map(memo_json).collect::<Vec<_>>(), "nextOffset": if rows.len() > limit as usize {Some(offset+limit)} else {None}}),
    ))
}
pub async fn memo(
    State(state): State<AppState>,
    Extension(grant): Extension<Grant>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = sqlx::query("SELECT m.*,s.name AS space_name FROM memos m JOIN spaces s ON s.user_id=m.user_id AND s.id=m.space_id WHERE m.user_id=? AND m.id=? AND m.deleted=0 AND s.deleted=0 AND (? IS NULL OR s.id IN (SELECT value FROM json_each(?)))")
        .bind(grant.user_id).bind(&id).bind(&grant.spaces).bind(&grant.spaces).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    let mut memo = memo_json(&row);
    let attachments = sqlx::query("SELECT id,filename,mime_type,size FROM attachments WHERE user_id=? AND memo_id=? AND deleted=0")
        .bind(grant.user_id).bind(id).fetch_all(&state.db).await?;
    memo["attachments"] = json!(attachments.iter().map(|r| json!({"id":r.get::<String,_>("id"),"filename":r.get::<String,_>("filename"),"mimeType":r.get::<String,_>("mime_type"),"size":r.get::<i64,_>("size")})).collect::<Vec<_>>());
    Ok(Json(memo))
}

/// Operator-only provisioning; never uses display names to choose an account.
pub async fn provision_cli(state: &AppState, args: &[String]) -> anyhow::Result<()> {
    anyhow::ensure!(
        args.len() == 7 && args[1] == "--user" && args[3] == "--spaces" && args[5] == "--output",
        "Usage: integration-token --user OIDC_SUBJECT --spaces 'Inbox,Backlog' --output /private/config.json (use * for all)"
    );
    let user: i64 = sqlx::query_scalar("SELECT id FROM users WHERE issuer=? AND subject=?")
        .bind(&state.config.oidc_issuer)
        .bind(&args[2])
        .fetch_one(&state.db)
        .await?;
    let mut ids = vec![];
    for name in args[4].split(',').map(str::trim) {
        if name == "*" {
            ids.push("*".into());
            continue;
        }
        let found: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM spaces WHERE user_id=? AND deleted=0 AND (id=? OR name=?)",
        )
        .bind(user)
        .bind(name)
        .bind(name)
        .fetch_all(&state.db)
        .await?;
        anyhow::ensure!(
            found.len() == 1,
            "Space {name} is absent or ambiguous; use its ID"
        );
        ids.push(found[0].clone());
    }
    // Reserve the private output before issuing so an existing credential cannot be overwritten.
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&args[6])?;
    let issued = issue(state, user, "MCP", &ids).await?;
    use std::io::Write;
    file.write_all(serde_json::to_string_pretty(&json!({"url":state.config.public_base_url,"user":args[2],"spaces":ids,"token":issued["token"]}))?.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, db, models::Profile};
    use axum::{
        Router, middleware,
        routing::{get, post},
    };
    use std::sync::Arc;

    #[tokio::test]
    async fn read_tokens_enforce_user_space_expiry_revocation_and_read_only_access() {
        let dir = tempfile::tempdir().unwrap();
        let pool = db::connect(dir.path()).await.unwrap();
        let config = Config {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            data_dir: dir.path().into(),
            web_dir: dir.path().into(),
            public_base_url: "http://localhost".into(),
            oidc_issuer: "https://issuer.test".into(),
            oidc_client_id: "client".into(),
            oidc_client_secret: "secret".into(),
            oidc_groups_claim: "groups".into(),
            allowed_groups: Arc::new(vec!["allowed".into()]),
            session_key: [0; 32],
            max_attachment_bytes: 1024,
            ingest_token_hash: None,
        };
        let (changes, _) = tokio::sync::broadcast::channel(8);
        let state = AppState {
            config: Arc::new(config),
            db: pool.clone(),
            http: reqwest::Client::new(),
            changes,
        };
        let a = db::ensure_user(
            &pool,
            "https://issuer.test",
            &Profile {
                subject: "a".into(),
                display_name: "A".into(),
                groups: vec!["allowed".into()],
            },
        )
        .await
        .unwrap();
        let b = db::ensure_user(
            &pool,
            "https://issuer.test",
            &Profile {
                subject: "b".into(),
                display_name: "B".into(),
                groups: vec!["allowed".into()],
            },
        )
        .await
        .unwrap();
        for user in [a, b] {
            sqlx::query("INSERT INTO oidc_credentials(user_id,access_token,refresh_token,expires_at,checked_at) VALUES(?,'unused','unused',unixepoch()+3600,unixepoch())").bind(user).execute(&pool).await.unwrap();
            for (id, name) in [("shared", "Backlog"), ("private", "Private")] {
                sqlx::query("INSERT INTO spaces(user_id,id,name,position,created_at,updated_at,server_seq) VALUES(?,?,?,1,'now','now',1)").bind(user).bind(id).bind(name).execute(&pool).await.unwrap();
                for i in 0..3 {
                    sqlx::query("INSERT INTO memos(user_id,id,space_id,body,created_at,updated_at,server_seq) VALUES(?,?,?,'test literal_%','now','now',1)").bind(user).bind(format!("{id}{i}")).bind(id).execute(&pool).await.unwrap();
                }
            }
        }
        assert!(issue(&state, a, "empty", &[]).await.is_err());
        assert!(
            issue(&state, a, "missing", &["missing".into()])
                .await
                .is_err()
        );
        assert!(
            issue(&state, a, "mixed", &["*".into(), "shared".into()])
                .await
                .is_err()
        );
        let issued = issue(&state, a, "test", &["shared".into()]).await.unwrap();
        let token = issued["token"].as_str().unwrap();
        let hash: String =
            sqlx::query_scalar("SELECT token_hash FROM integration_tokens WHERE id=?")
                .bind(issued["id"].as_str().unwrap())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_ne!(hash, token);
        let reads = Router::new()
            .route("/context", get(context))
            .route("/memos", get(memos))
            .route("/memos/{id}", get(memo))
            .route_layer(middleware::from_fn_with_state(state.clone(), require_token));
        let writes = Router::new()
            .route("/write", post(|| async { "unexpected" }))
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                auth::require_auth,
            ));
        let app = reads.merge(writes).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let c: Value = client
            .get(format!("{base}/context"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(c["user"]["subject"], "a");
        assert_eq!(c["spaces"].as_array().unwrap().len(), 1);
        assert_eq!(
            client
                .get(format!("{base}/context"))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            client
                .post(format!("{base}/write"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        let page: Value = client
            .get(format!("{base}/memos?limit=2&q=literal_%"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(page["memos"].as_array().unwrap().len(), 2);
        assert_eq!(page["nextOffset"], 2);
        let hidden: Value = client
            .get(format!("{base}/memos?spaceId=private"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(hidden["memos"].as_array().unwrap().is_empty());
        assert_eq!(
            client
                .get(format!("{base}/memos/private0"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        // Matching IDs in another account cannot leak that account's memo.
        sqlx::query("UPDATE memos SET body='OTHER USER' WHERE user_id=?")
            .bind(b)
            .execute(&pool)
            .await
            .unwrap();
        let one: Value = client
            .get(format!("{base}/memos/shared0"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(one["body"], "test literal_%");
        sqlx::query("UPDATE spaces SET name='Renamed' WHERE user_id=? AND id='shared'")
            .bind(a)
            .execute(&pool)
            .await
            .unwrap();
        let c: Value = context(
            State(state.clone()),
            Extension(Grant {
                user_id: a,
                spaces: Some("[\"shared\"]".into()),
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(c["spaces"][0]["name"], "Renamed");
        sqlx::query("UPDATE memos SET space_id='private' WHERE user_id=? AND id='shared0'")
            .bind(a)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            client
                .get(format!("{base}/memos/shared0"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        // Another user's revoke cannot remove this user's token.
        let _ = revoke(
            State(state.clone()),
            Extension(AuthUser { user_id: b }),
            Path(issued["id"].as_str().unwrap().into()),
        )
        .await
        .unwrap();
        assert_eq!(
            client
                .get(format!("{base}/context"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        sqlx::query("UPDATE integration_tokens SET expires_at=0 WHERE id=?")
            .bind(issued["id"].as_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            client
                .get(format!("{base}/context"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        let all = issue(&state, a, "all", &["*".into()]).await.unwrap();
        sqlx::query("INSERT INTO spaces(user_id,id,name,position,created_at,updated_at,server_seq) VALUES(?,'future','Future',1,'now','now',1)").bind(a).execute(&pool).await.unwrap();
        let c: Value = client
            .get(format!("{base}/context"))
            .bearer_auth(all["token"].as_str().unwrap())
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        // Includes the Inbox created by ensure_user, the two fixtures, and Future.
        assert_eq!(c["spaces"].as_array().unwrap().len(), 4);
        let _ = revoke(
            State(state.clone()),
            Extension(AuthUser { user_id: a }),
            Path(all["id"].as_str().unwrap().into()),
        )
        .await
        .unwrap();
        assert_eq!(
            client
                .get(format!("{base}/context"))
                .bearer_auth(all["token"].as_str().unwrap())
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        let deleted = issue(&state, a, "deleted", &["shared".into()])
            .await
            .unwrap();
        sqlx::query("UPDATE spaces SET deleted=1 WHERE user_id=? AND id='shared'")
            .bind(a)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            client
                .get(format!("{base}/memos/shared1"))
                .bearer_auth(deleted["token"].as_str().unwrap())
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        handle.abort();
    }
}
