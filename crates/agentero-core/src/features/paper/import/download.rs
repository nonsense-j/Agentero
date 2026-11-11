//! Paper asset download: PDF + arXiv LaTeX source fetch, byte progress aggregation,
//! and on-demand re-download for an existing paper folder.
//!
//! Flow:
//! - `ensure_paper_assets*` is used by the commit pipeline to fetch resources for
//!   a freshly created paper folder.
//! - `download_paper_assets*` is the on-demand entry for an existing folder
//!   (Library right-click / CLI `paper download`).
//! - Always try PDF; arXiv IDs also try e-print TeX; caller runs liteparse when
//!   no TeX is available.

use super::{AppHandle, PaperDownloadAssetsArgs};
use crate::error::AppError;
use crate::features::catalog::{papers, probe_paper_caps, CapsCache};
use crate::features::paper::source::{self, SourceStatus};
use crate::features::scholar_api::identifiers::{extract_arxiv_id, strip_arxiv_version};
use crate::http;
use flate2::read::GzDecoder;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tar::Archive;

/// Institution proxy (EZProxy/WebVPN/CARSI) credentials for paywalled PDF fallback.
///
/// Set by the host when settings load or change (`set_institution_proxy`);
/// read per request by the download fallback chain. An empty prefix disables
/// the layer — the unauthenticated behaviour stays the default.
static INSTITUTION_PROXY: Mutex<Option<InstitutionProxyConf>> = Mutex::new(None);

/// Optional desktop WebView2/WKWebView PDF fetcher installed by `src-tauri`.
///
/// Publisher CDNs such as `dl.acm.org` (Cloudflare) and `ieeexplore.ieee.org`
/// (`stamp.jsp` session checks) bind CARSI SAML sessions to the Chromium TLS
/// stack and `HttpOnly` cookies inside the login WebView, rejecting bare
/// `reqwest` requests with HTTP 403 / 502. When installed, CARSI probes and
/// downloads execute inside an offscreen WebView sharing that exact profile.
pub type BrowserPdfFetchFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<u8>, String>> + Send>>;
pub type BrowserPdfFetcher = std::sync::Arc<dyn Fn(String) -> BrowserPdfFetchFuture + Send + Sync>;

static BROWSER_PDF_FETCHER: Mutex<Option<BrowserPdfFetcher>> = Mutex::new(None);

/// Register the desktop host's WebView-backed publisher PDF fetcher.
pub fn install_browser_pdf_fetcher(fetcher: BrowserPdfFetcher) {
    if let Ok(mut guard) = BROWSER_PDF_FETCHER.lock() {
        *guard = Some(fetcher);
    }
}

async fn browser_pdf_fetch(url: &str) -> Option<Result<Vec<u8>, String>> {
    let fetcher = BROWSER_PDF_FETCHER.lock().ok().and_then(|g| g.clone())?;
    Some((fetcher)(url.to_string()).await)
}

/// Returns `true` when `prefix` points to a publisher Shibboleth / CARSI WAYF
/// endpoint rather than an EZProxy or wengine WebVPN gateway.
pub fn is_carsi_sso_prefix(prefix: &str) -> bool {
    let lower = prefix.trim().to_ascii_lowercase();
    lower.contains("dl.acm.org/action/ssostart")
        || lower.contains("ieeexplore.ieee.org/servlet/wayf.jsp")
        || lower.contains("wayf.springernature.com")
        || lower.contains("authn.sd.elsevier.com")
        || lower.contains("ds.carsi.edu.cn")
        || lower.contains("onlinelibrary.wiley.com/action/ssostart")
}

/// Gateway flavour of the configured institution proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstitutionProxyKind {
    /// No gateway: direct connection. On campus networks the institution IP
    /// itself carries the subscription, so this needs zero configuration.
    Direct,
    /// Standard EZProxy query passthrough (`/login?url={encoded target}`).
    EzProxy,
    /// wengine WebVPN path rewriting (`/https/{encrypted-host}/{path}`), used
    /// by several CN universities (ZJU etc.). Hosts are AES-128-CTR encrypted
    /// with the fixed public `wrdvpnisthebest!` key and prefixed with the IV.
    Wengine,
    /// CARSI federated Shibboleth SSO directly on publisher domains
    /// (`dl.acm.org`, `ieeexplore.ieee.org`, `link.springer.com`,
    /// `www.sciencedirect.com`, `www.nature.com`, `onlinelibrary.wiley.com`).
    Carsi,
}

impl InstitutionProxyKind {
    pub fn from_setting(s: &str) -> Self {
        if s.eq_ignore_ascii_case("direct") || s.eq_ignore_ascii_case("none") {
            Self::Direct
        } else if s.eq_ignore_ascii_case("wengine") {
            Self::Wengine
        } else if s.eq_ignore_ascii_case("carsi") {
            Self::Carsi
        } else {
            Self::EzProxy
        }
    }

    pub fn from_setting_and_prefix(s: &str, prefix: &str) -> Self {
        if s.eq_ignore_ascii_case("direct") || s.eq_ignore_ascii_case("none") {
            Self::Direct
        } else if is_carsi_sso_prefix(prefix) {
            Self::Carsi
        } else {
            Self::from_setting(s)
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct InstitutionProxyConf {
    kind: InstitutionProxyKind,
    prefix: String,
    cookie: String,
}

/// Update the process-wide institution proxy (kind + prefix + session cookie).
/// An empty prefix disables the fallback layer (except CARSI with non-empty
/// publisher cookies). For EZProxy a bare origin (no query part) gets the
/// `/login?url=` convention appended; for wengine/CARSI the prefix stays as-is.
pub fn set_institution_proxy(kind: InstitutionProxyKind, prefix: &str, cookie: &str) {
    let mut prefix = prefix.trim().trim_end_matches('/').to_string();
    if kind == InstitutionProxyKind::EzProxy && !prefix.is_empty() && !prefix.contains('?') {
        prefix.push_str("/login?url=");
    }
    // Header values reject control characters; pasted cookies often carry
    // stray CR/LF/TAB from terminals or chat windows.
    let cookie: String = cookie
        .trim()
        .chars()
        .filter(|c| !matches!(c, '\r' | '\n' | '\t'))
        .collect();
    let disabled = kind == InstitutionProxyKind::Direct
        || (prefix.is_empty() && !(kind == InstitutionProxyKind::Carsi && !cookie.is_empty()));
    let value = if disabled {
        None
    } else {
        Some(InstitutionProxyConf {
            kind,
            prefix,
            cookie,
        })
    };
    if let Ok(mut guard) = INSTITUTION_PROXY.lock() {
        *guard = value;
    }
}

fn institution_proxy() -> Option<InstitutionProxyConf> {
    INSTITUTION_PROXY.lock().ok().and_then(|g| g.clone())
}

/// Institution-proxy fields as stored in the shared
/// `$XDG_CONFIG_HOME/agentero/settings.json` (camelCase). Defined here so the
/// headless CLI reads the very same keys the GUI store writes, instead of a
/// parallel copy that could drift out of sync.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstitutionProxySettings {
    #[serde(default)]
    institution_proxy_prefix: String,
    #[serde(default)]
    institution_proxy_cookie: String,
    #[serde(default)]
    institution_proxy_type: String,
}

/// Extract `(kind, prefix, cookie)` from a `settings.json` body. Pure so it can
/// be unit-tested without touching the process-wide proxy.
fn parse_institution_proxy_settings(raw: &str) -> Option<(InstitutionProxyKind, String, String)> {
    let s: InstitutionProxySettings = serde_json::from_str(raw).ok()?;
    let kind = InstitutionProxyKind::from_setting_and_prefix(
        &s.institution_proxy_type,
        &s.institution_proxy_prefix,
    );
    Some((kind, s.institution_proxy_prefix, s.institution_proxy_cookie))
}

/// Install the institution-proxy slice of a `settings.json` body into this
/// process. An absent/empty prefix keeps the unauthenticated default (direct,
/// no cookie). Returns true when a gateway was activated.
fn apply_institution_proxy_settings(raw: &str) -> bool {
    let Some((kind, prefix, cookie)) = parse_institution_proxy_settings(raw) else {
        return false;
    };
    set_institution_proxy(kind, &prefix, &cookie);
    institution_proxy().is_some()
}

/// Load the institution proxy (EZProxy/WebVPN) from the shared `settings.json`
/// into this process. The desktop Host does this through its settings store;
/// the headless CLI has no store, so it reads the same file here before
/// downloading. Missing, unreadable, or malformed settings leave the default
/// (direct, no cookie).
pub fn load_institution_proxy_from_settings() -> bool {
    std::fs::read_to_string(crate::paths::settings_path())
        .map(|raw| apply_institution_proxy_settings(&raw))
        .unwrap_or(false)
}

/// AES-128-CTR encrypt `host` with the public wengine key/IV and hex-encode
/// with the IV prefixed in plaintext, matching the gateway's URL form
/// (`/https/{hex(wrdvpnisthebest!)}{hex(ct)}/`). Verified against a live ZJU
/// WebVPN deployment (sample: www.cnki.net).
fn wengine_host(host: &str) -> String {
    use aes::cipher::{BlockEncrypt, KeyInit};
    const KEY_IV: &[u8; 16] = b"wrdvpnisthebest!";
    let cipher = aes::Aes128::new_from_slice(KEY_IV).expect("fixed 16-byte key");
    let mut counter = *KEY_IV;
    let mut block = aes::Block::default();
    let mut out = Vec::with_capacity(host.len());
    for chunk in host.as_bytes().chunks(16) {
        block.copy_from_slice(&counter);
        cipher.encrypt_block(&mut block);
        for (i, byte) in chunk.iter().enumerate() {
            out.push(byte ^ block[i]);
        }
        // big-endian increment of the full 128-bit counter
        for b in counter.iter_mut().rev() {
            *b = b.wrapping_add(1);
            if *b != 0 {
                break;
            }
        }
    }
    let mut hexed = String::with_capacity(32 + out.len() * 2);
    for b in KEY_IV.iter().chain(out.iter()) {
        hexed.push_str(&format!("{b:02x}"));
    }
    hexed
}

/// Rewrite `target` into a wengine path-style proxy URL:
/// `{origin}/{scheme}/{encoded-host}{path}`.
fn wengine_rewrite(origin: &str, target: &str) -> Option<String> {
    let (scheme, rest) = target.split_once("://")?;
    let (host, path) = match rest.split_once('/') {
        Some((h, p)) => (h, format!("/{p}")),
        None => (rest, "/".to_string()),
    };
    // strip port: the gateway encodes the bare host
    let host = host.split(':').next().unwrap_or(host);
    let path = path.trim_start_matches('/').trim_end_matches('/');
    if path.is_empty() {
        Some(format!("{origin}/{scheme}/{}", wengine_host(host)))
    } else {
        Some(format!("{origin}/{scheme}/{}/{path}", wengine_host(host)))
    }
}

/// Rewrite `target` into an EZProxy-style prefixed URL
/// (`{prefix}{percent-encoded target}`). The prefix is expected to already end
/// with the query part, e.g. `https://webvpn.example.edu/login?url=`.
fn ezproxy_rewrite(prefix: &str, target: &str) -> String {
    format!("{prefix}{}", urlencoding::encode(target))
}

/// Extract candidate PDF links from a proxied landing page. Absolute links are
/// returned as-is; publisher-relative paths are resolved against the proxy
/// origin so the caller can rewrite them again.
fn pdf_links_from_html(html: &str, proxy_origin: &str, gateway_origin: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for attr in ["href=\"", "src=\""] {
        let mut rest = html;
        while let Some(idx) = rest.find(attr) {
            let after = &rest[idx + attr.len()..];
            let Some(end) = after.find('"') else { break };
            let link = &after[..end];
            rest = &after[end..];
            let lower = link.to_ascii_lowercase();
            let looks_like_pdf = lower.ends_with(".pdf")
                || lower.contains("pdfdirect")
                || lower.contains("getfulltxt")
                || lower.contains("/pdf/")
                || lower.contains("articlepdf");
            if !looks_like_pdf || link.is_empty() {
                continue;
            }
            let resolved = if link.starts_with("http") {
                link.to_string()
            } else if link.starts_with("/https/") || link.starts_with("/http/") {
                // Gateway-absolute wengine path — resolve against the gateway
                // origin, never against the current page's directory.
                format!("{gateway_origin}{link}")
            } else if link.starts_with('/') {
                format!("{proxy_origin}{link}")
            } else {
                continue;
            };
            if !out.contains(&resolved) {
                out.push(resolved);
            }
        }
    }
    out.truncate(5);
    out
}

/// Merge newly captured publisher-domain cookies `(host, cookie_header)` into
/// an existing `institutionProxyCookie` value. Supports both a JSON host→cookie
/// map (`{"dl.acm.org":"...","ieeexplore.ieee.org":"..."}`) so signing into
/// multiple CARSI publishers accumulates sessions without overwriting, and
/// legacy plain cookie strings (preserved under `"*"`).
pub fn merge_carsi_cookie_map(existing_raw: &str, host_cookies: &[(String, String)]) -> String {
    use std::collections::BTreeMap;
    let trimmed = existing_raw.trim();
    let mut map: BTreeMap<String, String> = if trimmed.starts_with('{') {
        serde_json::from_str(trimmed).unwrap_or_default()
    } else {
        let mut init = BTreeMap::new();
        if !trimmed.is_empty() {
            init.insert("*".to_string(), trimmed.to_string());
        }
        init
    };
    for (host, cookie) in host_cookies {
        let h = host.trim().to_ascii_lowercase();
        let c = cookie.trim();
        if !h.is_empty() && !c.is_empty() {
            map.insert(h, c.to_string());
        }
    }
    serde_json::to_string(&map).unwrap_or_default()
}

/// Resolve the `Cookie` header to send for `target_url`.
/// Plain strings are returned verbatim; JSON host→cookie maps match the exact
/// hostname first, then parent domain suffix, then `"*"` fallback.
pub fn cookie_for_url(cookie_raw: &str, target_url: &str) -> String {
    let trimmed = cookie_raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if !trimmed.starts_with('{') {
        return trimmed.to_string();
    }
    let Ok(map) = serde_json::from_str::<std::collections::BTreeMap<String, String>>(trimmed)
    else {
        return String::new();
    };
    let host = reqwest::Url::parse(target_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_default();
    if !host.is_empty() {
        if let Some(exact) = map.get(&host) {
            return exact.clone();
        }
        for (k, v) in &map {
            if k == "*" {
                continue;
            }
            let kl = k.to_ascii_lowercase();
            if host.ends_with(&format!(".{kl}")) || kl.ends_with(&format!(".{host}")) {
                return v.clone();
            }
        }
    }
    map.get("*").cloned().unwrap_or_default()
}

/// Direct publisher PDF URLs derived from a DOI prefix so CARSI / campus
/// requests hit the publisher host directly without a `doi.org` cross-origin
/// redirect (which strips `Cookie` headers in HTTP clients).
pub fn publisher_direct_pdf_targets(doi: &str) -> Vec<String> {
    let d = doi.trim();
    let lower = d.to_ascii_lowercase();
    let mut out = Vec::new();
    if lower.starts_with("10.1145/") {
        out.push(format!("https://dl.acm.org/doi/pdf/{d}"));
    } else if lower.starts_with("10.1007/") {
        out.push(format!("https://link.springer.com/content/pdf/{d}.pdf"));
    } else if let Some(suffix) = d.split_once("10.1038/").map(|(_, s)| s) {
        if !suffix.is_empty() {
            out.push(format!("https://www.nature.com/articles/{suffix}.pdf"));
        }
    } else if lower.starts_with("10.1002/") {
        out.push(format!(
            "https://onlinelibrary.wiley.com/doi/pdfdirect/{d}?download=true"
        ));
    }
    out
}

/// Mine publisher-specific PDF download endpoints (e.g. IEEE `stampPDF/getPDF.jsp`
/// `arnumber`, Elsevier `pdfft`, ACM `/doi/pdf/`) from a landed publisher URL + HTML.
fn publisher_mined_pdf_targets(doi: &str, final_url: &str, html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower_url = final_url.to_ascii_lowercase();
    if lower_url.contains("ieeexplore.ieee.org") {
        let arnumber = final_url
            .split("/document/")
            .nth(1)
            .and_then(|s| s.split(['/', '?', '#']).next())
            .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
            .map(str::to_string)
            .or_else(|| {
                let needle = "\"articleNumber\":\"";
                let start = html.find(needle)? + needle.len();
                let rest = &html[start..];
                let end = rest.find('"')?;
                let cand = &rest[..end];
                (!cand.is_empty() && cand.chars().all(|c| c.is_ascii_digit()))
                    .then(|| cand.to_string())
            });
        if let Some(ar) = arnumber {
            out.push(format!(
                "https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber={ar}&ref="
            ));
        }
    } else if lower_url.contains("sciencedirect.com") {
        if let Some(pii) = final_url
            .split("/pii/")
            .nth(1)
            .and_then(|s| s.split(['/', '?', '#']).next())
            .filter(|s| !s.is_empty())
        {
            out.push(format!(
                "https://www.sciencedirect.com/science/article/pii/{pii}/pdfft?isDTMRedir=true&download=true"
            ));
        }
    } else if lower_url.contains("dl.acm.org") && !doi.is_empty() {
        out.push(format!("https://dl.acm.org/doi/pdf/{doi}"));
    } else if lower_url.contains("link.springer.com") && !doi.is_empty() {
        out.push(format!("https://link.springer.com/content/pdf/{doi}.pdf"));
    }
    out
}

fn strip_html_tags_plain(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for c in input.chars() {
        match c {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    crate::features::paper::discovery::coolpapers::decode_entities(&out)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Extract an article/chapter abstract from publisher HTML (Springer `#Abs1-content`,
/// IEEE `xplGlobal.document.metadata.abstract`, ACM `abstractSection`, or Highwire/DC meta).
pub fn extract_publisher_abstract_from_html(html: &str) -> Option<String> {
    // 1. Springer `#Abs1-content`
    for marker in ["id=\"Abs1-content\"", "id='Abs1-content'"] {
        if let Some(idx) = html.find(marker) {
            let after = &html[idx + marker.len()..];
            if let Some(gt) = after.find('>') {
                let inner = &after[gt + 1..];
                if let Some(close) = inner.find("</div>") {
                    let cleaned = strip_html_tags_plain(&inner[..close]);
                    if cleaned.len() >= 40 {
                        return Some(cleaned);
                    }
                }
            }
        }
    }

    // 2. IEEE Xplore `xplGlobal.document.metadata` `"abstract":"..."`
    if let Some(meta_idx) = html.find("xplGlobal.document.metadata") {
        let slice = &html[meta_idx..];
        let needle = "\"abstract\":\"";
        if let Some(abs_start) = slice.find(needle) {
            let mut rest = &slice[abs_start + needle.len()..];
            let mut raw_json_str = String::from("\"");
            let mut escaped = false;
            for ch in rest.chars() {
                raw_json_str.push(ch);
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    break;
                }
            }
            let _ = &mut rest;
            if let Ok(unescaped) = serde_json::from_str::<String>(&raw_json_str) {
                let cleaned = strip_html_tags_plain(&unescaped);
                if cleaned.len() >= 40 && !cleaned.eq_ignore_ascii_case("true") {
                    return Some(cleaned);
                }
            }
        }
    }

    // 3. ACM Digital Library `<div class="abstractSection abstractInFull">`
    if let Some(idx) = html.find("abstractInFull") {
        let after = &html[idx..];
        if let Some(gt) = after.find('>') {
            let inner = &after[gt + 1..];
            if let Some(close) = inner.find("</div>") {
                let cleaned = strip_html_tags_plain(&inner[..close]);
                if cleaned.len() >= 40 {
                    return Some(cleaned);
                }
            }
        }
    }

    // 4. Highwire / Dublin Core `<meta name="citation_abstract" content="...">` / `dc.description`
    for name in ["citation_abstract", "dc.description", "DC.Description"] {
        let needle = format!("name=\"{name}\"");
        if let Some(pos) = html.find(&needle) {
            let start_tag = html[..pos].rfind('<').unwrap_or(pos);
            let end_tag = html[pos..].find('>').map(|e| pos + e).unwrap_or(html.len());
            let tag = &html[start_tag..end_tag];
            if let Some(c_pos) = tag.find("content=\"") {
                let val_rest = &tag[c_pos + "content=\"".len()..];
                if let Some(c_end) = val_rest.find('"') {
                    let cleaned = strip_html_tags_plain(&val_rest[..c_end]);
                    if cleaned.len() >= 40 {
                        return Some(cleaned);
                    }
                }
            }
        }
    }

    None
}

/// Best-effort abstract fallback for DOI imports when Crossref/Translator omit the abstract:
/// - Publicly fetches `link.springer.com` for `10.1007/*` DOIs;
/// - Uses configured institution proxy / CARSI cookies when available for ACM/IEEE/Elsevier.
pub async fn fetch_publisher_abstract_fallback(doi: &str) -> Option<String> {
    let d = doi.trim();
    if d.is_empty() {
        return None;
    }
    let lower = d.to_ascii_lowercase();
    let conf = institution_proxy();

    let mut urls: Vec<String> = Vec::new();
    if lower.starts_with("10.1007/") {
        if lower.starts_with("10.1007/978-") {
            urls.push(format!("https://link.springer.com/chapter/{d}"));
            urls.push(format!("https://link.springer.com/article/{d}"));
        } else {
            urls.push(format!("https://link.springer.com/article/{d}"));
            urls.push(format!("https://link.springer.com/chapter/{d}"));
        }
    } else if conf.is_some() {
        if lower.starts_with("10.1145/") {
            urls.push(format!("https://dl.acm.org/doi/{d}"));
        } else {
            urls.push(format!("https://doi.org/{d}"));
        }
    } else {
        return None;
    }

    for target in urls {
        let (rewritten, cookie) = match &conf {
            Some(c) => match c.kind {
                InstitutionProxyKind::Direct | InstitutionProxyKind::Carsi => {
                    (target.clone(), cookie_for_url(&c.cookie, &target))
                }
                InstitutionProxyKind::EzProxy => {
                    (ezproxy_rewrite(&c.prefix, &target), c.cookie.clone())
                }
                InstitutionProxyKind::Wengine => {
                    let origin = c.prefix.trim_end_matches('/');
                    match wengine_rewrite(origin, &target) {
                        Some(u) => (u, c.cookie.clone()),
                        None => continue,
                    }
                }
            },
            None => (target.clone(), String::new()),
        };

        if let Ok((bytes, final_url)) = fetch_bytes_checked_with_url(&rewritten, &cookie).await {
            if let Ok(html) = String::from_utf8(bytes) {
                if let Some(abs) = extract_publisher_abstract_from_html(&html) {
                    return Some(abs);
                }
                // Cross-origin `doi.org` -> publisher redirect stripped Cookie on hop 0:
                // re-fetch `final_url` directly with its host cookie if CARSI has one.
                if let Some(c) = &conf {
                    if c.kind == InstitutionProxyKind::Carsi && final_url != rewritten {
                        let host_cookie = cookie_for_url(&c.cookie, &final_url);
                        if !host_cookie.is_empty() {
                            if let Ok((b2, _)) =
                                fetch_bytes_checked_with_url(&final_url, &host_cookie).await
                            {
                                if let Ok(h2) = String::from_utf8(b2) {
                                    if let Some(abs) = extract_publisher_abstract_from_html(&h2) {
                                        return Some(abs);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

/// One-shot probe of an institution proxy configuration: fetch a known
/// paywalled DOI through the rewrite and check the response is a PDF.
/// Returns the byte count on success. Backs the settings "test connection".
pub async fn probe_institution_proxy(
    kind: InstitutionProxyKind,
    prefix: &str,
    cookie: &str,
) -> Result<usize, String> {
    const PROBE_DOI: &str = "10.1038/nature12373";
    let prefix = prefix.trim().trim_end_matches('/');
    if prefix.is_empty() && kind != InstitutionProxyKind::Carsi {
        return Err("proxy prefix is empty".into());
    }
    let target = "https://www.nature.com/articles/nature12373.pdf";
    let (rewritten, resolved_cookie) = match kind {
        InstitutionProxyKind::Direct => {
            return Err("direct mode has no gateway to probe".into());
        }
        InstitutionProxyKind::EzProxy => {
            let mut ez = prefix.to_string();
            if !ez.contains('?') {
                ez.push_str("/login?url=");
            }
            (
                ezproxy_rewrite(&ez, &format!("https://doi.org/{PROBE_DOI}")),
                cookie.trim().to_string(),
            )
        }
        InstitutionProxyKind::Wengine => (
            wengine_rewrite(prefix, target).ok_or_else(|| "wengine rewrite failed".to_string())?,
            cookie.trim().to_string(),
        ),
        InstitutionProxyKind::Carsi => {
            let lower_prefix = prefix.to_ascii_lowercase();
            let carsi_target = if lower_prefix.contains("acm.org") {
                "https://dl.acm.org/doi/pdf/10.1145/2786805.2786814"
            } else if lower_prefix.contains("ieee.org") {
                "https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=7194613"
            } else if lower_prefix.contains("springer") {
                "https://link.springer.com/content/pdf/10.1007/s10515-023-00407-8.pdf"
            } else if lower_prefix.contains("elsevier") || lower_prefix.contains("sciencedirect") {
                "https://www.sciencedirect.com/science/article/pii/S0164121223003199/pdfft?isDTMRedir=true&download=true"
            } else if lower_prefix.contains("wiley.com") {
                "https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/smr.2624?download=true"
            } else {
                target
            };

            if let Some(browser_res) = browser_pdf_fetch(carsi_target).await {
                match browser_res {
                    Ok(bytes) if bytes.len() >= 4 && &bytes[..4] == b"%PDF" => {
                        return Ok(bytes.len());
                    }
                    Ok(_) => {}
                    Err(e) if e.contains("authentication required") => {
                        return Err(e);
                    }
                    Err(_) => {}
                }
            }

            let host_cookie = cookie_for_url(cookie, carsi_target);
            if host_cookie.is_empty() {
                return Err(
                    "authentication required: sign in via CARSI first so publisher session is active"
                        .into(),
                );
            }
            (carsi_target.to_string(), host_cookie)
        }
    };
    let (bytes, final_url) = fetch_bytes_checked_with_url(&rewritten, &resolved_cookie).await?;
    if bytes.len() >= 4 && &bytes[..4] == b"%PDF" {
        return Ok(bytes.len());
    }
    if kind == InstitutionProxyKind::Carsi {
        if let Ok(html) = std::str::from_utf8(&bytes) {
            let link_base = reqwest::Url::parse(&final_url)
                .ok()
                .and_then(|u| Some(format!("{}://{}", u.scheme(), u.host_str()?)))
                .unwrap_or_default();
            for mined in pdf_links_from_html(html, &link_base, &link_base) {
                let c = cookie_for_url(cookie, &mined);
                if let Ok((b2, _)) = fetch_bytes_checked_with_url(&mined, &c).await {
                    if b2.len() >= 4 && &b2[..4] == b"%PDF" {
                        return Ok(b2.len());
                    }
                }
            }
        }
    }
    let login_redirect = reqwest::Url::parse(&final_url).is_ok_and(|url| {
        let path = url.path().to_ascii_lowercase();
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        ["/login", "/auth", "/cas", "/sso", "/shibboleth", "/wayf"]
            .iter()
            .any(|part| path.contains(part))
            || ["login.", "sso.", "cas.", "passport.", "idp.", "ds.carsi."]
                .iter()
                .any(|part| host.starts_with(part))
    });
    if login_redirect {
        return Err("authentication required: gateway redirected to login".into());
    }
    Err("response was HTML, not a PDF (institution may not subscribe to this journal)".into())
}

/// Like [`fetch_bytes_checked`] but also returns the final URL after
/// redirects — needed to resolve relative links on the landed page.
async fn fetch_bytes_checked_with_url(
    url: &str,
    cookie: &str,
) -> Result<(Vec<u8>, String), String> {
    // Cookie store on: publisher bot checks (e.g. nature.com) accept the
    // request once the landing page's cookies ride along, which also makes
    // direct on-campus downloads work with zero configuration.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent(http::BROWSER_USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .cookie_store(true)
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(url);
    if !cookie.is_empty() {
        let value = reqwest::header::HeaderValue::from_str(cookie)
            .map_err(|e| format!("cookie contains characters invalid in a header ({e})"))?;
        req = req.header("Cookie", value);
    }
    let res = req.send().await.map_err(|e| {
        let mut msg = e.to_string();
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            msg.push_str(": ");
            msg.push_str(&s.to_string());
            src = s.source();
        }
        msg
    })?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let final_url = res.url().to_string();
    let bytes = res.bytes().await.map_err(|e| e.to_string())?.to_vec();
    Ok((bytes, final_url))
}

/// Upper bound for the network asset phase of one paper import.
///
/// Individual requests have shorter reqwest timeouts, but an import may try
/// several PDF fallbacks before fetching the arXiv source. Keep the whole
/// phase bounded so one paper cannot hold an import task indefinitely.
pub const PAPER_ASSET_TIMEOUT: Duration = Duration::from_secs(3 * 60);

#[derive(Debug, Default, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetDownloadResult {
    pub pdf: bool,
    pub tex: bool,
    /// True when `PAPER.md` was written (or already present after auto-parse).
    #[serde(default)]
    pub paper_md: bool,
    pub messages: Vec<String>,
    /// Follow-up steps for this download. Not part of the IPC payload.
    #[serde(skip)]
    #[specta(skip)]
    pub preparation: super::preparation::PreparationPlan,
}

/// Byte/count progress wire event for projected JobCenter rows. `task_id`
/// carries the JobCenter job id; the desktop contract mirror lives in
/// `events_contract.rs` (`JobProgressEvent`). Host-side emitters go through
/// `features::jobs::emit_job_progress`; core emitters share this name.
pub const JOB_PROGRESS_EVENT: &str = "job:progress";

#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDownloadProgress {
    pub task_id: String,
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub progress: Option<u8>,
    /// Optional item counters for batch operations (e.g. import 2/5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_count: Option<usize>,
}

#[derive(Clone, Copy)]
pub struct AssetProgressContext<'a> {
    pub app: Option<&'a AppHandle>,
    pub task_id: Option<&'a str>,
}

/// Throttle byte-level download progress events.
///
/// reqwest yields 8–16KB chunks, so a 20MB PDF used to emit 1000–2500
/// `job:progress` events (×5 with batch import concurrency),
/// flooding the webview event loop. Emit only when enough time passed or the
/// percentage actually moved; the caller emits the final value unconditionally
/// when the download completes.
pub(crate) struct ProgressThrottle {
    min_interval: Duration,
    last_emit: Option<std::time::Instant>,
    last_percent: Option<u8>,
}

impl ProgressThrottle {
    pub(crate) fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last_emit: None,
            last_percent: None,
        }
    }

    /// True when this sample should be emitted: first sample, ≥ interval since
    /// the last emit, or the percent moved by ≥ 1 point since the last emit.
    pub(crate) fn should_emit(&mut self, now: std::time::Instant, percent: Option<u8>) -> bool {
        let elapsed_ok = match self.last_emit {
            None => true,
            Some(last) => now.duration_since(last) >= self.min_interval,
        };
        let percent_moved = match (self.last_percent, percent) {
            (Some(prev), Some(cur)) => cur != prev,
            (None, Some(_)) => true,
            _ => false,
        };
        if !elapsed_ok && !percent_moved {
            return false;
        }
        self.last_emit = Some(now);
        if percent.is_some() {
            self.last_percent = percent;
        }
        true
    }
}

/// Minimum spacing between byte-progress events when the percent is unknown.
pub(crate) const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);

/// Byte progress of one download stream inside an [`AssetProgressAggregator`].
#[derive(Debug, Clone, Copy, Default)]
struct ProgressSlot {
    downloaded: u64,
    total: Option<u64>,
    /// The stream ended (saved or gave up), so its size is final and a missing
    /// `Content-Length` no longer holds the merged total back.
    finished: bool,
}

/// Merged totals across every stream sharing one JobCenter row.
///
/// A stream still running with no `Content-Length` keeps the merged size
/// unknown: guessing at it would let the other stream read 100% on its own.
fn merged_progress(slots: &[ProgressSlot]) -> (u64, Option<u64>, Option<u8>) {
    let mut downloaded = 0_u64;
    let mut total = 0_u64;
    for slot in slots {
        downloaded = downloaded.saturating_add(slot.downloaded);
        let Some(size) = slot
            .total
            .or_else(|| slot.finished.then_some(slot.downloaded))
        else {
            return (downloaded, None, None);
        };
        total = total.saturating_add(size);
    }
    let percent = ((downloaded.saturating_mul(100) / total.max(1)).min(100)) as u8;
    (downloaded, Some(total), Some(percent))
}

/// Merges the byte progress of every stream that shares one JobCenter row.
///
/// PDF and TeX share a single `task_id`, so per-phase
/// percentages cannot be weighted on the frontend: whichever stream finished
/// first pinned the shared bar at 100% while the other was still fetching.
/// The slot count fixed at construction is the denominator, which also keeps a
/// PDF-only import (no TeX stream) spanning the whole bar.
pub(crate) struct AssetProgressAggregator<'a> {
    app: Option<&'a AppHandle>,
    task_id: Option<&'a str>,
    phase: &'static str,
    state: Mutex<AggregatorState>,
}

struct AggregatorState {
    slots: Vec<ProgressSlot>,
    throttle: ProgressThrottle,
}

impl<'a> AssetProgressAggregator<'a> {
    pub(crate) fn new(
        app: Option<&'a AppHandle>,
        task_id: Option<&'a str>,
        phase: &'static str,
        streams: usize,
    ) -> Self {
        Self {
            app,
            task_id,
            phase,
            state: Mutex::new(AggregatorState {
                slots: vec![ProgressSlot::default(); streams.max(1)],
                throttle: ProgressThrottle::new(PROGRESS_EMIT_INTERVAL),
            }),
        }
    }

    /// Handle for one stream of this aggregator.
    pub(crate) fn stream(&self, slot: usize) -> StreamProgress<'_, 'a> {
        StreamProgress { agg: self, slot }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, AggregatorState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Build the wire payload, or `None` when the throttle swallowed it.
    fn sample(&self, state: &mut AggregatorState, force: bool) -> Option<AssetDownloadProgress> {
        let task_id = self.task_id?;
        let (downloaded_bytes, total_bytes, progress) = merged_progress(&state.slots);
        if !force
            && !state
                .throttle
                .should_emit(std::time::Instant::now(), progress)
        {
            return None;
        }
        Some(AssetDownloadProgress {
            task_id: task_id.to_string(),
            phase: self.phase.to_string(),
            downloaded_bytes,
            total_bytes,
            progress,
            current_count: None,
            total_count: None,
        })
    }

    fn emit_progress(&self, payload: Option<AssetDownloadProgress>) {
        let (Some(app), Some(payload)) = (self.app, payload) else {
            return;
        };
        app.emit(JOB_PROGRESS_EVENT, &payload);
    }
}

/// One stream's view into an [`AssetProgressAggregator`].
#[derive(Clone, Copy)]
pub(crate) struct StreamProgress<'agg, 'ctx> {
    agg: &'agg AssetProgressAggregator<'ctx>,
    slot: usize,
}

impl<'agg, 'ctx> StreamProgress<'agg, 'ctx> {
    pub(crate) fn task_id(&self) -> Option<&'ctx str> {
        self.agg.task_id
    }

    /// The next candidate URL starts its byte count over (PDF fallbacks).
    fn restart(&self) {
        if let Some(slot) = self.agg.lock().slots.get_mut(self.slot) {
            *slot = ProgressSlot::default();
        }
    }

    fn record(&self, downloaded: u64, total: Option<u64>, force: bool) {
        let payload = {
            let mut state = self.agg.lock();
            if let Some(slot) = state.slots.get_mut(self.slot) {
                slot.downloaded = downloaded;
                slot.total = total;
            }
            self.agg.sample(&mut state, force)
        };
        self.agg.emit_progress(payload);
    }

    pub(crate) fn report(&self, downloaded: u64, total: Option<u64>) {
        self.record(downloaded, total, false);
    }

    /// The stream ended. Always emits: the merged bar must reach the final
    /// byte count even when the throttle swallowed the last chunk, and a
    /// stream that gave up before any byte landed must not keep the merged
    /// total unknown forever.
    pub(crate) fn finish(&self) {
        let payload = {
            let mut state = self.agg.lock();
            if let Some(slot) = state.slots.get_mut(self.slot) {
                slot.finished = true;
            }
            self.agg.sample(&mut state, true)
        };
        self.agg.emit_progress(payload);
    }
}

/// Download missing PDF (always try when URL known) and arXiv LaTeX source.
///
/// - **PDF** → paper folder root: `{paper}/{id}.pdf` (not under `source/`)
/// - **TeX** (arXiv e-print) → `{paper}/source/`
///
/// PDF lands first to pin the source to its arXiv version stamp; both streams
/// share byte progress. The body preparation chooses TeX before PDF parsing.
pub async fn ensure_paper_assets(
    paper_dir: &Path,
    id: &str,
    arxiv_id: Option<&str>,
    pdf_url: Option<&str>,
    doi: Option<&str>,
) -> Result<AssetDownloadResult, AppError> {
    ensure_paper_assets_with_cookies(paper_dir, id, arxiv_id, pdf_url, doi, None).await
}

#[allow(clippy::too_many_arguments)]
pub async fn ensure_paper_assets_with_progress(
    paper_dir: &Path,
    vault: &Path,
    paper_path: &str,
    id: &str,
    arxiv_id: Option<&str>,
    pdf_url: Option<&str>,
    doi: Option<&str>,
    cookies: Option<&str>,
    cache: Option<&CapsCache>,
    progress: AssetProgressContext<'_>,
) -> Result<AssetDownloadResult, AppError> {
    tokio::time::timeout(
        PAPER_ASSET_TIMEOUT,
        ensure_paper_assets_impl(
            paper_dir, vault, paper_path, id, arxiv_id, pdf_url, doi, cookies, cache, progress,
            true,
        ),
    )
    .await
    .map_err(|_| {
        AppError::message(format!(
            "asset download timeout after {}s",
            PAPER_ASSET_TIMEOUT.as_secs()
        ))
    })?
}

/// Variant used by browser integrations that provide the page's cookie jar.
/// The cookie string is only sent to the explicitly supplied attachment URL.
pub async fn ensure_paper_assets_with_cookies(
    paper_dir: &Path,
    id: &str,
    arxiv_id: Option<&str>,
    pdf_url: Option<&str>,
    doi: Option<&str>,
    cookies: Option<&str>,
) -> Result<AssetDownloadResult, AppError> {
    tokio::time::timeout(
        PAPER_ASSET_TIMEOUT,
        ensure_paper_assets_impl(
            paper_dir,
            paper_dir,
            "",
            id,
            arxiv_id,
            pdf_url,
            doi,
            cookies,
            None,
            AssetProgressContext {
                app: None,
                task_id: None,
            },
            false,
        ),
    )
    .await
    .map_err(|_| {
        AppError::message(format!(
            "asset download timeout after {}s",
            PAPER_ASSET_TIMEOUT.as_secs()
        ))
    })?
}

#[derive(Debug, Default)]
struct PdfAssetResult {
    ok: bool,
    messages: Vec<String>,
}

#[derive(Debug, Default)]
struct TexAssetResult {
    messages: Vec<String>,
    error: Option<AppError>,
}

#[allow(clippy::too_many_arguments)]
async fn ensure_paper_assets_impl(
    paper_dir: &Path,
    vault: &Path,
    paper_path: &str,
    id: &str,
    arxiv_id: Option<&str>,
    pdf_url: Option<&str>,
    doi: Option<&str>,
    cookies: Option<&str>,
    cache: Option<&CapsCache>,
    progress: AssetProgressContext<'_>,
    retry_source: bool,
) -> Result<AssetDownloadResult, AppError> {
    super::check_task_not_cancelled(progress.task_id)?;
    let mut out = AssetDownloadResult::default();
    fs::create_dir_all(paper_dir)?;

    let before = probe_paper_caps(paper_dir);
    let need_pdf = !before.has_pdf();
    let need_tex = !before.has_tex;
    let request = source::asset_request(arxiv_id, pdf_url, None);
    let tex_arxiv_id = request.as_deref();

    // Both streams share one JobCenter row, so their byte progress is merged
    // here instead of being weighted per phase in the frontend. The slot count
    // is the denominator: a stream that never starts must not let the other
    // one reach 100%.
    let streams = usize::from(need_pdf) + usize::from(need_tex && tex_arxiv_id.is_some());
    let aggregator = AssetProgressAggregator::new(
        progress.app,
        progress.task_id,
        if streams > 1 {
            "assets"
        } else if need_pdf {
            "pdf"
        } else {
            "tex"
        },
        streams,
    );
    let pdf_stream = aggregator.stream(0);
    let tex_stream = aggregator.stream(usize::from(need_pdf));

    let pdf_task = async {
        if !need_pdf {
            return PdfAssetResult {
                ok: true,
                messages: vec!["pdf already present".into()],
            };
        }
        let res = fetch_pdf_assets(
            paper_dir,
            id,
            tex_arxiv_id,
            pdf_url,
            doi,
            cookies,
            pdf_stream,
        )
        .await;
        // The candidate loop may have given up before any byte landed.
        pdf_stream.finish();
        res
    };

    let tex_task = async {
        if !need_tex {
            return TexAssetResult {
                messages: vec!["tex already present".into()],
                ..Default::default()
            };
        }
        let Some(aid) = tex_arxiv_id else {
            return TexAssetResult::default();
        };
        let res = match prepare_arxiv_source_with_progress(paper_dir, aid, tex_stream, retry_source)
            .await
        {
            Ok(tex) => TexAssetResult {
                messages: vec![if tex {
                    "tex ready"
                } else {
                    "e-print has no TeX"
                }
                .into()],
                ..Default::default()
            },
            Err(error) => TexAssetResult {
                messages: vec![format!("tex failed: {error}")],
                error: Some(error),
            },
        };
        tex_stream.finish();
        res
    };

    // Land the PDF first so its native arXiv version stamp can pin the source.
    let pdf_res = pdf_task.await;
    let tex_res = tex_task.await;
    let tex_error = tex_res.error;
    out.messages.extend(pdf_res.messages);
    out.messages.extend(tex_res.messages);

    // Refresh presence after attempts. Directory content may have changed, so
    // invalidate any cached entry first; caps_for then re-probes and caches.
    if let Some(c) = cache {
        c.invalidate(vault, paper_path);
    }
    let after = cache
        .map(|c| c.caps_for(vault, paper_path))
        .unwrap_or_else(|| probe_paper_caps(paper_dir));
    if after.has_pdf() {
        out.pdf = true;
    }
    if after.has_tex {
        out.tex = true;
    }
    out.paper_md = after.has_paper_md;
    if !paper_path.is_empty() {
        source::reconcile_body(vault, paper_path)?;
    }
    if after.has_pdf() && !paper_path.is_empty() {
        super::code_repo::fill_code_repo_from_pdf(vault, paper_path).await;
    }
    super::check_task_not_cancelled(progress.task_id)?;

    if let Some(error) = tex_error {
        return Err(error);
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
async fn fetch_pdf_assets(
    paper_dir: &Path,
    id: &str,
    arxiv_id: Option<&str>,
    pdf_url: Option<&str>,
    doi: Option<&str>,
    cookies: Option<&str>,
    progress: StreamProgress<'_, '_>,
) -> PdfAssetResult {
    let mut out = PdfAssetResult::default();
    let mut candidates = pdf_url_candidates(id, arxiv_id, pdf_url);
    let mut ok = try_download_candidates_with_cookies(
        paper_dir,
        id,
        &candidates,
        &mut out,
        cookies,
        progress,
    )
    .await;
    // DOI fallback: Crossref often lists a direct / open-access PDF link even
    // when the Translator gave no pdf_url (or the publisher landing page failed).
    if !ok {
        if let Err(e) = super::check_task_not_cancelled(progress.task_id()) {
            out.messages.push(format!("pdf cancelled: {e}"));
            return out;
        }
        if let Some(doi) = doi.map(str::trim).filter(|s| !s.is_empty()) {
            let extra: Vec<String> = crossref_pdf_urls(doi)
                .await
                .into_iter()
                .filter(|u| !candidates.iter().any(|c| c == u))
                .collect();
            if extra.is_empty() {
                out.messages
                    .push("pdf: no Crossref PDF link for DOI".into());
            } else {
                ok = try_download_candidates_with_cookies(
                    paper_dir, id, &extra, &mut out, cookies, progress,
                )
                .await;
                candidates.extend(extra);
            }
        }
    }
    // Unpaywall fallback: open-access PDF for DOI papers (helps some ACM/IEEE
    // and other paywalled papers that have an OA copy; no API key required).
    if !ok {
        if let Err(e) = super::check_task_not_cancelled(progress.task_id()) {
            out.messages.push(format!("pdf cancelled: {e}"));
            return out;
        }
        if let Some(doi) = doi.map(str::trim).filter(|s| !s.is_empty()) {
            if let Some(url) = unpaywall_pdf_url(doi).await {
                if !candidates.iter().any(|c| c == &url) {
                    ok = try_download_candidates_with_cookies(
                        paper_dir,
                        id,
                        std::slice::from_ref(&url),
                        &mut out,
                        cookies,
                        progress,
                    )
                    .await;
                    candidates.push(url);
                }
            }
        }
    }
    // Institution proxy / CARSI fallback: rewrite the DOI target through the
    // user's EZProxy/WebVPN gateway or send publisher CARSI session cookies.
    if !ok {
        if let Err(e) = super::check_task_not_cancelled(progress.task_id()) {
            out.messages.push(format!("pdf cancelled: {e}"));
            return out;
        }
        if let Some(doi) = doi.map(str::trim).filter(|s| !s.is_empty()) {
            let conf = institution_proxy().unwrap_or(InstitutionProxyConf {
                kind: InstitutionProxyKind::Direct,
                prefix: String::new(),
                cookie: String::new(),
            });
            ok = try_institution_proxy_download(paper_dir, id, doi, &conf, &mut out).await;
            if !ok {
                ok = try_paper_search_cli_download(paper_dir, id, doi, &mut out).await;
            }
        }
    }
    if !ok && candidates.is_empty() {
        out.messages.push("pdf: no url".into());
    }
    out.ok = ok;
    out
}

fn find_paper_search_binary() -> Option<PathBuf> {
    #[cfg(windows)]
    const NAMES: &[&str] = &["paper-search.exe", "paper-search.cmd", "paper-search.bat"];
    #[cfg(not(windows))]
    const NAMES: &[&str] = &["paper-search"];

    if let Some(path_os) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_os) {
            for name in NAMES {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    #[cfg(not(windows))]
    if let Some(home) = dirs::home_dir() {
        let local_bin = home.join(".local/bin/paper-search");
        if local_bin.is_file() {
            return Some(local_bin);
        }
    }
    None
}

/// Optional delegation to an externally user-installed `paper-search` CLI
/// (`dr-dumpling/PaperSearch`) when OA + built-in Institution Proxy / CARSI
/// could not retrieve a paywalled PDF. Silently no-ops if `paper-search` is
/// not installed on `PATH`.
async fn try_paper_search_cli_download(
    paper_dir: &Path,
    id: &str,
    doi: &str,
    out: &mut PdfAssetResult,
) -> bool {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = (paper_dir, id, doi, out);
        false
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let Some(bin) = find_paper_search_binary() else {
            return false;
        };
        let staging = paper_dir.join(format!(".paper-search-{}", uuid::Uuid::new_v4().simple()));
        if fs::create_dir_all(&staging).is_err() {
            return false;
        }
        let mut cmd = tokio::process::Command::new(&bin);
        cmd.arg("download")
            .arg(doi)
            .arg("-o")
            .arg(&staging)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let status_ok = matches!(
            tokio::time::timeout(Duration::from_secs(90), cmd.output()).await,
            Ok(Ok(output)) if output.status.success()
        );

        let mut adopted = false;
        if let Ok(entries) = fs::read_dir(&staging) {
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_file() {
                    continue;
                }
                if let Ok(bytes) = fs::read(&p) {
                    if bytes.len() >= 4 && &bytes[..4] == b"%PDF" {
                        let dest = paper_dir.join(safe_filename(id, "pdf"));
                        if fs::write(&dest, &bytes).is_ok() {
                            out.messages
                                .push("pdf ok via paper-search CLI fallback".into());
                            adopted = true;
                            break;
                        }
                    }
                }
            }
        }
        let _ = fs::remove_dir_all(&staging);
        if !adopted && !status_ok {
            out.messages
                .push("paper-search CLI fallback did not yield a PDF".into());
        }
        adopted
    }
}

/// Try to fetch a paywalled PDF through EZProxy/WebVPN or direct publisher
/// CARSI / campus subscriptions. The first hop often lands on the publisher
/// article page rather than the PDF itself, so HTML responses are mined for
/// publisher-specific PDF endpoints (`dl.acm.org/doi/pdf/...`, IEEE
/// `stampPDF/getPDF.jsp`, Springer `/content/pdf/...`, Elsevier `pdfft`) and retried.
async fn try_institution_proxy_download(
    paper_dir: &Path,
    id: &str,
    doi: &str,
    conf: &InstitutionProxyConf,
    out: &mut PdfAssetResult,
) -> bool {
    let proxy_origin = conf
        .prefix
        .split("/login?url=")
        .next()
        .unwrap_or(&conf.prefix)
        .to_string();
    let mut targets = match conf.kind {
        InstitutionProxyKind::Direct | InstitutionProxyKind::Carsi => {
            let mut direct = publisher_direct_pdf_targets(doi);
            direct.push(format!("https://doi.org/{doi}"));
            direct
        }
        InstitutionProxyKind::EzProxy | InstitutionProxyKind::Wengine => {
            vec![format!("https://doi.org/{doi}")]
        }
    };

    for _hop in 0..2 {
        let mut next_targets: Vec<String> = Vec::new();
        for target in &targets {
            let (rewritten, req_cookie) = match conf.kind {
                InstitutionProxyKind::Direct => (target.clone(), conf.cookie.clone()),
                InstitutionProxyKind::Carsi => {
                    (target.clone(), cookie_for_url(&conf.cookie, target))
                }
                InstitutionProxyKind::EzProxy => {
                    (ezproxy_rewrite(&conf.prefix, target), conf.cookie.clone())
                }
                InstitutionProxyKind::Wengine => {
                    if target.starts_with(&proxy_origin) {
                        (target.clone(), conf.cookie.clone())
                    } else {
                        match wengine_rewrite(&proxy_origin, target) {
                            Some(url) => (url, conf.cookie.clone()),
                            None => continue,
                        }
                    }
                }
            };
            match fetch_bytes_checked_with_url(&rewritten, &req_cookie).await {
                Ok((bytes, final_url)) => {
                    if bytes.len() >= 4 && &bytes[..4] == b"%PDF" {
                        let name = safe_filename(id, "pdf");
                        if let Err(e) = fs::write(paper_dir.join(name), &bytes) {
                            out.messages
                                .push(format!("institution proxy write failed: {e}"));
                            return false;
                        }
                        out.messages
                            .push(format!("pdf ok via institution proxy ({rewritten})"));
                        return true;
                    }
                    if let Ok(html) = String::from_utf8(bytes) {
                        // Resolve relative PDF links against the landed page:
                        // for wengine that is /https/{enc-host}/..., not the
                        // bare gateway origin.
                        let link_base = match conf.kind {
                            InstitutionProxyKind::Direct | InstitutionProxyKind::Carsi => {
                                reqwest::Url::parse(&final_url)
                                    .ok()
                                    .and_then(|u| {
                                        Some(format!("{}://{}", u.scheme(), u.host_str()?))
                                    })
                                    .unwrap_or_else(|| proxy_origin.clone())
                            }
                            InstitutionProxyKind::Wengine => {
                                let mut base = final_url.clone();
                                while base.ends_with('/') {
                                    base.pop();
                                }
                                match base.rfind('/') {
                                    Some(i) => base[..i].to_string(),
                                    None => proxy_origin.clone(),
                                }
                            }
                            InstitutionProxyKind::EzProxy => proxy_origin.clone(),
                        };
                        for pub_link in publisher_mined_pdf_targets(doi, &final_url, &html) {
                            if !next_targets.contains(&pub_link) {
                                next_targets.push(pub_link);
                            }
                        }
                        let mut mined = pdf_links_from_html(&html, &link_base, &proxy_origin);
                        mined.sort_by_key(|l| !(l.contains("/articles/") && l.ends_with(".pdf")));
                        for link in mined {
                            if !next_targets.contains(&link) {
                                next_targets.push(link);
                            }
                        }
                    }
                }
                Err(e) => out.messages.push(format!(
                    "institution proxy candidate failed ({rewritten}): {e}"
                )),
            }
        }
        if next_targets.is_empty() {
            break;
        }
        targets = next_targets;
    }

    if conf.kind == InstitutionProxyKind::Carsi {
        let mut browser_targets = publisher_direct_pdf_targets(doi);
        browser_targets.push(format!("https://doi.org/{doi}"));
        for target in &browser_targets {
            if let Some(res) = browser_pdf_fetch(target).await {
                match res {
                    Ok(bytes) if bytes.len() >= 4 && &bytes[..4] == b"%PDF" => {
                        let name = safe_filename(id, "pdf");
                        if let Err(e) = fs::write(paper_dir.join(name), &bytes) {
                            out.messages
                                .push(format!("CARSI browser PDF write failed: {e}"));
                            return false;
                        }
                        out.messages
                            .push(format!("pdf ok via CARSI browser session ({target})"));
                        return true;
                    }
                    Ok(_) => {}
                    Err(e) => out
                        .messages
                        .push(format!("CARSI browser candidate failed ({target}): {e}")),
                }
            }
        }
    }

    out.messages
        .push("institution proxy did not yield a PDF (cookie expired or not subscribed?)".into());
    false
}

/// Pick the e-print id. A stamp read from the local PDF pins the download,
/// including when the save itself was unversioned. An explicit version that
/// disagrees with that stamp is refused. With no stamp the request is kept:
/// a bare id is arXiv's latest version.
fn resolve_eprint_request(requested: &str, stamp: Option<&str>) -> Result<String, String> {
    let bare = strip_arxiv_version(requested);
    if let Some(versioned) = stamp {
        if requested != bare && requested != versioned {
            return Err(format!(
                "arXiv source version {requested} does not match local PDF {versioned}"
            ));
        }
        return Ok(versioned.to_string());
    }
    Ok(requested.to_string())
}

/// Papers saved before unversioned requests fell through to latest recorded
/// this refusal. It is no longer a failure, so the retry backoff must not
/// keep replaying it.
fn is_retired_unversioned_stamp_refusal(error: &str) -> bool {
    error.contains("Cannot determine the local PDF's arXiv version")
}

pub async fn prepare_arxiv_source(
    paper_dir: &Path,
    arxiv_id: &str,
    task_id: Option<&str>,
) -> Result<bool, AppError> {
    let aggregator = AssetProgressAggregator::new(None, task_id, "tex", 1);
    prepare_arxiv_source_with_progress(paper_dir, arxiv_id, aggregator.stream(0), false).await
}

async fn prepare_arxiv_source_with_progress(
    paper_dir: &Path,
    arxiv_id: &str,
    progress: StreamProgress<'_, '_>,
    retry: bool,
) -> Result<bool, AppError> {
    let _guard = source::lock(paper_dir, progress.task_id()).await?;
    if source::read_tex(paper_dir).is_some() {
        return Ok(true);
    }
    if let Some(state) =
        source::state(paper_dir).filter(|s| source::matches_request(arxiv_id, &s.arxiv_id))
    {
        if state.status == SourceStatus::Unavailable {
            return Ok(false);
        }
        if !retry
            && state.status == SourceStatus::RetryableError
            && !source::retry_due(paper_dir, arxiv_id)
            && !state
                .error
                .as_deref()
                .is_some_and(is_retired_unversioned_stamp_refusal)
        {
            return Err(AppError::message(
                state
                    .error
                    .unwrap_or_else(|| "arXiv source download needs retry".into()),
            ));
        }
    }
    let mut request = arxiv_id.to_string();
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    if let Some(pdf) = probe_paper_caps(paper_dir).pdf_path {
        let bare = strip_arxiv_version(&request);
        if let Ok(pages) =
            crate::features::paper::analyze::parse::run_liteparse_probe(&pdf, progress.task_id())
                .await
        {
            let text = pages
                .iter()
                .flat_map(|page| &page.lines)
                .flat_map(|line| &line.words)
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            if let Some(versioned) = source::version_from_text(&text, &bare) {
                request = match resolve_eprint_request(&request, Some(&versioned)) {
                    Ok(request) => request,
                    Err(message) => {
                        source::record_state(
                            paper_dir,
                            arxiv_id,
                            SourceStatus::RetryableError,
                            Some(message.clone()),
                        )?;
                        return Err(AppError::message(message));
                    }
                };
            }
        }
        super::check_task_not_cancelled(progress.task_id())?;
        // No readable stamp: an unversioned id stays bare and downloads latest.
    }
    let source = paper_dir.join("source");
    fs::create_dir_all(&source)?;
    match download_arxiv_source(&source, paper_dir, &request, progress).await {
        Ok(()) => {
            let ready = source::read_tex(paper_dir).is_some();
            source::record_state(
                paper_dir,
                &request,
                if ready {
                    SourceStatus::Ready
                } else {
                    SourceStatus::Unavailable
                },
                None,
            )?;
            Ok(ready)
        }
        Err(error) => {
            super::check_task_not_cancelled(progress.task_id())?;
            source::record_state(
                paper_dir,
                arxiv_id,
                SourceStatus::RetryableError,
                Some(error.to_string()),
            )?;
            Err(error)
        }
    }
}

/// Build ordered PDF URL candidates (first success wins).
fn pdf_url_candidates(id: &str, arxiv_id: Option<&str>, pdf_url: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |u: String| {
        let t = u.trim().to_string();
        if !t.is_empty() && !out.iter().any(|x| x == &t) {
            out.push(t);
        }
    };

    if let Some(u) = pdf_url.map(str::trim).filter(|s| !s.is_empty()) {
        push(u.to_string());
    }

    let bare_arxiv = arxiv_id
        .and_then(crate::features::scholar_api::identifiers::extract_arxiv_request)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            // Folder / id often is the arXiv id
            let s = id.trim().to_string();
            if looks_like_arxiv_id(&s) {
                Some(s)
            } else {
                None
            }
        });

    if let Some(bare) = bare_arxiv {
        push(format!("https://arxiv.org/pdf/{bare}"));
        push(format!("https://arxiv.org/pdf/{bare}.pdf"));
        push(format!("https://export.arxiv.org/pdf/{bare}"));
    }

    out
}

/// Query Unpaywall for a DOI's best open-access PDF location.
async fn unpaywall_pdf_url(doi: &str) -> Option<String> {
    use crate::features::scholar_api::sources::unpaywall::UnpaywallApi;
    use crate::features::scholar_api::traits::PdfUrlSource;
    use crate::features::scholar_api::ApiQuery;

    let source = UnpaywallApi::new("agentero@users.noreply.github.com");
    source
        .pdf_url(&ApiQuery::Doi(doi.trim().to_string()))
        .await
        .ok()
        .flatten()
}

/// Try each PDF URL in order; write on first success. Returns true when a PDF was saved.
async fn try_download_candidates_with_cookies(
    paper_dir: &Path,
    id: &str,
    urls: &[String],
    out: &mut PdfAssetResult,
    cookies: Option<&str>,
    progress: StreamProgress<'_, '_>,
) -> bool {
    for url in urls {
        // PDF lives next to NOTES.md, not under source/
        match download_pdf_with_cookies(paper_dir, id, url, cookies, progress).await {
            Ok(()) => {
                out.ok = true;
                out.messages.push(format!("pdf ok ({url})"));
                return true;
            }
            Err(e) => {
                out.messages
                    .push(format!("pdf candidate failed ({url}): {e}"));
            }
        }
    }
    false
}

/// Query Crossref for a DOI's direct / open-access PDF links (no API key needed).
/// Prefers links whose content-type is application/pdf; falls back to any link URL.
async fn crossref_pdf_urls(doi: &str) -> Vec<String> {
    let api = format!(
        "https://api.crossref.org/works/{}",
        doi.trim().replace(' ', "%20")
    );
    let Ok(client) = http::client_with(Duration::from_secs(20), 10, http::BROWSER_USER_AGENT)
    else {
        return Vec::new();
    };
    let Ok(res) = client
        .get(&api)
        .header("Accept", "application/json")
        .send()
        .await
    else {
        return Vec::new();
    };
    if !res.status().is_success() {
        return Vec::new();
    }
    let Ok(text) = res.text().await else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let mut pdf_links = Vec::new();
    let mut other_links = Vec::new();
    if let Some(links) = value.pointer("/message/link").and_then(|v| v.as_array()) {
        for l in links {
            let url = l.get("URL").and_then(|v| v.as_str()).unwrap_or("").trim();
            if url.is_empty() {
                continue;
            }
            let ct = l.get("content-type").and_then(|v| v.as_str()).unwrap_or("");
            if ct.eq_ignore_ascii_case("application/pdf")
                || url.to_ascii_lowercase().ends_with(".pdf")
            {
                pdf_links.push(url.to_string());
            } else {
                other_links.push(url.to_string());
            }
        }
    }
    if pdf_links.is_empty() {
        other_links
    } else {
        pdf_links
    }
}

fn looks_like_arxiv_id(s: &str) -> bool {
    // 1412.6980 or hep-th/9901001
    let s = s.trim();
    if s.is_empty() {
        return false;
    }
    if s.contains('/') {
        return true;
    }
    let parts: Vec<_> = s.split('.').collect();
    parts.len() == 2
        && parts[0].len() == 4
        && parts[0].chars().all(|c| c.is_ascii_digit())
        && parts[1].chars().all(|c| c.is_ascii_digit())
        && (parts[1].len() >= 4 && parts[1].len() <= 5)
}

async fn download_pdf_with_cookies(
    source_dir: &Path,
    id: &str,
    url: &str,
    cookies: Option<&str>,
    progress: StreamProgress<'_, '_>,
) -> Result<(), AppError> {
    let bytes =
        http_get_bytes_with_progress(url, Duration::from_secs(180), cookies, progress).await?;
    // Reject HTML error pages disguised as PDF
    if bytes.len() >= 4 && &bytes[..4] == b"%PDF" {
        let name = safe_filename(id, "pdf");
        fs::write(source_dir.join(name), &bytes)?;
        return Ok(());
    }
    // Some servers omit magic; still write if URL looks like pdf and body is large
    if (url.contains("/pdf/") || url.ends_with(".pdf")) && bytes.len() > 1024 {
        // Avoid writing HTML error pages
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(200)]).to_ascii_lowercase();
        if head.contains("<!doctype") || head.contains("<html") {
            return Err(AppError::message("download returned HTML, not PDF"));
        }
        let name = safe_filename(id, "pdf");
        fs::write(source_dir.join(name), &bytes)?;
        return Ok(());
    }
    Err(AppError::message("download did not look like a PDF"))
}

/// Fetch arXiv e-print and unpack TeX into `source/`.
/// PDF-only e-prints are written to the **paper folder root** (same as normal PDF download).
async fn download_arxiv_source(
    source_dir: &Path,
    paper_dir: &Path,
    arxiv_id: &str,
    progress: StreamProgress<'_, '_>,
) -> Result<(), AppError> {
    let bare = strip_arxiv_version(arxiv_id);
    // Prefer e-print; /src/ is an alias
    let url = format!("https://arxiv.org/e-print/{arxiv_id}");
    let bytes =
        http_get_bytes_with_progress(&url, Duration::from_secs(180), None, progress).await?;
    unpack_arxiv_eprint(source_dir, paper_dir, &bare, &bytes)
}

fn unpack_arxiv_eprint(
    source_dir: &Path,
    paper_dir: &Path,
    bare_id: &str,
    bytes: &[u8],
) -> Result<(), AppError> {
    if bytes.is_empty() {
        return Err(AppError::message("empty e-print response"));
    }

    const MAX_SOURCE: u64 = 128 * 1024 * 1024;
    let payload = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut inflated = Vec::new();
        GzDecoder::new(Cursor::new(bytes))
            .take(MAX_SOURCE + 1)
            .read_to_end(&mut inflated)?;
        inflated
    } else {
        bytes.to_vec()
    };
    if payload.len() as u64 > MAX_SOURCE {
        return Err(AppError::message("arXiv source exceeds unpack limit"));
    }
    if payload.starts_with(b"%PDF") {
        let dest = paper_dir.join(safe_filename(bare_id, "pdf"));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dest)
        {
            Ok(mut file) => file.write_all(&payload)?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        return Ok(());
    }
    if payload.starts_with(b"%!PS") {
        return Ok(());
    }

    // Validate the whole archive before publishing any source file. The staging
    // directory is outside source/ and ignored by capability/tree/sync scans.
    let staging = tempfile::Builder::new()
        .prefix(".agentero-source-")
        .tempdir_in(paper_dir)?;
    if looks_like_tar(&payload) {
        extract_tar_safe(staging.path(), &payload)?;
    } else {
        let text = String::from_utf8_lossy(&payload);
        if payload.contains(&0) || !source::tex::has_indicator(&source::tex::strip_comments(&text))
        {
            return Err(AppError::message(
                "arXiv e-print is not a TeX document or PDF",
            ));
        }
        fs::write(staging.path().join(safe_filename(bare_id, "tex")), &payload)?;
    }
    if source::read_tex(staging.path()).is_none() {
        // A successfully decoded archive with no TeX is a known unsupported
        // submission, unlike a broken/incomplete TeX project.
        if !source::contains_tex_files(staging.path()) {
            return Ok(());
        }
        return Err(AppError::message(
            "arXiv source has no readable main TeX document or has missing inputs",
        ));
    }
    // Preserve user edits and derived sidecars. Publish only new files, and roll
    // those back if a later file conflicts or fails. Never replace source/ whole.
    let mut created = Vec::new();
    let result = publish_source(staging.path(), source_dir, &mut created);
    if let Err(error) = result {
        for path in created.iter().rev() {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }
    Ok(())
}

fn publish_source(from: &Path, to: &Path, created: &mut Vec<PathBuf>) -> Result<(), AppError> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            if target.is_symlink() {
                return Err(AppError::message("source directory is a symlink"));
            }
            publish_source(&entry.path(), &target, created)?;
        } else {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("agentero-")
                || matches!(name.as_str(), "layout.json" | "layout-index.json")
            {
                continue;
            }
            let bytes = fs::read(entry.path())?;
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
            {
                Ok(mut file) => {
                    created.push(target);
                    file.write_all(&bytes)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if target.is_symlink() || fs::read(&target)? != bytes {
                        return Err(AppError::message(format!(
                            "source conflicts with existing file: {}",
                            target.display()
                        )));
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(())
}

fn looks_like_tar(bytes: &[u8]) -> bool {
    // ustar magic at offset 257
    if bytes.len() > 262 {
        let magic = &bytes[257..262];
        if magic == b"ustar" || magic == b"ustar\0" {
            return true;
        }
        // Some tars use "ustar " (POSIX)
        if &bytes[257..263] == b"ustar " {
            return true;
        }
    }
    // Heuristic: 512-byte blocks with NUL padding in header
    bytes.len() >= 512 && bytes[0] != 0 && bytes.iter().take(100).any(|&b| b == 0)
}

pub(crate) fn extract_tar_safe(dest: &Path, tar_bytes: &[u8]) -> Result<(), AppError> {
    let mut archive = Archive::new(Cursor::new(tar_bytes));
    let entries = archive
        .entries()
        .map_err(|e| AppError::message(format!("tar entries: {e}")))?;

    for (index, entry) in entries.enumerate() {
        if index >= 10_000 {
            return Err(AppError::message("source archive has too many entries"));
        }
        let mut entry = entry.map_err(|e| AppError::message(format!("tar entry: {e}")))?;
        if entry.size() > 128 * 1024 * 1024 {
            return Err(AppError::message("source archive entry exceeds limit"));
        }
        let path = entry
            .path()
            .map_err(|e| AppError::message(format!("tar path: {e}")))?
            .into_owned();

        let safe = sanitize_tar_path(&path)?;
        if safe.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest.join(&safe);

        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err(AppError::message(
                "source archive contains unsupported link or special file",
            ));
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut file =
            File::create(&out_path).map_err(|e| AppError::message(format!("create: {e}")))?;
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| AppError::message(format!("tar read: {e}")))?;
        file.write_all(&buf)
            .map_err(|e| AppError::message(format!("write: {e}")))?;
    }
    Ok(())
}

/// Reject absolute paths and `..` components.
fn sanitize_tar_path(path: &Path) -> Result<PathBuf, AppError> {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(AppError::message("tar path traversal rejected"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::message("absolute tar path rejected"));
            }
        }
    }
    Ok(out)
}

pub(crate) async fn http_get_bytes_with_progress(
    url: &str,
    timeout: Duration,
    cookies: Option<&str>,
    progress: StreamProgress<'_, '_>,
) -> Result<Vec<u8>, AppError> {
    let task_id = progress.task_id();
    super::check_task_not_cancelled(task_id)?;
    // Each attempt counts from zero: PDF falls back across candidate URLs.
    progress.restart();
    let client = http::client_with(timeout, 10, http::BROWSER_USER_AGENT)?;
    let mut request = client
        .get(url)
        .header("Accept", "application/pdf,application/octet-stream,*/*");
    if let Some(cookie) = cookies.map(str::trim).filter(|s| !s.is_empty()) {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    let mut res = request
        .send()
        .await
        .map_err(|e| AppError::message(format!("download: {e}")))?;
    super::check_task_not_cancelled(task_id)?;
    if !res.status().is_success() {
        return Err(AppError::message(format!("download HTTP {}", res.status())));
    }
    let total_bytes = res.content_length();
    let mut downloaded_bytes = 0_u64;
    let mut bytes = Vec::new();
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| AppError::message(format!("download body: {e}")))?
    {
        if let Some(task_id) = task_id {
            if super::is_task_cancelled(task_id) {
                return Err(AppError::message("background task cancelled"));
            }
        }
        downloaded_bytes += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);
        // Per-chunk emits flood the webview event loop; the aggregator
        // throttles to percent moves / ≥100ms.
        progress.report(downloaded_bytes, total_bytes);
    }
    // Settling always lands an event, even when the throttle just swallowed
    // the last chunk: the task bar must reach the final byte count.
    progress.finish();
    Ok(bytes)
}

/// On-demand download of PDF (+ arXiv LaTeX) for an existing paper folder.
pub async fn download_paper_assets(
    args: PaperDownloadAssetsArgs,
) -> Result<AssetDownloadResult, AppError> {
    download_paper_assets_with_progress(args, None, None).await
}

pub async fn download_paper_assets_with_progress(
    args: PaperDownloadAssetsArgs,
    app: Option<&AppHandle>,
    cache: Option<&CapsCache>,
) -> Result<AssetDownloadResult, AppError> {
    // Resolve the vault/paper folder (fs::canonicalize) and read the catalog
    // row (rusqlite, which acquires the process-wide catalog lock) on the
    // blocking pool so neither a slow filesystem nor a held catalog lock stalls
    // a tokio worker.
    let vault_arg = args.vault_path.clone();
    let path_arg = args.path.clone();
    let (vault, paper_dir, path_rel, id, arxiv_id, pdf_url, doi, rebuilt_row) =
        tokio::task::spawn_blocking(move || {
            let vault = crate::fs::resolve_vault(&vault_arg)?;
            let (paper_dir, path_rel) = crate::fs::resolve_paper_dir(&vault, &path_arg)?;

            let resolved = if let Ok(Some(row)) = papers::get_by_path(&vault, &path_rel) {
                let request = source::arxiv_request(&row);
                (row.id, request, row.pdf_url, row.doi, None)
            } else if let Ok(Some(row)) = papers::ensure_row_for_path(&vault, &path_rel) {
                // Orphaned folder (import failed after shell + folder were written but
                // before the catalog row landed): rebuild the row so the Library sees it.
                (
                    row.id.clone(),
                    row.arxiv_id,
                    row.pdf_url,
                    row.doi,
                    Some(row.id),
                )
            } else {
                // Fallback: folder name as id; treat as arXiv if it looks like one
                let name = paper_dir
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("paper")
                    .to_string();
                let arxiv = extract_arxiv_id(&name);
                let pdf = arxiv
                    .as_ref()
                    .map(|a| format!("https://arxiv.org/pdf/{}", a));
                (name, arxiv, pdf, None, None)
            };
            let (id, arxiv_id, pdf_url, doi, rebuilt_row) = resolved;
            Ok::<_, AppError>((
                vault,
                paper_dir,
                path_rel,
                id,
                arxiv_id,
                pdf_url,
                doi,
                rebuilt_row,
            ))
        })
        .await
        .map_err(|e| AppError::message(format!("blocking task failed: {e}")))??;

    if let Some(row_id) = rebuilt_row {
        crate::features::lifecycle::emit_paper_imported(app, &vault, &row_id, &path_rel);
    }

    let mut result = ensure_paper_assets_with_progress(
        &paper_dir,
        &vault,
        &path_rel,
        &id,
        arxiv_id.as_deref(),
        pdf_url.as_deref(),
        doi.as_deref(),
        None,
        cache,
        AssetProgressContext {
            app,
            task_id: args.task_id.as_deref(),
        },
    )
    .await?;
    super::check_task_not_cancelled(args.task_id.as_deref())?;

    source::reconcile_body(&vault, &path_rel)?;

    result.preparation = super::preparation::plan_after_assets(
        &path_rel,
        result.pdf,
        result.tex,
        result.paper_md,
        false,
    );
    Ok(result)
}

fn safe_filename(id: &str, ext: &str) -> String {
    let base = id
        .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_")
        .trim()
        .to_string();
    let base = if base.is_empty() {
        "paper".into()
    } else {
        base
    };
    format!("{base}.{ext}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    #[test]
    fn ezproxy_rewrite_percent_encodes_target() {
        assert_eq!(
            ezproxy_rewrite(
                "https://webvpn.example.edu/login?url=",
                "https://doi.org/10.1038/nature12373"
            ),
            "https://webvpn.example.edu/login?url=https%3A%2F%2Fdoi.org%2F10.1038%2Fnature12373"
        );
    }

    #[test]
    fn pdf_links_from_html_keeps_pdf_like_and_resolves_relative() {
        let html = r#"<a href="https://pub.example.org/pdf/10.1/x.pdf">pdf</a>
            <a href="/doi/pdf/10.1/x">alt</a>
            <a href="https://pub.example.org/article">no</a>
            <embed src="/delivery/getFullTxt.cpx">"#;
        let links = pdf_links_from_html(
            html,
            "https://webvpn.example.edu",
            "https://webvpn.example.edu",
        );
        assert!(links.contains(&"https://pub.example.org/pdf/10.1/x.pdf".to_string()));
        assert!(links.contains(&"https://webvpn.example.edu/doi/pdf/10.1/x".to_string()));
        assert!(links.contains(&"https://webvpn.example.edu/delivery/getFullTxt.cpx".to_string()));
        assert!(!links.iter().any(|l| l.ends_with("/article")));
    }

    #[test]
    fn wengine_host_matches_live_samples() {
        // Captured from a live ZJU WebVPN deployment (2026-10): the gateway
        // URL for www.cnki.net.
        assert_eq!(
            wengine_host("www.cnki.net"),
            "77726476706e69737468656265737421e7e056d2243e635930068cb8"
        );
    }

    #[test]
    fn wengine_rewrite_builds_path_form() {
        assert_eq!(
            wengine_rewrite(
                "https://webvpn.zju.edu.cn",
                "https://www.nature.com/articles/s43018-026-01220-4.pdf"
            )
            .as_deref(),
            Some(
                "https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421e7e056d229317c456c0dc7af9758/articles/s43018-026-01220-4.pdf"
            )
        );
    }

    #[test]
    fn set_institution_proxy_blank_prefix_disables() {
        set_institution_proxy(InstitutionProxyKind::EzProxy, "  ", "cookie");
        assert!(institution_proxy().is_none());
        // Bare origin gets the EZProxy `/login?url=` convention appended.
        set_institution_proxy(
            InstitutionProxyKind::EzProxy,
            "https://webvpn.example.edu/",
            " c ",
        );
        assert_eq!(
            institution_proxy(),
            Some(InstitutionProxyConf {
                kind: InstitutionProxyKind::EzProxy,
                prefix: "https://webvpn.example.edu/login?url=".to_string(),
                cookie: "c".to_string(),
            })
        );
        set_institution_proxy(InstitutionProxyKind::EzProxy, "", "");
    }

    #[test]
    fn parse_institution_proxy_settings_reads_camel_case_keys() {
        // wengine gateway (ZJU-style): bare origin + session cookie.
        let parsed = parse_institution_proxy_settings(
            r#"{"institutionProxyPrefix":"https://webvpn.zju.edu.cn","institutionProxyCookie":"S=1","institutionProxyType":"wengine"}"#,
        );
        assert_eq!(
            parsed,
            Some((
                InstitutionProxyKind::Wengine,
                "https://webvpn.zju.edu.cn".to_string(),
                "S=1".to_string(),
            ))
        );
        // Unknown/absent type falls back to EZProxy; missing prefix stays empty.
        assert_eq!(
            parse_institution_proxy_settings(r#"{"institutionProxyPrefix":""}"#),
            Some((InstitutionProxyKind::EzProxy, String::new(), String::new()))
        );
        // Malformed JSON is ignored rather than panicking.
        assert!(parse_institution_proxy_settings("not json").is_none());
    }

    /// 2000 × 8KB chunks of a 16MB known-size download at the same instant
    /// (time gate never opens) must be capped by percent moves: ≤ ~100 emits
    /// plus one unconditional completion event.
    #[test]
    fn progress_throttle_caps_known_size_chunk_storm() {
        let mut throttle = ProgressThrottle::new(PROGRESS_EMIT_INTERVAL);
        let now = std::time::Instant::now();
        let total: u64 = 2000 * 8 * 1024;
        let mut downloaded: u64 = 0;
        let mut emits = 0usize;
        for _ in 0..2000 {
            downloaded += 8 * 1024;
            let percent = Some(((downloaded * 100 / total).min(100)) as u8);
            if throttle.should_emit(now, percent) {
                emits += 1;
            }
        }
        // Final event bypasses the throttle in http_get_bytes_with_progress.
        let final_emits = emits + 1;
        assert!(
            final_emits <= 102,
            "expected ≤102 emits for 2000 chunks, got {final_emits}"
        );
        assert!(final_emits >= 50, "throttle must not starve the task bar");
        println!("throttled 2000 progress callbacks to {final_emits} emits (incl. final)");
    }

    /// Unknown content-length downloads fall back to the time gate: at most
    /// one emit per interval.
    #[test]
    fn progress_throttle_time_gates_unknown_size() {
        let mut throttle = ProgressThrottle::new(Duration::from_millis(100));
        let start = std::time::Instant::now();
        let mut emits = 0usize;
        for i in 0..2000u64 {
            // 2000 chunks arriving over 2 seconds.
            let now = start + Duration::from_millis(i);
            if throttle.should_emit(now, None) {
                emits += 1;
            }
        }
        assert!(
            emits <= 21,
            "expected ≤21 time-gated emits over 2s, got {emits}"
        );
        assert!(emits >= 1, "first sample must emit");
    }

    /// The first sample always emits so the task bar leaves 'queued' quickly.
    #[test]
    fn progress_throttle_first_sample_emits() {
        let mut throttle = ProgressThrottle::new(PROGRESS_EMIT_INTERVAL);
        assert!(throttle.should_emit(std::time::Instant::now(), Some(0)));
    }

    /// A finished concurrent stream must not pin the shared row at 100% while
    /// the other one is still fetching (TeX used to land first and freeze the
    /// bar above a PDF that was only 60% downloaded).
    #[test]
    fn merged_progress_stays_below_100_while_a_stream_runs() {
        let slots = vec![
            ProgressSlot {
                downloaded: 1024,
                total: Some(1024),
                finished: true,
            },
            ProgressSlot {
                downloaded: 352,
                total: Some(586),
                finished: false,
            },
        ];
        let (downloaded, total, percent) = merged_progress(&slots);
        assert_eq!(downloaded, 1376);
        assert_eq!(total, Some(1610));
        assert_eq!(percent, Some(85));
    }

    /// Guessing at a running stream's size would let the other one read 100%,
    /// so an unknown `Content-Length` keeps the merged total unknown instead.
    #[test]
    fn merged_progress_is_indeterminate_while_a_size_is_unknown() {
        let slots = vec![
            ProgressSlot {
                downloaded: 1024,
                total: Some(1024),
                finished: true,
            },
            ProgressSlot {
                downloaded: 64,
                total: None,
                finished: false,
            },
        ];
        assert_eq!(merged_progress(&slots), (1088, None, None));
    }

    /// Once a stream settles, whatever it received is all there is: it stops
    /// holding the merged total back.
    #[test]
    fn merged_progress_counts_a_settled_stream_of_unknown_size() {
        let slots = vec![ProgressSlot {
            downloaded: 40,
            total: None,
            finished: true,
        }];
        assert_eq!(merged_progress(&slots), (40, Some(40), Some(100)));
    }

    /// A DOI-only import has no TeX stream, so the PDF alone must span the
    /// whole bar instead of stalling at 50%.
    #[test]
    fn merged_progress_single_stream_spans_the_whole_bar() {
        let running = vec![ProgressSlot {
            downloaded: 293,
            total: Some(586),
            finished: false,
        }];
        assert_eq!(merged_progress(&running).2, Some(50));

        let done = vec![ProgressSlot {
            downloaded: 586,
            total: Some(586),
            finished: true,
        }];
        assert_eq!(merged_progress(&done).2, Some(100));
    }

    /// Force a payload without an `AppHandle`, bypassing the throttle.
    fn sample(agg: &AssetProgressAggregator<'_>) -> AssetDownloadProgress {
        let mut state = agg.lock();
        agg.sample(&mut state, true).expect("task id present")
    }

    /// The reported regression, through the real slot bookkeeping: TeX settles
    /// first, and the shared row must keep tracking the PDF's remaining bytes
    /// instead of claiming 100% above "PDF · 352 KB / 586 KB".
    #[test]
    fn aggregator_merges_concurrent_streams_without_overshooting() {
        let agg = AssetProgressAggregator::new(None, Some("job-1"), "assets", 2);
        let (pdf, tex) = (agg.stream(0), agg.stream(1));

        pdf.restart();
        tex.restart();
        pdf.report(0, Some(586));
        tex.report(0, Some(1024));
        tex.report(1024, Some(1024));
        tex.finish();
        pdf.report(352, Some(586));

        let payload = sample(&agg);
        assert_eq!(payload.phase, "assets");
        assert_eq!(payload.task_id, "job-1");
        assert_eq!(payload.downloaded_bytes, 1376);
        assert_eq!(payload.total_bytes, Some(1610));
        assert_eq!(payload.progress, Some(85));

        // The bar and the byte detail stay in agreement until the PDF lands.
        pdf.report(586, Some(586));
        pdf.finish();
        assert_eq!(sample(&agg).progress, Some(100));
    }

    /// Each PDF candidate URL counts its bytes from zero, so an attempt that
    /// failed mid-body cannot inflate the merged total.
    #[test]
    fn aggregator_restarts_the_byte_count_for_each_pdf_candidate() {
        let agg = AssetProgressAggregator::new(None, Some("job-1"), "assets", 2);
        let (pdf, tex) = (agg.stream(0), agg.stream(1));

        pdf.restart();
        pdf.report(300, Some(586));
        tex.restart();
        tex.report(512, Some(1024));

        pdf.restart();
        pdf.report(100, Some(400));

        let payload = sample(&agg);
        assert_eq!(payload.downloaded_bytes, 612);
        assert_eq!(payload.total_bytes, Some(1424));
        assert_eq!(payload.progress, Some(42));
    }

    #[test]
    fn sanitize_rejects_parent() {
        assert!(sanitize_tar_path(Path::new("../evil")).is_err());
        assert!(sanitize_tar_path(Path::new("/abs")).is_err());
        assert_eq!(
            sanitize_tar_path(Path::new("a/b.tex")).unwrap(),
            PathBuf::from("a/b.tex")
        );
    }

    #[test]
    fn unpack_plain_and_gzipped_tex() {
        let paper = std::env::temp_dir().join(format!("agentero-paper-{}", std::process::id()));
        let source = paper.join("source");
        let _ = fs::remove_dir_all(&paper);
        fs::create_dir_all(&source).unwrap();

        let tex = b"\\documentclass{article}\\begin{document}Hi\\end{document}";
        unpack_arxiv_eprint(&source, &paper, "1706.03762", tex).unwrap();
        assert!(source.join("1706.03762.tex").exists());

        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(b"\\documentclass{article}\n").unwrap();
        let gz = enc.finish().unwrap();
        unpack_arxiv_eprint(&source, &paper, "1234.5678", &gz).unwrap();
        assert!(source.join("1234.5678.tex").exists());

        let _ = fs::remove_dir_all(&paper);
    }

    #[test]
    fn unpack_pdf_only_eprint_to_paper_root() {
        let paper =
            std::env::temp_dir().join(format!("agentero-pdf-eprint-{}", std::process::id()));
        let source = paper.join("source");
        let _ = fs::remove_dir_all(&paper);
        fs::create_dir_all(&source).unwrap();

        let mut pdf = b"%PDF-1.4".to_vec();
        pdf.extend_from_slice(&[0u8; 64]);
        unpack_arxiv_eprint(&source, &paper, "1412.6980", &pdf).unwrap();
        assert!(paper.join("1412.6980.pdf").exists());
        assert!(!source.join("1412.6980.pdf").exists());

        let _ = fs::remove_dir_all(&paper);
    }

    #[test]
    fn rejects_error_pages_and_corrupt_archives_without_publishing_partial_tex() {
        let paper = tempfile::tempdir().unwrap();
        let source = paper.path().join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("layout.json"), "KEEP-SIDECAR").unwrap();
        assert!(unpack_arxiv_eprint(
            &source,
            paper.path(),
            "1706.03762",
            b"<html>Unavailable</html>"
        )
        .is_err());
        let mut builder = tar::Builder::new(Vec::new());
        let tex = b"\\documentclass{article}\\begin{document}Body\\end{document}";
        let mut header = tar::Header::new_gnu();
        header.set_size(tex.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "main.tex", Cursor::new(tex))
            .unwrap();
        let mut broken = builder.into_inner().unwrap();
        broken.truncate(1024);
        broken.extend_from_slice(&[b'x'; 512]);
        assert!(unpack_arxiv_eprint(&source, paper.path(), "1706.03762", &broken).is_err());
        assert!(!source.join("main.tex").exists());
        assert!(!source.join("1706.03762.tex").exists());
        assert_eq!(
            fs::read_to_string(source.join("layout.json")).unwrap(),
            "KEEP-SIDECAR"
        );
    }

    #[test]
    fn gzipped_pdf_is_pdf_only_and_valid_tar_preserves_user_sources() {
        let paper = tempfile::tempdir().unwrap();
        let source = paper.path().join("source");
        fs::create_dir_all(&source).unwrap();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(b"%PDF-1.4 test").unwrap();
        unpack_arxiv_eprint(
            &source,
            paper.path(),
            "1706.03762",
            &encoder.finish().unwrap(),
        )
        .unwrap();
        assert!(paper.path().join("1706.03762.pdf").is_file());
        assert!(!probe_paper_caps(paper.path()).has_tex);
        let mut builder = tar::Builder::new(Vec::new());
        let tex = b"\\documentclass{article}\\begin{document}Body\\end{document}";
        let mut header = tar::Header::new_gnu();
        header.set_size(tex.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "main.tex", Cursor::new(tex))
            .unwrap();
        let archive = builder.into_inner().unwrap();
        unpack_arxiv_eprint(&source, paper.path(), "1706.03762", &archive).unwrap();
        assert!(probe_paper_caps(paper.path()).has_tex);
        fs::write(source.join("main.tex"), "USER EDIT").unwrap();
        assert!(unpack_arxiv_eprint(&source, paper.path(), "1706.03762", &archive).is_err());
        assert_eq!(
            fs::read_to_string(source.join("main.tex")).unwrap(),
            "USER EDIT"
        );
    }

    #[test]
    fn pdf_candidates_include_arxiv() {
        let c = pdf_url_candidates(
            "1412.6980",
            Some("1412.6980"),
            Some("https://arxiv.org/pdf/1412.6980"),
        );
        assert!(c.iter().any(|u| u.contains("arxiv.org/pdf/1412.6980")));
        assert!(c.len() >= 2);
    }

    #[test]
    fn unversioned_arxiv_without_stamp_downloads_latest() {
        assert_eq!(
            resolve_eprint_request("2505.02387", None).as_deref(),
            Ok("2505.02387")
        );
        assert_eq!(
            resolve_eprint_request("2505.02387", Some("2505.02387v4")).as_deref(),
            Ok("2505.02387v4")
        );
        assert_eq!(
            resolve_eprint_request("2505.02387v4", None).as_deref(),
            Ok("2505.02387v4")
        );
        assert!(resolve_eprint_request("2505.02387v1", Some("2505.02387v4")).is_err());
        assert!(is_retired_unversioned_stamp_refusal(
            "Cannot determine the local PDF's arXiv version; set a versioned arXiv PDF/source URL before supplementing LaTeX"
        ));
    }

    #[test]
    fn looks_like_arxiv_id_basic() {
        assert!(looks_like_arxiv_id("1412.6980"));
        assert!(looks_like_arxiv_id("1706.03762"));
        assert!(!looks_like_arxiv_id("not-an-id"));
    }

    #[test]
    fn pdf_only_eprint_does_not_overwrite_existing_pdf() {
        let paper = std::env::temp_dir().join(format!(
            "agentero-pdf-race-{}-{}-existing",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let source = paper.join("source");
        let _ = fs::remove_dir_all(&paper);
        fs::create_dir_all(&source).unwrap();

        let existing_pdf = paper.join("1412.6980.pdf");
        fs::write(&existing_pdf, b"%PDF existing").unwrap();

        let eprint_pdf = b"%PDF e-print";
        unpack_arxiv_eprint(&source, &paper, "1412.6980", eprint_pdf).unwrap();

        // Existing PDF must remain; e-print PDF should have been discarded.
        assert_eq!(fs::read(&existing_pdf).unwrap(), b"%PDF existing");
        fs::remove_dir_all(&paper).ok();
    }

    #[test]
    fn pdf_only_eprint_writes_when_no_existing_pdf() {
        let paper = std::env::temp_dir().join(format!(
            "agentero-pdf-race-{}-{}-new",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let source = paper.join("source");
        let _ = fs::remove_dir_all(&paper);
        fs::create_dir_all(&source).unwrap();

        let eprint_pdf = b"%PDF e-print";
        unpack_arxiv_eprint(&source, &paper, "1412.6980", eprint_pdf).unwrap();

        let written = paper.join("1412.6980.pdf");
        assert!(written.exists());
        assert_eq!(fs::read(&written).unwrap(), eprint_pdf);
        fs::remove_dir_all(&paper).ok();
    }

    #[test]
    fn carsi_cookie_map_merges_multiple_publishers_and_resolves_by_host() {
        assert_eq!(
            InstitutionProxyKind::from_setting("carsi"),
            InstitutionProxyKind::Carsi
        );
        let m1 = merge_carsi_cookie_map(
            "",
            &[("dl.acm.org".into(), "cf_clearance=1; JSESSIONID=a".into())],
        );
        let m2 = merge_carsi_cookie_map(
            &m1,
            &[("ieeexplore.ieee.org".into(), "ERIGHTS=ieee_sess".into())],
        );
        assert_eq!(
            cookie_for_url(&m2, "https://dl.acm.org/doi/pdf/10.1145/3832783.3832800"),
            "cf_clearance=1; JSESSIONID=a"
        );
        assert_eq!(
            cookie_for_url(
                &m2,
                "https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=10123456&ref="
            ),
            "ERIGHTS=ieee_sess"
        );
        assert_eq!(
            cookie_for_url(&m2, "https://link.springer.com/article/10.1007/s10664"),
            ""
        );
        // Plain cookie strings stay backward-compatible across all URLs.
        assert_eq!(
            cookie_for_url(
                "wengine_vpn_ticket=abc",
                "https://webvpn.zju.edu.cn/https/777264/"
            ),
            "wengine_vpn_ticket=abc"
        );
    }

    #[test]
    fn publisher_pdf_targets_and_abstract_extractors_cover_acm_ieee_springer() {
        assert_eq!(
            publisher_direct_pdf_targets("10.1145/3832783.3832801"),
            vec!["https://dl.acm.org/doi/pdf/10.1145/3832783.3832801"]
        );
        assert_eq!(
            publisher_direct_pdf_targets("10.1007/978-3-032-40374-2_5"),
            vec!["https://link.springer.com/content/pdf/10.1007/978-3-032-40374-2_5.pdf"]
        );
        let ieee_mined = publisher_mined_pdf_targets(
            "10.1109/SP63933.2026.00012",
            "https://ieeexplore.ieee.org/document/10987654/",
            "",
        );
        assert_eq!(
            ieee_mined,
            vec!["https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=10987654&ref="]
        );

        let springer_html = r#"<section data-title="Abstract"><div id="Abs1-content"><p>Static analysis scales to million-line programs via modular abstract interpretation.</p></div></section>"#;
        assert_eq!(
            extract_publisher_abstract_from_html(springer_html).as_deref(),
            Some("Static analysis scales to million-line programs via modular abstract interpretation.")
        );

        let ieee_html = r#"<script>xplGlobal.document.metadata={"articleNumber":"10987654","abstract":"Automated program repair for concurrent Rust systems using ownership-guided synthesis."};</script>"#;
        assert_eq!(
            extract_publisher_abstract_from_html(ieee_html).as_deref(),
            Some("Automated program repair for concurrent Rust systems using ownership-guided synthesis.")
        );
    }
}
