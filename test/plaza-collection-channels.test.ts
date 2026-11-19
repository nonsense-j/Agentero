import { describe, expect, it, vi } from "vitest";
import { BackgroundTaskCancelledError } from "@/lib/core/background-tasks";
import { commands } from "@/lib/core/bindings";
import {
	DEFAULT_KEYWORD_LLM_MODEL,
	fetchKeywordLlmModels,
	setCachedKeywordLlmConfigForTests,
} from "@/lib/keyword-llm";
import {
	setCachedOpenAlexApiKeyForTests,
	withOpenAlexApiKey,
} from "@/lib/openalex";
import {
	applyFreshVenueItems,
	backfillSpringerAbstracts,
	type CollectionPaperItem,
	clearCollection,
	DEFAULT_ARXIV_CATEGORIES,
	DEFAULT_COLLECTION_VENUES,
	enrichArxivItemsBatch,
	enrichSinglePaperOnDemand,
	ensureCollectionSummaryHydrated,
	ensurePaperFullDetails,
	ensureVenueLoaded,
	extractArxivHtmlKeywords,
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
	isPaperMetadataComplete,
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
	shouldEnrichPaperOnDemand,
	subscribeCollectionSummary,
	subscribePreloadingCollection,
	syncArxivCategoriesIncremental,
	updateCollectionConfig,
	upsertCollectionPapers,
	VENUE_SPEC_BY_ID,
	VENUE_SPECS,
} from "@/lib/plaza/collection";
import {
	crossrefWorkToVenueItem,
	enrichVenueItemsBatch,
	extractArxivDoiFromAtomEntry,
	isArtifactOrDatasetDoi,
	isNonMainTrackPrefixedTitle,
	isWorkshopOrCompanionVenue,
	mergeKeywordMetadata,
	normalizeOpenAlexId,
	normalizeRawRefs,
	OPENALEX_SELECT,
	openAlexWorkToVenueItem,
	semanticScholarWorkToVenueItem,
	wrapFetchJsonWithAbort,
	wrapFetchTextWithAbort,
} from "@/lib/plaza/collection-enrichment";
import {
	backfillMissingMetadataFromChannel,
	createPoliteFetchJson,
	createPoliteFetchText,
	fetchAclAnthologyVenuePapers,
	fetchMiniConfVenuePapers,
	parseAclAnthologyVolumeHtml,
	parseResearchrHtml,
	parseUsenixPresentationHtml,
} from "@/lib/plaza/collection-venue-channels";
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
			deltaUrls.some((u) => u.includes("submittedDate:[202605080800+TO+")),
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

	it("hydrates Crossref abstract-less ASE 2026 papers (Doc2Test) via 0-credit OpenAlex DOI singletons, captures outgoing rawRefs + openalexId, and never reads OpenAlex predicted keywords or external cited_by_count", async () => {
		const ase = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ase-2026");
		const esem = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "esem-2026");
		const iclr = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "iclr-2026");
		if (!ase || !esem || !iclr) throw new Error("Missing venue configs");

		expect(OPENALEX_SELECT).toContain("referenced_works");
		expect(OPENALEX_SELECT).not.toContain("keywords");
		expect(OPENALEX_SELECT).not.toContain("cited_by_count");

		// 1. OpenAlex list endpoint (`works?filter=`) returns HTTP 429, Crossref returns Doc2Test without abstract + Crossref `reference`,
		//    and 0-credit singleton `works/doi:10.1145/3832783.3834507` populates full abstract + `openalexId` + `referenced_works` without OpenAlex keywords/citations.
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
						referenced_works: [
							"https://openalex.org/W1111111111",
							"https://openalex.org/W2222222222",
						],
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
									"is-referenced-by-count": 42,
									reference: [
										{ DOI: "10.1145/3597926.3598050" },
										{ DOI: "10.48550/arXiv.2601.12345v2" },
									],
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
		// External citation counts and OpenAlex predicted keywords are never imported
		expect(structured.items[0]?.citationCount).toBe(0);
		expect(structured.items[0]?.keywords).toEqual([]);
		expect(structured.items[0]?.openalexId).toBe("W_doc2test");
		expect(structured.items[0]?.rawRefs).toEqual([
			"doi:10.1145/3597926.3598050",
			"arxiv:2601.12345",
			"oa:W1111111111",
			"oa:W2222222222",
		]);

		// 2. DataCite LIPIcs retains un-schemed author subjects with `keywordSource: "author"` while dropping ACM CCS classification subjects
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
		expect(lipics.items[0]?.keywords).toEqual(["Flaky Test", "Microservices"]);
		expect(lipics.items[0]?.keywordSource).toBe("author");

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

			// `ensurePaperFullDetails` enriches placeholder abstract via OpenAlex (ignoring external cited_by_count & OpenAlex keywords) and patches SQLite
			const pldiSummary = ordered[0];
			if (!pldiSummary) throw new Error("Missing PLDI summary");
			const detailed = await ensurePaperFullDetails(pldiSummary);
			expect(detailed.abstract).toBe(
				"Sound type inference for effect handlers at scale",
			);
			expect(detailed.citationCount).toBe(0);
			expect(detailed.keywords).toEqual([]);
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

		// 3. SAS 2026 uses required Researchr #event-overview roster intersected with LNCS (<25 papers must NOT trigger arXiv fallback) and drops frontmatter
		let arxivFallbackCalled = false;
		const sasResearchrHtml = `
			<div id="event-overview">
				<table>
					${Array.from(
						{ length: 21 },
						(_, idx) => `
						<tr>
							<td>10:00</td>
							<td>
								<a class="publication-link" href="https://2026.splashcon.org/details/sas-2026-papers/${idx + 1}/paper">Relational Static Analysis Chapter ${idx + 1}</a>
								<div class="performers"><a href="/profile/author${idx + 1}">Author ${idx + 1}</a></div>
							</td>
						</tr>`,
					).join("\n")}
				</table>
			</div>`;
		const sasBundle = await fetchMultiChannelVenuePapers(
			sas,
			2026,
			async <T>(url: string) => {
				if (url.includes("api.crossref.org/works")) {
					return {
						message: {
							items: [
								{
									DOI: "10.1007/978-3-032-40374-2",
									type: "book-chapter",
									title: ["Front Matter"],
									"container-title": ["Static Analysis"],
									author: [{ given: "Editor", family: "Name" }],
									published: { "date-parts": [[2026, 10, 1]] },
								},
								...Array.from({ length: 21 }, (_, idx) => ({
									DOI: `10.1007/978-3-032-40374-2_${idx + 1}`,
									type: "book-chapter",
									title: [`Relational Static Analysis Chapter ${idx + 1}`],
									abstract: `<jats:p>Sound abstract interpretation technique ${idx + 1}.</jats:p>`,
									"container-title": ["Static Analysis"],
									author: [{ given: "Author", family: `${idx + 1}` }],
									published: { "date-parts": [[2026, 10, 1]] },
								})),
							],
						},
					} as T;
				}
				return { results: [] } as T;
			},
			async (url: string) => {
				if (url.includes("export.arxiv.org")) {
					arxivFallbackCalled = true;
				}
				if (url.includes("sas-2026-papers")) {
					return sasResearchrHtml;
				}
				return "";
			},
		);
		expect(sasBundle.items).toHaveLength(21);
		expect(
			sasBundle.items.some((p) =>
				p.title.toLowerCase().includes("front matter"),
			),
		).toBe(false);
		expect(arxivFallbackCalled).toBe(false);
		await expect(
			fetchMultiChannelVenuePapers(
				sas,
				2026,
				async <T>() => ({ results: [] }) as T,
				async () => "",
			),
		).rejects.toThrow(/Authoritative main-track roster returned 0 papers/);

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

	it("enriches arXiv batches solely via Keyword LLM with zero OpenAlex calls, supports on-demand arXiv HTML author keywords, and backfills existing SQLite rows on refresh", async () => {
		// 1. `extractArxivHtmlKeywords` parses LaTeX `\keywords{...}` / `Index Terms` and strips broad buckets
		const sampleHtml = `
			<div class="ltx_keywords">
				<h6 class="ltx_title ltx_title_keywords">Keywords: </h6>
				Static Application Security Testing, Software Security, Computer Science, cs.SE, Software and its engineering → Formal software verification.
			</div>`;
		expect(extractArxivHtmlKeywords(sampleHtml)).toEqual([
			"Static Application Security Testing",
			"Software Security",
			"Formal Verification",
		]);

		// 2. When Keyword LLM is unconfigured, `enrichArxivItemsBatch` returns immediately with ZERO OpenAlex or LLM calls.
		setCachedKeywordLlmConfigForTests(null);
		const largeBatch: CollectionPaperItem[] = Array.from(
			{ length: 210 },
			(_, idx) => {
				const aid = `2606.${String(10001 + idx)}`;
				return {
					id: `arxiv:${aid}`,
					arxivId: aid,
					doi: `10.48550/arxiv.${aid}`,
					title: `Scalable Program Analysis Study ${idx + 1}`,
					authors: [`Author ${idx + 1}`],
					abstract: `Complete abstract for scalable program analysis study ${idx + 1}.`,
					publishedAt: "2026-06-15T10:00:00Z",
					year: 2026,
					sourceType: "arxiv",
					sourceLabel: "cs.SE",
					categories: ["cs.SE"],
					url: `https://arxiv.org/abs/${aid}`,
				};
			},
		);

		const openAlexBatchUrls: string[] = [];
		const unconfiguredRes = await enrichArxivItemsBatch(
			largeBatch,
			async <T>(url: string) => {
				openAlexBatchUrls.push(url);
				return { results: [] } as T;
			},
		);
		expect(openAlexBatchUrls).toHaveLength(0);
		expect(unconfiguredRes).toHaveLength(210);
		expect(unconfiguredRes[0]?.keywords).toEqual([]);

		// 3. When Keyword LLM IS configured, `enrichArxivItemsBatch` sends only items lacking keywords to LLM,
		//    preserves pre-baked `maintainer_llm` / `author` keywords, tags LLM keywords with `keywordSource: "client_llm"`,
		//    and still makes ZERO OpenAlex requests.
		const recentIso = new Date(Date.now() - 2 * 86_400_000).toISOString();
		const mixedBatch: CollectionPaperItem[] = [
			{
				id: "arxiv:2610.50001",
				arxivId: "2610.50001",
				doi: "10.48550/arxiv.2610.50001",
				title: "Seed-Baked Preprint With Maintainer Keywords",
				authors: ["Alice"],
				abstract: "Preprint already enriched by maintainer seed bundle.",
				publishedAt: "2026-10-01T10:00:00Z",
				year: 2026,
				sourceType: "arxiv",
				sourceLabel: "cs.CR",
				categories: ["cs.CR"],
				keywords: ["Zero-Knowledge Proof"],
				keywordSource: "maintainer_llm",
				url: "https://arxiv.org/abs/2610.50001",
			},
			{
				id: "arxiv:2602.90002",
				arxivId: "2602.90002",
				doi: "10.48550/arxiv.2602.90002",
				title: "Unindexed Preprint Falling Back To OpenRouter LLM",
				authors: ["Bob"],
				abstract:
					"We present homomorphic encryption with side-channel countermeasures on Lattice hardware.",
				publishedAt: "2026-02-14T10:00:00Z",
				year: 2026,
				sourceType: "arxiv",
				sourceLabel: "cs.CR",
				categories: ["cs.CR"],
				url: "https://arxiv.org/abs/2602.90002",
			},
		];

		setCachedKeywordLlmConfigForTests({
			apiKey: "test-llm-key",
		});
		try {
			const openRouterPayloads: string[] = [];
			const fallbackRes = await enrichArxivItemsBatch(
				mixedBatch,
				async () => {
					throw new Error(
						"OpenAlex must not be called in enrichArxivItemsBatch",
					);
				},
				mixedBatch.length,
				{
					keywordLlmFetch: async (_input, init) => {
						openRouterPayloads.push(String(init?.body ?? ""));
						return new Response(
							JSON.stringify({
								choices: [
									{
										message: {
											content: JSON.stringify({
												"0": [
													"Homomorphic Encryption",
													"Side-Channel Analysis",
												],
											}),
										},
									},
								],
							}),
							{ status: 200 },
						);
					},
				},
			);

			expect(openRouterPayloads).toHaveLength(1);
			expect(openRouterPayloads[0]).toContain(
				"Unindexed Preprint Falling Back To OpenRouter LLM",
			);
			expect(openRouterPayloads[0]).not.toContain(
				"Seed-Baked Preprint With Maintainer Keywords",
			);
			expect(fallbackRes[0]?.keywords).toEqual(["Zero-Knowledge Proof"]);
			expect(fallbackRes[0]?.keywordSource).toBe("maintainer_llm");
			expect(fallbackRes[1]?.keywords).toEqual([
				"Homomorphic Encryption",
				"Side-Channel Analysis",
			]);
			expect(fallbackRes[1]?.keywordSource).toBe("client_llm");

			// 4. On-demand detail check for `arXiv` DOES check `arxiv.org/html/<id>` once for author `\keywords`
			//    (tagging `keywordSource: "author"`), recovers missing abstracts via arXiv Atom `id_list`,
			//    and skips Keyword LLM when author HTML keywords succeed!
			const bareArxivCard: CollectionPaperItem = {
				id: "arxiv:2611.90003",
				arxivId: "2611.90003",
				title: "Card Clicked In Detail Dialog",
				authors: ["Carol"],
				abstract: "",
				publishedAt: recentIso,
				year: 2026,
				sourceType: "arxiv",
				sourceLabel: "cs.PL",
				categories: ["cs.PL"],
				citationCount: 0,
				keywords: [],
				url: "https://arxiv.org/abs/2611.90003",
			};
			expect(shouldEnrichPaperOnDemand(bareArxivCard)).toBe(true);
			let htmlFetchedForArxiv = false;
			let llmCalledForHtmlHit = false;
			const onDemandArxiv = await enrichSinglePaperOnDemand(
				bareArxivCard,
				async () => {
					throw new Error("HTTP 404");
				},
				async (url) => {
					if (url.includes("arxiv.org/html/2611.90003")) {
						htmlFetchedForArxiv = true;
						return `<div class="ltx_keywords">Keywords: Gradual Typing, Dependent Types</div>`;
					}
					if (url.includes("id_list=2611.90003")) {
						return `<feed xmlns="http://www.w3.org/2005/Atom">
							<entry>
								<id>http://arxiv.org/abs/2611.90003v1</id>
								<summary>We formalize gradual dependent types with sound blame tracking across higher-order modules.</summary>
							</entry>
						</feed>`;
					}
					return "";
				},
				{
					keywordLlmFetch: async () => {
						llmCalledForHtmlHit = true;
						return new Response("{}", { status: 200 });
					},
				},
			);
			expect(htmlFetchedForArxiv).toBe(true);
			expect(llmCalledForHtmlHit).toBe(false);
			expect(onDemandArxiv.abstract).toBe(
				"We formalize gradual dependent types with sound blame tracking across higher-order modules.",
			);
			expect(onDemandArxiv.keywords).toEqual([
				"Gradual Typing",
				"Dependent Type",
			]);
			expect(onDemandArxiv.keywordSource).toBe("author");
			expect(isPaperMetadataComplete(onDemandArxiv)).toBe(true);
		} finally {
			setCachedKeywordLlmConfigForTests(undefined);
		}

		const venueCardWithArxiv: CollectionPaperItem = {
			id: "venue:popl-2026:arxiv:2611.90003",
			arxivId: "2611.90003",
			title: "Card Clicked Before OpenAlex Indexing",
			authors: ["Carol"],
			abstract:
				"Complete abstract already present from arXiv Atom feed for card click test.",
			publishedAt: recentIso,
			year: 2026,
			sourceType: "venue",
			sourceLabel: "POPL 2026",
			venueId: "popl-2026",
			categories: ["POPL 2026"],
			citationCount: 0,
			keywords: [],
			url: "https://arxiv.org/abs/2611.90003",
		};
		const onDemandVenue = await enrichSinglePaperOnDemand(
			venueCardWithArxiv,
			async () => {
				throw new Error(
					"OpenAlex must not be called when abstract + arxivId exist",
				);
			},
			async (url) =>
				url.includes("arxiv.org/html/2611.90003")
					? `<div class="ltx_keywords">Keywords: Gradual Typing, Dependent Types</div>`
					: "",
		);
		expect(onDemandVenue.keywords).toEqual([
			"Gradual Typing",
			"Dependent Type",
		]);
		expect(onDemandVenue.keywordSource).toBe("author");

		// 5. `refreshArxivCollection` heals already-cached `historyComplete: true` SQLite arXiv rows lacking keywords via Keyword LLM
		resetCollectionMemoryForTests();
		setCachedKeywordLlmConfigForTests({
			apiKey: "test-llm-key",
		});
		const ipc = installMockCollectionIpc({
			categories: ["cs.SE"],
			venues: [...DEFAULT_COLLECTION_VENUES],
			items: [
				{
					id: "arxiv:2607.12345",
					arxivId: "2607.12345",
					doi: "10.48550/arxiv.2607.12345",
					title: "Previously Synced Unenriched SE Preprint",
					authors: ["Edsger Dijkstra"],
					abstract:
						"We present a deductive verification framework previously cached without keywords.",
					publishedAt: "2026-07-20T10:00:00Z",
					year: 2026,
					sourceType: "arxiv",
					sourceLabel: "cs.SE",
					categories: ["cs.SE"],
					citationCount: 0,
					keywords: [],
					url: "https://arxiv.org/abs/2607.12345",
				},
			],
			arxivWatermarks: {
				"cs.SE": {
					latestArxivId: "2607.12345",
					latestPublishedAt: "2026-07-20T10:00:00Z",
					oldestSyncedPublishedAt: "2026-01-02T00:00:00Z",
					remoteTotal: 1,
					historyComplete: true,
					lastSyncedAt: "2026-07-21T00:00:00Z",
				},
			},
			lastRefreshedAt: "2026-07-21T00:00:00Z",
		});

		try {
			const statusSeq: string[] = [];
			await refreshArxivCollection({
				categories: ["cs.SE"],
				onCategoryStatus: (cat, st) => statusSeq.push(`${cat}:${st}`),
				transport: {
					fetchText: async () =>
						`<feed xmlns="http://www.w3.org/2005/Atom">
							<entry>
								<id>http://arxiv.org/abs/2607.12345v1</id>
								<published>2026-07-20T10:00:00Z</published>
								<title>Previously Synced Unenriched SE Preprint</title>
								<summary>We present a deductive verification framework previously cached without keywords.</summary>
								<author><name>Edsger Dijkstra</name></author>
							</entry>
						</feed>`,
					fetchJson: async () => {
						throw new Error("OpenAlex must not be called during arXiv refresh");
					},
					keywordLlmFetch: async () =>
						new Response(
							JSON.stringify({
								choices: [
									{
										message: {
											content: JSON.stringify({
												"0": ["Deductive Verification", "Hoare Logic"],
											}),
										},
									},
								],
							}),
							{ status: 200 },
						),
				},
			});

			const healedPage = await listCollectionPapers({
				sourceType: "arxiv",
				category: "cs.SE",
			});
			expect(healedPage.items).toHaveLength(1);
			expect(healedPage.items[0]?.keywords).toEqual([
				"Deductive Verification",
				"Hoare Logic",
			]);
			expect(healedPage.items[0]?.citationCount).toBe(0);
			expect(statusSeq[0]).toBe("cs.SE:refreshing");
			expect(statusSeq[statusSeq.length - 1]).toBe("cs.SE:done");
		} finally {
			setCachedKeywordLlmConfigForTests(undefined);
			ipc.restore();
			resetCollectionMemoryForTests();
		}
	});

	it("extracts ACM ltx_classification and inline arXiv HTML keywords while skipping CCS and LNCS run-ons", () => {
		const acmHtml = `
			<article class="ltx_document">
				<div class="ltx_classification">
					<h6 class="ltx_title ltx_title_classification">ccs</h6>
					Software and its engineering — Software verification and validation
				</div>
				<div class="ltx_classification">
					<h6 class="ltx_title ltx_title_classification">keywords</h6>
					quantum software engineering; runtime assurance; context binding; retained results; prespecified protocol; service recovery
				</div>
			</article>
		`;
		expect(extractArxivHtmlKeywords(acmHtml)).toEqual([
			"Quantum Software Engineering",
			"Runtime Assurance",
			"Context Binding",
			"Retained Result",
			"Prespecified Protocol",
			"Service Recovery",
		]);

		const inlinePipeHtml = `
			<div class="ltx_abstract">
				<p class="ltx_p">Abstract body.</p>
				<p class="ltx_p"><span class="ltx_text ltx_font_bold">Keywords:</span> Static Analysis | Symbolic Execution | Memory Safety</p>
			</div>
		`;
		expect(extractArxivHtmlKeywords(inlinePipeHtml)).toEqual([
			"Static Analysis",
			"Symbolic Execution",
			"Memory Safety",
		]);

		const malformedLncsHtml = `
			<div class="ltx_keywords">
				<h6 class="ltx_title ltx_title_keywords">Keywords: </h6>
				Cybersecurity Education Security Operations Center Incident Response Training Platform
			</div>
		`;
		expect(extractArxivHtmlKeywords(malformedLncsHtml)).toEqual([]);
	});

	it("normalizes OpenAlex IDs, rawRefs, keyword provenance priority, and appends optional OpenAlex api_key on venue discovery", async () => {
		setCachedOpenAlexApiKeyForTests("test_dummy_oa_key");
		try {
			expect(
				withOpenAlexApiKey(
					"https://api.openalex.org/works/W2741809807?select=id",
				),
			).toBe(
				"https://api.openalex.org/works/W2741809807?select=id&api_key=test_dummy_oa_key",
			);

			expect(normalizeOpenAlexId("https://openalex.org/W9999999999")).toBe(
				"W9999999999",
			);
			expect(normalizeOpenAlexId("oa:w12345")).toBe("W12345");
			expect(
				normalizeRawRefs([
					"https://openalex.org/W100",
					"https://doi.org/10.1145/3800001.3800002",
					"10.48550/arXiv.2601.12345v3",
					"https://arxiv.org/abs/2601.12345v1",
					"oa:W100",
				]),
			).toEqual(["oa:W100", "doi:10.1145/3800001.3800002", "arxiv:2601.12345"]);

			// Strict provenance rank: `author` > `maintainer_llm` > `client_llm`
			expect(
				mergeKeywordMetadata(
					["Client Keyword"],
					"client_llm",
					["Maintainer Keyword"],
					"maintainer_llm",
				),
			).toEqual({
				keywords: ["Maintainer Keyword"],
				keywordSource: "maintainer_llm",
			});
			expect(
				mergeKeywordMetadata(
					["Maintainer Keyword"],
					"maintainer_llm",
					["Author Keyword"],
					"author",
				),
			).toEqual({
				keywords: ["Author Keyword"],
				keywordSource: "author",
			});

			// `<arxiv:doi>` preserves genuine publisher DOIs while falling back to synthetic DataCite arXiv DOI
			expect(
				extractArxivDoiFromAtomEntry(
					"<arxiv:doi>10.1145/3744916.3780123</arxiv:doi>",
					"2604.01234v2",
				),
			).toBe("10.1145/3744916.3780123");
			expect(
				extractArxivDoiFromAtomEntry("<title>No DOI</title>", "2604.01234v2"),
			).toBe("10.48550/arxiv.2604.01234");

			const ccs = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ccs-2026");
			if (!ccs) throw new Error("Missing ccs-2026");
			const seenUrls: string[] = [];
			const structured = await fetchVenueStructuredPapers(
				ccs,
				2026,
				async <T>(url: string) => {
					seenUrls.push(url);
					if (url.includes("api.openalex.org/works")) {
						return {
							meta: { count: 1, next_cursor: null },
							results: [
								{
									id: "https://openalex.org/W9999999999",
									title: "Post-Quantum Authenticated Key Exchange at Scale",
									publication_year: 2026,
									publication_date: "2026-10-18",
									doi: "https://doi.org/10.1145/3658644.3690211",
									referenced_works: [
										"https://openalex.org/W2001",
										"https://openalex.org/W2002",
									],
									authorships: [{ author: { display_name: "Ada Lovelace" } }],
								},
							],
						} as T;
					}
					return { message: { items: [] } } as T;
				},
			);

			expect(
				seenUrls
					.filter((u) => u.includes("api.openalex.org"))
					.every((u) => u.includes("api_key=test_dummy_oa_key")),
			).toBe(true);
			expect(structured.items[0]?.openalexId).toBe("W9999999999");
			expect(structured.items[0]?.rawRefs).toEqual(["oa:W2001", "oa:W2002"]);
			expect(structured.items[0]?.keywords).toEqual([]);
			expect(structured.items[0]?.citationCount).toBe(0);
		} finally {
			setCachedOpenAlexApiKeyForTests(null);
		}
	});

	it("skips secondary OpenAlex/Crossref queries for papers.cool Group A venues (USENIX Security 2026) and extracts keywords directly via Keyword LLM", async () => {
		const usenix = DEFAULT_COLLECTION_VENUES.find(
			(v) => v.id === "usenix-sec-2026",
		);
		if (!usenix) throw new Error("Missing usenix-sec-2026");

		const totalPapers = 110;
		const targetIdx = 104;
		const targetTitle =
			"HasteBoots! Proving TFHE Programmable Bootstrapping in Seconds Across Heterogeneous Cryptographic Accelerators and Edge Enclaves";

		const coolPanels = Array.from({ length: totalPapers }, (_, idx) => {
			const title =
				idx === targetIdx
					? targetTitle
					: `Cryptographic Protocol Verification Study Number ${idx + 1}`;
			return `
				<div id="paper-${idx + 1}@usenixsecurity26@USENIX" class="panel paper" keywords="tfhe,bootstrapping">
					<h2 class="title">
						<a href="https://www.usenix.org/conference/usenixsecurity26/presentation/paper-${idx + 1}" title="${idx + 1}/${totalPapers}">#${idx + 1}</a>
						<a id="title-paper-${idx + 1}@usenixsecurity26@USENIX" class="title-link" href="/venue/paper-${idx + 1}@usenixsecurity26@USENIX">${title}</a>
						<a id="pdf-paper-${idx + 1}@usenixsecurity26@USENIX" class="title-pdf" data="https://www.usenix.org/system/files/usenixsecurity26-paper-${idx + 1}.pdf">[PDF]</a>
					</h2>
					<p class="metainfo authors"><a class="author" href="#">Alice Researcher</a></p>
					<p id="summary-paper-${idx + 1}@usenixsecurity26@USENIX">We present a formal security analysis and implementation evaluated across realistic adversarial workloads.</p>
				</div>`;
		}).join("\n");

		setCachedKeywordLlmConfigForTests({
			apiKey: "test-llm-key",
		});
		try {
			const jsonUrls: string[] = [];
			const bundle = await fetchMultiChannelVenuePapers(
				usenix,
				2026,
				async <T>(url: string) => {
					jsonUrls.push(url);
					return { results: [] } as T;
				},
				async (url) => {
					if (url.includes("papers.cool/venue/USENIX-Sec.2026")) {
						return coolPanels;
					}
					return "";
				},
				{
					keywordLlmFetch: async (_input, init) => {
						const body = JSON.parse(String(init?.body ?? "{}")) as {
							messages?: Array<{ content: string }>;
						};
						const prompt = body.messages?.[1]?.content ?? "";
						const matchLine = /\[(\d+)\]\s+Title:\s+HasteBoots!/.exec(prompt);
						const contentObj = matchLine?.[1]
							? {
									[matchLine[1]]: [
										"Homomorphic Encryption",
										"Zero-Knowledge Proofs",
									],
								}
							: { "0": ["Protocol Verification"] };
						return new Response(
							JSON.stringify({
								choices: [
									{
										message: {
											content: JSON.stringify(contentObj),
										},
									},
								],
							}),
							{ status: 200 },
						);
					},
				},
			);

			expect(bundle.items).toHaveLength(totalPapers);
			// Zero OpenAlex or Crossref requests once papers.cool yields >= 100 main-track papers!
			expect(jsonUrls).toEqual([]);
			const hit = bundle.items.find((p) => p.title === targetTitle);
			expect(hit?.keywords).toEqual([
				"Homomorphic Encryption",
				"Zero-Knowledge Proof",
			]);
			expect(hit?.keywordSource).toBe("client_llm");
			expect(hit?.citationCount).toBe(0);
		} finally {
			setCachedKeywordLlmConfigForTests(undefined);
		}
	});

	it("enriches incomplete arXiv papers of any age (no 10-day cutoff) via Keyword LLM with zero OpenAlex calls and skips complete rows on subsequent refreshes", async () => {
		resetCollectionMemoryForTests();
		setCachedKeywordLlmConfigForTests(null);
		const nowMs = Date.now();
		const recentPub = new Date(nowMs - 3 * 86_400_000).toISOString();
		const olderPub = new Date(nowMs - 120 * 86_400_000).toISOString();

		const ipc = installMockCollectionIpc({
			categories: ["cs.CR"],
			venues: [...DEFAULT_COLLECTION_VENUES],
			items: [
				{
					id: "arxiv:2611.70001",
					arxivId: "2611.70001",
					doi: "10.48550/arxiv.2611.70001",
					title: "Recent Preprint Missing Keywords",
					authors: ["Alice"],
					abstract:
						"We study post-quantum lattice key encapsulation mechanisms under side-channel leakage.",
					publishedAt: recentPub,
					year: 2026,
					sourceType: "arxiv",
					sourceLabel: "cs.CR",
					categories: ["cs.CR"],
					citationCount: 0,
					keywords: [],
					url: "https://arxiv.org/abs/2611.70001",
				},
				{
					id: "arxiv:2605.10001",
					arxivId: "2605.10001",
					doi: "10.48550/arxiv.2605.10001",
					title: "Older 120-Day Preprint Without Keywords Or Abstract",
					authors: ["Bob"],
					abstract: "",
					publishedAt: olderPub,
					year: 2026,
					sourceType: "arxiv",
					sourceLabel: "cs.CR",
					categories: ["cs.CR"],
					citationCount: 0,
					keywords: [],
					url: "https://arxiv.org/abs/2605.10001",
				},
			],
			arxivWatermarks: {
				"cs.CR": {
					latestArxivId: "2611.70001",
					latestPublishedAt: recentPub,
					oldestSyncedPublishedAt: "2026-01-02T00:00:00Z",
					remoteTotal: 2,
					historyComplete: true,
					lastSyncedAt: recentPub,
				},
			},
			lastRefreshedAt: recentPub,
		});

		const probeAtomXml = `<feed xmlns="http://www.w3.org/2005/Atom">
			<entry>
				<id>http://arxiv.org/abs/2611.70001v1</id>
				<published>${recentPub}</published>
				<title>Recent Preprint Missing Keywords</title>
				<summary>We study post-quantum lattice key encapsulation mechanisms under side-channel leakage.</summary>
				<author><name>Alice</name></author>
			</entry>
		</feed>`;

		const olderIdListXml = `<feed xmlns="http://www.w3.org/2005/Atom">
			<entry>
				<id>http://arxiv.org/abs/2605.10001v1</id>
				<published>${olderPub}</published>
				<title>Older 120-Day Preprint Without Keywords Or Abstract</title>
				<summary>We construct threshold ring signatures secure against adaptive chosen-message attacks in lattice groups.</summary>
				<author><name>Bob</name></author>
			</entry>
		</feed>`;

		try {
			const htmlUrls: string[] = [];
			const firstRefreshOpenAlexUrls: string[] = [];

			// Refresh 1: Keyword LLM unconfigured -> zero OpenAlex requests, zero HTML scrapes, missing abstract healed via id_list!
			await refreshArxivCollection({
				categories: ["cs.CR"],
				transport: {
					fetchText: async (url) => {
						if (url.includes("arxiv.org/html/")) htmlUrls.push(url);
						if (url.includes("id_list=")) return olderIdListXml;
						return probeAtomXml;
					},
					fetchJson: async <T>(url: string) => {
						firstRefreshOpenAlexUrls.push(decodeURIComponent(url));
						return { results: [] } as T;
					},
				},
			});

			expect(htmlUrls).toEqual([]);
			expect(firstRefreshOpenAlexUrls).toEqual([]);

			// Refresh 2: User configures Keyword LLM -> both recent AND 120-day-old preprints get LLM keywords (`client_llm`) with 0 OpenAlex calls!
			setCachedKeywordLlmConfigForTests({
				apiKey: "test-llm-key",
			});
			const secondRefreshOpenAlexUrls: string[] = [];
			let secondRefreshOpenRouterCalls = 0;

			await refreshArxivCollection({
				categories: ["cs.CR"],
				transport: {
					fetchText: async (url) => {
						if (url.includes("arxiv.org/html/")) htmlUrls.push(url);
						if (url.includes("id_list=")) return olderIdListXml;
						return probeAtomXml;
					},
					fetchJson: async <T>(url: string) => {
						secondRefreshOpenAlexUrls.push(decodeURIComponent(url));
						return { results: [] } as T;
					},
					keywordLlmFetch: async () => {
						secondRefreshOpenRouterCalls += 1;
						return new Response(
							JSON.stringify({
								choices: [
									{
										message: {
											content: JSON.stringify({
												"0": [
													"Post-Quantum Cryptography",
													"Side-Channel Analysis",
												],
												"1": ["Ring Signatures", "Lattice Cryptography"],
											}),
										},
									},
								],
							}),
							{ status: 200 },
						);
					},
				},
			});

			expect(htmlUrls).toEqual([]);
			expect(secondRefreshOpenAlexUrls).toEqual([]);
			expect(secondRefreshOpenRouterCalls).toBe(1);

			const page = await listCollectionPapers({
				sourceType: "arxiv",
				category: "cs.CR",
			});
			const recentRow = page.items.find((p) => p.id === "arxiv:2611.70001");
			const olderRow = page.items.find((p) => p.id === "arxiv:2605.10001");
			expect(recentRow?.keywords).toEqual([
				"Post-Quantum Cryptography",
				"Side-Channel Analysis",
			]);
			expect(olderRow?.abstract).toBe(
				"We construct threshold ring signatures secure against adaptive chosen-message attacks in lattice groups.",
			);
			expect(olderRow?.keywords).toEqual([
				"Ring Signature",
				"Lattice Cryptography",
			]);
			expect(recentRow && isPaperMetadataComplete(recentRow)).toBe(true);
			expect(olderRow && isPaperMetadataComplete(olderRow)).toBe(true);

			// Refresh 3: Once every paper has complete metadata, subsequent refreshes skip enrichment permanently!
			const thirdRefreshOpenAlexUrls: string[] = [];
			let thirdRefreshOpenRouterCalls = 0;
			await refreshArxivCollection({
				categories: ["cs.CR"],
				transport: {
					fetchText: async () => probeAtomXml,
					fetchJson: async <T>(url: string) => {
						thirdRefreshOpenAlexUrls.push(decodeURIComponent(url));
						return { results: [] } as T;
					},
					keywordLlmFetch: async () => {
						thirdRefreshOpenRouterCalls += 1;
						return new Response("{}", { status: 200 });
					},
				},
			});
			expect(thirdRefreshOpenAlexUrls).toEqual([]);
			expect(thirdRefreshOpenRouterCalls).toBe(0);
		} finally {
			setCachedKeywordLlmConfigForTests(undefined);
			ipc.restore();
			resetCollectionMemoryForTests();
		}
	});

	it("marks CSDL Venue author keywords with keywordSource='author', skips cold-start OpenAlex requests, and falls back to Keyword LLM only when keywords remain empty", async () => {
		const sp = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "sp-2026");
		if (!sp) throw new Error("Missing sp-2026");

		// Verify generic OpenAI-compatible model catalog ordering (active model pinned first if present, rest sorted alphabetically)
		const models = await fetchKeywordLlmModels(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "qwen/qwen3-coder:free",
			},
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "openai/gpt-5", name: "GPT-5" },
							{
								id: "baidu/ernie-5.5-flash-preview:free",
								name: "Baidu: ERNIE 5.5 Flash Preview (free)",
								context_length: 131072,
							},
							{
								id: "qwen/qwen3-coder:free",
								name: "Qwen3 Coder (free)",
								context_length: 65536,
							},
						],
					}),
					{ status: 200 },
				),
		);
		expect(models).toEqual([
			"qwen/qwen3-coder:free",
			"baidu/ernie-5.5-flash-preview:free",
			"openai/gpt-5",
		]);

		setCachedKeywordLlmConfigForTests({
			apiKey: "test-llm-key",
		});

		try {
			const csdlPapers = Array.from({ length: 26 }, (_, idx) => ({
				id: `sp26-${idx + 1}`,
				title:
					idx === 0
						? "Hybrid Fuzzing with Directed Symbolic Execution"
						: idx === 1
							? "Memory-Safe Microkernel Isolation Without Upstream Keywords"
							: `Security Protocol Analysis Number ${idx + 1}`,
				doi: `10.1109/SP60000.2026.${String(idx + 2).padStart(5, "0")}`,
				contentType: "paper",
				year: "2026",
				pubDate: "2026-05-18",
				pages: `${idx * 15 + 1}-${idx * 15 + 14}`,
				abstract:
					idx === 1
						? "We design a capability-based Rust microkernel isolating untrusted device drivers with zero-copy IPC verification."
						: "We present a comprehensive security analysis and evaluation across real-world systems.",
				keywords:
					idx === 0
						? ["Hybrid Fuzzing", "Symbolic Execution"]
						: idx === 1
							? []
							: ["Protocol Verification"],
				authors: [{ fullName: "Grace Hopper" }],
			}));

			const openAlexCalls: string[] = [];
			const openRouterPrompts: string[] = [];
			let callAttempt = 0;

			const bundle = await fetchMultiChannelVenuePapers(
				sp,
				2026,
				async <T>(url: string) => {
					const decoded = decodeURIComponent(url);
					if (url.includes("www.computer.org/csdl/api/v1/graphql")) {
						if (decoded.includes("proceedings(")) {
							return {
								data: {
									proceedings: [
										{
											id: "sp-main-2026",
											title: "2026 IEEE Symposium on Security and Privacy (SP)",
										},
									],
								},
							} as T;
						}
						return {
							data: {
								articlesByProceeding: csdlPapers,
							},
						} as T;
					}
					if (decoded.includes("api.openalex.org")) {
						openAlexCalls.push(decoded);
					}
					return { results: [] } as T;
				},
				async () => "",
				{
					keywordLlmFetch: async (_input, init) => {
						callAttempt += 1;
						const body = JSON.parse(String(init?.body ?? "{}")) as {
							model?: string;
							reasoning?: { effort?: string; exclude?: boolean };
							messages?: Array<{ role: string; content: string }>;
						};
						expect(body.model).toBe(DEFAULT_KEYWORD_LLM_MODEL);
						// Simulate first-call 400 on custom reasoning check, then 200 with `<think>` block
						if (callAttempt === 1) {
							expect(body.reasoning).toEqual({
								effort: "low",
								exclude: true,
							});
							return new Response("Reasoning config unsupported", {
								status: 400,
							});
						}
						openRouterPrompts.push(body.messages?.[1]?.content ?? "");
						return new Response(
							JSON.stringify({
								choices: [
									{
										message: {
											content: `<think>short</think>{"items":[{"idx":0,"keywords":["Microkernel Isolation","Capability Security","Rust Verification","Device Driver Isolation"]}]}`,
										},
									},
								],
							}),
							{ status: 200 },
						);
					},
				},
			);

			expect(bundle.items).toHaveLength(26);
			// Cold-start IEEE CSDL venue with complete abstracts + DOIs makes ZERO OpenAlex calls!
			expect(openAlexCalls).toEqual([]);

			const p1 = bundle.items.find((p) =>
				p.title.includes("Hybrid Fuzzing with Directed Symbolic Execution"),
			);
			const p2 = bundle.items.find((p) =>
				p.title.includes("Memory-Safe Microkernel Isolation"),
			);

			// Paper 1 retains pure IEEE CSDL author keywords with `keywordSource: "author"`
			expect(p1?.keywords).toEqual(["Hybrid Fuzzing", "Symbolic Execution"]);
			expect(p1?.keywordSource).toBe("author");
			expect(p1?.citationCount).toBe(0);

			// Paper 2 lacked author keywords -> extracted via Keyword LLM with `keywordSource: "client_llm"`
			expect(p2?.keywords).toEqual([
				"Microkernel Isolation",
				"Capability Security",
				"Rust Verification",
				"Device Driver Isolation",
			]);
			expect(p2?.keywordSource).toBe("client_llm");
			// OpenRouter only received the 1 paper missing keywords (not the 25 papers with author keywords!)
			expect(openRouterPrompts).toHaveLength(1);
			expect(openRouterPrompts[0]).toContain(
				"Memory-Safe Microkernel Isolation",
			);
			expect(openRouterPrompts[0]).not.toContain("Hybrid Fuzzing");
		} finally {
			setCachedKeywordLlmConfigForTests(undefined);
		}
	});

	it("applies Smart Diff on Venue refresh: deletes extra SQLite rows, makes 0 OpenAlex calls on Group A, and sends only incomplete/new rows to Keyword LLM", async () => {
		resetCollectionMemoryForTests();
		setCachedKeywordLlmConfigForTests({
			apiKey: "test-llm-key",
		});

		const usenix = DEFAULT_COLLECTION_VENUES.find(
			(v) => v.id === "usenix-sec-2026",
		);
		if (!usenix) throw new Error("Missing usenix-sec-2026");

		// Build 102 existing complete rows + 1 existing incomplete row (missing keywords) + 1 stale row to be deleted
		const completeRows: CollectionPaperItem[] = Array.from(
			{ length: 102 },
			(_, idx) => ({
				id: `venue:usenix-sec-2026:complete-security-paper-${idx + 1}`,
				title: `Complete Security Paper Number ${idx + 1}`,
				authors: ["Alice"],
				abstract:
					"Cached complete abstract describing formal verification and systems security evaluation.",
				publishedAt: "2026-08-12T00:00:00Z",
				year: 2026,
				sourceType: "venue",
				sourceLabel: usenix.name,
				categories: [usenix.name, "CR", "CCF-A"],
				url: `https://www.usenix.org/conference/usenixsecurity26/presentation/complete-${idx + 1}`,
				pdfUrl: `https://www.usenix.org/system/files/complete-${idx + 1}.pdf`,
				coolPapersId: `complete-${idx + 1}@usenixsecurity26@USENIX`,
				venueId: usenix.id,
				venueKind: "conference",
				venueDomain: "CR",
				ccfRank: "CCF-A",
				citationCount: 5,
				keywords: ["Formal Verification", "Systems Security"],
				...(idx === 0 ? { recommendedAt: "2026-08-15T09:00:00Z" } : {}),
			}),
		);

		const incompleteExistingRow: CollectionPaperItem = {
			id: "venue:usenix-sec-2026:incomplete-existing-paper",
			title: "Incomplete Existing Paper Missing Keywords",
			authors: ["Bob"],
			abstract:
				"Cached complete abstract for an existing paper whose keywords were previously empty.",
			publishedAt: "2026-08-12T00:00:00Z",
			year: 2026,
			sourceType: "venue",
			sourceLabel: usenix.name,
			categories: [usenix.name, "CR", "CCF-A"],
			url: "https://www.usenix.org/conference/usenixsecurity26/presentation/incomplete-existing",
			coolPapersId: "incomplete-existing@usenixsecurity26@USENIX",
			venueId: usenix.id,
			venueKind: "conference",
			venueDomain: "CR",
			ccfRank: "CCF-A",
			citationCount: 2,
			keywords: [],
			recommendedAt: "2026-08-16T10:00:00Z",
		};

		const extraStaleRow: CollectionPaperItem = {
			id: "venue:usenix-sec-2026:withdrawn-stale-paper",
			title: "Withdrawn Stale Paper No Longer In Upstream",
			authors: ["Mallory"],
			abstract:
				"This withdrawn paper is no longer on the official accepted papers page and must be removed.",
			publishedAt: "2026-08-12T00:00:00Z",
			year: 2026,
			sourceType: "venue",
			sourceLabel: usenix.name,
			categories: [usenix.name],
			url: "https://www.usenix.org/conference/usenixsecurity26/presentation/withdrawn",
			venueId: usenix.id,
			venueKind: "conference",
			venueDomain: "CR",
			ccfRank: "CCF-A",
			citationCount: 0,
			keywords: ["Obsolete"],
		};

		const ipc = installMockCollectionIpc({
			categories: ["cs.CR"],
			venues: DEFAULT_COLLECTION_VENUES.map((v) =>
				v.id === usenix.id
					? {
							...v,
							paperCount: 104,
							lastFetchedAt: "2026-08-20T00:00:00Z",
						}
					: v,
			),
			items: [...completeRows, incompleteExistingRow, extraStaleRow],
		});

		// Upstream fresh list: 102 complete rows + 1 incompleteExistingRow + 1 brandNewRow (extraStaleRow removed!)
		const makePanel = (
			slug: string,
			title: string,
			idx: number,
			total: number,
		) => `
			<div id="${slug}@usenixsecurity26@USENIX" class="panel paper">
				<h2 class="title">
					<a href="https://www.usenix.org/conference/usenixsecurity26/presentation/${slug}" title="${idx}/${total}">#${idx}</a>
					<a id="title-${slug}@usenixsecurity26@USENIX" class="title-link" href="/venue/${slug}@usenixsecurity26@USENIX">${title}</a>
				</h2>
				<p class="metainfo authors"><a class="author" href="#">Alice</a></p>
				<p id="summary-${slug}@usenixsecurity26@USENIX">Upstream abstract describing formal verification and systems security evaluation across benchmarks.</p>
			</div>`;

		const freshUpstreamHtml = [
			...completeRows.map((r, i) =>
				makePanel(`complete-${i + 1}`, r.title, i + 1, 104),
			),
			makePanel("incomplete-existing", incompleteExistingRow.title, 103, 104),
			makePanel(
				"brand-new-paper",
				"Brand New Zero-Day Kernel Exploit Mitigation Paper",
				104,
				104,
			),
		].join("\n");

		try {
			const openAlexUrls: string[] = [];
			const openRouterPayloads: string[] = [];

			// Pass 1: Zero OpenAlex requests; Keyword LLM receives ONLY the 1 incomplete existing row + 1 brand-new row!
			await ensureVenueLoaded(usenix.id, {
				fetchText: async (url) =>
					url.includes("papers.cool/venue/USENIX-Sec.2026")
						? freshUpstreamHtml
						: "",
				fetchJson: async <T>(url: string) => {
					openAlexUrls.push(decodeURIComponent(url));
					return { results: [] } as T;
				},
				keywordLlmFetch: async (_input, init) => {
					const body = JSON.parse(String(init?.body ?? "{}")) as {
						messages?: Array<{ content: string }>;
					};
					openRouterPayloads.push(body.messages?.[1]?.content ?? "");
					return new Response(
						JSON.stringify({
							choices: [
								{
									message: {
										content: JSON.stringify({
											items: [
												{
													idx: 0,
													keywords: ["Memory Safety"],
												},
												{
													idx: 1,
													keywords: [
														"Kernel Exploit Mitigation",
														"Control-Flow Integrity",
													],
												},
											],
										}),
									},
								},
							],
						}),
						{ status: 200 },
					);
				},
			});

			expect(openAlexUrls).toEqual([]);
			expect(openRouterPayloads).toHaveLength(1);
			expect(openRouterPayloads[0]).not.toContain(
				"Complete Security Paper Number 1",
			);
			expect(openRouterPayloads[0]).toContain(
				"Incomplete Existing Paper Missing Keywords",
			);
			expect(openRouterPayloads[0]).toContain(
				"Brand New Zero-Day Kernel Exploit Mitigation Paper",
			);

			const afterPass1 = await listCollectionPapers({
				sourceType: "venue",
				venueId: usenix.id,
				limit: 200,
			});
			expect(afterPass1.total).toBe(104);
			expect(
				afterPass1.items.some((p) => p.title === extraStaleRow.title),
			).toBe(false);
			const healedRow = afterPass1.items.find(
				(p) => p.title === incompleteExistingRow.title,
			);
			expect(healedRow?.keywords).toEqual(["Memory Safety"]);
			expect(healedRow?.recommendedAt).toBe("2026-08-16T10:00:00Z");

			const newRow = afterPass1.items.find((p) =>
				p.title.includes("Brand New Zero-Day Kernel Exploit Mitigation Paper"),
			);
			expect(newRow?.keywords).toEqual([
				"Kernel Exploit Mitigation",
				"Control-Flow Integrity",
			]);

			// Pass 2: Now all 104 rows in SQLite are complete -> refreshing again makes ZERO OpenAlex and ZERO OpenRouter calls!
			openAlexUrls.length = 0;
			openRouterPayloads.length = 0;
			await ensureVenueLoaded(usenix.id, {
				fetchText: async (url) =>
					url.includes("papers.cool/venue/USENIX-Sec.2026")
						? freshUpstreamHtml
						: "",
				fetchJson: async <T>(url: string) => {
					openAlexUrls.push(url);
					return { results: [] } as T;
				},
				keywordLlmFetch: async () => {
					openRouterPayloads.push("unexpected");
					return new Response("{}", { status: 200 });
				},
			});

			expect(openAlexUrls).toEqual([]);
			expect(openRouterPayloads).toEqual([]);
		} finally {
			setCachedKeywordLlmConfigForTests(undefined);
			ipc.restore();
		}
	});

	it("blocks Zenodo/artifact DOIs, non-article OpenAlex types, and POSTER/DEMO titles across all enrichment paths", async () => {
		const issre = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "issre-2026");
		if (!issre) throw new Error("Missing issre-2026");
		const issreSpec = VENUE_SPEC_BY_ID.get("issre-2026");

		// 1. Artifact/dataset DOI prefixes + non-main-track title prefixes
		for (const badDoi of [
			"https://doi.org/10.5281/ZENODO.21868420",
			"10.6084/m9.figshare.12345",
			"10.6084/figshare.99887",
			"10.17605/OSF.IO/ABCDE",
			"10.24433/co.1234567.v1",
			"10.7910/DVN/XYZ",
			"10.5061/dryad.abc123",
			"10.4121/uuid-123",
			"10.13140/RG.2.2.12345",
		]) {
			expect(isArtifactOrDatasetDoi(badDoi)).toBe(true);
		}
		expect(isArtifactOrDatasetDoi("10.1109/ISSRE.2026.00012")).toBe(false);
		expect(isArtifactOrDatasetDoi("10.18653/v1/2026.acl-long.1")).toBe(false);

		expect(isNonMainTrackPrefixedTitle("POSTER: Dynamic Binary Lifting")).toBe(
			true,
		);
		expect(isNonMainTrackPrefixedTitle("DEMO: Live Fuzzing Dashboard")).toBe(
			true,
		);
		expect(
			isNonMainTrackPrefixedTitle("WORKSHOP: Security of Autonomous Agents"),
		).toBe(true);
		expect(
			isNonMainTrackPrefixedTitle("TUTORIAL: Abstract Interpretation"),
		).toBe(true);
		expect(isNonMainTrackPrefixedTitle("DOCTORAL: Verified Compilers")).toBe(
			true,
		);
		expect(
			isNonMainTrackPrefixedTitle("POSTER: Sound Static Analysis for Rust"),
		).toBe(true);
		expect(
			isNonMainTrackPrefixedTitle(
				"Bridging the Granularity Gap in Log Anomaly Detection",
			),
		).toBe(false);

		// 2. Direct row converters reject Zenodo DOIs & dataset/software/paratext/erratum OpenAlex types
		expect(
			openAlexWorkToVenueItem(
				{
					id: "https://openalex.org/W_zenodo",
					type: "dataset",
					title: "Bridging the Granularity Gap in Log Anomaly Detection",
					doi: "https://doi.org/10.5281/zenodo.21868420",
					abstract_inverted_index: {
						Replication: [0],
						artifact: [1],
						zip: [2],
					},
					authorships: [{ author: { display_name: "Alice Doe" } }],
				},
				issre,
				issreSpec,
				2026,
			),
		).toBeNull();
		for (const rejectedType of ["dataset", "software", "paratext", "erratum"]) {
			expect(
				openAlexWorkToVenueItem(
					{
						id: `https://openalex.org/W_${rejectedType}`,
						type: rejectedType,
						title: "Valid Looking Paper Title",
						doi: "https://doi.org/10.1109/ISSRE.2026.1",
						authorships: [{ author: { display_name: "Alice Doe" } }],
					},
					issre,
					issreSpec,
					2026,
				),
			).toBeNull();
		}
		expect(
			crossrefWorkToVenueItem(
				{
					DOI: "10.5281/zenodo.21868420",
					type: "dataset",
					title: ["Bridging the Granularity Gap Replication Package"],
					author: [{ given: "Alice", family: "Doe" }],
				},
				issre,
				issreSpec,
				2026,
			),
		).toBeNull();
		expect(
			semanticScholarWorkToVenueItem(
				{
					paperId: "s2zenodo",
					title: "Bridging the Granularity Gap",
					externalIds: { DOI: "10.5281/zenodo.21868420" },
					authors: [{ name: "Alice Doe" }],
				},
				issre,
				issreSpec,
				2026,
			),
		).toBeNull();

		// 3. enrichVenueItemsBatch (preloaded + title.search), backfillMissingMetadataFromChannel, and enrichSinglePaperOnDemand
		// must NEVER adopt Zenodo DOIs or overwrite ISSRE abstract when only a Zenodo artifact exists
		const issrePaper: CollectionPaperItem = {
			id: "venue:issre-2026:bridging",
			title: "Bridging the Granularity Gap in Log Anomaly Detection",
			authors: ["Alice Doe", "Bob Roe"],
			abstract: "",
			publishedAt: "2026-01-01T00:00:00Z",
			year: 2026,
			sourceType: "venue",
			sourceLabel: issre.name,
			categories: [issre.name],
			url: "https://issre.github.io/2026/program/papers/",
			venueId: issre.id,
			venueKind: "conference",
			venueDomain: "PL/SE",
			ccfRank: "CCF-B",
			venueFull: issre.name,
		};
		const poisonedZenodoItem: CollectionPaperItem = {
			...issrePaper,
			id: "venue:issre-2026:doi:10.5281/zenodo.21868420",
			doi: "10.5281/zenodo.21868420",
			abstract: "Zenodo artifact README contents that must not leak.",
			url: "https://zenodo.org/records/21868420",
		};

		const enrichedIssre = await enrichVenueItemsBatch(
			[issrePaper],
			issre,
			async <T>(url: string) => {
				if (url.includes("api.openalex.org/works")) {
					return {
						results: [
							{
								id: "https://openalex.org/W_zenodo_21868420",
								type: "dataset",
								title: "Bridging the Granularity Gap in Log Anomaly Detection",
								doi: "https://doi.org/10.5281/zenodo.21868420",
								publication_year: 2026,
								abstract_inverted_index: {
									Zenodo: [0],
									artifact: [1],
									repository: [2],
								},
								authorships: [
									{ author: { display_name: "Alice Doe" } },
									{ author: { display_name: "Bob Roe" } },
								],
							},
						],
					} as T;
				}
				return { results: [], data: [] } as T;
			},
			[poisonedZenodoItem],
		);
		expect(enrichedIssre[0]?.doi).toBeUndefined();
		expect(enrichedIssre[0]?.abstract).toBe("");

		const backfilled = backfillMissingMetadataFromChannel(
			[issrePaper],
			[poisonedZenodoItem],
		);
		expect(backfilled[0]?.doi).toBeUndefined();
		expect(backfilled[0]?.abstract).toBe("");

		const onDemand = await enrichSinglePaperOnDemand(
			issrePaper,
			async <T>(url: string) => {
				if (url.includes("api.openalex.org/works")) {
					return {
						results: [
							{
								id: "https://openalex.org/W_zenodo_single",
								type: "article",
								title: "Bridging the Granularity Gap in Log Anomaly Detection",
								doi: "https://doi.org/10.5281/zenodo.21868420",
								publication_year: 2026,
								abstract_inverted_index: { Fake: [0], zenodo: [1], text: [2] },
								authorships: [{ author: { display_name: "Alice Doe" } }],
							},
						],
					} as T;
				}
				if (url.includes("api.semanticscholar.org")) {
					return {
						data: [
							{
								paperId: "s2zen",
								title: "Bridging the Granularity Gap in Log Anomaly Detection",
								abstract: "Zenodo replication package in S2.",
								externalIds: { DOI: "10.5281/zenodo.21868420" },
								authors: [{ name: "Alice Doe" }],
							},
						],
					} as T;
				}
				return {} as T;
			},
		);
		expect(onDemand.doi).toBeUndefined();
		expect(onDemand.abstract).toBe("");
	});

	it("parses MiniConf Virtual JSON for NeurIPS/ICLR/ICML with NeurIPS-only Datasets & Benchmarks and graceful papers.cool fallback", async () => {
		const neurips = DEFAULT_COLLECTION_VENUES.find(
			(v) => v.id === "neurips-2026",
		);
		const iclr = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "iclr-2026");
		if (!neurips || !iclr) throw new Error("Missing MiniConf test venues");

		// Datasets & Benchmarks allowed ONLY when explicitly permitted by spec
		expect(isWorkshopOrCompanionVenue("NeurIPS Datasets and Benchmarks")).toBe(
			true,
		);
		expect(
			isWorkshopOrCompanionVenue(
				"NeurIPS.cc/2026/Evaluations_and_Datasets_Track",
			),
		).toBe(true);
		expect(
			isWorkshopOrCompanionVenue(
				"NeurIPS.cc/2026/Evaluations_and_Datasets_Track",
				{
					allowDatasetsBenchmarks: true,
				},
			),
		).toBe(false);
		expect(
			isWorkshopOrCompanionVenue("NeurIPS Datasets and Benchmarks", {
				allowDatasetsBenchmarks: true,
			}),
		).toBe(false);
		for (const rejected of [
			"NeurIPS.cc/2026/Position_Paper_Track",
			"NeurIPS.cc/2026/BlogPosts",
			"journal-track/NeurIPS_2026-Posters_TMLR.xlsx",
			"JMLR 2026",
			"AoS",
			"bridging-the-future",
			"ICLR 2026 Workshop",
		]) {
			expect(
				isWorkshopOrCompanionVenue(rejected.replace(/[_/.-]+/g, " "), {
					allowDatasetsBenchmarks: true,
				}),
			).toBe(true);
		}

		const mockMiniConfJson = async <T>(url: string): Promise<T> => {
			if (url.includes("neurips-2026-orals-posters.json")) {
				return {
					count: 8,
					results: [
						{
							id: 101,
							uid: "or-101",
							name: "Main Track&#x27;s Oral Paper",
							authors: [
								{ fullname: "Ada Lovelace" },
								{ fullname: "Alan Turing" },
							],
							keywords: ["scaling", "transformers"],
							decision: "Accept (oral)",
							eventtype: "Oral",
							sourceurl:
								"https://openreview.net/group?id=NeurIPS.cc/2026/Conference",
							paper_url: "",
							url: "https://openreview.net/forum?id=MainOral123",
							paper_pdf_url: null,
						},
						{
							id: 102,
							uid: "or-102",
							name: "Unified Multimodal Benchmark Suite",
							authors: [{ fullname: "Grace Hopper" }],
							decision: "Accept (poster)",
							eventtype: "Poster",
							sourceurl:
								"https://openreview.net/group?id=NeurIPS.cc/2026/Evaluations_and_Datasets_Track",
							paper_url: "https://openreview.net/forum?id=DbTrack456",
						},
						{
							id: 103,
							name: "Position: Stop Benchmarking Benchmarks",
							authors: [{ fullname: "Chris Researcher" }],
							decision: "Accept (spotlight)",
							eventtype: "Spotlight",
							sourceurl:
								"https://openreview.net/group?id=NeurIPS.cc/2026/Position_Paper_Track",
						},
						{
							id: 104,
							name: "Blog Post Summary",
							authors: [{ fullname: "Blog Author" }],
							decision: "Accept",
							sourceurl:
								"https://openreview.net/group?id=NeurIPS.cc/2026/BlogPosts",
						},
						{
							id: 105,
							name: "TMLR Cross-Posted Paper",
							authors: [{ fullname: "Journal Author" }],
							decision: "Accept",
							sourceurl: "journal-track/NeurIPS_2026-Posters_TMLR.xlsx",
						},
						{
							id: 106,
							name: "JMLR & AoS Journal Track",
							authors: [{ fullname: "Stat Author" }],
							decision: "Accept",
							sourceurl: "journal-track/NeurIPS_2026_JMLR_AoS.xlsx",
						},
						{
							id: 107,
							name: "Withdrawn Main Submission",
							authors: [{ fullname: "Withdrawn Author" }],
							decision: "Withdrawn",
							sourceurl:
								"https://openreview.net/group?id=NeurIPS.cc/2026/Conference",
						},
						{
							id: 108,
							name: "Workshop Bridging Future",
							authors: [{ fullname: "Ws Author" }],
							decision: "Accept",
							sourceurl:
								"https://openreview.net/group?id=NeurIPS.cc/2026/Workshop/bridging-the-future",
						},
					],
				} as T;
			}
			if (url.includes("neurips-2026-abstracts.json")) {
				return {
					"101": "Full official NeurIPS main conference oral abstract.",
					"or-102": "Full NeurIPS Datasets and Benchmarks abstract.",
				} as T;
			}
			if (url.includes("iclr-2026-orals-posters.json")) {
				return [
					{
						id: "iclr-1",
						name: "ICLR Main Conference Spotlight",
						authors: [{ fullname: "Yann LeCun" }],
						decision: "Accept (spotlight)",
						eventtype: "Spotlight",
						sourceurl:
							"https://openreview.net/group?id=ICLR.cc/2026/Conference",
						paper_url: "https://openreview.net/forum?id=IclrSpot9",
					},
					{
						id: "iclr-2",
						name: "Non-NeurIPS Datasets Track Must Drop",
						authors: [{ fullname: "Other Author" }],
						decision: "Accept (poster)",
						eventtype: "Poster",
						sourceurl:
							"https://openreview.net/group?id=ICLR.cc/2026/Datasets_and_Benchmarks",
					},
				] as T;
			}
			if (url.includes("iclr-2026-abstracts.json")) {
				return {
					"iclr-1": "ICLR spotlight abstract via MiniConf.",
				} as T;
			}
			return { results: [] } as T;
		};

		const neuripsMini = await fetchMiniConfVenuePapers(
			neurips,
			2026,
			mockMiniConfJson,
		);
		expect(neuripsMini.items.map((p) => p.title)).toEqual([
			"Main Track's Oral Paper",
			"Unified Multimodal Benchmark Suite",
		]);
		expect(neuripsMini.items[0]?.abstract).toBe(
			"Full official NeurIPS main conference oral abstract.",
		);
		expect(neuripsMini.items[0]?.pdfUrl).toBe(
			"https://openreview.net/pdf?id=MainOral123",
		);
		expect(neuripsMini.items[1]?.abstract).toBe(
			"Full NeurIPS Datasets and Benchmarks abstract.",
		);
		expect(neuripsMini.items[1]?.pdfUrl).toBe(
			"https://openreview.net/pdf?id=DbTrack456",
		);

		const iclrMini = await fetchMiniConfVenuePapers(
			iclr,
			2026,
			mockMiniConfJson,
		);
		expect(iclrMini.items.map((p) => p.title)).toEqual([
			"ICLR Main Conference Spotlight",
		]);

		// Graceful fallback to papers.cool when MiniConf throws / returns empty
		const coolPanelsHtml = `
			<p class="info">Total 120 papers</p>
			${Array.from(
				{ length: 102 },
				(_, idx) => `
				<div id="iclr${idx}@OpenReview" class="panel paper">
					<h2 class="title"><a href="https://openreview.net/forum?id=iclr${idx}"></a><a id="title-iclr${idx}">Fallback ICLR Cool Paper ${idx}</a></h2>
					<p class="metainfo authors"><a class="author">Author ${idx}</a></p>
					<p class="metainfo subjects"><a href="/venue/ICLR.2026?group=Poster">ICLR.2026 - Poster</a></p>
					<p id="summary-iclr${idx}" class="summary">Fallback abstract ${idx}.</p>
				</div>`,
			).join("\n")}`;
		const iclrFallback = await fetchMultiChannelVenuePapers(
			iclr,
			2026,
			async <T>(url: string) => {
				if (url.includes("iclr.cc/static/virtual/data")) {
					throw new Error("HTTP 404 Not Found");
				}
				return { results: [] } as T;
			},
			async (url: string) =>
				url.includes("papers.cool/venue/ICLR.2026") ? coolPanelsHtml : "",
		);
		expect(iclrFallback.items).toHaveLength(102);
		expect(iclrFallback.authoritativeMainTrack).toBe(true);
	});

	it("parses ACL Anthology 2026 volumes + 2026.aclweb.org accepted_papers and falls back to papers.cool when empty", async () => {
		const acl = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "acl-2026");
		if (!acl) throw new Error("Missing acl-2026");
		const aclSpec = VENUE_SPEC_BY_ID.get("acl-2026");

		const aclWebHtml = `
			<div class="page__content">
				<div class="notice--info">Acceptance announcement</div>
				<ul>
					<li><p><strong>OctoTools: Executable Tool Chains for Language Agents</strong><br /><em>Pan Lu, Bowen Chen</em></p></li>
					<li><p><strong>Compact Discourse Parsing in Low Resource</strong><br /><em>Jane Doe &amp; John Smith</em></p></li>
				</ul>
			</div>`;
		const aclLongHtml = `
			<div class="d-sm-flex align-items-stretch mb-3">
				<div class="d-none d-sm-block"><a href=https://aclanthology.org/2026.acl-long.0.pdf>pdf</a></div>
				<span class=d-block><strong><a class=align-middle href=/2026.acl-long.0/>Proceedings of ACL 2026 Long Papers</a></strong></span>
			</div>
			<div class="d-sm-flex align-items-stretch mb-3">
				<div class="d-none d-sm-block"><a href=https://aclanthology.org/2026.acl-long.1.pdf>pdf</a></div>
				<span class=d-block>
					<strong><a class=align-middle href=/2026.acl-long.1/><span class=acl-fixed-case>O</span>cto<span class=acl-fixed-case>T</span>ools: Executable Tool Chains for Language Agents</a></strong><br>
					<a href=/people/p/pan-lu/>Pan Lu</a> | <a href=/people/b/bowen-chen/>Bowen Chen</a>
				</span>
			</div>
			<div class="card bg-light collapse abstract-collapse" id=abstract-2026--acl-long--1>
				<div class="card-body p-3 small">OctoTools coordinates heterogeneous domain tools cleanly.</div>
			</div>
			<div class="d-sm-flex align-items-stretch mb-3">
				<span class=d-block><strong><a href=/2026.acl-long.2/>Extra Unlisted Volume Note</a></strong><br><a href=/people/u/unlisted/>Unlisted Author</a></span>
			</div>`;
		const aclShortHtml = `
			<div class="d-sm-flex align-items-stretch mb-3">
				<div class="d-none d-sm-block"><a href=https://aclanthology.org/2026.acl-short.3.pdf>pdf</a></div>
				<span class=d-block>
					<strong><a href=/2026.acl-short.3/>Compact Discourse Parsing in Low Resource</a></strong><br>
					<a href=/people/j/jane-doe/>Jane Doe</a> | <a href=/people/j/john-smith/>John Smith</a>
				</span>
			</div>
			<div class="card collapse abstract-collapse" id="abstract-2026--acl-short-3">
				<div class="card-body">Minimal short-paper discourse parser.</div>
			</div>`;

		const aclWebParsed = parseOfficialVenueProgramHtml(
			aclWebHtml,
			"https://2026.aclweb.org/program/accepted_papers/",
			acl,
			aclSpec,
			2026,
		);
		expect(aclWebParsed.map((p) => p.title)).toEqual([
			"OctoTools: Executable Tool Chains for Language Agents",
			"Compact Discourse Parsing in Low Resource",
		]);
		expect(aclWebParsed[1]?.authors).toEqual(["Jane Doe", "John Smith"]);

		const longParsed = parseAclAnthologyVolumeHtml(
			aclLongHtml,
			"https://aclanthology.org/volumes/2026.acl-long/",
			acl,
			aclSpec,
			2026,
		);
		expect(longParsed.map((p) => p.title)).toEqual([
			"OctoTools: Executable Tool Chains for Language Agents",
			"Extra Unlisted Volume Note",
		]);
		expect(longParsed[0]?.doi).toBe("10.18653/v1/2026.acl-long.1");
		expect(longParsed[0]?.pdfUrl).toBe(
			"https://aclanthology.org/2026.acl-long.1.pdf",
		);
		expect(longParsed[0]?.abstract).toBe(
			"OctoTools coordinates heterogeneous domain tools cleanly.",
		);

		const reconciled = await fetchAclAnthologyVenuePapers(
			acl,
			2026,
			async (url) => {
				if (url.includes("accepted_papers")) return aclWebHtml;
				if (url.includes("2026.acl-long")) return aclLongHtml;
				if (url.includes("2026.acl-short")) return aclShortHtml;
				return "";
			},
		);
		expect(reconciled.items.map((p) => p.doi)).toEqual([
			"10.18653/v1/2026.acl-long.1",
			"10.18653/v1/2026.acl-short.3",
		]);
		expect(reconciled.items[1]?.abstract).toBe(
			"Minimal short-paper discourse parser.",
		);

		// Fallback to papers.cool when Anthology volumes are not out yet (HTTP 404)
		const aclCoolHtml = `
			<p class="info">Total 105 papers</p>
			${Array.from(
				{ length: 105 },
				(_, idx) => `
				<div id="acl${idx}@ACL" class="panel paper">
					<h2 class="title"><a href="https://aclanthology.org/2026.acl-long.${idx + 1}"></a><a id="title-acl${idx}">ACL Cool Fallback ${idx}</a></h2>
					<p class="metainfo authors"><a class="author">Author ${idx}</a></p>
					<p class="metainfo subjects"><a href="/venue/ACL.2026?group=Long+Papers">ACL.2026 - Long Papers</a></p>
					<p id="summary-acl${idx}" class="summary">ACL abstract ${idx}.</p>
				</div>`,
			).join("\n")}`;
		const aclFallbackBundle = await fetchMultiChannelVenuePapers(
			acl,
			2026,
			async <T>() => ({ results: [] }) as T,
			async (url) => {
				if (url.includes("aclanthology.org/volumes")) {
					throw new Error("HTTP 404");
				}
				if (url.includes("papers.cool/venue/ACL.2026")) {
					return aclCoolHtml;
				}
				return "";
			},
		);
		expect(aclFallbackBundle.items).toHaveLength(105);
	});

	it("parses S&P 2026, USENIX technical-sessions + presentation subpages, NDSS required intersection, CCS required schedule, and ISSTA/ECOOP Researchr tracks", async () => {
		const sp = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "sp-2026");
		const usenix = DEFAULT_COLLECTION_VENUES.find(
			(v) => v.id === "usenix-sec-2026",
		);
		const ndss = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ndss-2026");
		const ccs = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ccs-2026");
		const issta = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "issta-2026");
		const ecoop = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ecoop-2026");
		if (!sp || !usenix || !ndss || !ccs || !issta || !ecoop) {
			throw new Error("Missing security/SE venues");
		}

		// 1. IEEE S&P 2026 accepted-papers.html (`<sup>` & `<br />` affiliation stripping) + fallback
		const spHtml = `
			<div class="list-group-item">
				<b><a href="#sp1" data-toggle="collapse">Zero-Knowledge Proofs at Line Rate<span class="glyphicon glyphicon-chevron-down"></span></a></b>
				<div id="sp1" class="collapse authorlist">
					Alice Chen<sup>1,2</sup>, Bob Kim<sup>2</sup> and Carol Wu<sup>1</sup>
					<br /><sup>1</sup>ETH Zurich; <sup>2</sup>EPFL
				</div>
			</div>`;
		const spParsed = parseOfficialVenueProgramHtml(
			spHtml,
			"https://sp2026.ieee-security.org/accepted-papers.html",
			sp,
			VENUE_SPEC_BY_ID.get("sp-2026"),
			2026,
		);
		expect(spParsed).toHaveLength(1);
		expect(spParsed[0]?.title).toBe("Zero-Knowledge Proofs at Line Rate");
		expect(spParsed[0]?.authors).toEqual(["Alice Chen", "Bob Kim", "Carol Wu"]);

		// 2. USENIX Security 2026 technical-sessions + papers.cool backfill + polite presentation subpages
		const usenixTechSessionsHtml = `
			<article id="node-1" class="node node-paper view-mode-schedule">
				<h2><a href="/conference/usenixsecurity26/presentation/kernel-guard">Kernel Guard via Hardware Faults</a></h2>
				<div class="field field-name-field-paper-people-text">Alice Tan and Bob Ng, <em>MIT; ETH Zurich</em></div>
				<div class="field field-name-field-paper-description-long"><p>Inline USENIX abstract on hardware isolation.</p></div>
			</article>
			<article id="node-2" class="node node-paper view-mode-schedule">
				<h2><a href="/conference/usenixsecurity26/presentation/tls-verify">TLS Transcript Verification</a></h2>
				<div class="field field-name-field-paper-people-text">Carol Li (Stanford), Dave Park (CMU)</div>
			</article>
			<article id="node-3" class="node node-paper view-mode-schedule">
				<h2><a href="/conference/usenixsecurity26/presentation/missing-page">Side-Channel Leakage in Enclaves</a></h2>
				<div class="field field-name-field-paper-people-text">Eve Fox, <em>University of Toronto</em></div>
			</article>`;
		const usenixTechParsed = parseOfficialVenueProgramHtml(
			usenixTechSessionsHtml,
			"https://www.usenix.org/conference/usenixsecurity26/technical-sessions",
			usenix,
			VENUE_SPEC_BY_ID.get("usenix-sec-2026"),
			2026,
		);
		expect(usenixTechParsed).toHaveLength(3);
		expect(usenixTechParsed[0]?.authors).toEqual(["Alice Tan", "Bob Ng"]);
		expect(usenixTechParsed[1]?.authors).toEqual(["Carol Li", "Dave Park"]);
		expect(usenixTechParsed[2]?.authors).toEqual(["Eve Fox"]);

		const usenixPresParsed = parseUsenixPresentationHtml(
			`<div class="field field-name-field-paper-description"><p>Abstract: Verified TLS state machine with bounded proof.</p></div>
			 <div class="field field-name-field-final-paper-pdf"><a href="/system/files/usenixsecurity26-carol.pdf">PDF</a></div>`,
			"https://www.usenix.org/conference/usenixsecurity26/presentation/tls-verify",
		);
		expect(usenixPresParsed.abstract).toBe(
			"Verified TLS state machine with bounded proof.",
		);
		expect(usenixPresParsed.pdfUrl).toBe(
			"https://www.usenix.org/system/files/usenixsecurity26-carol.pdf",
		);

		let coolHydrateCount = 0;
		const usenixBundle = await fetchMultiChannelVenuePapers(
			usenix,
			2026,
			async <T>() => ({ results: [] }) as T,
			async (url) => {
				if (url.includes("usenixsecurity26/technical-sessions")) {
					return usenixTechSessionsHtml;
				}
				if (url.includes("papers.cool/venue/USENIX-Sec.2026")) {
					coolHydrateCount += 1;
					return `<div id="u1@USENIX" class="panel paper">
						<h2 class="title"><a href="https://www.usenix.org/conference/usenixsecurity26/presentation/kernel-guard"></a><a id="title-u1">Kernel Guard via Hardware Faults</a><a id="pdf-u1" data="https://www.usenix.org/system/files/u1.pdf||">PDF</a></h2>
						<p class="metainfo authors"><a class="author">Alice Tan</a></p>
						<p class="metainfo subjects"><a href="/venue/USENIX-Sec.2026">USENIX-Sec.2026</a></p>
						<p id="summary-u1" class="summary">Inline USENIX abstract on hardware isolation.</p>
					</div>`;
				}
				if (url.includes("presentation/tls-verify")) {
					return `<div class="field field-name-field-paper-description"><p>Verified TLS state machine with bounded proof.</p></div>
						<div class="field field-name-field-final-paper-pdf"><a href="/system/files/usenixsecurity26-carol.pdf">PDF</a></div>`;
				}
				if (url.includes("presentation/missing-page")) {
					throw new Error("HTTP 404 Not Found");
				}
				return "";
			},
		);
		expect(coolHydrateCount).toBe(1);
		expect(usenixBundle.items).toHaveLength(3);
		expect(usenixBundle.items[0]?.pdfUrl).toBe(
			"https://www.usenix.org/system/files/u1.pdf",
		);
		expect(usenixBundle.items[1]?.abstract).toBe(
			"Verified TLS state machine with bounded proof.",
		);
		expect(usenixBundle.items[2]?.title).toBe(
			"Side-Channel Leakage in Enclaves",
		);

		// 3. NDSS 2026 accepted-papers/ + required OpenAlex S4306420590 & papers.cool intersection
		const ndssHtml = `
			<div class="pt-cv-content-item">
				<h2 class="pt-cv-title"><a href="https://www.ndss-symposium.org/ndss-paper/bgp-route-attestation/">BGP Route Attestation at Scale</a></h2>
				<div class="pt-cv-custom-fields pt-cv-ctf-display_authors">
					<div class="pt-cv-ctf-value"><p>Frank Gao (Tsinghua University), Grace Lin (UC San Diego)</p></div>
				</div>
			</div>`;
		const ndssBundle = await fetchMultiChannelVenuePapers(
			ndss,
			2026,
			async <T>(url: string) => {
				if (url.includes("S4306420590")) {
					return {
						meta: { count: 2 },
						results: [
							{
								id: "https://openalex.org/W_ndss_1",
								type: "article",
								title: "BGP Route Attestation at Scale",
								doi: "https://doi.org/10.14722/ndss.2026.23001",
								publication_year: 2026,
								cited_by_count: 3,
								referenced_works: [
									"https://openalex.org/W11",
									"https://openalex.org/W22",
								],
								authorships: [
									{ author: { display_name: "Frank Gao" } },
									{ author: { display_name: "Grace Lin" } },
								],
							},
							{
								id: "https://openalex.org/W_ndss_workshop",
								type: "article",
								title: "Non-Roster NDSS Workshop Paper",
								doi: "https://doi.org/10.14722/ndss.2026.99999",
								publication_year: 2026,
								authorships: [{ author: { display_name: "Other Author" } }],
							},
						],
					} as T;
				}
				return { results: [] } as T;
			},
			async (url) => {
				if (url.includes("ndss2026/accepted-papers")) return ndssHtml;
				if (url.includes("papers.cool/venue/NDSS.2026")) {
					return `<div id="n1@NDSS" class="panel paper">
						<h2 class="title"><a href="https://www.ndss-symposium.org/wp-content/uploads/2026-23001.pdf"></a><a id="title-n1">BGP Route Attestation at Scale</a></h2>
						<p class="metainfo authors"><a class="author">Frank Gao</a></p>
						<p class="metainfo subjects"><a href="/venue/NDSS.2026">NDSS.2026</a></p>
						<p id="summary-n1" class="summary">Formal RPKI route validation architecture.</p>
					</div>`;
				}
				return "";
			},
		);
		expect(ndssBundle.items).toHaveLength(1);
		expect(ndssBundle.items[0]?.doi).toBe("10.14722/ndss.2026.23001");
		expect(ndssBundle.items[0]?.abstract).toBe(
			"Formal RPKI route validation architecture.",
		);
		expect(ndssBundle.items[0]?.rawRefs).toEqual(["oa:W11", "oa:W22"]);

		// 4. CCS 2026 required mode drops workshop + POSTER:/DEMO: schedule entries
		const ccsScheduleHtml = `
			<ul>
				<li class="schedule-paper">
					<p class="schedule-paper-title"><a href="https://dl.acm.org/doi/10.1145/3700001">Post-Quantum Lattice Signatures</a></p>
					<p class="schedule-authors">Hannah Abbott (MIT), Ian Bell (ETH Zurich)</p>
				</li>
				<li class="schedule-paper">
					<p class="schedule-paper-title">POSTER: Unverified Hardware Fuzzing Poster</p>
					<p class="schedule-authors">Poster Author</p>
				</li>
				<li class="schedule-paper">
					<p class="schedule-paper-title">DEMO: Interactive Cryptanalysis Tool</p>
					<p class="schedule-authors">Demo Author</p>
				</li>
				<li class="schedule-paper">
					<p class="schedule-paper-title">WORKSHOP: Hardware Troubles Companion</p>
					<p class="schedule-authors">Workshop Author</p>
				</li>
			</ul>`;
		const ccsBundle = await fetchMultiChannelVenuePapers(
			ccs,
			2026,
			async <T>(url: string) => {
				if (url.includes("api.openalex.org/works")) {
					return {
						results: [
							{
								id: "https://openalex.org/W_ccs_ws",
								type: "article",
								title: "Non-Roster CCS Workshop Proceeding",
								doi: "https://doi.org/10.1145/3700002",
								publication_year: 2026,
								authorships: [{ author: { display_name: "Extra Author" } }],
							},
						],
					} as T;
				}
				return { results: [] } as T;
			},
			async (url) =>
				url.includes("CCS2026/program/schedule.html") ? ccsScheduleHtml : "",
		);
		expect(ccsBundle.items.map((p) => p.title)).toEqual([
			"Post-Quantum Lattice Signatures",
		]);

		// 5. ISSTA & ECOOP Researchr #event-overview with nested badge spans
		const ecoopHtml = `
			<div id="event-overview">
				<table>
					<tr>
						<td>14:00</td>
						<td>
							<a class="publication-link" href="/details/ecoop-2026-technical-papers/7">Gradual Ownership Types in Practice<span class="pull-right"><span class="output-badge"><span class="label-primary label">Distinguished paper award</span></span></span></a>
							<div class="performers"><a href="/profile/a">Martin Odersky</a></div>
						</td>
					</tr>
				</table>
			</div>`;
		const ecoopParsed = parseResearchrHtml(
			ecoopHtml,
			ecoop,
			"https://2026.ecoop.org/track/ecoop-2026-technical-papers",
		);
		expect(ecoopParsed.map((p) => p.title)).toEqual([
			"Gradual Ownership Types in Practice",
		]);
		const isstaParsed = parseResearchrHtml(
			`<div id="event-overview"><table><tr><td>09:00</td><td>
				<a class="publication-link" href="/details/issta-2026-research-papers/1">Symbolic Concolic Execution for WebAssembly</a>
				<div class="performers"><a href="/profile/s">Sonia Lee</a></div>
			</td></tr></table></div>`,
			issta,
			"https://conf.researchr.org/track/issta-2026/issta-2026-research-papers",
		);
		expect(isstaParsed.map((p) => p.title)).toEqual([
			"Symbolic Concolic Execution for WebAssembly",
		]);

		// 6. S&P 2026 uses accepted-papers.html fallback when proceedings DOIs are not indexed yet
		const spFallbackBundle = await fetchMultiChannelVenuePapers(
			sp,
			2026,
			async <T>() => ({ results: [], data: [] }) as T,
			async (url) =>
				url.includes("sp2026.ieee-security.org/accepted-papers.html")
					? spHtml
					: "",
		);
		expect(spFallbackBundle.items.map((p) => p.title)).toEqual([
			"Zero-Knowledge Proofs at Line Rate",
		]);
		expect(spFallbackBundle.authoritativeMainTrack).toBe(true);
	});

	it("enforces serialized host gate exclusivity and prevents re-entrant double-wrap self-deadlock for JSON and text fetchers", async () => {
		const flushMicrotasks = async () => {
			for (let i = 0; i < 6; i++) {
				await Promise.resolve();
			}
		};

		// 1. Prove SERIALIZED_HOSTS genuinely serializes concurrent requests (not a test-env no-op)
		let inFlight = 0;
		let maxInFlight = 0;
		const startedUrls: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const politeJson = createPoliteFetchJson(async <T>(url: string) => {
			startedUrls.push(url);
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				if (url.endsWith("/1")) {
					await firstGate;
				}
				return { url } as T;
			} finally {
				inFlight -= 1;
			}
		});

		const req1 = politeJson<{ url: string }>(
			"https://api.crossref.org/works/1",
		);
		const req2 = politeJson<{ url: string }>(
			"https://api.crossref.org/works/2",
		);
		await flushMicrotasks();

		expect(startedUrls).toEqual(["https://api.crossref.org/works/1"]);
		expect(maxInFlight).toBe(1);

		releaseFirst();
		const [res1, res2] = await Promise.all([req1, req2]);
		expect(res1.url).toBe("https://api.crossref.org/works/1");
		expect(res2.url).toBe("https://api.crossref.org/works/2");
		expect(startedUrls).toEqual([
			"https://api.crossref.org/works/1",
			"https://api.crossref.org/works/2",
		]);
		expect(maxInFlight).toBe(1);

		// 2. Direct double-wrapping is idempotent and never self-deadlocks
		let rawJsonCalls = 0;
		const basePoliteJson = createPoliteFetchJson(async <T>(url: string) => {
			rawJsonCalls += 1;
			return { ok: url } as T;
		});
		const doublePoliteJson = createPoliteFetchJson(basePoliteJson);
		expect(doublePoliteJson).toBe(basePoliteJson);
		await expect(
			doublePoliteJson<{ ok: string }>("https://api.crossref.org/works/direct"),
		).resolves.toEqual({ ok: "https://api.crossref.org/works/direct" });
		expect(rawJsonCalls).toBe(1);

		let rawTextCalls = 0;
		const basePoliteText = createPoliteFetchText(async (url: string) => {
			rawTextCalls += 1;
			return `html:${url}`;
		});
		const doublePoliteText = createPoliteFetchText(basePoliteText);
		expect(doublePoliteText).toBe(basePoliteText);
		await expect(
			doublePoliteText("https://papers.cool/venue/ICLR.2026"),
		).resolves.toBe("html:https://papers.cool/venue/ICLR.2026");
		expect(rawTextCalls).toBe(1);

		// 3. Indirect double-wrapping through opaque closures (e.g. wrapFetch*WithAbort + tracking) never self-deadlocks
		const ctrl = new AbortController();
		const indirectJson = createPoliteFetchJson(
			async <T>(url: string) =>
				await wrapFetchJsonWithAbort(basePoliteJson, ctrl.signal)<T>(url),
			ctrl.signal,
		);
		await expect(
			indirectJson<{ ok: string }>(
				"https://api.semanticscholar.org/graph/v1/paper/search/bulk",
			),
		).resolves.toEqual({
			ok: "https://api.semanticscholar.org/graph/v1/paper/search/bulk",
		});

		const indirectText = createPoliteFetchText(
			async (url: string, accept?: string) =>
				await wrapFetchTextWithAbort(basePoliteText, ctrl.signal)(url, accept),
			ctrl.signal,
		);
		await expect(
			indirectText("https://conf.researchr.org/home/ase-2026"),
		).resolves.toBe("html:https://conf.researchr.org/home/ase-2026");
	});

	it("composes AbortSignals across re-wrapped polite fetchers, preserves FIFO serialization on queued abort, and propagates signal in fetchMultiChannelVenuePapers", async () => {
		const flushMicrotasks = async () => {
			for (let i = 0; i < 6; i++) {
				await Promise.resolve();
			}
		};

		// Part A: stricter inner signal aborts a queued waiter while keeping later waiters behind the blocker
		let releaseBlocker!: () => void;
		const blockerGate = new Promise<void>((resolve) => {
			releaseBlocker = resolve;
		});
		const executedUrls: string[] = [];

		const blockerFetch = createPoliteFetchJson(async <T>(url: string) => {
			executedUrls.push(url);
			await blockerGate;
			return { url } as T;
		});

		const outerCtrl = new AbortController();
		const innerCtrl = new AbortController();
		const innerRawCalls: string[] = [];
		const outerPolite = createPoliteFetchJson(async <T>(url: string) => {
			innerRawCalls.push(url);
			return { url } as T;
		}, outerCtrl.signal);
		const reWrappedStricter = createPoliteFetchJson(
			outerPolite,
			innerCtrl.signal,
		);

		const waiter3Fetch = createPoliteFetchJson(async <T>(url: string) => {
			executedUrls.push(url);
			return { url } as T;
		});

		const blockerPromise = blockerFetch("https://api.crossref.org/works/hold");
		try {
			await flushMicrotasks();
			expect(executedUrls).toEqual(["https://api.crossref.org/works/hold"]);

			const queuedAborted = reWrappedStricter(
				"https://api.crossref.org/works/aborted",
			);
			const waiter3Promise = waiter3Fetch(
				"https://api.crossref.org/works/waiter3",
			);
			await flushMicrotasks();

			innerCtrl.abort();
			await expect(queuedAborted).rejects.toBeInstanceOf(
				BackgroundTaskCancelledError,
			);
			expect(innerRawCalls).toEqual([]);

			// Waiter 3 must remain queued behind the still-running blocker
			await flushMicrotasks();
			expect(executedUrls).toEqual(["https://api.crossref.org/works/hold"]);

			releaseBlocker();
			await Promise.all([blockerPromise, waiter3Promise]);
			expect(executedUrls).toEqual([
				"https://api.crossref.org/works/hold",
				"https://api.crossref.org/works/waiter3",
			]);
			expect(innerRawCalls).toEqual([]);
		} finally {
			releaseBlocker();
			await blockerPromise.catch(() => undefined);
		}

		// Part B: outer signal still aborts an in-flight call on a re-wrapped polite fetcher and releases the host gate
		const outerCtrl2 = new AbortController();
		const innerCtrl2 = new AbortController();
		const hangingOuter = createPoliteFetchJson(
			async <T>(_url: string) => await new Promise<T>(() => {}),
			outerCtrl2.signal,
		);
		const reWrappedWithInner = createPoliteFetchJson(
			hangingOuter,
			innerCtrl2.signal,
		);
		const inFlightPromise = reWrappedWithInner(
			"https://api.crossref.org/works/hang",
		);
		await flushMicrotasks();
		outerCtrl2.abort();
		await expect(inFlightPromise).rejects.toBeInstanceOf(
			BackgroundTaskCancelledError,
		);

		// Gate must be unlocked after the aborted in-flight call
		const afterAbort = createPoliteFetchJson(async <T>(url: string) => {
			return { ok: url } as T;
		});
		await expect(
			afterAbort<{ ok: string }>("https://api.crossref.org/works/after-abort"),
		).resolves.toEqual({ ok: "https://api.crossref.org/works/after-abort" });

		// Part C: fetchMultiChannelVenuePapers propagates options.signal into its polite host-gate wait
		const ase = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ase-2026");
		if (!ase) throw new Error("Missing ase-2026");

		let releaseResearchr!: () => void;
		const researchrGate = new Promise<void>((resolve) => {
			releaseResearchr = resolve;
		});
		const researchrBlocker = createPoliteFetchText(async (url: string) => {
			await researchrGate;
			return url;
		});
		const researchrBlockerPromise = researchrBlocker(
			"https://conf.researchr.org/home/blocker",
		);

		const venueCtrl = new AbortController();
		let venueRawTextCalls = 0;
		try {
			await flushMicrotasks();
			const venuePromise = fetchMultiChannelVenuePapers(
				ase,
				2026,
				async <T>() => ({ results: [] }) as T,
				async () => {
					venueRawTextCalls += 1;
					return "";
				},
				{ signal: venueCtrl.signal },
			);
			await flushMicrotasks();

			// Abort while fetchOfficialTrackRoster is queued on conf.researchr.org
			venueCtrl.abort();
			await expect(venuePromise).rejects.toBeInstanceOf(
				BackgroundTaskCancelledError,
			);
			expect(venueRawTextCalls).toBe(0);
		} finally {
			releaseResearchr();
			await researchrBlockerPromise.catch(() => undefined);
		}
	});

	it("refreshes TOSEM 2026 via ensureVenueLoaded without custom fetchJson without self-deadlocking on api.crossref.org", async () => {
		const tosem = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "tosem-2026");
		if (!tosem) throw new Error("Missing tosem-2026");

		resetCollectionMemoryForTests();
		setCachedKeywordLlmConfigForTests(null);
		setCachedOpenAlexApiKeyForTests(null);
		installMockCollectionIpc({
			initialState: {
				categories: ["cs.SE"],
				venues: [tosem],
			},
		});
		await ensureCollectionSummaryHydrated();

		let crossrefCalls = 0;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			if (url.includes("api.openalex.org/works")) {
				return new Response(
					JSON.stringify({
						meta: { count: 0 },
						results: [],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			if (url.includes("api.crossref.org/works")) {
				crossrefCalls += 1;
				return new Response(
					JSON.stringify({
						message: {
							"total-results": 1,
							"next-cursor": null,
							items: [
								{
									DOI: "10.1145/3799001",
									type: "journal-article",
									ISSN: ["1049-331X"],
									title: [
										"Automated Program Repair Verification for Industrial Systems",
									],
									author: [
										{ given: "Ada", family: "Lovelace" },
										{ given: "Grace", family: "Hopper" },
									],
									abstract:
										"<jats:p>A rigorous empirical evaluation of automated program repair verification on industrial software repositories.</jats:p>",
									subject: ["Software Engineering", "Program Repair"],
									"container-title": [
										"ACM Transactions on Software Engineering and Methodology",
									],
									published: { "date-parts": [[2026, 3, 15]] },
									"is-referenced-by-count": 4,
								},
							],
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(JSON.stringify({ results: [], data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		vi.stubGlobal("fetch", fetchMock);
		try {
			const ctrl = new AbortController();
			const summary = await ensureVenueLoaded("tosem-2026", {
				signal: ctrl.signal,
			});
			expect(crossrefCalls).toBeGreaterThanOrEqual(1);
			expect(summary.totalCount).toBe(1);
			const page = await listCollectionPapers({
				sourceType: "venue",
				venueId: "tosem-2026",
				timePreset: "all",
				limit: 10,
				offset: 0,
			});
			expect(page.items).toHaveLength(1);
			expect(page.items[0]?.doi).toBe("10.1145/3799001");
			expect(page.items[0]?.title).toBe(
				"Automated Program Repair Verification for Industrial Systems",
			);
		} finally {
			vi.unstubAllGlobals();
			setCachedKeywordLlmConfigForTests(undefined);
			setCachedOpenAlexApiKeyForTests(undefined);
			resetCollectionMemoryForTests();
		}
	});
});
