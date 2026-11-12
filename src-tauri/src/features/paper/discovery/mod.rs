//! Paper discovery sources and recommendations.

pub use agentero_core::features::paper::discovery::collection;
#[cfg(feature = "desktop")]
pub mod collection_commands;
#[cfg(feature = "desktop")]
pub mod coolpapers;
pub use agentero_core::features::paper::discovery::discover;
pub use agentero_core::features::paper::discovery::embeddings;
pub mod feeds;
#[cfg(feature = "desktop")]
pub mod proxy;
pub mod pwc;
#[cfg(feature = "desktop")]
pub mod recommend;
pub mod scratch;
