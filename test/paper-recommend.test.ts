import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/lib/core/bindings";
import {
	applyFreshVenueItems,
	type CollectionPaperItem,
	DEFAULT_COLLECTION_VENUES,
	enrichDblpItemsBatch,
	getCollectionPaperDetail,
	getCollectionSummarySnapshot,
	listCollectionPapers,
	mergeCollectionItems,
	patchCollectionPapers,
	purgeLegacyCollectionBrowserStorage,
	resetCollectionMemoryForTests,
	upsertCollectionPapers,
} from "@/lib/plaza/collection";
import {
	addCustomRecentKeyword,
	createDefaultRecommendPoolState,
	DEFAULT_RECOMMEND_BATCH_SIZE,
	DEFAULT_RECOMMEND_KEYWORDS,
	DEFAULT_WORD_CLOUD_TOP_N,
	fetchCollectionWordCloud,
	fetchRecommendPoolState,
	getActiveSelectedTerms,
	getWordCloudKeywords,
	isKeywordSelected,
	MAX_WORD_CLOUD_TOP_N,
	MIN_WORD_CLOUD_TOP_N,
	recommendNextFromCollection,
	removeRecentKeyword,
	resetRecommendedHistory,
	saveRecommendPoolState,
	scorePaperAgainstKeywords,
	setWordCloudTopN,
	toggleRecentKeywordById,
	toggleRecommendTerm,
} from "@/lib/plaza/recommend-pool";
import { installMockCollectionIpc } from "./helpers/mock-collection-ipc";

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));

function createMockLocalStorage() {
	const store = new Map<string, string>();
	return {
		store,
		api: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, val: string) => {
				store.set(key, String(val));
			},
			removeItem: (key: string) => {
				store.delete(key);
			},
			clear: () => {
				store.clear();
			},
		},
	};
}

function makePaper(
	index: number,
	overrides: Partial<CollectionPaperItem> = {},
): CollectionPaperItem {
	const padded = String(index).padStart(5, "0");
	return {
		id: `arxiv:2604.${padded}`,
		arxivId: `2604.${padded}`,
		title: `Research Paper ${index} on Software Reliability`,
		authors: [`Author ${index}`],
		abstract: `We present empirical analysis ${index} for large-scale software engineering systems with reproducible evaluation.`,
		publishedAt: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T10:00:00Z`,
		year: 2026,
		sourceType: "arxiv",
		sourceLabel: "cs.SE",
		categories: ["cs.SE"],
		url: `https://arxiv.org/abs/2604.${padded}`,
		citationCount: index % 15,
		keywords: ["Software Testing"],
		...overrides,
	};
}

describe("Paper Recommend overhaul (SQLite IPC, word cloud, selection & browser storage purge)", () => {
	let mockStorage: ReturnType<typeof createMockLocalStorage>;
	let ipc: ReturnType<typeof installMockCollectionIpc>;

	beforeEach(() => {
		mockStorage = createMockLocalStorage();
		vi.stubGlobal("localStorage", mockStorage.api);
		resetCollectionMemoryForTests();
		ipc = installMockCollectionIpc();
	});

	afterEach(() => {
		ipc.restore();
		vi.unstubAllGlobals();
		resetCollectionMemoryForTests();
	});

	it("allows deselecting ALL keywords including LLM Agent down to 0 active terms and persists across reloads", async () => {
		let state = await fetchRecommendPoolState();
		expect(isKeywordSelected(state, "LLM Agent")).toBe(true);
		expect(getActiveSelectedTerms(state).length).toBeGreaterThan(0);

		// Deselect every enabled chip including LLM Agent
		for (const chip of state.keywords) {
			if (chip.enabled) {
				state = toggleRecentKeywordById(state, chip.id);
			}
		}
		expect(getActiveSelectedTerms(state)).toEqual([]);
		expect(isKeywordSelected(state, "LLM Agent")).toBe(false);

		await saveRecommendPoolState(state);

		const reloaded = await fetchRecommendPoolState();
		expect(getActiveSelectedTerms(reloaded)).toEqual([]);
		expect(isKeywordSelected(reloaded, "LLM Agent")).toBe(false);

		// Toggling via toggleRecommendTerm also works symmetrically from 0 -> 1 -> 0
		const withLlm = toggleRecommendTerm(reloaded, "LLM Agent");
		expect(getActiveSelectedTerms(withLlm)).toEqual(["LLM Agent"]);
		const backToZero = toggleRecommendTerm(withLlm, "llm agent");
		expect(getActiveSelectedTerms(backToZero)).toEqual([]);

		// Calling recommendNextFromCollection with 0 selected returns empty batch cleanly
		ipc.seed({
			categories: ["cs.SE"],
			venues: [...DEFAULT_COLLECTION_VENUES],
			items: [
				makePaper(1, {
					title: "Autonomous LLM Agent for Program Repair",
					keywords: ["LLM Agent"],
				}),
			],
			lastRefreshedAt: "2026-04-10T00:00:00Z",
			latestArxiv: null,
		});
		await saveRecommendPoolState(backToZero);

		const emptyRes = await recommendNextFromCollection();
		expect(emptyRes.selectedKeywords).toEqual([]);
		expect(emptyRes.items).toEqual([]);
	});

	it("supports custom recent keyword add/remove down to 0 chips and merges word-cloud selections on recommend", async () => {
		let state = await fetchRecommendPoolState();

		// Remove ALL recent keyword chips down to 0
		for (const chip of [...state.keywords]) {
			state = removeRecentKeyword(state, chip.id);
		}
		expect(state.keywords).toEqual([]);
		await saveRecommendPoolState(state);

		state = await fetchRecommendPoolState();
		expect(state.keywords).toEqual([]);

		// Add custom keywords (deduplicating case-insensitively and upgrading display casing)
		state = addCustomRecentKeyword(state, "  concolic   testing ");
		state = addCustomRecentKeyword(state, "Concolic Testing");
		expect(state.keywords).toHaveLength(1);
		expect(state.keywords[0]?.term).toBe("Concolic Testing");
		expect(state.keywords[0]?.enabled).toBe(true);

		// Select an additional term from the All Keywords word cloud
		state = toggleRecommendTerm(state, "eBPF Verification");
		expect(state.selectedCloudTerms).toEqual(["eBPF Verification"]);
		expect(getActiveSelectedTerms(state)).toEqual([
			"Concolic Testing",
			"eBPF Verification",
		]);

		ipc.seed({
			categories: ["cs.SE"],
			venues: [...DEFAULT_COLLECTION_VENUES],
			items: [
				makePaper(1, {
					title: "Path Exploration for Kernel Verifiers",
					abstract: "Short non-matching abstract text that relies on keywords.",
					keywords: ["eBPF Verification"],
				}),
			],
			lastRefreshedAt: "2026-04-10T00:00:00Z",
			latestArxiv: null,
		});
		await saveRecommendPoolState(state);

		const revBefore = getCollectionSummarySnapshot().revision;
		const rec = await recommendNextFromCollection();
		expect(rec.items).toHaveLength(1);
		expect(rec.items[0]?.matchedKeywords).toContain("eBPF Verification");
		expect(getCollectionSummarySnapshot().revision).toBeGreaterThan(revBefore);

		// Cloud selection merged into Recent Keywords and `selectedCloudTerms` cleared
		expect(rec.state.selectedCloudTerms).toEqual([]);
		expect(rec.state.keywords.map((k) => k.term)).toEqual([
			"Concolic Testing",
			"eBPF Verification",
		]);
		expect(rec.state.keywords.every((k) => k.enabled)).toBe(true);
	});

	it("aggregates word cloud across all papers with best display casing, Top-50 default, and slider Top-N clamping/slicing", async () => {
		// Create 70 unique keywords with varying frequencies + casing variants for "LLM Agent"
		const papers: CollectionPaperItem[] = [
			makePaper(1, { keywords: ["llm agent", "program analysis"] }),
			makePaper(2, { keywords: ["LLM Agent", "Program Analysis"] }),
			makePaper(3, {
				keywords: ["LLM agent", "Fuzzing"],
				recommendedAt: "2026-04-05T00:00:00Z",
			}),
		];

		for (let k = 1; k <= 68; k++) {
			papers.push(
				makePaper(100 + k, {
					keywords: [`Topic Keyword ${String(k).padStart(2, "0")}`],
				}),
			);
		}

		// Default call returns Top 50 (`DEFAULT_WORD_CLOUD_TOP_N`)
		const defaultCloud = getWordCloudKeywords(papers);
		expect(defaultCloud.keywords).toHaveLength(DEFAULT_WORD_CLOUD_TOP_N);
		expect(defaultCloud.totalUniqueKeywords).toBe(71);

		const topEntry = defaultCloud.keywords[0];
		expect(topEntry).toEqual({
			term: "LLM Agent",
			normalized: "llm agent",
			count: 3,
			unrecommendedCount: 2,
		});
		expect(defaultCloud.keywords[1]).toEqual({
			term: "Program Analysis",
			normalized: "program analysis",
			count: 2,
			unrecommendedCount: 2,
		});

		// Slider Top-N state clamping (15..150) & O(1) slicing + remote IPC wrapper
		ipc.seed({ items: papers });
		let state = createDefaultRecommendPoolState();
		state = setWordCloudTopN(state, 5);
		expect(state.wordCloudTopN).toBe(MIN_WORD_CLOUD_TOP_N);
		const remoteMin = await fetchCollectionWordCloud(5);
		expect(commands.plazaCollectionWordCloud).toHaveBeenCalledWith({
			topN: MIN_WORD_CLOUD_TOP_N,
		});
		expect(remoteMin.keywords).toHaveLength(MIN_WORD_CLOUD_TOP_N);
		expect(remoteMin.totalCandidatePapers).toBe(papers.length);
		expect(remoteMin.unrecommendedPaperCount).toBe(papers.length - 1);

		state = setWordCloudTopN(state, 500);
		expect(state.wordCloudTopN).toBe(MAX_WORD_CLOUD_TOP_N);
		const remoteMax = await fetchCollectionWordCloud(500);
		expect(commands.plazaCollectionWordCloud).toHaveBeenLastCalledWith({
			topN: MAX_WORD_CLOUD_TOP_N,
		});
		expect(remoteMax.keywords).toHaveLength(71);
	});

	it("pushes 15-paper batches, omits bibtex on list summaries, resets history via resetRecommendedHistory, and preserves recommendedAt across merges/refreshes", async () => {
		const pool: CollectionPaperItem[] = [];
		for (let i = 1; i <= 35; i++) {
			pool.push(
				makePaper(i, {
					sourceType: i <= 20 ? "venue" : "arxiv",
					venueId: i <= 20 ? "icse-2026" : undefined,
					sourceLabel: i <= 20 ? "ICSE 2026" : "cs.SE",
					doi: i <= 20 ? `10.1145/3744916.${1000 + i}` : undefined,
					id:
						i <= 20
							? `venue:icse-2026:doi:10.1145/3744916.${1000 + i}`
							: `arxiv:2604.${String(i).padStart(5, "0")}`,
					title: `Directed Fuzzing Paper ${i}`,
					keywords: ["Directed Fuzzing"],
					bibtex: `@inproceedings{paper${i}, title={Directed Fuzzing Paper ${i}}}`,
				}),
			);
		}

		ipc.seed({
			categories: ["cs.SE"],
			venues: [...DEFAULT_COLLECTION_VENUES],
			items: pool,
			lastRefreshedAt: "2026-04-12T00:00:00Z",
			latestArxiv: null,
		});

		// Paginated list summaries strip heavy `bibtex` payloads while detail dialog retrieves `bibtex`
		const listedPage = await listCollectionPapers({ limit: 5, offset: 0 });
		expect(listedPage.items).toHaveLength(5);
		expect(listedPage.items[0]?.bibtex).toBeUndefined();
		const detailFirst = await getCollectionPaperDetail(pool[0]?.id ?? "");
		expect(detailFirst?.bibtex).toContain("@inproceedings{paper1");
		expect(detailFirst?.citationText).toContain("Directed Fuzzing Paper 1");

		await saveRecommendPoolState({
			keywords: [{ id: "kw-df", term: "Directed Fuzzing", enabled: true }],
			selectedCloudTerms: [],
			wordCloudTopN: DEFAULT_WORD_CLOUD_TOP_N,
			lastRecommendedAt: null,
		});

		// Batch 1 -> default 15 papers
		const batch1 = await recommendNextFromCollection();
		expect(DEFAULT_RECOMMEND_BATCH_SIZE).toBe(15);
		expect(batch1.items).toHaveLength(15);
		const batch1Ids = new Set(batch1.items.map((p) => p.id));
		for (const item of batch1.items) {
			expect(item.recommendedAt).toBeTruthy();
		}

		// Batch 2 -> next 15 unseen papers (disjoint from Batch 1)
		const batch2 = await recommendNextFromCollection();
		expect(batch2.items).toHaveLength(15);
		for (const item of batch2.items) {
			expect(batch1Ids.has(item.id)).toBe(false);
			expect(item.recommendedAt).toBeTruthy();
		}

		// Batch 3 -> remaining 5 unseen papers
		const batch3 = await recommendNextFromCollection();
		expect(batch3.items).toHaveLength(5);
		expect(batch3.exhausted).toBe(true);

		// Batch 4 -> 0 unseen papers left
		const batch4 = await recommendNextFromCollection();
		expect(batch4.items).toHaveLength(0);
		expect(batch4.exhausted).toBe(true);

		// Word cloud reflects `unrecommendedCount === 0` after all 35 are recommended
		const afterCloud = await fetchCollectionWordCloud();
		const dfEntry = afterCloud.keywords.find(
			(k) => k.normalized === "directed fuzzing",
		);
		expect(dfEntry?.count).toBe(35);
		expect(dfEntry?.unrecommendedCount).toBe(0);

		// Refreshing / merging / enriching venue papers MUST preserve `recommendedAt`
		const freshFromUpstream = pool.slice(0, 20).map((p) => ({
			...p,
			abstract: `${p.abstract} Updated upstream proceedings abstract.`,
			recommendedAt: undefined,
		}));
		const afterVenueRefresh = applyFreshVenueItems(
			ipc.getItems(),
			"icse-2026",
			freshFromUpstream,
			"ICSE 2026",
		);
		expect(afterVenueRefresh.every((p) => Boolean(p.recommendedAt))).toBe(true);

		const merged = mergeCollectionItems([freshFromUpstream, afterVenueRefresh]);
		expect(merged.every((p) => Boolean(p.recommendedAt))).toBe(true);

		const icseVenue = DEFAULT_COLLECTION_VENUES.find(
			(v) => v.id === "icse-2026",
		);
		if (!icseVenue) throw new Error("Missing icse-2026");
		const enriched = await enrichDblpItemsBatch(
			freshFromUpstream.slice(0, 2),
			icseVenue,
			async <T>() => ({ results: [] }) as T,
			afterVenueRefresh,
		);
		expect(enriched.every((p) => Boolean(p.recommendedAt))).toBe(true);

		await upsertCollectionPapers({
			items: freshFromUpstream,
			replaceVenueId: "icse-2026",
			replaceSourceLabel: "ICSE 2026",
		});
		expect(ipc.getItems().every((p) => Boolean(p.recommendedAt))).toBe(true);

		// `resetRecommendedHistory()` delegates to `plazaCollectionClear({ scope: "recommended" })`
		await resetRecommendedHistory();
		expect(commands.plazaCollectionClear).toHaveBeenCalledWith({
			scope: "recommended",
			venueId: null,
		});
		const resetCloud = await fetchCollectionWordCloud();
		expect(
			resetCloud.keywords.find((k) => k.normalized === "directed fuzzing")
				?.unrecommendedCount,
		).toBe(35);
	});

	it("purges legacy browser localStorage & IndexedDB keys once while preserving deep-sessions and ccf-deadlines, and patches papers via IPC", async () => {
		const deleteDatabase = vi.fn();
		vi.stubGlobal("indexedDB", { deleteDatabase });

		mockStorage.store.set("plaza:collection:state:v2", '{"items":[1]}');
		mockStorage.store.set("plaza:collection:state:v1", '{"items":[2]}');
		mockStorage.store.set("plaza:recommend:pool-state:v2", '{"keywords":[]}');
		mockStorage.store.set("plaza:recommend:pool-state:v1", '{"pushedIds":[]}');
		mockStorage.store.set("plaza:discover:deep-sessions:v1", '[{"id":"s1"}]');
		mockStorage.store.set("plaza:ccf-deadlines:v1", '{"items":["ICSE"]}');

		purgeLegacyCollectionBrowserStorage();

		expect(mockStorage.store.has("plaza:collection:state:v2")).toBe(false);
		expect(mockStorage.store.has("plaza:collection:state:v1")).toBe(false);
		expect(mockStorage.store.has("plaza:recommend:pool-state:v2")).toBe(false);
		expect(mockStorage.store.has("plaza:recommend:pool-state:v1")).toBe(false);
		expect(deleteDatabase).toHaveBeenCalledWith("agentero_plaza_collection_v2");

		// Unrelated Plaza keys must stay untouched
		expect(mockStorage.store.get("plaza:discover:deep-sessions:v1")).toBe(
			'[{"id":"s1"}]',
		);
		expect(mockStorage.store.get("plaza:ccf-deadlines:v1")).toBe(
			'{"items":["ICSE"]}',
		);

		// `patchCollectionPapers` updates SQLite records incrementally without overwriting non-null `recommendedAt`
		const papers = Array.from({ length: 20 }, (_, idx) =>
			makePaper(idx + 1, { keywords: ["Static Analysis"] }),
		);
		ipc.seed({ items: papers });

		const targetId = papers[5]?.id ?? "";
		const summaryAfterPatch = await patchCollectionPapers([
			{
				id: targetId,
				recommendedAt: "2026-04-12T08:00:00Z",
				citationCount: 42,
			},
		]);
		expect(summaryAfterPatch.totalCount).toBe(20);
		expect(ipc.getRawItem(targetId)?.recommendedAt).toBe(
			"2026-04-12T08:00:00Z",
		);

		// Subsequent metadata patch with `recommendedAt: null` must never clear existing `recommendedAt`
		await patchCollectionPapers([
			{
				id: targetId,
				keywords: ["Soundness"],
				recommendedAt: null,
			},
		]);
		expect(ipc.getRawItem(targetId)?.recommendedAt).toBe(
			"2026-04-12T08:00:00Z",
		);
		expect(ipc.getRawItem(targetId)?.keywords).toEqual([
			"Static Analysis",
			"Soundness",
		]);
	});

	it("computes word cloud + 15-paper recommendation over 3,000 synthetic papers cleanly", async () => {
		const keywordPool = Array.from(
			{ length: 180 },
			(_, i) => `Synthetic Topic ${i + 1}`,
		);
		keywordPool[0] = "LLM Agent";
		keywordPool[1] = "Program Analysis";
		keywordPool[2] = "Vulnerability Detection";
		keywordPool[3] = "Fuzzing";

		const corpus: CollectionPaperItem[] = new Array(3_000);
		for (let i = 0; i < 3_000; i++) {
			const kw1 = keywordPool[i % keywordPool.length] ?? "LLM Agent";
			const kw2 =
				keywordPool[(i * 7 + 3) % keywordPool.length] ?? "Program Analysis";
			const kw3 = keywordPool[(i * 13 + 11) % keywordPool.length] ?? "Fuzzing";
			corpus[i] = makePaper(i + 1, {
				title: `Scalable ${kw1} and ${kw2} for Modern Software Systems (${i})`,
				abstract: `We design and evaluate an automated ${kw1.toLowerCase()} pipeline combined with ${kw3.toLowerCase()} across 120 open-source repositories, improving precision and recall.`,
				keywords: [kw1, kw2, kw3],
			});
		}

		ipc.seed({
			categories: ["cs.SE", "cs.PL", "cs.CR"],
			venues: [...DEFAULT_COLLECTION_VENUES],
			items: corpus,
			lastRefreshedAt: "2026-04-12T12:00:00Z",
			latestArxiv: null,
		});
		await saveRecommendPoolState({
			keywords: DEFAULT_RECOMMEND_KEYWORDS.map((k) => ({ ...k })),
			selectedCloudTerms: ["Synthetic Topic 42"],
			wordCloudTopN: DEFAULT_WORD_CLOUD_TOP_N,
			lastRecommendedAt: null,
		});

		const t0 = performance.now();
		const cloud50 = getWordCloudKeywords(corpus, 50);
		const cloud150 = getWordCloudKeywords(corpus, 150);
		const rec = await recommendNextFromCollection(15);
		const elapsedMs = performance.now() - t0;

		expect(cloud50.keywords).toHaveLength(50);
		expect(cloud150.keywords).toHaveLength(150);
		expect(cloud50.totalUniqueKeywords).toBe(180);
		expect(rec.items).toHaveLength(15);
		expect(elapsedMs).toBeLessThan(500);

		// Also verify clicking ANY keyword from the word cloud matches papers carrying that keyword
		const pickedCloudKw = cloud150.keywords[120];
		if (!pickedCloudKw) throw new Error("Missing cloud keyword");
		const matchingPaper = corpus.find((p) =>
			p.keywords?.includes(pickedCloudKw.term),
		);
		if (!matchingPaper) throw new Error("Missing matching paper");
		const scored = scorePaperAgainstKeywords(matchingPaper, [
			pickedCloudKw.term,
		]);
		expect(scored.score).toBeGreaterThan(0);
		expect(scored.matchedKeywords).toEqual([pickedCloudKw.term]);
	});
});
