//! OpenAlex API source.

use async_trait::async_trait;
use serde_json::Value;

use crate::features::scholar_api::client;
use crate::features::scholar_api::identifiers::{extract_arxiv_id, strip_arxiv_version};
use crate::features::scholar_api::traits::AcademicApi;
use crate::features::scholar_api::{
    ApiCapability, ApiError, ApiPaper, ApiQuery, PaperIdentifiers, PaperUrls,
};

const SOURCE: &str = "openalex";
const API_BASE: &str = "https://api.openalex.org/works";
const MAILTO: &str = "agentero@users.noreply.github.com";
const SELECT_FIELDS: &str = "title,display_name,publication_year,publication_date,doi,ids,authorships,primary_location,open_access,biblio,cited_by_count,abstract_inverted_index,id";

/// Polite-pool contact for OpenAlex requests. `OPENALEX_MAILTO` (a real
/// contact address) overrides the project default so users join the polite
/// pool under their own identity. Pure so the override is unit-testable.
fn mailto(env_override: Option<&str>) -> String {
    env_override
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(MAILTO)
        .to_string()
}

fn env_mailto() -> String {
    mailto(std::env::var("OPENALEX_MAILTO").ok().as_deref())
}

/// OpenAlex metadata source.
#[derive(Debug, Clone, Default)]
pub struct OpenAlexApi;

#[async_trait]
impl AcademicApi for OpenAlexApi {
    fn name(&self) -> &'static str {
        SOURCE
    }

    fn capabilities(&self) -> ApiCapability {
        ApiCapability::SEARCH_BY_TITLE
            | ApiCapability::FETCH_BY_DOI
            | ApiCapability::PROVIDE_ABSTRACT
            | ApiCapability::PROVIDE_CITATION_COUNT
            | ApiCapability::PROVIDE_VENUE
    }

    fn priority(&self) -> i32 {
        80
    }

    async fn fetch(&self, query: &ApiQuery) -> Result<Vec<ApiPaper>, ApiError> {
        match query {
            ApiQuery::Title(title) => search_by_title(title, 5).await,
            ApiQuery::Doi(doi) => fetch_by_doi(doi).await.map(|p| vec![p]),
            _ => Err(ApiError::UnsupportedQuery(query.clone())),
        }
    }
}

async fn fetch_by_doi(doi: &str) -> Result<ApiPaper, ApiError> {
    let url = format!(
        "{API_BASE}/doi:{}?select={SELECT_FIELDS}&mailto={}",
        urlencoding::encode(doi.trim()),
        env_mailto()
    );
    let value = client::get_json(&url).await?;
    map_work(&value).ok_or(ApiError::NotFound)
}

async fn search_by_title(title: &str, limit: usize) -> Result<Vec<ApiPaper>, ApiError> {
    let url = format!(
        "{API_BASE}?search={}&per_page={}&select={SELECT_FIELDS}&mailto={}",
        urlencoding::encode(title),
        limit,
        env_mailto()
    );
    let value = client::get_json(&url).await?;
    let Some(items) = value.get("results").and_then(|v| v.as_array()) else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for item in items {
        if let Some(paper) = map_work(item) {
            out.push(paper);
        }
    }
    Ok(out)
}

fn map_work(work: &Value) -> Option<ApiPaper> {
    let title = work
        .get("display_name")
        .or_else(|| work.get("title"))
        .and_then(|v| v.as_str())?
        .to_string();

    let authors: Vec<String> = work
        .get("authorships")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    a.get("author")
                        .and_then(|auth| auth.get("display_name"))
                        .and_then(|v| v.as_str())
                })
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    let year = work
        .get("publication_year")
        .and_then(|v| v.as_i64())
        .map(|y| y as i32);

    let doi = work
        .get("doi")
        .and_then(|v| v.as_str())
        .map(|s| s.trim_start_matches("https://doi.org/").trim().to_string())
        .filter(|s| !s.is_empty());

    let arxiv_id = work
        .pointer("/ids/arxiv")
        .and_then(|v| v.as_str())
        .and_then(extract_arxiv_id)
        .or_else(|| {
            doi.as_deref().and_then(|d| {
                d.to_ascii_lowercase()
                    .strip_prefix("10.48550/arxiv.")
                    .map(String::from)
            })
        })
        .map(|id| strip_arxiv_version(&id));

    let venue = work
        .pointer("/primary_location/source/display_name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| {
            work.pointer("/biblio/venue")
                .and_then(|v| v.as_str())
                .map(String::from)
        });

    let volume = work
        .pointer("/biblio/volume")
        .and_then(|v| v.as_str())
        .map(String::from);
    let issue = work
        .pointer("/biblio/issue")
        .and_then(|v| v.as_str())
        .map(String::from);
    let pages = work.get("biblio").and_then(pages_from_biblio);
    let abstract_text = work
        .get("abstract_inverted_index")
        .and_then(reconstruct_abstract);

    let landing = work
        .pointer("/primary_location/landing_page_url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let pdf = work
        .pointer("/primary_location/pdf_url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| {
            work.pointer("/open_access/oa_url")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|u| {
                    let lower = u.to_ascii_lowercase();
                    lower.ends_with(".pdf") || lower.contains(".pdf?") || lower.contains("/pdf/")
                })
                .map(String::from)
        });

    Some(ApiPaper {
        identifiers: PaperIdentifiers {
            doi,
            arxiv_id,
            isbn: None,
            pmid: None,
        },
        title,
        authors,
        year,
        date: work
            .get("publication_date")
            .and_then(|v| v.as_str())
            .map(String::from)
            .or_else(|| year.map(|y| format!("{y:04}"))),
        venue,
        volume,
        issue,
        pages,
        publisher: None,
        abstract_text,
        urls: PaperUrls {
            pdf,
            html: None,
            landing,
        },
        citation_count: work.get("cited_by_count").and_then(|v| v.as_i64()),
        language: None,
        source: SOURCE,
        raw: None,
    })
}

fn reconstruct_abstract(inverted: &Value) -> Option<String> {
    let obj = inverted.as_object()?;
    if obj.is_empty() {
        return None;
    }
    let mut positioned: Vec<(usize, &str)> = Vec::new();
    for (token, indices) in obj {
        let word = token.trim();
        if word.is_empty() {
            continue;
        }
        let Some(arr) = indices.as_array() else {
            continue;
        };
        for pos in arr.iter().filter_map(|v| v.as_u64()) {
            let idx = pos as usize;
            if idx <= 20_000 {
                positioned.push((idx, word));
            }
        }
    }
    if positioned.is_empty() {
        return None;
    }
    positioned.sort_by_key(|(idx, _)| *idx);
    positioned.dedup_by_key(|(idx, _)| *idx);
    let text = positioned
        .into_iter()
        .map(|(_, w)| w)
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn pages_from_biblio(biblio: &Value) -> Option<String> {
    let first = biblio.get("first_page").and_then(|v| v.as_str())?;
    let last = biblio.get("last_page").and_then(|v| v.as_str());
    match last {
        Some(last) if !last.is_empty() && last != first => Some(format!("{first}--{last}")),
        _ => Some(first.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mailto_falls_back_to_project_default() {
        assert_eq!(mailto(None), "agentero@users.noreply.github.com");
        assert_eq!(mailto(Some("  ")), "agentero@users.noreply.github.com");
    }

    #[test]
    fn mailto_prefers_env_override() {
        assert_eq!(mailto(Some(" me@example.org ")), "me@example.org");
    }

    #[test]
    fn maps_openalex_work() {
        let work = json!({
            "display_name": "Attention Is All You Need",
            "publication_year": 2017,
            "doi": "https://doi.org/10.48550/arXiv.1706.03762",
            "authorships": [
                { "author": { "display_name": "Ashish Vaswani" } }
            ],
            "primary_location": {
                "source": { "display_name": "Neural Information Processing Systems" }
            },
            "biblio": {
                "volume": "30",
                "first_page": "5998",
                "last_page": "6008"
            }
        });
        let paper = map_work(&work).expect("mapped");
        assert_eq!(paper.title, "Attention Is All You Need");
        assert_eq!(paper.year, Some(2017));
        assert_eq!(
            paper.venue.as_deref(),
            Some("Neural Information Processing Systems")
        );
        assert_eq!(paper.pages.as_deref(), Some("5998--6008"));
    }

    #[test]
    fn maps_citation_count() {
        let work = json!({
            "id": "https://openalex.org/W2741809807",
            "display_name": "Attention Is All You Need",
            "publication_year": 2017,
            "doi": "https://doi.org/10.48550/arXiv.1706.03762",
            "cited_by_count": 121363
        });
        let paper = map_work(&work).expect("mapped");
        assert_eq!(paper.citation_count, Some(121_363));

        let without = json!({
            "id": "https://openalex.org/W2741809807",
            "display_name": "Attention Is All You Need"
        });
        assert_eq!(map_work(&without).expect("mapped").citation_count, None);
    }

    #[test]
    fn maps_inverted_abstract_arxiv_and_oa_pdf() {
        let work = json!({
            "display_name": "Doc2Test: An Industrial Multi-agent Framework",
            "publication_year": 2026,
            "publication_date": "2026-10-12",
            "doi": "https://doi.org/10.1145/3832783.3834507",
            "ids": {
                "arxiv": "https://arxiv.org/abs/2607.01234v2"
            },
            "primary_location": {
                "landing_page_url": "https://doi.org/10.1145/3832783.3834507",
                "pdf_url": null
            },
            "open_access": {
                "oa_url": "https://arxiv.org/pdf/2607.01234.pdf"
            },
            "abstract_inverted_index": {
                "We": [0],
                "present": [1],
                "Doc2Test": [2],
                "for": [3],
                "Selenium": [4],
                "testing.": [5]
            }
        });
        let paper = map_work(&work).expect("mapped");
        assert_eq!(
            paper.abstract_text.as_deref(),
            Some("We present Doc2Test for Selenium testing.")
        );
        assert_eq!(paper.identifiers.arxiv_id.as_deref(), Some("2607.01234"));
        assert_eq!(
            paper.urls.pdf.as_deref(),
            Some("https://arxiv.org/pdf/2607.01234.pdf")
        );
        assert_eq!(
            paper.urls.landing.as_deref(),
            Some("https://doi.org/10.1145/3832783.3834507")
        );
    }
}
