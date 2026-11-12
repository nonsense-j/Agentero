//! Tauri IPC commands for the unified `collection.sqlite` Paper Collection & Recommend store.

use agentero_core::features::paper::discovery::collection::{
    self, CollectionClearArgs, CollectionConfigUpdateArgs, CollectionListPapersArgs,
    CollectionOverviewOut, CollectionPaperDetail, CollectionPaperIdArgs, CollectionPaperIdsArgs,
    CollectionPaperSummary, CollectionPapersPage, CollectionPatchPapersArgs, CollectionSearchArgs,
    CollectionSearchResult, CollectionStateSummary, CollectionUpsertPapersArgs,
    CollectionWordCloudArgs, RecommendNextArgs, RecommendNextOut, RecommendPoolStateDto,
    RecommendPoolStateInput, WordCloudOut,
};
use serde::Serialize;

use crate::core::error::{map_err, ApiResult, AppError};

async fn run_collection_blocking<T, F>(label: &'static str, f: F) -> ApiResult<T>
where
    T: Serialize + Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(Ok(value)) => ApiResult::ok(value),
        Ok(Err(err)) => map_err(err),
        Err(join_err) => map_err(AppError::message(format!(
            "{label} task failed: {join_err}"
        ))),
    }
}

/// Read lightweight Paper Collection configuration, watermarks, venues, and portal counts.
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_state_get() -> ApiResult<CollectionStateSummary> {
    run_collection_blocking("plaza_collection_state_get", collection::state_get).await
}

/// Compute aggregate Paper Collection overview statistics (categories, venues, CCF distribution, date span).
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_overview() -> ApiResult<CollectionOverviewOut> {
    run_collection_blocking("plaza_collection_overview", collection::overview).await
}

/// Update Paper Collection categories, venues, arXiv watermarks, or refresh timestamps.
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_config_update(
    args: CollectionConfigUpdateArgs,
) -> ApiResult<CollectionStateSummary> {
    run_collection_blocking("plaza_collection_config_update", move || {
        collection::config_update(args)
    })
    .await
}

/// Upsert a batch of arXiv or Venue papers into `collection.sqlite` (optionally replacing a venue atomically).
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_upsert_papers(
    args: CollectionUpsertPapersArgs,
) -> ApiResult<CollectionStateSummary> {
    run_collection_blocking("plaza_collection_upsert_papers", move || {
        collection::upsert_papers(args)
    })
    .await
}

/// Apply incremental metadata patches (abstract, citations, keywords, BibTeX, `recommendedAt`) to existing papers.
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_patch_papers(
    args: CollectionPatchPapersArgs,
) -> ApiResult<CollectionStateSummary> {
    run_collection_blocking("plaza_collection_patch_papers", move || {
        collection::patch_papers(args)
    })
    .await
}

/// List a filtered, sorted page of lightweight Paper Collection summaries.
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_list_papers(
    args: CollectionListPapersArgs,
) -> ApiResult<CollectionPapersPage> {
    run_collection_blocking("plaza_collection_list_papers", move || {
        collection::list_papers(&args)
    })
    .await
}

/// Load complete paper details (including formatted BibTeX and citation string) for a single paper ID.
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_paper_get(
    args: CollectionPaperIdArgs,
) -> ApiResult<Option<CollectionPaperDetail>> {
    run_collection_blocking("plaza_collection_paper_get", move || {
        collection::paper_get(&args.id)
    })
    .await
}

/// Batch-fetch lightweight paper summaries by IDs while preserving requested ID order.
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_papers_by_ids(
    args: CollectionPaperIdsArgs,
) -> ApiResult<Vec<CollectionPaperSummary>> {
    run_collection_blocking("plaza_collection_papers_by_ids", move || {
        collection::papers_by_ids(&args.ids)
    })
    .await
}

/// Execute SQLite FTS5 + weighted boolean search with combinable range/rank/venue filters.
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_search(
    args: CollectionSearchArgs,
) -> ApiResult<CollectionSearchResult> {
    run_collection_blocking("plaza_collection_search", move || {
        collection::search_fast(&args)
    })
    .await
}

/// Read persisted Paper Recommend keyword chips, selected cloud terms, and Top-N configuration.
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_recommend_state_get() -> ApiResult<RecommendPoolStateDto> {
    run_collection_blocking(
        "plaza_collection_recommend_state_get",
        collection::recommend_state_get,
    )
    .await
}

/// Persist Paper Recommend keyword chips, selected cloud terms, or Top-N configuration.
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_recommend_state_set(
    args: RecommendPoolStateInput,
) -> ApiResult<RecommendPoolStateDto> {
    run_collection_blocking("plaza_collection_recommend_state_set", move || {
        collection::recommend_state_set(args)
    })
    .await
}

/// Compute Top-N word cloud keywords (`count`, `unrecommendedCount`, best display casing) over in-scope papers.
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_word_cloud(args: CollectionWordCloudArgs) -> ApiResult<WordCloudOut> {
    run_collection_blocking("plaza_collection_word_cloud", move || {
        collection::word_cloud(&args)
    })
    .await
}

/// Score unrecommended in-scope papers against active keywords, atomically stamp `recommendedAt`, and return the batch.
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_recommend_next(
    args: RecommendNextArgs,
) -> ApiResult<RecommendNextOut> {
    run_collection_blocking("plaza_collection_recommend_next", move || {
        collection::recommend_next(&args)
    })
    .await
}

/// Reset or clear Paper Collection data (`all`, `papers`, `venue`, `recommended`, or `citations`).
#[tauri::command]
#[specta::specta]
pub async fn plaza_collection_clear(
    args: CollectionClearArgs,
) -> ApiResult<CollectionStateSummary> {
    run_collection_blocking("plaza_collection_clear", move || {
        collection::clear_collection(&args)
    })
    .await
}
