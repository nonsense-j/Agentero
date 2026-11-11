//! Tauri commands for the device-local activity log.
//!
//! All commands are async and run their SQLite work in `run_blocking` so the
//! main thread (Windows UI message pump) is never blocked.

use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult};
use crate::core::usage::{clear_default, record_default, UsageRecord};
use serde::Deserialize;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRecordArgs {
    pub events: Vec<UsageRecord>,
}

#[tauri::command]
#[specta::specta]
pub async fn activity_record_events(args: ActivityRecordArgs) -> Result<ApiResult<usize>, String> {
    Ok(run_blocking(move || match record_default(&args.events) {
        Ok(n) => ApiResult::ok(n),
        Err(e) => map_err(e),
    })
    .await)
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageClearArgs {
    #[serde(default)]
    pub vault: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn usage_clear(args: UsageClearArgs) -> ApiResult<u64> {
    run_blocking(move || match clear_default(args.vault.as_deref()) {
        Ok(n) => ApiResult::ok(n),
        Err(e) => map_err(e),
    })
    .await
}
