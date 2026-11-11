//! Desktop shell around the shared MCP server.
//!
//! The listener, tools, and resources live in `agentero-mcp`. This module
//! keeps Tauri commands and the host hooks that talk to the job queue, wiki
//! index, and settings.

mod host;

pub mod commands;

pub use agentero_mcp::{McpController, McpStatus, MCP_STATUS_EVENT};
pub use host::attach_app;
