//! arXiv daily recommendation — rank new arXiv papers against the Vault library.
//!
//! Candidates come from the arXiv category RSS feeds; the corpus is every
//! library paper that has an abstract. Both sides are embedded through the
//! user's OpenAI-compatible endpoint (Settings → Agent → Embedding) and scored
//! by cosine similarity weighted by how recently each corpus paper was added.
//!
//! Vectors and the last run are cached in `catalog.sqlite` (schema v6), so a
//! same-day open reuses the previous result without touching the network.

use crate::core::error::AppError;
use crate::core::http;
use crate::features::paper::catalog::papers;
use crate::features::paper::catalog::with_catalog;
use crate::features::paper::discovery::embeddings;
use crate::features::paper::discovery::feeds::parse::parse_feed_bytes;
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

/// Categories used when the caller and the stored state have none.
pub const DEFAULT_CATEGORIES: &[&str] = &["cs.AI", "cs.CR", "cs.PL", "cs.SE"];

/// Recommendations returned to the page when the caller does not ask for more.
pub const DEFAULT_TOP_N: usize = 20;

/// Cap on abstracts embedded per request so one run cannot fan out unbounded.
const MAX_CORPUS: usize = 2_000;
/// Chars of an abstract sent for embedding (providers cap tokens per input).
const MAX_EMBED_CHARS: usize = 4_000;
const FEED_TIMEOUT: Duration = Duration::from_secs(30);
const EMBED_TIMEOUT: Duration = Duration::from_secs(120);
/// Shorter than a real embed because the probe only needs the response shape.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Marker error the UI turns into "configure an embedding model first".
pub const ERR_NO_EMBEDDING: &str = "recommend.no_embedding";
/// Marker error the UI turns into "embedding endpoint is unreachable".
pub const ERR_PROBE_FAILED: &str = "recommend.probe_failed";

/// Single token sent for a liveness probe — cheap, and any real embedding
/// provider must accept an input of this length.
const PROBE_INPUT: &str = "hi";

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecommendItem {
    pub arxiv_id: String,
    pub title: String,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
    pub url: String,
    pub published_at: Option<String>,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecommendResult {
    pub items: Vec<RecommendItem>,
    /// RFC3339 timestamp of the run that produced `items`.
    pub computed_at: String,
    pub categories: Vec<String>,
    pub corpus_size: usize,
    /// True when `items` came from the stored same-day run.
    pub reused_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProbeEmbeddingResult {
    /// Dimensionality reported by the embedding endpoint for the probe input.
    pub dim: usize,
    /// Wall-clock latency of the probe request in milliseconds.
    pub latency_ms: u64,
}

/// Read the most recent stored run without recomputing (page open / prewarm).
pub fn last_result(vault_root: &Path) -> Result<Option<RecommendResult>, AppError> {
    with_catalog(vault_root, latest_run_result)
}

/// Inputs that identify a cached run; also its cache key.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunParams {
    categories: Vec<String>,
    top_n: usize,
    model: String,
}

/// Stable cache key for a run: source + model + top_n + ordered categories.
/// Different top_n / model / categories therefore never share a slot.
fn run_key(source: &str, params: &RunParams) -> String {
    let categories = params
        .categories
        .iter()
        .map(|c| c.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(",");
    text_hash(&format!(
        "{source}|{}|{}|{categories}",
        params.model, params.top_n
    ))
}

/// Categories to use when the caller passes none: last run's, else defaults.
fn resolve_categories(conn: &Connection, requested: Option<Vec<String>>) -> Vec<String> {
    if let Some(list) = requested {
        let cleaned = normalize_categories(list);
        if !cleaned.is_empty() {
            return cleaned;
        }
    }
    if let Ok(Some(params)) = latest_run_params(conn) {
        if !params.categories.is_empty() {
            return params.categories;
        }
    }
    DEFAULT_CATEGORIES.iter().map(|c| c.to_string()).collect()
}

/// Trim, drop empties, and de-duplicate while preserving the caller's order.
fn normalize_categories(raw: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for cat in raw {
        let trimmed = cat.trim();
        if trimmed.is_empty() || trimmed.len() > 40 {
            continue;
        }
        if !out.iter().any(|c| c.eq_ignore_ascii_case(trimmed)) {
            out.push(trimmed.to_string());
        }
    }
    out
}

/// Decode one `discovery_runs` row into a cached `RecommendResult`.
fn parse_run_row(row: (String, String, String)) -> Option<RecommendResult> {
    let (computed_at, params_json, results_json) = row;
    let params: RunParams = serde_json::from_str(&params_json).ok()?;
    let items: Vec<RecommendItem> = serde_json::from_str(&results_json).unwrap_or_default();
    Some(RecommendResult {
        items,
        computed_at,
        categories: params.categories,
        corpus_size: 0,
        reused_cache: true,
    })
}

fn read_run(conn: &Connection, key: &str) -> Result<Option<RecommendResult>, AppError> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT computed_at, params_json, results_json FROM discovery_runs WHERE key = ?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(AppError::from)?;
    Ok(row.and_then(parse_run_row))
}

fn latest_run_result(conn: &Connection) -> Result<Option<RecommendResult>, AppError> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT computed_at, params_json, results_json FROM discovery_runs
             ORDER BY computed_at DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(AppError::from)?;
    Ok(row.and_then(parse_run_row))
}

fn latest_run_params(conn: &Connection) -> Result<Option<RunParams>, AppError> {
    let row: Option<String> = conn
        .query_row(
            "SELECT params_json FROM discovery_runs ORDER BY computed_at DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(AppError::from)?;
    Ok(row.and_then(|json| serde_json::from_str(&json).ok()))
}

fn write_run(
    conn: &Connection,
    key: &str,
    params: &RunParams,
    result: &RecommendResult,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO discovery_runs(key, source, computed_at, params_json, results_json)
         VALUES(?1, 'arxiv', ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET
            computed_at = excluded.computed_at,
            params_json = excluded.params_json,
            results_json = excluded.results_json",
        rusqlite::params![
            key,
            result.computed_at,
            serde_json::to_string(params)?,
            serde_json::to_string(&result.items)?
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

/// True when `computed_at` falls on today's UTC date and the run has items.
/// Model / categories / top_n are part of the cache key, so a hit already
/// implies those match.
fn is_fresh(state: &RecommendResult) -> bool {
    if state.items.is_empty() {
        return false;
    }
    let today = Utc::now().format("%Y-%m-%d").to_string();
    state.computed_at.starts_with(&today)
}

/// One arXiv candidate before scoring.
struct Candidate {
    arxiv_id: String,
    title: String,
    abstract_text: String,
    url: String,
    published_at: Option<String>,
}

/// Fetch each category RSS and collect de-duplicated candidates with abstracts.
async fn fetch_candidates(categories: &[String]) -> Result<Vec<Candidate>, AppError> {
    let client = http::client_builder()
        .timeout(FEED_TIMEOUT)
        .build()
        .map_err(|e| AppError::message(format!("recommend http client: {e}")))?;
    let mut out: Vec<Candidate> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut last_error: Option<AppError> = None;

    for category in categories {
        let url = format!("https://rss.arxiv.org/rss/{category}");
        let parsed = match fetch_feed(&client, &url, category).await {
            Ok(feed) => feed,
            Err(e) => {
                log::warn!(target: "agentero::recommend", "feed {category} failed: {e}");
                last_error = Some(e);
                continue;
            }
        };
        for item in parsed {
            let abstract_text = item.summary_text.trim().to_string();
            let title = item.title.trim().to_string();
            if abstract_text.is_empty() || title.is_empty() {
                continue;
            }
            // `paper_url` is already normalized to https://arxiv.org/abs/<id>.
            let Some(paper_url) = item.paper_url.clone() else {
                continue;
            };
            let arxiv_id = paper_url.rsplit('/').next().unwrap_or_default().to_string();
            if arxiv_id.is_empty() || seen.iter().any(|s| s == &arxiv_id) {
                continue;
            }
            seen.push(arxiv_id.clone());
            out.push(Candidate {
                arxiv_id,
                title,
                abstract_text,
                url: paper_url,
                published_at: item.published_at.clone(),
            });
        }
    }

    if out.is_empty() {
        if let Some(e) = last_error {
            return Err(e);
        }
    }
    Ok(out)
}

async fn fetch_feed(
    client: &reqwest::Client,
    url: &str,
    fallback_title: &str,
) -> Result<Vec<crate::features::paper::discovery::feeds::parse::ParsedItem>, AppError> {
    let resp = client
        .get(url)
        .header("User-Agent", "Agentero/1.0 (+https://github.com/Phil-Fan)")
        .send()
        .await
        .map_err(|e| AppError::message(format!("recommend feed fetch: {e}")))?;
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::message(format!("recommend feed body: {e}")))?;
    if !status.is_success() {
        return Err(AppError::message(format!(
            "recommend feed {url} returned {status}"
        )));
    }
    Ok(parse_feed_bytes(&bytes, fallback_title)?.items)
}

fn embed_text(title: &str, abstract_text: &str) -> String {
    let joined = format!("{}\n\n{}", title.trim(), abstract_text.trim());
    joined.chars().take(MAX_EMBED_CHARS).collect()
}

fn text_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn vector_to_blob(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn blob_to_vector(blob: &[u8]) -> Vec<f32> {
    blob.as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect()
}

/// Look up cached vectors for `hashes`, keyed by hash.
fn read_cached_vectors(
    conn: &Connection,
    model: &str,
    hashes: &[String],
) -> Result<HashMap<String, Vec<f32>>, AppError> {
    let mut out = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT vector FROM embed_cache WHERE text_hash = ?1 AND model = ?2")
        .map_err(AppError::from)?;
    for hash in hashes {
        let blob: Option<Vec<u8>> = stmt
            .query_row(rusqlite::params![hash, model], |r| r.get(0))
            .optional()
            .map_err(AppError::from)?;
        if let Some(blob) = blob {
            let vector = blob_to_vector(&blob);
            if !vector.is_empty() {
                out.insert(hash.clone(), vector);
            }
        }
    }
    Ok(out)
}

fn write_cached_vectors(
    conn: &Connection,
    model: &str,
    entries: &[(String, Vec<f32>)],
) -> Result<(), AppError> {
    let mut stmt = conn
        .prepare(
            "INSERT INTO embed_cache(text_hash, model, dim, vector) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(text_hash, model) DO UPDATE SET
                dim = excluded.dim, vector = excluded.vector",
        )
        .map_err(AppError::from)?;
    for (hash, vector) in entries {
        stmt.execute(rusqlite::params![
            hash,
            model,
            vector.len() as i64,
            vector_to_blob(vector)
        ])
        .map_err(AppError::from)?;
    }
    Ok(())
}

/// Liveness probe: POST one tiny input, confirm the endpoint actually serves
/// `/embeddings`, and report the returned dimensionality + latency.
///
/// Returns `AppError::message(ERR_PROBE_FAILED)` for any failure so the UI
/// can switch the arxiv daily panel into its "unreachable" state.
pub async fn probe_embedding_endpoint(
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
) -> Result<ProbeEmbeddingResult, AppError> {
    let endpoint = embeddings::resolve_endpoint(base_url);
    if endpoint.is_empty() {
        return Err(AppError::message(format!(
            "{ERR_PROBE_FAILED}: empty base URL"
        )));
    }
    let client = http::client_builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|e| AppError::message(format!("{ERR_PROBE_FAILED}: {e}")))?;
    let inputs = [PROBE_INPUT.to_string()];
    let started = std::time::Instant::now();
    let vectors = embeddings::embed_batch(&client, &endpoint, api_key, model, &inputs)
        .await
        .map_err(|e| AppError::message(format!("{ERR_PROBE_FAILED}: {e}")))?;
    let dim = vectors.first().map(Vec::len).unwrap_or(0);
    if dim == 0 {
        return Err(AppError::message(format!(
            "{ERR_PROBE_FAILED}: response has no embedding"
        )));
    }
    Ok(ProbeEmbeddingResult {
        dim,
        latency_ms: started.elapsed().as_millis() as u64,
    })
}

/// Embed every text, serving hits from `embed_cache` and caching new vectors.
async fn embed_all(
    vault_root: &Path,
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, AppError> {
    let hashes: Vec<String> = texts.iter().map(|t| text_hash(t)).collect();
    let cached = {
        let vault = vault_root.to_path_buf();
        let model = model.to_string();
        let hashes = hashes.clone();
        with_catalog(&vault, |conn| read_cached_vectors(conn, &model, &hashes))?
    };

    // Unique misses only: the same abstract can appear twice in one request.
    let mut missing: Vec<(String, String)> = Vec::new();
    for (hash, text) in hashes.iter().zip(texts.iter()) {
        if cached.contains_key(hash) || missing.iter().any(|(h, _)| h == hash) {
            continue;
        }
        missing.push((hash.clone(), text.clone()));
    }

    let client = http::client_builder()
        .timeout(EMBED_TIMEOUT)
        .build()
        .map_err(|e| AppError::message(format!("recommend http client: {e}")))?;
    let mut fresh: Vec<(String, Vec<f32>)> = Vec::new();
    for chunk in missing.chunks(embeddings::EMBED_BATCH) {
        let inputs: Vec<String> = chunk.iter().map(|(_, t)| t.clone()).collect();
        let vectors = embeddings::embed_batch(&client, endpoint, api_key, model, &inputs).await?;
        for ((hash, _), vector) in chunk.iter().zip(vectors) {
            fresh.push((hash.clone(), vector));
        }
    }

    if !fresh.is_empty() {
        let vault = vault_root.to_path_buf();
        let model = model.to_string();
        let entries = fresh.clone();
        with_catalog(&vault, |conn| write_cached_vectors(conn, &model, &entries))?;
    }

    let mut by_hash = cached;
    for (hash, vector) in fresh {
        by_hash.insert(hash, vector);
    }
    hashes
        .iter()
        .map(|hash| {
            by_hash
                .get(hash)
                .cloned()
                .ok_or_else(|| AppError::message("embedding missing after fetch"))
        })
        .collect()
}

/// Weights for corpus papers ordered newest-first: `1/(1+log10(rank+1))`,
/// normalized to sum to 1 so recently added papers dominate the score.
fn time_decay_weights(len: usize) -> Vec<f32> {
    let raw: Vec<f32> = (0..len)
        .map(|i| 1.0 / (1.0 + ((i + 1) as f32).log10()))
        .collect();
    let total: f32 = raw.iter().sum();
    if total <= 0.0 {
        return vec![0.0; len];
    }
    raw.into_iter().map(|w| w / total).collect()
}

/// Recompute recommendations, or return the stored run when it is still fresh.
///
/// `settings` is the resolved embedding endpoint `(base_url, api_key, model)`;
/// callers read it from `AppSettingsStore` before awaiting.
pub async fn recommend(
    vault_root: &Path,
    requested_categories: Option<Vec<String>>,
    top_n: Option<usize>,
    force: bool,
    embedding: Option<(String, Option<String>, String)>,
) -> Result<RecommendResult, AppError> {
    let categories = {
        let vault = vault_root.to_path_buf();
        with_catalog(&vault, |conn| {
            Ok(resolve_categories(conn, requested_categories))
        })?
    };
    let top_n = top_n.unwrap_or(DEFAULT_TOP_N).clamp(1, 100);

    // Cache by the inputs the run depends on. Without a configured model we
    // cannot compute the key, so fall back to the latest run (still same-day
    // gated) — this keeps page-open/prewarm rendering a stored result when the
    // endpoint is temporarily unavailable.
    let cache_key = embedding.as_ref().map(|(_, _, model)| {
        run_key(
            "arxiv",
            &RunParams {
                categories: categories.clone(),
                top_n,
                model: model.clone(),
            },
        )
    });

    if !force {
        let stored = {
            let vault = vault_root.to_path_buf();
            let cache_key = cache_key.clone();
            with_catalog(&vault, move |conn| match &cache_key {
                Some(key) => read_run(conn, key),
                None => latest_run_result(conn),
            })?
        };
        if let Some(state) = stored {
            if is_fresh(&state) {
                return Ok(state);
            }
        }
    }

    let Some((base_url, api_key, model)) = embedding else {
        return Err(AppError::message(ERR_NO_EMBEDDING));
    };
    let endpoint = embeddings::resolve_endpoint(&base_url);
    if endpoint.is_empty() {
        return Err(AppError::message(ERR_NO_EMBEDDING));
    }

    // Corpus: library papers with an abstract, newest-added first.
    let corpus_texts = {
        let vault = vault_root.to_path_buf();
        let mut rows = papers::list_all_unique_by_id(&vault)?
            .into_iter()
            .filter_map(|row| {
                let abstract_text = row.abstract_text.unwrap_or_default();
                if abstract_text.trim().is_empty() {
                    return None;
                }
                Some((row.added_at, embed_text(&row.title, &abstract_text)))
            })
            .collect::<Vec<_>>();
        rows.sort_by(|a, b| b.0.cmp(&a.0));
        rows.truncate(MAX_CORPUS);
        rows.into_iter().map(|(_, text)| text).collect::<Vec<_>>()
    };
    if corpus_texts.is_empty() {
        return Err(AppError::message("recommend.empty_corpus"));
    }

    let candidates = fetch_candidates(&categories).await?;
    if candidates.is_empty() {
        return Err(AppError::message("recommend.no_candidates"));
    }

    let candidate_texts: Vec<String> = candidates
        .iter()
        .map(|c| embed_text(&c.title, &c.abstract_text))
        .collect();

    let mut corpus_vectors = embed_all(
        vault_root,
        &endpoint,
        api_key.as_deref(),
        &model,
        &corpus_texts,
    )
    .await?;
    let mut candidate_vectors = embed_all(
        vault_root,
        &endpoint,
        api_key.as_deref(),
        &model,
        &candidate_texts,
    )
    .await?;
    for v in corpus_vectors.iter_mut() {
        embeddings::normalize(v);
    }
    for v in candidate_vectors.iter_mut() {
        embeddings::normalize(v);
    }

    let weights = time_decay_weights(corpus_vectors.len());
    let mut scored: Vec<RecommendItem> = candidates
        .into_iter()
        .zip(candidate_vectors.iter())
        .map(|(candidate, cv)| {
            let score = corpus_vectors
                .iter()
                .zip(weights.iter())
                .map(|(corpus_vector, weight)| {
                    // Mismatched dims mean two different models wrote the cache.
                    if corpus_vector.len() == cv.len() {
                        embeddings::dot(corpus_vector, cv) * weight
                    } else {
                        0.0
                    }
                })
                .sum::<f32>();
            RecommendItem {
                arxiv_id: candidate.arxiv_id,
                title: candidate.title,
                abstract_text: candidate.abstract_text,
                url: candidate.url,
                published_at: candidate.published_at,
                score,
            }
        })
        .collect();
    scored.sort_by(|a, b| b.score.total_cmp(&a.score));
    scored.truncate(top_n);

    let result = RecommendResult {
        items: scored,
        computed_at: crate::core::time::now_rfc3339_millis(),
        categories,
        corpus_size: corpus_vectors.len(),
        reused_cache: false,
    };
    {
        let params = RunParams {
            categories: result.categories.clone(),
            top_n,
            model: model.clone(),
        };
        let key = run_key("arxiv", &params);
        let vault = vault_root.to_path_buf();
        let to_store = result.clone();
        with_catalog(&vault, |conn| write_run(conn, &key, &params, &to_store))?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_favor_recent_and_sum_to_one() {
        let w = time_decay_weights(4);
        assert_eq!(w.len(), 4);
        assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-5);
        // Newest-first ordering means each weight is smaller than the previous.
        for pair in w.windows(2) {
            assert!(pair[0] > pair[1], "weights must decay: {w:?}");
        }
    }

    #[test]
    fn vector_blob_roundtrip() {
        let vector = vec![0.5_f32, -1.25, 0.0, 3.75];
        assert_eq!(blob_to_vector(&vector_to_blob(&vector)), vector);
    }

    #[test]
    fn categories_dedupe_and_trim() {
        let out = normalize_categories(vec![
            " cs.AI ".into(),
            "cs.ai".into(),
            String::new(),
            "cs.LG".into(),
        ]);
        assert_eq!(out, vec!["cs.AI".to_string(), "cs.LG".to_string()]);
    }

    fn sample_result(computed_at: String) -> RecommendResult {
        RecommendResult {
            items: vec![RecommendItem {
                arxiv_id: "1".into(),
                title: "t".into(),
                abstract_text: "a".into(),
                url: "u".into(),
                published_at: None,
                score: 1.0,
            }],
            computed_at,
            categories: vec!["cs.AI".to_string()],
            corpus_size: 1,
            reused_cache: true,
        }
    }

    #[test]
    fn freshness_requires_same_day_and_items() {
        let today = sample_result(crate::core::time::now_rfc3339_millis());
        assert!(is_fresh(&today));
        // Stale date → recompute.
        let stale = sample_result("2020-01-01T00:00:00Z".into());
        assert!(!is_fresh(&stale));
        // No items → recompute even when the date matches.
        let empty = RecommendResult {
            items: Vec::new(),
            ..today
        };
        assert!(!is_fresh(&empty));
    }

    #[test]
    fn run_key_varies_with_model_top_n_and_categories() {
        let base = RunParams {
            categories: vec!["cs.AI".to_string()],
            top_n: 20,
            model: "text-embedding-3-small".to_string(),
        };
        let key = run_key("arxiv", &base);

        // Same inputs (category case-insensitive) → same slot.
        let same = RunParams {
            categories: vec!["CS.ai".to_string()],
            ..base.clone()
        };
        assert_eq!(key, run_key("arxiv", &same));

        // Each input change is its own slot.
        assert_ne!(
            key,
            run_key(
                "arxiv",
                &RunParams {
                    top_n: 50,
                    ..base.clone()
                }
            )
        );
        assert_ne!(
            key,
            run_key(
                "arxiv",
                &RunParams {
                    model: "other-model".to_string(),
                    ..base.clone()
                }
            )
        );
        assert_ne!(
            key,
            run_key(
                "arxiv",
                &RunParams {
                    categories: vec!["cs.LG".to_string()],
                    ..base.clone()
                }
            )
        );
    }

    #[test]
    fn run_rows_roundtrip_through_the_multitable() {
        let dir =
            std::env::temp_dir().join(format!("agentero-recommend-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::features::paper::catalog::ensure_catalog(&dir).expect("catalog");

        let params = RunParams {
            categories: vec!["cs.AI".to_string()],
            top_n: 20,
            model: "m".to_string(),
        };
        let key = run_key("arxiv", &params);
        let result = sample_result(crate::core::time::now_rfc3339_millis());
        write_run(&conn, &key, &params, &result).unwrap();

        let read = read_run(&conn, &key).unwrap().expect("row");
        assert_eq!(read.items.len(), 1);
        assert_eq!(read.categories, vec!["cs.AI".to_string()]);
        assert!(read.reused_cache);

        // A different key is a different slot; latest still resolves.
        let other = RunParams {
            top_n: 50,
            ..params.clone()
        };
        write_run(
            &conn,
            &run_key("arxiv", &other),
            &other,
            &sample_result(crate::core::time::now_rfc3339_millis()),
        )
        .unwrap();
        assert!(read_run(&conn, &key).unwrap().is_some());
        assert!(latest_run_result(&conn).unwrap().is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Tauri command shells for this feature.
pub mod commands;
