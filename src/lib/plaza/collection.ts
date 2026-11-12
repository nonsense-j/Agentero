/**
 * Plaza — Paper Collection (2026 arXiv & 2026 Venue Main-Track paper pool).
 *
 * Separates arXiv (`cs.SE`, `cs.CR`, `cs.PL` by default with `cs.AI` optional, `2026-Now`)
 * and 2026 Venues (28 built-in PL/SE, CR, and AI venues + user-managed custom venues).
 *
 * Unified single source of truth: Rust `collection.sqlite` via Tauri IPC.
 * Fetching, XML/HTML parsing, and OpenAlex/Crossref/publisher enrichment are
 * stateless pipelines writing batches directly to `collection.sqlite`.
 */

import { listenAgentCompleted, listenAgentFailed, runOnce } from "@/lib/agent";
import { commands } from "@/lib/core/bindings";
import {
	ARXIV_CATEGORY_SUBTITLES,
	backfillSpringerAbstracts,
	buildVenuePaperId,
	type CollectionPaperItem,
	type CollectionSourceType,
	derivePaperKeywords,
	enrichArxivItemsBatch,
	enrichSinglePaperOnDemand,
	enrichVenueItemsBatch,
	extractSpringerHtmlAbstract,
	type FetchJsonFn,
	type FetchTextFn,
	fetchVenueStructuredPapers,
	formatPaperBibtex,
	formatPaperCitationText,
	inferVenueKind,
	isFrontmatterTitle,
	isNonResearchJournalItem,
	isPlaceholderAbstract,
	isPositionPaperTitle,
	isWorkshopOrCompanionVenue,
	normalizePaperKeywords,
	reconstructOpenAlexAbstract,
	VENUE_SPEC_BY_ID,
	VENUE_SPECS,
	type VenueCcfRank,
	type VenueConfig,
	type VenueDomain,
	type VenueKind,
	type VenueSpec,
} from "@/lib/plaza/collection-enrichment";
import {
	type ArxivCategoryWatermark,
	type ArxivLatestRecord,
	bumpCollectionRevision,
	type CollectionClearScope,
	type CollectionConfigUpdateInput,
	type CollectionListPapersQuery,
	type CollectionOverviewOut,
	type CollectionPaperDetailResult,
	type CollectionPaperPatchInput,
	type CollectionPapersPageResult,
	type CollectionStateSummary,
	type CollectionSummarySnapshot,
	type CollectionUpsertPapersInput,
	type CollectionVenueWatermarkUpdate,
	clearCollection,
	collectionStore,
	DEFAULT_ARXIV_CATEGORIES,
	DEFAULT_COLLECTION_VENUES,
	ensureCollectionSummaryHydrated,
	fetchCollectionOverview,
	fetchCollectionStateSummary,
	getCollectionPaperDetail,
	getCollectionPapersByIds,
	getCollectionSummarySnapshot,
	isPreloadingCollection,
	listCollectionPapers,
	patchCollectionPapers,
	purgeLegacyCollectionBrowserStorage,
	resetCollectionStoreForTests,
	setPreloadingCollectionFlag,
	subscribeCollectionSummary,
	subscribePreloadingCollection,
	updateCollectionConfig,
	upsertCollectionPapers,
} from "@/lib/plaza/collection-store";
import {
	createPoliteFetchJson,
	createPoliteFetchText,
	fetchCoolPapersVenuePapers,
	fetchCsdlVenuePapers,
	fetchDataCiteLipicsPapers,
	fetchMultiChannelVenuePapers,
	fetchOfficialTrackRoster,
	fetchOfficialVenueProgramPapers,
	isConfirmedVenueAcceptance,
	parseAcceptedVenueArxivXml,
	parseCoolPapersVenueHtml,
	parseOfficialVenueProgramHtml,
	parseResearchrHtml,
} from "@/lib/plaza/collection-venue-channels";
import { resolveConfiguredTranslateAgent } from "@/lib/translate/resolve-agent";
import { getVaultPath } from "@/lib/vault/store";
import { webViewProxyUrl } from "@/lib/web-view/proxy-url";

export type {
	ArxivCategoryWatermark,
	ArxivLatestRecord,
	CollectionClearScope,
	CollectionConfigUpdateInput,
	CollectionListPapersQuery,
	CollectionOverviewOut,
	CollectionPaperDetailResult,
	CollectionPaperItem,
	CollectionPaperPatchInput,
	CollectionPapersPageResult,
	CollectionSourceType,
	CollectionStateSummary,
	CollectionSummarySnapshot,
	CollectionUpsertPapersInput,
	CollectionVenueWatermarkUpdate,
	FetchJsonFn,
	FetchTextFn,
	VenueCcfRank,
	VenueConfig,
	VenueDomain,
	VenueKind,
	VenueSpec,
};
export {
	ARXIV_CATEGORY_SUBTITLES,
	backfillSpringerAbstracts,
	bumpCollectionRevision,
	clearCollection,
	collectionStore,
	DEFAULT_ARXIV_CATEGORIES,
	DEFAULT_COLLECTION_VENUES,
	derivePaperKeywords,
	enrichArxivItemsBatch,
	enrichSinglePaperOnDemand,
	enrichVenueItemsBatch,
	ensureCollectionSummaryHydrated,
	extractSpringerHtmlAbstract,
	fetchCollectionOverview,
	fetchCollectionStateSummary,
	fetchCoolPapersVenuePapers,
	fetchCsdlVenuePapers,
	fetchDataCiteLipicsPapers,
	fetchMultiChannelVenuePapers,
	fetchOfficialTrackRoster,
	fetchOfficialVenueProgramPapers,
	fetchVenueStructuredPapers,
	formatPaperBibtex,
	formatPaperCitationText,
	getCollectionPaperDetail,
	getCollectionPapersByIds,
	getCollectionSummarySnapshot,
	inferVenueKind,
	isConfirmedVenueAcceptance,
	isFrontmatterTitle,
	isNonResearchJournalItem,
	isPlaceholderAbstract,
	isPositionPaperTitle,
	isPreloadingCollection,
	isWorkshopOrCompanionVenue,
	listCollectionPapers,
	normalizePaperKeywords,
	parseAcceptedVenueArxivXml,
	parseCoolPapersVenueHtml,
	parseOfficialVenueProgramHtml,
	parseResearchrHtml,
	patchCollectionPapers,
	purgeLegacyCollectionBrowserStorage,
	reconstructOpenAlexAbstract,
	subscribeCollectionSummary,
	subscribePreloadingCollection,
	updateCollectionConfig,
	upsertCollectionPapers,
	VENUE_SPEC_BY_ID,
	VENUE_SPECS,
};

const TARGET_YEAR = 2026;

const attemptedDetailEnrichIds = new Set<string>();

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

/** Reset transient in-memory summary & enrichment flags (primarily for unit tests). */
export function resetCollectionMemoryForTests(): void {
	attemptedDetailEnrichIds.clear();
	resetCollectionStoreForTests();
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
	"www.computer.org",
]);

const allowedWebProxyHosts = new Set<string>();

async function ensureWebProxyAllowed(hostname: string): Promise<void> {
	if (!hostname) return;
	const companions =
		hostname === "link.springer.com"
			? ["link.springer.com", "idp.springer.com", "www.nature.com"]
			: hostname === "sigsac.org" || hostname === "www.sigsac.org"
				? ["sigsac.org", "www.sigsac.org"]
				: hostname === "cyprusconferences.org" ||
						hostname === "www.cyprusconferences.org"
					? ["cyprusconferences.org", "www.cyprusconferences.org"]
					: [hostname];
	for (const h of companions) {
		if (allowedWebProxyHosts.has(h)) continue;
		await commands.webProxyAllowHost({ host: h });
		allowedWebProxyHosts.add(h);
	}
}

/**
 * Fetch remote text (XML/JSON/HTML), using direct CORS fetch for open scholarly APIs
 * and routing non-CORS hosts (`export.arxiv.org`, `rss.arxiv.org`, `conf.researchr.org`,
 * `papers.cool`, etc.) through `agentero-web`.
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

	// Fast path: OpenAlex / Crossref / DataCite / Semantic Scholar / CSDL send `Access-Control-Allow-Origin: *`
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
			keywords: [],
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
			keywords: [],
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

	const maxAttempts = 5;
	let lastErr: unknown = null;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

			if (!isTransientEmpty) {
				const oldestYearMatch = /^(\d{4})/.exec(meta.oldestPublishedAt ?? "");
				const oldestYear = oldestYearMatch
					? Number(oldestYearMatch[1])
					: TARGET_YEAR;
				const historyComplete =
					fromStamp === `${TARGET_YEAR}01010000` &&
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
			lastErr = new Error(
				`arXiv returned transient empty feed for ${cat} (totalResults=${meta.totalResults ?? "unknown"}, start=${startOffset})`,
			);
		} catch (err) {
			lastErr = err;
		}
		if (
			attempt + 1 < maxAttempts &&
			(typeof import.meta === "undefined" || import.meta.env?.MODE !== "test")
		) {
			await new Promise((resolve) => setTimeout(resolve, 3500 * (attempt + 1)));
		}
	}
	throw (
		lastErr ??
		new Error(`Failed to fetch arXiv page for ${cat} at offset ${startOffset}`)
	);
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
		categoryCounts?: Readonly<Record<string, number>>;
		deferIncompleteDoneStatus?: boolean;
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
	const deferIncompleteDone = Boolean(transport?.deferIncompleteDoneStatus);
	const categoryCounts = transport?.categoryCounts;
	const cleanCats = categories.map((c) => c.trim()).filter(Boolean);
	const nextWatermarks: Record<string, ArxivCategoryWatermark> = {
		...existingWatermarks,
	};
	const emitDoneIfComplete = (cat: string) => {
		if (!deferIncompleteDone || nextWatermarks[cat]?.historyComplete) {
			onCategoryStatus?.(cat, "done");
		}
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
		const hasCachedInItems = existingItems.some(
			(i) =>
				i.sourceType === "arxiv" &&
				(i.sourceLabel === cat || i.categories.includes(cat)),
		);
		const hasCachedCount = (categoryCounts?.[cat] ?? 0) > 0;
		const wm = existingWatermarks[cat];
		if (
			incremental &&
			(hasCachedInItems || hasCachedCount) &&
			wm?.latestArxivId
		) {
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
						emitDoneIfComplete(cat);
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
					const unseen =
						knownArxivIds.size > 0
							? combinedCat.filter((item) => !knownArxivIds.has(item.id))
							: combinedCat.filter(
									(item) =>
										stripVersion(item.arxivId ?? item.id) !==
											stripVersion(wm.latestArxivId) &&
										item.publishedAt >= wm.latestPublishedAt,
								);
					if (unseen.length > 0) {
						rawDeltaGroups.push(unseen);
					}
					emitDoneIfComplete(cat);
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
				emitDoneIfComplete(cat);
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
 * Walk `2026-Now` arXiv categories backward using sliding
 * `submittedDate:[202601010000 TO toStamp]` windows (`perPage = 1000`, polite 3.25s rate limit)
 * until every category reaches `2026-01-01` (`historyComplete: true`).
 * Persists batches and `oldestSyncedPublishedAt` watermarks directly to `collection.sqlite`
 * after each page so interrupted sessions resume seamlessly with zero full-pool JS arrays.
 */
export async function preloadAll2026ArxivInBackground(
	categories?: readonly string[],
	maxPages = 120,
	perPage = 1000,
	transport?: {
		fetchText?: FetchTextFn;
		fetchJson?: FetchJsonFn;
		onCategoryStatus?: (
			category: string,
			status: "refreshing" | "done" | "error",
		) => void;
	},
): Promise<void> {
	const initialSnap = await fetchCollectionStateSummary();
	const baseCats = (
		categories && categories.length > 0
			? [...categories]
			: initialSnap.categories
	)
		.map((c) => c.trim())
		.filter(Boolean);
	const onCategoryStatus = transport?.onCategoryStatus;
	const pendingCats: string[] = [];
	for (const cat of baseCats) {
		if (initialSnap.arxivWatermarks[cat]?.historyComplete) {
			onCategoryStatus?.(cat, "done");
		} else {
			pendingCats.push(cat);
		}
	}
	if (pendingCats.length === 0) return;

	const runId = ++activePreloadRunId;
	setPreloadingCollectionFlag(true);
	const fetchTextFn = transport?.fetchText ?? politePlazaFetchText;
	const fetchJsonFn = transport?.fetchJson ?? politePlazaFetchJson;

	type CatCursor = {
		toStamp: string;
		startOffset: number;
		oldestSyncedPublishedAt?: string;
		remoteTotal?: number;
		consecutiveFailures: number;
	};
	const cursors = new Map<string, CatCursor>();
	for (const cat of pendingCats) {
		const wm = initialSnap.arxivWatermarks[cat];
		const resumeIso = wm?.oldestSyncedPublishedAt;
		cursors.set(cat, {
			toStamp: resumeIso ? toArxivUpperDateStamp(resumeIso) : "209912312359",
			startOffset: 0,
			oldestSyncedPublishedAt: resumeIso,
			remoteTotal: wm?.remoteTotal,
			consecutiveFailures: 0,
		});
	}

	const erroredCats = new Set<string>();
	const completedCats = new Set<string>();

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
			const newlyCompletedThisPage: string[] = [];
			const preferredCategories = collectionStore.getState().categories;

			for (const cat of activeCats) {
				if (runId !== activePreloadRunId) return;
				const curCursor = cursors.get(cat);
				if (!curCursor) continue;

				try {
					const pageRes = await fetchArxivCategoryPageWithRetry(
						cat,
						preferredCategories,
						perPage,
						{
							startOffset: curCursor.startOffset,
							toSubmittedStamp: curCursor.toStamp,
							fetchTextFn,
						},
					);
					curCursor.consecutiveFailures = 0;

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
					let isCatComplete = pageRes.historyComplete;

					if (!isCatComplete && pageRes.rawEntryCount > 0) {
						const candidateStamp = nextOldest
							? toArxivUpperDateStamp(nextOldest)
							: curCursor.toStamp;
						if (candidateStamp < curCursor.toStamp) {
							curCursor.toStamp = candidateStamp;
							curCursor.startOffset = 0;
							curCursor.oldestSyncedPublishedAt = nextOldest;
						} else if (curCursor.startOffset + perPage < 3000 && nextOldest) {
							curCursor.startOffset += perPage;
						} else if (nextOldest) {
							curCursor.toStamp = toArxivUpperDateStamp(nextOldest, 2);
							curCursor.startOffset = 0;
							curCursor.oldestSyncedPublishedAt = nextOldest;
						}
						if (curCursor.toStamp > `${TARGET_YEAR}01010000`) {
							stillActive.push(cat);
						} else {
							isCatComplete = true;
						}
					} else if (!isCatComplete && pageRes.rawEntryCount === 0) {
						isCatComplete = true;
					}

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
						historyComplete: isCatComplete,
					};

					if (isCatComplete) {
						newlyCompletedThisPage.push(cat);
					}
				} catch {
					curCursor.consecutiveFailures += 1;
					if (curCursor.consecutiveFailures < 3) {
						if (
							typeof import.meta === "undefined" ||
							import.meta.env?.MODE !== "test"
						) {
							await new Promise((resolve) =>
								setTimeout(resolve, 4000 * curCursor.consecutiveFailures),
							);
						}
						stillActive.push(cat);
					} else {
						erroredCats.add(cat);
						onCategoryStatus?.(cat, "error");
					}
				}
			}

			if (runId !== activePreloadRunId) break;
			const batchMerged =
				pageGroups.length > 0 ? mergeCollectionItems(pageGroups) : [];
			const existingInDb =
				batchMerged.length > 0
					? await getCollectionPapersByIds(batchMerged.map((i) => i.id))
					: [];
			const existingIdSet = new Set(existingInDb.map((i) => i.id));
			const unseenBatch = batchMerged.filter((i) => !existingIdSet.has(i.id));
			const enrichedUnseen =
				unseenBatch.length > 0
					? await enrichArxivItemsBatch(unseenBatch, fetchJsonFn, 135)
					: [];

			const latestCur = await fetchCollectionStateSummary();
			const nextWms: Record<string, ArxivCategoryWatermark> = {
				...latestCur.arxivWatermarks,
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

			if (enrichedUnseen.length > 0) {
				await upsertCollectionPapers({
					items: enrichedUnseen,
					arxivWatermarks: nextWms,
				});
			} else if (Object.keys(watermarkUpdates).length > 0) {
				await updateCollectionConfig({
					arxivWatermarks: nextWms,
				});
			}

			for (const doneCat of newlyCompletedThisPage) {
				completedCats.add(doneCat);
				onCategoryStatus?.(doneCat, "done");
			}

			activeCats = stillActive;
		}

		if (runId === activePreloadRunId && onCategoryStatus) {
			for (const cat of pendingCats) {
				if (!completedCats.has(cat) && !erroredCats.has(cat)) {
					onCategoryStatus(cat, "done");
				}
			}
		}
	} finally {
		if (runId === activePreloadRunId) {
			setPreloadingCollectionFlag(false);
		}
	}
}

/**
 * Paginate deeper into 2026 arXiv submissions per category using each category's own
 * `oldestSyncedPublishedAt` cursor and persist directly to `collection.sqlite`.
 */
export async function fetchMoreArxivCollection(options?: {
	categories?: readonly string[];
	startOffset?: number;
	maxResultsPerCategory?: number;
	transport?: {
		fetchText?: FetchTextFn;
		fetchJson?: FetchJsonFn;
	};
}): Promise<{ summary: CollectionStateSummary; addedCount: number }> {
	const current = await fetchCollectionStateSummary();
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
	const nowIso = new Date().toISOString();

	if (typeof options?.startOffset === "number") {
		const fetched = await fetchArxivCollection(
			categories,
			maxPerCat,
			options.startOffset,
			options.transport,
		);
		const summary = await upsertCollectionPapers({
			items: fetched.items,
			lastRefreshedAt: nowIso,
			...(fetched.latest ? { latestArxiv: fetched.latest } : {}),
		});
		const addedCount = Math.max(0, summary.totalCount - current.totalCount);
		return { summary, addedCount };
	}

	const pageGroups: CollectionPaperItem[][] = [];
	const wmPatches: Record<
		string,
		Partial<ArxivCategoryWatermark> & { newestItem?: CollectionPaperItem }
	> = {};

	for (const cat of categories) {
		const wm = current.arxivWatermarks[cat];
		if (wm?.historyComplete) continue;

		const oldestForCat = wm?.oldestSyncedPublishedAt;
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
			newestItem: pageRes.items[0],
		};
	}

	const rawBatch =
		pageGroups.length > 0 ? mergeCollectionItems(pageGroups) : [];
	const existingInDb =
		rawBatch.length > 0
			? await getCollectionPapersByIds(rawBatch.map((i) => i.id))
			: [];
	const existingIds = new Set(existingInDb.map((i) => i.id));
	const unseen = rawBatch.filter((i) => !existingIds.has(i.id));
	const enriched =
		unseen.length > 0
			? await enrichArxivItemsBatch(unseen, fetchJsonFn, 150)
			: [];

	const latestSnap = await fetchCollectionStateSummary();
	const nextWatermarks: Record<string, ArxivCategoryWatermark> = {
		...latestSnap.arxivWatermarks,
	};
	for (const [cat, patch] of Object.entries(wmPatches)) {
		const { newestItem, ...wmFields } = patch;
		const prev = nextWatermarks[cat];
		if (prev) {
			nextWatermarks[cat] = {
				...prev,
				...wmFields,
				historyComplete: Boolean(prev.historyComplete || patch.historyComplete),
			};
		} else if (newestItem) {
			nextWatermarks[cat] = {
				latestArxivId: stripVersion(newestItem.arxivId ?? newestItem.id),
				latestPublishedAt: newestItem.publishedAt,
				lastSyncedAt: nowIso,
				...wmFields,
			};
		}
	}

	const summary =
		enriched.length > 0
			? await upsertCollectionPapers({
					items: enriched,
					arxivWatermarks: nextWatermarks,
					lastRefreshedAt: nowIso,
				})
			: await updateCollectionConfig({
					arxivWatermarks: nextWatermarks,
					lastRefreshedAt: nowIso,
				});
	const addedCount = Math.max(0, summary.totalCount - current.totalCount);
	return { summary, addedCount };
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
		const xml = await politePlazaFetchText(
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
		politePlazaFetchText(
			`https://export.arxiv.org/api/query?search_query=${searchQuery}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`,
			"application/atom+xml,text/xml,*/*",
		),
		politePlazaFetchText(
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

type VenueFetchBundle = {
	items: CollectionPaperItem[];
	remoteTotalCount: number;
	latestPublishedAt: string | null;
	authoritativeMainTrack: boolean;
};

/**
 * Multi-channel 2026 venue fetcher combining:
 * 1. Curated main-track rosters (`papers.cool` / `conf.researchr.org` / official program pages),
 * 2. Authoritative publisher feeds (`CSDL`, `DataCite LIPIcs`, `OpenAlex`, `Crossref`),
 * 3. Semantic Scholar Bulk Search + arXiv confirmed accepted-venue metadata fallback.
 */
async function fetchStructuredVenueBundle(
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
		authoritativeMainTrack: multiChannel.authoritativeMainTrack,
	};
}

/**
 * Use the user's configured Agent (with web & paper search capabilities and optional `venue.notes`)
 * to extract Main / Research / Technical Track papers from a Venue URL and its track URLs.
 */
export async function extractVenueWithAgent(
	venue: VenueConfig,
	rawHtml?: string,
): Promise<CollectionPaperItem[]> {
	const resolved = await resolveConfiguredTranslateAgent();
	if (!resolved.agentId) {
		throw new Error("请先在设置中配置并启用 Agent 以执行网页提取");
	}

	const targetUrls =
		venue.tracks && venue.tracks.length > 0
			? venue.tracks.map((u) => u.trim()).filter(Boolean)
			: [venue.url];
	const snippets: string[] = [];

	if (rawHtml) {
		const cleaned = rawHtml
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 18_000);
		if (cleaned) snippets.push(cleaned);
	} else {
		for (const targetUrl of targetUrls.slice(0, 3)) {
			try {
				const html = await plazaFetchText(targetUrl);
				const cleaned = html
					.replace(/<script[\s\S]*?<\/script>/gi, " ")
					.replace(/<style[\s\S]*?<\/style>/gi, " ")
					.replace(/<[^>]+>/g, " ")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 12_000);
				if (cleaned) {
					snippets.push(`SOURCE (${targetUrl}):\n${cleaned}`);
				}
			} catch {
				// Agent can still use its own web/paper search tools if direct HTML fetch fails.
			}
		}
	}

	const notesBlock = venue.notes?.trim()
		? ["", "USER NOTES / INSTRUCTIONS:", venue.notes.trim(), ""]
		: [];
	const tracksLine =
		venue.tracks && venue.tracks.length > 0
			? `Main / Research / Technical Track URLs: ${venue.tracks.join(", ")}`
			: `Official Venue URL: ${venue.url}`;

	const prompt = [
		`You are an academic paper extractor for ${venue.name} (${venue.url}).`,
		tracksLine,
		"Extract ONLY Main Track / Research Track / Technical Track accepted research papers (or regular research articles & peer-reviewed surveys for journals).",
		"Strictly exclude Workshops, Companion volumes, NIER/ERA, Industry/SEIP, Tool Demos, Doctoral/Student tracks, Posters, Tutorials, Keynotes, Findings, and Editorials unless USER NOTES explicitly ask otherwise.",
		"If the page snippet below is incomplete or dynamically rendered, use your web browsing and scholarly paper search tools to locate the official accepted main-track papers.",
		...notesBlock,
		"Return ONLY a valid JSON array (no markdown fences, no commentary) where each element has:",
		`{"title": "string", "authors": ["string"], "abstract": "string", "track": "string", "url": "string", "doi": "string"}`,
		"If no individual papers are available yet, return [].",
		...(snippets.length > 0
			? ["", "PAGE CONTENT:", snippets.join("\n\n").slice(0, 24_000)]
			: []),
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
		doi?: string;
	}>;

	const yearMatch = /\b(20\d{2})\b/.exec(`${venue.name} ${venue.url}`);
	const year = yearMatch ? Number(yearMatch[1]) : TARGET_YEAR;

	return parsed
		.filter(
			(row) =>
				typeof row.title === "string" &&
				row.title.trim().length > 4 &&
				!isFrontmatterTitle(row.title),
		)
		.map((row) => {
			const title = cleanWhitespace(row.title ?? "");
			const abstract = cleanWhitespace(row.abstract ?? "");
			const doi = row.doi?.trim() || undefined;
			const categories = [venue.name, ...(row.track ? [row.track] : [])];
			return {
				id: buildVenuePaperId(venue.id, doi, undefined, title),
				title,
				authors: Array.isArray(row.authors) ? row.authors : [],
				abstract,
				publishedAt: `${year}-01-01T00:00:00Z`,
				year,
				sourceType: "venue" as const,
				sourceLabel: venue.name,
				categories,
				url: row.url || (doi ? `https://doi.org/${doi}` : venue.url),
				doi,
				venueId: venue.id,
				venueKind: venue.kind ?? inferVenueKind(venue),
				venueDomain: venue.domain,
				ccfRank: venue.ccfRank,
				citationCount: 0,
				keywords: [],
			};
		});
}

async function fetchSingleVenueBundle(
	venue: VenueConfig,
	forceAgent = false,
	options?: { maxPages?: number },
): Promise<VenueFetchBundle> {
	const hasBuiltInSpec = VENUE_SPEC_BY_ID.has(venue.id);

	if (!forceAgent && venue.mode !== "agent" && hasBuiltInSpec) {
		return await fetchStructuredVenueBundle(venue, options);
	}

	if (forceAgent || venue.mode === "agent") {
		try {
			const agentItems = await extractVenueWithAgent(venue);
			if (agentItems.length > 0) {
				const enriched = await enrichVenueItemsBatch(
					agentItems,
					venue,
					politePlazaFetchJson,
				);
				return {
					items: enriched,
					remoteTotalCount: enriched.length,
					latestPublishedAt: enriched[0]?.publishedAt ?? null,
					authoritativeMainTrack: true,
				};
			}
		} catch (err) {
			if (forceAgent || !hasBuiltInSpec) throw err;
		}
		if (hasBuiltInSpec) {
			return await fetchStructuredVenueBundle(venue, options);
		}
	}

	// Custom user-added venue in "auto" mode: try deterministic track/program HTML first, then Agent expansion
	const yearMatch = /\b(20\d{2})\b/.exec(`${venue.name} ${venue.url}`);
	const year = yearMatch ? Number(yearMatch[1]) : TARGET_YEAR;
	const candidateUrls =
		venue.tracks && venue.tracks.length > 0 ? venue.tracks : [venue.url];
	const deterministicItems: CollectionPaperItem[] = [];
	let firstHtml = "";

	for (const candidateUrl of candidateUrls) {
		try {
			const html = await plazaFetchText(candidateUrl);
			if (!firstHtml) firstHtml = html;
			const parsedResearchr = parseResearchrHtml(html, venue, candidateUrl);
			const parsed =
				parsedResearchr.length > 0
					? parsedResearchr.map((p) => ({
							...p,
							id: buildVenuePaperId(venue.id, p.doi, p.arxivId, p.title),
							abstract: isPlaceholderAbstract(p.abstract, venue.name)
								? ""
								: p.abstract,
						}))
					: parseOfficialVenueProgramHtml(
							html,
							candidateUrl,
							venue,
							undefined,
							year,
						);
			deterministicItems.push(...parsed);
		} catch {
			// Ignore deterministic fetch failure and fall through to Agent / scholarly channels.
		}
	}

	if (deterministicItems.length > 0) {
		const mergedDet = mergeCollectionItems([deterministicItems]);
		const enriched = await enrichVenueItemsBatch(
			mergedDet,
			venue,
			politePlazaFetchJson,
		);
		return {
			items: enriched,
			remoteTotalCount: enriched.length,
			latestPublishedAt: enriched[0]?.publishedAt ?? null,
			authoritativeMainTrack: true,
		};
	}

	try {
		const agentItems = await extractVenueWithAgent(
			venue,
			firstHtml || undefined,
		);
		if (agentItems.length > 0) {
			const enriched = await enrichVenueItemsBatch(
				agentItems,
				venue,
				politePlazaFetchJson,
			);
			return {
				items: enriched,
				remoteTotalCount: enriched.length,
				latestPublishedAt: enriched[0]?.publishedAt ?? null,
				authoritativeMainTrack: true,
			};
		}
	} catch {
		// Fall back to multi-channel scholarly lookup when Agent is not configured.
	}

	return await fetchStructuredVenueBundle(venue, options);
}

/**
 * Fetch papers for a single VenueConfig.
 */
export async function fetchSingleVenuePapers(
	venue: VenueConfig,
	forceAgent = false,
): Promise<CollectionPaperItem[]> {
	const bundle = await fetchSingleVenueBundle(venue, forceAgent);
	return bundle.items;
}

/**
 * Pure helper that replaces stale rows for `venueId` while carrying forward
 * `recommendedAt` timestamps across matching `(id, doi, arxivId, title)`.
 */
export function applyFreshVenueItems(
	pool: readonly CollectionPaperItem[],
	venueId: string,
	freshVenueItems: CollectionPaperItem[],
	venueName?: string,
): CollectionPaperItem[] {
	if (freshVenueItems.length === 0) {
		return [...pool];
	}

	const recommendedById = new Map<string, string>();
	const recommendedByDoi = new Map<string, string>();
	const recommendedByArxiv = new Map<string, string>();
	const recommendedByTitle = new Map<string, string>();
	const rest: CollectionPaperItem[] = [];

	for (const oldItem of pool) {
		const isTargetVenue =
			oldItem.sourceType === "venue" &&
			(oldItem.venueId === venueId ||
				(!oldItem.venueId && venueName && oldItem.sourceLabel === venueName));
		if (!isTargetVenue) {
			rest.push(oldItem);
			continue;
		}
		if (!oldItem.recommendedAt) continue;
		recommendedById.set(oldItem.id, oldItem.recommendedAt);
		if (oldItem.doi) {
			recommendedByDoi.set(oldItem.doi.toLowerCase(), oldItem.recommendedAt);
		}
		if (oldItem.arxivId) {
			recommendedByArxiv.set(
				oldItem.arxivId.toLowerCase(),
				oldItem.recommendedAt,
			);
		}
		const normTitle = oldItem.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
		if (normTitle) {
			recommendedByTitle.set(normTitle, oldItem.recommendedAt);
		}
	}

	const preservedFresh =
		recommendedById.size === 0
			? freshVenueItems
			: freshVenueItems.map((item) => {
					if (item.recommendedAt) return item;
					const normTitle = item.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
					const prevRec =
						recommendedById.get(item.id) ??
						(item.doi
							? recommendedByDoi.get(item.doi.toLowerCase())
							: undefined) ??
						(item.arxivId
							? recommendedByArxiv.get(item.arxivId.toLowerCase())
							: undefined) ??
						(normTitle ? recommendedByTitle.get(normTitle) : undefined);
					return prevRec ? { ...item, recommendedAt: prevRec } : item;
				});

	return mergeCollectionItems([preservedFresh, rest]);
}

const inflightVenueLoads = new Map<string, Promise<CollectionStateSummary>>();

/**
 * Priority-load (full multi-page update) a specific 2026 venue and atomically
 * replace its rows in `collection.sqlite` while preserving `recommended_at`.
 */
export async function ensureVenueLoaded(
	venueId: string,
): Promise<CollectionStateSummary> {
	const existing = inflightVenueLoads.get(venueId);
	if (existing) return existing;

	const task = (async () => {
		const summary = await fetchCollectionStateSummary();
		const venue = summary.venues.find((v) => v.id === venueId);
		if (!venue) return summary;

		const previousCount = venue.paperCount ?? 0;
		const nowIso = new Date().toISOString();
		const fullBundle = await fetchSingleVenueBundle(venue, false, {
			maxPages: 25,
		});

		if (
			fullBundle.items.length === 0 &&
			previousCount > 0 &&
			venue.id !== "neurips-2026"
		) {
			throw new Error(`No papers returned when refreshing ${venue.name}`);
		}
		if (
			!fullBundle.authoritativeMainTrack &&
			previousCount >= 80 &&
			fullBundle.items.length > 0 &&
			fullBundle.items.length < Math.floor(previousCount * 0.4)
		) {
			throw new Error(
				`Incomplete upstream response when refreshing ${venue.name}`,
			);
		}

		const combinedCount = fullBundle.items.length;
		return await upsertCollectionPapers({
			items: fullBundle.items,
			replaceVenueId: venue.id,
			replaceSourceLabel: venue.name,
			venueUpdate: {
				venueId: venue.id,
				lastFetchedAt: nowIso,
				latestPublishedAt:
					fullBundle.latestPublishedAt ?? venue.latestPublishedAt ?? null,
				remoteTotalCount: Math.max(fullBundle.remoteTotalCount, combinedCount),
			},
		});
	})().finally(() => {
		inflightVenueLoads.delete(venueId);
	});

	inflightVenueLoads.set(venueId, task);
	return task;
}

/**
 * True when opening a paper card's detail dialog should run on-demand enrichment:
 * missing/placeholder abstract, missing citation count, or one-time DOI keyword check.
 */
export function shouldEnrichPaperOnDemand(paper: CollectionPaperItem): boolean {
	if (isPlaceholderAbstract(paper.abstract, paper.sourceLabel)) return true;
	if (paper.citationCount === undefined) return true;
	if (
		paper.doi &&
		(!paper.keywords || paper.keywords.length === 0) &&
		!attemptedDetailEnrichIds.has(paper.id)
	) {
		return true;
	}
	return false;
}

/**
 * Guarantee complete abstract, citation count, authentic keywords, BibTeX, and
 * bibliographic info when clicking a paper card, persisting enriched fields
 * back to `collection.sqlite` via `plazaCollectionPatchPapers`.
 */
export async function ensurePaperFullDetails(
	paper: CollectionPaperItem,
): Promise<CollectionPaperItem> {
	let basePaper: CollectionPaperItem = paper;
	try {
		const dbDetail = await getCollectionPaperDetail(paper.id);
		if (dbDetail) {
			const { citationText: _cite, ...detailFields } = dbDetail;
			basePaper = detailFields;
		}
	} catch {
		// Non-Tauri unit test or offline fallback: proceed with `paper`.
	}

	if (!shouldEnrichPaperOnDemand(basePaper)) {
		return basePaper;
	}
	attemptedDetailEnrichIds.add(basePaper.id);

	const enriched = await enrichSinglePaperOnDemand(
		basePaper,
		politePlazaFetchJson,
		politePlazaFetchText,
	);
	const finalized: CollectionPaperItem = {
		...enriched,
		...(basePaper.recommendedAt && !enriched.recommendedAt
			? { recommendedAt: basePaper.recommendedAt }
			: {}),
		bibtex: enriched.bibtex || formatPaperBibtex(enriched),
	};

	try {
		await patchCollectionPapers([
			{
				id: finalized.id,
				abstract: finalized.abstract || null,
				doi: finalized.doi ?? null,
				arxivId: finalized.arxivId ?? null,
				pdfUrl: finalized.pdfUrl ?? null,
				volume: finalized.volume ?? null,
				issue: finalized.issue ?? null,
				pages: finalized.pages ?? null,
				venueFull: finalized.venueFull ?? null,
				citationCount: finalized.citationCount ?? 0,
				keywords: finalized.keywords ?? [],
				bibtex: finalized.bibtex ?? null,
			},
		]);
	} catch {
		// Non-Tauri unit test fallback: still return the enriched paper.
	}

	return finalized;
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
						...(prev.recommendedAt || item.recommendedAt
							? {
									recommendedAt:
										prev.recommendedAt && item.recommendedAt
											? prev.recommendedAt <= item.recommendedAt
												? prev.recommendedAt
												: item.recommendedAt
											: prev.recommendedAt || item.recommendedAt,
								}
							: {}),
						citationCount: Math.max(
							prev.citationCount ?? 0,
							item.citationCount ?? 0,
						),
						keywords: normalizePaperKeywords([
							...(prev.keywords ?? []),
							...(item.keywords ?? []),
						]),
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
 * True once a venue has already been fetched or has persisted papers in SQLite.
 */
export function isVenueAlreadyLoaded(
	venue: VenueConfig,
	items?: readonly CollectionPaperItem[],
): boolean {
	if (venue.lastFetchedAt || (venue.paperCount ?? 0) > 0) {
		return true;
	}
	if (items && items.length > 0) {
		return items.some(
			(item) => item.sourceType === "venue" && item.venueId === venue.id,
		);
	}
	return false;
}

/**
 * Refresh ONLY `arXiv` categories (either all configured categories or a single
 * sub-category such as `cs.SE`), persisting incremental deltas directly to `collection.sqlite`.
 */
export async function refreshArxivCollection(options?: {
	categories?: string[];
	replaceCategories?: boolean;
	incremental?: boolean;
	onCategoryStatus?: (
		category: string,
		status: "refreshing" | "done" | "error",
	) => void;
	transport?: {
		fetchText?: FetchTextFn;
		fetchJson?: FetchJsonFn;
	};
}): Promise<CollectionStateSummary> {
	const existingSummary = await fetchCollectionStateSummary();
	const targetCategories = options?.categories ?? existingSummary.categories;
	const savedCategories = options?.replaceCategories
		? targetCategories
		: existingSummary.categories;
	const incremental = options?.incremental !== false;

	if (options?.replaceCategories) {
		await updateCollectionConfig({ categories: savedCategories });
	}

	const arxivSync = await syncArxivCategoriesIncremental(
		targetCategories,
		[],
		existingSummary.arxivWatermarks,
		incremental,
		{
			...options?.transport,
			categoryCounts: existingSummary.categoryCounts,
			deferIncompleteDoneStatus: true,
			onCategoryStatus: options?.onCategoryStatus,
		},
	);

	const latestSnap = await fetchCollectionStateSummary();
	const mergedWatermarks: Record<string, ArxivCategoryWatermark> = {
		...latestSnap.arxivWatermarks,
		...arxivSync.nextWatermarks,
	};
	const nowIso = new Date().toISOString();
	const latestArxiv = arxivSync.latest ?? latestSnap.latestArxiv;

	const nextSummary =
		arxivSync.deltaItems.length > 0
			? await upsertCollectionPapers({
					items: arxivSync.deltaItems,
					arxivWatermarks: mergedWatermarks,
					lastRefreshedAt: nowIso,
					latestArxiv,
				})
			: await updateCollectionConfig({
					arxivWatermarks: mergedWatermarks,
					lastRefreshedAt: nowIso,
					...(latestArxiv ? { latestArxiv } : {}),
				});

	const incompleteCats = targetCategories
		.map((c) => c.trim())
		.filter(
			(c) => Boolean(c) && !nextSummary.arxivWatermarks[c]?.historyComplete,
		);
	if (incompleteCats.length > 0 || arxivSync.coldStartCategories.length > 0) {
		const catsToPreload = Array.from(
			new Set([...arxivSync.coldStartCategories, ...incompleteCats]),
		);
		await preloadAll2026ArxivInBackground(catsToPreload, 120, 1000, {
			...options?.transport,
			onCategoryStatus: options?.onCategoryStatus,
		});
		return await fetchCollectionStateSummary();
	}
	return nextSummary;
}

/**
 * Refresh ONLY `Venue` entries (either all venues, a filtered subset, or a single
 * venue such as `ase-2026`), persisting each venue atomically to `collection.sqlite`.
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
}): Promise<CollectionStateSummary> {
	let current = await fetchCollectionStateSummary();
	if (options?.venues !== undefined) {
		const changed =
			options.venues.length !== current.venues.length ||
			options.venues.some((v, idx) => {
				const cur = current.venues[idx];
				return (
					!cur ||
					cur.id !== v.id ||
					cur.name !== v.name ||
					cur.url !== v.url ||
					(cur.notes ?? "") !== (v.notes ?? "") ||
					cur.mode !== v.mode ||
					(cur.tracks ?? []).join("|") !== (v.tracks ?? []).join("|")
				);
			});
		if (changed) {
			current = await updateCollectionConfig({ venues: options.venues });
		}
	}

	const baseVenues = options?.venues ?? current.venues;
	const idSet =
		options?.venueIds && options.venueIds.length > 0
			? new Set(options.venueIds)
			: null;
	const targets = baseVenues.filter((v) => {
		if (idSet && !idSet.has(v.id)) return false;
		if (options?.skipLoaded && isVenueAlreadyLoaded(v)) {
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
				collectionStore.getState().venues.find((v) => v.id === target.id) ??
				target;
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

	return updateCollectionConfig({
		lastRefreshedAt: new Date().toISOString(),
	});
}

/**
 * Refresh both `arXiv` and `Venue` portals in `collection.sqlite`.
 */
export async function refreshAllCollection(options?: {
	incrementalArxiv?: boolean;
	skipLoadedVenues?: boolean;
	onCategoryStatus?: (
		category: string,
		status: "refreshing" | "done" | "error",
	) => void;
	onVenueProgress?: (venue: VenueConfig, index: number, total: number) => void;
	onVenueStatus?: (
		venue: VenueConfig,
		status: "refreshing" | "done" | "error",
		index: number,
		total: number,
	) => void;
}): Promise<CollectionStateSummary> {
	await refreshArxivCollection({
		incremental: options?.incrementalArxiv !== false,
		onCategoryStatus: options?.onCategoryStatus,
	});
	return refreshVenueCollection({
		skipLoaded: options?.skipLoadedVenues ?? false,
		onVenueProgress: options?.onVenueProgress,
		onVenueStatus: options?.onVenueStatus,
	});
}
