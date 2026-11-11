import { describe, expect, it, vi } from "vitest";
import { writeJsonStorage } from "@/lib/core/storage";
import {
	type CollectionPaperItem,
	CURRENT_VENUE_SYNC_VERSION,
	DEFAULT_ARXIV_CATEGORIES,
	DEFAULT_COLLECTION_VENUES,
	fetchVenueStructuredPapers,
	isConfirmedVenueAcceptance,
	isVenueAlreadyLoaded,
	loadCollectionState,
	mergeCollectionItems,
	parseAcceptedVenueArxivXml,
	refreshVenueCollection,
	resetCollectionMemoryForTests,
	saveCollectionState,
	syncArxivCategoriesIncremental,
	VENUE_SPEC_BY_ID,
} from "@/lib/plaza/collection";

describe("Plaza Paper Collection incremental arXiv & full multi-channel Venue sync", () => {
	it("paginates OpenAlex cursor pages beyond 200 items in fetchVenueStructuredPapers", async () => {
		const venue = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "icse-2026");
		if (!venue) throw new Error("Missing icse-2026");

		const makeWork = (idx: number) => ({
			id: `https://openalex.org/W${idx}`,
			title: `Automated Software Engineering Study Part ${idx}`,
			publication_year: 2026,
			publication_date: "2026-04-02",
			doi: `https://doi.org/10.1145/3770000.${idx}`,
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
				landing_page_url: `https://doi.org/10.1145/3770000.${idx}`,
				source: {
					id: "https://openalex.org/S4210203175",
					display_name: "ICSE 2026",
				},
			},
		});

		const calls: string[] = [];
		const mockFetchJson = async <T = unknown>(url: string): Promise<T> => {
			calls.push(url);
			if (url.includes("cursor=*")) {
				return {
					meta: { count: 245, next_cursor: "page2_tok" },
					results: Array.from({ length: 200 }, (_, i) => makeWork(i + 1)),
				} as T;
			}
			return {
				meta: { count: 245, next_cursor: null },
				results: Array.from({ length: 45 }, (_, i) => makeWork(201 + i)),
			} as T;
		};

		const res = await fetchVenueStructuredPapers(venue, 2026, mockFetchJson);
		expect(calls).toHaveLength(2);
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
			},
		);
		expect(unchangedCalls).toHaveLength(1);
		expect(unchangedCalls[0]).toContain("max_results=1");
		expect(unchangedSync.deltaItems).toHaveLength(0);

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

	it("treats v2-synced Venues as immutable on open and skips them when skipLoaded is true", async () => {
		const ase = DEFAULT_COLLECTION_VENUES.find((v) => v.id === "ase-2026");
		if (!ase) throw new Error("Missing ase-2026");

		// Cold venue before v2 sync -> not yet loaded
		expect(isVenueAlreadyLoaded(ase, [])).toBe(false);
		// Legacy v1 venue -> still requires one-time v2 upgrade
		expect(
			isVenueAlreadyLoaded(
				{ ...ase, syncVersion: 1, lastFetchedAt: "2026-06-01T00:00:00Z" },
				[],
			),
		).toBe(false);

		// Once v2 synced, opening Paper Collection never re-checks or re-fetches it
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
	});
});
