//! Vault recycle bin (`.agentero/trash`).
//!
//! Body in `agentero_core::features::vault::trash`; desktop command shell
//! stays here.

pub use agentero_core::features::vault::trash::*;

/// Tauri command shells for this feature.
#[cfg(feature = "desktop")]
pub mod commands;
