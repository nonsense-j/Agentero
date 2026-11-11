//! Local Paper Collection snapshot store, boolean/advanced search, uniform
//! random sampling, and citation/co-citation snowballing strictly bounded to
//! the user's Paper Collection pool.
//!
//! Layout under `<cache>/agentero/plaza-collection/`:
//! - `snapshot.json`: synced from the Plaza Paper Collection frontend pool
//! - `citation_edges.json`: cached OpenAlex / Semantic Scholar citation edges

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;
use crate::features::paper::scholar_api::client as scholar_client;
use crate::features::paper::scholar_api::references::fetch_references;
use crate::paths;

/// CLI flag used when spawning the session-scoped `agentero-collection` stdio MCP.
pub const COLLECTION_MCP_WORKER_ARG: &str = "--agentero-collection-mcp";

const SNAPSHOT_FILE: &str = "snapshot.json";
const CITATION_CACHE_FILE: &str = "citation_edges.json";
const OPENALEX_MAILTO: &str = "agentero@users.noreply.github.com";

#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionVenueMeta {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub ccf_rank: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSnapshotPaper {
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
    /// `"arxiv"` or `"venue"`.
    #[serde(default)]
    pub source_type: String,
    #[serde(default)]
    pub source_label: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arxiv_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue_domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ccf_rank: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue_full: Option<String>,
    #[serde(default)]
    pub citation_count: u32,
    #[serde(default)]
    pub keywords: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSnapshot {
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub venues: Vec<CollectionVenueMeta>,
    #[serde(default)]
    pub items: Vec<CollectionSnapshotPaper>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSyncStatus {
    pub dir: String,
    pub total_papers: usize,
    pub updated_at: String,
}

pub fn collection_cache_dir() -> PathBuf {
    paths::agentero_cache_dir().join("plaza-collection")
}

pub fn snapshot_path_in(dir: &Path) -> PathBuf {
    dir.join(SNAPSHOT_FILE)
}

fn citation_cache_path_in(dir: &Path) -> PathBuf {
    dir.join(CITATION_CACHE_FILE)
}

pub fn write_snapshot(snapshot: &CollectionSnapshot) -> Result<CollectionSyncStatus, AppError> {
    write_snapshot_in(&collection_cache_dir(), snapshot)
}

pub fn write_snapshot_in(
    dir: &Path,
    snapshot: &CollectionSnapshot,
) -> Result<CollectionSyncStatus, AppError> {
    std::fs::create_dir_all(dir)
        .map_err(|e| AppError::message(format!("create plaza-collection cache dir: {e}")))?;
    let target = snapshot_path_in(dir);
    let tmp = dir.join("snapshot.json.tmp");
    let bytes = serde_json::to_vec(snapshot)
        .map_err(|e| AppError::message(format!("serialize collection snapshot: {e}")))?;
    std::fs::write(&tmp, bytes)
        .map_err(|e| AppError::message(format!("write collection snapshot tmp: {e}")))?;
    if target.exists() {
        let _ = std::fs::remove_file(&target);
    }
    std::fs::rename(&tmp, &target)
        .map_err(|e| AppError::message(format!("commit collection snapshot: {e}")))?;
    Ok(CollectionSyncStatus {
        dir: dir.display().to_string(),
        total_papers: snapshot.items.len(),
        updated_at: snapshot.updated_at.clone(),
    })
}

pub fn read_snapshot_in(dir: &Path) -> Result<CollectionSnapshot, AppError> {
    let path = snapshot_path_in(dir);
    if !path.is_file() {
        return Ok(CollectionSnapshot::default());
    }
    let bytes = std::fs::read(&path)
        .map_err(|e| AppError::message(format!("read collection snapshot: {e}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| AppError::message(format!("parse collection snapshot: {e}")))
}

// ─── Overview ───

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BucketCount {
    pub label: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VenueBucketCount {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ccf_rank: Option<String>,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CcfDistribution {
    pub ccf_a: usize,
    pub ccf_b: usize,
    pub arxiv_preprint: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
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

pub fn compute_overview(snapshot: &CollectionSnapshot) -> CollectionOverviewOut {
    let mut arxiv_count = 0usize;
    let mut venue_count = 0usize;
    let mut ccf_a = 0usize;
    let mut ccf_b = 0usize;
    let mut cat_counts: HashMap<String, usize> = HashMap::new();
    let mut venue_counts: HashMap<String, usize> = HashMap::new();
    let mut earliest: Option<String> = None;
    let mut latest: Option<String> = None;

    for cat in &snapshot.categories {
        cat_counts.entry(cat.clone()).or_insert(0);
    }

    for item in &snapshot.items {
        if item.source_type == "arxiv" {
            arxiv_count += 1;
            let mut matched_configured = false;
            for cat in &snapshot.categories {
                if item.source_label.eq_ignore_ascii_case(cat)
                    || item.categories.iter().any(|c| c.eq_ignore_ascii_case(cat))
                {
                    *cat_counts.entry(cat.clone()).or_insert(0) += 1;
                    matched_configured = true;
                }
            }
            if !matched_configured && !item.source_label.is_empty() {
                *cat_counts.entry(item.source_label.clone()).or_insert(0) += 1;
            }
        } else {
            venue_count += 1;
            let key = item
                .venue_id
                .clone()
                .unwrap_or_else(|| item.source_label.clone());
            *venue_counts.entry(key).or_insert(0) += 1;
        }

        match item.ccf_rank.as_deref() {
            Some("CCF-A") => ccf_a += 1,
            Some("CCF-B") => ccf_b += 1,
            _ => {}
        }

        let date_prefix = item.published_at.get(..10).map(str::to_string);
        if let Some(d) = date_prefix {
            if earliest.as_ref().is_none_or(|cur| d < *cur) {
                earliest = Some(d.clone());
            }
            if latest.as_ref().is_none_or(|cur| d > *cur) {
                latest = Some(d);
            }
        }
    }

    let mut categories: Vec<BucketCount> = cat_counts
        .into_iter()
        .map(|(label, count)| BucketCount { label, count })
        .collect();
    categories.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.label.cmp(&b.label)));

    let mut venues: Vec<VenueBucketCount> = snapshot
        .venues
        .iter()
        .map(|v| {
            let count = venue_counts
                .remove(&v.id)
                .or_else(|| venue_counts.remove(&v.name))
                .unwrap_or(0);
            VenueBucketCount {
                id: v.id.clone(),
                name: v.name.clone(),
                kind: v.kind.clone(),
                domain: v.domain.clone(),
                ccf_rank: v.ccf_rank.clone(),
                count,
            }
        })
        .collect();
    for (leftover, count) in venue_counts {
        if count > 0 {
            venues.push(VenueBucketCount {
                id: leftover.clone(),
                name: leftover,
                kind: None,
                domain: None,
                ccf_rank: None,
                count,
            });
        }
    }
    venues.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));

    CollectionOverviewOut {
        total_papers: snapshot.items.len(),
        arxiv_count,
        venue_count,
        updated_at: snapshot.updated_at.clone(),
        earliest_date: earliest,
        latest_date: latest,
        ccf_distribution: CcfDistribution {
            ccf_a,
            ccf_b,
            arxiv_preprint: arxiv_count,
        },
        categories,
        venues,
    }
}

// ─── Boolean Search + Advanced Filtering + Uniform Random Sampling ───

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

#[derive(Debug, Clone)]
struct QueryTerm {
    text: String,
    phrase: bool,
    negated: bool,
}

#[derive(Debug, Clone)]
struct ParsedBooleanQuery {
    /// Disjunction (`OR`) of conjunction (`AND`) branches.
    branches: Vec<Vec<QueryTerm>>,
}

fn parse_boolean_query(raw: &str) -> ParsedBooleanQuery {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return ParsedBooleanQuery {
            branches: Vec::new(),
        };
    }

    let mut tokens: Vec<(String, bool, bool)> = Vec::new();
    let chars: Vec<char> = trimmed.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        let mut negated = false;
        if chars[i] == '-' && i + 1 < chars.len() && !chars[i + 1].is_whitespace() {
            negated = true;
            i += 1;
        }
        if i < chars.len() && chars[i] == '"' {
            i += 1;
            let start = i;
            while i < chars.len() && chars[i] != '"' {
                i += 1;
            }
            let phrase: String = chars[start..i].iter().collect();
            if i < chars.len() && chars[i] == '"' {
                i += 1;
            }
            let clean = phrase.trim().to_lowercase();
            if !clean.is_empty() {
                tokens.push((clean, true, negated));
            }
        } else {
            let start = i;
            while i < chars.len() && !chars[i].is_whitespace() {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            let clean = word.trim();
            if !clean.is_empty() {
                tokens.push((clean.to_string(), false, negated));
            }
        }
    }

    let mut branches: Vec<Vec<QueryTerm>> = vec![Vec::new()];
    let mut global_negations: Vec<QueryTerm> = Vec::new();

    for (raw_tok, is_phrase, negated) in tokens {
        if !is_phrase && !negated && (raw_tok == "OR" || raw_tok == "|") {
            if !branches.last().is_none_or(Vec::is_empty) {
                branches.push(Vec::new());
            }
            continue;
        }
        if !is_phrase && !negated && (raw_tok == "AND" || raw_tok == "&") {
            continue;
        }
        let term = QueryTerm {
            text: raw_tok.to_lowercase(),
            phrase: is_phrase || raw_tok.contains(' ') || raw_tok.contains('-'),
            negated,
        };
        if negated {
            global_negations.push(term);
        } else if let Some(last) = branches.last_mut() {
            last.push(term);
        }
    }

    branches.retain(|b| !b.is_empty());
    if branches.is_empty() && !global_negations.is_empty() {
        branches.push(global_negations);
    } else {
        for b in &mut branches {
            b.extend(global_negations.clone());
        }
    }

    ParsedBooleanQuery { branches }
}

#[derive(Debug, Clone, Copy)]
struct SearchFieldsMask {
    title: bool,
    abstract_text: bool,
    keywords: bool,
}

impl SearchFieldsMask {
    fn from_list(fields: &[String]) -> Self {
        if fields.is_empty() {
            return Self {
                title: true,
                abstract_text: true,
                keywords: true,
            };
        }
        let mut mask = Self {
            title: false,
            abstract_text: false,
            keywords: false,
        };
        for f in fields {
            match f.trim().to_ascii_lowercase().as_str() {
                "title" => mask.title = true,
                "abstract" => mask.abstract_text = true,
                "keywords" | "keyword" => mask.keywords = true,
                _ => {}
            }
        }
        if !mask.title && !mask.abstract_text && !mask.keywords {
            mask.title = true;
            mask.abstract_text = true;
            mask.keywords = true;
        }
        mask
    }
}

fn score_paper_query(
    paper: &CollectionSnapshotPaper,
    parsed: &ParsedBooleanQuery,
    mask: SearchFieldsMask,
) -> Option<f32> {
    if parsed.branches.is_empty() {
        return Some(1.0);
    }

    let title_lc = if mask.title {
        paper.title.to_lowercase()
    } else {
        String::new()
    };
    let kw_lc = if mask.keywords {
        format!(
            "{} {}",
            paper.keywords.join(" "),
            paper.categories.join(" ")
        )
        .to_lowercase()
    } else {
        String::new()
    };
    let abs_lc = if mask.abstract_text {
        paper.abstract_text.to_lowercase()
    } else {
        String::new()
    };

    let mut best_branch_score: Option<f32> = None;

    for branch in &parsed.branches {
        let mut branch_ok = true;
        let mut score = 0.0f32;
        let mut has_positive = false;

        for term in branch {
            let in_title = mask.title && title_lc.contains(&term.text);
            let in_kw = mask.keywords && kw_lc.contains(&term.text);
            let in_abs = mask.abstract_text && abs_lc.contains(&term.text);
            let matched = in_title || in_kw || in_abs;

            if term.negated {
                if matched {
                    branch_ok = false;
                    break;
                }
            } else {
                has_positive = true;
                if !matched {
                    branch_ok = false;
                    break;
                }
                if in_title {
                    score += if term.phrase { 8.0 } else { 3.5 };
                }
                if in_kw {
                    score += if term.phrase { 6.0 } else { 3.0 };
                }
                if in_abs {
                    score += if term.phrase { 2.5 } else { 1.2 };
                }
            }
        }

        if branch_ok {
            let final_score = if has_positive { score } else { 1.0 };
            if best_branch_score.is_none_or(|prev| final_score > prev) {
                best_branch_score = Some(final_score);
            }
        }
    }

    best_branch_score
}

fn resolve_date_bound(raw: Option<&str>, latest_iso: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("all") {
        return None;
    }
    if let Some(days_str) = raw.strip_suffix('d').or_else(|| raw.strip_suffix('D')) {
        if let Ok(days) = days_str.parse::<i64>() {
            let anchor = latest_iso
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(chrono::Utc::now);
            let cutoff = anchor - chrono::Duration::days(days);
            return Some(cutoff.format("%Y-%m-%d").to_string());
        }
    }
    Some(raw.chars().take(10).collect())
}

fn matches_structural_filters(
    paper: &CollectionSnapshotPaper,
    params: &CollectionSearchParams,
    date_from_ymd: Option<&str>,
    date_to_ymd: Option<&str>,
) -> bool {
    if let Some(st) = params.source_type.as_deref() {
        let st = st.trim();
        if !st.is_empty()
            && !st.eq_ignore_ascii_case("all")
            && !paper.source_type.eq_ignore_ascii_case(st)
        {
            return false;
        }
    }

    if !params.categories.is_empty() && paper.source_type.eq_ignore_ascii_case("arxiv") {
        let has_cat = params.categories.iter().any(|cat| {
            paper.source_label.eq_ignore_ascii_case(cat)
                || paper.categories.iter().any(|c| c.eq_ignore_ascii_case(cat))
        });
        if !has_cat {
            return false;
        }
    }

    if !params.venues.is_empty() && paper.source_type.eq_ignore_ascii_case("venue") {
        let has_venue = params.venues.iter().any(|v| {
            let v_trim = v.trim();
            paper
                .venue_id
                .as_deref()
                .is_some_and(|id| id.eq_ignore_ascii_case(v_trim))
                || paper.source_label.eq_ignore_ascii_case(v_trim)
                || paper
                    .source_label
                    .to_lowercase()
                    .starts_with(&format!("{} ", v_trim.to_lowercase()))
        });
        if !has_venue {
            return false;
        }
    }

    if let Some(vk) = params.venue_kind.as_deref().map(str::trim) {
        if !vk.is_empty() && !vk.eq_ignore_ascii_case("all") {
            if !paper.source_type.eq_ignore_ascii_case("venue") {
                return false;
            }
            if !paper
                .venue_kind
                .as_deref()
                .is_some_and(|k| k.eq_ignore_ascii_case(vk))
            {
                return false;
            }
        }
    }

    if let Some(vd) = params.venue_domain.as_deref().map(str::trim) {
        if !vd.is_empty() && !vd.eq_ignore_ascii_case("all") {
            if !paper.source_type.eq_ignore_ascii_case("venue") {
                return false;
            }
            if !paper
                .venue_domain
                .as_deref()
                .is_some_and(|d| d.eq_ignore_ascii_case(vd))
            {
                return false;
            }
        }
    }

    if !params.ccf_ranks.is_empty() {
        let rank_ok = params.ccf_ranks.iter().any(|r| {
            let r_norm = r.trim().to_uppercase();
            if r_norm == "ARXIV" || r_norm == "PREPRINT" {
                paper.source_type.eq_ignore_ascii_case("arxiv")
            } else {
                paper
                    .ccf_rank
                    .as_deref()
                    .is_some_and(|pr| pr.eq_ignore_ascii_case(&r_norm))
            }
        });
        if !rank_ok {
            return false;
        }
    }

    let pub_ymd = paper.published_at.get(..10).unwrap_or("");
    if !pub_ymd.is_empty() {
        if let Some(from) = date_from_ymd {
            if pub_ymd < from {
                return false;
            }
        }
        if let Some(to) = date_to_ymd {
            if pub_ymd > to {
                return false;
            }
        }
    }

    true
}

fn truncate_abstract_for_hit(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars).collect();
    format!("{}…", truncated.trim_end())
}

fn to_hit(paper: &CollectionSnapshotPaper, score: f32) -> CollectionPaperHit {
    CollectionPaperHit {
        id: paper.id.clone(),
        title: paper.title.clone(),
        authors: paper.authors.iter().take(5).cloned().collect(),
        year: paper.year,
        published_at: paper.published_at.clone(),
        source_type: paper.source_type.clone(),
        source_label: paper.source_label.clone(),
        ccf_rank: paper.ccf_rank.clone(),
        venue_kind: paper.venue_kind.clone(),
        venue_domain: paper.venue_domain.clone(),
        keywords: paper.keywords.clone(),
        abstract_text: truncate_abstract_for_hit(&paper.abstract_text, 480),
        citation_count: paper.citation_count,
        url: paper.url.clone(),
        arxiv_id: paper.arxiv_id.clone(),
        doi: paper.doi.clone(),
        score: (score * 100.0).round() / 100.0,
    }
}

/// Splitmix64 PRNG for fast, dependency-free uniform Fisher-Yates sampling.
struct SplitMix64(u64);

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self(if seed == 0 {
            0x9E37_79B9_7F4A_7C15
        } else {
            seed
        })
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn gen_index(&mut self, upper_exclusive: usize) -> usize {
        (self.next_u64() % (upper_exclusive as u64)) as usize
    }
}

fn build_broadened_or_query(raw: &str) -> Option<ParsedBooleanQuery> {
    let stop = [
        "the", "and", "for", "with", "from", "into", "using", "based", "via", "towards", "toward",
        "study", "paper", "papers", "method", "methods", "approach",
    ];
    let terms: Vec<QueryTerm> = raw
        .split(|c: char| {
            !c.is_alphanumeric() && c != '-' && !('\u{4e00}'..='\u{9fff}').contains(&c)
        })
        .map(|s| s.trim().to_lowercase())
        .filter(|s| s.chars().count() >= 3 && !stop.contains(&s.as_str()))
        .map(|text| QueryTerm {
            text,
            phrase: false,
            negated: false,
        })
        .collect();
    if terms.len() < 2 {
        return None;
    }
    Some(ParsedBooleanQuery {
        branches: terms.into_iter().map(|t| vec![t]).collect(),
    })
}

pub fn search_collection(
    snapshot: &CollectionSnapshot,
    params: &CollectionSearchParams,
) -> CollectionSearchOut {
    let raw_query = params.query.as_deref().unwrap_or("").trim().to_string();
    let mode = match params.mode.as_deref() {
        Some(m) if m.eq_ignore_ascii_case("random_sample") => "random_sample",
        _ => "ranked",
    };
    let mask = SearchFieldsMask::from_list(&params.fields);
    let parsed = parse_boolean_query(&raw_query);

    let latest_iso = snapshot.items.iter().map(|i| i.published_at.as_str()).max();
    let date_from_ymd = resolve_date_bound(params.date_from.as_deref(), latest_iso);
    let date_to_ymd = resolve_date_bound(params.date_to.as_deref(), latest_iso);

    let filtered: Vec<&CollectionSnapshotPaper> = snapshot
        .items
        .iter()
        .filter(|p| {
            matches_structural_filters(p, params, date_from_ymd.as_deref(), date_to_ymd.as_deref())
        })
        .collect();

    let mut strict_hits: Vec<(&CollectionSnapshotPaper, f32)> = filtered
        .iter()
        .filter_map(|p| score_paper_query(p, &parsed, mask).map(|s| (*p, s)))
        .collect();

    let strict_matched_count = strict_hits.len();
    let mut broadened = false;

    if mode == "random_sample" && !raw_query.is_empty() && strict_hits.len() < 10 {
        if let Some(broad_q) = build_broadened_or_query(&raw_query) {
            let strict_ids: HashSet<&str> =
                strict_hits.iter().map(|(p, _)| p.id.as_str()).collect();
            let mut extra: Vec<(&CollectionSnapshotPaper, f32)> = filtered
                .iter()
                .filter(|p| !strict_ids.contains(p.id.as_str()))
                .filter_map(|p| score_paper_query(p, &broad_q, mask).map(|s| (*p, s * 0.6)))
                .collect();
            if !extra.is_empty() {
                broadened = true;
                extra.sort_by(|a, b| {
                    b.1.partial_cmp(&a.1)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then_with(|| b.0.published_at.cmp(&a.0.published_at))
                });
                strict_hits.extend(extra.into_iter().take(60));
            }
        }
    }

    let total_matched = strict_hits.len();

    let selected: Vec<CollectionPaperHit> = if mode == "random_sample" {
        let cap = params.sample_size.unwrap_or(50).clamp(1, 50);
        if strict_hits.len() <= cap {
            strict_hits.into_iter().map(|(p, s)| to_hit(p, s)).collect()
        } else {
            let default_seed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(42);
            let mut rng = SplitMix64::new(params.seed.unwrap_or(default_seed));
            let len = strict_hits.len();
            for i in 0..cap {
                let j = i + rng.gen_index(len - i);
                strict_hits.swap(i, j);
            }
            strict_hits
                .into_iter()
                .take(cap)
                .map(|(p, s)| to_hit(p, s))
                .collect()
        }
    } else {
        let limit = params.limit.unwrap_or(25).clamp(1, 50);
        let sort = params.sort.as_deref().unwrap_or(if raw_query.is_empty() {
            "newest"
        } else {
            "relevance"
        });
        match sort {
            "newest" => {
                strict_hits.sort_by(|a, b| {
                    b.0.published_at
                        .cmp(&a.0.published_at)
                        .then_with(|| b.0.citation_count.cmp(&a.0.citation_count))
                });
            }
            "citations" => {
                strict_hits.sort_by(|a, b| {
                    b.0.citation_count
                        .cmp(&a.0.citation_count)
                        .then_with(|| b.0.published_at.cmp(&a.0.published_at))
                });
            }
            _ => {
                strict_hits.sort_by(|a, b| {
                    b.1.partial_cmp(&a.1)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then_with(|| b.0.citation_count.cmp(&a.0.citation_count))
                        .then_with(|| b.0.published_at.cmp(&a.0.published_at))
                });
            }
        }
        strict_hits
            .into_iter()
            .take(limit)
            .map(|(p, s)| to_hit(p, s))
            .collect()
    };

    CollectionSearchOut {
        mode: mode.to_string(),
        query: raw_query,
        total_pool_size: snapshot.items.len(),
        total_matched,
        strict_matched_count,
        broadened,
        returned_count: selected.len(),
        items: selected,
    }
}

// ─── Curate Verification ───

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

pub fn curate_collection(
    snapshot: &CollectionSnapshot,
    params: CollectionCurateParams,
) -> CollectionCurateOut {
    let by_id: HashMap<&str, &CollectionSnapshotPaper> =
        snapshot.items.iter().map(|p| (p.id.as_str(), p)).collect();
    let mode = match params.mode.as_deref() {
        Some(m) if m.eq_ignore_ascii_case("append") => "append".to_string(),
        _ => "replace".to_string(),
    };

    let mut groups_out = Vec::new();
    let mut dropped = Vec::new();
    let mut curated_count = 0usize;

    for group in params.groups {
        let mut items_out = Vec::new();
        for entry in group.items {
            let trimmed = entry.id.trim();
            if let Some(paper) = by_id.get(trimmed) {
                curated_count += 1;
                items_out.push(CuratedPaperOut {
                    id: paper.id.clone(),
                    title: paper.title.clone(),
                    source_label: paper.source_label.clone(),
                    ccf_rank: paper.ccf_rank.clone(),
                    year: paper.year,
                    reason: entry.reason.filter(|r| !r.trim().is_empty()),
                });
            } else if !trimmed.is_empty() {
                dropped.push(trimmed.to_string());
            }
        }
        if !items_out.is_empty() {
            groups_out.push(CuratedGroupOut {
                label: group.label,
                items: items_out,
            });
        }
    }

    CollectionCurateOut {
        mode,
        curated_count,
        groups: groups_out,
        suggested_follow_ups: params
            .suggested_follow_ups
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .take(6)
            .collect(),
        dropped_unknown_ids: dropped,
    }
}

// ─── Citation & Co-Citation Snowballing (Strictly In-Collection) ───

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalPaperStub {
    #[serde(default)]
    openalex_id: Option<String>,
    #[serde(default)]
    doi: Option<String>,
    #[serde(default)]
    arxiv_id: Option<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    cited_by_count: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedPaperEdges {
    #[serde(default)]
    openalex_id: Option<String>,
    #[serde(default)]
    references: Vec<ExternalPaperStub>,
    #[serde(default)]
    cited_by: Vec<ExternalPaperStub>,
    #[serde(default)]
    cocited_2026: Vec<(String, ExternalPaperStub)>,
}

type CitationEdgeCache = HashMap<String, CachedPaperEdges>;

fn load_edge_cache(dir: &Path) -> CitationEdgeCache {
    let path = citation_cache_path_in(dir);
    std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_edge_cache(dir: &Path, cache: &CitationEdgeCache) {
    let _ = std::fs::create_dir_all(dir);
    if let Ok(bytes) = serde_json::to_vec(cache) {
        let _ = std::fs::write(citation_cache_path_in(dir), bytes);
    }
}

fn clean_doi_key(raw: &str) -> Option<String> {
    let s = raw
        .trim()
        .trim_start_matches("https://doi.org/")
        .trim_start_matches("http://doi.org/")
        .trim_start_matches("https://dx.doi.org/")
        .trim_start_matches("doi:")
        .trim_end_matches(['.', ',', ';', ')'])
        .trim()
        .to_lowercase();
    (!s.is_empty()).then_some(s)
}

fn clean_arxiv_key(raw: &str) -> Option<String> {
    let s = raw
        .trim()
        .trim_start_matches("https://arxiv.org/abs/")
        .trim_start_matches("http://arxiv.org/abs/")
        .trim_start_matches("10.48550/arxiv.")
        .trim_start_matches("arxiv:")
        .trim_start_matches("ARXIV:")
        .trim()
        .to_lowercase();
    if s.is_empty() {
        return None;
    }
    let stripped = match s.rfind('v') {
        Some(pos) if pos >= 6 && s[pos + 1..].bytes().all(|b| b.is_ascii_digit()) => &s[..pos],
        _ => s.as_str(),
    };
    (!stripped.is_empty()).then(|| stripped.to_string())
}

fn norm_title_key(title: &str) -> String {
    title
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(c))
        .flat_map(|c| c.to_lowercase())
        .collect()
}

struct CollectionLookup<'a> {
    items: &'a [CollectionSnapshotPaper],
    by_id: HashMap<String, usize>,
    by_doi: HashMap<String, usize>,
    by_arxiv: HashMap<String, usize>,
    by_title: HashMap<String, usize>,
}

impl<'a> CollectionLookup<'a> {
    fn new(items: &'a [CollectionSnapshotPaper]) -> Self {
        let mut by_id = HashMap::new();
        let mut by_doi = HashMap::new();
        let mut by_arxiv = HashMap::new();
        let mut by_title = HashMap::new();

        for (idx, p) in items.iter().enumerate() {
            by_id.insert(p.id.clone(), idx);
            if let Some(d) = p.doi.as_deref().and_then(clean_doi_key) {
                by_doi.entry(d).or_insert(idx);
            }
            if let Some(a) = p.arxiv_id.as_deref().and_then(clean_arxiv_key) {
                by_arxiv.entry(a.clone()).or_insert(idx);
                by_doi.entry(format!("10.48550/arxiv.{a}")).or_insert(idx);
            }
            let tk = norm_title_key(&p.title);
            if tk.len() >= 8 {
                by_title.entry(tk).or_insert(idx);
            }
        }

        Self {
            items,
            by_id,
            by_doi,
            by_arxiv,
            by_title,
        }
    }

    fn resolve_seed(&self, raw_id: &str) -> Option<&'a CollectionSnapshotPaper> {
        let trimmed = raw_id.trim();
        if let Some(&idx) = self.by_id.get(trimmed) {
            return Some(&self.items[idx]);
        }
        if let Some(a) = clean_arxiv_key(trimmed) {
            if let Some(&idx) = self.by_arxiv.get(&a) {
                return Some(&self.items[idx]);
            }
        }
        if let Some(d) = clean_doi_key(trimmed) {
            if let Some(&idx) = self.by_doi.get(&d) {
                return Some(&self.items[idx]);
            }
        }
        None
    }

    fn match_stub(&self, stub: &ExternalPaperStub) -> Option<&'a CollectionSnapshotPaper> {
        if let Some(a) = stub.arxiv_id.as_deref().and_then(clean_arxiv_key) {
            if let Some(&idx) = self.by_arxiv.get(&a) {
                return Some(&self.items[idx]);
            }
        }
        if let Some(d) = stub.doi.as_deref().and_then(clean_doi_key) {
            if let Some(&idx) = self.by_doi.get(&d) {
                return Some(&self.items[idx]);
            }
            if let Some(a) = d.strip_prefix("10.48550/arxiv.") {
                if let Some(&idx) = self.by_arxiv.get(a) {
                    return Some(&self.items[idx]);
                }
            }
        }
        let tk = norm_title_key(&stub.title);
        if tk.len() >= 10 {
            if let Some(&idx) = self.by_title.get(&tk) {
                return Some(&self.items[idx]);
            }
        }
        None
    }
}

fn stub_from_openalex_work(work: &Value) -> Option<ExternalPaperStub> {
    let title = work
        .get("title")
        .or_else(|| work.get("display_name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let doi = work
        .get("doi")
        .and_then(Value::as_str)
        .and_then(clean_doi_key);
    let arxiv_from_ids = work
        .get("ids")
        .and_then(|ids| ids.get("arxiv"))
        .and_then(Value::as_str)
        .and_then(clean_arxiv_key);
    let arxiv_id = arxiv_from_ids.or_else(|| {
        doi.as_deref()
            .and_then(|d| d.strip_prefix("10.48550/arxiv."))
            .map(str::to_string)
    });
    let openalex_id = work
        .get("id")
        .and_then(Value::as_str)
        .map(|s| s.rsplit('/').next().unwrap_or(s).to_string())
        .filter(|s| !s.is_empty());
    let cited_by_count = work
        .get("cited_by_count")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;

    if title.is_empty() && doi.is_none() && arxiv_id.is_none() {
        return None;
    }

    Some(ExternalPaperStub {
        openalex_id,
        doi,
        arxiv_id,
        title,
        cited_by_count,
    })
}

async fn fetch_edges_for_seed(seed: &CollectionSnapshotPaper) -> CachedPaperEdges {
    let mut edges = CachedPaperEdges::default();
    let lookup_doi = seed.doi.as_deref().and_then(clean_doi_key).or_else(|| {
        seed.arxiv_id
            .as_deref()
            .and_then(clean_arxiv_key)
            .map(|a| format!("10.48550/arxiv.{a}"))
    });

    let mut referenced_oa_ids: Vec<String> = Vec::new();
    let select = "id,title,display_name,doi,ids,cited_by_count,referenced_works";

    let work_val = if let Some(ref d) = lookup_doi {
        let url = format!(
            "https://api.openalex.org/works/https://doi.org/{}?select={select}&mailto={OPENALEX_MAILTO}",
            urlencoding::encode(d)
        );
        scholar_client::get_json(&url).await.ok()
    } else {
        None
    };

    let work_val = match work_val {
        Some(v) => Some(v),
        None => {
            let url = format!(
                "https://api.openalex.org/works?search={}&per-page=3&select={select}&mailto={OPENALEX_MAILTO}",
                urlencoding::encode(&seed.title)
            );
            scholar_client::get_json(&url).await.ok().and_then(|res| {
                let target_tk = norm_title_key(&seed.title);
                res.get("results")
                    .and_then(Value::as_array)?
                    .iter()
                    .find(|r| {
                        let t = r
                            .get("title")
                            .or_else(|| r.get("display_name"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        norm_title_key(t) == target_tk
                    })
                    .cloned()
            })
        }
    };

    if let Some(ref work) = work_val {
        edges.openalex_id = work
            .get("id")
            .and_then(Value::as_str)
            .map(|s| s.rsplit('/').next().unwrap_or(s).to_string())
            .filter(|s| !s.is_empty());

        if let Some(arr) = work.get("referenced_works").and_then(Value::as_array) {
            for item in arr.iter().take(45) {
                if let Some(wid) = item
                    .as_str()
                    .map(|s| s.rsplit('/').next().unwrap_or(s).to_string())
                    .filter(|s| s.starts_with('W'))
                {
                    referenced_oa_ids.push(wid);
                }
            }
        }
    }

    // 1. Outgoing references via OpenAlex batch (or Semantic Scholar / Crossref fallback)
    if !referenced_oa_ids.is_empty() {
        let filter = format!("openalex:{}", referenced_oa_ids.join("|"));
        let url = format!(
            "https://api.openalex.org/works?filter={}&per-page=50&select=id,title,display_name,doi,ids,cited_by_count&mailto={OPENALEX_MAILTO}",
            urlencoding::encode(&filter)
        );
        if let Ok(val) = scholar_client::get_json(&url).await {
            if let Some(rows) = val.get("results").and_then(Value::as_array) {
                for row in rows {
                    if let Some(stub) = stub_from_openalex_work(row) {
                        edges.references.push(stub);
                    }
                }
            }
        }
    }

    if edges.references.is_empty() {
        let fallback = fetch_references(seed.doi.as_deref(), seed.arxiv_id.as_deref()).await;
        for r in fallback.refs {
            edges.references.push(ExternalPaperStub {
                openalex_id: None,
                doi: r.identifiers.doi,
                arxiv_id: r.identifiers.arxiv_id,
                title: r.title,
                cited_by_count: r.citation_count.unwrap_or(0) as u32,
            });
        }
    }

    // 2. Incoming `cited_by` (OpenAlex `cites:W...` + Semantic Scholar `/citations`)
    if let Some(ref wid) = edges.openalex_id {
        let filter = format!("cites:{wid},from_publication_date:2025-11-01");
        let url = format!(
            "https://api.openalex.org/works?filter={}&per-page=100&select=id,title,display_name,doi,ids,cited_by_count&mailto={OPENALEX_MAILTO}",
            urlencoding::encode(&filter)
        );
        if let Ok(val) = scholar_client::get_json(&url).await {
            if let Some(rows) = val.get("results").and_then(Value::as_array) {
                for row in rows {
                    if let Some(stub) = stub_from_openalex_work(row) {
                        edges.cited_by.push(stub);
                    }
                }
            }
        }
    }

    if edges.cited_by.is_empty() {
        let ext_id = seed
            .arxiv_id
            .as_deref()
            .and_then(clean_arxiv_key)
            .map(|a| format!("ARXIV:{a}"))
            .or_else(|| {
                seed.doi
                    .as_deref()
                    .and_then(clean_doi_key)
                    .map(|d| format!("DOI:{d}"))
            });
        if let Some(ext_id) = ext_id {
            let s2_url = format!(
                "https://api.semanticscholar.org/graph/v1/paper/{}/citations?fields=title,externalIds,citationCount&limit=150",
                urlencoding::encode(&ext_id)
            );
            if let Ok(val) = scholar_client::get_json(&s2_url).await {
                if let Some(rows) = val.get("data").and_then(Value::as_array) {
                    for row in rows {
                        if let Some(cp) = row.get("citingPaper") {
                            let title = cp
                                .get("title")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .trim()
                                .to_string();
                            let doi = cp
                                .get("externalIds")
                                .and_then(|e| e.get("DOI"))
                                .and_then(Value::as_str)
                                .and_then(clean_doi_key);
                            let arxiv_id = cp
                                .get("externalIds")
                                .and_then(|e| e.get("ArXiv"))
                                .and_then(Value::as_str)
                                .and_then(clean_arxiv_key);
                            let cited_by_count =
                                cp.get("citationCount").and_then(Value::as_u64).unwrap_or(0) as u32;
                            if !title.is_empty() || doi.is_some() || arxiv_id.is_some() {
                                edges.cited_by.push(ExternalPaperStub {
                                    openalex_id: None,
                                    doi,
                                    arxiv_id,
                                    title,
                                    cited_by_count,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Co-citation pivot: pick top referenced OpenAlex works and fetch 2026 works citing them
    let mut pivot_refs: Vec<&ExternalPaperStub> = edges
        .references
        .iter()
        .filter(|r| {
            r.openalex_id
                .as_deref()
                .is_some_and(|id| id.starts_with('W'))
        })
        .collect();
    pivot_refs.sort_by_key(|a| std::cmp::Reverse(a.cited_by_count));
    // Prefer informative mid-specificity references (avoid ultra-generic 50k+ citation transformers if possible)
    let specific_pivots: Vec<&ExternalPaperStub> = pivot_refs
        .iter()
        .copied()
        .filter(|r| r.cited_by_count <= 5_000)
        .take(5)
        .collect();
    let chosen_pivots = if specific_pivots.is_empty() {
        pivot_refs.into_iter().take(4).collect::<Vec<_>>()
    } else {
        specific_pivots
    };

    for pivot in chosen_pivots {
        let Some(ref wid) = pivot.openalex_id else {
            continue;
        };
        let filter = format!("cites:{wid},publication_year:2026");
        let url = format!(
            "https://api.openalex.org/works?filter={}&sort=publication_date:desc&per-page=80&select=id,title,display_name,doi,ids,cited_by_count&mailto={OPENALEX_MAILTO}",
            urlencoding::encode(&filter)
        );
        if let Ok(val) = scholar_client::get_json(&url).await {
            if let Some(rows) = val.get("results").and_then(Value::as_array) {
                let pivot_label = if pivot.title.is_empty() {
                    wid.clone()
                } else {
                    pivot.title.clone()
                };
                for row in rows {
                    if let Some(stub) = stub_from_openalex_work(row) {
                        edges.cocited_2026.push((pivot_label.clone(), stub));
                    }
                }
            }
        }
    }

    edges
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

pub async fn snowball_citations_in_collection<'a>(
    cache_dir: &Path,
    snapshot: &'a CollectionSnapshot,
    params: &CollectionCitationsParams,
) -> CollectionCitationsOut {
    let lookup = CollectionLookup::new(&snapshot.items);
    let mut resolved_seeds: Vec<&CollectionSnapshotPaper> = Vec::new();
    let mut unresolved_seeds: Vec<String> = Vec::new();
    let mut seed_id_set: HashSet<String> = HashSet::new();

    for raw in params.paper_ids.iter().take(5) {
        if let Some(p) = lookup.resolve_seed(raw) {
            if seed_id_set.insert(p.id.clone()) {
                resolved_seeds.push(p);
            }
        } else if !raw.trim().is_empty() {
            unresolved_seeds.push(raw.trim().to_string());
        }
    }

    if resolved_seeds.is_empty() {
        return CollectionCitationsOut {
            resolved_seeds: Vec::new(),
            unresolved_seeds,
            returned_count: 0,
            items: Vec::new(),
        };
    }

    let dir_mode = params
        .direction
        .as_deref()
        .unwrap_or("both")
        .trim()
        .to_ascii_lowercase();
    let want_refs = dir_mode == "both" || dir_mode == "references";
    let want_cited_by = dir_mode == "both" || dir_mode == "cited_by";
    let want_cocited = dir_mode == "both" || dir_mode == "cocited";

    let mut edge_cache = load_edge_cache(cache_dir);
    let mut cache_dirty = false;

    struct Acc<'a> {
        paper: &'a CollectionSnapshotPaper,
        relation_rank: u8, // 3 = cited_by, 2 = references, 1 = cocited
        relation_type: &'static str,
        seeds: HashSet<String>,
        via: Vec<String>,
    }

    fn record_hit<'a>(
        hits: &mut HashMap<String, Acc<'a>>,
        seed_id_set: &HashSet<String>,
        seed_id: &str,
        cand: &'a CollectionSnapshotPaper,
        rank: u8,
        rel: &'static str,
        via_msg: String,
    ) -> bool {
        if seed_id_set.contains(&cand.id) {
            return false;
        }
        let entry = hits.entry(cand.id.clone()).or_insert_with(|| Acc {
            paper: cand,
            relation_rank: rank,
            relation_type: rel,
            seeds: HashSet::new(),
            via: Vec::new(),
        });
        if rank > entry.relation_rank {
            entry.relation_rank = rank;
            entry.relation_type = rel;
        }
        entry.seeds.insert(seed_id.to_string());
        if entry.via.len() < 4 && !entry.via.contains(&via_msg) {
            entry.via.push(via_msg);
        }
        true
    }

    let mut hits: HashMap<String, Acc<'a>> = HashMap::new();

    for seed in &resolved_seeds {
        let edges = if let Some(cached) = edge_cache.get(&seed.id) {
            cached.clone()
        } else {
            let fetched = fetch_edges_for_seed(seed).await;
            edge_cache.insert(seed.id.clone(), fetched.clone());
            cache_dirty = true;
            fetched
        };

        let mut seed_matched = false;

        if want_cited_by {
            for stub in &edges.cited_by {
                if let Some(cand) = lookup.match_stub(stub) {
                    seed_matched |= record_hit(
                        &mut hits,
                        &seed_id_set,
                        &seed.id,
                        cand,
                        3,
                        "cited_by",
                        format!("Directly cites seed `{}`", seed.id),
                    );
                }
            }
        }

        if want_refs {
            for stub in &edges.references {
                if let Some(cand) = lookup.match_stub(stub) {
                    seed_matched |= record_hit(
                        &mut hits,
                        &seed_id_set,
                        &seed.id,
                        cand,
                        2,
                        "references",
                        format!("Directly referenced by seed `{}`", seed.id),
                    );
                }
            }
        }

        if want_cocited {
            for (pivot_title, stub) in &edges.cocited_2026 {
                if let Some(cand) = lookup.match_stub(stub) {
                    seed_matched |= record_hit(
                        &mut hits,
                        &seed_id_set,
                        &seed.id,
                        cand,
                        1,
                        "cocited",
                        format!("Co-cites `{pivot_title}` with `{}`", seed.id),
                    );
                }
            }
        }

        // Local fast fallback: if network is offline or returned 0 in-collection links,
        // compute deterministic shared-keyword / author lineage overlap strictly inside Collection.
        if !seed_matched && want_cocited && !seed.keywords.is_empty() {
            let seed_kw: HashSet<String> = seed.keywords.iter().map(|k| k.to_lowercase()).collect();
            let seed_authors: HashSet<String> =
                seed.authors.iter().map(|a| a.to_lowercase()).collect();
            for item in &snapshot.items {
                if seed_id_set.contains(&item.id) {
                    continue;
                }
                let shared_kw: Vec<&str> = item
                    .keywords
                    .iter()
                    .filter(|k| seed_kw.contains(&k.to_lowercase()))
                    .map(String::as_str)
                    .collect();
                let shared_auth = item
                    .authors
                    .iter()
                    .any(|a| seed_authors.contains(&a.to_lowercase()));
                if shared_kw.len() >= 2 || (shared_auth && !shared_kw.is_empty()) {
                    let _ = record_hit(
                        &mut hits,
                        &seed_id_set,
                        &seed.id,
                        item,
                        1,
                        "cocited",
                        format!(
                            "Shared technical lineage ({}) with `{}`",
                            shared_kw.join(", "),
                            seed.id
                        ),
                    );
                }
            }
        }
    }

    if cache_dirty {
        save_edge_cache(cache_dir, &edge_cache);
    }

    let limit = params.limit.unwrap_or(25).clamp(1, 50);
    let mut ranked: Vec<Acc<'_>> = hits.into_values().collect();
    ranked.sort_by(|a, b| {
        b.seeds
            .len()
            .cmp(&a.seeds.len())
            .then_with(|| b.relation_rank.cmp(&a.relation_rank))
            .then_with(|| b.via.len().cmp(&a.via.len()))
            .then_with(|| b.paper.citation_count.cmp(&a.paper.citation_count))
            .then_with(|| b.paper.published_at.cmp(&a.paper.published_at))
    });

    let items: Vec<SnowballPaperHit> = ranked
        .into_iter()
        .take(limit)
        .map(|acc| {
            let score = (acc.seeds.len() as f32) * 3.0
                + (acc.relation_rank as f32) * 2.0
                + (acc.via.len() as f32);
            let mut linked_seed_ids: Vec<String> = acc.seeds.into_iter().collect();
            linked_seed_ids.sort();
            SnowballPaperHit {
                paper: to_hit(acc.paper, score),
                relation_type: acc.relation_type.to_string(),
                linked_seed_ids,
                via: acc.via,
            }
        })
        .collect();

    CollectionCitationsOut {
        resolved_seeds: resolved_seeds.into_iter().map(|s| s.id.clone()).collect(),
        unresolved_seeds,
        returned_count: items.len(),
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_snapshot() -> CollectionSnapshot {
        let mut items = Vec::new();
        for idx in 1..=65 {
            let is_multi_agent = idx % 2 == 0;
            let is_venue = idx % 3 == 0;
            items.push(CollectionSnapshotPaper {
                id: if is_venue {
                    format!("doi:10.1145/37700{idx:02}")
                } else {
                    format!("arxiv:2603.{idx:05}")
                },
                title: if is_multi_agent {
                    format!("Multi-Agent Vulnerability Repair System #{idx}")
                } else {
                    format!("Symbolic Fuzzing for Rust Kernels #{idx}")
                },
                authors: vec!["Alice Smith".into()],
                abstract_text: if is_multi_agent {
                    "We propose an autonomous multi-agent workflow for software vulnerability repair."
                        .into()
                } else {
                    "We design a directed symbolic execution fuzzer for memory safety.".into()
                },
                published_at: format!("2026-03-{:02}T00:00:00Z", (idx % 28) + 1),
                year: 2026,
                source_type: if is_venue {
                    "venue".into()
                } else {
                    "arxiv".into()
                },
                source_label: if is_venue {
                    "ICSE 2026".into()
                } else {
                    "cs.SE".into()
                },
                categories: vec![if is_venue {
                    "ICSE 2026".into()
                } else {
                    "cs.SE".into()
                }],
                url: format!("https://example.org/p/{idx}"),
                pdf_url: None,
                arxiv_id: (!is_venue).then(|| format!("2603.{idx:05}")),
                doi: is_venue.then(|| format!("10.1145/37700{idx:02}")),
                venue_id: is_venue.then(|| "icse-2026".into()),
                venue_kind: is_venue.then(|| "conference".into()),
                venue_domain: is_venue.then(|| "PL/SE".into()),
                ccf_rank: is_venue.then(|| "CCF-A".into()),
                venue_full: None,
                citation_count: idx as u32,
                keywords: if is_multi_agent {
                    vec!["Multi-Agent".into(), "Program Repair".into()]
                } else {
                    vec!["Fuzzing".into(), "Symbolic Execution".into()]
                },
            });
        }
        CollectionSnapshot {
            updated_at: "2026-04-01T00:00:00Z".into(),
            categories: vec!["cs.SE".into(), "cs.AI".into()],
            venues: vec![CollectionVenueMeta {
                id: "icse-2026".into(),
                name: "ICSE 2026".into(),
                kind: Some("conference".into()),
                domain: Some("PL/SE".into()),
                ccf_rank: Some("CCF-A".into()),
            }],
            items,
        }
    }

    #[test]
    fn random_sample_caps_at_50_and_reports_total_matched() {
        let snap = sample_snapshot();
        let res = search_collection(
            &snap,
            &CollectionSearchParams {
                query: Some("\"multi-agent\" OR fuzzing".into()),
                mode: Some("random_sample".into()),
                sample_size: Some(50),
                seed: Some(12345),
                ..Default::default()
            },
        );
        assert_eq!(res.total_matched, 65);
        assert_eq!(res.returned_count, 50);
        assert_eq!(res.items.len(), 50);
    }

    #[test]
    fn boolean_negation_and_combinable_ccf_arxiv_filters_work() {
        let snap = sample_snapshot();
        let res = search_collection(
            &snap,
            &CollectionSearchParams {
                query: Some("repair -symbolic".into()),
                mode: Some("ranked".into()),
                ccf_ranks: vec!["CCF-A".into()],
                limit: Some(50),
                ..Default::default()
            },
        );
        assert!(!res.items.is_empty());
        assert!(res
            .items
            .iter()
            .all(|p| p.ccf_rank.as_deref() == Some("CCF-A") && p.title.contains("Multi-Agent")));
    }

    #[test]
    fn curate_drops_unknown_ids_and_preserves_valid_groups() {
        let snap = sample_snapshot();
        let out = curate_collection(
            &snap,
            CollectionCurateParams {
                groups: vec![CurateGroupInput {
                    label: "Multi-Agent Repair".into(),
                    items: vec![
                        CurateItemInput {
                            id: "arxiv:2603.00002".into(),
                            reason: Some("Autonomous repair pipeline".into()),
                        },
                        CurateItemInput {
                            id: "arxiv:9999.99999".into(),
                            reason: None,
                        },
                    ],
                }],
                mode: Some("replace".into()),
                suggested_follow_ups: vec!["Focus on CCF-A venues".into()],
            },
        );
        assert_eq!(out.curated_count, 1);
        assert_eq!(out.dropped_unknown_ids, vec!["arxiv:9999.99999"]);
        assert_eq!(out.groups[0].items[0].id, "arxiv:2603.00002");
    }
}
