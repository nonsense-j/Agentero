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
import {
	BackgroundTaskCancelledError,
	isBackgroundTaskCancelledError,
} from "@/lib/core/background-tasks";
import { commands } from "@/lib/core/bindings";
import { getKeywordLlmConfigSignature } from "@/lib/keyword-llm";
import {
	ensureOpenAlexRuntimeKeyLoaded,
	withOpenAlexApiKey,
} from "@/lib/openalex";
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
	extractArxivHtmlKeywords,
	extractSpringerHtmlAbstract,
	type FetchJsonFn,
	type FetchTextFn,
	fetchVenueStructuredPapers,
	formatPaperBibtex,
	formatPaperCitationText,
	inferVenueKind,
	isFrontmatterTitle,
	isNonResearchJournalItem,
	isPaperMetadataComplete,
	isPlaceholderAbstract,
	isPositionPaperTitle,
	isWorkshopOrCompanionVenue,
	normalizePaperKeywords,
	reconstructOpenAlexAbstract,
	sleepWithAbort,
	throwIfAborted,
	VENUE_SPEC_BY_ID,
	VENUE_SPECS,
	type VenueCcfRank,
	type VenueConfig,
	type VenueDomain,
	type VenueKind,
	type VenueSpec,
	wrapFetchJsonWithAbort,
	wrapFetchTextWithAbort,
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
	finalizeVenuePapersWithSmartDiff,
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
	extractArxivHtmlKeywords,
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
	isPaperMetadataComplete,
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
const completedArxivEnrichIds = new Set<string>();
const sessionAttemptedArxivEnrichIds = new Set<string>();
let lastObservedKeywordLlmConfigSig = "";

function syncEnrichmentSessionWithKeywordLlmConfig(): void {
	const sig = getKeywordLlmConfigSignature();
	if (sig !== lastObservedKeywordLlmConfigSig) {
		lastObservedKeywordLlmConfigSig = sig;
		sessionAttemptedArxivEnrichIds.clear();
		attemptedDetailEnrichIds.clear();
	}
}

function startNewArxivRefreshSession(): void {
	syncEnrichmentSessionWithKeywordLlmConfig();
	sessionAttemptedArxivEnrichIds.clear();
}

function recordArxivEnrichAttempt(items: readonly CollectionPaperItem[]): void {
	syncEnrichmentSessionWithKeywordLlmConfig();
	for (const item of items) {
		if (!item.id) continue;
		sessionAttemptedArxivEnrichIds.add(item.id);
		if (isPaperMetadataComplete(item)) {
			completedArxivEnrichIds.add(item.id);
		} else {
			completedArxivEnrichIds.delete(item.id);
		}
	}
}

function shouldAttemptArxivBackfill(item: CollectionPaperItem): boolean {
	syncEnrichmentSessionWithKeywordLlmConfig();
	if (isPaperMetadataComplete(item)) {
		if (item.id) completedArxivEnrichIds.add(item.id);
		return false;
	}
	completedArxivEnrichIds.delete(item.id);
	return !sessionAttemptedArxivEnrichIds.has(item.id);
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

/** Reset transient in-memory summary & enrichment flags (primarily for unit tests). */
export function resetCollectionMemoryForTests(): void {
	attemptedDetailEnrichIds.clear();
	completedArxivEnrichIds.clear();
	sessionAttemptedArxivEnrichIds.clear();
	lastObservedKeywordLlmConfigSig = "";
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
	"arxiv.org",
]);

function stripOpenAlexApiKeyParam(rawUrl: string): string {
	try {
		const parsed = new URL(rawUrl);
		if (!parsed.searchParams.has("api_key")) return rawUrl;
		parsed.searchParams.delete("api_key");
		return parsed.toString();
	} catch {
		return rawUrl.replace(/([?&])api_key=[^&#]*(&|$)/, (_m, sep, tail) =>
			tail === "&" ? sep : "",
		);
	}
}

async function readResponseHeadText(
	res: Response,
	maxBytes: number,
): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) {
		const full = await res.text();
		return full.slice(0, maxBytes);
	}
	const decoder = new TextDecoder();
	let out = "";
	let received = 0;
	try {
		while (received < maxBytes) {
			const { done, value } = await reader.read();
			if (done || !value) break;
			const remaining = maxBytes - received;
			const slice =
				value.byteLength > remaining ? value.subarray(0, remaining) : value;
			out += decoder.decode(slice, { stream: true });
			received += slice.byteLength;
			if (slice.byteLength < value.byteLength) break;
		}
		out += decoder.decode();
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return out;
}

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
function combineAbortSignals(
	...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
	const active = signals.filter((s): s is AbortSignal => Boolean(s));
	if (active.length === 0) return undefined;
	if (active.length === 1) return active[0];
	if (typeof AbortSignal?.any === "function") {
		return AbortSignal.any(active);
	}
	return active[0];
}

export async function plazaFetchText(
	url: string,
	accept = "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
	signal?: AbortSignal,
): Promise<string> {
	throwIfAborted(signal);
	const rawCleanUrl = url.split("#")[0] || url;
	let hostname = "";
	let pathname = "";
	try {
		const parsed = new URL(rawCleanUrl);
		hostname = parsed.hostname.toLowerCase();
		pathname = parsed.pathname;
	} catch {
		hostname = "";
	}
	if (hostname === "api.openalex.org") {
		await ensureOpenAlexRuntimeKeyLoaded();
		throwIfAborted(signal);
	}
	const cleanUrl =
		hostname === "api.openalex.org"
			? withOpenAlexApiKey(rawCleanUrl)
			: rawCleanUrl;
	const isArxivHtmlHead =
		hostname === "arxiv.org" && /^\/html\//i.test(pathname);

	// Fast path: OpenAlex / Crossref / DataCite / Semantic Scholar / CSDL / arxiv.org send `Access-Control-Allow-Origin: *`
	if (CORS_OPEN_HOSTS.has(hostname)) {
		try {
			const htmlSignal =
				isArxivHtmlHead && typeof AbortSignal?.timeout === "function"
					? AbortSignal.timeout(10_000)
					: undefined;
			const reqSignal = combineAbortSignals(signal, htmlSignal);
			let direct = await fetch(cleanUrl, {
				headers: { Accept: accept },
				...(reqSignal ? { signal: reqSignal } : {}),
			});
			if (direct.status === 401 && hostname === "api.openalex.org") {
				const unauthUrl = stripOpenAlexApiKeyParam(cleanUrl);
				if (unauthUrl !== cleanUrl) {
					direct = await fetch(unauthUrl, {
						headers: { Accept: accept },
						...(signal ? { signal } : {}),
					});
				}
			}
			if (
				direct.status === 202 ||
				direct.status === 429 ||
				(isArxivHtmlHead && direct.status === 404)
			) {
				throw new Error(`HTTP ${direct.status} fetching ${cleanUrl}`);
			}
			if (direct.ok) {
				return isArxivHtmlHead
					? await readResponseHeadText(direct, 65_536)
					: await direct.text();
			}
		} catch (err) {
			if (signal?.aborted || isBackgroundTaskCancelledError(err)) {
				throw new BackgroundTaskCancelledError();
			}
			if (err instanceof Error && /HTTP (?:202|404|429)\b/.test(err.message)) {
				throw err;
			}
			// Fall through to proxy fallback if direct fetch failed at network layer.
		}
	}

	if (hasTauriRuntime()) {
		try {
			await ensureWebProxyAllowed(hostname);
			throwIfAborted(signal);
			const proxied = webViewProxyUrl(cleanUrl);
			const res = await fetch(proxied, {
				headers: { Accept: accept },
				...(signal ? { signal } : {}),
			});
			if (res.status === 202) {
				throw new Error(`Upstream anti-bot gate (HTTP 202) for ${cleanUrl}`);
			}
			if (res.ok) {
				return await res.text();
			}
		} catch (err) {
			if (signal?.aborted || isBackgroundTaskCancelledError(err)) {
				throw new BackgroundTaskCancelledError();
			}
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
				...(signal ? { signal } : {}),
			});
			if (res.status === 202) {
				throw new Error(`Upstream anti-bot gate (HTTP 202) for ${cleanUrl}`);
			}
			if (res.ok) {
				return await res.text();
			}
		} catch (err) {
			if (signal?.aborted || isBackgroundTaskCancelledError(err)) {
				throw new BackgroundTaskCancelledError();
			}
			if (err instanceof Error && err.message.includes("HTTP 202")) {
				throw err;
			}
			// Fall through to direct fetch below.
		}
	}

	throwIfAborted(signal);
	const direct = await fetch(cleanUrl, {
		headers: { Accept: accept },
		...(signal ? { signal } : {}),
	});
	if (direct.status === 202 || !direct.ok) {
		throw new Error(`HTTP ${direct.status} fetching ${cleanUrl}`);
	}
	return await direct.text();
}

export async function plazaFetchJson<T = unknown>(
	url: string,
	signal?: AbortSignal,
): Promise<T> {
	const text = await plazaFetchText(url, "application/json", signal);
	const trimmed = text.trimStart();
	if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
		throw new Error(`Expected JSON but received HTML from ${url}`);
	}
	return JSON.parse(text) as T;
}

const politePlazaFetchJson = createPoliteFetchJson(plazaFetchJson);
const politePlazaFetchText = createPoliteFetchText(plazaFetchText);

function resolveTransportFetchers(transport?: {
	fetchText?: FetchTextFn;
	fetchJson?: FetchJsonFn;
	signal?: AbortSignal;
}) {
	const baseText =
		transport?.fetchText ??
		(transport?.signal
			? createPoliteFetchText((url, accept) =>
					plazaFetchText(url, accept, transport.signal),
				)
			: politePlazaFetchText);
	const baseJson =
		transport?.fetchJson ??
		(transport?.signal
			? createPoliteFetchJson(<T = unknown>(url: string) =>
					plazaFetchJson<T>(url, transport.signal),
				)
			: politePlazaFetchJson);
	return {
		fetchTextFn: wrapFetchTextWithAbort(baseText, transport?.signal),
		fetchJsonFn: wrapFetchJsonWithAbort(baseJson, transport?.signal),
	};
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
		signal?: AbortSignal;
	},
): Promise<ArxivCategoryPageResult> {
	throwIfAborted(options?.signal);
	const startOffset = options?.startOffset ?? 0;
	const fromStamp = options?.fromSubmittedStamp || `${TARGET_YEAR}01010000`;
	const toStamp = options?.toSubmittedStamp || "209912312359";
	const fetchTextFn = options?.fetchTextFn ?? politePlazaFetchText;
	const dateBound = `+AND+submittedDate:[${fromStamp}+TO+${toStamp}]`;
	const apiUrl = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(cat)}${dateBound}&sortBy=submittedDate&sortOrder=descending&start=${startOffset}&max_results=${maxResults}`;

	const maxAttempts = 5;
	let lastErr: unknown = null;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		throwIfAborted(options?.signal);
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
			if (options?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
				throw err;
			}
			lastErr = err;
		}
		if (
			attempt + 1 < maxAttempts &&
			(typeof import.meta === "undefined" || import.meta.env?.MODE !== "test")
		) {
			await sleepWithAbort(3500 * (attempt + 1), options?.signal);
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
		keywordLlmFetch?: typeof fetch;
		signal?: AbortSignal;
		onProgress?: (info: {
			stage: "fetch" | "enrich";
			category: string;
			completed: number;
			total: number;
		}) => void;
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
	throwIfAborted(transport?.signal);
	const cleanCats = categories.map((c) => c.trim()).filter(Boolean);
	if (cleanCats.length === 0) {
		return { items: [], latest: null, pageMetaByCategory: {} };
	}
	const { fetchTextFn, fetchJsonFn } = resolveTransportFetchers(transport);

	const rssPromise =
		startOffset === 0
			? Promise.allSettled(
					cleanCats.map((cat) =>
						fetchArxivRssFast(cat, cleanCats, fetchTextFn),
					),
				)
			: Promise.resolve([]);

	let fetchedCatCount = 0;
	const [rssResults, perCatResults] = await Promise.all([
		rssPromise,
		Promise.allSettled(
			cleanCats.map(async (cat) => {
				const res = await fetchArxivCategoryPageWithRetry(
					cat,
					cleanCats,
					maxResultsPerCategory,
					{
						startOffset,
						fetchTextFn,
						signal: transport?.signal,
					},
				);
				fetchedCatCount += 1;
				transport?.onProgress?.({
					stage: "fetch",
					category: cat,
					completed: fetchedCatCount,
					total: cleanCats.length,
				});
				return res;
			}),
		),
	]);
	throwIfAborted(transport?.signal);

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
	const items = await enrichArxivItemsBatch(
		rawMerged,
		fetchJsonFn,
		rawMerged.length,
		{
			keywordLlmFetch: transport?.keywordLlmFetch,
			signal: transport?.signal,
			onProgress: (completed, total) => {
				transport?.onProgress?.({
					stage: "enrich",
					category: cleanCats[0] ?? "",
					completed,
					total,
				});
			},
		},
	);
	recordArxivEnrichAttempt(items);
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
		keywordLlmFetch?: typeof fetch;
		categoryCounts?: Readonly<Record<string, number>>;
		deferIncompleteDoneStatus?: boolean;
		signal?: AbortSignal;
		onPhaseProgress?: (
			category: string,
			fraction: number,
			subCompleted?: number,
			subTotal?: number,
		) => void;
		onPhaseDone?: (category: string) => void;
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
	throwIfAborted(transport?.signal);
	const { fetchTextFn, fetchJsonFn } = resolveTransportFetchers(transport);
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
	const warmCatsWithDelta: string[] = [];
	const nowIso = new Date().toISOString();

	if (warmCategories.length > 0) {
		await Promise.allSettled(
			warmCategories.map(async (cat) => {
				throwIfAborted(transport?.signal);
				const wm = existingWatermarks[cat];
				if (!wm) return;
				onCategoryStatus?.(cat, "refreshing");
				transport?.onPhaseProgress?.(cat, 0.15);
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
						transport?.onPhaseDone?.(cat);
						return;
					}

					transport?.onPhaseProgress?.(cat, 0.35);

					// Newer timestamp detected -> pull ONLY incremental window since watermark
					const fromStamp = toArxivSubmittedDateStamp(wm.latestPublishedAt, 12);
					const [rssItems, deltaPage] = await Promise.all([
						fetchArxivRssFast(cat, cleanCats, fetchTextFn),
						fetchArxivCategoryPageWithRetry(cat, cleanCats, 300, {
							startOffset: 0,
							fromSubmittedStamp: fromStamp,
							fetchTextFn,
							signal: transport?.signal,
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
						warmCatsWithDelta.push(cat);
						transport?.onPhaseProgress?.(cat, 0.55, 0, unseen.length);
					} else {
						emitDoneIfComplete(cat);
						transport?.onPhaseDone?.(cat);
					}
				} catch (err) {
					if (
						transport?.signal?.aborted ||
						isBackgroundTaskCancelledError(err)
					) {
						throw err;
					}
					onCategoryStatus?.(cat, "error");
					throw err;
				}
			}),
		);
		throwIfAborted(transport?.signal);
	}

	let enrichedDelta: CollectionPaperItem[] = [];
	if (rawDeltaGroups.length > 0) {
		throwIfAborted(transport?.signal);
		const mergedWarmDelta = mergeCollectionItems(rawDeltaGroups);
		const displayCat = warmCatsWithDelta[0] ?? warmCategories[0] ?? "";
		enrichedDelta = await enrichArxivItemsBatch(
			mergedWarmDelta,
			fetchJsonFn,
			mergedWarmDelta.length,
			{
				keywordLlmFetch: transport?.keywordLlmFetch,
				signal: transport?.signal,
				onProgress: (completed, total) => {
					const frac = 0.55 + 0.45 * (completed / Math.max(1, total));
					for (const cat of warmCatsWithDelta) {
						transport?.onPhaseProgress?.(
							cat,
							frac,
							cat === displayCat ? completed : undefined,
							cat === displayCat ? total : undefined,
						);
					}
				},
			},
		);
		recordArxivEnrichAttempt(enrichedDelta);
		for (const cat of warmCatsWithDelta) {
			emitDoneIfComplete(cat);
			transport?.onPhaseDone?.(cat);
		}
	}

	let coldFetchedItems: CollectionPaperItem[] = [];
	if (coldStartCategories.length > 0) {
		throwIfAborted(transport?.signal);
		for (const cat of coldStartCategories) {
			onCategoryStatus?.(cat, "refreshing");
			transport?.onPhaseProgress?.(cat, 0.12);
		}
		const coldDisplayCat = coldStartCategories[0] ?? "";
		try {
			const coldRes = await fetchArxivCollection(coldStartCategories, 300, 0, {
				...transport,
				fetchText: fetchTextFn,
				fetchJson: fetchJsonFn,
				onProgress: (info) => {
					if (info.stage === "fetch") {
						const frac =
							0.12 + 0.23 * (info.completed / Math.max(1, info.total));
						for (const cat of coldStartCategories) {
							transport?.onPhaseProgress?.(cat, frac);
						}
						return;
					}
					const frac = 0.35 + 0.65 * (info.completed / Math.max(1, info.total));
					for (const cat of coldStartCategories) {
						transport?.onPhaseProgress?.(
							cat,
							frac,
							cat === coldDisplayCat ? info.completed : undefined,
							cat === coldDisplayCat ? info.total : undefined,
						);
					}
				},
			});
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
				transport?.onPhaseDone?.(cat);
			}
		} catch (err) {
			if (transport?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
				throw err;
			}
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
		keywordLlmFetch?: typeof fetch;
		signal?: AbortSignal;
		onCategoryProgress?: (
			category: string,
			syncedCount: number,
			remoteTotal?: number,
			pagesDone?: number,
		) => void;
		onCategoryStatus?: (
			category: string,
			status: "refreshing" | "done" | "error",
		) => void;
	},
): Promise<void> {
	throwIfAborted(transport?.signal);
	const initialSnap = await fetchCollectionStateSummary();
	throwIfAborted(transport?.signal);
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
	const { fetchTextFn, fetchJsonFn } = resolveTransportFetchers(transport);

	type CatCursor = {
		toStamp: string;
		startOffset: number;
		oldestSyncedPublishedAt?: string;
		remoteTotal?: number;
		consecutiveFailures: number;
	};
	const cursors = new Map<string, CatCursor>();
	const syncedCounts = new Map<string, number>();
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
		syncedCounts.set(cat, Math.max(0, initialSnap.categoryCounts[cat] ?? 0));
	}

	const erroredCats = new Set<string>();
	const completedCats = new Set<string>();

	try {
		let activeCats = [...pendingCats];
		for (let page = 1; page <= maxPages && activeCats.length > 0; page++) {
			throwIfAborted(transport?.signal);
			if (runId !== activePreloadRunId) return;
			const stillActive: string[] = [];
			const pageGroups: CollectionPaperItem[][] = [];
			const watermarkUpdates: Record<
				string,
				Partial<ArxivCategoryWatermark>
			> = {};
			const newlyCompletedThisPage: string[] = [];
			const preferredCategories = collectionStore.getState().categories;

			const pageFetchedCats: string[] = [];
			const pageStartSynced = new Map<string, number>();
			const pageTargetSynced = new Map<string, number>();

			for (const cat of activeCats) {
				throwIfAborted(transport?.signal);
				if (runId !== activePreloadRunId) return;
				const curCursor = cursors.get(cat);
				if (!curCursor) continue;

				try {
					const prevCatSynced = syncedCounts.get(cat) ?? 0;
					pageStartSynced.set(cat, prevCatSynced);
					transport?.onCategoryProgress?.(
						cat,
						prevCatSynced,
						curCursor.remoteTotal,
						page - 1,
					);
					const pageRes = await fetchArxivCategoryPageWithRetry(
						cat,
						preferredCategories,
						perPage,
						{
							startOffset: curCursor.startOffset,
							toSubmittedStamp: curCursor.toStamp,
							fetchTextFn,
							signal: transport?.signal,
						},
					);
					curCursor.consecutiveFailures = 0;

					if (pageRes.items.length > 0) {
						pageGroups.push(pageRes.items);
					}
					if (typeof pageRes.totalResults === "number") {
						if (
							curCursor.toStamp === "209912312359" &&
							curCursor.startOffset === 0
						) {
							curCursor.remoteTotal = pageRes.totalResults;
						} else if (
							curCursor.remoteTotal == null ||
							curCursor.remoteTotal <= 0
						) {
							curCursor.remoteTotal = Math.max(
								prevCatSynced + pageRes.items.length,
								prevCatSynced + pageRes.totalResults,
							);
						}
					}

					const estSynced =
						curCursor.remoteTotal != null
							? Math.min(
									curCursor.remoteTotal,
									prevCatSynced + pageRes.items.length,
								)
							: prevCatSynced + pageRes.items.length;
					pageFetchedCats.push(cat);
					pageTargetSynced.set(cat, estSynced);
					syncedCounts.set(cat, estSynced);
					const afterFetchDisplay =
						pageRes.items.length > 0
							? Math.min(
									estSynced,
									prevCatSynced +
										Math.max(1, Math.round(pageRes.items.length * 0.25)),
								)
							: estSynced;
					transport?.onCategoryProgress?.(
						cat,
						afterFetchDisplay,
						curCursor.remoteTotal,
						page - 0.75,
					);

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
				} catch (err) {
					if (
						transport?.signal?.aborted ||
						isBackgroundTaskCancelledError(err)
					) {
						throw err;
					}
					curCursor.consecutiveFailures += 1;
					if (curCursor.consecutiveFailures < 3) {
						if (
							typeof import.meta === "undefined" ||
							import.meta.env?.MODE !== "test"
						) {
							await sleepWithAbort(
								4000 * curCursor.consecutiveFailures,
								transport?.signal,
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
			const existingById = new Map(existingInDb.map((i) => [i.id, i]));
			const needsUpsertBatch = batchMerged
				.filter((i) => {
					const prev = existingById.get(i.id);
					if (!prev) return true;
					return shouldAttemptArxivBackfill(prev);
				})
				.map((i) => {
					const prev = existingById.get(i.id);
					return prev ? (mergeCollectionItems([[i], [prev]])[0] ?? i) : i;
				});
			const displayPreloadCat = pageFetchedCats[0] ?? activeCats[0] ?? "";
			const enrichedUnseen =
				needsUpsertBatch.length > 0
					? await enrichArxivItemsBatch(
							needsUpsertBatch,
							fetchJsonFn,
							needsUpsertBatch.length,
							{
								keywordLlmFetch: transport?.keywordLlmFetch,
								signal: transport?.signal,
								onProgress: (completed, total) => {
									const ratio = total > 0 ? completed / total : 1;
									for (const cat of pageFetchedCats) {
										const cur = cursors.get(cat);
										const prev = pageStartSynced.get(cat) ?? 0;
										const target = pageTargetSynced.get(cat) ?? prev;
										const interp =
											prev +
											Math.round((target - prev) * (0.25 + 0.75 * ratio));
										if (cur?.remoteTotal != null && cur.remoteTotal > 0) {
											transport?.onCategoryProgress?.(
												cat,
												Math.min(cur.remoteTotal, interp),
												cur.remoteTotal,
												page - 0.75 + 0.75 * ratio,
											);
										} else if (cat === displayPreloadCat) {
											transport?.onCategoryProgress?.(
												cat,
												completed,
												total,
												page - 0.75 + 0.75 * ratio,
											);
										}
									}
								},
							},
						)
					: [];
			for (const cat of pageFetchedCats) {
				const cur = cursors.get(cat);
				const target = pageTargetSynced.get(cat) ?? syncedCounts.get(cat) ?? 0;
				transport?.onCategoryProgress?.(cat, target, cur?.remoteTotal, page);
			}
			if (enrichedUnseen.length > 0) {
				recordArxivEnrichAttempt(enrichedUnseen);
			}

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

			let savedSummary = latestCur;
			if (enrichedUnseen.length > 0) {
				savedSummary = await upsertCollectionPapers({
					items: enrichedUnseen,
					arxivWatermarks: nextWms,
				});
			} else if (Object.keys(watermarkUpdates).length > 0) {
				savedSummary = await updateCollectionConfig({
					arxivWatermarks: nextWms,
				});
			}
			for (const cat of Object.keys(watermarkUpdates)) {
				const persistedCount = savedSummary.categoryCounts[cat];
				if (typeof persistedCount === "number") {
					syncedCounts.set(cat, persistedCount);
				}
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
		keywordLlmFetch?: typeof fetch;
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
	const existingById = new Map(existingInDb.map((i) => [i.id, i]));
	const unseenOrUnenriched = rawBatch
		.filter((i) => {
			const prev = existingById.get(i.id);
			if (!prev) return true;
			return shouldAttemptArxivBackfill(prev);
		})
		.map((i) => {
			const prev = existingById.get(i.id);
			return prev ? (mergeCollectionItems([[i], [prev]])[0] ?? i) : i;
		});
	const enriched =
		unseenOrUnenriched.length > 0
			? await enrichArxivItemsBatch(
					unseenOrUnenriched,
					fetchJsonFn,
					unseenOrUnenriched.length,
					{ keywordLlmFetch: options?.transport?.keywordLlmFetch },
				)
			: [];
	if (enriched.length > 0) {
		recordArxivEnrichAttempt(enriched);
	}

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
		const parsed = parseArxivAtomXml(xml, null, {
			preferredCategories: cleanCats,
		});
		return enrichArxivItemsBatch(parsed, politePlazaFetchJson, parsed.length);
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
	const merged = mergeCollectionItems(groups);
	return enrichArxivItemsBatch(merged, politePlazaFetchJson, merged.length);
}

type VenueFetchBundle = {
	items: CollectionPaperItem[];
	remoteTotalCount: number;
	latestPublishedAt: string | null;
	authoritativeMainTrack: boolean;
};

type VenueSyncOptions = {
	maxPages?: number;
	existingItems?: readonly CollectionPaperItem[];
	keywordLlmFetch?: typeof fetch;
	fetchJson?: FetchJsonFn;
	fetchText?: FetchTextFn;
	signal?: AbortSignal;
	onProgress?: (progress: { completed?: number; total?: number }) => void;
};

/**
 * Multi-channel 2026 venue fetcher combining:
 * 1. Curated main-track rosters (`papers.cool` / `conf.researchr.org` / official program pages),
 * 2. Authoritative publisher feeds (`CSDL`, `DataCite LIPIcs`, `OpenAlex`, `Crossref`),
 * 3. Semantic Scholar Bulk Search + arXiv confirmed accepted-venue metadata fallback.
 */
async function fetchStructuredVenueBundle(
	venue: VenueConfig,
	options?: VenueSyncOptions,
): Promise<VenueFetchBundle> {
	throwIfAborted(options?.signal);
	const yearMatch = /\b(20\d{2})\b/.exec(`${venue.name} ${venue.url}`);
	const year = yearMatch ? Number(yearMatch[1]) : TARGET_YEAR;

	const multiChannel = await fetchMultiChannelVenuePapers(
		venue,
		year,
		options?.fetchJson ??
			(options?.signal
				? <T = unknown>(url: string) => plazaFetchJson<T>(url, options.signal)
				: plazaFetchJson),
		options?.fetchText ??
			(options?.signal
				? (url, accept) => plazaFetchText(url, accept, options.signal)
				: plazaFetchText),
		{
			maxPages: options?.maxPages,
			existingItems: options?.existingItems,
			keywordLlmFetch: options?.keywordLlmFetch,
			signal: options?.signal,
			onProgress: options?.onProgress,
		},
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

async function loadExistingVenuePapersFromDb(
	venueId: string,
): Promise<CollectionPaperItem[]> {
	const all: CollectionPaperItem[] = [];
	let offset = 0;
	const limit = 1000;
	try {
		while (offset < 20_000) {
			const page = await listCollectionPapers({
				sourceType: "venue",
				venueId,
				timePreset: "all",
				limit,
				offset,
			});
			if (page.items.length === 0) break;
			all.push(...page.items);
			if (!page.hasMore) break;
			offset += page.items.length;
		}
	} catch {
		return [];
	}
	return all;
}

async function fetchSingleVenueBundle(
	venue: VenueConfig,
	forceAgent = false,
	options?: VenueSyncOptions,
): Promise<VenueFetchBundle> {
	throwIfAborted(options?.signal);
	const hasBuiltInSpec = VENUE_SPEC_BY_ID.has(venue.id);
	const { fetchTextFn, fetchJsonFn } = resolveTransportFetchers({
		fetchJson: options?.fetchJson,
		fetchText:
			options?.fetchText ??
			(options?.signal
				? (url, accept) => plazaFetchText(url, accept, options.signal)
				: plazaFetchText),
		signal: options?.signal,
	});
	const nextOptions: VenueSyncOptions = {
		...options,
		fetchJson: fetchJsonFn,
		fetchText: fetchTextFn,
	};

	if (!forceAgent && venue.mode !== "agent" && hasBuiltInSpec) {
		return await fetchStructuredVenueBundle(venue, nextOptions);
	}

	if (forceAgent || venue.mode === "agent") {
		try {
			const agentItems = await extractVenueWithAgent(venue);
			if (agentItems.length > 0) {
				const enriched = await finalizeVenuePapersWithSmartDiff(
					agentItems,
					venue,
					fetchJsonFn,
					{
						existingItems: options?.existingItems,
						keywordLlmFetch: options?.keywordLlmFetch,
					},
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
			const html = await fetchTextFn(candidateUrl);
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
		const enriched = await finalizeVenuePapersWithSmartDiff(
			mergedDet,
			venue,
			fetchJsonFn,
			{
				existingItems: options?.existingItems,
				keywordLlmFetch: options?.keywordLlmFetch,
			},
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
			const enriched = await finalizeVenuePapersWithSmartDiff(
				agentItems,
				venue,
				fetchJsonFn,
				{
					existingItems: options?.existingItems,
					keywordLlmFetch: options?.keywordLlmFetch,
				},
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
 * Priority-load (full multi-page update) a specific 2026 venue with Smart Diff against
 * existing SQLite rows: deletes stale rows, skips OpenAlex/OpenRouter calls for rows that
 * already have complete abstract + keywords, and enriches only new or incomplete rows.
 */
export async function ensureVenueLoaded(
	venueId: string,
	transport?: {
		fetchJson?: FetchJsonFn;
		fetchText?: FetchTextFn;
		keywordLlmFetch?: typeof fetch;
		signal?: AbortSignal;
		onProgress?: (progress: { completed?: number; total?: number }) => void;
	},
): Promise<CollectionStateSummary> {
	throwIfAborted(transport?.signal);
	const existing = inflightVenueLoads.get(venueId);
	if (existing) return existing;

	const task = (async () => {
		const summary = await fetchCollectionStateSummary();
		throwIfAborted(transport?.signal);
		const venue = summary.venues.find((v) => v.id === venueId);
		if (!venue) return summary;

		const previousCount = venue.paperCount ?? 0;
		const existingItems = await loadExistingVenuePapersFromDb(venue.id);
		throwIfAborted(transport?.signal);
		const nowIso = new Date().toISOString();
		const fullBundle = await fetchSingleVenueBundle(venue, false, {
			maxPages: 25,
			existingItems,
			fetchJson: transport?.fetchJson,
			fetchText: transport?.fetchText,
			keywordLlmFetch: transport?.keywordLlmFetch,
			signal: transport?.signal,
			onProgress: transport?.onProgress,
		});
		throwIfAborted(transport?.signal);

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
 * missing/placeholder abstract, missing citation count, or missing canonical keywords.
 */
export function shouldEnrichPaperOnDemand(paper: CollectionPaperItem): boolean {
	syncEnrichmentSessionWithKeywordLlmConfig();
	if (isPlaceholderAbstract(paper.abstract, paper.sourceLabel)) return true;
	if (paper.citationCount === undefined) return true;
	if (
		normalizePaperKeywords(paper.keywords).length === 0 &&
		!attemptedDetailEnrichIds.has(paper.id)
	) {
		return true;
	}
	return false;
}

/**
 * Guarantee complete abstract, citation count, canonical keywords, BibTeX, and
 * bibliographic info when clicking a paper card, persisting enriched fields
 * back to `collection.sqlite` via `plazaCollectionPatchPapers`.
 */
export async function ensurePaperFullDetails(
	paper: CollectionPaperItem,
	transport?: {
		fetchJson?: FetchJsonFn;
		fetchText?: FetchTextFn;
		keywordLlmFetch?: typeof fetch;
	},
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
		transport?.fetchJson ?? politePlazaFetchJson,
		transport?.fetchText ?? politePlazaFetchText,
		{ keywordLlmFetch: transport?.keywordLlmFetch },
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
 * Backfill complete abstracts, canonical keywords (OpenAlex -> Keyword LLM),
 * and citation counts for ALL incomplete arXiv rows in `collection.sqlite` regardless
 * of publish date, while preventing duplicate retries within the same refresh session.
 */
export async function backfillMissingArxivKeywords(
	categories: readonly string[],
	transport?: {
		fetchText?: FetchTextFn;
		fetchJson?: FetchJsonFn;
		keywordLlmFetch?: typeof fetch;
		deferDoneStatus?: boolean;
		signal?: AbortSignal;
		onCategoryProgress?: (
			category: string,
			completed: number,
			total: number,
		) => void;
		onCategoryDone?: (category: string) => void;
		onCategoryStatus?: (
			category: string,
			status: "refreshing" | "done" | "error",
		) => void;
	},
): Promise<number> {
	throwIfAborted(transport?.signal);
	const { fetchTextFn, fetchJsonFn } = resolveTransportFetchers(transport);
	const cleanCats = Array.from(
		new Set(categories.map((c) => c.trim()).filter(Boolean)),
	);
	if (cleanCats.length === 0) return 0;

	const PAGE_LIMIT = 500;
	const SLICE_SIZE = 240;
	let totalPatched = 0;

	for (const cat of cleanCats) {
		throwIfAborted(transport?.signal);
		let offset = 0;
		let emittedRefreshing = false;
		let highestReportedRow = 0;

		const emitCatBackfillProgress = (
			completedRows: number,
			totalRows: number,
		) => {
			const safeTotal = Math.max(1, totalRows);
			const clamped = Math.max(
				highestReportedRow,
				Math.min(safeTotal, Math.round(completedRows)),
			);
			highestReportedRow = clamped;
			transport?.onCategoryProgress?.(cat, clamped, safeTotal);
		};

		try {
			while (offset < 50_000) {
				throwIfAborted(transport?.signal);
				const page = await listCollectionPapers({
					sourceType: "arxiv",
					category: cat,
					sort: "newest",
					limit: PAGE_LIMIT,
					offset,
				});
				throwIfAborted(transport?.signal);
				if (page.items.length === 0) break;

				const totalRows = Math.max(
					typeof page.total === "number" ? page.total : 0,
					offset + page.items.length,
				);
				const pageStartRow = offset;
				const pageEndRow = Math.min(totalRows, offset + page.items.length);

				const candidates = page.items.filter(
					(p) => Boolean(p.arxivId) && shouldAttemptArxivBackfill(p),
				);

				if (candidates.length === 0) {
					emitCatBackfillProgress(pageEndRow, totalRows);
				} else {
					if (!emittedRefreshing) {
						emittedRefreshing = true;
						transport?.onCategoryStatus?.(cat, "refreshing");
					}

					for (let i = 0; i < candidates.length; i += SLICE_SIZE) {
						throwIfAborted(transport?.signal);
						let slice = candidates.slice(i, i + SLICE_SIZE);
						const sliceStartRow =
							pageStartRow +
							((pageEndRow - pageStartRow) * i) / candidates.length;
						const sliceEndRow =
							pageStartRow +
							((pageEndRow - pageStartRow) * (i + slice.length)) /
								candidates.length;
						emitCatBackfillProgress(sliceStartRow, totalRows);

						// Recover missing/placeholder abstracts from arXiv Atom `id_list` before OpenAlex/LLM enrichment
						const missingAbsAids = Array.from(
							new Set(
								slice
									.filter((p) =>
										isPlaceholderAbstract(p.abstract, p.sourceLabel),
									)
									.map((p) => stripVersion(p.arxivId ?? ""))
									.filter(Boolean),
							),
						);
						if (missingAbsAids.length > 0) {
							const atomByAid = new Map<string, string>();
							const ID_CHUNK = 40;
							for (let k = 0; k < missingAbsAids.length; k += ID_CHUNK) {
								throwIfAborted(transport?.signal);
								const chunkAids = missingAbsAids.slice(k, k + ID_CHUNK);
								try {
									const idUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(chunkAids.join(","))}&max_results=${chunkAids.length}`;
									const xml = await fetchTextFn(
										idUrl,
										"application/atom+xml,text/xml,*/*",
									);
									const parsedAtom = parseArxivAtomXml(xml, null, {
										preferredCategories: cleanCats,
										defaultCategory: cat,
									});
									for (const entry of parsedAtom) {
										const aidKey = stripVersion(
											entry.arxivId ?? "",
										).toLowerCase();
										if (
											aidKey &&
											!isPlaceholderAbstract(entry.abstract, entry.sourceLabel)
										) {
											atomByAid.set(aidKey, entry.abstract);
										}
									}
								} catch (err) {
									if (
										transport?.signal?.aborted ||
										isBackgroundTaskCancelledError(err)
									) {
										throw err;
									}
									// Best-effort abstract recovery; OpenAlex fallback still runs below.
								}
								const atomFrac =
									(k + chunkAids.length) / Math.max(1, missingAbsAids.length);
								emitCatBackfillProgress(
									sliceStartRow +
										(sliceEndRow - sliceStartRow) * (0.15 * atomFrac),
									totalRows,
								);
							}
							if (atomByAid.size > 0) {
								slice = slice.map((p) => {
									const aidKey = stripVersion(p.arxivId ?? "").toLowerCase();
									const recovered = atomByAid.get(aidKey);
									return recovered &&
										isPlaceholderAbstract(p.abstract, p.sourceLabel)
										? { ...p, abstract: recovered }
										: p;
								});
							}
						}

						const enrichBaseFrac = missingAbsAids.length > 0 ? 0.15 : 0;
						const enrichedSlice = await enrichArxivItemsBatch(
							slice,
							fetchJsonFn,
							slice.length,
							{
								keywordLlmFetch: transport?.keywordLlmFetch,
								signal: transport?.signal,
								onProgress: (done, total) => {
									const ratio = total > 0 ? done / total : 1;
									const sliceFrac =
										enrichBaseFrac + (1 - enrichBaseFrac) * ratio;
									emitCatBackfillProgress(
										sliceStartRow + (sliceEndRow - sliceStartRow) * sliceFrac,
										totalRows,
									);
								},
							},
						);
						throwIfAborted(transport?.signal);
						recordArxivEnrichAttempt(enrichedSlice);

						const origById = new Map(
							candidates.slice(i, i + SLICE_SIZE).map((p) => [p.id, p]),
						);
						const patches: CollectionPaperPatchInput[] = [];
						for (const item of enrichedSlice) {
							const orig = origById.get(item.id);
							const gainedAbstract =
								isPlaceholderAbstract(orig?.abstract, orig?.sourceLabel) &&
								!isPlaceholderAbstract(item.abstract, item.sourceLabel);
							const gainedKeywords =
								normalizePaperKeywords(orig?.keywords).length === 0 &&
								normalizePaperKeywords(item.keywords).length > 0;
							const gainedCitations =
								(item.citationCount ?? 0) > (orig?.citationCount ?? 0);
							const gainedDoi = !orig?.doi && Boolean(item.doi);
							if (
								!gainedAbstract &&
								!gainedKeywords &&
								!gainedCitations &&
								!gainedDoi
							) {
								continue;
							}
							patches.push({
								id: item.id,
								...(gainedAbstract ? { abstract: item.abstract } : {}),
								doi: item.doi ?? null,
								citationCount: item.citationCount ?? 0,
								keywords: item.keywords ?? [],
							});
						}
						if (patches.length > 0) {
							await patchCollectionPapers(patches);
							totalPatched += patches.length;
						}
						emitCatBackfillProgress(sliceEndRow, totalRows);
					}
				}

				if (!page.hasMore) break;
				offset += page.items.length;
			}

			if (emittedRefreshing && !transport?.deferDoneStatus) {
				transport?.onCategoryStatus?.(cat, "done");
			}
			transport?.onCategoryDone?.(cat);
		} catch (err) {
			if (transport?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
				throw err;
			}
			if (emittedRefreshing) {
				transport?.onCategoryStatus?.(cat, "error");
			}
			throw err;
		}
	}

	return totalPatched;
}

export type ArxivRefreshProgress = {
	category: string;
	completed: number;
	total: number;
	subCompleted?: number;
	subTotal?: number;
	overallProgress: number;
};

export type VenueRefreshProgress = {
	venueId: string;
	venueName: string;
	completed: number;
	total: number;
	subCompleted?: number;
	subTotal?: number;
	overallProgress: number;
};

/**
 * Refresh ONLY `arXiv` categories (either all configured categories or a single
 * sub-category such as `cs.SE`), persisting incremental deltas and backfilling any
 * incomplete arXiv metadata directly in `collection.sqlite`.
 */
export async function refreshArxivCollection(options?: {
	categories?: string[];
	replaceCategories?: boolean;
	incremental?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: ArxivRefreshProgress) => void;
	onCategoryStatus?: (
		category: string,
		status: "refreshing" | "done" | "error",
	) => void;
	transport?: {
		fetchText?: FetchTextFn;
		fetchJson?: FetchJsonFn;
		keywordLlmFetch?: typeof fetch;
	};
}): Promise<CollectionStateSummary> {
	throwIfAborted(options?.signal);
	startNewArxivRefreshSession();
	const existingSummary = await fetchCollectionStateSummary();
	throwIfAborted(options?.signal);
	const targetCategories = options?.categories ?? existingSummary.categories;
	const cleanTargetCats = Array.from(
		new Set(targetCategories.map((c) => c.trim()).filter(Boolean)),
	);
	const savedCategories = options?.replaceCategories
		? targetCategories
		: existingSummary.categories;
	const incremental = options?.incremental !== false;

	if (options?.replaceCategories) {
		await updateCollectionConfig({ categories: savedCategories });
		throwIfAborted(options?.signal);
	}

	const totalCats = cleanTargetCats.length;
	const perCatFraction = new Map<string, number>();
	const completedCatSet = new Set<string>();
	const needsBackfill = new Set<string>();
	for (const cat of cleanTargetCats) {
		perCatFraction.set(cat, 0);
		if (!existingSummary.arxivWatermarks[cat]?.historyComplete) {
			needsBackfill.add(cat);
		}
	}
	let maxReportedProgress = 0;

	const emitArxivProgress = (
		activeCat: string,
		subCompleted?: number,
		subTotal?: number,
	) => {
		if (!options?.onProgress) return;
		let sum = 0;
		for (const cat of cleanTargetCats) {
			sum += perCatFraction.get(cat) ?? 0;
		}
		const rawPct = totalCats > 0 ? Math.round((sum / totalCats) * 100) : 100;
		const ceiling = completedCatSet.size < totalCats ? 99 : 100;
		maxReportedProgress = Math.max(
			maxReportedProgress,
			Math.min(ceiling, rawPct),
		);
		options.onProgress({
			category: activeCat,
			completed: completedCatSet.size,
			total: totalCats,
			subCompleted,
			subTotal,
			overallProgress: maxReportedProgress,
		});
	};

	if (totalCats === 0) {
		emitArxivProgress("");
	} else {
		emitArxivProgress(cleanTargetCats[0] ?? "");
	}

	const erroredCats = new Set<string>();
	const holdDoneStatus = options?.onCategoryStatus
		? (cat: string, status: "refreshing" | "done" | "error") => {
				if (status === "error") {
					erroredCats.add(cat);
					options.onCategoryStatus?.(cat, "error");
					return;
				}
				if (status === "refreshing") {
					options.onCategoryStatus?.(cat, "refreshing");
				}
			}
		: undefined;

	const arxivSync = await syncArxivCategoriesIncremental(
		targetCategories,
		[],
		existingSummary.arxivWatermarks,
		incremental,
		{
			...options?.transport,
			signal: options?.signal,
			categoryCounts: existingSummary.categoryCounts,
			deferIncompleteDoneStatus: true,
			onPhaseProgress: (cat, fraction, subCompleted, subTotal) => {
				const syncWeight = needsBackfill.has(cat) ? 0.15 : 0.6;
				const clampedFrac = Math.max(0, Math.min(1, fraction));
				perCatFraction.set(
					cat,
					Math.max(perCatFraction.get(cat) ?? 0, syncWeight * clampedFrac),
				);
				emitArxivProgress(cat, subCompleted, subTotal);
			},
			onPhaseDone: (cat) => {
				const syncWeight = needsBackfill.has(cat) ? 0.15 : 0.6;
				perCatFraction.set(
					cat,
					Math.max(perCatFraction.get(cat) ?? 0, syncWeight),
				);
				emitArxivProgress(cat);
			},
			onCategoryStatus: holdDoneStatus,
		},
	);
	throwIfAborted(options?.signal);

	const latestSnap = await fetchCollectionStateSummary();
	throwIfAborted(options?.signal);
	const mergedWatermarks: Record<string, ArxivCategoryWatermark> = {
		...latestSnap.arxivWatermarks,
		...arxivSync.nextWatermarks,
	};
	const nowIso = new Date().toISOString();
	const latestArxiv = arxivSync.latest ?? latestSnap.latestArxiv;

	let nextSummary =
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
	throwIfAborted(options?.signal);

	const incompleteCats = cleanTargetCats.filter(
		(c) => !nextSummary.arxivWatermarks[c]?.historyComplete,
	);
	for (const cat of incompleteCats) {
		needsBackfill.add(cat);
	}
	for (const cat of arxivSync.coldStartCategories) {
		needsBackfill.add(cat);
	}

	let mutatedAfterInitialSync = false;
	if (incompleteCats.length > 0 || arxivSync.coldStartCategories.length > 0) {
		const catsToPreload = Array.from(
			new Set([...arxivSync.coldStartCategories, ...incompleteCats]),
		);
		await preloadAll2026ArxivInBackground(catsToPreload, 120, 1000, {
			...options?.transport,
			signal: options?.signal,
			onCategoryProgress: (cat, syncedCount, remoteTotal, pagesDone) => {
				const frac =
					remoteTotal && remoteTotal > 0
						? Math.min(1, syncedCount / remoteTotal)
						: Math.min(0.9, (pagesDone ?? 0) * 0.08);
				perCatFraction.set(
					cat,
					Math.max(perCatFraction.get(cat) ?? 0, 0.15 + 0.7 * frac),
				);
				emitArxivProgress(
					cat,
					remoteTotal && remoteTotal > 0 ? syncedCount : undefined,
					remoteTotal && remoteTotal > 0 ? remoteTotal : undefined,
				);
			},
			onCategoryStatus: holdDoneStatus,
		});
		mutatedAfterInitialSync = true;
	}
	throwIfAborted(options?.signal);

	const patchedCount = await backfillMissingArxivKeywords(cleanTargetCats, {
		...options?.transport,
		signal: options?.signal,
		deferDoneStatus: true,
		onCategoryProgress: (cat, completed, total) => {
			const base = needsBackfill.has(cat) ? 0.85 : 0.6;
			const ratio = total > 0 ? Math.min(1, completed / total) : 0;
			perCatFraction.set(
				cat,
				Math.max(perCatFraction.get(cat) ?? 0, base + (1 - base) * ratio),
			);
			emitArxivProgress(cat, completed, total);
		},
		onCategoryDone: (cat) => {
			completedCatSet.add(cat);
			perCatFraction.set(cat, 1);
			emitArxivProgress(cat);
		},
		onCategoryStatus: holdDoneStatus,
	});
	if (patchedCount > 0) {
		mutatedAfterInitialSync = true;
	}

	if (options?.onCategoryStatus) {
		for (const cat of cleanTargetCats) {
			if (!erroredCats.has(cat)) {
				options.onCategoryStatus(cat, "done");
			}
		}
	}

	for (const cat of cleanTargetCats) {
		completedCatSet.add(cat);
		perCatFraction.set(cat, 1);
	}
	emitArxivProgress(cleanTargetCats[cleanTargetCats.length - 1] ?? "");

	if (mutatedAfterInitialSync) {
		nextSummary = await fetchCollectionStateSummary();
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
	signal?: AbortSignal;
	onProgress?: (progress: VenueRefreshProgress) => void;
	onVenueProgress?: (venue: VenueConfig, index: number, total: number) => void;
	onVenueStatus?: (
		venue: VenueConfig,
		status: "refreshing" | "done" | "error",
		index: number,
		total: number,
	) => void;
}): Promise<CollectionStateSummary> {
	throwIfAborted(options?.signal);
	let current = await fetchCollectionStateSummary();
	throwIfAborted(options?.signal);
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
			throwIfAborted(options?.signal);
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
		options?.onProgress?.({
			venueId: "",
			venueName: "",
			completed: 0,
			total: 0,
			overallProgress: 100,
		});
		return current;
	}

	const CONCURRENCY = 2;
	let cursor = 0;
	let completedCount = 0;
	let maxReportedProgress = 0;
	const activeVenues = new Map<
		string,
		{ venue: VenueConfig; subCompleted?: number; subTotal?: number }
	>();

	const emitVenueProgress = (preferred: VenueConfig) => {
		if (!options?.onProgress) return;
		const display = activeVenues.get(preferred.id) ??
			activeVenues.values().next().value ?? {
				venue: preferred,
			};
		let activeFracSum = 0;
		for (const entry of activeVenues.values()) {
			if (
				entry.subTotal != null &&
				entry.subTotal > 0 &&
				entry.subCompleted != null
			) {
				activeFracSum += Math.min(0.95, entry.subCompleted / entry.subTotal);
			} else {
				activeFracSum += 0.05;
			}
		}
		const rawPct = Math.round(
			((completedCount + activeFracSum) / targets.length) * 100,
		);
		const ceiling = completedCount < targets.length ? 99 : 100;
		maxReportedProgress = Math.max(
			maxReportedProgress,
			Math.min(ceiling, rawPct),
		);
		options.onProgress({
			venueId: display.venue.id,
			venueName: display.venue.name,
			completed: completedCount,
			total: targets.length,
			subCompleted: display.subCompleted,
			subTotal: display.subTotal,
			overallProgress: maxReportedProgress,
		});
	};

	const worker = async () => {
		while (cursor < targets.length) {
			throwIfAborted(options?.signal);
			const idx = cursor++;
			const target = targets[idx];
			if (!target) continue;
			const liveVenue =
				collectionStore.getState().venues.find((v) => v.id === target.id) ??
				target;
			activeVenues.set(liveVenue.id, { venue: liveVenue });
			options?.onVenueProgress?.(liveVenue, completedCount, targets.length);
			options?.onVenueStatus?.(
				liveVenue,
				"refreshing",
				idx + 1,
				targets.length,
			);
			emitVenueProgress(liveVenue);
			try {
				await ensureVenueLoaded(liveVenue.id, {
					signal: options?.signal,
					onProgress: (p) => {
						const curEntry = activeVenues.get(liveVenue.id);
						if (!curEntry) return;
						curEntry.subCompleted = p.completed;
						curEntry.subTotal = p.total;
						emitVenueProgress(liveVenue);
					},
				});
				activeVenues.delete(liveVenue.id);
				completedCount += 1;
				options?.onVenueStatus?.(liveVenue, "done", idx + 1, targets.length);
				emitVenueProgress(liveVenue);
			} catch (err) {
				activeVenues.delete(liveVenue.id);
				if (options?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
					throw err;
				}
				options?.onVenueStatus?.(liveVenue, "error", idx + 1, targets.length);
				if (targets.length === 1) {
					throw err;
				}
				completedCount += 1;
				emitVenueProgress(liveVenue);
			}
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () =>
			worker(),
		),
	);
	throwIfAborted(options?.signal);

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
	signal?: AbortSignal;
	onArxivProgress?: (progress: ArxivRefreshProgress) => void;
	onCategoryStatus?: (
		category: string,
		status: "refreshing" | "done" | "error",
	) => void;
	onVenueProgress?: (venue: VenueConfig, index: number, total: number) => void;
	onVenueTaskProgress?: (progress: VenueRefreshProgress) => void;
	onVenueStatus?: (
		venue: VenueConfig,
		status: "refreshing" | "done" | "error",
		index: number,
		total: number,
	) => void;
}): Promise<CollectionStateSummary> {
	await refreshArxivCollection({
		incremental: options?.incrementalArxiv !== false,
		signal: options?.signal,
		onProgress: options?.onArxivProgress,
		onCategoryStatus: options?.onCategoryStatus,
	});
	return refreshVenueCollection({
		skipLoaded: options?.skipLoadedVenues ?? false,
		signal: options?.signal,
		onProgress: options?.onVenueTaskProgress,
		onVenueProgress: options?.onVenueProgress,
		onVenueStatus: options?.onVenueStatus,
	});
}
