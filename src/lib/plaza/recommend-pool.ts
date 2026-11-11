/**
 * Plaza — Paper Recommend Engine (Keyword-driven push from Paper Collection).
 *
 * Matches active user keyword chips against the 2026 Paper Collection pool
 * (`cs.AI`, `cs.CR`, `cs.PL`, `cs.SE` + top Venues).
 *
 * Guarantees non-repeating pushes: every pushed paper ID is persisted in the
 * recommendation history so subsequent pushes only surface unseen papers.
 * Supports two views:
 * - `recent`: the latest push batch
 * - `full`: all historically recommended papers
 */

import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import {
	type CollectionPaperItem,
	hydrateCollectionStateFromIdb,
	loadCollectionState,
} from "@/lib/plaza/collection";

export type RecommendKeywordChip = {
	id: string;
	term: string;
	enabled: boolean;
};

export type PushedRecommendPaper = CollectionPaperItem & {
	matchedKeywords: string[];
	score: number;
	pushedAt: string;
	batchId: string;
};

export type RecommendPoolState = {
	keywords: RecommendKeywordChip[];
	/** Most recent push batch IDs (subset of `history`). */
	recentBatchId: string | null;
	/** Complete deduplicated history of pushed papers, newest push first. */
	history: PushedRecommendPaper[];
	/** Canonical set of all paper IDs ever pushed (never pushed again). */
	pushedIds: string[];
	lastPushedAt: string | null;
};

const STORAGE_KEY = "plaza:recommend:pool-state:v1";

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

export function loadRecommendPoolState(): RecommendPoolState {
	const raw = readJsonStorage<Partial<RecommendPoolState> | null>(
		STORAGE_KEY,
		memoryPoolState,
	);
	const keywords =
		Array.isArray(raw?.keywords) && raw.keywords.length > 0
			? raw.keywords
			: [...DEFAULT_RECOMMEND_KEYWORDS];
	const history = Array.isArray(raw?.history) ? raw.history : [];
	const pushedIds = Array.isArray(raw?.pushedIds)
		? raw.pushedIds
		: history.map((h) => h.id);
	return {
		keywords,
		recentBatchId:
			typeof raw?.recentBatchId === "string" ? raw.recentBatchId : null,
		history,
		pushedIds,
		lastPushedAt:
			typeof raw?.lastPushedAt === "string" ? raw.lastPushedAt : null,
	};
}

export function saveRecommendPoolState(state: RecommendPoolState): void {
	memoryPoolState = state;
	writeJsonStorage(STORAGE_KEY, state);
}

/**
 * Score a CollectionPaperItem against active keyword chips.
 * Title hits weigh 3.0x, abstract/category hits weigh 1.0x.
 */
export function scorePaperAgainstKeywords(
	paper: CollectionPaperItem,
	activeKeywords: readonly RecommendKeywordChip[],
): { score: number; matchedKeywords: string[] } {
	const titleLower = paper.title.toLowerCase();
	const abstractLower = paper.abstract.toLowerCase();
	const catLower = paper.categories.join(" ").toLowerCase();

	let totalScore = 0;
	const matchedKeywords: string[] = [];

	for (const kw of activeKeywords) {
		if (!kw.enabled) continue;
		const phrase = kw.term.trim().toLowerCase();
		if (!phrase) continue;
		const tokens = phrase.split(/\s+/).filter((t) => t.length >= 2);

		let kwScore = 0;
		if (titleLower.includes(phrase)) {
			kwScore += 4.0;
		} else if (
			tokens.length > 1 &&
			tokens.every((t) => titleLower.includes(t))
		) {
			kwScore += 3.0;
		} else {
			for (const token of tokens) {
				if (titleLower.includes(token)) kwScore += 1.2;
			}
		}

		if (abstractLower.includes(phrase)) {
			kwScore += 1.8;
		} else if (
			tokens.length > 1 &&
			tokens.every((t) => abstractLower.includes(t))
		) {
			kwScore += 1.2;
		} else {
			for (const token of tokens) {
				if (abstractLower.includes(token)) kwScore += 0.4;
			}
		}

		if (catLower.includes(phrase)) {
			kwScore += 1.0;
		}

		// Require a meaningful match threshold so unrelated papers aren't matched by a single generic token
		const minThreshold = tokens.length > 1 ? 1.2 : 1.0;
		if (kwScore >= minThreshold) {
			totalScore += kwScore;
			matchedKeywords.push(kw.term);
		}
	}

	return {
		score: Number(totalScore.toFixed(2)),
		matchedKeywords,
	};
}

/**
 * Push a new batch of recommended papers from `Paper Collection` based on active
 * keywords, strictly excluding any paper ID that has already been pushed in history.
 */
export async function pushFromCollection(options?: {
	maxBatchSize?: number;
	ensureCollectionLoaded?: boolean;
}): Promise<{
	state: RecommendPoolState;
	newlyPushedCount: number;
}> {
	const maxBatchSize = options?.maxBatchSize ?? 24;
	const state = loadRecommendPoolState();
	const activeKeywords = state.keywords.filter((k) => k.enabled);

	let collection = loadCollectionState();
	if (
		collection.items.length === 0 &&
		options?.ensureCollectionLoaded !== false
	) {
		collection = await hydrateCollectionStateFromIdb();
	}

	const pushedSet = new Set(state.pushedIds);
	const candidates: Array<{
		paper: CollectionPaperItem;
		score: number;
		matchedKeywords: string[];
	}> = [];

	for (const paper of collection.items) {
		if (pushedSet.has(paper.id)) continue;
		const { score, matchedKeywords } = scorePaperAgainstKeywords(
			paper,
			activeKeywords,
		);
		if (score > 0 && matchedKeywords.length > 0) {
			candidates.push({ paper, score, matchedKeywords });
		}
	}

	candidates.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return b.paper.publishedAt.localeCompare(a.paper.publishedAt);
	});

	const selected = candidates.slice(0, maxBatchSize);
	if (selected.length === 0) {
		return { state, newlyPushedCount: 0 };
	}

	const nowIso = new Date().toISOString();
	const batchId = `batch-${Date.now()}`;
	const newPushedItems: PushedRecommendPaper[] = selected.map((c) => ({
		...c.paper,
		score: c.score,
		matchedKeywords: c.matchedKeywords,
		pushedAt: nowIso,
		batchId,
	}));

	const nextHistory = [...newPushedItems, ...state.history];
	const nextPushedIds = Array.from(
		new Set([...state.pushedIds, ...newPushedItems.map((i) => i.id)]),
	);

	const nextState: RecommendPoolState = {
		...state,
		recentBatchId: batchId,
		history: nextHistory,
		pushedIds: nextPushedIds,
		lastPushedAt: nowIso,
	};
	saveRecommendPoolState(nextState);
	return {
		state: nextState,
		newlyPushedCount: newPushedItems.length,
	};
}
