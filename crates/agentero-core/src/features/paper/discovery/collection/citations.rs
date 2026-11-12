//! Citation and co-citation snowballing strictly bounded to `collection.sqlite`,
//! with persistent edge caching in the `citation_edges` table.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;
use crate::features::paper::scholar_api::client as scholar_client;
use crate::features::paper::scholar_api::references::fetch_references;

use super::models::{
    CollectionCitationsOut, CollectionCitationsParams, CollectionPaperSummary, SnowballPaperHit,
};
use super::schema::ensure_collection_at;
use super::search::{enrich_venue_summaries_from_arxiv_conn, summary_to_hit};
use super::store::{
    append_enabled_scope_clause, clean_arxiv_key, clean_doi_key, compare_preferred_venue_summary,
    load_enabled_categories, map_paper_summary_row, merge_arxiv_into_venue_summary, norm_title_key,
    now_rfc3339, same_summary_work, PAPER_SUMMARY_SELECT_COLS,
};

const OPENALEX_MAILTO: &str = "agentero@users.noreply.github.com";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalPaperStub {
    #[serde(default)]
    pub openalex_id: Option<String>,
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default)]
    pub arxiv_id: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cited_by_count: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CachedPaperEdges {
    #[serde(default)]
    pub openalex_id: Option<String>,
    #[serde(default)]
    pub references: Vec<ExternalPaperStub>,
    #[serde(default)]
    pub cited_by: Vec<ExternalPaperStub>,
    #[serde(default)]
    pub cocited_2026: Vec<(String, ExternalPaperStub)>,
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

async fn fetch_edges_for_seed(seed: &CollectionPaperSummary) -> CachedPaperEdges {
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

fn resolve_seed_in_scope(
    conn: &Connection,
    raw_id: &str,
    enabled_cats: &[String],
) -> Result<Option<CollectionPaperSummary>, AppError> {
    let trimmed = raw_id.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    // 1. Exact ID match
    {
        let mut sql = format!("SELECT {PAPER_SUMMARY_SELECT_COLS} FROM papers p WHERE p.id = ?");
        let mut binds: Vec<rusqlite::types::Value> = vec![trimmed.to_string().into()];
        append_enabled_scope_clause(&mut sql, &mut binds, "p", enabled_cats);
        sql.push_str(" LIMIT 1");
        if let Some(p) = conn
            .query_row(&sql, params_from_iter(binds), map_paper_summary_row)
            .optional()?
        {
            return Ok(Some(p));
        }
    }

    // 2. Normalized arXiv ID match
    if let Some(a) = clean_arxiv_key(trimmed) {
        let mut sql =
            format!("SELECT {PAPER_SUMMARY_SELECT_COLS} FROM papers p WHERE p.arxiv_id_norm = ?");
        let mut binds: Vec<rusqlite::types::Value> = vec![a.into()];
        append_enabled_scope_clause(&mut sql, &mut binds, "p", enabled_cats);
        sql.push_str(" ORDER BY CASE WHEN p.source_type = 'venue' THEN 0 ELSE 1 END, p.published_at DESC LIMIT 1");
        if let Some(p) = conn
            .query_row(&sql, params_from_iter(binds), map_paper_summary_row)
            .optional()?
        {
            return Ok(Some(p));
        }
    }

    // 3. Normalized DOI match
    if let Some(d) = clean_doi_key(trimmed) {
        let mut sql =
            format!("SELECT {PAPER_SUMMARY_SELECT_COLS} FROM papers p WHERE p.doi_norm = ?");
        let mut binds: Vec<rusqlite::types::Value> = vec![d.clone().into()];
        append_enabled_scope_clause(&mut sql, &mut binds, "p", enabled_cats);
        sql.push_str(" ORDER BY CASE WHEN p.source_type = 'venue' THEN 0 ELSE 1 END, p.published_at DESC LIMIT 1");
        if let Some(p) = conn
            .query_row(&sql, params_from_iter(binds), map_paper_summary_row)
            .optional()?
        {
            return Ok(Some(p));
        }
        if let Some(a) = d.strip_prefix("10.48550/arxiv.") {
            let mut sql2 = format!(
                "SELECT {PAPER_SUMMARY_SELECT_COLS} FROM papers p WHERE p.arxiv_id_norm = ?"
            );
            let mut binds2: Vec<rusqlite::types::Value> = vec![a.to_string().into()];
            append_enabled_scope_clause(&mut sql2, &mut binds2, "p", enabled_cats);
            sql2.push_str(" LIMIT 1");
            if let Some(p) = conn
                .query_row(&sql2, params_from_iter(binds2), map_paper_summary_row)
                .optional()?
            {
                return Ok(Some(p));
            }
        }
    }

    Ok(None)
}

fn load_cached_edges_conn(
    conn: &Connection,
    seed_ids: &[String],
) -> Result<HashMap<String, CachedPaperEdges>, AppError> {
    if seed_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders: String = std::iter::repeat_n("?", seed_ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT seed_paper_id, openalex_id, references_json, cited_by_json, cocited_json \
         FROM citation_edges WHERE seed_paper_id IN ({placeholders})"
    );
    let binds: Vec<rusqlite::types::Value> = seed_ids.iter().cloned().map(Into::into).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(binds), |r| {
        let seed_id: String = r.get(0)?;
        let openalex_id: Option<String> = r.get(1)?;
        let refs_json: String = r.get(2)?;
        let cited_json: String = r.get(3)?;
        let cocited_json: String = r.get(4)?;
        Ok((
            seed_id,
            CachedPaperEdges {
                openalex_id,
                references: serde_json::from_str(&refs_json).unwrap_or_default(),
                cited_by: serde_json::from_str(&cited_json).unwrap_or_default(),
                cocited_2026: serde_json::from_str(&cocited_json).unwrap_or_default(),
            },
        ))
    })?;

    let mut out = HashMap::new();
    for entry in rows {
        let (sid, edges) = entry?;
        out.insert(sid, edges);
    }
    Ok(out)
}

pub(crate) fn save_cached_edges_conn(
    conn: &mut Connection,
    entries: &[(String, CachedPaperEdges)],
) -> Result<(), AppError> {
    if entries.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = now_rfc3339();
    for (seed_id, edges) in entries {
        let refs_json = serde_json::to_string(&edges.references)?;
        let cited_json = serde_json::to_string(&edges.cited_by)?;
        let cocited_json = serde_json::to_string(&edges.cocited_2026)?;
        tx.execute(
            "INSERT INTO citation_edges (
                seed_paper_id, openalex_id, references_json, cited_by_json, cocited_json, fetched_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(seed_paper_id) DO UPDATE SET
                openalex_id = excluded.openalex_id,
                references_json = excluded.references_json,
                cited_by_json = excluded.cited_by_json,
                cocited_json = excluded.cocited_json,
                fetched_at = excluded.fetched_at",
            params![
                seed_id,
                edges.openalex_id,
                refs_json,
                cited_json,
                cocited_json,
                now
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

struct StubCandidatePool {
    items: Vec<CollectionPaperSummary>,
    by_arxiv: HashMap<String, usize>,
    by_doi: HashMap<String, usize>,
    by_title: HashMap<String, usize>,
}

impl StubCandidatePool {
    fn load_for_stubs(
        conn: &Connection,
        stubs: &[&ExternalPaperStub],
        enabled_cats: &[String],
    ) -> Result<Self, AppError> {
        let mut arxiv_keys: HashSet<String> = HashSet::new();
        let mut doi_keys: HashSet<String> = HashSet::new();
        let mut title_keys: HashSet<String> = HashSet::new();

        for stub in stubs {
            if let Some(a) = stub.arxiv_id.as_deref().and_then(clean_arxiv_key) {
                doi_keys.insert(format!("10.48550/arxiv.{a}"));
                arxiv_keys.insert(a);
            }
            if let Some(d) = stub.doi.as_deref().and_then(clean_doi_key) {
                if let Some(a) = d.strip_prefix("10.48550/arxiv.") {
                    arxiv_keys.insert(a.to_string());
                }
                doi_keys.insert(d);
            }
            let tk = norm_title_key(&stub.title);
            if tk.len() >= 10 {
                title_keys.insert(tk);
            }
        }

        let mut by_id: HashMap<String, CollectionPaperSummary> = HashMap::new();

        fn fetch_by_column(
            conn: &Connection,
            col: &str,
            keys: &HashSet<String>,
            enabled_cats: &[String],
            out: &mut HashMap<String, CollectionPaperSummary>,
        ) -> Result<(), AppError> {
            let vec_keys: Vec<&String> = keys.iter().collect();
            for chunk in vec_keys.chunks(200) {
                let placeholders: String = std::iter::repeat_n("?", chunk.len())
                    .collect::<Vec<_>>()
                    .join(", ");
                let mut sql = format!(
                    "SELECT {PAPER_SUMMARY_SELECT_COLS} FROM papers p WHERE p.{col} IN ({placeholders})"
                );
                let mut binds: Vec<rusqlite::types::Value> =
                    chunk.iter().map(|s| (*s).clone().into()).collect();
                append_enabled_scope_clause(&mut sql, &mut binds, "p", enabled_cats);
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params_from_iter(binds), map_paper_summary_row)?;
                for entry in rows {
                    let p = entry?;
                    out.entry(p.id.clone()).or_insert(p);
                }
            }
            Ok(())
        }

        fetch_by_column(conn, "arxiv_id_norm", &arxiv_keys, enabled_cats, &mut by_id)?;
        fetch_by_column(conn, "doi_norm", &doi_keys, enabled_cats, &mut by_id)?;
        fetch_by_column(conn, "title_norm", &title_keys, enabled_cats, &mut by_id)?;

        // Pull cross-portal siblings by `title_norm` (e.g. stub only had `arxiv_id`, while the
        // `venue` counterpart in `collection.sqlite` only shares `title + first 2 authors`).
        let sibling_titles: HashSet<String> = by_id
            .values()
            .map(|p| norm_title_key(&p.title))
            .filter(|tk| tk.len() >= 4 && !title_keys.contains(tk))
            .collect();
        if !sibling_titles.is_empty() {
            fetch_by_column(
                conn,
                "title_norm",
                &sibling_titles,
                enabled_cats,
                &mut by_id,
            )?;
        }

        // Sort deterministically (prefer venue portal over preprint when same work exists)
        let mut raw_items: Vec<CollectionPaperSummary> = by_id.into_values().collect();
        raw_items.sort_by(compare_preferred_venue_summary);

        // Collapse cross-portal `arXiv` + `Venue` twins into the preferred `Venue` summary.
        let mut items: Vec<CollectionPaperSummary> = Vec::with_capacity(raw_items.len());
        for cand in raw_items {
            if let Some(existing) = items.iter_mut().find(|prev| same_summary_work(prev, &cand)) {
                if existing.source_type == "venue" && cand.source_type == "arxiv" {
                    merge_arxiv_into_venue_summary(existing, &cand);
                } else if existing.source_type == "arxiv" && cand.source_type == "venue" {
                    let mut upgraded = cand;
                    merge_arxiv_into_venue_summary(&mut upgraded, existing);
                    *existing = upgraded;
                }
            } else {
                items.push(cand);
            }
        }

        let mut by_arxiv = HashMap::new();
        let mut by_doi = HashMap::new();
        let mut by_title = HashMap::new();

        for (idx, p) in items.iter().enumerate() {
            if let Some(d) = p.doi.as_deref().and_then(clean_doi_key) {
                by_doi.entry(d).or_insert(idx);
            }
            if let Some(a) = p.arxiv_id.as_deref().and_then(clean_arxiv_key) {
                by_arxiv.entry(a.clone()).or_insert(idx);
                by_doi.entry(format!("10.48550/arxiv.{a}")).or_insert(idx);
            }
            let tk = norm_title_key(&p.title);
            if tk.len() >= 10 {
                by_title.entry(tk).or_insert(idx);
            }
        }

        Ok(Self {
            items,
            by_arxiv,
            by_doi,
            by_title,
        })
    }

    fn match_stub(&self, stub: &ExternalPaperStub) -> Option<&CollectionPaperSummary> {
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

fn find_local_lineage_candidates(
    conn: &Connection,
    seed: &CollectionPaperSummary,
    seed_id_set: &HashSet<String>,
    enabled_cats: &[String],
) -> Result<Vec<(CollectionPaperSummary, Vec<String>)>, AppError> {
    let seed_kw: Vec<String> = seed
        .keywords
        .iter()
        .map(|k| {
            k.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        })
        .filter(|k| k.chars().count() >= 2)
        .collect();
    if seed_kw.is_empty() {
        return Ok(Vec::new());
    }
    let seed_kw_set: HashSet<String> = seed_kw.iter().cloned().collect();
    let seed_authors: HashSet<String> = seed.authors.iter().map(|a| a.to_lowercase()).collect();

    let kw_placeholders: String = std::iter::repeat_n("?", seed_kw.len())
        .collect::<Vec<_>>()
        .join(", ");
    let mut sql = format!(
        "SELECT {PAPER_SUMMARY_SELECT_COLS} FROM papers p \
         WHERE EXISTS (SELECT 1 FROM paper_keywords pk WHERE pk.paper_id = p.id AND pk.normalized IN ({kw_placeholders}))"
    );
    let mut binds: Vec<rusqlite::types::Value> = seed_kw.into_iter().map(Into::into).collect();
    append_enabled_scope_clause(&mut sql, &mut binds, "p", enabled_cats);
    sql.push_str(" ORDER BY p.citation_count DESC, p.published_at DESC LIMIT 250");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(binds), map_paper_summary_row)?;

    let mut out = Vec::new();
    for entry in rows {
        let item = entry?;
        if seed_id_set.contains(&item.id) {
            continue;
        }
        let shared_kw: Vec<String> = item
            .keywords
            .iter()
            .filter(|k| {
                let norm = k
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase();
                seed_kw_set.contains(&norm)
            })
            .cloned()
            .collect();
        let shared_auth = item
            .authors
            .iter()
            .any(|a| seed_authors.contains(&a.to_lowercase()));
        if shared_kw.len() >= 2 || (shared_auth && !shared_kw.is_empty()) {
            out.push((item, shared_kw));
        }
    }
    Ok(out)
}

pub async fn snowball_citations_at(
    db_path: &Path,
    params: &CollectionCitationsParams,
) -> Result<CollectionCitationsOut, AppError> {
    // Step 1 (sync): resolve seeds & load cached edges; drop `Connection` before `.await`.
    let (resolved_seeds, unresolved_seeds, seed_id_set, mut edge_map) = {
        let conn = ensure_collection_at(db_path)?;
        let enabled_cats = load_enabled_categories(&conn)?;
        let mut resolved: Vec<CollectionPaperSummary> = Vec::new();
        let mut unresolved: Vec<String> = Vec::new();
        let mut id_set: HashSet<String> = HashSet::new();

        for raw in params.paper_ids.iter().take(5) {
            if let Some(p) = resolve_seed_in_scope(&conn, raw, &enabled_cats)? {
                if id_set.insert(p.id.clone()) {
                    resolved.push(p);
                }
            } else if !raw.trim().is_empty() {
                unresolved.push(raw.trim().to_string());
            }
        }

        if resolved.is_empty() {
            return Ok(CollectionCitationsOut {
                resolved_seeds: Vec::new(),
                unresolved_seeds: unresolved,
                returned_count: 0,
                items: Vec::new(),
            });
        }

        let resolved_ids: Vec<String> = resolved.iter().map(|s| s.id.clone()).collect();
        let cached = load_cached_edges_conn(&conn, &resolved_ids)?;
        (resolved, unresolved, id_set, cached)
    };

    // Step 2 (async): fetch missing citation edges from OpenAlex / Semantic Scholar.
    let mut newly_fetched: Vec<(String, CachedPaperEdges)> = Vec::new();
    for seed in &resolved_seeds {
        if !edge_map.contains_key(&seed.id) {
            let fetched = fetch_edges_for_seed(seed).await;
            newly_fetched.push((seed.id.clone(), fetched.clone()));
            edge_map.insert(seed.id.clone(), fetched);
        }
    }

    // Step 3 (sync): persist new edges & match strictly against in-scope `collection.sqlite` papers.
    let mut conn = ensure_collection_at(db_path)?;
    if !newly_fetched.is_empty() {
        save_cached_edges_conn(&mut conn, &newly_fetched)?;
    }

    let enabled_cats = load_enabled_categories(&conn)?;
    let dir_mode = params
        .direction
        .as_deref()
        .unwrap_or("both")
        .trim()
        .to_ascii_lowercase();
    let want_refs = dir_mode == "both" || dir_mode == "references";
    let want_cited_by = dir_mode == "both" || dir_mode == "cited_by";
    let want_cocited = dir_mode == "both" || dir_mode == "cocited";

    let mut all_stubs: Vec<&ExternalPaperStub> = Vec::new();
    for edges in edge_map.values() {
        if want_cited_by {
            all_stubs.extend(edges.cited_by.iter());
        }
        if want_refs {
            all_stubs.extend(edges.references.iter());
        }
        if want_cocited {
            all_stubs.extend(edges.cocited_2026.iter().map(|(_, s)| s));
        }
    }

    let pool = StubCandidatePool::load_for_stubs(&conn, &all_stubs, &enabled_cats)?;

    struct Acc {
        paper: CollectionPaperSummary,
        relation_rank: u8, // 3 = cited_by, 2 = references, 1 = cocited
        relation_type: &'static str,
        seeds: HashSet<String>,
        via: Vec<String>,
    }

    fn record_hit(
        hits: &mut Vec<Acc>,
        resolved_seeds: &[CollectionPaperSummary],
        seed_id: &str,
        cand: &CollectionPaperSummary,
        rank: u8,
        rel: &'static str,
        via_msg: String,
    ) -> bool {
        if resolved_seeds
            .iter()
            .any(|s| s.id == cand.id || same_summary_work(s, cand))
        {
            return false;
        }
        let idx = if let Some(pos) = hits
            .iter()
            .position(|e| e.paper.id == cand.id || same_summary_work(&e.paper, cand))
        {
            if hits[pos].paper.source_type == "arxiv" && cand.source_type == "venue" {
                let mut upgraded = cand.clone();
                merge_arxiv_into_venue_summary(&mut upgraded, &hits[pos].paper);
                hits[pos].paper = upgraded;
            } else if hits[pos].paper.source_type == "venue" && cand.source_type == "arxiv" {
                merge_arxiv_into_venue_summary(&mut hits[pos].paper, cand);
            }
            pos
        } else {
            hits.push(Acc {
                paper: cand.clone(),
                relation_rank: rank,
                relation_type: rel,
                seeds: HashSet::new(),
                via: Vec::new(),
            });
            hits.len() - 1
        };
        let entry = &mut hits[idx];
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

    let mut hits: Vec<Acc> = Vec::new();

    for seed in &resolved_seeds {
        let Some(edges) = edge_map.get(&seed.id) else {
            continue;
        };
        let mut seed_matched = false;

        if want_cited_by {
            for stub in &edges.cited_by {
                if let Some(cand) = pool.match_stub(stub) {
                    seed_matched |= record_hit(
                        &mut hits,
                        &resolved_seeds,
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
                if let Some(cand) = pool.match_stub(stub) {
                    seed_matched |= record_hit(
                        &mut hits,
                        &resolved_seeds,
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
                if let Some(cand) = pool.match_stub(stub) {
                    seed_matched |= record_hit(
                        &mut hits,
                        &resolved_seeds,
                        &seed.id,
                        cand,
                        1,
                        "cocited",
                        format!("Co-cites `{pivot_title}` with `{}`", seed.id),
                    );
                }
            }
        }

        // Local fast fallback when network is offline or yields 0 in-collection links.
        if !seed_matched && want_cocited && !seed.keywords.is_empty() {
            let local_matches =
                find_local_lineage_candidates(&conn, seed, &seed_id_set, &enabled_cats)?;
            for (cand, shared_kw) in local_matches {
                let _ = record_hit(
                    &mut hits,
                    &resolved_seeds,
                    &seed.id,
                    &cand,
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

    // Upgrade any local-lineage `arXiv` hit that has an enabled `Venue` twin in `collection.sqlite`.
    for acc in &mut hits {
        if acc.paper.source_type == "arxiv" {
            let tk = norm_title_key(&acc.paper.title);
            if tk.len() >= 4 {
                let mut sql = format!(
                    "SELECT {PAPER_SUMMARY_SELECT_COLS} FROM papers p \
                     WHERE p.source_type = 'venue' AND p.title_norm = ?"
                );
                let mut binds: Vec<rusqlite::types::Value> = vec![tk.into()];
                append_enabled_scope_clause(&mut sql, &mut binds, "p", &enabled_cats);
                if let Ok(mut stmt) = conn.prepare(&sql) {
                    if let Ok(rows) = stmt.query_map(params_from_iter(binds), map_paper_summary_row)
                    {
                        let mut venues: Vec<CollectionPaperSummary> = rows
                            .filter_map(Result::ok)
                            .filter(|v| same_summary_work(&acc.paper, v))
                            .collect();
                        venues.sort_by(compare_preferred_venue_summary);
                        if let Some(mut best_venue) = venues.into_iter().next() {
                            merge_arxiv_into_venue_summary(&mut best_venue, &acc.paper);
                            acc.paper = best_venue;
                        }
                    }
                }
            }
        }
    }

    let limit = params.limit.unwrap_or(25).clamp(1, 50);
    let mut ranked: Vec<Acc> = hits;
    ranked.sort_by(|a, b| {
        b.seeds
            .len()
            .cmp(&a.seeds.len())
            .then_with(|| b.relation_rank.cmp(&a.relation_rank))
            .then_with(|| b.via.len().cmp(&a.via.len()))
            .then_with(|| b.paper.citation_count.cmp(&a.paper.citation_count))
            .then_with(|| b.paper.published_at.cmp(&a.paper.published_at))
    });
    ranked.truncate(limit);

    let mut top_summaries: HashMap<i64, CollectionPaperSummary> = ranked
        .iter()
        .enumerate()
        .map(|(i, acc)| (i as i64, acc.paper.clone()))
        .collect();
    enrich_venue_summaries_from_arxiv_conn(&conn, &mut top_summaries)?;

    let items: Vec<SnowballPaperHit> = ranked
        .into_iter()
        .enumerate()
        .map(|(i, acc)| {
            let enriched_paper = top_summaries.remove(&(i as i64)).unwrap_or(acc.paper);
            let score = (acc.seeds.len() as f32) * 3.0
                + (acc.relation_rank as f32) * 2.0
                + (acc.via.len() as f32);
            let mut linked_seed_ids: Vec<String> = acc.seeds.into_iter().collect();
            linked_seed_ids.sort();
            SnowballPaperHit {
                paper: summary_to_hit(&enriched_paper, score),
                relation_type: acc.relation_type.to_string(),
                linked_seed_ids,
                via: acc.via,
            }
        })
        .collect();

    Ok(CollectionCitationsOut {
        resolved_seeds: resolved_seeds.into_iter().map(|s| s.id).collect(),
        unresolved_seeds,
        returned_count: items.len(),
        items,
    })
}
