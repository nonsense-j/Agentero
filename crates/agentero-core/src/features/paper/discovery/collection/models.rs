//! Shared IPC (specta) and MCP (schemars) data transfer types for `collection.sqlite`.
//!
//! Input `*Args` / `*Input` types derive `Deserialize + specta::Type` without `Serialize`,
//! while output DTOs derive `Serialize + specta::Type` without `Deserialize` or
//! `skip_serializing_if`, avoiding `_Serialize` / `_Deserialize` union splits in `bindings.ts`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// ─── State Summary & Config DTOs (IPC) ───

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionVenueRecord {
    pub id: String,
    pub name: String,
    pub url: String,
    pub mode: String,
    pub kind: Option<String>,
    pub domain: Option<String>,
    pub ccf_rank: Option<String>,
    pub dblp_stream: Option<String>,
    pub last_fetched_at: Option<String>,
    pub latest_published_at: Option<String>,
    pub remote_total_count: Option<usize>,
    pub paper_count: usize,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionVenueInput {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub ccf_rank: Option<String>,
    #[serde(default)]
    pub dblp_stream: Option<String>,
    #[serde(default)]
    pub last_fetched_at: Option<String>,
    #[serde(default)]
    pub latest_published_at: Option<String>,
    #[serde(default)]
    pub remote_total_count: Option<usize>,
    #[serde(default)]
    pub paper_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionArxivWatermark {
    pub latest_published_at: String,
    pub latest_arxiv_id: String,
    pub last_synced_at: String,
    pub oldest_synced_published_at: Option<String>,
    pub remote_total: Option<usize>,
    pub history_complete: bool,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionArxivWatermarkInput {
    pub latest_published_at: String,
    pub latest_arxiv_id: String,
    pub last_synced_at: String,
    #[serde(default)]
    pub oldest_synced_published_at: Option<String>,
    #[serde(default)]
    pub remote_total: Option<usize>,
    #[serde(default)]
    pub history_complete: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionArxivLatest {
    pub arxiv_id: String,
    pub title: String,
    pub published_at: String,
    pub categories_key: String,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionStateSummary {
    pub categories: Vec<String>,
    pub venues: Vec<CollectionVenueRecord>,
    pub arxiv_watermarks: HashMap<String, CollectionArxivWatermark>,
    pub last_refreshed_at: Option<String>,
    pub latest_arxiv: Option<CollectionArxivLatest>,
    pub total_count: usize,
    pub arxiv_count: usize,
    pub venue_count: usize,
    pub conference_count: usize,
    pub journal_count: usize,
    pub category_counts: HashMap<String, usize>,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionConfigUpdateArgs {
    #[serde(default)]
    pub categories: Option<Vec<String>>,
    #[serde(default)]
    pub venues: Option<Vec<CollectionVenueInput>>,
    #[serde(default)]
    pub arxiv_watermarks: Option<HashMap<String, CollectionArxivWatermarkInput>>,
    #[serde(default)]
    pub last_refreshed_at: Option<String>,
    #[serde(default)]
    pub latest_arxiv: Option<CollectionArxivLatest>,
}

// ─── Paper Summary, Detail, Upsert & Patch DTOs (IPC) ───

/// Lightweight paper record returned in paginated lists, search hits, and recommend batches.
/// Omits heavy `bibtex` payloads to minimize IPC serialization and resident UI memory.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPaperSummary {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
    pub published_at: String,
    pub year: i32,
    pub source_type: String,
    pub source_label: String,
    pub categories: Vec<String>,
    pub url: String,
    pub pdf_url: Option<String>,
    pub arxiv_id: Option<String>,
    pub doi: Option<String>,
    pub venue_id: Option<String>,
    pub venue_kind: Option<String>,
    pub venue_domain: Option<String>,
    pub ccf_rank: Option<String>,
    pub venue_full: Option<String>,
    pub citation_count: u32,
    pub keywords: Vec<String>,
    pub volume: Option<String>,
    pub issue: Option<String>,
    pub pages: Option<String>,
    pub cool_papers_id: Option<String>,
    pub recommended_at: Option<String>,
}

/// Complete paper record for the detail dialog and BibTeX / academic citation copy actions.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPaperDetail {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
    pub published_at: String,
    pub year: i32,
    pub source_type: String,
    pub source_label: String,
    pub categories: Vec<String>,
    pub url: String,
    pub pdf_url: Option<String>,
    pub arxiv_id: Option<String>,
    pub doi: Option<String>,
    pub venue_id: Option<String>,
    pub venue_kind: Option<String>,
    pub venue_domain: Option<String>,
    pub ccf_rank: Option<String>,
    pub venue_full: Option<String>,
    pub citation_count: u32,
    pub keywords: Vec<String>,
    pub volume: Option<String>,
    pub issue: Option<String>,
    pub pages: Option<String>,
    pub cool_papers_id: Option<String>,
    pub recommended_at: Option<String>,
    pub bibtex: Option<String>,
    pub citation_text: String,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPaperUpsertInput {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(rename = "abstract", default)]
    pub abstract_text: String,
    #[serde(default)]
    pub published_at: String,
    #[serde(default)]
    pub year: i32,
    pub source_type: String,
    pub source_label: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub pdf_url: Option<String>,
    #[serde(default)]
    pub arxiv_id: Option<String>,
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default)]
    pub venue_id: Option<String>,
    #[serde(default)]
    pub venue_kind: Option<String>,
    #[serde(default)]
    pub venue_domain: Option<String>,
    #[serde(default)]
    pub ccf_rank: Option<String>,
    #[serde(default)]
    pub venue_full: Option<String>,
    #[serde(default)]
    pub citation_count: Option<u32>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub volume: Option<String>,
    #[serde(default)]
    pub issue: Option<String>,
    #[serde(default)]
    pub pages: Option<String>,
    #[serde(default)]
    pub bibtex: Option<String>,
    #[serde(default)]
    pub cool_papers_id: Option<String>,
    #[serde(default)]
    pub recommended_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionVenueWatermarkUpdate {
    pub venue_id: String,
    #[serde(default)]
    pub last_fetched_at: Option<String>,
    #[serde(default)]
    pub latest_published_at: Option<String>,
    #[serde(default)]
    pub remote_total_count: Option<usize>,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionUpsertPapersArgs {
    #[serde(default)]
    pub items: Vec<CollectionPaperUpsertInput>,
    #[serde(default)]
    pub replace_venue_id: Option<String>,
    #[serde(default)]
    pub replace_source_label: Option<String>,
    #[serde(default)]
    pub venue_update: Option<CollectionVenueWatermarkUpdate>,
    #[serde(default)]
    pub arxiv_watermarks: Option<HashMap<String, CollectionArxivWatermarkInput>>,
    #[serde(default)]
    pub last_refreshed_at: Option<String>,
    #[serde(default)]
    pub latest_arxiv: Option<CollectionArxivLatest>,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPaperPatch {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub authors: Option<Vec<String>>,
    #[serde(rename = "abstract", default)]
    pub abstract_text: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub year: Option<i32>,
    #[serde(default)]
    pub categories: Option<Vec<String>>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub pdf_url: Option<String>,
    #[serde(default)]
    pub arxiv_id: Option<String>,
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default)]
    pub venue_id: Option<String>,
    #[serde(default)]
    pub venue_kind: Option<String>,
    #[serde(default)]
    pub venue_domain: Option<String>,
    #[serde(default)]
    pub ccf_rank: Option<String>,
    #[serde(default)]
    pub venue_full: Option<String>,
    #[serde(default)]
    pub citation_count: Option<u32>,
    #[serde(default)]
    pub keywords: Option<Vec<String>>,
    #[serde(default)]
    pub volume: Option<String>,
    #[serde(default)]
    pub issue: Option<String>,
    #[serde(default)]
    pub pages: Option<String>,
    #[serde(default)]
    pub bibtex: Option<String>,
    #[serde(default)]
    pub cool_papers_id: Option<String>,
    #[serde(default)]
    pub recommended_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPatchPapersArgs {
    pub patches: Vec<CollectionPaperPatch>,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPaperIdArgs {
    pub id: String,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPaperIdsArgs {
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionListPapersArgs {
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub time_preset: Option<String>,
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
    #[serde(default)]
    pub venue_kind: Option<String>,
    #[serde(default)]
    pub venue_domain: Option<String>,
    #[serde(default)]
    pub venue_id: Option<String>,
    #[serde(default)]
    pub ccf_ranks: Vec<String>,
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPapersPage {
    pub items: Vec<CollectionPaperSummary>,
    pub total: usize,
    pub has_more: bool,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSearchArgs {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub time_preset: Option<String>,
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub venues: Vec<String>,
    #[serde(default)]
    pub venue_kind: Option<String>,
    #[serde(default)]
    pub venue_domain: Option<String>,
    #[serde(default)]
    pub ccf_ranks: Vec<String>,
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ScoredCollectionPaperDto {
    pub paper: CollectionPaperSummary,
    pub score: f64,
    pub matched_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSearchResult {
    pub items: Vec<ScoredCollectionPaperDto>,
    pub total_matched: usize,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionClearArgs {
    pub scope: String,
    #[serde(default)]
    pub venue_id: Option<String>,
}

// ─── Recommend Engine DTOs (IPC) ───

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecommendKeywordChipDto {
    pub id: String,
    pub term: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecommendKeywordChipInput {
    #[serde(default)]
    pub id: Option<String>,
    pub term: String,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecommendPoolStateDto {
    pub keywords: Vec<RecommendKeywordChipDto>,
    pub selected_cloud_terms: Vec<String>,
    pub word_cloud_top_n: usize,
    pub last_recommended_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecommendPoolStateInput {
    #[serde(default)]
    pub keywords: Option<Vec<RecommendKeywordChipInput>>,
    #[serde(default)]
    pub selected_cloud_terms: Option<Vec<String>>,
    #[serde(default)]
    pub word_cloud_top_n: Option<usize>,
    #[serde(default)]
    pub last_recommended_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionWordCloudArgs {
    #[serde(default)]
    pub top_n: Option<usize>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WordCloudKeywordDto {
    pub term: String,
    pub normalized: String,
    pub count: usize,
    pub unrecommended_count: usize,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WordCloudOut {
    pub keywords: Vec<WordCloudKeywordDto>,
    pub total_unique_keywords: usize,
    pub total_candidate_papers: usize,
    pub unrecommended_paper_count: usize,
}

#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecommendNextArgs {
    #[serde(default)]
    pub max_batch_size: Option<usize>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecommendedPaperDto {
    pub paper: CollectionPaperSummary,
    pub matched_keywords: Vec<String>,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecommendNextOut {
    pub items: Vec<RecommendedPaperDto>,
    pub state: RecommendPoolStateDto,
    pub exhausted: bool,
    pub remaining_unrecommended: usize,
}

// ─── Overview DTOs (Shared by IPC + MCP) ───

#[derive(Debug, Clone, Serialize, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BucketCount {
    pub label: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VenueBucketCount {
    pub id: String,
    pub name: String,
    pub kind: Option<String>,
    pub domain: Option<String>,
    pub ccf_rank: Option<String>,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CcfDistribution {
    pub ccf_a: usize,
    pub ccf_b: usize,
    pub arxiv_preprint: usize,
}

#[derive(Debug, Clone, Serialize, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CollectionOverviewOut {
    pub total_papers: usize,
    pub arxiv_count: usize,
    pub venue_count: usize,
    pub updated_at: String,
    pub earliest_date: Option<String>,
    pub latest_date: Option<String>,
    pub ccf_distribution: CcfDistribution,
    pub categories: Vec<BucketCount>,
    pub venues: Vec<VenueBucketCount>,
}

// ─── MCP Tool Schemas (`agentero-collection` Deep Search stdio MCP) ───

#[derive(Debug, Clone, Default, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSearchParams {
    /// Boolean query over title + abstract + keywords (`AND` by space, `"exact phrase"`, `OR`, `-exclude`).
    #[serde(default)]
    pub query: Option<String>,
    /// `"ranked"` (default) or `"random_sample"` (uniformly samples up to `sample_size` matching papers).
    #[serde(default)]
    pub mode: Option<String>,
    /// Sample count when `mode == "random_sample"` (default 50, max 50).
    #[serde(default)]
    pub sample_size: Option<usize>,
    /// Max results when `mode == "ranked"` (default 25, max 50).
    #[serde(default)]
    pub limit: Option<usize>,
    /// Sort order in `"ranked"` mode: `"relevance"` (default), `"newest"`, or `"citations"`.
    #[serde(default)]
    pub sort: Option<String>,
    /// Searchable fields subset: `"title"`, `"abstract"`, `"keywords"`. Omit for all three.
    #[serde(default)]
    pub fields: Vec<String>,
    /// `"all"` (default), `"arxiv"`, or `"venue"`.
    #[serde(default)]
    pub source_type: Option<String>,
    /// Filter by arXiv categories (e.g. `["cs.SE", "cs.AI"]`).
    #[serde(default)]
    pub categories: Vec<String>,
    /// Filter by venue IDs or display names (e.g. `["ICSE 2026", "ISSTA 2026", "tosem-2026"]`).
    #[serde(default)]
    pub venues: Vec<String>,
    /// `"conference"` or `"journal"`.
    #[serde(default)]
    pub venue_kind: Option<String>,
    /// `"PL/SE"`, `"CR"`, or `"AI"`.
    #[serde(default)]
    pub venue_domain: Option<String>,
    /// Combinable rank filter: `"CCF-A"`, `"CCF-B"`, `"arxiv"`.
    #[serde(default)]
    pub ccf_ranks: Vec<String>,
    /// Start date (`YYYY-MM-DD`) or relative preset (`"7d"`, `"30d"`, `"90d"`).
    #[serde(default)]
    pub date_from: Option<String>,
    /// End date (`YYYY-MM-DD`).
    #[serde(default)]
    pub date_to: Option<String>,
    /// Optional deterministic RNG seed for reproducible `random_sample`.
    #[serde(default)]
    pub seed: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPaperHit {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: i32,
    pub published_at: String,
    pub source_type: String,
    pub source_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ccf_rank: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub venue_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub venue_domain: Option<String>,
    pub keywords: Vec<String>,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
    pub citation_count: u32,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arxiv_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSearchOut {
    pub mode: String,
    pub query: String,
    pub total_pool_size: usize,
    pub total_matched: usize,
    pub strict_matched_count: usize,
    pub broadened: bool,
    pub returned_count: usize,
    pub items: Vec<CollectionPaperHit>,
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CurateItemInput {
    pub id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CurateGroupInput {
    pub label: String,
    pub items: Vec<CurateItemInput>,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CollectionCurateParams {
    pub groups: Vec<CurateGroupInput>,
    /// `"replace"` (default) or `"append"`.
    #[serde(default)]
    pub mode: Option<String>,
    /// 3–5 concise follow-up direction pills shown below the Agent message.
    #[serde(default)]
    pub suggested_follow_ups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CuratedPaperOut {
    pub id: String,
    pub title: String,
    pub source_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ccf_rank: Option<String>,
    pub year: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CuratedGroupOut {
    pub label: String,
    pub items: Vec<CuratedPaperOut>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CollectionCurateOut {
    pub mode: String,
    pub curated_count: usize,
    pub groups: Vec<CuratedGroupOut>,
    pub suggested_follow_ups: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dropped_unknown_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CollectionCitationsParams {
    /// 1 to 5 paper IDs from `Paper Collection` used as snowball seeds.
    pub paper_ids: Vec<String>,
    /// `"both"` (default, includes direct + cocited), `"references"`, `"cited_by"`, or `"cocited"`.
    #[serde(default)]
    pub direction: Option<String>,
    /// Max discovered `Paper Collection` papers to return (default 25, max 50).
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SnowballPaperHit {
    pub paper: CollectionPaperHit,
    /// `"cited_by"`, `"references"`, or `"cocited"`.
    pub relation_type: String,
    /// Seed paper IDs in `Paper Collection` connected to this hit.
    pub linked_seed_ids: Vec<String>,
    /// Human-readable lineage explanation (e.g. direct citation or shared reference title).
    pub via: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CollectionCitationsOut {
    pub resolved_seeds: Vec<String>,
    pub unresolved_seeds: Vec<String>,
    pub returned_count: usize,
    pub items: Vec<SnowballPaperHit>,
}
