//! Recycle-bin commands: undoable delete + restore.

use crate::core::error::{map_err, ApiResult};
use crate::core::log_util::{trunc, OpTimer};
use crate::features::jobs::{emit_job_changed, JobCenter};
use crate::features::vault::trash;
use serde::Deserialize;
use std::path::PathBuf;
use tauri::State;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PathTrashArgs {
    pub vault_path: String,
    /// Vault-relative paths to move into the recycle bin.
    pub rels: Vec<String>,
}

/// Move files/folders into the vault recycle bin (undoable delete).
#[tauri::command]
#[specta::specta]
pub async fn path_trash(
    app: tauri::AppHandle,
    center: State<'_, JobCenter>,
    args: PathTrashArgs,
) -> Result<ApiResult<trash::TrashResult>, String> {
    let n = args.rels.len();
    let op = OpTimer::start_with("path_trash", format!("count={n}"));
    let vault = PathBuf::from(args.vault_path.trim());
    match trash::trash_paths(&vault, &args.rels) {
        Ok(res) => {
            // A deleted paper must not keep running/scheduling background
            // work (parse, download, layout, …): cancel its jobs now.
            let mut cancelled = 0usize;
            for rel in &res.rels {
                for snapshot in center.cancel_for_paper(&vault, rel).await {
                    emit_job_changed(&app, snapshot);
                    cancelled += 1;
                }
            }
            if cancelled > 0 {
                center.drain_and_spawn(&app).await;
            }
            op.finish_ok_extra(format!(
                "batch_id={} count={} jobs_cancelled={cancelled}",
                trunc(&res.batch_id, 40),
                res.count
            ));
            Ok(ApiResult::ok(res))
        }
        Err(e) => {
            // Files are already in the batch when catalog update fails.
            // Cancel jobs for paths that actually left the vault; a rename
            // that did not happen still exists on disk and keeps its jobs.
            if e.code() == "trash_catalog" {
                let mut cancelled = 0usize;
                for raw in &args.rels {
                    let rel = crate::core::fs::normalize_rel_separators(raw);
                    if vault.join(&rel).exists() {
                        continue;
                    }
                    for snapshot in center.cancel_for_paper(&vault, &rel).await {
                        emit_job_changed(&app, snapshot);
                        cancelled += 1;
                    }
                }
                if cancelled > 0 {
                    center.drain_and_spawn(&app).await;
                }
            }
            op.finish_err(&e);
            Ok(map_err(e))
        }
    }
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashVaultArgs {
    pub vault_path: String,
}

/// List every item currently in the recycle bin (Recycle Bin view).
#[tauri::command]
#[specta::specta]
pub async fn path_list_trash(
    args: TrashVaultArgs,
) -> Result<ApiResult<Vec<trash::TrashEntry>>, String> {
    let vault = PathBuf::from(args.vault_path.trim());
    match trash::list_trash(&vault) {
        Ok(items) => Ok(ApiResult::ok(items)),
        Err(e) => Ok(map_err(e)),
    }
}

/// Empty the entire recycle bin (permanent).
#[tauri::command]
#[specta::specta]
pub async fn path_purge_trash(args: TrashVaultArgs) -> Result<ApiResult<()>, String> {
    let op = OpTimer::start("path_purge_trash");
    let vault = PathBuf::from(args.vault_path.trim());
    match trash::purge_all(&vault) {
        Ok(()) => {
            op.finish_ok();
            Ok(ApiResult::ok(()))
        }
        Err(e) => {
            op.finish_err(&e);
            Ok(map_err(e))
        }
    }
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashItemArgs {
    pub vault_path: String,
    pub batch_id: String,
    /// Basename of the stored copy inside the batch (from `path_list_trash`).
    pub stored: String,
}

#[derive(Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PathRestoreItemResult {
    /// Vault-relative path the item was restored to.
    pub rel: String,
}

/// Restore a single recycle-bin item to its original path.
#[tauri::command]
#[specta::specta]
pub async fn path_restore_item(
    args: TrashItemArgs,
) -> Result<ApiResult<PathRestoreItemResult>, String> {
    let op = OpTimer::start_with(
        "path_restore_item",
        format!(
            "batch_id={} stored={}",
            trunc(&args.batch_id, 40),
            trunc(&args.stored, 80)
        ),
    );
    let vault = PathBuf::from(args.vault_path.trim());
    match trash::restore_item(&vault, &args.batch_id, &args.stored) {
        Ok(rel) => {
            op.finish_ok_extra(format!("rel={}", trunc(&rel, 120)));
            Ok(ApiResult::ok(PathRestoreItemResult { rel }))
        }
        Err(e) => {
            op.finish_err(&e);
            Ok(map_err(e))
        }
    }
}

/// Permanently delete a single recycle-bin item.
#[tauri::command]
#[specta::specta]
pub async fn path_purge_item(args: TrashItemArgs) -> Result<ApiResult<()>, String> {
    let op = OpTimer::start_with(
        "path_purge_item",
        format!(
            "batch_id={} stored={}",
            trunc(&args.batch_id, 40),
            trunc(&args.stored, 80)
        ),
    );
    let vault = PathBuf::from(args.vault_path.trim());
    match trash::purge_item(&vault, &args.batch_id, &args.stored) {
        Ok(()) => {
            op.finish_ok();
            Ok(ApiResult::ok(()))
        }
        Err(e) => {
            op.finish_err(&e);
            Ok(map_err(e))
        }
    }
}
