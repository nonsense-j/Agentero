//! Cross-cutting foundations shared by Host features and the headless CLI.
//!
//! Tauri-independent foundations live in the `agentero-core` crate and are
//! re-exported here so `crate::core::X` paths stay stable (the CLI depends on
//! `agentero-core` directly). Modules kept in this crate:
//!
//! - [`app_handle`]: re-export bridge around `agentero_core::app_handle`
//!   (tauri-free [`AppHandle`](app_handle::AppHandle) / `HostHooks`); the
//!   desktop `TauriHostHooks` implementation lives in `features::host_hooks`
//!   to keep `core/` free of `features/` deps.
//! - [`usage::commands`]: `#[tauri::command]` surface over the tauri-free
//!   storage layer in `agentero_core::usage`.

pub mod app_handle;
pub mod usage;

pub use agentero_core::blocking;
pub use agentero_core::cancel;
pub use agentero_core::decision;
pub use agentero_core::error;
pub use agentero_core::frontmatter;
pub use agentero_core::fs;
pub use agentero_core::http;
pub use agentero_core::install_dirs;
pub use agentero_core::json;
pub use agentero_core::log_util;
pub use agentero_core::paths;
pub use agentero_core::perf;
pub use agentero_core::process;
pub use agentero_core::sqlite;
pub use agentero_core::time;
