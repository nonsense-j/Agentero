import { describe, expect, it, vi } from "vitest";
import { writeJsonStorage } from "@/lib/core/storage";
import {
	applyFreshVenueItems,
	backfillSpringerAbstracts,
	type CollectionPaperItem,
	CURRENT_VENUE_SYNC_VERSION,
	DEFAULT_ARXIV_CATEGORIES,
	DEFAULT_COLLECTION_VENUES,
	extractSpringerHtmlAbstract,
	fetchCsdlVenuePapers,
	fetchDataCiteLipicsPapers,
	fetchDblpSparqlVenuePapers,
	fetchMoreArxivCollection,
	fetchMultiChannelVenuePapers,
	fetchVenueStructuredPapers,
	isConfirmedVenueAcceptance,
	isPreloadingCollection,
	isVenueAlreadyLoaded,
	loadCollectionState,
	mergeCollectionItems,
	parseAcceptedVenueArxivXml,
	parseArxivAtomXml,
	parseCoolPapersVenueHtml,
	parseOfficialVenueProgramHtml,
	preloadAll2026ArxivInBackground,
	refreshVenueCollection,
	resetCollectionMemoryForTests,
	saveCollectionState,
	syncArxivCategoriesIncremental,
	VENUE_SPEC_BY_ID,
} from "@/lib/plaza/collection";

describe("Plaza Paper Collection incremental arXiv & full multi-channel Venue sync", () => {
	it("paginates OpenAlex page=1..N beyond 200 items without API-key cursor 401s and excludes ICSE-Companion DOIs", async () => {
		const venue = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "icse-2026");
		if (!venue) throw new Error("Missing icse-2026");

		const makeWork = (idx: number, doiPrefix = "10.1145/3744916") => ({
			id: `https://openalex.org/W${idx}`,
			title: `Automated Software Engineering Study Part ${idx}`,
			publication_year: 2026,
			publication_date: "2026-04-02",
			doi: `https://doi.org/${doiPrefix}.${3780000 + idx}`,
			cited_by_count: idx % 7,
			abstract_inverted_index: {
				We: [0],
				present: [1],
				an: [2],
				automated: [3],
				verification: [4],
				technique: [5],
				for: [6],
				large: [7],
				software: [8],
				systems: [9],
			},
			authorships: [{ author: { display_name: `Author ${idx}` } }],
			primary_location: {
				landing_page_url: `https://doi.org/${doiPrefix}.${3780000 + idx}`,
				source: {
					id: "https://openalex.org/S4210203175",
					// OpenAlex mislabels S4210203175 with Companion in display_name even for main-track 3744916 DOIs
					display_name: "ICSE-Companion Proceedings",
				},
			},
		});

		const calls: string[] = [];
		const mockFetchJson = async <T = unknown>(url: string): Promise<T> => {
			calls.push(url);
			const decoded = decodeURIComponent(url);
			if (
				decoded.includes("locations.source.id:") &&
				url.includes("&page=1&")
			) {
				return {
					meta: { count: 245 },
					results: Array.from({ length: 200 }, (_, i) => makeWork(i + 1)),
				} as T;
			}
			if (
				decoded.includes("locations.source.id:") &&
				url.includes("&page=2&")
			) {
				return {
					meta: { count: 245 },
					results: [
						...Array.from({ length: 45 }, (_, i) => makeWork(201 + i)),
						// Excluded ICSE-Companion volume 3774748 must be dropped
						makeWork(999, "10.1145/3774748"),
					],
				} as T;
			}
			return {
				meta: { count: 0 },
				results: [],
			} as T;
		};

		const res = await fetchVenueStructuredPapers(venue, 2026, mockFetchJson);
		expect(calls.some((u) => u.includes("&page=1&"))).toBe(true);
		expect(calls.some((u) => u.includes("&page=2&"))).toBe(true);
		expect(calls.every((u) => !u.includes("cursor="))).toBe(true);
		expect(res.items).toHaveLength(245);
		expect(res.remoteTotalCount).toBe(245);
	});

	it("accepts genuine main-conference arXiv metadata for NeurIPS/ICML 2026 while rejecting workshops and unaccepted submissions", () => {
		expect(
			isConfirmedVenueAcceptance("Accepted at NeurIPS 2026 (Spotlight)", [
				"NeurIPS 2026",
			]),
		).toBe(true);
		expect(isConfirmedVenueAcceptance("EIML@ICML 2026", ["ICML 2026"])).toBe(
			false,
		);
		expect(
			isConfirmedVenueAcceptance("Accepted at ICML 2026 Workshop on Agents", [
				"ICML 2026",
			]),
		).toBe(false);
		expect(
			isConfirmedVenueAcceptance("Submitted to ICLR 2026", ["ICLR 2026"]),
		).toBe(false);

		const neuripsVenue = DEFAULT_COLLECTION_VENUES.find(
			(v) => v.id === "neurips-2026",
		);
		const neuripsSpec = VENUE_SPEC_BY_ID.get("neurips-2026");
		if (!neuripsVenue) throw new Error("Missing neurips-2026");

		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2605.10001v2</id>
    <updated>2026-09-25T12:00:00Z</updated>
    <published>2026-05-10T08:00:00Z</published>
    <title>Scaling Test-Time Reasoning for Transformer Agents</title>
    <summary>We propose a scalable test-time reasoning algorithm for multi-step transformer agents with provable convergence.</summary>
    <author><name>Grace Hopper</name></author>
    <arxiv:comment>Accepted to NeurIPS 2026 main track</arxiv:comment>
    <category term="cs.AI"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2605.10002v1</id>
    <updated>2026-09-26T12:00:00Z</updated>
    <published>2026-05-11T08:00:00Z</published>
    <title>Workshop Note on Small Prompts</title>
    <summary>We study small prompts in a workshop setting with preliminary observations across toy tasks.</summary>
    <author><name>Bob Builder</name></author>
    <arxiv:comment>NeurIPS 2026 Workshop on Foundation Models</arxiv:comment>
    <category term="cs.AI"/>
  </entry>
</feed>`;
		const accepted = parseAcceptedVenueArxivXml(
			xml,
			neuripsVenue,
			neuripsSpec,
			2026,
		);
		expect(accepted).toHaveLength(1);
		expect(accepted[0]?.id).toBe("venue:neurips-2026:arxiv:2605.10001");
		expect(accepted[0]?.venueId).toBe("neurips-2026");
	});

	it("preserves papers across both arXiv and Venue portals in mergeCollectionItems and performs timestamp-diff incremental sync for arXiv", async () => {
		const arxivCopy: CollectionPaperItem = {
			id: "arxiv:2605.10001",
			arxivId: "2605.10001",
			title: "Scaling Test-Time Reasoning for Transformer Agents",
			authors: ["Grace Hopper"],
			abstract:
				"We propose a scalable test-time reasoning algorithm for multi-step transformer agents with provable convergence.",
			publishedAt: "2026-05-10T08:00:00Z",
			year: 2026,
			sourceType: "arxiv",
			sourceLabel: "cs.AI",
			categories: ["cs.AI"],
			url: "https://arxiv.org/abs/2605.10001",
		};
		const neuripsCopy: CollectionPaperItem = {
			id: "venue:neurips-2026:arxiv:2605.10001",
			arxivId: "2605.10001",
			title: "Scaling Test-Time Reasoning for Transformer Agents",
			authors: ["Grace Hopper"],
			abstract:
				"We propose a scalable test-time reasoning algorithm for multi-step transformer agents with provable convergence.",
			publishedAt: "2026-09-25T12:00:00Z",
			year: 2026,
			sourceType: "venue",
			sourceLabel: "NeurIPS 2026",
			venueId: "neurips-2026",
			venueKind: "conference",
			venueDomain: "AI",
			ccfRank: "CCF-A",
			categories: ["NeurIPS 2026", "AI", "CCF-A"],
			url: "https://arxiv.org/abs/2605.10001",
		};

		const merged = mergeCollectionItems([[arxivCopy], [neuripsCopy]]);
		expect(merged).toHaveLength(2);
		expect(merged.some((p) => p.sourceType === "arxiv")).toBe(true);
		expect(
			merged.some(
				(p) => p.sourceType === "venue" && p.venueId === "neurips-2026",
			),
		).toBe(true);

		// 1. Unchanged timestamp probe -> skips full feed & OpenAlex enrichment completely
		const unchangedCalls: string[] = [];
		const statusEvents: string[] = [];
		const unchangedSync = await syncArxivCategoriesIncremental(
			["cs.AI"],
			[arxivCopy],
			{
				"cs.AI": {
					latestArxivId: "2605.10001",
					latestPublishedAt: "2026-05-10T08:00:00Z",
					lastSyncedAt: "2026-05-10T09:00:00Z",
				},
			},
			true,
			{
				fetchText: async (url) => {
					unchangedCalls.push(url);
					return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
						<entry>
							<id>http://arxiv.org/abs/2605.10001v1</id>
							<published>2026-05-10T08:00:00Z</published>
							<title>Scaling Test-Time Reasoning for Transformer Agents</title>
							<summary>We propose a scalable test-time reasoning algorithm for multi-step transformer agents with provable convergence.</summary>
							<author><name>Grace Hopper</name></author>
							<arxiv:primary_category term="cs.AI"/>
						</entry>
					</feed>`;
				},
				fetchJson: async <T>() => {
					unchangedCalls.push("openalex");
					return {} as T;
				},
				onCategoryStatus: (cat, status) => {
					statusEvents.push(`${cat}:${status}`);
				},
			},
		);
		expect(unchangedCalls).toHaveLength(1);
		expect(unchangedCalls[0]).toContain("max_results=1");
		expect(unchangedSync.deltaItems).toHaveLength(0);
		expect(statusEvents).toEqual(["cs.AI:refreshing", "cs.AI:done"]);

		// 2. Newer timestamp detected -> fetches incremental window since watermark & enriches ONLY the new item
		const deltaUrls: string[] = [];
		const deltaSync = await syncArxivCategoriesIncremental(
			["cs.AI"],
			[arxivCopy],
			{
				"cs.AI": {
					latestArxivId: "2605.10001",
					latestPublishedAt: "2026-05-10T08:00:00Z",
					lastSyncedAt: "2026-05-10T09:00:00Z",
				},
			},
			true,
			{
				fetchText: async (url) => {
					deltaUrls.push(url);
					if (url.includes("rss.arxiv.org")) return "<rss></rss>";
					return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
						<entry>
							<id>http://arxiv.org/abs/2605.10009v1</id>
							<published>2026-05-12T10:00:00Z</published>
							<title>New Incremental Agent Verification Paper</title>
							<summary>We introduce a brand-new incremental formal verification procedure for autonomous tool agents.</summary>
							<author><name>Alan Turing</name></author>
							<arxiv:primary_category term="cs.AI"/>
						</entry>
						<entry>
							<id>http://arxiv.org/abs/2605.10001v1</id>
							<published>2026-05-10T08:00:00Z</published>
							<title>Scaling Test-Time Reasoning for Transformer Agents</title>
							<summary>We propose a scalable test-time reasoning algorithm for multi-step transformer agents with provable convergence.</summary>
							<author><name>Grace Hopper</name></author>
							<arxiv:primary_category term="cs.AI"/>
						</entry>
					</feed>`;
				},
				fetchJson: async <T>(url: string) => {
					deltaUrls.push(url);
					return { results: [] } as T;
				},
			},
		);
		expect(
			deltaUrls.some((u) => u.includes("submittedDate:[202605092000+TO+")),
		).toBe(true);
		expect(deltaSync.deltaItems).toHaveLength(1);
		expect(deltaSync.deltaItems[0]?.arxivId).toBe("2605.10009");
		expect(deltaSync.nextWatermarks["cs.AI"]?.latestArxivId).toBe("2605.10009");
	});

	it("keeps cs.AI disabled by default in arXiv Collection while allowing manual opt-in", () => {
		expect(DEFAULT_ARXIV_CATEGORIES).toEqual(["cs.SE", "cs.CR", "cs.PL"]);

		const store = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => {
				store.set(k, v);
			},
			removeItem: (k: string) => {
				store.delete(k);
			},
		});

		try {
			// Simulate pre-v2 cached state where cs.AI was enabled by the old default
			writeJsonStorage("plaza:collection:state:v2", {
				categories: ["cs.SE", "cs.CR", "cs.PL", "cs.AI"],
				venues: [...DEFAULT_COLLECTION_VENUES],
				items: [
					{
						id: "arxiv:2606.00001",
						arxivId: "2606.00001",
						title: "Pure AI Preprint Without SE Tag",
						authors: ["Alice"],
						abstract:
							"We study pure general artificial intelligence scaling laws across multimodal benchmarks.",
						publishedAt: "2026-06-01T00:00:00Z",
						year: 2026,
						sourceType: "arxiv",
						sourceLabel: "cs.AI",
						categories: ["cs.AI"],
						url: "https://arxiv.org/abs/2606.00001",
					},
					{
						id: "arxiv:2606.00002",
						arxivId: "2606.00002",
						title: "Automated Program Repair with Static Analysis",
						authors: ["Bob"],
						abstract:
							"We propose a sound static analysis guided automated program repair framework for large-scale production software systems.",
						publishedAt: "2026-06-02T00:00:00Z",
						year: 2026,
						sourceType: "arxiv",
						sourceLabel: "cs.SE",
						categories: ["cs.SE"],
						url: "https://arxiv.org/abs/2606.00002",
					},
				],
				lastRefreshedAt: "2026-06-02T01:00:00Z",
				latestArxiv: null,
			});
			resetCollectionMemoryForTests();

			const migrated = loadCollectionState();
			expect(migrated.categories).toEqual(["cs.SE", "cs.CR", "cs.PL"]);
			expect(migrated.items.map((p) => p.id)).toEqual(["arxiv:2606.00002"]);

			// If the user explicitly turns cs.AI back ON, their choice persists across reload
			saveCollectionState({
				...migrated,
				categories: ["cs.SE", "cs.CR", "cs.PL", "cs.AI"],
			});
			resetCollectionMemoryForTests();
			const reloadedAfterOptIn = loadCollectionState();
			expect(reloadedAfterOptIn.categories).toEqual([
				"cs.SE",
				"cs.CR",
				"cs.PL",
				"cs.AI",
			]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("fetches DOI-less DBLP 2026 papers via official SPARQL and enriches abstracts via OpenAlex title search, plus lowercase LIPIcs DOI prefixes", async () => {
		const usenix = DEFAULT_COLLECTION_VENUES.find(
			(v) => v.id === "usenix-sec-2026",
		);
		const ecoop = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ecoop-2026");
		if (!usenix || !ecoop)
			throw new Error("Missing usenix-sec-2026 or ecoop-2026");

		const ecoopUrls: string[] = [];
		await fetchVenueStructuredPapers(ecoop, 2026, async <T>(url: string) => {
			ecoopUrls.push(url);
			return { meta: { count: 0, next_cursor: null }, results: [] } as T;
		});
		expect(
			ecoopUrls.some((u) =>
				decodeURIComponent(u).includes("doi_starts_with:10.4230/lipics.ecoop"),
			),
		).toBe(true);

		const sparqlRes = await fetchDblpSparqlVenuePapers(
			usenix,
			2026,
			new Set(),
			async <T>(url: string) => {
				if (url.includes("sparql.dblp.org")) {
					return {
						results: {
							bindings: [
								{
									title: {
										value:
											"Kernel Isolation Against Speculative Side Channels.",
									},
									ee: {
										value:
											"https://www.usenix.org/conference/usenixsecurity26/presentation/alice",
									},
									authors: { value: "Alice Security 0001||Bob Systems" },
								},
							],
						},
					} as T;
				}
				if (decodeURIComponent(url).includes("title.search:")) {
					return {
						results: [
							{
								id: "https://openalex.org/W999",
								title: "Kernel Isolation Against Speculative Side Channels",
								publication_year: 2026,
								publication_date: "2026-08-12",
								cited_by_count: 4,
								abstract_inverted_index: {
									We: [0],
									design: [1],
									a: [2],
									practical: [3],
									kernel: [4],
									isolation: [5],
									mechanism: [6],
									against: [7],
									speculative: [8],
									side: [9],
									channels: [10],
								},
								authorships: [
									{ author: { display_name: "Alice Security" } },
									{ author: { display_name: "Bob Systems" } },
								],
							},
						],
					} as T;
				}
				return { results: [] } as T;
			},
		);

		expect(sparqlRes.items).toHaveLength(1);
		expect(sparqlRes.items[0]?.authors).toEqual([
			"Alice Security",
			"Bob Systems",
		]);
		expect(sparqlRes.items[0]?.abstract).toContain(
			"practical kernel isolation mechanism",
		);
		expect(sparqlRes.items[0]?.citationCount).toBe(4);
	});

	it("treats v5-synced Venues as immutable on open, upgrades pre-v5 caches once, and does not toggle preloading flag during Venue refresh", async () => {
		const ase = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ase-2026");
		if (!ase) throw new Error("Missing ase-2026");

		expect(CURRENT_VENUE_SYNC_VERSION).toBe(5);
		// Cold venue -> not yet loaded
		expect(isVenueAlreadyLoaded(ase, [])).toBe(false);
		// Legacy v4 venue -> requires one-time v5 upgrade
		expect(
			isVenueAlreadyLoaded(
				{ ...ase, syncVersion: 4, lastFetchedAt: "2026-06-01T00:00:00Z" },
				[],
			),
		).toBe(false);

		// Once v5 synced, opening Paper Collection never re-checks or re-fetches it
		const loadedVenues = DEFAULT_COLLECTION_VENUES.map((v) => ({
			...v,
			syncVersion: CURRENT_VENUE_SYNC_VERSION,
			lastFetchedAt: "2026-06-02T00:00:00Z",
		}));
		expect(isVenueAlreadyLoaded(loadedVenues[0] ?? ase, [])).toBe(true);

		saveCollectionState({
			categories: ["cs.SE", "cs.CR", "cs.PL"],
			venues: loadedVenues,
			items: [],
			lastRefreshedAt: "2026-06-02T00:00:00Z",
			latestArxiv: null,
		});
		const stateAfterOpen = await refreshVenueCollection({ skipLoaded: true });
		expect(stateAfterOpen.lastRefreshedAt).toBe("2026-06-02T00:00:00Z");
		expect(isPreloadingCollection()).toBe(false);
	});

	it("retains ASE 2026 proceedings papers without public abstracts, excludes workshops/frontmatter, backfills S2 abstracts, and paginates DBLP SPARQL", async () => {
		const ase = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ase-2026");
		if (!ase) throw new Error("Missing ase-2026");

		// 1. Multi-page DBLP SPARQL (`OFFSET`) + workshop/editorship exclusion + abstract-less retention
		const sparqlCalls: string[] = [];
		const pagedDblp = await fetchDblpSparqlVenuePapers(
			ase,
			2026,
			new Set(),
			async <T>(url: string) => {
				if (url.includes("sparql.dblp.org")) {
					sparqlCalls.push(decodeURIComponent(url));
					if (decodeURIComponent(url).includes("OFFSET 0")) {
						return {
							results: {
								bindings: [
									{
										rec: { value: "https://dblp.org/rec/conf/kbse/ase2026" },
										title: {
											value:
												"Proceedings of the 41st IEEE/ACM International Conference on Automated Software Engineering, ASE 2026",
										},
										authors: { value: "Chair One" },
										pubIn: { value: "ASE" },
									},
									{
										rec: { value: "https://dblp.org/rec/conf/kbse/ws1" },
										title: {
											value: "Prompting Notes at LLM4Code Workshop",
										},
										authors: { value: "Workshop Author" },
										pubIn: { value: "LLM4Code@ASE" },
									},
									{
										rec: { value: "https://dblp.org/rec/conf/kbse/p1" },
										title: {
											value:
												"Sound Concolic Execution for Rust Smart Contracts.",
										},
										doi: { value: "10.1145/3832783.3832801" },
										authors: { value: "Ada Lovelace" },
										pubIn: { value: "ASE" },
									},
									{
										rec: { value: "https://dblp.org/rec/conf/kbse/p2" },
										title: {
											value:
												"Differential Compiler Fuzzing Across WASM Runtimes.",
										},
										doi: { value: "10.1145/3832783.3832802" },
										authors: { value: "Ken Thompson" },
										pubIn: { value: "ASE" },
									},
								],
							},
						} as T;
					}
					return {
						results: {
							bindings: [
								{
									rec: { value: "https://dblp.org/rec/conf/kbse/p3" },
									title: {
										value:
											"Modular Abstract Interpretation for Heap-Manipulating Programs.",
									},
									doi: { value: "10.1145/3832783.3832803" },
									authors: { value: "Patrick Cousot" },
									pubIn: { value: "ASE" },
								},
							],
						},
					} as T;
				}
				// OpenAlex returns null `abstract_inverted_index` (typical for ACM proceedings)
				return { results: [] } as T;
			},
			{ pageSize: 4, maxPages: 4 },
		);

		expect(sparqlCalls).toHaveLength(2);
		expect(sparqlCalls[1]).toContain("OFFSET 4");
		expect(pagedDblp.items).toHaveLength(3);
		expect(pagedDblp.items.every((p) => p.abstract === "")).toBe(true);

		// 2. Full `fetchMultiChannelVenuePapers` when OpenAlex has 30 ACM papers (all without abstracts)
		//    and S2 Bulk supplies preprint abstracts for matched papers without inflating count
		const store = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => {
				store.set(k, v);
			},
			removeItem: (k: string) => {
				store.delete(k);
			},
		});

		try {
			const bundle = await fetchMultiChannelVenuePapers(
				ase,
				2026,
				async <T>(url: string) => {
					if (url.includes("api.openalex.org/works")) {
						return {
							meta: { count: 31, next_cursor: null },
							results: [
								{
									id: "https://openalex.org/W_paratext",
									type: "paratext",
									title: "ASE 2026 Front Matter and Organization",
									publication_year: 2026,
									publication_date: "2026-10-07",
									authorships: [{ author: { display_name: "ACM Staff" } }],
								},
								...Array.from({ length: 30 }, (_, idx) => ({
									id: `https://openalex.org/W_ase_${idx + 1}`,
									type: "article",
									title: `Automated Program Analysis Technique Number ${idx + 1}`,
									publication_year: 2026,
									publication_date: "2026-10-07",
									doi: `https://doi.org/10.1145/3832783.${3832900 + idx}`,
									cited_by_count: idx,
									abstract_inverted_index: null,
									authorships: [
										{ author: { display_name: `Researcher ${idx + 1}` } },
									],
									primary_location: {
										landing_page_url: `https://doi.org/10.1145/3832783.${3832900 + idx}`,
										source: {
											id: "https://openalex.org/S4363608212",
											display_name:
												"Proceedings of the IEEE/ACM International Conference on Automated Software Engineering",
										},
									},
								})),
							],
						} as T;
					}
					if (url.includes("sparql.dblp.org")) {
						// Simulate DBLP lagging behind ACM DL publication
						return { results: { bindings: [] } } as T;
					}
					if (
						url.includes("api.semanticscholar.org/graph/v1/paper/search/bulk")
					) {
						return {
							total: 2,
							token: null,
							data: [
								{
									title: "Automated Program Analysis Technique Number 1",
									abstract:
										"We introduce a scalable static and dynamic program analysis technique evaluated across thirty real-world repositories.",
									year: 2026,
									externalIds: {
										DOI: "10.1145/3832783.3832900",
										ArXiv: "2608.12345",
									},
									authors: [{ name: "Researcher 1" }],
								},
								{
									title: "Unrelated Noisy Workshop Entry",
									abstract:
										"This noisy workshop abstract does not belong to the main proceedings and must not inflate primary count.",
									year: 2026,
									authors: [{ name: "Someone Else" }],
								},
							],
						} as T;
					}
					return { results: [] } as T;
				},
				async () => "<feed></feed>",
			);

			expect(bundle.items).toHaveLength(30);
			const enrichedFirst = bundle.items.find(
				(p) => p.doi === "10.1145/3832783.3832900",
			);
			expect(enrichedFirst?.abstract).toContain(
				"scalable static and dynamic program analysis",
			);
			expect(enrichedFirst?.arxivId).toBe("2608.12345");

			// Reload from storage must NOT strip the remaining 29 abstract-less ASE 2026 papers
			resetCollectionMemoryForTests();
			saveCollectionState({
				categories: ["cs.SE", "cs.CR", "cs.PL"],
				venues: [...DEFAULT_COLLECTION_VENUES],
				items: bundle.items,
				lastRefreshedAt: "2026-10-10T00:00:00Z",
				latestArxiv: null,
			});
			resetCollectionMemoryForTests();
			const reloaded = loadCollectionState();
			expect(
				reloaded.items.filter((i) => i.venueId === "ase-2026"),
			).toHaveLength(30);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("backfills complete 2026 arXiv history via sliding timestamp windows, drops pre-2026 pages cleanly, and cursors fetchMore per category", async () => {
		// 1. All-2025 page must return [] rather than leaking 2025 entries
		const xml2025Only = `<feed xmlns="http://www.w3.org/2005/Atom">
			<entry>
				<id>http://arxiv.org/abs/2512.99999v1</id>
				<published>2025-12-30T10:00:00Z</published>
				<title>Late 2025 Paper That Must Not Leak Into 2026 Pool</title>
				<summary>We present a December 2025 software engineering study that predates 2026.</summary>
				<author><name>Alice</name></author>
			</entry>
		</feed>`;
		expect(parseArxivAtomXml(xml2025Only, 2026)).toEqual([]);

		// 2. Sliding timestamp-window backfill heals incomplete cache and marks `historyComplete: true`
		const store = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => {
				store.set(k, v);
			},
			removeItem: (k: string) => {
				store.delete(k);
			},
		});

		try {
			resetCollectionMemoryForTests();
			// Seed with 2 already-cached top `cs.SE` papers (simulating an incomplete pre-watermark cache)
			saveCollectionState({
				categories: ["cs.SE"],
				venues: [...DEFAULT_COLLECTION_VENUES],
				items: [
					{
						id: "arxiv:2610.00004",
						arxivId: "2610.00004",
						title: "Newest Cached SE Paper Four",
						authors: ["Author 4"],
						abstract:
							"We present automated software verification technique four with complete empirical evaluation.",
						publishedAt: "2026-10-04T12:00:00Z",
						year: 2026,
						sourceType: "arxiv",
						sourceLabel: "cs.SE",
						categories: ["cs.SE"],
						url: "https://arxiv.org/abs/2610.00004",
					},
					{
						id: "arxiv:2609.00003",
						arxivId: "2609.00003",
						title: "Cached SE Paper Three",
						authors: ["Author 3"],
						abstract:
							"We present automated software verification technique three with complete empirical evaluation.",
						publishedAt: "2026-09-03T12:00:00Z",
						year: 2026,
						sourceType: "arxiv",
						sourceLabel: "cs.SE",
						categories: ["cs.SE"],
						url: "https://arxiv.org/abs/2609.00003",
					},
				],
				lastRefreshedAt: "2026-10-05T00:00:00Z",
				latestArxiv: null,
				arxivWatermarks: {
					"cs.SE": {
						latestArxivId: "2610.00004",
						latestPublishedAt: "2026-10-04T12:00:00Z",
						lastSyncedAt: "2026-10-05T00:00:00Z",
					},
				},
			});

			const windowUrls: string[] = [];
			await preloadAll2026ArxivInBackground(["cs.SE"], 5, 2, {
				fetchText: async (url) => {
					windowUrls.push(url);
					if (url.includes("TO+209912312359]")) {
						// Page 1 returns the 2 already-cached items! Old implementation broke early here.
						return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
							<opensearch:totalResults>4</opensearch:totalResults>
							<entry>
								<id>http://arxiv.org/abs/2610.00004v1</id>
								<published>2026-10-04T12:00:00Z</published>
								<title>Newest Cached SE Paper Four</title>
								<summary>We present automated software verification technique four with complete empirical evaluation.</summary>
								<author><name>Author 4</name></author>
							</entry>
							<entry>
								<id>http://arxiv.org/abs/2609.00003v1</id>
								<published>2026-09-03T12:00:00Z</published>
								<title>Cached SE Paper Three</title>
								<summary>We present automated software verification technique three with complete empirical evaluation.</summary>
								<author><name>Author 3</name></author>
							</entry>
						</feed>`;
					}
					if (url.includes("TO+202609031201]")) {
						return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
							<opensearch:totalResults>2</opensearch:totalResults>
							<entry>
								<id>http://arxiv.org/abs/2605.00002v1</id>
								<published>2026-05-02T09:30:00Z</published>
								<title>Earlier Backfilled SE Paper Two</title>
								<summary>We present automated software verification technique two with complete empirical evaluation.</summary>
								<author><name>Author 2</name></author>
							</entry>
							<entry>
								<id>http://arxiv.org/abs/2601.00001v1</id>
								<published>2026-01-10T08:15:00Z</published>
								<title>Earliest January 2026 SE Paper One</title>
								<summary>We present automated software verification technique one with complete empirical evaluation.</summary>
								<author><name>Author 1</name></author>
							</entry>
						</feed>`;
					}
					// Final window before 2026-01-10 returns 0 remaining entries (`totalResults=0`) -> `historyComplete = true`
					return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
						<opensearch:totalResults>0</opensearch:totalResults>
					</feed>`;
				},
				fetchJson: async <T>() => ({ results: [] }) as T,
			});

			const completedState = loadCollectionState();
			expect(completedState.items.map((i) => i.arxivId)).toEqual([
				"2610.00004",
				"2609.00003",
				"2605.00002",
				"2601.00001",
			]);
			expect(completedState.arxivWatermarks?.["cs.SE"]?.remoteTotal).toBe(4);
			expect(completedState.arxivWatermarks?.["cs.SE"]?.historyComplete).toBe(
				true,
			);
			expect(windowUrls).toHaveLength(3);

			// Calling `fetchMoreArxivCollection` for an incomplete single category uses THAT category's oldest timestamp
			saveCollectionState({
				...completedState,
				categories: ["cs.SE", "cs.CR"],
				items: [
					...completedState.items,
					{
						id: "arxiv:2608.00099",
						arxivId: "2608.00099",
						title: "Recent Security Paper",
						authors: ["Sec Author"],
						abstract:
							"We analyze cryptographic protocol security with mechanized proofs across modern implementations.",
						publishedAt: "2026-08-20T15:10:00Z",
						year: 2026,
						sourceType: "arxiv",
						sourceLabel: "cs.CR",
						categories: ["cs.CR"],
						url: "https://arxiv.org/abs/2608.00099",
					},
				],
				arxivWatermarks: {
					...completedState.arxivWatermarks,
					"cs.CR": {
						latestArxivId: "2608.00099",
						latestPublishedAt: "2026-08-20T15:10:00Z",
						oldestSyncedPublishedAt: "2026-08-20T15:10:00Z",
						lastSyncedAt: "2026-10-05T00:00:00Z",
						historyComplete: false,
					},
				},
			});

			const moreUrls: string[] = [];
			const moreRes = await fetchMoreArxivCollection({
				categories: ["cs.CR"],
				maxResultsPerCategory: 50,
				transport: {
					fetchText: async (url) => {
						moreUrls.push(url);
						return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
							<opensearch:totalResults>1</opensearch:totalResults>
							<entry>
								<id>http://arxiv.org/abs/2603.00055v1</id>
								<published>2026-03-12T10:00:00Z</published>
								<title>Older Security Paper From March 2026</title>
								<summary>We present an earlier March 2026 cryptographic analysis for zero-knowledge systems.</summary>
								<author><name>Sec Author Two</name></author>
							</entry>
						</feed>`;
					},
					fetchJson: async <T>() => ({ results: [] }) as T,
				},
			});

			expect(moreUrls).toHaveLength(1);
			expect(moreUrls[0]).toContain("TO+202608201511]");
			expect(moreRes.addedCount).toBe(1);
			expect(moreRes.state.arxivWatermarks?.["cs.CR"]?.historyComplete).toBe(
				true,
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("parses papers.cool venues, CCS/ISSRE official programs, Springer abstracts, retains multi-issue OOPSLA, and purges stale workshop cache on refresh", async () => {
		const icml = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "icml-2026");
		const acl = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "acl-2026");
		const ccs = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ccs-2026");
		const issre = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "issre-2026");
		const oopsla = DEFAULT_COLLECTION_VENUES.find(
			(v) => v.id === "oopsla-2026",
		);
		if (!icml || !acl || !ccs || !issre || !oopsla) {
			throw new Error("Missing target venues");
		}

		// 1. papers.cool venue list HTML (ICML OpenReview + ACL Anthology DOI derivation)
		const coolHtml = `
			<div id="aIH1jyU37z@OpenReview" class="panel paper" keywords="equivariant,sheaf,neural">
				<h2 class="title">
					<a href="https://openreview.net/forum?id=aIH1jyU37z" target="_blank" title="1/6554"><span class="index">#1</span></a>
					<a id="title-aIH1jyU37z@OpenReview" class="title-link" href="/venue/aIH1jyU37z@OpenReview">Foundations of Equivariant Deep Learning</a>
					<a id="pdf-aIH1jyU37z@OpenReview" class="title-pdf" data="https://openreview.net/pdf?id=aIH1jyU37z||md5=cf3eecf">[PDF]</a>
				</h2>
				<p id="authors-aIH1jyU37z@OpenReview" class="metainfo authors">
					<a class="author">Yoshihiro Maruyama</a>
				</p>
				<p id="summary-aIH1jyU37z@OpenReview" class="summary">Symmetry is everywhere in nature and geometric deep learning exploits symmetries in data.</p>
			</div>`;
		const icmlParsed = parseCoolPapersVenueHtml(
			coolHtml,
			icml,
			VENUE_SPEC_BY_ID.get("icml-2026"),
			2026,
		);
		expect(icmlParsed.remoteTotalCount).toBe(6554);
		expect(icmlParsed.items).toHaveLength(1);
		expect(icmlParsed.items[0]?.coolPapersId).toBe("aIH1jyU37z@OpenReview");
		expect(icmlParsed.items[0]?.pdfUrl).toBe(
			"https://openreview.net/pdf?id=aIH1jyU37z",
		);
		expect(icmlParsed.items[0]?.abstract).toContain(
			"geometric deep learning exploits symmetries",
		);

		const aclHtml = `
			<div id="2026.acl-long.12@ACL" class="panel paper" keywords="llm,reasoning">
				<h2 class="title">
					<a href="https://aclanthology.org/2026.acl-long.12/" target="_blank" title="12/4813"><span class="index">#12</span></a>
					<a id="title-2026.acl-long.12@ACL" class="title-link" href="/venue/2026.acl-long.12@ACL">Compositional Semantic Parsing at Scale</a>
					<a id="pdf-2026.acl-long.12@ACL" class="title-pdf" data="https://aclanthology.org/2026.acl-long.12.pdf||md5=111">[PDF]</a>
				</h2>
				<p id="authors-2026.acl-long.12@ACL" class="metainfo authors"><a class="author">Jane Doe</a></p>
				<p id="summary-2026.acl-long.12@ACL" class="summary">We introduce a compositional semantic parser evaluated across twelve multilingual benchmarks.</p>
			</div>`;
		const aclParsed = parseCoolPapersVenueHtml(
			aclHtml,
			acl,
			VENUE_SPEC_BY_ID.get("acl-2026"),
			2026,
		);
		expect(aclParsed.items[0]?.doi).toBe("10.18653/v1/2026.acl-long.12");

		// 2. Official CCS 2026 schedule HTML (comma inside parenthetical affiliation + duplicate slot dedupe)
		const ccsHtml = `
			<ul>
				<li class="schedule-paper" data-paper-id="A#777">
					<p class="schedule-paper-title"><span class="schedule-paper-id">(A#777)</span> Expose Your Disguise: Recovering Source Speaker Identity</p>
					<p class="schedule-authors">Hanlei Zhang (University of California, Berkeley), Yanjiao Chen (Zhejiang University)</p>
				</li>
				<li class="schedule-paper" data-paper-id="A#777">
					<p class="schedule-paper-title"><span class="schedule-paper-id">(A#777)</span> Expose Your Disguise: Recovering Source Speaker Identity</p>
					<p class="schedule-authors">Hanlei Zhang (University of California, Berkeley), Yanjiao Chen (Zhejiang University)</p>
				</li>
			</ul>`;
		const ccsItems = parseOfficialVenueProgramHtml(
			ccsHtml,
			"https://www.sigsac.org/ccs/CCS2026/program/schedule.html",
			ccs,
			VENUE_SPEC_BY_ID.get("ccs-2026"),
			2026,
		);
		expect(ccsItems).toHaveLength(1);
		expect(ccsItems[0]?.title).toBe(
			"Expose Your Disguise: Recovering Source Speaker Identity",
		);
		expect(ccsItems[0]?.authors).toEqual(["Hanlei Zhang", "Yanjiao Chen"]);

		// 3. Official ISSRE 2026 accepted-papers embedded tracks JSON (excludes doctoral & fast-abstracts)
		const issreHtml = `<script>const tracks = [
			{"id":"research-track","label":"Research Track","papers":[{"title":"Fault Localization in Microservices","authors":"Alice Lee, Bob Chen and Carol Wu"}]},
			{"id":"doctoral-symposium","label":"Doctoral Symposium","papers":[{"title":"PhD Plan on Fuzzing","authors":"Student One"}]}
		];</script>`;
		const issreItems = parseOfficialVenueProgramHtml(
			issreHtml,
			"https://cyprusconferences.org/issre2026/accepted-papers/",
			issre,
			VENUE_SPEC_BY_ID.get("issre-2026"),
			2026,
		);
		expect(issreItems).toHaveLength(1);
		expect(issreItems[0]?.authors).toEqual([
			"Alice Lee",
			"Bob Chen",
			"Carol Wu",
		]);

		// 4. Springer #Abs1-content backfill
		const springerHtml = `<section data-title="Abstract"><div id="Abs1-content"><p>Modular relational abstract interpretation scales sound verification to industrial embedded C codebases.</p></div></section>`;
		expect(extractSpringerHtmlAbstract(springerHtml)).toContain(
			"Modular relational abstract interpretation",
		);
		const backfilled = await backfillSpringerAbstracts(
			[
				{
					id: "venue:sas-2026:doi:10.1007/978-3-032-40374-2_5",
					title: "Relational Abstract Interpretation",
					authors: ["Patrick Cousot"],
					abstract: "",
					publishedAt: "2026-10-01T00:00:00Z",
					year: 2026,
					sourceType: "venue",
					sourceLabel: "SAS 2026",
					categories: ["SAS 2026"],
					url: "https://doi.org/10.1007/978-3-032-40374-2_5",
					doi: "10.1007/978-3-032-40374-2_5",
					venueId: "sas-2026",
				},
			],
			async () => springerHtml,
		);
		expect(backfilled[0]?.abstract).toContain(
			"Modular relational abstract interpretation",
		);

		// 5. OOPSLA1 + OOPSLA2 union: DBLP having only OOPSLA1 (30) must NOT discard OOPSLA2 (35) from OpenAlex
		const oopslaBundle = await fetchMultiChannelVenuePapers(
			oopsla,
			2026,
			async <T>(url: string) => {
				if (url.includes("api.openalex.org/works")) {
					return {
						meta: { count: 65 },
						results: Array.from({ length: 65 }, (_, i) => ({
							id: `https://openalex.org/W_oopsla_${i + 1}`,
							type: "article",
							title: `Type-Directed Synthesis Paper ${i + 1}`,
							publication_year: 2026,
							publication_date: "2026-04-15",
							doi: `https://doi.org/10.1145/3798${200 + i}`,
							biblio: {
								volume: "10",
								issue: i < 30 ? "OOPSLA1" : "OOPSLA2",
							},
							abstract_inverted_index: {
								Sound: [0],
								gradual: [1],
								typing: [2],
								with: [3],
								zero: [4],
								overhead: [5],
								guarantees: [6],
							},
							authorships: [{ author: { display_name: `PL Author ${i + 1}` } }],
							primary_location: {
								source: {
									id: "https://openalex.org/S4210216081",
									display_name:
										"Proceedings of the ACM on Programming Languages",
								},
							},
						})),
					} as T;
				}
				if (url.includes("sparql.dblp.org")) {
					return {
						results: {
							bindings: Array.from({ length: 30 }, (_, i) => ({
								rec: { value: `https://dblp.org/rec/journals/pacmpl/p${i}` },
								title: { value: `Type-Directed Synthesis Paper ${i + 1}` },
								doi: { value: `10.1145/3798${200 + i}` },
								authors: { value: `PL Author ${i + 1}` },
								pubIn: { value: "Proc. ACM Program. Lang." },
							})),
						},
					} as T;
				}
				return { results: [] } as T;
			},
			async () => "",
		);
		expect(oopslaBundle.items).toHaveLength(65);

		// 6. applyFreshVenueItems replaces stale workshop-polluted cache (e.g. 3 -> 2 clean items)
		const baseCcs = ccsItems[0];
		if (!baseCcs) throw new Error("Expected parsed CCS item");
		const stalePool: CollectionPaperItem[] = [
			{ ...baseCcs, id: "venue:ccs-2026:p1", title: "Clean Paper One" },
			{ ...baseCcs, id: "venue:ccs-2026:p2", title: "Clean Paper Two" },
			{
				...baseCcs,
				id: "venue:ccs-2026:ws",
				title: "Stale Workshop Paper",
			},
		];
		const replaced = applyFreshVenueItems(
			stalePool,
			"ccs-2026",
			stalePool.slice(0, 2),
		);
		expect(replaced).toHaveLength(2);
		expect(replaced.some((p) => p.title === "Stale Workshop Paper")).toBe(
			false,
		);
	});

	it("fetches 100% abstracts from IEEE CSDL GraphQL and DataCite LIPIcs while excluding workshops and .0 frontmatter", async () => {
		const sp = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "sp-2026");
		const esem = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "esem-2026");
		if (!sp || !esem) throw new Error("Missing sp/esem venues");

		const csdlRes = await fetchCsdlVenuePapers(
			sp,
			2026,
			async <T>(url: string) => {
				const decoded = decodeURIComponent(url);
				if (decoded.includes("proceedings(")) {
					return {
						data: {
							proceedings: [
								{
									id: "sp-main-2026",
									title: "2026 IEEE Symposium on Security and Privacy (SP)",
								},
								{
									id: "spw-2026",
									title: "2026 IEEE Security and Privacy Workshops (SPW)",
								},
							],
						},
					} as T;
				}
				if (
					decoded.includes('articlesByProceeding(proceedingId: "sp-main-2026")')
				) {
					return {
						data: {
							articlesByProceeding: [
								{
									id: "p1",
									title: "Formal Verification of Post-Quantum TLS Handshakes",
									abstract:
										"We present a mechanized cryptographic proof for post-quantum hybrid key exchange in TLS 1.3 implementations.",
									doi: "10.1109/SP63933.2026.00042",
									contentType: "paper",
									year: "2026",
									pubDate: "2026-05-18",
									authors: [{ fullName: "Ada Lovelace" }],
								},
								{
									id: "toc1",
									title: "Table of Contents",
									contentType: "toc",
									doi: "10.1109/SP63933.2026.00001",
									authors: [{ fullName: "Committee" }],
								},
							],
						},
					} as T;
				}
				throw new Error(`Unexpected CSDL query: ${decoded}`);
			},
		);
		expect(csdlRes.items).toHaveLength(1);
		expect(csdlRes.items[0]?.doi).toBe("10.1109/SP63933.2026.00042");
		expect(csdlRes.items[0]?.abstract).toContain(
			"mechanized cryptographic proof",
		);

		const lipicsRes = await fetchDataCiteLipicsPapers(
			esem,
			2026,
			async <T>() => {
				return {
					data: [
						{
							id: "10.4230/lipics.esem.2026.0",
							attributes: {
								titles: [{ title: "Front Matter, Table of Contents, Preface" }],
								creators: [{ name: "Editors" }],
							},
						},
						{
							id: "10.4230/lipics.esem.2026.14",
							attributes: {
								titles: [
									{
										title:
											"Empirical Study of LLM-Assisted Code Review in Open Source",
									},
								],
								creators: [{ givenName: "Linus", familyName: "Torvalds" }],
								descriptions: [
									{
										descriptionType: "Abstract",
										description:
											"We conduct a controlled empirical study across 42 repositories measuring review latency and defect escape rates.",
									},
								],
								contentUrl:
									"https://drops.dagstuhl.de/storage/00lipics/lipics-vol355-esem2026/LIPIcs.ESEM.2026.14.pdf",
							},
						},
					],
				} as T;
			},
		);
		expect(lipicsRes.items).toHaveLength(1);
		expect(lipicsRes.items[0]?.doi).toBe("10.4230/lipics.esem.2026.14");
		expect(lipicsRes.items[0]?.abstract).toContain(
			"controlled empirical study across 42 repositories",
		);
		expect(lipicsRes.items[0]?.pdfUrl).toContain("LIPIcs.ESEM.2026.14.pdf");
	});
});
