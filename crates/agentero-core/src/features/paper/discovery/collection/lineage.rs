//! Local-zero-network In-Collection Citation Lineage, Bibliographic Coupling,
//! and Personal Vault (`catalog.sqlite`) cross-matching.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params_from_iter, Connection, OpenFlags, OptionalExtension};

use crate::error::AppError;

use super::models::{
    CollectionCitationEdgeDto, CollectionPaperLineageArgs, CollectionPaperLineageOut,
    CollectionPaperSummary, CollectionSharedRefEdgeDto, CollectionSharedRefPeer,
    CollectionSubgraphArgs, CollectionSubgraphOut, CollectionVaultPaperMatch,
};
use super::schema::{ensure_collection, ensure_collection_at};
use super::store::{
    clean_doi_key, compare_preferred_venue_summary, extract_arxiv_norm, is_publisher_doi,
    load_enabled_categories, map_paper_summary_row, merge_arxiv_into_venue_summary, norm_title_key,
    same_work_by_title_and_authors, PAPER_SUMMARY_COL_COUNT, PAPER_SUMMARY_SELECT_COLS,
};

const MAX_LINEAGE_NEIGHBORS: usize = 40;
const MAX_SHARED_REF_PEERS: usize = 20;
const MIN_SHARED_REF_COUNT: i64 = 3;
const MAX_SUBGRAPH_SHARED_DEGREE: usize = 6;

#[derive(Debug, Clone)]
pub(crate) struct VaultCatalogEntry {
    pub rel_path: String,
    pub title: String,
    pub authors: Vec<String>,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct VaultCatalogIndex {
    pub entries: Vec<VaultCatalogEntry>,
    pub by_ref_key: HashMap<String, Vec<usize>>,
    pub by_title_norm: HashMap<String, Vec<usize>>,
}

impl VaultCatalogIndex {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Read-only `<1ms` snapshot of the user's `.agentero/catalog.sqlite` `papers` table.
pub(crate) fn load_vault_catalog_index(vault_path: Option<&str>) -> VaultCatalogIndex {
    let Some(vp) = vault_path.map(str::trim).filter(|s| !s.is_empty()) else {
        return VaultCatalogIndex::default();
    };
    let db_path = Path::new(vp).join(".agentero").join("catalog.sqlite");
    if !db_path.is_file() {
        return VaultCatalogIndex::default();
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let Ok(conn) = Connection::open_with_flags(&db_path, flags) else {
        return VaultCatalogIndex::default();
    };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(250));

    let Ok(mut stmt) = conn.prepare(
        "SELECT path, title, authors_json, doi, arxiv_id FROM papers ORDER BY updated_at DESC",
    ) else {
        return VaultCatalogIndex::default();
    };
    let Ok(rows) = stmt.query_map([], |r| {
        let authors_raw: String = r.get::<_, Option<String>>(2)?.unwrap_or_default();
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            authors_raw,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
        ))
    }) else {
        return VaultCatalogIndex::default();
    };

    let mut index = VaultCatalogIndex::default();
    for row in rows.flatten() {
        let (rel_path, title, authors_raw, doi_opt, arxiv_opt) = row;
        if rel_path.trim().is_empty() {
            continue;
        }
        let authors: Vec<String> = serde_json::from_str(&authors_raw).unwrap_or_default();
        let pub_doi = doi_opt
            .as_deref()
            .and_then(clean_doi_key)
            .filter(|d| is_publisher_doi(d));
        let arxiv_norm = extract_arxiv_norm(arxiv_opt.as_deref(), doi_opt.as_deref());
        let title_norm = norm_title_key(&title);

        let idx = index.entries.len();
        if let Some(ref d) = pub_doi {
            index
                .by_ref_key
                .entry(format!("doi:{d}"))
                .or_default()
                .push(idx);
        }
        if let Some(ref a) = arxiv_norm {
            index
                .by_ref_key
                .entry(format!("arxiv:{a}"))
                .or_default()
                .push(idx);
        }
        if title_norm.len() >= 4 {
            index.by_title_norm.entry(title_norm).or_default().push(idx);
        }

        index.entries.push(VaultCatalogEntry {
            rel_path,
            title,
            authors,
            doi: doi_opt
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            arxiv_id: arxiv_opt
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        });
    }

    index
}

fn arxiv_row_in_enabled_scope(summary: &CollectionPaperSummary, enabled_cats: &[String]) -> bool {
    if summary.source_type != "arxiv" || enabled_cats.is_empty() {
        return true;
    }
    enabled_cats.iter().any(|cat| {
        summary.source_label.eq_ignore_ascii_case(cat)
            || summary
                .categories
                .iter()
                .any(|pc| pc.eq_ignore_ascii_case(cat))
    })
}

/// Load one deduplicated, twin-enriched representative `CollectionPaperSummary` per `work_id`
/// (preferring `venue` rows over `arxiv` rows).
pub(crate) fn load_preferred_summaries_by_work_ids(
    conn: &Connection,
    work_ids: &[i64],
) -> Result<HashMap<i64, CollectionPaperSummary>, AppError> {
    if work_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let enabled_cats = load_enabled_categories(conn)?;
    let mut unique_ids: Vec<i64> = work_ids.iter().copied().filter(|&w| w > 0).collect();
    unique_ids.sort_unstable();
    unique_ids.dedup();
    if unique_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let mut grouped: HashMap<i64, Vec<CollectionPaperSummary>> =
        HashMap::with_capacity(unique_ids.len());
    for chunk in unique_ids.chunks(400) {
        let ph = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {PAPER_SUMMARY_SELECT_COLS}, p.work_id FROM papers p WHERE p.work_id IN ({ph})"
        );
        let binds: Vec<rusqlite::types::Value> = chunk.iter().copied().map(Into::into).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), |r| {
            let summary = map_paper_summary_row(r)?;
            let wid: i64 = r.get(PAPER_SUMMARY_COL_COUNT)?;
            Ok((wid, summary))
        })?;
        for entry in rows {
            let (wid, summary) = entry?;
            grouped.entry(wid).or_default().push(summary);
        }
    }

    let mut out = HashMap::with_capacity(grouped.len());
    for (wid, rows) in grouped {
        let mut venues: Vec<CollectionPaperSummary> = Vec::new();
        let mut arxivs: Vec<CollectionPaperSummary> = Vec::new();
        for row in rows {
            if row.source_type == "venue" {
                venues.push(row);
            } else {
                arxivs.push(row);
            }
        }
        if !venues.is_empty() {
            venues.sort_by(compare_preferred_venue_summary);
            let mut best = venues.remove(0);
            for ap in &arxivs {
                merge_arxiv_into_venue_summary(&mut best, ap);
            }
            out.insert(wid, best);
        } else {
            let mut active_arxivs: Vec<CollectionPaperSummary> = arxivs
                .into_iter()
                .filter(|ap| arxiv_row_in_enabled_scope(ap, &enabled_cats))
                .collect();
            if !active_arxivs.is_empty() {
                active_arxivs.sort_by(compare_preferred_venue_summary);
                out.insert(wid, active_arxivs.remove(0));
            }
        }
    }

    Ok(out)
}

fn sort_lineage_summaries(list: &mut [CollectionPaperSummary]) {
    list.sort_by(|a, b| {
        b.citation_count
            .cmp(&a.citation_count)
            .then_with(|| b.published_at.cmp(&a.published_at))
            .then_with(|| a.id.cmp(&b.id))
    });
}

pub fn paper_lineage(
    args: &CollectionPaperLineageArgs,
) -> Result<CollectionPaperLineageOut, AppError> {
    let conn = ensure_collection()?;
    paper_lineage_conn(&conn, args)
}

pub fn paper_lineage_at(
    db_path: &Path,
    args: &CollectionPaperLineageArgs,
) -> Result<CollectionPaperLineageOut, AppError> {
    let conn = ensure_collection_at(db_path)?;
    paper_lineage_conn(&conn, args)
}

pub(crate) fn paper_lineage_conn(
    conn: &Connection,
    args: &CollectionPaperLineageArgs,
) -> Result<CollectionPaperLineageOut, AppError> {
    let target_id = args.id.trim();
    if target_id.is_empty() {
        return Ok(CollectionPaperLineageOut {
            cited_by_in_pool: Vec::new(),
            references_in_pool: Vec::new(),
            shared_ref_peers: Vec::new(),
            vault_matches: Vec::new(),
        });
    }

    struct TargetLineageSeed {
        work_id: i64,
        title: String,
        authors_json: String,
        doi: Option<String>,
        arxiv_id: Option<String>,
    }

    let target_row: Option<TargetLineageSeed> = conn
        .query_row(
            "SELECT work_id, title, authors_json, doi, arxiv_id FROM papers WHERE id = ?1",
            [target_id],
            |r| {
                Ok(TargetLineageSeed {
                    work_id: r.get(0)?,
                    title: r.get(1)?,
                    authors_json: r.get(2)?,
                    doi: r.get(3)?,
                    arxiv_id: r.get(4)?,
                })
            },
        )
        .optional()?;

    let Some(TargetLineageSeed {
        work_id: target_work_id,
        title: target_title,
        authors_json: target_authors_json,
        doi: target_doi,
        arxiv_id: target_arxiv,
    }) = target_row
    else {
        return Ok(CollectionPaperLineageOut {
            cited_by_in_pool: Vec::new(),
            references_in_pool: Vec::new(),
            shared_ref_peers: Vec::new(),
            vault_matches: Vec::new(),
        });
    };

    if target_work_id <= 0 {
        return Ok(CollectionPaperLineageOut {
            cited_by_in_pool: Vec::new(),
            references_in_pool: Vec::new(),
            shared_ref_peers: Vec::new(),
            vault_matches: Vec::new(),
        });
    }

    // 1. In-pool incoming citations (`cited_by_in_pool`)
    let citing_work_ids: Vec<i64> = {
        let mut stmt = conn.prepare(
            "SELECT pc.citing_work_id
             FROM paper_citations pc
             JOIN canonical_works cw ON cw.work_id = pc.citing_work_id
             WHERE pc.cited_work_id = ?1 AND cw.active_in_scope = 1",
        )?;
        let rows = stmt.query_map([target_work_id], |r| r.get::<_, i64>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    // 2. In-pool outgoing references (`references_in_pool`)
    let cited_work_ids: Vec<i64> = {
        let mut stmt = conn.prepare(
            "SELECT pc.cited_work_id
             FROM paper_citations pc
             JOIN canonical_works cw ON cw.work_id = pc.cited_work_id
             WHERE pc.citing_work_id = ?1 AND cw.active_in_scope = 1",
        )?;
        let rows = stmt.query_map([target_work_id], |r| r.get::<_, i64>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    // 3. Bibliographic coupling peers (`shared_ref_peers`, shared_count >= 3, Top 20)
    let coupled_pairs: Vec<(i64, u32)> = {
        let mut stmt = conn.prepare(
            "SELECT r2.src_work_id, COUNT(*) AS shared_cnt
             FROM paper_raw_refs r1
             JOIN paper_raw_refs r2 ON r2.ref_key = r1.ref_key AND r2.src_work_id != r1.src_work_id
             JOIN canonical_works cw ON cw.work_id = r2.src_work_id
             WHERE r1.src_work_id = ?1 AND cw.active_in_scope = 1
             GROUP BY r2.src_work_id
             HAVING shared_cnt >= ?2
             ORDER BY shared_cnt DESC, r2.src_work_id ASC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![
                target_work_id,
                MIN_SHARED_REF_COUNT,
                MAX_SHARED_REF_PEERS as i64
            ],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?.max(0) as u32)),
        )?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let mut all_needed_wids: Vec<i64> =
        Vec::with_capacity(citing_work_ids.len() + cited_work_ids.len() + coupled_pairs.len());
    all_needed_wids.extend_from_slice(&citing_work_ids);
    all_needed_wids.extend_from_slice(&cited_work_ids);
    for &(wid, _) in &coupled_pairs {
        all_needed_wids.push(wid);
    }

    let summary_by_wid = load_preferred_summaries_by_work_ids(conn, &all_needed_wids)?;

    let mut cited_by_in_pool: Vec<CollectionPaperSummary> = citing_work_ids
        .iter()
        .filter_map(|wid| summary_by_wid.get(wid).cloned())
        .collect();
    sort_lineage_summaries(&mut cited_by_in_pool);
    cited_by_in_pool.truncate(MAX_LINEAGE_NEIGHBORS);

    let mut references_in_pool: Vec<CollectionPaperSummary> = cited_work_ids
        .iter()
        .filter_map(|wid| summary_by_wid.get(wid).cloned())
        .collect();
    sort_lineage_summaries(&mut references_in_pool);
    references_in_pool.truncate(MAX_LINEAGE_NEIGHBORS);

    let mut shared_ref_peers: Vec<CollectionSharedRefPeer> = coupled_pairs
        .into_iter()
        .filter_map(|(wid, shared_count)| {
            summary_by_wid
                .get(&wid)
                .cloned()
                .map(|paper| CollectionSharedRefPeer {
                    paper,
                    shared_count,
                })
        })
        .collect();
    shared_ref_peers.sort_by(|a, b| {
        b.shared_count
            .cmp(&a.shared_count)
            .then_with(|| b.paper.citation_count.cmp(&a.paper.citation_count))
            .then_with(|| b.paper.published_at.cmp(&a.paper.published_at))
            .then_with(|| a.paper.id.cmp(&b.paper.id))
    });
    shared_ref_peers.truncate(MAX_SHARED_REF_PEERS);

    // 4. Personal Vault cross-matches (`"self"` + `"referenced"`)
    let vault_matches = compute_vault_matches_for_work(
        conn,
        target_work_id,
        &target_title,
        &serde_json::from_str::<Vec<String>>(&target_authors_json).unwrap_or_default(),
        target_doi.as_deref(),
        target_arxiv.as_deref(),
        args.vault_path.as_deref(),
    )?;

    Ok(CollectionPaperLineageOut {
        cited_by_in_pool,
        references_in_pool,
        shared_ref_peers,
        vault_matches,
    })
}

fn compute_vault_matches_for_work(
    conn: &Connection,
    target_work_id: i64,
    target_title: &str,
    target_authors: &[String],
    target_doi: Option<&str>,
    target_arxiv: Option<&str>,
    vault_path: Option<&str>,
) -> Result<Vec<CollectionVaultPaperMatch>, AppError> {
    let vault = load_vault_catalog_index(vault_path);
    if vault.is_empty() {
        return Ok(Vec::new());
    }

    let cw_ids: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT doi_norm, arxiv_id_norm FROM canonical_works WHERE work_id = ?1",
            [target_work_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (cw_doi, cw_arxiv) = cw_ids.unwrap_or((None, None));

    let mut self_ref_keys: Vec<String> = Vec::new();
    if let Some(d) = cw_doi.or_else(|| {
        target_doi
            .and_then(clean_doi_key)
            .filter(|d| is_publisher_doi(d))
    }) {
        self_ref_keys.push(format!("doi:{d}"));
    }
    if let Some(a) = cw_arxiv.or_else(|| extract_arxiv_norm(target_arxiv, target_doi)) {
        self_ref_keys.push(format!("arxiv:{a}"));
    }

    let mut seen_vault_indices: HashSet<usize> = HashSet::new();
    let mut matches: Vec<CollectionVaultPaperMatch> = Vec::new();

    // 4a. Match `"self"` by DOI / arXiv ID or exact title + compatible authors
    for key in &self_ref_keys {
        if let Some(idxs) = vault.by_ref_key.get(key) {
            for &vi in idxs {
                if seen_vault_indices.insert(vi) {
                    let e = &vault.entries[vi];
                    matches.push(CollectionVaultPaperMatch {
                        rel_path: e.rel_path.clone(),
                        title: e.title.clone(),
                        doi: e.doi.clone(),
                        arxiv_id: e.arxiv_id.clone(),
                        relation: "self".to_string(),
                    });
                }
            }
        }
    }
    let tk = norm_title_key(target_title);
    if tk.len() >= 4 {
        if let Some(idxs) = vault.by_title_norm.get(&tk) {
            for &vi in idxs {
                let e = &vault.entries[vi];
                if same_work_by_title_and_authors(
                    target_title,
                    target_authors,
                    &e.title,
                    &e.authors,
                ) && seen_vault_indices.insert(vi)
                {
                    matches.push(CollectionVaultPaperMatch {
                        rel_path: e.rel_path.clone(),
                        title: e.title.clone(),
                        doi: e.doi.clone(),
                        arxiv_id: e.arxiv_id.clone(),
                        relation: "self".to_string(),
                    });
                }
            }
        }
    }

    // 4b. Match `"referenced"` via direct `paper_raw_refs` (`doi:` / `arxiv:`) AND
    //     pool-resolved `paper_citations` (`oa:W...` -> `canonical_works.doi_norm / arxiv_id_norm`).
    let mut outgoing_keys: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn.prepare(
            "SELECT ref_key FROM paper_raw_refs WHERE src_work_id = ?1 AND (ref_key LIKE 'doi:%' OR ref_key LIKE 'arxiv:%')",
        )?;
        for rk in stmt.query_map([target_work_id], |r| r.get::<_, String>(0))? {
            outgoing_keys.insert(rk?);
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT cw.doi_norm, cw.arxiv_id_norm
             FROM paper_citations pc
             JOIN canonical_works cw ON cw.work_id = pc.cited_work_id
             WHERE pc.citing_work_id = ?1",
        )?;
        let rows = stmt.query_map([target_work_id], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<String>>(1)?,
            ))
        })?;
        for entry in rows {
            let (d_opt, a_opt) = entry?;
            if let Some(d) = d_opt.filter(|s| !s.is_empty()) {
                outgoing_keys.insert(format!("doi:{d}"));
            }
            if let Some(a) = a_opt.filter(|s| !s.is_empty()) {
                outgoing_keys.insert(format!("arxiv:{a}"));
            }
        }
    }

    for key in outgoing_keys {
        if let Some(idxs) = vault.by_ref_key.get(&key) {
            for &vi in idxs {
                if seen_vault_indices.insert(vi) {
                    let e = &vault.entries[vi];
                    matches.push(CollectionVaultPaperMatch {
                        rel_path: e.rel_path.clone(),
                        title: e.title.clone(),
                        doi: e.doi.clone(),
                        arxiv_id: e.arxiv_id.clone(),
                        relation: "referenced".to_string(),
                    });
                }
            }
        }
    }

    Ok(matches)
}

/// Compute `work_id -> cited_vault_count` across the given candidate `work_ids` in `< 2ms`
/// when `vault_path` is provided and `.agentero/catalog.sqlite` is non-empty.
pub(crate) fn compute_cited_vault_counts(
    conn: &Connection,
    candidate_work_ids: &[i64],
    vault_path: Option<&str>,
) -> Result<HashMap<i64, u32>, AppError> {
    if candidate_work_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let vault = load_vault_catalog_index(vault_path);
    if vault.is_empty() || vault.by_ref_key.is_empty() {
        return Ok(HashMap::new());
    }

    let cand_set: HashSet<i64> = candidate_work_ids
        .iter()
        .copied()
        .filter(|&w| w > 0)
        .collect();
    if cand_set.is_empty() {
        return Ok(HashMap::new());
    }

    // Map `citing_work_id -> set of matched vault entry indices` so a Vault paper with both
    // DOI and arXiv ID is counted once, not twice!
    let mut matched_by_work: HashMap<i64, HashSet<usize>> = HashMap::new();

    let ref_keys: Vec<&String> = vault.by_ref_key.keys().collect();
    for chunk in ref_keys.chunks(400) {
        let ph = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql =
            format!("SELECT src_work_id, ref_key FROM paper_raw_refs WHERE ref_key IN ({ph})");
        let binds: Vec<rusqlite::types::Value> =
            chunk.iter().map(|s| (*s).clone().into()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        for entry in rows {
            let (src_wid, rkey) = entry?;
            if !cand_set.contains(&src_wid) {
                continue;
            }
            if let Some(v_idxs) = vault.by_ref_key.get(&rkey) {
                let set = matched_by_work.entry(src_wid).or_default();
                for &vi in v_idxs {
                    set.insert(vi);
                }
            }
        }
    }

    // Also bridge via `canonical_works` + `paper_citations` for `'oa:W...'` edges in `paper_raw_refs`!
    let mut vault_dois: Vec<(String, Vec<usize>)> = Vec::new();
    let mut vault_arxivs: Vec<(String, Vec<usize>)> = Vec::new();
    for (rk, idxs) in &vault.by_ref_key {
        if let Some(d) = rk.strip_prefix("doi:") {
            vault_dois.push((d.to_string(), idxs.clone()));
        } else if let Some(a) = rk.strip_prefix("arxiv:") {
            vault_arxivs.push((a.to_string(), idxs.clone()));
        }
    }

    let mut cited_pool_wid_to_vault: HashMap<i64, HashSet<usize>> = HashMap::new();
    for chunk in vault_dois.chunks(400) {
        let ph = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("SELECT work_id, doi_norm FROM canonical_works WHERE doi_norm IN ({ph})");
        let binds: Vec<rusqlite::types::Value> =
            chunk.iter().map(|(d, _)| d.clone().into()).collect();
        let lookup: HashMap<&str, &[usize]> = chunk
            .iter()
            .map(|(d, v)| (d.as_str(), v.as_slice()))
            .collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        for entry in rows {
            let (wid, d) = entry?;
            if let Some(v_idxs) = lookup.get(d.as_str()) {
                cited_pool_wid_to_vault
                    .entry(wid)
                    .or_default()
                    .extend(v_idxs.iter().copied());
            }
        }
    }
    for chunk in vault_arxivs.chunks(400) {
        let ph = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT work_id, arxiv_id_norm FROM canonical_works WHERE arxiv_id_norm IN ({ph})"
        );
        let binds: Vec<rusqlite::types::Value> =
            chunk.iter().map(|(a, _)| a.clone().into()).collect();
        let lookup: HashMap<&str, &[usize]> = chunk
            .iter()
            .map(|(a, v)| (a.as_str(), v.as_slice()))
            .collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        for entry in rows {
            let (wid, a) = entry?;
            if let Some(v_idxs) = lookup.get(a.as_str()) {
                cited_pool_wid_to_vault
                    .entry(wid)
                    .or_default()
                    .extend(v_idxs.iter().copied());
            }
        }
    }

    if !cited_pool_wid_to_vault.is_empty() {
        let cited_wids: Vec<i64> = cited_pool_wid_to_vault.keys().copied().collect();
        for chunk in cited_wids.chunks(400) {
            let ph = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT citing_work_id, cited_work_id FROM paper_citations WHERE cited_work_id IN ({ph})"
            );
            let binds: Vec<rusqlite::types::Value> =
                chunk.iter().copied().map(Into::into).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(binds), |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })?;
            for entry in rows {
                let (citing_wid, cited_wid) = entry?;
                if !cand_set.contains(&citing_wid) || citing_wid == cited_wid {
                    continue;
                }
                if let Some(v_idxs) = cited_pool_wid_to_vault.get(&cited_wid) {
                    matched_by_work
                        .entry(citing_wid)
                        .or_default()
                        .extend(v_idxs.iter().copied());
                }
            }
        }
    }

    Ok(matched_by_work
        .into_iter()
        .filter_map(|(wid, set)| {
            let cnt = set.len() as u32;
            (cnt > 0).then_some((wid, cnt))
        })
        .collect())
}

pub fn paper_subgraph(args: &CollectionSubgraphArgs) -> Result<CollectionSubgraphOut, AppError> {
    let conn = ensure_collection()?;
    paper_subgraph_conn(&conn, args)
}

pub fn paper_subgraph_at(
    db_path: &Path,
    args: &CollectionSubgraphArgs,
) -> Result<CollectionSubgraphOut, AppError> {
    let conn = ensure_collection_at(db_path)?;
    paper_subgraph_conn(&conn, args)
}

pub(crate) fn paper_subgraph_conn(
    conn: &Connection,
    args: &CollectionSubgraphArgs,
) -> Result<CollectionSubgraphOut, AppError> {
    let mut cleaned_ids: Vec<String> = Vec::new();
    let mut seen_input_ids: HashSet<String> = HashSet::new();
    for raw in &args.ids {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && seen_input_ids.insert(trimmed.to_string()) {
            cleaned_ids.push(trimmed.to_string());
        }
    }

    if cleaned_ids.is_empty() {
        return Ok(CollectionSubgraphOut {
            citation_edges: Vec::new(),
            shared_ref_edges: Vec::new(),
            unexpanded_counts: HashMap::new(),
        });
    }

    let mut id_to_wid: HashMap<String, i64> = HashMap::with_capacity(cleaned_ids.len());
    for chunk in cleaned_ids.chunks(400) {
        let ph = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("SELECT id, work_id FROM papers WHERE id IN ({ph})");
        let binds: Vec<rusqlite::types::Value> = chunk.iter().map(|s| s.clone().into()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for entry in rows {
            let (id, wid) = entry?;
            if wid > 0 {
                id_to_wid.insert(id, wid);
            }
        }
    }

    let mut wid_to_id: HashMap<i64, String> = HashMap::with_capacity(id_to_wid.len());
    let mut wids: Vec<i64> = Vec::with_capacity(id_to_wid.len());
    for id in &cleaned_ids {
        if let Some(&wid) = id_to_wid.get(id) {
            if let std::collections::hash_map::Entry::Vacant(e) = wid_to_id.entry(wid) {
                e.insert(id.clone());
                wids.push(wid);
            }
        }
    }

    if wids.is_empty() {
        return Ok(CollectionSubgraphOut {
            citation_edges: Vec::new(),
            shared_ref_edges: Vec::new(),
            unexpanded_counts: HashMap::new(),
        });
    }

    let wid_set: HashSet<i64> = wids.iter().copied().collect();
    let mut direct_directed: HashSet<(i64, i64)> = HashSet::new();
    let mut direct_undirected: HashSet<(i64, i64)> = HashSet::new();
    let mut outside_neighbors: HashMap<i64, HashSet<i64>> = HashMap::new();

    for chunk in wids.chunks(400) {
        let ph = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let binds: Vec<rusqlite::types::Value> = chunk.iter().copied().map(Into::into).collect();

        // Outgoing references (`citing_work_id` in subgraph)
        let out_sql = format!(
            "SELECT pc.citing_work_id, pc.cited_work_id, cw.active_in_scope
             FROM paper_citations pc
             JOIN canonical_works cw ON cw.work_id = pc.cited_work_id
             WHERE pc.citing_work_id IN ({ph})"
        );
        let mut out_stmt = conn.prepare(&out_sql)?;
        let out_rows = out_stmt.query_map(params_from_iter(binds.clone()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        for entry in out_rows {
            let (citing_wid, cited_wid, active) = entry?;
            if citing_wid == cited_wid {
                continue;
            }
            if wid_set.contains(&cited_wid) {
                direct_directed.insert((citing_wid, cited_wid));
                let pair = if citing_wid < cited_wid {
                    (citing_wid, cited_wid)
                } else {
                    (cited_wid, citing_wid)
                };
                direct_undirected.insert(pair);
            } else if active == 1 {
                outside_neighbors
                    .entry(citing_wid)
                    .or_default()
                    .insert(cited_wid);
            }
        }

        // Incoming citations (`cited_work_id` in subgraph)
        let in_sql = format!(
            "SELECT pc.citing_work_id, pc.cited_work_id
             FROM paper_citations pc
             JOIN canonical_works cw ON cw.work_id = pc.citing_work_id
             WHERE pc.cited_work_id IN ({ph}) AND cw.active_in_scope = 1"
        );
        let mut in_stmt = conn.prepare(&in_sql)?;
        let in_rows = in_stmt.query_map(params_from_iter(binds), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        for entry in in_rows {
            let (citing_wid, cited_wid) = entry?;
            if citing_wid != cited_wid && !wid_set.contains(&citing_wid) {
                outside_neighbors
                    .entry(cited_wid)
                    .or_default()
                    .insert(citing_wid);
            }
        }
    }

    let mut direct_vec: Vec<(i64, i64)> = direct_directed.into_iter().collect();
    direct_vec.sort_unstable();
    let citation_edges: Vec<CollectionCitationEdgeDto> = direct_vec
        .into_iter()
        .filter_map(|(citing_wid, cited_wid)| {
            Some(CollectionCitationEdgeDto {
                citing_id: wid_to_id.get(&citing_wid)?.clone(),
                cited_id: wid_to_id.get(&cited_wid)?.clone(),
            })
        })
        .collect();

    // Shared reference (bibliographic coupling) edges among subgraph works
    let min_shared = args
        .min_shared_refs
        .unwrap_or(MIN_SHARED_REF_COUNT as u32)
        .max(1);
    let mut works_by_ref: HashMap<String, Vec<i64>> = HashMap::new();
    for chunk in wids.chunks(400) {
        let ph = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql =
            format!("SELECT src_work_id, ref_key FROM paper_raw_refs WHERE src_work_id IN ({ph})");
        let binds: Vec<rusqlite::types::Value> = chunk.iter().copied().map(Into::into).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        for entry in rows {
            let (src_wid, ref_key) = entry?;
            works_by_ref.entry(ref_key).or_default().push(src_wid);
        }
    }

    let mut pair_shared: HashMap<(i64, i64), u32> = HashMap::new();
    for (_, mut list) in works_by_ref {
        if list.len() < 2 {
            continue;
        }
        list.sort_unstable();
        list.dedup();
        if list.len() < 2 {
            continue;
        }
        for i in 0..list.len() {
            let u = list[i];
            for &v in &list[(i + 1)..] {
                let pair = (u, v);
                if direct_undirected.contains(&pair) {
                    continue;
                }
                *pair_shared.entry(pair).or_insert(0) += 1;
            }
        }
    }

    let mut shared_candidates: Vec<(i64, i64, u32)> = pair_shared
        .into_iter()
        .filter_map(|((u, v), cnt)| (cnt >= min_shared).then_some((u, v, cnt)))
        .collect();
    shared_candidates.sort_by(|a, b| {
        b.2.cmp(&a.2)
            .then_with(|| a.0.cmp(&b.0))
            .then_with(|| a.1.cmp(&b.1))
    });

    let mut shared_degree: HashMap<i64, usize> = HashMap::new();
    let mut shared_ref_edges: Vec<CollectionSharedRefEdgeDto> = Vec::new();
    for (u, v, cnt) in shared_candidates {
        let du = shared_degree.get(&u).copied().unwrap_or(0);
        let dv = shared_degree.get(&v).copied().unwrap_or(0);
        if du >= MAX_SUBGRAPH_SHARED_DEGREE || dv >= MAX_SUBGRAPH_SHARED_DEGREE {
            continue;
        }
        if let (Some(src_id), Some(dst_id)) = (wid_to_id.get(&u), wid_to_id.get(&v)) {
            *shared_degree.entry(u).or_insert(0) += 1;
            *shared_degree.entry(v).or_insert(0) += 1;
            shared_ref_edges.push(CollectionSharedRefEdgeDto {
                source_id: src_id.clone(),
                target_id: dst_id.clone(),
                shared_count: cnt,
            });
        }
    }

    let mut unexpanded_counts: HashMap<String, u32> = HashMap::new();
    for (wid, neighbors) in outside_neighbors {
        if neighbors.is_empty() {
            continue;
        }
        if let Some(id) = wid_to_id.get(&wid) {
            unexpanded_counts.insert(id.clone(), neighbors.len() as u32);
        }
    }

    Ok(CollectionSubgraphOut {
        citation_edges,
        shared_ref_edges,
        unexpanded_counts,
    })
}
