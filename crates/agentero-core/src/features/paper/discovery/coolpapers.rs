//! Cool Papers (papers.cool) note fetch: resolve a paper, pull its Kimi FAQ
//! analysis, and append it to the paper's `NOTES.md`.
//!
//! The site is server-rendered with no JSON API and no auth. Two endpoints matter:
//! - `GET /{branch}/search?query=…` → list page carrying `id` + title per hit
//! - `GET /{branch}/kimi?paper={id}` → the analysis, as an HTML/Markdown hybrid
//!
//! Venue rows imported from the plaza already store the Cool Papers id
//! (`38818@AAAI`) and `https://papers.cool/venue/…` as `source_url`. Note fetch
//! must use those first: search-result titles are truncated, so exact-title
//! lookup misses long venue papers.
//!
//! An unknown paper id answers `200` with an empty body, so "no content" is the
//! not-found signal.
//!
//! The desktop Host keeps the papers.cool page importer and the 广场 proxy;
//! both share [`ORIGIN`], [`USER_AGENT`], [`http_client`] and
//! [`decode_entities`] from here.

use crate::error::AppError;
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub const ORIGIN: &str = "https://papers.cool";
pub const USER_AGENT: &str = "dovero/0.6 (+https://github.com/nonsense-j/Dovero)";
/// Branches searched when resolving by title, in preference order.
const BRANCHES: [&str; 2] = ["arxiv", "venue"];
/// A cold paper triggers real LLM generation upstream, which can take a while.
const REQUEST_TIMEOUT_SECS: u64 = 180;

/// Serialize note fetches: `/kimi` spends someone else's model quota.
fn limiter() -> &'static Arc<Semaphore> {
    static LIMITER: OnceLock<Arc<Semaphore>> = OnceLock::new();
    LIMITER.get_or_init(|| Arc::new(Semaphore::new(1)))
}

async fn permit() -> OwnedSemaphorePermit {
    limiter()
        .clone()
        .acquire_owned()
        .await
        .expect("cool papers limiter should not be closed")
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoolPapersNotes {
    /// False when the paper could not be resolved on papers.cool at all.
    pub found: bool,
    /// False when the analysis was already present in NOTES.md (idempotent).
    pub appended: bool,
    pub branch: Option<String>,
    pub paper_id: Option<String>,
    /// Public page for the resolved paper.
    pub url: Option<String>,
    /// `"sourceUrl"`, `"catalogId"`, `"arxivId"`, or `"title"`.
    pub matched_by: Option<String>,
}

impl CoolPapersNotes {
    fn not_found() -> Self {
        Self {
            found: false,
            appended: false,
            branch: None,
            paper_id: None,
            url: None,
            matched_by: None,
        }
    }
}

pub fn http_client() -> Result<reqwest::Client, AppError> {
    crate::http::shared_client()
}

async fn get_text(url: &str) -> Result<String, AppError> {
    let res = http_client()?
        .get(url)
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|e| AppError::message(format!("cool papers request failed: {e}")))?;
    let status = res.status();
    if !status.is_success() {
        return Err(AppError::message(format!("cool papers http {status}")));
    }
    res.text()
        .await
        .map_err(|e| AppError::message(format!("cool papers body failed: {e}")))
}

/// Bare arXiv id without the `vN` suffix papers.cool does not use.
fn bare_arxiv_id(raw: &str) -> Option<String> {
    let id = crate::features::paper::import::strip_arxiv_version(raw);
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    Some(id.to_string())
}

/// Comparison key for titles: alphanumerics only, lowercased.
/// Punctuation, spacing and casing differ freely between catalog and site.
fn title_key(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Query string papers.cool expects: alphanumeric runs joined by spaces.
fn search_query(title: &str) -> String {
    title
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// `(id, title)` for every paper on a list page.
///
/// Rows look like `<a id="title-{id}" class="title-link…" …>{title}</a>`.
fn parse_search_hits(html: &str) -> Vec<(String, String)> {
    const ANCHOR: &str = "<a id=\"title-";
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find(ANCHOR) {
        rest = &rest[start + ANCHOR.len()..];
        let Some(quote) = rest.find('"') else { break };
        let id = rest[..quote].to_string();
        rest = &rest[quote..];
        let Some(gt) = rest.find('>') else { break };
        rest = &rest[gt + 1..];
        let Some(close) = rest.find("</a>") else {
            break;
        };
        let title = decode_entities(&strip_tags(&rest[..close]));
        rest = &rest[close + 4..];
        if !id.is_empty() && !title.trim().is_empty() {
            out.push((id, title.trim().to_string()));
        }
    }
    out
}

/// papers.cool venue ids look like `38818@AAAI` or `2024.acl-long.290@ACL`.
fn venue_catalog_id(raw: &str) -> Option<&str> {
    let id = raw.trim();
    if id.is_empty() || !id.contains('@') {
        return None;
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '_' | '-'))
    {
        return None;
    }
    Some(id)
}

/// `https://papers.cool/{arxiv|venue}/{id}` (query / fragment ignored).
fn parse_coolpapers_url(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim();
    let after = raw
        .strip_prefix("https://papers.cool/")
        .or_else(|| raw.strip_prefix("http://papers.cool/"))
        .or_else(|| raw.strip_prefix("https://www.papers.cool/"))
        .or_else(|| raw.strip_prefix("http://www.papers.cool/"))?;
    let path = after.split(['?', '#']).next().unwrap_or(after);
    let mut segs = path.split('/').filter(|s| !s.is_empty());
    let branch = segs.next()?;
    if branch != "arxiv" && branch != "venue" {
        return None;
    }
    let next = segs.next().unwrap_or("");
    if next == "kimi" {
        let query = after.split_once('?')?.1;
        for pair in query.split('&') {
            let (k, v) = pair.split_once('=')?;
            if k == "paper" {
                let id = urlencoding::decode(v).ok()?;
                let id = id.trim();
                if !id.is_empty() {
                    return Some((branch.to_string(), id.to_string()));
                }
            }
        }
        return None;
    }
    if next.is_empty() || next == "search" {
        return None;
    }
    let id = urlencoding::decode(next).ok()?;
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    Some((branch.to_string(), id.to_string()))
}

/// Search-result titles are often clipped. Accept exact keys, or a long prefix.
fn titles_compatible(want: &str, hit: &str) -> bool {
    const MIN_PREFIX: usize = 24;
    let want = title_key(want);
    let hit = title_key(hit);
    if want.is_empty() || hit.is_empty() {
        return false;
    }
    if want == hit {
        return true;
    }
    let (short, long) = if want.len() <= hit.len() {
        (want, hit)
    } else {
        (hit, want)
    };
    long.starts_with(&short) && short.len() >= MIN_PREFIX
}

/// Title lookup across branches.
///
/// Never trust rank: papers.cool reports a constant `Total: 1000` and a
/// wrong-branch query still answers with plausible but unrelated papers.
/// Prefer an exact normalized title; fall back to a unique long-prefix match
/// because list rows truncate.
async fn resolve_by_title(title: &str) -> Option<(String, String)> {
    let query = search_query(title);
    if query.is_empty() {
        return None;
    }
    let want = title_key(title);
    if want.is_empty() {
        return None;
    }
    for branch in BRANCHES {
        let url = format!(
            "{ORIGIN}/{branch}/search?query={}",
            urlencoding::encode(&query)
        );
        let Ok(html) = get_text(&url).await else {
            continue;
        };
        let hits = parse_search_hits(&html);
        if let Some((id, _)) = hits.iter().find(|(_, hit)| title_key(hit) == want) {
            return Some((branch.to_string(), id.clone()));
        }
        let prefix: Vec<&(String, String)> = hits
            .iter()
            .filter(|(_, hit)| titles_compatible(title, hit))
            .collect();
        if prefix.len() == 1 {
            return Some((branch.to_string(), prefix[0].0.clone()));
        }
    }
    None
}

fn resolve_ref(
    catalog_id: Option<&str>,
    source_url: Option<&str>,
    arxiv_id: Option<&str>,
) -> Option<(String, String, &'static str)> {
    if let Some(raw) = source_url {
        if let Some((branch, id)) = parse_coolpapers_url(raw) {
            return Some((branch, id, "sourceUrl"));
        }
    }
    if let Some(id) = catalog_id.and_then(venue_catalog_id) {
        return Some(("venue".to_string(), id.to_string(), "catalogId"));
    }
    if let Some(id) = arxiv_id.and_then(bare_arxiv_id) {
        return Some(("arxiv".to_string(), id, "arxivId"));
    }
    None
}

fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut depth = 0usize;
    for c in input.chars() {
        match c {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

pub fn decode_entities(input: &str) -> String {
    if !input.contains('&') {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        // Named / numeric entities are short. Scan by char so a bare `&`
        // in front of CJK (e.g. `R&D返回`) cannot slice mid-codepoint.
        let Some(semi) = tail
            .char_indices()
            .take(32)
            .find_map(|(i, c)| (c == ';').then_some(i))
        else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => entity
                .strip_prefix('#')
                .and_then(|num| match num.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => num.parse::<u32>().ok(),
                })
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &tail[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Collapse runs of 3+ newlines down to a blank-line separator.
fn squeeze_blank_lines(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut newlines = 0usize;
    for c in input.chars() {
        if c == '\n' {
            newlines += 1;
            if newlines <= 2 {
                out.push(c);
            }
        } else {
            newlines = 0;
            out.push(c);
        }
    }
    out
}

/// Cool Papers ends every FAQ with a "chat on Kimi web" promo (usually Q7).
fn is_kimi_web_cta_question(question: &str) -> bool {
    let q = question.trim();
    q.contains("想要进一步了解") || q.contains("进一步了解论文")
}

/// Drop the `<div class="faq-a">…</div>` that follows a skipped CTA question.
fn skip_following_faq_answer(after_q: &str) -> &str {
    const A_OPEN: &str = "<div class=\"faq-a\"";
    let Some(start) = after_q.find(A_OPEN) else {
        return after_q;
    };
    let from = &after_q[start..];
    match from.find("</div>") {
        Some(close) => &from[close + "</div>".len()..],
        None => after_q,
    }
}

/// Turn the `/kimi` HTML+Markdown hybrid into plain Markdown.
///
/// Questions arrive as `<p class="faq-q"><strong>Q1</strong>: …</p>` and answers
/// are Markdown wrapped in `<div class="faq-a">`. The `$…$` math is left exactly
/// as-is; the site escapes it only to feed MathJax.
///
/// Heading levels: FAQ questions become `## Qn: …`; answer bodies already use
/// `###` subsections, so they nest under each Q. The trailing
/// "想要进一步了解论文" FAQ (Kimi web CTA) is dropped.
fn kimi_html_to_markdown(raw: &str) -> String {
    const Q_OPEN: &str = "<p class=\"faq-q\">";
    let mut staged = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find(Q_OPEN) {
        staged.push_str(&rest[..start]);
        let after = &rest[start + Q_OPEN.len()..];
        match after.find("</p>") {
            Some(end) => {
                let question = decode_entities(&strip_tags(&after[..end]));
                let after_q = &after[end + "</p>".len()..];
                if is_kimi_web_cta_question(&question) {
                    rest = skip_following_faq_answer(after_q);
                    continue;
                }
                // `##` so answer-body `###` subsections nest under each Q.
                staged.push_str("## ");
                staged.push_str(question.trim());
                rest = after_q;
            }
            None => {
                rest = after;
                break;
            }
        }
    }
    staged.push_str(rest);

    let mut body = String::with_capacity(staged.len());
    for line in staged.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("<div class=\"faq-a\"") || trimmed == "</div>" {
            continue;
        }
        body.push_str(line);
        body.push('\n');
    }
    squeeze_blank_lines(decode_entities(body.trim()).trim())
}

pub struct FetchNotesRequest<'a> {
    pub vault: &'a Path,
    /// Vault-relative paper folder.
    pub paper_rel: &'a str,
    /// Catalog id. Venue imports store the Cool Papers row id here.
    pub catalog_id: Option<&'a str>,
    pub source_url: Option<&'a str>,
    pub arxiv_id: Option<&'a str>,
    pub title: Option<&'a str>,
}

/// Resolve the paper on papers.cool, fetch its Kimi analysis, append to NOTES.md.
///
/// Appending goes through `append_markdown_blocks`, which is idempotent by
/// content and only ever appends — a hand-written NOTES.md is never rewritten.
pub async fn fetch_notes(req: FetchNotesRequest<'_>) -> Result<CoolPapersNotes, AppError> {
    let rel = crate::fs::sanitize_vault_rel(req.paper_rel)
        .map_err(|e| AppError::message(format!("invalid paper path: {e}")))?;
    let notes_path = req.vault.join(&rel).join("NOTES.md");
    if !notes_path.is_file() {
        return Err(AppError::message("paper has no NOTES.md"));
    }

    let _permit = permit().await;

    let (branch, paper_id, matched_by) =
        if let Some(hit) = resolve_ref(req.catalog_id, req.source_url, req.arxiv_id) {
            hit
        } else {
            let title = req.title.map(str::trim).filter(|s| !s.is_empty());
            let Some(title) = title else {
                return Ok(CoolPapersNotes::not_found());
            };
            match resolve_by_title(title).await {
                Some((branch, id)) => (branch, id, "title"),
                None => return Ok(CoolPapersNotes::not_found()),
            }
        };

    let encoded = urlencoding::encode(&paper_id);
    let kimi_url = format!("{ORIGIN}/{branch}/kimi?paper={encoded}");
    let raw = get_text(&kimi_url).await?;
    let markdown = kimi_html_to_markdown(&raw);
    if markdown.is_empty() {
        // Unknown paper ids answer 200 with an empty body.
        return Ok(CoolPapersNotes::not_found());
    }

    let page_url = format!("{ORIGIN}/{branch}/{encoded}");
    // Bold label (not a heading) so `## Qn` / answer `###` nest cleanly under
    // the paper's existing `#` title without a competing section heading.
    let block =
        format!("**Cool Papers · Kimi 解析**\n\n> 来源：[{page_url}]({page_url})\n\n{markdown}");
    let appended = crate::features::markdown::append::append_markdown_blocks(&notes_path, &[block]);

    Ok(CoolPapersNotes {
        found: true,
        appended,
        branch: Some(branch),
        paper_id: Some(paper_id),
        url: Some(page_url),
        matched_by: Some(matched_by.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_arxiv_version_suffix() {
        assert_eq!(bare_arxiv_id("2608.13558v3").as_deref(), Some("2608.13558"));
        assert_eq!(
            bare_arxiv_id("arXiv:1706.03762").as_deref(),
            Some("1706.03762")
        );
        assert_eq!(bare_arxiv_id("  "), None);
        // A trailing `v` that is not a version marker stays intact.
        assert_eq!(
            bare_arxiv_id("cs.CL/0101001").as_deref(),
            Some("cs.CL/0101001")
        );
    }

    #[test]
    fn title_key_ignores_punctuation_and_case() {
        assert_eq!(
            title_key("LoRA: Low-Rank Adaptation of LLMs"),
            title_key("lora low rank adaptation of llms")
        );
        assert_ne!(
            title_key("Segment Anything"),
            title_key("Segment Anything 2")
        );
    }

    #[test]
    fn search_query_keeps_alphanumeric_runs() {
        assert_eq!(
            search_query("LoRA: Low-Rank Adaptation!"),
            "LoRA Low Rank Adaptation"
        );
    }

    #[test]
    fn parses_id_and_title_from_list_rows() {
        let html = r#"
        <a id="title-36984@AAAI" class="title-link notranslate" href="/venue/36984@AAAI" target="_blank">Learning from Long-Term Engagement</a>
        <a id="title-2608.13558" class="title-link" href="/arxiv/2608.13558">OmniScientist: An Omni-Modal AI Scientist</a>
        "#;
        let hits = parse_search_hits(html);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].0, "36984@AAAI");
        assert_eq!(hits[0].1, "Learning from Long-Term Engagement");
        assert_eq!(hits[1].0, "2608.13558");
    }

    #[test]
    fn decodes_named_and_numeric_entities() {
        assert_eq!(
            decode_entities("students&#039; work &amp; play"),
            "students' work & play"
        );
        assert_eq!(decode_entities("a &lt;b&gt; c"), "a <b> c");
        // A bare ampersand is left alone.
        assert_eq!(decode_entities("Q&A"), "Q&A");
        // `&` + CJK used to panic: `tail[..12]` split a 3-byte char (`返`).
        assert_eq!(decode_entities("R&D返回首页"), "R&D返回首页");
        assert_eq!(decode_entities("A&测试&amp;B"), "A&测试&B");
    }

    #[test]
    fn converts_faq_hybrid_to_markdown() {
        let raw = "<p class=\"faq-q\"><strong>Q1</strong>: 试图解决什么问题？</p>\n\n<div class=\"faq-a\">\n\n答案正文 $x^2$ 保留。\n\n### 小节标题\n\n</div>\n";
        let md = kimi_html_to_markdown(raw);
        assert!(md.starts_with("## Q1: 试图解决什么问题？"));
        assert!(md.contains("答案正文 $x^2$ 保留。"));
        // Answer subsections stay ### so they nest under ## Q.
        assert!(md.contains("### 小节标题"));
        assert!(!md.contains("faq-a"));
        assert!(!md.contains("</div>"));
    }

    #[test]
    fn drops_kimi_web_cta_faq() {
        let raw = r#"<p class="faq-q"><strong>Q6</strong>: 总结一下论文的主要内容</p>
<div class="faq-a">

正文摘要。

</div>

<p class="faq-q"><strong>Q7</strong>: 想要进一步了解论文</p>

<div class="faq-a">

以上只是了解一篇论文的几个基本FAQ。如果你还想与Kimi进一步讨论该论文，请点击 <a href="http://kimi.com/_prefill_chat?x=1" target="_blank"><strong>这里 <i class="fa fa-external-link"></i></strong></a> 为你跳转Kimi AI网页版，并启动一个与该论文相关的新会话。

</div>
"#;
        let md = kimi_html_to_markdown(raw);
        assert!(md.contains("## Q6: 总结一下论文的主要内容"));
        assert!(md.contains("正文摘要。"));
        assert!(!md.contains("Q7"));
        assert!(!md.contains("想要进一步了解"));
        assert!(!md.contains("Kimi AI网页版"));
        assert!(!md.contains("fa-external-link"));
        assert!(!md.contains("kimi.com"));
    }

    #[test]
    fn empty_kimi_body_yields_empty_markdown() {
        assert!(kimi_html_to_markdown("").is_empty());
    }

    #[test]
    fn venue_catalog_id_accepts_cool_papers_row_ids() {
        assert_eq!(venue_catalog_id("38818@AAAI"), Some("38818@AAAI"));
        assert_eq!(
            venue_catalog_id("2024.acl-long.290@ACL"),
            Some("2024.acl-long.290@ACL")
        );
        assert_eq!(venue_catalog_id("1706.03762"), None);
        assert_eq!(venue_catalog_id("not an id"), None);
    }

    #[test]
    fn parses_cool_papers_page_and_kimi_urls() {
        assert_eq!(
            parse_coolpapers_url("https://papers.cool/venue/38818@AAAI"),
            Some(("venue".into(), "38818@AAAI".into()))
        );
        assert_eq!(
            parse_coolpapers_url("https://papers.cool/venue/kimi?paper=38818%40AAAI"),
            Some(("venue".into(), "38818@AAAI".into()))
        );
        assert_eq!(
            parse_coolpapers_url("https://papers.cool/arxiv/2608.13558"),
            Some(("arxiv".into(), "2608.13558".into()))
        );
        assert_eq!(
            parse_coolpapers_url("https://arxiv.org/abs/2608.13558"),
            None
        );
    }

    #[test]
    fn resolve_ref_prefers_source_url_then_venue_id() {
        let hit = resolve_ref(
            Some("38818@AAAI"),
            Some("https://papers.cool/venue/38818@AAAI"),
            Some("2608.13558"),
        )
        .expect("resolved");
        assert_eq!(hit.0, "venue");
        assert_eq!(hit.1, "38818@AAAI");
        assert_eq!(hit.2, "sourceUrl");

        let hit = resolve_ref(Some("38818@AAAI"), None, Some("2608.13558")).expect("resolved");
        assert_eq!(hit.2, "catalogId");
        assert_eq!(hit.1, "38818@AAAI");
    }

    #[test]
    fn titles_compatible_allows_truncated_search_hit() {
        let full = "TripLe: Revisiting Pretrained Model Reuse and Progressive Learning for Efficient Vision Transformer Scaling and Searching";
        let clipped = "TripLe: Revisiting Pretrained Model Reuse and Progressive Learning for Efficient Vision Transformer Scaling and Searchin";
        assert!(titles_compatible(full, clipped));
        assert!(titles_compatible(full, full));
        assert!(!titles_compatible(full, "TripLe"));
        assert!(!titles_compatible("Segment Anything", "Segment Anything 2"));
    }
}
