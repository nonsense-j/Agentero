//! Local-first citation and bibliographic-coupling snowballing over `paper_citations`
//! and `paper_raw_refs` in `collection.sqlite`.
//!
//! Queries execute in `< 1ms` purely against local SQLite tables; only when a seed paper
//! has zero recorded `paper_raw_refs` does it optionally perform a single lightweight
//! OpenAlex `referenced_works` lookup and persist the discovered outgoing edges back into
//! `paper_raw_refs`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;

use crate::error::AppError;
use crate::features::paper::scholar_api::client as scholar_client;

use super::lineage::load_preferred_summaries_by_work_ids;
use super::models::{CollectionCitationsOut, CollectionCitationsParams, SnowballPaperHit};
use super::schema::ensure_collection_at;
use super::search::summary_to_hit;
use super::store::{
    clean_arxiv_key, clean_doi_key, clean_openalex_id, insert_work_raw_refs_tx,
    map_paper_summary_row, recompute_graph_and_citations_tx, PAPER_SUMMARY_COL_COUNT,
    PAPER_SUMMARY_SELECT_COLS,
};

const OPENALEX_MAILTO: &str = "agentero@users.noreply.github.com";

#[derive(Clone)]
struct ResolvedSeed {
    id: String,
    work_id: i64,
    title: String,
    openalex_id: Option<String>,
    doi: Option<String>,
    arxiv_id: Option<String>,
    has_raw_refs: bool,
}

fn resolve_seed_row(conn: &Connection, raw_id: &str) -> Result<Option<ResolvedSeed>, AppError> {
    let trimmed = raw_id.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let arxiv_norm = clean_arxiv_key(trimmed);
    let doi_norm = clean_doi_key(trimmed);
    let sql = format!(
        "SELECT {PAPER_SUMMARY_SELECT_COLS}, p.work_id, p.openalex_id
         FROM papers p
         WHERE p.id = ?1
            OR p.cool_papers_id = ?1
            OR (?2 IS NOT NULL AND p.arxiv_id_norm = ?2)
            OR (?3 IS NOT NULL AND p.doi_norm = ?3)
         ORDER BY CASE WHEN p.source_type = 'venue' THEN 0 ELSE 1 END ASC
         LIMIT 1"
    );

    let row = conn
        .query_row(&sql, params![trimmed, arxiv_norm, doi_norm], |r| {
            let s = map_paper_summary_row(r)?;
            let wid: i64 = r.get(PAPER_SUMMARY_COL_COUNT)?;
            let oa: Option<String> = r.get(PAPER_SUMMARY_COL_COUNT + 1)?;
            Ok((s, wid, oa))
        })
        .optional()?;

    let Some((summary, work_id, openalex_id)) = row else {
        return Ok(None);
    };

    let has_raw_refs = if work_id > 0 {
        conn.query_row(
            "SELECT 1 FROM paper_raw_refs WHERE src_work_id = ?1 LIMIT 1",
            [work_id],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false)
    } else {
        false
    };

    Ok(Some(ResolvedSeed {
        id: summary.id,
        work_id,
        title: summary.title,
        openalex_id,
        doi: summary.doi,
        arxiv_id: summary.arxiv_id,
        has_raw_refs,
    }))
}

async fn fetch_missing_refs_from_openalex(
    seed: &ResolvedSeed,
) -> Option<(Option<String>, Vec<String>)> {
    let select = "id,doi,ids,referenced_works";
    let url = if let Some(oa) = seed.openalex_id.as_deref().and_then(clean_openalex_id) {
        format!("https://api.openalex.org/works/{oa}?select={select}&mailto={OPENALEX_MAILTO}")
    } else if let Some(d) = seed.doi.as_deref().and_then(clean_doi_key) {
        format!(
            "https://api.openalex.org/works/https://doi.org/{}?select={select}&mailto={OPENALEX_MAILTO}",
            urlencoding::encode(&d)
        )
    } else {
        let a = seed.arxiv_id.as_deref().and_then(clean_arxiv_key)?;
        let synth_doi = format!("10.48550/arxiv.{a}");
        format!(
            "https://api.openalex.org/works/https://doi.org/{}?select={select}&mailto={OPENALEX_MAILTO}",
            urlencoding::encode(&synth_doi)
        )
    };

    let work: Value = scholar_client::get_json(&url).await.ok()?;
    let oa_id = work
        .get("id")
        .and_then(Value::as_str)
        .and_then(clean_openalex_id);
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

    if oa_id.is_none() && refs.is_empty() {
        return None;
    }
    Some((oa_id, refs))
}

fn truncate_title(title: &str) -> String {
    if title.chars().count() > 72 {
        let mut s: String = title.chars().take(72).collect();
        s.push('…');
        s
    } else {
        title.to_string()
    }
}

pub async fn snowball_citations_at(
    db_path: &Path,
    params: &CollectionCitationsParams,
) -> Result<CollectionCitationsOut, AppError> {
    let limit = params.limit.unwrap_or(25).clamp(1, 50);
    let direction = params
        .direction
        .as_deref()
        .unwrap_or("both")
        .trim()
        .to_ascii_lowercase();
    let want_refs = matches!(direction.as_str(), "both" | "references");
    let want_cited_by = matches!(direction.as_str(), "both" | "cited_by");
    let want_cocited = matches!(direction.as_str(), "both" | "cocited");

    let mut req_ids: Vec<String> = Vec::new();
    let mut seen_req = HashSet::new();
    for id in &params.paper_ids {
        let t = id.trim();
        if !t.is_empty() && seen_req.insert(t.to_string()) {
            req_ids.push(t.to_string());
            if req_ids.len() >= 5 {
                break;
            }
        }
    }

    if req_ids.is_empty() {
        return Ok(CollectionCitationsOut {
            resolved_seeds: Vec::new(),
            unresolved_seeds: Vec::new(),
            returned_count: 0,
            items: Vec::new(),
        });
    }

    let db_buf = db_path.to_path_buf();
    let req_clone = req_ids.clone();
    let (seeds, unresolved_seeds) = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let conn = ensure_collection_at(&db_buf)?;
        let mut resolved = Vec::new();
        let mut unresolved = Vec::new();
        let mut seen_work = HashSet::new();
        for raw_id in req_clone {
            if let Some(seed) = resolve_seed_row(&conn, &raw_id)? {
                if seen_work.insert(seed.work_id) {
                    resolved.push(seed);
                }
            } else {
                unresolved.push(raw_id);
            }
        }
        Ok((resolved, unresolved))
    })
    .await
    .map_err(|e| AppError::message(format!("snowball resolve join: {e}")))??;

    if seeds.is_empty() {
        return Ok(CollectionCitationsOut {
            resolved_seeds: Vec::new(),
            unresolved_seeds,
            returned_count: 0,
            items: Vec::new(),
        });
    }

    // Optional single-query OpenAlex fallback ONLY for seeds missing local `paper_raw_refs`.
    if want_refs || want_cocited {
        let mut backfills: Vec<(i64, String, Option<String>, Vec<String>)> = Vec::new();
        for seed in &seeds {
            if !seed.has_raw_refs && seed.work_id > 0 {
                if let Some((oa_id, refs)) = fetch_missing_refs_from_openalex(seed).await {
                    backfills.push((seed.work_id, seed.id.clone(), oa_id, refs));
                }
            }
        }
        if !backfills.is_empty() {
            let db_save = db_path.to_path_buf();
            tokio::task::spawn_blocking(move || -> Result<(), AppError> {
                let mut conn = ensure_collection_at(&db_save)?;
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let mut any_changed = false;
                for (wid, pid, oa_id, refs) in backfills {
                    if let Some(ref oa) = oa_id {
                        tx.execute(
                            "UPDATE canonical_works SET openalex_id = COALESCE(openalex_id, ?1) WHERE work_id = ?2",
                            params![oa, wid],
                        )?;
                        tx.execute(
                            "UPDATE papers SET openalex_id = COALESCE(openalex_id, ?1) WHERE id = ?2",
                            params![oa, pid],
                        )?;
                        any_changed = true;
                    }
                    if insert_work_raw_refs_tx(&tx, wid, &refs)? > 0 {
                        any_changed = true;
                    }
                }
                if any_changed {
                    recompute_graph_and_citations_tx(&tx)?;
                }
                tx.commit()?;
                Ok(())
            })
            .await
            .map_err(|e| AppError::message(format!("snowball backfill join: {e}")))??;
        }
    }

    let db_final = db_path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<CollectionCitationsOut, AppError> {
        let conn = ensure_collection_at(&db_final)?;
        let seed_work_ids: HashSet<i64> = seeds.iter().map(|s| s.work_id).collect();
        let resolved_seeds: Vec<String> = seeds.iter().map(|s| s.id.clone()).collect();

        struct AccCandidate {
            has_cited_by: bool,
            has_references: bool,
            has_cocited: bool,
            linked_seed_ids: Vec<String>,
            via: Vec<String>,
            score: f32,
        }

        let mut acc_by_wid: HashMap<i64, AccCandidate> = HashMap::new();
        let mut add_edge =
            |wid: i64, rel: &str, seed_id: &str, via_text: String, weight: f32| {
                if wid <= 0 || seed_work_ids.contains(&wid) {
                    return;
                }
                let entry = acc_by_wid.entry(wid).or_insert_with(|| AccCandidate {
                    has_cited_by: false,
                    has_references: false,
                    has_cocited: false,
                    linked_seed_ids: Vec::new(),
                    via: Vec::new(),
                    score: 0.0,
                });
                match rel {
                    "cited_by" => entry.has_cited_by = true,
                    "references" => entry.has_references = true,
                    _ => entry.has_cocited = true,
                }
                if !entry.linked_seed_ids.iter().any(|s| s == seed_id) {
                    entry.linked_seed_ids.push(seed_id.to_string());
                }
                if entry.via.len() < 4 && !entry.via.iter().any(|v| v == &via_text) {
                    entry.via.push(via_text);
                }
                entry.score += weight;
            };

        for seed in &seeds {
            if seed.work_id <= 0 {
                continue;
            }
            let short_seed_title = truncate_title(&seed.title);

            if want_cited_by {
                let mut stmt = conn.prepare(
                    "SELECT pc.citing_work_id
                     FROM paper_citations pc
                     JOIN canonical_works cw ON cw.work_id = pc.citing_work_id
                     WHERE pc.cited_work_id = ?1 AND cw.active_in_scope = 1",
                )?;
                for wid_res in stmt.query_map([seed.work_id], |r| r.get::<_, i64>(0))? {
                    add_edge(
                        wid_res?,
                        "cited_by",
                        &seed.id,
                        format!("Cites seed `{short_seed_title}`"),
                        8.0,
                    );
                }
            }

            if want_refs {
                let mut stmt = conn.prepare(
                    "SELECT pc.cited_work_id
                     FROM paper_citations pc
                     JOIN canonical_works cw ON cw.work_id = pc.cited_work_id
                     WHERE pc.citing_work_id = ?1 AND cw.active_in_scope = 1",
                )?;
                for wid_res in stmt.query_map([seed.work_id], |r| r.get::<_, i64>(0))? {
                    add_edge(
                        wid_res?,
                        "references",
                        &seed.id,
                        format!("Referenced by seed `{short_seed_title}`"),
                        7.0,
                    );
                }
            }

            if want_cocited {
                let mut stmt = conn.prepare(
                    "SELECT r2.src_work_id, COUNT(*) AS shared_cnt
                     FROM paper_raw_refs r1
                     JOIN paper_raw_refs r2 ON r2.ref_key = r1.ref_key AND r2.src_work_id != r1.src_work_id
                     JOIN canonical_works cw ON cw.work_id = r2.src_work_id
                     WHERE r1.src_work_id = ?1 AND cw.active_in_scope = 1
                     GROUP BY r2.src_work_id
                     ORDER BY shared_cnt DESC, r2.src_work_id ASC
                     LIMIT 40",
                )?;
                let rows = stmt.query_map([seed.work_id], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?.max(1) as u32))
                })?;
                for entry in rows {
                    let (wid, shared_cnt) = entry?;
                    let w = 4.0 + 1.2 * (shared_cnt.min(5) as f32);
                    add_edge(
                        wid,
                        "cocited",
                        &seed.id,
                        format!("Shares {shared_cnt} reference(s) with `{short_seed_title}`"),
                        w,
                    );
                }
            }
        }

        let candidate_wids: Vec<i64> = acc_by_wid.keys().copied().collect();
        let summaries = load_preferred_summaries_by_work_ids(&conn, &candidate_wids)?;

        let mut ranked: Vec<SnowballPaperHit> = acc_by_wid
            .into_iter()
            .filter_map(|(wid, acc)| {
                let summary = summaries.get(&wid)?;
                let relation_type = if acc.has_cited_by {
                    "cited_by"
                } else if acc.has_references {
                    "references"
                } else {
                    "cocited"
                }
                .to_string();
                let seed_bonus = ((acc.linked_seed_ids.len().saturating_sub(1)) as f32) * 5.0;
                let cite_bonus = ((summary.citation_count as f32) + 1.0).ln() * 0.5;
                let final_score = ((acc.score + seed_bonus + cite_bonus) * 100.0).round() / 100.0;
                Some(SnowballPaperHit {
                    paper: summary_to_hit(summary, final_score),
                    relation_type,
                    linked_seed_ids: acc.linked_seed_ids,
                    via: acc.via,
                })
            })
            .collect();

        ranked.sort_by(|a, b| {
            b.linked_seed_ids
                .len()
                .cmp(&a.linked_seed_ids.len())
                .then_with(|| {
                    b.paper
                        .score
                        .partial_cmp(&a.paper.score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| b.paper.citation_count.cmp(&a.paper.citation_count))
                .then_with(|| b.paper.published_at.cmp(&a.paper.published_at))
                .then_with(|| a.paper.id.cmp(&b.paper.id))
        });
        ranked.truncate(limit);

        Ok(CollectionCitationsOut {
            resolved_seeds,
            unresolved_seeds,
            returned_count: ranked.len(),
            items: ranked,
        })
    })
    .await
    .map_err(|e| AppError::message(format!("snowball match join: {e}")))?
}
