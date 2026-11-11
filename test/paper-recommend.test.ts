import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyFreshVenueItems,
	type CollectionPaperItem,
	DEFAULT_COLLECTION_VENUES,
	enrichDblpItemsBatch,
	hydrateCollectionStateFromIdb,
	loadCollectionState,
	markCollectionPapersRecommended,
	mergeCollectionItems,
	resetCollectionMemoryForTests,
	saveCollectionState,
} from "@/lib/plaza/collection";
import {
	addCustomRecentKeyword,
	DEFAULT_RECOMMEND_BATCH_SIZE,
	DEFAULT_RECOMMEND_KEYWORDS,
	DEFAULT_WORD_CLOUD_TOP_N,
	getActiveSelectedTerms,
	getWordCloudKeywords,
	isKeywordSelected,
	loadRecommendPoolState,
	MAX_WORD_CLOUD_TOP_N,
	MIN_WORD_CLOUD_TOP_N,
	recommendFromCollection,
	removeRecentKeyword,
	resetRecommendPoolMemoryForTests,
	saveRecommendPoolState,
	scorePaperAgainstKeywords,
	setWordCloudTopN,
	toggleRecentKeywordById,
	toggleRecommendTerm,
} from "@/lib/plaza/recommend-pool";

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

function createSpyIndexedDb() {
	const records = new Map<string, CollectionPaperItem>();
	let putCount = 0;
	let clearCount = 0;
	let txCount = 0;

	const objectStoreNames = {
		contains: (name: string) => name === "papers",
	};

	const indexedDBMock = {
		open: () => {
			const req: {
				result?: unknown;
				onupgradeneeded?: (() => void) | null;
				onsuccess?: (() => void) | null;
				onerror?: (() => void) | null;
			} = {};

			queueMicrotask(() => {
				const db = {
					objectStoreNames,
					close: () => {},
					transaction: (_storeName: string, _mode: string) => {
						txCount += 1;
						const tx: {
							oncomplete?: (() => void) | null;
							onerror?: (() => void) | null;
							objectStore: () => unknown;
						} = {
							objectStore: () => ({
								put: (value: CollectionPaperItem) => {
									putCount += 1;
									records.set(value.id, value);
								},
								delete: (id: string) => {
									records.delete(id);
								},
								clear: () => {
									clearCount += 1;
									records.clear();
								},
								getAllKeys: () => {
									const r: {
										result: string[];
										onsuccess?: (() => void) | null;
									} = { result: Array.from(records.keys()) };
									queueMicrotask(() => r.onsuccess?.());
									return r;
								},
								getAll: () => {
									const r: {
										result: CollectionPaperItem[];
										onsuccess?: (() => void) | null;
									} = { result: Array.from(records.values()) };
									queueMicrotask(() => r.onsuccess?.());
									return r;
								},
							}),
						};
						queueMicrotask(() => tx.oncomplete?.());
						return tx;
					},
				};
				req.result = db;
				req.onsuccess?.();
			});

			return req;
		},
	};

	return {
		records,
		getStats: () => ({ putCount, clearCount, txCount }),
		resetStats: () => {
			putCount = 0;
			clearCount = 0;
			txCount = 0;
		},
		indexedDBMock,
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

describe("Paper Recommend overhaul (metadata, word cloud, selection & performance)", () => {
	let mockStorage: ReturnType<typeof createMockLocalStorage>;

	beforeEach(() => {
		mockStorage = createMockLocalStorage();
		vi.stubGlobal("localStorage", mockStorage.api);
		resetCollectionMemoryForTests();
		resetRecommendPoolMemoryForTests();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		resetCollectionMemoryForTests();
		resetRecommendPoolMemoryForTests();
	});

	it("allows deselecting ALL keywords including LLM Agent down to 0 active terms and persists across reloads", async () => {
		let state = loadRecommendPoolState();
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

		saveRecommendPoolState(state);
		resetRecommendPoolMemoryForTests();

		const reloaded = loadRecommendPoolState();
		expect(getActiveSelectedTerms(reloaded)).toEqual([]);
		expect(isKeywordSelected(reloaded, "LLM Agent")).toBe(false);

		// Toggling via toggleRecommendTerm also works symmetrically from 0 -> 1 -> 0
		const withLlm = toggleRecommendTerm(reloaded, "LLM Agent");
		expect(getActiveSelectedTerms(withLlm)).toEqual(["LLM Agent"]);
		const backToZero = toggleRecommendTerm(withLlm, "llm agent");
		expect(getActiveSelectedTerms(backToZero)).toEqual([]);

		// Calling recommendFromCollection with 0 selected returns empty batch cleanly
		saveRecommendPoolState(backToZero);
		saveCollectionState({
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
		const emptyRes = await recommendFromCollection({
			ensureCollectionLoaded: false,
		});
		expect(emptyRes.selectedKeywords).toEqual([]);
		expect(emptyRes.items).toEqual([]);
	});

	it("supports custom recent keyword add/remove down to 0 chips and merges word-cloud selections on recommend", async () => {
		let state = loadRecommendPoolState();

		// Remove ALL recent keyword chips down to 0
		for (const chip of [...state.keywords]) {
			state = removeRecentKeyword(state, chip.id);
		}
		expect(state.keywords).toEqual([]);
		saveRecommendPoolState(state);
		resetRecommendPoolMemoryForTests();

		state = loadRecommendPoolState();
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
		saveRecommendPoolState(state);

		saveCollectionState({
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

		const rec = await recommendFromCollection({
			ensureCollectionLoaded: false,
		});
		expect(rec.items).toHaveLength(1);
		expect(rec.items[0]?.matchedKeywords).toContain("eBPF Verification");
		// Cloud selection merged into Recent Keywords and `selectedCloudTerms` cleared
		expect(rec.state.selectedCloudTerms).toEqual([]);
		expect(rec.state.keywords.map((k) => k.term)).toEqual([
			"Concolic Testing",
			"eBPF Verification",
		]);
		expect(rec.state.keywords.every((k) => k.enabled)).toBe(true);
	});

	it("aggregates word cloud across all papers with best display casing, Top-50 default, and slider Top-N clamping/slicing", () => {
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

		// Slider Top-N state clamping (15..150) & O(1) slicing
		let state = loadRecommendPoolState();
		state = setWordCloudTopN(state, 5);
		expect(state.wordCloudTopN).toBe(MIN_WORD_CLOUD_TOP_N);
		expect(
			getWordCloudKeywords(papers, state.wordCloudTopN).keywords,
		).toHaveLength(MIN_WORD_CLOUD_TOP_N);

		state = setWordCloudTopN(state, 500);
		expect(state.wordCloudTopN).toBe(MAX_WORD_CLOUD_TOP_N);
		expect(
			getWordCloudKeywords(papers, state.wordCloudTopN).keywords,
		).toHaveLength(71);
	});

	it("pushes 15-paper batches, records recommendedAt in metadata, excludes previously recommended papers, and preserves recommendedAt across merges/refreshes", async () => {
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

		saveCollectionState({
			categories: ["cs.SE"],
			venues: [...DEFAULT_COLLECTION_VENUES],
			items: pool,
			lastRefreshedAt: "2026-04-12T00:00:00Z",
			latestArxiv: null,
		});

		// Verify synchronous localStorage strips heavy `bibtex` bloat
		const rawSavedCollection = mockStorage.store.get(
			"plaza:collection:state:v2",
		);
		expect(rawSavedCollection).toBeTruthy();
		expect(rawSavedCollection).not.toContain("@inproceedings");

		saveRecommendPoolState({
			keywords: [{ id: "kw-df", term: "Directed Fuzzing", enabled: true }],
			selectedCloudTerms: [],
			wordCloudTopN: DEFAULT_WORD_CLOUD_TOP_N,
			lastRecommendedAt: null,
		});

		// Batch 1 -> default 15 papers
		const batch1 = await recommendFromCollection({
			ensureCollectionLoaded: false,
		});
		expect(DEFAULT_RECOMMEND_BATCH_SIZE).toBe(15);
		expect(batch1.items).toHaveLength(15);
		const batch1Ids = new Set(batch1.items.map((p) => p.id));
		for (const item of batch1.items) {
			expect(item.recommendedAt).toBeTruthy();
		}

		// Batch 2 -> next 15 unseen papers (disjoint from Batch 1)
		const batch2 = await recommendFromCollection({
			ensureCollectionLoaded: false,
		});
		expect(batch2.items).toHaveLength(15);
		for (const item of batch2.items) {
			expect(batch1Ids.has(item.id)).toBe(false);
			expect(item.recommendedAt).toBeTruthy();
		}

		// Batch 3 -> remaining 5 unseen papers
		const batch3 = await recommendFromCollection({
			ensureCollectionLoaded: false,
		});
		expect(batch3.items).toHaveLength(5);

		// Batch 4 -> 0 unseen papers left
		const batch4 = await recommendFromCollection({
			ensureCollectionLoaded: false,
		});
		expect(batch4.items).toHaveLength(0);

		// Word cloud reflects `unrecommendedCount === 0` after all 35 are recommended
		const afterCloud = getWordCloudKeywords(loadCollectionState().items);
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
			loadCollectionState().items,
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
	});

	it("patches IndexedDB incrementally without store.clear and migrates legacy v1 pushedIds once", async () => {
		const idb = createSpyIndexedDb();
		vi.stubGlobal("indexedDB", idb.indexedDBMock);

		const papers = Array.from({ length: 200 }, (_, idx) =>
			makePaper(idx + 1, { keywords: ["Static Analysis"] }),
		);
		saveCollectionState({
			categories: ["cs.SE"],
			venues: [...DEFAULT_COLLECTION_VENUES],
			items: papers,
			lastRefreshedAt: "2026-04-12T00:00:00Z",
			latestArxiv: null,
		});
		// Wait for initial async IDB write
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idb.records.size).toBe(200);

		idb.resetStats();

		// Marking 15 papers recommended must write ONLY 15 records in 1 readwrite tx with 0 clears
		const target15 = papers.slice(50, 65).map((p) => p.id);
		const firstTargetId = target15[0] ?? "";
		await markCollectionPapersRecommended(target15, "2026-04-12T08:00:00Z");
		const stats = idb.getStats();
		expect(stats.clearCount).toBe(0);
		expect(stats.txCount).toBe(1);
		expect(stats.putCount).toBe(15);
		expect(idb.records.get(firstTargetId)?.recommendedAt).toBe(
			"2026-04-12T08:00:00Z",
		);

		// Cold reload hydrates all 200 items from IDB including `recommendedAt` beyond localStorage's 80-item cap
		resetCollectionMemoryForTests();
		const hydrated = await hydrateCollectionStateFromIdb();
		expect(hydrated.items).toHaveLength(200);
		expect(
			hydrated.items.find((p) => p.id === target15[14])?.recommendedAt,
		).toBe("2026-04-12T08:00:00Z");

		// Legacy `plaza:recommend:pool-state:v1` migration onto paper metadata + dropping bloat
		const legacyPaper = papers[120];
		if (!legacyPaper) throw new Error("Missing legacy paper");
		const legacyId = legacyPaper.id;
		mockStorage.store.set(
			"plaza:recommend:pool-state:v1",
			JSON.stringify({
				keywords: DEFAULT_RECOMMEND_KEYWORDS,
				recentBatchId: "batch-legacy",
				history: [{ ...legacyPaper, pushedAt: "2026-04-01T00:00:00Z" }],
				pushedIds: [legacyId],
				lastPushedAt: "2026-04-01T00:00:00Z",
			}),
		);
		resetRecommendPoolMemoryForTests();

		const migrated = loadRecommendPoolState();
		expect(migrated.lastRecommendedAt).toBe("2026-04-01T00:00:00Z");
		expect(mockStorage.store.has("plaza:recommend:pool-state:v1")).toBe(false);
		const savedV2 =
			mockStorage.store.get("plaza:recommend:pool-state:v2") ?? "";
		expect(savedV2).not.toContain("history");
		expect(savedV2).not.toContain("pushedIds");
		expect(
			loadCollectionState().items.find((p) => p.id === legacyId)?.recommendedAt,
		).toBe("2026-04-01T00:00:00Z");
	});

	it("computes word cloud + 15-paper recommendation over 3,000 synthetic papers in <50ms", async () => {
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

		saveCollectionState({
			categories: ["cs.SE", "cs.PL", "cs.CR"],
			venues: [...DEFAULT_COLLECTION_VENUES],
			items: corpus,
			lastRefreshedAt: "2026-04-12T12:00:00Z",
			latestArxiv: null,
		});
		saveRecommendPoolState({
			keywords: DEFAULT_RECOMMEND_KEYWORDS.map((k) => ({ ...k })),
			selectedCloudTerms: ["Synthetic Topic 42"],
			wordCloudTopN: DEFAULT_WORD_CLOUD_TOP_N,
			lastRecommendedAt: null,
		});

		// Measure cold index build + Top-50 word cloud + slider Top-150 slice + 15-paper recommendation
		const t0 = performance.now();
		const cloud50 = getWordCloudKeywords(loadCollectionState().items, 50);
		const cloud150 = getWordCloudKeywords(loadCollectionState().items, 150);
		const rec = await recommendFromCollection({
			maxBatchSize: 15,
			ensureCollectionLoaded: false,
		});
		const elapsedMs = performance.now() - t0;

		expect(cloud50.keywords).toHaveLength(50);
		expect(cloud150.keywords).toHaveLength(150);
		expect(cloud50.totalUniqueKeywords).toBe(180);
		expect(rec.items).toHaveLength(15);
		expect(elapsedMs).toBeLessThan(50);

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
