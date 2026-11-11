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
	type FetchJsonFn,
	type FetchTextFn,
	fetchVenueStructuredPapers,
	formatPaperBibtex,
	formatPaperCitationText,
	inferVenueKind,
	isPlaceholderAbstract,
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
	fetchDblpSparqlVenuePapers,
	fetchMultiChannelVenuePapers,
	isConfirmedVenueAcceptance,
	parseAcceptedVenueArxivXml,
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
	CURRENT_VENUE_SYNC_VERSION,
	DBLP_2026_VENUE_SPECS,
	derivePaperKeywords,
	enrichDblpItemsBatch,
	fetchDblpSparqlVenuePapers,
	fetchMultiChannelVenuePapers,
	fetchVenueStructuredPapers,
	formatPaperBibtex,
	formatPaperCitationText,
	inferVenueKind,
	isConfirmedVenueAcceptance,
	isPlaceholderAbstract,
	parseAcceptedVenueArxivXml,
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
		if (isPlaceholderAbstract(item.abstract, item.sourceLabel)) {
			continue;
		}
		const cleanedTitle = item.title
			.replace(
				/\s*(?:Distinguished Paper|Virtual Attendance|Artifact Available|Artifact Evaluated)\s*$/gi,
				"",
			)
			.trim();
		const spec = item.venueId ? VENUE_SPEC_BY_ID.get(item.venueId) : undefined;
		const keywords =
			item.keywords && item.keywords.length > 0
				? item.keywords
				: derivePaperKeywords(cleanedTitle, item.abstract, item.categories);
		const normalizedId =
			item.sourceType === "venue" && item.venueId
				? buildVenuePaperId(item.venueId, item.doi, item.arxivId, cleanedTitle)
				: item.id;
		out.push({
			...item,
			id: normalizedId,
			title: cleanedTitle,
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
	"api.semanticscholar.org",
	"sparql.dblp.org",
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
			if (hostname) {
				await commands.webProxyAllowHost({ host: hostname });
			}
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
		const yearFiltered = items.filter((item) => item.year >= filterYear);
		if (yearFiltered.length > 0) {
			return yearFiltered;
		}
	}
	return items;
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

function toArxivSubmittedDateStamp(
	isoString: string,
	overlapHours = 12,
): string {
	const parsed = Date.parse(isoString);
	const min2026 = Date.UTC(TARGET_YEAR, 0, 1, 0, 0, 0);
	const adjusted = Number.isNaN(parsed)
		? min2026
		: Math.max(min2026, parsed - overlapHours * 3_600_000);
	const d = new Date(adjusted);
	const yyyy = String(d.getUTCFullYear());
	const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(d.getUTCDate()).padStart(2, "0");
	const hh = String(d.getUTCHours()).padStart(2, "0");
	const min = String(d.getUTCMinutes()).padStart(2, "0");
	return `${yyyy}${mm}${dd}${hh}${min}`;
}

async function fetchArxivCategoryWithRetry(
	cat: string,
	cleanCats: readonly string[],
	maxResults: number,
	startOffset = 0,
	fromSubmittedStamp?: string,
	fetchTextFn: FetchTextFn = plazaFetchText,
): Promise<CollectionPaperItem[]> {
	const fromStamp = fromSubmittedStamp || `${TARGET_YEAR}01010000`;
	const dateBound = `+AND+submittedDate:[${fromStamp}+TO+209912312359]`;
	const apiUrl = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(cat)}${dateBound}&sortBy=submittedDate&sortOrder=descending&start=${startOffset}&max_results=${maxResults}`;
	let lastErr: unknown = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const xml = await fetchTextFn(
				apiUrl,
				"application/atom+xml,text/xml,*/*",
			);
			const parsed = parseArxivAtomXml(xml, TARGET_YEAR, {
				preferredCategories: cleanCats,
				defaultCategory: cat,
			});
			if (parsed.length > 0 || attempt === 1) {
				return parsed;
			}
		} catch (err) {
			lastErr = err;
		}
		await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
	}
	if (lastErr) throw lastErr;
	return [];
}

/**
 * Fetch 2026-Now arXiv papers for the given categories (`cs.SE`, `cs.CR`, `cs.PL`, `cs.AI`).
 * Combines fast `rss.arxiv.org` feeds with `export.arxiv.org` `2026-Now` date-bounded pages,
 * plus OpenAlex batch enrichment for citation counts and keywords.
 */
export async function fetchArxivCollection(
	categories: readonly string[],
	maxResultsPerCategory = 200,
	startOffset = 0,
): Promise<{
	items: CollectionPaperItem[];
	latest: ArxivLatestRecord | null;
}> {
	const cleanCats = categories.map((c) => c.trim()).filter(Boolean);
	if (cleanCats.length === 0) {
		return { items: [], latest: null };
	}

	const rssPromise =
		startOffset === 0
			? Promise.allSettled(
					cleanCats.map((cat) => fetchArxivRssFast(cat, cleanCats)),
				)
			: Promise.resolve([]);

	const [rssResults, perCatResults] = await Promise.all([
		rssPromise,
		Promise.allSettled(
			cleanCats.map((cat) =>
				fetchArxivCategoryWithRetry(
					cat,
					cleanCats,
					maxResultsPerCategory,
					startOffset,
				),
			),
		),
	]);

	const groups: CollectionPaperItem[][] = [];
	for (const outcome of rssResults) {
		if (outcome.status === "fulfilled" && outcome.value.length > 0) {
			groups.push(outcome.value);
		}
	}

	const failedCats: string[] = [];
	for (let i = 0; i < cleanCats.length; i++) {
		const outcome = perCatResults[i];
		const cat = cleanCats[i];
		if (outcome?.status === "fulfilled" && outcome.value.length > 0) {
			groups.push(outcome.value);
		} else if (cat) {
			failedCats.push(cat);
		}
	}

	if (failedCats.length > 0 && groups.length === 0) {
		const catQuery =
			failedCats.length === 1
				? `cat:${failedCats[0]}`
				: `(${failedCats.map((c) => `cat:${c}`).join("+OR+")})`;
		const apiUrl = `https://export.arxiv.org/api/query?search_query=${catQuery}&sortBy=submittedDate&sortOrder=descending&start=${startOffset}&max_results=${maxResultsPerCategory * failedCats.length}`;
		const xml = await plazaFetchText(
			apiUrl,
			"application/atom+xml,text/xml,*/*",
		);
		groups.push(
			parseArxivAtomXml(xml, TARGET_YEAR, {
				preferredCategories: cleanCats,
			}),
		);
	}

	const rawMerged = mergeCollectionItems(groups);
	const items = await enrichArxivItemsBatch(
		rawMerged,
		politePlazaFetchJson,
		180,
	);
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
	return { items, latest };
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
	},
): Promise<{
	deltaItems: CollectionPaperItem[];
	nextWatermarks: Record<string, ArxivCategoryWatermark>;
	latest: ArxivLatestRecord | null;
	coldStartCategories: string[];
}> {
	const fetchTextFn = transport?.fetchText ?? plazaFetchText;
	const fetchJsonFn = transport?.fetchJson ?? politePlazaFetchJson;
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
				const probeUrl = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(cat)}&sortBy=submittedDate&sortOrder=descending&start=0&max_results=1`;
				const probeXml = await fetchTextFn(
					probeUrl,
					"application/atom+xml,text/xml,*/*",
				);
				const probeParsed = parseArxivAtomXml(probeXml, TARGET_YEAR, {
					preferredCategories: cleanCats,
					defaultCategory: cat,
				});
				const top = probeParsed[0];
				if (
					top &&
					stripVersion(top.arxivId ?? "") === stripVersion(wm.latestArxivId) &&
					top.publishedAt <= wm.latestPublishedAt
				) {
					nextWatermarks[cat] = {
						...wm,
						lastSyncedAt: nowIso,
					};
					return;
				}

				// Newer timestamp detected -> pull ONLY incremental window since watermark
				const fromStamp = toArxivSubmittedDateStamp(wm.latestPublishedAt, 12);
				const [rssItems, deltaWindowItems] = await Promise.all([
					fetchArxivRssFast(cat, cleanCats, fetchTextFn),
					fetchArxivCategoryWithRetry(
						cat,
						cleanCats,
						200,
						0,
						fromStamp,
						fetchTextFn,
					),
				]);
				const combinedCat = mergeCollectionItems([rssItems, deltaWindowItems]);
				const newestCat = combinedCat[0] ?? top;
				if (newestCat) {
					nextWatermarks[cat] = {
						latestArxivId: stripVersion(newestCat.arxivId ?? newestCat.id),
						latestPublishedAt:
							newestCat.publishedAt > wm.latestPublishedAt
								? newestCat.publishedAt
								: wm.latestPublishedAt,
						lastSyncedAt: nowIso,
					};
				}
				const unseen = combinedCat.filter(
					(item) => !knownArxivIds.has(item.id),
				);
				if (unseen.length > 0) {
					rawDeltaGroups.push(unseen);
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
		const coldRes = await fetchArxivCollection(coldStartCategories, 200, 0);
		coldFetchedItems = coldRes.items;
		for (const cat of coldStartCategories) {
			const newestForCat = coldFetchedItems.find(
				(i) => i.sourceLabel === cat || i.categories.includes(cat),
			);
			if (newestForCat) {
				nextWatermarks[cat] = {
					latestArxivId: stripVersion(newestForCat.arxivId ?? newestForCat.id),
					latestPublishedAt: newestForCat.publishedAt,
					lastSyncedAt: nowIso,
				};
			}
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
 * Background preloader that continuously pulls deeper `2026-Now` pages into the
 * preloaded collection pool so clicking "Load 50 more" reveals already-preloaded papers.
 */
export async function preloadAll2026ArxivInBackground(
	categories?: readonly string[],
	maxPages = 6,
	perPage = 200,
): Promise<void> {
	const runId = ++activePreloadRunId;
	setPreloadingFlag(true);
	try {
		const baseCats = (
			categories && categories.length > 0
				? [...categories]
				: loadCollectionState().categories
		)
			.map((c) => c.trim())
			.filter(Boolean);
		if (baseCats.length === 0) return;

		let activeCats = [...baseCats];
		for (let page = 1; page <= maxPages; page++) {
			if (runId !== activePreloadRunId) return;
			const startOffset = page * perPage;
			const stillActive: string[] = [];
			const pageGroups: CollectionPaperItem[][] = [];

			const outcomes = await Promise.allSettled(
				activeCats.map((cat) =>
					fetchArxivCategoryWithRetry(cat, baseCats, perPage, startOffset),
				),
			);
			for (let i = 0; i < activeCats.length; i++) {
				const out = outcomes[i];
				const cat = activeCats[i];
				if (out?.status === "fulfilled" && out.value.length > 0 && cat) {
					pageGroups.push(out.value);
					if (out.value.length >= Math.floor(perPage * 0.4)) {
						stillActive.push(cat);
					}
				}
			}

			if (pageGroups.length === 0 || runId !== activePreloadRunId) break;
			const batchMerged = mergeCollectionItems(pageGroups);
			const enriched = await enrichArxivItemsBatch(
				batchMerged,
				politePlazaFetchJson,
				135,
			);
			const cur = loadCollectionState();
			const nextItems = mergeCollectionItems([cur.items, enriched]);
			if (nextItems.length === cur.items.length) break;
			saveCollectionState({
				...cur,
				items: nextItems,
			});

			activeCats = stillActive;
			if (activeCats.length === 0) break;
		}
	} finally {
		if (runId === activePreloadRunId) {
			setPreloadingFlag(false);
		}
	}
}

/**
 * Paginate deeper into 2026 arXiv submissions across all configured categories
 * and merge them into the persisted Paper Collection state.
 */
export async function fetchMoreArxivCollection(options?: {
	categories?: readonly string[];
	startOffset?: number;
	maxResultsPerCategory?: number;
}): Promise<{ state: CollectionState; addedCount: number }> {
	const current = loadCollectionState();
	const categories =
		options?.categories && options.categories.length > 0
			? [...options.categories]
			: current.categories;
	const maxPerCat = options?.maxResultsPerCategory ?? 200;
	const existingArxivCount = current.items.filter(
		(i) => i.sourceType === "arxiv",
	).length;
	const defaultOffset = Math.max(
		100,
		Math.floor(existingArxivCount / Math.max(1, categories.length)),
	);
	const startOffset = options?.startOffset ?? defaultOffset;

	const fetched = await fetchArxivCollection(
		categories,
		maxPerCat,
		startOffset,
	);
	const merged = mergeCollectionItems([current.items, fetched.items]);
	const addedCount = Math.max(0, merged.length - current.items.length);
	const nextState: CollectionState = {
		...current,
		items: merged,
		lastRefreshedAt: new Date().toISOString(),
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

	const cleaned = multiChannel.items.filter(
		(item) => !isPlaceholderAbstract(item.abstract, venue.name),
	);

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

function applyFreshVenueItems(
	pool: readonly CollectionPaperItem[],
	venueId: string,
	freshVenueItems: CollectionPaperItem[],
): CollectionPaperItem[] {
	if (freshVenueItems.length === 0) {
		return [...pool];
	}
	const cachedForVenue = pool.filter(
		(i) => i.sourceType === "venue" && i.venueId === venueId,
	);
	if (freshVenueItems.length >= cachedForVenue.length) {
		const rest = pool.filter(
			(i) => !(i.sourceType === "venue" && i.venueId === venueId),
		);
		return mergeCollectionItems([freshVenueItems, rest]);
	}
	return mergeCollectionItems([freshVenueItems, [...pool]]);
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
		maxPages: 6,
	});
	const combinedCount =
		fullBundle.items.length >= cachedForVenue.length
			? fullBundle.items.length
			: mergeCollectionItems([fullBundle.items, cachedForVenue]).length;

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

	const enriched = await enrichSinglePaperOnDemand(paper, politePlazaFetchJson);
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

	if (coldStartCats.length > 0) {
		void preloadAll2026ArxivInBackground(coldStartCats, 6, 200);
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
			try {
				await ensureVenueLoaded(liveVenue.id);
			} catch {
				// Continue remaining venues smoothly.
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
