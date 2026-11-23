import { vi } from "vitest";
import {
	type CollectionArxivLatest,
	type CollectionArxivWatermark,
	type CollectionClearArgs,
	type CollectionConfigUpdateArgs,
	type CollectionListPapersArgs,
	type CollectionOverviewOut,
	type CollectionPaperDetail,
	type CollectionPaperIdArgs,
	type CollectionPaperIdsArgs,
	type CollectionPaperLineageArgs,
	type CollectionPaperLineageOut,
	type CollectionPaperSummary,
	type CollectionPapersPage,
	type CollectionPatchPapersArgs,
	type CollectionSearchArgs,
	type CollectionSearchResult,
	type CollectionSeedSyncArgs,
	type CollectionSeedSyncOut,
	type CollectionStateSummary,
	type CollectionSubgraphArgs,
	type CollectionSubgraphOut,
	type CollectionUpsertPapersArgs,
	type CollectionVaultPaperMatch,
	type CollectionVenueRecord,
	type CollectionWordCloudArgs,
	commands,
	type RecommendNextArgs,
	type RecommendNextOut,
	type RecommendPoolStateDto,
	type RecommendPoolStateInput,
	type WordCloudOut,
} from "@/lib/core/bindings";
import {
	applyFreshVenueItems,
	type CollectionPaperItem,
	DEFAULT_ARXIV_CATEGORIES,
	DEFAULT_COLLECTION_VENUES,
	formatPaperBibtex,
	formatPaperCitationText,
	isPlaceholderAbstract,
	type KeywordSource,
	matchesAnyArxivCategory,
	mergeCollectionItems,
	normalizePaperKeywords,
	type VenueConfig,
} from "@/lib/plaza/collection";
import { sameCollectionPaperWork } from "@/lib/plaza/paper-identity";
import {
	comparePreferredVenueItem,
	type FastRankFilter,
	type FastSearchField,
	type FastSearchSort,
	type FastTimePreset,
	mergeArxivIntoVenueItem,
	searchCollectionFast,
} from "@/lib/plaza/paper-search";
import {
	addCustomRecentKeyword,
	createDefaultRecommendPoolState,
	DEFAULT_RECOMMEND_BATCH_SIZE,
	DEFAULT_WORD_CLOUD_TOP_N,
	getActiveSelectedTerms,
	getWordCloudKeywords,
	type RecommendPoolState,
	scorePaperAgainstKeywords,
} from "@/lib/plaza/recommend-pool";

function toPaperSummaryDto(item: CollectionPaperItem): CollectionPaperSummary {
	return {
		id: item.id,
		title: item.title,
		authors: [...item.authors],
		abstract: item.abstract,
		publishedAt: item.publishedAt,
		year: item.year,
		sourceType: item.sourceType,
		sourceLabel: item.sourceLabel,
		categories: [...item.categories],
		url: item.url,
		pdfUrl: item.pdfUrl ?? null,
		arxivId: item.arxivId ?? null,
		doi: item.doi ?? null,
		venueId: item.venueId ?? null,
		venueKind: item.venueKind ?? null,
		venueDomain: item.venueDomain ?? null,
		ccfRank: item.ccfRank ?? null,
		venueFull: item.venueFull ?? null,
		citationCount: item.citationCount ?? 0,
		keywords: [...(item.keywords ?? [])],
		keywordSource: item.keywordSource ?? null,
		volume: item.volume ?? null,
		issue: item.issue ?? null,
		pages: item.pages ?? null,
		coolPapersId: item.coolPapersId ?? null,
		recommendedAt: item.recommendedAt ?? null,
		linkedPeer: item.linkedPeer
			? {
					id: item.linkedPeer.id,
					sourceType: item.linkedPeer.sourceType,
					sourceLabel: item.linkedPeer.sourceLabel,
					categories: [...item.linkedPeer.categories],
					venueId: item.linkedPeer.venueId ?? null,
					venueKind: item.linkedPeer.venueKind ?? null,
					ccfRank: item.linkedPeer.ccfRank ?? null,
				}
			: null,
	};
}

function toPaperDetailDto(item: CollectionPaperItem): CollectionPaperDetail {
	const summary = toPaperSummaryDto(item);
	const bibtex = item.bibtex || formatPaperBibtex(item);
	return {
		...summary,
		bibtex,
		citationText: formatPaperCitationText(item),
	};
}

function parseKeywordSource(raw?: string | null): KeywordSource | undefined {
	if (raw === "author" || raw === "maintainer_llm" || raw === "client_llm") {
		return raw;
	}
	return undefined;
}

function keywordSourceRank(src?: KeywordSource): number {
	if (src === "author") return 3;
	if (src === "maintainer_llm") return 2;
	if (src === "client_llm") return 1;
	return 0;
}

function normalizeRefTokensForItem(item: {
	doi?: string | null;
	arxivId?: string | null;
	openalexId?: string | null;
}): string[] {
	const tokens: string[] = [];
	const doi = item.doi?.trim().toLowerCase();
	if (doi) {
		tokens.push(`doi:${doi}`);
		const axMatch = doi.match(/^10\.48550\/arxiv\.(.+)$/i);
		if (axMatch?.[1]) {
			tokens.push(`arxiv:${axMatch[1].replace(/v\d+$/i, "")}`);
		}
	}
	const ax = item.arxivId?.trim().toLowerCase().replace(/v\d+$/i, "");
	if (ax) {
		tokens.push(`arxiv:${ax}`);
	}
	const oa = item.openalexId
		?.trim()
		.replace(/^https?:\/\/openalex\.org\//i, "")
		.toUpperCase();
	if (oa) {
		tokens.push(`openalex:${oa}`);
	}
	return Array.from(new Set(tokens));
}

function normalizeRawRefToken(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const lower = trimmed.toLowerCase();
	if (lower.startsWith("doi:")) {
		const val = lower.slice(4).trim();
		return val ? `doi:${val}` : null;
	}
	if (lower.startsWith("arxiv:")) {
		const val = lower.slice(6).trim().replace(/v\d+$/i, "");
		return val ? `arxiv:${val}` : null;
	}
	if (lower.startsWith("openalex:")) {
		const val = trimmed
			.slice(9)
			.trim()
			.replace(/^https?:\/\/openalex\.org\//i, "")
			.toUpperCase();
		return val ? `openalex:${val}` : null;
	}
	if (/^w\d+$/i.test(trimmed)) {
		return `openalex:${trimmed.toUpperCase()}`;
	}
	return lower;
}

function defaultVenueRecords(): CollectionVenueRecord[] {
	return DEFAULT_COLLECTION_VENUES.map((v) => ({
		id: v.id,
		name: v.name,
		url: v.url,
		tracks: [...(v.tracks ?? [])],
		notes: v.notes?.trim() ? v.notes.trim() : null,
		mode: v.mode,
		kind: v.kind ?? null,
		domain: v.domain ?? null,
		ccfRank: v.ccfRank ?? null,
		lastFetchedAt: v.lastFetchedAt ?? null,
		latestPublishedAt: v.latestPublishedAt ?? null,
		remoteTotalCount: v.remoteTotalCount ?? null,
		paperCount: 0,
	}));
}

export type MockVaultCatalogPaper = {
	relPath: string;
	title: string;
	doi?: string | null;
	arxivId?: string | null;
};

export type MockSeedShard = {
	id: string;
	kind: "core" | "addon" | "delta";
	category?: string;
	items: CollectionPaperItem[];
};

export type MockCollectionDbSeed = {
	categories?: string[];
	venues?: VenueConfig[];
	items?: CollectionPaperItem[];
	arxivWatermarks?: Record<
		string,
		{
			latestPublishedAt: string;
			latestArxivId: string;
			lastSyncedAt: string;
			oldestSyncedPublishedAt?: string;
			remoteTotal?: number;
			historyComplete?: boolean;
		}
	>;
	lastRefreshedAt?: string | null;
	latestArxiv?: CollectionArxivLatest | null;
	recommendState?: Partial<RecommendPoolState>;
	seedCleared?: boolean;
	appliedSeedIds?: string[];
	vaultPapers?: MockVaultCatalogPaper[];
	seedShards?: MockSeedShard[];
};

/**
 * Install an in-memory `collection.sqlite` mock wired onto `commands.plazaCollection*` spies.
 * Mirrors SQLite invariants: portal-scoped PKs, enabled-category scoping for `arxiv`,
 * metadata-preserving upserts/patches (never overwriting `recommendedAt` with null),
 * atomic venue replacement carrying forward `recommendedAt`, word-cloud casing,
 * non-repeating recommendation batches, pure in-pool lineage graph, and seed sync.
 */
export function installMockCollectionIpc(initial?: MockCollectionDbSeed) {
	let categories: string[] = [...DEFAULT_ARXIV_CATEGORIES];
	let venues: CollectionVenueRecord[] = defaultVenueRecords();
	let watermarks: Record<string, CollectionArxivWatermark> = {};
	let lastRefreshedAt: string | null = null;
	let latestArxiv: CollectionArxivLatest | null = null;
	let itemsById = new Map<string, CollectionPaperItem>();
	let recommendState: RecommendPoolState = createDefaultRecommendPoolState();
	let seedCleared = false;
	let appliedSeedIds: string[] = [];
	let vaultPapers: MockVaultCatalogPaper[] = [];
	let seedShards: MockSeedShard[] = [];
	let recClockSeq = 0;

	const recomputeInPoolCitations = () => {
		const all = Array.from(itemsById.values());
		const hasAnyRawRefs = all.some((p) => (p.rawRefs?.length ?? 0) > 0);
		if (!hasAnyRawRefs) return;

		// Build canonical work groups across portals
		const workIdxByPaperId = new Map<string, number>();
		const tokenToWorkIdx = new Map<string, number>();
		const workMembers: CollectionPaperItem[][] = [];

		for (const item of all) {
			let foundIdx: number | undefined;
			for (const tok of normalizeRefTokensForItem(item)) {
				const existing = tokenToWorkIdx.get(tok);
				if (existing !== undefined) {
					foundIdx = existing;
					break;
				}
			}
			if (foundIdx === undefined) {
				const bySameWork = workMembers.findIndex((members) =>
					members.some((m) => sameCollectionPaperWork(m, item)),
				);
				if (bySameWork >= 0) foundIdx = bySameWork;
			}
			if (foundIdx === undefined) {
				foundIdx = workMembers.length;
				workMembers.push([item]);
			} else {
				workMembers[foundIdx]?.push(item);
			}
			workIdxByPaperId.set(item.id, foundIdx);
			for (const tok of normalizeRefTokensForItem(item)) {
				tokenToWorkIdx.set(tok, foundIdx);
			}
		}

		const citingWorksByTarget = new Map<number, Set<number>>();
		for (const item of all) {
			const srcWork = workIdxByPaperId.get(item.id);
			if (srcWork === undefined) continue;
			for (const raw of item.rawRefs ?? []) {
				const norm = normalizeRawRefToken(raw);
				if (!norm) continue;
				const dstWork = tokenToWorkIdx.get(norm);
				if (dstWork === undefined || dstWork === srcWork) continue;
				let set = citingWorksByTarget.get(dstWork);
				if (!set) {
					set = new Set();
					citingWorksByTarget.set(dstWork, set);
				}
				set.add(srcWork);
			}
		}

		for (const [id, item] of itemsById.entries()) {
			const wIdx = workIdxByPaperId.get(id);
			const computed =
				wIdx !== undefined ? (citingWorksByTarget.get(wIdx)?.size ?? 0) : 0;
			if (computed > 0 || (item.citationCount ?? 0) === 0) {
				itemsById.set(id, { ...item, citationCount: computed });
			}
		}
	};

	const pickPreferredRepresentative = (
		members: CollectionPaperItem[],
	): CollectionPaperItem | null => {
		if (members.length === 0) return null;
		const sorted = [...members].sort((a, b) => {
			if (a.sourceType !== b.sourceType) {
				return a.sourceType === "venue" ? -1 : 1;
			}
			if (a.sourceType === "venue" && b.sourceType === "venue") {
				return comparePreferredVenueItem(a, b);
			}
			return b.publishedAt.localeCompare(a.publishedAt);
		});
		return sorted[0] ?? null;
	};

	const computeVaultMatchesForPaper = (
		paper: CollectionPaperItem,
		hasVault: boolean,
	): CollectionVaultPaperMatch[] => {
		if (!hasVault || vaultPapers.length === 0) return [];
		const matches: CollectionVaultPaperMatch[] = [];
		const selfTokens = new Set(normalizeRefTokensForItem(paper));
		const refTokens = new Set(
			(paper.rawRefs ?? [])
				.map(normalizeRawRefToken)
				.filter((t): t is string => Boolean(t)),
		);

		for (const vp of vaultPapers) {
			const vpTokens = normalizeRefTokensForItem(vp);
			if (vpTokens.some((t) => selfTokens.has(t))) {
				matches.push({
					relPath: vp.relPath,
					title: vp.title,
					doi: vp.doi ?? null,
					arxivId: vp.arxivId ?? null,
					relation: "self",
				});
			} else if (vpTokens.some((t) => refTokens.has(t))) {
				matches.push({
					relPath: vp.relPath,
					title: vp.title,
					doi: vp.doi ?? null,
					arxivId: vp.arxivId ?? null,
					relation: "referenced",
				});
			}
		}
		return matches;
	};

	const getVisibleItems = (): CollectionPaperItem[] => {
		const all = Array.from(itemsById.values());
		return all
			.filter((p) => matchesAnyArxivCategory(p, categories))
			.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
	};

	const buildSummary = (): CollectionStateSummary => {
		const allItems = Array.from(itemsById.values());
		const visible = getVisibleItems();
		let arxivCount = 0;
		let venueCount = 0;
		let conferenceCount = 0;
		let journalCount = 0;
		const categoryCounts: Record<string, number> = {};
		const venuePaperCounts = new Map<string, number>();

		for (const item of allItems) {
			if (item.sourceType === "arxiv") {
				for (const cat of new Set([item.sourceLabel, ...item.categories])) {
					if (cat) categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
				}
			} else if (item.venueId) {
				venuePaperCounts.set(
					item.venueId,
					(venuePaperCounts.get(item.venueId) ?? 0) + 1,
				);
			}
		}

		for (const item of visible) {
			if (item.sourceType === "arxiv") {
				arxivCount += 1;
			} else {
				venueCount += 1;
				if (item.venueKind === "journal") {
					journalCount += 1;
				} else {
					conferenceCount += 1;
				}
			}
		}

		const enrichedVenues = venues.map((v) => ({
			...v,
			paperCount: venuePaperCounts.get(v.id) ?? 0,
		}));

		return {
			categories: [...categories],
			venues: enrichedVenues,
			arxivWatermarks: { ...watermarks },
			lastRefreshedAt,
			latestArxiv,
			totalCount: visible.length,
			arxivCount,
			venueCount,
			conferenceCount,
			journalCount,
			categoryCounts,
			seedCleared,
			appliedSeedIds: [...appliedSeedIds],
		};
	};

	const seed = (next?: MockCollectionDbSeed) => {
		categories = next?.categories
			? [...next.categories]
			: [...DEFAULT_ARXIV_CATEGORIES];
		venues = next?.venues
			? next.venues.map((v) => ({
					id: v.id,
					name: v.name,
					url: v.url,
					tracks: [...(v.tracks ?? [])],
					notes: v.notes?.trim() ? v.notes.trim() : null,
					mode: v.mode,
					kind: v.kind ?? null,
					domain: v.domain ?? null,
					ccfRank: v.ccfRank ?? null,
					lastFetchedAt: v.lastFetchedAt ?? null,
					latestPublishedAt: v.latestPublishedAt ?? null,
					remoteTotalCount: v.remoteTotalCount ?? null,
					paperCount: v.paperCount ?? 0,
				}))
			: defaultVenueRecords();
		watermarks = {};
		if (next?.arxivWatermarks) {
			for (const [cat, wm] of Object.entries(next.arxivWatermarks)) {
				watermarks[cat] = {
					latestPublishedAt: wm.latestPublishedAt,
					latestArxivId: wm.latestArxivId,
					lastSyncedAt: wm.lastSyncedAt,
					oldestSyncedPublishedAt: wm.oldestSyncedPublishedAt ?? null,
					remoteTotal: wm.remoteTotal ?? null,
					historyComplete: Boolean(wm.historyComplete),
				};
			}
		}
		lastRefreshedAt = next?.lastRefreshedAt ?? null;
		latestArxiv = next?.latestArxiv ?? null;
		seedCleared = Boolean(next?.seedCleared);
		appliedSeedIds = next?.appliedSeedIds ? [...next.appliedSeedIds] : [];
		vaultPapers = next?.vaultPapers ? [...next.vaultPapers] : [];
		seedShards = next?.seedShards ? [...next.seedShards] : [];
		itemsById = new Map();
		for (const item of next?.items ?? []) {
			itemsById.set(item.id, { ...item });
		}
		recomputeInPoolCitations();
		recommendState = {
			...createDefaultRecommendPoolState(),
			...next?.recommendState,
		};
		recClockSeq = 0;
	};

	seed(initial);

	const spies = [
		vi
			.spyOn(commands, "plazaCollectionStateGet")
			.mockImplementation(async () => ({
				ok: true,
				data: buildSummary(),
				error: null,
			})),

		vi
			.spyOn(commands, "plazaCollectionOverview")
			.mockImplementation(async () => {
				const summary = buildSummary();
				const visible = getVisibleItems();
				let ccfA = 0;
				let ccfB = 0;
				for (const item of visible) {
					if (item.ccfRank === "CCF-A") ccfA += 1;
					else if (item.ccfRank === "CCF-B") ccfB += 1;
				}
				const dates = visible
					.map((p) => p.publishedAt.slice(0, 10))
					.filter(Boolean)
					.sort();
				const out: CollectionOverviewOut = {
					totalPapers: summary.totalCount,
					arxivCount: summary.arxivCount,
					venueCount: summary.venueCount,
					updatedAt: summary.lastRefreshedAt ?? "2026-04-01T00:00:00Z",
					earliestDate: dates[0] ?? null,
					latestDate: dates[dates.length - 1] ?? null,
					ccfDistribution: {
						ccfA,
						ccfB,
						arxivPreprint: summary.arxivCount,
						otherVenue: Math.max(0, summary.venueCount - ccfA - ccfB),
					},
					categories: summary.categories.map((key) => ({
						key,
						count: summary.categoryCounts[key] ?? 0,
					})),
					venues: summary.venues
						.filter((v) => v.paperCount > 0)
						.map((v) => ({
							id: v.id,
							label: v.name,
							domain: v.domain ?? "PL/SE",
							kind: v.kind ?? "conference",
							ccfRank: v.ccfRank ?? "CCF-A",
							count: v.paperCount,
						})),
				};
				return { ok: true, data: out, error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionConfigUpdate")
			.mockImplementation(async (args: CollectionConfigUpdateArgs) => {
				if (args.categories) {
					categories = [...args.categories];
				}
				if (args.venues) {
					const prevById = new Map(venues.map((prev) => [prev.id, prev]));
					venues = args.venues.map((v) => {
						const prev = prevById.get(v.id);
						const nextNotes =
							v.notes !== undefined && v.notes !== null
								? v.notes.trim()
									? v.notes.trim()
									: null
								: (prev?.notes ?? null);
						return {
							id: v.id,
							name: v.name,
							url: v.url,
							tracks: v.tracks ? [...v.tracks] : [...(prev?.tracks ?? [])],
							notes: nextNotes,
							mode: v.mode ?? prev?.mode ?? "auto",
							kind: v.kind ?? prev?.kind ?? null,
							domain: v.domain ?? prev?.domain ?? null,
							ccfRank: v.ccfRank ?? prev?.ccfRank ?? null,
							lastFetchedAt: v.lastFetchedAt ?? prev?.lastFetchedAt ?? null,
							latestPublishedAt:
								v.latestPublishedAt ?? prev?.latestPublishedAt ?? null,
							remoteTotalCount:
								v.remoteTotalCount ?? prev?.remoteTotalCount ?? null,
							paperCount: v.paperCount ?? prev?.paperCount ?? 0,
						};
					});
					const keepVenueIds = new Set(venues.map((v) => v.id));
					for (const [id, item] of itemsById.entries()) {
						if (
							item.sourceType === "venue" &&
							item.venueId &&
							!keepVenueIds.has(item.venueId)
						) {
							itemsById.delete(id);
						}
					}
				}
				if (args.arxivWatermarks) {
					for (const [cat, wm] of Object.entries(args.arxivWatermarks)) {
						watermarks[cat] = {
							latestPublishedAt: wm.latestPublishedAt,
							latestArxivId: wm.latestArxivId,
							lastSyncedAt: wm.lastSyncedAt,
							oldestSyncedPublishedAt: wm.oldestSyncedPublishedAt ?? null,
							remoteTotal: wm.remoteTotal ?? null,
							historyComplete: Boolean(wm.historyComplete),
						};
					}
				}
				if (
					args.lastRefreshedAt !== undefined &&
					args.lastRefreshedAt !== null
				) {
					lastRefreshedAt = args.lastRefreshedAt;
				}
				if (args.latestArxiv !== undefined && args.latestArxiv !== null) {
					latestArxiv = args.latestArxiv;
				}
				return { ok: true, data: buildSummary(), error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionUpsertPapers")
			.mockImplementation(async (args: CollectionUpsertPapersArgs) => {
				const incoming: CollectionPaperItem[] = (args.items ?? []).map(
					(dto) => ({
						id: dto.id,
						title: dto.title,
						authors: dto.authors ?? [],
						abstract: dto.abstract ?? "",
						publishedAt: dto.publishedAt ?? "2026-01-01T00:00:00Z",
						year: dto.year ?? 2026,
						sourceType: dto.sourceType === "venue" ? "venue" : "arxiv",
						sourceLabel: dto.sourceLabel,
						categories: dto.categories ?? [],
						url: dto.url ?? "",
						...(dto.pdfUrl ? { pdfUrl: dto.pdfUrl } : {}),
						...(dto.arxivId ? { arxivId: dto.arxivId } : {}),
						...(dto.doi ? { doi: dto.doi } : {}),
						...(dto.venueId ? { venueId: dto.venueId } : {}),
						...(dto.venueKind === "conference" || dto.venueKind === "journal"
							? { venueKind: dto.venueKind }
							: {}),
						...(dto.venueDomain === "PL/SE" ||
						dto.venueDomain === "CR" ||
						dto.venueDomain === "AI"
							? { venueDomain: dto.venueDomain }
							: {}),
						...(dto.ccfRank === "CCF-A" || dto.ccfRank === "CCF-B"
							? { ccfRank: dto.ccfRank }
							: {}),
						...(dto.venueFull ? { venueFull: dto.venueFull } : {}),
						citationCount: dto.citationCount ?? 0,
						keywords: dto.keywords ?? [],
						...(parseKeywordSource(dto.keywordSource)
							? { keywordSource: parseKeywordSource(dto.keywordSource) }
							: {}),
						...(dto.openalexId ? { openalexId: dto.openalexId } : {}),
						...(dto.rawRefs && dto.rawRefs.length > 0
							? { rawRefs: [...dto.rawRefs] }
							: {}),
						...(dto.volume ? { volume: dto.volume } : {}),
						...(dto.issue ? { issue: dto.issue } : {}),
						...(dto.pages ? { pages: dto.pages } : {}),
						...(dto.bibtex ? { bibtex: dto.bibtex } : {}),
						...(dto.coolPapersId ? { coolPapersId: dto.coolPapersId } : {}),
						...(dto.recommendedAt ? { recommendedAt: dto.recommendedAt } : {}),
					}),
				);

				if (args.replaceVenueId) {
					const nextAll = applyFreshVenueItems(
						Array.from(itemsById.values()),
						args.replaceVenueId,
						incoming,
						args.replaceSourceLabel ?? undefined,
					);
					itemsById = new Map(nextAll.map((p) => [p.id, p]));
				} else if (incoming.length > 0) {
					const merged = mergeCollectionItems([
						Array.from(itemsById.values()),
						incoming,
					]);
					itemsById = new Map(merged.map((p) => [p.id, p]));
				}
				recomputeInPoolCitations();

				if (args.venueUpdate) {
					const u = args.venueUpdate;
					venues = venues.map((v) =>
						v.id === u.venueId
							? {
									...v,
									lastFetchedAt: u.lastFetchedAt ?? v.lastFetchedAt,
									latestPublishedAt: u.latestPublishedAt ?? v.latestPublishedAt,
									remoteTotalCount: u.remoteTotalCount ?? v.remoteTotalCount,
								}
							: v,
					);
				}

				if (args.arxivWatermarks) {
					for (const [cat, wm] of Object.entries(args.arxivWatermarks)) {
						watermarks[cat] = {
							latestPublishedAt: wm.latestPublishedAt,
							latestArxivId: wm.latestArxivId,
							lastSyncedAt: wm.lastSyncedAt,
							oldestSyncedPublishedAt: wm.oldestSyncedPublishedAt ?? null,
							remoteTotal: wm.remoteTotal ?? null,
							historyComplete: Boolean(wm.historyComplete),
						};
					}
				}
				if (args.lastRefreshedAt) {
					lastRefreshedAt = args.lastRefreshedAt;
				}
				if (args.latestArxiv) {
					latestArxiv = args.latestArxiv;
				}
				return { ok: true, data: buildSummary(), error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionPatchPapers")
			.mockImplementation(async (args: CollectionPatchPapersArgs) => {
				for (const patch of args.patches) {
					const prev = itemsById.get(patch.id);
					if (!prev) continue;
					const nextAbstract =
						patch.abstract &&
						!isPlaceholderAbstract(patch.abstract, prev.sourceLabel) &&
						(isPlaceholderAbstract(prev.abstract, prev.sourceLabel) ||
							patch.abstract.length >= prev.abstract.length)
							? patch.abstract
							: prev.abstract;
					const patchSource = parseKeywordSource(patch.keywordSource);
					const prevRank = keywordSourceRank(prev.keywordSource);
					const nextRank = keywordSourceRank(patchSource);
					const shouldAcceptKeywords =
						(prev.keywords?.length ?? 0) === 0 || nextRank >= prevRank;
					const mergedKeywords = shouldAcceptKeywords
						? normalizePaperKeywords([
								...(nextRank > prevRank ? [] : (prev.keywords ?? [])),
								...(patch.keywords ?? []),
							])
						: (prev.keywords ?? []);
					const mergedKeywordSource =
						nextRank >= prevRank && patchSource
							? patchSource
							: prev.keywordSource;
					const mergedRawRefs =
						patch.rawRefs && patch.rawRefs.length > 0
							? Array.from(new Set([...(prev.rawRefs ?? []), ...patch.rawRefs]))
							: prev.rawRefs;

					itemsById.set(patch.id, {
						...prev,
						abstract: nextAbstract,
						pdfUrl: prev.pdfUrl || patch.pdfUrl || undefined,
						arxivId: prev.arxivId || patch.arxivId || undefined,
						doi: patch.doi || prev.doi || undefined,
						venueFull: prev.venueFull || patch.venueFull || undefined,
						citationCount: Math.max(
							prev.citationCount ?? 0,
							patch.citationCount ?? 0,
						),
						keywords: mergedKeywords,
						...(mergedKeywordSource
							? { keywordSource: mergedKeywordSource }
							: {}),
						...(patch.openalexId || prev.openalexId
							? { openalexId: patch.openalexId || prev.openalexId || undefined }
							: {}),
						...(mergedRawRefs && mergedRawRefs.length > 0
							? { rawRefs: mergedRawRefs }
							: {}),
						volume: prev.volume || patch.volume || undefined,
						issue: prev.issue || patch.issue || undefined,
						pages: prev.pages || patch.pages || undefined,
						bibtex: patch.bibtex || prev.bibtex || undefined,
						coolPapersId: prev.coolPapersId || patch.coolPapersId || undefined,
						recommendedAt:
							prev.recommendedAt || patch.recommendedAt || undefined,
					});
				}
				recomputeInPoolCitations();
				return { ok: true, data: buildSummary(), error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionListPapers")
			.mockImplementation(async (args: CollectionListPapersArgs) => {
				const searched = searchCollectionFast(
					getVisibleItems(),
					"",
					{
						sourceType:
							args.sourceType === "arxiv" || args.sourceType === "venue"
								? args.sourceType
								: "all",
						categories: args.category ? [args.category] : [],
						timePreset: (args.timePreset as FastTimePreset | null) ?? "all",
						dateFrom: args.dateFrom ?? "",
						dateTo: args.dateTo ?? "",
						venueKind:
							args.venueKind === "conference" || args.venueKind === "journal"
								? args.venueKind
								: "all",
						venueDomain:
							args.venueDomain === "PL/SE" ||
							args.venueDomain === "CR" ||
							args.venueDomain === "AI"
								? args.venueDomain
								: "all",
						venues: args.venueId ? [args.venueId] : [],
						ccfRanks: (args.ccfRanks ?? []) as FastRankFilter[],
						sort: (args.sort as FastSearchSort | null) ?? "newest",
					},
					{ dedupeCrossPortal: false },
				);
				const offset = args.offset ?? 0;
				const limit = args.limit ?? 100;
				const sliced = searched.items
					.slice(offset, offset + limit)
					.map((s) => toPaperSummaryDto(s.paper));
				const page: CollectionPapersPage = {
					items: sliced,
					total: searched.totalMatched,
					hasMore: offset + sliced.length < searched.totalMatched,
				};
				return { ok: true, data: page, error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionPaperGet")
			.mockImplementation(async (args: CollectionPaperIdArgs) => {
				const item = itemsById.get(args.id);
				return {
					ok: true,
					data: item ? toPaperDetailDto(item) : null,
					error: null,
				};
			}),

		vi
			.spyOn(commands, "plazaCollectionPapersByIds")
			.mockImplementation(async (args: CollectionPaperIdsArgs) => {
				const out: CollectionPaperSummary[] = [];
				for (const id of args.ids) {
					const found = itemsById.get(id);
					if (found) out.push(toPaperSummaryDto(found));
				}
				return { ok: true, data: out, error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionPaperLineage")
			.mockImplementation(async (args: CollectionPaperLineageArgs) => {
				const target = itemsById.get(args.id);
				if (!target) {
					return {
						ok: true,
						data: {
							citedByCount: 0,
							referencesCount: 0,
							sharedRefCount: 0,
							citedByInPool: [],
							referencesInPool: [],
							sharedRefPeers: [],
							vaultMatches: [],
						} satisfies CollectionPaperLineageOut,
						error: null,
					};
				}

				const visible = getVisibleItems();
				const targetTokens = new Set(normalizeRefTokensForItem(target));
				const targetRefs = new Set(
					(target.rawRefs ?? [])
						.map(normalizeRawRefToken)
						.filter((t): t is string => Boolean(t)),
				);

				// Group visible items into canonical works
				const groups: CollectionPaperItem[][] = [];
				for (const item of visible) {
					if (sameCollectionPaperWork(item, target)) continue;
					const existing = groups.find((g) =>
						g.some((m) => sameCollectionPaperWork(m, item)),
					);
					if (existing) existing.push(item);
					else groups.push([item]);
				}

				const citedByInPool: CollectionPaperItem[] = [];
				const referencesInPool: CollectionPaperItem[] = [];
				const sharedRefPeers: {
					paper: CollectionPaperItem;
					sharedCount: number;
				}[] = [];

				for (const members of groups) {
					const rep = pickPreferredRepresentative(members);
					if (!rep) continue;
					const memberTokens = new Set(
						members.flatMap((m) => normalizeRefTokensForItem(m)),
					);
					const memberRefs = new Set(
						members
							.flatMap((m) => m.rawRefs ?? [])
							.map(normalizeRawRefToken)
							.filter((t): t is string => Boolean(t)),
					);

					const citesTarget = Array.from(targetTokens).some((t) =>
						memberRefs.has(t),
					);
					const referencedByTarget = Array.from(memberTokens).some((t) =>
						targetRefs.has(t),
					);
					if (citesTarget) citedByInPool.push(rep);
					if (referencedByTarget) referencesInPool.push(rep);

					if (!citesTarget && !referencedByTarget && targetRefs.size > 0) {
						let shared = 0;
						for (const r of targetRefs) {
							if (memberRefs.has(r)) shared += 1;
						}
						if (shared > 0) {
							sharedRefPeers.push({ paper: rep, sharedCount: shared });
						}
					}
				}

				citedByInPool.sort(
					(a, b) =>
						(b.citationCount ?? 0) - (a.citationCount ?? 0) ||
						b.publishedAt.localeCompare(a.publishedAt),
				);
				referencesInPool.sort(
					(a, b) =>
						(b.citationCount ?? 0) - (a.citationCount ?? 0) ||
						b.publishedAt.localeCompare(a.publishedAt),
				);
				sharedRefPeers.sort(
					(a, b) =>
						b.sharedCount - a.sharedCount ||
						(b.paper.citationCount ?? 0) - (a.paper.citationCount ?? 0),
				);

				const vaultMatches = computeVaultMatchesForPaper(
					target,
					Boolean(args.vaultPath),
				);
				const topShared = sharedRefPeers.slice(0, 10);

				if (args.countsOnly) {
					const out: CollectionPaperLineageOut = {
						citedByCount: citedByInPool.length,
						referencesCount: referencesInPool.length,
						sharedRefCount: topShared.length,
						citedByInPool: [],
						referencesInPool: [],
						sharedRefPeers: [],
						vaultMatches,
					};
					return { ok: true, data: out, error: null };
				}

				const out: CollectionPaperLineageOut = {
					citedByCount: citedByInPool.length,
					referencesCount: referencesInPool.length,
					sharedRefCount: topShared.length,
					citedByInPool: citedByInPool.map(toPaperSummaryDto),
					referencesInPool: referencesInPool.map(toPaperSummaryDto),
					sharedRefPeers: topShared.map((p) => ({
						paper: toPaperSummaryDto(p.paper),
						sharedCount: p.sharedCount,
					})),
					vaultMatches,
				};
				return { ok: true, data: out, error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionSubgraph")
			.mockImplementation(async (args: CollectionSubgraphArgs) => {
				const minShared = Math.max(1, args.minSharedRefs ?? 3);
				const visible = getVisibleItems();
				const workGroups: CollectionPaperItem[][] = [];
				for (const item of visible) {
					const existing = workGroups.find((g) =>
						g.some((m) => sameCollectionPaperWork(m, item)),
					);
					if (existing) existing.push(item);
					else workGroups.push([item]);
				}

				const groupTokens = workGroups.map(
					(members) =>
						new Set(members.flatMap((m) => normalizeRefTokensForItem(m))),
				);
				const groupRefs = workGroups.map(
					(members) =>
						new Set(
							members
								.flatMap((m) => m.rawRefs ?? [])
								.map(normalizeRawRefToken)
								.filter((t): t is string => Boolean(t)),
						),
				);

				const widToRepId = new Map<number, string>();
				const subgraphWids: number[] = [];
				for (const rawId of args.ids) {
					const item = itemsById.get(rawId);
					if (!item) continue;
					const wIdx = workGroups.findIndex((g) =>
						g.some((m) => sameCollectionPaperWork(m, item)),
					);
					if (wIdx >= 0 && !widToRepId.has(wIdx)) {
						widToRepId.set(wIdx, rawId);
						subgraphWids.push(wIdx);
					}
				}
				const subSet = new Set(subgraphWids);

				const citationEdges: CollectionSubgraphOut["citationEdges"] = [];
				const directUndirected = new Set<string>();
				const unexpandedCounts: Record<string, number> = {};

				for (const wIdx of subgraphWids) {
					const myTokens = groupTokens[wIdx] ?? new Set<string>();
					const myRefs = groupRefs[wIdx] ?? new Set<string>();
					const myId = widToRepId.get(wIdx);
					if (!myId) continue;

					let outsideCount = 0;
					for (let other = 0; other < workGroups.length; other += 1) {
						if (other === wIdx) continue;
						const otherTokens = groupTokens[other] ?? new Set<string>();
						const otherRefs = groupRefs[other] ?? new Set<string>();
						const iCiteOther = Array.from(otherTokens).some((t) =>
							myRefs.has(t),
						);
						const otherCitesMe = Array.from(myTokens).some((t) =>
							otherRefs.has(t),
						);

						if (subSet.has(other)) {
							const otherId = widToRepId.get(other);
							if (iCiteOther && otherId) {
								citationEdges.push({ citingId: myId, citedId: otherId });
								const pairKey =
									wIdx < other ? `${wIdx}:${other}` : `${other}:${wIdx}`;
								directUndirected.add(pairKey);
							}
						} else if (iCiteOther || otherCitesMe) {
							outsideCount += 1;
						}
					}
					if (outsideCount > 0) {
						unexpandedCounts[myId] = outsideCount;
					}
				}

				const sharedRefEdges: CollectionSubgraphOut["sharedRefEdges"] = [];
				for (let i = 0; i < subgraphWids.length; i += 1) {
					const u = subgraphWids[i];
					const uRefs = groupRefs[u] ?? new Set<string>();
					if (uRefs.size === 0) continue;
					for (let j = i + 1; j < subgraphWids.length; j += 1) {
						const v = subgraphWids[j];
						const pairKey = u < v ? `${u}:${v}` : `${v}:${u}`;
						if (directUndirected.has(pairKey)) continue;
						const vRefs = groupRefs[v] ?? new Set<string>();
						let shared = 0;
						for (const r of uRefs) {
							if (vRefs.has(r)) shared += 1;
						}
						const srcId = widToRepId.get(u);
						const dstId = widToRepId.get(v);
						if (shared >= minShared && srcId && dstId) {
							sharedRefEdges.push({
								sourceId: srcId,
								targetId: dstId,
								sharedCount: shared,
							});
						}
					}
				}

				const out: CollectionSubgraphOut = {
					citationEdges,
					sharedRefEdges,
					unexpandedCounts,
				};
				return { ok: true, data: out, error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionSeedSync")
			.mockImplementation(async (args: CollectionSeedSyncArgs) => {
				if (seedCleared && !args.force) {
					const out: CollectionSeedSyncOut = {
						state: buildSummary(),
						appliedShards: [],
						importedPapers: 0,
						skipped: true,
					};
					return { ok: true, data: out, error: null };
				}
				if (args.force) {
					seedCleared = false;
				}
				if (seedShards.length === 0) {
					const out: CollectionSeedSyncOut = {
						state: buildSummary(),
						appliedShards: [],
						importedPapers: 0,
						skipped: true,
					};
					return { ok: true, data: out, error: null };
				}

				const appliedSet = new Set(appliedSeedIds);
				const newlyApplied: string[] = [];
				let importedPapers = 0;

				for (const shard of seedShards) {
					if (!args.force && appliedSet.has(shard.id)) continue;
					if (
						shard.kind === "addon" &&
						shard.category &&
						!categories.includes(shard.category)
					) {
						continue;
					}
					if (shard.items.length > 0) {
						const merged = mergeCollectionItems([
							Array.from(itemsById.values()),
							shard.items,
						]);
						itemsById = new Map(merged.map((p) => [p.id, p]));
						importedPapers += shard.items.length;
					}
					appliedSet.add(shard.id);
					newlyApplied.push(shard.id);
				}

				appliedSeedIds = Array.from(appliedSet);
				recomputeInPoolCitations();

				const out: CollectionSeedSyncOut = {
					state: buildSummary(),
					appliedShards: newlyApplied,
					importedPapers,
					skipped: newlyApplied.length === 0,
				};
				return { ok: true, data: out, error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionSeedCancel")
			.mockImplementation(async () => ({
				ok: true,
				data: true,
				error: null,
			})),

		vi
			.spyOn(commands, "plazaCollectionBackfillRefs")
			.mockImplementation(async () => ({
				ok: true,
				data: {
					checkedWorks: 0,
					enrichedWorks: 0,
					state: buildSummary(),
				},
				error: null,
			})),

		vi
			.spyOn(commands, "plazaCollectionSearch")
			.mockImplementation(async (args: CollectionSearchArgs) => {
				const res = searchCollectionFast(getVisibleItems(), args.query ?? "", {
					timePreset: (args.timePreset as FastTimePreset | null) ?? "all",
					dateFrom: args.dateFrom ?? "",
					dateTo: args.dateTo ?? "",
					sourceType:
						args.sourceType === "arxiv" || args.sourceType === "venue"
							? args.sourceType
							: "all",
					categories: args.categories ?? [],
					venues: args.venues ?? [],
					venueKind:
						args.venueKind === "conference" || args.venueKind === "journal"
							? args.venueKind
							: "all",
					venueDomain:
						args.venueDomain === "PL/SE" ||
						args.venueDomain === "CR" ||
						args.venueDomain === "AI"
							? args.venueDomain
							: "all",
					ccfRanks: (args.ccfRanks ?? []) as FastRankFilter[],
					fields: (args.fields ?? [
						"title",
						"abstract",
						"keywords",
					]) as FastSearchField[],
					sort: (args.sort as FastSearchSort | null) ?? "relevance",
				});
				const offset = args.offset ?? 0;
				const limit = args.limit ?? 200;
				const sliced = res.items.slice(offset, offset + limit);
				const dto: CollectionSearchResult = {
					items: sliced.map((hit) => ({
						paper: toPaperSummaryDto(hit.paper),
						score: hit.score,
						matchedFields: [...hit.matchedFields],
					})),
					totalMatched: res.totalMatched,
				};
				return { ok: true, data: dto, error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionRecommendStateGet")
			.mockImplementation(async () => {
				const dto: RecommendPoolStateDto = {
					keywords: recommendState.keywords.map((k) => ({ ...k })),
					selectedCloudTerms: [...recommendState.selectedCloudTerms],
					wordCloudTopN: recommendState.wordCloudTopN,
					lastRecommendedAt: recommendState.lastRecommendedAt,
				};
				return { ok: true, data: dto, error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionRecommendStateSet")
			.mockImplementation(async (args: RecommendPoolStateInput) => {
				recommendState = {
					keywords: (args.keywords ?? recommendState.keywords).map(
						(k, idx) => ({
							id: k.id || `kw-${idx}`,
							term: k.term,
							enabled: k.enabled ?? true,
						}),
					),
					selectedCloudTerms:
						args.selectedCloudTerms ?? recommendState.selectedCloudTerms,
					wordCloudTopN:
						args.wordCloudTopN ??
						recommendState.wordCloudTopN ??
						DEFAULT_WORD_CLOUD_TOP_N,
					lastRecommendedAt:
						args.lastRecommendedAt !== undefined
							? args.lastRecommendedAt
							: recommendState.lastRecommendedAt,
				};
				const dto: RecommendPoolStateDto = {
					keywords: recommendState.keywords.map((k) => ({ ...k })),
					selectedCloudTerms: [...recommendState.selectedCloudTerms],
					wordCloudTopN: recommendState.wordCloudTopN,
					lastRecommendedAt: recommendState.lastRecommendedAt,
				};
				return { ok: true, data: dto, error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionWordCloud")
			.mockImplementation(async (args: CollectionWordCloudArgs) => {
				const visible = getVisibleItems();
				const topN = args.topN ?? DEFAULT_WORD_CLOUD_TOP_N;
				const cloud = getWordCloudKeywords(visible, topN);
				const unrecommendedPaperCount = visible.filter(
					(p) => !p.recommendedAt,
				).length;
				const dto: WordCloudOut = {
					keywords: cloud.keywords,
					totalUniqueKeywords: cloud.totalUniqueKeywords,
					totalCandidatePapers: visible.length,
					unrecommendedPaperCount,
				};
				return { ok: true, data: dto, error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionRecommendNext")
			.mockImplementation(async (args: RecommendNextArgs) => {
				const batchSize = args.maxBatchSize ?? DEFAULT_RECOMMEND_BATCH_SIZE;
				const activeTerms = getActiveSelectedTerms(recommendState);
				let mergedState: RecommendPoolState = { ...recommendState };
				for (const cloudTerm of recommendState.selectedCloudTerms) {
					mergedState = addCustomRecentKeyword(mergedState, cloudTerm);
				}
				mergedState = { ...mergedState, selectedCloudTerms: [] };

				if (activeTerms.length === 0) {
					recommendState = mergedState;
					const visible = getVisibleItems();
					const remaining = visible.filter((p) => !p.recommendedAt).length;
					return {
						ok: true,
						data: {
							items: [],
							state: {
								keywords: recommendState.keywords.map((k) => ({ ...k })),
								selectedCloudTerms: [],
								wordCloudTopN: recommendState.wordCloudTopN,
								lastRecommendedAt: recommendState.lastRecommendedAt,
							},
							exhausted: false,
							remainingUnrecommended: remaining,
						} satisfies RecommendNextOut,
						error: null,
					};
				}

				const visible = getVisibleItems();
				type RecGroup = {
					rep: CollectionPaperItem;
					memberIds: string[];
					alreadyRecommended: boolean;
				};
				const groups: RecGroup[] = [];
				for (const item of visible) {
					const existing = groups.find((g) =>
						sameCollectionPaperWork(g.rep, item),
					);
					if (existing) {
						existing.memberIds.push(item.id);
						if (item.recommendedAt) existing.alreadyRecommended = true;
						if (
							existing.rep.sourceType === "arxiv" &&
							item.sourceType === "venue"
						) {
							existing.rep = mergeArxivIntoVenueItem(item, existing.rep);
						} else if (
							existing.rep.sourceType === "venue" &&
							item.sourceType === "arxiv"
						) {
							existing.rep = mergeArxivIntoVenueItem(existing.rep, item);
						} else if (
							existing.rep.sourceType === "venue" &&
							item.sourceType === "venue" &&
							comparePreferredVenueItem(existing.rep, item) > 0
						) {
							existing.rep = item;
						}
					} else {
						groups.push({
							rep: item,
							memberIds: [item.id],
							alreadyRecommended: Boolean(item.recommendedAt),
						});
					}
				}

				const candidates = groups
					.filter((g) => !g.alreadyRecommended)
					.map((g) => {
						const res = scorePaperAgainstKeywords(g.rep, activeTerms);
						const citedVaultCount = computeVaultMatchesForPaper(
							g.rep,
							Boolean(args.vaultPath),
						).filter((m) => m.relation === "referenced").length;
						return {
							paper: g.rep,
							memberIds: g.memberIds,
							score: res.score + Math.min(20, citedVaultCount * 10),
							matchedKeywords: res.matchedKeywords,
							citedVaultCount,
						};
					})
					.filter((entry) => entry.score > 0)
					.sort((a, b) => {
						if (b.score !== a.score) return b.score - a.score;
						return b.paper.publishedAt.localeCompare(a.paper.publishedAt);
					});

				const picked = candidates.slice(0, batchSize);
				recClockSeq += 1;
				const stamp = `2026-04-12T10:${String(recClockSeq).padStart(2, "0")}:00Z`;
				for (const winner of picked) {
					for (const memberId of winner.memberIds) {
						const existing = itemsById.get(memberId);
						if (existing) {
							itemsById.set(existing.id, { ...existing, recommendedAt: stamp });
						}
					}
					winner.paper = { ...winner.paper, recommendedAt: stamp };
				}
				if (picked.length > 0) {
					mergedState = { ...mergedState, lastRecommendedAt: stamp };
				}
				recommendState = mergedState;

				const remainingMatching = Math.max(
					0,
					candidates.length - picked.length,
				);
				const out: RecommendNextOut = {
					items: picked.map((w) => ({
						paper: toPaperSummaryDto(w.paper),
						matchedKeywords: w.matchedKeywords,
						score: w.score,
						citedVaultCount: w.citedVaultCount,
					})),
					state: {
						keywords: recommendState.keywords.map((k) => ({ ...k })),
						selectedCloudTerms: [...recommendState.selectedCloudTerms],
						wordCloudTopN: recommendState.wordCloudTopN,
						lastRecommendedAt: recommendState.lastRecommendedAt,
					},
					exhausted: remainingMatching === 0,
					remainingUnrecommended: getVisibleItems().filter(
						(p) => !p.recommendedAt,
					).length,
				};
				return { ok: true, data: out, error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionClear")
			.mockImplementation(async (args: CollectionClearArgs) => {
				if (args.scope === "all") {
					seed({ seedCleared: true, appliedSeedIds: [] });
				} else if (args.scope === "papers") {
					itemsById.clear();
					watermarks = {};
				} else if (args.scope === "venue" && args.venueId) {
					for (const [id, item] of itemsById.entries()) {
						if (item.sourceType === "venue" && item.venueId === args.venueId) {
							itemsById.delete(id);
						}
					}
					venues = venues.map((v) =>
						v.id === args.venueId
							? { ...v, lastFetchedAt: null, paperCount: 0 }
							: v,
					);
					recomputeInPoolCitations();
				} else if (args.scope === "recommended") {
					for (const [id, item] of itemsById.entries()) {
						if (item.recommendedAt) {
							const { recommendedAt: _rec, ...rest } = item;
							itemsById.set(id, rest);
						}
					}
					recommendState = { ...recommendState, lastRecommendedAt: null };
				}
				return { ok: true, data: buildSummary(), error: null };
			}),
	];

	return {
		seed,
		getItems: () => getVisibleItems(),
		getRawItem: (id: string) => itemsById.get(id),
		restore: () => {
			for (const spy of spies) {
				spy.mockRestore();
			}
		},
	};
}
