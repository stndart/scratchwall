use anyhow::{Context, Result};
use sha2::Digest;
use std::{env, net::SocketAddr, path::PathBuf, sync::Arc};

#[derive(Clone)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub data_dir: PathBuf,
    pub web_dir: PathBuf,
    pub public_base_url: String,
    pub oidc_issuer: String,
    pub oidc_client_id: String,
    pub oidc_client_secret: String,
    pub oidc_groups_claim: String,
    pub allowed_groups: Arc<Vec<String>>,
    pub session_key: [u8; 32],
    pub max_attachment_bytes: u64,
    pub ingest_token_hash: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let session_value =
            env::var("SESSION_ENCRYPTION_KEY").context("SESSION_ENCRYPTION_KEY is required")?;
        anyhow::ensure!(
            session_value.len() >= 32,
            "SESSION_ENCRYPTION_KEY must contain at least 32 random characters"
        );
        let session_key: [u8; 32] = sha2::Sha256::digest(session_value.as_bytes()).into();
        Ok(Self {
            listen_addr: env::var("LISTEN_ADDR")
                .unwrap_or_else(|_| "127.0.0.1:8080".into())
                .parse()
                .context("invalid LISTEN_ADDR")?,
            data_dir: PathBuf::from(env::var("DATA_DIR").unwrap_or_else(|_| "./data".into())),
            web_dir: PathBuf::from(
                env::var("WEB_DIR").unwrap_or_else(|_| "./apps/web/dist".into()),
            ),
            public_base_url: env::var("PUBLIC_BASE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8080".into())
                .trim_end_matches('/')
                .into(),
            oidc_issuer: env::var("OIDC_ISSUER")
                .unwrap_or_else(|_| "https://void.morad.uk/oidc".into())
                .trim_end_matches('/')
                .into(),
            oidc_client_id: env::var("OIDC_CLIENT_ID").unwrap_or_default(),
            oidc_client_secret: env::var("OIDC_CLIENT_SECRET").unwrap_or_default(),
            oidc_groups_claim: env::var("OIDC_GROUPS_CLAIM").unwrap_or_else(|_| "groups".into()),
            allowed_groups: Arc::new(
                env::var("OIDC_ALLOWED_GROUPS")
                    .unwrap_or_else(|_| "admins,devs".into())
                    .split(',')
                    .map(|v| v.trim().to_owned())
                    .filter(|v| !v.is_empty())
                    .collect(),
            ),
            session_key,
            max_attachment_bytes: env::var("MAX_ATTACHMENT_BYTES")
                .unwrap_or_else(|_| "2147483648".into())
                .parse()
                .context("invalid MAX_ATTACHMENT_BYTES")
                .and_then(|value: u64| {
                    anyhow::ensure!(
                        value <= 2_147_483_648,
                        "MAX_ATTACHMENT_BYTES cannot exceed 2 GiB"
                    );
                    Ok(value)
                })?,
            ingest_token_hash: env::var("INGEST_TOKEN")
                .ok()
                .filter(|value| !value.is_empty())
                .map(|value| hex::encode(sha2::Sha256::digest(value.as_bytes()))),
        })
    }
}
