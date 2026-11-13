/**
 * Plaza — Unified `collection.sqlite` reactive summary store & IPC wrappers.
 *
 * Holds ONLY lightweight `CollectionStateSummary` metadata, `revision` counter,
 * and transient sync flags (`hydrated`, `preloading`) in JS memory — zero
 * full-pool paper arrays are retained in resident client state.
 */

import { createStore } from "zustand/vanilla";
import { type CollectionOverviewOut, commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import {
	type CollectionPaperItem,
	type CollectionSourceType,
	formatPaperCitationText,
	inferVenueKind,
	VENUE_SPEC_BY_ID,
	VENUE_SPECS,
	type VenueCcfRank,
	type VenueConfig,
	type VenueDomain,
	type VenueKind,
} from "@/lib/plaza/collection-enrichment";

export const DEFAULT_ARXIV_CATEGORIES = ["cs.SE", "cs.CR", "cs.PL"] as const;

export const DEFAULT_COLLECTION_VENUES: readonly VenueConfig[] =
	VENUE_SPECS.map((spec) => ({
		id: spec.id,
		name: spec.name,
		url: spec.url,
		tracks: [...spec.tracks],
		mode: "auto",
		kind: spec.kind,
		domain: spec.domain,
		ccfRank: spec.ccfRank,
	}));

export type ArxivLatestRecord = {
	arxivId: string;
	title: string;
	publishedAt: string;
	categoriesKey: string;
	checkedAt: string;
};

export type ArxivCategoryWatermark = {
	latestPublishedAt: string;
	latestArxivId: string;
	lastSyncedAt: string;
	/** Oldest `<published>` ISO timestamp contiguously synced during 2026 backfill. */
	oldestSyncedPublishedAt?: string;
	/** Upstream 2026 total count reported by `<opensearch:totalResults>`. */
	remoteTotal?: number;
	/** True once 2026 backfill has walked all the way back to `2026-01-01`. */
	historyComplete?: boolean;
};

export type CollectionStateSummary = {
	categories: string[];
	venues: VenueConfig[];
	arxivWatermarks: Record<string, ArxivCategoryWatermark>;
	lastRefreshedAt: string | null;
	latestArxiv: ArxivLatestRecord | null;
	totalCount: number;
	arxivCount: number;
	venueCount: number;
	conferenceCount: number;
	journalCount: number;
	categoryCounts: Record<string, number>;
};

export type CollectionSummarySnapshot = CollectionStateSummary & {
	revision: number;
	hydrated: boolean;
	preloading: boolean;
};

export type CollectionClearScope =
	| "all"
	| "papers"
	| "venue"
	| "recommended"
	| "citations";

export type CollectionListPapersQuery = {
	sourceType?: CollectionSourceType | null;
	category?: string | null;
	timePreset?: "all" | "7d" | "30d" | "90d" | "custom" | null;
	dateFrom?: string | null;
	dateTo?: string | null;
	venueKind?: VenueKind | null;
	venueDomain?: VenueDomain | null;
	venueId?: string | null;
	ccfRanks?: string[];
	sort?: "newest" | "citations" | null;
	limit?: number;
	offset?: number;
};

export type CollectionPapersPageResult = {
	items: CollectionPaperItem[];
	total: number;
	hasMore: boolean;
};

export type CollectionPaperDetailResult = CollectionPaperItem & {
	citationText: string;
};

export type CollectionVenueWatermarkUpdate = {
	venueId: string;
	lastFetchedAt?: string | null;
	latestPublishedAt?: string | null;
	remoteTotalCount?: number | null;
};

export type CollectionUpsertPapersInput = {
	items: readonly CollectionPaperItem[];
	replaceVenueId?: string | null;
	replaceSourceLabel?: string | null;
	venueUpdate?: CollectionVenueWatermarkUpdate | null;
	arxivWatermarks?: Record<string, ArxivCategoryWatermark> | null;
	lastRefreshedAt?: string | null;
	latestArxiv?: ArxivLatestRecord | null;
};

export type CollectionPaperPatchInput = {
	id: string;
	abstract?: string | null;
	pdfUrl?: string | null;
	arxivId?: string | null;
	doi?: string | null;
	venueFull?: string | null;
	citationCount?: number | null;
	keywords?: string[] | null;
	volume?: string | null;
	issue?: string | null;
	pages?: string | null;
	bibtex?: string | null;
	coolPapersId?: string | null;
	recommendedAt?: string | null;
};

export type CollectionConfigUpdateInput = {
	categories?: string[];
	venues?: VenueConfig[];
	arxivWatermarks?: Record<string, ArxivCategoryWatermark>;
	lastRefreshedAt?: string | null;
	latestArxiv?: ArxivLatestRecord | null;
};

// ─── DTO Wire Shapes & Mappers ───

export type WirePaperSummaryLike = {
	id: string;
	title: string;
	authors: string[];
	abstract: string;
	publishedAt: string;
	year: number;
	sourceType: string;
	sourceLabel: string;
	categories: string[];
	url: string;
	pdfUrl?: string | null;
	arxivId?: string | null;
	doi?: string | null;
	venueId?: string | null;
	venueKind?: string | null;
	venueDomain?: string | null;
	ccfRank?: string | null;
	venueFull?: string | null;
	citationCount?: number | null;
	keywords?: string[] | null;
	volume?: string | null;
	issue?: string | null;
	pages?: string | null;
	coolPapersId?: string | null;
	recommendedAt?: string | null;
};

export type WirePaperDetailLike = WirePaperSummaryLike & {
	bibtex?: string | null;
	citationText?: string | null;
};

type WireVenueRecordLike = {
	id: string;
	name: string;
	url: string;
	tracks?: string[] | null;
	notes?: string | null;
	mode?: string | null;
	kind?: string | null;
	domain?: string | null;
	ccfRank?: string | null;
	lastFetchedAt?: string | null;
	latestPublishedAt?: string | null;
	remoteTotalCount?: number | null;
	paperCount?: number | null;
};

type WireWatermarkLike = {
	latestPublishedAt: string;
	latestArxivId: string;
	lastSyncedAt: string;
	oldestSyncedPublishedAt?: string | null;
	remoteTotal?: number | null;
	historyComplete?: boolean | null;
};

type WireStateSummaryLike = {
	categories: string[];
	venues: WireVenueRecordLike[];
	arxivWatermarks: Record<string, WireWatermarkLike | undefined>;
	lastRefreshedAt: string | null;
	latestArxiv: ArxivLatestRecord | null;
	totalCount: number;
	arxivCount: number;
	venueCount: number;
	conferenceCount: number;
	journalCount: number;
	categoryCounts: Record<string, number | undefined>;
};

function coerceVenueKind(raw?: string | null): VenueKind | undefined {
	if (raw === "conference" || raw === "journal") return raw;
	return undefined;
}

function coerceVenueDomain(raw?: string | null): VenueDomain | undefined {
	if (raw === "PL/SE" || raw === "CR" || raw === "AI") return raw;
	return undefined;
}

function coerceCcfRank(raw?: string | null): VenueCcfRank | undefined {
	if (raw === "CCF-A" || raw === "CCF-B") return raw;
	return undefined;
}

export function fromPaperSummaryDto(
	dto: WirePaperSummaryLike,
): CollectionPaperItem {
	const spec = dto.venueId ? VENUE_SPEC_BY_ID.get(dto.venueId) : undefined;
	const sourceType: CollectionSourceType =
		dto.sourceType === "venue" ? "venue" : "arxiv";
	const venueKind = coerceVenueKind(dto.venueKind) ?? spec?.kind;
	const venueDomain = coerceVenueDomain(dto.venueDomain) ?? spec?.domain;
	const ccfRank = coerceCcfRank(dto.ccfRank) ?? spec?.ccfRank;

	return {
		id: dto.id,
		title: dto.title,
		authors: dto.authors,
		abstract: dto.abstract,
		publishedAt: dto.publishedAt,
		year: dto.year,
		sourceType,
		sourceLabel: dto.sourceLabel,
		categories: dto.categories,
		url: dto.url,
		...(dto.pdfUrl ? { pdfUrl: dto.pdfUrl } : {}),
		...(dto.arxivId ? { arxivId: dto.arxivId } : {}),
		...(dto.doi ? { doi: dto.doi } : {}),
		...(dto.venueId ? { venueId: dto.venueId } : {}),
		...(venueKind ? { venueKind } : {}),
		...(venueDomain ? { venueDomain } : {}),
		...(ccfRank ? { ccfRank } : {}),
		...(dto.venueFull ? { venueFull: dto.venueFull } : {}),
		citationCount: dto.citationCount ?? 0,
		keywords: dto.keywords ?? [],
		...(dto.volume ? { volume: dto.volume } : {}),
		...(dto.issue ? { issue: dto.issue } : {}),
		...(dto.pages ? { pages: dto.pages } : {}),
		...(dto.coolPapersId ? { coolPapersId: dto.coolPapersId } : {}),
		...(dto.recommendedAt ? { recommendedAt: dto.recommendedAt } : {}),
	};
}

export function fromPaperDetailDto(
	dto: WirePaperDetailLike,
): CollectionPaperDetailResult {
	const base = fromPaperSummaryDto(dto);
	const withBibtex: CollectionPaperItem = dto.bibtex
		? { ...base, bibtex: dto.bibtex }
		: base;
	return {
		...withBibtex,
		citationText:
			dto.citationText?.trim() || formatPaperCitationText(withBibtex),
	};
}

function fromVenueRecordDto(dto: WireVenueRecordLike): VenueConfig {
	const spec = VENUE_SPEC_BY_ID.get(dto.id);
	const name = dto.name?.trim() || spec?.name || dto.id;
	const url = dto.url?.trim() || spec?.url || "";
	const tracks = Array.isArray(dto.tracks)
		? dto.tracks.map((t) => t.trim()).filter(Boolean)
		: spec
			? [...spec.tracks]
			: [];
	const notes = dto.notes?.trim() || undefined;
	const kind =
		coerceVenueKind(dto.kind) ??
		spec?.kind ??
		inferVenueKind({
			id: dto.id,
			name,
			url,
		});
	const domain = coerceVenueDomain(dto.domain) ?? spec?.domain;
	const ccfRank = coerceCcfRank(dto.ccfRank) ?? spec?.ccfRank;

	return {
		id: dto.id,
		name,
		url,
		tracks,
		...(notes ? { notes } : {}),
		mode: dto.mode === "agent" ? "agent" : "auto",
		kind,
		...(domain ? { domain } : {}),
		...(ccfRank ? { ccfRank } : {}),
		lastFetchedAt: dto.lastFetchedAt ?? null,
		latestPublishedAt: dto.latestPublishedAt ?? null,
		...(dto.remoteTotalCount != null
			? { remoteTotalCount: dto.remoteTotalCount }
			: {}),
		paperCount: dto.paperCount ?? 0,
	};
}

function fromWatermarkMapDto(
	raw: Record<string, WireWatermarkLike | undefined> | null | undefined,
): Record<string, ArxivCategoryWatermark> {
	const out: Record<string, ArxivCategoryWatermark> = {};
	if (!raw) return out;
	for (const [cat, wm] of Object.entries(raw)) {
		if (!wm) continue;
		out[cat] = {
			latestPublishedAt: wm.latestPublishedAt,
			latestArxivId: wm.latestArxivId,
			lastSyncedAt: wm.lastSyncedAt,
			...(wm.oldestSyncedPublishedAt
				? { oldestSyncedPublishedAt: wm.oldestSyncedPublishedAt }
				: {}),
			...(wm.remoteTotal != null ? { remoteTotal: wm.remoteTotal } : {}),
			historyComplete: Boolean(wm.historyComplete),
		};
	}
	return out;
}

export function fromStateSummaryDto(
	dto: WireStateSummaryLike,
): CollectionStateSummary {
	const categoryCounts: Record<string, number> = {};
	for (const [k, v] of Object.entries(dto.categoryCounts ?? {})) {
		if (typeof v === "number") {
			categoryCounts[k] = v;
		}
	}
	const venues = Array.isArray(dto.venues)
		? dto.venues.map(fromVenueRecordDto)
		: DEFAULT_COLLECTION_VENUES.map((v) => ({ ...v, paperCount: 0 }));
	return {
		categories:
			dto.categories && dto.categories.length > 0
				? [...dto.categories]
				: [...DEFAULT_ARXIV_CATEGORIES],
		venues,
		arxivWatermarks: fromWatermarkMapDto(dto.arxivWatermarks),
		lastRefreshedAt: dto.lastRefreshedAt ?? null,
		latestArxiv: dto.latestArxiv ?? null,
		totalCount: dto.totalCount ?? 0,
		arxivCount: dto.arxivCount ?? 0,
		venueCount: dto.venueCount ?? 0,
		conferenceCount: dto.conferenceCount ?? 0,
		journalCount: dto.journalCount ?? 0,
		categoryCounts,
	};
}

function toVenueInputDto(venue: VenueConfig) {
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const resolvedTracks =
		venue.tracks !== undefined
			? venue.tracks.map((t) => t.trim()).filter(Boolean)
			: spec
				? [...spec.tracks]
				: [];
	return {
		id: venue.id,
		name: venue.name,
		url: venue.url,
		tracks: resolvedTracks,
		notes: venue.notes?.trim() ?? "",
		mode: venue.mode,
		kind: venue.kind ?? null,
		domain: venue.domain ?? null,
		ccfRank: venue.ccfRank ?? null,
		lastFetchedAt: venue.lastFetchedAt ?? null,
		latestPublishedAt: venue.latestPublishedAt ?? null,
		remoteTotalCount: venue.remoteTotalCount ?? null,
		paperCount: venue.paperCount ?? 0,
	};
}

function toWatermarkMapInputDto(map: Record<string, ArxivCategoryWatermark>) {
	const out: Record<
		string,
		{
			latestPublishedAt: string;
			latestArxivId: string;
			lastSyncedAt: string;
			oldestSyncedPublishedAt: string | null;
			remoteTotal: number | null;
			historyComplete: boolean | null;
		}
	> = {};
	for (const [cat, wm] of Object.entries(map)) {
		out[cat] = {
			latestPublishedAt: wm.latestPublishedAt,
			latestArxivId: wm.latestArxivId,
			lastSyncedAt: wm.lastSyncedAt,
			oldestSyncedPublishedAt: wm.oldestSyncedPublishedAt ?? null,
			remoteTotal: wm.remoteTotal ?? null,
			historyComplete: wm.historyComplete ?? null,
		};
	}
	return out;
}

function toPaperUpsertDto(item: CollectionPaperItem) {
	return {
		id: item.id,
		title: item.title,
		authors: item.authors,
		abstract: item.abstract,
		publishedAt: item.publishedAt,
		year: item.year,
		sourceType: item.sourceType,
		sourceLabel: item.sourceLabel,
		categories: item.categories,
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
		keywords: item.keywords ?? [],
		volume: item.volume ?? null,
		issue: item.issue ?? null,
		pages: item.pages ?? null,
		bibtex: item.bibtex ?? null,
		coolPapersId: item.coolPapersId ?? null,
		recommendedAt: item.recommendedAt ?? null,
	};
}

// ─── Memory-Slim Reactive Store ───

function createDefaultSummarySnapshot(): CollectionSummarySnapshot {
	return {
		categories: [...DEFAULT_ARXIV_CATEGORIES],
		venues: DEFAULT_COLLECTION_VENUES.map((v) => ({ ...v, paperCount: 0 })),
		arxivWatermarks: {},
		lastRefreshedAt: null,
		latestArxiv: null,
		totalCount: 0,
		arxivCount: 0,
		venueCount: 0,
		conferenceCount: 0,
		journalCount: 0,
		categoryCounts: {},
		revision: 0,
		hydrated: false,
		preloading: false,
	};
}

export const collectionStore = createStore<CollectionSummarySnapshot>(() =>
	createDefaultSummarySnapshot(),
);

export function getCollectionSummarySnapshot(): CollectionSummarySnapshot {
	return collectionStore.getState();
}

export function subscribeCollectionSummary(
	listener: (snapshot: CollectionSummarySnapshot) => void,
): () => void {
	return collectionStore.subscribe((state) => {
		listener(state);
	});
}

function applySummaryToStore(
	summary: CollectionStateSummary,
	bumpRevision: boolean,
): CollectionStateSummary {
	collectionStore.setState((prev) => ({
		...summary,
		revision: bumpRevision ? prev.revision + 1 : prev.revision,
		hydrated: true,
		preloading: prev.preloading,
	}));
	return summary;
}

export function bumpCollectionRevision(): number {
	let nextRev = 0;
	collectionStore.setState((prev) => {
		nextRev = prev.revision + 1;
		return { ...prev, revision: nextRev };
	});
	return nextRev;
}

export function setPreloadingCollectionFlag(next: boolean): void {
	if (collectionStore.getState().preloading === next) return;
	collectionStore.setState({ preloading: next });
}

export function isPreloadingCollection(): boolean {
	return collectionStore.getState().preloading;
}

export function subscribePreloadingCollection(
	listener: (preloading: boolean) => void,
): () => void {
	return collectionStore.subscribe((state, prev) => {
		if (state.preloading !== prev.preloading) {
			listener(state.preloading);
		}
	});
}

let inFlightInitialHydration: Promise<CollectionStateSummary> | null = null;

export function resetCollectionStoreForTests(): void {
	inFlightInitialHydration = null;
	collectionStore.setState(createDefaultSummarySnapshot(), true);
}

// ─── Async IPC Wrappers (`commands.plazaCollection*`) ───

export async function fetchCollectionStateSummary(): Promise<CollectionStateSummary> {
	const dto = await callApi(() => commands.plazaCollectionStateGet(), {
		fallback: "Failed to load paper collection state",
	});
	const wasHydrated = collectionStore.getState().hydrated;
	return applySummaryToStore(fromStateSummaryDto(dto), !wasHydrated);
}

export async function ensureCollectionSummaryHydrated(): Promise<CollectionStateSummary> {
	const snap = collectionStore.getState();
	if (snap.hydrated) {
		const { revision: _r, hydrated: _h, preloading: _p, ...summary } = snap;
		return summary;
	}
	if (inFlightInitialHydration) return inFlightInitialHydration;
	inFlightInitialHydration = fetchCollectionStateSummary().finally(() => {
		inFlightInitialHydration = null;
	});
	return inFlightInitialHydration;
}

export type { CollectionOverviewOut };

export async function fetchCollectionOverview(): Promise<CollectionOverviewOut> {
	return callApi(() => commands.plazaCollectionOverview(), {
		fallback: "Failed to load paper collection overview",
	});
}

export async function updateCollectionConfig(
	args: CollectionConfigUpdateInput,
): Promise<CollectionStateSummary> {
	const dto = await callApi(
		() =>
			commands.plazaCollectionConfigUpdate({
				categories: args.categories ?? null,
				venues: args.venues ? args.venues.map(toVenueInputDto) : null,
				arxivWatermarks: args.arxivWatermarks
					? toWatermarkMapInputDto(args.arxivWatermarks)
					: null,
				lastRefreshedAt:
					args.lastRefreshedAt !== undefined ? args.lastRefreshedAt : null,
				latestArxiv: args.latestArxiv !== undefined ? args.latestArxiv : null,
			}),
		{ fallback: "Failed to update paper collection configuration" },
	);
	return applySummaryToStore(fromStateSummaryDto(dto), true);
}

export async function listCollectionPapers(
	args: CollectionListPapersQuery = {},
): Promise<CollectionPapersPageResult> {
	const dto = await callApi(
		() =>
			commands.plazaCollectionListPapers({
				sourceType: args.sourceType ?? null,
				category: args.category ?? null,
				timePreset: args.timePreset ?? null,
				dateFrom: args.dateFrom ?? null,
				dateTo: args.dateTo ?? null,
				venueKind: args.venueKind ?? null,
				venueDomain: args.venueDomain ?? null,
				venueId: args.venueId ?? null,
				ccfRanks: args.ccfRanks ?? [],
				sort: args.sort ?? null,
				limit: args.limit ?? 100,
				offset: args.offset ?? 0,
			}),
		{ fallback: "Failed to list collection papers" },
	);
	return {
		items: dto.items.map(fromPaperSummaryDto),
		total: dto.total,
		hasMore: dto.hasMore,
	};
}

export async function getCollectionPaperDetail(
	id: string,
): Promise<CollectionPaperDetailResult | null> {
	const dto = await callApi(() => commands.plazaCollectionPaperGet({ id }), {
		fallback: "Failed to load paper details",
	});
	if (!dto) return null;
	return fromPaperDetailDto(dto);
}

export async function getCollectionPapersByIds(
	ids: readonly string[],
): Promise<CollectionPaperItem[]> {
	const cleaned = ids.map((id) => id.trim()).filter(Boolean);
	if (cleaned.length === 0) return [];
	const rows = await callApi(
		() => commands.plazaCollectionPapersByIds({ ids: cleaned }),
		{ fallback: "Failed to load papers by IDs" },
	);
	return rows.map(fromPaperSummaryDto);
}

export async function upsertCollectionPapers(
	args: CollectionUpsertPapersInput,
): Promise<CollectionStateSummary> {
	const dto = await callApi(
		() =>
			commands.plazaCollectionUpsertPapers({
				items: args.items.map(toPaperUpsertDto),
				replaceVenueId: args.replaceVenueId ?? null,
				replaceSourceLabel: args.replaceSourceLabel ?? null,
				venueUpdate: args.venueUpdate
					? {
							venueId: args.venueUpdate.venueId,
							lastFetchedAt: args.venueUpdate.lastFetchedAt ?? null,
							latestPublishedAt: args.venueUpdate.latestPublishedAt ?? null,
							remoteTotalCount: args.venueUpdate.remoteTotalCount ?? null,
						}
					: null,
				arxivWatermarks: args.arxivWatermarks
					? toWatermarkMapInputDto(args.arxivWatermarks)
					: null,
				lastRefreshedAt: args.lastRefreshedAt ?? null,
				latestArxiv: args.latestArxiv ?? null,
			}),
		{ fallback: "Failed to upsert collection papers" },
	);
	return applySummaryToStore(fromStateSummaryDto(dto), true);
}

export async function patchCollectionPapers(
	patches: readonly CollectionPaperPatchInput[],
): Promise<CollectionStateSummary> {
	if (patches.length === 0) {
		return fetchCollectionStateSummary();
	}
	const dto = await callApi(
		() =>
			commands.plazaCollectionPatchPapers({
				patches: patches.map((p) => ({
					id: p.id,
					abstract: p.abstract ?? null,
					pdfUrl: p.pdfUrl ?? null,
					arxivId: p.arxivId ?? null,
					doi: p.doi ?? null,
					venueFull: p.venueFull ?? null,
					citationCount: p.citationCount ?? null,
					keywords: p.keywords ?? null,
					volume: p.volume ?? null,
					issue: p.issue ?? null,
					pages: p.pages ?? null,
					bibtex: p.bibtex ?? null,
					coolPapersId: p.coolPapersId ?? null,
					recommendedAt: p.recommendedAt ?? null,
				})),
			}),
		{ fallback: "Failed to patch collection papers" },
	);
	return applySummaryToStore(fromStateSummaryDto(dto), true);
}

export async function clearCollection(
	scope: CollectionClearScope,
	venueId?: string | null,
): Promise<CollectionStateSummary> {
	const dto = await callApi(
		() =>
			commands.plazaCollectionClear({
				scope,
				venueId: venueId ?? null,
			}),
		{ fallback: "Failed to clear paper collection" },
	);
	return applySummaryToStore(fromStateSummaryDto(dto), true);
}
