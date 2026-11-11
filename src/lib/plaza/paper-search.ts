/**
 * Plaza — Paper Discover local search engine over `Paper Collection`.
 *
 * Powers `Fast Search`:
 * - Searches strictly within `CollectionPaperItem[]` across `title`, `abstract`, and `keywords`
 * - Boolean syntax: space-separated `AND`, `"exact phrase"`, `OR` / `|`, and `-exclude`
 * - Advanced range filters: Time (`7d` / `30d` / `90d` / `all` / custom `YYYY-MM-DD`),
 *   Source (`all` / `arxiv` / `venue`), arXiv Categories, Venue Kind (`conference` / `journal`),
 *   Venue Domain (`PL/SE` / `CR` / `AI`), Specific Venues, and OR-combinable Ranks (`CCF-A`, `CCF-B`, `arxiv`)
 * - Zero PDF downloads or external scraping during search.
 */

import type {
	CollectionPaperItem,
	CollectionSourceType,
	VenueDomain,
	VenueKind,
} from "@/lib/plaza/collection";

export type FastSearchField = "title" | "abstract" | "keywords";
export type FastSearchSort = "relevance" | "newest" | "citations";
export type FastTimePreset = "all" | "7d" | "30d" | "90d" | "custom";
export type FastRankFilter = "CCF-A" | "CCF-B" | "arxiv";

export type FastSearchFilters = {
	timePreset: FastTimePreset;
	dateFrom: string;
	dateTo: string;
	sourceType: "all" | CollectionSourceType;
	categories: string[];
	venues: string[];
	venueKind: "all" | VenueKind;
	venueDomain: "all" | VenueDomain;
	ccfRanks: FastRankFilter[];
	fields: FastSearchField[];
	sort: FastSearchSort;
};

export const DEFAULT_FAST_SEARCH_FILTERS: FastSearchFilters = {
	timePreset: "all",
	dateFrom: "",
	dateTo: "",
	sourceType: "all",
	categories: [],
	venues: [],
	venueKind: "all",
	venueDomain: "all",
	ccfRanks: [],
	fields: ["title", "abstract", "keywords"],
	sort: "relevance",
};

export type ScoredCollectionPaper = {
	paper: CollectionPaperItem;
	score: number;
	matchedFields: FastSearchField[];
};

export type FastSearchResult = {
	items: ScoredCollectionPaper[];
	totalMatched: number;
	activeFilterCount: number;
};

export type BooleanQueryTerm = {
	text: string;
	phrase: boolean;
	negated: boolean;
};

export type ParsedBooleanQuery = {
	/** Disjunction (`OR`) of conjunction (`AND`) term lists. */
	branches: BooleanQueryTerm[][];
};

/**
 * Parse boolean search syntax:
 * - Space-separated words form an `AND` conjunction
 * - `"exact phrase"` matches contiguous phrase
 * - `OR` or `|` splits disjunction branches
 * - `-term` or `-"exact phrase"` excludes matching papers globally
 */
export function parseBooleanSearchQuery(raw: string): ParsedBooleanQuery {
	const trimmed = raw.trim();
	if (!trimmed) return { branches: [] };

	const rawTokens: Array<{ text: string; phrase: boolean; negated: boolean }> =
		[];
	let i = 0;
	while (i < trimmed.length) {
		while (i < trimmed.length && /\s/.test(trimmed[i])) i += 1;
		if (i >= trimmed.length) break;

		let negated = false;
		if (
			trimmed[i] === "-" &&
			i + 1 < trimmed.length &&
			!/\s/.test(trimmed[i + 1])
		) {
			negated = true;
			i += 1;
		}

		if (trimmed[i] === '"') {
			i += 1;
			const start = i;
			while (i < trimmed.length && trimmed[i] !== '"') i += 1;
			const phrase = trimmed.slice(start, i).trim().toLowerCase();
			if (i < trimmed.length && trimmed[i] === '"') i += 1;
			if (phrase) {
				rawTokens.push({ text: phrase, phrase: true, negated });
			}
		} else {
			const start = i;
			while (i < trimmed.length && !/\s/.test(trimmed[i])) i += 1;
			const word = trimmed.slice(start, i).trim();
			if (word) {
				rawTokens.push({ text: word, phrase: false, negated });
			}
		}
	}

	const branches: BooleanQueryTerm[][] = [[]];
	const globalNegations: BooleanQueryTerm[] = [];

	for (const tok of rawTokens) {
		if (
			!tok.phrase &&
			!tok.negated &&
			(tok.text === "OR" || tok.text === "|")
		) {
			if (branches[branches.length - 1].length > 0) {
				branches.push([]);
			}
			continue;
		}
		if (
			!tok.phrase &&
			!tok.negated &&
			(tok.text === "AND" || tok.text === "&")
		) {
			continue;
		}
		const term: BooleanQueryTerm = {
			text: tok.text.toLowerCase(),
			phrase: tok.phrase || tok.text.includes(" ") || tok.text.includes("-"),
			negated: tok.negated,
		};
		if (term.negated) {
			globalNegations.push(term);
		} else {
			branches[branches.length - 1].push(term);
		}
	}

	const nonEmpty = branches.filter((b) => b.length > 0);
	if (nonEmpty.length === 0) {
		return globalNegations.length > 0
			? { branches: [globalNegations] }
			: { branches: [] };
	}
	return {
		branches: nonEmpty.map((b) => [...b, ...globalNegations]),
	};
}

export function countActiveFastFilters(filters: FastSearchFilters): number {
	let count = 0;
	if (filters.timePreset !== "all") count += 1;
	if (filters.sourceType !== "all") count += 1;
	if (filters.categories.length > 0) count += 1;
	if (filters.venues.length > 0) count += 1;
	if (filters.venueKind !== "all") count += 1;
	if (filters.venueDomain !== "all") count += 1;
	if (filters.ccfRanks.length > 0) count += 1;
	if (filters.fields.length > 0 && filters.fields.length < 3) count += 1;
	return count;
}

function resolveDateBounds(
	filters: FastSearchFilters,
	items: CollectionPaperItem[],
): { fromYmd: string | null; toYmd: string | null } {
	if (filters.timePreset === "all") {
		return { fromYmd: null, toYmd: null };
	}
	if (filters.timePreset === "custom") {
		const fromYmd = filters.dateFrom.trim().slice(0, 10) || null;
		const toYmd = filters.dateTo.trim().slice(0, 10) || null;
		return { fromYmd, toYmd };
	}

	const days =
		filters.timePreset === "7d" ? 7 : filters.timePreset === "30d" ? 30 : 90;
	let latestMs = 0;
	for (const item of items) {
		const ms = Date.parse(item.publishedAt);
		if (Number.isFinite(ms) && ms > latestMs) latestMs = ms;
	}
	const anchor = latestMs > 0 ? latestMs : Date.now();
	const cutoff = new Date(anchor - days * 86_400_000)
		.toISOString()
		.slice(0, 10);
	return { fromYmd: cutoff, toYmd: null };
}

function matchesFastFilters(
	paper: CollectionPaperItem,
	filters: FastSearchFilters,
	fromYmd: string | null,
	toYmd: string | null,
): boolean {
	if (filters.sourceType !== "all" && paper.sourceType !== filters.sourceType) {
		return false;
	}

	if (filters.categories.length > 0 && paper.sourceType === "arxiv") {
		const catSet = new Set(filters.categories.map((c) => c.toLowerCase()));
		const matchedCat =
			catSet.has(paper.sourceLabel.toLowerCase()) ||
			paper.categories.some((c) => catSet.has(c.toLowerCase()));
		if (!matchedCat) return false;
	}

	if (filters.venues.length > 0 && paper.sourceType === "venue") {
		const venueSet = new Set(filters.venues.map((v) => v.toLowerCase()));
		const matchedVenue =
			(paper.venueId != null && venueSet.has(paper.venueId.toLowerCase())) ||
			venueSet.has(paper.sourceLabel.toLowerCase());
		if (!matchedVenue) return false;
	}

	if (filters.venueKind !== "all") {
		if (paper.sourceType !== "venue") return false;
		if (paper.venueKind !== filters.venueKind) return false;
	}

	if (filters.venueDomain !== "all") {
		if (paper.sourceType !== "venue") return false;
		if (paper.venueDomain !== filters.venueDomain) return false;
	}

	if (filters.ccfRanks.length > 0) {
		const rankMatched = filters.ccfRanks.some((r) => {
			if (r === "arxiv") return paper.sourceType === "arxiv";
			return paper.ccfRank === r;
		});
		if (!rankMatched) return false;
	}

	const pubYmd = paper.publishedAt.slice(0, 10);
	if (pubYmd) {
		if (fromYmd && pubYmd < fromYmd) return false;
		if (toYmd && pubYmd > toYmd) return false;
	}

	return true;
}

function scorePaperAgainstQuery(
	paper: CollectionPaperItem,
	parsed: ParsedBooleanQuery,
	enabledFields: ReadonlySet<FastSearchField>,
): { score: number; matchedFields: FastSearchField[] } | null {
	if (parsed.branches.length === 0) {
		return { score: 1, matchedFields: [] };
	}

	const checkTitle = enabledFields.has("title");
	const checkKeywords = enabledFields.has("keywords");
	const checkAbstract = enabledFields.has("abstract");

	const titleLc = checkTitle ? paper.title.toLowerCase() : "";
	const kwLc = checkKeywords
		? `${(paper.keywords ?? []).join(" ")} ${paper.categories.join(" ")}`.toLowerCase()
		: "";
	const absLc = checkAbstract ? paper.abstract.toLowerCase() : "";

	let bestScore: number | null = null;
	let bestFields: FastSearchField[] = [];

	for (const branch of parsed.branches) {
		let ok = true;
		let score = 0;
		let hasPositive = false;
		const hitSet = new Set<FastSearchField>();

		for (const term of branch) {
			const inTitle = checkTitle && titleLc.includes(term.text);
			const inKw = checkKeywords && kwLc.includes(term.text);
			const inAbs = checkAbstract && absLc.includes(term.text);
			const matched = inTitle || inKw || inAbs;

			if (term.negated) {
				if (matched) {
					ok = false;
					break;
				}
			} else {
				hasPositive = true;
				if (!matched) {
					ok = false;
					break;
				}
				if (inTitle) {
					hitSet.add("title");
					score += term.phrase ? 8.0 : 3.5;
				}
				if (inKw) {
					hitSet.add("keywords");
					score += term.phrase ? 6.0 : 3.0;
				}
				if (inAbs) {
					hitSet.add("abstract");
					score += term.phrase ? 2.5 : 1.2;
				}
			}
		}

		if (ok) {
			const finalScore = hasPositive ? score : 1.0;
			if (bestScore === null || finalScore > bestScore) {
				bestScore = finalScore;
				bestFields = Array.from(hitSet);
			}
		}
	}

	if (bestScore === null) return null;
	return {
		score: Math.round(bestScore * 100) / 100,
		matchedFields: bestFields,
	};
}

/**
 * Execute synchronous, weighted local search over `Paper Collection` items.
 */
export function searchCollectionFast(
	items: CollectionPaperItem[],
	query: string,
	partialFilters?: Partial<FastSearchFilters>,
): FastSearchResult {
	const filters: FastSearchFilters = {
		...DEFAULT_FAST_SEARCH_FILTERS,
		...partialFilters,
	};
	const effectiveFields =
		filters.fields.length > 0
			? new Set<FastSearchField>(filters.fields)
			: new Set<FastSearchField>(["title", "abstract", "keywords"]);
	const parsed = parseBooleanSearchQuery(query);
	const { fromYmd, toYmd } = resolveDateBounds(filters, items);

	const scored: ScoredCollectionPaper[] = [];
	for (const paper of items) {
		if (!matchesFastFilters(paper, filters, fromYmd, toYmd)) continue;
		const hit = scorePaperAgainstQuery(paper, parsed, effectiveFields);
		if (!hit) continue;
		scored.push({
			paper,
			score: hit.score,
			matchedFields: hit.matchedFields,
		});
	}

	const hasQuery = parsed.branches.length > 0;
	const effectiveSort: FastSearchSort =
		!hasQuery && filters.sort === "relevance" ? "newest" : filters.sort;

	scored.sort((a, b) => {
		if (effectiveSort === "citations") {
			const diff = (b.paper.citationCount ?? 0) - (a.paper.citationCount ?? 0);
			if (diff !== 0) return diff;
			return b.paper.publishedAt.localeCompare(a.paper.publishedAt);
		}
		if (effectiveSort === "newest") {
			const cmp = b.paper.publishedAt.localeCompare(a.paper.publishedAt);
			if (cmp !== 0) return cmp;
			return (b.paper.citationCount ?? 0) - (a.paper.citationCount ?? 0);
		}
		// relevance
		if (b.score !== a.score) return b.score - a.score;
		const citeDiff =
			(b.paper.citationCount ?? 0) - (a.paper.citationCount ?? 0);
		if (citeDiff !== 0) return citeDiff;
		return b.paper.publishedAt.localeCompare(a.paper.publishedAt);
	});

	return {
		items: scored,
		totalMatched: scored.length,
		activeFilterCount: countActiveFastFilters(filters),
	};
}
