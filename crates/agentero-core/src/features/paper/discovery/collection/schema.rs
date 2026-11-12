//! XDG `collection.sqlite` schema, migrations, default seeds, and legacy cache cleanup.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Once;

use rusqlite::{params, Connection};

use crate::error::AppError;
use crate::paths;
use crate::sqlite::{DbMsgs, MigrationStep};

pub const SCHEMA_VERSION: i32 = 1;

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
        tracks: &["https://conf.researchr.org/track/issta-2026/issta-2026-papers"],
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
        tracks: &["https://2026.ecoop.org/track/ecoop-2026-papers"],
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
        tracks: &["https://sp2026.ieee-security.org/program-papers.html"],
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
        tracks: &["https://openreview.net/group?id=NeurIPS.cc/2026/Conference"],
        kind: "conference",
        domain: "AI",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "acl-2026",
        name: "ACL 2026",
        url: "https://2026.aclweb.org/",
        tracks: &[
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
        tracks: &["https://openreview.net/group?id=ICLR.cc/2026/Conference"],
        kind: "conference",
        domain: "AI",
        ccf_rank: "CCF-A",
    },
    DefaultVenueSeed {
        id: "icml-2026",
        name: "ICML 2026",
        url: "https://icml.cc/Conferences/2026",
        tracks: &["https://openreview.net/group?id=ICML.cc/2026/Conference"],
        kind: "conference",
        domain: "AI",
        ccf_rank: "CCF-A",
    },
];

pub const DEFAULT_RECOMMEND_KEYWORDS: &[(&str, &str, bool)] = &[
    ("kw-llm-agent", "LLM Agent", true),
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

CREATE TABLE IF NOT EXISTS citation_edges (
  seed_paper_id   TEXT PRIMARY KEY NOT NULL,
  openalex_id     TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  cited_by_json   TEXT NOT NULL DEFAULT '[]',
  cocited_json    TEXT NOT NULL DEFAULT '[]',
  fetched_at      TEXT NOT NULL
);
"#;

const MIGRATION_STEPS: [MigrationStep; 1] = [MigrationStep::custom(1, init_v1)];

fn init_v1(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(DDL_V1)
        .map_err(|e| AppError::message(format!("collection migrate v1 ddl: {e}")))?;
    seed_defaults(conn)?;
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
            conn.execute(
                "INSERT OR IGNORE INTO recommend_keywords (id, position, term, normalized, enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    id,
                    pos as i64,
                    term,
                    term.to_lowercase(),
                    i64::from(*enabled)
                ],
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

static LEGACY_CACHE_PURGED: Once = Once::new();

fn purge_legacy_cache_once() {
    LEGACY_CACHE_PURGED.call_once(|| {
        let legacy_dir = paths::agentero_cache_dir().join("plaza-collection");
        let _ = fs::remove_dir_all(legacy_dir);
    });
}

pub fn collection_db_path() -> PathBuf {
    paths::collection_db_path()
}

pub fn ensure_collection() -> Result<Connection, AppError> {
    purge_legacy_cache_once();
    ensure_collection_at(&collection_db_path())
}

fn reset_legacy_dblp_schema_if_needed(conn: &Connection) -> Result<(), AppError> {
    let has_legacy_dblp: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('venues') WHERE name = 'dblp_stream')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if !has_legacy_dblp {
        return Ok(());
    }
    conn.execute_batch(
        "DROP TABLE IF EXISTS citation_edges;
         DROP TRIGGER IF EXISTS papers_fts_ai;
         DROP TRIGGER IF EXISTS papers_fts_ad;
         DROP TRIGGER IF EXISTS papers_fts_au;
         DROP TABLE IF EXISTS papers_fts;
         DROP TABLE IF EXISTS paper_keywords;
         DROP TABLE IF EXISTS paper_categories;
         DROP TABLE IF EXISTS papers;
         DROP TABLE IF EXISTS recommend_keywords;
         DROP TABLE IF EXISTS arxiv_watermarks;
         DROP TABLE IF EXISTS venues;
         DROP TABLE IF EXISTS collection_config;
         DROP TABLE IF EXISTS schema_meta;",
    )
    .map_err(|e| AppError::message(format!("collection reset legacy dblp schema: {e}")))?;
    Ok(())
}

pub fn ensure_collection_at(db_path: &Path) -> Result<Connection, AppError> {
    if let Some(parent) = db_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let conn = crate::sqlite::open_standard(db_path, DbMsgs::COLLECTION)?;
    reset_legacy_dblp_schema_if_needed(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}
