/**
 * Plaza — Paper Recommend Engine (Keyword Hub + Word Cloud + Metadata-backed Push).
 *
 * Matches active user keywords (Recent Keywords + All Keywords Word Cloud) against
 * the 2026 Paper Collection pool (`arXiv` + 28 DBLP Venues).
 *
 * Performance & Persistence Architecture:
 * - Recommended status is stored directly as `paper.recommendedAt` (ISO timestamp) on
 *   `CollectionPaperItem` metadata and patched incrementally in IndexedDB (`store.put`),
 *   eliminating `localStorage` history/pushedIds bloat.
 * - Memoized in-memory `CorpusIndex` pre-aggregates and pre-sorts all unique paper
 *   keywords (`count`, `unrecommendedCount`, best display casing) for O(1) Top-N slider
 *   slicing, updates `unrecommendedCount` incrementally when batches are recommended,
 *   and pre-computes normalized keyword sets + lowercased search blobs for sub-10ms scoring.
 */

import {
	readJsonStorage,
	removeStorageKey,
	writeJsonStorage,
} from "@/lib/core/storage";
import {
	type CollectionPaperItem,
	derivePaperKeywords,
	hydrateCollectionStateFromIdb,
	loadCollectionState,
	markCollectionPapersRecommended,
} from "@/lib/plaza/collection";

export const DEFAULT_RECOMMEND_BATCH_SIZE = 15;
export const DEFAULT_WORD_CLOUD_TOP_N = 50;
export const MIN_WORD_CLOUD_TOP_N = 15;
export const MAX_WORD_CLOUD_TOP_N = 150;

const MAX_TIDY_RECENT_KEYWORDS = 24;

export type RecommendKeywordChip = {
	id: string;
	term: string;
	enabled: boolean;
};

export type WordCloudKeyword = {
	term: string;
	normalized: string;
	count: number;
	unrecommendedCount: number;
};

export type RecommendedPaperItem = CollectionPaperItem & {
	matchedKeywords: string[];
	score: number;
};

export type RecommendPoolState = {
	keywords: RecommendKeywordChip[];
	selectedCloudTerms: string[];
	wordCloudTopN: number;
	lastRecommendedAt: string | null;
};

type LegacyRecommendPoolStateV1 = {
	keywords?: RecommendKeywordChip[];
	recentBatchId?: string | null;
	history?: Array<{ id?: string; pushedAt?: string }>;
	pushedIds?: string[];
	lastPushedAt?: string | null;
};

const STORAGE_KEY = "plaza:recommend:pool-state:v2";
const LEGACY_STORAGE_KEY = "plaza:recommend:pool-state:v1";

export const DEFAULT_RECOMMEND_KEYWORDS: readonly RecommendKeywordChip[] = [
	{ id: "kw-llm-agent", term: "LLM Agent", enabled: true },
	{ id: "kw-program-analysis", term: "Program Analysis", enabled: true },
	{ id: "kw-vuln", term: "Vulnerability Detection", enabled: true },
	{ id: "kw-fuzzing", term: "Fuzzing", enabled: true },
	{ id: "kw-code-gen", term: "Code Generation", enabled: true },
	{ id: "kw-verification", term: "Formal Verification", enabled: true },
	{ id: "kw-repair", term: "Program Repair", enabled: false },
	{ id: "kw-smart-contract", term: "Smart Contract", enabled: false },
];

let memoryPoolState: RecommendPoolState | null = null;
let pendingLegacyMigration: {
	ids: string[];
	recommendedAt: string;
} | null = null;

function cleanTermDisplay(term: string): string {
	return term.replace(/\s+/g, " ").trim();
}

function normalizeTermKey(term: string): string {
	return cleanTermDisplay(term).toLowerCase();
}

function clampWordCloudTopN(topN: number): number {
	if (!Number.isFinite(topN)) return DEFAULT_WORD_CLOUD_TOP_N;
	return Math.min(
		MAX_WORD_CLOUD_TOP_N,
		Math.max(MIN_WORD_CLOUD_TOP_N, Math.round(topN)),
	);
}

function hasUsableLocalStorage(): boolean {
	try {
		if (typeof localStorage === "undefined" || !localStorage) return false;
		if (typeof localStorage.getItem !== "function") return false;
		localStorage.getItem(STORAGE_KEY);
		return true;
	} catch {
		return false;
	}
}

function buildKeywordChipId(
	term: string,
	existingIds: ReadonlySet<string>,
): string {
	const slug =
		normalizeTermKey(term)
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 32) || "term";
	const base = `kw-custom-${slug}`;
	if (!existingIds.has(base)) return base;
	let seq = 2;
	while (existingIds.has(`${base}-${seq}`)) seq += 1;
	return `${base}-${seq}`;
}

function sanitizeKeywordChips(rawChips: unknown[]): RecommendKeywordChip[] {
	const result: RecommendKeywordChip[] = [];
	const seenTerms = new Map<string, number>();
	const usedIds = new Set<string>();

	for (const raw of rawChips) {
		if (!raw || typeof raw !== "object") continue;
		const candidate = raw as Partial<RecommendKeywordChip>;
		if (typeof candidate.term !== "string") continue;
		const term = cleanTermDisplay(candidate.term);
		const key = normalizeTermKey(term);
		if (!key) continue;

		const enabled = Boolean(candidate.enabled);
		const existingIdx = seenTerms.get(key);
		if (existingIdx !== undefined) {
			const prev = result[existingIdx];
			if (prev && enabled && !prev.enabled) {
				result[existingIdx] = { ...prev, enabled: true };
			}
			continue;
		}

		const rawId =
			typeof candidate.id === "string" && candidate.id.trim()
				? candidate.id.trim()
				: "";
		const id =
			rawId && !usedIds.has(rawId) ? rawId : buildKeywordChipId(term, usedIds);
		usedIds.add(id);
		seenTerms.set(key, result.length);
		result.push({ id, term, enabled });
	}

	return result;
}

function sanitizeSelectedCloudTerms(
	rawTerms: unknown,
	keywords: readonly RecommendKeywordChip[],
): string[] {
	if (!Array.isArray(rawTerms)) return [];
	const enabledRecentKeys = new Set(
		keywords.filter((k) => k.enabled).map((k) => normalizeTermKey(k.term)),
	);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of rawTerms) {
		if (typeof entry !== "string") continue;
		const cleaned = cleanTermDisplay(entry);
		const key = normalizeTermKey(cleaned);
		if (!key || seen.has(key) || enabledRecentKeys.has(key)) continue;
		seen.add(key);
		out.push(cleaned);
	}
	return out;
}

function sanitizeRecommendPoolState(
	raw: Partial<RecommendPoolState> | null | undefined,
): RecommendPoolState {
	const keywords = Array.isArray(raw?.keywords)
		? sanitizeKeywordChips(raw.keywords)
		: DEFAULT_RECOMMEND_KEYWORDS.map((chip) => ({ ...chip }));
	const selectedCloudTerms = sanitizeSelectedCloudTerms(
		raw?.selectedCloudTerms,
		keywords,
	);
	const wordCloudTopN =
		typeof raw?.wordCloudTopN === "number"
			? clampWordCloudTopN(raw.wordCloudTopN)
			: DEFAULT_WORD_CLOUD_TOP_N;
	const lastRecommendedAt =
		typeof raw?.lastRecommendedAt === "string" && raw.lastRecommendedAt.trim()
			? raw.lastRecommendedAt.trim()
			: null;

	return {
		keywords,
		selectedCloudTerms,
		wordCloudTopN,
		lastRecommendedAt,
	};
}

function migrateLegacyV1StateIfPresent(): RecommendPoolState | null {
	const legacy = readJsonStorage<LegacyRecommendPoolStateV1 | null>(
		LEGACY_STORAGE_KEY,
		null,
	);
	if (!legacy || typeof legacy !== "object") return null;

	const idSet = new Set<string>();
	if (Array.isArray(legacy.pushedIds)) {
		for (const id of legacy.pushedIds) {
			if (typeof id === "string" && id.trim()) idSet.add(id.trim());
		}
	}
	if (Array.isArray(legacy.history)) {
		for (const h of legacy.history) {
			if (h && typeof h.id === "string" && h.id.trim()) {
				idSet.add(h.id.trim());
			}
		}
	}

	const migratedIso =
		typeof legacy.lastPushedAt === "string" && legacy.lastPushedAt.trim()
			? legacy.lastPushedAt.trim()
			: new Date().toISOString();

	if (idSet.size > 0) {
		const ids = Array.from(idSet);
		pendingLegacyMigration = { ids, recommendedAt: migratedIso };
		void markCollectionPapersRecommended(ids, migratedIso);
	}

	const existingV2 = readJsonStorage<Partial<RecommendPoolState> | null>(
		STORAGE_KEY,
		null,
	);
	const migrated = sanitizeRecommendPoolState({
		keywords: existingV2?.keywords ?? legacy.keywords,
		selectedCloudTerms: existingV2?.selectedCloudTerms ?? [],
		wordCloudTopN: existingV2?.wordCloudTopN ?? DEFAULT_WORD_CLOUD_TOP_N,
		lastRecommendedAt:
			existingV2?.lastRecommendedAt ??
			(typeof legacy.lastPushedAt === "string" ? legacy.lastPushedAt : null),
	});

	writeJsonStorage(STORAGE_KEY, migrated);
	removeStorageKey(LEGACY_STORAGE_KEY);
	memoryPoolState = migrated;
	return migrated;
}

export function loadRecommendPoolState(): RecommendPoolState {
	if (hasUsableLocalStorage()) {
		const migrated = migrateLegacyV1StateIfPresent();
		if (migrated) return migrated;
		const raw = readJsonStorage<
			| (Partial<RecommendPoolState> & {
					pushedIds?: string[];
					history?: Array<{ id?: string }>;
					lastPushedAt?: string | null;
			  })
			| null
		>(STORAGE_KEY, null);
		if (!raw) {
			return sanitizeRecommendPoolState(null);
		}
		const clean = sanitizeRecommendPoolState({
			...raw,
			lastRecommendedAt:
				raw.lastRecommendedAt ??
				(typeof raw.lastPushedAt === "string" ? raw.lastPushedAt : null),
		});
		if ("pushedIds" in raw || "history" in raw || "recentBatchId" in raw) {
			const extraIds = [
				...(Array.isArray(raw.pushedIds) ? raw.pushedIds : []),
				...(Array.isArray(raw.history)
					? raw.history
							.map((h) => h?.id)
							.filter((id): id is string => typeof id === "string")
					: []),
			];
			if (extraIds.length > 0) {
				const ts = clean.lastRecommendedAt ?? new Date().toISOString();
				pendingLegacyMigration = { ids: extraIds, recommendedAt: ts };
				void markCollectionPapersRecommended(extraIds, ts);
			}
			writeJsonStorage(STORAGE_KEY, clean);
		}
		memoryPoolState = clean;
		return clean;
	}

	return sanitizeRecommendPoolState(memoryPoolState);
}

export function saveRecommendPoolState(state: RecommendPoolState): void {
	const clean = sanitizeRecommendPoolState(state);
	memoryPoolState = clean;
	writeJsonStorage(STORAGE_KEY, clean);
	removeStorageKey(LEGACY_STORAGE_KEY);
}

/** Reset in-memory pool state and corpus index caches (primarily for unit tests). */
export function resetRecommendPoolMemoryForTests(): void {
	memoryPoolState = null;
	pendingLegacyMigration = null;
	cachedCorpusIndex = null;
}

// ─── Unified Keyword Selection & Recent Chips Management ───

export function getActiveSelectedTerms(state: RecommendPoolState): string[] {
	const out: string[] = [];
	const seen = new Set<string>();

	for (const chip of state.keywords) {
		if (!chip.enabled) continue;
		const term = cleanTermDisplay(chip.term);
		const key = normalizeTermKey(term);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(term);
	}

	for (const rawTerm of state.selectedCloudTerms) {
		const term = cleanTermDisplay(rawTerm);
		const key = normalizeTermKey(term);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(term);
	}

	return out;
}

export function isKeywordSelected(
	state: RecommendPoolState,
	term: string,
): boolean {
	const key = normalizeTermKey(term);
	if (!key) return false;
	for (const chip of state.keywords) {
		if (chip.enabled && normalizeTermKey(chip.term) === key) {
			return true;
		}
	}
	for (const cloudTerm of state.selectedCloudTerms) {
		if (normalizeTermKey(cloudTerm) === key) {
			return true;
		}
	}
	return false;
}

export function toggleRecommendTerm(
	state: RecommendPoolState,
	term: string,
): RecommendPoolState {
	const cleaned = cleanTermDisplay(term);
	const key = normalizeTermKey(cleaned);
	if (!key) return state;

	if (isKeywordSelected(state, cleaned)) {
		return {
			...state,
			keywords: state.keywords.map((chip) =>
				normalizeTermKey(chip.term) === key
					? { ...chip, enabled: false }
					: chip,
			),
			selectedCloudTerms: state.selectedCloudTerms.filter(
				(t) => normalizeTermKey(t) !== key,
			),
		};
	}

	const existingRecentIdx = state.keywords.findIndex(
		(chip) => normalizeTermKey(chip.term) === key,
	);
	if (existingRecentIdx >= 0) {
		return {
			...state,
			keywords: state.keywords.map((chip, idx) =>
				idx === existingRecentIdx ? { ...chip, enabled: true } : chip,
			),
			selectedCloudTerms: state.selectedCloudTerms.filter(
				(t) => normalizeTermKey(t) !== key,
			),
		};
	}

	return {
		...state,
		selectedCloudTerms: [...state.selectedCloudTerms, cleaned],
	};
}

export function toggleRecentKeywordById(
	state: RecommendPoolState,
	id: string,
): RecommendPoolState {
	const target = state.keywords.find((chip) => chip.id === id);
	if (!target) return state;
	const key = normalizeTermKey(target.term);
	const currentlyActive = isKeywordSelected(state, target.term);
	const nextEnabled = !currentlyActive;

	return {
		...state,
		keywords: state.keywords.map((chip) =>
			chip.id === id ? { ...chip, enabled: nextEnabled } : chip,
		),
		selectedCloudTerms: state.selectedCloudTerms.filter(
			(t) => normalizeTermKey(t) !== key,
		),
	};
}

export function addCustomRecentKeyword(
	state: RecommendPoolState,
	rawTerm: string,
): RecommendPoolState {
	const cleaned = cleanTermDisplay(rawTerm);
	const key = normalizeTermKey(cleaned);
	if (!key) return state;

	const existingIdx = state.keywords.findIndex(
		(chip) => normalizeTermKey(chip.term) === key,
	);
	const nextSelectedCloud = state.selectedCloudTerms.filter(
		(t) => normalizeTermKey(t) !== key,
	);

	if (existingIdx >= 0) {
		return {
			...state,
			keywords: state.keywords.map((chip, idx) =>
				idx === existingIdx
					? {
							...chip,
							term:
								casingQuality(cleaned) > casingQuality(chip.term)
									? cleaned
									: chip.term,
							enabled: true,
						}
					: chip,
			),
			selectedCloudTerms: nextSelectedCloud,
		};
	}

	const existingIds = new Set(state.keywords.map((chip) => chip.id));
	const newChip: RecommendKeywordChip = {
		id: buildKeywordChipId(cleaned, existingIds),
		term: cleaned,
		enabled: true,
	};

	return {
		...state,
		keywords: [...state.keywords, newChip],
		selectedCloudTerms: nextSelectedCloud,
	};
}

export function removeRecentKeyword(
	state: RecommendPoolState,
	id: string,
): RecommendPoolState {
	const target = state.keywords.find((chip) => chip.id === id);
	if (!target) return state;
	const key = normalizeTermKey(target.term);
	return {
		...state,
		keywords: state.keywords.filter((chip) => chip.id !== id),
		selectedCloudTerms: state.selectedCloudTerms.filter(
			(t) => normalizeTermKey(t) !== key,
		),
	};
}

export function setWordCloudTopN(
	state: RecommendPoolState,
	topN: number,
): RecommendPoolState {
	return {
		...state,
		wordCloudTopN: clampWordCloudTopN(topN),
	};
}

function mergeCloudTermsIntoRecentKeywords(
	state: RecommendPoolState,
): RecommendPoolState {
	if (state.selectedCloudTerms.length === 0) {
		return state;
	}

	let nextState: RecommendPoolState = {
		...state,
		keywords: [...state.keywords],
		selectedCloudTerms: [...state.selectedCloudTerms],
	};

	for (const cloudTerm of state.selectedCloudTerms) {
		nextState = addCustomRecentKeyword(nextState, cloudTerm);
	}
	nextState = {
		...nextState,
		selectedCloudTerms: [],
	};

	if (nextState.keywords.length > MAX_TIDY_RECENT_KEYWORDS) {
		const enabledChips = nextState.keywords.filter((k) => k.enabled);
		const disabledChips = nextState.keywords.filter((k) => !k.enabled);
		const disabledBudget = Math.max(
			0,
			MAX_TIDY_RECENT_KEYWORDS - enabledChips.length,
		);
		const keptDisabled = new Set(
			disabledChips.slice(-disabledBudget).map((k) => k.id),
		);
		nextState = {
			...nextState,
			keywords: nextState.keywords.filter(
				(k) => k.enabled || keptDisabled.has(k.id),
			),
		};
	}

	return nextState;
}

// ─── Memoized Corpus & Word-Cloud / Fast-Scoring Index ───

const MINOR_TITLE_WORDS = new Set([
	"a",
	"an",
	"and",
	"as",
	"at",
	"by",
	"for",
	"from",
	"in",
	"into",
	"of",
	"on",
	"or",
	"the",
	"to",
	"via",
	"with",
]);

function casingQuality(form: string): number {
	const hasUpper = /[A-Z]/.test(form);
	const hasLower = /[a-z]/.test(form);
	if (!hasUpper) return 1;
	if (!hasLower) {
		// Short acronyms like "LLM", "LLVM", "SMT", "WASM" are ideal in uppercase;
		// long multi-word SHOUTING strings are lower quality than Title Case.
		return form.length <= 6 && !/\s/.test(form) ? 4 : 2;
	}

	const words = form.split(/[\s/-]+/).filter(Boolean);
	let contentWords = 0;
	let capitalizedContentWords = 0;
	for (let i = 0; i < words.length; i++) {
		const w = words[i] ?? "";
		const lower = w.toLowerCase();
		if (i > 0 && MINOR_TITLE_WORDS.has(lower)) continue;
		if (!/[a-zA-Z]/.test(w)) continue;
		contentWords += 1;
		// Accept TitleCase ("Agent"), Acronym ("LLM"), or technical mixedCase ("eBPF", "GraphQL", "iOS")
		if (/^[A-Z]/.test(w) || /[a-z][A-Z]/.test(w)) {
			capitalizedContentWords += 1;
		}
	}
	const allContentCapitalized =
		contentWords > 0 && capitalizedContentWords === contentWords;
	const hasAcronym = /\b[A-Z]{2,}\b/.test(form) || /[a-z][A-Z]/.test(form);

	if (allContentCapitalized && hasAcronym) return 6;
	if (allContentCapitalized) return 5;
	if (hasAcronym) return 4;
	return 3;
}

function pickBestDisplayCasing(
	variants: Map<string, number>,
	fallback: string,
): string {
	let bestForm = fallback;
	let bestQuality = -1;
	let bestFreq = -1;

	for (const [form, freq] of variants) {
		const quality = casingQuality(form);
		if (
			quality > bestQuality ||
			(quality === bestQuality && freq > bestFreq) ||
			(quality === bestQuality &&
				freq === bestFreq &&
				form.localeCompare(bestForm) < 0)
		) {
			bestForm = form;
			bestQuality = quality;
			bestFreq = freq;
		}
	}

	return bestForm;
}

type PaperExtractedKeyword = {
	display: string;
	normalized: string;
};

type PrecomputedPaperFields = {
	extractedKeywords: PaperExtractedKeyword[];
	normalizedKeywords: string[];
	normalizedKeywordSet: ReadonlySet<string>;
	keywordsJoinedLower: string;
	titleLower: string;
	abstractLower: string;
	catLower: string;
	combinedLower: string;
};

const paperFieldsWeakCache = new WeakMap<
	CollectionPaperItem,
	PrecomputedPaperFields
>();

function extractPaperKeywordsNormalized(
	paper: CollectionPaperItem,
): PaperExtractedKeyword[] {
	const rawSource =
		paper.keywords && paper.keywords.length > 0
			? paper.keywords
			: derivePaperKeywords(
					paper.title,
					paper.abstract,
					paper.categories,
					paper.keywords,
				);
	if (!rawSource || rawSource.length === 0) return [];

	const out: PaperExtractedKeyword[] = [];
	const seen = new Set<string>();
	for (const raw of rawSource) {
		if (typeof raw !== "string") continue;
		const display = cleanTermDisplay(raw);
		if (display.length < 2) continue;
		const normalized = display.toLowerCase();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push({ display, normalized });
	}
	return out;
}

function getPrecomputedPaperFields(
	paper: CollectionPaperItem,
): PrecomputedPaperFields {
	const hit = paperFieldsWeakCache.get(paper);
	if (hit) return hit;

	const extractedKeywords = extractPaperKeywordsNormalized(paper);
	const normalizedKeywords = extractedKeywords.map((k) => k.normalized);
	const normalizedKeywordSet = new Set(normalizedKeywords);
	const keywordsJoinedLower = normalizedKeywords.join(" ; ");
	const titleLower = paper.title.toLowerCase();
	const abstractLower = paper.abstract.toLowerCase();
	const catLower = `${paper.sourceLabel} ${paper.categories.join(" ")}`
		.trim()
		.toLowerCase();
	const combinedLower = `${titleLower}\n${keywordsJoinedLower}\n${abstractLower}\n${catLower}`;

	const computed: PrecomputedPaperFields = {
		extractedKeywords,
		normalizedKeywords,
		normalizedKeywordSet,
		keywordsJoinedLower,
		titleLower,
		abstractLower,
		catLower,
		combinedLower,
	};
	paperFieldsWeakCache.set(paper, computed);
	return computed;
}

type IndexedCorpusDoc = {
	paper: CollectionPaperItem;
	fields: PrecomputedPaperFields;
	recommended: boolean;
};

type CorpusIndex = {
	itemsRef: readonly CollectionPaperItem[];
	length: number;
	lastRefreshedAt: string | null;
	recommendedCount: number;
	docs: IndexedCorpusDoc[];
	keywordByNormalized: Map<string, WordCloudKeyword>;
	sortedKeywords: WordCloudKeyword[];
};

let cachedCorpusIndex: CorpusIndex | null = null;

function compareWordCloudKeywords(
	a: WordCloudKeyword,
	b: WordCloudKeyword,
): number {
	if (b.count !== a.count) return b.count - a.count;
	if (b.unrecommendedCount !== a.unrecommendedCount) {
		return b.unrecommendedCount - a.unrecommendedCount;
	}
	return a.term.localeCompare(b.term);
}

function countRecommendedItems(items: readonly CollectionPaperItem[]): number {
	let recCount = 0;
	for (let i = 0; i < items.length; i++) {
		if (items[i]?.recommendedAt) recCount += 1;
	}
	return recCount;
}

function tryIncrementalRecommendedUpdate(
	prev: CorpusIndex,
	items: readonly CollectionPaperItem[],
	lastRefreshedAt: string | null,
	recommendedCount: number,
): CorpusIndex | null {
	if (prev.length !== items.length) return null;

	const changedIndices: number[] = [];
	for (let i = 0; i < items.length; i++) {
		const nextPaper = items[i];
		const prevDoc = prev.docs[i];
		if (!nextPaper || !prevDoc) return null;
		if (nextPaper === prevDoc.paper) {
			if (Boolean(nextPaper.recommendedAt) !== prevDoc.recommended) {
				changedIndices.push(i);
			}
			continue;
		}
		// Only take incremental path when paper identity & content are unchanged
		if (
			nextPaper.id !== prevDoc.paper.id ||
			nextPaper.title !== prevDoc.paper.title ||
			nextPaper.abstract !== prevDoc.paper.abstract ||
			nextPaper.keywords !== prevDoc.paper.keywords
		) {
			return null;
		}
		paperFieldsWeakCache.set(nextPaper, prevDoc.fields);
		if (Boolean(nextPaper.recommendedAt) !== prevDoc.recommended) {
			changedIndices.push(i);
		} else {
			prevDoc.paper = nextPaper;
		}
	}

	if (changedIndices.length === 0) {
		prev.itemsRef = items;
		prev.lastRefreshedAt = lastRefreshedAt;
		prev.recommendedCount = recommendedCount;
		return prev;
	}

	for (const idx of changedIndices) {
		const nextPaper = items[idx];
		const doc = prev.docs[idx];
		if (!nextPaper || !doc) continue;
		const nextRec = Boolean(nextPaper.recommendedAt);
		const delta = nextRec ? -1 : 1;
		doc.paper = nextPaper;
		doc.recommended = nextRec;

		for (const normKw of doc.fields.normalizedKeywords) {
			const entry = prev.keywordByNormalized.get(normKw);
			if (entry) {
				entry.unrecommendedCount = Math.max(
					0,
					entry.unrecommendedCount + delta,
				);
			}
		}
	}

	prev.sortedKeywords.sort(compareWordCloudKeywords);
	prev.itemsRef = items;
	prev.lastRefreshedAt = lastRefreshedAt;
	prev.recommendedCount = recommendedCount;
	return prev;
}

function getOrBuildCorpusIndex(
	items: readonly CollectionPaperItem[],
	lastRefreshedAt: string | null = null,
): CorpusIndex {
	const recommendedCount = countRecommendedItems(items);
	if (cachedCorpusIndex) {
		if (
			cachedCorpusIndex.itemsRef === items &&
			cachedCorpusIndex.recommendedCount === recommendedCount &&
			cachedCorpusIndex.lastRefreshedAt === lastRefreshedAt
		) {
			return cachedCorpusIndex;
		}
		const incremental = tryIncrementalRecommendedUpdate(
			cachedCorpusIndex,
			items,
			lastRefreshedAt,
			recommendedCount,
		);
		if (incremental) {
			return incremental;
		}
	}

	const docs: IndexedCorpusDoc[] = [];
	const buckets = new Map<
		string,
		{
			count: number;
			unrecommendedCount: number;
			variants: Map<string, number>;
		}
	>();

	for (const paper of items) {
		const fields = getPrecomputedPaperFields(paper);
		const recommended = Boolean(paper.recommendedAt);
		docs.push({ paper, fields, recommended });

		for (const kw of fields.extractedKeywords) {
			let bucket = buckets.get(kw.normalized);
			if (!bucket) {
				bucket = {
					count: 0,
					unrecommendedCount: 0,
					variants: new Map<string, number>(),
				};
				buckets.set(kw.normalized, bucket);
			}
			bucket.count += 1;
			if (!recommended) {
				bucket.unrecommendedCount += 1;
			}
			bucket.variants.set(
				kw.display,
				(bucket.variants.get(kw.display) ?? 0) + 1,
			);
		}
	}

	const keywordByNormalized = new Map<string, WordCloudKeyword>();
	const sortedKeywords: WordCloudKeyword[] = [];
	for (const [normalized, bucket] of buckets) {
		const entry: WordCloudKeyword = {
			term: pickBestDisplayCasing(bucket.variants, normalized),
			normalized,
			count: bucket.count,
			unrecommendedCount: bucket.unrecommendedCount,
		};
		keywordByNormalized.set(normalized, entry);
		sortedKeywords.push(entry);
	}
	sortedKeywords.sort(compareWordCloudKeywords);

	const built: CorpusIndex = {
		itemsRef: items,
		length: items.length,
		lastRefreshedAt,
		recommendedCount,
		docs,
		keywordByNormalized,
		sortedKeywords,
	};
	cachedCorpusIndex = built;
	return built;
}

export function getWordCloudKeywords(
	items: readonly CollectionPaperItem[],
	topN?: number,
): { keywords: WordCloudKeyword[]; totalUniqueKeywords: number } {
	const index = getOrBuildCorpusIndex(items);
	const limit =
		topN === undefined
			? DEFAULT_WORD_CLOUD_TOP_N
			: Math.max(0, Math.round(topN));
	return {
		keywords: index.sortedKeywords.slice(0, limit),
		totalUniqueKeywords: index.sortedKeywords.length,
	};
}

// ─── Keyword Scoring & Batch Recommendation ───

type PreparedQueryKeyword = {
	term: string;
	phrase: string;
	tokens: string[];
	minThreshold: number;
};

function prepareQueryKeywords(
	activeKeywords: readonly (RecommendKeywordChip | string)[],
): PreparedQueryKeyword[] {
	const out: PreparedQueryKeyword[] = [];
	const seen = new Set<string>();

	for (const entry of activeKeywords) {
		if (typeof entry !== "string" && !entry.enabled) continue;
		const rawTerm = typeof entry === "string" ? entry : entry.term;
		const term = cleanTermDisplay(rawTerm);
		const phrase = term.toLowerCase();
		if (!phrase || seen.has(phrase)) continue;
		seen.add(phrase);

		const tokens = phrase.split(/\s+/).filter((t) => t.length >= 2);
		const minThreshold = tokens.length > 1 ? 1.2 : 1.0;
		out.push({ term, phrase, tokens, minThreshold });
	}

	return out;
}

function scoreFieldsAgainstPreparedKeywords(
	fields: PrecomputedPaperFields,
	prepared: readonly PreparedQueryKeyword[],
): { score: number; matchedKeywords: string[] } {
	if (prepared.length === 0) {
		return { score: 0, matchedKeywords: [] };
	}

	let totalScore = 0;
	let matchedKeywords: string[] | null = null;

	for (const kw of prepared) {
		const { phrase, tokens, minThreshold } = kw;

		// Fast single-pass rejection over pre-lowercased combined search blob
		if (tokens.length === 0) {
			if (!fields.combinedLower.includes(phrase)) continue;
		} else if (tokens.length === 1) {
			const singleToken = tokens[0];
			if (!singleToken || !fields.combinedLower.includes(singleToken)) continue;
		} else {
			let anyTokenHit = false;
			for (const tok of tokens) {
				if (fields.combinedLower.includes(tok)) {
					anyTokenHit = true;
					break;
				}
			}
			if (!anyTokenHit) continue;
		}

		let kwScore = 0;

		// 1. Paper-level keywords (strong exact & phrase boost so every word-cloud tag matches reliably)
		if (fields.normalizedKeywordSet.has(phrase)) {
			kwScore += 5.0;
		} else if (fields.keywordsJoinedLower.includes(phrase)) {
			kwScore += 3.2;
		} else if (
			tokens.length > 1 &&
			fields.keywordsJoinedLower &&
			tokens.every((t) => fields.keywordsJoinedLower.includes(t))
		) {
			kwScore += 2.2;
		} else if (fields.keywordsJoinedLower) {
			for (const tok of tokens) {
				if (fields.keywordsJoinedLower.includes(tok)) {
					kwScore += 0.6;
				}
			}
		}

		// 2. Title match
		if (fields.titleLower.includes(phrase)) {
			kwScore += 4.0;
		} else if (
			tokens.length > 1 &&
			tokens.every((t) => fields.titleLower.includes(t))
		) {
			kwScore += 3.0;
		} else {
			for (const tok of tokens) {
				if (fields.titleLower.includes(tok)) {
					kwScore += 1.2;
				}
			}
		}

		// 3. Abstract match
		if (fields.abstractLower.includes(phrase)) {
			kwScore += 1.8;
		} else if (
			tokens.length > 1 &&
			fields.abstractLower &&
			tokens.every((t) => fields.abstractLower.includes(t))
		) {
			kwScore += 1.2;
		} else if (fields.abstractLower) {
			for (const tok of tokens) {
				if (fields.abstractLower.includes(tok)) {
					kwScore += 0.4;
				}
			}
		}

		// 4. Category / venue badge match
		if (fields.catLower.includes(phrase)) {
			kwScore += 1.0;
		}

		if (kwScore >= minThreshold) {
			totalScore += kwScore;
			if (!matchedKeywords) matchedKeywords = [];
			matchedKeywords.push(kw.term);
		}
	}

	if (!matchedKeywords || matchedKeywords.length === 0) {
		return { score: 0, matchedKeywords: [] };
	}

	return {
		score: Number(totalScore.toFixed(2)),
		matchedKeywords,
	};
}

export function scorePaperAgainstKeywords(
	paper: CollectionPaperItem,
	activeKeywords: readonly (RecommendKeywordChip | string)[],
): { score: number; matchedKeywords: string[] } {
	const prepared = prepareQueryKeywords(activeKeywords);
	if (prepared.length === 0) {
		return { score: 0, matchedKeywords: [] };
	}
	const fields = getPrecomputedPaperFields(paper);
	return scoreFieldsAgainstPreparedKeywords(fields, prepared);
}

export async function recommendFromCollection(options?: {
	maxBatchSize?: number;
	ensureCollectionLoaded?: boolean;
	excludeIds?: ReadonlySet<string>;
}): Promise<{
	state: RecommendPoolState;
	items: RecommendedPaperItem[];
	selectedKeywords: string[];
}> {
	const maxBatchSize = options?.maxBatchSize ?? DEFAULT_RECOMMEND_BATCH_SIZE;
	const initialState = loadRecommendPoolState();
	const mergedState = mergeCloudTermsIntoRecentKeywords(initialState);
	const selectedKeywords = getActiveSelectedTerms(mergedState);

	if (selectedKeywords.length === 0 || maxBatchSize <= 0) {
		if (mergedState !== initialState) {
			saveRecommendPoolState(mergedState);
		}
		return {
			state: mergedState,
			items: [],
			selectedKeywords,
		};
	}

	let collection = loadCollectionState();
	if (options?.ensureCollectionLoaded !== false) {
		collection = await hydrateCollectionStateFromIdb();
	}

	if (pendingLegacyMigration) {
		const mig = pendingLegacyMigration;
		pendingLegacyMigration = null;
		collection = await markCollectionPapersRecommended(
			mig.ids,
			mig.recommendedAt,
		);
	}

	const index = getOrBuildCorpusIndex(
		collection.items,
		collection.lastRefreshedAt,
	);
	const prepared = prepareQueryKeywords(selectedKeywords);
	const excludeIds = options?.excludeIds;

	const candidates: Array<{
		paper: CollectionPaperItem;
		score: number;
		matchedKeywords: string[];
	}> = [];

	for (const doc of index.docs) {
		if (doc.recommended) continue;
		if (excludeIds?.has(doc.paper.id)) continue;

		const { score, matchedKeywords } = scoreFieldsAgainstPreparedKeywords(
			doc.fields,
			prepared,
		);
		if (score > 0 && matchedKeywords.length > 0) {
			candidates.push({
				paper: doc.paper,
				score,
				matchedKeywords,
			});
		}
	}

	candidates.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return b.paper.publishedAt.localeCompare(a.paper.publishedAt);
	});

	const selected = candidates.slice(0, maxBatchSize);
	if (selected.length === 0) {
		saveRecommendPoolState(mergedState);
		return {
			state: mergedState,
			items: [],
			selectedKeywords,
		};
	}

	const nowIso = new Date().toISOString();
	const selectedIds = selected.map((c) => c.paper.id);
	const updatedCollection = await markCollectionPapersRecommended(
		selectedIds,
		nowIso,
	);

	// Incrementally update corpus index `unrecommendedCount` for the newly recommended batch
	getOrBuildCorpusIndex(
		updatedCollection.items,
		updatedCollection.lastRefreshedAt,
	);

	const updatedById = new Map<string, CollectionPaperItem>();
	const selectedIdSet = new Set(selectedIds);
	for (const item of updatedCollection.items) {
		if (selectedIdSet.has(item.id)) {
			updatedById.set(item.id, item);
		}
	}

	const items: RecommendedPaperItem[] = selected.map((c) => {
		const basePaper = updatedById.get(c.paper.id) ?? {
			...c.paper,
			recommendedAt: c.paper.recommendedAt ?? nowIso,
		};
		return {
			...basePaper,
			matchedKeywords: c.matchedKeywords,
			score: c.score,
		};
	});

	const nextState: RecommendPoolState = {
		...mergedState,
		lastRecommendedAt: nowIso,
	};
	saveRecommendPoolState(nextState);

	return {
		state: nextState,
		items,
		selectedKeywords,
	};
}
