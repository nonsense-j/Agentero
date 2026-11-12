//! Unified `collection.sqlite` storage, FTS5 boolean search, recommendation engine,
//! and in-collection citation snowballing for Plaza Paper Collection & Discover.

pub mod citations;
pub mod models;
pub mod recommend;
pub mod schema;
pub mod search;
pub mod store;

/// CLI flag used when spawning the session-scoped `agentero-collection` stdio MCP.
pub const COLLECTION_MCP_WORKER_ARG: &str = "--agentero-collection-mcp";

pub use citations::snowball_citations_at;
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
    use citations::{save_cached_edges_conn, CachedPaperEdges, ExternalPaperStub};

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
                items: vec![CollectionPaperUpsertInput {
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
                }],
                ..Default::default()
            },
        )
        .unwrap();

        // Re-upsert with placeholder abstract, lower citations, null recommended_at, and new keyword
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
                    citation_count: Some(3),
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
        assert_eq!(detail.citation_count, 42);
        assert_eq!(
            detail.recommended_at.as_deref(),
            Some("2026-04-02T12:00:00Z")
        );
        assert_eq!(detail.pdf_url.as_deref(), Some("https://dl.acm.org/pdf/1"));
        assert_eq!(
            detail.keywords,
            vec![
                "LLM Agent".to_string(),
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
                        },
                        CurateItemInput {
                            id: "arxiv:2603.00002".into(),
                            reason: Some("Disabled cs.AI".into()),
                        },
                    ],
                }],
                mode: None,
                suggested_follow_ups: vec![],
            },
        )
        .unwrap();
        assert_eq!(curated.curated_count, 1);
        assert_eq!(curated.dropped_unknown_ids, vec!["arxiv:2603.00002"]);

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
                    make_arxiv_input(1, "cs.SE", "Paper One", vec!["llm agent", "ebpf"]),
                    make_arxiv_input(2, "cs.SE", "Paper Two", vec!["LLM Agent", "eBPF"]),
                    make_arxiv_input(3, "cs.SE", "Paper Three", vec!["LLM AGENT", "eBPF"]),
                ],
                ..Default::default()
            },
        )
        .unwrap();

        let wc = word_cloud_at(&db, &CollectionWordCloudArgs { top_n: Some(20) }).unwrap();
        let llm_chip = wc
            .keywords
            .iter()
            .find(|k| k.normalized == "llm agent")
            .unwrap();
        assert_eq!(llm_chip.term, "LLM Agent");
        assert_eq!(llm_chip.count, 3);
        assert_eq!(llm_chip.unrecommended_count, 3);

        let ebpf_chip = wc.keywords.iter().find(|k| k.normalized == "ebpf").unwrap();
        assert_eq!(ebpf_chip.term, "eBPF");

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

        upsert_papers_at(
            &db,
            CollectionUpsertPapersArgs {
                items: vec![
                    make_arxiv_input(10, "cs.SE", "Seed Fuzzing Paper", vec!["Fuzzing", "Rust"]),
                    make_arxiv_input(11, "cs.SE", "Citing Fuzzing Followup", vec!["Fuzzing"]),
                    make_arxiv_input(12, "cs.SE", "Referenced Foundational Work", vec!["Rust"]),
                ],
                ..Default::default()
            },
        )
        .unwrap();

        {
            let mut conn = ensure_collection_at(&db).unwrap();
            save_cached_edges_conn(
                &mut conn,
                &[(
                    "arxiv:2603.00010".into(),
                    CachedPaperEdges {
                        openalex_id: Some("W10".into()),
                        cited_by: vec![ExternalPaperStub {
                            arxiv_id: Some("2603.00011".into()),
                            title: "Citing Fuzzing Followup".into(),
                            cited_by_count: 5,
                            ..Default::default()
                        }],
                        references: vec![ExternalPaperStub {
                            arxiv_id: Some("2603.00012".into()),
                            title: "Referenced Foundational Work".into(),
                            cited_by_count: 20,
                            ..Default::default()
                        }],
                        cocited_2026: vec![],
                    },
                )],
            )
            .unwrap();
        }

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
    fn legacy_dblp_schema_auto_reset_and_venue_management_crud_work() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("collection.sqlite");

        // 1. Pre-populate a legacy `venues(dblp_stream)` table and verify `ensure_collection_at` resets cleanly
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE venues (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, dblp_stream TEXT);
                 INSERT INTO venues VALUES ('ase-2026', 'ASE 2026', 'https://dblp.uni-trier.de/db/conf/kbse/ase2026.html', 'conf/kbse');",
            )
            .unwrap();
        }

        let initial = state_get_at(&db).unwrap();
        assert_eq!(initial.venues.len(), 28);
        assert!(initial
            .venues
            .iter()
            .all(|v| !v.url.contains("dblp") && v.tracks.iter().all(|t| !t.contains("dblp"))));

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
        assert_eq!(fast.items[0].paper.citation_count, 14);

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
                        },
                        CurateItemInput {
                            id: "venue:icse-2026:doi:10.1145/3650000.3650001".into(),
                            reason: Some("Duplicate venue ID".into()),
                        },
                    ],
                }],
                mode: None,
                suggested_follow_ups: vec![],
            },
        )
        .unwrap();
        assert_eq!(curated.curated_count, 1);
        assert_eq!(
            curated.groups[0].items[0].id,
            "venue:icse-2026:doi:10.1145/3650000.3650001"
        );

        // 3. Citations (`snowball_citations_at`) resolves an arXiv-only stub to the Venue twin
        //    (matched via `title + first 2 authors`) and excludes the seed's cross-portal twin.
        {
            let mut conn = ensure_collection_at(&db).unwrap();
            save_cached_edges_conn(
                &mut conn,
                &[(
                    "arxiv:2603.00100".into(),
                    CachedPaperEdges {
                        openalex_id: Some("W100".into()),
                        cited_by: vec![
                            ExternalPaperStub {
                                arxiv_id: Some("2603.00101".into()),
                                cited_by_count: 14,
                                ..Default::default()
                            },
                            ExternalPaperStub {
                                doi: Some("10.1145/3650000.3650000".into()),
                                title: "Seed Program Repair Study.".into(),
                                cited_by_count: 3,
                                ..Default::default()
                            },
                        ],
                        references: vec![],
                        cocited_2026: vec![],
                    },
                )],
            )
            .unwrap();
        }
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
            },
        )
        .unwrap();
        assert!(rec2.items.is_empty());
        assert!(rec2.exhausted);
    }
}
