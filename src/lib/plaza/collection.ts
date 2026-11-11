/**
 * Plaza — Paper Collection (2026 arXiv & DBLP 2026 Venue paper pool).
 *
 * Separates arXiv (`cs.SE`, `cs.CR`, `cs.PL`, `cs.AI` by default, `2026-Now`)
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
	type CollectionPaperItem,
	type CollectionSourceType,
	DBLP_2026_VENUE_SPECS,
	type DblpVenueSpec,
	derivePaperKeywords,
	enrichArxivItemsBatch,
	enrichDblpItemsBatch,
	enrichSinglePaperOnDemand,
	fetchVenueStructuredPapers,
	formatPaperBibtex,
	formatPaperCitationText,
	inferVenueKind,
	isFrontmatterTitle,
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
	DBLP_2026_VENUE_SPECS,
	derivePaperKeywords,
	formatPaperBibtex,
	formatPaperCitationText,
	inferVenueKind,
	isPlaceholderAbstract,
	reconstructOpenAlexAbstract,
	VENUE_SPEC_BY_ID,
};

export const DEFAULT_ARXIV_CATEGORIES = [
	"cs.SE",
	"cs.CR",
	"cs.PL",
	"cs.AI",
] as const;

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

export type CollectionState = {
	categories: string[];
	venues: VenueConfig[];
	items: CollectionPaperItem[];
	lastRefreshedAt: string | null;
	latestArxiv: ArxivLatestRecord | null;
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
	];
	return legacySets.some(
		(legacy) =>
			cats.length === legacy.length &&
			cats.every((c, idx) => c === legacy[idx]),
	);
}

let memoryState: CollectionState | null = null;
let idbHydrated = false;

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
		out.push({
			...item,
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
	const categories = isLegacyDefaultCategories(rawCategories)
		? [...DEFAULT_ARXIV_CATEGORIES]
		: rawCategories;
	const venues =
		Array.isArray(raw?.venues) && raw.venues.length > 0
			? migrateCachedVenues(raw.venues)
			: [...DEFAULT_COLLECTION_VENUES];
	const items = Array.isArray(raw?.items) ? sanitizeCachedItems(raw.items) : [];
	const loaded: CollectionState = {
		categories,
		venues,
		items,
		lastRefreshedAt:
			typeof raw?.lastRefreshedAt === "string" ? raw.lastRefreshedAt : null,
		latestArxiv: raw?.latestArxiv ?? null,
	};
	memoryState = loaded;
	return loaded;
}

export function saveCollectionState(next: CollectionState): void {
	memoryState = next;
	const compactForLocalStorage: CollectionState =
		next.items.length > LOCAL_STORAGE_MAX_ITEMS
			? {
					...next,
					items: next.items.slice(0, LOCAL_STORAGE_MAX_ITEMS),
				}
			: next;
	writeJsonStorage(STORAGE_KEY, compactForLocalStorage);
	void saveItemsToIndexedDb(next.items);
	for (const listener of listeners) {
		listener(next);
	}
}

/**
 * Hydrate full `2026-Now` preloaded pool from IndexedDB into memory state.
 */
export async function hydrateCollectionStateFromIdb(): Promise<CollectionState> {
	const current = loadCollectionState();
	if (idbHydrated) return current;
	idbHydrated = true;
	const idbItems = await loadItemsFromIndexedDb();
	if (!idbItems || idbItems.length === 0) return current;
	const sanitized = sanitizeCachedItems(idbItems);
	if (sanitized.length === 0) return current;
	const latest = loadCollectionState();
	const merged = mergeCollectionItems([latest.items, sanitized]);
	if (merged.length <= latest.items.length) return latest;
	const next: CollectionState = { ...latest, items: merged };
	memoryState = next;
	for (const listener of listeners) {
		listener(next);
	}
	return next;
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

/**
 * Fetch remote text (XML/JSON/HTML), routing through `agentero-web` when inside
 * the Tauri WebView. Explicitly rejects HTTP 202 anti-bot PoW responses.
 */
export async function plazaFetchText(
	url: string,
	accept = "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
): Promise<string> {
	const cleanUrl = url.split("#")[0] || url;
	if (hasTauriRuntime()) {
		try {
			const parsed = new URL(cleanUrl);
			await commands.webProxyAllowHost({ host: parsed.hostname });
			const proxied = webViewProxyUrl(cleanUrl);
			const res = await fetch(proxied, {
				headers: { Accept: accept },
			});
			if (res.status === 202) {
				throw new Error(`Upstream anti-bot gate (HTTP 202) for ${cleanUrl}`);
			}
			if (res.ok) {
				return await res.text();
			}
		} catch (err) {
			if (err instanceof Error && err.message.includes("HTTP 202")) {
				throw err;
			}
			// Fall through to direct fetch below.
		}
	} else if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
		try {
			const proxied = `/__plaza_proxy?url=${encodeURIComponent(cleanUrl)}`;
			const res = await fetch(proxied, {
				headers: { Accept: accept },
			});
			if (res.status === 202) {
				throw new Error(`Upstream anti-bot gate (HTTP 202) for ${cleanUrl}`);
			}
			if (res.ok) {
				return await res.text();
			}
		} catch (err) {
			if (err instanceof Error && err.message.includes("HTTP 202")) {
				throw err;
			}
			// Fall through to direct fetch below.
		}
	}
	const direct = await fetch(cleanUrl, {
		headers: { Accept: accept },
	});
	if (direct.status === 202 || !direct.ok) {
		throw new Error(`HTTP ${direct.status} fetching ${cleanUrl}`);
	}
	return await direct.text();
}

export async function plazaFetchJson<T = unknown>(url: string): Promise<T> {
	const text = await plazaFetchText(url, "application/json");
	const trimmed = text.trimStart();
	if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
		throw new Error(`Expected JSON but received HTML from ${url}`);
	}
	return JSON.parse(text) as T;
}

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
): Promise<CollectionPaperItem[]> {
	try {
		const xml = await plazaFetchText(
			`https://rss.arxiv.org/rss/${encodeURIComponent(cat)}`,
			"application/rss+xml,application/xml,text/xml,*/*",
		);
		return parseArxivRssXml(xml, cat, cleanCats);
	} catch {
		return [];
	}
}

async function fetchArxivCategoryWithRetry(
	cat: string,
	cleanCats: readonly string[],
	maxResults: number,
	startOffset = 0,
): Promise<CollectionPaperItem[]> {
	const dateBound = `+AND+submittedDate:[${TARGET_YEAR}01010000+TO+209912312359]`;
	const apiUrl = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(cat)}${dateBound}&sortBy=submittedDate&sortOrder=descending&start=${startOffset}&max_results=${maxResults}`;
	let lastErr: unknown = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const xml = await plazaFetchText(
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
	const items = await enrichArxivItemsBatch(rawMerged, plazaFetchJson, 180);
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
				plazaFetchJson,
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

function resolveDblpStream(venue: VenueConfig): string | null {
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	if (spec?.dblpStream) return spec.dblpStream;
	if (venue.dblpStream) return venue.dblpStream;
	const urlMatch = /\/db\/(conf|journals)\/([^/?#]+)/i.exec(venue.url);
	if (urlMatch?.[1] && urlMatch[2]) {
		return `streams/${urlMatch[1].toLowerCase()}/${urlMatch[2].toLowerCase()}`;
	}
	return null;
}

function isDblpVenue(venue: VenueConfig): boolean {
	return (
		VENUE_SPEC_BY_ID.has(venue.id) ||
		Boolean(venue.dblpStream) ||
		/dblp\.(?:uni-trier\.de|org|dagstuhl\.de)/i.test(venue.url)
	);
}

type DblpHitInfo = {
	title?: string;
	venue?: string;
	volume?: string;
	number?: string;
	pages?: string;
	year?: string;
	doi?: string;
	ee?: string | string[];
	url?: string;
	authors?: {
		author?: Array<{ text?: string } | string> | { text?: string } | string;
	};
};

/**
 * Primary DBLP 2026 venue reader (`dblp.uni-trier.de` stream API) paired with
 * OpenAlex + Crossref abstract/citation/keyword enrichment so every venue paper
 * has a complete abstract, citation count, keywords, and bibliographic citation info.
 */
async function fetchDblpForVenue(
	venue: VenueConfig,
): Promise<CollectionPaperItem[]> {
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const yearMatch = /\b(20\d{2})\b/.exec(`${venue.name} ${venue.url}`);
	const year = yearMatch ? Number(yearMatch[1]) : TARGET_YEAR;
	const stream = resolveDblpStream(venue);
	const shortVenue =
		venue.name
			.replace(/\s*\(J\)\s*/gi, " ")
			.replace(/\b20\d{2}\b/g, "")
			.trim() || venue.name;

	const dblpQuery = stream
		? `stream:${stream}: year:${year}`
		: `${shortVenue} ${year}`;
	const dblpUrl = `https://dblp.uni-trier.de/search/publ/api?q=${encodeURIComponent(dblpQuery)}&format=json&h=250&c=0`;

	const [dblpOutcome, structuredOutcome] = await Promise.allSettled([
		plazaFetchJson<{
			result?: {
				hits?: {
					hit?: Array<{ info?: DblpHitInfo }> | { info?: DblpHitInfo };
				};
			};
		}>(dblpUrl),
		fetchVenueStructuredPapers(venue, year, plazaFetchJson),
	]);

	const structuredItems =
		structuredOutcome.status === "fulfilled" ? structuredOutcome.value : [];

	let enrichedDblpItems: CollectionPaperItem[] = [];
	if (dblpOutcome.status === "fulfilled") {
		const rawHits = dblpOutcome.value.result?.hits?.hit;
		const hits = Array.isArray(rawHits) ? rawHits : rawHits ? [rawHits] : [];
		const venueKind = spec?.kind ?? inferVenueKind(venue);
		const venueDomain = spec?.domain ?? venue.domain;
		const ccfRank = spec?.ccfRank ?? venue.ccfRank;
		const rawDblpItems: CollectionPaperItem[] = [];

		for (const hit of hits) {
			const info = hit.info;
			if (!info?.title) continue;
			const itemYear = info.year ? Number(info.year) : year;
			if (itemYear < TARGET_YEAR) continue;
			const title = cleanWhitespace(info.title.replace(/\.$/, ""));
			if (isFrontmatterTitle(title)) continue;

			// Guard PACM shared streams if DBLP returned sibling issues
			if (spec?.pacmIssue && info.number) {
				const numUpper = info.number.trim().toUpperCase();
				if (!numUpper.startsWith(spec.pacmIssue.toUpperCase())) continue;
			}

			const rawAuthor = info.authors?.author;
			const authorList = Array.isArray(rawAuthor)
				? rawAuthor
				: rawAuthor
					? [rawAuthor]
					: [];
			const authors = authorList
				.map((a) => (typeof a === "string" ? a : (a.text ?? "")))
				.map((s) => s.replace(/\s+\d{4}$/, "").trim())
				.filter(Boolean);
			if (authors.length === 0) continue;

			const ee = Array.isArray(info.ee) ? info.ee[0] : info.ee;
			const doi = info.doi?.trim() || undefined;
			const url =
				ee || (doi ? `https://doi.org/${doi}` : info.url || venue.url);
			const slug = title
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.slice(0, 64);
			const categories = [
				venue.name,
				...(venueDomain ? [venueDomain] : []),
				...(ccfRank ? [ccfRank] : []),
			];

			rawDblpItems.push({
				id: doi ? `doi:${doi.toLowerCase()}` : `venue:${venue.id}:${slug}`,
				title,
				authors,
				abstract: "",
				publishedAt: `${itemYear}-01-01T00:00:00Z`,
				year: itemYear,
				sourceType: "venue",
				sourceLabel: venue.name,
				categories,
				url,
				doi,
				venueId: venue.id,
				venueKind,
				venueDomain,
				ccfRank,
				venueFull: info.venue?.trim() || venue.name,
				volume: info.volume?.trim() || undefined,
				issue: info.number?.trim() || undefined,
				pages: info.pages?.trim() || undefined,
			});
		}

		if (rawDblpItems.length > 0) {
			enrichedDblpItems = await enrichDblpItemsBatch(
				rawDblpItems,
				venue,
				plazaFetchJson,
			);
		}
	}

	return mergeCollectionItems([enrichedDblpItems, structuredItems]).filter(
		(item) => !isPlaceholderAbstract(item.abstract, venue.name),
	);
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
			const slug = title
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.slice(0, 64);
			const categories = [venue.name, ...(row.track ? [row.track] : [])];
			return {
				id: `venue:${venue.id}:${slug}`,
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

/**
 * Fetch papers for a single VenueConfig.
 * Built-in and DBLP venues read strictly from DBLP + structured bibliographic indexes
 * (never scraping official conference websites).
 */
export async function fetchSingleVenuePapers(
	venue: VenueConfig,
	forceAgent = false,
): Promise<CollectionPaperItem[]> {
	if (!forceAgent && venue.mode !== "agent" && isDblpVenue(venue)) {
		return await fetchDblpForVenue(venue);
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
				return await enrichDblpItemsBatch(agentItems, venue, plazaFetchJson);
			}
		} catch (err) {
			if (forceAgent) throw err;
		}
	}

	if (html) {
		const parsed = parseResearchrHtml(html, venue);
		if (parsed.length > 0) {
			const enriched = await enrichDblpItemsBatch(
				parsed,
				venue,
				plazaFetchJson,
			);
			if (enriched.length > 0) return enriched;
		}
	}

	return await fetchDblpForVenue(venue);
}

const inflightVenueLoads = new Map<string, Promise<CollectionState>>();

/**
 * Priority-load a specific 2026 venue when the user enters its view if not yet cached.
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

		const fetched = await fetchSingleVenuePapers(venue);
		const latest = loadCollectionState();
		const nowIso = new Date().toISOString();
		const merged = mergeCollectionItems([fetched, latest.items]);
		const updatedVenues = latest.venues.map((v) =>
			v.id === venueId
				? {
						...v,
						lastFetchedAt: nowIso,
						paperCount: fetched.length || v.paperCount,
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

	const enriched = await enrichSinglePaperOnDemand(paper, plazaFetchJson);
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
 */
export function mergeCollectionItems(
	groups: readonly CollectionPaperItem[][],
): CollectionPaperItem[] {
	const map = new Map<string, CollectionPaperItem>();
	const titleKeys = new Map<string, string>();

	for (const group of groups) {
		for (const item of group) {
			const normTitle = item.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
			const existingKey = map.has(item.id)
				? item.id
				: normTitle
					? titleKeys.get(normTitle)
					: undefined;
			if (!existingKey) {
				map.set(item.id, item);
				if (normTitle) titleKeys.set(normTitle, item.id);
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
 * Refresh Paper Collection (`2026-Now` arXiv categories + 28 DBLP 2026 Venues)
 * with progressive saves and background `2026-Now` pagination.
 */
export async function refreshPaperCollection(options?: {
	categories?: string[];
	venues?: VenueConfig[];
}): Promise<CollectionState> {
	const current = loadCollectionState();
	const categories = options?.categories ?? current.categories;
	const venues = options?.venues ?? current.venues;

	setPreloadingFlag(true);
	try {
		// 1. Load initial 2026-Now arXiv pool immediately and publish to UI
		const arxivOutcome = await Promise.allSettled([
			fetchArxivCollection(categories, 200, 0),
		]);
		const firstArxiv = arxivOutcome[0];
		const existingItems = loadCollectionState().items;
		const arxivItems =
			firstArxiv?.status === "fulfilled"
				? mergeCollectionItems([firstArxiv.value.items, existingItems])
				: existingItems;
		const latestArxiv =
			firstArxiv?.status === "fulfilled" && firstArxiv.value.latest
				? firstArxiv.value.latest
				: current.latestArxiv;

		const nowIso = new Date().toISOString();
		saveCollectionState({
			categories,
			venues,
			items: arxivItems,
			lastRefreshedAt: nowIso,
			latestArxiv,
		});

		// Kick off deeper 2026-Now arXiv pagination in background
		void preloadAll2026ArxivInBackground(categories, 6, 200);

		// 2. Load DBLP 2026 venues with controlled concurrency (4 at a time)
		const CONCURRENCY = 4;
		let cursor = 0;
		const venueResults = new Map<string, CollectionPaperItem[]>();

		const worker = async () => {
			while (cursor < venues.length) {
				const idx = cursor++;
				const venue = venues[idx];
				if (!venue) continue;
				try {
					const papers = await fetchSingleVenuePapers(venue);
					if (papers.length > 0) {
						venueResults.set(venue.id, papers);
						const snap = loadCollectionState();
						const mergedSnap = mergeCollectionItems([snap.items, papers]);
						const snapVenues = snap.venues.map((v) =>
							v.id === venue.id
								? {
										...v,
										lastFetchedAt: new Date().toISOString(),
										paperCount: papers.length,
									}
								: v,
						);
						saveCollectionState({
							...snap,
							venues: snapVenues,
							items: mergedSnap,
						});
					}
				} catch {
					// Continue remaining venues.
				}
			}
		};

		await Promise.all(
			Array.from({ length: Math.min(CONCURRENCY, venues.length) }, () =>
				worker(),
			),
		);

		const finalState = loadCollectionState();
		const finalVenues = venues.map((v) => {
			const got = venueResults.get(v.id);
			if (got && got.length > 0) {
				return {
					...v,
					lastFetchedAt: new Date().toISOString(),
					paperCount: got.length,
				};
			}
			return finalState.venues.find((fv) => fv.id === v.id) ?? v;
		});
		const nextState: CollectionState = {
			...finalState,
			categories,
			venues: finalVenues,
			lastRefreshedAt: new Date().toISOString(),
			latestArxiv,
		};
		saveCollectionState(nextState);
		return nextState;
	} finally {
		setPreloadingFlag(false);
	}
}
