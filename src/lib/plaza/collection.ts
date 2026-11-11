/**
 * Plaza — Paper Collection (2026 arXiv & DBLP 2026 Venue paper pool).
 *
 * Separates arXiv (`cs.SE`, `cs.CR`, `cs.PL` by default with `cs.AI` optional, `2026-Now`)
 * and 28 DBLP 2026 Venues (PL/SE CCF-A & CCF-B Conferences + Journals,
 * CR CCF-A Conferences, AI CCF-A Conferences).
 *
 * PDFs are never downloaded automatically, while complete abstracts, citation
 * counts, citation strings / BibTeX, and keywords are always populated.
 */

import { listenAgentCompleted, listenAgentFailed, runOnce } from "@/lib/agent";
import { commands } from "@/lib/core/bindings";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import {
	ARXIV_CATEGORY_SUBTITLES,
	backfillSpringerAbstracts,
	buildVenuePaperId,
	type CollectionPaperItem,
	type CollectionSourceType,
	CURRENT_VENUE_SYNC_VERSION,
	DBLP_2026_VENUE_SPECS,
	type DblpVenueSpec,
	derivePaperKeywords,
	enrichArxivItemsBatch,
	enrichDblpItemsBatch,
	enrichSinglePaperOnDemand,
	extractSpringerHtmlAbstract,
	type FetchJsonFn,
	type FetchTextFn,
	fetchVenueStructuredPapers,
	formatPaperBibtex,
	formatPaperCitationText,
	inferVenueKind,
	isExcludedByDoiPrefix,
	isFrontmatterTitle,
	isPlaceholderAbstract,
	isWorkshopOrCompanionVenue,
	loadItemsFromIndexedDb,
	reconstructOpenAlexAbstract,
	saveItemsToIndexedDb,
	VENUE_SPEC_BY_ID,
	type VenueCcfRank,
	type VenueConfig,
	type VenueDomain,
	type VenueKind,
} from "@/lib/plaza/collection-enrichment";
import {
	createPoliteFetchJson,
	createPoliteFetchText,
	fetchCoolPapersVenuePapers,
	fetchCsdlVenuePapers,
	fetchDataCiteLipicsPapers,
	fetchDblpSparqlVenuePapers,
	fetchMultiChannelVenuePapers,
	fetchOfficialVenueProgramPapers,
	isConfirmedVenueAcceptance,
	parseAcceptedVenueArxivXml,
	parseCoolPapersVenueHtml,
	parseOfficialVenueProgramHtml,
} from "@/lib/plaza/collection-venue-channels";
import { resolveConfiguredTranslateAgent } from "@/lib/translate/resolve-agent";
import { getVaultPath } from "@/lib/vault/store";
import { webViewProxyUrl } from "@/lib/web-view/proxy-url";

export type {
	CollectionPaperItem,
	CollectionSourceType,
	DblpVenueSpec,
	VenueCcfRank,
	VenueConfig,
	VenueDomain,
	VenueKind,
};
export {
	ARXIV_CATEGORY_SUBTITLES,
	backfillSpringerAbstracts,
	CURRENT_VENUE_SYNC_VERSION,
	DBLP_2026_VENUE_SPECS,
	derivePaperKeywords,
	enrichDblpItemsBatch,
	extractSpringerHtmlAbstract,
	fetchCoolPapersVenuePapers,
	fetchCsdlVenuePapers,
	fetchDataCiteLipicsPapers,
	fetchDblpSparqlVenuePapers,
	fetchMultiChannelVenuePapers,
	fetchOfficialVenueProgramPapers,
	fetchVenueStructuredPapers,
	formatPaperBibtex,
	formatPaperCitationText,
	inferVenueKind,
	isConfirmedVenueAcceptance,
	isFrontmatterTitle,
	isPlaceholderAbstract,
	isWorkshopOrCompanionVenue,
	parseAcceptedVenueArxivXml,
	parseCoolPapersVenueHtml,
	parseOfficialVenueProgramHtml,
	reconstructOpenAlexAbstract,
	VENUE_SPEC_BY_ID,
};

export const DEFAULT_ARXIV_CATEGORIES = ["cs.SE", "cs.CR", "cs.PL"] as const;

export const CURRENT_DEFAULT_CATEGORIES_VERSION = 2;

export type ArxivLatestRecord = {
	arxivId: string;
	title: string;
	publishedAt: string;
	categoriesKey: string;
	checkedAt: string;
};

export type ArxivUpdateCheckResult = {
	hasUpdate: boolean;
	remoteLatestId: string | null;
	remoteLatestTitle: string | null;
	remotePublishedAt: string | null;
	recordedLatestId: string | null;
	newCountEstimate: number;
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

export type CollectionState = {
	categories: string[];
	categoriesVersion?: number;
	venues: VenueConfig[];
	items: CollectionPaperItem[];
	lastRefreshedAt: string | null;
	latestArxiv: ArxivLatestRecord | null;
	arxivWatermarks?: Record<string, ArxivCategoryWatermark>;
};

const STORAGE_KEY = "plaza:collection:state:v2";
const LEGACY_STORAGE_KEY_V1 = "plaza:collection:state:v1";
const LOCAL_STORAGE_MAX_ITEMS = 350;
const TARGET_YEAR = 2026;

export const DEFAULT_COLLECTION_VENUES: readonly VenueConfig[] =
	DBLP_2026_VENUE_SPECS.map((spec) => ({
		id: spec.id,
		name: spec.name,
		url: spec.url,
		mode: "auto",
		kind: spec.kind,
		domain: spec.domain,
		ccfRank: spec.ccfRank,
		dblpStream: spec.dblpStream,
	}));

type Listener = (state: CollectionState) => void;
const listeners = new Set<Listener>();

type PreloadListener = (preloading: boolean) => void;
const preloadListeners = new Set<PreloadListener>();
let preloadingFlag = false;

function setPreloadingFlag(next: boolean): void {
	if (preloadingFlag === next) return;
	preloadingFlag = next;
	for (const l of preloadListeners) l(next);
}

export function isPreloadingCollection(): boolean {
	return preloadingFlag;
}

export function subscribePreloadingCollection(
	listener: PreloadListener,
): () => void {
	preloadListeners.add(listener);
	return () => {
		preloadListeners.delete(listener);
	};
}

function isLegacyDefaultCategories(cats: string[]): boolean {
	const legacySets: readonly (readonly string[])[] = [
		["cs.AI", "cs.CL", "cs.LG", "cs.CV", "stat.ML"],
		["cs.AI", "cs.CR", "cs.PL", "cs.SE"],
		["cs.SE", "cs.CR", "cs.PL", "cs.AI"],
	];
	return legacySets.some(
		(legacy) =>
			cats.length === legacy.length &&
			cats.every((c, idx) => c === legacy[idx]),
	);
}

export function matchesAnyArxivCategory(
	paper: CollectionPaperItem,
	categories: readonly string[],
): boolean {
	if (paper.sourceType !== "arxiv") return true;
	if (categories.length === 0) return true;
	return categories.some(
		(cat) => paper.sourceLabel === cat || paper.categories.includes(cat),
	);
}

/** Reset in-memory collection cache (primarily for unit tests). */
export function resetCollectionMemoryForTests(): void {
	memoryState = null;
	idbHydrated = false;
	idbHydrationPromise = null;
}

let memoryState: CollectionState | null = null;
let idbHydrated = false;
let idbHydrationPromise: Promise<CollectionState> | null = null;

function migrateCachedVenues(venues: VenueConfig[]): VenueConfig[] {
	const migrated = venues.map((venue) => {
		const spec = VENUE_SPEC_BY_ID.get(venue.id);
		if (spec) {
			return {
				...venue,
				name: spec.name,
				url: spec.url,
				mode: "auto" as const,
				kind: spec.kind,
				domain: spec.domain,
				ccfRank: spec.ccfRank,
				dblpStream: spec.dblpStream,
			};
		}
		return {
			...venue,
			kind: inferVenueKind(venue),
		};
	});

	const byId = new Map(migrated.map((v) => [v.id, v]));
	const ordered: VenueConfig[] = [];
	for (const def of DEFAULT_COLLECTION_VENUES) {
		ordered.push(byId.get(def.id) ?? def);
		byId.delete(def.id);
	}
	for (const custom of byId.values()) {
		ordered.push(custom);
	}
	return ordered;
}

function sanitizeCachedItems(
	items: CollectionPaperItem[],
): CollectionPaperItem[] {
	const out: CollectionPaperItem[] = [];
	for (const item of items) {
		if (!Array.isArray(item.authors) || item.authors.length === 0) {
			if (item.sourceType === "venue") continue;
		}
		const cleanedTitle = item.title
			.replace(
				/\s*(?:Distinguished Paper|Virtual Attendance|Artifact Available|Artifact Evaluated)\s*$/gi,
				"",
			)
			.trim();
		if (!cleanedTitle) continue;
		if (item.sourceType === "venue" && isFrontmatterTitle(cleanedTitle)) {
			continue;
		}
		const normalizedAbstract = isPlaceholderAbstract(
			item.abstract,
			item.sourceLabel,
		)
			? ""
			: item.abstract;
		const spec = item.venueId ? VENUE_SPEC_BY_ID.get(item.venueId) : undefined;
		if (
			item.sourceType === "venue" &&
			isExcludedByDoiPrefix(item.doi, spec?.excludeDoiPrefixes)
		) {
			continue;
		}
		const keywords =
			item.keywords && item.keywords.length > 0
				? item.keywords
				: derivePaperKeywords(
						cleanedTitle,
						normalizedAbstract,
						item.categories,
					);
		const normalizedId =
			item.sourceType === "venue" && item.venueId
				? buildVenuePaperId(item.venueId, item.doi, item.arxivId, cleanedTitle)
				: item.id;
		out.push({
			...item,
			id: normalizedId,
			title: cleanedTitle,
			abstract: normalizedAbstract,
			venueKind: item.venueKind ?? spec?.kind,
			venueDomain: item.venueDomain ?? spec?.domain,
			ccfRank: item.ccfRank ?? spec?.ccfRank,
			citationCount: item.citationCount ?? 0,
			keywords,
		});
	}
	return out;
}

export function loadCollectionState(): CollectionState {
	if (memoryState) return memoryState;
	const raw =
		readJsonStorage<Partial<CollectionState> | null>(STORAGE_KEY, null) ??
		readJsonStorage<Partial<CollectionState> | null>(
			LEGACY_STORAGE_KEY_V1,
			null,
		);
	const rawCategories =
		Array.isArray(raw?.categories) && raw.categories.length > 0
			? raw.categories
			: [...DEFAULT_ARXIV_CATEGORIES];
	const shouldMigrateDefaultCategories =
		(raw?.categoriesVersion ?? 0) < CURRENT_DEFAULT_CATEGORIES_VERSION &&
		isLegacyDefaultCategories(rawCategories);
	const categories = shouldMigrateDefaultCategories
		? [...DEFAULT_ARXIV_CATEGORIES]
		: rawCategories;
	const venues =
		Array.isArray(raw?.venues) && raw.venues.length > 0
			? migrateCachedVenues(raw.venues)
			: [...DEFAULT_COLLECTION_VENUES];
	const items = Array.isArray(raw?.items)
		? sanitizeCachedItems(raw.items).filter((item) =>
				matchesAnyArxivCategory(item, categories),
			)
		: [];
	const arxivWatermarks =
		raw?.arxivWatermarks && typeof raw.arxivWatermarks === "object"
			? raw.arxivWatermarks
			: {};
	const loaded: CollectionState = {
		categories,
		categoriesVersion: CURRENT_DEFAULT_CATEGORIES_VERSION,
		venues,
		items,
		lastRefreshedAt:
			typeof raw?.lastRefreshedAt === "string" ? raw.lastRefreshedAt : null,
		latestArxiv: raw?.latestArxiv ?? null,
		arxivWatermarks,
	};
	memoryState = loaded;
	return loaded;
}

export function saveCollectionState(next: CollectionState): void {
	const stamped: CollectionState = {
		...next,
		categoriesVersion:
			next.categoriesVersion ?? CURRENT_DEFAULT_CATEGORIES_VERSION,
		items: next.items.filter((item) =>
			matchesAnyArxivCategory(item, next.categories),
		),
	};
	memoryState = stamped;
	const compactForLocalStorage: CollectionState =
		stamped.items.length > LOCAL_STORAGE_MAX_ITEMS
			? {
					...stamped,
					items: stamped.items.slice(0, LOCAL_STORAGE_MAX_ITEMS),
				}
			: stamped;
	writeJsonStorage(STORAGE_KEY, compactForLocalStorage);

	if (idbHydrated || typeof indexedDB === "undefined") {
		void saveItemsToIndexedDb(stamped.items);
	} else {
		// Prevent overwriting IndexedDB's full paper pool with localStorage's 350-item slice
		// if a save happens before `hydrateCollectionStateFromIdb()` has completed.
		void (async () => {
			const existingIdb = await loadItemsFromIndexedDb();
			idbHydrated = true;
			const latest = loadCollectionState();
			if (!existingIdb || existingIdb.length === 0) {
				await saveItemsToIndexedDb(latest.items);
				return;
			}
			const sanitized = sanitizeCachedItems(existingIdb).filter((item) =>
				matchesAnyArxivCategory(item, latest.categories),
			);
			const merged = mergeCollectionItems([latest.items, sanitized]);
			await saveItemsToIndexedDb(merged);
			if (merged.length > latest.items.length) {
				const hydratedState: CollectionState = { ...latest, items: merged };
				memoryState = hydratedState;
				for (const listener of listeners) {
					listener(hydratedState);
				}
			}
		})();
	}

	for (const listener of listeners) {
		listener(stamped);
	}
}

/**
 * Hydrate full `2026-Now` preloaded pool from IndexedDB into memory state.
 */
export async function hydrateCollectionStateFromIdb(): Promise<CollectionState> {
	const current = loadCollectionState();
	if (idbHydrated) return current;
	if (idbHydrationPromise) return idbHydrationPromise;

	idbHydrationPromise = (async () => {
		const idbItems = await loadItemsFromIndexedDb();
		idbHydrated = true;
		const latest = loadCollectionState();
		if (!idbItems || idbItems.length === 0) return latest;
		const sanitized = sanitizeCachedItems(idbItems).filter((item) =>
			matchesAnyArxivCategory(item, latest.categories),
		);
		if (sanitized.length === 0) return latest;
		const merged = mergeCollectionItems([latest.items, sanitized]);
		if (merged.length <= latest.items.length) return latest;
		const next: CollectionState = { ...latest, items: merged };
		memoryState = next;
		for (const listener of listeners) {
			listener(next);
		}
		return next;
	})().finally(() => {
		idbHydrationPromise = null;
	});

	return idbHydrationPromise;
}

export function subscribeCollectionState(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function hasTauriRuntime(): boolean {
	return (
		typeof window !== "undefined" &&
		("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
	);
}

const CORS_OPEN_HOSTS = new Set([
	"api.openalex.org",
	"api.crossref.org",
	"api.datacite.org",
	"api.semanticscholar.org",
	"sparql.dblp.org",
	"www.computer.org",
]);

function isDblpHost(hostname: string): boolean {
	return /^dblp\.(?:uni-trier\.de|org|dagstuhl\.de)$/i.test(hostname);
}

const DBLP_COOLDOWN_MS =
	typeof import.meta !== "undefined" && import.meta.env?.MODE === "test"
		? 0
		: 30 * 60_000;
const DBLP_MIN_INTERVAL_MS =
	typeof import.meta !== "undefined" && import.meta.env?.MODE === "test"
		? 0
		: 1_600;

let dblpCircuitOpenUntil = 0;
const allowedWebProxyHosts = new Set<string>();

async function ensureWebProxyAllowed(hostname: string): Promise<void> {
	if (!hostname) return;
	const companions =
		hostname === "link.springer.com"
			? ["link.springer.com", "idp.springer.com", "www.nature.com"]
			: hostname === "sigsac.org" || hostname === "www.sigsac.org"
				? ["sigsac.org", "www.sigsac.org"]
				: [hostname];
	for (const h of companions) {
		if (allowedWebProxyHosts.has(h)) continue;
		await commands.webProxyAllowHost({ host: h });
		allowedWebProxyHosts.add(h);
	}
}
let dblpNextSlotMs = 0;

async function acquireDblpSlot(): Promise<void> {
	if (DBLP_MIN_INTERVAL_MS <= 0) return;
	const now = Date.now();
	const scheduled = Math.max(now, dblpNextSlotMs);
	dblpNextSlotMs = scheduled + DBLP_MIN_INTERVAL_MS;
	const wait = scheduled - now;
	if (wait > 0) {
		await new Promise((resolve) => setTimeout(resolve, wait));
	}
}

/**
 * Fetch remote text (XML/JSON/HTML), using direct CORS fetch for open scholarly APIs,
 * routing non-CORS hosts (`export.arxiv.org`, `rss.arxiv.org`, etc.) through `agentero-web`,
 * and enforcing a circuit breaker on DBLP so HTTP 202 anti-bot PoW gates or TCP resets
 * never spam `agentero::web_proxy`.
 */
export async function plazaFetchText(
	url: string,
	accept = "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
): Promise<string> {
	const cleanUrl = url.split("#")[0] || url;
	let hostname = "";
	try {
		hostname = new URL(cleanUrl).hostname.toLowerCase();
	} catch {
		hostname = "";
	}

	const dblpTarget = isDblpHost(hostname);
	if (dblpTarget) {
		if (Date.now() < dblpCircuitOpenUntil) {
			throw new Error(`DBLP circuit breaker active for ${cleanUrl}`);
		}
		await acquireDblpSlot();
		if (Date.now() < dblpCircuitOpenUntil) {
			throw new Error(`DBLP circuit breaker active for ${cleanUrl}`);
		}
	}

	// Fast path: OpenAlex / Crossref / Semantic Scholar send `Access-Control-Allow-Origin: *`
	if (CORS_OPEN_HOSTS.has(hostname)) {
		try {
			const direct = await fetch(cleanUrl, {
				headers: { Accept: accept },
			});
			if (direct.status === 202 || direct.status === 429) {
				throw new Error(`HTTP ${direct.status} fetching ${cleanUrl}`);
			}
			if (direct.ok) {
				return await direct.text();
			}
		} catch (err) {
			if (err instanceof Error && /HTTP (?:202|429)\b/.test(err.message)) {
				throw err;
			}
			// Fall through to proxy fallback if direct fetch failed at network layer.
		}
	}

	if (hasTauriRuntime()) {
		try {
			await ensureWebProxyAllowed(hostname);
			const proxied = webViewProxyUrl(cleanUrl);
			const res = await fetch(proxied, {
				headers: { Accept: accept },
			});
			if (res.status === 202) {
				if (dblpTarget) {
					dblpCircuitOpenUntil = Date.now() + DBLP_COOLDOWN_MS;
				}
				throw new Error(`Upstream anti-bot gate (HTTP 202) for ${cleanUrl}`);
			}
			if (res.ok) {
				return await res.text();
			}
			if (dblpTarget) {
				dblpCircuitOpenUntil = Date.now() + DBLP_COOLDOWN_MS;
				throw new Error(`DBLP upstream HTTP ${res.status} for ${cleanUrl}`);
			}
		} catch (err) {
			if (dblpTarget) {
				dblpCircuitOpenUntil = Date.now() + DBLP_COOLDOWN_MS;
				throw err;
			}
			if (err instanceof Error && err.message.includes("HTTP 202")) {
				throw err;
			}
			// Fall through to direct fetch below for non-DBLP hosts.
		}
	} else if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
		try {
			const proxied = `/__plaza_proxy?url=${encodeURIComponent(cleanUrl)}`;
			const res = await fetch(proxied, {
				headers: { Accept: accept },
			});
			if (res.status === 202) {
				if (dblpTarget) {
					dblpCircuitOpenUntil = Date.now() + DBLP_COOLDOWN_MS;
				}
				throw new Error(`Upstream anti-bot gate (HTTP 202) for ${cleanUrl}`);
			}
			if (res.ok) {
				return await res.text();
			}
			if (dblpTarget) {
				dblpCircuitOpenUntil = Date.now() + DBLP_COOLDOWN_MS;
				throw new Error(`DBLP upstream HTTP ${res.status} for ${cleanUrl}`);
			}
		} catch (err) {
			if (dblpTarget) {
				dblpCircuitOpenUntil = Date.now() + DBLP_COOLDOWN_MS;
				throw err;
			}
			if (err instanceof Error && err.message.includes("HTTP 202")) {
				throw err;
			}
			// Fall through to direct fetch below for non-DBLP hosts.
		}
	}

	const direct = await fetch(cleanUrl, {
		headers: { Accept: accept },
	});
	if (direct.status === 202 || !direct.ok) {
		if (dblpTarget) {
			dblpCircuitOpenUntil = Date.now() + DBLP_COOLDOWN_MS;
		}
		throw new Error(`HTTP ${direct.status} fetching ${cleanUrl}`);
	}
	if (dblpTarget) {
		const bodyText = await direct.text();
		if (bodyText.includes("Making sure you&#39;re not a bot")) {
			dblpCircuitOpenUntil = Date.now() + DBLP_COOLDOWN_MS;
			throw new Error(`DBLP anti-bot challenge for ${cleanUrl}`);
		}
		return bodyText;
	}
	return await direct.text();
}

export async function plazaFetchJson<T = unknown>(url: string): Promise<T> {
	const accept = url.includes("sparql.dblp.org")
		? "application/sparql-results+json, application/json;q=0.9"
		: "application/json";
	const text = await plazaFetchText(url, accept);
	const trimmed = text.trimStart();
	if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
		if (/dblp\.(?:uni-trier\.de|org|dagstuhl\.de)/i.test(url)) {
			dblpCircuitOpenUntil = Date.now() + DBLP_COOLDOWN_MS;
		}
		throw new Error(`Expected JSON but received HTML from ${url}`);
	}
	return JSON.parse(text) as T;
}

const politePlazaFetchJson = createPoliteFetchJson(plazaFetchJson);
const politePlazaFetchText = createPoliteFetchText(plazaFetchText);

function normalizeCategoriesKey(categories: readonly string[]): string {
	return [...categories]
		.map((c) => c.trim().toLowerCase())
		.filter(Boolean)
		.sort()
		.join(",");
}

function stripVersion(arxivId: string): string {
	return arxivId.replace(/v\d+$/i, "").trim();
}

function cleanWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(input: string): string {
	if (typeof DOMParser !== "undefined") {
		try {
			const doc = new DOMParser().parseFromString(input, "text/html");
			return cleanWhitespace(doc.body.textContent ?? input);
		} catch {
			// Fall back to regex replacement.
		}
	}
	return cleanWhitespace(
		input
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'"),
	);
}

/**
 * Parse arXiv Atom API XML (`export.arxiv.org/api/query`) into `CollectionPaperItem[]`.
 */
export function parseArxivAtomXml(
	xmlText: string,
	filterYear: number | null = TARGET_YEAR,
	options?: {
		preferredCategories?: readonly string[];
		defaultCategory?: string;
	},
): CollectionPaperItem[] {
	const items: CollectionPaperItem[] = [];
	const preferredSet = new Set(
		(options?.preferredCategories ?? []).map((c) => c.trim()),
	);
	const fallbackCat = options?.defaultCategory?.trim() || "cs.SE";
	const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
	for (const match of xmlText.matchAll(entryRegex)) {
		const block = match[1] ?? "";
		const rawId = /<id>([\s\S]*?)<\/id>/i.exec(block)?.[1]?.trim() ?? "";
		const rawTitle =
			/<title>([\s\S]*?)<\/title>/i.exec(block)?.[1]?.trim() ?? "";
		const rawSummary =
			/<summary>([\s\S]*?)<\/summary>/i.exec(block)?.[1]?.trim() ?? "";
		const published =
			/<published>([\s\S]*?)<\/published>/i.exec(block)?.[1]?.trim() ?? "";
		const updated =
			/<updated>([\s\S]*?)<\/updated>/i.exec(block)?.[1]?.trim() ?? "";

		if (!rawTitle) continue;

		const idMatch = /arxiv\.org\/abs\/([^\s?#<]+)/i.exec(rawId);
		const arxivId = stripVersion(idMatch ? idMatch[1] : rawId);
		if (!arxivId) continue;

		const dateStr = published || updated;
		const yearMatch = /^(\d{4})/.exec(dateStr);
		const year = yearMatch ? Number(yearMatch[1]) : TARGET_YEAR;

		const authors: string[] = [];
		for (const authorMatch of block.matchAll(
			/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi,
		)) {
			const name = cleanWhitespace(authorMatch[1] ?? "");
			if (name) authors.push(name);
		}

		const categories: string[] = [];
		for (const catMatch of block.matchAll(
			/<category[^>]*\bterm=["']([^"']+)["'][^>]*>/gi,
		)) {
			const term = (catMatch[1] ?? "").trim();
			if (term && !categories.includes(term)) {
				categories.push(term);
			}
		}
		if (
			options?.defaultCategory &&
			!categories.includes(options.defaultCategory)
		) {
			categories.push(options.defaultCategory);
		}

		const rawPrimaryCat =
			/<arxiv:primary_category[^>]*\bterm=["']([^"']+)["']/i.exec(block)?.[1] ??
			categories[0] ??
			fallbackCat;
		const primaryCat =
			preferredSet.size > 0 && !preferredSet.has(rawPrimaryCat)
				? (categories.find((c) => preferredSet.has(c)) ??
					options?.defaultCategory ??
					rawPrimaryCat)
				: rawPrimaryCat;

		const url = `https://arxiv.org/abs/${arxivId}`;
		const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
		const title = decodeHtmlEntities(rawTitle);
		const abstract = decodeHtmlEntities(rawSummary);
		const finalCats = categories.length > 0 ? categories : [primaryCat];

		items.push({
			id: `arxiv:${arxivId}`,
			arxivId,
			doi: `10.48550/arxiv.${arxivId}`,
			title,
			authors,
			abstract,
			publishedAt: dateStr || `${year}-01-01T00:00:00Z`,
			year,
			sourceType: "arxiv",
			sourceLabel: primaryCat,
			categories: finalCats,
			url,
			pdfUrl,
			citationCount: 0,
			keywords: derivePaperKeywords(title, abstract, finalCats),
		});
	}

	if (filterYear !== null) {
		return items.filter((item) => item.year >= filterYear);
	}
	return items;
}

export type ArxivAtomFeedMeta = {
	rawEntryCount: number;
	totalResults?: number;
	oldestPublishedAt?: string;
	newestPublishedAt?: string;
};

/**
 * Extract pagination metadata (`<opensearch:totalResults>`, raw `<entry>` count,
 * and oldest/newest `<published>` timestamps) from an arXiv Atom XML response.
 */
export function parseArxivAtomFeedMeta(xmlText: string): ArxivAtomFeedMeta {
	const totalMatch =
		/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/i.exec(
			xmlText,
		);
	const totalResults = totalMatch?.[1] ? Number(totalMatch[1]) : undefined;
	let rawEntryCount = 0;
	let newestPublishedAt: string | undefined;
	let oldestPublishedAt: string | undefined;

	for (const match of xmlText.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
		rawEntryCount += 1;
		const block = match[1] ?? "";
		const published =
			/<published>([\s\S]*?)<\/published>/i.exec(block)?.[1]?.trim() ||
			/<updated>([\s\S]*?)<\/updated>/i.exec(block)?.[1]?.trim();
		if (published) {
			if (!newestPublishedAt || published > newestPublishedAt) {
				newestPublishedAt = published;
			}
			if (!oldestPublishedAt || published < oldestPublishedAt) {
				oldestPublishedAt = published;
			}
		}
	}

	return {
		rawEntryCount,
		totalResults,
		oldestPublishedAt,
		newestPublishedAt,
	};
}

/**
 * Parse fast `rss.arxiv.org/rss/<cat>` XML (~300 ms) into `CollectionPaperItem[]`
 * with full abstracts, authors, categories, and derived keywords.
 */
export function parseArxivRssXml(
	rssXml: string,
	defaultCategory: string,
	preferredCategories?: readonly string[],
): CollectionPaperItem[] {
	const items: CollectionPaperItem[] = [];
	const preferredSet = new Set(
		(preferredCategories ?? []).map((c) => c.trim()),
	);
	const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
	for (const match of rssXml.matchAll(itemRegex)) {
		const block = match[1] ?? "";
		const rawTitle =
			/<title>([\s\S]*?)<\/title>/i.exec(block)?.[1]?.trim() ?? "";
		const rawLink = /<link>([\s\S]*?)<\/link>/i.exec(block)?.[1]?.trim() ?? "";
		const rawDesc =
			/<description>([\s\S]*?)<\/description>/i.exec(block)?.[1]?.trim() ?? "";
		const rawCreator =
			/<dc:creator>([\s\S]*?)<\/dc:creator>/i.exec(block)?.[1]?.trim() ?? "";
		const rawPubDate =
			/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(block)?.[1]?.trim() ?? "";

		const idMatch = /arxiv\.org\/abs\/([^\s?#<]+)/i.exec(rawLink);
		const arxivId = stripVersion(idMatch ? idMatch[1] : "");
		if (!arxivId || !rawTitle) continue;

		const title = decodeHtmlEntities(
			rawTitle.replace(/\s*\(arXiv:[^)]+\)\s*$/i, ""),
		);
		const decodedDesc = decodeHtmlEntities(rawDesc);
		const abstract = decodedDesc
			.replace(/^arXiv:[^\s]+\s*Announce Type:[^A]*Abstract:\s*/i, "")
			.replace(/^Abstract:\s*/i, "")
			.trim();
		if (isPlaceholderAbstract(abstract)) continue;

		const parsedTs = rawPubDate ? Date.parse(rawPubDate) : Number.NaN;
		const pubDateObj = Number.isNaN(parsedTs) ? new Date() : new Date(parsedTs);
		const year = pubDateObj.getUTCFullYear();
		if (year < TARGET_YEAR) continue;

		const authors = decodeHtmlEntities(rawCreator)
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);

		const categories: string[] = [];
		for (const catMatch of block.matchAll(
			/<category[^>]*>([\s\S]*?)<\/category>/gi,
		)) {
			const term = cleanWhitespace(catMatch[1] ?? "");
			if (term && !categories.includes(term)) categories.push(term);
		}
		if (!categories.includes(defaultCategory)) {
			categories.push(defaultCategory);
		}
		const primaryCat =
			categories.find((c) => preferredSet.has(c)) ?? defaultCategory;

		items.push({
			id: `arxiv:${arxivId}`,
			arxivId,
			doi: `10.48550/arxiv.${arxivId}`,
			title,
			authors,
			abstract,
			publishedAt: pubDateObj.toISOString(),
			year,
			sourceType: "arxiv",
			sourceLabel: primaryCat,
			categories,
			url: `https://arxiv.org/abs/${arxivId}`,
			pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`,
			citationCount: 0,
			keywords: derivePaperKeywords(title, abstract, categories),
		});
	}
	return items;
}

async function fetchArxivRssFast(
	cat: string,
	cleanCats: readonly string[],
	fetchTextFn: FetchTextFn = plazaFetchText,
): Promise<CollectionPaperItem[]> {
	try {
		const xml = await fetchTextFn(
			`https://rss.arxiv.org/rss/${encodeURIComponent(cat)}`,
			"application/rss+xml,application/xml,text/xml,*/*",
		);
		return parseArxivRssXml(xml, cat, cleanCats);
	} catch {
		return [];
	}
}

function formatArxivDateStamp(utcMs: number): string {
	const d = new Date(utcMs);
	const yyyy = String(d.getUTCFullYear());
	const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(d.getUTCDate()).padStart(2, "0");
	const hh = String(d.getUTCHours()).padStart(2, "0");
	const min = String(d.getUTCMinutes()).padStart(2, "0");
	return `${yyyy}${mm}${dd}${hh}${min}`;
}

function toArxivSubmittedDateStamp(
	isoString: string,
	overlapHours = 12,
): string {
	const parsed = Date.parse(isoString);
	const min2026 = Date.UTC(TARGET_YEAR, 0, 1, 0, 0, 0);
	const adjusted = Number.isNaN(parsed)
		? min2026
		: Math.max(min2026, parsed - overlapHours * 3_600_000);
	return formatArxivDateStamp(adjusted);
}

/**
 * Convert an oldest-seen `<published>` ISO timestamp into an inclusive upper bound
 * `YYYYMMDDHHMM` (+1 minute overlap deduplicated by `mergeCollectionItems`) for
 * sliding `submittedDate:[202601010000 TO toStamp]` backward without deep `start` offsets.
 */
function toArxivUpperDateStamp(isoString: string, minusMinutes = 0): string {
	const parsed = Date.parse(isoString);
	if (Number.isNaN(parsed)) return "209912312359";
	const min2026 = Date.UTC(TARGET_YEAR, 0, 1, 0, 0, 0);
	const roundedUpMinute =
		Math.floor(parsed / 60_000) * 60_000 + (1 - minusMinutes) * 60_000;
	return formatArxivDateStamp(Math.max(min2026, roundedUpMinute));
}

type ArxivCategoryPageResult = {
	items: CollectionPaperItem[];
	rawEntryCount: number;
	totalResults?: number;
	oldestPublishedAt?: string;
	newestPublishedAt?: string;
	historyComplete: boolean;
};

async function fetchArxivCategoryPageWithRetry(
	cat: string,
	cleanCats: readonly string[],
	maxResults: number,
	options?: {
		startOffset?: number;
		fromSubmittedStamp?: string;
		toSubmittedStamp?: string;
		fetchTextFn?: FetchTextFn;
	},
): Promise<ArxivCategoryPageResult> {
	const startOffset = options?.startOffset ?? 0;
	const fromStamp = options?.fromSubmittedStamp || `${TARGET_YEAR}01010000`;
	const toStamp = options?.toSubmittedStamp || "209912312359";
	const fetchTextFn = options?.fetchTextFn ?? politePlazaFetchText;
	const dateBound = `+AND+submittedDate:[${fromStamp}+TO+${toStamp}]`;
	const apiUrl = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(cat)}${dateBound}&sortBy=submittedDate&sortOrder=descending&start=${startOffset}&max_results=${maxResults}`;

	let lastErr: unknown = null;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const xml = await fetchTextFn(
				apiUrl,
				"application/atom+xml,text/xml,*/*",
			);
			const meta = parseArxivAtomFeedMeta(xml);
			const parsed = parseArxivAtomXml(xml, TARGET_YEAR, {
				preferredCategories: cleanCats,
				defaultCategory: cat,
			});

			const isTransientEmpty =
				meta.rawEntryCount === 0 &&
				(meta.totalResults === undefined || meta.totalResults > startOffset);

			if (!isTransientEmpty || attempt === 2) {
				const oldestYearMatch = /^(\d{4})/.exec(meta.oldestPublishedAt ?? "");
				const oldestYear = oldestYearMatch
					? Number(oldestYearMatch[1])
					: TARGET_YEAR;
				const historyComplete =
					fromStamp === `${TARGET_YEAR}01010000` &&
					!isTransientEmpty &&
					(meta.rawEntryCount < maxResults || oldestYear < TARGET_YEAR);

				return {
					items: parsed,
					rawEntryCount: meta.rawEntryCount,
					totalResults: meta.totalResults,
					oldestPublishedAt: meta.oldestPublishedAt,
					newestPublishedAt: meta.newestPublishedAt,
					historyComplete,
				};
			}
		} catch (err) {
			lastErr = err;
		}
		if (
			typeof import.meta === "undefined" ||
			import.meta.env?.MODE !== "test"
		) {
			await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
		}
	}
	if (lastErr) throw lastErr;
	return {
		items: [],
		rawEntryCount: 0,
		historyComplete: false,
	};
}

/**
 * Fetch 2026-Now arXiv papers for the given categories (`cs.SE`, `cs.CR`, `cs.PL`, `cs.AI`).
 * Combines fast `rss.arxiv.org` feeds with `export.arxiv.org` `2026-Now` date-bounded pages,
 * plus OpenAlex batch enrichment for citation counts and keywords.
 */
export async function fetchArxivCollection(
	categories: readonly string[],
	maxResultsPerCategory = 300,
	startOffset = 0,
	transport?: {
		fetchText?: FetchTextFn;
		fetchJson?: FetchJsonFn;
	},
): Promise<{
	items: CollectionPaperItem[];
	latest: ArxivLatestRecord | null;
	pageMetaByCategory?: Record<
		string,
		{
			totalResults?: number;
			oldestPublishedAt?: string;
			historyComplete: boolean;
		}
	>;
}> {
	const cleanCats = categories.map((c) => c.trim()).filter(Boolean);
	if (cleanCats.length === 0) {
		return { items: [], latest: null, pageMetaByCategory: {} };
	}
	const fetchTextFn = transport?.fetchText ?? politePlazaFetchText;
	const fetchJsonFn = transport?.fetchJson ?? politePlazaFetchJson;

	const rssPromise =
		startOffset === 0
			? Promise.allSettled(
					cleanCats.map((cat) =>
						fetchArxivRssFast(
							cat,
							cleanCats,
							transport?.fetchText ?? plazaFetchText,
						),
					),
				)
			: Promise.resolve([]);

	const [rssResults, perCatResults] = await Promise.all([
		rssPromise,
		Promise.allSettled(
			cleanCats.map((cat) =>
				fetchArxivCategoryPageWithRetry(cat, cleanCats, maxResultsPerCategory, {
					startOffset,
					fetchTextFn,
				}),
			),
		),
	]);

	const groups: CollectionPaperItem[][] = [];
	for (const outcome of rssResults) {
		if (outcome.status === "fulfilled" && outcome.value.length > 0) {
			groups.push(outcome.value);
		}
	}

	const pageMetaByCategory: Record<
		string,
		{
			totalResults?: number;
			oldestPublishedAt?: string;
			historyComplete: boolean;
		}
	> = {};
	const failedCats: string[] = [];
	for (let i = 0; i < cleanCats.length; i++) {
		const outcome = perCatResults[i];
		const cat = cleanCats[i];
		if (outcome?.status === "fulfilled" && cat) {
			pageMetaByCategory[cat] = {
				totalResults: outcome.value.totalResults,
				oldestPublishedAt: outcome.value.oldestPublishedAt,
				historyComplete: outcome.value.historyComplete,
			};
			if (outcome.value.items.length > 0) {
				groups.push(outcome.value.items);
			}
		} else if (cat) {
			failedCats.push(cat);
		}
	}

	if (failedCats.length > 0 && groups.length === 0) {
		const catQuery =
			failedCats.length === 1
				? `cat:${failedCats[0]}`
				: `(${failedCats.map((c) => `cat:${c}`).join("+OR+")})`;
		const apiUrl = `https://export.arxiv.org/api/query?search_query=${catQuery}+AND+submittedDate:[${TARGET_YEAR}01010000+TO+209912312359]&sortBy=submittedDate&sortOrder=descending&start=${startOffset}&max_results=${maxResultsPerCategory * failedCats.length}`;
		const xml = await fetchTextFn(apiUrl, "application/atom+xml,text/xml,*/*");
		groups.push(
			parseArxivAtomXml(xml, TARGET_YEAR, {
				preferredCategories: cleanCats,
			}),
		);
	}

	const rawMerged = mergeCollectionItems(groups);
	const items = await enrichArxivItemsBatch(rawMerged, fetchJsonFn, 180);
	const newest = items[0] ?? null;
	const latest: ArxivLatestRecord | null = newest
		? {
				arxivId: newest.arxivId ?? newest.id,
				title: newest.title,
				publishedAt: newest.publishedAt,
				categoriesKey: normalizeCategoriesKey(cleanCats),
				checkedAt: new Date().toISOString(),
			}
		: null;
	return { items, latest, pageMetaByCategory };
}

/**
 * Timestamp-diff incremental sync for arXiv categories:
 * Probes `max_results=1` per warm category first; skips full XML & OpenAlex enrichment
 * when `(latestArxivId, latestPublishedAt)` has not advanced, and fetches/enriches ONLY
 * the incremental delta (`submittedDate:[watermark TO now]`) when newer papers exist.
 */
export async function syncArxivCategoriesIncremental(
	categories: readonly string[],
	existingItems: readonly CollectionPaperItem[],
	existingWatermarks: Record<string, ArxivCategoryWatermark>,
	incremental = true,
	transport?: {
		fetchText?: FetchTextFn;
		fetchJson?: FetchJsonFn;
		onCategoryStatus?: (
			category: string,
			status: "refreshing" | "done" | "error",
		) => void;
	},
): Promise<{
	deltaItems: CollectionPaperItem[];
	nextWatermarks: Record<string, ArxivCategoryWatermark>;
	latest: ArxivLatestRecord | null;
	coldStartCategories: string[];
}> {
	const fetchTextFn = transport?.fetchText ?? politePlazaFetchText;
	const fetchJsonFn = transport?.fetchJson ?? politePlazaFetchJson;
	const onCategoryStatus = transport?.onCategoryStatus;
	const cleanCats = categories.map((c) => c.trim()).filter(Boolean);
	const nextWatermarks: Record<string, ArxivCategoryWatermark> = {
		...existingWatermarks,
	};
	if (cleanCats.length === 0) {
		return {
			deltaItems: [],
			nextWatermarks,
			latest: null,
			coldStartCategories: [],
		};
	}

	const knownArxivIds = new Set(
		existingItems.filter((i) => i.sourceType === "arxiv").map((i) => i.id),
	);
	const coldStartCategories: string[] = [];
	const warmCategories: string[] = [];

	for (const cat of cleanCats) {
		const hasCached = existingItems.some(
			(i) =>
				i.sourceType === "arxiv" &&
				(i.sourceLabel === cat || i.categories.includes(cat)),
		);
		if (incremental && hasCached && existingWatermarks[cat]) {
			warmCategories.push(cat);
		} else {
			coldStartCategories.push(cat);
		}
	}

	const rawDeltaGroups: CollectionPaperItem[][] = [];
	const nowIso = new Date().toISOString();

	if (warmCategories.length > 0) {
		await Promise.allSettled(
			warmCategories.map(async (cat) => {
				const wm = existingWatermarks[cat];
				if (!wm) return;
				onCategoryStatus?.(cat, "refreshing");
				try {
					const probeUrl = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(cat)}+AND+submittedDate:[${TARGET_YEAR}01010000+TO+209912312359]&sortBy=submittedDate&sortOrder=descending&start=0&max_results=1`;
					const probeXml = await fetchTextFn(
						probeUrl,
						"application/atom+xml,text/xml,*/*",
					);
					const probeMeta = parseArxivAtomFeedMeta(probeXml);
					const probeParsed = parseArxivAtomXml(probeXml, TARGET_YEAR, {
						preferredCategories: cleanCats,
						defaultCategory: cat,
					});
					const top = probeParsed[0];
					if (
						top &&
						stripVersion(top.arxivId ?? "") ===
							stripVersion(wm.latestArxivId) &&
						top.publishedAt <= wm.latestPublishedAt
					) {
						nextWatermarks[cat] = {
							...wm,
							remoteTotal: probeMeta.totalResults ?? wm.remoteTotal,
							lastSyncedAt: nowIso,
						};
						onCategoryStatus?.(cat, "done");
						return;
					}

					// Newer timestamp detected -> pull ONLY incremental window since watermark
					const fromStamp = toArxivSubmittedDateStamp(wm.latestPublishedAt, 12);
					const [rssItems, deltaPage] = await Promise.all([
						fetchArxivRssFast(cat, cleanCats, fetchTextFn),
						fetchArxivCategoryPageWithRetry(cat, cleanCats, 300, {
							startOffset: 0,
							fromSubmittedStamp: fromStamp,
							fetchTextFn,
						}),
					]);
					const combinedCat = mergeCollectionItems([rssItems, deltaPage.items]);
					const newestCat = combinedCat[0] ?? top;
					if (newestCat) {
						nextWatermarks[cat] = {
							...wm,
							latestArxivId: stripVersion(newestCat.arxivId ?? newestCat.id),
							latestPublishedAt:
								newestCat.publishedAt > wm.latestPublishedAt
									? newestCat.publishedAt
									: wm.latestPublishedAt,
							remoteTotal: probeMeta.totalResults ?? wm.remoteTotal,
							lastSyncedAt: nowIso,
						};
					}
					const unseen = combinedCat.filter(
						(item) => !knownArxivIds.has(item.id),
					);
					if (unseen.length > 0) {
						rawDeltaGroups.push(unseen);
					}
					onCategoryStatus?.(cat, "done");
				} catch (err) {
					onCategoryStatus?.(cat, "error");
					throw err;
				}
			}),
		);
	}

	let enrichedDelta: CollectionPaperItem[] = [];
	if (rawDeltaGroups.length > 0) {
		const mergedWarmDelta = mergeCollectionItems(rawDeltaGroups);
		enrichedDelta = await enrichArxivItemsBatch(
			mergedWarmDelta,
			fetchJsonFn,
			180,
		);
	}

	let coldFetchedItems: CollectionPaperItem[] = [];
	if (coldStartCategories.length > 0) {
		for (const cat of coldStartCategories) {
			onCategoryStatus?.(cat, "refreshing");
		}
		try {
			const coldRes = await fetchArxivCollection(
				coldStartCategories,
				300,
				0,
				transport,
			);
			coldFetchedItems = coldRes.items;
			for (const cat of coldStartCategories) {
				const catItems = coldFetchedItems.filter(
					(i) => i.sourceLabel === cat || i.categories.includes(cat),
				);
				const newestForCat = catItems[0];
				const oldestForCat = catItems[catItems.length - 1];
				const pageMeta = coldRes.pageMetaByCategory?.[cat];
				if (newestForCat) {
					nextWatermarks[cat] = {
						latestArxivId: stripVersion(
							newestForCat.arxivId ?? newestForCat.id,
						),
						latestPublishedAt: newestForCat.publishedAt,
						lastSyncedAt: nowIso,
						oldestSyncedPublishedAt:
							pageMeta?.oldestPublishedAt ?? oldestForCat?.publishedAt,
						remoteTotal: pageMeta?.totalResults,
						historyComplete: pageMeta?.historyComplete ?? false,
					};
				} else if (pageMeta?.historyComplete) {
					nextWatermarks[cat] = {
						latestArxivId: "",
						latestPublishedAt: `${TARGET_YEAR}-01-01T00:00:00Z`,
						lastSyncedAt: nowIso,
						remoteTotal: pageMeta.totalResults ?? 0,
						historyComplete: true,
					};
				}
				onCategoryStatus?.(cat, "done");
			}
		} catch (err) {
			for (const cat of coldStartCategories) {
				onCategoryStatus?.(cat, "error");
			}
			throw err;
		}
	}

	const allDelta = mergeCollectionItems([enrichedDelta, coldFetchedItems]);
	const overallNewest =
		allDelta[0] ?? existingItems.find((i) => i.sourceType === "arxiv") ?? null;
	const latest: ArxivLatestRecord | null = overallNewest
		? {
				arxivId: overallNewest.arxivId ?? overallNewest.id,
				title: overallNewest.title,
				publishedAt: overallNewest.publishedAt,
				categoriesKey: normalizeCategoriesKey(cleanCats),
				checkedAt: nowIso,
			}
		: null;

	return {
		deltaItems: allDelta,
		nextWatermarks,
		latest,
		coldStartCategories,
	};
}

let activePreloadRunId = 0;

/**
 * Background preloader that walks `2026-Now` arXiv categories backward using
 * sliding `submittedDate:[202601010000 TO toStamp]` windows (`start=0`, polite rate limit)
 * until every category reaches `2026-01-01` (`historyComplete: true`).
 * Persists `oldestSyncedPublishedAt` after each page so interrupted sessions resume seamlessly.
 */
export async function preloadAll2026ArxivInBackground(
	categories?: readonly string[],
	maxPages = 25,
	perPage = 300,
	transport?: {
		fetchText?: FetchTextFn;
		fetchJson?: FetchJsonFn;
	},
): Promise<void> {
	const initialSnap = loadCollectionState();
	const baseCats = (
		categories && categories.length > 0
			? [...categories]
			: initialSnap.categories
	)
		.map((c) => c.trim())
		.filter(Boolean);
	const pendingCats = baseCats.filter(
		(cat) => !initialSnap.arxivWatermarks?.[cat]?.historyComplete,
	);
	if (pendingCats.length === 0) return;

	const runId = ++activePreloadRunId;
	setPreloadingFlag(true);
	const fetchTextFn = transport?.fetchText ?? politePlazaFetchText;
	const fetchJsonFn = transport?.fetchJson ?? politePlazaFetchJson;

	type CatCursor = {
		toStamp: string;
		startOffset: number;
		oldestSyncedPublishedAt?: string;
		remoteTotal?: number;
	};
	const cursors = new Map<string, CatCursor>();
	for (const cat of pendingCats) {
		const wm = initialSnap.arxivWatermarks?.[cat];
		// Only resume from `oldestSyncedPublishedAt` if a prior contiguous cursor recorded it;
		// legacy pre-watermark caches start from `"209912312359"` to heal any mid-year gaps.
		const resumeIso = wm?.oldestSyncedPublishedAt;
		cursors.set(cat, {
			toStamp: resumeIso ? toArxivUpperDateStamp(resumeIso) : "209912312359",
			startOffset: 0,
			oldestSyncedPublishedAt: resumeIso,
			remoteTotal: wm?.remoteTotal,
		});
	}

	try {
		let activeCats = [...pendingCats];
		for (let page = 1; page <= maxPages && activeCats.length > 0; page++) {
			if (runId !== activePreloadRunId) return;
			const stillActive: string[] = [];
			const pageGroups: CollectionPaperItem[][] = [];
			const watermarkUpdates: Record<
				string,
				Partial<ArxivCategoryWatermark>
			> = {};

			for (const cat of activeCats) {
				if (runId !== activePreloadRunId) return;
				const curCursor = cursors.get(cat);
				if (!curCursor) continue;

				try {
					const pageRes = await fetchArxivCategoryPageWithRetry(
						cat,
						loadCollectionState().categories,
						perPage,
						{
							startOffset: curCursor.startOffset,
							toSubmittedStamp: curCursor.toStamp,
							fetchTextFn,
						},
					);

					if (pageRes.items.length > 0) {
						pageGroups.push(pageRes.items);
					}
					if (
						curCursor.toStamp === "209912312359" &&
						curCursor.startOffset === 0 &&
						typeof pageRes.totalResults === "number"
					) {
						curCursor.remoteTotal = pageRes.totalResults;
					}

					const nextOldest =
						pageRes.oldestPublishedAt ??
						pageRes.items[pageRes.items.length - 1]?.publishedAt ??
						curCursor.oldestSyncedPublishedAt;

					const newestItem = pageRes.items[0];
					watermarkUpdates[cat] = {
						...(newestItem
							? {
									latestArxivId: stripVersion(
										newestItem.arxivId ?? newestItem.id,
									),
									latestPublishedAt: newestItem.publishedAt,
								}
							: {}),
						oldestSyncedPublishedAt: nextOldest,
						remoteTotal: curCursor.remoteTotal,
						historyComplete: pageRes.historyComplete,
					};

					if (!pageRes.historyComplete && pageRes.rawEntryCount > 0) {
						const candidateStamp = nextOldest
							? toArxivUpperDateStamp(nextOldest)
							: curCursor.toStamp;
						if (candidateStamp < curCursor.toStamp) {
							curCursor.toStamp = candidateStamp;
							curCursor.startOffset = 0;
							curCursor.oldestSyncedPublishedAt = nextOldest;
						} else if (curCursor.startOffset + perPage < 900 && nextOldest) {
							curCursor.startOffset += perPage;
						} else if (nextOldest) {
							curCursor.toStamp = toArxivUpperDateStamp(nextOldest, 2);
							curCursor.startOffset = 0;
							curCursor.oldestSyncedPublishedAt = nextOldest;
						}
						if (curCursor.toStamp > `${TARGET_YEAR}01010000`) {
							stillActive.push(cat);
						} else {
							watermarkUpdates[cat] = {
								...watermarkUpdates[cat],
								historyComplete: true,
							};
						}
					}
				} catch {
					// Transient network/rate-limit failure: stop this category for the current run;
					// persisted `oldestSyncedPublishedAt` lets the next refresh/open resume cleanly.
				}
			}

			if (runId !== activePreloadRunId) break;
			const cur = loadCollectionState();
			const existingIdSet = new Set(cur.items.map((i) => i.id));
			const batchMerged =
				pageGroups.length > 0 ? mergeCollectionItems(pageGroups) : [];
			const unseenBatch = batchMerged.filter((i) => !existingIdSet.has(i.id));
			const enrichedUnseen =
				unseenBatch.length > 0
					? await enrichArxivItemsBatch(unseenBatch, fetchJsonFn, 135)
					: [];

			const latestCur = loadCollectionState();
			const nextItems =
				enrichedUnseen.length > 0
					? mergeCollectionItems([latestCur.items, enrichedUnseen])
					: latestCur.items;

			const nextWms: Record<string, ArxivCategoryWatermark> = {
				...(latestCur.arxivWatermarks ?? {}),
			};
			const nowIso = new Date().toISOString();
			for (const [cat, patch] of Object.entries(watermarkUpdates)) {
				const prevWm = nextWms[cat];
				const latestArxivId =
					prevWm?.latestArxivId || patch.latestArxivId || "";
				const latestPublishedAt =
					prevWm?.latestPublishedAt && patch.latestPublishedAt
						? prevWm.latestPublishedAt >= patch.latestPublishedAt
							? prevWm.latestPublishedAt
							: patch.latestPublishedAt
						: prevWm?.latestPublishedAt ||
							patch.latestPublishedAt ||
							`${TARGET_YEAR}-01-01T00:00:00Z`;
				nextWms[cat] = {
					...prevWm,
					latestArxivId,
					latestPublishedAt,
					lastSyncedAt: prevWm?.lastSyncedAt ?? nowIso,
					oldestSyncedPublishedAt:
						patch.oldestSyncedPublishedAt ?? prevWm?.oldestSyncedPublishedAt,
					remoteTotal: patch.remoteTotal ?? prevWm?.remoteTotal,
					historyComplete: Boolean(
						prevWm?.historyComplete || patch.historyComplete,
					),
				};
			}

			if (
				enrichedUnseen.length > 0 ||
				Object.keys(watermarkUpdates).length > 0
			) {
				saveCollectionState({
					...latestCur,
					items: nextItems,
					arxivWatermarks: nextWms,
				});
			}

			activeCats = stillActive;
		}
	} finally {
		if (runId === activePreloadRunId) {
			setPreloadingFlag(false);
		}
	}
}

/**
 * Paginate deeper into 2026 arXiv submissions per category using each category's own
 * `oldestSyncedPublishedAt` cursor (rather than dividing total pool size across categories)
 * and merge into the persisted Paper Collection state.
 */
export async function fetchMoreArxivCollection(options?: {
	categories?: readonly string[];
	startOffset?: number;
	maxResultsPerCategory?: number;
	transport?: {
		fetchText?: FetchTextFn;
		fetchJson?: FetchJsonFn;
	};
}): Promise<{ state: CollectionState; addedCount: number }> {
	const current = loadCollectionState();
	const categories = (
		options?.categories && options.categories.length > 0
			? [...options.categories]
			: current.categories
	)
		.map((c) => c.trim())
		.filter(Boolean);
	const maxPerCat = options?.maxResultsPerCategory ?? 300;
	const fetchTextFn = options?.transport?.fetchText ?? politePlazaFetchText;
	const fetchJsonFn = options?.transport?.fetchJson ?? politePlazaFetchJson;

	if (typeof options?.startOffset === "number") {
		const fetched = await fetchArxivCollection(
			categories,
			maxPerCat,
			options.startOffset,
			options.transport,
		);
		const latestSnap = loadCollectionState();
		const merged = mergeCollectionItems([latestSnap.items, fetched.items]);
		const addedCount = Math.max(0, merged.length - latestSnap.items.length);
		const nextState: CollectionState = {
			...latestSnap,
			items: merged,
			lastRefreshedAt: new Date().toISOString(),
		};
		saveCollectionState(nextState);
		return { state: nextState, addedCount };
	}

	const pageGroups: CollectionPaperItem[][] = [];
	const wmPatches: Record<string, Partial<ArxivCategoryWatermark>> = {};

	for (const cat of categories) {
		const wm = current.arxivWatermarks?.[cat];
		if (wm?.historyComplete) continue;

		let oldestForCat = wm?.oldestSyncedPublishedAt;
		if (!oldestForCat) {
			for (const item of current.items) {
				if (
					item.sourceType === "arxiv" &&
					(item.sourceLabel === cat || item.categories.includes(cat))
				) {
					if (!oldestForCat || item.publishedAt < oldestForCat) {
						oldestForCat = item.publishedAt;
					}
				}
			}
		}

		const toStamp = oldestForCat
			? toArxivUpperDateStamp(oldestForCat)
			: "209912312359";
		const pageRes = await fetchArxivCategoryPageWithRetry(
			cat,
			current.categories,
			maxPerCat,
			{
				startOffset: 0,
				toSubmittedStamp: toStamp,
				fetchTextFn,
			},
		);
		if (pageRes.items.length > 0) {
			pageGroups.push(pageRes.items);
		}
		wmPatches[cat] = {
			oldestSyncedPublishedAt:
				pageRes.oldestPublishedAt ??
				pageRes.items[pageRes.items.length - 1]?.publishedAt ??
				oldestForCat,
			remoteTotal:
				toStamp === "209912312359"
					? (pageRes.totalResults ?? wm?.remoteTotal)
					: wm?.remoteTotal,
			historyComplete: pageRes.historyComplete,
		};
	}

	const latestSnap = loadCollectionState();
	const existingIds = new Set(latestSnap.items.map((i) => i.id));
	const rawBatch =
		pageGroups.length > 0 ? mergeCollectionItems(pageGroups) : [];
	const unseen = rawBatch.filter((i) => !existingIds.has(i.id));
	const enriched =
		unseen.length > 0
			? await enrichArxivItemsBatch(unseen, fetchJsonFn, 150)
			: [];

	const merged =
		enriched.length > 0
			? mergeCollectionItems([latestSnap.items, enriched])
			: latestSnap.items;
	const addedCount = Math.max(0, merged.length - latestSnap.items.length);
	const nowIso = new Date().toISOString();
	const nextWatermarks: Record<string, ArxivCategoryWatermark> = {
		...(latestSnap.arxivWatermarks ?? {}),
	};
	for (const [cat, patch] of Object.entries(wmPatches)) {
		const prev = nextWatermarks[cat];
		if (prev) {
			nextWatermarks[cat] = {
				...prev,
				...patch,
				historyComplete: Boolean(prev.historyComplete || patch.historyComplete),
			};
		} else {
			const newestCat = merged.find(
				(i) =>
					i.sourceType === "arxiv" &&
					(i.sourceLabel === cat || i.categories.includes(cat)),
			);
			if (newestCat) {
				nextWatermarks[cat] = {
					latestArxivId: stripVersion(newestCat.arxivId ?? newestCat.id),
					latestPublishedAt: newestCat.publishedAt,
					lastSyncedAt: nowIso,
					...patch,
				};
			}
		}
	}

	const nextState: CollectionState = {
		...latestSnap,
		items: merged,
		arxivWatermarks: nextWatermarks,
		lastRefreshedAt: nowIso,
	};
	saveCollectionState(nextState);
	return { state: nextState, addedCount };
}

/**
 * Search arXiv papers on-demand across the configured categories (`cs.SE`, `cs.CR`, `cs.PL`, `cs.AI`)
 * so user searches in Paper Collection are not limited to the initial cached snapshot.
 */
export async function searchArxivCollection(
	query: string,
	categories: readonly string[] = DEFAULT_ARXIV_CATEGORIES,
	maxResults = 40,
): Promise<CollectionPaperItem[]> {
	const trimmed = query.trim();
	if (trimmed.length < 2) return [];
	const cleanCats =
		categories.length > 0
			? categories.map((c) => c.trim()).filter(Boolean)
			: [...DEFAULT_ARXIV_CATEGORIES];

	const bareArxivMatch = /^(?:arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?$/i.exec(
		trimmed,
	);
	if (bareArxivMatch?.[1]) {
		const idUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(bareArxivMatch[1])}&max_results=5`;
		const xml = await plazaFetchText(
			idUrl,
			"application/atom+xml,text/xml,*/*",
		);
		return parseArxivAtomXml(xml, null, {
			preferredCategories: cleanCats,
		});
	}

	const tokens = trimmed
		.split(/\s+/)
		.map((t) => t.replace(/[()"']/g, "").trim())
		.filter((t) => t.length >= 2);
	if (tokens.length === 0) return [];

	const termExpr =
		tokens.length === 1
			? `all:${encodeURIComponent(tokens[0] ?? "")}`
			: `(${tokens.map((t) => `all:${encodeURIComponent(t)}`).join("+AND+")})`;
	const catExpr =
		cleanCats.length === 1
			? `cat:${cleanCats[0]}`
			: `(${cleanCats.map((c) => `cat:${c}`).join("+OR+")})`;

	const searchQuery = `(${termExpr})+AND+${catExpr}`;
	const [byDate, byRelevance] = await Promise.allSettled([
		plazaFetchText(
			`https://export.arxiv.org/api/query?search_query=${searchQuery}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`,
			"application/atom+xml,text/xml,*/*",
		),
		plazaFetchText(
			`https://export.arxiv.org/api/query?search_query=${searchQuery}&sortBy=relevance&sortOrder=descending&max_results=${maxResults}`,
			"application/atom+xml,text/xml,*/*",
		),
	]);

	const groups: CollectionPaperItem[][] = [];
	if (byDate.status === "fulfilled") {
		groups.push(
			parseArxivAtomXml(byDate.value, TARGET_YEAR, {
				preferredCategories: cleanCats,
			}),
		);
	}
	if (byRelevance.status === "fulfilled") {
		groups.push(
			parseArxivAtomXml(byRelevance.value, TARGET_YEAR, {
				preferredCategories: cleanCats,
			}),
		);
	}
	return mergeCollectionItems(groups);
}

/**
 * Lightweight check against arXiv's latest submissions for the configured categories.
 * Compares the newest remote arXiv submission with our recorded `latestArxiv` state.
 */
export async function checkArxivCollectionUpdate(
	categories?: readonly string[],
): Promise<ArxivUpdateCheckResult> {
	const state = loadCollectionState();
	const activeCats =
		categories && categories.length > 0 ? categories : state.categories;
	const cleanCats = activeCats.map((c) => c.trim()).filter(Boolean);
	const checkedAt = new Date().toISOString();

	if (cleanCats.length === 0) {
		return {
			hasUpdate: false,
			remoteLatestId: null,
			remoteLatestTitle: null,
			remotePublishedAt: null,
			recordedLatestId: state.latestArxiv?.arxivId ?? null,
			newCountEstimate: 0,
			checkedAt,
		};
	}

	const catQuery =
		cleanCats.length === 1
			? `cat:${cleanCats[0]}`
			: `(${cleanCats.map((c) => `cat:${c}`).join("+OR+")})`;
	const probeUrl = `https://export.arxiv.org/api/query?search_query=${catQuery}&sortBy=submittedDate&sortOrder=descending&max_results=10`;
	const xml = await plazaFetchText(
		probeUrl,
		"application/atom+xml,text/xml,*/*",
	);
	const remoteItems = parseArxivAtomXml(xml, null);
	const remoteTop = remoteItems[0] ?? null;

	const recordedId =
		state.latestArxiv?.arxivId ??
		state.items.find((i) => i.sourceType === "arxiv")?.arxivId ??
		null;

	if (!remoteTop) {
		return {
			hasUpdate: false,
			remoteLatestId: null,
			remoteLatestTitle: null,
			remotePublishedAt: null,
			recordedLatestId: recordedId,
			newCountEstimate: 0,
			checkedAt,
		};
	}

	const knownArxivIds = new Set(
		state.items
			.filter((i) => i.sourceType === "arxiv")
			.map((i) => stripVersion(i.arxivId ?? i.id.replace(/^arxiv:/, ""))),
	);

	const remoteTopId = stripVersion(remoteTop.arxivId ?? remoteTop.id);
	let newCountEstimate = 0;
	for (const item of remoteItems) {
		const id = stripVersion(item.arxivId ?? item.id);
		if (!knownArxivIds.has(id)) {
			newCountEstimate += 1;
		} else {
			break;
		}
	}

	const hasUpdate =
		!recordedId ||
		stripVersion(recordedId) !== remoteTopId ||
		newCountEstimate > 0;

	return {
		hasUpdate,
		remoteLatestId: remoteTopId,
		remoteLatestTitle: remoteTop.title,
		remotePublishedAt: remoteTop.publishedAt,
		recordedLatestId: recordedId,
		newCountEstimate: hasUpdate ? Math.max(1, newCountEstimate) : 0,
		checkedAt,
	};
}

function stripResearchrBadges(rawTitleHtmlOrText: string): string {
	return rawTitleHtmlOrText
		.replace(
			/<span[^>]*class=["'][^"']*(?:pull-right|output-badge|badge)[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,
			" ",
		)
		.replace(/<[^>]+>/g, " ")
		.replace(
			/\s*(?:Distinguished Paper|Virtual Attendance|Artifact Available|Artifact Evaluated)\s*$/gi,
			"",
		)
		.trim();
}

function extractResearchrPublicationMeta(
	rowHtml: string,
	baseUrl: string,
): {
	url: string;
	arxivId?: string;
	pdfUrl?: string;
	doi?: string;
} {
	let url = baseUrl;
	let arxivId: string | undefined;
	let pdfUrl: string | undefined;
	let doi: string | undefined;

	const pubLinkMatch =
		/<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*publication-link[^"']*["']/i.exec(
			rowHtml,
		) ??
		/<a[^>]*class=["'][^"']*publication-link[^"']*["'][^>]*href=["']([^"']+)["']/i.exec(
			rowHtml,
		);
	const rawLink = pubLinkMatch?.[1]?.trim();
	if (rawLink && rawLink !== "#" && !rawLink.startsWith("javascript:")) {
		try {
			url = new URL(rawLink, baseUrl).href;
		} catch {
			url = rawLink;
		}
	}

	const arxivMatch = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/i.exec(
		rowHtml,
	);
	if (arxivMatch?.[1]) {
		arxivId = arxivMatch[1];
		pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
		if (url === baseUrl) {
			url = `https://arxiv.org/abs/${arxivId}`;
		}
	}

	const doiMatch =
		/(?:doi\.org|dl\.acm\.org\/doi(?:\/abs|\/pdf)?)\/(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i.exec(
			rowHtml,
		);
	if (doiMatch?.[1]) {
		doi = doiMatch[1].replace(/[.,;>)"']+$/, "");
		if (url === baseUrl) {
			url = `https://doi.org/${doi}`;
		}
	}

	return { url, arxivId, pdfUrl, doi };
}

/**
 * Deterministic parser for `conf.researchr.org/track/<conf>/<track>` HTML pages.
 * Extracts accepted papers from `#event-overview` and program tables while
 * filtering out non-paper schedule rows (e.g. "ICSE Yoga", "Welcome") and badge labels.
 */
export function parseResearchrHtml(
	html: string,
	venue: VenueConfig,
): CollectionPaperItem[] {
	const results: CollectionPaperItem[] = [];
	const seenTitles = new Set<string>();
	const yearMatch = /\b(20\d{2})\b/.exec(`${venue.name} ${venue.url}`);
	const year = yearMatch ? Number(yearMatch[1]) : TARGET_YEAR;
	const baseUrl = venue.url.split("#")[0] || venue.url;

	if (typeof DOMParser !== "undefined") {
		try {
			const doc = new DOMParser().parseFromString(html, "text/html");
			const overview = doc.getElementById("event-overview");
			const rows = overview
				? overview.querySelectorAll("tr")
				: doc.querySelectorAll("table.table-condensed tr, table.table tr");
			for (const row of rows) {
				const titleAnchor =
					row.querySelector<HTMLAnchorElement>("a[data-event-modal]") ??
					row.querySelector<HTMLAnchorElement>(
						"td a[href*='/details/'], td strong a",
					);
				if (!titleAnchor) continue;

				// Clone anchor and strip award/attendance badge elements before reading title text.
				const anchorClone = titleAnchor.cloneNode(true) as HTMLElement;
				for (const badge of anchorClone.querySelectorAll(
					".pull-right, .output-badge, .badge, [data-facet-badge]",
				)) {
					badge.remove();
				}
				const title = stripResearchrBadges(
					cleanWhitespace(anchorClone.textContent ?? ""),
				);
				if (!title || title.length < 6) continue;

				const performersContainer = row.querySelector(".performers");
				const authorEls = row.querySelectorAll(".performers a, .performers");
				const authors: string[] = [];
				if (authorEls.length > 0) {
					for (const el of authorEls) {
						if (el.tagName.toLowerCase() === "a") {
							const name = cleanWhitespace(el.textContent ?? "");
							if (name && !authors.includes(name)) authors.push(name);
						}
					}
					if (authors.length === 0 && performersContainer) {
						const rawAuthors = cleanWhitespace(
							performersContainer.textContent ?? "",
						);
						for (const part of rawAuthors.split(",")) {
							const name = part.trim();
							if (name) authors.push(name);
						}
					}
				}
				// Real accepted papers on conf.researchr.org always have a .performers block with authors;
				// schedule modal entries ("ICSE Yoga", "Welcome", coffee breaks) do not.
				if (authors.length === 0) continue;

				const normTitle = title.toLowerCase();
				if (seenTitles.has(normTitle)) continue;
				seenTitles.add(normTitle);

				const trackText = cleanWhitespace(
					row.querySelector(".prog-track")?.textContent ?? venue.name,
				);
				const href = titleAnchor.getAttribute("href") ?? "";
				const pubMeta = extractResearchrPublicationMeta(row.innerHTML, baseUrl);
				const itemUrl =
					pubMeta.url !== baseUrl
						? pubMeta.url
						: href && href !== "#" && !href.startsWith("javascript:")
							? new URL(href, baseUrl).href
							: baseUrl;

				const slug = normTitle
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, "")
					.slice(0, 64);

				results.push({
					id: pubMeta.doi
						? `doi:${pubMeta.doi.toLowerCase()}`
						: pubMeta.arxivId
							? `arxiv:${pubMeta.arxivId}`
							: `venue:${venue.id}:${slug}`,
					title,
					authors,
					abstract: trackText ? `${venue.name} · ${trackText}` : venue.name,
					publishedAt: `${year}-01-01T00:00:00Z`,
					year,
					sourceType: "venue",
					sourceLabel: venue.name,
					categories: [venue.name, ...(trackText ? [trackText] : [])],
					url: itemUrl,
					pdfUrl: pubMeta.pdfUrl,
					arxivId: pubMeta.arxivId,
					doi: pubMeta.doi,
					venueId: venue.id,
				});
			}
		} catch {
			// Fall back to regex parser below.
		}
	}

	if (results.length === 0) {
		const overviewIdx = html.search(/id=["']event-overview["']/i);
		const scopedHtml = overviewIdx >= 0 ? html.slice(overviewIdx) : html;
		const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
		for (const trMatch of scopedHtml.matchAll(trRegex)) {
			const rowHtml = trMatch[1] ?? "";
			if (!/class=["'][^"']*performers/i.test(rowHtml)) continue;
			const anchorMatch =
				/<a[^>]*data-event-modal=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(
					rowHtml,
				);
			if (!anchorMatch) continue;
			const rawTitle = stripResearchrBadges(anchorMatch[2] ?? "");
			const title = decodeHtmlEntities(rawTitle);
			if (!title || title.length < 6) continue;

			const authors: string[] = [];
			const performersBlock =
				/<div[^>]*class=["'][^"']*performers[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(
					rowHtml,
				)?.[1] ?? "";
			for (const aMatch of performersBlock.matchAll(
				/<a[^>]*>([\s\S]*?)<\/a>/gi,
			)) {
				const name = decodeHtmlEntities(aMatch[1] ?? "");
				if (name && !authors.includes(name)) authors.push(name);
			}
			if (authors.length === 0 && performersBlock) {
				const plainPerformers = decodeHtmlEntities(
					performersBlock.replace(/<[^>]+>/g, " "),
				);
				for (const part of plainPerformers.split(",")) {
					const name = part.trim();
					if (name) authors.push(name);
				}
			}
			if (authors.length === 0) continue;

			const normTitle = title.toLowerCase();
			if (seenTitles.has(normTitle)) continue;
			seenTitles.add(normTitle);

			const pubMeta = extractResearchrPublicationMeta(rowHtml, baseUrl);
			const slug = normTitle
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "")
				.slice(0, 64);

			results.push({
				id: pubMeta.doi
					? `doi:${pubMeta.doi.toLowerCase()}`
					: pubMeta.arxivId
						? `arxiv:${pubMeta.arxivId}`
						: `venue:${venue.id}:${slug}`,
				title,
				authors,
				abstract: `${venue.name} Accepted Paper`,
				publishedAt: `${year}-01-01T00:00:00Z`,
				year,
				sourceType: "venue",
				sourceLabel: venue.name,
				categories: [venue.name],
				url: pubMeta.url,
				pdfUrl: pubMeta.pdfUrl,
				arxivId: pubMeta.arxivId,
				doi: pubMeta.doi,
				venueId: venue.id,
			});
		}
	}

	return results;
}

function isDblpVenue(venue: VenueConfig): boolean {
	return (
		VENUE_SPEC_BY_ID.has(venue.id) ||
		Boolean(venue.dblpStream) ||
		/dblp\.(?:uni-trier\.de|org|dagstuhl\.de)/i.test(venue.url)
	);
}

type VenueFetchBundle = {
	items: CollectionPaperItem[];
	remoteTotalCount: number;
	latestPublishedAt: string | null;
};

/**
 * Multi-channel 2026 venue full fetcher combining:
 * 1. OpenAlex + Crossref (`cursor` paginated up to 1,200 papers),
 * 2. Official DBLP SPARQL (`https://sparql.dblp.org/sparql`) + OpenAlex DOI/Title batch enrichment,
 * 3. Semantic Scholar Bulk Search + arXiv Confirmed Accepted-Venue Metadata fallback.
 */
async function fetchDblpForVenue(
	venue: VenueConfig,
	options?: {
		maxPages?: number;
	},
): Promise<VenueFetchBundle> {
	const yearMatch = /\b(20\d{2})\b/.exec(`${venue.name} ${venue.url}`);
	const year = yearMatch ? Number(yearMatch[1]) : TARGET_YEAR;

	const multiChannel = await fetchMultiChannelVenuePapers(
		venue,
		year,
		plazaFetchJson,
		plazaFetchText,
		options,
	);

	const cleaned = multiChannel.items.map((item) => ({
		...item,
		abstract: isPlaceholderAbstract(item.abstract, venue.name)
			? ""
			: item.abstract,
	}));

	let latestPublishedAt = multiChannel.latestPublishedAt;
	for (const item of cleaned) {
		if (!latestPublishedAt || item.publishedAt > latestPublishedAt) {
			latestPublishedAt = item.publishedAt;
		}
	}

	return {
		items: cleaned,
		remoteTotalCount: Math.max(multiChannel.remoteTotalCount, cleaned.length),
		latestPublishedAt,
	};
}

/**
 * Use the user's configured Agent to extract structured papers from an arbitrary Venue URL.
 */
export async function extractVenueWithAgent(
	venue: VenueConfig,
	rawHtml?: string,
): Promise<CollectionPaperItem[]> {
	const html = rawHtml ?? (await plazaFetchText(venue.url));
	const plainSnippet = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 18_000);

	const resolved = await resolveConfiguredTranslateAgent();
	if (!resolved.agentId) {
		throw new Error("请先在设置中配置并启用 Agent 以执行网页智能提取");
	}
	const prompt = [
		`You are an academic paper extractor for ${venue.name} (${venue.url}).`,
		"Extract accepted/listed research papers from the conference page content below.",
		"Return ONLY a valid JSON array (no markdown fences, no commentary) where each element has:",
		`{"title": "string", "authors": ["string"], "abstract": "string", "track": "string", "url": "string"}`,
		"If no individual papers are listed yet on the page, return [].",
		"",
		"PAGE CONTENT:",
		plainSnippet,
	].join("\n");

	const accepted = await runOnce({
		prompt,
		agentId: resolved.agentId,
		modelId: resolved.modelId,
		vaultPath: getVaultPath() ?? undefined,
		workflow: "free",
		permissionMode: "auto",
		hideFromChatHistory: true,
	});

	const responseText = await new Promise<string>((resolve, reject) => {
		const unsubs: Array<() => void> = [];
		const cleanup = () => {
			for (const u of unsubs) u();
		};
		void listenAgentCompleted((ev) => {
			if (ev.sessionId !== accepted.sessionId) return;
			cleanup();
			resolve((ev.content ?? "").trim());
		}).then((u) => unsubs.push(u));
		void listenAgentFailed((ev) => {
			if (ev.sessionId !== accepted.sessionId) return;
			cleanup();
			reject(new Error(ev.error || "Agent venue extraction failed"));
		}).then((u) => unsubs.push(u));
	});

	const jsonMatch = /\[[\s\S]*\]/.exec(responseText);
	if (!jsonMatch) return [];
	const parsed = JSON.parse(jsonMatch[0]) as Array<{
		title?: string;
		authors?: string[];
		abstract?: string;
		track?: string;
		url?: string;
	}>;

	const yearMatch = /\b(20\d{2})\b/.exec(`${venue.name} ${venue.url}`);
	const year = yearMatch ? Number(yearMatch[1]) : TARGET_YEAR;

	return parsed
		.filter(
			(row) => typeof row.title === "string" && row.title.trim().length > 4,
		)
		.map((row) => {
			const title = cleanWhitespace(row.title ?? "");
			const abstract = cleanWhitespace(row.abstract ?? "");
			const categories = [venue.name, ...(row.track ? [row.track] : [])];
			return {
				id: buildVenuePaperId(venue.id, undefined, undefined, title),
				title,
				authors: Array.isArray(row.authors) ? row.authors : [],
				abstract,
				publishedAt: `${year}-01-01T00:00:00Z`,
				year,
				sourceType: "venue" as const,
				sourceLabel: venue.name,
				categories,
				url: row.url || venue.url,
				venueId: venue.id,
				venueKind: inferVenueKind(venue),
				citationCount: 0,
				keywords: derivePaperKeywords(title, abstract, categories),
			};
		});
}

async function fetchSingleVenueBundle(
	venue: VenueConfig,
	forceAgent = false,
	options?: { maxPages?: number },
): Promise<VenueFetchBundle> {
	if (!forceAgent && venue.mode !== "agent" && isDblpVenue(venue)) {
		return await fetchDblpForVenue(venue, options);
	}

	let html = "";
	try {
		html = await plazaFetchText(venue.url);
	} catch {
		html = "";
	}

	if (forceAgent || venue.mode === "agent") {
		try {
			const agentItems = await extractVenueWithAgent(venue, html || undefined);
			if (agentItems.length > 0) {
				const enriched = await enrichDblpItemsBatch(
					agentItems,
					venue,
					politePlazaFetchJson,
				);
				return {
					items: enriched,
					remoteTotalCount: enriched.length,
					latestPublishedAt: enriched[0]?.publishedAt ?? null,
				};
			}
		} catch (err) {
			if (forceAgent) throw err;
		}
	}

	if (html) {
		const parsed = parseResearchrHtml(html, venue);
		if (parsed.length > 0) {
			const normalized = parsed.map((p) => ({
				...p,
				id: buildVenuePaperId(venue.id, p.doi, p.arxivId, p.title),
			}));
			const enriched = await enrichDblpItemsBatch(
				normalized,
				venue,
				politePlazaFetchJson,
			);
			if (enriched.length > 0) {
				return {
					items: enriched,
					remoteTotalCount: enriched.length,
					latestPublishedAt: enriched[0]?.publishedAt ?? null,
				};
			}
		}
	}

	return await fetchDblpForVenue(venue, options);
}

/**
 * Fetch papers for a single VenueConfig.
 * Built-in and DBLP venues read strictly from multi-channel scholarly indexes
 * (never scraping official conference websites).
 */
export async function fetchSingleVenuePapers(
	venue: VenueConfig,
	forceAgent = false,
): Promise<CollectionPaperItem[]> {
	const bundle = await fetchSingleVenueBundle(venue, forceAgent);
	return bundle.items;
}

export function applyFreshVenueItems(
	pool: readonly CollectionPaperItem[],
	venueId: string,
	freshVenueItems: CollectionPaperItem[],
): CollectionPaperItem[] {
	if (freshVenueItems.length === 0) {
		return [...pool];
	}
	const rest = pool.filter(
		(i) => !(i.sourceType === "venue" && i.venueId === venueId),
	);
	return mergeCollectionItems([freshVenueItems, rest]);
}

/**
 * Full multi-page, multi-channel update for a single Venue.
 */
async function syncVenueFull(venue: VenueConfig): Promise<{
	venuePatch: Partial<VenueConfig>;
	fullItems: CollectionPaperItem[];
}> {
	const snap = loadCollectionState();
	const cachedForVenue = snap.items.filter(
		(i) => i.sourceType === "venue" && i.venueId === venue.id,
	);
	const nowIso = new Date().toISOString();

	const fullBundle = await fetchSingleVenueBundle(venue, false, {
		maxPages: 25,
	});
	const combinedCount =
		fullBundle.items.length > 0
			? fullBundle.items.length
			: cachedForVenue.length;

	return {
		venuePatch: {
			lastFetchedAt: nowIso,
			latestPublishedAt:
				fullBundle.latestPublishedAt ?? venue.latestPublishedAt ?? null,
			remoteTotalCount: Math.max(fullBundle.remoteTotalCount, combinedCount),
			syncVersion: CURRENT_VENUE_SYNC_VERSION,
			paperCount: combinedCount || venue.paperCount,
		},
		fullItems: fullBundle.items,
	};
}

const inflightVenueLoads = new Map<string, Promise<CollectionState>>();

/**
 * Priority-load (full multi-page update) a specific 2026 venue when selected in UI.
 */
export async function ensureVenueLoaded(
	venueId: string,
): Promise<CollectionState> {
	const existing = inflightVenueLoads.get(venueId);
	if (existing) return existing;

	const task = (async () => {
		const state = loadCollectionState();
		const venue = state.venues.find((v) => v.id === venueId);
		if (!venue) return state;

		const result = await syncVenueFull(venue);
		const latest = loadCollectionState();
		const merged = applyFreshVenueItems(
			latest.items,
			venueId,
			result.fullItems,
		);
		const updatedVenues = latest.venues.map((v) =>
			v.id === venueId
				? {
						...v,
						...result.venuePatch,
					}
				: v,
		);
		const next: CollectionState = {
			...latest,
			venues: updatedVenues,
			items: merged,
		};
		saveCollectionState(next);
		return next;
	})().finally(() => {
		inflightVenueLoads.delete(venueId);
	});

	inflightVenueLoads.set(venueId, task);
	return task;
}

/**
 * Guarantee complete abstract, citation count, keywords, and bibliographic info
 * when clicking a paper card, persisting enriched fields back into local state.
 */
export async function ensurePaperFullDetails(
	paper: CollectionPaperItem,
): Promise<CollectionPaperItem> {
	const needsEnrich =
		isPlaceholderAbstract(paper.abstract, paper.sourceLabel) ||
		paper.citationCount === undefined ||
		!paper.keywords ||
		paper.keywords.length === 0;
	if (!needsEnrich) return paper;

	const enriched = await enrichSinglePaperOnDemand(
		paper,
		politePlazaFetchJson,
		politePlazaFetchText,
	);
	const cur = loadCollectionState();
	const idx = cur.items.findIndex((i) => i.id === paper.id);
	if (idx >= 0) {
		const nextItems = [...cur.items];
		nextItems[idx] = enriched;
		saveCollectionState({ ...cur, items: nextItems });
	}
	return enriched;
}

/**
 * Deduplicate and merge CollectionPaperItems, newest first.
 * Deduplication is scoped per portal (`arxiv` vs `venue:<venueId>`) so accepted
 * conference/journal papers that also have an arXiv preprint remain visible in BOTH
 * the `arXiv` portal and their `Venue` portal.
 */
export function mergeCollectionItems(
	groups: readonly CollectionPaperItem[][],
): CollectionPaperItem[] {
	const map = new Map<string, CollectionPaperItem>();
	const titleKeys = new Map<string, string>();

	for (const group of groups) {
		for (const item of group) {
			const normTitle = item.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
			const portalScope =
				item.sourceType === "venue"
					? `venue:${item.venueId ?? item.sourceLabel}`
					: "arxiv";
			const scopedTitleKey = normTitle ? `${portalScope}::${normTitle}` : "";
			const existingKey = map.has(item.id)
				? item.id
				: scopedTitleKey
					? titleKeys.get(scopedTitleKey)
					: undefined;
			if (!existingKey) {
				map.set(item.id, item);
				if (scopedTitleKey) titleKeys.set(scopedTitleKey, item.id);
			} else {
				const prev = map.get(existingKey);
				if (prev) {
					const prevPlaceholder = isPlaceholderAbstract(
						prev.abstract,
						prev.sourceLabel,
					);
					const nextPlaceholder = isPlaceholderAbstract(
						item.abstract,
						item.sourceLabel,
					);
					const bestAbstract =
						prevPlaceholder && !nextPlaceholder
							? item.abstract
							: !prevPlaceholder && nextPlaceholder
								? prev.abstract
								: prev.abstract.length >= item.abstract.length
									? prev.abstract
									: item.abstract;

					map.set(existingKey, {
						...prev,
						abstract: bestAbstract,
						pdfUrl: prev.pdfUrl || item.pdfUrl,
						doi: prev.doi || item.doi,
						arxivId: prev.arxivId || item.arxivId,
						coolPapersId: prev.coolPapersId || item.coolPapersId,
						venueId: prev.venueId || item.venueId,
						venueKind: prev.venueKind || item.venueKind,
						venueDomain: prev.venueDomain || item.venueDomain,
						ccfRank: prev.ccfRank || item.ccfRank,
						venueFull: prev.venueFull || item.venueFull,
						volume: prev.volume || item.volume,
						issue: prev.issue || item.issue,
						pages: prev.pages || item.pages,
						bibtex: prev.bibtex || item.bibtex,
						citationCount: Math.max(
							prev.citationCount ?? 0,
							item.citationCount ?? 0,
						),
						keywords: Array.from(
							new Set([...(prev.keywords ?? []), ...(item.keywords ?? [])]),
						).slice(0, 8),
						categories: Array.from(
							new Set([...prev.categories, ...item.categories]),
						),
					});
				}
			}
		}
	}

	return Array.from(map.values()).sort((a, b) =>
		b.publishedAt.localeCompare(a.publishedAt),
	);
}

/**
 * True once a venue has already completed a full multi-page v2 sync (or already has
 * v2 cached papers), so opening Paper Collection does not re-check or re-fetch it.
 */
export function isVenueAlreadyLoaded(
	venue: VenueConfig,
	items: readonly CollectionPaperItem[],
): boolean {
	if ((venue.syncVersion ?? 0) < CURRENT_VENUE_SYNC_VERSION) {
		return false;
	}
	if (venue.lastFetchedAt) {
		return true;
	}
	return items.some(
		(item) => item.sourceType === "venue" && item.venueId === venue.id,
	);
}

/**
 * Refresh ONLY `arXiv` categories (either all configured categories or a single
 * sub-category such as `cs.SE`), never touching `Venue` items or triggering Venue requests.
 */
export async function refreshArxivCollection(options?: {
	categories?: string[];
	replaceCategories?: boolean;
	incremental?: boolean;
	onCategoryStatus?: (
		category: string,
		status: "refreshing" | "done" | "error",
	) => void;
}): Promise<CollectionState> {
	const existingState = loadCollectionState();
	const targetCategories = options?.categories ?? existingState.categories;
	const savedCategories = options?.replaceCategories
		? targetCategories
		: existingState.categories;
	const incremental = options?.incremental !== false;

	let mergedItems = existingState.items;
	let latestArxiv = existingState.latestArxiv;
	let nextWatermarks = existingState.arxivWatermarks ?? {};
	let coldStartCats: string[] = [];

	const arxivSync = await syncArxivCategoriesIncremental(
		targetCategories,
		existingState.items,
		nextWatermarks,
		incremental,
		{
			onCategoryStatus: options?.onCategoryStatus,
		},
	);
	nextWatermarks = arxivSync.nextWatermarks;
	coldStartCats = arxivSync.coldStartCategories;
	if (arxivSync.deltaItems.length > 0) {
		mergedItems = mergeCollectionItems([
			arxivSync.deltaItems,
			loadCollectionState().items,
		]);
	} else {
		mergedItems = loadCollectionState().items;
	}
	if (arxivSync.latest) {
		latestArxiv = arxivSync.latest;
	}

	const latestSnap = loadCollectionState();
	const nextState: CollectionState = {
		...latestSnap,
		categories: savedCategories,
		items: mergedItems,
		lastRefreshedAt: new Date().toISOString(),
		latestArxiv,
		arxivWatermarks: {
			...(latestSnap.arxivWatermarks ?? {}),
			...nextWatermarks,
		},
	};
	saveCollectionState(nextState);

	const incompleteCats = targetCategories
		.map((c) => c.trim())
		.filter(
			(c) => Boolean(c) && !nextState.arxivWatermarks?.[c]?.historyComplete,
		);
	if (incompleteCats.length > 0 || coldStartCats.length > 0) {
		const catsToPreload = Array.from(
			new Set([...coldStartCats, ...incompleteCats]),
		);
		void preloadAll2026ArxivInBackground(catsToPreload);
	}
	return loadCollectionState();
}

/**
 * Refresh ONLY `Venue` entries (either all venues, a filtered subset, or a single
 * venue such as `ase-2026`), never touching `arXiv`.
 * When `skipLoaded` is true (used only for cold-start initialization), venues that
 * have already been loaded are skipped.
 */
export async function refreshVenueCollection(options?: {
	venues?: VenueConfig[];
	venueIds?: string[];
	skipLoaded?: boolean;
	onVenueProgress?: (venue: VenueConfig, index: number, total: number) => void;
	onVenueStatus?: (
		venue: VenueConfig,
		status: "refreshing" | "done" | "error",
		index: number,
		total: number,
	) => void;
}): Promise<CollectionState> {
	const current = loadCollectionState();
	const baseVenues = options?.venues ?? current.venues;
	const idSet =
		options?.venueIds && options.venueIds.length > 0
			? new Set(options.venueIds)
			: null;
	const targets = baseVenues.filter((v) => {
		if (idSet && !idSet.has(v.id)) return false;
		if (options?.skipLoaded && isVenueAlreadyLoaded(v, current.items)) {
			return false;
		}
		return true;
	});

	if (targets.length === 0) {
		return current;
	}

	const CONCURRENCY = 2;
	let cursor = 0;

	const worker = async () => {
		while (cursor < targets.length) {
			const idx = cursor++;
			const target = targets[idx];
			if (!target) continue;
			const liveVenue =
				loadCollectionState().venues.find((v) => v.id === target.id) ?? target;
			options?.onVenueProgress?.(liveVenue, idx + 1, targets.length);
			options?.onVenueStatus?.(
				liveVenue,
				"refreshing",
				idx + 1,
				targets.length,
			);
			try {
				await ensureVenueLoaded(liveVenue.id);
				options?.onVenueStatus?.(liveVenue, "done", idx + 1, targets.length);
			} catch {
				options?.onVenueStatus?.(liveVenue, "error", idx + 1, targets.length);
			}
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () =>
			worker(),
		),
	);

	const finalState = loadCollectionState();
	const nextState: CollectionState = {
		...finalState,
		lastRefreshedAt: new Date().toISOString(),
	};
	saveCollectionState(nextState);
	return nextState;
}

/**
 * Refresh Paper Collection (`2026-Now` arXiv categories + unloaded/selected 2026 Venues).
 */
export async function refreshPaperCollection(options?: {
	categories?: string[];
	venues?: VenueConfig[];
	incremental?: boolean;
	skipLoadedVenues?: boolean;
}): Promise<CollectionState> {
	try {
		await refreshArxivCollection({
			categories: options?.categories,
			replaceCategories: Boolean(options?.categories),
			incremental: options?.incremental,
		});
	} catch {
		// Preserve existing arXiv items if network is offline.
	}
	return await refreshVenueCollection({
		venues: options?.venues,
		skipLoaded: options?.skipLoadedVenues ?? false,
	});
}
