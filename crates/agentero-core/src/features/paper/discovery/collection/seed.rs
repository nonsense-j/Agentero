//! GitHub Releases static seed sync (`seed_sync`) and maintainer seed baker (`seed_bake`)
//! for Plaza `Paper Collection`.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use futures_util::stream::{self, StreamExt};
use reqwest::StatusCode;
use rusqlite::{params, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::AppError;

use super::keywords::{canonicalize_keywords, normalize_keyword_key};
use super::models::{
    CollectionArxivWatermarkInput, CollectionPaperUpsertInput, CollectionSeedSyncArgs,
    CollectionSeedSyncOut, CollectionVenueWatermarkUpdate,
};
use super::schema::{collection_db_path, ensure_collection_at};
use super::store::{
    apply_venue_watermark_update_tx, build_keywords_text, clean_arxiv_key, clean_doi_key,
    clean_openalex_id, clean_opt_str, clean_publisher_doi, clean_string_vec,
    insert_work_raw_refs_tx, load_enabled_categories, normalize_ref_key, now_rfc3339,
    read_state_summary_conn, recompute_graph_and_citations_tx, upsert_arxiv_watermarks_tx,
    upsert_single_paper_tx,
};

pub const DEFAULT_SEED_MANIFEST_URL: &str =
    "https://github.com/nonsense-j/Agentero/releases/download/collection-seed-2026/manifest.json";

pub const DEFAULT_BAKE_LLM_BASE_URL: &str = "http://127.0.0.1:8011/v1";
pub const DEFAULT_BAKE_LLM_MODEL: &str = "mercury-3-instant";

const OPENALEX_MAILTO: &str = "agentero@users.noreply.github.com";
const LLM_RETRY_DELAYS_SECS: [u64; 8] = [3, 6, 12, 25, 45, 45, 45, 45];
const UPSTREAM_RETRY_DELAYS_SECS: [u64; 6] = [2, 5, 10, 20, 35, 45];

// ─── Seed Manifest & JSONL Record Wire Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedShardEntry {
    pub id: String,
    /// `"core"`, `"addon-cs-ai"`, or `"delta"`.
    pub kind: String,
    pub filename: String,
    pub sha256: String,
    pub paper_count: usize,
    #[serde(default)]
    pub categories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedArxivWatermark {
    pub latest_published_at: String,
    pub latest_arxiv_id: String,
    pub last_synced_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oldest_synced_published_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_total: Option<usize>,
    #[serde(default)]
    pub history_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedVenueWatermark {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fetched_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_published_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_total_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedManifest {
    pub version: u32,
    pub generated_at: String,
    pub shards: Vec<SeedShardEntry>,
    #[serde(default)]
    pub arxiv_watermarks: HashMap<String, SeedArxivWatermark>,
    #[serde(default)]
    pub venue_watermarks: HashMap<String, SeedVenueWatermark>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedPaperRecord {
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
    pub keywords: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyword_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openalex_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub raw_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bibtex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cool_papers_id: Option<String>,
}

impl From<SeedPaperRecord> for CollectionPaperUpsertInput {
    fn from(r: SeedPaperRecord) -> Self {
        Self {
            id: r.id,
            title: r.title,
            authors: r.authors,
            abstract_text: r.abstract_text,
            published_at: r.published_at,
            year: r.year,
            source_type: r.source_type,
            source_label: r.source_label,
            categories: r.categories,
            url: r.url,
            pdf_url: r.pdf_url,
            arxiv_id: r.arxiv_id,
            doi: r.doi,
            venue_id: r.venue_id,
            venue_kind: r.venue_kind,
            venue_domain: r.venue_domain,
            ccf_rank: r.ccf_rank,
            venue_full: r.venue_full,
            citation_count: None,
            keywords: r.keywords,
            keyword_source: r.keyword_source,
            openalex_id: r.openalex_id,
            raw_refs: r.raw_refs,
            volume: r.volume,
            issue: r.issue,
            pages: r.pages,
            bibtex: r.bibtex,
            cool_papers_id: r.cool_papers_id,
            recommended_at: None,
        }
    }
}

// ─── Client / CLI Streaming Seed Sync ───

enum ManifestLocation {
    Http(url::Url),
    Local(PathBuf),
}

fn parse_manifest_location(raw: &str) -> Result<ManifestLocation, AppError> {
    let trimmed = raw.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let parsed = url::Url::parse(trimmed).map_err(|e| {
            AppError::message(format!("invalid seed manifest url `{trimmed}`: {e}"))
        })?;
        return Ok(ManifestLocation::Http(parsed));
    }
    if let Some(file_rest) = trimmed.strip_prefix("file://") {
        let p = url::Url::parse(trimmed)
            .ok()
            .and_then(|u| u.to_file_path().ok())
            .unwrap_or_else(|| PathBuf::from(file_rest));
        return Ok(ManifestLocation::Local(p));
    }
    let path = PathBuf::from(trimmed);
    if path.is_dir() {
        return Ok(ManifestLocation::Local(path.join("manifest.json")));
    }
    Ok(ManifestLocation::Local(path))
}

fn seed_http_client() -> Result<reqwest::Client, AppError> {
    crate::http::client_with(Duration::from_secs(180), 10, crate::http::USER_AGENT)
}

async fn fetch_manifest(
    loc: &ManifestLocation,
    force: bool,
) -> Result<Option<SeedManifest>, AppError> {
    match loc {
        ManifestLocation::Local(path) => {
            if !path.is_file() {
                if !force {
                    return Ok(None);
                }
                return Err(AppError::message(format!(
                    "seed manifest not found at {}",
                    path.display()
                )));
            }
            let bytes = tokio::fs::read(path).await?;
            let manifest: SeedManifest = serde_json::from_slice(&bytes).map_err(|e| {
                AppError::message(format!("parse seed manifest {}: {e}", path.display()))
            })?;
            Ok(Some(manifest))
        }
        ManifestLocation::Http(url) => {
            let client = seed_http_client()?;
            let resp = client
                .get(url.clone())
                .send()
                .await
                .map_err(|e| AppError::message(format!("fetch seed manifest {url}: {e}")))?;
            if resp.status() == StatusCode::NOT_FOUND {
                if !force {
                    return Ok(None);
                }
                return Err(AppError::message(format!(
                    "seed manifest returned 404 at {url}"
                )));
            }
            if !resp.status().is_success() {
                return Err(AppError::message(format!(
                    "seed manifest HTTP {} at {url}",
                    resp.status()
                )));
            }
            let bytes = resp
                .bytes()
                .await
                .map_err(|e| AppError::message(format!("read seed manifest body: {e}")))?;
            let manifest: SeedManifest = serde_json::from_slice(&bytes)
                .map_err(|e| AppError::message(format!("parse seed manifest JSON: {e}")))?;
            Ok(Some(manifest))
        }
    }
}

async fn download_or_locate_shard(
    loc: &ManifestLocation,
    shard: &SeedShardEntry,
    temp_dir: &Path,
) -> Result<PathBuf, AppError> {
    match loc {
        ManifestLocation::Local(manifest_path) => {
            let parent = manifest_path.parent().unwrap_or_else(|| Path::new("."));
            let shard_path = parent.join(&shard.filename);
            if !shard_path.is_file() {
                return Err(AppError::message(format!(
                    "seed shard file missing: {}",
                    shard_path.display()
                )));
            }
            verify_file_sha256(&shard_path, &shard.sha256)?;
            Ok(shard_path)
        }
        ManifestLocation::Http(manifest_url) => {
            let shard_url = manifest_url.join(&shard.filename).map_err(|e| {
                AppError::message(format!("resolve shard url {}: {e}", shard.filename))
            })?;
            let client = seed_http_client()?;
            let mut resp =
                client.get(shard_url.clone()).send().await.map_err(|e| {
                    AppError::message(format!("download seed shard {shard_url}: {e}"))
                })?;
            if !resp.status().is_success() {
                return Err(AppError::message(format!(
                    "seed shard HTTP {} at {shard_url}",
                    resp.status()
                )));
            }

            let dest = temp_dir.join(&shard.filename);
            let mut file = File::create(&dest)?;
            let mut hasher = Sha256::new();
            while let Some(chunk) = resp.chunk().await.map_err(|e| {
                AppError::message(format!("stream seed shard {}: {e}", shard.filename))
            })? {
                hasher.update(&chunk);
                file.write_all(&chunk)?;
            }
            file.flush()?;
            let actual_hex = hex::encode(hasher.finalize());
            let expected = shard.sha256.trim().to_ascii_lowercase();
            if !expected.is_empty() && actual_hex != expected {
                let _ = fs::remove_file(&dest);
                return Err(AppError::message(format!(
                    "SHA-256 mismatch for {}: expected {expected}, got {actual_hex}",
                    shard.filename
                )));
            }
            Ok(dest)
        }
    }
}

fn verify_file_sha256(path: &Path, expected_hex: &str) -> Result<String, AppError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = hex::encode(hasher.finalize());
    let expected = expected_hex.trim().to_ascii_lowercase();
    if !expected.is_empty() && actual != expected {
        return Err(AppError::message(format!(
            "SHA-256 mismatch for {}: expected {expected}, got {actual}",
            path.display()
        )));
    }
    Ok(actual)
}

fn shard_matches_enabled_scope(shard: &SeedShardEntry, enabled_cats: &[String]) -> bool {
    let cs_ai_enabled = enabled_cats.iter().any(|c| c.eq_ignore_ascii_case("cs.AI"));
    match shard.kind.trim().to_ascii_lowercase().as_str() {
        "core" => true,
        "addon-cs-ai" => cs_ai_enabled,
        "delta" => {
            shard.categories.is_empty()
                || shard.categories.iter().any(|sc| {
                    enabled_cats
                        .iter()
                        .any(|ec| ec.eq_ignore_ascii_case(sc.trim()))
                })
        }
        _ => false,
    }
}

pub async fn seed_sync(args: CollectionSeedSyncArgs) -> Result<CollectionSeedSyncOut, AppError> {
    let db_path = collection_db_path();
    seed_sync_at(&db_path, args).await
}

pub async fn seed_sync_at(
    db_path: &Path,
    args: CollectionSeedSyncArgs,
) -> Result<CollectionSeedSyncOut, AppError> {
    let force = args.force.unwrap_or(false);
    let db_check = db_path.to_path_buf();
    let initial_state = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let conn = ensure_collection_at(&db_check)?;
        read_state_summary_conn(&conn)
    })
    .await
    .map_err(|e| AppError::message(format!("seed_sync init join: {e}")))??;

    if initial_state.seed_cleared && !force {
        return Ok(CollectionSeedSyncOut {
            state: initial_state,
            applied_shards: Vec::new(),
            imported_papers: 0,
            skipped: true,
        });
    }

    let raw_url = args
        .manifest_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SEED_MANIFEST_URL);
    let loc = parse_manifest_location(raw_url)?;

    let Some(manifest) = fetch_manifest(&loc, force).await? else {
        return Ok(CollectionSeedSyncOut {
            state: initial_state,
            applied_shards: Vec::new(),
            imported_papers: 0,
            skipped: true,
        });
    };

    let already_applied: HashSet<String> = if force {
        HashSet::new()
    } else {
        initial_state.applied_seed_ids.iter().cloned().collect()
    };

    let selected_shards: Vec<SeedShardEntry> = manifest
        .shards
        .iter()
        .filter(|s| {
            !s.id.trim().is_empty()
                && !already_applied.contains(s.id.trim())
                && shard_matches_enabled_scope(s, &initial_state.categories)
        })
        .cloned()
        .collect();

    if selected_shards.is_empty() {
        if force && initial_state.seed_cleared {
            let db_clear_flag = db_path.to_path_buf();
            let state = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
                let conn = ensure_collection_at(&db_clear_flag)?;
                conn.execute(
                    "UPDATE collection_config SET seed_cleared = 0 WHERE id = 1",
                    [],
                )?;
                read_state_summary_conn(&conn)
            })
            .await
            .map_err(|e| AppError::message(format!("seed_sync reset join: {e}")))??;
            return Ok(CollectionSeedSyncOut {
                state,
                applied_shards: Vec::new(),
                imported_papers: 0,
                skipped: true,
            });
        }
        return Ok(CollectionSeedSyncOut {
            state: initial_state,
            applied_shards: Vec::new(),
            imported_papers: 0,
            skipped: true,
        });
    }

    let temp_dir = tempfile::tempdir()?;
    let mut local_shards: Vec<(SeedShardEntry, PathBuf)> =
        Vec::with_capacity(selected_shards.len());
    for shard in &selected_shards {
        let local_path = download_or_locate_shard(&loc, shard, temp_dir.path()).await?;
        local_shards.push((shard.clone(), local_path));
    }

    let db_import = db_path.to_path_buf();
    let out = tokio::task::spawn_blocking(move || -> Result<CollectionSeedSyncOut, AppError> {
        let mut conn = ensure_collection_at(&db_import)?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_rfc3339();

        let mut imported_papers = 0usize;
        let mut applied_shards = Vec::with_capacity(local_shards.len());
        let mut imported_core_or_delta = false;

        for (shard, shard_path) in &local_shards {
            let file = File::open(shard_path)?;
            let gz = GzDecoder::new(file);
            let reader = BufReader::with_capacity(128 * 1024, gz);
            for (line_idx, line_res) in reader.lines().enumerate() {
                let line = line_res.map_err(|e| {
                    AppError::message(format!(
                        "gunzip seed shard {} line {}: {e}",
                        shard.filename,
                        line_idx + 1
                    ))
                })?;
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let rec: SeedPaperRecord = serde_json::from_str(trimmed).map_err(|e| {
                    AppError::message(format!(
                        "parse seed shard {} line {}: {e}",
                        shard.filename,
                        line_idx + 1
                    ))
                })?;
                let input: CollectionPaperUpsertInput = rec.into();
                upsert_single_paper_tx(&tx, &input, &now)?;
                imported_papers += 1;
            }
            if matches!(
                shard.kind.trim().to_ascii_lowercase().as_str(),
                "core" | "delta"
            ) {
                imported_core_or_delta = true;
            }
            applied_shards.push(shard.id.trim().to_string());
        }

        // Advance arXiv watermarks monotonically for enabled categories.
        let enabled_cats = load_enabled_categories(&tx)?;
        let cs_ai_enabled = enabled_cats.iter().any(|c| c.eq_ignore_ascii_case("cs.AI"));
        let mut wm_updates: HashMap<String, CollectionArxivWatermarkInput> = HashMap::new();
        for (cat, swm) in &manifest.arxiv_watermarks {
            if cat.eq_ignore_ascii_case("cs.AI") && !cs_ai_enabled {
                continue;
            }
            let existing_latest: Option<String> = tx
                .query_row(
                    "SELECT latest_published_at FROM arxiv_watermarks WHERE category = ?1",
                    [cat.as_str()],
                    |r| r.get(0),
                )
                .ok();
            let should_advance = existing_latest
                .as_deref()
                .is_none_or(|cur| swm.latest_published_at.as_str() >= cur);
            if should_advance {
                wm_updates.insert(
                    cat.clone(),
                    CollectionArxivWatermarkInput {
                        latest_published_at: swm.latest_published_at.clone(),
                        latest_arxiv_id: swm.latest_arxiv_id.clone(),
                        last_synced_at: swm.last_synced_at.clone(),
                        oldest_synced_published_at: swm.oldest_synced_published_at.clone(),
                        remote_total: swm.remote_total,
                        history_complete: Some(swm.history_complete),
                    },
                );
            }
        }
        if !wm_updates.is_empty() {
            upsert_arxiv_watermarks_tx(&tx, &wm_updates)?;
        }

        // Advance venue watermarks monotonically when core/delta shards are applied.
        if imported_core_or_delta {
            for (vid, vwm) in &manifest.venue_watermarks {
                let existing_fetched: Option<String> = tx
                    .query_row(
                        "SELECT last_fetched_at FROM venues WHERE id = ?1",
                        [vid.as_str()],
                        |r| r.get::<_, Option<String>>(0),
                    )
                    .ok()
                    .flatten();
                let should_advance = match (&existing_fetched, &vwm.last_fetched_at) {
                    (None, Some(_)) => true,
                    (Some(cur), Some(inc)) => inc.as_str() >= cur.as_str(),
                    (None, None) => vwm.remote_total_count.is_some(),
                    _ => false,
                };
                if should_advance {
                    apply_venue_watermark_update_tx(
                        &tx,
                        &CollectionVenueWatermarkUpdate {
                            venue_id: vid.clone(),
                            last_fetched_at: vwm.last_fetched_at.clone(),
                            latest_published_at: vwm.latest_published_at.clone(),
                            remote_total_count: vwm.remote_total_count,
                        },
                    )?;
                }
            }
        }

        // Record applied_seed_ids, clear seed_cleared, and stamp last_refreshed_at if empty.
        let prev_applied_raw: String = tx.query_row(
            "SELECT applied_seed_ids_json FROM collection_config WHERE id = 1",
            [],
            |r| r.get(0),
        )?;
        let mut merged_applied: Vec<String> =
            serde_json::from_str(&prev_applied_raw).unwrap_or_default();
        for sid in &applied_shards {
            if !merged_applied.iter().any(|x| x == sid) {
                merged_applied.push(sid.clone());
            }
        }
        let merged_applied_json = serde_json::to_string(&clean_string_vec(&merged_applied))?;
        let gen_ts = clean_opt_str(Some(manifest.generated_at.clone()));
        tx.execute(
            "UPDATE collection_config
             SET seed_cleared = 0,
                 applied_seed_ids_json = ?1,
                 last_refreshed_at = CASE
                   WHEN last_refreshed_at IS NULL OR last_refreshed_at = '' THEN ?2
                   ELSE last_refreshed_at
                 END
             WHERE id = 1",
            params![merged_applied_json, gen_ts],
        )?;

        recompute_graph_and_citations_tx(&tx)?;
        tx.commit()?;

        let state = read_state_summary_conn(&conn)?;
        Ok(CollectionSeedSyncOut {
            state,
            applied_shards,
            imported_papers,
            skipped: false,
        })
    })
    .await
    .map_err(|e| AppError::message(format!("seed_sync import join: {e}")))??;

    drop(temp_dir);
    Ok(out)
}

// ─── Maintainer Seed Baker (`seed_bake`) ───

#[derive(Debug, Clone)]
pub struct SeedBakeOptions {
    pub out_dir: PathBuf,
    pub llm_base_url: String,
    pub llm_model: String,
    pub llm_api_key: Option<String>,
    pub llm_concurrency: usize,
    pub skip_refs: bool,
    pub skip_llm: bool,
    pub delta_since: Option<String>,
}

impl Default for SeedBakeOptions {
    fn default() -> Self {
        Self {
            out_dir: PathBuf::from("dist/seed"),
            llm_base_url: DEFAULT_BAKE_LLM_BASE_URL.to_string(),
            llm_model: DEFAULT_BAKE_LLM_MODEL.to_string(),
            llm_api_key: None,
            llm_concurrency: 6,
            skip_refs: false,
            skip_llm: false,
            delta_since: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedBakeReport {
    pub out_dir: String,
    pub manifest_path: String,
    pub openalex_enriched_works: usize,
    pub s2_enriched_works: usize,
    pub llm_enriched_papers: usize,
    pub shards: Vec<SeedShardEntry>,
}

#[derive(Clone)]
struct WorkRefTarget {
    work_id: i64,
    openalex_id: Option<String>,
    doi_norm: Option<String>,
    arxiv_id_norm: Option<String>,
}

fn parse_retry_after_secs(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

async fn get_json_with_backoff(
    client: &reqwest::Client,
    url: &str,
) -> Result<Option<Value>, AppError> {
    for (attempt, &base_secs) in UPSTREAM_RETRY_DELAYS_SECS.iter().enumerate() {
        match client.get(url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return Ok(resp.json::<Value>().await.ok());
                }
                if status == StatusCode::NOT_FOUND {
                    return Ok(None);
                }
                if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                    let wait = parse_retry_after_secs(resp.headers())
                        .unwrap_or(base_secs)
                        .clamp(1, 120);
                    log::warn!(
                        "seed_bake upstream GET HTTP {} (attempt {}/{}), sleeping {}s",
                        status,
                        attempt + 1,
                        UPSTREAM_RETRY_DELAYS_SECS.len(),
                        wait
                    );
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                    continue;
                }
                return Ok(None);
            }
            Err(err) => {
                if attempt + 1 < UPSTREAM_RETRY_DELAYS_SECS.len() {
                    tokio::time::sleep(Duration::from_secs(base_secs)).await;
                } else {
                    log::warn!("seed_bake upstream GET failed after retries: {err}");
                }
            }
        }
    }
    Ok(None)
}

fn persist_ref_batch(
    db_path: &Path,
    updates: &[(i64, Option<String>, Vec<String>)],
) -> Result<usize, AppError> {
    if updates.is_empty() {
        return Ok(0);
    }
    let mut conn = ensure_collection_at(db_path)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut enriched = 0usize;
    for (wid, oa_opt, refs) in updates {
        let mut touched = false;
        if let Some(ref oa) = oa_opt {
            tx.execute(
                "UPDATE canonical_works SET openalex_id = COALESCE(openalex_id, ?1) WHERE work_id = ?2",
                params![oa, wid],
            )?;
            tx.execute(
                "UPDATE papers SET openalex_id = COALESCE(openalex_id, ?1) WHERE work_id = ?2",
                params![oa, wid],
            )?;
            touched = true;
        }
        if insert_work_raw_refs_tx(&tx, *wid, refs)? > 0 {
            touched = true;
        }
        if touched {
            enriched += 1;
        }
    }
    tx.commit()?;
    Ok(enriched)
}

async fn run_step_a_refs_backfill(db_path: &Path) -> Result<(usize, usize), AppError> {
    let db_load = db_path.to_path_buf();
    let targets: Vec<WorkRefTarget> = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let conn = ensure_collection_at(&db_load)?;
        let mut stmt = conn.prepare(
            "SELECT cw.work_id, cw.openalex_id, cw.doi_norm, cw.arxiv_id_norm
             FROM canonical_works cw
             WHERE NOT EXISTS (SELECT 1 FROM paper_raw_refs r WHERE r.src_work_id = cw.work_id)
               AND (cw.openalex_id IS NOT NULL OR cw.doi_norm IS NOT NULL OR cw.arxiv_id_norm IS NOT NULL)
             ORDER BY cw.work_id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(WorkRefTarget {
                work_id: r.get(0)?,
                openalex_id: r.get(1)?,
                doi_norm: r.get(2)?,
                arxiv_id_norm: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
    .await
    .map_err(|e| AppError::message(format!("seed_bake load ref targets: {e}")))??;

    if targets.is_empty() {
        return Ok((0, 0));
    }

    let client = crate::http::client_with(Duration::from_secs(60), 5, crate::http::USER_AGENT)?;
    let mut oa_enriched = 0usize;

    // Pass A1: OpenAlex batch lookup (`select=id,doi,ids,referenced_works`, 50/batch)
    let mut by_oa_batch: Vec<&WorkRefTarget> = Vec::new();
    let mut by_doi_batch: Vec<(&WorkRefTarget, String)> = Vec::new();
    for t in &targets {
        if t.openalex_id.is_some() {
            by_oa_batch.push(t);
        } else if let Some(ref d) = t.doi_norm {
            by_doi_batch.push((t, format!("https://doi.org/{d}")));
        } else if let Some(ref a) = t.arxiv_id_norm {
            by_doi_batch.push((t, format!("https://doi.org/10.48550/arxiv.{a}")));
        }
    }

    for chunk in by_oa_batch.chunks(50) {
        let filter_ids: Vec<&str> = chunk
            .iter()
            .filter_map(|t| t.openalex_id.as_deref())
            .collect();
        let url = format!(
            "https://api.openalex.org/works?filter=openalex:{}&per-page=50&select=id,doi,ids,referenced_works&mailto={OPENALEX_MAILTO}",
            filter_ids.join("|")
        );
        if let Some(json) = get_json_with_backoff(&client, &url).await? {
            let updates = match_openalex_results_to_targets(chunk, &json);
            let db_p = db_path.to_path_buf();
            oa_enriched += tokio::task::spawn_blocking(move || persist_ref_batch(&db_p, &updates))
                .await
                .map_err(|e| AppError::message(format!("persist oa batch: {e}")))??;
        }
    }

    for chunk in by_doi_batch.chunks(40) {
        let filter_dois: Vec<String> = chunk
            .iter()
            .map(|(_, d)| urlencoding::encode(d).into_owned())
            .collect();
        let target_refs: Vec<&WorkRefTarget> = chunk.iter().map(|(t, _)| *t).collect();
        let url = format!(
            "https://api.openalex.org/works?filter=doi:{}&per-page=50&select=id,doi,ids,referenced_works&mailto={OPENALEX_MAILTO}",
            filter_dois.join("|")
        );
        if let Some(json) = get_json_with_backoff(&client, &url).await? {
            let updates = match_openalex_results_to_targets(&target_refs, &json);
            let db_p = db_path.to_path_buf();
            oa_enriched += tokio::task::spawn_blocking(move || persist_ref_batch(&db_p, &updates))
                .await
                .map_err(|e| AppError::message(format!("persist oa doi batch: {e}")))??;
        }
    }

    // Pass A2: Semantic Scholar batch (`POST /graph/v1/paper/batch`, 100/batch, auto-bisect 50 -> 20)
    let db_rem = db_path.to_path_buf();
    let s2_targets: Vec<(i64, String)> =
        tokio::task::spawn_blocking(move || -> Result<_, AppError> {
            let conn = ensure_collection_at(&db_rem)?;
            let mut stmt = conn.prepare(
                "SELECT cw.work_id, cw.doi_norm, cw.arxiv_id_norm
                 FROM canonical_works cw
                 WHERE NOT EXISTS (SELECT 1 FROM paper_raw_refs r WHERE r.src_work_id = cw.work_id)
                   AND (cw.doi_norm IS NOT NULL OR cw.arxiv_id_norm IS NOT NULL)
                 ORDER BY cw.work_id ASC",
            )?;
            let rows = stmt.query_map([], |r| {
                let wid: i64 = r.get(0)?;
                let d: Option<String> = r.get(1)?;
                let a: Option<String> = r.get(2)?;
                Ok((wid, d, a))
            })?;
            let mut list = Vec::new();
            for entry in rows {
                let (wid, d_opt, a_opt) = entry?;
                if let Some(d) = d_opt.filter(|s| !s.is_empty()) {
                    list.push((wid, format!("DOI:{d}")));
                } else if let Some(a) = a_opt.filter(|s| !s.is_empty()) {
                    list.push((wid, format!("ARXIV:{a}")));
                }
            }
            Ok(list)
        })
        .await
        .map_err(|e| AppError::message(format!("seed_bake load s2 targets: {e}")))??;

    let mut s2_enriched = 0usize;
    for batch100 in s2_targets.chunks(100) {
        let updates = fetch_s2_batch_with_bisect(&client, batch100).await?;
        if !updates.is_empty() {
            let db_p = db_path.to_path_buf();
            s2_enriched += tokio::task::spawn_blocking(move || persist_ref_batch(&db_p, &updates))
                .await
                .map_err(|e| AppError::message(format!("persist s2 batch: {e}")))??;
        }
    }

    let db_recomp = db_path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        let mut conn = ensure_collection_at(&db_recomp)?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        recompute_graph_and_citations_tx(&tx)?;
        tx.commit()?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::message(format!("seed_bake recompute graph: {e}")))??;

    Ok((oa_enriched, s2_enriched))
}

fn match_openalex_results_to_targets(
    targets: &[&WorkRefTarget],
    json: &Value,
) -> Vec<(i64, Option<String>, Vec<String>)> {
    let Some(results) = json.get("results").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut by_oa: HashMap<&str, i64> = HashMap::new();
    let mut by_doi: HashMap<&str, i64> = HashMap::new();
    let mut by_arxiv: HashMap<&str, i64> = HashMap::new();
    for t in targets {
        if let Some(ref oa) = t.openalex_id {
            by_oa.insert(oa.as_str(), t.work_id);
        }
        if let Some(ref d) = t.doi_norm {
            by_doi.insert(d.as_str(), t.work_id);
        }
        if let Some(ref a) = t.arxiv_id_norm {
            by_arxiv.insert(a.as_str(), t.work_id);
        }
    }

    let mut out = Vec::new();
    for work in results {
        let oa_id = work
            .get("id")
            .and_then(Value::as_str)
            .and_then(clean_openalex_id);
        let raw_doi = work
            .get("doi")
            .and_then(Value::as_str)
            .and_then(clean_doi_key);
        let pub_doi = raw_doi.as_deref().and_then(clean_publisher_doi);
        let arxiv_id = work
            .get("ids")
            .and_then(|ids| ids.get("arxiv"))
            .and_then(Value::as_str)
            .and_then(clean_arxiv_key)
            .or_else(|| {
                raw_doi
                    .as_deref()
                    .and_then(|d| d.strip_prefix("10.48550/arxiv.").and_then(clean_arxiv_key))
            });

        let matched_wid = oa_id
            .as_deref()
            .and_then(|k| by_oa.get(k).copied())
            .or_else(|| pub_doi.as_deref().and_then(|k| by_doi.get(k).copied()))
            .or_else(|| arxiv_id.as_deref().and_then(|k| by_arxiv.get(k).copied()));
        let Some(wid) = matched_wid else {
            continue;
        };

        let refs: Vec<String> = work
            .get("referenced_works")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .filter_map(clean_openalex_id)
                    .map(|w| format!("oa:{w}"))
                    .collect()
            })
            .unwrap_or_default();

        if oa_id.is_some() || !refs.is_empty() {
            out.push((wid, oa_id, refs));
        }
    }
    out
}

async fn fetch_s2_batch_with_bisect(
    client: &reqwest::Client,
    slice: &[(i64, String)],
) -> Result<Vec<(i64, Option<String>, Vec<String>)>, AppError> {
    if slice.is_empty() {
        return Ok(Vec::new());
    }
    let mut pending: Vec<&[(i64, String)]> = vec![slice];
    let mut collected: Vec<(i64, Option<String>, Vec<String>)> = Vec::new();
    let url =
        "https://api.semanticscholar.org/graph/v1/paper/batch?fields=externalIds,references.externalIds";

    while let Some(cur) = pending.pop() {
        if cur.is_empty() {
            continue;
        }
        let ids: Vec<&str> = cur.iter().map(|(_, q)| q.as_str()).collect();
        let body = serde_json::json!({ "ids": ids });

        let mut succeeded = false;
        let mut should_bisect = false;

        for (attempt, &base_secs) in UPSTREAM_RETRY_DELAYS_SECS.iter().enumerate() {
            match client.post(url).json(&body).send().await {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        if let Ok(Value::Array(items)) = resp.json::<Value>().await {
                            for (idx, item) in items.iter().enumerate() {
                                if idx >= cur.len() || item.is_null() {
                                    continue;
                                }
                                let wid = cur[idx].0;
                                let mut refs = Vec::new();
                                if let Some(ref_arr) =
                                    item.get("references").and_then(Value::as_array)
                                {
                                    for r in ref_arr {
                                        let Some(ext) = r.get("externalIds") else {
                                            continue;
                                        };
                                        if let Some(d) = ext
                                            .get("DOI")
                                            .and_then(Value::as_str)
                                            .and_then(normalize_ref_key)
                                        {
                                            refs.push(d);
                                        } else if let Some(a) = ext
                                            .get("ArXiv")
                                            .and_then(Value::as_str)
                                            .and_then(clean_arxiv_key)
                                        {
                                            refs.push(format!("arxiv:{a}"));
                                        }
                                    }
                                }
                                if !refs.is_empty() {
                                    collected.push((wid, None, refs));
                                }
                            }
                        }
                        succeeded = true;
                        break;
                    }
                    if status == StatusCode::TOO_MANY_REQUESTS {
                        let wait = parse_retry_after_secs(resp.headers())
                            .unwrap_or(base_secs)
                            .clamp(1, 120);
                        log::warn!(
                            "seed_bake S2 batch 429 (size={}, attempt={}), sleeping {}s",
                            cur.len(),
                            attempt + 1,
                            wait
                        );
                        tokio::time::sleep(Duration::from_secs(wait)).await;
                        continue;
                    }
                    if (status == StatusCode::BAD_REQUEST
                        || status == StatusCode::PAYLOAD_TOO_LARGE
                        || status.is_server_error())
                        && cur.len() > 20
                    {
                        should_bisect = true;
                        break;
                    }
                    if status.is_server_error() && attempt + 1 < UPSTREAM_RETRY_DELAYS_SECS.len() {
                        tokio::time::sleep(Duration::from_secs(base_secs)).await;
                        continue;
                    }
                    break;
                }
                Err(_) => {
                    if attempt + 1 < UPSTREAM_RETRY_DELAYS_SECS.len() {
                        tokio::time::sleep(Duration::from_secs(base_secs)).await;
                    } else if cur.len() > 20 {
                        should_bisect = true;
                    }
                }
            }
        }

        if !succeeded && should_bisect && cur.len() > 20 {
            if cur.len() > 50 {
                // 100 -> 50 + 50
                let mid = cur.len() / 2;
                let (left, right) = cur.split_at(mid);
                pending.push(right);
                pending.push(left);
            } else {
                // 50 -> 20-sized slices
                for sub in cur.chunks(20).rev() {
                    pending.push(sub);
                }
            }
        }
    }

    Ok(collected)
}

// ─── Step B: Patient Resumable Concurrent LLM Keyword Baker ───

#[derive(Clone)]
struct LlmPaperTarget {
    id: String,
    title: String,
    abstract_text: String,
    categories: Vec<String>,
    source_label: String,
}

fn build_chat_completions_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn build_bake_llm_messages(chunk: &[LlmPaperTarget]) -> Value {
    let mut user_lines = Vec::with_capacity(chunk.len() + 2);
    user_lines.push(
        "Extract 3 to 6 concise, domain-specific academic keywords for each paper below. \
         Return strict JSON: {\"items\":[{\"id\":\"1\",\"keywords\":[\"Keyword A\",\"Keyword B\"]}]}. \
         Avoid generic words like 'paper', 'method', 'system', or 'study'."
            .to_string(),
    );
    for (idx, p) in chunk.iter().enumerate() {
        let abs_trunc: String = p.abstract_text.trim().chars().take(1600).collect();
        user_lines.push(format!(
            "[{}] Title: {}\nAbstract: {}",
            idx + 1,
            p.title.trim(),
            abs_trunc
        ));
    }

    serde_json::json!([
        {
            "role": "system",
            "content": "You are a precise computer science bibliography curator. Output valid JSON only."
        },
        {
            "role": "user",
            "content": user_lines.join("\n\n")
        }
    ])
}

fn parse_llm_keyword_batch_json(content: &str, expected_len: usize) -> HashMap<usize, Vec<String>> {
    let trimmed = content.trim();
    let json_slice = extract_json_payload(trimmed);
    let Ok(val) = serde_json::from_str::<Value>(json_slice) else {
        return HashMap::new();
    };

    let arr_opt = val
        .get("items")
        .or_else(|| val.get("results"))
        .or_else(|| val.get("papers"))
        .and_then(Value::as_array)
        .or_else(|| val.as_array());

    let mut out = HashMap::new();
    if let Some(arr) = arr_opt {
        for (pos, entry) in arr.iter().enumerate() {
            let idx_1based = entry
                .get("id")
                .or_else(|| entry.get("index"))
                .and_then(|v| {
                    v.as_u64()
                        .map(|n| n as usize)
                        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<usize>().ok()))
                })
                .unwrap_or(pos + 1);
            if idx_1based == 0 || idx_1based > expected_len {
                continue;
            }
            if let Some(kws_arr) = entry.get("keywords").and_then(Value::as_array) {
                let raw_kws: Vec<String> = kws_arr
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect();
                let canon = canonicalize_keywords(&raw_kws);
                if !canon.is_empty() {
                    out.insert(idx_1based - 1, canon);
                }
            }
        }
    } else if expected_len == 1 {
        if let Some(kws_arr) = val.get("keywords").and_then(Value::as_array) {
            let raw_kws: Vec<String> = kws_arr
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            let canon = canonicalize_keywords(&raw_kws);
            if !canon.is_empty() {
                out.insert(0, canon);
            }
        }
    }

    out
}

fn extract_json_payload(raw: &str) -> &str {
    if let Some(fence_start) = raw.find("```") {
        let after_ticks = &raw[fence_start + 3..];
        let body_start = after_ticks.find('\n').map(|i| i + 1).unwrap_or(0);
        let body = &after_ticks[body_start..];
        if let Some(fence_end) = body.find("```") {
            return body[..fence_end].trim();
        }
    }
    if let (Some(s), Some(e)) = (raw.find('{'), raw.rfind('}')) {
        if s < e {
            return &raw[s..=e];
        }
    }
    if let (Some(s), Some(e)) = (raw.find('['), raw.rfind(']')) {
        if s < e {
            return &raw[s..=e];
        }
    }
    raw
}

async fn request_llm_keywords_with_patient_backoff(
    client: &reqwest::Client,
    endpoint: &str,
    model: &str,
    api_key: Option<&str>,
    chunk: &[LlmPaperTarget],
) -> Result<HashMap<usize, Vec<String>>, AppError> {
    let payload = serde_json::json!({
        "model": model,
        "temperature": 0.1,
        "messages": build_bake_llm_messages(chunk),
    });

    let mut last_err = String::new();
    for (attempt, &base_secs) in LLM_RETRY_DELAYS_SECS.iter().enumerate() {
        let mut req = client.post(endpoint).json(&payload);
        if let Some(key) = api_key.map(str::trim).filter(|s| !s.is_empty()) {
            req = req.bearer_auth(key);
        }

        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    let body_val: Value = match resp.json().await {
                        Ok(v) => v,
                        Err(e) => {
                            last_err = format!("invalid JSON body: {e}");
                            tokio::time::sleep(Duration::from_secs(base_secs)).await;
                            continue;
                        }
                    };
                    let content = body_val
                        .pointer("/choices/0/message/content")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    if content.is_empty() {
                        last_err = "empty assistant content".to_string();
                        tokio::time::sleep(Duration::from_secs(base_secs)).await;
                        continue;
                    }
                    let parsed = parse_llm_keyword_batch_json(content, chunk.len());
                    if !parsed.is_empty() {
                        return Ok(parsed);
                    }
                    last_err = "unparseable keyword JSON".to_string();
                    tokio::time::sleep(Duration::from_secs(base_secs)).await;
                } else if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                    let wait = parse_retry_after_secs(resp.headers())
                        .unwrap_or(base_secs)
                        .max(base_secs);
                    last_err = format!("HTTP {status}");
                    log::warn!(
                        "seed_bake LLM {} (attempt {}/{}), backing off {}s",
                        status,
                        attempt + 1,
                        LLM_RETRY_DELAYS_SECS.len(),
                        wait
                    );
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                } else {
                    let err_text = resp.text().await.unwrap_or_default();
                    return Err(AppError::message(format!(
                        "seed_bake LLM non-retryable HTTP {status}: {err_text}"
                    )));
                }
            }
            Err(e) => {
                last_err = e.to_string();
                log::warn!(
                    "seed_bake LLM transport error (attempt {}/{}): {e}; backing off {}s",
                    attempt + 1,
                    LLM_RETRY_DELAYS_SECS.len(),
                    base_secs
                );
                tokio::time::sleep(Duration::from_secs(base_secs)).await;
            }
        }
    }

    Err(AppError::message(format!(
        "seed_bake LLM exhausted {} retries: {last_err}",
        LLM_RETRY_DELAYS_SECS.len()
    )))
}

async fn extract_batch_with_single_fallback(
    client: &reqwest::Client,
    endpoint: &str,
    model: &str,
    api_key: Option<&str>,
    chunk: Vec<LlmPaperTarget>,
) -> Result<Vec<(LlmPaperTarget, Vec<String>)>, AppError> {
    let batch_map =
        request_llm_keywords_with_patient_backoff(client, endpoint, model, api_key, &chunk).await?;
    let mut out = Vec::with_capacity(chunk.len());
    for (idx, paper) in chunk.into_iter().enumerate() {
        if let Some(kws) = batch_map.get(&idx).filter(|k| !k.is_empty()) {
            out.push((paper, kws.clone()));
        } else {
            // Single-paper patient retry so partial batch omissions are never silently dropped!
            let single_slice = std::slice::from_ref(&paper);
            let single_map = request_llm_keywords_with_patient_backoff(
                client,
                endpoint,
                model,
                api_key,
                single_slice,
            )
            .await?;
            let kws = single_map.get(&0).cloned().unwrap_or_default();
            if !kws.is_empty() {
                out.push((paper, kws));
            }
        }
    }
    Ok(out)
}

fn persist_maintainer_llm_batch(
    db_path: &Path,
    batch: &[(LlmPaperTarget, Vec<String>)],
) -> Result<usize, AppError> {
    if batch.is_empty() {
        return Ok(0);
    }
    let mut conn = ensure_collection_at(db_path)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = now_rfc3339();
    let mut updated = 0usize;

    for (paper, kws) in batch {
        let canon = canonicalize_keywords(kws);
        if canon.is_empty() {
            continue;
        }
        // Double-check row has not gained `author` keywords concurrently.
        let cur_src: Option<String> = tx
            .query_row(
                "SELECT keyword_source FROM papers WHERE id = ?1",
                [paper.id.as_str()],
                |r| r.get(0),
            )
            .ok();
        if cur_src
            .as_deref()
            .is_some_and(|s| s.eq_ignore_ascii_case("author"))
        {
            continue;
        }

        let kws_json = serde_json::to_string(&canon)?;
        let kw_text = build_keywords_text(&canon, &paper.categories, &paper.source_label);
        tx.execute(
            "UPDATE papers SET keywords_json = ?1, keyword_source = 'maintainer_llm', \
                               keywords_text = ?2, updated_at = ?3 \
             WHERE id = ?4",
            params![kws_json, kw_text, now, paper.id],
        )?;
        tx.execute(
            "DELETE FROM paper_keywords WHERE paper_id = ?1",
            [paper.id.as_str()],
        )?;
        for display in &canon {
            let norm = normalize_keyword_key(display);
            if !norm.is_empty() {
                tx.execute(
                    "INSERT OR IGNORE INTO paper_keywords (paper_id, normalized, display) \
                     VALUES (?1, ?2, ?3)",
                    params![paper.id, norm, display],
                )?;
            }
        }
        updated += 1;
    }

    tx.commit()?;
    Ok(updated)
}

async fn run_step_b_llm_bake(db_path: &Path, opts: &SeedBakeOptions) -> Result<usize, AppError> {
    let db_load = db_path.to_path_buf();
    let targets: Vec<LlmPaperTarget> =
        tokio::task::spawn_blocking(move || -> Result<_, AppError> {
            let conn = ensure_collection_at(&db_load)?;
            let mut stmt = conn.prepare(
                "SELECT id, title, abstract_text, categories_json, source_label
             FROM papers
             WHERE (keywords_json = '[]' OR keyword_source NOT IN ('author', 'maintainer_llm'))
               AND TRIM(title) != ''
             ORDER BY row_id ASC",
            )?;
            let rows = stmt.query_map([], |r| {
                let cats_json: String = r.get(3)?;
                Ok(LlmPaperTarget {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    abstract_text: r.get(2)?,
                    categories: serde_json::from_str(&cats_json).unwrap_or_default(),
                    source_label: r.get(4)?,
                })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .map_err(|e| AppError::message(format!("seed_bake load llm targets: {e}")))??;

    if targets.is_empty() {
        return Ok(0);
    }

    let endpoint = build_chat_completions_url(&opts.llm_base_url);
    let model = opts.llm_model.trim().to_string();
    let api_key = opts.llm_api_key.clone();
    let concurrency = opts.llm_concurrency.clamp(1, 32);
    let client = crate::http::client_with(Duration::from_secs(90), 5, crate::http::USER_AGENT)?;

    let chunks: Vec<Vec<LlmPaperTarget>> = targets.chunks(8).map(|c| c.to_vec()).collect();
    let mut futs = stream::iter(chunks.into_iter().map(|chunk| {
        let client_c = client.clone();
        let endpoint_c = endpoint.clone();
        let model_c = model.clone();
        let api_key_c = api_key.clone();
        async move {
            extract_batch_with_single_fallback(
                &client_c,
                &endpoint_c,
                &model_c,
                api_key_c.as_deref(),
                chunk,
            )
            .await
        }
    }))
    .buffer_unordered(concurrency);

    let mut total_updated = 0usize;
    while let Some(res) = futs.next().await {
        let extracted = res?;
        let db_p = db_path.to_path_buf();
        total_updated +=
            tokio::task::spawn_blocking(move || persist_maintainer_llm_batch(&db_p, &extracted))
                .await
                .map_err(|e| AppError::message(format!("persist llm batch: {e}")))??;
    }

    Ok(total_updated)
}

// ─── Step C: Streaming Gzip Shard Export & Manifest Generation ───

fn is_pure_cs_ai_arxiv(source_type: &str, source_label: &str, categories: &[String]) -> bool {
    if source_type != "arxiv" {
        return false;
    }
    let mut has_cs_ai = source_label.eq_ignore_ascii_case("cs.AI");
    let mut has_other_core = !source_label.trim().is_empty() && !has_cs_ai;
    for cat in categories {
        let c = cat.trim();
        if c.is_empty() {
            continue;
        }
        if c.eq_ignore_ascii_case("cs.AI") {
            has_cs_ai = true;
        } else {
            has_other_core = true;
        }
    }
    has_cs_ai && !has_other_core
}

struct GzShardWriter {
    tmp_path: PathBuf,
    encoder: GzEncoder<BufWriter<File>>,
    count: usize,
}

impl GzShardWriter {
    fn create(out_dir: &Path, tag: &str) -> Result<Self, AppError> {
        let tmp_path = out_dir.join(format!(".tmp-{tag}.jsonl.gz"));
        let file = File::create(&tmp_path)?;
        let encoder = GzEncoder::new(
            BufWriter::with_capacity(128 * 1024, file),
            Compression::default(),
        );
        Ok(Self {
            tmp_path,
            encoder,
            count: 0,
        })
    }

    fn write_record(&mut self, rec: &SeedPaperRecord) -> Result<(), AppError> {
        serde_json::to_writer(&mut self.encoder, rec)?;
        self.encoder.write_all(b"\n")?;
        self.count += 1;
        Ok(())
    }

    fn finish(
        self,
        out_dir: &Path,
        kind: &str,
        prefix: &str,
        categories: Vec<String>,
    ) -> Result<Option<SeedShardEntry>, AppError> {
        let mut bw = self.encoder.finish()?;
        bw.flush()?;
        drop(bw);

        if self.count == 0 {
            let _ = fs::remove_file(&self.tmp_path);
            return Ok(None);
        }

        let sha256 = verify_file_sha256(&self.tmp_path, "")?;
        let hash8 = &sha256[..8];
        let id = format!("{prefix}-{hash8}");
        let filename = format!("{id}.jsonl.gz");
        let final_path = out_dir.join(&filename);
        if final_path.exists() {
            let _ = fs::remove_file(&final_path);
        }
        fs::rename(&self.tmp_path, &final_path)?;

        Ok(Some(SeedShardEntry {
            id,
            kind: kind.to_string(),
            filename,
            sha256,
            paper_count: self.count,
            categories,
        }))
    }
}

fn export_seed_shards_sync(
    db_path: &Path,
    out_dir: &Path,
    delta_since: Option<&str>,
) -> Result<(PathBuf, Vec<SeedShardEntry>), AppError> {
    fs::create_dir_all(out_dir)?;
    let conn = ensure_collection_at(db_path)?;

    // Preload `work_id -> Vec<ref_key>` once in memory (~1M short strings -> ~35 MB, O(1) lookup).
    let mut refs_by_work: HashMap<i64, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT src_work_id, ref_key FROM paper_raw_refs ORDER BY src_work_id ASC, ref_key ASC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for entry in rows {
            let (wid, rk) = entry?;
            refs_by_work.entry(wid).or_default().push(rk);
        }
    }

    let mut core_writer = GzShardWriter::create(out_dir, "core")?;
    let mut cs_ai_writer = GzShardWriter::create(out_dir, "addon-cs-ai")?;
    let delta_cutoff = delta_since.map(str::trim).filter(|s| !s.is_empty());
    let mut delta_writer = if delta_cutoff.is_some() {
        Some(GzShardWriter::create(out_dir, "delta")?)
    } else {
        None
    };

    let mut core_cats_seen: HashSet<String> = HashSet::new();
    let mut delta_cats_seen: HashSet<String> = HashSet::new();

    {
        let mut stmt = conn.prepare(
            "SELECT id, title, authors_json, abstract_text, published_at, year, source_type,
                    source_label, categories_json, url, pdf_url, arxiv_id, doi, venue_id,
                    venue_kind, venue_domain, ccf_rank, venue_full, keywords_json, keyword_source,
                    openalex_id, work_id, volume, issue, pages, bibtex, cool_papers_id
             FROM papers
             ORDER BY published_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            let authors_json: String = r.get(2)?;
            let cats_json: String = r.get(8)?;
            let kws_json: String = r.get(18)?;
            let kw_src_raw: String = r.get(19)?;
            let wid: i64 = r.get(21)?;
            let categories: Vec<String> = serde_json::from_str(&cats_json).unwrap_or_default();
            let rec = SeedPaperRecord {
                id: r.get(0)?,
                title: r.get(1)?,
                authors: serde_json::from_str(&authors_json).unwrap_or_default(),
                abstract_text: r.get(3)?,
                published_at: r.get(4)?,
                year: r.get(5)?,
                source_type: r.get(6)?,
                source_label: r.get(7)?,
                categories,
                url: r.get(9)?,
                pdf_url: r.get(10)?,
                arxiv_id: r.get(11)?,
                doi: r.get(12)?,
                venue_id: r.get(13)?,
                venue_kind: r.get(14)?,
                venue_domain: r.get(15)?,
                ccf_rank: r.get(16)?,
                venue_full: r.get(17)?,
                keywords: serde_json::from_str(&kws_json).unwrap_or_default(),
                keyword_source: (!kw_src_raw.trim().is_empty())
                    .then(|| kw_src_raw.trim().to_string()),
                openalex_id: r.get(20)?,
                raw_refs: refs_by_work.get(&wid).cloned().unwrap_or_default(),
                volume: r.get(22)?,
                issue: r.get(23)?,
                pages: r.get(24)?,
                bibtex: r.get(25)?,
                cool_papers_id: r.get(26)?,
            };
            Ok(rec)
        })?;

        for entry in rows {
            let rec = entry?;
            if is_pure_cs_ai_arxiv(&rec.source_type, &rec.source_label, &rec.categories) {
                cs_ai_writer.write_record(&rec)?;
            } else {
                if rec.source_type == "arxiv" {
                    if !rec.source_label.trim().is_empty() {
                        core_cats_seen.insert(rec.source_label.trim().to_string());
                    }
                    for c in &rec.categories {
                        if !c.eq_ignore_ascii_case("cs.AI") && !c.trim().is_empty() {
                            core_cats_seen.insert(c.trim().to_string());
                        }
                    }
                }
                core_writer.write_record(&rec)?;
            }

            if let (Some(cutoff), Some(ref mut dw)) = (delta_cutoff, delta_writer.as_mut()) {
                if rec.published_at.as_str() >= cutoff {
                    if rec.source_type == "arxiv" && !rec.source_label.trim().is_empty() {
                        delta_cats_seen.insert(rec.source_label.trim().to_string());
                    }
                    dw.write_record(&rec)?;
                }
            }
        }
    }

    let mut core_cats: Vec<String> = if core_cats_seen.is_empty() {
        vec![
            "cs.SE".to_string(),
            "cs.CR".to_string(),
            "cs.PL".to_string(),
        ]
    } else {
        let mut v: Vec<String> = core_cats_seen.into_iter().collect();
        v.sort();
        v
    };
    core_cats.retain(|c| !c.eq_ignore_ascii_case("cs.AI"));

    let mut shards = Vec::new();
    if let Some(core_entry) = core_writer.finish(out_dir, "core", "core-2026", core_cats)? {
        shards.push(core_entry);
    }
    if let Some(ai_entry) = cs_ai_writer.finish(
        out_dir,
        "addon-cs-ai",
        "addon-cs-ai-2026",
        vec!["cs.AI".to_string()],
    )? {
        shards.push(ai_entry);
    }
    if let Some(dw) = delta_writer {
        let date_tag = chrono::Utc::now().format("%Y%m%d").to_string();
        let mut dcats: Vec<String> = delta_cats_seen.into_iter().collect();
        dcats.sort();
        if let Some(delta_entry) =
            dw.finish(out_dir, "delta", &format!("delta-2026-{date_tag}"), dcats)?
        {
            shards.push(delta_entry);
        }
    }

    // Collect arXiv & Venue watermarks for `manifest.json`.
    let mut arxiv_watermarks: HashMap<String, SeedArxivWatermark> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT category, latest_published_at, latest_arxiv_id, last_synced_at,
                    oldest_synced_published_at, remote_total, history_complete
             FROM arxiv_watermarks",
        )?;
        let rows = stmt.query_map([], |r| {
            let cat: String = r.get(0)?;
            let rtot: Option<i64> = r.get(5)?;
            let hc: i64 = r.get(6)?;
            Ok((
                cat,
                SeedArxivWatermark {
                    latest_published_at: r.get(1)?,
                    latest_arxiv_id: r.get(2)?,
                    last_synced_at: r.get(3)?,
                    oldest_synced_published_at: r.get(4)?,
                    remote_total: rtot.map(|n| n.max(0) as usize),
                    history_complete: hc != 0,
                },
            ))
        })?;
        for entry in rows {
            let (c, wm) = entry?;
            arxiv_watermarks.insert(c, wm);
        }
    }

    let mut venue_watermarks: HashMap<String, SeedVenueWatermark> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT v.id, v.last_fetched_at, v.latest_published_at, v.remote_total_count,
                    (SELECT COUNT(*) FROM papers p WHERE p.source_type = 'venue' AND p.venue_id = v.id)
             FROM venues v",
        )?;
        let rows = stmt.query_map([], |r| {
            let vid: String = r.get(0)?;
            let lf: Option<String> = r.get(1)?;
            let lp: Option<String> = r.get(2)?;
            let rt: Option<i64> = r.get(3)?;
            let pcnt: i64 = r.get(4)?;
            Ok((vid, lf, lp, rt, pcnt))
        })?;
        for entry in rows {
            let (vid, lf, lp, rt, pcnt) = entry?;
            if lf.is_some() || rt.is_some() || pcnt > 0 {
                venue_watermarks.insert(
                    vid,
                    SeedVenueWatermark {
                        last_fetched_at: lf,
                        latest_published_at: lp,
                        remote_total_count: rt
                            .map(|n| n.max(0) as usize)
                            .or_else(|| (pcnt > 0).then_some(pcnt as usize)),
                    },
                );
            }
        }
    }

    let manifest = SeedManifest {
        version: 2,
        generated_at: now_rfc3339(),
        shards: shards.clone(),
        arxiv_watermarks,
        venue_watermarks,
    };

    let manifest_path = out_dir.join("manifest.json");
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    fs::write(&manifest_path, manifest_bytes)?;

    Ok((manifest_path, shards))
}

pub async fn seed_bake_at(
    db_path: &Path,
    opts: SeedBakeOptions,
) -> Result<SeedBakeReport, AppError> {
    let (oa_enriched, s2_enriched) = if opts.skip_refs {
        (0, 0)
    } else {
        run_step_a_refs_backfill(db_path).await?
    };

    let llm_enriched = if opts.skip_llm {
        0
    } else {
        run_step_b_llm_bake(db_path, &opts).await?
    };

    let db_exp = db_path.to_path_buf();
    let out_dir = opts.out_dir.clone();
    let delta_since = opts.delta_since.clone();
    let (manifest_path, shards) = tokio::task::spawn_blocking(move || {
        export_seed_shards_sync(&db_exp, &out_dir, delta_since.as_deref())
    })
    .await
    .map_err(|e| AppError::message(format!("seed_bake export join: {e}")))??;

    Ok(SeedBakeReport {
        out_dir: opts.out_dir.display().to_string(),
        manifest_path: manifest_path.display().to_string(),
        openalex_enriched_works: oa_enriched,
        s2_enriched_works: s2_enriched,
        llm_enriched_papers: llm_enriched,
        shards,
    })
}
