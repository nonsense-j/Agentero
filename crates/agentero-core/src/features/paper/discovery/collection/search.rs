//! SQLite FTS5 + weighted boolean search, combinable filters, uniform random
//! sampling, collection overview, and Deep Search curation verification.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params_from_iter, Connection};

use crate::error::AppError;

use super::models::{
    BucketCount, CcfDistribution, CollectionCurateOut, CollectionCurateParams,
    CollectionOverviewOut, CollectionPaperHit, CollectionPaperSummary, CollectionSearchArgs,
    CollectionSearchOut, CollectionSearchParams, CollectionSearchResult, CuratedGroupOut,
    CuratedPaperOut, ScoredCollectionPaperDto, VenueBucketCount,
};
use super::schema::{ensure_collection, ensure_collection_at};
use super::store::{
    append_ccf_ranks_clause, append_enabled_scope_clause, infer_venue_kind,
    load_enabled_categories, load_summaries_by_row_ids, max_published_at_in_scope,
    resolve_date_bounds, resolve_single_date_bound, PAPER_SUMMARY_SELECT_COLS,
};

// ─── Overview ───

pub fn overview() -> Result<CollectionOverviewOut, AppError> {
    let conn = ensure_collection()?;
    compute_overview_conn(&conn)
}

pub fn overview_at(db_path: &Path) -> Result<CollectionOverviewOut, AppError> {
    let conn = ensure_collection_at(db_path)?;
    compute_overview_conn(&conn)
}

pub(crate) fn compute_overview_conn(conn: &Connection) -> Result<CollectionOverviewOut, AppError> {
    let updated_at: Option<String> = conn
        .query_row(
            "SELECT last_refreshed_at FROM collection_config WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or(None);

    let enabled_cats = load_enabled_categories(conn)?;

    let mut cat_counts: HashMap<String, usize> = HashMap::new();
    for cat in &enabled_cats {
        cat_counts.entry(cat.clone()).or_insert(0);
    }

    let mut arxiv_count = 0usize;
    let mut venue_count = 0usize;
    let mut ccf_a = 0usize;
    let mut ccf_b = 0usize;
    let mut venue_counts: HashMap<String, usize> = HashMap::new();
    let mut earliest: Option<String> = None;
    let mut latest: Option<String> = None;

    let mut sql = String::from(
        "SELECT p.source_type, p.source_label, p.venue_id, p.ccf_rank, p.published_ymd, p.categories_json \
         FROM papers p WHERE 1=1",
    );
    let mut binds: Vec<rusqlite::types::Value> = Vec::new();
    append_enabled_scope_clause(&mut sql, &mut binds, "p", &enabled_cats);

    {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;

        for entry in rows {
            let (source_type, source_label, venue_id, ccf_rank, pub_ymd, cats_json) = entry?;
            if source_type == "arxiv" {
                arxiv_count += 1;
                let paper_cats: Vec<String> = serde_json::from_str(&cats_json).unwrap_or_default();
                let mut matched_configured = false;
                for cat in &enabled_cats {
                    if source_label.eq_ignore_ascii_case(cat)
                        || paper_cats.iter().any(|c| c.eq_ignore_ascii_case(cat))
                    {
                        *cat_counts.entry(cat.clone()).or_insert(0) += 1;
                        matched_configured = true;
                    }
                }
                if !matched_configured && !source_label.is_empty() {
                    *cat_counts.entry(source_label.clone()).or_insert(0) += 1;
                }
            } else {
                venue_count += 1;
                let key = venue_id
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| source_label.clone());
                *venue_counts.entry(key).or_insert(0) += 1;
            }

            match ccf_rank.as_deref() {
                Some("CCF-A") => ccf_a += 1,
                Some("CCF-B") => ccf_b += 1,
                _ => {}
            }

            if pub_ymd.len() == 10 {
                if earliest.as_ref().is_none_or(|cur| pub_ymd < *cur) {
                    earliest = Some(pub_ymd.clone());
                }
                if latest.as_ref().is_none_or(|cur| pub_ymd > *cur) {
                    latest = Some(pub_ymd);
                }
            }
        }
    }

    let mut categories: Vec<BucketCount> = cat_counts
        .into_iter()
        .map(|(label, count)| BucketCount { label, count })
        .collect();
    categories.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.label.cmp(&b.label)));

    let mut venues: Vec<VenueBucketCount> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, name, url, kind, domain, ccf_rank FROM venues ORDER BY position ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })?;
        for entry in rows {
            let (id, name, url, kind_opt, domain, ccf_rank) = entry?;
            let count = venue_counts
                .remove(&id)
                .or_else(|| venue_counts.remove(&name))
                .unwrap_or(0);
            let kind = Some(infer_venue_kind(&id, &name, &url, kind_opt.as_deref()));
            venues.push(VenueBucketCount {
                id,
                name,
                kind,
                domain,
                ccf_rank,
                count,
            });
        }
    }

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

    Ok(CollectionOverviewOut {
        total_papers: arxiv_count + venue_count,
        arxiv_count,
        venue_count,
        updated_at: updated_at.unwrap_or_default(),
        earliest_date: earliest,
        latest_date: latest,
        ccf_distribution: CcfDistribution {
            ccf_a,
            ccf_b,
            arxiv_preprint: arxiv_count,
        },
        categories,
        venues,
    })
}

// ─── Boolean Query Parser + FTS5 Candidate Builder + Weighted Scorer ───

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

/// Build an FTS5 prefix disjunction over positive ASCII alphanumeric tokens when every
/// branch has at least one positive ASCII word (`len >= 2`) and no non-ASCII/CJK characters.
fn build_fts5_match_expr(parsed: &ParsedBooleanQuery) -> Option<String> {
    if parsed.branches.is_empty() {
        return None;
    }

    let mut branch_exprs: Vec<String> = Vec::with_capacity(parsed.branches.len());
    for branch in &parsed.branches {
        let mut word_exprs: Vec<String> = Vec::new();
        for term in branch {
            if term.negated {
                continue;
            }
            if !term.text.is_ascii() {
                return None;
            }
            for w in term.text.split(|c: char| !c.is_ascii_alphanumeric()) {
                if w.is_empty() {
                    continue;
                }
                if w.len() < 2 {
                    return None;
                }
                word_exprs.push(format!("\"{w}\"*"));
            }
        }
        if word_exprs.is_empty() {
            return None;
        }
        branch_exprs.push(format!("({})", word_exprs.join(" AND ")));
    }

    if branch_exprs.is_empty() {
        None
    } else {
        Some(branch_exprs.join(" OR "))
    }
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

struct CandidateDoc {
    row_id: i64,
    id: String,
    published_at: String,
    citation_count: u32,
    title: String,
    keywords_text: String,
    abstract_text: String,
}

fn score_candidate_doc(
    doc: &CandidateDoc,
    parsed: &ParsedBooleanQuery,
    mask: SearchFieldsMask,
) -> Option<(f64, Vec<String>)> {
    if parsed.branches.is_empty() {
        return Some((1.0, Vec::new()));
    }

    let title_lc = if mask.title {
        doc.title.to_lowercase()
    } else {
        String::new()
    };
    let kw_lc = if mask.keywords {
        doc.keywords_text.to_lowercase()
    } else {
        String::new()
    };
    let abs_lc = if mask.abstract_text {
        doc.abstract_text.to_lowercase()
    } else {
        String::new()
    };

    let mut best_score: Option<f64> = None;
    let mut best_fields: Vec<String> = Vec::new();

    for branch in &parsed.branches {
        let mut branch_ok = true;
        let mut score = 0.0f64;
        let mut has_positive = false;
        let mut hit_title = false;
        let mut hit_kw = false;
        let mut hit_abs = false;

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
                    hit_title = true;
                    score += if term.phrase { 8.0 } else { 3.5 };
                }
                if in_kw {
                    hit_kw = true;
                    score += if term.phrase { 6.0 } else { 3.0 };
                }
                if in_abs {
                    hit_abs = true;
                    score += if term.phrase { 2.5 } else { 1.2 };
                }
            }
        }

        if branch_ok {
            let final_score = if has_positive { score } else { 1.0 };
            if best_score.is_none_or(|prev| final_score > prev) {
                best_score = Some(final_score);
                let mut fields_out = Vec::with_capacity(3);
                if hit_title {
                    fields_out.push("title".to_string());
                }
                if hit_kw {
                    fields_out.push("keywords".to_string());
                }
                if hit_abs {
                    fields_out.push("abstract".to_string());
                }
                best_fields = fields_out;
            }
        }
    }

    best_score.map(|s| ((s * 100.0).round() / 100.0, best_fields))
}

struct StructuralFilters<'a> {
    source_type: Option<&'a str>,
    categories: &'a [String],
    venues: &'a [String],
    venue_kind: Option<&'a str>,
    venue_domain: Option<&'a str>,
    ccf_ranks: &'a [String],
    from_ymd: Option<&'a str>,
    to_ymd: Option<&'a str>,
}

fn append_structural_where(
    where_sql: &mut String,
    binds: &mut Vec<rusqlite::types::Value>,
    enabled_cats: &[String],
    filters: &StructuralFilters<'_>,
) {
    append_enabled_scope_clause(where_sql, binds, "p", enabled_cats);

    if let Some(st) = filters.source_type.map(str::trim) {
        if !st.is_empty() && !st.eq_ignore_ascii_case("all") {
            where_sql.push_str(" AND p.source_type COLLATE NOCASE = ?");
            binds.push(st.to_string().into());
        }
    }

    let clean_cats: Vec<&str> = filters
        .categories
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if !clean_cats.is_empty() {
        let placeholders: String = std::iter::repeat_n("?", clean_cats.len())
            .collect::<Vec<_>>()
            .join(", ");
        where_sql.push_str(&format!(
            " AND (p.source_type != 'arxiv' OR p.source_label COLLATE NOCASE IN ({placeholders}) \
              OR EXISTS (SELECT 1 FROM paper_categories pc WHERE pc.paper_id = p.id AND pc.category IN ({placeholders})))"
        ));
        for c in &clean_cats {
            binds.push((*c).to_string().into());
        }
        for c in &clean_cats {
            binds.push((*c).to_string().into());
        }
    }

    let clean_venues: Vec<&str> = filters
        .venues
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if !clean_venues.is_empty() {
        let mut v_clauses: Vec<String> = Vec::with_capacity(clean_venues.len());
        for v in clean_venues {
            v_clauses.push(
                "(p.venue_id COLLATE NOCASE = ? OR p.source_label COLLATE NOCASE = ? OR LOWER(p.source_label) LIKE ?)"
                    .to_string(),
            );
            binds.push(v.to_string().into());
            binds.push(v.to_string().into());
            binds.push(format!("{} %", v.to_lowercase()).into());
        }
        where_sql.push_str(" AND (p.source_type != 'venue' OR (");
        where_sql.push_str(&v_clauses.join(" OR "));
        where_sql.push_str("))");
    }

    if let Some(vk) = filters.venue_kind.map(str::trim) {
        if !vk.is_empty() && !vk.eq_ignore_ascii_case("all") {
            where_sql.push_str(" AND p.source_type = 'venue' AND p.venue_kind COLLATE NOCASE = ?");
            binds.push(vk.to_string().into());
        }
    }

    if let Some(vd) = filters.venue_domain.map(str::trim) {
        if !vd.is_empty() && !vd.eq_ignore_ascii_case("all") {
            where_sql
                .push_str(" AND p.source_type = 'venue' AND p.venue_domain COLLATE NOCASE = ?");
            binds.push(vd.to_string().into());
        }
    }

    if !filters.ccf_ranks.is_empty() {
        append_ccf_ranks_clause(where_sql, binds, "p", filters.ccf_ranks);
    }

    if let Some(from) = filters.from_ymd {
        where_sql.push_str(" AND (p.published_ymd = '' OR p.published_ymd >= ?)");
        binds.push(from.to_string().into());
    }
    if let Some(to) = filters.to_ymd {
        where_sql.push_str(" AND (p.published_ymd = '' OR p.published_ymd <= ?)");
        binds.push(to.to_string().into());
    }
}

fn query_candidate_docs(
    conn: &Connection,
    where_sql: &str,
    base_binds: &[rusqlite::types::Value],
    fts_expr: Option<&str>,
) -> Result<Vec<CandidateDoc>, AppError> {
    let (sql, binds) = if let Some(expr) = fts_expr {
        let mut b = Vec::with_capacity(base_binds.len() + 1);
        b.push(rusqlite::types::Value::from(expr.to_string()));
        b.extend(base_binds.iter().cloned());
        (
            format!(
                "SELECT p.row_id, p.id, p.published_at, p.citation_count, p.title, p.keywords_text, p.abstract_text \
                 FROM papers p \
                 JOIN papers_fts ON papers_fts.rowid = p.row_id \
                 {where_sql_fts}",
                where_sql_fts = where_sql.replacen(" WHERE 1=1", " WHERE papers_fts MATCH ?", 1)
            ),
            b,
        )
    } else {
        (
            format!(
                "SELECT p.row_id, p.id, p.published_at, p.citation_count, p.title, p.keywords_text, p.abstract_text \
                 FROM papers p{where_sql}"
            ),
            base_binds.to_vec(),
        )
    };

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(binds), |r| {
        let cites: i64 = r.get(3)?;
        Ok(CandidateDoc {
            row_id: r.get(0)?,
            id: r.get(1)?,
            published_at: r.get(2)?,
            citation_count: cites.max(0) as u32,
            title: r.get(4)?,
            keywords_text: r.get(5)?,
            abstract_text: r.get(6)?,
        })
    })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn score_filtered_candidates(
    conn: &Connection,
    where_sql: &str,
    base_binds: &[rusqlite::types::Value],
    parsed: &ParsedBooleanQuery,
    mask: SearchFieldsMask,
) -> Result<Vec<(CandidateDoc, f64, Vec<String>)>, AppError> {
    if let Some(fts_expr) = build_fts5_match_expr(parsed) {
        if let Ok(fts_docs) = query_candidate_docs(conn, where_sql, base_binds, Some(&fts_expr)) {
            let scored: Vec<(CandidateDoc, f64, Vec<String>)> = fts_docs
                .into_iter()
                .filter_map(|doc| {
                    score_candidate_doc(&doc, parsed, mask).map(|(s, mf)| (doc, s, mf))
                })
                .collect();
            if !scored.is_empty() {
                return Ok(scored);
            }
        }
    }

    // Fallback to full SQL-filtered scan for empty queries, pure negations, CJK, or infix substrings.
    let all_docs = query_candidate_docs(conn, where_sql, base_binds, None)?;
    Ok(all_docs
        .into_iter()
        .filter_map(|doc| score_candidate_doc(&doc, parsed, mask).map(|(s, mf)| (doc, s, mf)))
        .collect())
}

// ─── IPC Fast Search (`plaza_collection_search`) ───

pub fn search_fast(args: &CollectionSearchArgs) -> Result<CollectionSearchResult, AppError> {
    let conn = ensure_collection()?;
    search_fast_conn(&conn, args)
}

pub fn search_fast_at(
    db_path: &Path,
    args: &CollectionSearchArgs,
) -> Result<CollectionSearchResult, AppError> {
    let conn = ensure_collection_at(db_path)?;
    search_fast_conn(&conn, args)
}

pub(crate) fn search_fast_conn(
    conn: &Connection,
    args: &CollectionSearchArgs,
) -> Result<CollectionSearchResult, AppError> {
    let enabled_cats = load_enabled_categories(conn)?;
    let latest_iso = max_published_at_in_scope(conn, &enabled_cats)?;
    let (from_ymd, to_ymd) = resolve_date_bounds(
        args.time_preset.as_deref(),
        args.date_from.as_deref(),
        args.date_to.as_deref(),
        latest_iso.as_deref(),
    );

    let mut where_sql = String::from(" WHERE 1=1");
    let mut base_binds: Vec<rusqlite::types::Value> = Vec::new();
    append_structural_where(
        &mut where_sql,
        &mut base_binds,
        &enabled_cats,
        &StructuralFilters {
            source_type: args.source_type.as_deref(),
            categories: &args.categories,
            venues: &args.venues,
            venue_kind: args.venue_kind.as_deref(),
            venue_domain: args.venue_domain.as_deref(),
            ccf_ranks: &args.ccf_ranks,
            from_ymd: from_ymd.as_deref(),
            to_ymd: to_ymd.as_deref(),
        },
    );

    let raw_query = args.query.as_deref().unwrap_or("").trim();
    let parsed = parse_boolean_query(raw_query);
    let mask = SearchFieldsMask::from_list(&args.fields);
    let has_query = !parsed.branches.is_empty();

    let mut hits = score_filtered_candidates(conn, &where_sql, &base_binds, &parsed, mask)?;
    let total_matched = hits.len();

    let raw_sort = args.sort.as_deref().map(str::trim).unwrap_or("relevance");
    let effective_sort = if !has_query && raw_sort.eq_ignore_ascii_case("relevance") {
        "newest"
    } else {
        raw_sort
    };

    if effective_sort.eq_ignore_ascii_case("citations") {
        hits.sort_by(|a, b| {
            b.0.citation_count
                .cmp(&a.0.citation_count)
                .then_with(|| b.0.published_at.cmp(&a.0.published_at))
                .then_with(|| a.0.id.cmp(&b.0.id))
        });
    } else if effective_sort.eq_ignore_ascii_case("newest") {
        hits.sort_by(|a, b| {
            b.0.published_at
                .cmp(&a.0.published_at)
                .then_with(|| b.0.citation_count.cmp(&a.0.citation_count))
                .then_with(|| a.0.id.cmp(&b.0.id))
        });
    } else {
        hits.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.0.citation_count.cmp(&a.0.citation_count))
                .then_with(|| b.0.published_at.cmp(&a.0.published_at))
                .then_with(|| a.0.id.cmp(&b.0.id))
        });
    }

    let limit = args.limit.unwrap_or(100).clamp(1, 1000);
    let offset = args.offset.unwrap_or(0);
    let page_slice: Vec<(i64, f64, Vec<String>)> = hits
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(doc, score, mf)| (doc.row_id, score, mf))
        .collect();

    let row_ids: Vec<i64> = page_slice.iter().map(|(rid, _, _)| *rid).collect();
    let mut summaries = load_summaries_by_row_ids(conn, &row_ids)?;

    let mut items = Vec::with_capacity(page_slice.len());
    for (rid, score, matched_fields) in page_slice {
        if let Some(paper) = summaries.remove(&rid) {
            items.push(ScoredCollectionPaperDto {
                paper,
                score,
                matched_fields,
            });
        }
    }

    Ok(CollectionSearchResult {
        items,
        total_matched,
    })
}

// ─── MCP Deep Search (`collection_search` & `collection_curate`) ───

pub(crate) fn truncate_abstract_for_hit(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars).collect();
    format!("{}…", truncated.trim_end())
}

pub(crate) fn summary_to_hit(paper: &CollectionPaperSummary, score: f32) -> CollectionPaperHit {
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

/// SplitMix64 PRNG for fast, dependency-free uniform Fisher-Yates sampling.
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

pub fn search_collection_at(
    db_path: &Path,
    params: &CollectionSearchParams,
) -> Result<CollectionSearchOut, AppError> {
    let conn = ensure_collection_at(db_path)?;
    search_collection_conn(&conn, params)
}

pub(crate) fn search_collection_conn(
    conn: &Connection,
    params: &CollectionSearchParams,
) -> Result<CollectionSearchOut, AppError> {
    let enabled_cats = load_enabled_categories(conn)?;

    let mut pool_sql = String::from("SELECT COUNT(*) FROM papers p WHERE 1=1");
    let mut pool_binds: Vec<rusqlite::types::Value> = Vec::new();
    append_enabled_scope_clause(&mut pool_sql, &mut pool_binds, "p", &enabled_cats);
    let total_pool_raw: i64 =
        conn.query_row(&pool_sql, params_from_iter(pool_binds), |r| r.get(0))?;
    let total_pool_size = total_pool_raw.max(0) as usize;

    let raw_query = params.query.as_deref().unwrap_or("").trim().to_string();
    let mode = match params.mode.as_deref() {
        Some(m) if m.eq_ignore_ascii_case("random_sample") => "random_sample",
        _ => "ranked",
    };
    let mask = SearchFieldsMask::from_list(&params.fields);
    let parsed = parse_boolean_query(&raw_query);

    let latest_iso = max_published_at_in_scope(conn, &enabled_cats)?;
    let date_from_ymd =
        resolve_single_date_bound(params.date_from.as_deref(), latest_iso.as_deref());
    let date_to_ymd = resolve_single_date_bound(params.date_to.as_deref(), latest_iso.as_deref());

    let mut where_sql = String::from(" WHERE 1=1");
    let mut base_binds: Vec<rusqlite::types::Value> = Vec::new();
    append_structural_where(
        &mut where_sql,
        &mut base_binds,
        &enabled_cats,
        &StructuralFilters {
            source_type: params.source_type.as_deref(),
            categories: &params.categories,
            venues: &params.venues,
            venue_kind: params.venue_kind.as_deref(),
            venue_domain: params.venue_domain.as_deref(),
            ccf_ranks: &params.ccf_ranks,
            from_ymd: date_from_ymd.as_deref(),
            to_ymd: date_to_ymd.as_deref(),
        },
    );

    let mut strict_hits: Vec<(CandidateDoc, f32)> =
        score_filtered_candidates(conn, &where_sql, &base_binds, &parsed, mask)?
            .into_iter()
            .map(|(doc, s, _)| (doc, s as f32))
            .collect();

    let strict_matched_count = strict_hits.len();
    let mut broadened = false;

    if mode == "random_sample" && !raw_query.is_empty() && strict_hits.len() < 10 {
        if let Some(broad_q) = build_broadened_or_query(&raw_query) {
            let strict_ids: HashSet<String> =
                strict_hits.iter().map(|(d, _)| d.id.clone()).collect();
            let mut extra: Vec<(CandidateDoc, f32)> =
                score_filtered_candidates(conn, &where_sql, &base_binds, &broad_q, mask)?
                    .into_iter()
                    .filter(|(d, _, _)| !strict_ids.contains(&d.id))
                    .map(|(d, s, _)| (d, (s as f32) * 0.6))
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

    let chosen_slice: Vec<(i64, f32)> = if mode == "random_sample" {
        let cap = params.sample_size.unwrap_or(50).clamp(1, 50);
        if strict_hits.len() <= cap {
            strict_hits
                .into_iter()
                .map(|(d, s)| (d.row_id, s))
                .collect()
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
                .map(|(d, s)| (d.row_id, s))
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
            .map(|(d, s)| (d.row_id, s))
            .collect()
    };

    let row_ids: Vec<i64> = chosen_slice.iter().map(|(rid, _)| *rid).collect();
    let summaries = load_summaries_by_row_ids(conn, &row_ids)?;
    let mut selected = Vec::with_capacity(chosen_slice.len());
    for (rid, score) in chosen_slice {
        if let Some(summary) = summaries.get(&rid) {
            selected.push(summary_to_hit(summary, score));
        }
    }

    Ok(CollectionSearchOut {
        mode: mode.to_string(),
        query: raw_query,
        total_pool_size,
        total_matched,
        strict_matched_count,
        broadened,
        returned_count: selected.len(),
        items: selected,
    })
}

pub fn curate_collection_at(
    db_path: &Path,
    params: CollectionCurateParams,
) -> Result<CollectionCurateOut, AppError> {
    let conn = ensure_collection_at(db_path)?;
    curate_collection_conn(&conn, params)
}

pub(crate) fn curate_collection_conn(
    conn: &Connection,
    params: CollectionCurateParams,
) -> Result<CollectionCurateOut, AppError> {
    let enabled_cats = load_enabled_categories(conn)?;
    let mode = match params.mode.as_deref() {
        Some(m) if m.eq_ignore_ascii_case("append") => "append".to_string(),
        _ => "replace".to_string(),
    };

    let mut requested_ids: Vec<String> = Vec::new();
    let mut seen_req = HashSet::new();
    for g in &params.groups {
        for item in &g.items {
            let trimmed = item.id.trim();
            if !trimmed.is_empty() && seen_req.insert(trimmed.to_string()) {
                requested_ids.push(trimmed.to_string());
            }
        }
    }

    let mut by_id: HashMap<String, (String, String, Option<String>, i32)> = HashMap::new();
    if !requested_ids.is_empty() {
        let placeholders: String = std::iter::repeat_n("?", requested_ids.len())
            .collect::<Vec<_>>()
            .join(", ");
        let mut sql = format!(
            "SELECT p.id, p.title, p.source_label, p.ccf_rank, p.year \
             FROM papers p WHERE p.id IN ({placeholders})"
        );
        let mut binds: Vec<rusqlite::types::Value> =
            requested_ids.iter().cloned().map(Into::into).collect();
        append_enabled_scope_clause(&mut sql, &mut binds, "p", &enabled_cats);

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i32>(4)?,
            ))
        })?;
        for entry in rows {
            let (id, title, source_label, ccf_rank, year) = entry?;
            by_id.insert(id, (title, source_label, ccf_rank, year));
        }
    }

    let _ = PAPER_SUMMARY_SELECT_COLS; // keep import cleanliness
    let mut groups_out = Vec::new();
    let mut dropped = Vec::new();
    let mut curated_count = 0usize;

    for group in params.groups {
        let mut items_out = Vec::new();
        for entry in group.items {
            let trimmed = entry.id.trim();
            if let Some((title, source_label, ccf_rank, year)) = by_id.get(trimmed) {
                curated_count += 1;
                items_out.push(CuratedPaperOut {
                    id: trimmed.to_string(),
                    title: title.clone(),
                    source_label: source_label.clone(),
                    ccf_rank: ccf_rank.clone(),
                    year: *year,
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

    Ok(CollectionCurateOut {
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
    })
}
