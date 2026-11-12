//! Small metadata helpers shared across the `paper` subtrees (`import`,
//! `discovery/collection`, `catalog`, `analyze/refs`, `scholar_api`): JSON field
//! scraping, whitespace folding, and cross-portal work identity (`title + first 2 authors`).

use serde_json::Value;

/// Trimmed, non-empty string field of a JSON object. `None` when the key is
/// missing, not a string, or blank.
pub(crate) fn str_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// [`str_field`] addressed by a JSON pointer instead of a top-level key.
pub(crate) fn str_field_at(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Collapse every whitespace run into a single space and trim both ends.
pub(crate) fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Canonical title comparison key: lowercase ASCII alphanumerics + CJK ideographs.
/// Matches `papers.title_norm` in `collection.sqlite`.
pub fn norm_title_key(raw: &str) -> String {
    raw.trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(c))
        .collect()
}

fn strip_parentheticals(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut depth = 0usize;
    for ch in raw.chars() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

fn fold_latin_to_ascii_or_space(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        for lower in ch.to_lowercase() {
            match lower {
                'a'..='z' | '0'..='9' => out.push(lower),
                '\u{4e00}'..='\u{9fff}' => out.push(lower),
                'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => out.push('a'),
                'æ' => out.push_str("ae"),
                'ç' | 'ć' | 'č' | 'ĉ' | 'ċ' => out.push('c'),
                'ď' | 'đ' | 'ð' => out.push('d'),
                'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => out.push('e'),
                'ğ' | 'ĝ' | 'ġ' | 'ģ' => out.push('g'),
                'ĥ' | 'ħ' => out.push('h'),
                'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => out.push('i'),
                'ĵ' => out.push('j'),
                'ķ' => out.push('k'),
                'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => out.push('l'),
                'ñ' | 'ń' | 'ņ' | 'ň' => out.push('n'),
                'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => out.push('o'),
                'œ' => out.push_str("oe"),
                'ŕ' | 'ŗ' | 'ř' => out.push('r'),
                'ß' => out.push_str("ss"),
                'ś' | 'ŝ' | 'ş' | 'š' | 'ș' => out.push('s'),
                'ť' | 'ţ' | 'ŧ' | 'ț' => out.push('t'),
                'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => {
                    out.push('u')
                }
                'ŵ' => out.push('w'),
                'ý' | 'ÿ' | 'ŷ' => out.push('y'),
                'ź' | 'ż' | 'ž' => out.push('z'),
                'þ' => out.push_str("th"),
                _ => out.push(' '),
            }
        }
    }
    out
}

fn is_author_suffix(tok: &str) -> bool {
    matches!(tok, "jr" | "sr" | "ii" | "iii" | "iv" | "v")
}

/// Normalized `(given_tokens_joined, surname_or_mononym)` for one author name.
/// Handles `"Last, First"`, generational suffixes (`Jr.`, `III`), DBLP numeric
/// disambiguators (`0001`), parenthetical affiliations, middle single-letter
/// initials (`"Alice B. Smith"` -> `("alice", "smith")`), and CJK names.
fn parse_normalized_author(raw: &str) -> Option<(String, String)> {
    let cleaned = strip_parentheticals(raw);
    let reordered = if cleaned.contains(',') {
        let mut parts: Vec<String> = Vec::new();
        for seg in cleaned.split(',') {
            let folded = fold_latin_to_ascii_or_space(seg);
            let toks: Vec<&str> = folded
                .split_whitespace()
                .filter(|t| !t.chars().all(|c| c.is_ascii_digit()) && !is_author_suffix(t))
                .collect();
            if !toks.is_empty() {
                parts.push(toks.join(" "));
            }
        }
        if parts.len() >= 2 {
            let surname = parts.remove(0);
            format!("{} {surname}", parts.join(" "))
        } else {
            parts.into_iter().next().unwrap_or_default()
        }
    } else {
        fold_latin_to_ascii_or_space(&cleaned)
    };

    let raw_tokens: Vec<&str> = reordered
        .split_whitespace()
        .filter(|t| !t.is_empty() && !t.chars().all(|c| c.is_ascii_digit()) && !is_author_suffix(t))
        .collect();
    if raw_tokens.is_empty() {
        return None;
    }
    if raw_tokens.len() == 1 {
        return Some((String::new(), raw_tokens[0].to_string()));
    }

    let mut filtered: Vec<&str> = Vec::with_capacity(raw_tokens.len());
    let last_idx = raw_tokens.len() - 1;
    for (idx, &tok) in raw_tokens.iter().enumerate() {
        let is_middle_initial =
            idx > 0 && idx < last_idx && tok.len() == 1 && tok.as_bytes()[0].is_ascii_lowercase();
        if !is_middle_initial {
            filtered.push(tok);
        }
    }
    let surname = filtered.pop().unwrap_or_default().to_string();
    let given = filtered.concat();
    Some((given, surname))
}

/// Canonical key for one author name (e.g. `"Alice B. Smith"` / `"Smith, Alice 0001"` -> `"alicesmith"`).
pub fn norm_author_key(raw: &str) -> String {
    match parse_normalized_author(raw) {
        Some((given, surname)) => format!("{given}{surname}"),
        None => String::new(),
    }
}

/// Canonical O(1) hash key identifying a paper work by normalized title + first 2 author names.
/// Returns `None` when either normalized title or normalized first-2-authors is empty.
pub fn paper_work_key(title: &str, authors: &[String]) -> Option<String> {
    let t = norm_title_key(title);
    if t.is_empty() {
        return None;
    }
    let first_two: Vec<String> = authors
        .iter()
        .map(|a| norm_author_key(a))
        .filter(|k| !k.is_empty())
        .take(2)
        .collect();
    if first_two.is_empty() {
        return None;
    }
    Some(format!("{t}::{}", first_two.join("|")))
}

fn author_pair_compatible(a: &(String, String), b: &(String, String)) -> bool {
    if a.1 != b.1 || a.1.is_empty() {
        return false;
    }
    if a.0 == b.0 {
        return true;
    }
    // Abbreviated initial compatibility on Western names: `"a"` <-> `"alice"`,
    // while keeping `"alice"` != `"aaron"`.
    if a.0.len() == 1 && b.0.starts_with(&a.0) {
        return true;
    }
    if b.0.len() == 1 && a.0.starts_with(&b.0) {
        return true;
    }
    false
}

/// True when two papers share the same normalized title and compatible first 2 authors
/// (supporting exact normalized match as well as abbreviated given-name initials like
/// `"A. Smith"` vs `"Alice Smith"`).
pub fn same_work_by_title_and_authors(
    title_a: &str,
    authors_a: &[String],
    title_b: &str,
    authors_b: &[String],
) -> bool {
    let ta = norm_title_key(title_a);
    if ta.is_empty() || ta != norm_title_key(title_b) {
        return false;
    }
    let pa: Vec<(String, String)> = authors_a
        .iter()
        .filter_map(|s| parse_normalized_author(s))
        .take(2)
        .collect();
    let pb: Vec<(String, String)> = authors_b
        .iter()
        .filter_map(|s| parse_normalized_author(s))
        .take(2)
        .collect();
    if pa.is_empty() || pa.len() != pb.len() {
        return false;
    }
    pa.iter()
        .zip(pb.iter())
        .all(|(x, y)| author_pair_compatible(x, y))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_author_variants_and_builds_work_key() {
        assert_eq!(norm_author_key("Alice B. Smith"), "alicesmith");
        assert_eq!(norm_author_key("Smith, Alice 0001"), "alicesmith");
        assert_eq!(norm_author_key("Alice Smith, Jr. (MIT)"), "alicesmith");
        assert_eq!(norm_author_key("Jürgen Müller"), "jurgenmuller");
        assert_eq!(norm_author_key("张三"), "张三");

        let k1 = paper_work_key(
            "Multi-Agent Vulnerability Repair: A Study",
            &[
                "Alice B. Smith".into(),
                "Bob Jones".into(),
                "Carol Lee".into(),
            ],
        );
        let k2 = paper_work_key(
            "Multi-Agent Vulnerability Repair - A Study.",
            &[
                "Smith, Alice".into(),
                "Jones, Bob 0002".into(),
                "Different Third".into(),
            ],
        );
        assert_eq!(
            k1.as_deref(),
            Some("multiagentvulnerabilityrepairastudy::alicesmith|bobjones")
        );
        assert_eq!(k1, k2);
    }

    #[test]
    fn matches_abbreviated_initials_without_conflating_distinct_given_names() {
        assert!(same_work_by_title_and_authors(
            "Directed Fuzzing for Smart Contracts",
            &["A. Smith".into(), "B. Jones".into(), "C. Lee".into()],
            "Directed Fuzzing for Smart Contracts.",
            &["Alice Smith".into(), "Bob Jones".into()],
        ));

        assert!(!same_work_by_title_and_authors(
            "Directed Fuzzing for Smart Contracts",
            &["Alice Smith".into(), "Bob Jones".into()],
            "Directed Fuzzing for Smart Contracts",
            &["Aaron Smith".into(), "Bob Jones".into()],
        ));

        assert!(!same_work_by_title_and_authors(
            "Directed Fuzzing for Smart Contracts",
            &["Alice Smith".into(), "Bob Jones".into()],
            "Directed Fuzzing for Smart Contracts",
            &["Alice Smith".into(), "Carol Lee".into()],
        ));

        assert!(!same_work_by_title_and_authors(
            "Untitled Stub",
            &[],
            "Untitled Stub",
            &[],
        ));
    }
}
