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
	type CollectionPaperSummary,
	type CollectionPapersPage,
	type CollectionPatchPapersArgs,
	type CollectionSearchArgs,
	type CollectionSearchResult,
	type CollectionStateSummary,
	type CollectionUpsertPapersArgs,
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
	matchesAnyArxivCategory,
	mergeCollectionItems,
	normalizePaperKeywords,
	type VenueConfig,
} from "@/lib/plaza/collection";
import {
	type FastRankFilter,
	type FastSearchField,
	type FastSearchSort,
	type FastTimePreset,
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
		volume: item.volume ?? null,
		issue: item.issue ?? null,
		pages: item.pages ?? null,
		coolPapersId: item.coolPapersId ?? null,
		recommendedAt: item.recommendedAt ?? null,
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

function defaultVenueRecords(): CollectionVenueRecord[] {
	return DEFAULT_COLLECTION_VENUES.map((v) => ({
		id: v.id,
		name: v.name,
		url: v.url,
		mode: v.mode,
		kind: v.kind ?? null,
		domain: v.domain ?? null,
		ccfRank: v.ccfRank ?? null,
		dblpStream: v.dblpStream ?? null,
		lastFetchedAt: v.lastFetchedAt ?? null,
		latestPublishedAt: v.latestPublishedAt ?? null,
		remoteTotalCount: v.remoteTotalCount ?? null,
		paperCount: 0,
	}));
}

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
};

/**
 * Install an in-memory `collection.sqlite` mock wired onto `commands.plazaCollection*` spies.
 * Mirrors SQLite invariants: portal-scoped PKs, enabled-category scoping for `arxiv`,
 * metadata-preserving upserts/patches (never overwriting `recommendedAt` with null),
 * atomic venue replacement carrying forward `recommendedAt`, word-cloud casing, and
 * non-repeating recommendation batches.
 */
export function installMockCollectionIpc(initial?: MockCollectionDbSeed) {
	let categories: string[] = [...DEFAULT_ARXIV_CATEGORIES];
	let venues: CollectionVenueRecord[] = defaultVenueRecords();
	let watermarks: Record<string, CollectionArxivWatermark> = {};
	let lastRefreshedAt: string | null = null;
	let latestArxiv: CollectionArxivLatest | null = null;
	let itemsById = new Map<string, CollectionPaperItem>();
	let recommendState: RecommendPoolState = createDefaultRecommendPoolState();
	let recClockSeq = 0;

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
					mode: v.mode,
					kind: v.kind ?? null,
					domain: v.domain ?? null,
					ccfRank: v.ccfRank ?? null,
					dblpStream: v.dblpStream ?? null,
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
		itemsById = new Map();
		for (const item of next?.items ?? []) {
			itemsById.set(item.id, { ...item });
		}
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
					venues = args.venues.map((v) => ({
						id: v.id,
						name: v.name,
						url: v.url,
						mode: v.mode ?? "auto",
						kind: v.kind ?? null,
						domain: v.domain ?? null,
						ccfRank: v.ccfRank ?? null,
						dblpStream: v.dblpStream ?? null,
						lastFetchedAt: v.lastFetchedAt ?? null,
						latestPublishedAt: v.latestPublishedAt ?? null,
						remoteTotalCount: v.remoteTotalCount ?? null,
						paperCount: v.paperCount ?? 0,
					}));
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
					itemsById.set(patch.id, {
						...prev,
						abstract: nextAbstract,
						pdfUrl: prev.pdfUrl || patch.pdfUrl || undefined,
						arxivId: prev.arxivId || patch.arxivId || undefined,
						doi: prev.doi || patch.doi || undefined,
						venueFull: prev.venueFull || patch.venueFull || undefined,
						citationCount: Math.max(
							prev.citationCount ?? 0,
							patch.citationCount ?? 0,
						),
						keywords: normalizePaperKeywords([
							...(prev.keywords ?? []),
							...(patch.keywords ?? []),
						]),
						volume: prev.volume || patch.volume || undefined,
						issue: prev.issue || patch.issue || undefined,
						pages: prev.pages || patch.pages || undefined,
						bibtex: patch.bibtex || prev.bibtex || undefined,
						coolPapersId: prev.coolPapersId || patch.coolPapersId || undefined,
						recommendedAt:
							prev.recommendedAt || patch.recommendedAt || undefined,
					});
				}
				return { ok: true, data: buildSummary(), error: null };
			}),

		vi
			.spyOn(commands, "plazaCollectionListPapers")
			.mockImplementation(async (args: CollectionListPapersArgs) => {
				const searched = searchCollectionFast(getVisibleItems(), "", {
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
				});
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
				const candidates = visible
					.filter((p) => !p.recommendedAt)
					.map((paper) => {
						const res = scorePaperAgainstKeywords(paper, activeTerms);
						return {
							paper,
							score: res.score,
							matchedKeywords: res.matchedKeywords,
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
					const existing = itemsById.get(winner.paper.id);
					if (existing) {
						const updated = { ...existing, recommendedAt: stamp };
						itemsById.set(existing.id, updated);
						winner.paper = updated;
					}
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
					seed();
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
