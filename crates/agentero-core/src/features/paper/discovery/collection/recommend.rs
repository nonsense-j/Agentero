//! Keyword recommendation state, SQLite word-cloud aggregation (`casing_quality`),
//! and batch recommendation scoring + atomic `recommended_at` stamping.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, params_from_iter, Connection, TransactionBehavior};

use crate::error::AppError;

use super::keywords::{
    canonicalize_keyword, canonicalize_query_term, normalize_keyword_key, union_canonical_keywords,
};
use super::models::{
    CollectionWordCloudArgs, RecommendKeywordChipDto, RecommendKeywordChipInput, RecommendNextArgs,
    RecommendNextOut, RecommendPoolStateDto, RecommendPoolStateInput, RecommendedPaperDto,
    WordCloudKeywordDto, WordCloudOut,
};
use super::schema::{
    ensure_collection, ensure_collection_at, DEFAULT_WORD_CLOUD_TOP_N, MAX_WORD_CLOUD_TOP_N,
    MIN_WORD_CLOUD_TOP_N,
};
use super::search::enrich_venue_summaries_from_arxiv_conn;
use super::store::{
    append_enabled_scope_clause, choose_better_abstract, clean_opt_str, is_publisher_doi,
    load_enabled_categories, load_summaries_by_row_ids, now_rfc3339, same_collection_work,
    union_strings_case_insensitive,
};

pub const DEFAULT_RECOMMEND_BATCH_SIZE: usize = 15;
const MAX_TIDY_RECENT_KEYWORDS: usize = 24;

const MINOR_TITLE_WORDS: &[&str] = &[
    "a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to",
    "via", "with",
];

fn clamp_word_cloud_top_n(n: usize) -> usize {
    n.clamp(MIN_WORD_CLOUD_TOP_N, MAX_WORD_CLOUD_TOP_N)
}

fn build_keyword_chip_id(term: &str, existing_ids: &HashSet<String>) -> String {
    let norm = normalize_keyword_key(term);
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in norm.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.len() > 32 {
        slug.truncate(32);
        while slug.ends_with('-') {
            slug.pop();
        }
    }
    if slug.is_empty() {
        slug = "term".to_string();
    }

    let base = format!("kw-custom-{slug}");
    if !existing_ids.contains(&base) {
        return base;
    }
    let mut seq = 2usize;
    loop {
        let candidate = format!("{base}-{seq}");
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
        seq += 1;
    }
}

/// Score display casing quality of a keyword surface form (mirrors `recommend-pool.ts`).
pub(crate) fn casing_quality(form: &str) -> i32 {
    let has_upper = form.chars().any(|c| c.is_ascii_uppercase());
    let has_lower = form.chars().any(|c| c.is_ascii_lowercase());
    if !has_upper {
        return 1;
    }
    if !has_lower {
        return if form.chars().count() <= 6 && !form.chars().any(char::is_whitespace) {
            4
        } else {
            2
        };
    }

    let words: Vec<&str> = form
        .split(|c: char| c.is_whitespace() || c == '/' || c == '-')
        .filter(|w| !w.is_empty())
        .collect();
    let mut content_words = 0usize;
    let mut capitalized_content_words = 0usize;
    for (i, w) in words.iter().enumerate() {
        let lower = w.to_ascii_lowercase();
        if i > 0 && MINOR_TITLE_WORDS.contains(&lower.as_str()) {
            continue;
        }
        if !w.chars().any(|c| c.is_ascii_alphabetic()) {
            continue;
        }
        content_words += 1;
        let has_mixed = w
            .as_bytes()
            .windows(2)
            .any(|pair| pair[0].is_ascii_lowercase() && pair[1].is_ascii_uppercase());
        if w.starts_with(|c: char| c.is_ascii_uppercase()) || has_mixed {
            capitalized_content_words += 1;
        }
    }

    let all_content_capitalized = content_words > 0 && capitalized_content_words == content_words;
    let has_upper_word = form
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|tok| tok.len() >= 2 && tok.bytes().all(|b| b.is_ascii_uppercase()));
    let has_camel = form
        .as_bytes()
        .windows(2)
        .any(|pair| pair[0].is_ascii_lowercase() && pair[1].is_ascii_uppercase());
    let has_acronym = has_upper_word || has_camel;

    if all_content_capitalized && has_acronym {
        6
    } else if all_content_capitalized {
        5
    } else if has_acronym {
        4
    } else {
        3
    }
}

fn pick_best_display_casing(variants: &HashMap<String, usize>, fallback: &str) -> String {
    let mut best_form = fallback.to_string();
    let mut best_quality = -1i32;
    let mut best_freq = 0usize;
    let mut has_any = false;

    for (form, &freq) in variants {
        let quality = casing_quality(form);
        let better = if !has_any {
            true
        } else if quality != best_quality {
            quality > best_quality
        } else if freq != best_freq {
            freq > best_freq
        } else {
            form.as_str() < best_form.as_str()
        };
        if better {
            has_any = true;
            best_form = form.clone();
            best_quality = quality;
            best_freq = freq;
        }
    }

    best_form
}

fn sanitize_keyword_chips(inputs: &[RecommendKeywordChipInput]) -> Vec<RecommendKeywordChipDto> {
    let mut result: Vec<RecommendKeywordChipDto> = Vec::new();
    let mut seen_terms: HashMap<String, usize> = HashMap::new();
    let mut used_ids: HashSet<String> = HashSet::new();

    for raw in inputs {
        let Some(term) = canonicalize_query_term(&raw.term) else {
            continue;
        };
        let key = normalize_keyword_key(&term);
        if key.is_empty() {
            continue;
        }
        if let Some(&idx) = seen_terms.get(&key) {
            if casing_quality(&term) > casing_quality(&result[idx].term) {
                result[idx].term = term;
            }
            if raw.enabled && !result[idx].enabled {
                result[idx].enabled = true;
            }
            continue;
        }

        let raw_id = raw
            .id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("");
        let id = if !raw_id.is_empty() && !used_ids.contains(raw_id) {
            raw_id.to_string()
        } else {
            build_keyword_chip_id(&term, &used_ids)
        };
        used_ids.insert(id.clone());
        seen_terms.insert(key, result.len());
        result.push(RecommendKeywordChipDto {
            id,
            term,
            enabled: raw.enabled,
        });
    }

    result
}

fn sanitize_selected_cloud_terms(
    raw_terms: &[String],
    keywords: &[RecommendKeywordChipDto],
) -> Vec<String> {
    let enabled_keys: HashSet<String> = keywords
        .iter()
        .filter(|k| k.enabled)
        .map(|k| normalize_keyword_key(&k.term))
        .collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for entry in raw_terms {
        let Some(cleaned) = canonicalize_query_term(entry) else {
            continue;
        };
        let key = normalize_keyword_key(&cleaned);
        if key.is_empty() || enabled_keys.contains(&key) || !seen.insert(key) {
            continue;
        }
        out.push(cleaned);
    }
    out
}

// ─── State Get & Set ───

pub fn recommend_state_get() -> Result<RecommendPoolStateDto, AppError> {
    let conn = ensure_collection()?;
    recommend_state_get_conn(&conn)
}

pub fn recommend_state_get_at(db_path: &Path) -> Result<RecommendPoolStateDto, AppError> {
    let conn = ensure_collection_at(db_path)?;
    recommend_state_get_conn(&conn)
}

pub(crate) fn recommend_state_get_conn(
    conn: &Connection,
) -> Result<RecommendPoolStateDto, AppError> {
    let (top_n_raw, cloud_json, last_recommended_at): (i64, String, Option<String>) = conn
        .query_row(
            "SELECT word_cloud_top_n, selected_cloud_terms_json, last_recommended_at \
             FROM collection_config WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap_or_else(|_| (DEFAULT_WORD_CLOUD_TOP_N as i64, "[]".to_string(), None));

    let mut keywords: Vec<RecommendKeywordChipDto> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, term, enabled FROM recommend_keywords ORDER BY position ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            let enabled_int: i64 = r.get(2)?;
            Ok(RecommendKeywordChipDto {
                id: r.get(0)?,
                term: r.get(1)?,
                enabled: enabled_int != 0,
            })
        })?;
        for chip in rows {
            keywords.push(chip?);
        }
    }

    let raw_cloud: Vec<String> = serde_json::from_str(&cloud_json).unwrap_or_default();
    let selected_cloud_terms = sanitize_selected_cloud_terms(&raw_cloud, &keywords);
    let word_cloud_top_n = clamp_word_cloud_top_n(top_n_raw.max(0) as usize);

    Ok(RecommendPoolStateDto {
        keywords,
        selected_cloud_terms,
        word_cloud_top_n,
        last_recommended_at: clean_opt_str(last_recommended_at),
    })
}

fn persist_recommend_state_tx(
    conn: &Connection,
    state: &RecommendPoolStateDto,
) -> Result<(), AppError> {
    conn.execute("DELETE FROM recommend_keywords", [])?;
    for (pos, chip) in state.keywords.iter().enumerate() {
        conn.execute(
            "INSERT INTO recommend_keywords (id, position, term, normalized, enabled) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                chip.id,
                pos as i64,
                chip.term,
                normalize_keyword_key(&chip.term),
                i64::from(chip.enabled),
            ],
        )?;
    }

    let cloud_json = serde_json::to_string(&state.selected_cloud_terms)?;
    conn.execute(
        "UPDATE collection_config SET \
            word_cloud_top_n = ?1, \
            selected_cloud_terms_json = ?2, \
            last_recommended_at = ?3 \
         WHERE id = 1",
        params![
            state.word_cloud_top_n as i64,
            cloud_json,
            state.last_recommended_at,
        ],
    )?;
    Ok(())
}

pub fn recommend_state_set(
    args: RecommendPoolStateInput,
) -> Result<RecommendPoolStateDto, AppError> {
    let mut conn = ensure_collection()?;
    recommend_state_set_conn(&mut conn, args)
}

pub fn recommend_state_set_at(
    db_path: &Path,
    args: RecommendPoolStateInput,
) -> Result<RecommendPoolStateDto, AppError> {
    let mut conn = ensure_collection_at(db_path)?;
    recommend_state_set_conn(&mut conn, args)
}

pub(crate) fn recommend_state_set_conn(
    conn: &mut Connection,
    args: RecommendPoolStateInput,
) -> Result<RecommendPoolStateDto, AppError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let prev = recommend_state_get_conn(&tx)?;

    let keywords = match args.keywords {
        Some(ref raw_chips) => sanitize_keyword_chips(raw_chips),
        None => prev.keywords,
    };

    let raw_cloud = args
        .selected_cloud_terms
        .unwrap_or(prev.selected_cloud_terms);
    let selected_cloud_terms = sanitize_selected_cloud_terms(&raw_cloud, &keywords);

    let word_cloud_top_n = args
        .word_cloud_top_n
        .map(clamp_word_cloud_top_n)
        .unwrap_or(prev.word_cloud_top_n);

    let last_recommended_at = match args.last_recommended_at {
        Some(ts) => clean_opt_str(Some(ts)),
        None => prev.last_recommended_at,
    };

    let next_state = RecommendPoolStateDto {
        keywords,
        selected_cloud_terms,
        word_cloud_top_n,
        last_recommended_at,
    };

    persist_recommend_state_tx(&tx, &next_state)?;
    tx.commit()?;
    Ok(next_state)
}

// ─── Word Cloud Aggregation ───

pub fn word_cloud(args: &CollectionWordCloudArgs) -> Result<WordCloudOut, AppError> {
    let conn = ensure_collection()?;
    word_cloud_conn(&conn, args)
}

pub fn word_cloud_at(
    db_path: &Path,
    args: &CollectionWordCloudArgs,
) -> Result<WordCloudOut, AppError> {
    let conn = ensure_collection_at(db_path)?;
    word_cloud_conn(&conn, args)
}

pub(crate) fn word_cloud_conn(
    conn: &Connection,
    args: &CollectionWordCloudArgs,
) -> Result<WordCloudOut, AppError> {
    let enabled_cats = load_enabled_categories(conn)?;
    let configured_top_n: i64 = conn
        .query_row(
            "SELECT word_cloud_top_n FROM collection_config WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or(DEFAULT_WORD_CLOUD_TOP_N as i64);

    let limit = args
        .top_n
        .unwrap_or_else(|| clamp_word_cloud_top_n(configured_top_n.max(0) as usize))
        .min(500);

    let mut count_sql = String::from(
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN p.recommended_at IS NULL THEN 1 ELSE 0 END), 0) \
         FROM papers p WHERE 1=1",
    );
    let mut count_binds: Vec<rusqlite::types::Value> = Vec::new();
    append_enabled_scope_clause(&mut count_sql, &mut count_binds, "p", &enabled_cats);
    let (total_cand_raw, unrec_raw): (i64, i64) =
        conn.query_row(&count_sql, params_from_iter(count_binds), |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;

    struct KwBucket {
        count: usize,
        unrecommended_count: usize,
        variants: HashMap<String, usize>,
    }

    let mut kw_sql = String::from(
        "SELECT pk.normalized, pk.display, COUNT(*), \
                COALESCE(SUM(CASE WHEN p.recommended_at IS NULL THEN 1 ELSE 0 END), 0) \
         FROM paper_keywords pk \
         JOIN papers p ON p.id = pk.paper_id \
         WHERE 1=1",
    );
    let mut kw_binds: Vec<rusqlite::types::Value> = Vec::new();
    append_enabled_scope_clause(&mut kw_sql, &mut kw_binds, "p", &enabled_cats);
    kw_sql.push_str(" GROUP BY pk.normalized, pk.display");

    let mut buckets: HashMap<String, KwBucket> = HashMap::new();
    {
        let mut stmt = conn.prepare(&kw_sql)?;
        let rows = stmt.query_map(params_from_iter(kw_binds), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?;
        for entry in rows {
            let (norm, display, cnt_raw, unrec_cnt_raw) = entry?;
            let cnt = cnt_raw.max(0) as usize;
            let unrec_cnt = unrec_cnt_raw.max(0) as usize;
            let canon_display = canonicalize_keyword(&display).unwrap_or(display);
            let bucket_key = {
                let k = normalize_keyword_key(&canon_display);
                if k.is_empty() {
                    norm
                } else {
                    k
                }
            };
            let bucket = buckets.entry(bucket_key).or_insert_with(|| KwBucket {
                count: 0,
                unrecommended_count: 0,
                variants: HashMap::new(),
            });
            bucket.count += cnt;
            bucket.unrecommended_count += unrec_cnt;
            *bucket.variants.entry(canon_display).or_insert(0) += cnt;
        }
    }

    let mut sorted: Vec<WordCloudKeywordDto> = buckets
        .into_iter()
        .map(|(normalized, bucket)| WordCloudKeywordDto {
            term: pick_best_display_casing(&bucket.variants, &normalized),
            normalized,
            count: bucket.count,
            unrecommended_count: bucket.unrecommended_count,
        })
        .collect();

    sorted.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| b.unrecommended_count.cmp(&a.unrecommended_count))
            .then_with(|| a.term.cmp(&b.term))
    });

    let total_unique_keywords = sorted.len();
    sorted.truncate(limit);

    Ok(WordCloudOut {
        keywords: sorted,
        total_unique_keywords,
        total_candidate_papers: total_cand_raw.max(0) as usize,
        unrecommended_paper_count: unrec_raw.max(0) as usize,
    })
}

// ─── Batch Recommendation Scoring & Stamping ───

fn merge_cloud_terms_into_recent_keywords(state: &RecommendPoolStateDto) -> RecommendPoolStateDto {
    if state.selected_cloud_terms.is_empty() {
        return state.clone();
    }

    let mut keywords = state.keywords.clone();
    for cloud_term in &state.selected_cloud_terms {
        let Some(cleaned) = canonicalize_query_term(cloud_term) else {
            continue;
        };
        let key = normalize_keyword_key(&cleaned);
        if key.is_empty() {
            continue;
        }
        if let Some(chip) = keywords
            .iter_mut()
            .find(|c| normalize_keyword_key(&c.term) == key)
        {
            if casing_quality(&cleaned) > casing_quality(&chip.term) {
                chip.term = cleaned;
            }
            chip.enabled = true;
        } else {
            let existing_ids: HashSet<String> = keywords.iter().map(|c| c.id.clone()).collect();
            let id = build_keyword_chip_id(&cleaned, &existing_ids);
            keywords.push(RecommendKeywordChipDto {
                id,
                term: cleaned,
                enabled: true,
            });
        }
    }

    if keywords.len() > MAX_TIDY_RECENT_KEYWORDS {
        let enabled_count = keywords.iter().filter(|k| k.enabled).count();
        let disabled_budget = MAX_TIDY_RECENT_KEYWORDS.saturating_sub(enabled_count);
        let disabled_ids: Vec<String> = keywords
            .iter()
            .filter(|k| !k.enabled)
            .map(|k| k.id.clone())
            .collect();
        let skip_disabled = disabled_ids.len().saturating_sub(disabled_budget);
        let kept_disabled: HashSet<String> = disabled_ids.into_iter().skip(skip_disabled).collect();
        keywords.retain(|k| k.enabled || kept_disabled.contains(&k.id));
    }

    RecommendPoolStateDto {
        keywords,
        selected_cloud_terms: Vec::new(),
        word_cloud_top_n: state.word_cloud_top_n,
        last_recommended_at: state.last_recommended_at.clone(),
    }
}

struct PreparedQueryKeyword {
    term: String,
    phrase: String,
    tokens: Vec<String>,
    min_threshold: f64,
}

fn prepare_query_keywords(chips: &[RecommendKeywordChipDto]) -> Vec<PreparedQueryKeyword> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for chip in chips {
        if !chip.enabled {
            continue;
        }
        let Some(term) = canonicalize_query_term(&chip.term) else {
            continue;
        };
        let phrase = normalize_keyword_key(&term);
        if phrase.is_empty() || !seen.insert(phrase.clone()) {
            continue;
        }
        let tokens: Vec<String> = phrase
            .split_whitespace()
            .filter(|t| t.chars().count() >= 2)
            .map(str::to_string)
            .collect();
        let min_threshold = if tokens.len() > 1 { 1.2 } else { 1.0 };
        out.push(PreparedQueryKeyword {
            term,
            phrase,
            tokens,
            min_threshold,
        });
    }

    out
}

struct ScorablePaperRow {
    row_id: i64,
    id: String,
    published_at: String,
    title_lower: String,
    abstract_lower: String,
    cat_lower: String,
    norm_kw_set: HashSet<String>,
    keywords_joined_lower: String,
    combined_lower: String,
}

fn score_paper_against_prepared(
    doc: &ScorablePaperRow,
    prepared: &[PreparedQueryKeyword],
) -> Option<(f64, Vec<String>)> {
    if prepared.is_empty() {
        return None;
    }

    let mut total_score = 0.0f64;
    let mut matched_keywords: Vec<String> = Vec::new();

    for kw in prepared {
        if kw.tokens.is_empty() {
            if !doc.combined_lower.contains(&kw.phrase) {
                continue;
            }
        } else if kw.tokens.len() == 1 {
            if !doc.combined_lower.contains(&kw.tokens[0]) {
                continue;
            }
        } else if !kw.tokens.iter().any(|tok| doc.combined_lower.contains(tok)) {
            continue;
        }

        let mut kw_score = 0.0f64;

        // 1. Paper-level keywords
        if doc.norm_kw_set.contains(&kw.phrase) {
            kw_score += 5.0;
        } else if doc.keywords_joined_lower.contains(&kw.phrase) {
            kw_score += 3.2;
        } else if kw.tokens.len() > 1
            && !doc.keywords_joined_lower.is_empty()
            && kw
                .tokens
                .iter()
                .all(|t| doc.keywords_joined_lower.contains(t))
        {
            kw_score += 2.2;
        } else if !doc.keywords_joined_lower.is_empty() {
            for tok in &kw.tokens {
                if doc.keywords_joined_lower.contains(tok) {
                    kw_score += 0.6;
                }
            }
        }

        // 2. Title match
        if doc.title_lower.contains(&kw.phrase) {
            kw_score += 4.0;
        } else if kw.tokens.len() > 1 && kw.tokens.iter().all(|t| doc.title_lower.contains(t)) {
            kw_score += 3.0;
        } else {
            for tok in &kw.tokens {
                if doc.title_lower.contains(tok) {
                    kw_score += 1.2;
                }
            }
        }

        // 3. Abstract match
        if doc.abstract_lower.contains(&kw.phrase) {
            kw_score += 1.8;
        } else if kw.tokens.len() > 1
            && !doc.abstract_lower.is_empty()
            && kw.tokens.iter().all(|t| doc.abstract_lower.contains(t))
        {
            kw_score += 1.2;
        } else if !doc.abstract_lower.is_empty() {
            for tok in &kw.tokens {
                if doc.abstract_lower.contains(tok) {
                    kw_score += 0.4;
                }
            }
        }

        // 4. Category / venue badge match
        if doc.cat_lower.contains(&kw.phrase) {
            kw_score += 1.0;
        }

        if kw_score >= kw.min_threshold {
            total_score += kw_score;
            matched_keywords.push(kw.term.clone());
        }
    }

    if matched_keywords.is_empty() {
        None
    } else {
        Some(((total_score * 100.0).round() / 100.0, matched_keywords))
    }
}

pub fn recommend_next(args: &RecommendNextArgs) -> Result<RecommendNextOut, AppError> {
    let mut conn = ensure_collection()?;
    recommend_next_conn(&mut conn, args)
}

pub fn recommend_next_at(
    db_path: &Path,
    args: &RecommendNextArgs,
) -> Result<RecommendNextOut, AppError> {
    let mut conn = ensure_collection_at(db_path)?;
    recommend_next_conn(&mut conn, args)
}

pub(crate) fn recommend_next_conn(
    conn: &mut Connection,
    args: &RecommendNextArgs,
) -> Result<RecommendNextOut, AppError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let initial_state = recommend_state_get_conn(&tx)?;
    let mut merged_state = merge_cloud_terms_into_recent_keywords(&initial_state);
    let prepared = prepare_query_keywords(&merged_state.keywords);
    let max_batch_size = args
        .max_batch_size
        .unwrap_or(DEFAULT_RECOMMEND_BATCH_SIZE)
        .clamp(1, 100);

    if prepared.is_empty() {
        persist_recommend_state_tx(&tx, &merged_state)?;
        tx.commit()?;
        return Ok(RecommendNextOut {
            items: Vec::new(),
            state: merged_state,
            exhausted: false,
            remaining_unrecommended: 0,
        });
    }

    let enabled_cats = load_enabled_categories(&tx)?;
    let mut sql = String::from(
        "SELECT p.row_id, p.id, p.source_type, p.ccf_rank, p.published_at, p.title, \
                p.authors_json, p.title_norm, p.arxiv_id_norm, p.doi_norm, p.abstract_text, \
                p.source_label, p.categories_json, p.keywords_json, p.recommended_at \
         FROM papers p WHERE 1=1",
    );
    let mut binds: Vec<rusqlite::types::Value> = Vec::new();
    append_enabled_scope_clause(&mut sql, &mut binds, "p", &enabled_cats);

    struct RawRecRow {
        row_id: i64,
        id: String,
        source_type: String,
        ccf_rank: Option<String>,
        published_at: String,
        title: String,
        authors: Vec<String>,
        title_norm: String,
        arxiv_id_norm: Option<String>,
        doi_norm: Option<String>,
        abstract_text: String,
        source_label: String,
        categories: Vec<String>,
        keywords: Vec<String>,
        recommended: bool,
        sibling_row_ids: Vec<i64>,
    }

    fn ccf_priority(rank: Option<&str>) -> u8 {
        match rank.map(str::trim) {
            Some(r) if r.eq_ignore_ascii_case("CCF-A") => 0,
            Some(r) if r.eq_ignore_ascii_case("CCF-B") => 1,
            Some(r) if !r.is_empty() => 2,
            _ => 3,
        }
    }

    let mut venue_rows: Vec<RawRecRow> = Vec::new();
    let mut arxiv_rows: Vec<RawRecRow> = Vec::new();
    {
        let mut stmt = tx.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds), |r| {
            let authors_json: String = r.get(6)?;
            let cats_json: String = r.get(12)?;
            let kws_json: String = r.get(13)?;
            let rec_at: Option<String> = r.get(14)?;
            Ok(RawRecRow {
                row_id: r.get(0)?,
                id: r.get(1)?,
                source_type: r.get(2)?,
                ccf_rank: r.get(3)?,
                published_at: r.get(4)?,
                title: r.get(5)?,
                authors: serde_json::from_str(&authors_json).unwrap_or_default(),
                title_norm: r.get(7)?,
                arxiv_id_norm: r.get::<_, Option<String>>(8)?.filter(|s| !s.is_empty()),
                doi_norm: r.get::<_, Option<String>>(9)?.filter(|s| !s.is_empty()),
                abstract_text: r.get(10)?,
                source_label: r.get(11)?,
                categories: serde_json::from_str(&cats_json).unwrap_or_default(),
                keywords: serde_json::from_str(&kws_json).unwrap_or_default(),
                recommended: rec_at.is_some_and(|s| !s.trim().is_empty()),
                sibling_row_ids: Vec::new(),
            })
        })?;

        for entry in rows {
            let row = entry?;
            if row.source_type == "venue" {
                venue_rows.push(row);
            } else {
                arxiv_rows.push(row);
            }
        }
    }

    venue_rows.sort_by(|a, b| {
        ccf_priority(a.ccf_rank.as_deref())
            .cmp(&ccf_priority(b.ccf_rank.as_deref()))
            .then_with(|| b.published_at.cmp(&a.published_at))
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut venue_by_arxiv: HashMap<String, Vec<usize>> = HashMap::new();
    let mut venue_by_doi: HashMap<String, Vec<usize>> = HashMap::new();
    let mut venue_by_title: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, v) in venue_rows.iter().enumerate() {
        if let Some(ref a) = v.arxiv_id_norm {
            venue_by_arxiv.entry(a.clone()).or_default().push(idx);
        }
        if let Some(d) = v.doi_norm.as_deref().filter(|d| is_publisher_doi(d)) {
            venue_by_doi.entry(d.to_string()).or_default().push(idx);
        }
        if !v.title_norm.is_empty() {
            venue_by_title
                .entry(v.title_norm.clone())
                .or_default()
                .push(idx);
        }
    }

    let mut standalone_arxiv: Vec<RawRecRow> = Vec::new();
    for a in arxiv_rows {
        let mut cand_v: Vec<usize> = Vec::new();
        if let Some(ref aid) = a.arxiv_id_norm {
            if let Some(idxs) = venue_by_arxiv.get(aid) {
                cand_v.extend(idxs.iter().copied());
            }
        }
        if let Some(d) = a.doi_norm.as_deref().filter(|d| is_publisher_doi(d)) {
            if let Some(idxs) = venue_by_doi.get(d) {
                cand_v.extend(idxs.iter().copied());
            }
        }
        if !a.title_norm.is_empty() {
            if let Some(idxs) = venue_by_title.get(&a.title_norm) {
                cand_v.extend(idxs.iter().copied());
            }
        }
        cand_v.sort_unstable();
        cand_v.dedup();

        if let Some(v_idx) = cand_v.into_iter().find(|&vi| {
            let v = &venue_rows[vi];
            same_collection_work(
                &a.title,
                &a.authors,
                a.arxiv_id_norm.as_deref(),
                a.doi_norm.as_deref(),
                &v.title,
                &v.authors,
                v.arxiv_id_norm.as_deref(),
                v.doi_norm.as_deref(),
            )
        }) {
            let v = &mut venue_rows[v_idx];
            if a.recommended {
                v.recommended = true;
            }
            v.sibling_row_ids.push(a.row_id);
            v.abstract_text =
                choose_better_abstract(&v.abstract_text, &a.abstract_text, &v.source_label);
            v.keywords = union_canonical_keywords(&v.keywords, &a.keywords);
            v.categories = union_strings_case_insensitive(&v.categories, &a.categories);
        } else {
            standalone_arxiv.push(a);
        }
    }

    struct ScoredRecCandidate {
        row_id: i64,
        sibling_row_ids: Vec<i64>,
        id: String,
        published_at: String,
        score: f64,
        matched_keywords: Vec<String>,
    }

    let mut candidates: Vec<ScoredRecCandidate> = Vec::new();
    for row in venue_rows.into_iter().chain(standalone_arxiv) {
        if row.recommended {
            continue;
        }
        let mut norm_kws: Vec<String> = Vec::with_capacity(row.keywords.len());
        let mut norm_kw_set: HashSet<String> = HashSet::with_capacity(row.keywords.len());
        for kw in &row.keywords {
            let norm = normalize_keyword_key(kw);
            if norm.chars().count() >= 2 && norm_kw_set.insert(norm.clone()) {
                norm_kws.push(norm);
            }
        }
        let keywords_joined_lower = norm_kws.join(" ; ");
        let title_lower = row.title.to_lowercase();
        let abstract_lower = row.abstract_text.to_lowercase();
        let cat_lower = format!("{} {}", row.source_label, row.categories.join(" "))
            .trim()
            .to_lowercase();
        let combined_lower =
            format!("{title_lower}\n{keywords_joined_lower}\n{abstract_lower}\n{cat_lower}");

        let doc = ScorablePaperRow {
            row_id: row.row_id,
            id: row.id,
            published_at: row.published_at,
            title_lower,
            abstract_lower,
            cat_lower,
            norm_kw_set,
            keywords_joined_lower,
            combined_lower,
        };

        if let Some((score, matched_keywords)) = score_paper_against_prepared(&doc, &prepared) {
            candidates.push(ScoredRecCandidate {
                row_id: doc.row_id,
                sibling_row_ids: row.sibling_row_ids,
                id: doc.id,
                published_at: doc.published_at,
                score,
                matched_keywords,
            });
        }
    }

    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.published_at.cmp(&a.published_at))
            .then_with(|| a.id.cmp(&b.id))
    });

    if candidates.is_empty() {
        persist_recommend_state_tx(&tx, &merged_state)?;
        tx.commit()?;
        return Ok(RecommendNextOut {
            items: Vec::new(),
            state: merged_state,
            exhausted: true,
            remaining_unrecommended: 0,
        });
    }

    let total_matching = candidates.len();
    let selected: Vec<ScoredRecCandidate> = candidates.into_iter().take(max_batch_size).collect();
    let remaining_unrecommended = total_matching.saturating_sub(selected.len());

    let now = now_rfc3339();
    for cand in &selected {
        tx.execute(
            "UPDATE papers SET recommended_at = ?1, updated_at = ?1 WHERE row_id = ?2",
            params![now, cand.row_id],
        )?;
        for srid in &cand.sibling_row_ids {
            tx.execute(
                "UPDATE papers SET recommended_at = ?1, updated_at = ?1 WHERE row_id = ?2",
                params![now, srid],
            )?;
        }
    }

    merged_state.last_recommended_at = Some(now);
    persist_recommend_state_tx(&tx, &merged_state)?;

    let row_ids: Vec<i64> = selected.iter().map(|cand| cand.row_id).collect();
    let mut summaries = load_summaries_by_row_ids(&tx, &row_ids)?;
    enrich_venue_summaries_from_arxiv_conn(&tx, &mut summaries)?;
    tx.commit()?;

    let mut items = Vec::with_capacity(selected.len());
    for cand in selected {
        if let Some(paper) = summaries.remove(&cand.row_id) {
            items.push(RecommendedPaperDto {
                paper,
                matched_keywords: cand.matched_keywords,
                score: cand.score,
            });
        }
    }

    Ok(RecommendNextOut {
        items,
        state: merged_state,
        exhausted: false,
        remaining_unrecommended,
    })
}
