use crate::{AppState, db, error::AppError, models::Profile};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use axum::{
    Json,
    body::Body,
    extract::{Extension, Query, State},
    http::{HeaderMap, Request, StatusCode, header},
    middleware::Next,
    response::{Html, IntoResponse, Redirect, Response},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use jsonwebtoken::{DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::HashSet;
use time::Duration;
use url::Url;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginQuery {
    mode: Option<String>,
    code_challenge: Option<String>,
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: String,
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRequest {
    code: String,
    code_verifier: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeResponse {
    session_token: String,
    expires_at: i64,
    profile: Profile,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    id_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct RefreshResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

fn verified_profile(
    userinfo: &Value,
    expected_subject: &str,
    groups_claim: &str,
    allowed_groups: &[String],
) -> Result<Profile, AppError> {
    let subject = userinfo
        .get("sub")
        .and_then(Value::as_str)
        .ok_or(AppError::Forbidden)?;
    if subject != expected_subject {
        return Err(AppError::Forbidden);
    }
    let groups: Vec<String> = userinfo
        .get(groups_claim)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if !groups.iter().any(|group| allowed_groups.contains(group)) {
        return Err(AppError::Forbidden);
    }
    let display_name = userinfo
        .get("name")
        .or_else(|| userinfo.get("preferred_username"))
        .and_then(Value::as_str)
        .unwrap_or(subject)
        .to_owned();
    Ok(Profile {
        subject: subject.into(),
        display_name,
        groups,
    })
}

// Serialize renewal per stripe: providers may rotate refresh tokens after each use.
static RENEW_LOCKS: std::sync::LazyLock<Vec<tokio::sync::Mutex<()>>> =
    std::sync::LazyLock::new(|| (0..64).map(|_| tokio::sync::Mutex::new(())).collect());

async fn renew_membership(state: &AppState, user_id: i64) -> Result<(), AppError> {
    let _guard = RENEW_LOCKS[user_id as usize % 64].lock().await;
    let row = sqlx::query("SELECT c.*,u.subject FROM oidc_credentials c JOIN users u ON u.id=c.user_id WHERE c.user_id=?")
        .bind(user_id).fetch_optional(&state.db).await?.ok_or(AppError::Unauthorized)?;
    let now = Utc::now().timestamp();
    if row.get::<i64, _>("checked_at") > now - 900 {
        return Ok(());
    }
    let mut access = open_credential(state, &row.get::<String, _>("access_token"))?;
    if row.get::<i64, _>("expires_at") <= now + 30 {
        let refresh = row
            .get::<Option<String>, _>("refresh_token")
            .ok_or(AppError::Unauthorized)?;
        let refresh = open_credential(state, &refresh)?;
        let tokens: RefreshResponse = state
            .http
            .post(format!("{}/token", state.config.oidc_issuer))
            .basic_auth(
                &state.config.oidc_client_id,
                Some(&state.config.oidc_client_secret),
            )
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
            ])
            .send()
            .await
            .map_err(|e| AppError::Internal(e.into()))?
            .error_for_status()
            .map_err(|_| AppError::Unauthorized)?
            .json()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        access = tokens.access_token;
        let rotated = tokens
            .refresh_token
            .map(|value| seal_credential(state, &value))
            .transpose()?;
        // Persist rotations before UserInfo so a transient UserInfo failure doesn't lose the new token.
        sqlx::query("UPDATE oidc_credentials SET access_token=?,refresh_token=COALESCE(?,refresh_token),expires_at=? WHERE user_id=?")
            .bind(seal_credential(state, &access)?).bind(rotated).bind(now + tokens.expires_in.unwrap_or(300).clamp(0, 86400)).bind(user_id).execute(&state.db).await?;
    }
    let userinfo: Value = state
        .http
        .get(format!("{}/me", state.config.oidc_issuer))
        .bearer_auth(&access)
        .send()
        .await
        .map_err(|e| AppError::Internal(e.into()))?
        .error_for_status()
        .map_err(|_| AppError::Unauthorized)?
        .json()
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    let profile = match verified_profile(
        &userinfo,
        &row.get::<String, _>("subject"),
        &state.config.oidc_groups_claim,
        &state.config.allowed_groups,
    ) {
        Ok(profile) => profile,
        Err(error) => {
            sqlx::query("DELETE FROM sessions WHERE user_id=?")
                .bind(user_id)
                .execute(&state.db)
                .await?;
            return Err(error);
        }
    };
    db::ensure_user(&state.db, &state.config.oidc_issuer, &profile)
        .await
        .map_err(AppError::Internal)?;
    sqlx::query("UPDATE oidc_credentials SET checked_at=? WHERE user_id=?")
        .bind(now)
        .bind(user_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

fn random_token(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    OsRng.fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn seal_credential(state: &AppState, value: &str) -> Result<String, AppError> {
    let cipher =
        Aes256Gcm::new_from_slice(&state.config.session_key).map_err(|_| AppError::Forbidden)?;
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce), value.as_bytes())
        .map_err(|_| AppError::Forbidden)?;
    let mut sealed = nonce.to_vec();
    sealed.extend(encrypted);
    Ok(URL_SAFE_NO_PAD.encode(sealed))
}

fn open_credential(state: &AppState, value: &str) -> Result<String, AppError> {
    let sealed = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::Forbidden)?;
    if sealed.len() < 13 {
        return Err(AppError::Forbidden);
    }
    let cipher =
        Aes256Gcm::new_from_slice(&state.config.session_key).map_err(|_| AppError::Forbidden)?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&sealed[..12]), &sealed[12..])
        .map_err(|_| AppError::Forbidden)?;
    String::from_utf8(plaintext).map_err(|_| AppError::Forbidden)
}

pub fn token_hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn pkce_challenge(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

pub async fn login(
    State(state): State<AppState>,
    Query(query): Query<LoginQuery>,
) -> Result<Response, AppError> {
    if state.config.oidc_client_id.is_empty() || state.config.oidc_client_secret.is_empty() {
        return Err(AppError::BadRequest("OIDC is not configured".into()));
    }
    let mode = query.mode.unwrap_or_else(|| "web".into());
    if mode != "web" && mode != "native" {
        return Err(AppError::BadRequest("mode must be web or native".into()));
    }
    if mode == "native" && query.code_challenge.as_deref().unwrap_or_default().len() < 43 {
        return Err(AppError::BadRequest(
            "native login requires an S256 code challenge".into(),
        ));
    }
    let state_value = random_token(32);
    let nonce = random_token(24);
    let verifier = random_token(48);
    let expires = Utc::now().timestamp() + 600;
    sqlx::query("INSERT INTO auth_flows(state_hash,nonce,oidc_verifier,mode,native_challenge,expires_at) VALUES(?,?,?,?,?,?)")
        .bind(token_hash(&state_value)).bind(&nonce).bind(seal_credential(&state, &verifier)?).bind(&mode).bind(query.code_challenge).bind(expires).execute(&state.db).await?;
    let callback = format!("{}/auth/oidc/callback", state.config.public_base_url);
    let mut url = Url::parse(&format!("{}/auth", state.config.oidc_issuer))
        .map_err(|e| AppError::Internal(e.into()))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &state.config.oidc_client_id)
        .append_pair("redirect_uri", &callback)
        .append_pair("scope", "openid profile email groups")
        .append_pair("state", &state_value)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge", &pkce_challenge(&verifier))
        .append_pair("code_challenge_method", "S256");
    let cookie = Cookie::build(("scratchwall_login", state_value))
        .path("/auth/oidc/callback")
        .http_only(true)
        .secure(state.config.public_base_url.starts_with("https://"))
        .same_site(SameSite::Lax)
        .max_age(Duration::minutes(10))
        .build();
    let mut response = Redirect::temporary(url.as_str()).into_response();
    response
        .headers_mut()
        .append(header::SET_COOKIE, cookie.to_string().parse().unwrap());
    Ok(response)
}

fn native_app_url(code: &str) -> String {
    format!("scratchwall://auth/callback?code={code}")
}

fn native_intent_url(code: &str) -> String {
    format!(
        "intent://auth/callback?code={code}#Intent;scheme=scratchwall;package=uk.morad.scratchwall;end"
    )
}

fn native_return_html(code: &str) -> String {
    let app = native_app_url(code);
    let intent = native_intent_url(code);
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Scratchwall</title></head><body style="font-family:system-ui;background:#101218;color:#eef0f7;display:grid;place-items:center;min-height:100vh;margin:0"><main style="text-align:center;padding:24px;max-width:28rem"><p>Sign-in complete. Opening Scratchwall…</p><p><a id="open" href="{app}" style="display:inline-block;margin-top:12px;padding:12px 20px;border-radius:12px;background:#7c6cff;color:#fff;text-decoration:none;font-weight:600">Open Scratchwall</a></p><p><a href="{intent}" style="color:#9f94ff">Open on Android</a></p></main><iframe src="{app}" style="display:none" title=""></iframe><script>(function(){{var app={app:?};var intent={intent:?};location.replace(app);setTimeout(function(){{location.replace(intent)}},250);}})();</script></body></html>"#
    )
}

fn is_android_user_agent(user_agent: Option<&str>) -> bool {
    user_agent.is_some_and(|value| value.to_ascii_lowercase().contains("android"))
}

fn native_return_response(code: &str, user_agent: Option<&str>) -> Response {
    let html = native_return_html(code);
    if is_android_user_agent(user_agent) {
        let mut response = Html(html).into_response();
        *response.status_mut() = StatusCode::FOUND;
        if let Ok(location) = native_app_url(code).parse() {
            response.headers_mut().insert(header::LOCATION, location);
        }
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        response
    } else {
        let mut response = Html(html).into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        response
    }
}

pub async fn callback(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Query(query): Query<CallbackQuery>,
) -> Result<Response, AppError> {
    if jar.get("scratchwall_login").map(Cookie::value) != Some(query.state.as_str()) {
        return Err(AppError::Forbidden);
    }
    let row = sqlx::query("DELETE FROM auth_flows WHERE state_hash=? AND expires_at>? RETURNING nonce,oidc_verifier,mode,native_challenge")
        .bind(token_hash(&query.state)).bind(Utc::now().timestamp()).fetch_optional(&state.db).await?.ok_or_else(|| AppError::BadRequest("login state expired or invalid".into()))?;
    let nonce: String = row.get("nonce");
    let verifier = open_credential(&state, row.get::<String, _>("oidc_verifier").as_str())?;
    let mode: String = row.get("mode");
    let native_challenge: Option<String> = row.get("native_challenge");
    let callback = format!("{}/auth/oidc/callback", state.config.public_base_url);
    let token: TokenResponse = state
        .http
        .post(format!("{}/token", state.config.oidc_issuer))
        .basic_auth(
            &state.config.oidc_client_id,
            Some(&state.config.oidc_client_secret),
        )
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", query.code.as_str()),
            ("redirect_uri", callback.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|e| AppError::Internal(e.into()))?
        .error_for_status()
        .map_err(|_| AppError::Forbidden)?
        .json()
        .await
        .map_err(|e| AppError::Internal(e.into()))?;

    let header = decode_header(&token.id_token).map_err(|_| AppError::Forbidden)?;
    let jwks: JwkSet = state
        .http
        .get(format!("{}/jwks", state.config.oidc_issuer))
        .send()
        .await
        .map_err(|e| AppError::Internal(e.into()))?
        .error_for_status()
        .map_err(|_| AppError::Forbidden)?
        .json()
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    let jwk = jwks
        .find(header.kid.as_deref().ok_or(AppError::Forbidden)?)
        .ok_or(AppError::Forbidden)?;
    let key = DecodingKey::from_jwk(jwk).map_err(|_| AppError::Forbidden)?;
    let mut validation = Validation::new(header.alg);
    validation.set_audience(&[state.config.oidc_client_id.as_str()]);
    validation.set_issuer(&[state.config.oidc_issuer.as_str()]);
    let claims = decode::<Value>(&token.id_token, &key, &validation)
        .map_err(|_| AppError::Forbidden)?
        .claims;
    if claims.get("nonce").and_then(Value::as_str) != Some(&nonce) {
        return Err(AppError::Forbidden);
    }
    let userinfo: Value = state
        .http
        .get(format!("{}/me", state.config.oidc_issuer))
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(|e| AppError::Internal(e.into()))?
        .error_for_status()
        .map_err(|_| AppError::Forbidden)?
        .json()
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    let groups_value = userinfo.get(&state.config.oidc_groups_claim);
    let groups: Vec<String> = groups_value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let allowed: HashSet<&str> = state
        .config
        .allowed_groups
        .iter()
        .map(String::as_str)
        .collect();
    if !groups.iter().any(|group| allowed.contains(group.as_str())) {
        return Err(AppError::Forbidden);
    }
    let subject = userinfo
        .get("sub")
        .and_then(Value::as_str)
        .ok_or(AppError::Forbidden)?
        .to_owned();
    if claims.get("sub").and_then(Value::as_str) != Some(subject.as_str()) {
        return Err(AppError::Forbidden);
    }
    let display_name = userinfo
        .get("name")
        .or_else(|| userinfo.get("preferred_username"))
        .or_else(|| claims.get("name"))
        .and_then(Value::as_str)
        .unwrap_or(&subject)
        .to_owned();
    let profile = Profile {
        subject,
        display_name,
        groups,
    };
    let user_id = db::ensure_user(&state.db, &state.config.oidc_issuer, &profile)
        .await
        .map_err(AppError::Internal)?;
    sqlx::query("INSERT INTO oidc_credentials(user_id,access_token,refresh_token,expires_at,checked_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET access_token=excluded.access_token,refresh_token=excluded.refresh_token,expires_at=excluded.expires_at,checked_at=excluded.checked_at")
        .bind(user_id).bind(seal_credential(&state, &token.access_token)?)
        .bind(token.refresh_token.map(|value| seal_credential(&state, &value)).transpose()?)
        .bind(Utc::now().timestamp() + token.expires_in.unwrap_or(300).clamp(0, 86400))
        .bind(Utc::now().timestamp()).execute(&state.db).await?;

    if mode == "native" {
        let code = random_token(32);
        sqlx::query(
            "INSERT INTO native_codes(code_hash,user_id,challenge,expires_at) VALUES(?,?,?,?)",
        )
        .bind(token_hash(&code))
        .bind(user_id)
        .bind(native_challenge.ok_or(AppError::Forbidden)?)
        .bind(Utc::now().timestamp() + 600)
        .execute(&state.db)
        .await?;
        let user_agent = headers
            .get(header::USER_AGENT)
            .and_then(|value| value.to_str().ok());
        return Ok(native_return_response(&code, user_agent));
    }

    let (session, expires_at) = create_session(&state, user_id).await?;
    let secure = state.config.public_base_url.starts_with("https://");
    let cookie = Cookie::build(("scratchwall_session", session))
        .path("/")
        .http_only(true)
        .secure(secure)
        .same_site(SameSite::Lax)
        .max_age(Duration::days(30))
        .build();
    let mut response = Redirect::to("/").into_response();
    response
        .headers_mut()
        .append(header::SET_COOKIE, cookie.to_string().parse().unwrap());
    tracing::info!(user_id, expires_at, "web session created");
    Ok(response)
}

async fn create_session(state: &AppState, user_id: i64) -> Result<(String, i64), AppError> {
    let token = random_token(32);
    let expires = Utc::now().timestamp() + 30 * 24 * 60 * 60;
    sqlx::query(
        "INSERT INTO sessions(id,token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?,?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(token_hash(&token))
    .bind(user_id)
    .bind(expires)
    .bind(Utc::now().timestamp())
    .execute(&state.db)
    .await?;
    Ok((token, expires))
}

pub async fn exchange(
    State(state): State<AppState>,
    Json(input): Json<ExchangeRequest>,
) -> Result<Json<ExchangeResponse>, AppError> {
    let row = sqlx::query(
        "DELETE FROM native_codes WHERE code_hash=? AND expires_at>? RETURNING user_id,challenge",
    )
    .bind(token_hash(&input.code))
    .bind(Utc::now().timestamp())
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::Forbidden)?;
    let challenge: String = row.get("challenge");
    if pkce_challenge(&input.code_verifier) != challenge {
        return Err(AppError::Forbidden);
    }
    let user_id: i64 = row.get("user_id");
    let (session_token, expires_at) = create_session(&state, user_id).await?;
    let profile = db::profile_for_user(&state.db, user_id)
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(ExchangeResponse {
        session_token,
        expires_at,
        profile,
    }))
}

pub async fn me(
    Extension(user): Extension<AuthUser>,
    State(state): State<AppState>,
) -> Result<Json<Profile>, AppError> {
    Ok(Json(
        db::profile_for_user(&state.db, user.user_id)
            .await
            .map_err(AppError::Internal)?,
    ))
}

pub async fn logout(
    Extension(user): Extension<AuthUser>,
    State(state): State<AppState>,
    request: Request<Body>,
) -> Result<Response, AppError> {
    if let Some(token) = extract_token(&request) {
        sqlx::query("DELETE FROM sessions WHERE user_id=? AND token_hash=?")
            .bind(user.user_id)
            .bind(token_hash(&token))
            .execute(&state.db)
            .await?;
    }
    let cookie = Cookie::build(("scratchwall_session", ""))
        .path("/")
        .http_only(true)
        .secure(state.config.public_base_url.starts_with("https://"))
        .max_age(Duration::ZERO)
        .build();
    let mut response = axum::http::StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .append(header::SET_COOKIE, cookie.to_string().parse().unwrap());
    Ok(response)
}

fn extract_token(request: &Request<Body>) -> Option<String> {
    if let Some(value) = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        return Some(value.to_owned());
    }
    request
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|cookies| {
            cookies
                .split(';')
                .map(str::trim)
                .find_map(|item| item.strip_prefix("scratchwall_session=").map(str::to_owned))
        })
}

pub async fn require_auth(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let token = extract_token(&request).ok_or(AppError::Unauthorized)?;
    if !request.headers().contains_key(header::AUTHORIZATION)
        && let Some(origin) = request.headers().get(header::ORIGIN)
        && origin.to_str().ok() != Some(state.config.public_base_url.as_str())
    {
        return Err(AppError::Forbidden);
    }
    let user_id: Option<i64> =
        sqlx::query_scalar("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?")
            .bind(token_hash(&token))
            .bind(Utc::now().timestamp())
            .fetch_optional(&state.db)
            .await?;
    let user_id = user_id.ok_or(AppError::Unauthorized)?;
    renew_membership(&state, user_id).await?;
    request.extensions_mut().insert(AuthUser { user_id });
    Ok(next.run(request).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn userinfo_membership_and_subject_fail_closed() {
        let allowed = vec!["admins".into(), "devs".into()];
        assert!(
            verified_profile(
                &serde_json::json!({"sub":"one","groups":["devs"]}),
                "one",
                "groups",
                &allowed
            )
            .is_ok()
        );
        for value in [
            serde_json::json!({"sub":"other","groups":["admins"]}),
            serde_json::json!({"sub":"one"}),
            serde_json::json!({"sub":"one","groups":["visitors"]}),
        ] {
            assert!(verified_profile(&value, "one", "groups", &allowed).is_err());
        }
    }
    #[test]
    fn pkce_is_stable() {
        assert_eq!(
            pkce_challenge("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"),
            "ImpiCd8pp4MveCNnbIS7-GXEtB0xF5HMIDoWqvGA5ig"
        );
    }

    #[test]
    fn native_return_page_can_be_opened_manually() {
        let html = native_return_html("abc_CODE-123");
        assert!(html.contains(r#"href="scratchwall://auth/callback?code=abc_CODE-123""#));
        assert!(html.contains("package=uk.morad.scratchwall"));
        assert!(html.contains("Open Scratchwall"));
        assert!(html.contains("<iframe"));
    }

    #[test]
    fn android_native_return_redirects_to_the_app_scheme() {
        let response = native_return_response(
            "abc",
            Some("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0"),
        );
        assert_eq!(response.status(), StatusCode::FOUND);
        assert_eq!(
            response.headers().get(header::LOCATION).unwrap(),
            "scratchwall://auth/callback?code=abc"
        );
    }

    #[test]
    fn desktop_native_return_keeps_the_open_link_visible() {
        let response = native_return_response(
            "abc",
            Some("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0"),
        );
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn credentials_are_randomized_and_round_trip() {
        let config = crate::config::Config {
            listen_addr: "127.0.0.1:8080".parse().unwrap(),
            data_dir: ".".into(),
            web_dir: ".".into(),
            public_base_url: "https://example.test".into(),
            oidc_issuer: "https://issuer.test".into(),
            oidc_client_id: "id".into(),
            oidc_client_secret: "secret".into(),
            oidc_groups_claim: "groups".into(),
            allowed_groups: std::sync::Arc::new(vec!["admins".into()]),
            session_key: [7; 32],
            max_attachment_bytes: 1024,
        };
        let (changes, _) = tokio::sync::broadcast::channel(1);
        let state = AppState {
            config: std::sync::Arc::new(config),
            db: sqlx::SqlitePool::connect_lazy("sqlite::memory:").unwrap(),
            http: reqwest::Client::new(),
            changes,
        };
        let first = seal_credential(&state, "credential").unwrap();
        let second = seal_credential(&state, "credential").unwrap();
        assert_ne!(first, second);
        assert_eq!(open_credential(&state, &first).unwrap(), "credential");
    }
}
