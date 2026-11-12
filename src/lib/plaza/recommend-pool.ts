/**
 * Plaza — Paper Recommend Engine (Keyword Hub + Word Cloud + SQLite-backed Push).
 *
 * Matches active user keywords (Recent Keywords + All Keywords Word Cloud) against
 * the unified `collection.sqlite` pool (`arXiv` + 28 DBLP Venues) via Tauri IPC.
 *
 * Architecture:
 * - Zero `localStorage` persistence and zero in-memory `CorpusIndex` / `WeakMap` retention.
 * - Keyword chips, selected cloud terms, Top-N setting, `lastRecommendedAt`, and per-paper
 *   `recommended_at` timestamps live in `collection.sqlite`.
 * - Pure chip manipulation and keyword scoring helpers remain statelessly exported for UI
 *   optimistic updates and unit tests.
 */

import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import {
	type CollectionPaperItem,
	derivePaperKeywords,
} from "@/lib/plaza/collection-enrichment";
import {
	bumpCollectionRevision,
	type CollectionStateSummary,
	clearCollection,
	fromPaperSummaryDto,
} from "@/lib/plaza/collection-store";

export const DEFAULT_RECOMMEND_BATCH_SIZE = 15;
export const DEFAULT_WORD_CLOUD_TOP_N = 50;
export const MIN_WORD_CLOUD_TOP_N = 15;
export const MAX_WORD_CLOUD_TOP_N = 150;

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

export type CollectionWordCloudResult = {
	keywords: WordCloudKeyword[];
	totalUniqueKeywords: number;
	totalCandidatePapers: number;
	unrecommendedPaperCount: number;
};

export type RecommendNextResult = {
	items: RecommendedPaperItem[];
	state: RecommendPoolState;
	selectedKeywords: string[];
	exhausted: boolean;
	remainingUnrecommended: number;
};

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

export function createDefaultRecommendPoolState(): RecommendPoolState {
	return sanitizeRecommendPoolState(null);
}

// ─── Async IPC Wrappers (`commands.plazaCollection*`) ───

export async function fetchRecommendPoolState(): Promise<RecommendPoolState> {
	const dto = await callApi(() => commands.plazaCollectionRecommendStateGet(), {
		fallback: "Failed to load paper recommend state",
	});
	return sanitizeRecommendPoolState(dto);
}

export async function saveRecommendPoolState(
	state: RecommendPoolState,
): Promise<RecommendPoolState> {
	const clean = sanitizeRecommendPoolState(state);
	const dto = await callApi(
		() =>
			commands.plazaCollectionRecommendStateSet({
				keywords: clean.keywords,
				selectedCloudTerms: clean.selectedCloudTerms,
				wordCloudTopN: clean.wordCloudTopN,
				lastRecommendedAt: clean.lastRecommendedAt,
			}),
		{ fallback: "Failed to save paper recommend state" },
	);
	return sanitizeRecommendPoolState(dto);
}

export async function fetchCollectionWordCloud(
	topN?: number,
): Promise<CollectionWordCloudResult> {
	const dto = await callApi(
		() =>
			commands.plazaCollectionWordCloud({
				topN: topN !== undefined ? clampWordCloudTopN(topN) : null,
			}),
		{ fallback: "Failed to load collection word cloud" },
	);
	return {
		keywords: dto.keywords.map((kw) => ({
			term: kw.term,
			normalized: kw.normalized,
			count: kw.count,
			unrecommendedCount: kw.unrecommendedCount,
		})),
		totalUniqueKeywords: dto.totalUniqueKeywords,
		totalCandidatePapers: dto.totalCandidatePapers,
		unrecommendedPaperCount: dto.unrecommendedPaperCount,
	};
}

export async function recommendNextFromCollection(
	maxBatchSize: number = DEFAULT_RECOMMEND_BATCH_SIZE,
): Promise<RecommendNextResult> {
	const dto = await callApi(
		() =>
			commands.plazaCollectionRecommendNext({
				maxBatchSize,
			}),
		{ fallback: "Failed to recommend papers from collection" },
	);
	const state = sanitizeRecommendPoolState(dto.state);
	const items: RecommendedPaperItem[] = dto.items.map((entry) => ({
		...fromPaperSummaryDto(entry.paper),
		matchedKeywords: entry.matchedKeywords,
		score: entry.score ?? 0,
	}));
	if (items.length > 0) {
		bumpCollectionRevision();
	}
	return {
		items,
		state,
		selectedKeywords: getActiveSelectedTerms(state),
		exhausted: dto.exhausted,
		remainingUnrecommended: dto.remainingUnrecommended,
	};
}

export async function resetRecommendedHistory(): Promise<CollectionStateSummary> {
	return clearCollection("recommended");
}

// ─── Pure Keyword Selection & Recent Chips Helpers ───

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

// ─── Stateless Casing, Word Cloud & Keyword Scoring Helpers ───

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

type ComputedPaperFields = {
	extractedKeywords: PaperExtractedKeyword[];
	normalizedKeywordSet: ReadonlySet<string>;
	keywordsJoinedLower: string;
	titleLower: string;
	abstractLower: string;
	catLower: string;
	combinedLower: string;
};

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

function computePaperFields(paper: CollectionPaperItem): ComputedPaperFields {
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

	return {
		extractedKeywords,
		normalizedKeywordSet,
		keywordsJoinedLower,
		titleLower,
		abstractLower,
		catLower,
		combinedLower,
	};
}

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

/**
 * Pure, stateless word-cloud keyword extractor (zero module-level cache retention;
 * useful for unit tests and non-Tauri environments).
 */
export function getWordCloudKeywords(
	items: readonly CollectionPaperItem[],
	topN?: number,
): { keywords: WordCloudKeyword[]; totalUniqueKeywords: number } {
	const buckets = new Map<
		string,
		{
			count: number;
			unrecommendedCount: number;
			variants: Map<string, number>;
		}
	>();

	for (const paper of items) {
		const extracted = extractPaperKeywordsNormalized(paper);
		const recommended = Boolean(paper.recommendedAt);
		for (const kw of extracted) {
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

	const sortedKeywords: WordCloudKeyword[] = [];
	for (const [normalized, bucket] of buckets) {
		sortedKeywords.push({
			term: pickBestDisplayCasing(bucket.variants, normalized),
			normalized,
			count: bucket.count,
			unrecommendedCount: bucket.unrecommendedCount,
		});
	}
	sortedKeywords.sort(compareWordCloudKeywords);

	const limit =
		topN === undefined
			? DEFAULT_WORD_CLOUD_TOP_N
			: Math.max(0, Math.round(topN));
	return {
		keywords: sortedKeywords.slice(0, limit),
		totalUniqueKeywords: sortedKeywords.length,
	};
}

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
	fields: ComputedPaperFields,
	prepared: readonly PreparedQueryKeyword[],
): { score: number; matchedKeywords: string[] } {
	if (prepared.length === 0) {
		return { score: 0, matchedKeywords: [] };
	}

	let totalScore = 0;
	let matchedKeywords: string[] | null = null;

	for (const kw of prepared) {
		const { phrase, tokens, minThreshold } = kw;

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

		// 1. Paper-level keywords
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
	const fields = computePaperFields(paper);
	return scoreFieldsAgainstPreparedKeywords(fields, prepared);
}
