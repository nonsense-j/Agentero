//! `agentero collection *` — Plaza Paper Collection headless batch ingest,
//! maintainer seed baker, and GitHub Releases seed importer.

use std::path::PathBuf;

use agentero_core::features::paper::discovery::collection::{
    self, CollectionPaperUpsertInput, CollectionSeedSyncArgs, CollectionUpsertPapersArgs,
    SeedBakeOptions, DEFAULT_BAKE_LLM_BASE_URL, DEFAULT_BAKE_LLM_MODEL,
};
use clap::{Subcommand, ValueHint};
use serde_json::{json, Value};

use crate::error::CliError;
use crate::output::to_value;
use crate::resolve::GlobalOpts;

#[derive(Debug, Subcommand)]
pub enum CollectionCmd {
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
            env = "AGENTERO_SEED_LLM_API_KEY"
        )]
        llm_api_key: Option<String>,
        /// Number of concurrent 8-paper LLM batches.
        #[arg(long = "llm-concurrency", value_name = "N", default_value_t = 6)]
        llm_concurrency: usize,
        /// Skip Step A (OpenAlex + Semantic Scholar reference backfill).
        #[arg(long = "skip-refs")]
        skip_refs: bool,
        /// Skip Step B (LLM keyword extraction).
        #[arg(long = "skip-llm")]
        skip_llm: bool,
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
            skip_refs,
            skip_llm,
            delta_since,
        } => {
            let db_path = db.unwrap_or_else(collection::collection_db_path);
            let opts = SeedBakeOptions {
                out_dir,
                llm_base_url,
                llm_model,
                llm_api_key,
                llm_concurrency,
                skip_refs,
                skip_llm,
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

        let bake_val = run(
            CollectionCmd::SeedBake {
                db: Some(db1),
                out_dir: out_dir.clone(),
                llm_base_url: DEFAULT_BAKE_LLM_BASE_URL.into(),
                llm_model: DEFAULT_BAKE_LLM_MODEL.into(),
                llm_api_key: None,
                llm_concurrency: 1,
                skip_refs: true,
                skip_llm: true,
                delta_since: None,
            },
            &globals,
        )
        .await
        .unwrap();
        assert_eq!(bake_val["shards"].as_array().unwrap().len(), 1);

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
}
