//! External integrations: browser connector, MCP servers, and cloud sync.
//! These depend on the desktop runtime and are not available to the headless CLI.

#[cfg(feature = "desktop")]
pub mod collection_mcp;
#[cfg(feature = "desktop")]
pub mod connector;
#[cfg(feature = "desktop")]
pub mod context_mcp;
#[cfg(feature = "desktop")]
pub mod mcp;
#[cfg(feature = "desktop")]
pub mod sync;
