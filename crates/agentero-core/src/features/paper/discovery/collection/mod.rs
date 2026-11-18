//! Unified `collection.sqlite` storage, FTS5 boolean search, recommendation engine,
//! and in-collection citation snowballing for Plaza Paper Collection & Discover.

pub mod citations;
pub mod keywords;
pub mod lineage;
pub mod models;
pub mod recommend;
pub mod schema;
pub mod search;
pub mod seed;
pub mod store;

/// CLI flag used when spawning the session-scoped `agentero-collection` stdio MCP.
pub const COLLECTION_MCP_WORKER_ARG: &str = "--agentero-collection-mcp";

pub use citations::snowball_citations_at;
pub use keywords::{
    build_keyword_lookup_key, canonicalize_keyword, canonicalize_keywords, clean_keyword_surface,
    normalize_keyword_key, singularize_keyword_token, union_canonical_keywords,
    KeywordSynonymGroup, KEYWORD_SYNONYM_MAP, SYNONYM_GROUPS,
};
pub use lineage::{paper_lineage, paper_lineage_at, paper_subgraph, paper_subgraph_at};
pub use models::*;
pub use recommend::{
    recommend_next, recommend_next_at, recommend_state_get, recommend_state_get_at,
    recommend_state_set, recommend_state_set_at, word_cloud, word_cloud_at,
    DEFAULT_RECOMMEND_BATCH_SIZE,
};
pub use schema::{
    collection_db_path, ensure_collection, ensure_collection_at, DEFAULT_ARXIV_CATEGORIES_JSON,
    DEFAULT_RECOMMEND_KEYWORDS, DEFAULT_VENUES, DEFAULT_WORD_CLOUD_TOP_N, MAX_WORD_CLOUD_TOP_N,
    MIN_WORD_CLOUD_TOP_N, SCHEMA_VERSION,
};
pub use search::{
    curate_collection_at, overview, overview_at, search_collection_at, search_fast, search_fast_at,
};
pub use seed::{
    seed_bake_at, seed_sync, seed_sync_at, SeedBakeOptions, SeedBakeReport, SeedManifest,
    SeedPaperRecord, SeedShardEntry, DEFAULT_BAKE_LLM_BASE_URL, DEFAULT_BAKE_LLM_BATCH_SIZE,
    DEFAULT_BAKE_LLM_CONCURRENCY, DEFAULT_BAKE_LLM_MODEL, DEFAULT_SEED_MANIFEST_URL,
    DEFAULT_X666_LLM_RPM,
};
pub use store::{
    clear_collection, clear_collection_at, config_update, config_update_at,
    enrich_paper_record_from_collection, enrich_paper_record_from_collection_at,
    find_sibling_arxiv_id_in_collection, find_sibling_arxiv_id_in_collection_at, list_papers,
    list_papers_at, norm_author_key, norm_title_key, paper_get, paper_get_at, paper_work_key,
    papers_by_ids, papers_by_ids_at, patch_papers, patch_papers_at, same_work_by_title_and_authors,
    state_get, state_get_at, upsert_papers, upsert_papers_at,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn make_arxiv_input(
        id_num: usize,
        cat: &str,
        title: &str,
        kws: Vec<&str>,
    ) -> CollectionPaperUpsertInput {
        CollectionPaperUpsertInput {
            id: format!("arxiv:2603.{id_num:05}"),
            title: title.to_string(),
            authors: vec!["Alice Smith".into(), "Bob Chen".into()],
            abstract_text: format!(
                "We present a comprehensive study on {title} with empirical evaluation across benchmarks."
            ),
            published_at: format!("2026-03-{:02}T00:00:00Z", (id_num % 28) + 1),
            year: 2026,
            source_type: "arxiv".into(),
            source_label: cat.into(),
            categories: vec![cat.into()],
            url: format!("https://arxiv.org/abs/2603.{id_num:05}"),
            pdf_url: Some(format!("https://arxiv.org/pdf/2603.{id_num:05}")),
            arxiv_id: Some(format!("2603.{id_num:05}")),
            citation_count: Some(id_num as u32),
            keywords: kws.into_iter().map(str::to_string).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn portal_independence_allows_arxiv_and_venue_rows_to_coexist() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        let arxiv_paper = CollectionPaperUpsertInput {
            id: "arxiv:2605.10001".into(),
            title: "Unified Agentic Program Analysis".into(),
            authors: vec!["Jane Doe".into()],
            abstract_text: "Full arXiv preprint abstract on unified agentic program analysis for software systems.".into(),
            published_at: "2026-05-01T00:00:00Z".into(),
            year: 2026,
            source_type: "arxiv".into(),
            source_label: "cs.SE".into(),
            categories: vec!["cs.SE".into()],
            url: "https://arxiv.org/abs/2605.10001".into(),
            arxiv_id: Some("2605.10001".into()),
            keywords: vec!["Program Analysis".into()],
            ..Default::default()
        };

        let venue_paper = CollectionPaperUpsertInput {
            id: "venue:neurips-2026:arxiv:2605.10001".into(),
            title: "Unified Agentic Program Analysis".into(),
            authors: vec!["Jane Doe".into()],
            abstract_text:
                "Full NeurIPS 2026 camera-ready abstract on unified agentic program analysis."
                    .into(),
            published_at: "2026-05-10T00:00:00Z".into(),
            year: 2026,
            source_type: "venue".into(),
            source_label: "NeurIPS 2026".into(),
            categories: vec!["NeurIPS 2026".into()],
            url: "https://neurips.cc/p/10001".into(),
            arxiv_id: Some("2605.10001".into()),
            venue_id: Some("neurips-2026".into()),
            venue_kind: Some("conference".into()),
            venue_domain: Some("AI".into()),
            ccf_rank: Some("CCF-A".into()),
            keywords: vec!["Program Analysis".into()],
            ..Default::default()
        };

        let state = upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![arxiv_paper, venue_paper],
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(state.arxiv_count, 1);
        assert_eq!(state.venue_count, 1);
        assert_eq!(state.total_count, 2);

        let arxiv_page = list_papers_at(
            &db,
            &CollectionListPapersArgs {
                source_type: Some("arxiv".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(arxiv_page.total, 1);
        assert_eq!(arxiv_page.items[0].id, "arxiv:2605.10001");

        let venue_page = list_papers_at(
            &db,
            &CollectionListPapersArgs {
                source_type: Some("venue".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(venue_page.total, 1);
        assert_eq!(
            venue_page.items[0].id,
            "venue:neurips-2026:arxiv:2605.10001"
        );
    }

    #[test]
    fn metadata_preserving_upsert_and_patch_never_regress_richer_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        let rich_abs = "We introduce an automated vulnerability detection framework combining static taint tracking and LLM agents.";
        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![
                    CollectionPaperUpsertInput {
                        id: "venue:icse-2026:doi:10.1145/1".into(),
                        title: "TaintAgent: Hybrid Vulnerability Detection".into(),
                        authors: vec!["Alice Guo".into()],
                        abstract_text: rich_abs.into(),
                        published_at: "2026-04-01T00:00:00Z".into(),
                        year: 2026,
                        source_type: "venue".into(),
                        source_label: "ICSE 2026".into(),
                        venue_id: Some("icse-2026".into()),
                        venue_kind: Some("conference".into()),
                        venue_domain: Some("PL/SE".into()),
                        ccf_rank: Some("CCF-A".into()),
                        doi: Some("10.1145/1".into()),
                        pdf_url: Some("https://dl.acm.org/pdf/1".into()),
                        citation_count: Some(42),
                        keywords: vec!["LLM Agent".into()],
                        recommended_at: Some("2026-04-02T12:00:00Z".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "arxiv:2604.09999".into(),
                        title: "Follow-up Study Citing TaintAgent".into(),
                        authors: vec!["Bob Li".into()],
                        abstract_text:
                            "We build upon TaintAgent for cross-language vulnerability repair."
                                .into(),
                        published_at: "2026-04-05T00:00:00Z".into(),
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.SE".into(),
                        categories: vec!["cs.SE".into()],
                        arxiv_id: Some("2604.09999".into()),
                        raw_refs: vec!["doi:10.1145/1".into()],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        // Re-upsert with placeholder abstract, external citation_count (ignored in V2), null recommended_at, and new keyword
        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![CollectionPaperUpsertInput {
                    id: "venue:icse-2026:doi:10.1145/1".into(),
                    title: "TaintAgent: Hybrid Vulnerability Detection".into(),
                    abstract_text: "ICSE 2026 accepted paper".into(),
                    published_at: "2026-04-01T00:00:00Z".into(),
                    year: 2026,
                    source_type: "venue".into(),
                    source_label: "ICSE 2026".into(),
                    citation_count: Some(999),
                    keywords: vec!["Vulnerability Detection".into()],
                    recommended_at: None,
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();

        let detail = paper_get_at(&db, "venue:icse-2026:doi:10.1145/1")
            .unwrap()
            .expect("paper should exist");
        assert_eq!(detail.abstract_text, rich_abs);
        assert_eq!(detail.citation_count, 1);
        assert_eq!(
            detail.recommended_at.as_deref(),
            Some("2026-04-02T12:00:00Z")
        );
        assert_eq!(detail.pdf_url.as_deref(), Some("https://dl.acm.org/pdf/1"));
        assert_eq!(
            detail.keywords,
            vec![
                "AI Agent".to_string(),
                "Vulnerability Detection".to_string()
            ]
        );
        assert!(detail
            .bibtex
            .as_deref()
            .unwrap_or("")
            .contains("@inproceedings"));
        assert!(detail.citation_text.contains("TaintAgent"));
    }

    #[test]
    fn atomic_venue_replacement_purges_stale_rows_and_preserves_recommended_at() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![
                    CollectionPaperUpsertInput {
                        id: "venue:ase-2026:doi:10.1/keep-id".into(),
                        title: "Paper Kept By ID".into(),
                        source_type: "venue".into(),
                        source_label: "ASE 2026".into(),
                        venue_id: Some("ase-2026".into()),
                        doi: Some("10.1/keep-id".into()),
                        recommended_at: Some("2026-04-05T00:00:00Z".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "venue:ase-2026:arxiv:2602.99999".into(),
                        title: "Paper Upgraded From Arxiv To DOI".into(),
                        source_type: "venue".into(),
                        source_label: "ASE 2026".into(),
                        venue_id: Some("ase-2026".into()),
                        arxiv_id: Some("2602.99999v2".into()),
                        recommended_at: Some("2026-04-06T00:00:00Z".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "venue:ase-2026:stale-workshop".into(),
                        title: "Stale Workshop Entry".into(),
                        source_type: "venue".into(),
                        source_label: "ASE 2026".into(),
                        venue_id: Some("ase-2026".into()),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        let state = upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                replace_venue_id: Some("ase-2026".into()),
                replace_source_label: Some("ASE 2026".into()),
                items: vec![
                    CollectionPaperUpsertInput {
                        id: "venue:ase-2026:doi:10.1/keep-id".into(),
                        title: "Paper Kept By ID".into(),
                        source_type: "venue".into(),
                        source_label: "ASE 2026".into(),
                        venue_id: Some("ase-2026".into()),
                        doi: Some("10.1/keep-id".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "venue:ase-2026:doi:10.1145/final-camera".into(),
                        title: "Paper Upgraded From Arxiv To DOI".into(),
                        source_type: "venue".into(),
                        source_label: "ASE 2026".into(),
                        venue_id: Some("ase-2026".into()),
                        doi: Some("10.1145/final-camera".into()),
                        arxiv_id: Some("2602.99999".into()),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(state.venue_count, 2);
        assert!(paper_get_at(&db, "venue:ase-2026:stale-workshop")
            .unwrap()
            .is_none());

        let p1 = paper_get_at(&db, "venue:ase-2026:doi:10.1/keep-id")
            .unwrap()
            .unwrap();
        assert_eq!(p1.recommended_at.as_deref(), Some("2026-04-05T00:00:00Z"));

        let p2 = paper_get_at(&db, "venue:ase-2026:doi:10.1145/final-camera")
            .unwrap()
            .unwrap();
        assert_eq!(p2.recommended_at.as_deref(), Some("2026-04-06T00:00:00Z"));
    }

    #[test]
    fn enabled_categories_scoping_gates_all_reads_searches_recommendations_and_curation() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        // Default categories are ["cs.SE", "cs.CR", "cs.PL"]; cs.AI is opt-in.
        let state = upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![
                    make_arxiv_input(1, "cs.SE", "LLM Agent Program Analysis", vec!["LLM Agent"]),
                    make_arxiv_input(
                        2,
                        "cs.AI",
                        "LLM Agent Reasoning",
                        vec!["LLM Agent", "Reasoning"],
                    ),
                ],
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(state.arxiv_count, 1);
        assert_eq!(overview_at(&db).unwrap().arxiv_count, 1);
        assert_eq!(
            list_papers_at(&db, &CollectionListPapersArgs::default())
                .unwrap()
                .total,
            1
        );
        assert_eq!(
            search_fast_at(
                &db,
                &CollectionSearchArgs {
                    query: Some("LLM Agent".into()),
                    ..Default::default()
                }
            )
            .unwrap()
            .total_matched,
            1
        );

        let wc = word_cloud_at(&db, &CollectionWordCloudArgs::default()).unwrap();
        assert_eq!(wc.total_candidate_papers, 1);
        assert!(!wc.keywords.iter().any(|k| k.normalized == "reasoning"));

        let curated = curate_collection_at(
            &db,
            CollectionCurateParams {
                groups: vec![CurateGroupInput {
                    label: "Agents".into(),
                    items: vec![
                        CurateItemInput {
                            id: "arxiv:2603.00001".into(),
                            reason: Some("In scope".into()),
                            keep: true,
                        },
                        CurateItemInput {
                            id: "arxiv:2603.00002".into(),
                            reason: Some("Disabled cs.AI".into()),
                            keep: false,
                        },
                    ],
                }],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(curated.curated_count, 1);
        assert!(curated.groups[0].items[0].keep);
        assert_eq!(curated.dropped_unknown_ids, vec!["arxiv:2603.00002"]);

        // MCP clients validate `structuredContent` against the output schema:
        // every `required` property must be present even when its list is empty.
        let empty = curate_collection_at(&db, CollectionCurateParams::default()).unwrap();
        let value = serde_json::to_value(&empty).unwrap();
        let schema = serde_json::to_value(schemars::schema_for!(CollectionCurateOut)).unwrap();
        for key in schema["required"].as_array().unwrap() {
            let key = key.as_str().unwrap();
            assert!(value.get(key).is_some(), "curate output missing `{key}`");
        }

        // Enable cs.AI and verify immediate visibility without re-fetching.
        let updated = config_update_at(
            &db,
            CollectionConfigUpdateArgs {
                categories: Some(vec![
                    "cs.SE".into(),
                    "cs.CR".into(),
                    "cs.PL".into(),
                    "cs.AI".into(),
                ]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.arxiv_count, 2);
        assert_eq!(
            search_fast_at(
                &db,
                &CollectionSearchArgs {
                    query: Some("LLM Agent".into()),
                    ..Default::default()
                }
            )
            .unwrap()
            .total_matched,
            2
        );
    }

    #[test]
    fn fts5_boolean_phrase_negation_cjk_and_random_sample_work() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        let mut items = Vec::new();
        for idx in 1..=65 {
            let is_multi_agent = idx % 2 == 0;
            let is_venue = idx % 3 == 0;
            items.push(CollectionPaperUpsertInput {
                id: if is_venue {
                    format!("doi:10.1145/37700{idx:02}")
                } else {
                    format!("arxiv:2603.{idx:05}")
                },
                title: if is_multi_agent {
                    format!("Multi-Agent Vulnerability Repair System #{idx}")
                } else {
                    format!("Symbolic Fuzzing for Rust Kernels #{idx}")
                },
                authors: vec!["Alice Smith".into()],
                abstract_text: if is_multi_agent {
                    "We propose an autonomous multi-agent workflow for software vulnerability repair."
                        .into()
                } else {
                    "We design a directed symbolic execution fuzzer for memory safety.".into()
                },
                published_at: format!("2026-03-{:02}T00:00:00Z", (idx % 28) + 1),
                year: 2026,
                source_type: if is_venue { "venue".into() } else { "arxiv".into() },
                source_label: if is_venue { "ICSE 2026".into() } else { "cs.SE".into() },
                categories: vec![if is_venue { "ICSE 2026".into() } else { "cs.SE".into() }],
                url: format!("https://example.org/p/{idx}"),
                arxiv_id: (!is_venue).then(|| format!("2603.{idx:05}")),
                doi: is_venue.then(|| format!("10.1145/37700{idx:02}")),
                venue_id: is_venue.then(|| "icse-2026".into()),
                venue_kind: is_venue.then(|| "conference".into()),
                venue_domain: is_venue.then(|| "PL/SE".into()),
                ccf_rank: is_venue.then(|| "CCF-A".into()),
                citation_count: Some(idx as u32),
                keywords: if is_multi_agent {
                    vec!["Multi-Agent".into(), "Program Repair".into()]
                } else {
                    vec!["Fuzzing".into(), "Symbolic Execution".into()]
                },
                ..Default::default()
            });
        }
        items.push(make_arxiv_input(
            99,
            "cs.SE",
            "基于大语言模型形式化验证的漏洞修复框架",
            vec!["Formal Verification"],
        ));

        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items,
                ..Default::default()
            },
        )
        .unwrap();

        let sample = search_collection_at(
            &db,
            &CollectionSearchParams {
                query: Some("\"multi-agent\" OR fuzzing".into()),
                mode: Some("random_sample".into()),
                sample_size: Some(50),
                seed: Some(12345),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(sample.total_matched, 65);
        assert_eq!(sample.returned_count, 50);

        let ranked = search_fast_at(
            &db,
            &CollectionSearchArgs {
                query: Some("repair -symbolic".into()),
                ccf_ranks: vec!["CCF-A".into()],
                limit: Some(50),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!ranked.items.is_empty());
        assert!(ranked
            .items
            .iter()
            .all(|s| s.paper.ccf_rank.as_deref() == Some("CCF-A")
                && s.paper.title.contains("Multi-Agent")));

        // CJK fallback
        let cjk = search_fast_at(
            &db,
            &CollectionSearchArgs {
                query: Some("形式化验证".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(cjk.total_matched, 1);
        assert_eq!(cjk.items[0].paper.id, "arxiv:2603.00099");

        // Broadened OR fallback when random_sample strict hits < 10
        let broad = search_collection_at(
            &db,
            &CollectionSearchParams {
                query: Some("autonomous symbolic".into()),
                mode: Some("random_sample".into()),
                sample_size: Some(20),
                seed: Some(7),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(broad.strict_matched_count, 0);
        assert!(broad.broadened);
        assert!(!broad.items.is_empty());
    }

    #[test]
    fn word_cloud_casing_quality_and_recommend_next_batch_stamping() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![
                    make_arxiv_input(
                        1,
                        "cs.SE",
                        "Paper One",
                        vec!["llm agent", "ebpf", "langgraph"],
                    ),
                    make_arxiv_input(
                        2,
                        "cs.SE",
                        "Paper Two",
                        vec!["LLM Agent", "eBPF", "LangGraph"],
                    ),
                    make_arxiv_input(
                        3,
                        "cs.SE",
                        "Paper Three",
                        vec!["LLM AGENT", "eBPF", "LangGraph"],
                    ),
                ],
                ..Default::default()
            },
        )
        .unwrap();

        let wc = word_cloud_at(&db, &CollectionWordCloudArgs { top_n: Some(20) }).unwrap();
        let agent_chip = wc
            .keywords
            .iter()
            .find(|k| k.normalized == "ai agent")
            .unwrap();
        assert_eq!(agent_chip.term, "AI Agent");
        assert_eq!(agent_chip.count, 3);
        assert_eq!(agent_chip.unrecommended_count, 3);

        let ebpf_chip = wc.keywords.iter().find(|k| k.normalized == "ebpf").unwrap();
        assert_eq!(ebpf_chip.term, "eBPF");

        let langgraph_chip = wc
            .keywords
            .iter()
            .find(|k| k.normalized == "langgraph")
            .unwrap();
        assert_eq!(langgraph_chip.term, "LangGraph");

        let cleared = recommend_state_set_at(
            &db,
            RecommendPoolStateInput {
                keywords: Some(vec![]),
                selected_cloud_terms: Some(vec!["eBPF".into()]),
                word_cloud_top_n: Some(30),
                last_recommended_at: None,
            },
        )
        .unwrap();
        assert!(cleared.keywords.is_empty());

        // Reloading state when `recommend_keywords` is empty must NOT resurrect default seeds.
        let reloaded = recommend_state_get_at(&db).unwrap();
        assert!(reloaded.keywords.is_empty());
        assert_eq!(reloaded.selected_cloud_terms, vec!["eBPF"]);

        let batch1 = recommend_next_at(
            &db,
            &RecommendNextArgs {
                max_batch_size: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(batch1.items.len(), 2);
        assert_eq!(batch1.remaining_unrecommended, 1);
        assert!(!batch1.exhausted);
        assert!(batch1.state.selected_cloud_terms.is_empty());
        assert_eq!(batch1.state.keywords.len(), 1);
        assert_eq!(batch1.state.keywords[0].term, "eBPF");
        assert!(batch1.state.keywords[0].enabled);
        assert!(batch1
            .items
            .iter()
            .all(|r| r.paper.recommended_at.is_some()));

        let batch2 = recommend_next_at(
            &db,
            &RecommendNextArgs {
                max_batch_size: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(batch2.items.len(), 1);
        assert_eq!(batch2.remaining_unrecommended, 0);
        assert!(!batch2.exhausted);

        let batch3 = recommend_next_at(
            &db,
            &RecommendNextArgs {
                max_batch_size: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(batch3.items.is_empty());
        assert!(batch3.exhausted);

        // Reset recommended stamps
        clear_collection_at(
            &db,
            &CollectionClearArgs {
                scope: "recommended".into(),
                venue_id: None,
            },
        )
        .unwrap();
        let wc_after_reset = word_cloud_at(&db, &CollectionWordCloudArgs::default()).unwrap();
        assert_eq!(wc_after_reset.unrecommended_paper_count, 3);

        // Clearing all keywords with no cloud terms leaves 0 active terms and does not resurrect defaults.
        recommend_state_set_at(
            &db,
            RecommendPoolStateInput {
                keywords: Some(vec![]),
                selected_cloud_terms: Some(vec![]),
                word_cloud_top_n: None,
                last_recommended_at: None,
            },
        )
        .unwrap();
        let empty_next = recommend_next_at(&db, &RecommendNextArgs::default()).unwrap();
        assert!(empty_next.items.is_empty());
        assert!(!empty_next.exhausted);
        assert!(empty_next.state.keywords.is_empty());
        assert!(recommend_state_get_at(&db).unwrap().keywords.is_empty());
    }

    #[tokio::test]
    async fn citation_edges_sqlite_cache_and_in_collection_snowballing() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        let mut p10 = make_arxiv_input(10, "cs.SE", "Seed Fuzzing Paper", vec!["Fuzzing", "Rust"]);
        p10.raw_refs = vec!["arxiv:2603.00012".into()];
        let mut p11 = make_arxiv_input(11, "cs.SE", "Citing Fuzzing Followup", vec!["Fuzzing"]);
        p11.raw_refs = vec!["arxiv:2603.00010".into()];
        let p12 = make_arxiv_input(12, "cs.SE", "Referenced Foundational Work", vec!["Rust"]);

        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![p10, p11, p12],
                ..Default::default()
            },
        )
        .unwrap();

        let out = snowball_citations_at(
            &db,
            &CollectionCitationsParams {
                paper_ids: vec!["arxiv:2603.00010".into(), "arxiv:9999.00000".into()],
                direction: Some("both".into()),
                limit: Some(10),
            },
        )
        .await
        .unwrap();

        assert_eq!(out.resolved_seeds, vec!["arxiv:2603.00010"]);
        assert_eq!(out.unresolved_seeds, vec!["arxiv:9999.00000"]);
        assert_eq!(out.returned_count, 2);
        assert_eq!(out.items[0].paper.id, "arxiv:2603.00011");
        assert_eq!(out.items[0].relation_type, "cited_by");
        assert_eq!(out.items[1].paper.id, "arxiv:2603.00012");
        assert_eq!(out.items[1].relation_type, "references");
    }

    #[test]
    fn clean_v1_schema_defaults_and_venue_management_crud_work() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        assert_eq!(SCHEMA_VERSION, 4);
        let initial = state_get_at(&db).unwrap();
        assert_eq!(initial.venues.len(), 28);
        assert!(initial
            .venues
            .iter()
            .all(|v| !v.url.contains("dblp") && v.tracks.iter().all(|t| !t.contains("dblp"))));

        let rec_defaults = recommend_state_get_at(&db).unwrap();
        assert_eq!(rec_defaults.keywords[0].id, "kw-ai-agent");
        assert_eq!(rec_defaults.keywords[0].term, "AI Agent");

        // 2. Upsert a venue paper for `sas-2026`, then delete `sas-2026`, edit `icse-2026` notes, and add `msr-2026`
        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![CollectionPaperUpsertInput {
                    id: "venue:sas-2026:doi:10.1007/978-3-032-40374-2_1".into(),
                    title: "Static Analysis Paper".into(),
                    authors: vec!["Patrick Cousot".into()],
                    abstract_text: "Sound static analysis.".into(),
                    published_at: "2026-10-01T00:00:00Z".into(),
                    year: 2026,
                    source_type: "venue".into(),
                    source_label: "SAS 2026".into(),
                    categories: vec!["SAS 2026".into()],
                    url: "https://doi.org/10.1007/978-3-032-40374-2_1".into(),
                    venue_id: Some("sas-2026".into()),
                    venue_kind: Some("conference".into()),
                    venue_domain: Some("PL/SE".into()),
                    ccf_rank: Some("CCF-B".into()),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(state_get_at(&db).unwrap().venue_count, 1);

        let mut next_venues: Vec<CollectionVenueInput> = initial
            .venues
            .into_iter()
            .filter(|v| v.id != "sas-2026")
            .map(|v| CollectionVenueInput {
                notes: (v.id == "icse-2026").then(|| "Research Track full papers only.".into()),
                id: v.id,
                name: v.name,
                url: v.url,
                tracks: Some(v.tracks),
                mode: Some(v.mode),
                kind: v.kind,
                domain: v.domain,
                ccf_rank: v.ccf_rank,
                last_fetched_at: v.last_fetched_at,
                latest_published_at: v.latest_published_at,
                remote_total_count: v.remote_total_count,
                paper_count: Some(v.paper_count),
            })
            .collect();
        next_venues.push(CollectionVenueInput {
            id: "msr-2026".into(),
            name: "MSR 2026".into(),
            url: "https://2026.msrconf.org/".into(),
            tracks: Some(vec![
                "https://2026.msrconf.org/track/msr-2026-technical-papers?#event-overview".into(),
            ]),
            notes: Some("Exclude Data Showcase and Mining Challenge.".into()),
            mode: Some("agent".into()),
            kind: Some("conference".into()),
            domain: Some("PL/SE".into()),
            ccf_rank: Some("CCF-B".into()),
            ..Default::default()
        });

        let updated = config_update_at(
            &db,
            CollectionConfigUpdateArgs {
                venues: Some(next_venues),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.venues.len(), 28); // 28 - 1 (`sas-2026`) + 1 (`msr-2026`)
        assert!(!updated.venues.iter().any(|v| v.id == "sas-2026"));
        assert_eq!(updated.venue_count, 0); // `sas-2026` papers cascade-deleted
        let msr = updated.venues.iter().find(|v| v.id == "msr-2026").unwrap();
        assert_eq!(
            msr.notes.as_deref(),
            Some("Exclude Data Showcase and Mining Challenge.")
        );
        assert_eq!(msr.tracks.len(), 1);

        // Clearing `notes` with `Some("")` sets `notes` back to `None`
        let cleared_inputs: Vec<CollectionVenueInput> = updated
            .venues
            .into_iter()
            .map(|v| CollectionVenueInput {
                notes: if v.id == "icse-2026" {
                    Some(String::new())
                } else {
                    v.notes
                },
                id: v.id,
                name: v.name,
                url: v.url,
                tracks: Some(v.tracks),
                mode: Some(v.mode),
                kind: v.kind,
                domain: v.domain,
                ccf_rank: v.ccf_rank,
                last_fetched_at: v.last_fetched_at,
                latest_published_at: v.latest_published_at,
                remote_total_count: v.remote_total_count,
                paper_count: Some(v.paper_count),
            })
            .collect();
        let after_clear = config_update_at(
            &db,
            CollectionConfigUpdateArgs {
                venues: Some(cleared_inputs),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            after_clear
                .venues
                .iter()
                .find(|v| v.id == "icse-2026")
                .unwrap()
                .notes,
            None
        );
    }

    #[tokio::test]
    async fn cross_portal_dedupe_keeps_full_pool_but_outputs_only_venue_in_search_citations_and_recommend(
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        let state = upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![
                    CollectionPaperUpsertInput {
                        id: "arxiv:2603.00100".into(),
                        title: "Seed Program Repair Study".into(),
                        authors: vec!["Dana White".into(), "Evan Green".into()],
                        abstract_text: "Seed study on automated repair.".into(),
                        published_at: "2026-03-01T00:00:00Z".into(),
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.SE".into(),
                        categories: vec!["cs.SE".into()],
                        url: "https://arxiv.org/abs/2603.00100".into(),
                        arxiv_id: Some("2603.00100".into()),
                        keywords: vec!["Repair".into()],
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "venue:icse-2026:seed".into(),
                        title: "Seed Program Repair Study.".into(),
                        authors: vec!["White, Dana".into(), "E. Green".into()],
                        abstract_text: "".into(),
                        published_at: "2026-04-01T00:00:00Z".into(),
                        year: 2026,
                        source_type: "venue".into(),
                        source_label: "ICSE 2026".into(),
                        categories: vec!["ICSE 2026".into()],
                        url: "https://doi.org/10.1145/3650000.3650000".into(),
                        doi: Some("10.1145/3650000.3650000".into()),
                        venue_id: Some("icse-2026".into()),
                        venue_kind: Some("conference".into()),
                        venue_domain: Some("PL/SE".into()),
                        ccf_rank: Some("CCF-A".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "arxiv:2603.00101".into(),
                        title: "Multi-Agent Fuzzing for Smart Contracts".into(),
                        authors: vec![
                            "Alice B. Smith".into(),
                            "Bob Jones".into(),
                            "Carol Lee".into(),
                        ],
                        abstract_text:
                            "We propose a multi-agent fuzzing engine tailored to smart contracts."
                                .into(),
                        published_at: "2026-03-05T00:00:00Z".into(),
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.SE".into(),
                        categories: vec!["cs.SE".into()],
                        url: "https://arxiv.org/abs/2603.00101".into(),
                        pdf_url: Some("https://arxiv.org/pdf/2603.00101".into()),
                        arxiv_id: Some("2603.00101".into()),
                        keywords: vec!["Fuzzing".into(), "Smart Contracts".into()],
                        citation_count: Some(14),
                        raw_refs: vec!["arxiv:2603.00100".into()],
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "venue:icse-2026:doi:10.1145/3650000.3650001".into(),
                        title: "Multi-Agent Fuzzing for Smart Contracts.".into(),
                        authors: vec![
                            "Smith, Alice".into(),
                            "B. Jones".into(),
                            "Different Third".into(),
                        ],
                        abstract_text: "".into(),
                        published_at: "2026-04-10T00:00:00Z".into(),
                        year: 2026,
                        source_type: "venue".into(),
                        source_label: "ICSE 2026".into(),
                        categories: vec!["ICSE 2026".into()],
                        url: "https://doi.org/10.1145/3650000.3650001".into(),
                        doi: Some("10.1145/3650000.3650001".into()),
                        venue_id: Some("icse-2026".into()),
                        venue_kind: Some("conference".into()),
                        venue_domain: Some("PL/SE".into()),
                        ccf_rank: Some("CCF-A".into()),
                        keywords: vec!["ICSE".into()],
                        citation_count: Some(6),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        // 1. Full Paper Pool (`state_get_at` & `list_papers_at`) retains both arXiv and Venue entries.
        assert_eq!(state.arxiv_count, 2);
        assert_eq!(state.venue_count, 2);
        assert_eq!(state.total_count, 4);
        let full_list = list_papers_at(&db, &CollectionListPapersArgs::default()).unwrap();
        assert_eq!(full_list.total, 4);

        // 2. Search (`search_fast_at` & `search_collection_at`) keeps ONLY Venue, even when the query
        //    matched text/keywords present only on the arXiv twin, and enriches Venue metadata.
        let fast = search_fast_at(
            &db,
            &CollectionSearchArgs {
                query: Some("\"smart contracts\"".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(fast.total_matched, 1);
        assert_eq!(
            fast.items[0].paper.id,
            "venue:icse-2026:doi:10.1145/3650000.3650001"
        );
        assert_eq!(fast.items[0].paper.source_type, "venue");
        assert_eq!(fast.items[0].paper.arxiv_id.as_deref(), Some("2603.00101"));
        assert_eq!(
            fast.items[0].paper.pdf_url.as_deref(),
            Some("https://arxiv.org/pdf/2603.00101")
        );
        assert!(fast.items[0]
            .paper
            .abstract_text
            .contains("multi-agent fuzzing engine"));
        assert_eq!(fast.items[0].paper.citation_count, 0);
        let seed_venue = paper_get_at(&db, "venue:icse-2026:seed").unwrap().unwrap();
        assert_eq!(seed_venue.citation_count, 1);

        // Explicit `source_type = "arxiv"` still surfaces arXiv entries when explicitly requested.
        let arxiv_only = search_fast_at(
            &db,
            &CollectionSearchArgs {
                query: Some("\"smart contracts\"".into()),
                source_type: Some("arxiv".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(arxiv_only.total_matched, 1);
        assert_eq!(arxiv_only.items[0].paper.id, "arxiv:2603.00101");

        let deep_sample = search_collection_at(
            &db,
            &CollectionSearchParams {
                mode: Some("random_sample".into()),
                sample_size: Some(10),
                seed: Some(7),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(deep_sample.total_matched, 2);
        assert!(deep_sample.items.iter().all(|h| h.source_type == "venue"));

        // Curate upgrades an arXiv ID to its Venue twin and deduplicates when both IDs are passed.
        let curated = curate_collection_at(
            &db,
            CollectionCurateParams {
                groups: vec![CurateGroupInput {
                    label: "Fuzzing".into(),
                    items: vec![
                        CurateItemInput {
                            id: "arxiv:2603.00101".into(),
                            reason: Some("Matched via arXiv ID".into()),
                            keep: false,
                        },
                        CurateItemInput {
                            id: "venue:icse-2026:doi:10.1145/3650000.3650001".into(),
                            reason: Some("Duplicate venue ID".into()),
                            keep: false,
                        },
                    ],
                }],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(curated.curated_count, 1);
        assert_eq!(
            curated.groups[0].items[0].id,
            "venue:icse-2026:doi:10.1145/3650000.3650001"
        );

        // 3. Citations (`snowball_citations_at`) resolves an arXiv-only edge to the Venue twin
        //    (matched via `title + first author`) and excludes the seed's cross-portal twin.
        let citations = snowball_citations_at(
            &db,
            &CollectionCitationsParams {
                paper_ids: vec!["arxiv:2603.00100".into()],
                direction: Some("cited_by".into()),
                limit: Some(10),
            },
        )
        .await
        .unwrap();
        assert_eq!(citations.returned_count, 1);
        assert_eq!(
            citations.items[0].paper.id,
            "venue:icse-2026:doi:10.1145/3650000.3650001"
        );
        assert_eq!(citations.items[0].paper.source_type, "venue");
        assert_eq!(
            citations.items[0].paper.arxiv_id.as_deref(),
            Some("2603.00101")
        );

        // 4. Recommend (`recommend_next_at`) returns ONLY Venue and marks BOTH Venue and arXiv
        //    rows as `recommended_at`, preventing the arXiv twin from surfacing in later batches.
        recommend_state_set_at(
            &db,
            RecommendPoolStateInput {
                keywords: Some(vec![RecommendKeywordChipInput {
                    id: Some("kw-sc".into()),
                    term: "Smart Contracts".into(),
                    enabled: true,
                }]),
                selected_cloud_terms: Some(vec![]),
                word_cloud_top_n: Some(25),
                last_recommended_at: None,
            },
        )
        .unwrap();
        let rec1 = recommend_next_at(
            &db,
            &RecommendNextArgs {
                max_batch_size: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rec1.items.len(), 1);
        assert_eq!(
            rec1.items[0].paper.id,
            "venue:icse-2026:doi:10.1145/3650000.3650001"
        );
        assert_eq!(rec1.items[0].paper.arxiv_id.as_deref(), Some("2603.00101"));
        assert!(!rec1.exhausted);

        let venue_detail = paper_get_at(&db, "venue:icse-2026:doi:10.1145/3650000.3650001")
            .unwrap()
            .unwrap();
        let arxiv_detail = paper_get_at(&db, "arxiv:2603.00101").unwrap().unwrap();
        assert!(venue_detail.recommended_at.is_some());
        assert_eq!(arxiv_detail.recommended_at, venue_detail.recommended_at);

        let rec2 = recommend_next_at(
            &db,
            &RecommendNextArgs {
                max_batch_size: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(rec2.items.is_empty());
        assert!(rec2.exhausted);
    }

    #[test]
    fn synonym_canonicalization_dedupes_store_recommend_and_search_across_aliases() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        // 1. Upsert papers whose titles/abstracts avoid raw alias tokens, testing pure keyword canonicalization.
        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![
                    CollectionPaperUpsertInput {
                        id: "arxiv:2604.00001".into(),
                        title: "Sound Static Taint Flow for C Binaries".into(),
                        authors: vec!["Alice Smith".into(), "Bob Chen".into()],
                        abstract_text:
                            "We present an interprocedural analysis for memory corruption.".into(),
                        published_at: "2026-04-01T00:00:00Z".into(),
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.SE".into(),
                        categories: vec!["cs.SE".into()],
                        url: "https://arxiv.org/abs/2604.00001".into(),
                        arxiv_id: Some("2604.00001".into()),
                        keywords: vec![
                            "Defect Detection".into(),
                            "Bug Detection".into(),
                            "Software Vulnerability Detection".into(),
                            "Fuzz Testing".into(),
                            "APR".into(),
                        ],
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "venue:icse-2026:doi:10.1145/9990001".into(),
                        title: "Sound Static Taint Flow for C Binaries".into(),
                        authors: vec!["Alice Smith".into(), "Bob Chen".into()],
                        abstract_text:
                            "We present an interprocedural analysis for memory corruption.".into(),
                        published_at: "2026-04-15T00:00:00Z".into(),
                        year: 2026,
                        source_type: "venue".into(),
                        source_label: "ICSE 2026".into(),
                        categories: vec!["ICSE 2026".into()],
                        url: "https://doi.org/10.1145/9990001".into(),
                        doi: Some("10.1145/9990001".into()),
                        venue_id: Some("icse-2026".into()),
                        venue_kind: Some("conference".into()),
                        venue_domain: Some("PL/SE".into()),
                        ccf_rank: Some("CCF-A".into()),
                        keywords: vec!["Flaw Detection".into(), "LLM Agent".into()],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        let arxiv_detail = paper_get_at(&db, "arxiv:2604.00001").unwrap().unwrap();
        assert_eq!(
            arxiv_detail.keywords,
            vec!["Vulnerability Detection", "Fuzzing", "Program Repair"]
        );

        // 2. Patching synonym variants onto the venue paper never introduces duplicate tags.
        patch_papers_at(
            &db,
            CollectionPatchPapersArgs {
                patches: vec![CollectionPaperPatch {
                    id: "venue:icse-2026:doi:10.1145/9990001".into(),
                    keywords: Some(vec![
                        "Bug Finding".into(),
                        "Autonomous Agents".into(),
                        "Agentic AI".into(),
                    ]),
                    ..Default::default()
                }],
            },
        )
        .unwrap();

        let venue_detail = paper_get_at(&db, "venue:icse-2026:doi:10.1145/9990001")
            .unwrap()
            .unwrap();
        assert_eq!(
            venue_detail.keywords,
            vec!["Vulnerability Detection", "AI Agent"]
        );

        // 3. Word cloud collapses all synonyms across both rows into canonical buckets.
        let wc = word_cloud_at(&db, &CollectionWordCloudArgs { top_n: Some(20) }).unwrap();
        let vuln_bucket = wc
            .keywords
            .iter()
            .find(|k| k.normalized == "vulnerability detection")
            .unwrap();
        assert_eq!(vuln_bucket.term, "Vulnerability Detection");
        assert_eq!(vuln_bucket.count, 2);
        assert!(wc
            .keywords
            .iter()
            .all(|k| k.normalized != "defect detection"
                && k.normalized != "llm agent"
                && k.normalized != "fuzz testing"));

        // 4. Keyword-field search via alias queries ("Defect Detection", "\"defect detection\"",
        //    "LLM Agent", "Fuzz Testing", "APR") hits canonical stored keywords & enriches twin.
        for alias_query in [
            "Defect Detection",
            "\"defect detection\"",
            "LLM Agent",
            "\"llm agent\"",
            "Fuzz Testing",
            "APR",
        ] {
            let res = search_fast_at(
                &db,
                &CollectionSearchArgs {
                    query: Some(alias_query.into()),
                    fields: vec!["keywords".into()],
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(res.total_matched, 1, "failed search_fast for {alias_query}");
            assert_eq!(res.items[0].paper.id, "venue:icse-2026:doi:10.1145/9990001");
            assert_eq!(
                res.items[0].paper.keywords,
                vec![
                    "Vulnerability Detection",
                    "AI Agent",
                    "Fuzzing",
                    "Program Repair"
                ]
            );
        }

        // 5. User-added recommend chips canonicalize & deduplicate synonyms and score +5.0 on paper_keywords.
        let rec_state = recommend_state_set_at(
            &db,
            RecommendPoolStateInput {
                keywords: Some(vec![
                    RecommendKeywordChipInput {
                        id: None,
                        term: "Defect Detection".into(),
                        enabled: true,
                    },
                    RecommendKeywordChipInput {
                        id: None,
                        term: "Bug Detection".into(),
                        enabled: true,
                    },
                    RecommendKeywordChipInput {
                        id: None,
                        term: "LLM Agents".into(),
                        enabled: false,
                    },
                ]),
                selected_cloud_terms: Some(vec!["Autonomous Agent".into()]),
                word_cloud_top_n: Some(30),
                last_recommended_at: None,
            },
        )
        .unwrap();
        assert_eq!(rec_state.keywords.len(), 2);
        assert_eq!(rec_state.keywords[0].term, "Vulnerability Detection");
        assert_eq!(rec_state.keywords[1].term, "AI Agent");
        assert_eq!(rec_state.selected_cloud_terms, vec!["AI Agent"]);

        let rec_next = recommend_next_at(
            &db,
            &RecommendNextArgs {
                max_batch_size: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rec_next.items.len(), 1);
        assert_eq!(
            rec_next.items[0].matched_keywords,
            vec!["Vulnerability Detection", "AI Agent"]
        );
        assert!(rec_next.items[0].score >= 10.0);
    }

    #[test]
    fn v1_to_v2_migration_drops_citation_edges_wipes_untagged_keywords_and_builds_canonical_works()
    {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE schema_meta (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL
                );
                INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1');
                CREATE TABLE collection_config (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    categories_json TEXT NOT NULL DEFAULT '[\"cs.SE\",\"cs.CR\",\"cs.PL\"]',
                    last_refreshed_at TEXT,
                    latest_arxiv_json TEXT,
                    word_cloud_top_n INTEGER NOT NULL DEFAULT 50,
                    selected_cloud_terms_json TEXT NOT NULL DEFAULT '[]',
                    last_recommended_at TEXT
                );
                INSERT INTO collection_config (id) VALUES (1);
                CREATE TABLE venues (
                    id TEXT PRIMARY KEY NOT NULL,
                    position INTEGER NOT NULL DEFAULT 0,
                    name TEXT NOT NULL,
                    url TEXT NOT NULL,
                    tracks_json TEXT NOT NULL DEFAULT '[]',
                    notes TEXT,
                    mode TEXT NOT NULL DEFAULT 'auto',
                    kind TEXT,
                    domain TEXT,
                    ccf_rank TEXT,
                    last_fetched_at TEXT,
                    latest_published_at TEXT,
                    remote_total_count INTEGER
                );
                CREATE TABLE arxiv_watermarks (
                    category TEXT PRIMARY KEY NOT NULL,
                    latest_published_at TEXT NOT NULL,
                    latest_arxiv_id TEXT NOT NULL,
                    last_synced_at TEXT NOT NULL,
                    oldest_synced_published_at TEXT,
                    remote_total INTEGER,
                    history_complete INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE recommend_keywords (
                    id TEXT PRIMARY KEY NOT NULL,
                    position INTEGER NOT NULL DEFAULT 0,
                    term TEXT NOT NULL,
                    normalized TEXT NOT NULL UNIQUE,
                    enabled INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE papers (
                    row_id INTEGER PRIMARY KEY,
                    id TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    authors_json TEXT NOT NULL DEFAULT '[]',
                    abstract_text TEXT NOT NULL DEFAULT '',
                    published_at TEXT NOT NULL DEFAULT '',
                    published_ymd TEXT NOT NULL DEFAULT '',
                    year INTEGER NOT NULL DEFAULT 2026,
                    source_type TEXT NOT NULL,
                    source_label TEXT NOT NULL,
                    categories_json TEXT NOT NULL DEFAULT '[]',
                    url TEXT NOT NULL DEFAULT '',
                    pdf_url TEXT,
                    arxiv_id TEXT,
                    arxiv_id_norm TEXT,
                    doi TEXT,
                    doi_norm TEXT,
                    title_norm TEXT NOT NULL DEFAULT '',
                    venue_id TEXT,
                    venue_kind TEXT,
                    venue_domain TEXT,
                    ccf_rank TEXT,
                    venue_full TEXT,
                    citation_count INTEGER NOT NULL DEFAULT 0,
                    keywords_json TEXT NOT NULL DEFAULT '[]',
                    keywords_text TEXT NOT NULL DEFAULT '',
                    volume TEXT,
                    issue TEXT,
                    pages TEXT,
                    bibtex TEXT,
                    cool_papers_id TEXT,
                    recommended_at TEXT,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE paper_categories (
                    paper_id TEXT NOT NULL,
                    category TEXT NOT NULL COLLATE NOCASE,
                    PRIMARY KEY (paper_id, category)
                ) WITHOUT ROWID;
                CREATE TABLE paper_keywords (
                    paper_id TEXT NOT NULL,
                    normalized TEXT NOT NULL,
                    display TEXT NOT NULL,
                    PRIMARY KEY (paper_id, normalized)
                ) WITHOUT ROWID;
                CREATE VIRTUAL TABLE papers_fts USING fts5(
                    title, keywords_text, abstract_text,
                    content='papers', content_rowid='row_id',
                    tokenize='unicode61 remove_diacritics 2'
                );
                CREATE TABLE citation_edges (
                    paper_id TEXT PRIMARY KEY,
                    openalex_id TEXT,
                    cited_by_json TEXT NOT NULL DEFAULT '[]',
                    references_json TEXT NOT NULL DEFAULT '[]',
                    cocited_json TEXT NOT NULL DEFAULT '[]',
                    fetched_at TEXT NOT NULL
                );
                INSERT INTO papers (
                    row_id, id, title, title_norm, authors_json, abstract_text, published_at, published_ymd,
                    year, source_type, source_label, categories_json, arxiv_id, arxiv_id_norm,
                    citation_count, keywords_json, keywords_text, updated_at
                ) VALUES (
                    1, 'arxiv:2601.00001', 'Twin Compiler Verification', 'twin compiler verification',
                    '[\"Ada Lovelace\"]', 'Verified compiler passes.', '2026-01-02T00:00:00Z', '2026-01-02',
                    2026, 'arxiv', 'cs.PL', '[\"cs.PL\"]', '2601.00001', '2601.00001',
                    88, '[\"Computer Science\",\"Artificial Intelligence\"]', 'Computer Science Artificial Intelligence cs.PL',
                    '2026-01-02T00:00:00Z'
                );
                INSERT INTO paper_keywords VALUES ('arxiv:2601.00001', 'computer science', 'Computer Science');
                INSERT INTO citation_edges VALUES ('arxiv:2601.00001', 'W1', '[]', '[]', '[]', '2026-01-02T00:00:00Z');",
            )
            .unwrap();
        }

        let conn = ensure_collection_at(&db).unwrap();
        let has_legacy_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'citation_edges'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_legacy_table, 0);

        let detail = paper_get_at(&db, "arxiv:2601.00001").unwrap().unwrap();
        assert_eq!(detail.citation_count, 0);
        assert!(detail.keywords.is_empty());
        assert_eq!(detail.keyword_source, None);

        let kw_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM paper_keywords", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kw_rows, 0);
        let cw_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM canonical_works", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cw_rows, 1);
    }

    #[test]
    fn in_collection_citations_merge_twin_works_and_recompute_on_category_scope_toggle() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        // Insert arxiv:A and venue:A separately at first without shared arxiv_id/doi on venue:A,
        // then bridge them via patch/upsert and test cs.AI scope toggling on citing papers.
        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![
                    CollectionPaperUpsertInput {
                        id: "arxiv:2602.00001".into(),
                        title: "Kernel Sanitizer Guided Fuzzing".into(),
                        authors: vec!["Alice Zhang".into()],
                        source_type: "arxiv".into(),
                        source_label: "cs.CR".into(),
                        categories: vec!["cs.CR".into()],
                        arxiv_id: Some("2602.00001".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "venue:sp-2026:doi:10.1109/sp.2026.1".into(),
                        title: "Kernel Sanitizer Guided Fuzzing (Extended)".into(),
                        authors: vec!["Different Lead".into()],
                        source_type: "venue".into(),
                        source_label: "IEEE S&P 2026".into(),
                        venue_id: Some("sp-2026".into()),
                        doi: Some("10.1109/sp.2026.1".into()),
                        raw_refs: vec!["oa:W999999".into()],
                        ..Default::default()
                    },
                    // Active-scope citing paper (cs.SE) citing the arXiv ID
                    CollectionPaperUpsertInput {
                        id: "arxiv:2602.00002".into(),
                        title: "SE Citer".into(),
                        authors: vec!["Bob Lee".into()],
                        source_type: "arxiv".into(),
                        source_label: "cs.SE".into(),
                        categories: vec!["cs.SE".into()],
                        arxiv_id: Some("2602.00002".into()),
                        raw_refs: vec!["arxiv:2602.00001".into()],
                        ..Default::default()
                    },
                    // Out-of-default-scope citing paper (cs.AI) citing the publisher DOI
                    CollectionPaperUpsertInput {
                        id: "arxiv:2602.00003".into(),
                        title: "AI Citer".into(),
                        authors: vec!["Carol Wu".into()],
                        source_type: "arxiv".into(),
                        source_label: "cs.AI".into(),
                        categories: vec!["cs.AI".into()],
                        arxiv_id: Some("2602.00003".into()),
                        raw_refs: vec!["doi:10.1109/sp.2026.1".into()],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        // Bridge the two previously distinct work_ids by patching openalex_id + publisher DOI onto arxiv:2602.00001
        patch_papers_at(
            &db,
            CollectionPatchPapersArgs {
                patches: vec![
                    CollectionPaperPatch {
                        id: "arxiv:2602.00001".into(),
                        openalex_id: Some("W123456".into()),
                        ..Default::default()
                    },
                    CollectionPaperPatch {
                        id: "venue:sp-2026:doi:10.1109/sp.2026.1".into(),
                        openalex_id: Some("https://openalex.org/W123456".into()),
                        ..Default::default()
                    },
                ],
            },
        )
        .unwrap();

        // With default categories (cs.SE, cs.CR, cs.PL), only cs.SE citer is active -> citation_count == 1 on BOTH twins!
        let v_before = paper_get_at(&db, "venue:sp-2026:doi:10.1109/sp.2026.1")
            .unwrap()
            .unwrap();
        let a_before = paper_get_at(&db, "arxiv:2602.00001").unwrap().unwrap();
        assert_eq!(v_before.citation_count, 1);
        assert_eq!(a_before.citation_count, 1);

        // Enable cs.AI -> AI citer becomes active_in_scope -> citation_count immediately becomes 2!
        config_update_at(
            &db,
            CollectionConfigUpdateArgs {
                categories: Some(vec![
                    "cs.SE".into(),
                    "cs.CR".into(),
                    "cs.PL".into(),
                    "cs.AI".into(),
                ]),
                ..Default::default()
            },
        )
        .unwrap();
        let v_ai_on = paper_get_at(&db, "venue:sp-2026:doi:10.1109/sp.2026.1")
            .unwrap()
            .unwrap();
        assert_eq!(v_ai_on.citation_count, 2);

        // Turn cs.AI back off -> citation_count drops back to 1!
        config_update_at(
            &db,
            CollectionConfigUpdateArgs {
                categories: Some(vec!["cs.SE".into(), "cs.CR".into(), "cs.PL".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        let v_ai_off = paper_get_at(&db, "venue:sp-2026:doi:10.1109/sp.2026.1")
            .unwrap()
            .unwrap();
        assert_eq!(v_ai_off.citation_count, 1);
    }

    #[test]
    fn keyword_priority_overwrite_and_diff_replace_venue_id_preserve_state() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![
                    CollectionPaperUpsertInput {
                        id: "venue:pldi-2026:p1".into(),
                        title: "Equality Saturation for Tensor Compilers".into(),
                        authors: vec!["Max Willsey".into()],
                        source_type: "venue".into(),
                        source_label: "PLDI 2026".into(),
                        venue_id: Some("pldi-2026".into()),
                        openalex_id: Some("W7777".into()),
                        keywords: vec!["Client Guess".into()],
                        keyword_source: Some("client_llm".into()),
                        recommended_at: Some("2026-06-01T00:00:00Z".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "venue:pldi-2026:stale".into(),
                        title: "Withdrawn Paper".into(),
                        source_type: "venue".into(),
                        source_label: "PLDI 2026".into(),
                        venue_id: Some("pldi-2026".into()),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        let conn = ensure_collection_at(&db).unwrap();
        let orig_rowid: i64 = conn
            .query_row(
                "SELECT row_id FROM papers WHERE id = 'venue:pldi-2026:p1'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        // Maintainer LLM (priority 2) overwrites client_llm (priority 1) completely
        patch_papers_at(
            &db,
            CollectionPatchPapersArgs {
                patches: vec![CollectionPaperPatch {
                    id: "venue:pldi-2026:p1".into(),
                    keywords: Some(vec!["Equality Saturation".into()]),
                    keyword_source: Some("maintainer_llm".into()),
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        let d_maint = paper_get_at(&db, "venue:pldi-2026:p1").unwrap().unwrap();
        assert_eq!(d_maint.keywords, vec!["Equality Saturation"]);
        assert_eq!(d_maint.keyword_source.as_deref(), Some("maintainer_llm"));

        // Author keywords (priority 3) overwrite maintainer_llm; subsequent client_llm is ignored!
        // Also run `replace_venue_id = "pldi-2026"` with only `p1`, verifying row_id & openalex_id & recommended_at survive!
        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                replace_venue_id: Some("pldi-2026".into()),
                items: vec![CollectionPaperUpsertInput {
                    id: "venue:pldi-2026:p1".into(),
                    title: "Equality Saturation for Tensor Compilers".into(),
                    authors: vec!["Max Willsey".into()],
                    source_type: "venue".into(),
                    source_label: "PLDI 2026".into(),
                    venue_id: Some("pldi-2026".into()),
                    keywords: vec!["E-Graphs".into(), "Compiler Optimization".into()],
                    keyword_source: Some("author".into()),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();

        patch_papers_at(
            &db,
            CollectionPatchPapersArgs {
                patches: vec![CollectionPaperPatch {
                    id: "venue:pldi-2026:p1".into(),
                    keywords: Some(vec!["Noisy Lower Priority".into()]),
                    keyword_source: Some("client_llm".into()),
                    ..Default::default()
                }],
            },
        )
        .unwrap();

        assert!(paper_get_at(&db, "venue:pldi-2026:stale")
            .unwrap()
            .is_none());
        let d_final = paper_get_at(&db, "venue:pldi-2026:p1").unwrap().unwrap();
        assert_eq!(d_final.keywords, vec!["E-Graph", "Compiler Optimization"]);
        assert_eq!(d_final.keyword_source.as_deref(), Some("author"));
        assert_eq!(
            d_final.recommended_at.as_deref(),
            Some("2026-06-01T00:00:00Z")
        );

        let after_rowid: i64 = conn
            .query_row(
                "SELECT row_id FROM papers WHERE id = 'venue:pldi-2026:p1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after_rowid, orig_rowid);
    }

    #[test]
    fn paper_lineage_and_recommend_vault_catalog_linkage() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");
        let vault_dir = tmp.path().join("vault");
        std::fs::create_dir_all(vault_dir.join(".agentero")).unwrap();
        {
            let vconn =
                rusqlite::Connection::open(vault_dir.join(".agentero").join("catalog.sqlite"))
                    .unwrap();
            vconn
                .execute_batch(
                    "CREATE TABLE papers (
                        path TEXT PRIMARY KEY NOT NULL,
                        title TEXT NOT NULL,
                        authors_json TEXT NOT NULL DEFAULT '[]',
                        doi TEXT,
                        arxiv_id TEXT,
                        updated_at TEXT NOT NULL
                    );
                    INSERT INTO papers VALUES ('papers/base_fuzz.md', 'Foundational Greybox Fuzzing', '[\"Marcel Bohme\"]', '10.1145/base-fuzz', '2501.00001', '2026-01-01T00:00:00.000Z');
                    INSERT INTO papers VALUES ('papers/self_seed.md', 'Target Lineage Paper', '[\"Alice Security\"]', '10.1145/target-1', NULL, '2026-01-02T00:00:00.000Z');",
                )
                .unwrap();
        }

        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![
                    CollectionPaperUpsertInput {
                        id: "venue:ccs-2026:target".into(),
                        title: "Target Lineage Paper".into(),
                        authors: vec!["Alice Security".into()],
                        source_type: "venue".into(),
                        source_label: "CCS 2026".into(),
                        venue_id: Some("ccs-2026".into()),
                        ccf_rank: Some("CCF-A".into()),
                        doi: Some("10.1145/target-1".into()),
                        keywords: vec!["Fuzzing".into()],
                        keyword_source: Some("author".into()),
                        raw_refs: vec![
                            "arxiv:2601.00050".into(),
                            "doi:10.1145/base-fuzz".into(),
                            "oa:W9001".into(),
                            "oa:W9002".into(),
                        ],
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "arxiv:2601.00050".into(),
                        title: "In-Pool Referenced Sanitizer".into(),
                        authors: vec!["Bob Sanitizer".into()],
                        source_type: "arxiv".into(),
                        source_label: "cs.CR".into(),
                        categories: vec!["cs.CR".into()],
                        arxiv_id: Some("2601.00050".into()),
                        keywords: vec!["Fuzzing".into()],
                        keyword_source: Some("maintainer_llm".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "arxiv:2606.00060".into(),
                        title: "In-Pool Citing Followup".into(),
                        authors: vec!["Carol Followup".into()],
                        source_type: "arxiv".into(),
                        source_label: "cs.CR".into(),
                        categories: vec!["cs.CR".into()],
                        arxiv_id: Some("2606.00060".into()),
                        keywords: vec!["Fuzzing".into()],
                        keyword_source: Some("maintainer_llm".into()),
                        raw_refs: vec![
                            "doi:10.1145/target-1".into(),
                            "doi:10.1145/base-fuzz".into(),
                            "oa:W9001".into(),
                            "oa:W9002".into(),
                        ],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();

        let lineage = paper_lineage_at(
            &db,
            &CollectionPaperLineageArgs {
                id: "venue:ccs-2026:target".into(),
                vault_path: Some(vault_dir.to_string_lossy().to_string()),
            },
        )
        .unwrap();
        assert_eq!(lineage.cited_by_in_pool.len(), 1);
        assert_eq!(lineage.cited_by_in_pool[0].id, "arxiv:2606.00060");
        assert_eq!(lineage.references_in_pool.len(), 1);
        assert_eq!(lineage.references_in_pool[0].id, "arxiv:2601.00050");
        assert_eq!(lineage.shared_ref_peers.len(), 1);
        assert_eq!(lineage.shared_ref_peers[0].paper.id, "arxiv:2606.00060");
        assert_eq!(lineage.shared_ref_peers[0].shared_count, 3);
        assert_eq!(lineage.vault_matches.len(), 2);
        assert!(lineage
            .vault_matches
            .iter()
            .any(|m| m.rel_path == "papers/self_seed.md" && m.relation == "self"));
        assert!(lineage
            .vault_matches
            .iter()
            .any(|m| m.rel_path == "papers/base_fuzz.md" && m.relation == "referenced"));

        recommend_state_set_at(
            &db,
            RecommendPoolStateInput {
                keywords: Some(vec![RecommendKeywordChipInput {
                    id: Some("kw-fuzz".into()),
                    term: "Fuzzing".into(),
                    enabled: true,
                }]),
                selected_cloud_terms: Some(vec![]),
                word_cloud_top_n: Some(20),
                last_recommended_at: None,
            },
        )
        .unwrap();

        let rec = recommend_next_at(
            &db,
            &RecommendNextArgs {
                max_batch_size: Some(5),
                vault_path: Some(vault_dir.to_string_lossy().to_string()),
            },
        )
        .unwrap();
        let followup_rec = rec
            .items
            .iter()
            .find(|r| r.paper.id == "arxiv:2606.00060")
            .unwrap();
        assert_eq!(followup_rec.cited_vault_count, 2);
        let non_vault_rec = rec
            .items
            .iter()
            .find(|r| r.paper.id == "arxiv:2601.00050")
            .unwrap();
        assert_eq!(non_vault_rec.cited_vault_count, 0);
        assert!(followup_rec.score > non_vault_rec.score);
    }

    #[tokio::test]
    async fn seed_bake_and_seed_sync_roundtrip_with_429_retry_and_404_skip() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let tmp = tempfile::tempdir().unwrap();
        let src_db = tmp.path().join("src_collection.sqlite");
        let seed_dir = tmp.path().join("seed_out");
        let dst_db = tmp.path().join("dst_collection.sqlite");

        upsert_papers_at(
            &src_db,
            CollectionUpsertPapersArgs {
                items: vec![
                    CollectionPaperUpsertInput {
                        id: "arxiv:2603.00501".into(),
                        title: "Symbolic Execution for WebAssembly Smart Contracts".into(),
                        authors: vec!["Alice Wasm".into()],
                        abstract_text: "We design a concolic symbolic execution engine to uncover reentrancy bugs in WebAssembly smart contracts.".into(),
                        published_at: "2026-03-10T00:00:00Z".into(),
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.SE".into(),
                        categories: vec!["cs.SE".into()],
                        arxiv_id: Some("2603.00501".into()),
                        openalex_id: Some("W501".into()),
                        raw_refs: vec!["oa:W502".into()],
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "arxiv:2603.00502".into(),
                        title: "Foundational Wasm Semantics".into(),
                        authors: vec!["Bob Wasm".into()],
                        abstract_text: "Mechanized operational semantics for WebAssembly.".into(),
                        published_at: "2026-03-01T00:00:00Z".into(),
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.PL".into(),
                        categories: vec!["cs.PL".into()],
                        arxiv_id: Some("2603.00502".into()),
                        openalex_id: Some("W502".into()),
                        keywords: vec!["Formal Verification".into()],
                        keyword_source: Some("author".into()),
                        ..Default::default()
                    },
                    CollectionPaperUpsertInput {
                        id: "arxiv:2603.00503".into(),
                        title: "Diffusion Transformer Scaling Laws".into(),
                        authors: vec!["Carol Vision".into()],
                        abstract_text: "Scaling laws for multimodal diffusion transformers.".into(),
                        published_at: "2026-03-12T00:00:00Z".into(),
                        year: 2026,
                        source_type: "arxiv".into(),
                        source_label: "cs.AI".into(),
                        categories: vec!["cs.AI".into()],
                        arxiv_id: Some("2603.00503".into()),
                        keywords: vec!["Diffusion Models".into()],
                        keyword_source: Some("author".into()),
                        ..Default::default()
                    },
                ],
                arxiv_watermarks: Some(std::collections::HashMap::from([(
                    "cs.SE".to_string(),
                    CollectionArxivWatermarkInput {
                        latest_published_at: "2026-03-10T00:00:00Z".into(),
                        latest_arxiv_id: "2603.00501".into(),
                        last_synced_at: "2026-03-15T00:00:00Z".into(),
                        oldest_synced_published_at: None,
                        remote_total: None,
                        history_complete: Some(true),
                    },
                )])),
                ..Default::default()
            },
        )
        .unwrap();

        // Spawn a tiny local HTTP server testing 429 + Retry-After: 1 on 1st call, 200 OK on 2nd call, and 404 on /missing.json
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let llm_hits = Arc::new(AtomicUsize::new(0));
        let hits_clone = llm_hits.clone();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let hits = hits_clone.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 16384];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req_str = String::from_utf8_lossy(&buf[..n]);
                    if req_str.starts_with("GET /missing.json") {
                        let resp =
                            "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found";
                        let _ = sock.write_all(resp.as_bytes()).await;
                        return;
                    }
                    let attempt = hits.fetch_add(1, Ordering::SeqCst);
                    if attempt == 0 {
                        let resp = "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nContent-Length: 9\r\nConnection: close\r\n\r\nrate limit";
                        let _ = sock.write_all(resp.as_bytes()).await;
                    } else if attempt == 1 && req_str.contains("\"reasoning\"") {
                        let resp = "HTTP/1.1 400 Bad Request\r\nContent-Length: 21\r\nConnection: close\r\n\r\nunsupported reasoning";
                        let _ = sock.write_all(resp.as_bytes()).await;
                    } else {
                        assert!(!req_str.contains("\"max_tokens\""));
                        let body = serde_json::json!({
                            "choices": [{
                                "message": {
                                    "content": "{\"items\":[{\"idx\":0,\"keywords\":[\"Symbolic Execution\",\"Smart Contracts\",\"WebAssembly\"]}]}"
                                }
                            }]
                        })
                        .to_string();
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = sock.write_all(resp.as_bytes()).await;
                    }
                });
            }
        });

        let bake_report = seed_bake_at(
            &src_db,
            SeedBakeOptions {
                out_dir: seed_dir.clone(),
                llm_base_url: format!("http://{addr}/v1"),
                llm_model: "mercury-3-instant".into(),
                llm_api_key: None,
                llm_concurrency: 1,
                llm_batch_size: DEFAULT_BAKE_LLM_BATCH_SIZE,
                llm_rpm: None,
                skip_refs: true,
                skip_llm: false,
                delta_since: None,
            },
        )
        .await
        .unwrap();

        assert!(llm_hits.load(Ordering::SeqCst) >= 3);
        assert_eq!(bake_report.llm_enriched_papers, 1);
        assert_eq!(bake_report.shards.len(), 2); // core + addon-cs-ai

        // 404 remote manifest when `force != Some(true)` returns `skipped: true` cleanly
        let skipped_404 = seed_sync_at(
            &dst_db,
            CollectionSeedSyncArgs {
                manifest_url: Some(format!("http://{addr}/missing.json")),
                force: Some(false),
            },
        )
        .await
        .unwrap();
        assert!(skipped_404.skipped);
        assert_eq!(skipped_404.imported_papers, 0);

        // Import from baked manifest with default categories (core only, 2 papers; cs.AI addon skipped)
        let manifest_path = seed_dir.join("manifest.json").to_string_lossy().to_string();
        let sync1 = seed_sync_at(
            &dst_db,
            CollectionSeedSyncArgs {
                manifest_url: Some(manifest_path.clone()),
                force: Some(false),
            },
        )
        .await
        .unwrap();
        assert!(!sync1.skipped);
        assert_eq!(sync1.imported_papers, 2);
        assert_eq!(sync1.applied_shards.len(), 1);

        let baked_p1 = paper_get_at(&dst_db, "arxiv:2603.00501").unwrap().unwrap();
        assert_eq!(baked_p1.keyword_source.as_deref(), Some("maintainer_llm"));
        assert!(baked_p1
            .keywords
            .contains(&"Symbolic Execution".to_string()));
        let baked_p2 = paper_get_at(&dst_db, "arxiv:2603.00502").unwrap().unwrap();
        assert_eq!(baked_p2.citation_count, 1); // Cited by 2603.00501 via `oa:W502`!

        // Clear `papers` sets `seed_cleared = true`; auto sync skips until `force = true`
        let cleared_state = clear_collection_at(
            &dst_db,
            &CollectionClearArgs {
                scope: "papers".into(),
                venue_id: None,
            },
        )
        .unwrap();
        assert!(cleared_state.seed_cleared);

        let sync_after_clear = seed_sync_at(
            &dst_db,
            CollectionSeedSyncArgs {
                manifest_url: Some(manifest_path.clone()),
                force: Some(false),
            },
        )
        .await
        .unwrap();
        assert!(sync_after_clear.skipped);

        let sync_forced = seed_sync_at(
            &dst_db,
            CollectionSeedSyncArgs {
                manifest_url: Some(manifest_path),
                force: Some(true),
            },
        )
        .await
        .unwrap();
        assert!(!sync_forced.skipped);
        assert!(!sync_forced.state.seed_cleared);
        assert_eq!(sync_forced.imported_papers, 2);

        server.abort();
    }

    #[test]
    fn v2_to_v3_migration_and_upserts_strip_arxiv_announcement_prefixes() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        {
            let conn = ensure_collection_at(&db).unwrap();
            conn.execute_batch(
                "UPDATE schema_meta SET value = '2' WHERE key = 'schema_version';
                 INSERT INTO papers (
                    work_id, id, title, title_norm, authors_json, abstract_text, published_at,
                    published_ymd, year, source_type, source_label, categories_json,
                    arxiv_id, arxiv_id_norm, updated_at
                 ) VALUES (
                    1,
                    'arxiv:2607.07738',
                    'REFORGE: A Method for Benchmarking LLMs'' Reverse Engineering Capabilities in Decompiled Binary Function Naming',
                    'reforgeamethodforbenchmarkingllmsreverseengineeringcapabilitiesindecompiledbinaryfunctionnaming',
                    '[\"Alice Smith\"]',
                    'arXiv:2607.07738v3 Announce Type: replace Abstract: Reverse engineering stripped binaries requires semantic reasoning.',
                    '2026-07-15T00:00:00Z',
                    '2026-07-15',
                    2026,
                    'arxiv',
                    'cs.CR',
                    '[\"cs.CR\"]',
                    '2607.07738',
                    '2607.07738',
                    '2026-07-15T00:00:00Z'
                 );",
            )
            .unwrap();
        }

        let conn = ensure_collection_at(&db).unwrap();
        assert_eq!(
            crate::sqlite::read_schema_version(&conn, crate::sqlite::DbMsgs::COLLECTION).unwrap(),
            SCHEMA_VERSION
        );
        let detail = paper_get_at(&db, "arxiv:2607.07738").unwrap().unwrap();
        assert_eq!(
            detail.abstract_text,
            "Reverse engineering stripped binaries requires semantic reasoning."
        );

        // FTS5 was also refreshed by the update trigger so searching for `Announce` no longer matches.
        let fts_hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM papers_fts WHERE papers_fts MATCH 'Announce'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fts_hits, 0);

        // New upserts strip the prefix as well, even on fresh insert.
        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![CollectionPaperUpsertInput {
                    id: "arxiv:2608.00001".into(),
                    title: "Clean Upsert Check".into(),
                    authors: vec!["Bob Jones".into()],
                    abstract_text:
                        "arXiv:2608.00001v2 Announce Type: replace-cross Abstract: Clean body."
                            .into(),
                    published_at: "2026-08-01T00:00:00Z".into(),
                    year: 2026,
                    source_type: "arxiv".into(),
                    source_label: "cs.SE".into(),
                    categories: vec!["cs.SE".into()],
                    url: "https://arxiv.org/abs/2608.00001".into(),
                    arxiv_id: Some("2608.00001".into()),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();
        let inserted = paper_get_at(&db, "arxiv:2608.00001").unwrap().unwrap();
        assert_eq!(inserted.abstract_text, "Clean body.");
    }

    #[test]
    fn paper_subgraph_resolves_direct_citations_shared_refs_and_unexpanded_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        let mut p1 = make_arxiv_input(1, "cs.SE", "Fuzzing Core", vec!["Fuzzing"]);
        p1.raw_refs = vec![
            "arxiv:2603.00002".into(),
            "arxiv:2603.00004".into(),
            "doi:10.1145/shared-1".into(),
            "doi:10.1145/shared-2".into(),
            "doi:10.1145/shared-3".into(),
        ];

        let mut p2 = make_arxiv_input(2, "cs.SE", "Symbolic Base", vec!["Symbolic Execution"]);
        p2.raw_refs = vec!["doi:10.1145/shared-1".into()];

        let mut p3 = make_arxiv_input(3, "cs.SE", "Sibling Fuzzer", vec!["Fuzzing"]);
        p3.raw_refs = vec![
            "doi:10.1145/shared-1".into(),
            "doi:10.1145/shared-2".into(),
            "doi:10.1145/shared-3".into(),
        ];

        // Outside the initial queried subgraph: p4 is cited by p1, p5 cites p2
        let p4 = make_arxiv_input(4, "cs.SE", "Outside Ref", vec!["Program Analysis"]);
        let mut p5 = make_arxiv_input(5, "cs.SE", "Outside Citing", vec!["Program Analysis"]);
        p5.raw_refs = vec!["arxiv:2603.00002".into()];

        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![p1, p2, p3, p4, p5],
                ..Default::default()
            },
        )
        .unwrap();

        let sub = paper_subgraph_at(
            &db,
            &CollectionSubgraphArgs {
                ids: vec![
                    "arxiv:2603.00001".into(),
                    "arxiv:2603.00002".into(),
                    "arxiv:2603.00003".into(),
                ],
                min_shared_refs: None,
            },
        )
        .unwrap();

        assert_eq!(sub.citation_edges.len(), 1);
        assert_eq!(sub.citation_edges[0].citing_id, "arxiv:2603.00001");
        assert_eq!(sub.citation_edges[0].cited_id, "arxiv:2603.00002");

        assert_eq!(sub.shared_ref_edges.len(), 1);
        assert_eq!(sub.shared_ref_edges[0].source_id, "arxiv:2603.00001");
        assert_eq!(sub.shared_ref_edges[0].target_id, "arxiv:2603.00003");
        assert_eq!(sub.shared_ref_edges[0].shared_count, 3);

        assert_eq!(sub.unexpanded_counts.get("arxiv:2603.00001"), Some(&1));
        assert_eq!(sub.unexpanded_counts.get("arxiv:2603.00002"), Some(&1));
        assert!(!sub.unexpanded_counts.contains_key("arxiv:2603.00003"));
    }

    #[test]
    fn clean_arxiv_key_and_artifact_doi_guards_prevent_pollution() {
        use super::store::{clean_arxiv_key, clean_publisher_doi, is_artifact_or_dataset_doi};

        // Case-insensitive prefix stripping on arXiv identifiers & DOIs
        assert_eq!(
            clean_arxiv_key("10.48550/arXiv.2601.12345v2"),
            Some("2601.12345".into())
        );
        assert_eq!(
            clean_arxiv_key("HTTPS://ARXIV.ORG/ABS/2602.00099V3"),
            Some("2602.00099".into())
        );
        assert_eq!(
            clean_arxiv_key("ARXIV:10.48550/arXiv.2603.11111"),
            Some("2603.11111".into())
        );
        assert_eq!(
            clean_arxiv_key("https://doi.org/10.48550/arXiv.2604.22222v1"),
            Some("2604.22222".into())
        );

        // Repository / artifact / dataset DOIs
        for bad_doi in [
            "10.5281/zenodo.21868420",
            "https://doi.org/10.5281/ZENODO.99999",
            "doi:10.6084/m9.figshare.123456",
            "10.6084/figshare.123456",
            "10.17605/OSF.IO/abcde",
            "10.24433/co.123456.v1",
            "10.7910/DVN/XYZ123",
            "10.5061/dryad.abc123",
            "10.4121/99999",
            "10.13140/RG.2.2.12345.67890",
        ] {
            assert!(
                is_artifact_or_dataset_doi(bad_doi),
                "expected artifact DOI rejection for {bad_doi}"
            );
            assert_eq!(
                clean_publisher_doi(bad_doi),
                None,
                "clean_publisher_doi must reject {bad_doi}"
            );
        }
        assert!(!is_artifact_or_dataset_doi("10.1145/3744916.3773123"));
        assert!(!is_artifact_or_dataset_doi("10.48550/arXiv.2601.12345"));
        assert_eq!(
            clean_publisher_doi("https://doi.org/10.1145/3744916.3773123"),
            Some("10.1145/3744916.3773123".into())
        );

        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        // Fresh upsert with artifact DOI strips doi & doi_norm
        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![CollectionPaperUpsertInput {
                    id: "venue:issre-2026:1".into(),
                    title: "Bridging the Granularity Gap in Software Testing".into(),
                    authors: vec!["Alice Researcher".into()],
                    abstract_text: "Valid abstract from venue.".into(),
                    source_type: "venue".into(),
                    source_label: "ISSRE 2026".into(),
                    venue_id: Some("issre-2026".into()),
                    doi: Some("10.5281/zenodo.21868420".into()),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();
        let p = paper_get_at(&db, "venue:issre-2026:1").unwrap().unwrap();
        assert_eq!(p.doi, None);

        // Simulate legacy polluted row with ex.doi = zenodo + polluted abstract, then re-upsert with empty doi/abs
        {
            let conn = ensure_collection_at(&db).unwrap();
            conn.execute(
                "UPDATE papers SET doi = '10.5281/zenodo.21868420', doi_norm = '10.5281/zenodo.21868420',
                                    abstract_text = 'Polluted Zenodo artifact readme'
                 WHERE id = 'venue:issre-2026:1'",
                [],
            )
            .unwrap();
        }
        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![CollectionPaperUpsertInput {
                    id: "venue:issre-2026:1".into(),
                    title: "Bridging the Granularity Gap in Software Testing".into(),
                    authors: vec!["Alice Researcher".into()],
                    abstract_text: "".into(),
                    source_type: "venue".into(),
                    source_label: "ISSRE 2026".into(),
                    venue_id: Some("issre-2026".into()),
                    doi: Some("https://doi.org/10.5281/zenodo.999".into()),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();
        let cleaned = paper_get_at(&db, "venue:issre-2026:1").unwrap().unwrap();
        assert_eq!(cleaned.doi, None);
        assert_eq!(cleaned.abstract_text, "");
    }

    #[test]
    fn v3_to_v4_migration_fixes_tracks_arxiv_keys_and_strips_artifact_dois() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(schema::DDL_V1).unwrap();
            conn.execute_batch(
                "ALTER TABLE collection_config ADD COLUMN seed_cleared INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE collection_config ADD COLUMN applied_seed_ids_json TEXT NOT NULL DEFAULT '[]';
                 ALTER TABLE papers ADD COLUMN work_id INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE papers ADD COLUMN openalex_id TEXT;
                 ALTER TABLE papers ADD COLUMN keyword_source TEXT NOT NULL DEFAULT '';
                 DROP TABLE IF EXISTS citation_edges;
                 CREATE TABLE canonical_works (
                    work_id         INTEGER PRIMARY KEY,
                    openalex_id     TEXT,
                    doi_norm        TEXT,
                    arxiv_id_norm   TEXT,
                    title_norm      TEXT,
                    author_norm     TEXT,
                    active_in_scope INTEGER NOT NULL DEFAULT 1
                 );
                 CREATE TABLE paper_raw_refs (
                    src_work_id INTEGER NOT NULL,
                    ref_key     TEXT NOT NULL,
                    PRIMARY KEY (src_work_id, ref_key)
                 ) WITHOUT ROWID;
                 CREATE TABLE paper_citations (
                    citing_work_id INTEGER NOT NULL,
                    cited_work_id  INTEGER NOT NULL,
                    PRIMARY KEY (citing_work_id, cited_work_id)
                 ) WITHOUT ROWID;
                 INSERT INTO schema_meta (key, value) VALUES ('schema_version', '3');",
            )
            .unwrap();
            schema::seed_defaults(&conn).unwrap();
            // Simulate old v3 default tracks, plus a user-edited ICLR track and SAS track
            conn.execute_batch(
                "UPDATE venues SET tracks_json = '[\"https://conf.researchr.org/track/issta-2026/issta-2026-papers\"]' WHERE id = 'issta-2026';
                 UPDATE venues SET tracks_json = '[\"https://2026.ecoop.org/track/ecoop-2026-papers\"]' WHERE id = 'ecoop-2026';
                 UPDATE venues SET tracks_json = '[\"https://2026.splashcon.org/track/sas-2026-papers\"]' WHERE id = 'sas-2026';
                 UPDATE venues SET tracks_json = '[\"https://sp2026.ieee-security.org/program-papers.html\"]' WHERE id = 'sp-2026';
                 UPDATE venues SET tracks_json = '[\"https://openreview.net/group?id=NeurIPS.cc/2026/Conference\"]' WHERE id = 'neurips-2026';
                 UPDATE venues SET tracks_json = '[\"https://aclanthology.org/volumes/2026.acl-long/\",\"https://aclanthology.org/volumes/2026.acl-short/\"]' WHERE id = 'acl-2026';
                 UPDATE venues SET tracks_json = '[\"https://custom.user.edit/iclr-2026\"]' WHERE id = 'iclr-2026';

                 INSERT INTO canonical_works (work_id, openalex_id, doi_norm, arxiv_id_norm, title_norm, author_norm, active_in_scope)
                 VALUES
                    (1, NULL, NULL, '10.48550/arxiv.2601.00010', 'foundationalpaper', 'alicesmith', 1),
                    (2, NULL, '10.5281/zenodo.21868420', NULL, 'bridgingthegranularitygap', 'bobjones', 1),
                    (3, NULL, '10.1145/3744916.3773123', NULL, 'genuineicsepaper', 'carollee', 1);

                 INSERT INTO papers (
                    row_id, work_id, id, title, title_norm, authors_json, abstract_text, published_at, published_ymd,
                    year, source_type, source_label, categories_json, arxiv_id, arxiv_id_norm, doi, doi_norm, updated_at
                 ) VALUES
                    (1, 1, 'arxiv:2601.00010', 'Foundational Paper', 'foundationalpaper', '[\"Alice Smith\"]', 'ArXiv study.', '2026-01-10T00:00:00Z', '2026-01-10',
                     2026, 'arxiv', 'cs.SE', '[\"cs.SE\"]', '2601.00010', '10.48550/arxiv.2601.00010', NULL, NULL, '2026-01-10T00:00:00Z'),
                    (2, 2, 'venue:issre-2026:p1', 'Bridging the Granularity Gap', 'bridgingthegranularitygap', '[\"Bob Jones\"]', 'Artifact for Bridging the Granularity Gap on Zenodo', '2026-05-01T00:00:00Z', '2026-05-01',
                     2026, 'venue', 'ISSRE 2026', '[\"ISSRE 2026\"]', NULL, NULL, '10.5281/zenodo.21868420', '10.5281/zenodo.21868420', '2026-05-01T00:00:00Z'),
                    (3, 3, 'venue:icse-2026:p1', 'Genuine ICSE Paper', 'genuineicsepaper', '[\"Carol Lee\"]', 'We propose a novel static analysis tool. Our source code is on Zenodo.', '2026-04-01T00:00:00Z', '2026-04-01',
                     2026, 'venue', 'ICSE 2026', '[\"ICSE 2026\"]', NULL, NULL, '10.1145/3744916.3773123', '10.1145/3744916.3773123', '2026-04-01T00:00:00Z');

                 INSERT INTO paper_raw_refs (src_work_id, ref_key) VALUES
                    (3, 'arxiv:10.48550/arxiv.2601.00010'),
                    (3, 'arxiv:2601.00010'),
                    (2, 'arxiv:10.48550/arxiv.2601.00010'),
                    (3, 'doi:10.5281/zenodo.21868420');",
            )
            .unwrap();
        }

        let conn = ensure_collection_at(&db).unwrap();
        assert_eq!(
            crate::sqlite::read_schema_version(&conn, crate::sqlite::DbMsgs::COLLECTION).unwrap(),
            4
        );

        // 1. `refs_checked_at` column added on canonical_works
        let checked: Option<String> = conn
            .query_row(
                "SELECT refs_checked_at FROM canonical_works WHERE work_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(checked, None);

        // 2. Venue tracks updated only for broken old defaults; SAS and user-edited ICLR preserved
        let state = state_get_at(&db).unwrap();
        let tracks_of = |vid: &str| -> Vec<String> {
            state
                .venues
                .iter()
                .find(|v| v.id == vid)
                .unwrap()
                .tracks
                .clone()
        };
        assert_eq!(
            tracks_of("issta-2026"),
            vec!["https://conf.researchr.org/track/issta-2026/issta-2026-research-papers"]
        );
        assert_eq!(
            tracks_of("ecoop-2026"),
            vec!["https://2026.ecoop.org/track/ecoop-2026-technical-papers"]
        );
        assert_eq!(
            tracks_of("sas-2026"),
            vec!["https://2026.splashcon.org/track/sas-2026-papers"]
        );
        assert_eq!(
            tracks_of("sp-2026"),
            vec!["https://sp2026.ieee-security.org/accepted-papers.html"]
        );
        assert_eq!(
            tracks_of("neurips-2026"),
            vec!["https://neurips.cc/virtual/2026/papers.html"]
        );
        assert_eq!(
            tracks_of("acl-2026"),
            vec![
                "https://2026.aclweb.org/program/accepted_papers/",
                "https://aclanthology.org/volumes/2026.acl-long/",
                "https://aclanthology.org/volumes/2026.acl-short/",
            ]
        );
        assert_eq!(
            tracks_of("iclr-2026"),
            vec!["https://custom.user.edit/iclr-2026"]
        );

        // 3. Malformed `arxiv:10.48550/` cleaned in paper_raw_refs and canonical_works (with PK collision handled)
        let malformed_refs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM paper_raw_refs WHERE ref_key LIKE 'arxiv:10.48550/%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(malformed_refs, 0);
        let cw1_arxiv: Option<String> = conn
            .query_row(
                "SELECT arxiv_id_norm FROM canonical_works WHERE work_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cw1_arxiv.as_deref(), Some("2601.00010"));

        // 4. Zenodo DOI & artifact abstract stripped; genuine paper abstract + publisher DOI preserved
        let p2 = paper_get_at(&db, "venue:issre-2026:p1").unwrap().unwrap();
        assert_eq!(p2.doi, None);
        assert_eq!(p2.abstract_text, "");
        let cw2_doi: Option<String> = conn
            .query_row(
                "SELECT doi_norm FROM canonical_works WHERE work_id = 2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cw2_doi, None);

        let p3 = paper_get_at(&db, "venue:icse-2026:p1").unwrap().unwrap();
        assert_eq!(p3.doi.as_deref(), Some("10.1145/3744916.3773123"));
        assert!(p3.abstract_text.contains("novel static analysis tool"));

        // Recomputed citations: work 2 & 3 both cite work 1 via normalized `arxiv:2601.00010`,
        // while work 2 no longer gets false citation via Zenodo DOI!
        let p1 = paper_get_at(&db, "arxiv:2601.00010").unwrap().unwrap();
        assert_eq!(p1.citation_count, 2);
        assert_eq!(p2.citation_count, 0);
    }
}
