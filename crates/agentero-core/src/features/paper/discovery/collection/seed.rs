//! GitHub Releases static seed sync (`seed_sync`) and maintainer seed baker (`seed_bake`)
//! for Plaza `Paper Collection`.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use futures_util::stream::{self, StreamExt};
use reqwest::StatusCode;
use rusqlite::{params, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::openai_compat::{
    acquire_rate_slot, extract_chat_message_content, resolve_openai_compatible_url,
    send_chat_with_reasoning_fallback, ChatFallbackRequest,
};

use super::keywords::{canonicalize_keywords, normalize_keyword_key, SYNONYM_GROUPS};
use super::models::{
    CollectionArxivWatermarkInput, CollectionBackfillRefsArgs, CollectionBackfillRefsOut,
    CollectionPaperUpsertInput, CollectionSeedProgress, CollectionSeedSyncArgs,
    CollectionSeedSyncOut, CollectionSeedSyncPhase, CollectionVenueWatermarkUpdate,
};
use super::schema::{
    collection_db_path, ensure_collection_at, normalize_write_lock_key, with_collection_write_conn,
};
use super::store::{
    apply_venue_watermark_update_tx, build_keywords_text, clean_arxiv_key, clean_doi_key,
    clean_openalex_id, clean_opt_str, clean_publisher_doi, clean_string_vec,
    insert_work_raw_refs_tx, is_artifact_or_dataset_doi, is_publisher_doi, load_enabled_categories,
    newer_refs_checked_at, norm_title_key, normalize_ref_key, normalize_refs_checked_at,
    now_rfc3339, read_state_summary_conn, recompute_graph_and_citations_tx,
    same_work_by_title_and_authors, upsert_arxiv_watermarks_tx,
    upsert_single_paper_with_options_tx,
};

pub const DEFAULT_SEED_MANIFEST_URL: &str =
    "https://github.com/nonsense-j/Dovero/releases/download/collection-seed-2026/manifest.json";

pub const DEFAULT_BAKE_LLM_BASE_URL: &str = "https://x666.me/v1";
pub const DEFAULT_BAKE_LLM_MODEL: &str = "ernie-5.5-flash-preview";
pub const DEFAULT_BAKE_LLM_BATCH_SIZE: usize = 8;
pub const DEFAULT_BAKE_LLM_CONCURRENCY: usize = 1;
pub const DEFAULT_BAKE_LLM_RPM: u32 = 5;

const OPENALEX_MAILTO: &str = "agentero@users.noreply.github.com";
const OPENALEX_SELECT: &str =
    "id,type,title,publication_year,doi,ids,authorships,abstract_inverted_index,referenced_works";
const MAX_OA_SOURCE_PAGES: usize = 30;
const MAX_OA_TITLE_SEARCH_CALLS: usize = 850;
const MAX_OA_TITLE_SEARCH_BATCH_SIZE: usize = 75;
const MAX_OA_TITLE_SEARCH_URL_BYTES: usize = 7800;
/// Re-check missing OpenAlex `referenced_works` every 7 days for arXiv-only papers.
pub const ARXIV_OA_REFS_CHECK_TTL_DAYS: i64 = 7;
/// Skip OpenAlex `referenced_works` re-checks for arXiv-only papers published over 60 days ago.
pub const ARXIV_OA_REFS_MAX_AGE_DAYS: i64 = 60;
/// Re-check missing OpenAlex `referenced_works` every 14 days for Venue papers (no age cutoff).
pub const VENUE_OA_REFS_CHECK_TTL_DAYS: i64 = 14;
/// OpenAlex 2026 RPS limits: 30 req/s with free API key (~22 req/s paced), 10 req/s keyless (~8.3 req/s paced).
const OA_SINGLETON_SLOT_KEYED_MS: u64 = 45;
const OA_SINGLETON_SLOT_KEYLESS_MS: u64 = 120;
const OA_SINGLETON_CONCURRENCY_KEYED: usize = 16;
const OA_SINGLETON_CONCURRENCY_KEYLESS: usize = 8;
const LLM_RETRY_DELAYS_SECS: [u64; 8] = [3, 6, 12, 25, 45, 45, 45, 45];
const UPSTREAM_RETRY_DELAYS_SECS: [u64; 6] = [2, 5, 10, 20, 35, 45];

/// Verified OpenAlex Source IDs for `DEFAULT_VENUES` (aligned with `collection-enrichment.ts`
/// plus LIPIcs `S4393917817` for ECOOP/ESEM). Shared source IDs (e.g. PACMSE/PACMPL/LIPIcs)
/// are deduplicated during Pass A1.5 so each source is paged at most once.
const VENUE_OPENALEX_SOURCE_IDS: &[(&str, &[&str])] = &[
    ("aaai-2026", &["S4210191458"]),
    ("ndss-2026", &["S4306420590"]),
    ("acl-2026", &["S4393915740"]),
    ("ccs-2026", &["S4393917527"]),
    ("sp-2026", &["S4210233669"]),
    ("icse-2026", &["S4210203175"]),
    ("ase-2026", &["S4363608212"]),
    ("fse-2026", &["S4404663975"]),
    ("issta-2026", &["S4404663975"]),
    ("pldi-2026", &["S4210216081"]),
    ("popl-2026", &["S4210216081"]),
    ("oopsla-2026", &["S4210216081"]),
    ("re-2026", &["S7407086818"]),
    ("saner-2026", &["S4363608226"]),
    ("icpc-2026", &["S7407088527", "S4306419777"]),
    ("icsme-2026", &["S4210174939"]),
    ("issre-2026", &["S4210220341"]),
    ("sas-2026", &["S4306420942"]),
    ("ecoop-2026", &["S4393917817"]),
    ("esem-2026", &["S4210197744", "S4393917817"]),
    ("tse-2026", &["S8351582"]),
    ("tosem-2026", &["S142627899"]),
    ("ese-2026", &["S109852484"]),
    ("ase-journal-2026", &["S4210177399"]),
    ("usenix-sec-2026", &["S4306421123"]),
    ("neurips-2026", &["S4363606243"]),
    ("iclr-2026", &["S4306419637"]),
    ("icml-2026", &["S4306419644"]),
];

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
    pub refs_checked_at: Option<String>,
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

pub type SeedProgressCallback = Arc<dyn Fn(CollectionSeedProgress) + Send + Sync>;

pub const SEED_SYNC_CANCELLED_CODE: &str = "seed_sync_cancelled";
const SEED_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(120);
const SEED_IMPORT_CANCEL_CHECK_STRIDE: usize = 200;
const MAX_SHARD_DOWNLOAD_RETRIES: usize = 2;
const SHARD_RETRY_BACKOFF_SECS: [u64; 2] = [1, 3];
const SHARD_WRITE_BUF_BYTES: usize = 256 * 1024;

fn seed_sync_cancelled_err() -> AppError {
    AppError::domain(SEED_SYNC_CANCELLED_CODE, "Collection seed sync cancelled")
}

fn is_seed_sync_cancelled(err: &AppError) -> bool {
    err.code() == SEED_SYNC_CANCELLED_CODE
}

#[derive(Clone)]
struct SeedSyncWatchErr {
    domain_code: Option<&'static str>,
    message: String,
}

impl SeedSyncWatchErr {
    fn from_app_error(err: &AppError) -> Self {
        let domain_code = match err {
            AppError::Domain { code, .. } => Some(*code),
            _ => None,
        };
        Self {
            domain_code,
            message: err.to_string(),
        }
    }

    fn into_app_error(self) -> AppError {
        match self.domain_code {
            Some(code) => AppError::domain(code, self.message),
            None => AppError::message(self.message),
        }
    }
}

type SeedSyncOutcome = Result<CollectionSeedSyncOut, SeedSyncWatchErr>;

struct ActiveSeedSync {
    cancel: CancellationToken,
    done_tx: tokio::sync::watch::Sender<Option<SeedSyncOutcome>>,
    done_rx: tokio::sync::watch::Receiver<Option<SeedSyncOutcome>>,
}

fn active_seed_syncs() -> &'static StdMutex<HashMap<PathBuf, Arc<ActiveSeedSync>>> {
    static ACTIVE: OnceLock<StdMutex<HashMap<PathBuf, Arc<ActiveSeedSync>>>> = OnceLock::new();
    ACTIVE.get_or_init(|| StdMutex::new(HashMap::new()))
}

struct ActiveSeedSyncGuard {
    key: PathBuf,
    entry: Arc<ActiveSeedSync>,
    published: bool,
}

impl ActiveSeedSyncGuard {
    fn finish(mut self, outcome: SeedSyncOutcome) {
        {
            let mut map = active_seed_syncs()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if map
                .get(&self.key)
                .is_some_and(|cur| Arc::ptr_eq(cur, &self.entry))
            {
                map.remove(&self.key);
            }
        }
        let _ = self.entry.done_tx.send(Some(outcome));
        self.published = true;
    }
}

impl Drop for ActiveSeedSyncGuard {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        {
            let mut map = active_seed_syncs()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if map
                .get(&self.key)
                .is_some_and(|cur| Arc::ptr_eq(cur, &self.entry))
            {
                map.remove(&self.key);
            }
        }
        let _ = self.entry.done_tx.send(Some(Err(SeedSyncWatchErr {
            domain_code: Some(SEED_SYNC_CANCELLED_CODE),
            message: "Collection seed sync interrupted".to_string(),
        })));
    }
}

/// Signal cancellation of any active Collection seed sync running against the default DB.
/// Returns `true` if an active sync was found and signalled.
pub fn cancel_seed_sync() -> bool {
    cancel_seed_sync_at(&collection_db_path())
}

/// Signal cancellation of any active Collection seed sync running against `db_path`.
/// Returns `true` if an active sync was found and signalled.
pub fn cancel_seed_sync_at(db_path: &Path) -> bool {
    let key = normalize_write_lock_key(db_path);
    let entry = active_seed_syncs()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
        .cloned();
    if let Some(active) = entry {
        active.cancel.cancel();
        true
    } else {
        false
    }
}

struct ProgressEmitter {
    cb: Option<SeedProgressCallback>,
    last_emit: Option<Instant>,
}

impl ProgressEmitter {
    fn new(cb: Option<SeedProgressCallback>) -> Self {
        Self {
            cb,
            last_emit: None,
        }
    }

    fn emit_immediate(&mut self, progress: CollectionSeedProgress) {
        if let Some(ref cb) = self.cb {
            cb(progress);
            self.last_emit = Some(Instant::now());
        }
    }

    fn emit_throttled(&mut self, progress: CollectionSeedProgress) {
        let should_emit = self
            .last_emit
            .is_none_or(|t| t.elapsed() >= SEED_PROGRESS_EMIT_INTERVAL);
        if should_emit {
            self.emit_immediate(progress);
        }
    }
}

fn progress_phase(phase: CollectionSeedSyncPhase) -> CollectionSeedProgress {
    CollectionSeedProgress {
        phase,
        shard_index: 0,
        shard_count: 0,
        downloaded_bytes: 0,
        total_bytes: None,
        bytes_per_sec: None,
        imported_papers: 0,
        total_papers: 0,
        error: None,
    }
}

enum ManifestLocation {
    Http(url::Url),
    Local(PathBuf),
}

struct PreparedShard {
    shard: SeedShardEntry,
    path: PathBuf,
    delete_after_commit: bool,
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
    crate::http::client_builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .user_agent(crate::http::USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| AppError::message(format!("http client: {e}")))
}

fn seed_cache_dir_for(db_path: &Path) -> PathBuf {
    if normalize_write_lock_key(db_path) == normalize_write_lock_key(&collection_db_path()) {
        crate::paths::collection_seed_cache_dir()
    } else {
        db_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
            .join(".seed-cache")
    }
}

fn parse_content_range_total(header_val: &str) -> Option<u64> {
    let (_, total_part) = header_val.rsplit_once('/')?;
    let trimmed = total_part.trim();
    if trimmed == "*" || trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<u64>().ok()
}

fn sanitize_shard_filename(raw: &str) -> Result<&str, AppError> {
    Path::new(raw)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| {
            !n.is_empty() && !n.contains('/') && !n.contains('\\') && *n != "." && *n != ".."
        })
        .ok_or_else(|| AppError::message(format!("invalid seed shard filename: {raw}")))
}

fn is_transient_http_status(status: StatusCode) -> bool {
    status.is_server_error()
        || status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
}

async fn sleep_cancellable(dur: Duration, cancel: &CancellationToken) -> Result<(), AppError> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(seed_sync_cancelled_err()),
        _ = tokio::time::sleep(dur) => Ok(()),
    }
}

async fn fetch_manifest(
    client: &reqwest::Client,
    loc: &ManifestLocation,
    force: bool,
    cancel: &CancellationToken,
) -> Result<Option<SeedManifest>, AppError> {
    if cancel.is_cancelled() {
        return Err(seed_sync_cancelled_err());
    }
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
            let resp = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(seed_sync_cancelled_err()),
                res = client.get(url.clone()).timeout(Duration::from_secs(15)).send() => {
                    res.map_err(|e| AppError::message(format!("fetch seed manifest {url}: {e}")))?
                }
            };
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
            let bytes = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(seed_sync_cancelled_err()),
                res = resp.bytes() => {
                    res.map_err(|e| AppError::message(format!("read seed manifest body: {e}")))?
                }
            };
            let manifest: SeedManifest = serde_json::from_slice(&bytes)
                .map_err(|e| AppError::message(format!("parse seed manifest JSON: {e}")))?;
            Ok(Some(manifest))
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn download_or_locate_shard(
    client: &reqwest::Client,
    loc: &ManifestLocation,
    shard: &SeedShardEntry,
    cache_dir: &Path,
    shard_index: usize,
    shard_count: usize,
    total_papers: usize,
    cancel: &CancellationToken,
    progress: &mut ProgressEmitter,
) -> Result<PreparedShard, AppError> {
    if cancel.is_cancelled() {
        return Err(seed_sync_cancelled_err());
    }
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
            let file_len = tokio::fs::metadata(&shard_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0);
            progress.emit_immediate(CollectionSeedProgress {
                shard_index,
                shard_count,
                downloaded_bytes: file_len,
                total_bytes: Some(file_len),
                total_papers,
                ..progress_phase(CollectionSeedSyncPhase::Downloading)
            });
            let verify_path = shard_path.clone();
            let expected = shard.sha256.clone();
            tokio::task::spawn_blocking(move || verify_file_sha256(&verify_path, &expected))
                .await
                .map_err(|e| AppError::message(format!("verify seed shard join: {e}")))??;
            Ok(PreparedShard {
                shard: shard.clone(),
                path: shard_path,
                delete_after_commit: false,
            })
        }
        ManifestLocation::Http(manifest_url) => {
            let shard_url = manifest_url.join(&shard.filename).map_err(|e| {
                AppError::message(format!("resolve shard url {}: {e}", shard.filename))
            })?;
            let safe_name = sanitize_shard_filename(&shard.filename)?;
            tokio::fs::create_dir_all(cache_dir).await?;
            let part_path = cache_dir.join(format!("{safe_name}.part"));

            // Reuse a previously verified `.part` file (e.g. cancelled during import) without re-downloading.
            let expected_sha = shard.sha256.trim().to_ascii_lowercase();
            if !expected_sha.is_empty() {
                if let Ok(meta) = tokio::fs::metadata(&part_path).await {
                    let cached_len = meta.len();
                    if cached_len > 0 {
                        let verify_path = part_path.clone();
                        let sha_clone = expected_sha.clone();
                        let verified = tokio::task::spawn_blocking(move || {
                            verify_file_sha256(&verify_path, &sha_clone).is_ok()
                        })
                        .await
                        .unwrap_or(false);
                        if verified {
                            progress.emit_immediate(CollectionSeedProgress {
                                shard_index,
                                shard_count,
                                downloaded_bytes: cached_len,
                                total_bytes: Some(cached_len),
                                total_papers,
                                ..progress_phase(CollectionSeedSyncPhase::Downloading)
                            });
                            return Ok(PreparedShard {
                                shard: shard.clone(),
                                path: part_path,
                                delete_after_commit: true,
                            });
                        }
                    }
                }
            }

            let mut attempt = 0usize;
            let mut reset_416_used = false;
            loop {
                if cancel.is_cancelled() {
                    return Err(seed_sync_cancelled_err());
                }

                let existing_len = tokio::fs::metadata(&part_path)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);

                let mut req = client.get(shard_url.clone());
                if existing_len > 0 {
                    req = req.header(reqwest::header::RANGE, format!("bytes={existing_len}-"));
                }

                let send_res = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(seed_sync_cancelled_err()),
                    res = req.send() => res,
                };

                let mut resp = match send_res {
                    Ok(r) => r,
                    Err(e) => {
                        if attempt < MAX_SHARD_DOWNLOAD_RETRIES {
                            let wait = Duration::from_secs(SHARD_RETRY_BACKOFF_SECS[attempt]);
                            attempt += 1;
                            sleep_cancellable(wait, cancel).await?;
                            continue;
                        }
                        return Err(AppError::message(format!(
                            "download seed shard {shard_url}: {e}"
                        )));
                    }
                };

                let status = resp.status();
                if status == StatusCode::RANGE_NOT_SATISFIABLE
                    && existing_len > 0
                    && !reset_416_used
                {
                    let _ = tokio::fs::remove_file(&part_path).await;
                    reset_416_used = true;
                    continue;
                }
                if !status.is_success() {
                    if is_transient_http_status(status) && attempt < MAX_SHARD_DOWNLOAD_RETRIES {
                        let wait = Duration::from_secs(SHARD_RETRY_BACKOFF_SECS[attempt]);
                        attempt += 1;
                        sleep_cancellable(wait, cancel).await?;
                        continue;
                    }
                    return Err(AppError::message(format!(
                        "seed shard HTTP {status} at {shard_url}"
                    )));
                }

                let resumed = status == StatusCode::PARTIAL_CONTENT && existing_len > 0;
                let (mut downloaded_bytes, total_bytes, file) = if resumed {
                    let total = resp
                        .headers()
                        .get(reqwest::header::CONTENT_RANGE)
                        .and_then(|v| v.to_str().ok())
                        .and_then(parse_content_range_total)
                        .or_else(|| resp.content_length().map(|rem| existing_len + rem));
                    let f = tokio::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&part_path)
                        .await?;
                    (existing_len, total, f)
                } else {
                    let total = resp.content_length();
                    let f = tokio::fs::OpenOptions::new()
                        .create(true)
                        .write(true)
                        .truncate(true)
                        .open(&part_path)
                        .await?;
                    (0u64, total, f)
                };

                let mut writer = tokio::io::BufWriter::with_capacity(SHARD_WRITE_BUF_BYTES, file);
                let started = Instant::now();
                let mut session_bytes = 0u64;

                progress.emit_immediate(CollectionSeedProgress {
                    shard_index,
                    shard_count,
                    downloaded_bytes,
                    total_bytes,
                    total_papers,
                    ..progress_phase(CollectionSeedSyncPhase::Downloading)
                });

                let mut stream_err: Option<String> = None;
                loop {
                    let next_chunk = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => {
                            let _ = writer.flush().await;
                            return Err(seed_sync_cancelled_err());
                        }
                        chunk = resp.chunk() => chunk,
                    };
                    match next_chunk {
                        Ok(Some(chunk)) => {
                            writer.write_all(&chunk).await?;
                            let n = chunk.len() as u64;
                            downloaded_bytes = downloaded_bytes.saturating_add(n);
                            session_bytes = session_bytes.saturating_add(n);
                            let elapsed = started.elapsed();
                            let bps = if elapsed >= Duration::from_millis(250) {
                                Some(((session_bytes as f64) / elapsed.as_secs_f64()) as u64)
                            } else {
                                None
                            };
                            progress.emit_throttled(CollectionSeedProgress {
                                shard_index,
                                shard_count,
                                downloaded_bytes,
                                total_bytes,
                                bytes_per_sec: bps,
                                total_papers,
                                ..progress_phase(CollectionSeedSyncPhase::Downloading)
                            });
                        }
                        Ok(None) => break,
                        Err(e) => {
                            stream_err = Some(e.to_string());
                            break;
                        }
                    }
                }

                writer.flush().await?;
                drop(writer);

                if let Some(err_msg) = stream_err {
                    if attempt < MAX_SHARD_DOWNLOAD_RETRIES {
                        let wait = Duration::from_secs(SHARD_RETRY_BACKOFF_SECS[attempt]);
                        attempt += 1;
                        sleep_cancellable(wait, cancel).await?;
                        continue;
                    }
                    return Err(AppError::message(format!(
                        "stream seed shard {}: {err_msg}",
                        shard.filename
                    )));
                }

                // Verify complete file SHA-256 on blocking pool.
                let verify_path = part_path.clone();
                let expected = shard.sha256.clone();
                let sha_res = tokio::task::spawn_blocking(move || {
                    verify_file_sha256(&verify_path, &expected)
                })
                .await
                .map_err(|e| AppError::message(format!("verify seed shard join: {e}")))?;

                match sha_res {
                    Ok(_) => {
                        let elapsed = started.elapsed();
                        let bps = if elapsed >= Duration::from_millis(100) && session_bytes > 0 {
                            Some(((session_bytes as f64) / elapsed.as_secs_f64()) as u64)
                        } else {
                            None
                        };
                        progress.emit_immediate(CollectionSeedProgress {
                            shard_index,
                            shard_count,
                            downloaded_bytes,
                            total_bytes: total_bytes.or(Some(downloaded_bytes)),
                            bytes_per_sec: bps,
                            total_papers,
                            ..progress_phase(CollectionSeedSyncPhase::Downloading)
                        });
                        return Ok(PreparedShard {
                            shard: shard.clone(),
                            path: part_path,
                            delete_after_commit: true,
                        });
                    }
                    Err(e) => {
                        // Delete corrupted/stale `.part` file cleanly before retry or error.
                        let _ = tokio::fs::remove_file(&part_path).await;
                        if attempt < MAX_SHARD_DOWNLOAD_RETRIES {
                            let wait = Duration::from_secs(SHARD_RETRY_BACKOFF_SECS[attempt]);
                            attempt += 1;
                            sleep_cancellable(wait, cancel).await?;
                            continue;
                        }
                        return Err(e);
                    }
                }
            }
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
    seed_sync_with_progress(args, None).await
}

pub async fn seed_sync_with_progress(
    args: CollectionSeedSyncArgs,
    on_progress: Option<SeedProgressCallback>,
) -> Result<CollectionSeedSyncOut, AppError> {
    let db_path = collection_db_path();
    seed_sync_at_with_progress(&db_path, args, on_progress).await
}

pub async fn seed_sync_at(
    db_path: &Path,
    args: CollectionSeedSyncArgs,
) -> Result<CollectionSeedSyncOut, AppError> {
    seed_sync_at_with_progress(db_path, args, None).await
}

pub async fn seed_sync_at_with_progress(
    db_path: &Path,
    args: CollectionSeedSyncArgs,
    on_progress: Option<SeedProgressCallback>,
) -> Result<CollectionSeedSyncOut, AppError> {
    let key = normalize_write_lock_key(db_path);
    let force = args.force.unwrap_or(false);

    loop {
        enum Role {
            Leader(ActiveSeedSyncGuard),
            Follower(tokio::sync::watch::Receiver<Option<SeedSyncOutcome>>),
        }

        let role = {
            let mut map = active_seed_syncs()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(existing) = map.get(&key) {
                Role::Follower(existing.done_rx.clone())
            } else {
                let (done_tx, done_rx) = tokio::sync::watch::channel(None);
                let entry = Arc::new(ActiveSeedSync {
                    cancel: CancellationToken::new(),
                    done_tx,
                    done_rx,
                });
                map.insert(key.clone(), Arc::clone(&entry));
                Role::Leader(ActiveSeedSyncGuard {
                    key: key.clone(),
                    entry,
                    published: false,
                })
            }
        };

        match role {
            Role::Follower(mut rx) => {
                let _ = rx.wait_for(|v| v.is_some()).await;
                let outcome = rx.borrow().clone().unwrap_or_else(|| {
                    Err(SeedSyncWatchErr {
                        domain_code: None,
                        message: "Collection seed sync channel closed".to_string(),
                    })
                });
                match outcome {
                    Ok(out) => {
                        if force && out.skipped {
                            continue;
                        }
                        return Ok(out);
                    }
                    Err(err) => return Err(err.into_app_error()),
                }
            }
            Role::Leader(guard) => {
                let cancel = guard.entry.cancel.clone();
                let res = run_seed_sync_leader(db_path, args, cancel, on_progress.clone()).await;
                let watch_res = res
                    .as_ref()
                    .map(Clone::clone)
                    .map_err(SeedSyncWatchErr::from_app_error);
                guard.finish(watch_res);
                return res;
            }
        }
    }
}

async fn run_seed_sync_leader(
    db_path: &Path,
    args: CollectionSeedSyncArgs,
    cancel: CancellationToken,
    on_progress: Option<SeedProgressCallback>,
) -> Result<CollectionSeedSyncOut, AppError> {
    let mut progress = ProgressEmitter::new(on_progress.clone());
    let result =
        run_seed_sync_leader_inner(db_path, args, cancel, on_progress, &mut progress).await;
    match &result {
        Ok(out) => {
            let phase = if out.skipped {
                CollectionSeedSyncPhase::Skipped
            } else {
                CollectionSeedSyncPhase::Done
            };
            progress.emit_immediate(CollectionSeedProgress {
                shard_index: out.applied_shards.len(),
                shard_count: out.applied_shards.len(),
                imported_papers: out.imported_papers,
                total_papers: out.imported_papers,
                ..progress_phase(phase)
            });
        }
        Err(err) if is_seed_sync_cancelled(err) => {
            progress.emit_immediate(progress_phase(CollectionSeedSyncPhase::Cancelled));
        }
        Err(err) => {
            progress.emit_immediate(CollectionSeedProgress {
                error: Some(err.to_string()),
                ..progress_phase(CollectionSeedSyncPhase::Error)
            });
        }
    }
    result
}

async fn run_seed_sync_leader_inner(
    db_path: &Path,
    args: CollectionSeedSyncArgs,
    cancel: CancellationToken,
    on_progress: Option<SeedProgressCallback>,
    progress: &mut ProgressEmitter,
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

    if cancel.is_cancelled() {
        return Err(seed_sync_cancelled_err());
    }

    let raw_url = args
        .manifest_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SEED_MANIFEST_URL);
    let loc = parse_manifest_location(raw_url)?;

    progress.emit_immediate(progress_phase(CollectionSeedSyncPhase::FetchingManifest));

    let client = seed_http_client()?;
    let Some(manifest) = fetch_manifest(&client, &loc, force, &cancel).await? else {
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
    let has_applied_core = !force
        && initial_state.total_count > 0
        && initial_state
            .applied_seed_ids
            .iter()
            .any(|id| id.trim().to_ascii_lowercase().starts_with("core-"));

    let selected_shards: Vec<SeedShardEntry> = manifest
        .shards
        .iter()
        .filter(|s| {
            let sid = s.id.trim();
            if sid.is_empty() || already_applied.contains(sid) {
                return false;
            }
            if has_applied_core && s.kind.trim().eq_ignore_ascii_case("core") {
                return false;
            }
            shard_matches_enabled_scope(s, &initial_state.categories)
        })
        .cloned()
        .collect();

    if selected_shards.is_empty() {
        if force && initial_state.seed_cleared {
            let db_clear_flag = db_path.to_path_buf();
            let state = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
                with_collection_write_conn(&db_clear_flag, |conn| {
                    conn.execute(
                        "UPDATE collection_config SET seed_cleared = 0 WHERE id = 1",
                        [],
                    )?;
                    read_state_summary_conn(conn)
                })
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

    let cache_dir = seed_cache_dir_for(db_path);
    let shard_count = selected_shards.len();
    let total_papers_planned: usize = selected_shards.iter().map(|s| s.paper_count).sum();
    let mut prepared_shards: Vec<PreparedShard> = Vec::with_capacity(shard_count);
    for (idx, shard) in selected_shards.iter().enumerate() {
        let prepared = download_or_locate_shard(
            &client,
            &loc,
            shard,
            &cache_dir,
            idx + 1,
            shard_count,
            total_papers_planned,
            &cancel,
            progress,
        )
        .await?;
        prepared_shards.push(prepared);
    }

    if cancel.is_cancelled() {
        return Err(seed_sync_cancelled_err());
    }

    let cleanup_paths: Vec<PathBuf> = prepared_shards
        .iter()
        .filter(|s| s.delete_after_commit)
        .map(|s| s.path.clone())
        .collect();

    let db_import = db_path.to_path_buf();
    let cancel_import = cancel.clone();
    let out = tokio::task::spawn_blocking(move || -> Result<CollectionSeedSyncOut, AppError> {
        let mut import_progress = ProgressEmitter::new(on_progress);
        with_collection_write_conn(&db_import, |conn| {
            let _ = conn.execute_batch("PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY;");
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            // Re-check `seed_cleared`, `applied_seed_ids`, and `papers` count inside the write
            // lock so a concurrent `clear_collection` or duplicate sync cannot be clobbered.
            let (fresh_seed_cleared_raw, prev_applied_raw): (i64, String) = tx.query_row(
                "SELECT seed_cleared, applied_seed_ids_json FROM collection_config WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let fresh_seed_cleared = fresh_seed_cleared_raw != 0;
            if fresh_seed_cleared && !force {
                drop(tx);
                let state = read_state_summary_conn(conn)?;
                return Ok(CollectionSeedSyncOut {
                    state,
                    applied_shards: Vec::new(),
                    imported_papers: 0,
                    skipped: true,
                });
            }

            let existing_paper_count: i64 =
                tx.query_row("SELECT COUNT(*) FROM papers", [], |r| r.get(0))?;
            let prev_applied_vec: Vec<String> =
                serde_json::from_str(&prev_applied_raw).unwrap_or_default();
            let fresh_already_applied: HashSet<String> = if force {
                HashSet::new()
            } else {
                prev_applied_vec.iter().cloned().collect()
            };
            let fresh_has_applied_core = !force
                && existing_paper_count > 0
                && prev_applied_vec
                    .iter()
                    .any(|id| id.trim().to_ascii_lowercase().starts_with("core-"));

            let shards_to_apply: Vec<&PreparedShard> = prepared_shards
                .iter()
                .filter(|ps| {
                    let sid = ps.shard.id.trim();
                    if sid.is_empty() || fresh_already_applied.contains(sid) {
                        return false;
                    }
                    !(fresh_has_applied_core && ps.shard.kind.trim().eq_ignore_ascii_case("core"))
                })
                .collect();

            if shards_to_apply.is_empty() {
                drop(tx);
                let state = read_state_summary_conn(conn)?;
                return Ok(CollectionSeedSyncOut {
                    state,
                    applied_shards: Vec::new(),
                    imported_papers: 0,
                    skipped: true,
                });
            }

            let is_empty_db = existing_paper_count == 0;
            if is_empty_db {
                // Defer FTS5 insert trigger and `idx_raw_refs_key` inside this transaction;
                // SQLite DDL is transactional, so rollback restores both cleanly on cancel/error.
                tx.execute_batch(
                    "DROP TRIGGER IF EXISTS papers_fts_ai;
                     DROP INDEX IF EXISTS idx_raw_refs_key;",
                )?;
            }

            let now = now_rfc3339();
            let apply_shard_count = shards_to_apply.len();
            let total_papers: usize = shards_to_apply.iter().map(|s| s.shard.paper_count).sum();
            let mut imported_papers = 0usize;
            let mut applied_shards = Vec::with_capacity(apply_shard_count);
            let mut imported_core_or_delta = false;
            let mut imported_cs_ai_addon = false;
            let mut seen_paper_ids: HashSet<String> = if is_empty_db {
                HashSet::with_capacity(total_papers)
            } else {
                HashSet::new()
            };

            for (idx, ps) in shards_to_apply.iter().enumerate() {
                let shard = &ps.shard;
                let shard_idx = idx + 1;
                import_progress.emit_immediate(CollectionSeedProgress {
                    shard_index: shard_idx,
                    shard_count: apply_shard_count,
                    imported_papers,
                    total_papers: total_papers.max(imported_papers),
                    ..progress_phase(CollectionSeedSyncPhase::Importing)
                });

                let file = File::open(&ps.path)?;
                let gz = GzDecoder::new(file);
                let reader = BufReader::with_capacity(128 * 1024, gz);
                for (line_idx, line_res) in reader.lines().enumerate() {
                    if line_idx.is_multiple_of(SEED_IMPORT_CANCEL_CHECK_STRIDE)
                        && cancel_import.is_cancelled()
                    {
                        return Err(seed_sync_cancelled_err());
                    }
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
                    let incoming_refs_checked_at = rec.refs_checked_at.clone();
                    let assume_new =
                        is_empty_db && seen_paper_ids.insert(rec.id.trim().to_string());
                    let input: CollectionPaperUpsertInput = rec.into();
                    upsert_single_paper_with_options_tx(
                        &tx,
                        &input,
                        &now,
                        incoming_refs_checked_at.as_deref(),
                        assume_new,
                    )?;
                    imported_papers += 1;
                    if imported_papers.is_multiple_of(SEED_IMPORT_CANCEL_CHECK_STRIDE) {
                        if cancel_import.is_cancelled() {
                            return Err(seed_sync_cancelled_err());
                        }
                        import_progress.emit_throttled(CollectionSeedProgress {
                            shard_index: shard_idx,
                            shard_count: apply_shard_count,
                            imported_papers,
                            total_papers: total_papers.max(imported_papers),
                            ..progress_phase(CollectionSeedSyncPhase::Importing)
                        });
                    }
                }
                let kind_lower = shard.kind.trim().to_ascii_lowercase();
                if matches!(kind_lower.as_str(), "core" | "delta") {
                    imported_core_or_delta = true;
                }
                if kind_lower == "addon-cs-ai" {
                    imported_cs_ai_addon = true;
                }
                applied_shards.push(shard.id.trim().to_string());
            }

            if cancel_import.is_cancelled() {
                return Err(seed_sync_cancelled_err());
            }

            import_progress.emit_immediate(CollectionSeedProgress {
                shard_index: apply_shard_count,
                shard_count: apply_shard_count,
                imported_papers,
                total_papers: total_papers.max(imported_papers),
                ..progress_phase(CollectionSeedSyncPhase::Indexing)
            });

            if is_empty_db {
                tx.execute_batch(
                    "CREATE INDEX IF NOT EXISTS idx_raw_refs_key ON paper_raw_refs(ref_key);
                     INSERT INTO papers_fts(papers_fts) VALUES('rebuild');
                     CREATE TRIGGER IF NOT EXISTS papers_fts_ai AFTER INSERT ON papers BEGIN
                       INSERT INTO papers_fts(rowid, title, keywords_text, abstract_text)
                       VALUES (new.row_id, new.title, new.keywords_text, new.abstract_text);
                     END;",
                )?;
            }

            // Advance arXiv watermarks monotonically for enabled categories; never advance
            // `cs.AI` unless `addon-cs-ai` was actually applied in this run.
            let enabled_cats = load_enabled_categories(&tx)?;
            let cs_ai_enabled = enabled_cats.iter().any(|c| c.eq_ignore_ascii_case("cs.AI"));
            let mut wm_updates: HashMap<String, CollectionArxivWatermarkInput> = HashMap::new();
            for (cat, swm) in &manifest.arxiv_watermarks {
                if cat.eq_ignore_ascii_case("cs.AI") && (!cs_ai_enabled || !imported_cs_ai_addon) {
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
            let mut merged_applied = prev_applied_vec;
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
            if cancel_import.is_cancelled() {
                return Err(seed_sync_cancelled_err());
            }
            tx.commit()?;

            let state = read_state_summary_conn(conn)?;
            Ok(CollectionSeedSyncOut {
                state,
                applied_shards,
                imported_papers,
                skipped: false,
            })
        })
    })
    .await
    .map_err(|e| AppError::message(format!("seed_sync import join: {e}")))??;

    // Delete `.part` files only after verified commit.
    if !out.skipped {
        for part_path in cleanup_paths {
            let _ = tokio::fs::remove_file(&part_path).await;
        }
    }

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
    pub llm_batch_size: usize,
    /// Hard RPM limit across workers (`0` disables pacing; defaults to [`DEFAULT_BAKE_LLM_RPM`]).
    pub llm_rpm: u32,
    pub skip_refs: bool,
    pub skip_llm: bool,
    /// When `true`, bypass the 14-day reference check TTL and re-bake non-author keywords.
    pub force_clean: bool,
    pub delta_since: Option<String>,
}

impl Default for SeedBakeOptions {
    fn default() -> Self {
        Self {
            out_dir: PathBuf::from("dist/seed"),
            llm_base_url: DEFAULT_BAKE_LLM_BASE_URL.to_string(),
            llm_model: DEFAULT_BAKE_LLM_MODEL.to_string(),
            llm_api_key: None,
            llm_concurrency: DEFAULT_BAKE_LLM_CONCURRENCY,
            llm_batch_size: DEFAULT_BAKE_LLM_BATCH_SIZE,
            llm_rpm: DEFAULT_BAKE_LLM_RPM,
            skip_refs: false,
            skip_llm: false,
            force_clean: false,
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

#[derive(Clone, Debug)]
struct WorkRefTarget {
    work_id: i64,
    openalex_id: Option<String>,
    doi_norm: Option<String>,
    arxiv_id_norm: Option<String>,
    title: String,
    authors: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct WorkRefUpdate {
    work_id: i64,
    openalex_id: Option<String>,
    pub_doi: Option<String>,
    arxiv_id: Option<String>,
    abstract_text: Option<String>,
    refs: Vec<String>,
}

struct ParsedOpenAlexWork {
    openalex_id: Option<String>,
    title: String,
    authors: Vec<String>,
    pub_doi: Option<String>,
    arxiv_id: Option<String>,
    abstract_text: Option<String>,
    refs: Vec<String>,
}

enum OpenAlexFetchResult {
    Ok(Value),
    NotFound,
    RateLimited,
    Error,
}

fn parse_retry_after_secs(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

async fn fetch_openalex_json(client: &reqwest::Client, url: &str) -> OpenAlexFetchResult {
    const OA_RETRY_DELAYS_SECS: [u64; 3] = [2, 5, 10];
    for (attempt, &base_secs) in OA_RETRY_DELAYS_SECS.iter().enumerate() {
        match client.get(url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return match resp.json::<Value>().await {
                        Ok(v) => OpenAlexFetchResult::Ok(v),
                        Err(err) => {
                            log::warn!("seed_bake OpenAlex invalid JSON: {err}");
                            OpenAlexFetchResult::Error
                        }
                    };
                }
                if status == StatusCode::NOT_FOUND {
                    return OpenAlexFetchResult::NotFound;
                }
                if status == StatusCode::TOO_MANY_REQUESTS {
                    let retry_after = parse_retry_after_secs(resp.headers());
                    let remaining_credits: Option<u64> = resp
                        .headers()
                        .get("x-ratelimit-remaining")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.trim().parse::<u64>().ok());
                    let body_lower = resp.text().await.unwrap_or_default().to_ascii_lowercase();
                    let is_daily_budget = match remaining_credits {
                        Some(0) => true,
                        Some(_) => false,
                        None => {
                            retry_after.is_some_and(|s| s > 120)
                                || body_lower.contains("daily budget")
                                || body_lower.contains("insufficient credits")
                                || body_lower.contains("out of credits")
                                || body_lower.contains("daily limit exceeded")
                        }
                    };
                    if is_daily_budget || attempt + 1 >= OA_RETRY_DELAYS_SECS.len() {
                        log::warn!(
                            "seed_bake OpenAlex HTTP 429 rate-limited (daily_budget={is_daily_budget}, remaining={remaining_credits:?}), stopping OpenAlex pass gracefully"
                        );
                        return OpenAlexFetchResult::RateLimited;
                    }
                    let wait = retry_after.unwrap_or(base_secs).clamp(1, 30);
                    log::warn!(
                        "seed_bake OpenAlex HTTP 429 (attempt {}/{}), sleeping {}s",
                        attempt + 1,
                        OA_RETRY_DELAYS_SECS.len(),
                        wait
                    );
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                    continue;
                }
                if status.is_server_error() && attempt + 1 < OA_RETRY_DELAYS_SECS.len() {
                    log::warn!(
                        "seed_bake OpenAlex HTTP {} (attempt {}/{}), sleeping {}s",
                        status,
                        attempt + 1,
                        OA_RETRY_DELAYS_SECS.len(),
                        base_secs
                    );
                    tokio::time::sleep(Duration::from_secs(base_secs)).await;
                    continue;
                }
                log::warn!("seed_bake OpenAlex HTTP {status}");
                return OpenAlexFetchResult::Error;
            }
            Err(err) => {
                if attempt + 1 < OA_RETRY_DELAYS_SECS.len() {
                    tokio::time::sleep(Duration::from_secs(base_secs)).await;
                } else {
                    log::warn!("seed_bake OpenAlex GET failed after retries: {err}");
                    return OpenAlexFetchResult::Error;
                }
            }
        }
    }
    OpenAlexFetchResult::Error
}

fn is_rejected_openalex_work(work: &Value) -> bool {
    if let Some(wtype) = work.get("type").and_then(Value::as_str) {
        let t = wtype.trim().to_ascii_lowercase();
        if matches!(
            t.as_str(),
            "dataset"
                | "software"
                | "paratext"
                | "peer-review"
                | "erratum"
                | "letter"
                | "editorial"
                | "grant"
                | "retraction"
                | "book"
                | "proceedings"
                | "journal-issue"
        ) {
            return true;
        }
    }
    if let Some(raw_doi) = work.get("doi").and_then(Value::as_str) {
        if is_artifact_or_dataset_doi(raw_doi) {
            return true;
        }
    }
    if let Some(id_doi) = work
        .get("ids")
        .and_then(|ids| ids.get("doi"))
        .and_then(Value::as_str)
    {
        if is_artifact_or_dataset_doi(id_doi) {
            return true;
        }
    }
    false
}

fn extract_openalex_authors(work: &Value) -> Vec<String> {
    work.get("authorships")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    a.get("author")
                        .and_then(|au| au.get("display_name"))
                        .and_then(Value::as_str)
                        .or_else(|| a.get("raw_author_name").and_then(Value::as_str))
                })
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_openalex_work(work: &Value) -> Option<ParsedOpenAlexWork> {
    if is_rejected_openalex_work(work) {
        return None;
    }
    let openalex_id = work
        .get("id")
        .and_then(Value::as_str)
        .and_then(clean_openalex_id);
    let title = work
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let authors = extract_openalex_authors(work);
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
    let abstract_text = work
        .get("abstract_inverted_index")
        .and_then(crate::features::paper::scholar_api::sources::openalex::reconstruct_abstract)
        .map(|raw| collapse_whitespace(&raw))
        .filter(|clean| !clean.is_empty() && !is_roster_placeholder_abstract(clean, ""));
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

    Some(ParsedOpenAlexWork {
        openalex_id,
        title,
        authors,
        pub_doi,
        arxiv_id,
        abstract_text,
        refs,
    })
}

fn resolve_work_alias(aliases: &HashMap<i64, i64>, mut wid: i64) -> i64 {
    while let Some(&next) = aliases.get(&wid) {
        if next == wid {
            break;
        }
        wid = next;
    }
    wid
}

fn merge_canonical_works_on_ids_tx(
    tx: &rusqlite::Transaction<'_>,
    aliases: &mut HashMap<i64, i64>,
    seed_wid: i64,
    oa_opt: Option<&str>,
    pub_doi_opt: Option<&str>,
    arxiv_opt: Option<&str>,
) -> Result<i64, AppError> {
    let cur_wid = resolve_work_alias(aliases, seed_wid);
    let mut matched: Vec<i64> = Vec::new();
    let exists_cur: bool = tx
        .query_row(
            "SELECT 1 FROM canonical_works WHERE work_id = ?1",
            [cur_wid],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if exists_cur {
        matched.push(cur_wid);
    }

    if let Some(oa) = oa_opt.filter(|s| !s.is_empty()) {
        let mut stmt =
            tx.prepare_cached("SELECT work_id FROM canonical_works WHERE openalex_id = ?1")?;
        for wid in stmt.query_map([oa], |r| r.get::<_, i64>(0))? {
            let wid = wid?;
            if !matched.contains(&wid) {
                matched.push(wid);
            }
        }
    }
    if let Some(doi) = pub_doi_opt.filter(|s| is_publisher_doi(s)) {
        let mut stmt =
            tx.prepare_cached("SELECT work_id FROM canonical_works WHERE doi_norm = ?1")?;
        for wid in stmt.query_map([doi], |r| r.get::<_, i64>(0))? {
            let wid = wid?;
            if !matched.contains(&wid) {
                matched.push(wid);
            }
        }
    }
    if let Some(aid) = arxiv_opt.filter(|s| !s.is_empty()) {
        let mut stmt =
            tx.prepare_cached("SELECT work_id FROM canonical_works WHERE arxiv_id_norm = ?1")?;
        for wid in stmt.query_map([aid], |r| r.get::<_, i64>(0))? {
            let wid = wid?;
            if !matched.contains(&wid) {
                matched.push(wid);
            }
        }
    }

    if matched.is_empty() {
        return Ok(cur_wid);
    }
    matched.sort_unstable();
    let primary_id = matched[0];
    if matched.len() > 1 {
        struct CanonicalMergeRow {
            openalex_id: Option<String>,
            doi_norm: Option<String>,
            arxiv_id_norm: Option<String>,
            title_norm: Option<String>,
            author_norm: Option<String>,
            refs_checked_at: Option<String>,
        }
        let read_cw = |wid: i64| -> rusqlite::Result<CanonicalMergeRow> {
            tx.query_row(
                "SELECT openalex_id, doi_norm, arxiv_id_norm, title_norm, author_norm, refs_checked_at
                 FROM canonical_works WHERE work_id = ?1",
                [wid],
                |r| {
                    Ok(CanonicalMergeRow {
                        openalex_id: r.get(0)?,
                        doi_norm: r.get(1)?,
                        arxiv_id_norm: r.get(2)?,
                        title_norm: r.get(3)?,
                        author_norm: r.get(4)?,
                        refs_checked_at: r.get(5)?,
                    })
                },
            )
        };
        let mut primary = read_cw(primary_id)?;
        for &sec_id in &matched[1..] {
            if let Ok(sec) = read_cw(sec_id) {
                if primary.openalex_id.is_none() {
                    primary.openalex_id = sec.openalex_id;
                }
                if primary.doi_norm.is_none() {
                    primary.doi_norm = sec.doi_norm.filter(|d| is_publisher_doi(d));
                }
                if primary.arxiv_id_norm.is_none() {
                    primary.arxiv_id_norm = sec.arxiv_id_norm;
                }
                if primary.title_norm.as_deref().is_none_or(str::is_empty) {
                    primary.title_norm = sec.title_norm;
                }
                if primary.author_norm.as_deref().is_none_or(str::is_empty) {
                    primary.author_norm = sec.author_norm;
                }
                primary.refs_checked_at =
                    newer_refs_checked_at(primary.refs_checked_at, sec.refs_checked_at);
            }
            tx.execute(
                "INSERT OR IGNORE INTO paper_raw_refs (src_work_id, ref_key)
                 SELECT ?1, ref_key FROM paper_raw_refs WHERE src_work_id = ?2",
                params![primary_id, sec_id],
            )?;
            tx.execute(
                "DELETE FROM paper_raw_refs WHERE src_work_id = ?1",
                [sec_id],
            )?;
            tx.execute(
                "DELETE FROM paper_citations WHERE citing_work_id = ?1 OR cited_work_id = ?1",
                [sec_id],
            )?;
            tx.execute(
                "UPDATE papers SET work_id = ?1 WHERE work_id = ?2",
                params![primary_id, sec_id],
            )?;
            tx.execute("DELETE FROM canonical_works WHERE work_id = ?1", [sec_id])?;
            aliases.insert(sec_id, primary_id);
        }
        tx.execute(
            "UPDATE canonical_works
             SET openalex_id = ?1, doi_norm = ?2, arxiv_id_norm = ?3,
                 title_norm = ?4, author_norm = ?5, refs_checked_at = ?6
             WHERE work_id = ?7",
            params![
                primary.openalex_id,
                primary.doi_norm,
                primary.arxiv_id_norm,
                primary.title_norm,
                primary.author_norm,
                primary.refs_checked_at,
                primary_id
            ],
        )?;
    }

    Ok(primary_id)
}

fn persist_ref_batch(db_path: &Path, updates: &[WorkRefUpdate]) -> Result<usize, AppError> {
    if updates.is_empty() {
        return Ok(0);
    }
    with_collection_write_conn(db_path, |conn| {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut enriched = 0usize;
        let mut aliases: HashMap<i64, i64> = HashMap::new();

        for u in updates {
            let pub_doi = u.pub_doi.as_deref().and_then(clean_publisher_doi);
            let arxiv_id = u.arxiv_id.as_deref().and_then(clean_arxiv_key);
            let oa_id = u.openalex_id.as_deref().and_then(clean_openalex_id);
            let primary_id = merge_canonical_works_on_ids_tx(
                &tx,
                &mut aliases,
                u.work_id,
                oa_id.as_deref(),
                pub_doi.as_deref(),
                arxiv_id.as_deref(),
            )?;

            let mut touched = false;
            if oa_id.is_some() || pub_doi.is_some() || arxiv_id.is_some() {
                tx.execute(
                    "UPDATE canonical_works
                 SET openalex_id = COALESCE(openalex_id, ?1),
                     doi_norm = COALESCE(doi_norm, ?2),
                     arxiv_id_norm = COALESCE(arxiv_id_norm, ?3)
                 WHERE work_id = ?4",
                    params![oa_id, pub_doi, arxiv_id, primary_id],
                )?;
                tx.execute(
                "UPDATE papers
                 SET openalex_id = COALESCE(openalex_id, ?1),
                     doi = CASE
                         WHEN ?2 IS NOT NULL AND (doi IS NULL OR doi = '' OR doi_norm LIKE '10.48550/%')
                         THEN ?2 ELSE doi END,
                     doi_norm = CASE
                         WHEN ?2 IS NOT NULL AND (doi_norm IS NULL OR doi_norm = '' OR doi_norm LIKE '10.48550/%')
                         THEN ?2 ELSE doi_norm END,
                     arxiv_id = COALESCE(NULLIF(arxiv_id, ''), ?3),
                     arxiv_id_norm = COALESCE(NULLIF(arxiv_id_norm, ''), ?3)
                 WHERE work_id = ?4",
                params![oa_id, pub_doi, arxiv_id, primary_id],
            )?;
                touched = true;
            }
            if insert_work_raw_refs_tx(&tx, primary_id, &u.refs)? > 0 {
                touched = true;
            }
            if let Some(ref abs) = u.abstract_text {
                let clean_abs = collapse_whitespace(abs);
                if !clean_abs.is_empty() && !is_roster_placeholder_abstract(&clean_abs, "") {
                    let candidates: Vec<(i64, String, String)> = {
                        let mut stmt = tx.prepare_cached(
                        "SELECT row_id, abstract_text, source_label FROM papers WHERE work_id = ?1",
                    )?;
                        let rows = stmt
                            .query_map([primary_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
                        rows.collect::<Result<Vec<_>, _>>()?
                    };
                    for (row_id, ex_abs, src_label) in candidates {
                        let ex_clean = collapse_whitespace(&ex_abs);
                        if ex_clean.is_empty()
                            || is_roster_placeholder_abstract(&ex_clean, &src_label)
                        {
                            tx.execute(
                                "UPDATE papers SET abstract_text = ?1 WHERE row_id = ?2",
                                params![clean_abs, row_id],
                            )?;
                            touched = true;
                        }
                    }
                }
            }
            if touched {
                enriched += 1;
            }
        }
        tx.commit()?;
        Ok(enriched)
    })
}

fn mark_works_refs_checked(db_path: &Path, work_ids: &[i64]) -> Result<(), AppError> {
    if work_ids.is_empty() {
        return Ok(());
    }
    with_collection_write_conn(db_path, |conn| {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_rfc3339();
        {
            let mut stmt = tx.prepare_cached(
                "UPDATE canonical_works SET refs_checked_at = ?1 WHERE work_id = ?2",
            )?;
            for &wid in work_ids {
                stmt.execute(params![now, wid])?;
            }
        }
        tx.commit()?;
        Ok(())
    })
}

fn sanitize_title_for_openalex_search(raw: &str) -> Option<String> {
    if raw.split_whitespace().count() < 3 {
        return None;
    }
    let mut buf = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '"' | '“' | '”' => {}
            '|' | ',' | ':' | ';' | '(' | ')' | '[' | ']' | '{' | '}' | '!' | '?' | '/' | '\\'
            | '&' | '*' | '+' | '~' | '<' | '>' | '=' | '^' | '$' | '#' | '@' | '%' | '_' | '-'
            | '\'' | '’' | '‘' => buf.push(' '),
            _ if ch.is_whitespace() => buf.push(' '),
            _ => buf.push(ch),
        }
    }
    let collapsed = buf
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if collapsed.split_whitespace().count() < 3 {
        return None;
    }
    let mut trimmed = collapsed;
    if trimmed.len() > 115 {
        if let Some(cut) = trimmed
            .char_indices()
            .take_while(|(idx, _)| *idx <= 115)
            .filter(|(_, c)| *c == ' ')
            .map(|(idx, _)| idx)
            .last()
        {
            if cut >= 24 {
                trimmed.truncate(cut);
            }
        }
        if trimmed.len() > 115 {
            trimmed = trimmed
                .chars()
                .take(115)
                .collect::<String>()
                .trim_end()
                .to_string();
        }
    }
    if trimmed.split_whitespace().count() < 3 {
        return None;
    }
    Some(format!("\"{trimmed}\""))
}

fn target_ids_compatible(target: &WorkRefTarget, parsed: &ParsedOpenAlexWork) -> bool {
    let doi_ok = match (&target.doi_norm, &parsed.pub_doi) {
        (Some(td), Some(pd)) => td == pd,
        _ => true,
    };
    let arxiv_ok = match (&target.arxiv_id_norm, &parsed.arxiv_id) {
        (Some(ta), Some(pa)) => ta == pa,
        _ => true,
    };
    doi_ok && arxiv_ok
}

fn verify_target_title_and_authors(
    target: &WorkRefTarget,
    parsed: &ParsedOpenAlexWork,
    allow_authorless_fallback: bool,
) -> bool {
    let t_key = norm_title_key(&target.title);
    let oa_key = norm_title_key(&parsed.title);
    if t_key.is_empty() || t_key != oa_key {
        return false;
    }
    if !target.authors.is_empty() && !parsed.authors.is_empty() {
        return same_work_by_title_and_authors(
            &target.title,
            &target.authors,
            &parsed.title,
            &parsed.authors,
        );
    }
    if !allow_authorless_fallback {
        return false;
    }
    t_key.len() >= 12 && target.title.split_whitespace().count() >= 3
}

fn merge_parsed_into_update(existing: &mut WorkRefUpdate, parsed: &ParsedOpenAlexWork) {
    if existing.openalex_id.is_none() {
        existing.openalex_id = parsed.openalex_id.clone();
    }
    if existing.pub_doi.is_none() {
        existing.pub_doi = parsed.pub_doi.clone();
    }
    if existing.arxiv_id.is_none() {
        existing.arxiv_id = parsed.arxiv_id.clone();
    }
    if existing.abstract_text.is_none() {
        existing.abstract_text = parsed.abstract_text.clone();
    }
    for r in &parsed.refs {
        if !existing.refs.contains(r) {
            existing.refs.push(r.clone());
        }
    }
}

fn arxiv_refs_check_ttl_cutoff() -> String {
    (chrono::Utc::now() - chrono::Duration::days(ARXIV_OA_REFS_CHECK_TTL_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn venue_refs_check_ttl_cutoff() -> String {
    (chrono::Utc::now() - chrono::Duration::days(VENUE_OA_REFS_CHECK_TTL_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn arxiv_refs_min_published_ymd() -> String {
    (chrono::Utc::now() - chrono::Duration::days(ARXIV_OA_REFS_MAX_AGE_DAYS))
        .format("%Y-%m-%d")
        .to_string()
}

struct WorkTargetRow {
    work_id: i64,
    openalex_id: Option<String>,
    doi_norm: Option<String>,
    arxiv_id_norm: Option<String>,
    title: String,
    authors_json: String,
}

fn fold_work_targets_from_rows(rows: Vec<WorkTargetRow>) -> Vec<WorkRefTarget> {
    let mut order: Vec<i64> = Vec::new();
    let mut map: HashMap<i64, WorkRefTarget> = HashMap::new();
    for row in rows {
        let authors: Vec<String> = serde_json::from_str(&row.authors_json).unwrap_or_default();
        let entry = map.entry(row.work_id).or_insert_with(|| {
            order.push(row.work_id);
            WorkRefTarget {
                work_id: row.work_id,
                openalex_id: row.openalex_id.clone(),
                doi_norm: row.doi_norm.filter(|d| is_publisher_doi(d)),
                arxiv_id_norm: row.arxiv_id_norm,
                title: String::new(),
                authors: Vec::new(),
            }
        });
        if entry.title.trim().is_empty() && !row.title.trim().is_empty() {
            entry.title = row.title;
        }
        if entry.authors.is_empty() && !authors.is_empty() {
            entry.authors = authors;
        }
    }
    order
        .into_iter()
        .filter_map(|wid| map.remove(&wid))
        .collect()
}

fn load_pass_a1_targets(
    conn: &rusqlite::Connection,
    arxiv_ttl_cutoff: &str,
    venue_ttl_cutoff: &str,
    arxiv_min_ymd: &str,
) -> Result<(Vec<WorkRefTarget>, HashSet<i64>), AppError> {
    let mut stmt = conn.prepare(
        "SELECT cw.work_id, cw.openalex_id, cw.doi_norm, cw.arxiv_id_norm, p.title, p.authors_json,
                EXISTS (SELECT 1 FROM papers pv WHERE pv.work_id = cw.work_id AND pv.source_type = 'venue') AS is_venue
         FROM canonical_works cw
         LEFT JOIN papers p ON p.work_id = cw.work_id
         WHERE NOT EXISTS (SELECT 1 FROM paper_raw_refs r WHERE r.src_work_id = cw.work_id)
           AND (cw.openalex_id IS NOT NULL OR cw.doi_norm IS NOT NULL OR cw.arxiv_id_norm IS NOT NULL)
           AND (
             (
               EXISTS (SELECT 1 FROM papers pv WHERE pv.work_id = cw.work_id AND pv.source_type = 'venue')
               AND (cw.refs_checked_at IS NULL OR cw.refs_checked_at < ?2)
             )
             OR (
               NOT EXISTS (SELECT 1 FROM papers pv WHERE pv.work_id = cw.work_id AND pv.source_type = 'venue')
               AND (cw.refs_checked_at IS NULL OR cw.refs_checked_at < ?1)
               AND EXISTS (
                 SELECT 1 FROM papers pa
                 WHERE pa.work_id = cw.work_id
                   AND (pa.published_ymd = '' OR pa.published_ymd >= ?3)
               )
             )
           )
         ORDER BY CASE WHEN is_venue = 1 THEN 0 ELSE 1 END,
                  cw.work_id ASC,
                  CASE WHEN p.source_type = 'venue' THEN 0 ELSE 1 END,
                  p.row_id ASC",
    )?;
    let mut venue_wids: HashSet<i64> = HashSet::new();
    let rows = stmt
        .query_map(
            params![arxiv_ttl_cutoff, venue_ttl_cutoff, arxiv_min_ymd],
            |r| {
                let wid: i64 = r.get(0)?;
                let is_venue: bool = r.get::<_, i64>(6)? != 0;
                Ok((
                    is_venue,
                    WorkTargetRow {
                        work_id: wid,
                        openalex_id: r.get(1)?,
                        doi_norm: r.get(2)?,
                        arxiv_id_norm: r.get(3)?,
                        title: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                        authors_json: r
                            .get::<_, Option<String>>(5)?
                            .unwrap_or_else(|| "[]".to_string()),
                    },
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let mut raw_rows = Vec::with_capacity(rows.len());
    for (is_venue, row) in rows {
        if is_venue {
            venue_wids.insert(row.work_id);
        }
        raw_rows.push(row);
    }
    let targets = fold_work_targets_from_rows(raw_rows);
    let arxiv_only_wids: HashSet<i64> = targets
        .iter()
        .filter(|t| !venue_wids.contains(&t.work_id))
        .map(|t| t.work_id)
        .collect();
    Ok((targets, arxiv_only_wids))
}

fn load_client_refs_backfill_targets(
    conn: &rusqlite::Connection,
    args: &CollectionBackfillRefsArgs,
    arxiv_ttl_cutoff: &str,
    venue_ttl_cutoff: &str,
    arxiv_min_ymd: &str,
) -> Result<Vec<WorkRefTarget>, AppError> {
    let scope = args
        .source_type
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("all");
    let include_arxiv = scope.eq_ignore_ascii_case("all") || scope.eq_ignore_ascii_case("arxiv");
    let include_venue = scope.eq_ignore_ascii_case("all") || scope.eq_ignore_ascii_case("venue");
    if !include_arxiv && !include_venue {
        return Ok(Vec::new());
    }

    let clean_cats: Vec<String> = args
        .categories
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    let clean_venues: Vec<String> = args
        .venue_ids
        .iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect();

    let mut branches: Vec<String> = Vec::new();
    let mut binds: Vec<rusqlite::types::Value> = Vec::new();

    if include_venue {
        let mut venue_clause = String::from(
            "(EXISTS (SELECT 1 FROM papers pv WHERE pv.work_id = cw.work_id AND pv.source_type = 'venue'",
        );
        if !clean_venues.is_empty() {
            let ph = std::iter::repeat_n("?", clean_venues.len())
                .collect::<Vec<_>>()
                .join(", ");
            venue_clause.push_str(&format!(" AND pv.venue_id COLLATE NOCASE IN ({ph})"));
            for vid in &clean_venues {
                binds.push(vid.clone().into());
            }
        }
        venue_clause.push_str(") AND (cw.refs_checked_at IS NULL OR cw.refs_checked_at < ?))");
        binds.push(venue_ttl_cutoff.to_string().into());
        branches.push(venue_clause);
    }

    if include_arxiv {
        let mut arxiv_clause = String::from(
            "(NOT EXISTS (SELECT 1 FROM papers pv WHERE pv.work_id = cw.work_id AND pv.source_type = 'venue') \
             AND (cw.refs_checked_at IS NULL OR cw.refs_checked_at < ?) \
             AND EXISTS (SELECT 1 FROM papers pa WHERE pa.work_id = cw.work_id AND pa.source_type = 'arxiv' \
               AND (pa.published_ymd = '' OR pa.published_ymd >= ?)",
        );
        binds.push(arxiv_ttl_cutoff.to_string().into());
        binds.push(arxiv_min_ymd.to_string().into());
        if !clean_cats.is_empty() {
            let ph = std::iter::repeat_n("?", clean_cats.len())
                .collect::<Vec<_>>()
                .join(", ");
            arxiv_clause.push_str(&format!(
                " AND (pa.source_label COLLATE NOCASE IN ({ph}) \
                  OR EXISTS (SELECT 1 FROM paper_categories pc WHERE pc.paper_id = pa.id AND pc.category IN ({ph})))"
            ));
            for cat in &clean_cats {
                binds.push(cat.clone().into());
            }
            for cat in &clean_cats {
                binds.push(cat.clone().into());
            }
        }
        arxiv_clause.push_str("))");
        branches.push(arxiv_clause);
    }

    let sql = format!(
        "SELECT cw.work_id, cw.openalex_id, cw.doi_norm, cw.arxiv_id_norm, p.title, p.authors_json
         FROM canonical_works cw
         JOIN papers p ON p.work_id = cw.work_id
         WHERE cw.active_in_scope = 1
           AND NOT EXISTS (SELECT 1 FROM paper_raw_refs r WHERE r.src_work_id = cw.work_id)
           AND (cw.openalex_id IS NOT NULL OR cw.doi_norm IS NOT NULL OR cw.arxiv_id_norm IS NOT NULL)
           AND ({})
         ORDER BY cw.work_id ASC,
                  CASE WHEN p.source_type = 'venue' THEN 0 ELSE 1 END,
                  p.row_id ASC",
        branches.join(" OR ")
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(binds), |r| {
            Ok(WorkTargetRow {
                work_id: r.get(0)?,
                openalex_id: r.get(1)?,
                doi_norm: r.get(2)?,
                arxiv_id_norm: r.get(3)?,
                title: r.get(4)?,
                authors_json: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(fold_work_targets_from_rows(rows))
}

/// Client-side zero-credit OpenAlex `referenced_works` backfill sharing the exact same
/// TTL & arXiv age-cutoff policy as server `seed_bake`:
/// - arXiv-only papers: 7-day TTL, skip papers published >60 days ago.
/// - Venue papers: 14-day TTL, no age cutoff.
pub async fn backfill_missing_refs(
    args: CollectionBackfillRefsArgs,
    openalex_api_key: Option<&str>,
) -> Result<CollectionBackfillRefsOut, AppError> {
    let db_path = collection_db_path();
    backfill_missing_refs_at(&db_path, args, openalex_api_key).await
}

pub async fn backfill_missing_refs_at(
    db_path: &Path,
    args: CollectionBackfillRefsArgs,
    openalex_api_key: Option<&str>,
) -> Result<CollectionBackfillRefsOut, AppError> {
    use std::sync::Arc;
    use tokio::sync::Mutex;

    let arxiv_ttl = arxiv_refs_check_ttl_cutoff();
    let venue_ttl = venue_refs_check_ttl_cutoff();
    let arxiv_min_ymd = arxiv_refs_min_published_ymd();

    let db_load = db_path.to_path_buf();
    let targets = tokio::task::spawn_blocking(move || -> Result<Vec<WorkRefTarget>, AppError> {
        let conn = ensure_collection_at(&db_load)?;
        load_client_refs_backfill_targets(&conn, &args, &arxiv_ttl, &venue_ttl, &arxiv_min_ymd)
    })
    .await
    .map_err(|e| AppError::message(format!("backfill_missing_refs load: {e}")))??;

    if targets.is_empty() {
        let db_state = db_path.to_path_buf();
        let state = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
            let conn = ensure_collection_at(&db_state)?;
            read_state_summary_conn(&conn)
        })
        .await
        .map_err(|e| AppError::message(format!("backfill_missing_refs state: {e}")))??;
        return Ok(CollectionBackfillRefsOut {
            checked_works: 0,
            enriched_works: 0,
            state,
        });
    }

    let resolved_key = openalex_api_key
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(crate::features::paper::scholar_api::client::openalex_api_key);
    let has_oa_key = resolved_key.is_some();
    let oa_key_param = resolved_key
        .as_deref()
        .map(|k| format!("&api_key={}", urlencoding::encode(k)))
        .unwrap_or_default();
    let oa_slot_interval = Duration::from_millis(if has_oa_key {
        OA_SINGLETON_SLOT_KEYED_MS
    } else {
        OA_SINGLETON_SLOT_KEYLESS_MS
    });
    let oa_singleton_concurrency = if has_oa_key {
        OA_SINGLETON_CONCURRENCY_KEYED
    } else {
        OA_SINGLETON_CONCURRENCY_KEYLESS
    };
    let oa_next_slot = Arc::new(Mutex::new(tokio::time::Instant::now()));
    let client = crate::http::client_with(Duration::from_secs(20), 5, crate::http::USER_AGENT)?;

    let mut futs = stream::iter(targets.into_iter().filter_map(|t| {
        let url = if let Some(ref oa) = t.openalex_id {
            format!(
                "https://api.openalex.org/works/{oa}?select={OPENALEX_SELECT}&mailto={OPENALEX_MAILTO}{oa_key_param}"
            )
        } else if let Some(ref d) = t.doi_norm {
            format!(
                "https://api.openalex.org/works/https://doi.org/{d}?select={OPENALEX_SELECT}&mailto={OPENALEX_MAILTO}{oa_key_param}"
            )
        } else {
            let a = t.arxiv_id_norm.as_deref()?;
            format!(
                "https://api.openalex.org/works/https://doi.org/10.48550/arxiv.{a}?select={OPENALEX_SELECT}&mailto={OPENALEX_MAILTO}{oa_key_param}"
            )
        };
        let client_c = client.clone();
        let slot_c = Arc::clone(&oa_next_slot);
        Some(async move {
            acquire_rate_slot(&slot_c, oa_slot_interval).await;
            let res = fetch_openalex_json(&client_c, &url).await;
            (t, res)
        })
    }))
    .buffer_unordered(oa_singleton_concurrency);

    let mut checked_works = 0usize;
    let mut enriched_works = 0usize;
    let mut pending_updates: Vec<WorkRefUpdate> = Vec::new();
    let mut pending_checked: Vec<i64> = Vec::new();

    while let Some((target, res)) = futs.next().await {
        match res {
            OpenAlexFetchResult::Ok(json) => {
                checked_works += 1;
                let mut got_refs = false;
                if let Some(upd) = match_single_openalex_work_to_target(&target, &json) {
                    got_refs = !upd.refs.is_empty();
                    pending_updates.push(upd);
                }
                if !got_refs {
                    pending_checked.push(target.work_id);
                }
            }
            OpenAlexFetchResult::NotFound => {
                checked_works += 1;
                pending_checked.push(target.work_id);
            }
            OpenAlexFetchResult::RateLimited | OpenAlexFetchResult::Error => {}
        }
        if pending_updates.len() >= 50 {
            let flush = std::mem::take(&mut pending_updates);
            let db_p = db_path.to_path_buf();
            enriched_works += tokio::task::spawn_blocking(move || persist_ref_batch(&db_p, &flush))
                .await
                .map_err(|e| AppError::message(format!("backfill_missing_refs persist: {e}")))??;
        }
        if pending_checked.len() >= 50 {
            let flush_chk = std::mem::take(&mut pending_checked);
            let db_chk = db_path.to_path_buf();
            tokio::task::spawn_blocking(move || mark_works_refs_checked(&db_chk, &flush_chk))
                .await
                .map_err(|e| AppError::message(format!("backfill_missing_refs mark: {e}")))??;
        }
    }

    if !pending_updates.is_empty() {
        let db_p = db_path.to_path_buf();
        enriched_works +=
            tokio::task::spawn_blocking(move || persist_ref_batch(&db_p, &pending_updates))
                .await
                .map_err(|e| AppError::message(format!("backfill_missing_refs persist: {e}")))??;
    }
    if !pending_checked.is_empty() {
        let db_chk = db_path.to_path_buf();
        tokio::task::spawn_blocking(move || mark_works_refs_checked(&db_chk, &pending_checked))
            .await
            .map_err(|e| AppError::message(format!("backfill_missing_refs mark: {e}")))??;
    }

    let db_fin = db_path.to_path_buf();
    let should_recompute = enriched_works > 0;
    let state = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        if should_recompute {
            with_collection_write_conn(&db_fin, |conn| {
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                recompute_graph_and_citations_tx(&tx)?;
                tx.commit()?;
                read_state_summary_conn(conn)
            })
        } else {
            let conn = ensure_collection_at(&db_fin)?;
            read_state_summary_conn(&conn)
        }
    })
    .await
    .map_err(|e| AppError::message(format!("backfill_missing_refs finalize: {e}")))??;

    Ok(CollectionBackfillRefsOut {
        checked_works,
        enriched_works,
        state,
    })
}

fn load_pass_a1_5_targets_by_venue(
    conn: &rusqlite::Connection,
) -> Result<HashMap<String, Vec<WorkRefTarget>>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT cw.work_id, cw.openalex_id, cw.doi_norm, cw.arxiv_id_norm, p.venue_id, p.title, p.authors_json
         FROM canonical_works cw
         JOIN papers p ON p.work_id = cw.work_id
         WHERE cw.active_in_scope = 1
           AND cw.openalex_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM paper_raw_refs r WHERE r.src_work_id = cw.work_id)
           AND p.source_type = 'venue'
           AND p.venue_id IS NOT NULL
         ORDER BY cw.work_id ASC, p.row_id ASC",
    )?;
    let mut by_venue_rows: HashMap<String, Vec<WorkTargetRow>> = HashMap::new();
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(4)?,
            WorkTargetRow {
                work_id: r.get(0)?,
                openalex_id: r.get(1)?,
                doi_norm: r.get(2)?,
                arxiv_id_norm: r.get(3)?,
                title: r.get(5)?,
                authors_json: r.get(6)?,
            },
        ))
    })?;
    for entry in rows {
        let (vid, row) = entry?;
        by_venue_rows.entry(vid).or_default().push(row);
    }
    Ok(by_venue_rows
        .into_iter()
        .map(|(vid, vrows)| (vid, fold_work_targets_from_rows(vrows)))
        .collect())
}

/// Stage 2.4 (`title.search`) targets ONLY active `Venue` works that still lack
/// references after singleton / source-paging / S2 passes, excluding works whose
/// own identifier is already an arXiv DOI (`10.48550/%`) and honoring the 14-day TTL.
fn load_pass_a2_5_targets(
    conn: &rusqlite::Connection,
    ttl_cutoff: &str,
) -> Result<Vec<WorkRefTarget>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT cw.work_id, cw.openalex_id, cw.doi_norm, cw.arxiv_id_norm, p.title, p.authors_json
         FROM canonical_works cw
         JOIN papers p ON p.work_id = cw.work_id
         WHERE cw.active_in_scope = 1
           AND (cw.refs_checked_at IS NULL OR cw.refs_checked_at < ?1)
           AND NOT EXISTS (SELECT 1 FROM paper_raw_refs r WHERE r.src_work_id = cw.work_id)
           AND EXISTS (
               SELECT 1 FROM papers pv WHERE pv.work_id = cw.work_id AND pv.source_type = 'venue'
           )
           AND (cw.doi_norm IS NULL OR cw.doi_norm NOT LIKE '10.48550/%')
           AND NOT EXISTS (
               SELECT 1 FROM papers pa
               WHERE pa.work_id = cw.work_id
                 AND lower(COALESCE(pa.doi, '')) LIKE '10.48550/%'
           )
         ORDER BY cw.work_id ASC,
                  CASE WHEN p.source_type = 'venue' THEN 0 ELSE 1 END,
                  p.row_id ASC",
    )?;
    let rows = stmt
        .query_map([ttl_cutoff], |r| {
            Ok(WorkTargetRow {
                work_id: r.get(0)?,
                openalex_id: r.get(1)?,
                doi_norm: r.get(2)?,
                arxiv_id_norm: r.get(3)?,
                title: r.get(4)?,
                authors_json: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let folded = fold_work_targets_from_rows(rows);
    Ok(folded
        .into_iter()
        .filter(|t| sanitize_title_for_openalex_search(&t.title).is_some())
        .collect())
}

fn pack_title_search_batches(
    targets: &[WorkRefTarget],
    prefix_bytes: usize,
    suffix_bytes: usize,
) -> Vec<(Vec<usize>, Vec<String>)> {
    let mut batches: Vec<(Vec<usize>, Vec<String>)> = Vec::new();
    let mut cur_indices: Vec<usize> = Vec::new();
    let mut cur_clauses: Vec<String> = Vec::new();
    let mut cur_len = prefix_bytes + suffix_bytes;

    for (idx, t) in targets.iter().enumerate() {
        let Some(clean) = sanitize_title_for_openalex_search(&t.title) else {
            continue;
        };
        let encoded = urlencoding::encode(&clean).into_owned();
        let added_bytes = if cur_clauses.is_empty() {
            encoded.len()
        } else {
            // `|` separator (3 bytes percent-encoded `%7C` or 1 byte literal)
            3 + encoded.len()
        };
        if !cur_clauses.is_empty()
            && (cur_clauses.len() >= MAX_OA_TITLE_SEARCH_BATCH_SIZE
                || cur_len + added_bytes > MAX_OA_TITLE_SEARCH_URL_BYTES)
        {
            batches.push((cur_indices, cur_clauses));
            cur_indices = Vec::new();
            cur_clauses = Vec::new();
            cur_len = prefix_bytes + suffix_bytes + encoded.len();
        } else {
            cur_len += added_bytes;
        }
        cur_indices.push(idx);
        cur_clauses.push(encoded);
    }

    if !cur_clauses.is_empty() {
        batches.push((cur_indices, cur_clauses));
    }
    batches
}

fn match_single_openalex_work_to_target(
    target: &WorkRefTarget,
    work: &Value,
) -> Option<WorkRefUpdate> {
    let parsed = parse_openalex_work(work)?;
    if !target_ids_compatible(target, &parsed) {
        return None;
    }
    let exact_id_match = target
        .openalex_id
        .as_deref()
        .is_some_and(|oa| parsed.openalex_id.as_deref() == Some(oa))
        || target
            .doi_norm
            .as_deref()
            .is_some_and(|d| parsed.pub_doi.as_deref() == Some(d))
        || target
            .arxiv_id_norm
            .as_deref()
            .is_some_and(|a| parsed.arxiv_id.as_deref() == Some(a));
    if !exact_id_match && !verify_target_title_and_authors(target, &parsed, false) {
        return None;
    }
    if parsed.openalex_id.is_none()
        && parsed.pub_doi.is_none()
        && parsed.arxiv_id.is_none()
        && parsed.abstract_text.is_none()
        && parsed.refs.is_empty()
    {
        return None;
    }
    Some(WorkRefUpdate {
        work_id: target.work_id,
        openalex_id: parsed.openalex_id,
        pub_doi: parsed.pub_doi,
        arxiv_id: parsed.arxiv_id,
        abstract_text: parsed.abstract_text,
        refs: parsed.refs,
    })
}

async fn run_s2_batch_pass(
    client: &reqwest::Client,
    db_path: &Path,
    targets: &[(i64, String)],
    context: &str,
) -> Result<usize, AppError> {
    let mut enriched = 0usize;
    for batch100 in targets.chunks(100) {
        let updates = fetch_s2_batch_with_bisect(client, batch100).await?;
        if !updates.is_empty() {
            let db_p = db_path.to_path_buf();
            let err_label = context.to_string();
            enriched += tokio::task::spawn_blocking(move || persist_ref_batch(&db_p, &updates))
                .await
                .map_err(|e| AppError::message(format!("{err_label}: {e}")))??;
        }
    }
    Ok(enriched)
}

async fn run_step_a_refs_backfill(
    db_path: &Path,
    force_clean: bool,
) -> Result<(usize, usize), AppError> {
    use std::sync::Arc;
    use tokio::sync::Mutex;

    let client = crate::http::client_with(Duration::from_secs(60), 5, crate::http::USER_AGENT)?;
    let oa_api_key = crate::features::paper::scholar_api::client::openalex_api_key();
    let has_oa_key = oa_api_key.is_some();
    let oa_key_param = oa_api_key
        .as_deref()
        .map(|k| format!("&api_key={}", urlencoding::encode(k)))
        .unwrap_or_default();
    let oa_slot_interval = Duration::from_millis(if has_oa_key {
        OA_SINGLETON_SLOT_KEYED_MS
    } else {
        OA_SINGLETON_SLOT_KEYLESS_MS
    });
    let oa_singleton_concurrency = if has_oa_key {
        OA_SINGLETON_CONCURRENCY_KEYED
    } else {
        OA_SINGLETON_CONCURRENCY_KEYLESS
    };
    let oa_next_slot = Arc::new(Mutex::new(tokio::time::Instant::now()));

    let mut oa_enriched = 0usize;
    let mut oa_rate_limited = false;
    let arxiv_ttl_cutoff = if force_clean {
        "9999-12-31T23:59:59.999Z".to_string()
    } else {
        arxiv_refs_check_ttl_cutoff()
    };
    let venue_ttl_cutoff = if force_clean {
        "9999-12-31T23:59:59.999Z".to_string()
    } else {
        venue_refs_check_ttl_cutoff()
    };
    let arxiv_min_ymd = arxiv_refs_min_published_ymd();

    // Stage 2.1: Concurrent Zero-Credit OpenAlex Singleton Lookup (`0 credits`, paced by RPS tier)
    let db_load = db_path.to_path_buf();
    let arxiv_ttl_for_a1 = arxiv_ttl_cutoff.clone();
    let venue_ttl_for_a1 = venue_ttl_cutoff.clone();
    let min_ymd_for_a1 = arxiv_min_ymd.clone();
    let (a1_targets, arxiv_only_wids) =
        tokio::task::spawn_blocking(move || -> Result<_, AppError> {
            let conn = ensure_collection_at(&db_load)?;
            load_pass_a1_targets(&conn, &arxiv_ttl_for_a1, &venue_ttl_for_a1, &min_ymd_for_a1)
        })
        .await
        .map_err(|e| AppError::message(format!("seed_bake load 2.1 targets: {e}")))??;

    if !a1_targets.is_empty() {
        let mut futs = stream::iter(a1_targets.into_iter().filter_map(|t| {
            let url = if let Some(ref oa) = t.openalex_id {
                format!(
                    "https://api.openalex.org/works/{oa}?select={OPENALEX_SELECT}&mailto={OPENALEX_MAILTO}{oa_key_param}"
                )
            } else if let Some(ref d) = t.doi_norm {
                format!(
                    "https://api.openalex.org/works/https://doi.org/{d}?select={OPENALEX_SELECT}&mailto={OPENALEX_MAILTO}{oa_key_param}"
                )
            } else {
                let a = t.arxiv_id_norm.as_deref()?;
                format!(
                    "https://api.openalex.org/works/https://doi.org/10.48550/arxiv.{a}?select={OPENALEX_SELECT}&mailto={OPENALEX_MAILTO}{oa_key_param}"
                )
            };
            let client_c = client.clone();
            let slot_c = Arc::clone(&oa_next_slot);
            let is_arxiv_only = arxiv_only_wids.contains(&t.work_id);
            Some(async move {
                acquire_rate_slot(&slot_c, oa_slot_interval).await;
                let res = fetch_openalex_json(&client_c, &url).await;
                (t, is_arxiv_only, res)
            })
        }))
        .buffer_unordered(oa_singleton_concurrency);

        let mut pending_updates: Vec<WorkRefUpdate> = Vec::new();
        let mut pending_arxiv_checked: Vec<i64> = Vec::new();
        while let Some((target, is_arxiv_only, res)) = futs.next().await {
            match res {
                OpenAlexFetchResult::Ok(json) => {
                    let mut got_refs = false;
                    if let Some(upd) = match_single_openalex_work_to_target(&target, &json) {
                        got_refs = !upd.refs.is_empty();
                        pending_updates.push(upd);
                    }
                    if is_arxiv_only && !got_refs {
                        pending_arxiv_checked.push(target.work_id);
                    }
                }
                OpenAlexFetchResult::NotFound => {
                    if is_arxiv_only {
                        pending_arxiv_checked.push(target.work_id);
                    }
                }
                OpenAlexFetchResult::RateLimited | OpenAlexFetchResult::Error => {}
            }
            if pending_updates.len() >= 100 {
                let flush = std::mem::take(&mut pending_updates);
                let db_p = db_path.to_path_buf();
                oa_enriched +=
                    tokio::task::spawn_blocking(move || persist_ref_batch(&db_p, &flush))
                        .await
                        .map_err(|e| {
                            AppError::message(format!("persist oa singleton batch: {e}"))
                        })??;
            }
            if pending_arxiv_checked.len() >= 100 {
                let flush_chk = std::mem::take(&mut pending_arxiv_checked);
                let db_chk = db_path.to_path_buf();
                tokio::task::spawn_blocking(move || mark_works_refs_checked(&db_chk, &flush_chk))
                    .await
                    .map_err(|e| {
                        AppError::message(format!("mark arxiv singleton checked: {e}"))
                    })??;
            }
        }
        if !pending_updates.is_empty() {
            let db_p = db_path.to_path_buf();
            oa_enriched +=
                tokio::task::spawn_blocking(move || persist_ref_batch(&db_p, &pending_updates))
                    .await
                    .map_err(|e| AppError::message(format!("persist oa singleton batch: {e}")))??;
        }
        if !pending_arxiv_checked.is_empty() {
            let db_chk = db_path.to_path_buf();
            tokio::task::spawn_blocking(move || {
                mark_works_refs_checked(&db_chk, &pending_arxiv_checked)
            })
            .await
            .map_err(|e| AppError::message(format!("mark arxiv singleton checked: {e}")))??;
        }
    }

    // Stage 2.2: OpenAlex Source Paging ($0.10/1k, 200 works/page) for venues missing `openalex_id`
    let db_a15 = db_path.to_path_buf();
    let targets_by_venue = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let conn = ensure_collection_at(&db_a15)?;
        load_pass_a1_5_targets_by_venue(&conn)
    })
    .await
    .map_err(|e| AppError::message(format!("seed_bake load 2.2 targets: {e}")))??;

    if !targets_by_venue.is_empty() {
        let mut source_to_venues: Vec<(&'static str, Vec<&'static str>)> = Vec::new();
        let mut sid_index: HashMap<&'static str, usize> = HashMap::new();
        for &(vid, sids) in VENUE_OPENALEX_SOURCE_IDS {
            if !targets_by_venue
                .get(vid)
                .is_some_and(|list| !list.is_empty())
            {
                continue;
            }
            for &sid in sids {
                if let Some(&pos) = sid_index.get(sid) {
                    source_to_venues[pos].1.push(vid);
                } else {
                    sid_index.insert(sid, source_to_venues.len());
                    source_to_venues.push((sid, vec![vid]));
                }
            }
        }

        let mut claimed_wids: HashSet<i64> = HashSet::new();
        for (sid, vids) in source_to_venues {
            if oa_rate_limited {
                break;
            }
            let mut remaining: Vec<WorkRefTarget> = Vec::new();
            let mut seen_wids: HashSet<i64> = HashSet::new();
            for vid in vids {
                if let Some(list) = targets_by_venue.get(vid) {
                    for t in list {
                        if !claimed_wids.contains(&t.work_id) && seen_wids.insert(t.work_id) {
                            remaining.push(t.clone());
                        }
                    }
                }
            }
            if remaining.is_empty() {
                continue;
            }

            for page in 1..=MAX_OA_SOURCE_PAGES {
                if remaining.is_empty() {
                    break;
                }
                acquire_rate_slot(&oa_next_slot, Duration::from_millis(120)).await;
                let url = format!(
                    "https://api.openalex.org/works?filter=locations.source.id:{sid},publication_year:2026&per-page=200&page={page}&select={OPENALEX_SELECT}&mailto={OPENALEX_MAILTO}{oa_key_param}"
                );
                match fetch_openalex_json(&client, &url).await {
                    OpenAlexFetchResult::Ok(json) => {
                        let result_len = json
                            .get("results")
                            .and_then(Value::as_array)
                            .map_or(0, Vec::len);
                        let total_count = json
                            .pointer("/meta/count")
                            .and_then(Value::as_u64)
                            .map(|n| n as usize);
                        if result_len == 0 {
                            break;
                        }

                        let updates = match_source_page_results_to_targets(&remaining, &json);
                        if !updates.is_empty() {
                            let matched_set: HashSet<i64> =
                                updates.iter().map(|u| u.work_id).collect();
                            claimed_wids.extend(&matched_set);
                            remaining.retain(|t| !matched_set.contains(&t.work_id));

                            let db_p = db_path.to_path_buf();
                            oa_enriched += tokio::task::spawn_blocking(move || {
                                persist_ref_batch(&db_p, &updates)
                            })
                            .await
                            .map_err(|e| {
                                AppError::message(format!("persist oa source batch: {e}"))
                            })??;
                        }

                        if result_len < 200 || total_count.is_some_and(|total| page * 200 >= total)
                        {
                            break;
                        }
                    }
                    OpenAlexFetchResult::RateLimited => {
                        oa_rate_limited = true;
                        break;
                    }
                    OpenAlexFetchResult::NotFound | OpenAlexFetchResult::Error => break,
                }
            }
        }
    }

    // Stage 2.3: Free Semantic Scholar Batch (0 OpenAlex credits) BEFORE `title.search`
    let mut s2_enriched = 0usize;
    let db_rem = db_path.to_path_buf();
    let s2_primary_targets: Vec<(i64, String)> =
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
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })?;
            let mut list = Vec::new();
            for entry in rows {
                let (wid, d_opt, a_opt) = entry?;
                if let Some(d) = d_opt.as_deref().and_then(clean_publisher_doi) {
                    list.push((wid, format!("DOI:{d}")));
                } else if let Some(a) = a_opt.as_deref().and_then(clean_arxiv_key) {
                    list.push((wid, format!("ARXIV:{a}")));
                }
            }
            Ok(list)
        })
        .await
        .map_err(|e| AppError::message(format!("seed_bake load s2 targets: {e}")))??;
    s2_enriched +=
        run_s2_batch_pass(&client, db_path, &s2_primary_targets, "persist s2 batch").await?;

    let db_rem2 = db_path.to_path_buf();
    let s2_arxiv_fallback_targets: Vec<(i64, String)> =
        tokio::task::spawn_blocking(move || -> Result<_, AppError> {
            let conn = ensure_collection_at(&db_rem2)?;
            let mut stmt = conn.prepare(
                "SELECT cw.work_id, cw.arxiv_id_norm
                 FROM canonical_works cw
                 WHERE NOT EXISTS (SELECT 1 FROM paper_raw_refs r WHERE r.src_work_id = cw.work_id)
                   AND cw.doi_norm IS NOT NULL
                   AND cw.arxiv_id_norm IS NOT NULL
                 ORDER BY cw.work_id ASC",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            let mut list = Vec::new();
            for entry in rows {
                let (wid, a_raw) = entry?;
                if let Some(a) = clean_arxiv_key(&a_raw) {
                    list.push((wid, format!("ARXIV:{a}")));
                }
            }
            Ok(list)
        })
        .await
        .map_err(|e| AppError::message(format!("seed_bake load s2 arxiv fallback: {e}")))??;
    s2_enriched += run_s2_batch_pass(
        &client,
        db_path,
        &s2_arxiv_fallback_targets,
        "persist s2 arxiv batch",
    )
    .await?;

    // Stage 2.4: Dynamic Byte-Packed OpenAlex `title.search` (<=7800 URI bytes, up to 75 titles/call)
    let mut newly_discovered_s2: Vec<(i64, String)> = Vec::new();
    if !oa_rate_limited {
        let db_a25 = db_path.to_path_buf();
        let ttl_for_a25 = venue_ttl_cutoff.clone();
        let a25_targets = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
            let conn = ensure_collection_at(&db_a25)?;
            load_pass_a2_5_targets(&conn, &ttl_for_a25)
        })
        .await
        .map_err(|e| AppError::message(format!("seed_bake load 2.4 targets: {e}")))??;

        let url_prefix = "https://api.openalex.org/works?filter=title.search:";
        let encoded_select = urlencoding::encode(OPENALEX_SELECT);
        let url_suffix_p1 = format!(
            ",from_publication_date:2024-01-01&per-page=200&page=1&select={encoded_select}&mailto={OPENALEX_MAILTO}{oa_key_param}"
        );
        let batches =
            pack_title_search_batches(&a25_targets, url_prefix.len(), url_suffix_p1.len());

        let mut calls_used = 0usize;
        for (target_indices, clauses) in batches {
            if calls_used >= MAX_OA_TITLE_SEARCH_CALLS {
                log::info!(
                    "seed_bake Stage 2.4 reached per-run cap ({MAX_OA_TITLE_SEARCH_CALLS} calls); stopping cleanly"
                );
                break;
            }
            let chunk: Vec<WorkRefTarget> = target_indices
                .iter()
                .map(|&idx| a25_targets[idx].clone())
                .collect();
            let joined = clauses.join("|");
            let mut merged_results: Vec<Value> = Vec::new();
            let mut batch_failed = false;

            for page in 1..=2usize {
                if calls_used >= MAX_OA_TITLE_SEARCH_CALLS {
                    batch_failed = page == 1;
                    break;
                }
                acquire_rate_slot(&oa_next_slot, Duration::from_millis(120)).await;
                calls_used += 1;
                let url = format!(
                    "{url_prefix}{joined},from_publication_date:2024-01-01&per-page=200&page={page}&select={encoded_select}&mailto={OPENALEX_MAILTO}{oa_key_param}"
                );
                match fetch_openalex_json(&client, &url).await {
                    OpenAlexFetchResult::Ok(json) => {
                        let page_results = json
                            .get("results")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let total_count = json
                            .pointer("/meta/count")
                            .and_then(Value::as_u64)
                            .unwrap_or(0) as usize;
                        let page_len = page_results.len();
                        merged_results.extend(page_results);
                        if page_len < 200 || page * 200 >= total_count {
                            break;
                        }
                    }
                    OpenAlexFetchResult::NotFound => break,
                    OpenAlexFetchResult::RateLimited | OpenAlexFetchResult::Error => {
                        batch_failed = true;
                        break;
                    }
                }
            }
            if batch_failed {
                break;
            }

            if !merged_results.is_empty() {
                let agg_json = serde_json::json!({ "results": merged_results });
                let updates = match_title_search_results_to_targets(&chunk, &agg_json);
                for u in &updates {
                    if u.refs.is_empty() {
                        if let Some(ref a) = u.arxiv_id {
                            newly_discovered_s2.push((u.work_id, format!("ARXIV:{a}")));
                        } else if let Some(ref d) = u.pub_doi {
                            newly_discovered_s2.push((u.work_id, format!("DOI:{d}")));
                        }
                    }
                }
                if !updates.is_empty() {
                    let db_p = db_path.to_path_buf();
                    oa_enriched +=
                        tokio::task::spawn_blocking(move || persist_ref_batch(&db_p, &updates))
                            .await
                            .map_err(|e| {
                                AppError::message(format!("persist oa title.search batch: {e}"))
                            })??;
                }
            }
            let checked_wids: Vec<i64> = chunk.iter().map(|t| t.work_id).collect();
            let db_chk = db_path.to_path_buf();
            tokio::task::spawn_blocking(move || mark_works_refs_checked(&db_chk, &checked_wids))
                .await
                .map_err(|e| AppError::message(format!("mark refs_checked_at: {e}")))??;
        }
    }

    if !newly_discovered_s2.is_empty() {
        s2_enriched += run_s2_batch_pass(
            &client,
            db_path,
            &newly_discovered_s2,
            "persist s2 post-title batch",
        )
        .await?;
    }

    let db_recomp = db_path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        with_collection_write_conn(&db_recomp, |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            recompute_graph_and_citations_tx(&tx)?;
            tx.commit()?;
            Ok(())
        })
    })
    .await
    .map_err(|e| AppError::message(format!("seed_bake recompute graph: {e}")))??;

    Ok((oa_enriched, s2_enriched))
}

#[cfg(test)]
fn match_openalex_results_to_targets(
    targets: &[&WorkRefTarget],
    json: &Value,
) -> Vec<WorkRefUpdate> {
    let Some(results) = json.get("results").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut by_oa: HashMap<&str, usize> = HashMap::new();
    let mut by_doi: HashMap<&str, usize> = HashMap::new();
    let mut by_arxiv: HashMap<&str, usize> = HashMap::new();
    for (idx, t) in targets.iter().enumerate() {
        if let Some(ref oa) = t.openalex_id {
            by_oa.entry(oa.as_str()).or_insert(idx);
        }
        if let Some(ref d) = t.doi_norm {
            by_doi.entry(d.as_str()).or_insert(idx);
        }
        if let Some(ref a) = t.arxiv_id_norm {
            by_arxiv.entry(a.as_str()).or_insert(idx);
        }
    }

    let mut matched_indices: HashSet<usize> = HashSet::new();
    let mut by_target_idx: HashMap<usize, WorkRefUpdate> = HashMap::new();
    let mut order: Vec<usize> = Vec::new();

    for work in results {
        let Some(parsed) = parse_openalex_work(work) else {
            continue;
        };

        let exact_idx = parsed
            .openalex_id
            .as_deref()
            .and_then(|k| by_oa.get(k).copied())
            .or_else(|| {
                parsed
                    .pub_doi
                    .as_deref()
                    .and_then(|k| by_doi.get(k).copied())
            })
            .or_else(|| {
                parsed
                    .arxiv_id
                    .as_deref()
                    .and_then(|k| by_arxiv.get(k).copied())
            });

        let matched_idx = if let Some(idx) = exact_idx {
            Some(idx)
        } else {
            // Fallback for `10.48550/arxiv.{aid}` lookups where OpenAlex resolved to the
            // published conference DOI with `ids.arxiv = null`: match by title + authors
            // within this chunk, requiring a unique compatible target and no ID conflicts.
            let candidates: Vec<usize> = targets
                .iter()
                .enumerate()
                .filter(|(idx, t)| {
                    !matched_indices.contains(idx)
                        && verify_target_title_and_authors(t, &parsed, false)
                        && target_ids_compatible(t, &parsed)
                })
                .map(|(idx, _)| idx)
                .collect();
            match candidates.as_slice() {
                &[single] => Some(single),
                _ => None,
            }
        };

        let Some(idx) = matched_idx else {
            continue;
        };
        let t = targets[idx];
        matched_indices.insert(idx);

        if parsed.openalex_id.is_some()
            || parsed.pub_doi.is_some()
            || parsed.arxiv_id.is_some()
            || parsed.abstract_text.is_some()
            || !parsed.refs.is_empty()
        {
            if let Some(existing) = by_target_idx.get_mut(&idx) {
                merge_parsed_into_update(existing, &parsed);
            } else {
                order.push(idx);
                by_target_idx.insert(
                    idx,
                    WorkRefUpdate {
                        work_id: t.work_id,
                        openalex_id: parsed.openalex_id,
                        pub_doi: parsed.pub_doi,
                        arxiv_id: parsed.arxiv_id,
                        abstract_text: parsed.abstract_text,
                        refs: parsed.refs,
                    },
                );
            }
        }
    }

    order
        .into_iter()
        .filter_map(|idx| by_target_idx.remove(&idx))
        .collect()
}

fn match_source_page_results_to_targets(
    targets: &[WorkRefTarget],
    json: &Value,
) -> Vec<WorkRefUpdate> {
    let Some(results) = json.get("results").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut by_doi: HashMap<&str, usize> = HashMap::new();
    let mut by_arxiv: HashMap<&str, usize> = HashMap::new();
    let mut by_title: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, t) in targets.iter().enumerate() {
        if let Some(ref d) = t.doi_norm {
            by_doi.entry(d.as_str()).or_insert(idx);
        }
        if let Some(ref a) = t.arxiv_id_norm {
            by_arxiv.entry(a.as_str()).or_insert(idx);
        }
        let tk = norm_title_key(&t.title);
        if !tk.is_empty() {
            by_title.entry(tk).or_default().push(idx);
        }
    }

    let mut matched_indices: HashSet<usize> = HashSet::new();
    let mut out: Vec<WorkRefUpdate> = Vec::new();
    for work in results {
        let Some(parsed) = parse_openalex_work(work) else {
            continue;
        };
        let exact_idx = parsed
            .pub_doi
            .as_deref()
            .and_then(|d| by_doi.get(d).copied())
            .or_else(|| {
                parsed
                    .arxiv_id
                    .as_deref()
                    .and_then(|a| by_arxiv.get(a).copied())
            });

        let matched_idx = if let Some(idx) = exact_idx.filter(|i| !matched_indices.contains(i)) {
            Some(idx)
        } else {
            let tk = norm_title_key(&parsed.title);
            by_title.get(&tk).and_then(|cand_indices| {
                let valid: Vec<usize> = cand_indices
                    .iter()
                    .copied()
                    .filter(|idx| {
                        let t = &targets[*idx];
                        !matched_indices.contains(idx)
                            && verify_target_title_and_authors(t, &parsed, true)
                            && target_ids_compatible(t, &parsed)
                    })
                    .collect();
                match valid.as_slice() {
                    &[single] => Some(single),
                    _ => None,
                }
            })
        };

        let Some(idx) = matched_idx else {
            continue;
        };
        matched_indices.insert(idx);
        let t = &targets[idx];
        if parsed.openalex_id.is_some()
            || parsed.pub_doi.is_some()
            || parsed.arxiv_id.is_some()
            || parsed.abstract_text.is_some()
            || !parsed.refs.is_empty()
        {
            out.push(WorkRefUpdate {
                work_id: t.work_id,
                openalex_id: parsed.openalex_id,
                pub_doi: parsed.pub_doi,
                arxiv_id: parsed.arxiv_id,
                abstract_text: parsed.abstract_text,
                refs: parsed.refs,
            });
        }
    }
    out
}

fn match_title_search_results_to_targets(
    targets: &[WorkRefTarget],
    json: &Value,
) -> Vec<WorkRefUpdate> {
    let Some(results) = json.get("results").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut by_title: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, t) in targets.iter().enumerate() {
        let tk = norm_title_key(&t.title);
        if !tk.is_empty() {
            by_title.entry(tk).or_default().push(idx);
        }
    }

    let mut matched_by_idx: HashMap<usize, Vec<ParsedOpenAlexWork>> = HashMap::new();
    for work in results {
        let Some(parsed) = parse_openalex_work(work) else {
            continue;
        };
        let tk = norm_title_key(&parsed.title);
        let Some(cand_indices) = by_title.get(&tk) else {
            continue;
        };
        let valid: Vec<usize> = cand_indices
            .iter()
            .copied()
            .filter(|idx| {
                let t = &targets[*idx];
                verify_target_title_and_authors(t, &parsed, true)
                    && target_ids_compatible(t, &parsed)
            })
            .collect();
        if valid.len() == 1 {
            matched_by_idx.entry(valid[0]).or_default().push(parsed);
        }
    }

    let mut out = Vec::new();
    for (idx, t) in targets.iter().enumerate() {
        let Some(mut hits) = matched_by_idx.remove(&idx) else {
            continue;
        };
        if t.authors.is_empty() && hits.len() > 1 {
            let distinct_authors = hits.windows(2).any(|w| {
                !w[0].authors.is_empty()
                    && !w[1].authors.is_empty()
                    && !same_work_by_title_and_authors(
                        &w[0].title,
                        &w[0].authors,
                        &w[1].title,
                        &w[1].authors,
                    )
            });
            if distinct_authors {
                continue;
            }
        }
        // Prefer richer record (has publisher DOI, then more referenced_works) as primary metadata,
        // and union refs across matching preprint/conference twins.
        hits.sort_by(|a, b| {
            b.pub_doi
                .is_some()
                .cmp(&a.pub_doi.is_some())
                .then_with(|| b.refs.len().cmp(&a.refs.len()))
        });
        let mut iter = hits.into_iter();
        let first = iter.next().unwrap();
        let mut upd = WorkRefUpdate {
            work_id: t.work_id,
            openalex_id: first.openalex_id,
            pub_doi: first.pub_doi,
            arxiv_id: first.arxiv_id,
            abstract_text: first.abstract_text,
            refs: first.refs,
        };
        for extra in iter {
            merge_parsed_into_update(&mut upd, &extra);
        }
        if upd.openalex_id.is_some()
            || upd.pub_doi.is_some()
            || upd.arxiv_id.is_some()
            || upd.abstract_text.is_some()
            || !upd.refs.is_empty()
        {
            out.push(upd);
        }
    }
    out
}

pub(crate) fn extract_s2_ref_keys(ext: &Value) -> Vec<String> {
    let mut refs = Vec::new();
    if let Some(raw_doi) = ext.get("DOI").and_then(Value::as_str) {
        if !is_artifact_or_dataset_doi(raw_doi) {
            if let Some(d) = normalize_ref_key(raw_doi) {
                refs.push(d);
            }
        }
    }
    if let Some(a) = ext
        .get("ArXiv")
        .and_then(Value::as_str)
        .and_then(clean_arxiv_key)
    {
        let key = format!("arxiv:{a}");
        if !refs.contains(&key) {
            refs.push(key);
        }
    }
    if let Some(raw_acl) = ext.get("ACL").and_then(Value::as_str) {
        let mut acl_clean = raw_acl.trim().to_ascii_lowercase();
        for prefix in [
            "https://doi.org/",
            "http://doi.org/",
            "doi:",
            "10.18653/v1/",
        ] {
            if let Some(rest) = acl_clean.strip_prefix(prefix) {
                acl_clean = rest.trim().to_string();
            }
        }
        if !acl_clean.is_empty() {
            let acl_doi = format!("10.18653/v1/{acl_clean}");
            if !is_artifact_or_dataset_doi(&acl_doi) {
                let key = format!("doi:{acl_doi}");
                if !refs.contains(&key) {
                    refs.push(key);
                }
            }
        }
    }
    refs
}

async fn fetch_s2_batch_with_bisect(
    client: &reqwest::Client,
    slice: &[(i64, String)],
) -> Result<Vec<WorkRefUpdate>, AppError> {
    if slice.is_empty() {
        return Ok(Vec::new());
    }
    let mut pending: Vec<&[(i64, String)]> = vec![slice];
    let mut collected: Vec<WorkRefUpdate> = Vec::new();
    let url =
        "https://api.semanticscholar.org/graph/v1/paper/batch?fields=externalIds,references.externalIds";

    while let Some(cur) = pending.pop() {
        if cur.is_empty() {
            continue;
        }
        tokio::time::sleep(Duration::from_millis(1100)).await;
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
                                        for key in extract_s2_ref_keys(ext) {
                                            if !refs.contains(&key) {
                                                refs.push(key);
                                            }
                                        }
                                    }
                                }
                                if !refs.is_empty() {
                                    collected.push(WorkRefUpdate {
                                        work_id: wid,
                                        openalex_id: None,
                                        pub_doi: None,
                                        arxiv_id: None,
                                        abstract_text: None,
                                        refs,
                                    });
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

const BAKE_KEYWORD_SYSTEM_PROMPT: &str = "\
Extract 4 to 6 canonical English academic keywords for each paper from its Title and Abstract.
Rules:
- Output ONLY a valid JSON object mapping each paper index string to an array of 4-6 strings, with no markdown fences and no commentary.
- Cover BOTH (1) the research subfield or problem category (e.g., Code Generation, Vulnerability Detection, Program Repair, Smart Contract Security, Prompt Injection, Medical Image Segmentation) AND (2) the core technique or methodology class (e.g., Fuzzing, Random Testing, Unit Test Generation, Static Analysis, Symbolic Execution, Formal Verification, Type System, AI Agent, Low-Rank Adaptation).
- Format every keyword as a general, reusable, singular noun phrase in English Title Case (1-4 words, preserving standard acronyms like LLM, RAG, eBPF, SMT) suitable for cross-paper clustering and search.
- STRICTLY FORBID paper-coined system, method, tool, framework, model, dataset, or benchmark names and title acronyms (never output bespoke names like VulnGPT, AutoFuzz, DuFP, Tree-of-Mutations, VulnFuzz, RankSeg).
- STRICTLY FORBID generic academic filler (paper, study, method, approach, proposed, framework, system, analysis, experiment, evaluation, performance, benchmark) and overly broad top-level disciplines (Computer Science, Software Engineering, Artificial Intelligence).
- Even if the Abstract is missing, very short, or a conference roster placeholder, ALWAYS infer 4 to 6 accurate academic keywords from the Title and any Venue/Field context; NEVER return an empty array [].

Example Input:
[0] Title: VulnFuzz: Fuzzing Smart Contracts via Symbolic Taint Guided Mutation | Abstract: Smart contract vulnerabilities cause severe financial losses. We present VulnFuzz, combining static taint tracking with coverage-guided fuzzing and symbolic execution on EVM bytecode to uncover reentrancy and integer overflow bugs.
[1] Title: RankSeg: Low-Rank Adaptation of Vision-Language Models for Few-Shot Medical Segmentation | Abstract: Adapting large vision-language foundation models to volumetric CT and MRI scans is memory intensive. We introduce RankSeg, using rank-decomposed cross-modal adapters that tune 0.8% parameters for few-shot organ segmentation.

Example Output:
{\"0\":[\"Smart Contract Security\",\"Vulnerability Detection\",\"Coverage-Guided Fuzzing\",\"Taint Analysis\",\"Symbolic Execution\"],\"1\":[\"Medical Image Segmentation\",\"Few-Shot Learning\",\"Vision-Language Model\",\"Low-Rank Adaptation\",\"Parameter-Efficient Fine-Tuning\"]}";

fn collapse_whitespace(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_roster_placeholder_abstract(collapsed_abs: &str, source_label: &str) -> bool {
    if collapsed_abs.is_empty() {
        return true;
    }
    if collapsed_abs
        .to_ascii_lowercase()
        .ends_with("accepted paper")
    {
        return true;
    }
    let sl = source_label.trim();
    if !sl.is_empty() && collapsed_abs.eq_ignore_ascii_case(sl) {
        return true;
    }
    collapsed_abs.contains(" · ") && collapsed_abs.chars().count() <= 84
}

fn build_paper_context_hint(paper: &LlmPaperTarget) -> String {
    let mut parts = Vec::new();
    let sl = collapse_whitespace(&paper.source_label);
    if !sl.is_empty() {
        parts.push(sl);
    }
    let cats: Vec<String> = paper
        .categories
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .map(str::to_string)
        .collect();
    if !cats.is_empty() {
        parts.push(cats.join(", "));
    }
    parts.join("; ")
}

fn build_bake_llm_messages(chunk: &[LlmPaperTarget]) -> Value {
    let mut user_lines = Vec::with_capacity(chunk.len());
    for (idx, p) in chunk.iter().enumerate() {
        let title = collapse_whitespace(&p.title);
        let abs_collapsed = collapse_whitespace(&p.abstract_text);
        let ctx = build_paper_context_hint(p);
        let line = if is_roster_placeholder_abstract(&abs_collapsed, &p.source_label) {
            if ctx.is_empty() {
                format!("[{idx}] Title: {title}")
            } else {
                format!("[{idx}] Title: {title} | Abstract: (Title-only entry; Venue/Field: {ctx})")
            }
        } else {
            let abs_full = if abs_collapsed.chars().count() < 48 && !ctx.is_empty() {
                format!("{abs_collapsed} (Venue/Field: {ctx})")
            } else {
                abs_collapsed
            };
            format!("[{idx}] Title: {title} | Abstract: {abs_full}")
        };
        user_lines.push(line);
    }

    serde_json::json!([
        {
            "role": "system",
            "content": BAKE_KEYWORD_SYSTEM_PROMPT
        },
        {
            "role": "user",
            "content": user_lines.join("\n")
        }
    ])
}

fn strip_think_blocks_ci(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(open_pos) = rest.to_ascii_lowercase().find("<think>") {
        out.push_str(&rest[..open_pos]);
        let after_open = &rest[open_pos + "<think>".len()..];
        if let Some(close_pos) = after_open.to_ascii_lowercase().find("</think>") {
            rest = &after_open[close_pos + "</think>".len()..];
        } else {
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

fn extract_string_array_canon(val: &Value) -> Vec<String> {
    let Some(kws_arr) = val.as_array() else {
        return Vec::new();
    };
    let raw_kws: Vec<String> = kws_arr
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    canonicalize_keywords(&raw_kws)
}

fn parse_index_key(raw: &str) -> Option<usize> {
    raw.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim()
        .parse::<usize>()
        .ok()
}

fn parse_llm_keyword_batch_json(content: &str, expected_len: usize) -> HashMap<usize, Vec<String>> {
    if expected_len == 0 {
        return HashMap::new();
    }
    let cleaned = strip_think_blocks_ci(content);
    let json_slice = extract_json_payload(cleaned.trim());
    let Ok(val) = serde_json::from_str::<Value>(json_slice) else {
        return HashMap::new();
    };

    let mut out = HashMap::new();
    match &val {
        Value::Object(map) => {
            if let Some(arr) = map.get("items").and_then(Value::as_array) {
                for (pos, entry) in arr.iter().enumerate() {
                    let Some(kws_val) = entry.get("keywords") else {
                        continue;
                    };
                    let idx = entry
                        .get("idx")
                        .and_then(|v| {
                            v.as_u64()
                                .map(|n| n as usize)
                                .or_else(|| v.as_str().and_then(parse_index_key))
                        })
                        .unwrap_or(pos);
                    if idx < expected_len {
                        let canon = extract_string_array_canon(kws_val);
                        if !canon.is_empty() {
                            out.insert(idx, canon);
                        }
                    }
                }
            }

            for (k, v) in map {
                if k == "items" {
                    continue;
                }
                if let Some(idx) = parse_index_key(k) {
                    if idx < expected_len {
                        let canon = extract_string_array_canon(v);
                        if !canon.is_empty() {
                            out.insert(idx, canon);
                        }
                    }
                }
            }

            if out.is_empty() && expected_len == 1 {
                if let Some(kws_val) = map.get("keywords") {
                    let canon = extract_string_array_canon(kws_val);
                    if !canon.is_empty() {
                        out.insert(0, canon);
                    }
                }
            }
        }
        Value::Array(arr) if expected_len == 1 && !arr.iter().any(Value::is_object) => {
            let canon = extract_string_array_canon(&val);
            if !canon.is_empty() {
                out.insert(0, canon);
            }
        }
        _ => {}
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

/// Guard against an LLM echoing a paper's bespoke coined tool/model prefix before `:`
/// (e.g., `"DuFP: ..."`, `"VulnGPT: ..."`, `"AutoFuzz: ..."`), while preserving standard
/// technical names such as `eBPF`, `WebAssembly`, `GraphQL`, `JavaScript`, `TypeScript`,
/// `PyTorch`, `OpenMP`, `CodeQL`, or `LoRA`.
fn strip_bespoke_title_prefix(title: &str, kws: Vec<String>) -> Vec<String> {
    let Some((raw_prefix, _)) = title.split_once(':') else {
        return kws;
    };
    let prefix = raw_prefix
        .trim()
        .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-');
    if prefix.len() < 3 || prefix.len() > 28 || prefix.contains(char::is_whitespace) {
        return kws;
    }
    const ALLOWED_STANDARD_CAMEL: &[&str] = &[
        "ebpf",
        "webassembly",
        "graphql",
        "javascript",
        "typescript",
        "pytorch",
        "openmp",
        "codeql",
        "lora",
        "qlora",
        "deepseek",
        "riscv",
        "risc-v",
        "llvm",
        "mlir",
        "wasm",
    ];
    let lower_prefix = prefix.to_ascii_lowercase();
    if ALLOWED_STANDARD_CAMEL.contains(&lower_prefix.as_str()) {
        return kws;
    }
    let chars: Vec<char> = prefix.chars().collect();
    let has_internal_camel = chars
        .windows(2)
        .any(|w| w[0].is_ascii_lowercase() && w[1].is_ascii_uppercase())
        || chars.windows(3).any(|w| {
            w[0].is_ascii_uppercase() && w[1].is_ascii_uppercase() && w[2].is_ascii_lowercase()
        });
    let has_hyphen_coinage = prefix.contains('-')
        && SYNONYM_GROUPS.iter().all(|g| {
            !g.canonical.eq_ignore_ascii_case(prefix)
                && !g.aliases.iter().any(|a| a.eq_ignore_ascii_case(prefix))
        });

    if !has_internal_camel && !has_hyphen_coinage {
        return kws;
    }

    kws.into_iter()
        .filter(|kw| !kw.trim().eq_ignore_ascii_case(prefix))
        .collect()
}

fn contains_ascii_phrase_boundary(haystack_lower: &str, phrase_lower: &str) -> bool {
    if phrase_lower.len() < 3 {
        return false;
    }
    let bytes = haystack_lower.as_bytes();
    let p_len = phrase_lower.len();
    let mut start = 0usize;
    while let Some(rel) = haystack_lower[start..].find(phrase_lower) {
        let pos = start + rel;
        let end = pos + p_len;
        let left_ok = pos == 0 || !bytes[pos - 1].is_ascii_alphanumeric();
        let right_ok = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if left_ok && right_ok {
            return true;
        }
        start = pos + 1;
    }
    false
}

/// Deterministic zero-empty safety net when a paper has a non-empty `title` (even with an
/// empty or conference-roster placeholder abstract) and the LLM returned only filtered noise.
fn fallback_keywords_from_title_and_context(paper: &LlmPaperTarget) -> Vec<String> {
    let title = collapse_whitespace(&paper.title);
    if title.is_empty() {
        return Vec::new();
    }
    let abs = collapse_whitespace(&paper.abstract_text);
    let searchable = if is_roster_placeholder_abstract(&abs, &paper.source_label) {
        title.to_ascii_lowercase()
    } else {
        format!("{} {}", title, abs).to_ascii_lowercase()
    };

    let mut matched_raw: Vec<String> = Vec::new();
    for group in SYNONYM_GROUPS {
        let hit = std::iter::once(group.canonical)
            .chain(group.aliases.iter().copied())
            .any(|term| {
                let tl = term.to_ascii_lowercase();
                tl.len() >= 4 && contains_ascii_phrase_boundary(&searchable, &tl)
            });
        if hit {
            matched_raw.push(group.canonical.to_string());
            if matched_raw.len() >= 5 {
                break;
            }
        }
    }

    // Domain context supplement from arXiv categories / venue label so even abstract-less
    // papers with novel terminology receive valid canonical subfield keywords.
    let ctx_lower =
        format!("{} {}", paper.categories.join(" "), paper.source_label).to_ascii_lowercase();
    if matched_raw.len() < 2 {
        if ctx_lower.contains("cs.cr")
            || ctx_lower.contains("security")
            || ctx_lower.contains("usenix")
            || ctx_lower.contains("ccs")
            || ctx_lower.contains("ndss")
            || ctx_lower.contains("crypt")
        {
            matched_raw.push("System Security".to_string());
        }
        if ctx_lower.contains("cs.se")
            || ctx_lower.contains("icse")
            || ctx_lower.contains("fse")
            || ctx_lower.contains("ase")
            || ctx_lower.contains("issta")
            || ctx_lower.contains("tosem")
            || ctx_lower.contains("tse")
        {
            matched_raw.push("Program Analysis".to_string());
        }
        if ctx_lower.contains("cs.pl")
            || ctx_lower.contains("popl")
            || ctx_lower.contains("pldi")
            || ctx_lower.contains("oopsla")
            || ctx_lower.contains("icfp")
        {
            matched_raw.push("Programming Language".to_string());
        }
        if ctx_lower.contains("cs.ai")
            || ctx_lower.contains("cs.lg")
            || ctx_lower.contains("neurips")
            || ctx_lower.contains("icml")
            || ctx_lower.contains("iclr")
            || ctx_lower.contains("aaai")
        {
            matched_raw.push("Machine Learning".to_string());
        }
        if ctx_lower.contains("cs.cl") || ctx_lower.contains("acl") || ctx_lower.contains("emnlp") {
            matched_raw.push("Natural Language Processing".to_string());
        }
        if ctx_lower.contains("cs.cv") || ctx_lower.contains("cvpr") || ctx_lower.contains("iccv") {
            matched_raw.push("Computer Vision".to_string());
        }
    }

    if matched_raw.is_empty() {
        matched_raw.push("Program Analysis".to_string());
    }

    let canon = strip_bespoke_title_prefix(&title, canonicalize_keywords(&matched_raw));
    if canon.is_empty() {
        vec!["Program Analysis".to_string()]
    } else {
        canon.into_iter().take(6).collect()
    }
}

struct LlmBakeClientCtx {
    client: reqwest::Client,
    endpoint: String,
    model: String,
    api_key: Option<String>,
    reasoning_rejected: Arc<AtomicBool>,
    rate_limiter: Option<(Arc<tokio::sync::Mutex<tokio::time::Instant>>, Duration)>,
}

async fn request_llm_keywords_with_patient_backoff(
    ctx: &LlmBakeClientCtx,
    chunk: &[LlmPaperTarget],
) -> Result<HashMap<usize, Vec<String>>, AppError> {
    let messages = build_bake_llm_messages(chunk);

    let mut last_err = String::new();
    for (attempt, &base_secs) in LLM_RETRY_DELAYS_SECS.iter().enumerate() {
        match send_chat_with_reasoning_fallback(
            &ChatFallbackRequest {
                client: &ctx.client,
                endpoint: &ctx.endpoint,
                model: &ctx.model,
                api_key: ctx.api_key.as_deref(),
                messages: &messages,
                max_tokens: None,
                reasoning_rejected: Some(ctx.reasoning_rejected.as_ref()),
            },
            || async {
                if let Some((ref slot, interval)) = ctx.rate_limiter {
                    acquire_rate_slot(slot, interval).await;
                }
            },
        )
        .await
        {
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
                    let content = extract_chat_message_content(&body_val);
                    if content.is_empty() {
                        last_err = "empty assistant content".to_string();
                        tokio::time::sleep(Duration::from_secs(base_secs)).await;
                        continue;
                    }
                    let parsed = parse_llm_keyword_batch_json(&content, chunk.len());
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
    ctx: &LlmBakeClientCtx,
    chunk: Vec<LlmPaperTarget>,
) -> Result<Vec<(LlmPaperTarget, Vec<String>)>, AppError> {
    let batch_map = request_llm_keywords_with_patient_backoff(ctx, &chunk).await?;
    let mut out = Vec::with_capacity(chunk.len());
    for (idx, paper) in chunk.into_iter().enumerate() {
        let cleaned_batch = batch_map
            .get(&idx)
            .cloned()
            .map(|kws| strip_bespoke_title_prefix(&paper.title, kws))
            .unwrap_or_default();
        if !cleaned_batch.is_empty() {
            out.push((paper, cleaned_batch));
            continue;
        }

        // Single-paper patient retry so partial batch omissions or title-only entries are never dropped.
        let single_slice = std::slice::from_ref(&paper);
        let single_kws = match request_llm_keywords_with_patient_backoff(ctx, single_slice).await {
            Ok(single_map) => single_map
                .get(&0)
                .cloned()
                .map(|kws| strip_bespoke_title_prefix(&paper.title, kws))
                .unwrap_or_default(),
            Err(err) => {
                log::warn!(
                    "seed_bake single-paper LLM fallback failed for {}: {err}; using title/context fallback",
                    paper.id
                );
                Vec::new()
            }
        };

        let final_kws = if single_kws.is_empty() {
            fallback_keywords_from_title_and_context(&paper)
        } else {
            single_kws
        };
        if !final_kws.is_empty() {
            out.push((paper, final_kws));
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
    with_collection_write_conn(db_path, |conn| {
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
    })
}

async fn run_step_b_llm_bake(db_path: &Path, opts: &SeedBakeOptions) -> Result<usize, AppError> {
    let db_load = db_path.to_path_buf();
    let force_clean = opts.force_clean;
    let targets: Vec<LlmPaperTarget> =
        tokio::task::spawn_blocking(move || -> Result<_, AppError> {
            let conn = ensure_collection_at(&db_load)?;
            let sql = if force_clean {
                "SELECT id, title, abstract_text, categories_json, source_label
                 FROM papers
                 WHERE keyword_source != 'author'
                   AND TRIM(title) != ''
                 ORDER BY row_id ASC"
            } else {
                "SELECT id, title, abstract_text, categories_json, source_label
                 FROM papers
                 WHERE (keywords_json = '[]' OR keyword_source NOT IN ('author', 'maintainer_llm'))
                   AND TRIM(title) != ''
                 ORDER BY row_id ASC"
            };
            let mut stmt = conn.prepare(sql)?;
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

    let endpoint = resolve_openai_compatible_url(
        &opts.llm_base_url,
        DEFAULT_BAKE_LLM_BASE_URL,
        "/chat/completions",
    )
    .map_err(AppError::message)?
    .to_string();
    let model = opts.llm_model.trim().to_string();
    let api_key = opts.llm_api_key.clone();
    let effective_rpm = opts.llm_rpm;
    let rate_limiter = (effective_rpm > 0).then(|| {
        let interval_ms = (60_500u64 / u64::from(effective_rpm)).max(1);
        (
            Arc::new(tokio::sync::Mutex::new(tokio::time::Instant::now())),
            Duration::from_millis(interval_ms),
        )
    });
    let concurrency = opts.llm_concurrency.clamp(1, 32);
    let batch_size = opts.llm_batch_size.clamp(1, 32);
    let client = crate::http::client_with(Duration::from_secs(180), 5, crate::http::USER_AGENT)?;

    let ctx = Arc::new(LlmBakeClientCtx {
        client,
        endpoint,
        model,
        api_key,
        reasoning_rejected: Arc::new(AtomicBool::new(false)),
        rate_limiter,
    });

    let total_targets = targets.len();
    let chunks: Vec<Vec<LlmPaperTarget>> = targets.chunks(batch_size).map(|c| c.to_vec()).collect();
    let total_chunks = chunks.len();
    let started_at = Instant::now();
    if total_chunks > 1 {
        eprintln!(
            "[seed-bake llm] {} papers in {} batches (batch_size={}, concurrency={}, rpm={})",
            total_targets, total_chunks, batch_size, concurrency, effective_rpm
        );
    }

    let mut futs = stream::iter(chunks.into_iter().map(|chunk| {
        let ctx_c = Arc::clone(&ctx);
        async move { extract_batch_with_single_fallback(&ctx_c, chunk).await }
    }))
    .buffer_unordered(concurrency);

    let mut total_updated = 0usize;
    let mut completed_chunks = 0usize;
    while let Some(res) = futs.next().await {
        let extracted = res?;
        let db_p = db_path.to_path_buf();
        total_updated +=
            tokio::task::spawn_blocking(move || persist_maintainer_llm_batch(&db_p, &extracted))
                .await
                .map_err(|e| AppError::message(format!("persist llm batch: {e}")))??;
        completed_chunks += 1;
        if total_chunks >= 10
            && (completed_chunks.is_multiple_of(10) || completed_chunks == total_chunks)
        {
            let elapsed_s = started_at.elapsed().as_secs_f64();
            let rate = completed_chunks as f64 / elapsed_s.max(0.1);
            let remaining_s = ((total_chunks - completed_chunks) as f64 / rate.max(1e-6)) / 60.0;
            eprintln!(
                "[seed-bake llm] {}/{} batches ({} papers updated, elapsed {:.1}m, eta {:.1}m)",
                completed_chunks,
                total_chunks,
                total_updated,
                elapsed_s / 60.0,
                remaining_s
            );
        }
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

    // Preload `work_id -> refs_checked_at` (canonical UTC millisecond RFC 3339) for works
    // still lacking `raw_refs`, so clients syncing from seed honor the maintainer's TTL.
    let mut refs_checked_by_work: HashMap<i64, String> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT work_id, refs_checked_at FROM canonical_works
             WHERE refs_checked_at IS NOT NULL AND TRIM(refs_checked_at) != ''",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for entry in rows {
            let (wid, raw_ts) = entry?;
            if let Some(norm) = normalize_refs_checked_at(&raw_ts) {
                refs_checked_by_work.insert(wid, norm);
            }
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
            let raw_refs = refs_by_work.get(&wid).cloned().unwrap_or_default();
            let refs_checked_at = if raw_refs.is_empty() {
                refs_checked_by_work.get(&wid).cloned()
            } else {
                None
            };
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
                doi: r
                    .get::<_, Option<String>>(12)?
                    .filter(|d| !is_artifact_or_dataset_doi(d)),
                venue_id: r.get(13)?,
                venue_kind: r.get(14)?,
                venue_domain: r.get(15)?,
                ccf_rank: r.get(16)?,
                venue_full: r.get(17)?,
                keywords: serde_json::from_str(&kws_json).unwrap_or_default(),
                keyword_source: (!kw_src_raw.trim().is_empty())
                    .then(|| kw_src_raw.trim().to_string()),
                openalex_id: r.get(20)?,
                raw_refs,
                refs_checked_at,
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

    // Prune stale `.jsonl.gz` shard files left in `out_dir` from previous bakes.
    let active_filenames: HashSet<&str> = shards.iter().map(|s| s.filename.as_str()).collect();
    if let Ok(entries) = fs::read_dir(out_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.ends_with(".jsonl.gz") && !active_filenames.contains(name) {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }

    Ok((manifest_path, shards))
}

pub async fn seed_bake_at(
    db_path: &Path,
    opts: SeedBakeOptions,
) -> Result<SeedBakeReport, AppError> {
    let (oa_enriched, s2_enriched) = if opts.skip_refs {
        (0, 0)
    } else {
        run_step_a_refs_backfill(db_path, opts.force_clean).await?
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bake_prompt_matches_keyword_llm_rules_and_formats_zero_based_lines() {
        let long_abs = format!(
            "We study smart contract fuzzing. {} Conclusion on EVM invariants.",
            "x".repeat(2000)
        );
        let expected_abs = long_abs.clone();
        let chunk = vec![
            LlmPaperTarget {
                id: "arxiv:2603.00001".into(),
                title: "DuFP: Dual-Path Fuzzing for Smart Contracts".into(),
                abstract_text: long_abs,
                categories: vec!["cs.CR".into(), "cs.SE".into()],
                source_label: "arXiv cs.CR".into(),
            },
            LlmPaperTarget {
                id: "venue:icse-2026:p2".into(),
                title: "VulnGPT: Automated Program Repair via Symbolic Execution".into(),
                abstract_text: "ICSE 2026 accepted paper".into(),
                categories: Vec::new(),
                source_label: "ICSE 2026".into(),
            },
        ];

        let msgs = build_bake_llm_messages(&chunk);
        let sys = msgs[0]["content"].as_str().unwrap();
        assert!(sys.contains("4 to 6 canonical English academic keywords"));
        assert!(sys.contains("VulnGPT"));
        assert!(sys.contains("AutoFuzz"));
        assert!(sys.contains("DuFP"));

        let user = msgs[1]["content"].as_str().unwrap();
        let lines: Vec<&str> = user.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0]
            .starts_with("[0] Title: DuFP: Dual-Path Fuzzing for Smart Contracts | Abstract: "));
        let (_, abs_part) = lines[0].split_once(" | Abstract: ").unwrap();
        assert_eq!(abs_part, expected_abs);
        assert!(lines[1].starts_with(
            "[1] Title: VulnGPT: Automated Program Repair via Symbolic Execution | Abstract: (Title-only entry; Venue/Field: ICSE 2026)"
        ));
    }

    #[test]
    fn parse_llm_keyword_batch_supports_zero_based_object_and_items_array() {
        // 1) Default KEYWORD_SYSTEM_PROMPT 0-based object with <think> and markdown code fences
        let raw_kv = r#"<think>Reasoning about subfield and technique...</think>
```json
{
  "0": ["Smart Contract Security", "Fuzzing", "Symbolic Execution", "Benchmark"],
  "1": ["Program Repair", "Static Analysis", "Computer Science"]
}
```"#;
        let parsed_kv = parse_llm_keyword_batch_json(raw_kv, 2);
        assert_eq!(
            parsed_kv.get(&0).unwrap(),
            &vec![
                "Smart Contract Security".to_string(),
                "Fuzzing".to_string(),
                "Symbolic Execution".to_string()
            ]
        );
        assert_eq!(
            parsed_kv.get(&1).unwrap(),
            &vec!["Program Repair".to_string(), "Static Analysis".to_string()]
        );

        // 2) `{"items": [{"idx": 0, ...}, {"idx": 1, ...}]}` array format
        let raw_items_idx = r#"{"items":[{"idx":0,"keywords":["Vulnerability Detection","Taint Analysis"]},{"idx":1,"keywords":["Code Generation","Type System"]}]}"#;
        let parsed_items = parse_llm_keyword_batch_json(raw_items_idx, 2);
        assert_eq!(
            parsed_items.get(&0).unwrap(),
            &vec![
                "Vulnerability Detection".to_string(),
                "Taint Analysis".to_string()
            ]
        );
        assert_eq!(
            parsed_items.get(&1).unwrap(),
            &vec!["Code Generation".to_string(), "Type System".to_string()]
        );
    }

    #[test]
    fn bespoke_prefix_guard_and_placeholder_abstract_fallback_never_leave_empty() {
        let stripped = strip_bespoke_title_prefix(
            "DuFP: Dual-Path Fuzzing for Smart Contracts",
            vec![
                "DuFP".into(),
                "Fuzzing".into(),
                "Smart Contract Security".into(),
            ],
        );
        assert_eq!(
            stripped,
            vec!["Fuzzing".to_string(), "Smart Contract Security".to_string()]
        );

        // Standard camelCase tech names like eBPF are preserved
        let kept = strip_bespoke_title_prefix(
            "eBPF: Safe In-Kernel Sandboxing",
            vec!["eBPF".into(), "Kernel Security".into()],
        );
        assert_eq!(
            kept,
            vec!["eBPF".to_string(), "Kernel Security".to_string()]
        );

        // Roster placeholder abstract still produces non-empty canonical keywords from title + venue
        let roster_paper = LlmPaperTarget {
            id: "venue:usenix-2026:p99".into(),
            title: "AutoFuzz: Coverage-Guided Fuzzing for Smart Contracts".into(),
            abstract_text: "USENIX Security 2026 accepted paper".into(),
            categories: Vec::new(),
            source_label: "USENIX Security 2026".into(),
        };
        let fb = fallback_keywords_from_title_and_context(&roster_paper);
        assert!(!fb.is_empty());
        assert!(!fb.iter().any(|k| k.eq_ignore_ascii_case("AutoFuzz")));
    }

    #[test]
    fn venue_openalex_source_ids_all_exist_in_default_venues() {
        let valid_ids: HashSet<&str> = super::super::schema::DEFAULT_VENUES
            .iter()
            .map(|v| v.id)
            .collect();
        for &(vid, sids) in VENUE_OPENALEX_SOURCE_IDS {
            assert!(
                valid_ids.contains(vid),
                "unknown venue_id `{vid}` in VENUE_OPENALEX_SOURCE_IDS"
            );
            assert!(
                !sids.is_empty(),
                "empty OpenAlex source IDs for venue `{vid}`"
            );
        }
    }

    #[test]
    fn match_openalex_results_handles_arxiv_to_publisher_doi_and_guards_collisions() {
        let t_arxiv = WorkRefTarget {
            work_id: 101,
            openalex_id: None,
            doi_norm: None,
            arxiv_id_norm: Some("2601.10001".into()),
            title: "Sound Taint Analysis for Rust Kernels".into(),
            authors: vec!["Alice Smith".into(), "Bob Chen".into()],
        };
        let t_existing_doi = WorkRefTarget {
            work_id: 102,
            openalex_id: None,
            doi_norm: Some("10.1109/sp.2026.999".into()),
            arxiv_id_norm: None,
            title: "Hardware Enclave Side Channels".into(),
            authors: vec!["Carol Lee".into()],
        };
        let targets = vec![&t_arxiv, &t_existing_doi];

        let json = serde_json::json!({
            "results": [
                // 1) Upgraded published conference work with `ids.arxiv = null`, matched via title+authors
                {
                    "id": "https://openalex.org/W9001",
                    "type": "proceedings-article",
                    "title": "Sound Taint Analysis for Rust Kernels",
                    "publication_year": 2026,
                    "doi": "https://doi.org/10.1145/3744916.3773101",
                    "ids": { "openalex": "https://openalex.org/W9001", "arxiv": null },
                    "authorships": [
                        { "author": { "display_name": "Alice Smith" } },
                        { "author": { "display_name": "Bob Chen" } }
                    ],
                    "referenced_works": ["https://openalex.org/W42", "https://openalex.org/W43"]
                },
                // 2) Collision: same title, DIFFERENT author -> MUST be rejected
                {
                    "id": "https://openalex.org/W9002",
                    "type": "article",
                    "title": "Sound Taint Analysis for Rust Kernels",
                    "publication_year": 2026,
                    "doi": "https://doi.org/10.1145/9999999.1",
                    "ids": {},
                    "authorships": [
                        { "author": { "display_name": "Eve Mallory" } }
                    ],
                    "referenced_works": ["https://openalex.org/W777"]
                },
                // 3) Rejected dataset/Zenodo artifact even with identical title and authors
                {
                    "id": "https://openalex.org/W9003",
                    "type": "dataset",
                    "title": "Sound Taint Analysis for Rust Kernels",
                    "publication_year": 2026,
                    "doi": "https://doi.org/10.5281/zenodo.21868420",
                    "ids": {},
                    "authorships": [
                        { "author": { "display_name": "Alice Smith" } },
                        { "author": { "display_name": "Bob Chen" } }
                    ],
                    "referenced_works": ["https://openalex.org/W888"]
                },
                // 4) Conflicting publisher DOI on t_existing_doi -> MUST be rejected by ID compatibility guard
                {
                    "id": "https://openalex.org/W9004",
                    "type": "article",
                    "title": "Hardware Enclave Side Channels",
                    "publication_year": 2026,
                    "doi": "https://doi.org/10.1145/conflict.2026.1",
                    "ids": {},
                    "authorships": [
                        { "author": { "display_name": "Carol Lee" } }
                    ],
                    "referenced_works": ["https://openalex.org/W555"]
                }
            ]
        });

        let updates = match_openalex_results_to_targets(&targets, &json);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].work_id, 101);
        assert_eq!(updates[0].openalex_id.as_deref(), Some("W9001"));
        assert_eq!(
            updates[0].pub_doi.as_deref(),
            Some("10.1145/3744916.3773101")
        );
        assert_eq!(
            updates[0].refs,
            vec!["oa:W42".to_string(), "oa:W43".to_string()]
        );

        // Verify persist_ref_batch upgrades `doi`/`doi_norm`/`openalex_id` on both tables
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");
        super::super::store::upsert_papers_at(
            &db,
            super::super::models::CollectionUpsertPapersArgs {
                items: vec![CollectionPaperUpsertInput {
                    id: "arxiv:2601.10001".into(),
                    title: "Sound Taint Analysis for Rust Kernels".into(),
                    authors: vec!["Alice Smith".into(), "Bob Chen".into()],
                    source_type: "arxiv".into(),
                    source_label: "cs.SE".into(),
                    categories: vec!["cs.SE".into()],
                    arxiv_id: Some("2601.10001".into()),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();
        let conn = ensure_collection_at(&db).unwrap();
        let wid: i64 = conn
            .query_row(
                "SELECT work_id FROM papers WHERE id = 'arxiv:2601.10001'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        drop(conn);
        let mut persisted = updates;
        persisted[0].work_id = wid;
        let cnt = persist_ref_batch(&db, &persisted).unwrap();
        assert_eq!(cnt, 1);

        let detail = super::super::store::paper_get_at(&db, "arxiv:2601.10001")
            .unwrap()
            .unwrap();
        assert_eq!(detail.doi.as_deref(), Some("10.1145/3744916.3773101"));
        let conn2 = ensure_collection_at(&db).unwrap();
        let (cw_oa, cw_doi): (Option<String>, Option<String>) = conn2
            .query_row(
                "SELECT openalex_id, doi_norm FROM canonical_works WHERE work_id = ?1",
                [wid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(cw_oa.as_deref(), Some("W9001"));
        assert_eq!(cw_doi.as_deref(), Some("10.1145/3744916.3773101"));
    }

    #[test]
    fn title_search_sanitizer_and_strict_matcher_guard_noise() {
        assert_eq!(sanitize_title_for_openalex_search("Short Title"), None);
        assert_eq!(
            sanitize_title_for_openalex_search(
                "\"Agentic\" Security & Privacy | A Study: AND/OR (2026)!"
            ),
            Some("\"agentic security privacy a study and or 2026\"".to_string())
        );
        let sanitized =
            sanitize_title_for_openalex_search("\"Foo\": Bar | Baz + Quux * Test (v1) [Draft]?")
                .unwrap();
        assert!(!sanitized[1..sanitized.len() - 1].contains('"'));
        assert!(!sanitized.contains('|'));
        assert!(!sanitized.contains(':'));
        assert!(!sanitized.contains('+'));
        assert!(!sanitized.contains('*'));

        // Strict author + non-artifact verification on Pass A2.5 matching
        let targets = vec![WorkRefTarget {
            work_id: 201,
            openalex_id: None,
            doi_norm: None,
            arxiv_id_norm: None,
            title: "Agentic Security and Privacy in Modern Systems".into(),
            authors: vec!["Dana White".into(), "Evan Green".into()],
        }];
        let json = serde_json::json!({
            "results": [
                {
                    "id": "https://openalex.org/W8001",
                    "type": "software",
                    "title": "Agentic Security and Privacy in Modern Systems",
                    "doi": "https://doi.org/10.5281/zenodo.77777",
                    "ids": {},
                    "authorships": [{ "author": { "display_name": "Dana White" } }, { "author": { "display_name": "Evan Green" } }],
                    "referenced_works": ["https://openalex.org/W1"]
                },
                {
                    "id": "https://openalex.org/W8002",
                    "type": "article",
                    "title": "Agentic Security and Privacy in Modern Systems",
                    "doi": "https://doi.org/10.1145/wrong.author",
                    "ids": {},
                    "authorships": [{ "author": { "display_name": "Wrong Author" } }, { "author": { "display_name": "Another Person" } }],
                    "referenced_works": ["https://openalex.org/W2"]
                },
                {
                    "id": "https://openalex.org/W8003",
                    "type": "preprint",
                    "title": "Agentic Security and Privacy in Modern Systems",
                    "doi": "https://doi.org/10.48550/arXiv.2603.55555",
                    "ids": { "arxiv": "https://arxiv.org/abs/2603.55555" },
                    "authorships": [{ "author": { "display_name": "Dana White" } }, { "author": { "display_name": "Evan Green" } }],
                    "referenced_works": ["https://openalex.org/W10", "https://openalex.org/W11"]
                }
            ]
        });
        let matched = match_title_search_results_to_targets(&targets, &json);
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].work_id, 201);
        assert_eq!(matched[0].openalex_id.as_deref(), Some("W8003"));
        assert_eq!(matched[0].pub_doi, None);
        assert_eq!(matched[0].arxiv_id.as_deref(), Some("2603.55555"));
        assert_eq!(
            matched[0].refs,
            vec!["oa:W10".to_string(), "oa:W11".to_string()]
        );
    }

    #[test]
    fn s2_ref_extraction_keeps_doi_arxiv_and_acl_independently() {
        let ext_all = serde_json::json!({
            "DOI": "10.1145/3744916.3773100",
            "ArXiv": "2601.55555v2",
            "ACL": "2026.acl-long.42"
        });
        let keys_all = extract_s2_ref_keys(&ext_all);
        assert_eq!(
            keys_all,
            vec![
                "doi:10.1145/3744916.3773100".to_string(),
                "arxiv:2601.55555".to_string(),
                "doi:10.18653/v1/2026.acl-long.42".to_string(),
            ]
        );

        let ext_zenodo_plus_arxiv = serde_json::json!({
            "DOI": "10.5281/zenodo.21868420",
            "ArXiv": "10.48550/arXiv.2602.77777"
        });
        let keys_filtered = extract_s2_ref_keys(&ext_zenodo_plus_arxiv);
        assert_eq!(keys_filtered, vec!["arxiv:2602.77777".to_string()]);
    }

    #[tokio::test]
    async fn fetch_openalex_json_returns_rate_limited_without_hanging_on_daily_429() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let body = r#"{"error":"Insufficient daily budget credits"}"#;
                let resp = format!(
                    "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });

        let client =
            crate::http::client_with(Duration::from_secs(5), 1, crate::http::USER_AGENT).unwrap();
        let url = format!("http://{addr}/works?filter=title.search:%22test%22");
        let res = fetch_openalex_json(&client, &url).await;
        assert!(matches!(res, OpenAlexFetchResult::RateLimited));
        server.abort();
    }

    #[tokio::test]
    async fn fetch_openalex_json_retries_transient_429_when_credits_remain() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let body = r#"{"error":"Rate limit exceeded. Your daily credit limit is 10000."}"#;
                let resp = format!(
                    "HTTP/1.1 429 Too Many Requests\r\nX-RateLimit-Remaining: 6374\r\nRetry-After: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let body = r#"{"results":[]}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });

        let client =
            crate::http::client_with(Duration::from_secs(5), 1, crate::http::USER_AGENT).unwrap();
        let url = format!("http://{addr}/works?filter=title.search:%22test%22");
        let res = fetch_openalex_json(&client, &url).await;
        assert!(matches!(res, OpenAlexFetchResult::Ok(_)));
        server.abort();
    }

    #[test]
    fn pack_title_search_batches_respects_url_bytes_and_max_clauses() {
        let targets: Vec<WorkRefTarget> = (0..180)
            .map(|i| WorkRefTarget {
                work_id: i + 1,
                openalex_id: None,
                doi_norm: None,
                arxiv_id_norm: None,
                title: format!(
                    "Efficient Scalable Neural Program Synthesis Method Variant Number {i:03}"
                ),
                authors: vec!["Alice Smith".into()],
            })
            .collect();

        let prefix = "https://api.openalex.org/works?filter=title.search:".len();
        let suffix = 180usize;
        let batches = pack_title_search_batches(&targets, prefix, suffix);
        assert!(batches.len() >= 3);
        let mut total_packed = 0usize;
        for (indices, clauses) in &batches {
            assert_eq!(indices.len(), clauses.len());
            assert!(clauses.len() <= MAX_OA_TITLE_SEARCH_BATCH_SIZE);
            let url_bytes = prefix
                + suffix
                + clauses.iter().map(|c| c.len()).sum::<usize>()
                + 3 * (clauses.len().saturating_sub(1));
            assert!(url_bytes <= MAX_OA_TITLE_SEARCH_URL_BYTES);
            total_packed += clauses.len();
        }
        assert_eq!(total_packed, 180);
    }

    #[test]
    fn pass_a2_5_excludes_arxiv_works_and_honors_14_day_ttl() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");
        super::super::store::upsert_papers_at(
            &db,
            super::super::models::CollectionUpsertPapersArgs {
                items: vec![
                    CollectionPaperUpsertInput {
                        id: "arxiv:2601.11111".into(),
                        title: "Pure Arxiv Preprint Must Never Enter Title Search".into(),
                        authors: vec!["Ada Lovelace".into()],
                        source_type: "arxiv".into(),
                        source_label: "cs.SE".into(),
                        categories: vec!["cs.SE".into()],
                        arxiv_id: Some("2601.11111".into()),
                        doi: Some("10.48550/arXiv.2601.11111".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "venue:iclr-2026:arxiv-doi".into(),
                        title: "Venue Paper Having Only Arxiv Doi Should Skip".into(),
                        authors: vec!["Alan Turing".into()],
                        source_type: "venue".into(),
                        source_label: "ICLR 2026".into(),
                        categories: vec!["ICLR 2026".into()],
                        venue_id: Some("iclr-2026".into()),
                        doi: Some("10.48550/arXiv.2602.22222".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "venue:tse-2026:fresh".into(),
                        title: "Publisher Doi Without Refs Should Retry Preprint".into(),
                        authors: vec!["Grace Hopper".into()],
                        source_type: "venue".into(),
                        source_label: "TSE 2026".into(),
                        categories: vec!["TSE 2026".into()],
                        venue_id: Some("tse-2026".into()),
                        doi: Some("10.1109/TSE.2026.9000001".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "venue:neurips-2026:stale".into(),
                        title: "Stale Checked Paper Should Reenter After 14 Days".into(),
                        authors: vec!["Linus Torvalds".into()],
                        source_type: "venue".into(),
                        source_label: "NeurIPS 2026".into(),
                        categories: vec!["NeurIPS 2026".into()],
                        venue_id: Some("neurips-2026".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "venue:neurips-2026:recent".into(),
                        title: "Recent Checked Paper Must Stay In Cooldown".into(),
                        authors: vec!["Ken Thompson".into()],
                        source_type: "venue".into(),
                        source_label: "NeurIPS 2026".into(),
                        categories: vec!["NeurIPS 2026".into()],
                        venue_id: Some("neurips-2026".into()),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        let stale_ts = (chrono::Utc::now() - chrono::Duration::days(15))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let recent_ts = (chrono::Utc::now() - chrono::Duration::days(2))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let conn = ensure_collection_at(&db).unwrap();
        conn.execute(
            "UPDATE canonical_works SET refs_checked_at = ?1 WHERE work_id = (SELECT work_id FROM papers WHERE id = 'venue:neurips-2026:stale')",
            [stale_ts],
        )
        .unwrap();
        conn.execute(
            "UPDATE canonical_works SET refs_checked_at = ?1 WHERE work_id = (SELECT work_id FROM papers WHERE id = 'venue:neurips-2026:recent')",
            [recent_ts],
        )
        .unwrap();

        let targets = load_pass_a2_5_targets(&conn, &venue_refs_check_ttl_cutoff()).unwrap();
        let titles: Vec<&str> = targets.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(
            titles,
            vec![
                "Publisher Doi Without Refs Should Retry Preprint",
                "Stale Checked Paper Should Reenter After 14 Days",
            ]
        );

        // Verify singleton matcher + persist_ref_batch fills empty/placeholder abstract without overwriting genuine ones
        let singleton_json = serde_json::json!({
            "id": "https://openalex.org/W77123",
            "type": "article",
            "title": "Stale Checked Paper Should Reenter After 14 Days",
            "doi": "https://doi.org/10.1234/neurips.2026.9",
            "ids": {},
            "authorships": [{ "author": { "display_name": "Linus Torvalds" } }],
            "abstract_inverted_index": {
                "Recovered": [0],
                "abstract": [1],
                "from": [2],
                "OpenAlex.": [3]
            },
            "referenced_works": ["https://openalex.org/W42"]
        });
        let stale_target = &targets[1];
        let upd = match_single_openalex_work_to_target(stale_target, &singleton_json).unwrap();
        assert_eq!(
            upd.abstract_text.as_deref(),
            Some("Recovered abstract from OpenAlex.")
        );
        drop(conn);
        persist_ref_batch(&db, &[upd]).unwrap();
        let updated_paper = super::super::store::paper_get_at(&db, "venue:neurips-2026:stale")
            .unwrap()
            .unwrap();
        assert_eq!(
            updated_paper.abstract_text,
            "Recovered abstract from OpenAlex."
        );
    }

    #[test]
    fn seed_bake_options_default_to_generic_endpoint_and_rpm_limit() {
        let opts = SeedBakeOptions::default();
        assert_eq!(opts.llm_base_url, DEFAULT_BAKE_LLM_BASE_URL);
        assert_eq!(opts.llm_model, DEFAULT_BAKE_LLM_MODEL);
        assert_eq!(opts.llm_rpm, DEFAULT_BAKE_LLM_RPM);
        assert_eq!(opts.llm_concurrency, DEFAULT_BAKE_LLM_CONCURRENCY);
    }

    #[test]
    fn refs_backfill_policy_uses_7d_60d_for_arxiv_and_14d_no_age_cap_for_venue() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("collection.sqlite");

        let ymd_days_ago = |days: i64| -> String {
            (chrono::Utc::now() - chrono::Duration::days(days))
                .format("%Y-%m-%dT12:00:00Z")
                .to_string()
        };
        let ts_days_ago = |days: i64| -> String {
            (chrono::Utc::now() - chrono::Duration::days(days))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };

        super::super::store::upsert_papers_at(
            &db,
            super::super::models::CollectionUpsertPapersArgs {
                items: vec![
                    // 1. arXiv-only, published 20d ago, checked 8d ago (>7d TTL) -> INCLUDED
                    CollectionPaperUpsertInput {
                        id: "arxiv:2610.00001".into(),
                        title: "Recent Arxiv Past 7d TTL".into(),
                        authors: vec!["Alice".into()],
                        published_at: ymd_days_ago(20),
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.SE".into(),
                        categories: vec!["cs.SE".into()],
                        arxiv_id: Some("2610.00001".into()),
                        ..Default::default()
                    },
                    // 2. arXiv-only, published 20d ago, checked 3d ago (<7d TTL) -> EXCLUDED
                    CollectionPaperUpsertInput {
                        id: "arxiv:2610.00002".into(),
                        title: "Recent Arxiv Within 7d TTL".into(),
                        authors: vec!["Bob".into()],
                        published_at: ymd_days_ago(20),
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.SE".into(),
                        categories: vec!["cs.SE".into()],
                        arxiv_id: Some("2610.00002".into()),
                        ..Default::default()
                    },
                    // 3. arXiv-only, published 75d ago (>60d max age), never checked -> EXCLUDED
                    CollectionPaperUpsertInput {
                        id: "arxiv:2608.00003".into(),
                        title: "Old Arxiv Over 60d Cutoff".into(),
                        authors: vec!["Carol".into()],
                        published_at: ymd_days_ago(75),
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.SE".into(),
                        categories: vec!["cs.SE".into()],
                        arxiv_id: Some("2608.00003".into()),
                        ..Default::default()
                    },
                    // 4. Venue, published 120d ago, checked 15d ago (>14d TTL, NO 60d cap) -> INCLUDED
                    CollectionPaperUpsertInput {
                        id: "doi:10.1145/venue.old.stale".into(),
                        title: "Old Venue Past 14d TTL".into(),
                        authors: vec!["Dave".into()],
                        published_at: ymd_days_ago(120),
                        year: 2026,
                        source_type: "venue".into(),
                        source_label: "ICSE 2026".into(),
                        categories: vec!["ICSE 2026".into()],
                        doi: Some("10.1145/venue.old.stale".into()),
                        venue_id: Some("icse-2026".into()),
                        ..Default::default()
                    },
                    // 5. Venue, published 120d ago, checked 10d ago (<14d TTL) -> EXCLUDED
                    CollectionPaperUpsertInput {
                        id: "doi:10.1145/venue.old.fresh".into(),
                        title: "Old Venue Within 14d TTL".into(),
                        authors: vec!["Eve".into()],
                        published_at: ymd_days_ago(120),
                        year: 2026,
                        source_type: "venue".into(),
                        source_label: "ICSE 2026".into(),
                        categories: vec!["ICSE 2026".into()],
                        doi: Some("10.1145/venue.old.fresh".into()),
                        venue_id: Some("icse-2026".into()),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        let conn = ensure_collection_at(&db).unwrap();
        for (pid, days) in [
            ("arxiv:2610.00001", 8),
            ("arxiv:2610.00002", 3),
            ("doi:10.1145/venue.old.stale", 15),
            ("doi:10.1145/venue.old.fresh", 10),
        ] {
            conn.execute(
                "UPDATE canonical_works SET refs_checked_at = ?1 WHERE work_id = (SELECT work_id FROM papers WHERE id = ?2)",
                params![ts_days_ago(days), pid],
            )
            .unwrap();
        }

        let arxiv_ttl = arxiv_refs_check_ttl_cutoff();
        let venue_ttl = venue_refs_check_ttl_cutoff();
        let arxiv_min_ymd = arxiv_refs_min_published_ymd();

        // Server Pass A1
        let (a1_targets, _) =
            load_pass_a1_targets(&conn, &arxiv_ttl, &venue_ttl, &arxiv_min_ymd).unwrap();
        let a1_titles: Vec<&str> = a1_targets.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(
            a1_titles,
            vec!["Old Venue Past 14d TTL", "Recent Arxiv Past 7d TTL"]
        );

        // Client arXiv-scoped backfill
        let client_arxiv = load_client_refs_backfill_targets(
            &conn,
            &CollectionBackfillRefsArgs {
                source_type: Some("arxiv".into()),
                categories: vec!["cs.SE".into()],
                venue_ids: vec![],
            },
            &arxiv_ttl,
            &venue_ttl,
            &arxiv_min_ymd,
        )
        .unwrap();
        assert_eq!(
            client_arxiv
                .iter()
                .map(|t| t.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Recent Arxiv Past 7d TTL"]
        );

        // Client Venue-scoped backfill
        let client_venue = load_client_refs_backfill_targets(
            &conn,
            &CollectionBackfillRefsArgs {
                source_type: Some("venue".into()),
                categories: vec![],
                venue_ids: vec!["icse-2026".into()],
            },
            &arxiv_ttl,
            &venue_ttl,
            &arxiv_min_ymd,
        )
        .unwrap();
        assert_eq!(
            client_venue
                .iter()
                .map(|t| t.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Old Venue Past 14d TTL"]
        );
    }

    #[test]
    fn export_seed_shards_emits_refs_checked_at_only_when_raw_refs_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");
        let out_dir = tmp.path().join("out");

        super::super::store::upsert_papers_at(
            &db,
            super::super::models::CollectionUpsertPapersArgs {
                items: vec![
                    CollectionPaperUpsertInput {
                        id: "arxiv:2601.10001".into(),
                        title: "Missing Refs Checked Paper".into(),
                        authors: vec!["Alice".into()],
                        published_at: "2026-01-10T00:00:00Z".into(),
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.SE".into(),
                        categories: vec!["cs.SE".into()],
                        arxiv_id: Some("2601.10001".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "arxiv:2601.10002".into(),
                        title: "Has Refs Should Omit Checked At".into(),
                        authors: vec!["Bob".into()],
                        published_at: "2026-01-11T00:00:00Z".into(),
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.SE".into(),
                        categories: vec!["cs.SE".into()],
                        arxiv_id: Some("2601.10002".into()),
                        raw_refs: vec!["arxiv:2601.10001".into()],
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "arxiv:2601.10003".into(),
                        title: "Unchecked Empty Paper".into(),
                        authors: vec!["Carol".into()],
                        published_at: "2026-01-12T00:00:00Z".into(),
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.SE".into(),
                        categories: vec!["cs.SE".into()],
                        arxiv_id: Some("2601.10003".into()),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        {
            let conn = ensure_collection_at(&db).unwrap();
            // Non-UTC offset should be normalized to canonical UTC `...Z` millisecond form.
            conn.execute(
                "UPDATE canonical_works SET refs_checked_at = '2026-11-18T10:00:00+08:00'
                 WHERE work_id = (SELECT work_id FROM papers WHERE id = 'arxiv:2601.10001')",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE canonical_works SET refs_checked_at = '2026-11-18T02:00:00.000Z'
                 WHERE work_id = (SELECT work_id FROM papers WHERE id = 'arxiv:2601.10002')",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE canonical_works SET refs_checked_at = ''
                 WHERE work_id = (SELECT work_id FROM papers WHERE id = 'arxiv:2601.10003')",
                [],
            )
            .unwrap();
        }

        let (_manifest_path, shards) = export_seed_shards_sync(&db, &out_dir, None).unwrap();
        let core = shards.iter().find(|s| s.kind == "core").unwrap();
        let gz = GzDecoder::new(File::open(out_dir.join(&core.filename)).unwrap());
        let mut records: HashMap<String, (String, SeedPaperRecord)> = HashMap::new();
        for line in BufReader::new(gz).lines() {
            let raw = line.unwrap();
            let rec: SeedPaperRecord = serde_json::from_str(&raw).unwrap();
            records.insert(rec.id.clone(), (raw, rec));
        }

        assert_eq!(
            records["arxiv:2601.10001"].1.refs_checked_at.as_deref(),
            Some("2026-11-18T02:00:00.000Z")
        );
        assert!(records["arxiv:2601.10002"].1.refs_checked_at.is_none());
        assert!(!records["arxiv:2601.10002"].0.contains("\"refsCheckedAt\""));
        assert!(records["arxiv:2601.10003"].1.refs_checked_at.is_none());
        assert!(!records["arxiv:2601.10003"].0.contains("\"refsCheckedAt\""));
    }

    #[tokio::test]
    async fn seed_sync_imports_refs_checked_at_monotonically_and_backfill_honors_ttl() {
        let tmp = tempfile::tempdir().unwrap();
        let seed_dir = tmp.path().join("seed");
        let dst_db = tmp.path().join("dst_collection.sqlite");
        fs::create_dir_all(&seed_dir).unwrap();

        let ymd_days_ago = |days: i64| -> String {
            (chrono::Utc::now() - chrono::Duration::days(days))
                .format("%Y-%m-%dT12:00:00Z")
                .to_string()
        };
        let ts_days_ago = |days: i64| -> String {
            (chrono::Utc::now() - chrono::Duration::days(days))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };

        let write_manifest_and_shard = |records: &[SeedPaperRecord], shard_id: &str| {
            let mut w = GzShardWriter::create(&seed_dir, "core").unwrap();
            for rec in records {
                w.write_record(rec).unwrap();
            }
            let shard = w
                .finish(&seed_dir, "core", shard_id, vec!["cs.SE".into()])
                .unwrap()
                .unwrap();
            let manifest = SeedManifest {
                version: 2,
                generated_at: ts_days_ago(0),
                shards: vec![shard],
                arxiv_watermarks: HashMap::new(),
                venue_watermarks: HashMap::new(),
            };
            let manifest_path = seed_dir.join("manifest.json");
            fs::write(
                &manifest_path,
                serde_json::to_vec_pretty(&manifest).unwrap(),
            )
            .unwrap();
            manifest_path
        };

        let make_rec = |id: &str,
                        title: &str,
                        source_type: &str,
                        pub_days_ago: i64,
                        refs_checked_at: Option<String>| SeedPaperRecord {
            id: id.into(),
            title: title.into(),
            authors: vec!["Alice".into()],
            abstract_text: "Abstract.".into(),
            published_at: ymd_days_ago(pub_days_ago),
            year: 2026,
            source_type: source_type.into(),
            source_label: if source_type == "arxiv" {
                "cs.SE".into()
            } else {
                "ICSE 2026".into()
            },
            categories: if source_type == "arxiv" {
                vec!["cs.SE".into()]
            } else {
                vec!["ICSE 2026".into()]
            },
            url: String::new(),
            pdf_url: None,
            arxiv_id: (source_type == "arxiv").then(|| id.trim_start_matches("arxiv:").to_string()),
            doi: (source_type == "venue").then(|| format!("10.1145/{}", id.replace(':', "."))),
            venue_id: (source_type == "venue").then(|| "icse-2026".to_string()),
            venue_kind: None,
            venue_domain: None,
            ccf_rank: None,
            venue_full: None,
            keywords: vec!["Testing".into()],
            keyword_source: Some("author".into()),
            openalex_id: None,
            raw_refs: Vec::new(),
            refs_checked_at,
            volume: None,
            issue: None,
            pages: None,
            bibtex: None,
            cool_papers_id: None,
        };

        let ts_2d = ts_days_ago(2);
        let ts_3d = ts_days_ago(3);
        let ts_9d = ts_days_ago(9);
        let ts_15d = ts_days_ago(15);

        let manifest_path = write_manifest_and_shard(
            &[
                make_rec(
                    "arxiv:2610.10001",
                    "Arxiv Within TTL",
                    "arxiv",
                    15,
                    Some(ts_2d.clone()),
                ),
                make_rec(
                    "arxiv:2610.10002",
                    "Arxiv Past TTL",
                    "arxiv",
                    15,
                    Some(ts_9d.clone()),
                ),
                make_rec(
                    "venue:icse-2026:fresh",
                    "Venue Within TTL",
                    "venue",
                    60,
                    Some(ts_3d.clone()),
                ),
                make_rec(
                    "venue:icse-2026:stale",
                    "Venue Past TTL",
                    "venue",
                    60,
                    Some(ts_15d.clone()),
                ),
                make_rec(
                    "venue:icse-2026:none",
                    "Venue Never Checked",
                    "venue",
                    60,
                    None,
                ),
            ],
            "core-v1",
        );

        let sync1 = seed_sync_at(
            &dst_db,
            CollectionSeedSyncArgs {
                manifest_url: Some(manifest_path.to_string_lossy().to_string()),
                force: Some(false),
            },
        )
        .await
        .unwrap();
        assert_eq!(sync1.imported_papers, 5);

        let read_checked_at = |pid: &str| -> Option<String> {
            let conn = ensure_collection_at(&dst_db).unwrap();
            conn.query_row(
                "SELECT cw.refs_checked_at FROM papers p
                 JOIN canonical_works cw ON cw.work_id = p.work_id
                 WHERE p.id = ?1",
                [pid],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(
            read_checked_at("arxiv:2610.10001").as_deref(),
            Some(ts_2d.as_str())
        );
        assert_eq!(
            read_checked_at("arxiv:2610.10002").as_deref(),
            Some(ts_9d.as_str())
        );
        assert_eq!(
            read_checked_at("venue:icse-2026:fresh").as_deref(),
            Some(ts_3d.as_str())
        );
        assert_eq!(
            read_checked_at("venue:icse-2026:stale").as_deref(),
            Some(ts_15d.as_str())
        );
        assert_eq!(read_checked_at("venue:icse-2026:none"), None);

        {
            let conn = ensure_collection_at(&dst_db).unwrap();
            let targets = load_client_refs_backfill_targets(
                &conn,
                &CollectionBackfillRefsArgs::default(),
                &arxiv_refs_check_ttl_cutoff(),
                &venue_refs_check_ttl_cutoff(),
                &arxiv_refs_min_published_ymd(),
            )
            .unwrap();
            let titles: Vec<&str> = targets.iter().map(|t| t.title.as_str()).collect();
            assert_eq!(
                titles,
                vec!["Arxiv Past TTL", "Venue Past TTL", "Venue Never Checked"]
            );
        }

        // Second sync with: older ts for 10001 (must NOT regress), newer ts for 10002 (must advance),
        // None for venue:fresh (must NOT clear), new ts for venue:none (must populate).
        let ts_5d = ts_days_ago(5);
        let ts_1d = ts_days_ago(1);
        let ts_4d = ts_days_ago(4);
        let ts_1d_plus8 = chrono::DateTime::parse_from_rfc3339(&ts_1d)
            .unwrap()
            .with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap())
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, false);

        let manifest_path_2 = write_manifest_and_shard(
            &[
                make_rec(
                    "arxiv:2610.10001",
                    "Arxiv Within TTL",
                    "arxiv",
                    15,
                    Some(ts_5d),
                ),
                make_rec(
                    "arxiv:2610.10002",
                    "Arxiv Past TTL",
                    "arxiv",
                    15,
                    Some(ts_1d_plus8.clone()),
                ),
                make_rec(
                    "venue:icse-2026:fresh",
                    "Venue Within TTL",
                    "venue",
                    60,
                    None,
                ),
                make_rec(
                    "venue:icse-2026:stale",
                    "Venue Past TTL",
                    "venue",
                    60,
                    Some(ts_1d.clone()),
                ),
                make_rec(
                    "venue:icse-2026:none",
                    "Venue Never Checked",
                    "venue",
                    60,
                    Some(ts_4d.clone()),
                ),
            ],
            "core-v2",
        );

        let sync2 = seed_sync_at(
            &dst_db,
            CollectionSeedSyncArgs {
                manifest_url: Some(manifest_path_2.to_string_lossy().to_string()),
                force: Some(true),
            },
        )
        .await
        .unwrap();
        assert_eq!(sync2.imported_papers, 5);

        let expected_1d_norm = normalize_refs_checked_at(&ts_1d_plus8).unwrap();
        assert_eq!(
            read_checked_at("arxiv:2610.10001").as_deref(),
            Some(ts_2d.as_str())
        );
        assert_eq!(
            read_checked_at("arxiv:2610.10002").as_deref(),
            Some(expected_1d_norm.as_str())
        );
        assert_eq!(
            read_checked_at("venue:icse-2026:fresh").as_deref(),
            Some(ts_3d.as_str())
        );
        assert_eq!(
            read_checked_at("venue:icse-2026:stale").as_deref(),
            Some(ts_1d.as_str())
        );
        assert_eq!(
            read_checked_at("venue:icse-2026:none").as_deref(),
            Some(ts_4d.as_str())
        );

        // Now every work is within its TTL, so `backfill_missing_refs_at` skips all of them with 0 API calls.
        let bf = backfill_missing_refs_at(&dst_db, CollectionBackfillRefsArgs::default(), None)
            .await
            .unwrap();
        assert_eq!(bf.checked_works, 0);
        assert_eq!(bf.enriched_works, 0);
    }

    #[test]
    fn canonical_work_merge_preserves_newest_refs_checked_at_across_store_and_seed() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        // Case 1 (`store.rs` `resolve_or_merge_work_id_tx`):
        // Primary (`work_id` smaller) is arXiv-only with older ts; secondary (`work_id` larger)
        // is Venue with newer ts -> merge by matching title+authors keeps the newer ts.
        super::super::store::upsert_papers_at(
            &db,
            super::super::models::CollectionUpsertPapersArgs {
                items: vec![
                    CollectionPaperUpsertInput {
                        id: "arxiv:2605.11111".into(),
                        title: "Twin Merge Preserves Newest Check Timestamp".into(),
                        authors: vec!["Ada Lovelace".into()],
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.SE".into(),
                        categories: vec!["cs.SE".into()],
                        arxiv_id: Some("2605.11111".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "venue:icse-2026:twin-a".into(),
                        title: "Twin Merge Preserves Newest Check Timestamp".into(),
                        authors: vec!["Grace Hopper".into()],
                        year: 2026,
                        source_type: "venue".into(),
                        source_label: "ICSE 2026".into(),
                        categories: vec!["ICSE 2026".into()],
                        doi: Some("10.1145/twin.merge.1".into()),
                        venue_id: Some("icse-2026".into()),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        let ts_old = "2026-11-01T00:00:00.000Z";
        let ts_new = "2026-11-15T12:30:00.000Z";
        {
            let conn = ensure_collection_at(&db).unwrap();
            conn.execute(
                "UPDATE canonical_works SET refs_checked_at = ?1
                 WHERE work_id = (SELECT work_id FROM papers WHERE id = 'arxiv:2605.11111')",
                [ts_old],
            )
            .unwrap();
            conn.execute(
                "UPDATE canonical_works SET refs_checked_at = ?1
                 WHERE work_id = (SELECT work_id FROM papers WHERE id = 'venue:icse-2026:twin-a')",
                [ts_new],
            )
            .unwrap();
        }

        // Upserting the Venue paper with the bridging arXiv ID triggers `resolve_or_merge_work_id_tx`
        super::super::store::upsert_papers_at(
            &db,
            super::super::models::CollectionUpsertPapersArgs {
                items: vec![CollectionPaperUpsertInput {
                    id: "venue:icse-2026:twin-a".into(),
                    title: "Twin Merge Preserves Newest Check Timestamp".into(),
                    authors: vec!["Grace Hopper".into()],
                    year: 2026,
                    source_type: "venue".into(),
                    source_label: "ICSE 2026".into(),
                    categories: vec!["ICSE 2026".into()],
                    arxiv_id: Some("2605.11111".into()),
                    doi: Some("10.1145/twin.merge.1".into()),
                    venue_id: Some("icse-2026".into()),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();

        {
            let conn = ensure_collection_at(&db).unwrap();
            let (w1, ts1): (i64, Option<String>) = conn
                .query_row(
                    "SELECT cw.work_id, cw.refs_checked_at FROM papers p
                     JOIN canonical_works cw ON cw.work_id = p.work_id
                     WHERE p.id = 'arxiv:2605.11111'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            let (w2, ts2): (i64, Option<String>) = conn
                .query_row(
                    "SELECT cw.work_id, cw.refs_checked_at FROM papers p
                     JOIN canonical_works cw ON cw.work_id = p.work_id
                     WHERE p.id = 'venue:icse-2026:twin-a'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(w1, w2);
            assert_eq!(ts1.as_deref(), Some(ts_new));
            assert_eq!(ts2.as_deref(), Some(ts_new));
        }

        // Case 2 (`seed.rs` `merge_canonical_works_on_ids_tx`):
        // Primary (`work_id` smaller) has older ts; secondary (`work_id` larger) has newer ts.
        super::super::store::upsert_papers_at(
            &db,
            super::super::models::CollectionUpsertPapersArgs {
                items: vec![
                    CollectionPaperUpsertInput {
                        id: "arxiv:2605.22222".into(),
                        title: "Seed Merge Primary Older".into(),
                        authors: vec!["Alan Turing".into()],
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.PL".into(),
                        categories: vec!["cs.PL".into()],
                        arxiv_id: Some("2605.22222".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "venue:icse-2026:twin-b".into(),
                        title: "Seed Merge Secondary Newer".into(),
                        authors: vec!["Alan Turing".into()],
                        year: 2026,
                        source_type: "venue".into(),
                        source_label: "ICSE 2026".into(),
                        categories: vec!["ICSE 2026".into()],
                        doi: Some("10.1145/twin.merge.2".into()),
                        venue_id: Some("icse-2026".into()),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        let mut conn = ensure_collection_at(&db).unwrap();
        let wid_a: i64 = conn
            .query_row(
                "SELECT work_id FROM papers WHERE id = 'arxiv:2605.22222'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let wid_b: i64 = conn
            .query_row(
                "SELECT work_id FROM papers WHERE id = 'venue:icse-2026:twin-b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "UPDATE canonical_works SET refs_checked_at = ?1 WHERE work_id = ?2",
            params![ts_old, wid_a],
        )
        .unwrap();
        conn.execute(
            "UPDATE canonical_works SET refs_checked_at = ?1 WHERE work_id = ?2",
            params![ts_new, wid_b],
        )
        .unwrap();

        let tx = conn.transaction().unwrap();
        let mut aliases = HashMap::new();
        let merged_id = merge_canonical_works_on_ids_tx(
            &tx,
            &mut aliases,
            wid_a,
            None,
            Some("10.1145/twin.merge.2"),
            Some("2605.22222"),
        )
        .unwrap();
        tx.commit().unwrap();
        assert_eq!(merged_id, wid_a.min(wid_b));
        let merged_ts: Option<String> = conn
            .query_row(
                "SELECT refs_checked_at FROM canonical_works WHERE work_id = ?1",
                [merged_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(merged_ts.as_deref(), Some(ts_new));
    }

    #[tokio::test]
    async fn seed_sync_skips_rebuilt_core_shard_after_core_already_applied_unless_forced() {
        let tmp = tempfile::tempdir().unwrap();
        let dst_db = tmp.path().join("collection.sqlite");
        let seed_dir = tmp.path().join("seed");
        fs::create_dir_all(&seed_dir).unwrap();

        let write_shard = |filename: &str, records: &[SeedPaperRecord]| -> String {
            let path = seed_dir.join(filename);
            let file = File::create(&path).unwrap();
            let mut enc = GzEncoder::new(file, Compression::default());
            for rec in records {
                writeln!(enc, "{}", serde_json::to_string(rec).unwrap()).unwrap();
            }
            enc.finish().unwrap();
            let bytes = fs::read(&path).unwrap();
            hex::encode(Sha256::digest(&bytes))
        };

        let make_rec = |id: &str, title: &str| SeedPaperRecord {
            id: id.to_string(),
            title: title.to_string(),
            authors: vec!["Alice Smith".into()],
            abstract_text: "A full research abstract for seed sync verification testing.".into(),
            published_at: "2026-09-22T00:00:00Z".into(),
            year: 2026,
            source_type: "arxiv".into(),
            source_label: "cs.SE".into(),
            categories: vec!["cs.SE".into()],
            url: format!("https://arxiv.org/abs/{id}"),
            pdf_url: None,
            arxiv_id: Some(id.trim_start_matches("arxiv:").to_string()),
            doi: None,
            venue_id: None,
            venue_kind: None,
            venue_domain: None,
            ccf_rank: None,
            venue_full: None,
            keywords: vec!["Fuzzing".into()],
            keyword_source: Some("maintainer_llm".into()),
            openalex_id: None,
            raw_refs: Vec::new(),
            refs_checked_at: None,
            volume: None,
            issue: None,
            pages: None,
            bibtex: None,
            cool_papers_id: None,
        };

        let sha1 = write_shard(
            "core-2026-v1.jsonl.gz",
            &[make_rec("arxiv:2609.00001", "Initial Seed Paper")],
        );
        let manifest_v1 = seed_dir.join("manifest-v1.json");
        fs::write(
            &manifest_v1,
            serde_json::to_vec(&SeedManifest {
                version: 2,
                generated_at: "2026-11-18T00:00:00Z".into(),
                shards: vec![SeedShardEntry {
                    id: "core-2026-v1".into(),
                    kind: "core".into(),
                    filename: "core-2026-v1.jsonl.gz".into(),
                    sha256: sha1,
                    paper_count: 1,
                    categories: vec!["cs.SE".into()],
                }],
                arxiv_watermarks: HashMap::new(),
                venue_watermarks: HashMap::new(),
            })
            .unwrap(),
        )
        .unwrap();

        let sync1 = seed_sync_at(
            &dst_db,
            CollectionSeedSyncArgs {
                manifest_url: Some(manifest_v1.to_string_lossy().to_string()),
                force: Some(false),
            },
        )
        .await
        .unwrap();
        assert!(!sync1.skipped);
        assert_eq!(sync1.imported_papers, 1);

        // Rebuilt core shard (`core-2026-v2`) plus an incremental `delta` shard:
        // non-forced sync must skip `core-2026-v2` (avoiding 40+ MB re-import) and apply only `delta`.
        let sha2 = write_shard(
            "core-2026-v2.jsonl.gz",
            &[
                make_rec("arxiv:2609.00001", "Initial Seed Paper"),
                make_rec("arxiv:2609.00002", "Core V2 Only Paper"),
            ],
        );
        let sha_delta = write_shard(
            "delta-2026-1120.jsonl.gz",
            &[make_rec("arxiv:2609.00003", "Delta Paper")],
        );
        let manifest_v2 = seed_dir.join("manifest-v2.json");
        fs::write(
            &manifest_v2,
            serde_json::to_vec(&SeedManifest {
                version: 2,
                generated_at: "2026-11-20T00:00:00Z".into(),
                shards: vec![
                    SeedShardEntry {
                        id: "core-2026-v2".into(),
                        kind: "core".into(),
                        filename: "core-2026-v2.jsonl.gz".into(),
                        sha256: sha2,
                        paper_count: 2,
                        categories: vec!["cs.SE".into()],
                    },
                    SeedShardEntry {
                        id: "delta-2026-1120".into(),
                        kind: "delta".into(),
                        filename: "delta-2026-1120.jsonl.gz".into(),
                        sha256: sha_delta,
                        paper_count: 1,
                        categories: vec!["cs.SE".into()],
                    },
                ],
                arxiv_watermarks: HashMap::new(),
                venue_watermarks: HashMap::new(),
            })
            .unwrap(),
        )
        .unwrap();

        let sync2 = seed_sync_at(
            &dst_db,
            CollectionSeedSyncArgs {
                manifest_url: Some(manifest_v2.to_string_lossy().to_string()),
                force: Some(false),
            },
        )
        .await
        .unwrap();
        assert!(!sync2.skipped);
        assert_eq!(sync2.applied_shards, vec!["delta-2026-1120"]);
        assert_eq!(sync2.imported_papers, 1);

        // Subsequent non-forced sync with only rebuilt `core-2026-v2` unapplied skips immediately.
        let sync3 = seed_sync_at(
            &dst_db,
            CollectionSeedSyncArgs {
                manifest_url: Some(manifest_v2.to_string_lossy().to_string()),
                force: Some(false),
            },
        )
        .await
        .unwrap();
        assert!(sync3.skipped);
        assert_eq!(sync3.imported_papers, 0);

        // Explicit `force: true` still re-applies `core-2026-v2`.
        let sync4 = seed_sync_at(
            &dst_db,
            CollectionSeedSyncArgs {
                manifest_url: Some(manifest_v2.to_string_lossy().to_string()),
                force: Some(true),
            },
        )
        .await
        .unwrap();
        assert!(!sync4.skipped);
        assert_eq!(
            sync4.applied_shards,
            vec!["core-2026-v2", "delta-2026-1120"]
        );
        assert_eq!(sync4.imported_papers, 3);
    }

    #[test]
    fn title_norm_queries_use_partial_indexes_in_query_plan() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");
        let conn = ensure_collection_at(&db).unwrap();

        let cw_plan: Vec<String> = conn
            .prepare(
                "EXPLAIN QUERY PLAN \
                 SELECT work_id, COALESCE(author_norm, '') FROM canonical_works \
                 WHERE title_norm IS NOT NULL AND title_norm != '' AND title_norm = ?1",
            )
            .unwrap()
            .query_map(["sampletitle"], |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            cw_plan.iter().any(|d| d.contains("idx_cw_title")),
            "expected idx_cw_title in query plan, got: {cw_plan:?}"
        );

        let papers_plan: Vec<String> = conn
            .prepare(
                "EXPLAIN QUERY PLAN \
                 SELECT id FROM papers p WHERE p.title_norm != '' AND p.title_norm = ?1",
            )
            .unwrap()
            .query_map(["sampletitle"], |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            papers_plan
                .iter()
                .any(|d| d.contains("idx_papers_title_norm")),
            "expected idx_papers_title_norm in query plan, got: {papers_plan:?}"
        );
    }

    #[tokio::test]
    async fn seed_sync_empty_db_fast_path_rebuilds_fts_and_guards_cs_ai_watermark() {
        let tmp = tempfile::tempdir().unwrap();
        let seed_dir = tmp.path().join("seed");
        fs::create_dir_all(&seed_dir).unwrap();
        let dst_db = tmp.path().join("collection.sqlite");

        // Enable cs.AI BEFORE seed sync, but provide only a `core` shard (no `addon-cs-ai`).
        super::super::store::config_update_at(
            &dst_db,
            super::super::models::CollectionConfigUpdateArgs {
                categories: Some(vec![
                    "cs.SE".into(),
                    "cs.CR".into(),
                    "cs.PL".into(),
                    "cs.AI".into(),
                ]),
                ..Default::default()
            },
        )
        .unwrap();

        let shard_path = seed_dir.join("core-2026-fast.jsonl.gz");
        let rec = SeedPaperRecord {
            id: "arxiv:2610.00001".into(),
            title: "Quantum Fuzzing Verification Pipeline".into(),
            authors: vec!["Alice Smith".into()],
            abstract_text: "A full abstract proving FTS5 rebuild after empty DB bulk import."
                .into(),
            published_at: "2026-10-01T00:00:00Z".into(),
            year: 2026,
            source_type: "arxiv".into(),
            source_label: "cs.SE".into(),
            categories: vec!["cs.SE".into()],
            url: "https://arxiv.org/abs/2610.00001".into(),
            pdf_url: None,
            arxiv_id: Some("2610.00001".into()),
            doi: None,
            venue_id: None,
            venue_kind: None,
            venue_domain: None,
            ccf_rank: None,
            venue_full: None,
            keywords: vec!["Fuzzing".into()],
            keyword_source: Some("author".into()),
            openalex_id: None,
            raw_refs: vec!["arxiv:2610.00002".into()],
            refs_checked_at: Some("2026-11-20T00:00:00Z".into()),
            volume: None,
            issue: None,
            pages: None,
            bibtex: None,
            cool_papers_id: None,
        };
        {
            let f = File::create(&shard_path).unwrap();
            let mut gz = GzEncoder::new(f, Compression::default());
            writeln!(gz, "{}", serde_json::to_string(&rec).unwrap()).unwrap();
            gz.finish().unwrap();
        }
        let sha = verify_file_sha256(&shard_path, "").unwrap();

        let mut arxiv_wms = HashMap::new();
        arxiv_wms.insert(
            "cs.SE".to_string(),
            SeedArxivWatermark {
                latest_published_at: "2026-10-01T00:00:00Z".into(),
                latest_arxiv_id: "2610.00001".into(),
                last_synced_at: "2026-11-20T00:00:00Z".into(),
                oldest_synced_published_at: None,
                remote_total: Some(1),
                history_complete: true,
            },
        );
        arxiv_wms.insert(
            "cs.AI".to_string(),
            SeedArxivWatermark {
                latest_published_at: "2026-10-01T00:00:00Z".into(),
                latest_arxiv_id: "2610.99999".into(),
                last_synced_at: "2026-11-20T00:00:00Z".into(),
                oldest_synced_published_at: None,
                remote_total: Some(500),
                history_complete: true,
            },
        );

        let manifest_path = seed_dir.join("manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec(&SeedManifest {
                version: 2,
                generated_at: "2026-11-20T00:00:00Z".into(),
                shards: vec![SeedShardEntry {
                    id: "core-2026-fast".into(),
                    kind: "core".into(),
                    filename: "core-2026-fast.jsonl.gz".into(),
                    sha256: sha,
                    paper_count: 1,
                    categories: vec!["cs.SE".into()],
                }],
                arxiv_watermarks: arxiv_wms,
                venue_watermarks: HashMap::new(),
            })
            .unwrap(),
        )
        .unwrap();

        let out = seed_sync_at(
            &dst_db,
            CollectionSeedSyncArgs {
                manifest_url: Some(manifest_path.to_string_lossy().to_string()),
                force: Some(false),
            },
        )
        .await
        .unwrap();
        assert!(!out.skipped);
        assert_eq!(out.imported_papers, 1);
        assert!(out.state.arxiv_watermarks.contains_key("cs.SE"));
        // cs.AI watermark must NOT advance when `addon-cs-ai` was not applied.
        assert!(!out.state.arxiv_watermarks.contains_key("cs.AI"));

        // Verify FTS5 rebuild indexed the bulk-imported paper.
        let hit1 = super::super::search::search_fast_at(
            &dst_db,
            &super::super::models::CollectionSearchArgs {
                query: Some("Quantum".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(hit1.total_matched, 1);

        // Verify `papers_fts_ai` trigger was restored for subsequent inserts.
        super::super::store::upsert_papers_at(
            &dst_db,
            super::super::models::CollectionUpsertPapersArgs {
                items: vec![CollectionPaperUpsertInput {
                    id: "arxiv:2610.00002".into(),
                    title: "Nebula Symbolic Execution Engine".into(),
                    authors: vec!["Bob Chen".into()],
                    abstract_text: "A subsequent insert verifying restored FTS5 trigger.".into(),
                    published_at: "2026-10-02T00:00:00Z".into(),
                    year: 2026,
                    source_type: "arxiv".into(),
                    source_label: "cs.SE".into(),
                    categories: vec!["cs.SE".into()],
                    arxiv_id: Some("2610.00002".into()),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();
        let hit2 = super::super::search::search_fast_at(
            &dst_db,
            &super::super::models::CollectionSearchArgs {
                query: Some("Nebula".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(hit2.total_matched, 1);
    }

    #[tokio::test]
    async fn seed_sync_http_resumes_part_file_coalesces_single_flight_and_cleans_up() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let tmp = tempfile::tempdir().unwrap();
        let dst_db = tmp.path().join("collection.sqlite");

        let mut shard_buf = Vec::new();
        {
            let mut gz = GzEncoder::new(&mut shard_buf, Compression::default());
            for i in 1..=2 {
                let rec = SeedPaperRecord {
                    id: format!("arxiv:2611.0000{i}"),
                    title: format!("Resumable Single Flight Paper {i}"),
                    authors: vec!["Alice Smith".into()],
                    abstract_text: "Testing HTTP Range resume and single-flight coalescing.".into(),
                    published_at: "2026-11-01T00:00:00Z".into(),
                    year: 2026,
                    source_type: "arxiv".into(),
                    source_label: "cs.SE".into(),
                    categories: vec!["cs.SE".into()],
                    url: format!("https://arxiv.org/abs/2611.0000{i}"),
                    pdf_url: None,
                    arxiv_id: Some(format!("2611.0000{i}")),
                    doi: None,
                    venue_id: None,
                    venue_kind: None,
                    venue_domain: None,
                    ccf_rank: None,
                    venue_full: None,
                    keywords: vec!["Fuzzing".into()],
                    keyword_source: Some("author".into()),
                    openalex_id: None,
                    raw_refs: Vec::new(),
                    refs_checked_at: None,
                    volume: None,
                    issue: None,
                    pages: None,
                    bibtex: None,
                    cool_papers_id: None,
                };
                writeln!(gz, "{}", serde_json::to_string(&rec).unwrap()).unwrap();
            }
            gz.finish().unwrap();
        }
        let sha = hex::encode(Sha256::digest(&shard_buf));
        let manifest_bytes = serde_json::to_vec(&SeedManifest {
            version: 2,
            generated_at: "2026-11-23T00:00:00Z".into(),
            shards: vec![SeedShardEntry {
                id: "core-2026-http".into(),
                kind: "core".into(),
                filename: "core-2026-http.jsonl.gz".into(),
                sha256: sha,
                paper_count: 2,
                categories: vec!["cs.SE".into()],
            }],
            arxiv_watermarks: HashMap::new(),
            venue_watermarks: HashMap::new(),
        })
        .unwrap();

        // Pre-seed the first half of the shard into `.seed-cache/core-2026-http.jsonl.gz.part`.
        let split_at = shard_buf.len() / 2;
        let cache_dir = seed_cache_dir_for(&dst_db);
        fs::create_dir_all(&cache_dir).unwrap();
        let part_path = cache_dir.join("core-2026-http.jsonl.gz.part");
        fs::write(&part_path, &shard_buf[..split_at]).unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let shard_hits = Arc::new(AtomicUsize::new(0));
        let range_hits = Arc::new(AtomicUsize::new(0));
        let shard_hits_srv = Arc::clone(&shard_hits);
        let range_hits_srv = Arc::clone(&range_hits);
        let manifest_srv = manifest_bytes.clone();
        let shard_srv = shard_buf.clone();

        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut req_buf = [0u8; 4096];
                let n = socket.read(&mut req_buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&req_buf[..n]);
                let first_line = req_str.lines().next().unwrap_or("");
                if first_line.contains("/manifest.json") {
                    tokio::time::sleep(Duration::from_millis(60)).await;
                    let hdr = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        manifest_srv.len()
                    );
                    let _ = socket.write_all(hdr.as_bytes()).await;
                    let _ = socket.write_all(&manifest_srv).await;
                } else if first_line.contains("/core-2026-http.jsonl.gz") {
                    shard_hits_srv.fetch_add(1, Ordering::SeqCst);
                    let range_start = req_str
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("range:"))
                        .and_then(|l| l.split_once("bytes="))
                        .and_then(|(_, rest)| rest.split('-').next())
                        .and_then(|s| s.trim().parse::<usize>().ok());
                    if let Some(start) = range_start {
                        range_hits_srv.fetch_add(1, Ordering::SeqCst);
                        let slice = &shard_srv[start..];
                        let hdr = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            start,
                            shard_srv.len() - 1,
                            shard_srv.len(),
                            slice.len()
                        );
                        let _ = socket.write_all(hdr.as_bytes()).await;
                        let _ = socket.write_all(slice).await;
                    } else {
                        let hdr = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            shard_srv.len()
                        );
                        let _ = socket.write_all(hdr.as_bytes()).await;
                        let _ = socket.write_all(&shard_srv).await;
                    }
                }
            }
        });

        let phases: Arc<StdMutex<Vec<CollectionSeedSyncPhase>>> =
            Arc::new(StdMutex::new(Vec::new()));
        let phases_cb = Arc::clone(&phases);
        let cb: SeedProgressCallback = Arc::new(move |p| {
            phases_cb.lock().unwrap().push(p.phase);
        });

        let url = format!("http://{addr}/manifest.json");
        let f1 = seed_sync_at_with_progress(
            &dst_db,
            CollectionSeedSyncArgs {
                manifest_url: Some(url.clone()),
                force: Some(false),
            },
            Some(cb),
        );
        let f2 = seed_sync_at(
            &dst_db,
            CollectionSeedSyncArgs {
                manifest_url: Some(url),
                force: Some(false),
            },
        );

        let (r1, r2) = tokio::join!(f1, f2);
        server.abort();
        let o1 = r1.unwrap();
        let o2 = r2.unwrap();

        assert!(!o1.skipped);
        assert_eq!(o1.imported_papers, 2);
        assert_eq!(o2.imported_papers, 2);
        // Single-flight coalesced the shard download into exactly 1 HTTP Range request.
        assert_eq!(shard_hits.load(Ordering::SeqCst), 1);
        assert_eq!(range_hits.load(Ordering::SeqCst), 1);
        // `.part` file was removed after verified commit.
        assert!(!part_path.exists());

        let recorded = phases.lock().unwrap().clone();
        assert!(recorded.contains(&CollectionSeedSyncPhase::FetchingManifest));
        assert!(recorded.contains(&CollectionSeedSyncPhase::Downloading));
        assert!(recorded.contains(&CollectionSeedSyncPhase::Importing));
        assert!(recorded.contains(&CollectionSeedSyncPhase::Indexing));
        assert_eq!(recorded.last(), Some(&CollectionSeedSyncPhase::Done));
    }

    #[tokio::test]
    async fn seed_sync_cancel_preserves_part_file_and_rolls_back() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let tmp = tempfile::tempdir().unwrap();
        let dst_db = tmp.path().join("collection.sqlite");
        let payload = vec![b'x'; 8192];
        let manifest_bytes = serde_json::to_vec(&SeedManifest {
            version: 2,
            generated_at: "2026-11-23T00:00:00Z".into(),
            shards: vec![SeedShardEntry {
                id: "core-2026-cancel".into(),
                kind: "core".into(),
                filename: "core-2026-cancel.jsonl.gz".into(),
                sha256: "deadbeef".into(),
                paper_count: 10,
                categories: vec!["cs.SE".into()],
            }],
            arxiv_watermarks: HashMap::new(),
            venue_watermarks: HashMap::new(),
        })
        .unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let manifest_srv = manifest_bytes.clone();
        let payload_srv = payload.clone();
        let (chunk_sent_tx, chunk_sent_rx) = tokio::sync::oneshot::channel::<()>();
        let mut chunk_sent_tx = Some(chunk_sent_tx);

        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut req_buf = [0u8; 4096];
                let n = socket.read(&mut req_buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&req_buf[..n]);
                let first_line = req_str.lines().next().unwrap_or("");
                if first_line.contains("/manifest.json") {
                    let hdr = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        manifest_srv.len()
                    );
                    let _ = socket.write_all(hdr.as_bytes()).await;
                    let _ = socket.write_all(&manifest_srv).await;
                } else {
                    let hdr = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        payload_srv.len()
                    );
                    let _ = socket.write_all(hdr.as_bytes()).await;
                    // Send first chunk, wait past the 120ms progress throttle, send second chunk, then stall.
                    let _ = socket.write_all(&payload_srv[..2048]).await;
                    let _ = socket.flush().await;
                    if let Some(tx) = chunk_sent_tx.take() {
                        let _ = tx.send(());
                    }
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
            }
        });

        let phases: Arc<StdMutex<Vec<CollectionSeedSyncPhase>>> =
            Arc::new(StdMutex::new(Vec::new()));
        let phases_cb = Arc::clone(&phases);
        let cb: SeedProgressCallback = Arc::new(move |p| {
            phases_cb.lock().unwrap().push(p.phase);
        });

        let db_for_cancel = dst_db.clone();
        let cancel_driver = tokio::spawn(async move {
            let _ = chunk_sent_rx.await;
            tokio::time::sleep(Duration::from_millis(80)).await;
            assert!(cancel_seed_sync_at(&db_for_cancel));
        });

        let url = format!("http://{addr}/manifest.json");
        let err = seed_sync_at_with_progress(
            &dst_db,
            CollectionSeedSyncArgs {
                manifest_url: Some(url),
                force: Some(false),
            },
            Some(cb),
        )
        .await
        .expect_err("cancelled seed sync must return error");
        let _ = cancel_driver.await;
        server.abort();

        assert_eq!(err.code(), SEED_SYNC_CANCELLED_CODE);
        let recorded = phases.lock().unwrap().clone();
        assert_eq!(recorded.last(), Some(&CollectionSeedSyncPhase::Cancelled));

        // Partial `.part` file stays cached for resume; DB remains cleanly empty.
        let part_path = seed_cache_dir_for(&dst_db).join("core-2026-cancel.jsonl.gz.part");
        assert!(part_path.is_file());
        assert!(fs::metadata(&part_path).unwrap().len() >= 2048);
        let state = super::super::store::state_get_at(&dst_db).unwrap();
        assert_eq!(state.total_count, 0);
        assert!(state.applied_seed_ids.is_empty());
    }
}
