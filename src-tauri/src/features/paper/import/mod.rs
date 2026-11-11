//! Paper import: identifier lookup, Translator, local PDF, PAPER.md parse.
//!
//! The tauri-free pipeline lives in `agentero_core::features::paper::import`
//! and is glob-re-exported here; this module keeps the desktop-only shells:
//! Tauri commands, JobCenter runners, remote-import ops, deferred metadata
//! recognition, and the settings-backed parser config refresh.
//!
//! @see docs/backend/identifier-lookup.md
//! @see docs/backend/paper-import-pipeline.md

pub use agentero_core::features::paper::import::*;

#[cfg(feature = "desktop")]
pub mod commands;
#[cfg(feature = "desktop")]
pub mod job_runners;
#[cfg(feature = "desktop")]
pub mod recognize;

// pdf_parse engine config refresh (settings-backed; desktop only). Registered
// engines resolve through the core engine registry.
#[cfg(feature = "desktop")]
pub use crate::features::paper::analyze::body_engines::refresh_parser_config;

/// Resolve the configured NOTES shell mode from the managed settings store.
#[cfg(feature = "desktop")]
pub fn note_mode_from_app(app: &tauri::AppHandle) -> NoteShellMode {
    use tauri::Manager;
    app.state::<crate::features::system::settings::AppSettingsStore>()
        .get()
        .map(|r| NoteShellMode::parse(&r.settings.paper_note_mode))
        .unwrap_or(NoteShellMode::Standard)
}
