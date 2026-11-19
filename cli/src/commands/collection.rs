//! `agentero collection *` — Plaza Paper Collection headless batch ingest,
//! maintainer seed baker, and GitHub Releases seed importer.

use std::path::{Path, PathBuf};

use agentero_core::features::paper::discovery::collection::{
    self, CollectionClearArgs, CollectionPaperUpsertInput, CollectionSeedSyncArgs,
    CollectionUpsertPapersArgs, SeedBakeOptions, DEFAULT_BAKE_LLM_BASE_URL,
    DEFAULT_BAKE_LLM_BATCH_SIZE, DEFAULT_BAKE_LLM_CONCURRENCY, DEFAULT_BAKE_LLM_MODEL,
    DEFAULT_BAKE_LLM_RPM,
};
use agentero_core::openai_compat::same_endpoint_host;
use clap::{Subcommand, ValueHint};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::CliError;
use crate::output::to_value;
use crate::resolve::GlobalOpts;

const DEFAULT_DESKTOP_PROXY_URL: &str = "http://127.0.0.1:7890";

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DesktopKeywordLlmSettings {
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    api_key: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DesktopNetworkSettings {
    #[serde(default)]
    network_proxy_enabled: bool,
    #[serde(default = "default_desktop_proxy_url")]
    network_proxy_url: String,
    #[serde(default)]
    open_alex_key: String,
    #[serde(default)]
    keyword_llm: DesktopKeywordLlmSettings,
}

fn default_desktop_proxy_url() -> String {
    DEFAULT_DESKTOP_PROXY_URL.to_string()
}

fn parse_desktop_network_settings(raw: &str) -> Option<DesktopNetworkSettings> {
    serde_json::from_str::<DesktopNetworkSettings>(raw).ok()
}

/// Auto-load outbound network proxy (`networkProxyEnabled` + `networkProxyUrl`)
/// and optional `openAlexKey` from desktop `settings.json` (`%APPDATA%\agentero\settings.json`
/// on Windows, `$XDG_CONFIG_HOME/agentero/settings.json` on Unix) before running
/// `seed-bake` or `seed-import`.
///
/// `agentero_core::http` enforces loopback bypass (`127.0.0.1`, `localhost`, `::1`),
/// so external OpenAlex / Semantic Scholar / GitHub requests route through the proxy
/// while local LLM endpoints (e.g. `127.0.0.1:8011`) connect directly.
fn load_desktop_settings(settings_file: &Path) -> Option<DesktopNetworkSettings> {
    let raw = std::fs::read_to_string(settings_file).ok()?;
    parse_desktop_network_settings(&raw)
}

fn apply_desktop_network_settings_from(settings_file: &Path) {
    let Some(cfg) = load_desktop_settings(settings_file) else {
        return;
    };
    let proxy_url = cfg.network_proxy_url.trim();
    if cfg.network_proxy_enabled && !proxy_url.is_empty() {
        if let Err(err) = agentero_core::http::configure_proxy(true, proxy_url) {
            log::warn!(
                "failed to configure network proxy from {}: {err}",
                settings_file.display()
            );
        }
    }
    let oa_key = cfg.open_alex_key.trim();
    if !oa_key.is_empty() && !oa_key.chars().all(|c| c == '*') {
        agentero_core::features::paper::scholar_api::client::set_openalex_api_key(Some(
            oa_key.to_string(),
        ));
    }
}

fn ensure_desktop_network_settings_loaded() {
    apply_desktop_network_settings_from(&agentero_core::paths::settings_path());
}

fn non_masked_key(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '*') {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn read_dotenv_key(path: &Path, key_name: &str) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let cleaned = trimmed.strip_prefix("export ").unwrap_or(trimmed);
        let Some((k, v)) = cleaned.split_once('=') else {
            continue;
        };
        if k.trim() != key_name {
            continue;
        }
        let unquoted = v.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        if let Some(usable) = non_masked_key(unquoted) {
            return Some(usable);
        }
    }
    None
}

const KEYWORD_LLM_API_KEY_ENV: &str = "AGENTERO_KEYWORD_LLM_API_KEY";

fn resolve_bake_llm_api_key(explicit: Option<String>, llm_base_url: &str) -> Option<String> {
    if let Some(k) = explicit.as_deref().and_then(non_masked_key) {
        return Some(k);
    }
    if let Ok(val) = std::env::var(KEYWORD_LLM_API_KEY_ENV) {
        if let Some(usable) = non_masked_key(&val) {
            return Some(usable);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors() {
            let candidate = ancestor.join(".env");
            if candidate.is_file() {
                if let Some(usable) = read_dotenv_key(&candidate, KEYWORD_LLM_API_KEY_ENV) {
                    return Some(usable);
                }
                break;
            }
        }
    }
    if let Some(cfg) = load_desktop_settings(&agentero_core::paths::settings_path()) {
        let same_host = cfg.keyword_llm.base_url.trim().is_empty()
            || same_endpoint_host(llm_base_url, &cfg.keyword_llm.base_url);
        if same_host {
            if let Some(usable) = non_masked_key(&cfg.keyword_llm.api_key) {
                return Some(usable);
            }
        }
    }
    option_env!("AGENTERO_KEYWORD_LLM_API_KEY").and_then(non_masked_key)
}

#[derive(Debug, Subcommand)]
pub enum CollectionCmd {
    /// Inspect `collection.sqlite` summary, venue counts, and arXiv sync watermarks.
    State {
        /// Optional override path to `collection.sqlite`.
        #[arg(long = "db", value_name = "PATH", value_hint = ValueHint::FilePath)]
        db: Option<PathBuf>,
    },

    /// Clear `collection.sqlite` papers/watermarks (`all`, `venue`, `recommended`, `citations`).
    Clear {
        /// Scope to clear (`all`, `papers`, `venue`, `recommended`, `citations`).
        #[arg(long = "scope", value_name = "SCOPE", default_value = "all")]
        scope: String,
        /// Target venue ID when `--scope venue` is used.
        #[arg(long = "venue-id", value_name = "ID")]
        venue_id: Option<String>,
        /// Optional override path to `collection.sqlite`.
        #[arg(long = "db", value_name = "PATH", value_hint = ValueHint::FilePath)]
        db: Option<PathBuf>,
    },

    /// Batch-upsert papers into `collection.sqlite` from a JSON file
    /// (`CollectionUpsertPapersArgs` object or bare `CollectionPaperUpsertInput[]` array).
    UpsertFile {
        /// Path to JSON payload file.
        #[arg(long = "file", value_name = "PATH", value_hint = ValueHint::FilePath)]
        file: PathBuf,
        /// Optional venue ID for diff-based venue replacement.
        #[arg(long = "replace-venue-id", value_name = "ID")]
        replace_venue_id: Option<String>,
        /// Optional override path to `collection.sqlite`.
        #[arg(long = "db", value_name = "PATH", value_hint = ValueHint::FilePath)]
        db: Option<PathBuf>,
    },

    /// Idempotent, resumable maintainer pipeline: backfill outgoing references
    /// (OpenAlex + Semantic Scholar), extract missing keywords via OpenAI-compatible LLM,
    /// and export compressed `.jsonl.gz` seed shards + `manifest.json`.
    SeedBake {
        /// Optional override path to `collection.sqlite`.
        #[arg(long = "db", value_name = "PATH", value_hint = ValueHint::FilePath)]
        db: Option<PathBuf>,
        /// Output directory for `manifest.json` and `.jsonl.gz` shards.
        #[arg(
            long = "out-dir",
            value_name = "DIR",
            default_value = "dist/seed",
            value_hint = ValueHint::DirPath
        )]
        out_dir: PathBuf,
        /// OpenAI-compatible base URL (loopback automatically bypasses proxy).
        #[arg(
            long = "llm-base-url",
            value_name = "URL",
            default_value = DEFAULT_BAKE_LLM_BASE_URL,
            value_hint = ValueHint::Url
        )]
        llm_base_url: String,
        /// Model identifier for 8-paper batch keyword extraction.
        #[arg(
            long = "llm-model",
            value_name = "MODEL",
            default_value = DEFAULT_BAKE_LLM_MODEL
        )]
        llm_model: String,
        /// Optional Bearer API key for the LLM endpoint.
        #[arg(
            long = "llm-api-key",
            value_name = "KEY",
            env = "AGENTERO_KEYWORD_LLM_API_KEY"
        )]
        llm_api_key: Option<String>,
        /// Number of concurrent LLM batches (kept low by default for RPM-capped endpoints).
        #[arg(
            long = "llm-concurrency",
            value_name = "N",
            default_value_t = DEFAULT_BAKE_LLM_CONCURRENCY
        )]
        llm_concurrency: usize,
        /// Number of papers packed per LLM batch request (1-32).
        #[arg(
            long = "llm-batch-size",
            value_name = "N",
            default_value_t = DEFAULT_BAKE_LLM_BATCH_SIZE
        )]
        llm_batch_size: usize,
        /// Hard RPM cap across workers (`0` disables pacing; defaults to `5`).
        #[arg(
            long = "llm-rpm",
            value_name = "N",
            default_value_t = DEFAULT_BAKE_LLM_RPM
        )]
        llm_rpm: u32,
        /// Skip Step A (OpenAlex + Semantic Scholar reference backfill).
        #[arg(long = "skip-refs")]
        skip_refs: bool,
        /// Skip Step B (LLM keyword extraction).
        #[arg(long = "skip-llm")]
        skip_llm: bool,
        /// Bypass 14-day reference check TTL and re-bake non-author keywords.
        #[arg(long = "force-clean")]
        force_clean: bool,
        /// Optional ISO timestamp watermark to also emit a `delta-2026-...jsonl.gz` shard.
        #[arg(long = "delta-since", value_name = "ISO")]
        delta_since: Option<String>,
    },

    /// Stream-import Paper Collection seed shards from a local `manifest.json` path or HTTPS URL.
    SeedImport {
        /// Local path or HTTPS URL to `manifest.json`.
        #[arg(long = "manifest", value_name = "PATH_OR_URL")]
        manifest: String,
        /// Optional override path to `collection.sqlite`.
        #[arg(long = "db", value_name = "PATH", value_hint = ValueHint::FilePath)]
        db: Option<PathBuf>,
        /// Re-import even if `seed_cleared` was set or shard IDs were already applied.
        #[arg(long = "force")]
        force: bool,
    },
}

pub async fn run(cmd: CollectionCmd, globals: &GlobalOpts) -> Result<Value, CliError> {
    match cmd {
        CollectionCmd::State { db } => {
            let db_path = db.unwrap_or_else(collection::collection_db_path);
            let state = tokio::task::spawn_blocking(move || collection::state_get_at(&db_path))
                .await
                .map_err(|e| CliError::message(format!("collection state join failed: {e}")))?
                .map_err(CliError::from)?;
            let lines = vec![globals.style.ok(&format!(
                "collection pool: {} papers (arxiv: {}, venue: {}, watermarks: {})",
                state.total_count,
                state.arxiv_count,
                state.venue_count,
                state.arxiv_watermarks.len()
            ))];
            let mut out = to_value(&state)?;
            if let Some(obj) = out.as_object_mut() {
                obj.insert("lines".into(), json!(lines));
            }
            Ok(out)
        }
        CollectionCmd::Clear {
            scope,
            venue_id,
            db,
        } => {
            let msg = match venue_id.as_deref() {
                Some(vid) => format!("Clear collection scope '{scope}' for venue '{vid}'?"),
                None => format!("Clear collection scope '{scope}'?"),
            };
            if !crate::prompt::confirm(globals, &msg, false)? {
                return Err(CliError::needs_confirmation("collection clear cancelled"));
            }
            let db_path = db.unwrap_or_else(collection::collection_db_path);
            let args = CollectionClearArgs {
                scope: scope.clone(),
                venue_id,
            };
            let state = tokio::task::spawn_blocking(move || {
                collection::clear_collection_at(&db_path, &args)
            })
            .await
            .map_err(|e| CliError::message(format!("collection clear join failed: {e}")))?
            .map_err(CliError::from)?;
            let lines = vec![globals.style.ok(&format!(
                "cleared collection scope '{scope}' (remaining pool: {})",
                state.total_count
            ))];
            let mut out = to_value(&state)?;
            if let Some(obj) = out.as_object_mut() {
                obj.insert("lines".into(), json!(lines));
            }
            Ok(out)
        }
        CollectionCmd::UpsertFile {
            file,
            replace_venue_id,
            db,
        } => run_upsert_file(globals, file, replace_venue_id, db).await,
        CollectionCmd::SeedBake {
            db,
            out_dir,
            llm_base_url,
            llm_model,
            llm_api_key,
            llm_concurrency,
            llm_batch_size,
            llm_rpm,
            skip_refs,
            skip_llm,
            force_clean,
            delta_since,
        } => {
            ensure_desktop_network_settings_loaded();
            let db_path = db.unwrap_or_else(collection::collection_db_path);
            let resolved_api_key = resolve_bake_llm_api_key(llm_api_key, &llm_base_url);
            let opts = SeedBakeOptions {
                out_dir,
                llm_base_url,
                llm_model,
                llm_api_key: resolved_api_key,
                llm_concurrency,
                llm_batch_size,
                llm_rpm,
                skip_refs,
                skip_llm,
                force_clean,
                delta_since,
            };
            let report = collection::seed_bake_at(&db_path, opts)
                .await
                .map_err(CliError::from)?;
            let lines = vec![globals.style.ok(&format!(
                "baked {} shards (openalex works: {}, s2 works: {}, llm papers: {}) -> {}",
                report.shards.len(),
                report.openalex_enriched_works,
                report.s2_enriched_works,
                report.llm_enriched_papers,
                report.manifest_path
            ))];
            let mut out = to_value(&report)?;
            if let Some(obj) = out.as_object_mut() {
                obj.insert("lines".into(), json!(lines));
            }
            Ok(out)
        }
        CollectionCmd::SeedImport {
            manifest,
            db,
            force,
        } => {
            ensure_desktop_network_settings_loaded();
            let db_path = db.unwrap_or_else(collection::collection_db_path);
            let res = collection::seed_sync_at(
                &db_path,
                CollectionSeedSyncArgs {
                    manifest_url: Some(manifest),
                    force: Some(force),
                },
            )
            .await
            .map_err(CliError::from)?;
            let lines = if res.skipped {
                vec![globals.style.dim("seed sync skipped")]
            } else {
                vec![globals.style.ok(&format!(
                    "imported {} papers from {} shard(s) (total pool: {})",
                    res.imported_papers,
                    res.applied_shards.len(),
                    res.state.total_count
                ))]
            };
            let mut out = to_value(&res)?;
            if let Some(obj) = out.as_object_mut() {
                obj.insert("lines".into(), json!(lines));
            }
            Ok(out)
        }
    }
}

async fn run_upsert_file(
    globals: &GlobalOpts,
    file: PathBuf,
    replace_venue_id: Option<String>,
    db: Option<PathBuf>,
) -> Result<Value, CliError> {
    let raw = std::fs::read_to_string(&file)?;
    let trimmed = raw.trim_start();
    let mut args: CollectionUpsertPapersArgs = if trimmed.starts_with('[') {
        let items: Vec<CollectionPaperUpsertInput> = serde_json::from_str(&raw).map_err(|e| {
            CliError::usage(format!("invalid JSON array in {}: {e}", file.display()))
        })?;
        CollectionUpsertPapersArgs {
            items,
            ..Default::default()
        }
    } else {
        serde_json::from_str(&raw).map_err(|e| {
            CliError::usage(format!(
                "invalid CollectionUpsertPapersArgs JSON in {}: {e}",
                file.display()
            ))
        })?
    };

    if let Some(vid) = replace_venue_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        args.replace_venue_id = Some(vid);
    }

    let item_count = args.items.len();
    let db_path = db.unwrap_or_else(collection::collection_db_path);
    let state = tokio::task::spawn_blocking(move || collection::upsert_papers_at(&db_path, args))
        .await
        .map_err(|e| CliError::message(format!("upsert-file join failed: {e}")))?
        .map_err(CliError::from)?;

    let lines = vec![globals.style.ok(&format!(
        "upserted {} input items (total pool: {}, arxiv: {}, venue: {})",
        item_count, state.total_count, state.arxiv_count, state.venue_count
    ))];
    let mut out = to_value(&state)?;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("upsertedInputCount".into(), json!(item_count));
        obj.insert("lines".into(), json!(lines));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::OutputFormat;
    use crate::style::Style;

    fn test_globals() -> GlobalOpts {
        GlobalOpts {
            vault_flag: None,
            yes: true,
            quiet: true,
            translator_url: None,
            format: OutputFormat::Json,
            pretty: false,
            style: Style::new(false),
        }
    }

    #[tokio::test]
    async fn cli_collection_upsert_file_bake_and_import_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let db1 = tmp.path().join("src.sqlite");
        let db2 = tmp.path().join("dst.sqlite");
        let out_dir = tmp.path().join("seed");
        let input_json = tmp.path().join("batch.json");

        std::fs::write(
            &input_json,
            serde_json::json!([
                {
                    "id": "venue:usenix-2026:p1",
                    "title": "Fuzzing Embedded Firmware with Symbolic Summaries",
                    "authors": ["Alice Security"],
                    "abstractText": "We propose symbolic summaries for firmware fuzzing.",
                    "publishedAt": "2026-08-12T00:00:00Z",
                    "year": 2026,
                    "sourceType": "venue",
                    "sourceLabel": "USENIX Security 2026",
                    "venueId": "usenix-2026",
                    "ccfRank": "CCF-A",
                    "doi": "10.5555/usenix.2026.1",
                    "keywords": ["Fuzzing"],
                    "keywordSource": "author",
                    "rawRefs": ["doi:10.5555/usenix.2026.2"]
                },
                {
                    "id": "venue:usenix-2026:p2",
                    "title": "Foundational Firmware Emulation",
                    "authors": ["Bob Emulation"],
                    "abstractText": "Fast rehosting and emulation for embedded targets.",
                    "publishedAt": "2026-08-12T00:00:00Z",
                    "year": 2026,
                    "sourceType": "venue",
                    "sourceLabel": "USENIX Security 2026",
                    "venueId": "usenix-2026",
                    "ccfRank": "CCF-A",
                    "doi": "10.5555/usenix.2026.2",
                    "keywords": ["Firmware Analysis"],
                    "keywordSource": "author"
                }
            ])
            .to_string(),
        )
        .unwrap();

        let globals = test_globals();
        let upsert_val = run(
            CollectionCmd::UpsertFile {
                file: input_json,
                replace_venue_id: Some("usenix-2026".into()),
                db: Some(db1.clone()),
            },
            &globals,
        )
        .await
        .unwrap();
        assert_eq!(upsert_val["totalCount"], 2);
        assert_eq!(upsert_val["upsertedInputCount"], 2);

        let state_val = run(
            CollectionCmd::State {
                db: Some(db1.clone()),
            },
            &globals,
        )
        .await
        .unwrap();
        assert_eq!(state_val["totalCount"], 2);

        // Pre-seed a stale shard file to verify `seed-bake` prunes old `.jsonl.gz` assets.
        std::fs::create_dir_all(&out_dir).unwrap();
        let stale_shard = out_dir.join("core-2026-00000000.jsonl.gz");
        std::fs::write(&stale_shard, b"stale").unwrap();

        let bake_val = run(
            CollectionCmd::SeedBake {
                db: Some(db1.clone()),
                out_dir: out_dir.clone(),
                llm_base_url: DEFAULT_BAKE_LLM_BASE_URL.into(),
                llm_model: DEFAULT_BAKE_LLM_MODEL.into(),
                llm_api_key: None,
                llm_concurrency: 1,
                llm_batch_size: DEFAULT_BAKE_LLM_BATCH_SIZE,
                llm_rpm: DEFAULT_BAKE_LLM_RPM,
                skip_refs: true,
                skip_llm: true,
                force_clean: false,
                delta_since: None,
            },
            &globals,
        )
        .await
        .unwrap();
        assert_eq!(bake_val["shards"].as_array().unwrap().len(), 1);
        assert!(
            !stale_shard.exists(),
            "seed-bake must prune stale .jsonl.gz files in out_dir"
        );

        let cleared_val = run(
            CollectionCmd::Clear {
                scope: "all".into(),
                venue_id: None,
                db: Some(db1),
            },
            &globals,
        )
        .await
        .unwrap();
        assert_eq!(cleared_val["totalCount"], 0);

        let import_val = run(
            CollectionCmd::SeedImport {
                manifest: out_dir.join("manifest.json").to_string_lossy().to_string(),
                db: Some(db2.clone()),
                force: false,
            },
            &globals,
        )
        .await
        .unwrap();
        assert_eq!(import_val["importedPapers"], 2);
        let p2 = collection::paper_get_at(&db2, "venue:usenix-2026:p2")
            .unwrap()
            .unwrap();
        assert_eq!(p2.citation_count, 1);
    }

    #[test]
    fn desktop_settings_loader_parses_proxy_and_openalex_key() {
        let tmp = tempfile::tempdir().unwrap();
        let settings_file = tmp.path().join("settings.json");
        std::fs::write(
            &settings_file,
            r#"{"networkProxyEnabled":true,"networkProxyUrl":"http://127.0.0.1:7890","openAlexKey":"oa-test-key-123"}"#,
        )
        .unwrap();

        let parsed =
            parse_desktop_network_settings(&std::fs::read_to_string(&settings_file).unwrap())
                .unwrap();
        assert!(parsed.network_proxy_enabled);
        assert_eq!(parsed.network_proxy_url, "http://127.0.0.1:7890");
        assert_eq!(parsed.open_alex_key, "oa-test-key-123");

        apply_desktop_network_settings_from(&settings_file);
        assert_eq!(
            agentero_core::features::paper::scholar_api::client::openalex_api_key().as_deref(),
            Some("oa-test-key-123")
        );

        // Reset global state cleanly after test
        let _ = agentero_core::http::configure_proxy(false, "");
        agentero_core::features::paper::scholar_api::client::set_openalex_api_key(None);
    }
}
