//! Tauri commands for the loopback MCP server.

use super::{McpController, McpStatus};
use crate::core::error::ApiResult;
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub fn mcp_get_status(ctrl: State<'_, Arc<McpController>>) -> ApiResult<McpStatus> {
    ApiResult::ok(ctrl.status())
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpSetEnabledArgs {
    pub enabled: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_set_enabled(
    ctrl: State<'_, Arc<McpController>>,
    args: McpSetEnabledArgs,
) -> Result<ApiResult<McpStatus>, String> {
    use crate::core::log_util::OpTimer;
    let op = OpTimer::start_with("mcp_set_enabled", format!("enabled={}", args.enabled));
    let ctrl = Arc::clone(&ctrl);
    let status = ctrl.set_enabled(args.enabled).await;
    if let Some(err) = status.last_error.as_deref() {
        if !err.is_empty() && args.enabled {
            op.finish_err_msg("mcp", err);
        } else {
            op.finish_ok_extra(format!(
                "listening={} port={}",
                status.listening, status.port
            ));
        }
    } else {
        op.finish_ok_extra(format!(
            "listening={} port={}",
            status.listening, status.port
        ));
    }
    Ok(ApiResult::ok(status))
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpSetPortArgs {
    pub port: u16,
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_set_port(
    ctrl: State<'_, Arc<McpController>>,
    args: McpSetPortArgs,
) -> Result<ApiResult<McpStatus>, String> {
    let ctrl = Arc::clone(&ctrl);
    Ok(ApiResult::ok(ctrl.set_port(args.port).await))
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpSetVaultArgs {
    pub vault_path: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn mcp_set_vault(ctrl: State<'_, Arc<McpController>>, args: McpSetVaultArgs) -> ApiResult<()> {
    ctrl.set_vault(args.vault_path);
    ApiResult::ok(())
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpSetKnownVaultsArgs {
    pub vaults: Vec<String>,
}

/// Sync the renderer's recent local vaults so MCP `vault_list` can advertise
/// every vault the user has opened, not only the currently open one.
#[tauri::command]
#[specta::specta]
pub fn mcp_set_known_vaults(
    ctrl: State<'_, Arc<McpController>>,
    args: McpSetKnownVaultsArgs,
) -> ApiResult<()> {
    ctrl.set_known_vaults(args.vaults);
    ApiResult::ok(())
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpSetParentDirArgs {
    pub parent_dir: String,
}

#[tauri::command]
#[specta::specta]
pub fn mcp_set_parent_dir(
    ctrl: State<'_, Arc<McpController>>,
    args: McpSetParentDirArgs,
) -> ApiResult<()> {
    let dir = crate::core::fs::normalize_rel_separators(args.parent_dir.trim());
    if !dir.is_empty() {
        ctrl.set_parent_dir(dir);
    }
    ApiResult::ok(())
}
