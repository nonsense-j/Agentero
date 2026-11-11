//! Tauri command for syncing the Plaza Paper Collection pool to the local Host cache
//! consumed by the session-scoped `agentero-collection` MCP server.

use crate::core::error::{map_err, ApiResult, AppError};
use agentero_core::features::paper::discovery::collection_pool::{
    self, CollectionSnapshot, CollectionSyncStatus,
};

/// Persist the frontend Paper Collection pool to `<cache>/agentero/plaza-collection/snapshot.json`
/// so Deep Search's `agentero-collection` MCP server can query and snowball over it.
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_sync_snapshot(
    snapshot: CollectionSnapshot,
) -> ApiResult<CollectionSyncStatus> {
    let outcome =
        tokio::task::spawn_blocking(move || collection_pool::write_snapshot(&snapshot)).await;
    match outcome {
        Ok(Ok(status)) => ApiResult::ok(status),
        Ok(Err(err)) => map_err(err),
        Err(join_err) => map_err(AppError::message(format!(
            "sync plaza collection snapshot task failed: {join_err}"
        ))),
    }
}
