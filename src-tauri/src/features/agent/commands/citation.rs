//! Tauri command for resolving agent inline citation links.

use crate::core::error::{map_err, ApiResult, AppError};
use crate::features::agent::citation::{resolve_citation, CitationTarget};
use std::path::PathBuf;

/// Resolve a vault-relative citation link to PDF coordinates.
///
/// Supports fragments like `#section=2.3`, `#figure=1`, `#table=2`,
/// `#algorithm=1`, `#formula=5`, `#region=figure-1`, and `#page=3`.
#[tauri::command]
#[specta::specta]
pub async fn agent_resolve_citation(
    vault_path: Option<String>,
    source: String,
) -> Result<ApiResult<CitationTarget>, String> {
    // Citations are vault-relative; without a valid local vault there is no
    // meaningful root, so fail instead of falling back to the process cwd
    // (which is `/` for a Finder-launched macOS GUI app).
    let vault = vault_path
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .ok_or_else(|| {
            AppError::domain(
                "citation_vault_unavailable",
                "a valid local vault is required to resolve citations",
            )
        });
    let vault = match vault {
        Ok(vault) => vault,
        Err(e) => return Ok(map_err(e)),
    };

    match resolve_citation(&vault, &source) {
        Ok(target) => Ok(ApiResult::ok(target)),
        Err(e) => Ok(map_err(e)),
    }
}
