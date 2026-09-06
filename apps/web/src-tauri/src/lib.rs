use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_sql::{Migration, MigrationKind};

#[tauri::command]
async fn open_attachment(
    app: tauri::AppHandle,
    instances: tauri::State<'_, tauri_plugin_sql::DbInstances>,
    id: String,
) -> Result<(), String> {
    let databases = instances.0.read().await;
    let Some(tauri_plugin_sql::DbPool::Sqlite(pool)) = databases.get("sqlite:scratchwall.sqlite")
    else {
        return Err("Local database is not loaded".into());
    };
    let relative: Option<String> =
        sqlx::query_scalar("SELECT blob_path FROM attachments WHERE id=?")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .flatten();
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("attachments")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(relative.ok_or("File is not cached")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("Invalid cached file path".into());
    }
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
struct Statement {
    sql: String,
    values: Vec<serde_json::Value>,
}

#[tauri::command]
async fn local_transaction(
    instances: tauri::State<'_, tauri_plugin_sql::DbInstances>,
    statements: Vec<Statement>,
) -> Result<(), String> {
    let databases = instances.0.read().await;
    let Some(tauri_plugin_sql::DbPool::Sqlite(pool)) = databases.get("sqlite:scratchwall.sqlite")
    else {
        return Err("Local database is not loaded".into());
    };
    let mut transaction = pool.begin().await.map_err(|e| e.to_string())?;
    for statement in statements {
        let mut query = sqlx::query(&statement.sql);
        for value in statement.values {
            query = match value {
                serde_json::Value::Null => query.bind(None::<String>),
                serde_json::Value::String(value) => query.bind(value),
                serde_json::Value::Number(value) => {
                    query.bind(value.as_i64().ok_or("Expected integer")?)
                }
                serde_json::Value::Bool(value) => query.bind(value),
                _ => return Err("Unsupported SQL parameter".into()),
            };
        }
        query
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
    }
    transaction.commit().await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create local-first stores",
            sql: r#"
CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, position INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memos (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, space_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memos_space ON memos(space_id, created_at);
CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, memo_id TEXT NOT NULL, blob BLOB);
CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, value_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "store native attachment paths",
            sql: "ALTER TABLE attachments ADD COLUMN blob_path TEXT;",
            kind: MigrationKind::Up,
        },
    ];

    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    builder
        .invoke_handler(tauri::generate_handler![local_transaction, open_attachment])
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:scratchwall.sqlite", migrations)
                .build(),
        )
        .setup(|app| {
            // Portable EXE/AppImage builds are not installed, so the OS will not
            // associate scratchwall:// unless the running binary registers it.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Scratchwall");
}
