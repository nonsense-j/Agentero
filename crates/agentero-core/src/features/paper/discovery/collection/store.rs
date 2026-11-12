//! CRUD, metadata-preserving upserts, atomic venue replacement, pagination, and state summaries
//! for `collection.sqlite`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, TransactionBehavior};

use crate::error::AppError;

use super::models::{
    CollectionArxivLatest, CollectionArxivWatermark, CollectionArxivWatermarkInput,
    CollectionClearArgs, CollectionConfigUpdateArgs, CollectionListPapersArgs,
    CollectionPaperDetail, CollectionPaperSummary, CollectionPaperUpsertInput,
    CollectionPapersPage, CollectionPatchPapersArgs, CollectionStateSummary,
    CollectionUpsertPapersArgs, CollectionVenueInput, CollectionVenueRecord,
    CollectionVenueWatermarkUpdate,
};
use super::schema::{ensure_collection, ensure_collection_at};

pub(crate) fn now_rfc3339() -> String {
    crate::time::now_rfc3339_millis()
}

pub(crate) fn clean_opt_str(raw: Option<String>) -> Option<String> {
    raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub(crate) fn clean_doi_key(raw: &str) -> Option<String> {
    let s = raw
        .trim()
        .trim_start_matches("https://doi.org/")
        .trim_start_matches("http://doi.org/")
        .trim_start_matches("https://dx.doi.org/")
        .trim_start_matches("doi:")
        .trim_start_matches("DOI:")
        .trim_end_matches(['.', ',', ';', ')'])
        .trim()
        .to_lowercase();
    (!s.is_empty()).then_some(s)
}

pub(crate) fn clean_arxiv_key(raw: &str) -> Option<String> {
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

pub(crate) fn norm_title_key(title: &str) -> String {
    title
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(c))
        .flat_map(|c| c.to_lowercase())
        .collect()
}

pub(crate) fn is_placeholder_abstract(abstract_text: &str, venue_label: Option<&str>) -> bool {
    let trimmed = abstract_text.trim();
    if trimmed.chars().count() < 36 {
        return true;
    }
    if trimmed.to_ascii_lowercase().ends_with("accepted paper") {
        return true;
    }
    if let Some(vl) = venue_label {
        if trimmed.eq_ignore_ascii_case(vl.trim()) {
            return true;
        }
    }
    if trimmed.contains(" · ") && trimmed.chars().count() <= 84 {
        return true;
    }
    false
}

pub(crate) fn choose_better_abstract(existing: &str, incoming: &str, source_label: &str) -> String {
    let ex_trim = existing.trim();
    let in_trim = incoming.trim();
    if in_trim.is_empty() {
        return ex_trim.to_string();
    }
    if ex_trim.is_empty() {
        return in_trim.to_string();
    }
    let ex_ph = is_placeholder_abstract(ex_trim, Some(source_label));
    let in_ph = is_placeholder_abstract(in_trim, Some(source_label));
    if !in_ph && ex_ph {
        return in_trim.to_string();
    }
    if in_ph && !ex_ph {
        return ex_trim.to_string();
    }
    if in_trim.chars().count() >= ex_trim.chars().count() {
        in_trim.to_string()
    } else {
        ex_trim.to_string()
    }
}

pub(crate) fn union_strings_case_insensitive(
    existing: &[String],
    incoming: &[String],
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for s in existing.iter().chain(incoming.iter()) {
        let trimmed = s.split_whitespace().collect::<Vec<_>>().join(" ");
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_lowercase();
        if seen.insert(lower) {
            out.push(trimmed);
        }
    }
    out
}

pub(crate) fn clean_string_vec(list: &[String]) -> Vec<String> {
    union_strings_case_insensitive(&[], list)
}

pub(crate) fn build_keywords_text(
    keywords: &[String],
    categories: &[String],
    source_label: &str,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !keywords.is_empty() {
        parts.push(keywords.join(" ; "));
    }
    if !categories.is_empty() {
        parts.push(categories.join(" "));
    }
    let sl = source_label.trim();
    if !sl.is_empty() {
        parts.push(sl.to_string());
    }
    parts.join(" ")
}

pub(crate) fn infer_venue_kind(id: &str, name: &str, url: &str, kind: Option<&str>) -> String {
    if let Some(k) = kind.map(str::trim) {
        if k.eq_ignore_ascii_case("journal") {
            return "journal".to_string();
        }
        if k.eq_ignore_ascii_case("conference") {
            return "conference".to_string();
        }
    }
    let lower = format!("{id} {name} {url}").to_lowercase();
    if lower.contains("/db/journals/")
        || lower.contains("journal")
        || lower.contains("transactions")
        || lower.starts_with("tse-")
        || lower.starts_with("tosem-")
        || lower.starts_with("ese-")
    {
        "journal".to_string()
    } else {
        "conference".to_string()
    }
}

pub(crate) fn format_paper_citation_text(paper: &CollectionPaperSummary) -> String {
    let author_text = if paper.authors.is_empty() {
        "Unknown Authors".to_string()
    } else {
        paper.authors.join(", ")
    };
    let year = if paper.year > 0 { paper.year } else { 2026 };
    let title = paper.title.trim_end_matches('.');
    let venue_name = paper
        .venue_full
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&paper.source_label);

    if paper.source_type == "arxiv" {
        if let Some(ref arxiv_id) = paper.arxiv_id.as_deref().filter(|s| !s.trim().is_empty()) {
            let link = if let Some(ref doi) = paper.doi.as_deref().filter(|s| !s.trim().is_empty())
            {
                format!(" https://doi.org/{doi}")
            } else if !paper.url.trim().is_empty() {
                format!(" {}", paper.url.trim())
            } else {
                String::new()
            };
            return format!(
                "{author_text}. ({year}). {title}. arXiv preprint arXiv:{arxiv_id}.{link}"
            );
        }
    }

    let mut vol_parts: Vec<String> = Vec::new();
    if let Some(v) = paper.volume.as_deref().filter(|s| !s.trim().is_empty()) {
        vol_parts.push(format!("Vol. {v}"));
    }
    if let Some(i) = paper.issue.as_deref().filter(|s| !s.trim().is_empty()) {
        vol_parts.push(format!("No. {i}"));
    }
    if let Some(p) = paper.pages.as_deref().filter(|s| !s.trim().is_empty()) {
        vol_parts.push(format!("pp. {p}"));
    }
    let venue_part = if vol_parts.is_empty() {
        venue_name.to_string()
    } else {
        format!("{venue_name} ({})", vol_parts.join(", "))
    };
    let link_part = if let Some(doi) = paper.doi.as_deref().filter(|s| !s.trim().is_empty()) {
        format!(" https://doi.org/{doi}")
    } else if !paper.url.trim().is_empty() {
        format!(" {}", paper.url.trim())
    } else {
        String::new()
    };
    format!("{author_text}. ({year}). {title}. In {venue_part}.{link_part}")
}

pub(crate) fn format_paper_bibtex(
    paper: &CollectionPaperSummary,
    stored_bibtex: Option<&str>,
) -> String {
    if let Some(b) = stored_bibtex.map(str::trim).filter(|s| !s.is_empty()) {
        return b.to_string();
    }
    let first_author_last = paper
        .authors
        .first()
        .and_then(|a| a.split_whitespace().last())
        .map(|w| {
            w.chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_lowercase()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "paper".to_string());
    let title_lower = paper.title.to_lowercase();
    let first_title_word = title_lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() >= 4)
        .unwrap_or("work");
    let year = if paper.year > 0 { paper.year } else { 2026 };
    let cite_key = format!("{first_author_last}{year}{first_title_word}");
    let author_bib = if paper.authors.is_empty() {
        "Unknown".to_string()
    } else {
        paper.authors.join(" and ")
    };

    if paper.source_type == "arxiv" {
        if let Some(arxiv_id) = paper.arxiv_id.as_deref().filter(|s| !s.trim().is_empty()) {
            let mut lines = vec![
                format!("@misc{{{cite_key},"),
                format!("  title = {{{}}},", paper.title),
                format!("  author = {{{author_bib}}},"),
                format!("  year = {{{year}}},"),
                format!("  eprint = {{{arxiv_id}}},"),
                "  archivePrefix = {arXiv},".to_string(),
                format!("  primaryClass = {{{}}},", paper.source_label),
            ];
            if let Some(doi) = paper.doi.as_deref().filter(|s| !s.trim().is_empty()) {
                lines.push(format!("  doi = {{{doi}}},"));
            }
            lines.push(format!("  url = {{{}}}", paper.url));
            lines.push("}".to_string());
            return lines.join("\n");
        }
    }

    let is_journal = paper
        .venue_kind
        .as_deref()
        .is_some_and(|k| k.eq_ignore_ascii_case("journal"));
    let entry_type = if is_journal {
        "article"
    } else {
        "inproceedings"
    };
    let venue_field = if is_journal { "journal" } else { "booktitle" };
    let venue_val = paper
        .venue_full
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&paper.source_label);

    let mut lines = vec![
        format!("@{entry_type}{{{cite_key},"),
        format!("  title = {{{}}},", paper.title),
        format!("  author = {{{author_bib}}},"),
        format!("  {venue_field} = {{{venue_val}}},"),
        format!("  year = {{{year}}},"),
    ];
    if let Some(vol) = paper.volume.as_deref().filter(|s| !s.trim().is_empty()) {
        lines.push(format!("  volume = {{{vol}}},"));
    }
    if let Some(iss) = paper.issue.as_deref().filter(|s| !s.trim().is_empty()) {
        lines.push(format!("  number = {{{iss}}},"));
    }
    if let Some(pgs) = paper.pages.as_deref().filter(|s| !s.trim().is_empty()) {
        lines.push(format!("  pages = {{{pgs}}},"));
    }
    if let Some(doi) = paper.doi.as_deref().filter(|s| !s.trim().is_empty()) {
        lines.push(format!("  doi = {{{doi}}},"));
    }
    lines.push(format!("  url = {{{}}}", paper.url));
    lines.push("}".to_string());
    lines.join("\n")
}

// ─── Enabled Category Visibility Scope ───

pub(crate) fn load_enabled_categories(conn: &Connection) -> Result<Vec<String>, AppError> {
    let raw: String = conn
        .query_row(
            "SELECT categories_json FROM collection_config WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| super::schema::DEFAULT_ARXIV_CATEGORIES_JSON.to_string());
    let parsed: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(clean_string_vec(&parsed))
}

pub(crate) fn append_enabled_scope_clause(
    sql: &mut String,
    binds: &mut Vec<rusqlite::types::Value>,
    alias: &str,
    enabled_cats: &[String],
) {
    if enabled_cats.is_empty() {
        return;
    }
    let placeholders: String = std::iter::repeat_n("?", enabled_cats.len())
        .collect::<Vec<_>>()
        .join(", ");
    sql.push_str(&format!(
        " AND ({alias}.source_type != 'arxiv' OR {alias}.source_label COLLATE NOCASE IN ({placeholders}) \
          OR EXISTS (SELECT 1 FROM paper_categories pc WHERE pc.paper_id = {alias}.id AND pc.category IN ({placeholders})))"
    ));
    for c in enabled_cats {
        binds.push(c.clone().into());
    }
    for c in enabled_cats {
        binds.push(c.clone().into());
    }
}

pub(crate) fn max_published_at_in_scope(
    conn: &Connection,
    enabled_cats: &[String],
) -> Result<Option<String>, AppError> {
    let mut sql =
        String::from("SELECT MAX(p.published_at) FROM papers p WHERE p.published_at != ''");
    let mut binds: Vec<rusqlite::types::Value> = Vec::new();
    append_enabled_scope_clause(&mut sql, &mut binds, "p", enabled_cats);
    let max_ts: Option<String> = conn.query_row(&sql, params_from_iter(binds), |r| r.get(0))?;
    Ok(max_ts.filter(|s| !s.is_empty()))
}

pub(crate) fn resolve_date_bounds(
    time_preset: Option<&str>,
    date_from: Option<&str>,
    date_to: Option<&str>,
    latest_iso: Option<&str>,
) -> (Option<String>, Option<String>) {
    let preset = time_preset.map(str::trim).unwrap_or("");
    if preset.eq_ignore_ascii_case("all") {
        return (None, None);
    }
    if preset.eq_ignore_ascii_case("7d")
        || preset.eq_ignore_ascii_case("30d")
        || preset.eq_ignore_ascii_case("90d")
    {
        return (resolve_single_date_bound(Some(preset), latest_iso), None);
    }
    (
        resolve_single_date_bound(date_from, latest_iso),
        resolve_single_date_bound(date_to, latest_iso),
    )
}

pub(crate) fn resolve_single_date_bound(
    raw: Option<&str>,
    latest_iso: Option<&str>,
) -> Option<String> {
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

// ─── Row Mapping ───

pub(crate) const PAPER_SUMMARY_SELECT_COLS: &str = "p.id, p.title, p.authors_json, p.abstract_text, \
    p.published_at, p.year, p.source_type, p.source_label, p.categories_json, p.url, p.pdf_url, \
    p.arxiv_id, p.doi, p.venue_id, p.venue_kind, p.venue_domain, p.ccf_rank, p.venue_full, \
    p.citation_count, p.keywords_json, p.volume, p.issue, p.pages, p.cool_papers_id, p.recommended_at";

pub(crate) fn map_paper_summary_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CollectionPaperSummary> {
    let authors_json: String = row.get(2)?;
    let categories_json: String = row.get(8)?;
    let citation_count_raw: i64 = row.get(18)?;
    let keywords_json: String = row.get(19)?;
    Ok(CollectionPaperSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        authors: serde_json::from_str(&authors_json).unwrap_or_default(),
        abstract_text: row.get(3)?,
        published_at: row.get(4)?,
        year: row.get(5)?,
        source_type: row.get(6)?,
        source_label: row.get(7)?,
        categories: serde_json::from_str(&categories_json).unwrap_or_default(),
        url: row.get(9)?,
        pdf_url: row.get(10)?,
        arxiv_id: row.get(11)?,
        doi: row.get(12)?,
        venue_id: row.get(13)?,
        venue_kind: row.get(14)?,
        venue_domain: row.get(15)?,
        ccf_rank: row.get(16)?,
        venue_full: row.get(17)?,
        citation_count: citation_count_raw.max(0) as u32,
        keywords: serde_json::from_str(&keywords_json).unwrap_or_default(),
        volume: row.get(20)?,
        issue: row.get(21)?,
        pages: row.get(22)?,
        cool_papers_id: row.get(23)?,
        recommended_at: row.get(24)?,
    })
}

pub(crate) fn load_summaries_by_row_ids(
    conn: &Connection,
    row_ids: &[i64],
) -> Result<HashMap<i64, CollectionPaperSummary>, AppError> {
    if row_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders: String = std::iter::repeat_n("?", row_ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {PAPER_SUMMARY_SELECT_COLS}, p.row_id FROM papers p WHERE p.row_id IN ({placeholders})"
    );
    let binds: Vec<rusqlite::types::Value> = row_ids.iter().copied().map(Into::into).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(binds), |row| {
        let summary = map_paper_summary_row(row)?;
        let rid: i64 = row.get(25)?;
        Ok((rid, summary))
    })?;
    let mut map = HashMap::with_capacity(row_ids.len());
    for entry in rows {
        let (rid, summary) = entry?;
        map.insert(rid, summary);
    }
    Ok(map)
}

// ─── State Summary & Config ───

pub fn state_get() -> Result<CollectionStateSummary, AppError> {
    let conn = ensure_collection()?;
    read_state_summary_conn(&conn)
}

pub fn state_get_at(db_path: &Path) -> Result<CollectionStateSummary, AppError> {
    let conn = ensure_collection_at(db_path)?;
    read_state_summary_conn(&conn)
}

pub(crate) fn read_state_summary_conn(
    conn: &Connection,
) -> Result<CollectionStateSummary, AppError> {
    let (categories_json, last_refreshed_at, latest_arxiv_json): (
        String,
        Option<String>,
        Option<String>,
    ) = conn.query_row(
        "SELECT categories_json, last_refreshed_at, latest_arxiv_json FROM collection_config WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;

    let categories = clean_string_vec(
        &serde_json::from_str::<Vec<String>>(&categories_json).unwrap_or_default(),
    );
    let latest_arxiv: Option<CollectionArxivLatest> = latest_arxiv_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());

    let mut arxiv_watermarks = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT category, latest_published_at, latest_arxiv_id, last_synced_at, \
                    oldest_synced_published_at, remote_total, history_complete \
             FROM arxiv_watermarks",
        )?;
        let rows = stmt.query_map([], |r| {
            let cat: String = r.get(0)?;
            let remote_total: Option<i64> = r.get(5)?;
            let history_complete: i64 = r.get(6)?;
            Ok((
                cat,
                CollectionArxivWatermark {
                    latest_published_at: r.get(1)?,
                    latest_arxiv_id: r.get(2)?,
                    last_synced_at: r.get(3)?,
                    oldest_synced_published_at: r.get(4)?,
                    remote_total: remote_total.map(|n| n.max(0) as usize),
                    history_complete: history_complete != 0,
                },
            ))
        })?;
        for entry in rows {
            let (cat, wm) = entry?;
            arxiv_watermarks.insert(cat, wm);
        }
    }

    // Aggregate venue paper counts & conference/journal breakdown
    let mut venue_counts_by_id: HashMap<String, usize> = HashMap::new();
    let mut venue_counts_by_label: HashMap<String, usize> = HashMap::new();
    let mut venue_count = 0usize;
    let mut conference_count = 0usize;
    let mut journal_count = 0usize;
    {
        let mut stmt = conn.prepare(
            "SELECT venue_id, source_label, venue_kind, COUNT(*) \
             FROM papers WHERE source_type = 'venue' \
             GROUP BY venue_id, source_label, venue_kind",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        for entry in rows {
            let (vid, slabel, vkind, cnt_raw) = entry?;
            let cnt = cnt_raw.max(0) as usize;
            venue_count += cnt;
            let inferred =
                infer_venue_kind(vid.as_deref().unwrap_or(""), &slabel, "", vkind.as_deref());
            if inferred == "journal" {
                journal_count += cnt;
            } else {
                conference_count += cnt;
            }
            if let Some(id) = vid.filter(|s| !s.is_empty()) {
                *venue_counts_by_id.entry(id).or_insert(0) += cnt;
            } else if !slabel.is_empty() {
                *venue_counts_by_label
                    .entry(slabel.to_lowercase())
                    .or_insert(0) += cnt;
            }
        }
    }

    let mut venues = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, name, url, mode, kind, domain, ccf_rank, dblp_stream, \
                    last_fetched_at, latest_published_at, remote_total_count \
             FROM venues ORDER BY position ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            let id: String = r.get(0)?;
            let name: String = r.get(1)?;
            let url: String = r.get(2)?;
            let mode: String = r.get(3)?;
            let kind_opt: Option<String> = r.get(4)?;
            let remote_total: Option<i64> = r.get(10)?;
            let pcount = venue_counts_by_id.get(&id).copied().unwrap_or_else(|| {
                venue_counts_by_label
                    .get(&name.to_lowercase())
                    .copied()
                    .unwrap_or(0)
            });
            let resolved_kind = Some(infer_venue_kind(&id, &name, &url, kind_opt.as_deref()));
            Ok(CollectionVenueRecord {
                id,
                name,
                url,
                mode,
                kind: resolved_kind,
                domain: r.get(5)?,
                ccf_rank: r.get(6)?,
                dblp_stream: r.get(7)?,
                last_fetched_at: r.get(8)?,
                latest_published_at: r.get(9)?,
                remote_total_count: remote_total.map(|n| n.max(0) as usize),
                paper_count: pcount,
            })
        })?;
        for v in rows {
            venues.push(v?);
        }
    }

    // Count arXiv papers within enabled categories scope + per-category counts
    let mut arxiv_sql = String::from("SELECT COUNT(*) FROM papers p WHERE p.source_type = 'arxiv'");
    let mut arxiv_binds: Vec<rusqlite::types::Value> = Vec::new();
    append_enabled_scope_clause(&mut arxiv_sql, &mut arxiv_binds, "p", &categories);
    let arxiv_count_raw: i64 =
        conn.query_row(&arxiv_sql, params_from_iter(arxiv_binds), |r| r.get(0))?;
    let arxiv_count = arxiv_count_raw.max(0) as usize;

    let mut category_counts: HashMap<String, usize> = HashMap::new();
    for cat in &categories {
        let cnt_raw: i64 = conn.query_row(
            "SELECT COUNT(*) FROM papers p WHERE p.source_type = 'arxiv' \
             AND (p.source_label COLLATE NOCASE = ?1 \
                  OR EXISTS (SELECT 1 FROM paper_categories pc WHERE pc.paper_id = p.id AND pc.category = ?1))",
            [cat],
            |r| r.get(0),
        )?;
        category_counts.insert(cat.clone(), cnt_raw.max(0) as usize);
    }

    Ok(CollectionStateSummary {
        categories,
        venues,
        arxiv_watermarks,
        last_refreshed_at,
        latest_arxiv,
        total_count: arxiv_count + venue_count,
        arxiv_count,
        venue_count,
        conference_count,
        journal_count,
        category_counts,
    })
}

fn upsert_arxiv_watermarks_tx(
    conn: &Connection,
    watermarks: &HashMap<String, CollectionArxivWatermarkInput>,
) -> Result<(), AppError> {
    for (cat, wm) in watermarks {
        let cat_trim = cat.trim();
        if cat_trim.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT INTO arxiv_watermarks (
                category, latest_published_at, latest_arxiv_id, last_synced_at,
                oldest_synced_published_at, remote_total, history_complete
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(category) DO UPDATE SET
                latest_published_at = excluded.latest_published_at,
                latest_arxiv_id = excluded.latest_arxiv_id,
                last_synced_at = excluded.last_synced_at,
                oldest_synced_published_at = COALESCE(excluded.oldest_synced_published_at, arxiv_watermarks.oldest_synced_published_at),
                remote_total = COALESCE(excluded.remote_total, arxiv_watermarks.remote_total),
                history_complete = COALESCE(?8, arxiv_watermarks.history_complete)",
            params![
                cat_trim,
                wm.latest_published_at,
                wm.latest_arxiv_id,
                wm.last_synced_at,
                wm.oldest_synced_published_at,
                wm.remote_total.map(|n| n as i64),
                i64::from(wm.history_complete.unwrap_or(false)),
                wm.history_complete.map(i64::from),
            ],
        )?;
    }
    Ok(())
}

fn apply_venue_watermark_update_tx(
    conn: &Connection,
    upd: &CollectionVenueWatermarkUpdate,
) -> Result<(), AppError> {
    conn.execute(
        "UPDATE venues SET
            last_fetched_at = COALESCE(?2, last_fetched_at),
            latest_published_at = COALESCE(?3, latest_published_at),
            remote_total_count = COALESCE(?4, remote_total_count)
         WHERE id = ?1",
        params![
            upd.venue_id.trim(),
            clean_opt_str(upd.last_fetched_at.clone()),
            clean_opt_str(upd.latest_published_at.clone()),
            upd.remote_total_count.map(|n| n as i64),
        ],
    )?;
    Ok(())
}

fn apply_latest_arxiv_tx(
    conn: &Connection,
    latest: &CollectionArxivLatest,
) -> Result<(), AppError> {
    let serialized = serde_json::to_string(latest)?;
    conn.execute(
        "UPDATE collection_config SET latest_arxiv_json = ?1 WHERE id = 1",
        [serialized],
    )?;
    Ok(())
}

fn sync_venues_list_tx(conn: &Connection, venues: &[CollectionVenueInput]) -> Result<(), AppError> {
    let mut kept_ids: Vec<String> = Vec::with_capacity(venues.len());
    for (idx, v) in venues.iter().enumerate() {
        let id = v.id.trim().to_string();
        if id.is_empty() {
            continue;
        }
        let name = v.name.trim().to_string();
        let url = v.url.trim().to_string();
        let mode = match v.mode.as_deref().map(str::trim) {
            Some("agent") => "agent",
            _ => "auto",
        };
        let kind = infer_venue_kind(&id, &name, &url, v.kind.as_deref());
        conn.execute(
            "INSERT INTO venues (
                id, position, name, url, mode, kind, domain, ccf_rank, dblp_stream,
                last_fetched_at, latest_published_at, remote_total_count
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                position = excluded.position,
                name = excluded.name,
                url = excluded.url,
                mode = excluded.mode,
                kind = excluded.kind,
                domain = COALESCE(excluded.domain, venues.domain),
                ccf_rank = COALESCE(excluded.ccf_rank, venues.ccf_rank),
                dblp_stream = COALESCE(excluded.dblp_stream, venues.dblp_stream),
                last_fetched_at = COALESCE(excluded.last_fetched_at, venues.last_fetched_at),
                latest_published_at = COALESCE(excluded.latest_published_at, venues.latest_published_at),
                remote_total_count = COALESCE(excluded.remote_total_count, venues.remote_total_count)",
            params![
                id,
                idx as i64,
                name,
                url,
                mode,
                kind,
                clean_opt_str(v.domain.clone()),
                clean_opt_str(v.ccf_rank.clone()),
                clean_opt_str(v.dblp_stream.clone()),
                clean_opt_str(v.last_fetched_at.clone()),
                clean_opt_str(v.latest_published_at.clone()),
                v.remote_total_count.map(|n| n as i64),
            ],
        )?;
        kept_ids.push(id);
    }

    if kept_ids.is_empty() {
        conn.execute("DELETE FROM venues", [])?;
    } else {
        let placeholders: String = std::iter::repeat_n("?", kept_ids.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("DELETE FROM venues WHERE id NOT IN ({placeholders})");
        let binds: Vec<rusqlite::types::Value> = kept_ids.iter().cloned().map(Into::into).collect();
        conn.execute(&sql, params_from_iter(binds))?;
    }
    Ok(())
}

pub fn config_update(args: CollectionConfigUpdateArgs) -> Result<CollectionStateSummary, AppError> {
    let mut conn = ensure_collection()?;
    config_update_conn(&mut conn, args)
}

pub fn config_update_at(
    db_path: &Path,
    args: CollectionConfigUpdateArgs,
) -> Result<CollectionStateSummary, AppError> {
    let mut conn = ensure_collection_at(db_path)?;
    config_update_conn(&mut conn, args)
}

pub(crate) fn config_update_conn(
    conn: &mut Connection,
    args: CollectionConfigUpdateArgs,
) -> Result<CollectionStateSummary, AppError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(cats) = args.categories {
        let cleaned = clean_string_vec(&cats);
        let serialized = serde_json::to_string(&cleaned)?;
        tx.execute(
            "UPDATE collection_config SET categories_json = ?1 WHERE id = 1",
            [serialized],
        )?;
    }
    if let Some(ref venues) = args.venues {
        sync_venues_list_tx(&tx, venues)?;
    }
    if let Some(ref wms) = args.arxiv_watermarks {
        upsert_arxiv_watermarks_tx(&tx, wms)?;
    }
    if let Some(ts) = args.last_refreshed_at {
        let val = clean_opt_str(Some(ts));
        tx.execute(
            "UPDATE collection_config SET last_refreshed_at = ?1 WHERE id = 1",
            [val],
        )?;
    }
    if let Some(ref latest) = args.latest_arxiv {
        apply_latest_arxiv_tx(&tx, latest)?;
    }
    tx.commit()?;
    read_state_summary_conn(conn)
}

// ─── Paper Relations & Metadata-Preserving Upsert ───

fn sync_paper_relations(
    conn: &Connection,
    paper_id: &str,
    source_type: &str,
    source_label: &str,
    categories: &[String],
    keywords: &[String],
) -> Result<(), AppError> {
    conn.execute(
        "DELETE FROM paper_categories WHERE paper_id = ?1",
        [paper_id],
    )?;
    let mut cat_seen = HashSet::new();
    if source_type == "arxiv" && !source_label.trim().is_empty() {
        let sl = source_label.trim();
        if cat_seen.insert(sl.to_lowercase()) {
            conn.execute(
                "INSERT OR IGNORE INTO paper_categories (paper_id, category) VALUES (?1, ?2)",
                params![paper_id, sl],
            )?;
        }
    }
    for cat in categories {
        let c = cat.trim();
        if !c.is_empty() && cat_seen.insert(c.to_lowercase()) {
            conn.execute(
                "INSERT OR IGNORE INTO paper_categories (paper_id, category) VALUES (?1, ?2)",
                params![paper_id, c],
            )?;
        }
    }

    conn.execute("DELETE FROM paper_keywords WHERE paper_id = ?1", [paper_id])?;
    let mut kw_seen = HashSet::new();
    for kw in keywords {
        let display = kw.split_whitespace().collect::<Vec<_>>().join(" ");
        if display.chars().count() < 2 {
            continue;
        }
        let norm = display.to_lowercase();
        if kw_seen.insert(norm.clone()) {
            conn.execute(
                "INSERT OR IGNORE INTO paper_keywords (paper_id, normalized, display) VALUES (?1, ?2, ?3)",
                params![paper_id, norm, display],
            )?;
        }
    }
    Ok(())
}

struct ExistingPaperRow {
    row_id: i64,
    title: String,
    authors_json: String,
    abstract_text: String,
    published_at: String,
    year: i32,
    source_type: String,
    source_label: String,
    categories_json: String,
    url: String,
    pdf_url: Option<String>,
    arxiv_id: Option<String>,
    doi: Option<String>,
    venue_id: Option<String>,
    venue_kind: Option<String>,
    venue_domain: Option<String>,
    ccf_rank: Option<String>,
    venue_full: Option<String>,
    citation_count: u32,
    keywords_json: String,
    volume: Option<String>,
    issue: Option<String>,
    pages: Option<String>,
    bibtex: Option<String>,
    cool_papers_id: Option<String>,
    recommended_at: Option<String>,
}

fn load_existing_paper_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<ExistingPaperRow>, AppError> {
    let mut stmt = conn.prepare_cached(
        "SELECT row_id, title, authors_json, abstract_text, published_at, year, source_type, \
                source_label, categories_json, url, pdf_url, arxiv_id, doi, venue_id, venue_kind, \
                venue_domain, ccf_rank, venue_full, citation_count, keywords_json, volume, issue, \
                pages, bibtex, cool_papers_id, recommended_at \
         FROM papers WHERE id = ?1",
    )?;
    let row = stmt
        .query_row([id], |r| {
            let cites: i64 = r.get(18)?;
            Ok(ExistingPaperRow {
                row_id: r.get(0)?,
                title: r.get(1)?,
                authors_json: r.get(2)?,
                abstract_text: r.get(3)?,
                published_at: r.get(4)?,
                year: r.get(5)?,
                source_type: r.get(6)?,
                source_label: r.get(7)?,
                categories_json: r.get(8)?,
                url: r.get(9)?,
                pdf_url: r.get(10)?,
                arxiv_id: r.get(11)?,
                doi: r.get(12)?,
                venue_id: r.get(13)?,
                venue_kind: r.get(14)?,
                venue_domain: r.get(15)?,
                ccf_rank: r.get(16)?,
                venue_full: r.get(17)?,
                citation_count: cites.max(0) as u32,
                keywords_json: r.get(19)?,
                volume: r.get(20)?,
                issue: r.get(21)?,
                pages: r.get(22)?,
                bibtex: r.get(23)?,
                cool_papers_id: r.get(24)?,
                recommended_at: r.get(25)?,
            })
        })
        .optional()?;
    Ok(row)
}

fn upsert_single_paper_tx(
    conn: &Connection,
    input: &CollectionPaperUpsertInput,
    now: &str,
) -> Result<(), AppError> {
    let id = input.id.trim();
    if id.is_empty() {
        return Ok(());
    }

    let in_title = input.title.trim();
    let in_authors = clean_string_vec(&input.authors);
    let in_cats = clean_string_vec(&input.categories);
    let in_kws = clean_string_vec(&input.keywords);
    let in_pub = input.published_at.trim();
    let in_year = if input.year > 0 { input.year } else { 2026 };
    let in_source_type = input.source_type.trim();
    let in_source_label = input.source_label.trim();
    let in_url = input.url.trim();
    let in_cites = input.citation_count.unwrap_or(0);

    if let Some(ex) = load_existing_paper_by_id(conn, id)? {
        let ex_authors: Vec<String> = serde_json::from_str(&ex.authors_json).unwrap_or_default();
        let ex_cats: Vec<String> = serde_json::from_str(&ex.categories_json).unwrap_or_default();
        let ex_kws: Vec<String> = serde_json::from_str(&ex.keywords_json).unwrap_or_default();

        let title = if !in_title.is_empty() {
            in_title.to_string()
        } else {
            ex.title
        };
        let authors = if !in_authors.is_empty() {
            in_authors
        } else {
            ex_authors
        };
        let source_type = if !in_source_type.is_empty() {
            in_source_type.to_string()
        } else {
            ex.source_type
        };
        let source_label = if !in_source_label.is_empty() {
            in_source_label.to_string()
        } else {
            ex.source_label
        };
        let abstract_text =
            choose_better_abstract(&ex.abstract_text, &input.abstract_text, &source_label);
        let published_at = if !in_pub.is_empty() {
            in_pub.to_string()
        } else {
            ex.published_at
        };
        let published_ymd: String = published_at.chars().take(10).collect();
        let year = if input.year > 0 { input.year } else { ex.year };
        let categories = union_strings_case_insensitive(&ex_cats, &in_cats);
        let keywords = union_strings_case_insensitive(&ex_kws, &in_kws);
        let url = if !in_url.is_empty() {
            in_url.to_string()
        } else {
            ex.url
        };

        let pdf_url = clean_opt_str(input.pdf_url.clone()).or(ex.pdf_url);
        let arxiv_id = clean_opt_str(input.arxiv_id.clone()).or(ex.arxiv_id);
        let arxiv_id_norm = arxiv_id.as_deref().and_then(clean_arxiv_key);
        let doi = clean_opt_str(input.doi.clone()).or(ex.doi);
        let doi_norm = doi.as_deref().and_then(clean_doi_key);
        let title_norm = norm_title_key(&title);
        let venue_id = clean_opt_str(input.venue_id.clone()).or(ex.venue_id);
        let venue_kind = clean_opt_str(input.venue_kind.clone()).or(ex.venue_kind);
        let venue_domain = clean_opt_str(input.venue_domain.clone()).or(ex.venue_domain);
        let ccf_rank = clean_opt_str(input.ccf_rank.clone()).or(ex.ccf_rank);
        let venue_full = clean_opt_str(input.venue_full.clone()).or(ex.venue_full);
        let citation_count = ex.citation_count.max(in_cites);
        let volume = clean_opt_str(input.volume.clone()).or(ex.volume);
        let issue = clean_opt_str(input.issue.clone()).or(ex.issue);
        let pages = clean_opt_str(input.pages.clone()).or(ex.pages);
        let bibtex = clean_opt_str(input.bibtex.clone()).or(ex.bibtex);
        let cool_papers_id = clean_opt_str(input.cool_papers_id.clone()).or(ex.cool_papers_id);
        // Never overwrite non-null recommended_at with null.
        let recommended_at = clean_opt_str(input.recommended_at.clone()).or(ex.recommended_at);

        let authors_json = serde_json::to_string(&authors)?;
        let categories_json = serde_json::to_string(&categories)?;
        let keywords_json = serde_json::to_string(&keywords)?;
        let keywords_text = build_keywords_text(&keywords, &categories, &source_label);

        let mut stmt = conn.prepare_cached(
            "UPDATE papers SET
                title = ?1, authors_json = ?2, abstract_text = ?3, published_at = ?4,
                published_ymd = ?5, year = ?6, source_type = ?7, source_label = ?8,
                categories_json = ?9, url = ?10, pdf_url = ?11, arxiv_id = ?12,
                arxiv_id_norm = ?13, doi = ?14, doi_norm = ?15, title_norm = ?16,
                venue_id = ?17, venue_kind = ?18, venue_domain = ?19, ccf_rank = ?20,
                venue_full = ?21, citation_count = ?22, keywords_json = ?23, keywords_text = ?24,
                volume = ?25, issue = ?26, pages = ?27, bibtex = ?28, cool_papers_id = ?29,
                recommended_at = ?30, updated_at = ?31
             WHERE row_id = ?32",
        )?;
        stmt.execute(params![
            title,
            authors_json,
            abstract_text,
            published_at,
            published_ymd,
            year,
            source_type,
            source_label,
            categories_json,
            url,
            pdf_url,
            arxiv_id,
            arxiv_id_norm,
            doi,
            doi_norm,
            title_norm,
            venue_id,
            venue_kind,
            venue_domain,
            ccf_rank,
            venue_full,
            citation_count as i64,
            keywords_json,
            keywords_text,
            volume,
            issue,
            pages,
            bibtex,
            cool_papers_id,
            recommended_at,
            now,
            ex.row_id,
        ])?;

        sync_paper_relations(
            conn,
            id,
            &source_type,
            &source_label,
            &categories,
            &keywords,
        )?;
    } else {
        let published_ymd: String = in_pub.chars().take(10).collect();
        let arxiv_id = clean_opt_str(input.arxiv_id.clone());
        let arxiv_id_norm = arxiv_id.as_deref().and_then(clean_arxiv_key);
        let doi = clean_opt_str(input.doi.clone());
        let doi_norm = doi.as_deref().and_then(clean_doi_key);
        let title_norm = norm_title_key(in_title);
        let authors_json = serde_json::to_string(&in_authors)?;
        let categories_json = serde_json::to_string(&in_cats)?;
        let keywords_json = serde_json::to_string(&in_kws)?;
        let keywords_text = build_keywords_text(&in_kws, &in_cats, in_source_label);

        let mut stmt = conn.prepare_cached(
            "INSERT INTO papers (
                id, title, authors_json, abstract_text, published_at, published_ymd, year,
                source_type, source_label, categories_json, url, pdf_url, arxiv_id, arxiv_id_norm,
                doi, doi_norm, title_norm, venue_id, venue_kind, venue_domain, ccf_rank,
                venue_full, citation_count, keywords_json, keywords_text, volume, issue, pages,
                bibtex, cool_papers_id, recommended_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7,
                ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19, ?20, ?21,
                ?22, ?23, ?24, ?25, ?26, ?27, ?28,
                ?29, ?30, ?31, ?32
             )",
        )?;
        stmt.execute(params![
            id,
            in_title,
            authors_json,
            input.abstract_text.trim(),
            in_pub,
            published_ymd,
            in_year,
            in_source_type,
            in_source_label,
            categories_json,
            in_url,
            clean_opt_str(input.pdf_url.clone()),
            arxiv_id,
            arxiv_id_norm,
            doi,
            doi_norm,
            title_norm,
            clean_opt_str(input.venue_id.clone()),
            clean_opt_str(input.venue_kind.clone()),
            clean_opt_str(input.venue_domain.clone()),
            clean_opt_str(input.ccf_rank.clone()),
            clean_opt_str(input.venue_full.clone()),
            in_cites as i64,
            keywords_json,
            keywords_text,
            clean_opt_str(input.volume.clone()),
            clean_opt_str(input.issue.clone()),
            clean_opt_str(input.pages.clone()),
            clean_opt_str(input.bibtex.clone()),
            clean_opt_str(input.cool_papers_id.clone()),
            clean_opt_str(input.recommended_at.clone()),
            now,
        ])?;

        sync_paper_relations(conn, id, in_source_type, in_source_label, &in_cats, &in_kws)?;
    }

    Ok(())
}

pub fn upsert_papers(args: CollectionUpsertPapersArgs) -> Result<CollectionStateSummary, AppError> {
    let mut conn = ensure_collection()?;
    upsert_papers_conn(&mut conn, args)
}

pub fn upsert_papers_at(
    db_path: &Path,
    args: CollectionUpsertPapersArgs,
) -> Result<CollectionStateSummary, AppError> {
    let mut conn = ensure_collection_at(db_path)?;
    upsert_papers_conn(&mut conn, args)
}

pub(crate) fn upsert_papers_conn(
    conn: &mut Connection,
    mut args: CollectionUpsertPapersArgs,
) -> Result<CollectionStateSummary, AppError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = now_rfc3339();

    let replace_vid = clean_opt_str(args.replace_venue_id.take());
    let replace_slabel = clean_opt_str(args.replace_source_label.take());

    // Atomic Venue Replacement: preserve recommended_at across fresh venue sync
    if replace_vid.is_some() || replace_slabel.is_some() {
        let mut rec_by_id: HashMap<String, String> = HashMap::new();
        let mut rec_by_doi: HashMap<String, String> = HashMap::new();
        let mut rec_by_arxiv: HashMap<String, String> = HashMap::new();

        {
            let mut stmt = tx.prepare(
                "SELECT id, doi_norm, arxiv_id_norm, recommended_at
                 FROM papers
                 WHERE source_type = 'venue'
                   AND ((?1 IS NOT NULL AND venue_id = ?1)
                        OR (?2 IS NOT NULL AND venue_id IS NULL AND source_label = ?2))
                   AND recommended_at IS NOT NULL",
            )?;
            let rows = stmt.query_map(params![replace_vid, replace_slabel], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?;
            for entry in rows {
                let (pid, dnorm, anorm, rec_at) = entry?;
                rec_by_id.insert(pid, rec_at.clone());
                if let Some(d) = dnorm {
                    rec_by_doi.insert(d, rec_at.clone());
                }
                if let Some(a) = anorm {
                    rec_by_arxiv.insert(a, rec_at);
                }
            }
        }

        tx.execute(
            "DELETE FROM papers
             WHERE source_type = 'venue'
               AND ((?1 IS NOT NULL AND venue_id = ?1)
                    OR (?2 IS NOT NULL AND venue_id IS NULL AND source_label = ?2))",
            params![replace_vid, replace_slabel],
        )?;

        if !rec_by_id.is_empty() || !rec_by_doi.is_empty() || !rec_by_arxiv.is_empty() {
            for item in &mut args.items {
                if clean_opt_str(item.recommended_at.clone()).is_some() {
                    continue;
                }
                let matched = rec_by_id
                    .get(item.id.trim())
                    .cloned()
                    .or_else(|| {
                        item.doi
                            .as_deref()
                            .and_then(clean_doi_key)
                            .and_then(|d| rec_by_doi.get(&d).cloned())
                    })
                    .or_else(|| {
                        item.arxiv_id
                            .as_deref()
                            .and_then(clean_arxiv_key)
                            .and_then(|a| rec_by_arxiv.get(&a).cloned())
                    });
                if let Some(rec) = matched {
                    item.recommended_at = Some(rec);
                }
            }
        }
    }

    for item in &args.items {
        upsert_single_paper_tx(&tx, item, &now)?;
    }

    if let Some(ref vupd) = args.venue_update {
        apply_venue_watermark_update_tx(&tx, vupd)?;
    }
    if let Some(ref wms) = args.arxiv_watermarks {
        upsert_arxiv_watermarks_tx(&tx, wms)?;
    }
    if let Some(ts) = args.last_refreshed_at {
        if let Some(clean_ts) = clean_opt_str(Some(ts)) {
            tx.execute(
                "UPDATE collection_config SET last_refreshed_at = ?1 WHERE id = 1",
                [clean_ts],
            )?;
        }
    }
    if let Some(ref latest) = args.latest_arxiv {
        apply_latest_arxiv_tx(&tx, latest)?;
    }

    tx.commit()?;
    read_state_summary_conn(conn)
}

pub fn patch_papers(args: CollectionPatchPapersArgs) -> Result<CollectionStateSummary, AppError> {
    let mut conn = ensure_collection()?;
    patch_papers_conn(&mut conn, args)
}

pub fn patch_papers_at(
    db_path: &Path,
    args: CollectionPatchPapersArgs,
) -> Result<CollectionStateSummary, AppError> {
    let mut conn = ensure_collection_at(db_path)?;
    patch_papers_conn(&mut conn, args)
}

pub(crate) fn patch_papers_conn(
    conn: &mut Connection,
    args: CollectionPatchPapersArgs,
) -> Result<CollectionStateSummary, AppError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = now_rfc3339();

    for patch in &args.patches {
        let id = patch.id.trim();
        let Some(ex) = load_existing_paper_by_id(&tx, id)? else {
            continue;
        };

        let ex_authors: Vec<String> = serde_json::from_str(&ex.authors_json).unwrap_or_default();
        let ex_cats: Vec<String> = serde_json::from_str(&ex.categories_json).unwrap_or_default();
        let ex_kws: Vec<String> = serde_json::from_str(&ex.keywords_json).unwrap_or_default();

        let title = patch
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or(ex.title);
        let authors = match &patch.authors {
            Some(a) if !a.is_empty() => clean_string_vec(a),
            _ => ex_authors,
        };
        let abstract_text = match &patch.abstract_text {
            Some(abs) => choose_better_abstract(&ex.abstract_text, abs, &ex.source_label),
            None => ex.abstract_text,
        };
        let published_at = patch
            .published_at
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or(ex.published_at);
        let published_ymd: String = published_at.chars().take(10).collect();
        let year = patch.year.filter(|&y| y > 0).unwrap_or(ex.year);
        let categories = match &patch.categories {
            Some(c) => union_strings_case_insensitive(&ex_cats, c),
            None => ex_cats,
        };
        let keywords = match &patch.keywords {
            Some(k) => union_strings_case_insensitive(&ex_kws, k),
            None => ex_kws,
        };
        let url = patch
            .url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or(ex.url);
        let pdf_url = clean_opt_str(patch.pdf_url.clone()).or(ex.pdf_url);
        let arxiv_id = clean_opt_str(patch.arxiv_id.clone()).or(ex.arxiv_id);
        let arxiv_id_norm = arxiv_id.as_deref().and_then(clean_arxiv_key);
        let doi = clean_opt_str(patch.doi.clone()).or(ex.doi);
        let doi_norm = doi.as_deref().and_then(clean_doi_key);
        let title_norm = norm_title_key(&title);
        let venue_id = clean_opt_str(patch.venue_id.clone()).or(ex.venue_id);
        let venue_kind = clean_opt_str(patch.venue_kind.clone()).or(ex.venue_kind);
        let venue_domain = clean_opt_str(patch.venue_domain.clone()).or(ex.venue_domain);
        let ccf_rank = clean_opt_str(patch.ccf_rank.clone()).or(ex.ccf_rank);
        let venue_full = clean_opt_str(patch.venue_full.clone()).or(ex.venue_full);
        let citation_count = match patch.citation_count {
            Some(c) => ex.citation_count.max(c),
            None => ex.citation_count,
        };
        let volume = clean_opt_str(patch.volume.clone()).or(ex.volume);
        let issue = clean_opt_str(patch.issue.clone()).or(ex.issue);
        let pages = clean_opt_str(patch.pages.clone()).or(ex.pages);
        let bibtex = clean_opt_str(patch.bibtex.clone()).or(ex.bibtex);
        let cool_papers_id = clean_opt_str(patch.cool_papers_id.clone()).or(ex.cool_papers_id);
        let recommended_at = clean_opt_str(patch.recommended_at.clone()).or(ex.recommended_at);

        let authors_json = serde_json::to_string(&authors)?;
        let categories_json = serde_json::to_string(&categories)?;
        let keywords_json = serde_json::to_string(&keywords)?;
        let keywords_text = build_keywords_text(&keywords, &categories, &ex.source_label);

        tx.execute(
            "UPDATE papers SET
                title = ?1, authors_json = ?2, abstract_text = ?3, published_at = ?4,
                published_ymd = ?5, year = ?6, categories_json = ?7, url = ?8,
                pdf_url = ?9, arxiv_id = ?10, arxiv_id_norm = ?11, doi = ?12, doi_norm = ?13,
                title_norm = ?14, venue_id = ?15, venue_kind = ?16, venue_domain = ?17,
                ccf_rank = ?18, venue_full = ?19, citation_count = ?20, keywords_json = ?21,
                keywords_text = ?22, volume = ?23, issue = ?24, pages = ?25, bibtex = ?26,
                cool_papers_id = ?27, recommended_at = ?28, updated_at = ?29
             WHERE row_id = ?30",
            params![
                title,
                authors_json,
                abstract_text,
                published_at,
                published_ymd,
                year,
                categories_json,
                url,
                pdf_url,
                arxiv_id,
                arxiv_id_norm,
                doi,
                doi_norm,
                title_norm,
                venue_id,
                venue_kind,
                venue_domain,
                ccf_rank,
                venue_full,
                citation_count as i64,
                keywords_json,
                keywords_text,
                volume,
                issue,
                pages,
                bibtex,
                cool_papers_id,
                recommended_at,
                now,
                ex.row_id,
            ],
        )?;

        sync_paper_relations(
            &tx,
            id,
            &ex.source_type,
            &ex.source_label,
            &categories,
            &keywords,
        )?;
    }

    tx.commit()?;
    read_state_summary_conn(conn)
}

// ─── Detail, Batch Lookup & Paginated Listing ───

pub fn paper_get(id: &str) -> Result<Option<CollectionPaperDetail>, AppError> {
    let conn = ensure_collection()?;
    paper_get_conn(&conn, id)
}

pub fn paper_get_at(db_path: &Path, id: &str) -> Result<Option<CollectionPaperDetail>, AppError> {
    let conn = ensure_collection_at(db_path)?;
    paper_get_conn(&conn, id)
}

pub(crate) fn paper_get_conn(
    conn: &Connection,
    id: &str,
) -> Result<Option<CollectionPaperDetail>, AppError> {
    let sql = format!("SELECT {PAPER_SUMMARY_SELECT_COLS}, p.bibtex FROM papers p WHERE p.id = ?1");
    let row = conn
        .query_row(&sql, [id.trim()], |r| {
            let summary = map_paper_summary_row(r)?;
            let raw_bib: Option<String> = r.get(25)?;
            Ok((summary, raw_bib))
        })
        .optional()?;

    Ok(row.map(|(s, raw_bib)| {
        let citation_text = format_paper_citation_text(&s);
        let bibtex = Some(format_paper_bibtex(&s, raw_bib.as_deref()));
        CollectionPaperDetail {
            id: s.id,
            title: s.title,
            authors: s.authors,
            abstract_text: s.abstract_text,
            published_at: s.published_at,
            year: s.year,
            source_type: s.source_type,
            source_label: s.source_label,
            categories: s.categories,
            url: s.url,
            pdf_url: s.pdf_url,
            arxiv_id: s.arxiv_id,
            doi: s.doi,
            venue_id: s.venue_id,
            venue_kind: s.venue_kind,
            venue_domain: s.venue_domain,
            ccf_rank: s.ccf_rank,
            venue_full: s.venue_full,
            citation_count: s.citation_count,
            keywords: s.keywords,
            volume: s.volume,
            issue: s.issue,
            pages: s.pages,
            cool_papers_id: s.cool_papers_id,
            recommended_at: s.recommended_at,
            bibtex,
            citation_text,
        }
    }))
}

pub fn papers_by_ids(ids: &[String]) -> Result<Vec<CollectionPaperSummary>, AppError> {
    let conn = ensure_collection()?;
    papers_by_ids_conn(&conn, ids)
}

pub fn papers_by_ids_at(
    db_path: &Path,
    ids: &[String],
) -> Result<Vec<CollectionPaperSummary>, AppError> {
    let conn = ensure_collection_at(db_path)?;
    papers_by_ids_conn(&conn, ids)
}

pub(crate) fn papers_by_ids_conn(
    conn: &Connection,
    ids: &[String],
) -> Result<Vec<CollectionPaperSummary>, AppError> {
    let cleaned: Vec<String> = ids
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if cleaned.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders: String = std::iter::repeat_n("?", cleaned.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql =
        format!("SELECT {PAPER_SUMMARY_SELECT_COLS} FROM papers p WHERE p.id IN ({placeholders})");
    let binds: Vec<rusqlite::types::Value> = cleaned.iter().cloned().map(Into::into).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(binds), map_paper_summary_row)?;
    let mut by_id: HashMap<String, CollectionPaperSummary> = HashMap::with_capacity(cleaned.len());
    for entry in rows {
        let p = entry?;
        by_id.insert(p.id.clone(), p);
    }

    let mut out = Vec::with_capacity(by_id.len());
    let mut seen = HashSet::new();
    for id in cleaned {
        if seen.insert(id.clone()) {
            if let Some(p) = by_id.remove(&id) {
                out.push(p);
            }
        }
    }
    Ok(out)
}

pub fn list_papers(args: &CollectionListPapersArgs) -> Result<CollectionPapersPage, AppError> {
    let conn = ensure_collection()?;
    list_papers_conn(&conn, args)
}

pub fn list_papers_at(
    db_path: &Path,
    args: &CollectionListPapersArgs,
) -> Result<CollectionPapersPage, AppError> {
    let conn = ensure_collection_at(db_path)?;
    list_papers_conn(&conn, args)
}

pub(crate) fn list_papers_conn(
    conn: &Connection,
    args: &CollectionListPapersArgs,
) -> Result<CollectionPapersPage, AppError> {
    let enabled_cats = load_enabled_categories(conn)?;
    let latest_iso = max_published_at_in_scope(conn, &enabled_cats)?;
    let (from_ymd, to_ymd) = resolve_date_bounds(
        args.time_preset.as_deref(),
        args.date_from.as_deref(),
        args.date_to.as_deref(),
        latest_iso.as_deref(),
    );

    let mut where_sql = String::from(" WHERE 1=1");
    let mut binds: Vec<rusqlite::types::Value> = Vec::new();
    append_enabled_scope_clause(&mut where_sql, &mut binds, "p", &enabled_cats);

    if let Some(st) = args.source_type.as_deref().map(str::trim) {
        if !st.is_empty() && !st.eq_ignore_ascii_case("all") {
            where_sql.push_str(" AND p.source_type COLLATE NOCASE = ?");
            binds.push(st.to_string().into());
        }
    }

    if let Some(cat) = args.category.as_deref().map(str::trim) {
        if !cat.is_empty() && !cat.eq_ignore_ascii_case("all") {
            where_sql.push_str(
                " AND (p.source_type != 'arxiv' OR p.source_label COLLATE NOCASE = ? \
                  OR EXISTS (SELECT 1 FROM paper_categories pc WHERE pc.paper_id = p.id AND pc.category = ?))",
            );
            binds.push(cat.to_string().into());
            binds.push(cat.to_string().into());
        }
    }

    if let Some(vk) = args.venue_kind.as_deref().map(str::trim) {
        if !vk.is_empty() && !vk.eq_ignore_ascii_case("all") {
            where_sql.push_str(" AND p.source_type = 'venue' AND p.venue_kind COLLATE NOCASE = ?");
            binds.push(vk.to_string().into());
        }
    }

    if let Some(vd) = args.venue_domain.as_deref().map(str::trim) {
        if !vd.is_empty() && !vd.eq_ignore_ascii_case("all") {
            where_sql
                .push_str(" AND p.source_type = 'venue' AND p.venue_domain COLLATE NOCASE = ?");
            binds.push(vd.to_string().into());
        }
    }

    if let Some(vid) = args.venue_id.as_deref().map(str::trim) {
        if !vid.is_empty() && !vid.eq_ignore_ascii_case("all") {
            where_sql.push_str(
                " AND p.source_type = 'venue' AND (p.venue_id COLLATE NOCASE = ? OR p.source_label COLLATE NOCASE = ?)",
            );
            binds.push(vid.to_string().into());
            binds.push(vid.to_string().into());
        }
    }

    if !args.ccf_ranks.is_empty() {
        append_ccf_ranks_clause(&mut where_sql, &mut binds, "p", &args.ccf_ranks);
    }

    if let Some(ref f) = from_ymd {
        where_sql.push_str(" AND (p.published_ymd = '' OR p.published_ymd >= ?)");
        binds.push(f.clone().into());
    }
    if let Some(ref t) = to_ymd {
        where_sql.push_str(" AND (p.published_ymd = '' OR p.published_ymd <= ?)");
        binds.push(t.clone().into());
    }

    let count_sql = format!("SELECT COUNT(*) FROM papers p{where_sql}");
    let total_raw: i64 =
        conn.query_row(&count_sql, params_from_iter(binds.clone()), |r| r.get(0))?;
    let total = total_raw.max(0) as usize;

    let limit = args.limit.unwrap_or(100).clamp(1, 1000);
    let offset = args.offset.unwrap_or(0);
    let order_by = match args.sort.as_deref().map(str::trim) {
        Some(s) if s.eq_ignore_ascii_case("citations") => {
            " ORDER BY p.citation_count DESC, p.published_at DESC, p.id ASC"
        }
        _ => " ORDER BY p.published_at DESC, p.citation_count DESC, p.id ASC",
    };

    let page_sql = format!(
        "SELECT {PAPER_SUMMARY_SELECT_COLS} FROM papers p{where_sql}{order_by} LIMIT ? OFFSET ?"
    );
    binds.push((limit as i64).into());
    binds.push((offset as i64).into());

    let mut stmt = conn.prepare(&page_sql)?;
    let items = stmt
        .query_map(params_from_iter(binds), map_paper_summary_row)?
        .collect::<Result<Vec<_>, _>>()?;

    let has_more = offset.saturating_add(items.len()) < total;
    Ok(CollectionPapersPage {
        items,
        total,
        has_more,
    })
}

pub(crate) fn append_ccf_ranks_clause(
    sql: &mut String,
    binds: &mut Vec<rusqlite::types::Value>,
    alias: &str,
    ccf_ranks: &[String],
) {
    let mut sub_clauses: Vec<String> = Vec::new();
    for r in ccf_ranks {
        let norm = r.trim().to_uppercase();
        if norm.is_empty() {
            continue;
        }
        if norm == "ARXIV" || norm == "PREPRINT" {
            sub_clauses.push(format!("{alias}.source_type = 'arxiv'"));
        } else {
            sub_clauses.push(format!("{alias}.ccf_rank COLLATE NOCASE = ?"));
            binds.push(norm.into());
        }
    }
    if !sub_clauses.is_empty() {
        sql.push_str(" AND (");
        sql.push_str(&sub_clauses.join(" OR "));
        sql.push(')');
    }
}

// ─── Atomic Reset / Clear ───

pub fn clear_collection(args: &CollectionClearArgs) -> Result<CollectionStateSummary, AppError> {
    let mut conn = ensure_collection()?;
    clear_collection_conn(&mut conn, args)
}

pub fn clear_collection_at(
    db_path: &Path,
    args: &CollectionClearArgs,
) -> Result<CollectionStateSummary, AppError> {
    let mut conn = ensure_collection_at(db_path)?;
    clear_collection_conn(&mut conn, args)
}

pub(crate) fn clear_collection_conn(
    conn: &mut Connection,
    args: &CollectionClearArgs,
) -> Result<CollectionStateSummary, AppError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    match args.scope.trim().to_ascii_lowercase().as_str() {
        "all" => {
            tx.execute_batch(
                "DELETE FROM papers;
                 DELETE FROM arxiv_watermarks;
                 DELETE FROM citation_edges;
                 UPDATE venues SET last_fetched_at = NULL, latest_published_at = NULL, remote_total_count = NULL;
                 UPDATE collection_config SET last_refreshed_at = NULL, latest_arxiv_json = NULL, last_recommended_at = NULL WHERE id = 1;",
            )?;
        }
        "papers" => {
            tx.execute_batch(
                "DELETE FROM papers;
                 DELETE FROM arxiv_watermarks;
                 UPDATE venues SET last_fetched_at = NULL, latest_published_at = NULL, remote_total_count = NULL;
                 UPDATE collection_config SET last_refreshed_at = NULL, latest_arxiv_json = NULL, last_recommended_at = NULL WHERE id = 1;",
            )?;
        }
        "venue" => {
            if let Some(vid) = args
                .venue_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                tx.execute(
                    "DELETE FROM papers WHERE source_type = 'venue' AND (venue_id = ?1 OR (venue_id IS NULL AND source_label = ?1))",
                    [vid],
                )?;
                tx.execute(
                    "UPDATE venues SET last_fetched_at = NULL, latest_published_at = NULL, remote_total_count = NULL WHERE id = ?1",
                    [vid],
                )?;
            }
        }
        "recommended" => {
            tx.execute_batch(
                "UPDATE papers SET recommended_at = NULL WHERE recommended_at IS NOT NULL;
                 UPDATE collection_config SET last_recommended_at = NULL WHERE id = 1;",
            )?;
        }
        "citations" => {
            tx.execute("DELETE FROM citation_edges", [])?;
        }
        other => {
            return Err(AppError::message(format!(
                "unsupported collection clear scope: {other}"
            )));
        }
    }
    tx.commit()?;
    read_state_summary_conn(conn)
}
