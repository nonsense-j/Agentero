//! Title-driven metadata resolver backed by `scholar_api::search`.
//!
//! The previous hard-coded 5-step fallback chain (S2 match → Crossref →
//! OpenAlex → S2 search → arXiv) has been replaced by a single concurrent
//! search + fusion pipeline in `agentero_core::features::paper::scholar_api::search`.
//! This module now only re-exports the thin wrapper used by the desktop
//! `paper_resolve_identifier` command.

use crate::core::error::AppError;
use crate::features::paper::catalog::papers::PaperRecord;
use agentero_core::features::paper::import::{api_paper_to_meta, enrich_remote_urls};
use agentero_core::features::paper::scholar_api::search::{resolve_best_by_title, SourceScope};

/// Resolve metadata for a free-form title query.
///
/// Searches across all configured academic sources concurrently, fuses the
/// results, and returns the best candidate that clears the title-similarity
/// threshold.
pub async fn resolve_metadata_chain(query: &str) -> Result<PaperRecord, AppError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(AppError::message("empty title query"));
    }

    let best = resolve_best_by_title(query, SourceScope::Core)
        .await
        .map_err(|e| AppError::message(format!("could not resolve metadata: {e}")))?;

    let mut record = api_paper_to_meta(&best);
    enrich_remote_urls(&mut record);
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live end-to-end latency benchmark for the new search-based resolver.
    /// Run manually:
    /// `AGENTERO_RESOLVE_LIVE_TITLE="Attention Is All You Need" cargo test -p agentero --lib recognize::chain_resolve::tests::live_latency_benchmark -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "live network latency benchmark"]
    async fn live_latency_benchmark() {
        use std::time::Instant;

        let title = std::env::var("AGENTERO_RESOLVE_LIVE_TITLE")
            .unwrap_or_else(|_| "Attention Is All You Need".into());

        let t0 = Instant::now();
        match resolve_metadata_chain(&title).await {
            Ok(meta) => {
                let elapsed = t0.elapsed();
                println!("Resolve chain: {elapsed:?}");
                println!("  -> title: {}", meta.title);
                println!("  -> source: {:?}", meta.meta_source);
            }
            Err(e) => println!("Resolve chain failed: {e}"),
        }
    }
}
