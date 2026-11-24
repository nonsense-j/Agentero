//! XDG `collection.sqlite` schema, migrations, and default seeds.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use rusqlite::{params, Connection};

use crate::error::AppError;
use crate::paths;
use crate::sqlite::{DbMsgs, MigrationStep};

pub const SCHEMA_VERSION: i32 = 4;

pub const DEFAULT_ARXIV_CATEGORIES_JSON: &str = r#"["cs.SE","cs.CR","cs.PL"]"#;
pub const DEFAULT_WORD_CLOUD_TOP_N: usize = 50;
pub const MIN_WORD_CLOUD_TOP_N: usize = 15;
pub const MAX_WORD_CLOUD_TOP_N: usize = 150;

pub struct DefaultVenueSeed {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    pub tracks: &'static [&'static str],
    pub kind: &'static str,
    pub domain: &'static str,
    pub ccf_rank: &'static str,
}

/// Complete 2026 Venue catalog (28 CCF-A / CCF-B venues across PL/SE, CR, and AI).
pub const DEFAULT_VENUES: &[DefaultVenueSeed] = &[
    // 1a. PL/SE Conferences — CCF-A
    DefaultVenueSeed {
        id: "ase-2026",
        name: "ASE 2026",
        url: "https://conf.researchr.org/home/ase-2026",
        tracks: &["https://conf.researchr.org/track/ase-2026/ase-2026-research-track"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "icse-2026",
        name: "ICSE 2026",
        url: "https://conf.researchr.org/home/icse-2026",
        tracks: &["https://conf.researchr.org/track/icse-2026/icse-2026-research-track"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "issta-2026",
        name: "ISSTA 2026",
        url: "https://conf.researchr.org/home/issta-2026",
        tracks: &["https://conf.researchr.org/track/issta-2026/issta-2026-research-papers"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "fse-2026",
        name: "FSE 2026",
        url: "https://conf.researchr.org/home/fse-2026",
        tracks: &["https://conf.researchr.org/track/fse-2026/fse-2026-research-papers"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "pldi-2026",
        name: "PLDI 2026",
        url: "https://pldi26.sigplan.org",
        tracks: &["https://pldi26.sigplan.org/track/pldi-2026-papers"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "popl-2026",
        name: "POPL 2026",
        url: "https://popl26.sigplan.org",
        tracks: &["https://popl26.sigplan.org/track/POPL-2026-popl-research-papers"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "oopsla-2026",
        name: "OOPSLA 2026",
        url: "https://2026.splashcon.org",
        tracks: &["https://2026.splashcon.org/track/oopsla-2026"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
    },
    // 1a. PL/SE Conferences — CCF-B
    DefaultVenueSeed {
        id: "ecoop-2026",
        name: "ECOOP 2026",
        url: "https://2026.ecoop.org",
        tracks: &["https://2026.ecoop.org/track/ecoop-2026-technical-papers"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
    },
    DefaultVenueSeed {
        id: "icpc-2026",
        name: "ICPC 2026",
        url: "https://conf.researchr.org/home/icpc-2026",
        tracks: &["https://conf.researchr.org/track/icpc-2026/icpc-2026-research"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
    },
    DefaultVenueSeed {
        id: "re-2026",
        name: "RE 2026",
        url: "https://conf.researchr.org/home/RE-2026",
        tracks: &["https://conf.researchr.org/track/RE-2026/RE-2026-Research-Papers"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
    },
    DefaultVenueSeed {
        id: "saner-2026",
        name: "SANER 2026",
        url: "https://conf.researchr.org/home/saner-2026",
        tracks: &["https://conf.researchr.org/track/saner-2026/saner-2026-papers"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
    },
    DefaultVenueSeed {
        id: "icsme-2026",
        name: "ICSME 2026",
        url: "https://conf.researchr.org/home/icsme-2026",
        tracks: &["https://conf.researchr.org/track/icsme-2026/icsme-2026-papers"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
    },
    DefaultVenueSeed {
        id: "sas-2026",
        name: "SAS 2026",
        url: "https://2026.splashcon.org/home/sas-2026",
        tracks: &["https://2026.splashcon.org/track/sas-2026-papers"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
    },
    DefaultVenueSeed {
        id: "esem-2026",
        name: "ESEM 2026",
        url: "https://conf.researchr.org/home/eseiw-2026",
        tracks: &["https://conf.researchr.org/track/eseiw-2026/eseiw-2026-esem---technical-track"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
    },
    DefaultVenueSeed {
        id: "issre-2026",
        name: "ISSRE 2026",
        url: "https://cyprusconferences.org/issre2026/",
        tracks: &["https://cyprusconferences.org/issre2026/accepted-papers/"],
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
    },
    // 1b. PL/SE Journals — CCF-A & CCF-B
    DefaultVenueSeed {
        id: "tse-2026",
        name: "TSE 2026",
        url: "https://www.computer.org/csdl/journal/ts",
        tracks: &[],
        kind: "journal",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "tosem-2026",
        name: "TOSEM 2026",
        url: "https://dl.acm.org/journal/tosem",
        tracks: &[],
        kind: "journal",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "ase-journal-2026",
        name: "ASE (J) 2026",
        url: "https://link.springer.com/journal/10515",
        tracks: &[],
        kind: "journal",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
    },
    DefaultVenueSeed {
        id: "ese-2026",
        name: "ESE 2026",
        url: "https://link.springer.com/journal/10664",
        tracks: &[],
        kind: "journal",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
    },
    // 2. CR Conferences — CCF-A
    DefaultVenueSeed {
        id: "ccs-2026",
        name: "CCS 2026",
        url: "https://www.sigsac.org/ccs/CCS2026/",
        tracks: &["https://www.sigsac.org/ccs/CCS2026/program/schedule.html"],
        kind: "conference",
        domain: "CR",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "sp-2026",
        name: "S&P 2026",
        url: "https://sp2026.ieee-security.org/",
        tracks: &["https://sp2026.ieee-security.org/accepted-papers.html"],
        kind: "conference",
        domain: "CR",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "usenix-sec-2026",
        name: "USENIX Security 2026",
        url: "https://www.usenix.org/conference/usenixsecurity26",
        tracks: &["https://www.usenix.org/conference/usenixsecurity26/technical-sessions"],
        kind: "conference",
        domain: "CR",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "ndss-2026",
        name: "NDSS 2026",
        url: "https://www.ndss-symposium.org/ndss2026/",
        tracks: &["https://www.ndss-symposium.org/ndss2026/accepted-papers/"],
        kind: "conference",
        domain: "CR",
        ccf_rank: "CCF-A",
    },
    // 3. AI Conferences — CCF-A
    DefaultVenueSeed {
        id: "aaai-2026",
        name: "AAAI 2026",
        url: "https://aaai.org/conference/aaai/aaai-26/",
        tracks: &["https://ojs.aaai.org/index.php/AAAI/issue/archive"],
        kind: "conference",
        domain: "AI",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "neurips-2026",
        name: "NeurIPS 2026",
        url: "https://neurips.cc/Conferences/2026",
        tracks: &["https://neurips.cc/virtual/2026/papers.html"],
        kind: "conference",
        domain: "AI",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "acl-2026",
        name: "ACL 2026",
        url: "https://2026.aclweb.org/",
        tracks: &[
            "https://2026.aclweb.org/program/accepted_papers/",
            "https://aclanthology.org/volumes/2026.acl-long/",
            "https://aclanthology.org/volumes/2026.acl-short/",
        ],
        kind: "conference",
        domain: "AI",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "iclr-2026",
        name: "ICLR 2026",
        url: "https://iclr.cc/Conferences/2026",
        tracks: &["https://iclr.cc/virtual/2026/papers.html"],
        kind: "conference",
        domain: "AI",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "icml-2026",
        name: "ICML 2026",
        url: "https://icml.cc/Conferences/2026",
        tracks: &["https://icml.cc/virtual/2026/papers.html"],
        kind: "conference",
        domain: "AI",
        ccf_rank: "CCF-A",
    },
];

pub const DEFAULT_RECOMMEND_KEYWORDS: &[(&str, &str, bool)] = &[
    ("kw-ai-agent", "AI Agent", true),
    ("kw-program-analysis", "Program Analysis", true),
    ("kw-vuln", "Vulnerability Detection", true),
    ("kw-fuzzing", "Fuzzing", true),
    ("kw-code-gen", "Code Generation", true),
    ("kw-verification", "Formal Verification", true),
    ("kw-repair", "Program Repair", false),
    ("kw-smart-contract", "Smart Contract", false),
];

pub const DDL_V1: &str = r#"
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_config (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  categories_json           TEXT NOT NULL DEFAULT '["cs.SE","cs.CR","cs.PL"]',
  last_refreshed_at         TEXT,
  latest_arxiv_json         TEXT,
  word_cloud_top_n          INTEGER NOT NULL DEFAULT 50,
  selected_cloud_terms_json TEXT NOT NULL DEFAULT '[]',
  last_recommended_at       TEXT
);

CREATE TABLE IF NOT EXISTS venues (
  id                  TEXT PRIMARY KEY NOT NULL,
  position            INTEGER NOT NULL DEFAULT 0,
  name                TEXT NOT NULL,
  url                 TEXT NOT NULL,
  tracks_json         TEXT NOT NULL DEFAULT '[]',
  notes               TEXT,
  mode                TEXT NOT NULL DEFAULT 'auto',
  kind                TEXT,
  domain              TEXT,
  ccf_rank            TEXT,
  last_fetched_at     TEXT,
  latest_published_at TEXT,
  remote_total_count  INTEGER
);

CREATE TABLE IF NOT EXISTS arxiv_watermarks (
  category                   TEXT PRIMARY KEY NOT NULL,
  latest_published_at        TEXT NOT NULL,
  latest_arxiv_id            TEXT NOT NULL,
  last_synced_at             TEXT NOT NULL,
  oldest_synced_published_at TEXT,
  remote_total               INTEGER,
  history_complete           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recommend_keywords (
  id         TEXT PRIMARY KEY NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  term       TEXT NOT NULL,
  normalized TEXT NOT NULL UNIQUE,
  enabled    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS papers (
  row_id          INTEGER PRIMARY KEY,
  id              TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  authors_json    TEXT NOT NULL DEFAULT '[]',
  abstract_text   TEXT NOT NULL DEFAULT '',
  published_at    TEXT NOT NULL DEFAULT '',
  published_ymd   TEXT NOT NULL DEFAULT '',
  year            INTEGER NOT NULL DEFAULT 2026,
  source_type     TEXT NOT NULL,
  source_label    TEXT NOT NULL,
  categories_json TEXT NOT NULL DEFAULT '[]',
  url             TEXT NOT NULL DEFAULT '',
  pdf_url         TEXT,
  arxiv_id        TEXT,
  arxiv_id_norm   TEXT,
  doi             TEXT,
  doi_norm        TEXT,
  title_norm      TEXT NOT NULL DEFAULT '',
  venue_id        TEXT,
  venue_kind      TEXT,
  venue_domain    TEXT,
  ccf_rank        TEXT,
  venue_full      TEXT,
  citation_count  INTEGER NOT NULL DEFAULT 0,
  keywords_json   TEXT NOT NULL DEFAULT '[]',
  keywords_text   TEXT NOT NULL DEFAULT '',
  volume          TEXT,
  issue           TEXT,
  pages           TEXT,
  bibtex          TEXT,
  cool_papers_id  TEXT,
  recommended_at  TEXT,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_papers_source_pub  ON papers(source_type, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_papers_venue_pub   ON papers(venue_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_papers_ymd_cite    ON papers(published_ymd DESC, citation_count DESC);
CREATE INDEX IF NOT EXISTS idx_papers_ccf_pub     ON papers(ccf_rank, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_papers_recommended ON papers(recommended_at);
CREATE INDEX IF NOT EXISTS idx_papers_arxiv_norm  ON papers(arxiv_id_norm) WHERE arxiv_id_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_papers_doi_norm    ON papers(doi_norm) WHERE doi_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_papers_title_norm  ON papers(title_norm) WHERE title_norm != '';

CREATE TABLE IF NOT EXISTS paper_categories (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  category TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (paper_id, category)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_paper_categories_cat ON paper_categories(category COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS paper_keywords (
  paper_id   TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  normalized TEXT NOT NULL,
  display    TEXT NOT NULL,
  PRIMARY KEY (paper_id, normalized)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_paper_keywords_norm ON paper_keywords(normalized);

CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
  title,
  keywords_text,
  abstract_text,
  content='papers',
  content_rowid='row_id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS papers_fts_ai AFTER INSERT ON papers BEGIN
  INSERT INTO papers_fts(rowid, title, keywords_text, abstract_text)
  VALUES (new.row_id, new.title, new.keywords_text, new.abstract_text);
END;

CREATE TRIGGER IF NOT EXISTS papers_fts_ad AFTER DELETE ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, keywords_text, abstract_text)
  VALUES ('delete', old.row_id, old.title, old.keywords_text, old.abstract_text);
END;

CREATE TRIGGER IF NOT EXISTS papers_fts_au AFTER UPDATE OF title, keywords_text, abstract_text ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, keywords_text, abstract_text)
  VALUES ('delete', old.row_id, old.title, old.keywords_text, old.abstract_text);
  INSERT INTO papers_fts(rowid, title, keywords_text, abstract_text)
  VALUES (new.row_id, new.title, new.keywords_text, new.abstract_text);
END;
"#;

const V2_ADD_COLUMNS: &[&str] = &[
    "ALTER TABLE collection_config ADD COLUMN seed_cleared INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE collection_config ADD COLUMN applied_seed_ids_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE papers ADD COLUMN work_id INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE papers ADD COLUMN openalex_id TEXT",
    "ALTER TABLE papers ADD COLUMN keyword_source TEXT NOT NULL DEFAULT ''",
];

pub const DDL_V2_TABLES: &str = r#"
DROP TABLE IF EXISTS citation_edges;

CREATE INDEX IF NOT EXISTS idx_papers_work_id     ON papers(work_id);
CREATE INDEX IF NOT EXISTS idx_papers_openalex_id ON papers(openalex_id) WHERE openalex_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS canonical_works (
  work_id         INTEGER PRIMARY KEY,
  openalex_id     TEXT,
  doi_norm        TEXT,
  arxiv_id_norm   TEXT,
  title_norm      TEXT,
  author_norm     TEXT,
  active_in_scope INTEGER NOT NULL DEFAULT 1,
  refs_checked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cw_openalex ON canonical_works(openalex_id) WHERE openalex_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cw_doi      ON canonical_works(doi_norm) WHERE doi_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cw_arxiv    ON canonical_works(arxiv_id_norm) WHERE arxiv_id_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cw_title    ON canonical_works(title_norm) WHERE title_norm IS NOT NULL AND title_norm != '';

CREATE TABLE IF NOT EXISTS paper_raw_refs (
  src_work_id INTEGER NOT NULL,
  ref_key     TEXT NOT NULL,
  PRIMARY KEY (src_work_id, ref_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_raw_refs_key ON paper_raw_refs(ref_key);

CREATE TABLE IF NOT EXISTS paper_citations (
  citing_work_id INTEGER NOT NULL,
  cited_work_id  INTEGER NOT NULL,
  PRIMARY KEY (citing_work_id, cited_work_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_paper_citations_cited ON paper_citations(cited_work_id);
"#;

const MIGRATION_STEPS: [MigrationStep; 4] = [
    MigrationStep::custom(1, init_v1),
    MigrationStep::custom(2, migrate_v2),
    MigrationStep::custom(3, migrate_v3),
    MigrationStep::custom(4, migrate_v4),
];

fn init_v1(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(DDL_V1)
        .map_err(|e| AppError::message(format!("collection migrate v1 ddl: {e}")))?;
    seed_defaults(conn)?;
    Ok(())
}

fn migrate_v2(conn: &Connection) -> Result<(), AppError> {
    for alter_sql in V2_ADD_COLUMNS {
        if let Err(e) = conn.execute_batch(alter_sql) {
            if !e.to_string().contains("duplicate column name") {
                return Err(AppError::message(format!(
                    "collection migrate v2 alter: {e}"
                )));
            }
        }
    }
    conn.execute_batch(DDL_V2_TABLES)
        .map_err(|e| AppError::message(format!("collection migrate v2 ddl: {e}")))?;
    super::store::migrate_v1_rows_to_v2(conn)?;
    Ok(())
}

/// v3: strip persisted arXiv RSS announcement prefixes (`arXiv:... Announce Type: ... Abstract: ...`)
/// from existing `papers.abstract_text` rows; `papers_fts_au` updates FTS5 automatically.
fn migrate_v3(conn: &Connection) -> Result<(), AppError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::message(format!("collection migrate v3 tx: {e}")))?;
    let candidates: Vec<(i64, String)> = {
        let mut stmt = tx.prepare(
            "SELECT row_id, abstract_text FROM papers
             WHERE LTRIM(abstract_text, ' ' || char(9) || char(10) || char(13)) LIKE 'arXiv:%'
                OR LTRIM(abstract_text, ' ' || char(9) || char(10) || char(13)) LIKE 'Announce%Type:%'
                OR LTRIM(abstract_text, ' ' || char(9) || char(10) || char(13)) LIKE 'Abstract:%'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if !candidates.is_empty() {
        let mut update = tx.prepare("UPDATE papers SET abstract_text = ?1 WHERE row_id = ?2")?;
        for (row_id, raw) in candidates {
            let cleaned = crate::features::paper::util::clean_arxiv_abstract(&raw);
            if cleaned != raw {
                update.execute(params![cleaned, row_id])?;
            }
        }
    }
    tx.commit()
        .map_err(|e| AppError::message(format!("collection migrate v3 commit: {e}")))?;
    Ok(())
}

fn is_artifact_description(raw: &str) -> bool {
    let lower = raw.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    let looks_like_paper = lower.contains("we propose")
        || lower.contains("we present")
        || lower.contains("we introduce")
        || lower.contains("in this paper")
        || lower.contains("this paper ");
    if looks_like_paper && lower.len() > 260 {
        return false;
    }
    lower.starts_with("artifact for ")
        || lower.starts_with("replication package for ")
        || lower.starts_with("source code for ")
        || lower.starts_with("source code and ")
        || lower.starts_with("this zenodo ")
        || lower.starts_with("zenodo ")
        || (lower.len() < 260
            && (lower.contains("10.5281/zenodo.")
                || lower.contains("zenodo.org/record")
                || lower.contains("figshare.com/")
                || lower.contains("source code repository for")))
}

fn migrate_v4_venue_tracks(tx: &Connection) -> Result<(), AppError> {
    let rows: Vec<(String, String)> = {
        let mut stmt = tx.prepare(
            "SELECT id, tracks_json FROM venues
             WHERE id IN ('issta-2026', 'ecoop-2026', 'sp-2026', 'neurips-2026', 'acl-2026', 'iclr-2026', 'icml-2026')",
        )?;
        let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        mapped.collect::<Result<Vec<_>, _>>()?
    };

    let mut update = tx.prepare("UPDATE venues SET tracks_json = ?1 WHERE id = ?2")?;
    for (id, raw_json) in rows {
        let Ok(tracks) = serde_json::from_str::<Vec<String>>(&raw_json) else {
            continue;
        };
        let next_tracks: Option<Vec<String>> = match id.as_str() {
            "issta-2026" => {
                if tracks
                    .iter()
                    .any(|t| t.trim().ends_with("/issta-2026-papers"))
                {
                    Some(
                        tracks
                            .iter()
                            .map(|t| {
                                if t.trim().ends_with("/issta-2026-papers") {
                                    "https://conf.researchr.org/track/issta-2026/issta-2026-research-papers"
                                        .to_string()
                                } else {
                                    t.clone()
                                }
                            })
                            .collect(),
                    )
                } else {
                    None
                }
            }
            "ecoop-2026" => {
                if tracks
                    .iter()
                    .any(|t| t.trim().ends_with("/ecoop-2026-papers"))
                {
                    Some(
                        tracks
                            .iter()
                            .map(|t| {
                                if t.trim().ends_with("/ecoop-2026-papers") {
                                    "https://2026.ecoop.org/track/ecoop-2026-technical-papers"
                                        .to_string()
                                } else {
                                    t.clone()
                                }
                            })
                            .collect(),
                    )
                } else {
                    None
                }
            }
            "sp-2026" => {
                if tracks
                    .iter()
                    .any(|t| t.trim().ends_with("/program-papers.html"))
                {
                    Some(
                        tracks
                            .iter()
                            .map(|t| {
                                if t.trim().ends_with("/program-papers.html") {
                                    "https://sp2026.ieee-security.org/accepted-papers.html"
                                        .to_string()
                                } else {
                                    t.clone()
                                }
                            })
                            .collect(),
                    )
                } else {
                    None
                }
            }
            "neurips-2026"
                if tracks.as_slice()
                    == ["https://openreview.net/group?id=NeurIPS.cc/2026/Conference"] =>
            {
                Some(vec![
                    "https://neurips.cc/virtual/2026/papers.html".to_string()
                ])
            }
            "iclr-2026"
                if tracks.as_slice()
                    == ["https://openreview.net/group?id=ICLR.cc/2026/Conference"] =>
            {
                Some(vec!["https://iclr.cc/virtual/2026/papers.html".to_string()])
            }
            "icml-2026"
                if tracks.as_slice()
                    == ["https://openreview.net/group?id=ICML.cc/2026/Conference"] =>
            {
                Some(vec!["https://icml.cc/virtual/2026/papers.html".to_string()])
            }
            "acl-2026"
                if tracks.as_slice()
                    == [
                        "https://aclanthology.org/volumes/2026.acl-long/",
                        "https://aclanthology.org/volumes/2026.acl-short/",
                    ] =>
            {
                Some(vec![
                    "https://2026.aclweb.org/program/accepted_papers/".to_string(),
                    "https://aclanthology.org/volumes/2026.acl-long/".to_string(),
                    "https://aclanthology.org/volumes/2026.acl-short/".to_string(),
                ])
            }
            _ => None,
        };

        if let Some(updated) = next_tracks {
            let encoded = serde_json::to_string(&updated)?;
            if encoded != raw_json {
                update.execute(params![encoded, id])?;
            }
        }
    }
    Ok(())
}

fn migrate_v4_arxiv_keys(tx: &Connection) -> Result<(), AppError> {
    let bad_refs: Vec<(i64, String)> = {
        let mut stmt = tx.prepare(
            "SELECT src_work_id, ref_key FROM paper_raw_refs WHERE ref_key LIKE 'arxiv:10.48550/%'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if !bad_refs.is_empty() {
        let mut ins = tx.prepare(
            "INSERT OR IGNORE INTO paper_raw_refs (src_work_id, ref_key) VALUES (?1, ?2)",
        )?;
        let mut del =
            tx.prepare("DELETE FROM paper_raw_refs WHERE src_work_id = ?1 AND ref_key = ?2")?;
        for (wid, old_key) in bad_refs {
            if let Some(clean_id) = super::store::clean_arxiv_key(&old_key) {
                ins.execute(params![wid, format!("arxiv:{clean_id}")])?;
                del.execute(params![wid, old_key])?;
            }
        }
    }

    let bad_cw: Vec<(i64, String)> = {
        let mut stmt = tx.prepare(
            "SELECT work_id, arxiv_id_norm FROM canonical_works WHERE arxiv_id_norm LIKE '10.48550/%'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if !bad_cw.is_empty() {
        let mut upd_cw =
            tx.prepare("UPDATE canonical_works SET arxiv_id_norm = ?1 WHERE work_id = ?2")?;
        let mut cleaned_aids = std::collections::HashSet::new();
        for (wid, old_aid) in bad_cw {
            if let Some(clean_id) = super::store::clean_arxiv_key(&old_aid) {
                upd_cw.execute(params![clean_id, wid])?;
                cleaned_aids.insert(clean_id);
            }
        }

        // Merge any canonical_works rows that now share the same cleaned arxiv_id_norm.
        for aid in cleaned_aids {
            let wids: Vec<i64> = {
                let mut stmt = tx.prepare(
                    "SELECT work_id FROM canonical_works WHERE arxiv_id_norm = ?1 ORDER BY work_id ASC",
                )?;
                let rows = stmt.query_map([aid.as_str()], |r| r.get(0))?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            if wids.len() > 1 {
                let primary_id = wids[0];
                for &sec_id in &wids[1..] {
                    tx.execute(
                        "INSERT OR IGNORE INTO paper_raw_refs (src_work_id, ref_key)
                         SELECT ?1, ref_key FROM paper_raw_refs WHERE src_work_id = ?2",
                        params![primary_id, sec_id],
                    )?;
                    tx.execute(
                        "DELETE FROM paper_raw_refs WHERE src_work_id = ?1",
                        [sec_id],
                    )?;
                    tx.execute(
                        "UPDATE papers SET work_id = ?1 WHERE work_id = ?2",
                        params![primary_id, sec_id],
                    )?;
                    tx.execute("DELETE FROM canonical_works WHERE work_id = ?1", [sec_id])?;
                }
            }
        }
    }

    let bad_papers: Vec<(i64, String)> = {
        let mut stmt = tx.prepare(
            "SELECT row_id, arxiv_id_norm FROM papers WHERE arxiv_id_norm LIKE '10.48550/%'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if !bad_papers.is_empty() {
        let mut upd_p = tx.prepare("UPDATE papers SET arxiv_id_norm = ?1 WHERE row_id = ?2")?;
        for (row_id, old_aid) in bad_papers {
            if let Some(clean_id) = super::store::clean_arxiv_key(&old_aid) {
                upd_p.execute(params![clean_id, row_id])?;
            }
        }
    }

    Ok(())
}

struct ArtifactCandidateRow {
    row_id: i64,
    source_type: String,
    doi: Option<String>,
    doi_norm: Option<String>,
    abstract_text: String,
}

fn migrate_v4_strip_artifact_dois(tx: &Connection) -> Result<(), AppError> {
    let paper_candidates: Vec<ArtifactCandidateRow> = {
        let mut stmt = tx.prepare(
            "SELECT row_id, source_type, doi, doi_norm, abstract_text
             FROM papers
             WHERE doi IS NOT NULL
                OR doi_norm IS NOT NULL
                OR LOWER(abstract_text) LIKE '%zenodo%'
                OR LOWER(abstract_text) LIKE '%figshare%'
                OR LOWER(abstract_text) LIKE '%source code%'
                OR LOWER(abstract_text) LIKE '%replication package%'
                OR LOWER(abstract_text) LIKE '%artifact%'",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ArtifactCandidateRow {
                row_id: r.get(0)?,
                source_type: r.get(1)?,
                doi: r.get(2)?,
                doi_norm: r.get(3)?,
                abstract_text: r.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if !paper_candidates.is_empty() {
        let mut clear_both = tx.prepare(
            "UPDATE papers SET doi = NULL, doi_norm = NULL, abstract_text = '' WHERE row_id = ?1",
        )?;
        let mut clear_doi =
            tx.prepare("UPDATE papers SET doi = NULL, doi_norm = NULL WHERE row_id = ?1")?;
        let mut clear_abs = tx.prepare("UPDATE papers SET abstract_text = '' WHERE row_id = ?1")?;
        for cand in paper_candidates {
            let has_artifact_doi = cand
                .doi
                .as_deref()
                .is_some_and(super::store::is_artifact_or_dataset_doi)
                || cand
                    .doi_norm
                    .as_deref()
                    .is_some_and(super::store::is_artifact_or_dataset_doi);
            let bad_abs = is_artifact_description(&cand.abstract_text);
            if has_artifact_doi {
                if cand.source_type != "arxiv" || bad_abs {
                    clear_both.execute([cand.row_id])?;
                } else {
                    clear_doi.execute([cand.row_id])?;
                }
            } else if cand.source_type != "arxiv" && bad_abs {
                clear_abs.execute([cand.row_id])?;
            }
        }
    }

    let cw_candidates: Vec<(i64, String)> = {
        let mut stmt =
            tx.prepare("SELECT work_id, doi_norm FROM canonical_works WHERE doi_norm IS NOT NULL")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if !cw_candidates.is_empty() {
        let mut upd_cw =
            tx.prepare("UPDATE canonical_works SET doi_norm = NULL WHERE work_id = ?1")?;
        for (wid, dnorm) in cw_candidates {
            if super::store::is_artifact_or_dataset_doi(&dnorm) {
                upd_cw.execute([wid])?;
            }
        }
    }

    Ok(())
}

/// v4: add `canonical_works.refs_checked_at`, repair broken default venue tracks,
/// normalize malformed `arxiv:10.48550/...` keys, strip repository/artifact DOIs,
/// and recompute citation edges.
fn migrate_v4(conn: &Connection) -> Result<(), AppError> {
    if let Err(e) =
        conn.execute_batch("ALTER TABLE canonical_works ADD COLUMN refs_checked_at TEXT")
    {
        if !e.to_string().contains("duplicate column name") {
            return Err(AppError::message(format!(
                "collection migrate v4 alter: {e}"
            )));
        }
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::message(format!("collection migrate v4 tx: {e}")))?;

    migrate_v4_venue_tracks(&tx)?;
    migrate_v4_arxiv_keys(&tx)?;
    migrate_v4_strip_artifact_dois(&tx)?;
    super::store::recompute_graph_and_citations_tx(&tx)?;

    tx.commit()
        .map_err(|e| AppError::message(format!("collection migrate v4 commit: {e}")))?;
    Ok(())
}

pub fn seed_defaults(conn: &Connection) -> Result<(), AppError> {
    conn.execute(
        "INSERT OR IGNORE INTO collection_config (id, categories_json, word_cloud_top_n, selected_cloud_terms_json)
         VALUES (1, ?1, ?2, '[]')",
        params![DEFAULT_ARXIV_CATEGORIES_JSON, DEFAULT_WORD_CLOUD_TOP_N as i64],
    )
    .map_err(|e| AppError::message(format!("collection seed config: {e}")))?;

    let venue_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM venues", [], |r| r.get(0))
        .unwrap_or(0);
    if venue_count == 0 {
        for (pos, v) in DEFAULT_VENUES.iter().enumerate() {
            let tracks_json = serde_json::to_string(v.tracks).unwrap_or_else(|_| "[]".to_string());
            conn.execute(
                "INSERT OR IGNORE INTO venues (id, position, name, url, tracks_json, mode, kind, domain, ccf_rank)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'auto', ?6, ?7, ?8)",
                params![v.id, pos as i64, v.name, v.url, tracks_json, v.kind, v.domain, v.ccf_rank],
            )
            .map_err(|e| AppError::message(format!("collection seed venue {}: {e}", v.id)))?;
        }
    }

    let kw_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM recommend_keywords", [], |r| r.get(0))
        .unwrap_or(0);
    if kw_count == 0 {
        for (pos, (id, term, enabled)) in DEFAULT_RECOMMEND_KEYWORDS.iter().enumerate() {
            let canon =
                super::keywords::canonicalize_keyword(term).unwrap_or_else(|| (*term).to_string());
            let norm = super::keywords::normalize_keyword_key(&canon);
            conn.execute(
                "INSERT OR IGNORE INTO recommend_keywords (id, position, term, normalized, enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, pos as i64, canon, norm, i64::from(*enabled)],
            )
            .map_err(|e| AppError::message(format!("collection seed keyword {id}: {e}")))?;
        }
    }
    Ok(())
}

fn set_schema_version(conn: &Connection, version: i32) -> Result<(), AppError> {
    crate::sqlite::write_schema_version(conn, version, DbMsgs::COLLECTION)
}

fn migrate(conn: &Connection) -> Result<(), AppError> {
    crate::sqlite::run_migrations(
        conn,
        DbMsgs::COLLECTION,
        SCHEMA_VERSION,
        &MIGRATION_STEPS,
        set_schema_version,
    )
}

pub fn collection_db_path() -> PathBuf {
    paths::collection_db_path()
}

const COLLECTION_BUSY_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn normalize_write_lock_key(db_path: &Path) -> PathBuf {
    let resolved = dunce::canonicalize(db_path).unwrap_or_else(|_| {
        match (db_path.parent(), db_path.file_name()) {
            (Some(parent), Some(name)) if !parent.as_os_str().is_empty() => {
                let p = dunce::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
                p.join(name)
            }
            _ => db_path.to_path_buf(),
        }
    });
    #[cfg(windows)]
    {
        PathBuf::from(resolved.to_string_lossy().to_ascii_lowercase())
    }
    #[cfg(not(windows))]
    {
        resolved
    }
}

fn collection_write_mutex(db_path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let key = normalize_write_lock_key(db_path);
    let mut map = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.retain(|_, weak| weak.strong_count() > 0);
    if let Some(existing) = map.get(&key).and_then(Weak::upgrade) {
        return existing;
    }
    let lock = Arc::new(Mutex::new(()));
    map.insert(key, Arc::downgrade(&lock));
    lock
}

fn open_collection_conn_raw(db_path: &Path) -> Result<Connection, AppError> {
    if let Some(parent) = db_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let conn = crate::sqlite::open_standard(db_path, DbMsgs::COLLECTION)?;
    let _ = conn.busy_timeout(COLLECTION_BUSY_TIMEOUT);
    Ok(conn)
}

fn ensure_collection_at_locked(db_path: &Path) -> Result<Connection, AppError> {
    let conn = open_collection_conn_raw(db_path)?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn ensure_collection() -> Result<Connection, AppError> {
    let db_path = collection_db_path();
    paths::migrate_legacy_sqlite("collection.sqlite", &db_path);
    ensure_collection_at(&db_path)
}

pub fn ensure_collection_at(db_path: &Path) -> Result<Connection, AppError> {
    if !db_path.is_file() {
        let lock = collection_write_mutex(db_path);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        return ensure_collection_at_locked(db_path);
    }
    let conn = open_collection_conn_raw(db_path)?;
    let version = crate::sqlite::read_schema_version(&conn, DbMsgs::COLLECTION).unwrap_or(0);
    if version == SCHEMA_VERSION {
        return Ok(conn);
    }
    let lock = collection_write_mutex(db_path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    migrate(&conn)?;
    Ok(conn)
}

/// Serialize in-process write transactions to the same `collection.sqlite` path so
/// concurrent Venue/arXiv refresh workers, `backfill_refs`, and `seed_sync` queue
/// cleanly instead of colliding on SQLite's `busy_timeout`.
pub(crate) fn with_collection_write_conn<T, F>(db_path: &Path, f: F) -> Result<T, AppError>
where
    F: FnOnce(&mut Connection) -> Result<T, AppError>,
{
    let lock = collection_write_mutex(db_path);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut conn = ensure_collection_at_locked(db_path)?;
    f(&mut conn)
}

pub(crate) fn with_default_collection_write_conn<T, F>(f: F) -> Result<T, AppError>
where
    F: FnOnce(&mut Connection) -> Result<T, AppError>,
{
    let db_path = collection_db_path();
    paths::migrate_legacy_sqlite("collection.sqlite", &db_path);
    with_collection_write_conn(&db_path, f)
}
