import { describe, expect, it, vi } from "vitest";
import { commands } from "@/lib/core/bindings";
import {
	applyFreshVenueItems,
	backfillSpringerAbstracts,
	type CollectionPaperItem,
	clearCollection,
	DEFAULT_ARXIV_CATEGORIES,
	DEFAULT_COLLECTION_VENUES,
	ensureCollectionSummaryHydrated,
	ensurePaperFullDetails,
	extractSpringerHtmlAbstract,
	fetchCollectionStateSummary,
	fetchCoolPapersVenuePapers,
	fetchCsdlVenuePapers,
	fetchDataCiteLipicsPapers,
	fetchMoreArxivCollection,
	fetchMultiChannelVenuePapers,
	fetchOfficialTrackRoster,
	fetchVenueStructuredPapers,
	getCollectionPapersByIds,
	getCollectionSummarySnapshot,
	isConfirmedVenueAcceptance,
	isNonResearchJournalItem,
	isPreloadingCollection,
	isVenueAlreadyLoaded,
	listCollectionPapers,
	mergeCollectionItems,
	parseAcceptedVenueArxivXml,
	parseArxivAtomXml,
	parseCoolPapersVenueHtml,
	parseOfficialVenueProgramHtml,
	preloadAll2026ArxivInBackground,
	refreshArxivCollection,
	refreshVenueCollection,
	resetCollectionMemoryForTests,
	subscribeCollectionSummary,
	subscribePreloadingCollection,
	syncArxivCategoriesIncremental,
	updateCollectionConfig,
	upsertCollectionPapers,
	VENUE_SPEC_BY_ID,
	VENUE_SPECS,
} from "@/lib/plaza/collection";
import { installMockCollectionIpc } from "./helpers/mock-collection-ipc";

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));

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

	it("keeps cs.AI disabled by default in arXiv Collection while allowing manual opt-in", async () => {
		expect(DEFAULT_ARXIV_CATEGORIES).toEqual(["cs.SE", "cs.CR", "cs.PL"]);

		resetCollectionMemoryForTests();
		const ipc = installMockCollectionIpc({
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

		try {
			// Fresh state without explicit categories uses default ["cs.SE", "cs.CR", "cs.PL"] and filters out pure cs.AI items
			const initial = await fetchCollectionStateSummary();
			expect(initial.categories).toEqual(["cs.SE", "cs.CR", "cs.PL"]);
			expect(initial.totalCount).toBe(1);
			const initialPage = await listCollectionPapers({ sourceType: "arxiv" });
			expect(initialPage.items.map((p) => p.id)).toEqual(["arxiv:2606.00002"]);

			// If the user explicitly turns cs.AI ON, their choice persists in SQLite and reactive summary updates
			await updateCollectionConfig({
				categories: ["cs.SE", "cs.CR", "cs.PL", "cs.AI"],
			});
			resetCollectionMemoryForTests();
			const reloadedAfterOptIn = await fetchCollectionStateSummary();
			expect(reloadedAfterOptIn.categories).toEqual([
				"cs.SE",
				"cs.CR",
				"cs.PL",
				"cs.AI",
			]);
			expect(reloadedAfterOptIn.totalCount).toBe(2);
			const optedInPage = await listCollectionPapers({ sourceType: "arxiv" });
			expect(optedInPage.items.map((p) => p.id)).toEqual([
				"arxiv:2606.00002",
				"arxiv:2606.00001",
			]);
		} finally {
			ipc.restore();
			resetCollectionMemoryForTests();
		}
	});

	it("configures VENUE_SPECS without DBLP dependencies, queries lowercase LIPIcs DOI prefixes, and supports Venue add/edit/delete management without resurrection", async () => {
		expect(VENUE_SPECS).toHaveLength(28);
		for (const spec of VENUE_SPECS) {
			expect(spec.url).toMatch(/^https:\/\//);
			expect(spec.url).not.toContain("dblp");
			for (const trackUrl of spec.tracks) {
				expect(trackUrl).toMatch(/^https:\/\//);
				expect(trackUrl).not.toContain("dblp");
			}
		}

		const ecoop = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ecoop-2026");
		if (!ecoop) throw new Error("Missing ecoop-2026");

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

		resetCollectionMemoryForTests();
		const ipc = installMockCollectionIpc({
			venues: [...DEFAULT_COLLECTION_VENUES],
			items: [
				{
					id: "venue:sas-2026:doi:10.1007/978-3-032-40374-2_1",
					title: "Abstract Interpretation Paper to Cascade Delete",
					authors: ["Patrick Cousot"],
					abstract: "Sound static analysis abstract.",
					publishedAt: "2026-10-01T00:00:00Z",
					year: 2026,
					sourceType: "venue",
					sourceLabel: "SAS 2026",
					venueId: "sas-2026",
					venueKind: "conference",
					venueDomain: "PL/SE",
					ccfRank: "CCF-B",
					categories: ["SAS 2026"],
					url: "https://doi.org/10.1007/978-3-032-40374-2_1",
				},
			],
		});

		try {
			// Delete built-in `sas-2026`, edit built-in `icse-2026` (url + tracks + notes + agent mode),
			// and add a custom user venue `msr-2026` with `tracks` + `notes`.
			const nextVenues = DEFAULT_COLLECTION_VENUES.filter(
				(v) => v.id !== "sas-2026",
			).map((v) =>
				v.id === "icse-2026"
					? {
							...v,
							url: "https://conf.researchr.org/home/icse-2026-custom",
							tracks: [
								"https://conf.researchr.org/track/icse-2026/icse-2026-research-track?#event-overview",
							],
							notes: "Only extract ICSE Research Track accepted full papers.",
							mode: "agent" as const,
						}
					: v,
			);
			nextVenues.push({
				id: "msr-2026",
				name: "MSR 2026",
				url: "https://2026.msrconf.org/",
				tracks: [
					"https://2026.msrconf.org/track/msr-2026-technical-papers?#event-overview",
				],
				notes:
					"Keep Technical Papers only; exclude Data Showcase and Mining Challenge.",
				mode: "agent",
				kind: "conference",
				domain: "PL/SE",
				ccfRank: "CCF-B",
			});

			await updateCollectionConfig({ venues: nextVenues });
			resetCollectionMemoryForTests();

			const reloaded = await fetchCollectionStateSummary();
			// Deleted built-in `sas-2026` is NOT resurrected and its papers were cascade-deleted
			expect(reloaded.venues.some((v) => v.id === "sas-2026")).toBe(false);
			expect(reloaded.venueCount).toBe(0);

			// Edited built-in `icse-2026` preserves user overrides
			const editedIcse = reloaded.venues.find((v) => v.id === "icse-2026");
			expect(editedIcse?.url).toBe(
				"https://conf.researchr.org/home/icse-2026-custom",
			);
			expect(editedIcse?.notes).toBe(
				"Only extract ICSE Research Track accepted full papers.",
			);
			expect(editedIcse?.mode).toBe("agent");

			// Newly added `msr-2026` persists `tracks` and `notes`
			const addedMsr = reloaded.venues.find((v) => v.id === "msr-2026");
			expect(addedMsr?.tracks).toEqual([
				"https://2026.msrconf.org/track/msr-2026-technical-papers?#event-overview",
			]);
			expect(addedMsr?.notes).toContain("Keep Technical Papers only");
		} finally {
			ipc.restore();
			resetCollectionMemoryForTests();
		}
	});

	it("marks Venues with lastFetchedAt or cached items as loaded without version tracking, and does not toggle preloading flag during Venue refresh", async () => {
		const ase = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ase-2026");
		if (!ase) throw new Error("Missing ase-2026");

		// Cold venue -> not yet loaded
		expect(isVenueAlreadyLoaded(ase, [])).toBe(false);
		expect(isVenueAlreadyLoaded({ ...ase, paperCount: 12 }, [])).toBe(true);

		const loadedVenues = DEFAULT_COLLECTION_VENUES.map((v) => ({
			...v,
			lastFetchedAt: "2026-06-02T00:00:00Z",
		}));
		expect(isVenueAlreadyLoaded(loadedVenues[0] ?? ase, [])).toBe(true);

		resetCollectionMemoryForTests();
		const ipc = installMockCollectionIpc({
			categories: ["cs.SE", "cs.CR", "cs.PL"],
			venues: loadedVenues,
			items: [],
			lastRefreshedAt: "2026-06-02T00:00:00Z",
			latestArxiv: null,
		});
		try {
			const stateAfterSkip = await refreshVenueCollection({ skipLoaded: true });
			expect(stateAfterSkip.lastRefreshedAt).toBe("2026-06-02T00:00:00Z");
			expect(isPreloadingCollection()).toBe(false);
		} finally {
			ipc.restore();
			resetCollectionMemoryForTests();
		}
	});

	it("enforces strict Research Track roster purity on combined-volume ASE/ESEM 2026 (including fuzzy camera-ready matching and fail-closed roster errors)", async () => {
		const ase = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ase-2026");
		const esem = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "esem-2026");
		if (!ase || !esem) throw new Error("Missing ase-2026 or esem-2026");

		// 1. Fail-closed: if conf.researchr.org fails or returns 0 papers for `trackRosterMode: "required"`, throw instead of leaking combined-volume papers
		await expect(
			fetchOfficialTrackRoster(
				esem,
				2026,
				async () => "<html><body>No table rows yet</body></html>",
			),
		).rejects.toThrow("returned 0 papers");

		const researchrRows = Array.from({ length: 30 }, (_, idx) => {
			// Entry 2 tests camera-ready British/US spelling variation (`Modelling` on Researchr vs `Modeling` on ACM DL)
			const title =
				idx === 1
					? "Automated Threat Modelling for Stateful Cloud Microservices"
					: `Automated Program Analysis Technique Number ${idx + 1}`;
			return `<tr><td><a href="#" class="event-title">${title}</a><div class="performers"><a href="#">Researcher ${idx + 1}</a></div></td></tr>`;
		}).join("\n");
		const researchrHtml = `<table>${researchrRows}</table>`;

		// 2. Full `fetchMultiChannelVenuePapers`: OpenAlex has 30 Research Track ACM papers (entry 2 spelled `Modeling`)
		//    PLUS 1 NIER/Workshop paper sharing the combined volume `10.1145/3832783.*` -> strictly filtered to 30!
		resetCollectionMemoryForTests();
		const ipc = installMockCollectionIpc({
			categories: ["cs.SE", "cs.CR", "cs.PL"],
			venues: [...DEFAULT_COLLECTION_VENUES],
		});

		try {
			const bundle = await fetchMultiChannelVenuePapers(
				ase,
				2026,
				async <T>(url: string) => {
					if (url.includes("api.openalex.org/works")) {
						return {
							meta: { count: 32, next_cursor: null },
							results: [
								{
									id: "https://openalex.org/W_paratext",
									type: "paratext",
									title: "ASE 2026 Front Matter and Organization",
									publication_year: 2026,
									publication_date: "2026-10-07",
									authorships: [{ author: { display_name: "ACM Staff" } }],
								},
								{
									id: "https://openalex.org/W_nier_leak",
									type: "article",
									title:
										"Early Vision Note in Combined ASE NIER and Industry Volume",
									publication_year: 2026,
									publication_date: "2026-10-07",
									doi: "https://doi.org/10.1145/3832783.3832999",
									abstract_inverted_index: { Early: [0], vision: [1] },
									authorships: [{ author: { display_name: "NIER Author" } }],
									primary_location: {
										landing_page_url: "https://doi.org/10.1145/3832783.3832999",
										source: {
											id: "https://openalex.org/S4363608212",
											display_name:
												"Proceedings of the IEEE/ACM International Conference on Automated Software Engineering",
										},
									},
								},
								...Array.from({ length: 30 }, (_, idx) => ({
									id: `https://openalex.org/W_ase_${idx + 1}`,
									type: "article",
									title:
										idx === 1
											? "Automated Threat Modeling for Stateful Cloud Microservices"
											: `Automated Program Analysis Technique Number ${idx + 1}`,
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
				async (url: string) => {
					if (url.includes("conf.researchr.org")) return researchrHtml;
					return "<feed></feed>";
				},
			);

			expect(bundle.authoritativeMainTrack).toBe(true);
			expect(bundle.items).toHaveLength(30);
			expect(
				bundle.items.some((p) => p.doi === "10.1145/3832783.3832999"),
			).toBe(false);
			// Entry 2 matched fuzzily (`Modelling` <-> `Modeling` + shared surname `2` / `Researcher 2`) and acquired its ACM DOI
			expect(
				bundle.items.some((p) => p.doi === "10.1145/3832783.3832901"),
			).toBe(true);
			const enrichedFirst = bundle.items.find(
				(p) => p.doi === "10.1145/3832783.3832900",
			);
			expect(enrichedFirst?.abstract).toContain(
				"scalable static and dynamic program analysis",
			);
			expect(enrichedFirst?.arxivId).toBe("2608.12345");

			// Persisting & reading from SQLite must NOT strip the remaining 29 abstract-less ASE 2026 papers
			await upsertCollectionPapers({
				items: bundle.items,
				replaceVenueId: "ase-2026",
				replaceSourceLabel: "ASE 2026",
				lastRefreshedAt: "2026-10-10T00:00:00Z",
			});
			resetCollectionMemoryForTests();
			const reloadedPage = await listCollectionPapers({
				sourceType: "venue",
				venueId: "ase-2026",
				limit: 100,
			});
			expect(reloadedPage.items).toHaveLength(30);
		} finally {
			ipc.restore();
			resetCollectionMemoryForTests();
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
		resetCollectionMemoryForTests();
		const ipc = installMockCollectionIpc({
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

		const preloadingTransitions: boolean[] = [];
		const unsubPreloading = subscribePreloadingCollection((flag) => {
			preloadingTransitions.push(flag);
		});

		try {
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

			expect(preloadingTransitions).toEqual([true, false]);
			expect(isPreloadingCollection()).toBe(false);

			const completedSummary = await fetchCollectionStateSummary();
			const completedPage = await listCollectionPapers({ sourceType: "arxiv" });
			expect(completedPage.items.map((i) => i.arxivId)).toEqual([
				"2610.00004",
				"2609.00003",
				"2605.00002",
				"2601.00001",
			]);
			expect(completedSummary.arxivWatermarks?.["cs.SE"]?.remoteTotal).toBe(4);
			expect(completedSummary.arxivWatermarks?.["cs.SE"]?.historyComplete).toBe(
				true,
			);
			expect(windowUrls).toHaveLength(3);

			// Calling `fetchMoreArxivCollection` for an incomplete single category uses THAT category's oldest timestamp
			await updateCollectionConfig({
				categories: ["cs.SE", "cs.CR"],
			});
			await upsertCollectionPapers({
				items: [
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
					...completedSummary.arxivWatermarks,
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
			expect(moreRes.summary.arxivWatermarks?.["cs.CR"]?.historyComplete).toBe(
				true,
			);
		} finally {
			unsubPreloading();
			ipc.restore();
			resetCollectionMemoryForTests();
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

		// 3. Official ISSRE 2026 accepted-papers embedded tracks JSON (strictly keeps Research Track only; excludes industry, J1C2, replication, doctoral & fast-abstracts)
		const issreHtml = `<script>const tracks = [
			{"id":"research-track","label":"Research Track","papers":[{"title":"Fault Localization in Microservices","authors":"Alice Lee, Bob Chen and Carol Wu"}]},
			{"id":"industry-track","label":"Industry Track","papers":[{"title":"Industrial Logging Case Study","authors":"Industry Author"}]},
			{"id":"j1c2-track","label":"Journal First / Conference Second (J1C2)","papers":[{"title":"Prior Journal Paper Presentation","authors":"Journal Author"}]},
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

		// 5. OOPSLA1 + OOPSLA2 union while strictly rejecting non-OOPSLA PACMPL issues (e.g. POPL / ICFP)
		const oopslaBundle = await fetchMultiChannelVenuePapers(
			oopsla,
			2026,
			async <T>(url: string) => {
				if (url.includes("api.openalex.org/works")) {
					return {
						meta: { count: 66 },
						results: [
							...Array.from({ length: 65 }, (_, i) => ({
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
								authorships: [
									{ author: { display_name: `PL Author ${i + 1}` } },
								],
								primary_location: {
									source: {
										id: "https://openalex.org/S4210216081",
										display_name:
											"Proceedings of the ACM on Programming Languages",
									},
								},
							})),
							{
								id: "https://openalex.org/W_popl_spill",
								type: "article",
								title: "POPL Issue Paper That Must Not Enter OOPSLA",
								publication_year: 2026,
								publication_date: "2026-01-15",
								doi: "https://doi.org/10.1145/3776699",
								biblio: { volume: "10", issue: "POPL" },
								abstract_inverted_index: { POPL: [0] },
								authorships: [{ author: { display_name: "POPL Author" } }],
								primary_location: {
									source: {
										id: "https://openalex.org/S4210216081",
										display_name:
											"Proceedings of the ACM on Programming Languages",
									},
								},
							},
						],
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

	it("falls back to Crossref offset proceedings search for ASE 2026 when OpenAlex hits HTTP 429 and throws on empty upstream failure", async () => {
		const ase = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ase-2026");
		if (!ase) throw new Error("Missing ase-2026");

		const crossrefUrls: string[] = [];
		const res = await fetchVenueStructuredPapers(
			ase,
			2026,
			async <T>(url: string) => {
				if (url.includes("api.openalex.org")) {
					throw new Error("HTTP 429 Rate limit exceeded");
				}
				if (url.includes("api.crossref.org/works")) {
					crossrefUrls.push(url);
					return {
						message: {
							items: [
								{
									DOI: "10.1145/3832783.3832801",
									type: "proceedings-article",
									title: ["Sound Symbolic Execution for Rust Async Kernels"],
									abstract:
										"<jats:p>We present a sound symbolic execution engine for concurrent Rust async kernels with zero false alarms.</jats:p>",
									"container-title": [
										"Proceedings of the 41st IEEE/ACM International Conference on Automated Software Engineering",
									],
									author: [{ given: "Ada", family: "Lovelace" }],
									published: { "date-parts": [[2026, 10, 12]] },
								},
								{
									DOI: "10.1145/9999999.1111111",
									type: "proceedings-article",
									title: ["Unrelated ACM Conference Paper"],
									author: [{ given: "Eve", family: "Other" }],
									published: { "date-parts": [[2026, 10, 12]] },
								},
							],
						},
					} as T;
				}
				throw new Error(`Unexpected URL: ${url}`);
			},
		);

		expect(crossrefUrls[0]).toContain("offset=0");
		expect(crossrefUrls[0]).toContain("prefix:10.1145");
		expect(res.items).toHaveLength(1);
		expect(res.items[0]?.doi).toBe("10.1145/3832783.3832801");
		expect(res.items[0]?.abstract).toContain(
			"sound symbolic execution engine for concurrent Rust async kernels",
		);

		// If OpenAlex & Crossref fail on a non-roster venue (`icse-2026`) while S2 returns 0 rows,
		// fetchMultiChannelVenuePapers must throw instead of silently returning 0 items.
		const icse = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "icse-2026");
		if (!icse) throw new Error("Missing icse-2026");
		await expect(
			fetchMultiChannelVenuePapers(
				icse,
				2026,
				async <T>(url: string) => {
					if (url.includes("semanticscholar.org")) {
						return { total: 0, data: [] } as T;
					}
					throw new Error("HTTP 429 Rate limit exceeded");
				},
				async () => "<feed></feed>",
			),
		).rejects.toThrow("HTTP 429");

		// applyFreshVenueItems replaces stale cached items (including legacy sourceLabel-only entries)
		const stalePool: CollectionPaperItem[] = Array.from(
			{ length: 196 },
			(_, idx) => ({
				id: `venue:ase-2026:old-${idx}`,
				title: `Stale Cached ASE Item ${idx}`,
				authors: ["Author"],
				abstract: "Old abstract",
				publishedAt: "2026-03-01T00:00:00Z",
				year: 2026,
				sourceType: "venue",
				sourceLabel: "ASE 2026",
				categories: ["ASE 2026"],
				url: `https://doi.org/10.1145/3832783.${idx}`,
				venueId: idx % 2 === 0 ? "ase-2026" : undefined,
			}),
		);
		const replaced = applyFreshVenueItems(
			stalePool,
			"ase-2026",
			res.items,
			"ASE 2026",
		);
		expect(replaced).toHaveLength(1);
		expect(replaced[0]?.doi).toBe("10.1145/3832783.3832801");
	});

	it("hydrates Crossref abstract-less ASE 2026 papers (Doc2Test) via 0-credit OpenAlex DOI singletons during preload and enforces Option-B authentic keywords", async () => {
		const ase = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ase-2026");
		const esem = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "esem-2026");
		const iclr = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "iclr-2026");
		if (!ase || !esem || !iclr) throw new Error("Missing venue configs");

		// 1. OpenAlex list endpoint (`works?filter=`) returns HTTP 429, Crossref returns Doc2Test without abstract,
		//    and 0-credit singleton `works/doi:10.1145/3832783.3834507` populates full abstract + authentic keywords during preload.
		const singletonCalls: string[] = [];
		const structured = await fetchVenueStructuredPapers(
			ase,
			2026,
			async <T>(url: string) => {
				if (url.includes("api.openalex.org/works?")) {
					throw new Error("HTTP 429 Daily list credits exhausted");
				}
				if (url.includes("api.openalex.org/works/doi:")) {
					singletonCalls.push(url);
					return {
						id: "https://openalex.org/W_doc2test",
						doi: "https://doi.org/10.1145/3832783.3834507",
						title:
							"Doc2Test: An Industrial Multi-agent Framework for Document-Driven End-to-End Selenium Test Generation",
						cited_by_count: 3,
						abstract_inverted_index: {
							Industrial: [0],
							"end-to-end": [1],
							Selenium: [2],
							test: [3],
							generation: [4],
							from: [5],
							requirements: [6],
							documents: [7],
							remains: [8],
							challenging: [9],
							in: [10],
							enterprise: [11],
							practice: [12],
						},
						keywords: [
							{ display_name: "Multi-agent Systems", score: 0.78 },
							{ display_name: "Selenium Test Generation", score: 0.71 },
							{ display_name: "Computer Science", score: 0.9 },
							{ display_name: "Low Confidence Noise", score: 0.12 },
						],
					} as T;
				}
				if (url.includes("api.crossref.org/works")) {
					return {
						message: {
							items: [
								{
									DOI: "10.1145/3832783.3834507",
									type: "proceedings-article",
									title: [
										"Doc2Test: An Industrial Multi-agent Framework for Document-Driven End-to-End Selenium Test Generation",
									],
									subject: ["Software", "Computer Science Applications"],
									"container-title": [
										"Proceedings of the 41st IEEE/ACM International Conference on Automated Software Engineering",
									],
									author: [{ given: "Lin", family: "Chen" }],
									published: { "date-parts": [[2026, 10, 12]] },
								},
							],
						},
					} as T;
				}
				throw new Error(`Unexpected URL: ${url}`);
			},
		);

		expect(singletonCalls).toHaveLength(1);
		expect(structured.items).toHaveLength(1);
		expect(structured.items[0]?.abstract).toBe(
			"Industrial end-to-end Selenium test generation from requirements documents remains challenging in enterprise practice",
		);
		expect(structured.items[0]?.citationCount).toBe(3);
		expect(structured.items[0]?.keywords).toEqual([
			"Multi-agent Systems",
			"Selenium Test Generation",
		]);

		// 2. DataCite LIPIcs retains un-schemed author subjects while dropping ACM CCS classification subjects
		const lipics = await fetchDataCiteLipicsPapers(
			esem,
			2026,
			async <T>() =>
				({
					data: [
						{
							id: "10.4230/lipics.esem.2026.21",
							attributes: {
								titles: [
									{
										title:
											"Empirical Study on Flaky Test Repair in Microservices",
									},
								],
								creators: [{ givenName: "Jane", familyName: "Doe" }],
								descriptions: [
									{
										descriptionType: "Abstract",
										description:
											"We conduct a large-scale study of flaky test repair across 55 microservice systems.",
									},
								],
								subjects: [
									{
										subject:
											"Software and its engineering -> Software testing and debugging",
										subjectScheme: "ACM",
									},
									{ subject: "Flaky Tests" },
									{ subject: "Microservices" },
								],
							},
						},
					],
				}) as T,
		);
		expect(lipics.items[0]?.keywords).toEqual(["Flaky Tests", "Microservices"]);

		// 3. `papers.cool` `<div keywords="...">` TF-IDF tokens are never surfaced as author keywords
		const coolParsed = parseCoolPapersVenueHtml(
			`<div id="abc123@OpenReview" class="panel paper" keywords="multi-agent,selenium,test,document">
				<h2 class="title"><a href="https://openreview.net/forum?id=abc123" title="1/1"></a><a id="title-abc123">Agentic Planning Without Author Keywords</a></h2>
				<p class="metainfo authors"><a class="author">Alice Zhang</a></p>
				<p id="summary-abc123" class="summary">We study agentic planning in open-ended environments with rigorous evaluation.</p>
			</div>`,
			iclr,
			VENUE_SPEC_BY_ID.get("iclr-2026"),
			2026,
		);
		expect(coolParsed.items[0]?.keywords).toEqual([]);
	});

	it("hydrates collectionStore reactively, deduplicates concurrent initial hydration, preserves ID order in getCollectionPapersByIds, and enriches detail records via IPC", async () => {
		resetCollectionMemoryForTests();
		const ipc = installMockCollectionIpc({
			categories: ["cs.SE", "cs.PL"],
			items: [
				{
					id: "arxiv:2607.00001",
					arxivId: "2607.00001",
					title: "First SE Paper",
					authors: ["Alice"],
					abstract:
						"Complete abstract for first software engineering paper in 2026.",
					publishedAt: "2026-07-01T00:00:00Z",
					year: 2026,
					sourceType: "arxiv",
					sourceLabel: "cs.SE",
					categories: ["cs.SE"],
					url: "https://arxiv.org/abs/2607.00001",
					citationCount: 2,
					keywords: ["Program Repair"],
				},
				{
					id: "venue:pldi-2026:doi:10.1145/3800001",
					doi: "10.1145/3800001",
					title: "Placeholder Abstract PLDI Paper",
					authors: ["Bob"],
					abstract: "PLDI 2026 · PLDI",
					publishedAt: "2026-06-15T00:00:00Z",
					year: 2026,
					sourceType: "venue",
					sourceLabel: "PLDI 2026",
					venueId: "pldi-2026",
					venueKind: "conference",
					venueDomain: "PL/SE",
					ccfRank: "CCF-A",
					categories: ["PLDI 2026"],
					url: "https://doi.org/10.1145/3800001",
				},
			],
		});

		const revisions: number[] = [];
		const unsub = subscribeCollectionSummary((snap) => {
			revisions.push(snap.revision);
		});
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("api.openalex.org")) {
				return new Response(
					JSON.stringify({
						id: "https://openalex.org/W_pldi_1",
						doi: "https://doi.org/10.1145/3800001",
						cited_by_count: 9,
						abstract_inverted_index: {
							Sound: [0],
							type: [1],
							inference: [2],
							for: [3],
							effect: [4],
							handlers: [5],
							at: [6],
							scale: [7],
						},
						keywords: [{ display_name: "Effect Handlers", score: 0.85 }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("{}", {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		try {
			expect(getCollectionSummarySnapshot().hydrated).toBe(false);

			// Concurrent `ensureCollectionSummaryHydrated()` calls share a single IPC round-trip
			const [s1, s2] = await Promise.all([
				ensureCollectionSummaryHydrated(),
				ensureCollectionSummaryHydrated(),
			]);
			expect(commands.plazaCollectionStateGet).toHaveBeenCalledTimes(1);
			expect(s1.totalCount).toBe(2);
			expect(s2.totalCount).toBe(2);
			expect(getCollectionSummarySnapshot().hydrated).toBe(true);
			expect(getCollectionSummarySnapshot().revision).toBe(1);

			// `getCollectionPapersByIds` preserves caller ID ordering
			const ordered = await getCollectionPapersByIds([
				"venue:pldi-2026:doi:10.1145/3800001",
				"arxiv:2607.00001",
			]);
			expect(ordered.map((p) => p.id)).toEqual([
				"venue:pldi-2026:doi:10.1145/3800001",
				"arxiv:2607.00001",
			]);

			// `ensurePaperFullDetails` enriches placeholder abstract via OpenAlex and patches SQLite
			const pldiSummary = ordered[0];
			if (!pldiSummary) throw new Error("Missing PLDI summary");
			const detailed = await ensurePaperFullDetails(pldiSummary);
			expect(detailed.abstract).toBe(
				"Sound type inference for effect handlers at scale",
			);
			expect(detailed.citationCount).toBe(9);
			expect(detailed.keywords).toEqual(["Effect Handlers"]);
			expect(detailed.bibtex).toContain("@inproceedings{");
			expect(commands.plazaCollectionPatchPapers).toHaveBeenCalledTimes(1);

			// `clearCollection("papers")` wipes papers and bumps `revision`
			const cleared = await clearCollection("papers");
			expect(cleared.totalCount).toBe(0);
			expect(revisions.length).toBeGreaterThanOrEqual(3);
		} finally {
			unsub();
			vi.unstubAllGlobals();
			ipc.restore();
			resetCollectionMemoryForTests();
		}
	});

	it("enforces main-track purity across ACL/AAAI/ICML papers.cool, SAS <25 LNCS proceedings, NeurIPS prior-year spillover, and Journal non-research items", async () => {
		const acl = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "acl-2026");
		const aaai = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "aaai-2026");
		const icml = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "icml-2026");
		const sas = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "sas-2026");
		const neurips = DEFAULT_COLLECTION_VENUES.find(
			(v) => v.id === "neurips-2026",
		);
		const tosem = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "tosem-2026");
		if (!acl || !aaai || !icml || !sas || !neurips || !tosem) {
			throw new Error("Missing built-in venues");
		}

		// 1. ACL 2026 queries direct `?group=Long%20Papers` & `?group=Short%20Papers` and drops Findings
		const aclUrls: string[] = [];
		const aclRes = await fetchCoolPapersVenuePapers(
			acl,
			2026,
			async (url: string) => {
				aclUrls.push(url);
				if (url.includes("group=Long%20Papers")) {
					return `<div id="2026.acl-long.1@ACL" class="panel paper">
						<h2 class="title"><a href="https://aclanthology.org/2026.acl-long.1/" title="1/1"></a><a id="title-1">Long Track Semantic Parser</a></h2>
						<p class="metainfo authors"><a class="author">Alice</a></p>
						<p class="metainfo subjects"><a href="/venue/ACL.2026?group=Long%20Papers">ACL.2026 - Long Papers</a></p>
						<p id="summary-1" class="summary">Full long paper abstract.</p>
					</div>`;
				}
				if (url.includes("group=Short%20Papers")) {
					return `<div id="2026.acl-short.2@ACL" class="panel paper">
						<h2 class="title"><a href="https://aclanthology.org/2026.acl-short.2/" title="1/1"></a><a id="title-2">Short Track Probing Study</a></h2>
						<p class="metainfo authors"><a class="author">Bob</a></p>
						<p class="metainfo subjects"><a href="/venue/ACL.2026?group=Short%20Papers">ACL.2026 - Short Papers</a></p>
						<p id="summary-2" class="summary">Concise short paper abstract.</p>
					</div>
					<div id="2026.findings-acl.9@ACL" class="panel paper">
						<h2 class="title"><a href="https://aclanthology.org/2026.findings-acl.9/" title="1/1"></a><a id="title-9">Findings Paper Must Be Excluded</a></h2>
						<p class="metainfo authors"><a class="author">Eve</a></p>
						<p class="metainfo subjects"><a href="/venue/ACL.2026?group=Findings">ACL.2026 - Findings</a></p>
						<p id="summary-9" class="summary">Findings paper abstract.</p>
					</div>`;
				}
				return "";
			},
		);
		expect(aclUrls.some((u) => u.includes("group=Long%20Papers"))).toBe(true);
		expect(aclUrls.some((u) => u.includes("group=Short%20Papers"))).toBe(true);
		expect(aclRes.items.map((p) => p.title)).toEqual([
			"Long Track Semantic Parser",
			"Short Track Probing Study",
		]);

		// 2. AAAI excludes Student Abstract / IAAI; ICML excludes `Position: ...`
		const aaaiParsed = parseCoolPapersVenueHtml(
			`<div id="p1@AAAI" class="panel paper">
				<h2 class="title"><a href="https://ojs.aaai.org/1" title="1/2"></a><a id="title-p1">Verified Neuro-Symbolic Planning</a></h2>
				<p class="metainfo authors"><a class="author">Carol</a></p>
				<p class="metainfo subjects"><a href="/venue/AAAI.2026?group=Planning%2C%20Routing%2C%20and%20Scheduling">AAAI.2026 - Planning, Routing, and Scheduling</a></p>
				<p id="summary-p1" class="summary">Technical track abstract.</p>
			</div>
			<div id="p2@AAAI" class="panel paper">
				<h2 class="title"><a href="https://ojs.aaai.org/2" title="2/2"></a><a id="title-p2">Two-Page Student Abstract Note</a></h2>
				<p class="metainfo authors"><a class="author">Student</a></p>
				<p class="metainfo subjects"><a href="/venue/AAAI.2026?group=Student%20Abstract%20and%20Poster%20Program">AAAI.2026 - Student Abstract and Poster Program</a></p>
				<p id="summary-p2" class="summary">Student abstract.</p>
			</div>`,
			aaai,
			VENUE_SPEC_BY_ID.get("aaai-2026"),
			2026,
		);
		expect(aaaiParsed.items.map((p) => p.title)).toEqual([
			"Verified Neuro-Symbolic Planning",
		]);

		const icmlParsed = parseCoolPapersVenueHtml(
			`<div id="pos1@OpenReview" class="panel paper">
				<h2 class="title"><a href="https://openreview.net/forum?id=pos1" title="1/2"></a><a id="title-pos1">Position: Benchmarks Should Stop Rewarding Memorization</a></h2>
				<p class="metainfo authors"><a class="author">Author A</a></p>
				<p class="metainfo subjects"><a href="/venue/ICML.2026?group=Poster">ICML.2026 - Poster</a></p>
				<p id="summary-pos1" class="summary">Position track paper.</p>
			</div>
			<div id="res1@OpenReview" class="panel paper">
				<h2 class="title"><a href="https://openreview.net/forum?id=res1" title="2/2"></a><a id="title-res1">Optimal Transport for Diffusion Samplers</a></h2>
				<p class="metainfo authors"><a class="author">Author B</a></p>
				<p class="metainfo subjects"><a href="/venue/ICML.2026?group=Oral">ICML.2026 - Oral</a></p>
				<p id="summary-res1" class="summary">Main conference oral paper.</p>
			</div>`,
			icml,
			VENUE_SPEC_BY_ID.get("icml-2026"),
			2026,
		);
		expect(icmlParsed.items.map((p) => p.title)).toEqual([
			"Optimal Transport for Diffusion Samplers",
		]);

		// 3. SAS 2026 with 21 LNCS papers must NOT trigger `< 25` arXiv fallback noise
		let arxivFallbackCalled = false;
		const sasBundle = await fetchMultiChannelVenuePapers(
			sas,
			2026,
			async <T>(url: string) => {
				if (url.includes("api.crossref.org/works")) {
					return {
						message: {
							items: Array.from({ length: 21 }, (_, idx) => ({
								DOI: `10.1007/978-3-032-40374-2_${idx + 1}`,
								type: "book-chapter",
								title: [`Relational Static Analysis Chapter ${idx + 1}`],
								abstract: `<jats:p>Sound abstract interpretation technique ${idx + 1}.</jats:p>`,
								"container-title": ["Static Analysis"],
								author: [{ given: "Author", family: `${idx + 1}` }],
								published: { "date-parts": [[2026, 10, 1]] },
							})),
						},
					} as T;
				}
				return { results: [] } as T;
			},
			async (url: string) => {
				if (url.includes("export.arxiv.org")) {
					arxivFallbackCalled = true;
				}
				return "";
			},
		);
		expect(sasBundle.items).toHaveLength(21);
		expect(arxivFallbackCalled).toBe(false);

		// 4. NeurIPS 2026 drops 2024/2025 `10.52202/079017|085713` spillover & position papers
		const neuripsStructured = await fetchVenueStructuredPapers(
			neurips,
			2026,
			async <T>(url: string) => {
				if (url.includes("api.openalex.org/works")) {
					return {
						meta: { count: 2 },
						results: [
							{
								id: "https://openalex.org/W_nips25_spill",
								type: "article",
								title: "Late Indexed NeurIPS 2025 Proceedings Paper",
								publication_year: 2026,
								publication_date: "2026-01-15",
								doi: "https://doi.org/10.52202/085713-0123",
								abstract_inverted_index: { Late: [0], indexed: [1] },
								authorships: [{ author: { display_name: "Author 2025" } }],
								primary_location: {
									source: {
										id: "https://openalex.org/S4306420609",
										display_name:
											"Advances in Neural Information Processing Systems",
									},
								},
							},
						],
					} as T;
				}
				return { results: [] } as T;
			},
		);
		expect(neuripsStructured.items).toHaveLength(0);

		// 5. Journal non-research filter: drops RCR Report, Guest Editorial, Corrigendum, 1-4p; keeps Springer single-integer article number "93"
		expect(
			isNonResearchJournalItem(
				"Automated Bug Localization via Graph Neural Networks — RCR Report",
				"1-6",
			),
		).toBe(true);
		expect(
			isNonResearchJournalItem(
				"Guest Editorial: Special Issue on Trustworthy AI4SE",
				"1-5",
			),
		).toBe(true);
		expect(
			isNonResearchJournalItem(
				"Corrigendum to 'Sound Static Taint Analysis'",
				"12-13",
			),
		).toBe(true);
		expect(
			isNonResearchJournalItem(
				"Short Commentary on Software Metrics",
				"101-104",
			),
		).toBe(true);
		expect(
			isNonResearchJournalItem(
				"A Comprehensive Survey and Empirical Study of Fuzzing Rust Unsafe Blocks",
				"93",
			),
		).toBe(false);
		expect(tosem.tracks).toEqual([]);
	});

	it("recovers from transient empty arXiv Atom feeds, throws on persistent empty truncation, and awaits full 2026 backfill in refreshArxivCollection", async () => {
		resetCollectionMemoryForTests();
		const ipc = installMockCollectionIpc({
			categories: ["cs.SE"],
			venues: [...DEFAULT_COLLECTION_VENUES],
		});

		try {
			// 1. Transient empty feed (`totalResults=2` with 0 entries on attempt 1) recovers on retry
			let transientCalls = 0;
			const statuses: string[] = [];
			const refreshed = await refreshArxivCollection({
				categories: ["cs.SE"],
				onCategoryStatus: (cat, st) => statuses.push(`${cat}:${st}`),
				transport: {
					fetchText: async (url) => {
						if (url.includes("rss.arxiv.org")) return "<rss></rss>";
						transientCalls += 1;
						if (transientCalls === 1) {
							return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
								<opensearch:totalResults>2</opensearch:totalResults>
							</feed>`;
						}
						if (url.includes("TO+209912312359]")) {
							return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
								<opensearch:totalResults>2</opensearch:totalResults>
								<entry>
									<id>http://arxiv.org/abs/2604.00002v1</id>
									<published>2026-04-10T10:00:00Z</published>
									<title>April 2026 SE Paper Two</title>
									<summary>Full software engineering abstract two.</summary>
									<author><name>Author Two</name></author>
								</entry>
								<entry>
									<id>http://arxiv.org/abs/2601.00001v1</id>
									<published>2026-01-05T09:00:00Z</published>
									<title>January 2026 SE Paper One</title>
									<summary>Full software engineering abstract one.</summary>
									<author><name>Author One</name></author>
								</entry>
							</feed>`;
						}
						return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
							<opensearch:totalResults>0</opensearch:totalResults>
						</feed>`;
					},
					fetchJson: async <T>() => ({ results: [] }) as T,
				},
			});

			expect(transientCalls).toBeGreaterThanOrEqual(2);
			expect(refreshed.arxivCount).toBe(2);
			expect(refreshed.arxivWatermarks["cs.SE"]?.historyComplete).toBe(true);
			expect(statuses[0]).toBe("cs.SE:refreshing");
			expect(statuses[statuses.length - 1]).toBe("cs.SE:done");

			// 2. Persistent transient empty feed (`totalResults=7054` with 0 entries across all retries) throws instead of marking historyComplete
			await expect(
				fetchMoreArxivCollection({
					categories: ["cs.PL"],
					maxResultsPerCategory: 100,
					transport: {
						fetchText: async () =>
							`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
								<opensearch:totalResults>7054</opensearch:totalResults>
							</feed>`,
						fetchJson: async <T>() => ({ results: [] }) as T,
					},
				}),
			).rejects.toThrow("transient empty feed");
		} finally {
			ipc.restore();
			resetCollectionMemoryForTests();
		}
	});
});
