use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub subject: String,
    pub display_name: String,
    pub groups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub is_inbox: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "synced")]
    pub sync_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memo {
    pub id: String,
    pub space_id: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bumped_at: Option<String>,
    pub updated_at: String,
    #[serde(default = "synced")]
    pub sync_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub memo_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    pub remote_ready: bool,
    pub cache_state: String,
    pub created_at: String,
}

fn synced() -> String {
    "synced".into()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingOperation {
    pub id: String,
    pub kind: String,
    pub entity_id: String,
    pub payload: Option<Value>,
    #[allow(dead_code)]
    pub created_at: String,
    #[allow(dead_code)]
    pub attempts: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    #[serde(default)]
    pub cursor: i64,
    #[serde(default)]
    pub operations: Vec<PendingOperation>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerChange {
    pub seq: i64,
    pub entity_type: String,
    pub entity_id: String,
    pub operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rejection {
    pub id: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    pub cursor: i64,
    pub has_more: bool,
    pub acknowledged: Vec<String>,
    pub rejected: Vec<Rejection>,
    pub changes: Vec<ServerChange>,
}
