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
    pub kind: &'static str,
    pub domain: &'static str,
    pub ccf_rank: &'static str,
    pub dblp_stream: &'static str,
}

/// Complete 2026 Venue catalog (28 CCF-A / CCF-B venues across PL/SE, CR, and AI).
pub const DEFAULT_VENUES: &[DefaultVenueSeed] = &[
    // 1a. PL/SE Conferences — CCF-A
    DefaultVenueSeed {
        id: "ase-2026",
        name: "ASE 2026",
        url: "https://dblp.uni-trier.de/db/conf/kbse/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/kbse",
    },
    DefaultVenueSeed {
        id: "icse-2026",
        name: "ICSE 2026",
        url: "https://dblp.uni-trier.de/db/conf/icse/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/icse",
    },
    DefaultVenueSeed {
        id: "issta-2026",
        name: "ISSTA 2026",
        url: "https://dblp.uni-trier.de/db/conf/issta/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/issta",
    },
    DefaultVenueSeed {
        id: "fse-2026",
        name: "FSE 2026",
        url: "https://dblp.uni-trier.de/db/conf/sigsoft/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/sigsoft",
    },
    DefaultVenueSeed {
        id: "pldi-2026",
        name: "PLDI 2026",
        url: "https://dblp.uni-trier.de/db/conf/pldi/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/pldi",
    },
    DefaultVenueSeed {
        id: "popl-2026",
        name: "POPL 2026",
        url: "https://dblp.uni-trier.de/db/conf/popl/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/popl",
    },
    DefaultVenueSeed {
        id: "oopsla-2026",
        name: "OOPSLA 2026",
        url: "https://dblp.uni-trier.de/db/conf/oopsla/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/oopsla",
    },
    // 1a. PL/SE Conferences — CCF-B
    DefaultVenueSeed {
        id: "ecoop-2026",
        name: "ECOOP 2026",
        url: "https://dblp.uni-trier.de/db/conf/ecoop/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
        dblp_stream: "streams/conf/ecoop",
    },
    DefaultVenueSeed {
        id: "icpc-2026",
        name: "ICPC 2026",
        url: "https://dblp.uni-trier.de/db/conf/iwpc/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
        dblp_stream: "streams/conf/iwpc",
    },
    DefaultVenueSeed {
        id: "re-2026",
        name: "RE 2026",
        url: "https://dblp.uni-trier.de/db/conf/re/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
        dblp_stream: "streams/conf/re",
    },
    DefaultVenueSeed {
        id: "saner-2026",
        name: "SANER 2026",
        url: "https://dblp.uni-trier.de/db/conf/wcre/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
        dblp_stream: "streams/conf/wcre",
    },
    DefaultVenueSeed {
        id: "icsme-2026",
        name: "ICSME 2026",
        url: "https://dblp.uni-trier.de/db/conf/icsm/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
        dblp_stream: "streams/conf/icsm",
    },
    DefaultVenueSeed {
        id: "sas-2026",
        name: "SAS 2026",
        url: "https://dblp.uni-trier.de/db/conf/sas/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
        dblp_stream: "streams/conf/sas",
    },
    DefaultVenueSeed {
        id: "esem-2026",
        name: "ESEM 2026",
        url: "https://dblp.uni-trier.de/db/conf/esem/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
        dblp_stream: "streams/conf/esem",
    },
    DefaultVenueSeed {
        id: "issre-2026",
        name: "ISSRE 2026",
        url: "https://dblp.uni-trier.de/db/conf/issre/",
        kind: "conference",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
        dblp_stream: "streams/conf/issre",
    },
    // 1b. PL/SE Journals — CCF-A & CCF-B
    DefaultVenueSeed {
        id: "tse-2026",
        name: "TSE 2026",
        url: "https://dblp.uni-trier.de/db/journals/tse/",
        kind: "journal",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/journals/tse",
    },
    DefaultVenueSeed {
        id: "tosem-2026",
        name: "TOSEM 2026",
        url: "https://dblp.uni-trier.de/db/journals/tosem/",
        kind: "journal",
        domain: "PL/SE",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/journals/tosem",
    },
    DefaultVenueSeed {
        id: "ase-journal-2026",
        name: "ASE (J) 2026",
        url: "https://dblp.uni-trier.de/db/journals/ase/",
        kind: "journal",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
        dblp_stream: "streams/journals/ase",
    },
    DefaultVenueSeed {
        id: "ese-2026",
        name: "ESE 2026",
        url: "https://dblp.uni-trier.de/db/journals/ese/",
        kind: "journal",
        domain: "PL/SE",
        ccf_rank: "CCF-B",
        dblp_stream: "streams/journals/ese",
    },
    // 2. CR Conferences — CCF-A
    DefaultVenueSeed {
        id: "ccs-2026",
        name: "CCS 2026",
        url: "https://dblp.uni-trier.de/db/conf/ccs/",
        kind: "conference",
        domain: "CR",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/ccs",
    },
    DefaultVenueSeed {
        id: "sp-2026",
        name: "S&P 2026",
        url: "https://dblp.uni-trier.de/db/conf/sp/",
        kind: "conference",
        domain: "CR",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/sp",
    },
    DefaultVenueSeed {
        id: "usenix-sec-2026",
        name: "USENIX Security 2026",
        url: "https://dblp.uni-trier.de/db/conf/uss/",
        kind: "conference",
        domain: "CR",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/uss",
    },
    DefaultVenueSeed {
        id: "ndss-2026",
        name: "NDSS 2026",
        url: "https://dblp.uni-trier.de/db/conf/ndss/",
        kind: "conference",
        domain: "CR",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/ndss",
    },
    // 3. AI Conferences — CCF-A
    DefaultVenueSeed {
        id: "aaai-2026",
        name: "AAAI 2026",
        url: "https://dblp.uni-trier.de/db/conf/aaai/",
        kind: "conference",
        domain: "AI",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/aaai",
    },
    DefaultVenueSeed {
        id: "neurips-2026",
        name: "NeurIPS 2026",
        url: "https://dblp.uni-trier.de/db/conf/nips/",
        kind: "conference",
        domain: "AI",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/nips",
    },
    DefaultVenueSeed {
        id: "acl-2026",
        name: "ACL 2026",
        url: "https://dblp.uni-trier.de/db/conf/acl/",
        kind: "conference",
        domain: "AI",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/acl",
    },
    DefaultVenueSeed {
        id: "iclr-2026",
        name: "ICLR 2026",
        url: "https://dblp.uni-trier.de/db/conf/iclr/",
        kind: "conference",
        domain: "AI",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/iclr",
    },
    DefaultVenueSeed {
        id: "icml-2026",
        name: "ICML 2026",
        url: "https://dblp.uni-trier.de/db/conf/icml/",
        kind: "conference",
        domain: "AI",
        ccf_rank: "CCF-A",
        dblp_stream: "streams/conf/icml",
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
  mode                TEXT NOT NULL DEFAULT 'auto',
  kind                TEXT,
  domain              TEXT,
  ccf_rank            TEXT,
  dblp_stream         TEXT,
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
            conn.execute(
                "INSERT OR IGNORE INTO venues (id, position, name, url, mode, kind, domain, ccf_rank, dblp_stream)
                 VALUES (?1, ?2, ?3, ?4, 'auto', ?5, ?6, ?7, ?8)",
                params![v.id, pos as i64, v.name, v.url, v.kind, v.domain, v.ccf_rank, v.dblp_stream],
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

pub fn ensure_collection_at(db_path: &Path) -> Result<Connection, AppError> {
    if let Some(parent) = db_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let conn = crate::sqlite::open_standard(db_path, DbMsgs::COLLECTION)?;
    migrate(&conn)?;
    Ok(conn)
}
