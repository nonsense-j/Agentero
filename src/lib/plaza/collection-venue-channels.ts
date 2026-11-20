/**
 * Plaza — Multi-channel, multi-page 2026 Venue main-track fetcher.
 *
 * Unifies authoritative official track rosters (`conf.researchr.org` / official program pages),
 * curated main-track proceedings (`papers.cool`), and scholarly metadata indexes
 * (`OpenAlex`, `Crossref`, `IEEE CSDL`, `DataCite LIPIcs`, `Semantic Scholar`, `arXiv`)
 * without any DBLP dependency.
 */

import { isBackgroundTaskCancelledError } from "@/lib/core/background-tasks";
import { extractKeywordsWithKeywordLlmBatch } from "@/lib/keyword-llm";
import { hasCachedOpenAlexApiKey } from "@/lib/openalex";
import {
	backfillSpringerAbstracts,
	buildVenuePaperId,
	type CollectionPaperItem,
	cleanDoi,
	enrichArxivItemsBatch,
	enrichVenueItemsBatch,
	type FetchJsonFn,
	type FetchTextFn,
	fetchVenueStructuredPapers,
	hasDistinctPublisherDoi,
	hasPriorConferenceYearSpillover,
	inferVenueKind,
	isArtifactOrDatasetDoi,
	isExcludedByDoiPrefix,
	isFrontmatterTitle,
	isNonResearchJournalItem,
	isPaperMetadataComplete,
	isPlaceholderAbstract,
	isPositionPaperTitle,
	isWorkshopOrCompanionVenue,
	mergeKeywordMetadata,
	normalizeOpenAlexId,
	normalizePaperKeywords,
	normalizeRawRefs,
	pickEarliestPublishedAt,
	raceWithAbort,
	type S2BulkPaper,
	scoreCameraReadyCandidateMatch,
	semanticScholarWorkToVenueItem,
	sleepWithAbort,
	throwIfAborted,
	VENUE_SPEC_BY_ID,
	type VenueConfig,
	type VenueSpec,
} from "@/lib/plaza/collection-enrichment";

const IS_TEST_ENV =
	typeof import.meta !== "undefined" && import.meta.env?.MODE === "test";

const HOST_MIN_INTERVAL_MS: Record<string, number> = {
	"api.openalex.org": 125,
	"api.crossref.org": 120,
	"api.datacite.org": 100,
	"api.semanticscholar.org": 1400,
	"export.arxiv.org": 3250,
	"arxiv.org": 150,
	"papers.cool": 300,
	"conf.researchr.org": 250,
	"link.springer.com": 80,
	"www.computer.org": 120,
	"neurips.cc": 150,
	"iclr.cc": 150,
	"icml.cc": 150,
	"aclanthology.org": 200,
	"2026.aclweb.org": 200,
	"www.usenix.org": 120,
	"sp2026.ieee-security.org": 150,
	"www.ndss-symposium.org": 150,
	"www.sigsac.org": 150,
};

const SERIALIZED_HOSTS = new Set([
	"papers.cool",
	"conf.researchr.org",
	"api.crossref.org",
	"export.arxiv.org",
	"arxiv.org",
	"api.semanticscholar.org",
]);

const hostNextSlotMs = new Map<string, number>();
const hostInFlightChain = new Map<string, Promise<void>>();
const activeSyncHostGateDepth = new Map<string, number>();
let openAlexListCooldownUntil = 0;

type PoliteTextMeta = {
	raw: FetchTextFn;
	signal?: AbortSignal;
};

type PoliteJsonMeta = {
	raw: FetchJsonFn;
	signal?: AbortSignal;
};

const politeFetchTextMeta = new WeakMap<FetchTextFn, PoliteTextMeta>();
const politeFetchJsonMeta = new WeakMap<FetchJsonFn, PoliteJsonMeta>();

function combineAbortSignals(
	first?: AbortSignal,
	second?: AbortSignal,
): AbortSignal | undefined {
	if (!first) return second;
	if (!second || first === second) return first;
	if (typeof AbortSignal?.any === "function") {
		return AbortSignal.any([first, second]);
	}
	if (first.aborted) return first;
	if (second.aborted) return second;
	const controller = new AbortController();
	const onAbort = () => {
		first.removeEventListener("abort", onAbort);
		second.removeEventListener("abort", onAbort);
		controller.abort();
	};
	first.addEventListener("abort", onAbort, { once: true });
	second.addEventListener("abort", onAbort, { once: true });
	return controller.signal;
}

function runWithActiveHostGate<T>(
	host: string,
	task: () => Promise<T>,
): Promise<T> {
	if (!host) return task();
	const prevDepth = activeSyncHostGateDepth.get(host) ?? 0;
	activeSyncHostGateDepth.set(host, prevDepth + 1);
	try {
		return task();
	} finally {
		if (prevDepth === 0) {
			activeSyncHostGateDepth.delete(host);
		} else {
			activeSyncHostGateDepth.set(host, prevDepth);
		}
	}
}

function extractHostname(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * OpenAlex daily credit limits (`429`) apply to list/search queries (`/works?...`),
 * whereas `/works/doi:...` singletons cost 0 credits and must remain available.
 */
function isOpenAlexListUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.hostname.toLowerCase() === "api.openalex.org" &&
			parsed.pathname.replace(/\/+$/, "") === "/works"
		);
	} catch {
		return false;
	}
}

async function acquireHostSlot(
	host: string,
	url: string,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	if (IS_TEST_ENV || !host) return;
	const interval =
		host === "api.openalex.org"
			? !isOpenAlexListUrl(url)
				? hasCachedOpenAlexApiKey()
					? 45
					: 120
				: hasCachedOpenAlexApiKey()
					? 105
					: HOST_MIN_INTERVAL_MS[host]
			: HOST_MIN_INTERVAL_MS[host];
	if (!interval) return;

	const now = Date.now();
	const scheduled = Math.max(now, hostNextSlotMs.get(host) ?? 0);
	hostNextSlotMs.set(host, scheduled + interval);
	const waitMs = scheduled - now;
	if (waitMs > 0) {
		await sleepWithAbort(waitMs, signal);
	}
}

async function withHostGate<T>(
	url: string,
	task: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	throwIfAborted(signal);
	const host = extractHostname(url);
	if (
		!IS_TEST_ENV &&
		isOpenAlexListUrl(url) &&
		Date.now() < openAlexListCooldownUntil
	) {
		throw new Error(`OpenAlex list rate-limit cooldown active for ${url}`);
	}
	if (host && (activeSyncHostGateDepth.get(host) ?? 0) > 0) {
		return await raceWithAbort(task(), signal);
	}
	if (!SERIALIZED_HOSTS.has(host)) {
		await acquireHostSlot(host, url, signal);
		const taskPromise = runWithActiveHostGate(host, task);
		return await raceWithAbort(taskPromise, signal);
	}

	const prev = hostInFlightChain.get(host) ?? Promise.resolve();
	let release: () => void = () => {};
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	hostInFlightChain.set(host, current);

	let acquired = false;
	try {
		await raceWithAbort(prev, signal);
		acquired = true;
		await acquireHostSlot(host, url, signal);
		const taskPromise = runWithActiveHostGate(host, task);
		return await raceWithAbort(taskPromise, signal);
	} finally {
		if (acquired) {
			if (hostInFlightChain.get(host) === current) {
				hostInFlightChain.delete(host);
			}
			release();
		} else {
			// Wait for `prev` before releasing `current` so later waiters remain serialized behind `prev`.
			void prev.finally(() => {
				if (hostInFlightChain.get(host) === current) {
					hostInFlightChain.delete(host);
				}
				release();
			});
		}
	}
}

function isTransientNetworkError(msg: string): boolean {
	return /\b(?:429|502|503|504)\b|timeout|timed\s*out|fetch\s+failed|econnreset/i.test(
		msg,
	);
}

export function createPoliteFetchText(
	rawFetchText: FetchTextFn,
	signal?: AbortSignal,
): FetchTextFn {
	const existing = politeFetchTextMeta.get(rawFetchText);
	if (existing) {
		if (!signal || signal === existing.signal) {
			return rawFetchText;
		}
		return createPoliteFetchText(
			existing.raw,
			combineAbortSignals(existing.signal, signal),
		);
	}

	const wrapped: FetchTextFn = async (
		url: string,
		accept?: string,
	): Promise<string> => {
		throwIfAborted(signal);
		const host = extractHostname(url);
		if (host && (activeSyncHostGateDepth.get(host) ?? 0) > 0) {
			return await raceWithAbort(rawFetchText(url, accept), signal);
		}
		try {
			return await withHostGate(url, () => rawFetchText(url, accept), signal);
		} catch (err) {
			if (signal?.aborted || isBackgroundTaskCancelledError(err)) {
				throw err;
			}
			const msg = err instanceof Error ? err.message : String(err);
			if (!IS_TEST_ENV && isTransientNetworkError(msg)) {
				await sleepWithAbort(1500, signal);
				return await withHostGate(url, () => rawFetchText(url, accept), signal);
			}
			throw err;
		}
	};

	politeFetchTextMeta.set(wrapped, { raw: rawFetchText, signal });
	return wrapped;
}

export function createPoliteFetchJson(
	rawFetchJson: FetchJsonFn,
	signal?: AbortSignal,
): FetchJsonFn {
	const existing = politeFetchJsonMeta.get(rawFetchJson);
	if (existing) {
		if (!signal || signal === existing.signal) {
			return rawFetchJson;
		}
		return createPoliteFetchJson(
			existing.raw,
			combineAbortSignals(existing.signal, signal),
		);
	}

	const wrapped: FetchJsonFn = async <T = unknown>(url: string): Promise<T> => {
		throwIfAborted(signal);
		const host = extractHostname(url);
		if (host && (activeSyncHostGateDepth.get(host) ?? 0) > 0) {
			return await raceWithAbort(rawFetchJson<T>(url), signal);
		}
		try {
			return await withHostGate(url, () => rawFetchJson<T>(url), signal);
		} catch (err) {
			if (signal?.aborted || isBackgroundTaskCancelledError(err)) {
				throw err;
			}
			const msg = err instanceof Error ? err.message : String(err);
			if (!IS_TEST_ENV && isOpenAlexListUrl(url) && /\b429\b/.test(msg)) {
				openAlexListCooldownUntil = Date.now() + 5 * 60_000;
				throw err;
			}
			if (!IS_TEST_ENV && isTransientNetworkError(msg)) {
				await sleepWithAbort(1500, signal);
				return await withHostGate(url, () => rawFetchJson<T>(url), signal);
			}
			throw err;
		}
	};

	politeFetchJsonMeta.set(wrapped, { raw: rawFetchJson, signal });
	return wrapped;
}

function decodeHtmlEntities(raw: string): string {
	return raw
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&#039;|&apos;/gi, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
			const cp = Number.parseInt(hex, 16);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
		})
		.replace(/&#(\d+);/g, (_, dec) => {
			const cp = Number.parseInt(dec, 10);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
		});
}

function cleanXmlText(raw: string): string {
	return decodeHtmlEntities(raw).replace(/\s+/g, " ").trim();
}

function stripArxivVersion(id: string): string {
	return id.replace(/v\d+$/i, "").trim();
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const REJECT_VENUE_COMMENT_COMMON_RE =
	/\b(workshop|workshops|ws\b|submitted\s+to|under\s+review|in\s+submission|preprint\s+submitted|rejected|withdrawn|doctoral\s+symposium|doctoral\s+consortium|student\s+abstract|student\s+research|challenge|competition|tutorial|extended\s+abstract|demo\s+track|demonstrations?\s+track|tool\s+demos?|findings\s+of|position\s+(?:paper\s+)?track|industry\s+track|seip\b|nier\b|seet\b|seis\b|replications?\s+(?:and|&)\s+negative|registered\s+reports?|blog\s*posts?|tmlr|jmlr|annals\s+of\s+statistics|bridging[- ]the[- ]future)\b/i;

const REJECT_VENUE_DATASETS_RE =
	/\b(?:datasets?\s+(?:and|&)\s+benchmarks?|evaluations?\s+(?:and|&)\s+datasets?(?:\s+track)?)\b/i;

/**
 * Verify that an arXiv `<arxiv:comment>` or `<arxiv:journal_ref>` string genuinely
 * declares acceptance at one of the target main-track venue aliases (rejecting
 * workshops such as `"ICML 2026 Workshop"` or `"EIML@ICML 2026"` and unaccepted submissions).
 */
export function isConfirmedVenueAcceptance(
	commentOrJournalRef: string,
	aliases: readonly string[],
	options?: { allowDatasetsBenchmarks?: boolean },
): boolean {
	const text = commentOrJournalRef.replace(/\s+/g, " ").trim();
	if (!text || aliases.length === 0) return false;
	if (REJECT_VENUE_COMMENT_COMMON_RE.test(text)) return false;
	if (
		!options?.allowDatasetsBenchmarks &&
		REJECT_VENUE_DATASETS_RE.test(text)
	) {
		return false;
	}

	for (const alias of aliases) {
		const patternBody = escapeRegex(alias.trim()).replace(/\\ /g, "\\s+");
		if (!patternBody) continue;
		// Disallow `@` or word characters immediately before the venue name so `EIML@ICML 2026` is rejected.
		const re = new RegExp(`(?:^|[^@\\w-])(${patternBody})(?:$|[^\\w])`, "i");
		if (re.test(text)) {
			return true;
		}
	}
	return false;
}

/**
 * Parse arXiv Atom XML entries queried via `co:` / `jr:` for a specific 2026 venue,
 * strictly retaining confirmed main-conference / journal accepted papers.
 */
export function parseAcceptedVenueArxivXml(
	xmlText: string,
	venue: VenueConfig,
	spec: VenueSpec | undefined,
	targetYear: number,
): CollectionPaperItem[] {
	const aliases = spec?.arxivVenueAliases ?? [venue.name];
	const venueKind = spec?.kind ?? inferVenueKind(venue);
	const venueDomain = spec?.domain ?? venue.domain;
	const ccfRank = spec?.ccfRank ?? venue.ccfRank;
	const out: CollectionPaperItem[] = [];

	const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
	for (const match of xmlText.matchAll(entryRegex)) {
		const block = match[1] ?? "";
		const comment = cleanXmlText(
			/<arxiv:comment[^>]*>([\s\S]*?)<\/arxiv:comment>/i.exec(block)?.[1] ?? "",
		);
		const journalRef = cleanXmlText(
			/<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/i.exec(
				block,
			)?.[1] ?? "",
		);
		const combinedMeta = `${comment} ${journalRef}`.trim();
		if (
			!isConfirmedVenueAcceptance(combinedMeta, aliases, {
				allowDatasetsBenchmarks: Boolean(spec?.includeDatasetsBenchmarks),
			})
		) {
			continue;
		}

		const rawId = /<id>([\s\S]*?)<\/id>/i.exec(block)?.[1]?.trim() ?? "";
		const idMatch = /arxiv\.org\/abs\/([^\s?#<]+)/i.exec(rawId);
		const arxivId = stripArxivVersion(idMatch ? idMatch[1] : rawId);
		if (!arxivId) continue;

		const title = cleanXmlText(
			/<title>([\s\S]*?)<\/title>/i.exec(block)?.[1] ?? "",
		);
		if (!title || isFrontmatterTitle(title)) continue;
		if (spec?.excludePositionPapers && isPositionPaperTitle(title)) continue;
		if (venueKind === "journal" && isNonResearchJournalItem(title, undefined)) {
			continue;
		}

		const abstract = cleanXmlText(
			/<summary>([\s\S]*?)<\/summary>/i.exec(block)?.[1] ?? "",
		);
		if (isPlaceholderAbstract(abstract, venue.name)) continue;

		const authors: string[] = [];
		for (const am of block.matchAll(
			/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi,
		)) {
			const name = cleanXmlText(am[1] ?? "");
			if (name) authors.push(name);
		}
		if (authors.length === 0) continue;

		const updated =
			/<updated>([\s\S]*?)<\/updated>/i.exec(block)?.[1]?.trim() ?? "";
		const published =
			/<published>([\s\S]*?)<\/published>/i.exec(block)?.[1]?.trim() ?? "";
		const publishedAt = updated || published || `${targetYear}-01-01T00:00:00Z`;

		const explicitDoi = cleanDoi(
			/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/i.exec(block)?.[1],
		);
		if (
			isArtifactOrDatasetDoi(explicitDoi) ||
			isExcludedByDoiPrefix(explicitDoi, spec?.excludeDoiPrefixes)
		) {
			continue;
		}
		if (hasPriorConferenceYearSpillover(targetYear, explicitDoi, journalRef)) {
			continue;
		}
		const doi = explicitDoi || `10.48550/arxiv.${arxivId}`;

		const arxivCats: string[] = [];
		for (const cm of block.matchAll(
			/<category[^>]*\bterm=["']([^"']+)["'][^>]*>/gi,
		)) {
			const term = (cm[1] ?? "").trim();
			if (term && !arxivCats.includes(term)) arxivCats.push(term);
		}

		const categories = [
			venue.name,
			...(venueDomain ? [venueDomain] : []),
			...(ccfRank ? [ccfRank] : []),
			...arxivCats.slice(0, 2),
		];

		out.push({
			id: buildVenuePaperId(venue.id, explicitDoi, arxivId, title),
			title,
			authors,
			abstract,
			publishedAt,
			year: targetYear,
			sourceType: "venue",
			sourceLabel: venue.name,
			categories,
			url: explicitDoi
				? `https://doi.org/${explicitDoi}`
				: `https://arxiv.org/abs/${arxivId}`,
			pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`,
			arxivId,
			doi,
			venueId: venue.id,
			venueKind,
			venueDomain,
			ccfRank,
			venueFull: journalRef || venue.name,
			citationCount: 0,
			keywords: [],
		});
	}

	return out;
}

function buildArxivVenueSearchQuery(aliases: readonly string[]): string {
	const clauses: string[] = [];
	for (const alias of aliases) {
		const encoded = encodeURIComponent(`"${alias.trim()}"`);
		clauses.push(`co:${encoded}`, `jr:${encoded}`);
	}
	return clauses.length === 1 ? clauses[0] : `(${clauses.join("+OR+")})`;
}

/**
 * Multi-page arXiv accepted-venue fetcher (`co:` / `jr:`), sorted by `lastUpdatedDate`
 * descending so newly-accepted camera-ready updates appear on page 0 and incremental
 * `sinceDate` scans can terminate early.
 */
export async function fetchArxivAcceptedForVenue(
	venue: VenueConfig,
	year: number,
	fetchText: FetchTextFn,
	options?: {
		sinceDate?: string | null;
		maxPages?: number;
	},
): Promise<{
	items: CollectionPaperItem[];
	totalResults: number;
	latestUpdatedAt: string | null;
}> {
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const aliases = spec?.arxivVenueAliases;
	if (!aliases || aliases.length === 0) {
		return { items: [], totalResults: 0, latestUpdatedAt: null };
	}

	const queryExpr = buildArxivVenueSearchQuery(aliases);
	const perPage = 200;
	let effectiveMaxPages = options?.maxPages ?? 4;
	const sinceTs = options?.sinceDate
		? Date.parse(options.sinceDate)
		: Number.NaN;
	const out: CollectionPaperItem[] = [];
	let totalResults = 0;
	let latestUpdatedAt: string | null = null;

	for (let page = 0; page < effectiveMaxPages; page++) {
		const start = page * perPage;
		const url = `https://export.arxiv.org/api/query?search_query=${queryExpr}&sortBy=lastUpdatedDate&sortOrder=descending&start=${start}&max_results=${perPage}`;
		try {
			const xml = await fetchText(url, "application/atom+xml,text/xml,*/*");
			if (page === 0) {
				const totalMatch =
					/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/i.exec(
						xml,
					);
				if (totalMatch?.[1]) {
					totalResults = Number(totalMatch[1]);
					if (totalResults > 0) {
						effectiveMaxPages = Math.min(
							effectiveMaxPages,
							Math.ceil(totalResults / perPage),
						);
					}
				}
				const firstUpdated =
					/<entry>[\s\S]*?<updated>([\s\S]*?)<\/updated>/i
						.exec(xml)?.[1]
						?.trim() ?? null;
				latestUpdatedAt = firstUpdated;
			}

			const rawEntryCount = (xml.match(/<entry>/gi) ?? []).length;
			if (rawEntryCount === 0) break;

			const parsed = parseAcceptedVenueArxivXml(xml, venue, spec, year);
			for (const item of parsed) {
				if (!Number.isNaN(sinceTs)) {
					const itemTs = Date.parse(item.publishedAt);
					if (!Number.isNaN(itemTs) && itemTs < sinceTs) {
						continue;
					}
				}
				out.push(item);
			}

			// Stop early on incremental runs once the page tail is older than `sinceDate`
			if (!Number.isNaN(sinceTs)) {
				const allUpdated = Array.from(
					xml.matchAll(/<entry>[\s\S]*?<updated>([\s\S]*?)<\/updated>/gi),
				).map((m) => (m[1] ?? "").trim());
				const tailUpdated = allUpdated[allUpdated.length - 1];
				if (tailUpdated) {
					const tailTs = Date.parse(tailUpdated);
					if (!Number.isNaN(tailTs) && tailTs < sinceTs) {
						break;
					}
				}
			}

			if (rawEntryCount < perPage) break;
		} catch {
			break;
		}
	}

	return { items: out, totalResults, latestUpdatedAt };
}

export { semanticScholarWorkToVenueItem };

/**
 * Semantic Scholar Graph Bulk Search fetcher (`/graph/v1/paper/search/bulk`) with
 * `token` cursor pagination (up to 1,000 papers per page) and optional `sinceDate` filter.
 */
export async function fetchSemanticScholarVenuePapers(
	venue: VenueConfig,
	year: number,
	fetchJson: FetchJsonFn,
	options?: {
		sinceDate?: string | null;
		maxPages?: number;
	},
): Promise<{
	items: CollectionPaperItem[];
	totalResults: number;
}> {
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const venueNames = spec?.s2VenueNames;
	if (!venueNames || venueNames.length === 0) {
		return { items: [], totalResults: 0 };
	}

	const maxPages = options?.maxPages ?? 5;
	const sinceDate = options?.sinceDate?.slice(0, 10) || null;
	const out: CollectionPaperItem[] = [];
	let totalResults = 0;

	const primaryVenueParam = venueNames[0];
	if (!primaryVenueParam) return { items: [], totalResults: 0 };

	let token: string | null = null;
	for (let page = 0; page < maxPages; page++) {
		const dateQuery = sinceDate
			? `&publicationDateOrYear=${encodeURIComponent(`${sinceDate}:`)}`
			: `&year=${year}`;
		const tokenQuery: string = token
			? `&token=${encodeURIComponent(token)}`
			: "";
		const fields =
			"title,abstract,authors,year,publicationDate,publicationTypes,externalIds,venue,url,openAccessPdf";
		const s2Url: string = `https://api.semanticscholar.org/graph/v1/paper/search/bulk?venue=${encodeURIComponent(primaryVenueParam)}${dateQuery}&fields=${fields}${tokenQuery}`;

		try {
			const res = await fetchJson<{
				total?: number;
				token?: string | null;
				data?: S2BulkPaper[];
			}>(s2Url);
			if (page === 0 && typeof res.total === "number") {
				totalResults = res.total;
			}
			const rows = res.data ?? [];
			if (rows.length === 0) break;

			for (const row of rows) {
				const item = semanticScholarWorkToVenueItem(row, venue, spec, year);
				if (item) {
					out.push(item);
				}
			}

			if (!res.token || res.token === token) break;
			token = res.token;
		} catch {
			break;
		}
	}

	return { items: out, totalResults };
}

function stripParentheticalAffiliations(raw: string): string {
	let cur = raw;
	for (let pass = 0; pass < 3; pass++) {
		const next = cur.replace(/\s*\([^()]*\)/g, "");
		if (next === cur) break;
		cur = next;
	}
	return cur;
}

function extractCoolPapersPanelGroup(chunk: string): string {
	const subjectsBlock =
		/<p\s+(?:id="subjects-[^"]+"[^>]*|[^>]*\bclass="[^"]*\bsubjects\b[^"]*"[^>]*)>([\s\S]*?)<\/p>/i.exec(
			chunk,
		)?.[1] ?? "";
	if (!subjectsBlock) return "";
	const groupHrefMatch = /[?&]group=([^"&'<>]+)/i.exec(subjectsBlock);
	if (groupHrefMatch?.[1]) {
		try {
			return decodeURIComponent(groupHrefMatch[1].replace(/\+/g, " "))
				.replace(/\s+/g, " ")
				.trim();
		} catch {
			return groupHrefMatch[1].replace(/\+/g, " ").trim();
		}
	}
	const plain = decodeHtmlEntities(subjectsBlock.replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
	const dashIdx = plain.indexOf(" - ");
	return dashIdx >= 0 ? plain.slice(dashIdx + 3).trim() : "";
}

/**
 * Parse a `papers.cool/venue/{slug}` list page (`<div id="..." class="panel paper">`).
 * Carries complete abstracts, authors, external publisher links, and direct PDF URLs for
 * OpenReview (`ICML`, `ICLR`, `NeurIPS`), `ACL`, `AAAI`, `USENIX Security`, and `NDSS`,
 * while strictly filtering out non-main tracks (`Findings`, `Position`, `Student Abstract`, etc.).
 */
export function parseCoolPapersVenueHtml(
	html: string,
	venue: VenueConfig,
	spec: VenueSpec | undefined,
	targetYear: number,
): {
	items: CollectionPaperItem[];
	remoteTotalCount: number;
	rawPanelCount: number;
	filteredAnyPanel: boolean;
} {
	const venueKind = spec?.kind ?? inferVenueKind(venue);
	const venueDomain = spec?.domain ?? venue.domain;
	const ccfRank = spec?.ccfRank ?? venue.ccfRank;
	const allowedGroupsLower = spec?.coolPapersAllowedGroups?.length
		? new Set(spec.coolPapersAllowedGroups.map((g) => g.toLowerCase()))
		: null;
	const excludedGroupPattern = spec?.coolPapersExcludedGroupPattern;
	const baseCategories = [
		venue.name,
		...(venueDomain ? [venueDomain] : []),
		...(ccfRank ? [ccfRank] : []),
	];

	const items: CollectionPaperItem[] = [];
	let remoteTotalCount = 0;
	let rawPanelCount = 0;
	let filteredAnyPanel = false;
	const chunks = html.split('<div id="');

	for (let i = 1; i < chunks.length; i++) {
		const chunk = chunks[i] ?? "";
		const headEnd = chunk.indexOf(">");
		if (headEnd <= 0) continue;
		const openTag = chunk.slice(0, headEnd);
		if (!/\bpanel\b/i.test(openTag) || !/\bpaper\b/i.test(openTag)) continue;

		const idQuote = openTag.indexOf('"');
		const coolPapersId = (idQuote > 0 ? openTag.slice(0, idQuote) : "").trim();
		if (!coolPapersId) continue;
		rawPanelCount += 1;

		const totalMatch =
			/<a\s+href="https?:\/\/[^"]+"[^>]*\btitle="\d+\/(\d+)"/i.exec(chunk);
		if (totalMatch?.[1]) {
			const parsedTotal = Number(totalMatch[1]);
			if (parsedTotal > remoteTotalCount) remoteTotalCount = parsedTotal;
		}

		const panelGroup = extractCoolPapersPanelGroup(chunk);
		if (panelGroup) {
			if (
				allowedGroupsLower &&
				!allowedGroupsLower.has(panelGroup.toLowerCase())
			) {
				filteredAnyPanel = true;
				continue;
			}
			if (excludedGroupPattern?.test(panelGroup)) {
				filteredAnyPanel = true;
				continue;
			}
		}

		const rawTitleHtml =
			/<a\s+id="title-[^"]+"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk)?.[1] ?? "";
		const title = decodeHtmlEntities(rawTitleHtml.replace(/<[^>]+>/g, " "))
			.replace(/\s+/g, " ")
			.trim();
		if (!title || isFrontmatterTitle(title)) continue;
		if (spec?.excludePositionPapers && isPositionPaperTitle(title)) {
			filteredAnyPanel = true;
			continue;
		}

		const authors: string[] = [];
		for (const am of chunk.matchAll(
			/<a\s+class="author\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
		)) {
			const name = decodeHtmlEntities((am[1] ?? "").replace(/<[^>]+>/g, " "))
				.replace(/\s+/g, " ")
				.trim();
			if (name) authors.push(name);
		}
		if (authors.length === 0) continue;

		const rawSummaryHtml =
			/<p\s+id="summary-[^"]+"[^>]*>([\s\S]*?)<\/p>/i.exec(chunk)?.[1] ?? "";
		const rawAbstract = decodeHtmlEntities(
			rawSummaryHtml.replace(/<[^>]+>/g, " "),
		)
			.replace(/\s+/g, " ")
			.trim();
		const abstract = isPlaceholderAbstract(rawAbstract, venue.name)
			? ""
			: rawAbstract;

		const extUrl =
			/<h2[^>]*class="[^"]*title[^"]*"[^>]*>[\s\S]*?<a\s+href="(https?:\/\/[^"]+)"/i
				.exec(chunk)?.[1]
				?.trim() ||
			`https://papers.cool/venue/${encodeURIComponent(coolPapersId)}`;

		const rawPdfData =
			/<a\s+id="pdf-[^"]+"[^>]*\bdata="([^"]+)"/i.exec(chunk)?.[1] ?? "";
		const pdfUrl =
			decodeHtmlEntities(rawPdfData.split("||")[0] ?? "").trim() || undefined;

		let doi = cleanDoi(extUrl);
		if (!doi) {
			const aclMatch =
				/aclanthology\.org\/(20\d{2}\.[a-z0-9.-]+?)(?:\/|\.pdf|$)/i.exec(
					extUrl,
				) ?? /^(20\d{2}\.[a-z0-9.-]+)@ACL$/i.exec(coolPapersId);
			if (aclMatch?.[1]) {
				doi = `10.18653/v1/${aclMatch[1]}`;
			}
		}
		if (isExcludedByDoiPrefix(doi, spec?.excludeDoiPrefixes)) {
			filteredAnyPanel = true;
			continue;
		}
		if (hasPriorConferenceYearSpillover(targetYear, doi, extUrl)) {
			filteredAnyPanel = true;
			continue;
		}

		const arxivMatch = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i.exec(
			`${extUrl} ${pdfUrl ?? ""}`,
		);
		const arxivId = arxivMatch?.[1];

		items.push({
			id: buildVenuePaperId(venue.id, doi, arxivId, title),
			title,
			authors,
			abstract,
			publishedAt: `${targetYear}-01-01T00:00:00Z`,
			year: targetYear,
			sourceType: "venue",
			sourceLabel: venue.name,
			categories: baseCategories,
			url: extUrl,
			pdfUrl:
				pdfUrl ||
				(arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined),
			arxivId,
			doi,
			coolPapersId,
			venueId: venue.id,
			venueKind,
			venueDomain,
			ccfRank,
			venueFull: venue.name,
			citationCount: 0,
			// `papers.cool` `<div keywords="...">` stores TF-IDF search tokens rather than author keywords.
			keywords: [],
		});
	}

	return {
		items,
		remoteTotalCount: Math.max(remoteTotalCount, items.length),
		rawPanelCount,
		filteredAnyPanel,
	};
}

/**
 * Multi-page `papers.cool/venue/{slug}?skip=...&show=2000` fetcher (up to 32,000 papers).
 * When a small explicit `coolPapersAllowedGroups` whitelist is configured (e.g. `ACL 2026`
 * `Long Papers` + `Short Papers`), queries those exact groups directly.
 */
export async function fetchCoolPapersVenuePapers(
	venue: VenueConfig,
	year: number,
	fetchText: FetchTextFn,
	options?: {
		maxPages?: number;
		pageSize?: number;
	},
): Promise<{ items: CollectionPaperItem[]; remoteTotalCount: number }> {
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const slug = spec?.coolPapersVenueSlug;
	if (!slug) return { items: [], remoteTotalCount: 0 };

	const pageSize = options?.pageSize ?? 2000;
	const maxPages = options?.maxPages ?? 16;
	const out: CollectionPaperItem[] = [];
	const seenIds = new Set<string>();
	let remoteTotalCount = 0;
	let filteredAny = false;

	const fetchGroupPages = async (groupParam: string | null) => {
		let groupTotal = 0;
		let observedPanels = 0;
		for (let page = 0; page < maxPages; page++) {
			const skip = page * pageSize;
			const groupQuery = groupParam
				? `group=${encodeURIComponent(groupParam)}&`
				: "";
			const url = `https://papers.cool/venue/${encodeURIComponent(slug)}?${groupQuery}skip=${skip}&show=${pageSize}`;
			let html = "";
			try {
				html = await fetchText(url, "text/html,application/xhtml+xml,*/*");
			} catch (err) {
				if (isBackgroundTaskCancelledError(err)) throw err;
				if (IS_TEST_ENV) throw err;
				try {
					await new Promise((resolve) => setTimeout(resolve, 1200));
					html = await fetchText(url, "text/html,application/xhtml+xml,*/*");
				} catch (retryErr) {
					if (isBackgroundTaskCancelledError(retryErr)) throw retryErr;
					throw retryErr;
				}
			}

			const parsed = parseCoolPapersVenueHtml(html, venue, spec, year);
			observedPanels += parsed.rawPanelCount;
			if (parsed.filteredAnyPanel) filteredAny = true;
			if (parsed.remoteTotalCount > groupTotal) {
				groupTotal = parsed.remoteTotalCount;
			}
			if (parsed.rawPanelCount === 0) break;

			let added = 0;
			for (const item of parsed.items) {
				const dedupeKey = item.coolPapersId || item.id;
				if (seenIds.has(dedupeKey)) continue;
				seenIds.add(dedupeKey);
				out.push(item);
				added += 1;
			}

			if (
				(added === 0 && !parsed.filteredAnyPanel) ||
				parsed.rawPanelCount < pageSize ||
				(groupTotal > 0 && (page + 1) * pageSize >= groupTotal)
			) {
				break;
			}
		}
		if (!groupParam && groupTotal > remoteTotalCount) {
			remoteTotalCount = groupTotal;
		}
		return observedPanels;
	};

	const explicitGroups =
		spec?.coolPapersAllowedGroups &&
		spec.coolPapersAllowedGroups.length > 0 &&
		spec.coolPapersAllowedGroups.length <= 3
			? spec.coolPapersAllowedGroups
			: null;

	if (explicitGroups) {
		filteredAny = true;
		let totalObserved = 0;
		for (const grp of explicitGroups) {
			totalObserved += await fetchGroupPages(grp);
		}
		if (totalObserved === 0) {
			await fetchGroupPages(null);
		}
	} else {
		await fetchGroupPages(null);
	}

	return {
		items: out,
		remoteTotalCount: filteredAny
			? out.length
			: Math.max(remoteTotalCount, out.length),
	};
}

function extractBalancedTagInner(
	html: string,
	openTagEndIndex: number,
	tagName: string,
): string {
	const tagRe = new RegExp(`<(\\/)?${tagName}\\b[^>]*>`, "gi");
	tagRe.lastIndex = openTagEndIndex;
	let depth = 1;
	for (let m = tagRe.exec(html); m !== null; m = tagRe.exec(html)) {
		if (m[1]) {
			depth -= 1;
			if (depth === 0) {
				return html.slice(openTagEndIndex, m.index);
			}
		} else if (!m[0].endsWith("/>")) {
			depth += 1;
		}
	}
	return html.slice(openTagEndIndex);
}

function stripBalancedBadgeSpans(raw: string): string {
	let out = raw;
	for (let guard = 0; guard < 12; guard++) {
		const openMatch =
			/<span\b[^>]*class=["'][^"']*(?:pull-right|output-badge|badge)[^"']*["'][^>]*>/i.exec(
				out,
			);
		if (!openMatch || openMatch.index === undefined) break;
		const start = openMatch.index;
		const openEnd = start + openMatch[0].length;
		const inner = extractBalancedTagInner(out, openEnd, "span");
		const afterClose = openEnd + inner.length + "</span>".length;
		out = `${out.slice(0, start)} ${out.slice(afterClose <= out.length ? afterClose : out.length)}`;
	}
	return out;
}

function stripResearchrBadges(rawTitleHtmlOrText: string): string {
	return stripBalancedBadgeSpans(rawTitleHtmlOrText)
		.replace(/<[^>]+>/g, " ")
		.replace(
			/\s*(?:Distinguished Paper(?:\s+Award)?|Virtual Attendance|Artifact Available|Artifact Evaluated|ACM SIGSOFT Distinguished Paper)\s*$/gi,
			"",
		)
		.replace(/\s+/g, " ")
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
	baseUrlOverride?: string,
): CollectionPaperItem[] {
	const results: CollectionPaperItem[] = [];
	const seenTitles = new Set<string>();
	const rawBase = baseUrlOverride || venue.url;
	const yearMatch = /\b(20\d{2})\b/.exec(`${venue.name} ${rawBase}`);
	const year = yearMatch ? Number(yearMatch[1]) : 2026;
	const baseUrl = rawBase.split("#")[0] || rawBase;

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

				const anchorClone = titleAnchor.cloneNode(true) as HTMLElement;
				for (const badge of anchorClone.querySelectorAll(
					".pull-right, .output-badge, .badge, [data-facet-badge]",
				)) {
					badge.remove();
				}
				const title = stripResearchrBadges(
					(anchorClone.textContent ?? "").replace(/\s+/g, " ").trim(),
				);
				if (!title || title.length < 6 || isFrontmatterTitle(title)) continue;

				const performersContainer = row.querySelector(".performers");
				const authorEls = row.querySelectorAll(".performers a, .performers");
				const authors: string[] = [];
				if (authorEls.length > 0) {
					for (const el of authorEls) {
						if (el.tagName.toLowerCase() === "a") {
							const name = (el.textContent ?? "").replace(/\s+/g, " ").trim();
							if (name && !authors.includes(name)) authors.push(name);
						}
					}
					if (authors.length === 0 && performersContainer) {
						const rawAuthors = (performersContainer.textContent ?? "")
							.replace(/\s+/g, " ")
							.trim();
						for (const part of rawAuthors.split(",")) {
							const name = part.trim();
							if (name) authors.push(name);
						}
					}
				}
				if (authors.length === 0) continue;

				const normTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
				if (!normTitle || seenTitles.has(normTitle)) continue;
				seenTitles.add(normTitle);

				const trackText = (
					row.querySelector(".prog-track")?.textContent ?? venue.name
				)
					.replace(/\s+/g, " ")
					.trim();
				const href = titleAnchor.getAttribute("href") ?? "";
				const pubMeta = extractResearchrPublicationMeta(row.innerHTML, baseUrl);
				let itemUrl = baseUrl;
				if (pubMeta.url !== baseUrl) {
					itemUrl = pubMeta.url;
				} else if (href && href !== "#" && !href.startsWith("javascript:")) {
					try {
						itemUrl = new URL(href, baseUrl).href;
					} catch {
						itemUrl = href;
					}
				}

				const slug = title
					.toLowerCase()
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
		let scopedHtml = overviewIdx >= 0 ? html.slice(overviewIdx) : html;
		if (overviewIdx >= 0) {
			const tableEnd = scopedHtml.search(/<\/table>/i);
			if (tableEnd >= 0) {
				scopedHtml = scopedHtml.slice(0, tableEnd + 8);
			}
		}
		const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
		for (const trMatch of scopedHtml.matchAll(trRegex)) {
			const rowHtml = trMatch[1] ?? "";
			if (!/class=["'][^"']*performers/i.test(rowHtml)) continue;
			const anchorMatch =
				/<a[^>]*(?:data-event-modal=["'][^"']+["']|class=["'][^"']*\bevent-title\b[^"']*["']|href=["'][^"']*\/details\/[^"']+["'])[^>]*>([\s\S]*?)<\/a>/i.exec(
					rowHtml,
				);
			if (!anchorMatch) continue;
			const rawTitle = stripResearchrBadges(anchorMatch[1] ?? "");
			const title = decodeHtmlEntities(rawTitle).replace(/\s+/g, " ").trim();
			if (!title || title.length < 6 || isFrontmatterTitle(title)) continue;

			const authors: string[] = [];
			const performersBlock =
				/<div[^>]*class=["'][^"']*performers[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(
					rowHtml,
				)?.[1] ?? "";
			for (const aMatch of performersBlock.matchAll(
				/<a[^>]*>([\s\S]*?)<\/a>/gi,
			)) {
				const name = decodeHtmlEntities(aMatch[1] ?? "")
					.replace(/\s+/g, " ")
					.trim();
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

			const normTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
			if (!normTitle || seenTitles.has(normTitle)) continue;
			seenTitles.add(normTitle);

			const pubMeta = extractResearchrPublicationMeta(rowHtml, baseUrl);
			const slug = title
				.toLowerCase()
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

function splitCleanAuthorList(rawPlain: string): string[] {
	const cleaned = stripParentheticalAffiliations(rawPlain)
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return [];
	const out: string[] = [];
	for (const seg of cleaned.split(/[,;|]+/)) {
		const trimmedSeg = seg.trim();
		if (!trimmedSeg) continue;
		for (const sub of trimmedSeg.split(
			/\s+(?:and|&)\s+|^(?:and|&)\s+|\s*&\s*/i,
		)) {
			const name = sub.replace(/\s+/g, " ").trim();
			if (name) out.push(name);
		}
	}
	return out;
}

function extractBalancedClassDivInner(
	html: string,
	className: string,
): string | null {
	const re = new RegExp(
		`<div\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`,
		"i",
	);
	const m = re.exec(html);
	if (!m || m.index === undefined) return null;
	return extractBalancedTagInner(html, m.index + m[0].length, "div");
}

function cleanRichHtmlProse(rawHtml: string): string {
	return decodeHtmlEntities(
		rawHtml
			.replace(/<\/?(?:p|br|div|li|blockquote)\b[^>]*>/gi, " ")
			.replace(/<[^>]+>/g, ""),
	)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Extract paper abstract and final PDF link from a USENIX presentation detail page
 * (`https://www.usenix.org/conference/usenixsecurity26/presentation/...`).
 */
export function parseUsenixPresentationHtml(
	html: string,
	pageUrl: string,
): { abstract: string; pdfUrl?: string } {
	let abstract = "";
	const descInner =
		extractBalancedClassDivInner(html, "field-name-field-paper-description") ??
		extractBalancedClassDivInner(
			html,
			"field-name-field-paper-description-long",
		);
	if (descInner) {
		abstract = cleanRichHtmlProse(descInner).replace(/^abstract[:.\s-]*/i, "");
	}

	let pdfUrl: string | undefined;
	const pdfInner = extractBalancedClassDivInner(
		html,
		"field-name-field-final-paper-pdf",
	);
	if (pdfInner) {
		const hrefMatch =
			/<a\b[^>]*href=["']?([^"'\s>]+\.pdf[^"'\s>]*)["']?/i.exec(pdfInner) ??
			/<a\b[^>]*href=["']?([^"'\s>]+)["']?/i.exec(pdfInner);
		if (hrefMatch?.[1]) {
			try {
				pdfUrl = new URL(decodeHtmlEntities(hrefMatch[1]), pageUrl).href;
			} catch {
				pdfUrl = decodeHtmlEntities(hrefMatch[1]);
			}
		}
	}

	return { abstract, pdfUrl };
}

/**
 * Parse official accepted-paper program pages for conferences whose proceedings DOIs
 * have not yet been minted or whose main-track roster must be enforced (`CCS 2026`,
 * `ISSRE 2026`, `S&P 2026`, `USENIX Security 2026`, `NDSS 2026`, `ACL 2026`).
 */
export function parseOfficialVenueProgramHtml(
	html: string,
	sourceUrl: string,
	venue: VenueConfig,
	spec: VenueSpec | undefined,
	targetYear: number,
): CollectionPaperItem[] {
	const venueKind = spec?.kind ?? inferVenueKind(venue);
	const venueDomain = spec?.domain ?? venue.domain;
	const ccfRank = spec?.ccfRank ?? venue.ccfRank;
	const baseCategories = [
		venue.name,
		...(venueDomain ? [venueDomain] : []),
		...(ccfRank ? [ccfRank] : []),
	];

	const out: CollectionPaperItem[] = [];
	const seenTitles = new Set<string>();

	const pushCandidate = (
		rawTitle: string,
		authors: string[],
		trackLabel?: string,
		extra?: {
			itemUrl?: string;
			abstract?: string;
			pdfUrl?: string;
			arxivId?: string;
			doi?: string;
		},
	) => {
		const title = rawTitle.replace(/\s+/g, " ").trim();
		if (!title || isFrontmatterTitle(title) || authors.length === 0) return;
		if (spec?.excludePositionPapers && isPositionPaperTitle(title)) return;
		const normTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
		if (!normTitle || seenTitles.has(normTitle)) return;
		seenTitles.add(normTitle);
		const doi =
			extra?.doi && !isArtifactOrDatasetDoi(extra.doi) ? extra.doi : undefined;
		const cleanAbs =
			extra?.abstract && !isPlaceholderAbstract(extra.abstract, venue.name)
				? extra.abstract
				: "";
		const categories = trackLabel
			? Array.from(new Set([...baseCategories, trackLabel]))
			: baseCategories;
		out.push({
			id: buildVenuePaperId(venue.id, doi, extra?.arxivId, title),
			title,
			authors,
			abstract: cleanAbs,
			publishedAt: `${targetYear}-01-01T00:00:00Z`,
			year: targetYear,
			sourceType: "venue",
			sourceLabel: venue.name,
			categories,
			url: extra?.itemUrl || sourceUrl,
			...(extra?.pdfUrl ? { pdfUrl: extra.pdfUrl } : {}),
			...(extra?.arxivId ? { arxivId: extra.arxivId } : {}),
			...(doi ? { doi } : {}),
			venueId: venue.id,
			venueKind,
			venueDomain,
			ccfRank,
			venueFull: venue.name,
			citationCount: 0,
			keywords: [],
		});
	};

	// Pattern 1: Structured JSON `const tracks = [...];` (e.g. ISSRE 2026 accepted papers)
	// Strictly whitelist Main / Research / Technical Track and reject Industry / J1C2 / Replication / Doctoral / Fast Abstracts.
	const tracksMatch = /const\s+tracks\s*=\s*(\[[\s\S]*?\]);/.exec(html);
	if (tracksMatch?.[1]) {
		try {
			const tracks = JSON.parse(tracksMatch[1]) as Array<{
				id?: string;
				label?: string;
				papers?: Array<{ title?: string; authors?: string | string[] }>;
			}>;
			for (const tr of tracks) {
				const trKey = `${tr.id ?? ""} ${tr.label ?? ""}`.trim();
				const isMainResearchTrack =
					/\b(?:research|technical|main)\s*(?:track|papers?)?\b/i.test(trKey) &&
					!/\b(?:industry|industrial|replication|negative|j1c2|journal[- ]first|doctoral|fast[- ]abstracts?|posters?|demos?|demonstrations?|student|tutorials?|workshops?|nier|era|vision)\b/i.test(
						trKey,
					);
				if (!isMainResearchTrack) {
					continue;
				}
				for (const p of tr.papers ?? []) {
					const rawTitle = decodeHtmlEntities(p.title ?? "");
					const rawAuthors = Array.isArray(p.authors)
						? p.authors
						: splitCleanAuthorList(decodeHtmlEntities(p.authors ?? ""));
					pushCandidate(rawTitle, rawAuthors, tr.label?.trim());
				}
			}
			if (out.length > 0) return out;
		} catch {
			// Fall through to HTML schedule patterns.
		}
	}

	// Pattern 2: `<li class="schedule-paper">` blocks (e.g. ACM CCS 2026 schedule)
	for (const m of html.matchAll(
		/<li[^>]*class=["'][^"']*\bschedule-paper\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi,
	)) {
		const block = m[1] ?? "";
		const titleBlock =
			/<p[^>]*class=["'][^"']*\bschedule-paper-title\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(
				block,
			)?.[1] ?? "";
		const strippedTitleHtml = titleBlock.replace(
			/<span[^>]*class=["'][^"']*\bschedule-paper-id\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,
			" ",
		);
		const title = decodeHtmlEntities(
			strippedTitleHtml.replace(/<[^>]+>/g, " "),
		);
		const authorsBlock =
			/<p[^>]*class=["'][^"']*\bschedule-authors\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(
				block,
			)?.[1] ?? "";
		const authors = splitCleanAuthorList(
			decodeHtmlEntities(authorsBlock.replace(/<[^>]+>/g, " ")),
		);
		pushCandidate(title, authors);
	}
	if (out.length > 0) return out;

	// Pattern 3: IEEE S&P accepted-papers.html (`<div class="list-group-item">`)
	const spItemRe =
		/<div\b[^>]*class=["'][^"']*\blist-group-item\b[^"']*["'][^>]*>/gi;
	for (const m of html.matchAll(spItemRe)) {
		if (m.index === undefined) continue;
		const block = extractBalancedTagInner(html, m.index + m[0].length, "div");
		const boldInner = /<b\b[^>]*>([\s\S]*?)<\/b>/i.exec(block)?.[1] ?? "";
		if (!boldInner) continue;
		const anchorInner =
			/<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(boldInner)?.[1] ?? boldInner;
		const cleanedTitleHtml = anchorInner.replace(
			/<span\b[^>]*class=["'][^"']*\bglyphicon\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,
			"",
		);
		const title = decodeHtmlEntities(cleanedTitleHtml.replace(/<[^>]+>/g, ""))
			.replace(/\s+/g, " ")
			.trim();
		const authorListInner = extractBalancedClassDivInner(block, "authorlist");
		if (!authorListInner) continue;
		const authorsLineHtml = (authorListInner.split(/<br\b/i)[0] ?? "").replace(
			/<sup\b[^>]*>[\s\S]*?<\/sup>/gi,
			"",
		);
		const authors = splitCleanAuthorList(
			decodeHtmlEntities(authorsLineHtml.replace(/<[^>]+>/g, " ")),
		);
		pushCandidate(title, authors);
	}
	if (out.length > 0) return out;

	// Pattern 4: USENIX technical-sessions (`<article ... class="node node-paper ...">`)
	const usenixArticleRe =
		/<article\b[^>]*class=["'][^"']*(?=[^"']*\bnode\b)(?=[^"']*\bnode-paper\b)[^"']*["'][^>]*>/gi;
	for (const m of html.matchAll(usenixArticleRe)) {
		if (m.index === undefined) continue;
		const block = extractBalancedTagInner(
			html,
			m.index + m[0].length,
			"article",
		);
		const h2Match =
			/<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i.exec(
				block,
			);
		if (!h2Match) continue;
		let itemUrl = sourceUrl;
		const rawHref = decodeHtmlEntities(h2Match[1] ?? "").trim();
		if (rawHref && !rawHref.startsWith("#")) {
			try {
				itemUrl = new URL(rawHref, sourceUrl).href;
			} catch {
				itemUrl = rawHref;
			}
		}
		const title = decodeHtmlEntities((h2Match[2] ?? "").replace(/<[^>]+>/g, ""))
			.replace(/\s+/g, " ")
			.trim();
		const peopleInner = extractBalancedClassDivInner(
			block,
			"field-name-field-paper-people-text",
		);
		if (!peopleInner) continue;
		const authorsRaw = decodeHtmlEntities(
			peopleInner
				.replace(/<em\b[^>]*>[\s\S]*?<\/em>/gi, " ")
				.replace(/<i\b[^>]*>[\s\S]*?<\/i>/gi, " ")
				.replace(/<[^>]+>/g, " "),
		);
		const authors = splitCleanAuthorList(authorsRaw);
		const descInner =
			extractBalancedClassDivInner(
				block,
				"field-name-field-paper-description-long",
			) ??
			extractBalancedClassDivInner(block, "field-name-field-paper-description");
		const abstract = descInner
			? cleanRichHtmlProse(descInner).replace(/^abstract[:.\s-]*/i, "")
			: "";
		const pdfMatch =
			/<a\b[^>]*href=["']?([^"'\s>]+\.pdf(?:\?[^"'\s>]*)?)["']?/i.exec(block);
		let pdfUrl: string | undefined;
		if (pdfMatch?.[1]) {
			try {
				pdfUrl = new URL(decodeHtmlEntities(pdfMatch[1]), sourceUrl).href;
			} catch {
				pdfUrl = decodeHtmlEntities(pdfMatch[1]);
			}
		}
		pushCandidate(title, authors, undefined, {
			itemUrl,
			abstract,
			pdfUrl,
		});
	}
	if (out.length > 0) return out;

	// Pattern 5: NDSS accepted-papers (`<h2 class="pt-cv-title"><a href="...">Title</a></h2>` + `.pt-cv-ctf-display_authors`)
	const ndssTitles = Array.from(
		html.matchAll(
			/<h2\b[^>]*class=["'][^"']*\bpt-cv-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/gi,
		),
	);
	for (let i = 0; i < ndssTitles.length; i++) {
		const m = ndssTitles[i];
		if (!m || m.index === undefined) continue;
		const start = m.index + m[0].length;
		const nextIdx = ndssTitles[i + 1]?.index;
		const sliceEnd =
			nextIdx !== undefined ? Math.min(nextIdx, start + 8000) : start + 8000;
		const slice = html.slice(start, sliceEnd);
		const titleAnchor =
			/<a\b[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/i.exec(
				m[1] ?? "",
			);
		const rawTitleHtml = titleAnchor?.[2] ?? m[1] ?? "";
		const title = decodeHtmlEntities(rawTitleHtml.replace(/<[^>]+>/g, ""))
			.replace(/\s+/g, " ")
			.trim();
		let itemUrl = sourceUrl;
		if (titleAnchor?.[1]) {
			try {
				itemUrl = new URL(decodeHtmlEntities(titleAnchor[1]), sourceUrl).href;
			} catch {
				itemUrl = decodeHtmlEntities(titleAnchor[1]);
			}
		}
		const authorsInner = extractBalancedClassDivInner(
			slice,
			"pt-cv-ctf-display_authors",
		);
		if (!authorsInner) continue;
		const authors = splitCleanAuthorList(
			decodeHtmlEntities(authorsInner.replace(/<[^>]+>/g, " ")),
		);
		pushCandidate(title, authors, undefined, { itemUrl });
	}
	if (out.length > 0) return out;

	// Pattern 6: ACLweb accepted_papers (`<li><p><strong>Title</strong><br /><em>Authors</em></p></li>` inside main content)
	const mainContentMatch =
		/<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html) ??
		/<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html);
	const fallbackContentDiv =
		extractBalancedClassDivInner(html, "page__content") ??
		extractBalancedClassDivInner(html, "entry-content") ??
		extractBalancedClassDivInner(html, "post-content");
	const mainScope = (mainContentMatch?.[1] ?? fallbackContentDiv ?? html)
		.replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
		.replace(/<header\b[\s\S]*?<\/header>/gi, " ")
		.replace(/<footer\b[\s\S]*?<\/footer>/gi, " ");
	const aclTokenRe =
		/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>|<li\b[^>]*>\s*(?:<p\b[^>]*>\s*)?<strong\b[^>]*>([\s\S]*?)<\/strong>\s*(?:<br\s*\/?>\s*|\s+)<em\b[^>]*>([\s\S]*?)<\/em>\s*(?:<\/p>\s*)?<\/li>/gi;
	let excludedAclSection = false;
	for (const m of mainScope.matchAll(aclTokenRe)) {
		if (m[2] !== undefined) {
			const headingText = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, " "))
				.replace(/\s+/g, " ")
				.trim();
			excludedAclSection =
				/\b(findings|workshops?|tutorials?|demos?|demonstrations?|industry|student\s+research|srw|doctoral|companion)\b/i.test(
					headingText,
				);
			continue;
		}
		if (excludedAclSection) continue;
		const title = decodeHtmlEntities((m[3] ?? "").replace(/<[^>]+>/g, ""))
			.replace(/\s+/g, " ")
			.trim();
		const authors = splitCleanAuthorList(
			decodeHtmlEntities((m[4] ?? "").replace(/<[^>]+>/g, " ")),
		);
		pushCandidate(title, authors);
	}

	return out;
}

/**
 * Fetch and parse authoritative Main / Research / Technical Track URLs (`venue.tracks` / `spec.tracks`).
 * When `spec.trackRosterMode === "required"`, throws if no track roster papers could be parsed so
 * combined-volume conferences (`ASE`, `ICPC`, `RE`, `SANER`, `ICSME`, `ESEM`) never store unfiltered tracks.
 */
export async function fetchOfficialTrackRoster(
	venue: VenueConfig,
	year: number,
	fetchText: FetchTextFn,
): Promise<{ items: CollectionPaperItem[]; remoteTotalCount: number }> {
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const rawTrackUrls =
		venue.tracks && venue.tracks.length > 0
			? venue.tracks
			: (spec?.tracks ?? []);
	const trackUrls = Array.from(
		new Set(rawTrackUrls.map((u) => u.trim()).filter(Boolean)),
	);
	const strictRequired = spec?.trackRosterMode === "required";

	if (trackUrls.length === 0) {
		if (strictRequired) {
			throw new Error(`Missing main-track URLs for ${venue.name}`);
		}
		return { items: [], remoteTotalCount: 0 };
	}

	const venueKind = spec?.kind ?? inferVenueKind(venue);
	const venueDomain = spec?.domain ?? venue.domain;
	const ccfRank = spec?.ccfRank ?? venue.ccfRank;
	const baseCategories = [
		venue.name,
		...(venueDomain ? [venueDomain] : []),
		...(ccfRank ? [ccfRank] : []),
	];

	const out: CollectionPaperItem[] = [];
	const seenNormTitles = new Set<string>();
	let lastFetchErr: unknown = null;

	for (const trackUrl of trackUrls) {
		let html = "";
		try {
			html = await fetchText(trackUrl, "text/html,application/xhtml+xml,*/*");
		} catch (err) {
			if (isBackgroundTaskCancelledError(err)) throw err;
			lastFetchErr = err;
			if (!IS_TEST_ENV) {
				try {
					await new Promise((resolve) => setTimeout(resolve, 1200));
					html = await fetchText(
						trackUrl,
						"text/html,application/xhtml+xml,*/*",
					);
				} catch (retryErr) {
					if (isBackgroundTaskCancelledError(retryErr)) throw retryErr;
					lastFetchErr = retryErr;
					continue;
				}
			} else {
				continue;
			}
		}

		const researchrParsed = parseResearchrHtml(html, venue, trackUrl);
		const candidates =
			researchrParsed.length > 0
				? researchrParsed.map((p) => ({
						...p,
						id: buildVenuePaperId(venue.id, p.doi, p.arxivId, p.title),
						abstract: isPlaceholderAbstract(p.abstract, venue.name)
							? ""
							: p.abstract,
						year,
						publishedAt: `${year}-01-01T00:00:00Z`,
						categories: baseCategories,
						venueId: venue.id,
						venueKind,
						venueDomain,
						ccfRank,
						venueFull: venue.name,
						citationCount: p.citationCount ?? 0,
						keywords: p.keywords ?? [],
					}))
				: parseOfficialVenueProgramHtml(html, trackUrl, venue, spec, year);

		for (const item of candidates) {
			const norm = item.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
			if (!norm || seenNormTitles.has(norm)) continue;
			seenNormTitles.add(norm);
			out.push(item);
		}
	}

	if (out.length === 0 && strictRequired) {
		if (lastFetchErr instanceof Error) {
			throw lastFetchErr;
		}
		throw new Error(
			`Authoritative main-track roster returned 0 papers for ${venue.name}`,
		);
	}

	return { items: out, remoteTotalCount: out.length };
}

export async function fetchOfficialVenueProgramPapers(
	venue: VenueConfig,
	year: number,
	fetchText: FetchTextFn,
): Promise<{ items: CollectionPaperItem[]; remoteTotalCount: number }> {
	try {
		return await fetchOfficialTrackRoster(venue, year, fetchText);
	} catch {
		return { items: [], remoteTotalCount: 0 };
	}
}

interface MiniConfAuthorRaw {
	fullname?: string;
	name?: string;
	first?: string;
	last?: string;
}

interface MiniConfEventMediaRaw {
	uri?: string;
	url?: string;
	name?: string;
	type?: string;
}

interface MiniConfPaperRaw {
	id?: string | number;
	uid?: string | number;
	name?: string;
	title?: string;
	authors?: Array<MiniConfAuthorRaw | string>;
	keywords?: Array<string>;
	decision?: string;
	eventtype?: string;
	event_type?: string;
	sourceurl?: string;
	source_url?: string;
	track?: string;
	paper_url?: string;
	url?: string;
	paper_pdf_url?: string | null;
	pdf_url?: string | null;
	virtualsite_url?: string;
	eventmedia?: Array<MiniConfEventMediaRaw>;
	abstract?: string;
}

const REJECT_MINICONF_SOURCE_RE =
	/(?:position[_-]?paper[_-]?track|position[_-]?track|blog[_-]?posts?|tmlr|jmlr|annals[_-]?of[_-]?statistics|\baos\b|workshop|bridging[-_]the[-_]future|journal[-_]track|companion|tutorials?|demonstrations?|demos?|challenges?|competitions?|social|town[-_ ]hall)/i;

/**
 * Fetch official MiniConf `orals-posters.json` + `abstracts.json` metadata
 * (`NeurIPS`, `ICLR`, `ICML`), keeping only Conference main-track Oral/Spotlight/Poster
 * (plus NeurIPS Datasets & Benchmarks / Evaluations & Datasets when explicitly enabled).
 * Returns empty gracefully on missing/error JSON so callers fall through cleanly.
 */
export async function fetchMiniConfVenuePapers(
	venue: VenueConfig,
	year: number,
	fetchJson: FetchJsonFn,
	signal?: AbortSignal,
): Promise<{ items: CollectionPaperItem[]; remoteTotalCount: number }> {
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const slug = spec?.miniConfSlug;
	if (!slug) return { items: [], remoteTotalCount: 0 };

	throwIfAborted(signal);
	const baseHost = `https://${slug}.cc`;
	const oralsPostersUrl = `${baseHost}/static/virtual/data/${slug}-${year}-orals-posters.json`;
	const abstractsUrl = `${baseHost}/static/virtual/data/${slug}-${year}-abstracts.json`;

	let rawListPayload: unknown;
	try {
		rawListPayload = await fetchJson(oralsPostersUrl);
	} catch {
		return { items: [], remoteTotalCount: 0 };
	}

	const rawRows: MiniConfPaperRaw[] = Array.isArray(rawListPayload)
		? (rawListPayload as MiniConfPaperRaw[])
		: rawListPayload &&
				typeof rawListPayload === "object" &&
				Array.isArray((rawListPayload as { results?: unknown }).results)
			? (rawListPayload as { results: MiniConfPaperRaw[] }).results
			: [];
	if (rawRows.length === 0) {
		return { items: [], remoteTotalCount: 0 };
	}

	throwIfAborted(signal);
	const abstractsByKey = new Map<string, string>();
	try {
		const rawAbsPayload = await fetchJson<unknown>(abstractsUrl);
		if (Array.isArray(rawAbsPayload)) {
			for (const entry of rawAbsPayload) {
				if (!entry || typeof entry !== "object") continue;
				const rec = entry as {
					id?: string | number;
					uid?: string | number;
					abstract?: unknown;
				};
				if (typeof rec.abstract !== "string") continue;
				const cleanAbs = cleanRichHtmlProse(rec.abstract);
				if (!cleanAbs) continue;
				if (rec.id !== undefined && rec.id !== null) {
					abstractsByKey.set(String(rec.id), cleanAbs);
				}
				if (rec.uid !== undefined && rec.uid !== null) {
					abstractsByKey.set(String(rec.uid), cleanAbs);
				}
			}
		} else if (rawAbsPayload && typeof rawAbsPayload === "object") {
			const recordObj = rawAbsPayload as Record<string, unknown>;
			if (Array.isArray(recordObj.results)) {
				for (const entry of recordObj.results) {
					if (!entry || typeof entry !== "object") continue;
					const rec = entry as {
						id?: string | number;
						uid?: string | number;
						abstract?: unknown;
					};
					if (typeof rec.abstract !== "string") continue;
					const cleanAbs = cleanRichHtmlProse(rec.abstract);
					if (!cleanAbs) continue;
					if (rec.id !== undefined && rec.id !== null) {
						abstractsByKey.set(String(rec.id), cleanAbs);
					}
					if (rec.uid !== undefined && rec.uid !== null) {
						abstractsByKey.set(String(rec.uid), cleanAbs);
					}
				}
			} else {
				for (const [key, val] of Object.entries(recordObj)) {
					const rawStr =
						typeof val === "string"
							? val
							: val &&
									typeof val === "object" &&
									typeof (val as { abstract?: unknown }).abstract === "string"
								? (val as { abstract: string }).abstract
								: "";
					const cleanAbs = rawStr ? cleanRichHtmlProse(rawStr) : "";
					if (cleanAbs) abstractsByKey.set(key, cleanAbs);
				}
			}
		}
	} catch {
		// Abstracts JSON is optional fallback; continue with any inline abstracts.
	}

	const venueKind = spec?.kind ?? inferVenueKind(venue);
	const venueDomain = spec?.domain ?? venue.domain;
	const ccfRank = spec?.ccfRank ?? venue.ccfRank;
	const baseCategories = [
		venue.name,
		...(venueDomain ? [venueDomain] : []),
		...(ccfRank ? [ccfRank] : []),
	];
	const allowDb = Boolean(spec?.includeDatasetsBenchmarks);

	const out: CollectionPaperItem[] = [];
	const seenTitles = new Set<string>();

	for (const row of rawRows) {
		if (!row || typeof row !== "object") continue;
		const title = decodeHtmlEntities(String(row.name ?? row.title ?? ""))
			.replace(/\s+/g, " ")
			.trim();
		if (!title || isFrontmatterTitle(title)) continue;
		if (spec?.excludePositionPapers && isPositionPaperTitle(title)) continue;

		const decision = decodeHtmlEntities(String(row.decision ?? ""))
			.replace(/\s+/g, " ")
			.trim();
		if (!decision) continue;
		if (/\b(?:reject|rejected|withdrawn?|desk[- ]?reject)/i.test(decision)) {
			continue;
		}

		const sourceUrlField = String(row.sourceurl ?? row.source_url ?? "").trim();
		const trackField = decodeHtmlEntities(String(row.track ?? "")).trim();
		const eventTypeField = decodeHtmlEntities(
			String(row.eventtype ?? row.event_type ?? ""),
		).trim();
		const combinedMeta = `${sourceUrlField} ${trackField} ${eventTypeField} ${decision}`;
		const normalizedMeta = combinedMeta.replace(/[_/.-]+/g, " ");

		if (
			REJECT_MINICONF_SOURCE_RE.test(combinedMeta) ||
			isWorkshopOrCompanionVenue(normalizedMeta, {
				allowDatasetsBenchmarks: allowDb,
			})
		) {
			continue;
		}
		if (hasPriorConferenceYearSpillover(year, sourceUrlField, trackField)) {
			continue;
		}

		const isMainConferenceTrack = sourceUrlField
			.toLowerCase()
			.includes(`/${year}/conference`);
		const isAllowedDatasetsTrack =
			allowDb &&
			(/(?:evaluations[_ ]and[_ ]datasets[_ ]track|datasets[_ ]and[_ ]benchmarks)/i.test(
				sourceUrlField,
			) ||
				/(?:evaluations?\s+(?:and|&)\s+datasets?|datasets?\s+(?:and|&)\s+benchmarks?)/i.test(
					`${trackField} ${decision}`,
				));
		if (!isMainConferenceTrack && !isAllowedDatasetsTrack) {
			continue;
		}
		if (
			eventTypeField &&
			!/\b(?:oral|spotlight|poster)\b/i.test(eventTypeField)
		) {
			continue;
		}

		const normTitle = normVenueTitleKey(title);
		if (!normTitle || seenTitles.has(normTitle)) continue;
		seenTitles.add(normTitle);

		const authors = (row.authors ?? [])
			.map((a) => {
				if (typeof a === "string") return decodeHtmlEntities(a);
				if (!a || typeof a !== "object") return "";
				return decodeHtmlEntities(
					a.fullname ||
						a.name ||
						[a.first, a.last].filter(Boolean).join(" ") ||
						"",
				);
			})
			.map((s) => s.replace(/\s+/g, " ").trim())
			.filter(Boolean);

		const idKey = row.id !== undefined && row.id !== null ? String(row.id) : "";
		const uidKey =
			row.uid !== undefined && row.uid !== null ? String(row.uid) : "";
		const rawAbs =
			(idKey ? abstractsByKey.get(idKey) : undefined) ??
			(uidKey ? abstractsByKey.get(uidKey) : undefined) ??
			(typeof row.abstract === "string"
				? cleanRichHtmlProse(row.abstract)
				: "");
		const abstract = isPlaceholderAbstract(rawAbs, venue.name) ? "" : rawAbs;

		const candidateUrls = [
			row.paper_url,
			row.url,
			row.paper_pdf_url,
			row.pdf_url,
			row.virtualsite_url,
			...(row.eventmedia ?? []).flatMap((m) => [m?.uri, m?.url]),
		]
			.map((u) => (typeof u === "string" ? u.trim() : ""))
			.filter(Boolean);

		let openReviewId: string | undefined;
		let arxivId: string | undefined;
		let openReviewForumUrl: string | undefined;
		let explicitPdfUrl: string | undefined;

		for (const u of candidateUrls) {
			const orMatch =
				/openreview\.net\/(?:forum|pdf)\?id=([A-Za-z0-9._-]+)/i.exec(u);
			if (orMatch?.[1]) {
				openReviewId = openReviewId ?? orMatch[1];
				if (/\/forum\?/i.test(u) && !openReviewForumUrl) {
					openReviewForumUrl = `https://openreview.net/forum?id=${orMatch[1]}`;
				}
				if (/\/pdf\?/i.test(u) && !explicitPdfUrl) {
					explicitPdfUrl = `https://openreview.net/pdf?id=${orMatch[1]}`;
				}
			}
			const axMatch =
				/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/i.exec(u);
			if (axMatch?.[1] && !arxivId) {
				arxivId = axMatch[1];
			}
			if (
				!explicitPdfUrl &&
				(/\.pdf(?:$|\?)/i.test(u) || /openreview\.net\/pdf\?/i.test(u))
			) {
				try {
					explicitPdfUrl = new URL(u, baseHost).href;
				} catch {
					explicitPdfUrl = u;
				}
			}
		}

		const pdfUrl =
			explicitPdfUrl ??
			(openReviewId
				? `https://openreview.net/pdf?id=${openReviewId}`
				: arxivId
					? `https://arxiv.org/pdf/${arxivId}.pdf`
					: undefined);

		const primaryRawUrl =
			openReviewForumUrl ||
			(typeof row.paper_url === "string" ? row.paper_url.trim() : "") ||
			(typeof row.url === "string" ? row.url.trim() : "") ||
			(typeof row.virtualsite_url === "string"
				? row.virtualsite_url.trim()
				: "") ||
			`${baseHost}/virtual/${year}/papers.html`;
		let itemUrl = primaryRawUrl;
		try {
			itemUrl = new URL(primaryRawUrl, baseHost).href;
		} catch {
			// Keep string URL
		}

		const keywords = normalizePaperKeywords(row.keywords);
		const catLabel = isAllowedDatasetsTrack
			? "Datasets & Benchmarks"
			: eventTypeField || decision;
		const categories = catLabel
			? Array.from(new Set([...baseCategories, catLabel]))
			: baseCategories;

		out.push({
			id: buildVenuePaperId(venue.id, undefined, arxivId, title),
			title,
			authors,
			abstract,
			publishedAt: `${year}-01-01T00:00:00Z`,
			year,
			sourceType: "venue",
			sourceLabel: venue.name,
			categories,
			url: itemUrl,
			...(pdfUrl ? { pdfUrl } : {}),
			...(arxivId ? { arxivId } : {}),
			venueId: venue.id,
			venueKind,
			venueDomain,
			ccfRank,
			venueFull: venue.name,
			citationCount: 0,
			keywords,
			...(keywords.length > 0 ? { keywordSource: "author" as const } : {}),
		});
	}

	return {
		items: out,
		remoteTotalCount: out.length,
	};
}

/**
 * Normalize an ACL Anthology `#abstract-...` suffix (supporting both `--` delimiters
 * such as `2026--acl-long--1` and trailing hyphen `2026--acl-long-1`) into `2026.acl-long.1`.
 */
function normalizeAclAbstractKey(rawSuffix: string): string {
	return rawSuffix
		.trim()
		.replace(/--/g, ".")
		.replace(/-(\d+)$/, ".$1")
		.toLowerCase();
}

/**
 * Parse an ACL Anthology volume HTML page (`2026.acl-long/` or `2026.acl-short/`),
 * handling Hugo unquoted attributes, inline `<span class=acl-fixed-case>`, `.pdf` links,
 * DOIs `10.18653/v1/{paperId}`, inline `#abstract-...` collapse divs, and skipping `.0`
 * frontmatter as well as `findings` volumes.
 */
export function parseAclAnthologyVolumeHtml(
	html: string,
	volumeUrl: string,
	venue: VenueConfig,
	spec: VenueSpec | undefined,
	targetYear: number,
): CollectionPaperItem[] {
	if (!html) return [];
	if (/findings/i.test(volumeUrl)) return [];

	const abstractById = new Map<string, string>();
	for (const absMatch of html.matchAll(
		/<div\b[^>]*\bid=["']?abstract-([^"'\s>]+)["']?[^>]*>/gi,
	)) {
		const rawKey = absMatch[1];
		if (!rawKey || absMatch.index === undefined) continue;
		const inner = extractBalancedTagInner(
			html,
			absMatch.index + absMatch[0].length,
			"div",
		);
		if (!inner) continue;
		const cleaned = cleanRichHtmlProse(inner).replace(/^abstract:\s*/i, "");
		if (!cleaned || isPlaceholderAbstract(cleaned, venue.name)) continue;
		abstractById.set(normalizeAclAbstractKey(rawKey), cleaned);
		abstractById.set(rawKey.toLowerCase(), cleaned);
	}

	const venueKind = spec?.kind ?? inferVenueKind(venue);
	const venueDomain = spec?.domain ?? venue.domain;
	const ccfRank = spec?.ccfRank ?? venue.ccfRank;
	const baseCategories = [
		venue.name,
		...(venueDomain ? [venueDomain] : []),
		...(ccfRank ? [ccfRank] : []),
	];

	const entryBlocks: string[] = [];
	for (const blk of html.matchAll(
		/<div\b[^>]*class=["'][^"']*\bd-sm-flex\b[^"']*["'][^>]*>/gi,
	)) {
		if (blk.index === undefined) continue;
		const inner = extractBalancedTagInner(
			html,
			blk.index + blk[0].length,
			"div",
		);
		if (inner) entryBlocks.push(inner);
	}

	// Fallback if simplified HTML omits `.d-sm-flex` wrapper
	if (entryBlocks.length === 0) {
		const pMatches = [
			...html.matchAll(
				/<(?:p|li|div)\b[^>]*>([\s\S]*?<strong>\s*<a\b[^>]*href=["']?[^"'\s>]*\d{4}\.[^"'\s>]+["']?[^>]*>[\s\S]*?)<\/(?:p|li|div)>/gi,
			),
		];
		for (const pm of pMatches) {
			if (pm[1]) entryBlocks.push(pm[1]);
		}
	}

	const out: CollectionPaperItem[] = [];
	const seenIds = new Set<string>();
	const defaultTrackLabel = /acl-short/i.test(volumeUrl)
		? "Short Papers"
		: /acl-long/i.test(volumeUrl)
			? "Long Papers"
			: undefined;

	for (const block of entryBlocks) {
		const titleAnchorMatch =
			/<strong>\s*<a\b[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>\s*<\/strong>/i.exec(
				block,
			);
		if (!titleAnchorMatch) continue;

		const rawHref = decodeHtmlEntities(titleAnchorMatch[1] ?? "").trim();
		const paperIdMatch = /(\d{4}\.[a-z0-9-]+\.(\d+))\/?$/i.exec(rawHref);
		if (!paperIdMatch?.[1]) continue;

		const paperId = paperIdMatch[1].toLowerCase();
		const paperNum = paperIdMatch[2];
		if (paperNum === "0") continue;
		if (paperId.includes("findings")) continue;
		if (hasPriorConferenceYearSpillover(targetYear, paperId)) continue;
		if (seenIds.has(paperId)) continue;

		// Strip inline HTML spans without inserting spaces so `<span class=acl-fixed-case>O</span>cto` -> `Octo`.
		const title = decodeHtmlEntities(
			(titleAnchorMatch[2] ?? "").replace(/<[^>]+>/g, ""),
		)
			.replace(/\s+/g, " ")
			.trim();
		if (!title || isFrontmatterTitle(title)) continue;
		if (spec?.excludePositionPapers && isPositionPaperTitle(title)) continue;

		const authors: string[] = [];
		for (const am of block.matchAll(
			/<a\b[^>]*href=["']?(?:https?:\/\/aclanthology\.org)?\/people\/[^"'\s>]+["']?[^>]*>([\s\S]*?)<\/a>/gi,
		)) {
			const name = decodeHtmlEntities((am[1] ?? "").replace(/<[^>]+>/g, ""))
				.replace(/\s+/g, " ")
				.trim();
			if (name) authors.push(name);
		}
		if (authors.length === 0) {
			const afterStrong = block.slice(
				(titleAnchorMatch.index ?? 0) + titleAnchorMatch[0].length,
			);
			const authorLine = afterStrong
				.replace(/<br\s*\/?>/gi, "\n")
				.replace(/<[^>]+>/g, "")
				.split("\n")
				.map((s) => decodeHtmlEntities(s).trim())
				.find((s) => s.length > 0 && !/^(?:abs|bib|pdf|errata|video)/i.test(s));
			if (authorLine) {
				authors.push(...splitCleanAuthorList(authorLine));
			}
		}

		seenIds.add(paperId);
		const doi = cleanDoi(`10.18653/v1/${paperId}`) ?? `10.18653/v1/${paperId}`;
		let itemUrl = `https://aclanthology.org/${paperId}/`;
		try {
			itemUrl = new URL(rawHref, volumeUrl).href;
		} catch {
			// Keep canonical URL
		}

		const pdfHrefMatch = /<a\b[^>]*href=["']?([^"'\s>]*\.pdf)["']?[^>]*>/i.exec(
			block,
		);
		let pdfUrl = `https://aclanthology.org/${paperId}.pdf`;
		if (pdfHrefMatch?.[1]) {
			try {
				pdfUrl = new URL(decodeHtmlEntities(pdfHrefMatch[1]), volumeUrl).href;
			} catch {
				// Keep canonical PDF URL
			}
		}

		const abstract = abstractById.get(paperId) ?? "";
		const trackLabel = paperId.includes("acl-short")
			? "Short Papers"
			: paperId.includes("acl-long")
				? "Long Papers"
				: defaultTrackLabel;
		const categories = trackLabel
			? Array.from(new Set([...baseCategories, trackLabel]))
			: baseCategories;

		out.push({
			id: buildVenuePaperId(venue.id, doi, undefined, title),
			title,
			authors,
			abstract,
			publishedAt: `${targetYear}-01-01T00:00:00Z`,
			year: targetYear,
			sourceType: "venue",
			sourceLabel: venue.name,
			categories,
			url: itemUrl,
			pdfUrl,
			doi,
			venueId: venue.id,
			venueKind,
			venueDomain,
			ccfRank,
			venueFull: venue.name,
			citationCount: 0,
			keywords: [],
		});
	}

	return out;
}

/**
 * Fetch and parse ACL Anthology main-track volumes (`2026.acl-long/`, `2026.acl-short/`)
 * and reconcile/filter against `2026.aclweb.org/program/accepted_papers/` when non-empty.
 * Returns empty `items` on failure/404 so `papers.cool` fallback executes gracefully.
 */
export async function fetchAclAnthologyVenuePapers(
	venue: VenueConfig,
	year: number,
	fetchText: FetchTextFn,
	signal?: AbortSignal,
): Promise<{
	items: CollectionPaperItem[];
	remoteTotalCount: number;
	acceptedRoster: CollectionPaperItem[];
}> {
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const rawTracks =
		venue.tracks && venue.tracks.length > 0
			? venue.tracks
			: (spec?.tracks ?? []);
	const aclWebUrls = rawTracks.filter(
		(u) => /aclweb\.org/i.test(u) || /accepted_papers/i.test(u),
	);
	const anthologyUrls = rawTracks.filter((u) =>
		/aclanthology\.org\/volumes\//i.test(u),
	);
	if (anthologyUrls.length === 0) {
		anthologyUrls.push(
			`https://aclanthology.org/volumes/${year}.acl-long/`,
			`https://aclanthology.org/volumes/${year}.acl-short/`,
		);
	}

	const acceptedRoster: CollectionPaperItem[] = [];
	const seenRosterTitles = new Set<string>();
	for (const url of aclWebUrls) {
		throwIfAborted(signal);
		try {
			const html = await fetchText(url, "text/html,application/xhtml+xml,*/*");
			for (const item of parseOfficialVenueProgramHtml(
				html,
				url,
				venue,
				spec,
				year,
			)) {
				const tk = normVenueTitleKey(item.title);
				if (!tk || seenRosterTitles.has(tk)) continue;
				seenRosterTitles.add(tk);
				acceptedRoster.push(item);
			}
		} catch {
			// Best-effort accepted_papers roster; Anthology volumes still work standalone.
		}
	}

	const anthologyItems: CollectionPaperItem[] = [];
	const seenAnthologyIds = new Set<string>();
	const failedVolumes: string[] = [];
	for (const volUrl of anthologyUrls) {
		throwIfAborted(signal);
		try {
			const html = await fetchText(
				volUrl,
				"text/html,application/xhtml+xml,*/*",
			);
			for (const item of parseAclAnthologyVolumeHtml(
				html,
				volUrl,
				venue,
				spec,
				year,
			)) {
				const key = item.doi?.toLowerCase() || normVenueTitleKey(item.title);
				if (!key || seenAnthologyIds.has(key)) continue;
				seenAnthologyIds.add(key);
				anthologyItems.push(item);
			}
		} catch (err) {
			if (signal?.aborted || isBackgroundTaskCancelledError(err)) {
				throw err;
			}
			// Volume may not be published yet; continue to remaining volume or fallback.
			failedVolumes.push(volUrl);
		}
	}

	const missingPrimaryLong =
		anthologyUrls.length > 1 && failedVolumes.some((u) => u.includes("-long"));
	if (anthologyItems.length === 0 || missingPrimaryLong) {
		return {
			items: [],
			remoteTotalCount: acceptedRoster.length,
			acceptedRoster,
		};
	}

	if (acceptedRoster.length > 0) {
		const rosterByTitle = new Map<string, CollectionPaperItem>();
		for (const r of acceptedRoster) {
			const tk = normVenueTitleKey(r.title);
			if (tk && !rosterByTitle.has(tk)) rosterByTitle.set(tk, r);
		}
		const filtered = anthologyItems.filter((item) => {
			const tk = normVenueTitleKey(item.title);
			if (tk && rosterByTitle.has(tk)) return true;
			return acceptedRoster.some(
				(r) =>
					scoreCameraReadyCandidateMatch(
						r.title,
						r.authors,
						item.title,
						item.authors,
					).matched,
			);
		});
		if (filtered.length > 0) {
			return {
				items: filtered,
				remoteTotalCount: filtered.length,
				acceptedRoster,
			};
		}
	}

	return {
		items: anthologyItems,
		remoteTotalCount: anthologyItems.length,
		acceptedRoster,
	};
}

/**
 * Fetch LIPIcs Gold-OA conference proceedings (`ECOOP 2026`, `ESEM 2026`) directly from
 * DataCite's CORS-open REST API (`10.4230/lipics.*`), carrying 100% full abstracts.
 */
export async function fetchDataCiteLipicsPapers(
	venue: VenueConfig,
	year: number,
	fetchJson: FetchJsonFn,
): Promise<{ items: CollectionPaperItem[]; remoteTotalCount: number }> {
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const prefix = spec?.doiPrefixFilter?.toLowerCase();
	if (!prefix?.startsWith("10.4230/")) {
		return { items: [], remoteTotalCount: 0 };
	}

	const venueKind = spec?.kind ?? inferVenueKind(venue);
	const venueDomain = spec?.domain ?? venue.domain;
	const ccfRank = spec?.ccfRank ?? venue.ccfRank;
	const baseCategories = [
		venue.name,
		...(venueDomain ? [venueDomain] : []),
		...(ccfRank ? [ccfRank] : []),
	];

	try {
		type DataCiteRow = {
			id?: string;
			attributes?: {
				titles?: Array<{ title?: string }>;
				creators?: Array<{
					givenName?: string;
					familyName?: string;
					name?: string;
				}>;
				descriptions?: Array<{
					descriptionType?: string;
					description?: string;
				}>;
				subjects?: Array<{
					subject?: string;
					subjectScheme?: string;
					schemeUri?: string;
				}>;
				url?: string;
				contentUrl?: string | string[] | null;
				published?: string | null;
			};
		};
		type DataCiteResponse = {
			data?: DataCiteRow[];
			meta?: { total?: number; totalPages?: number; page?: number };
		};

		const rows: DataCiteRow[] = [];
		const MAX_PAGES = 5;
		let totalPages = 1;
		for (let page = 1; page <= totalPages && page <= MAX_PAGES; page++) {
			const pageSuffix = page > 1 ? `&page[number]=${page}` : "";
			const url = `https://api.datacite.org/dois?query=${encodeURIComponent(`id:${prefix}.*`)}&page[size]=250${pageSuffix}`;
			const res = await fetchJson<DataCiteResponse>(url);
			const pageRows = res.data ?? [];
			rows.push(...pageRows);
			const reportedPages = res.meta?.totalPages;
			if (typeof reportedPages === "number" && reportedPages > totalPages) {
				totalPages = reportedPages;
			}
			if (pageRows.length < 250) break;
		}

		const items: CollectionPaperItem[] = [];
		for (const row of rows) {
			const doi = cleanDoi(row.id);
			if (!doi?.toLowerCase().startsWith(`${prefix}.`)) continue;
			// Skip `.0` frontmatter volume entry in LIPIcs
			if (/\.0$/i.test(doi)) continue;
			const attr = row.attributes;
			const rawTitle = decodeHtmlEntities(attr?.titles?.[0]?.title ?? "")
				.replace(/\s+/g, " ")
				.trim();
			if (!rawTitle || isFrontmatterTitle(rawTitle)) continue;

			const authors = (attr?.creators ?? [])
				.map((c) => {
					const full = `${c.givenName ?? ""} ${c.familyName ?? ""}`.trim();
					if (full) return full;
					const parts = (c.name ?? "").split(",");
					return parts.length === 2
						? `${parts[1]?.trim()} ${parts[0]?.trim()}`.trim()
						: (c.name ?? "").trim();
				})
				.filter(Boolean);
			if (authors.length === 0) continue;

			const rawAbs =
				attr?.descriptions?.find(
					(d) => d.descriptionType?.toLowerCase() === "abstract",
				)?.description ??
				attr?.descriptions?.[0]?.description ??
				"";
			const cleanAbs = decodeHtmlEntities(rawAbs.replace(/<[^>]+>/g, " "))
				.replace(/\s+/g, " ")
				.trim();
			const abstract = isPlaceholderAbstract(cleanAbs, venue.name)
				? ""
				: cleanAbs;

			const contentUrl = Array.isArray(attr?.contentUrl)
				? attr?.contentUrl[0]
				: attr?.contentUrl;
			const landingUrl = attr?.url || `https://doi.org/${doi}`;
			const authorSubjects = (attr?.subjects ?? [])
				.filter((s) => !s.subjectScheme && !s.schemeUri)
				.map((s) => decodeHtmlEntities(s.subject ?? "").trim())
				.filter(Boolean);
			const normalizedKeywords = normalizePaperKeywords(authorSubjects);

			items.push({
				id: buildVenuePaperId(venue.id, doi, undefined, rawTitle),
				title: rawTitle,
				authors,
				abstract,
				publishedAt: `${year}-01-01T00:00:00Z`,
				year,
				sourceType: "venue",
				sourceLabel: venue.name,
				categories: baseCategories,
				url: landingUrl,
				pdfUrl: contentUrl || undefined,
				doi,
				venueId: venue.id,
				venueKind,
				venueDomain,
				ccfRank,
				venueFull: venue.name,
				citationCount: 0,
				keywords: normalizedKeywords,
				...(normalizedKeywords.length > 0 ? { keywordSource: "author" } : {}),
			});
		}
		return { items, remoteTotalCount: items.length };
	} catch {
		return { items: [], remoteTotalCount: 0 };
	}
}

const NON_PAPER_CSDL_TYPES = new Set([
	"breaker-page",
	"toc",
	"list-staff",
	"index-author",
	"cover",
	"editorial",
	"front-matter",
	"back-matter",
	"title-page",
	"copyright",
	"preface",
	"foreword",
	"opinion",
	"commentary",
	"errata",
]);

type CsdlArticleRow = {
	id?: string;
	title?: string;
	abstract?: string;
	doi?: string;
	contentType?: string;
	issueNum?: string;
	volume?: string;
	year?: string;
	pubDate?: string;
	pages?: string;
	keywords?: string[];
	isOpenAccess?: boolean;
	authors?: Array<{
		fullName?: string;
		givenName?: string;
		surname?: string;
	}>;
};

/**
 * Fetch IEEE Computer Society Digital Library proceedings (`S&P`, `RE`, `SANER`, `ICSME`)
 * and journals (`TSE`) via CSDL's CORS-open GraphQL endpoint (`/csdl/api/v1/graphql`),
 * yielding 100% official IEEE abstracts even when OpenAlex/IEEE Xplore are rate-limited or WAF-gated.
 */
export async function fetchCsdlVenuePapers(
	venue: VenueConfig,
	year: number,
	fetchJson: FetchJsonFn,
): Promise<{ items: CollectionPaperItem[]; remoteTotalCount: number }> {
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const idPrefix = spec?.csdlIdPrefix;
	if (!idPrefix) return { items: [], remoteTotalCount: 0 };

	const venueKind = spec?.kind ?? inferVenueKind(venue);
	const venueDomain = spec?.domain ?? venue.domain;
	const ccfRank = spec?.ccfRank ?? venue.ccfRank;
	const baseCategories = [
		venue.name,
		...(venueDomain ? [venueDomain] : []),
		...(ccfRank ? [ccfRank] : []),
	];

	const gqlUrl = (query: string) =>
		`https://www.computer.org/csdl/api/v1/graphql?query=${encodeURIComponent(query)}`;

	const rawArticles: CsdlArticleRow[] = [];
	try {
		if (venueKind === "journal") {
			const issuesRes = await fetchJson<{
				data?: { periodicalIssues?: Array<{ issueNum?: string }> };
			}>(
				gqlUrl(
					`{ periodicalIssues(idPrefix: "${idPrefix}", year: "${year}") { issueNum } }`,
				),
			);
			for (const iss of issuesRes.data?.periodicalIssues ?? []) {
				if (!iss.issueNum) continue;
				const artRes = await fetchJson<{
					data?: { articles?: CsdlArticleRow[] };
				}>(
					gqlUrl(
						`{ articles(idPrefix: "${idPrefix}", year: "${year}", issueNum: "${iss.issueNum}") { id title abstract doi contentType issueNum volume year pubDate pages keywords authors { fullName givenName surname } } }`,
					),
				);
				rawArticles.push(...(artRes.data?.articles ?? []));
			}
			const preRes = await fetchJson<{
				data?: { preprints?: CsdlArticleRow[] };
			}>(
				gqlUrl(
					`{ preprints(idPrefix: "${idPrefix}") { id title abstract doi contentType issueNum volume year pubDate pages keywords authors { fullName givenName surname } } }`,
				),
			);
			for (const pre of preRes.data?.preprints ?? []) {
				if (
					String(pre.year ?? "") === String(year) ||
					String(pre.pubDate ?? "").startsWith(String(year))
				) {
					rawArticles.push(pre);
				}
			}
		} else {
			const procRes = await fetchJson<{
				data?: { proceedings?: Array<{ id?: string; title?: string }> };
			}>(
				gqlUrl(
					`{ proceedings(idPrefix: "${idPrefix}", year: "${year}") { id title } }`,
				),
			);
			for (const proc of procRes.data?.proceedings ?? []) {
				if (!proc.id) continue;
				if (proc.title && isWorkshopOrCompanionVenue(proc.title)) continue;
				const artRes = await fetchJson<{
					data?: { articlesByProceeding?: CsdlArticleRow[] };
				}>(
					gqlUrl(
						`{ articlesByProceeding(proceedingId: "${proc.id}") { id title abstract doi contentType issueNum volume year pubDate pages keywords authors { fullName givenName surname } } }`,
					),
				);
				rawArticles.push(...(artRes.data?.articlesByProceeding ?? []));
			}
		}
	} catch {
		return { items: [], remoteTotalCount: 0 };
	}

	const items: CollectionPaperItem[] = [];
	const seenIds = new Set<string>();
	for (const row of rawArticles) {
		const cType = (row.contentType ?? "").trim().toLowerCase();
		if (cType && NON_PAPER_CSDL_TYPES.has(cType)) continue;

		const title = decodeHtmlEntities((row.title ?? "").replace(/<[^>]+>/g, " "))
			.replace(/\s+/g, " ")
			.trim();
		if (!title || isFrontmatterTitle(title)) continue;
		if (spec?.excludePositionPapers && isPositionPaperTitle(title)) continue;
		if (venueKind === "journal" && isNonResearchJournalItem(title, row.pages)) {
			continue;
		}

		const doi = cleanDoi(row.doi);
		if (isExcludedByDoiPrefix(doi, spec?.excludeDoiPrefixes)) continue;

		const authors = (row.authors ?? [])
			.map(
				(a) =>
					a.fullName?.trim() ||
					`${a.givenName ?? ""} ${a.surname ?? ""}`.trim(),
			)
			.filter(Boolean);
		if (authors.length === 0) continue;

		const rawAbs = decodeHtmlEntities(
			(row.abstract ?? "").replace(/<[^>]+>/g, " "),
		)
			.replace(/\s+/g, " ")
			.trim();
		const abstract = isPlaceholderAbstract(rawAbs, venue.name) ? "" : rawAbs;

		const id = buildVenuePaperId(venue.id, doi, undefined, title);
		if (seenIds.has(id)) continue;
		seenIds.add(id);

		const pubDate = /^\d{4}-\d{2}-\d{2}/.test(row.pubDate ?? "")
			? `${row.pubDate?.slice(0, 10)}T00:00:00Z`
			: `${year}-01-01T00:00:00Z`;
		const normalizedKeywords = normalizePaperKeywords(row.keywords);

		items.push({
			id,
			title,
			authors,
			abstract,
			publishedAt: pubDate,
			year,
			sourceType: "venue",
			sourceLabel: venue.name,
			categories: baseCategories,
			url: doi ? `https://doi.org/${doi}` : venue.url,
			doi,
			venueId: venue.id,
			venueKind,
			venueDomain,
			ccfRank,
			venueFull: venue.name,
			citationCount: 0,
			keywords: normalizedKeywords,
			...(normalizedKeywords.length > 0 ? { keywordSource: "author" } : {}),
			volume: row.volume || undefined,
			issue: row.issueNum || undefined,
			pages: row.pages || undefined,
		});
	}

	return { items, remoteTotalCount: items.length };
}

function isArxivDoi(doi?: string): boolean {
	return Boolean(doi && /^10\.48550\/arxiv\./i.test(doi));
}

const ARTIFACT_LANDING_HOST_RE =
	/(?:zenodo\.org\/(?:record|records|doi)|figshare\.com|osf\.io|codeocean\.com|dataverse\.|datadryad\.org)/i;

function isArtifactChannelItem(item: {
	doi?: string;
	url?: string;
	pdfUrl?: string;
}): boolean {
	if (isArtifactOrDatasetDoi(item.doi)) return true;
	const combined = `${item.url ?? ""} ${item.pdfUrl ?? ""}`;
	return ARTIFACT_LANDING_HOST_RE.test(combined);
}

function pickPreferredDoi(
	a: string | undefined,
	b: string | undefined,
): string | undefined {
	const cleanA = a && !isArtifactOrDatasetDoi(a) ? a : undefined;
	const cleanB = b && !isArtifactOrDatasetDoi(b) ? b : undefined;
	if (cleanA && !isArxivDoi(cleanA)) return cleanA;
	if (cleanB && !isArxivDoi(cleanB)) return cleanB;
	return cleanA || cleanB;
}

function dedupeVenueChannelItems(
	groups: readonly CollectionPaperItem[][],
): CollectionPaperItem[] {
	const byId = new Map<string, CollectionPaperItem>();
	const doiToId = new Map<string, string>();
	const titleToId = new Map<string, string>();

	for (const group of groups) {
		for (const item of group) {
			if (isFrontmatterTitle(item.title) || isArtifactChannelItem(item)) {
				continue;
			}
			const normDoi =
				item.doi && !isArxivDoi(item.doi) ? item.doi.toLowerCase() : "";
			const normTitle = item.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
			const existingId = byId.has(item.id)
				? item.id
				: normDoi && doiToId.has(normDoi)
					? doiToId.get(normDoi)
					: normTitle
						? titleToId.get(normTitle)
						: undefined;
			if (!existingId) {
				byId.set(item.id, item);
				if (normDoi) doiToId.set(normDoi, item.id);
				if (normTitle) titleToId.set(normTitle, item.id);
				continue;
			}
			const prev = byId.get(existingId);
			if (!prev) continue;
			const mergedDoi = pickPreferredDoi(prev.doi, item.doi);
			const mergedKw = mergeKeywordMetadata(
				prev.keywords,
				prev.keywordSource,
				item.keywords,
				item.keywordSource,
			);
			const mergedOaId =
				normalizeOpenAlexId(prev.openalexId) ||
				normalizeOpenAlexId(item.openalexId);
			const mergedRefs = normalizeRawRefs([
				...(prev.rawRefs ?? []),
				...(item.rawRefs ?? []),
			]);
			byId.set(existingId, {
				...prev,
				abstract:
					prev.abstract.length >= item.abstract.length
						? prev.abstract
						: item.abstract,
				doi: mergedDoi,
				arxivId: prev.arxivId || item.arxivId,
				pdfUrl: prev.pdfUrl || item.pdfUrl,
				coolPapersId: prev.coolPapersId || item.coolPapersId,
				volume: prev.volume || item.volume,
				issue: prev.issue || item.issue,
				pages: prev.pages || item.pages,
				venueFull: prev.venueFull || item.venueFull,
				publishedAt:
					pickEarliestPublishedAt(prev.publishedAt, item.publishedAt) ||
					prev.publishedAt,
				citationCount: Math.max(
					prev.citationCount ?? 0,
					item.citationCount ?? 0,
				),
				keywords: mergedKw.keywords,
				...(mergedKw.keywordSource
					? { keywordSource: mergedKw.keywordSource }
					: {}),
				...(mergedOaId ? { openalexId: mergedOaId } : {}),
				...(mergedRefs ? { rawRefs: mergedRefs } : {}),
				categories: Array.from(
					new Set([...prev.categories, ...item.categories]),
				),
			});
			if (mergedDoi && !isArxivDoi(mergedDoi)) {
				doiToId.set(mergedDoi.toLowerCase(), existingId);
			}
		}
	}

	return Array.from(byId.values()).sort((a, b) =>
		b.publishedAt.localeCompare(a.publishedAt),
	);
}

/**
 * Backfill missing abstracts, arXiv preprint links, PDF URLs, and citation counts onto an
 * authoritative proceedings paper list without adding unmatched noisy rows.
 */
export function backfillMissingMetadataFromChannel(
	primaryItems: readonly CollectionPaperItem[],
	supplementItems: readonly CollectionPaperItem[],
): CollectionPaperItem[] {
	if (primaryItems.length === 0 || supplementItems.length === 0) {
		return [...primaryItems];
	}
	const suppByDoi = new Map<string, CollectionPaperItem>();
	const suppByTitle = new Map<string, CollectionPaperItem>();
	for (const s of supplementItems) {
		if (isFrontmatterTitle(s.title) || isArtifactChannelItem(s)) {
			continue;
		}
		if (s.doi && !isArxivDoi(s.doi)) {
			suppByDoi.set(s.doi.toLowerCase(), s);
		}
		const tk = s.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
		if (tk) {
			const prev = suppByTitle.get(tk);
			if (!prev || s.abstract.length > prev.abstract.length) {
				suppByTitle.set(tk, s);
			}
		}
	}

	return primaryItems.map((item) => {
		const itemClean = isArtifactChannelItem(item)
			? { ...item, doi: undefined, abstract: "" }
			: item;
		const tk = itemClean.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
		const match =
			(itemClean.doi && !isArxivDoi(itemClean.doi)
				? suppByDoi.get(itemClean.doi.toLowerCase())
				: undefined) ?? (tk ? suppByTitle.get(tk) : undefined);
		if (!match) return itemClean;
		const bestAbstract =
			itemClean.abstract.length >= match.abstract.length
				? itemClean.abstract
				: match.abstract;
		const bestArxivId = itemClean.arxivId || match.arxivId;
		const bestDoi = pickPreferredDoi(itemClean.doi, match.doi);
		const mergedKw = mergeKeywordMetadata(
			itemClean.keywords,
			itemClean.keywordSource,
			match.keywords,
			match.keywordSource,
		);
		const mergedOaId =
			normalizeOpenAlexId(itemClean.openalexId) ||
			normalizeOpenAlexId(match.openalexId);
		const mergedRefs = normalizeRawRefs([
			...(itemClean.rawRefs ?? []),
			...(match.rawRefs ?? []),
		]);
		return {
			...itemClean,
			abstract: bestAbstract,
			publishedAt:
				pickEarliestPublishedAt(itemClean.publishedAt, match.publishedAt) ||
				itemClean.publishedAt,
			doi: bestDoi,
			arxivId: bestArxivId,
			coolPapersId: itemClean.coolPapersId || match.coolPapersId,
			pdfUrl:
				itemClean.pdfUrl ||
				match.pdfUrl ||
				(bestArxivId ? `https://arxiv.org/pdf/${bestArxivId}.pdf` : undefined),
			citationCount: Math.max(
				itemClean.citationCount ?? 0,
				match.citationCount ?? 0,
			),
			keywords: mergedKw.keywords,
			...(mergedKw.keywordSource
				? { keywordSource: mergedKw.keywordSource }
				: {}),
			...(mergedOaId ? { openalexId: mergedOaId } : {}),
			...(mergedRefs ? { rawRefs: mergedRefs } : {}),
		};
	});
}

type ExistingVenueLookup = {
	completeItems: CollectionPaperItem[];
	findMatch: (item: CollectionPaperItem) => {
		matched: CollectionPaperItem | undefined;
		isComplete: boolean;
	};
};

function normVenueTitleKey(title: string): string {
	return title
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function stripVenueArxivVersion(raw: string | undefined | null): string {
	if (!raw) return "";
	return raw
		.trim()
		.replace(/^arxiv:/i, "")
		.replace(/v\d+$/i, "")
		.toLowerCase();
}

function buildExistingVenueLookup(
	existingItems: readonly CollectionPaperItem[] | undefined,
	venueName: string,
): ExistingVenueLookup {
	const existingList: CollectionPaperItem[] = [];
	const byId = new Map<string, CollectionPaperItem>();
	const byDoi = new Map<string, CollectionPaperItem>();
	const byArxiv = new Map<string, CollectionPaperItem>();
	const byTitle = new Map<string, CollectionPaperItem>();
	const completeItems: CollectionPaperItem[] = [];

	const isComplete = (item: CollectionPaperItem): boolean =>
		!isArtifactChannelItem(item) && isPaperMetadataComplete(item, venueName);

	for (const rawEx of existingItems ?? []) {
		if (!rawEx || isFrontmatterTitle(rawEx.title)) continue;
		const ex: CollectionPaperItem = isArtifactChannelItem(rawEx)
			? {
					...rawEx,
					doi: undefined,
					abstract: "",
					pdfUrl: rawEx.arxivId
						? `https://arxiv.org/pdf/${rawEx.arxivId}.pdf`
						: undefined,
				}
			: rawEx;
		existingList.push(ex);
		if (isComplete(ex)) {
			completeItems.push(ex);
		}
		if (ex.id) byId.set(ex.id, ex);
		const d = cleanDoi(ex.doi)?.toLowerCase();
		if (d && !isArxivDoi(d) && !isArtifactOrDatasetDoi(d)) byDoi.set(d, ex);
		const aid = stripVenueArxivVersion(ex.arxivId);
		if (aid) byArxiv.set(aid, ex);
		const tk = normVenueTitleKey(ex.title);
		if (tk && !byTitle.has(tk)) byTitle.set(tk, ex);
	}

	return {
		completeItems,
		findMatch: (item) => {
			const d = cleanDoi(item.doi)?.toLowerCase();
			const aid = stripVenueArxivVersion(item.arxivId);
			const tk = normVenueTitleKey(item.title);
			const titleMatch = tk ? byTitle.get(tk) : undefined;
			let matched =
				byId.get(item.id) ??
				(d && !isArxivDoi(d) ? byDoi.get(d) : undefined) ??
				(aid ? byArxiv.get(aid) : undefined) ??
				(titleMatch && !hasDistinctPublisherDoi(item.doi, titleMatch.doi)
					? titleMatch
					: undefined);
			if (!matched && existingList.length > 0 && item.authors.length > 0) {
				let bestScore = 0;
				for (const ex of existingList) {
					if (hasDistinctPublisherDoi(item.doi, ex.doi)) continue;
					const res = scoreCameraReadyCandidateMatch(
						item.title,
						item.authors,
						ex.title,
						ex.authors,
					);
					if (res.matched && res.score > bestScore) {
						bestScore = res.score;
						matched = ex;
					}
				}
			}
			return {
				matched,
				isComplete: Boolean(matched && isComplete(matched)),
			};
		},
	};
}

function mergeExistingIntoFreshVenueItem(
	fresh: CollectionPaperItem,
	existing: CollectionPaperItem,
	venue: VenueConfig,
): CollectionPaperItem {
	const existingClean: CollectionPaperItem = isArtifactChannelItem(existing)
		? {
				...existing,
				doi: undefined,
				abstract: "",
				pdfUrl: existing.arxivId
					? `https://arxiv.org/pdf/${existing.arxivId}.pdf`
					: undefined,
			}
		: existing;
	const freshPlaceholder = isPlaceholderAbstract(fresh.abstract, venue.name);
	const exPlaceholder = isPlaceholderAbstract(
		existingClean.abstract,
		venue.name,
	);
	const bestAbstract =
		freshPlaceholder && !exPlaceholder
			? existingClean.abstract
			: !freshPlaceholder && exPlaceholder
				? fresh.abstract
				: fresh.abstract.length >= existingClean.abstract.length
					? fresh.abstract
					: existingClean.abstract;
	const bestDoi = pickPreferredDoi(fresh.doi, existingClean.doi);
	const bestArxivId = fresh.arxivId || existingClean.arxivId;
	const bestPublishedAt =
		pickEarliestPublishedAt(fresh.publishedAt, existingClean.publishedAt) ||
		fresh.publishedAt ||
		existingClean.publishedAt;

	const bestTitle =
		existingClean.title &&
		existingClean.doi &&
		!isArxivDoi(existingClean.doi) &&
		!isArtifactOrDatasetDoi(existingClean.doi) &&
		(!fresh.doi || isArxivDoi(fresh.doi) || isArtifactOrDatasetDoi(fresh.doi))
			? existingClean.title
			: fresh.title;
	const mergedKw = mergeKeywordMetadata(
		fresh.keywords,
		fresh.keywordSource,
		existingClean.keywords,
		existingClean.keywordSource,
	);
	const mergedOaId =
		normalizeOpenAlexId(fresh.openalexId) ||
		normalizeOpenAlexId(existingClean.openalexId);
	const mergedRefs = normalizeRawRefs([
		...(fresh.rawRefs ?? []),
		...(existingClean.rawRefs ?? []),
	]);

	return {
		...fresh,
		id: buildVenuePaperId(venue.id, bestDoi, bestArxivId, bestTitle),
		title: bestTitle,
		abstract: isPlaceholderAbstract(bestAbstract, venue.name)
			? ""
			: bestAbstract,
		publishedAt: bestPublishedAt,
		doi: bestDoi,
		arxivId: bestArxivId,
		pdfUrl:
			fresh.pdfUrl ||
			existingClean.pdfUrl ||
			(bestArxivId ? `https://arxiv.org/pdf/${bestArxivId}.pdf` : undefined),
		coolPapersId: fresh.coolPapersId || existingClean.coolPapersId,
		volume: fresh.volume || existingClean.volume,
		issue: fresh.issue || existingClean.issue,
		pages: fresh.pages || existingClean.pages,
		bibtex: fresh.bibtex || existingClean.bibtex,
		...(fresh.recommendedAt || existingClean.recommendedAt
			? { recommendedAt: fresh.recommendedAt || existingClean.recommendedAt }
			: {}),
		venueFull:
			fresh.venueFull && fresh.venueFull !== venue.name
				? fresh.venueFull
				: existingClean.venueFull || fresh.venueFull,
		citationCount: Math.max(
			fresh.citationCount ?? 0,
			existing.citationCount ?? 0,
		),
		keywords: mergedKw.keywords,
		...(mergedKw.keywordSource
			? { keywordSource: mergedKw.keywordSource }
			: {}),
		...(mergedOaId ? { openalexId: mergedOaId } : {}),
		...(mergedRefs ? { rawRefs: mergedRefs } : {}),
	};
}

function reconcileFreshWithExisting(
	freshItems: readonly CollectionPaperItem[],
	existingLookup: ExistingVenueLookup,
	venue: VenueConfig,
): {
	items: CollectionPaperItem[];
	incompleteOrNewIndices: number[];
} {
	const items: CollectionPaperItem[] = [];
	const incompleteOrNewIndices: number[] = [];

	for (let i = 0; i < freshItems.length; i++) {
		const fresh = freshItems[i];
		if (!fresh) continue;
		const { matched, isComplete } = existingLookup.findMatch(fresh);
		const merged = matched
			? mergeExistingIntoFreshVenueItem(fresh, matched, venue)
			: fresh;
		items.push(merged);
		if (!isComplete && !isPaperMetadataComplete(merged, venue.name)) {
			incompleteOrNewIndices.push(items.length - 1);
		}
	}

	return { items, incompleteOrNewIndices };
}

async function enrichSubsetInPlace(
	items: CollectionPaperItem[],
	targetIndices: readonly number[],
	venue: VenueConfig,
	fetchJson: FetchJsonFn,
	preloadedItems?: readonly CollectionPaperItem[],
	options?: {
		skipTitleSearch?: boolean;
		signal?: AbortSignal;
		onProgress?: (progress: { completed?: number; total?: number }) => void;
	},
): Promise<CollectionPaperItem[]> {
	if (targetIndices.length === 0) return items;
	const subset = targetIndices
		.map((idx) => items[idx])
		.filter((x): x is CollectionPaperItem => Boolean(x));
	if (subset.length === 0) return items;

	const enrichedSubset = await enrichVenueItemsBatch(
		subset,
		venue,
		fetchJson,
		preloadedItems,
		{
			...(options?.skipTitleSearch ? { skipTitleSearch: true } : {}),
			signal: options?.signal,
			onProgress: options?.onProgress,
		},
	);
	const next = [...items];
	if (enrichedSubset.length === targetIndices.length) {
		for (let k = 0; k < targetIndices.length; k++) {
			const targetIdx = targetIndices[k];
			const enrichedItem = enrichedSubset[k];
			if (targetIdx !== undefined && enrichedItem) {
				next[targetIdx] = enrichedItem;
			}
		}
		return next;
	}
	return backfillMissingMetadataFromChannel(next, enrichedSubset);
}

async function backfillMissingVenueKeywordsWithKeywordLlm(
	items: CollectionPaperItem[],
	options?: {
		keywordLlmFetch?: typeof fetch;
		signal?: AbortSignal;
		onProgress?: (progress: { completed?: number; total?: number }) => void;
	},
): Promise<CollectionPaperItem[]> {
	const missingIndices: number[] = [];
	for (let idx = 0; idx < items.length; idx++) {
		if (normalizePaperKeywords(items[idx]?.keywords).length === 0) {
			missingIndices.push(idx);
		}
	}
	if (missingIndices.length === 0) return items;

	const batchInputs = missingIndices
		.map((idx) => items[idx])
		.filter((x): x is CollectionPaperItem => Boolean(x))
		.map((p) => ({
			id: p.id,
			title: p.title,
			abstract: p.abstract,
		}));
	if (batchInputs.length === 0) return items;

	const extracted = await extractKeywordsWithKeywordLlmBatch(batchInputs, {
		fetchFn: options?.keywordLlmFetch,
		signal: options?.signal,
		onProgress: (completed, total) =>
			options?.onProgress?.({ completed, total }),
	});
	if (extracted.size === 0) return items;

	const next = [...items];
	for (const idx of missingIndices) {
		const item = next[idx];
		if (!item) continue;
		const llmKws = normalizePaperKeywords(extracted.get(item.id), 8);
		if (llmKws.length > 0) {
			next[idx] = {
				...item,
				keywords: llmKws,
				keywordSource: "client_llm",
			};
		}
	}
	return next;
}

/**
 * Reconcile freshly extracted custom / Agent venue items against cached SQLite rows,
 * enriching only items missing core metadata via OpenAlex and running Keyword LLM fallback.
 */
export async function finalizeVenuePapersWithSmartDiff(
	freshItems: readonly CollectionPaperItem[],
	venue: VenueConfig,
	fetchJson: FetchJsonFn,
	options?: {
		existingItems?: readonly CollectionPaperItem[];
		keywordLlmFetch?: typeof fetch;
		signal?: AbortSignal;
		onProgress?: (progress: { completed?: number; total?: number }) => void;
	},
): Promise<CollectionPaperItem[]> {
	if (freshItems.length === 0) return [];
	const existingLookup = buildExistingVenueLookup(
		options?.existingItems,
		venue.name,
	);
	const reconciled = reconcileFreshWithExisting(
		freshItems,
		existingLookup,
		venue,
	);
	const openAlexTargetIndices = reconciled.incompleteOrNewIndices.filter(
		(idx) => {
			const p = reconciled.items[idx];
			return Boolean(
				p &&
					(isPlaceholderAbstract(p.abstract, venue.name) ||
						(!p.doi && !p.arxivId)),
			);
		},
	);
	const enriched = await enrichSubsetInPlace(
		reconciled.items,
		openAlexTargetIndices,
		venue,
		fetchJson,
		existingLookup.completeItems,
		{
			signal: options?.signal,
			onProgress: options?.onProgress,
		},
	);
	return backfillMissingVenueKeywordsWithKeywordLlm(enriched, {
		keywordLlmFetch: options?.keywordLlmFetch,
		signal: options?.signal,
		onProgress: options?.onProgress,
	});
}

/**
 * Match publisher metadata (`CSDL` / `DataCite` / `OpenAlex` / `Crossref`) onto an
 * authoritative Main / Research / Technical Track roster (`conf.researchr.org`),
 * discarding all non-roster combined-volume papers while tolerating minor camera-ready
 * title edits (`Modeling` <-> `Modelling`, subtitle tweaks) when an author surname matches.
 */
async function mergePublisherIntoTrackRoster(
	rosterItems: readonly CollectionPaperItem[],
	publisherItems: readonly CollectionPaperItem[],
	venue: VenueConfig,
	fetchJson: FetchJsonFn,
	options?: {
		openAlexHydrated?: boolean;
		skipTitleSearch?: boolean;
		existingLookup?: ExistingVenueLookup;
		signal?: AbortSignal;
	},
): Promise<CollectionPaperItem[]> {
	throwIfAborted(options?.signal);
	if (rosterItems.length === 0) return [];

	const pubList = [...publisherItems];
	const pubByDoi = new Map<string, number>();
	const pubByNormTitle = new Map<string, number>();

	for (let i = 0; i < pubList.length; i++) {
		const p = pubList[i];
		if (!p || isFrontmatterTitle(p.title) || isArtifactChannelItem(p)) continue;
		if (p.doi && !isArxivDoi(p.doi)) {
			pubByDoi.set(p.doi.toLowerCase(), i);
		}
		const tk = normVenueTitleKey(p.title);
		if (tk && !pubByNormTitle.has(tk)) {
			pubByNormTitle.set(tk, i);
		}
	}

	const usedPubIndices = new Set<number>();
	const matchedPubIdx = new Array<number | undefined>(rosterItems.length).fill(
		undefined,
	);

	// Pass 1: claim all exact DOI / diacritic-normalized title hits first so fuzzy passes never steal exact matches.
	for (let rIdx = 0; rIdx < rosterItems.length; rIdx++) {
		const r = rosterItems[rIdx];
		if (!r) continue;
		let matchedIdx: number | undefined;
		if (r.doi && !isArxivDoi(r.doi)) {
			matchedIdx = pubByDoi.get(r.doi.toLowerCase());
		}
		if (matchedIdx === undefined || usedPubIndices.has(matchedIdx)) {
			const normTitle = normVenueTitleKey(r.title);
			if (normTitle) {
				matchedIdx = pubByNormTitle.get(normTitle);
			}
		}
		if (matchedIdx !== undefined && !usedPubIndices.has(matchedIdx)) {
			matchedPubIdx[rIdx] = matchedIdx;
			usedPubIndices.add(matchedIdx);
		}
	}

	// Pass 2: match camera-ready title revisions (e.g. DataCite LIPIcs / CSDL / OpenAlex) by author-team overlap + title kinship.
	const fuzzyPairs: Array<{ rIdx: number; pIdx: number; score: number }> = [];
	for (let rIdx = 0; rIdx < rosterItems.length; rIdx++) {
		if (matchedPubIdx[rIdx] !== undefined) continue;
		const r = rosterItems[rIdx];
		if (!r || r.authors.length === 0) continue;
		for (let pIdx = 0; pIdx < pubList.length; pIdx++) {
			if (usedPubIndices.has(pIdx)) continue;
			const p = pubList[pIdx];
			if (!p || p.authors.length === 0) continue;
			if (hasDistinctPublisherDoi(r.doi, p.doi)) continue;
			const res = scoreCameraReadyCandidateMatch(
				r.title,
				r.authors,
				p.title,
				p.authors,
			);
			if (res.matched) {
				fuzzyPairs.push({ rIdx, pIdx, score: res.score });
			}
		}
	}
	fuzzyPairs.sort((a, b) => b.score - a.score);
	for (const pair of fuzzyPairs) {
		if (
			matchedPubIdx[pair.rIdx] !== undefined ||
			usedPubIndices.has(pair.pIdx)
		) {
			continue;
		}
		matchedPubIdx[pair.rIdx] = pair.pIdx;
		usedPubIndices.add(pair.pIdx);
	}

	const merged: CollectionPaperItem[] = [];
	const unmatchedIndices: number[] = [];

	for (let rIdx = 0; rIdx < rosterItems.length; rIdx++) {
		const r = rosterItems[rIdx];
		if (!r) continue;
		const matchedIdx = matchedPubIdx[rIdx];
		if (matchedIdx !== undefined) {
			const pub = pubList[matchedIdx];
			if (pub) {
				const bestDoi = pickPreferredDoi(pub.doi, r.doi);
				const bestArxivId = pub.arxivId || r.arxivId;
				const bestTitle = pub.title || r.title;
				const bestAbstract =
					pub.abstract.length >= r.abstract.length ? pub.abstract : r.abstract;
				const mergedKw = mergeKeywordMetadata(
					pub.keywords,
					pub.keywordSource,
					r.keywords,
					r.keywordSource,
				);
				const mergedOaId =
					normalizeOpenAlexId(pub.openalexId) ||
					normalizeOpenAlexId(r.openalexId);
				const mergedRefs = normalizeRawRefs([
					...(pub.rawRefs ?? []),
					...(r.rawRefs ?? []),
				]);
				let candidate: CollectionPaperItem = {
					...r,
					id: buildVenuePaperId(venue.id, bestDoi, bestArxivId, bestTitle),
					title: bestTitle,
					authors: pub.authors.length > 0 ? pub.authors : r.authors,
					abstract: bestAbstract,
					publishedAt:
						pickEarliestPublishedAt(pub.publishedAt, r.publishedAt) ||
						r.publishedAt,
					url: bestDoi ? `https://doi.org/${bestDoi}` : pub.url || r.url,
					pdfUrl:
						pub.pdfUrl ||
						r.pdfUrl ||
						(bestArxivId
							? `https://arxiv.org/pdf/${bestArxivId}.pdf`
							: undefined),
					arxivId: bestArxivId,
					doi: bestDoi,
					volume: pub.volume || r.volume,
					issue: pub.issue || r.issue,
					pages: pub.pages || r.pages,
					venueFull: pub.venueFull || r.venueFull,
					citationCount: Math.max(pub.citationCount ?? 0, r.citationCount ?? 0),
					keywords: mergedKw.keywords,
					...(mergedKw.keywordSource
						? { keywordSource: mergedKw.keywordSource }
						: {}),
					...(mergedOaId ? { openalexId: mergedOaId } : {}),
					...(mergedRefs ? { rawRefs: mergedRefs } : {}),
				};
				const exHit = options?.existingLookup?.findMatch(candidate);
				if (exHit?.matched) {
					candidate = mergeExistingIntoFreshVenueItem(
						candidate,
						exHit.matched,
						venue,
					);
				}
				merged.push(candidate);
				if (
					!exHit?.isComplete &&
					!isPaperMetadataComplete(candidate, venue.name) &&
					(isPlaceholderAbstract(candidate.abstract, venue.name) ||
						!candidate.doi)
				) {
					unmatchedIndices.push(merged.length - 1);
				}
				continue;
			}
		}

		const exRosterHit = options?.existingLookup?.findMatch(r);
		const fallbackItem = exRosterHit?.matched
			? mergeExistingIntoFreshVenueItem(r, exRosterHit.matched, venue)
			: r;
		merged.push(fallbackItem);
		if (
			!exRosterHit?.isComplete &&
			!isPaperMetadataComplete(fallbackItem, venue.name) &&
			(isPlaceholderAbstract(fallbackItem.abstract, venue.name) ||
				!fallbackItem.doi)
		) {
			unmatchedIndices.push(merged.length - 1);
		}
	}

	if (unmatchedIndices.length > 0) {
		const subset = unmatchedIndices
			.map((idx) => merged[idx])
			.filter((x): x is CollectionPaperItem => Boolean(x));
		const enrichedSubset = await enrichVenueItemsBatch(
			subset,
			venue,
			fetchJson,
			options?.existingLookup?.completeItems.length
				? [...pubList, ...options.existingLookup.completeItems]
				: pubList,
			{
				signal: options?.signal,
				...(options?.skipTitleSearch ? { skipTitleSearch: true } : {}),
			},
		);
		for (let k = 0; k < unmatchedIndices.length; k++) {
			const targetIdx = unmatchedIndices[k];
			const enrichedItem = enrichedSubset[k];
			if (targetIdx !== undefined && enrichedItem) {
				merged[targetIdx] = enrichedItem;
			}
		}
	}

	return merged;
}

/**
 * Fetch USENIX presentation detail subpages politely (`concurrency: 6`, per-page error tolerant)
 * for items still lacking an abstract after `technical-sessions` + `papers.cool` hydration.
 */
async function hydrateUsenixPresentationSubpages(
	items: readonly CollectionPaperItem[],
	venue: VenueConfig,
	fetchText: FetchTextFn,
	options?: {
		concurrency?: number;
		signal?: AbortSignal;
		onProgress?: (progress: { completed?: number; total?: number }) => void;
	},
): Promise<CollectionPaperItem[]> {
	const targetIndices: number[] = [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (!item) continue;
		if (
			isPlaceholderAbstract(item.abstract, venue.name) &&
			/\/conference\/usenixsecurity\d+\/presentation\//i.test(item.url)
		) {
			targetIndices.push(i);
		}
	}
	if (targetIndices.length === 0) return [...items];

	const next = [...items];
	const workerCount = Math.min(
		Math.max(1, options?.concurrency ?? 6),
		targetIndices.length,
	);
	let cursor = 0;
	let completed = 0;

	const worker = async () => {
		while (cursor < targetIndices.length) {
			throwIfAborted(options?.signal);
			const idx = targetIndices[cursor];
			cursor += 1;
			if (idx === undefined) continue;
			const item = next[idx];
			if (!item) continue;
			try {
				const html = await fetchText(
					item.url,
					"text/html,application/xhtml+xml,*/*",
				);
				const parsed = parseUsenixPresentationHtml(html, item.url);
				const cleanAbs =
					parsed.abstract && !isPlaceholderAbstract(parsed.abstract, venue.name)
						? parsed.abstract
						: item.abstract;
				const bestPdf = item.pdfUrl || parsed.pdfUrl;
				if (cleanAbs !== item.abstract || bestPdf !== item.pdfUrl) {
					next[idx] = {
						...item,
						abstract: cleanAbs,
						...(bestPdf ? { pdfUrl: bestPdf } : {}),
					};
				}
			} catch (err) {
				if (
					options?.signal?.aborted ||
					(err instanceof Error && err.name === "AbortError")
				) {
					throw err;
				}
				// Per-page error tolerant: leave partial metadata intact.
			} finally {
				completed += 1;
				options?.onProgress?.({ completed, total: targetIndices.length });
			}
		}
	};

	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return next;
}

/**
 * Fetch complete, multi-page 2026 venue papers (strict Main / Research / Technical Track):
 * 0. Curated `papers.cool` primary channel whenever `coolPapersVenueSlug` is configured
 *    (`AAAI`, `ACL`, `ICLR`, `ICML`, `NeurIPS`, `USENIX Sec`, `NDSS`), falling back cleanly
 *    to official channels when unavailable, unindexed (`NeurIPS 2026`), or returning `< 100` items.
 * 1. Strict Official Track Roster (`trackRosterMode: "required"`: `NDSS`, `CCS`, `SAS`, `ASE`,
 *    `ICPC`, `RE`, `SANER`, `ICSME`, `ESEM`) intersected with OpenAlex / CSDL / DataCite / `papers.cool`.
 * 2. Official MiniConf Virtual JSON (`NeurIPS`, `ICLR`, `ICML`), Official ACL Anthology + `aclweb`,
 *    and USENIX Security `technical-sessions` (+ `papers.cool` & polite presentation subpages).
 * 3. Publisher proceedings & journals (`ICSE`, `ISSTA`, `FSE`, `PLDI`, `POPL`, `OOPSLA`, `ECOOP`,
 *    `S&P`, `TSE`, `TOSEM`, `ASE (J)`, `ESE`) with strict issue/DOI/frontmatter/artifact filtering.
 * 4. Official conference accepted-papers fallback (`ISSRE 2026`, `S&P 2026`), Springer HTML
 *    abstract backfill (`#Abs1-content`), Smart Diff against `existingItems`, and Keyword LLM fallback.
 */
export async function fetchMultiChannelVenuePapers(
	venue: VenueConfig,
	year: number,
	rawFetchJson: FetchJsonFn,
	rawFetchText: FetchTextFn,
	options?: {
		maxPages?: number;
		skipTitleSearch?: boolean;
		existingItems?: readonly CollectionPaperItem[];
		keywordLlmFetch?: typeof fetch;
		signal?: AbortSignal;
		onProgress?: (progress: { completed?: number; total?: number }) => void;
	},
): Promise<{
	items: CollectionPaperItem[];
	remoteTotalCount: number;
	latestPublishedAt: string | null;
	authoritativeMainTrack: boolean;
}> {
	throwIfAborted(options?.signal);
	let requestCount = 0;
	let lastError: unknown = null;
	const politeFetchJson = createPoliteFetchJson(rawFetchJson, options?.signal);
	const politeFetchText = createPoliteFetchText(rawFetchText, options?.signal);

	const fetchJson: FetchJsonFn = async <T = unknown>(
		url: string,
	): Promise<T> => {
		throwIfAborted(options?.signal);
		requestCount += 1;
		try {
			return await politeFetchJson<T>(url);
		} catch (err) {
			lastError = err;
			throw err;
		}
	};

	const fetchText: FetchTextFn = async (
		url: string,
		accept?: string,
	): Promise<string> => {
		throwIfAborted(options?.signal);
		requestCount += 1;
		try {
			return await politeFetchText(url, accept);
		} catch (err) {
			lastError = err;
			throw err;
		}
	};
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const maxPages = options?.maxPages ?? 25;
	const existingLookup = buildExistingVenueLookup(
		options?.existingItems,
		venue.name,
	);

	let coolRes: { items: CollectionPaperItem[]; remoteTotalCount: number } = {
		items: [],
		remoteTotalCount: 0,
	};
	let coolFetched = false;
	const ensureCoolRes = async (coolOpts?: {
		maxPages?: number;
		pageSize?: number;
	}) => {
		if (!coolFetched && spec?.coolPapersVenueSlug) {
			coolFetched = true;
			const prevErr = lastError;
			try {
				coolRes = await fetchCoolPapersVenuePapers(
					venue,
					year,
					fetchText,
					coolOpts,
				);
			} catch (err) {
				if (options?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
					throw err;
				}
				// Graceful fallback when papers.cool is unindexed (404), unavailable, or truncated mid-pagination.
				coolRes = { items: [], remoteTotalCount: 0 };
				if (lastError === prevErr && err instanceof Error) {
					lastError = err;
				}
			}
		}
		return coolRes;
	};

	let primaryItems: CollectionPaperItem[] = [];
	let structuredRemoteTotal = 0;
	let authoritativeMainTrack = false;
	let authoritativeViaRoster = false;
	let aclAcceptedRoster: CollectionPaperItem[] = [];
	let handledPrimary = false;

	// Tier 0: Curated papers.cool venue list first whenever configured (`AAAI`, `ACL`, `ICLR`, `ICML`,
	// `NeurIPS`, `USENIX Sec`, `NDSS`) — falls back cleanly to official channels when <100 or unavailable.
	if (spec?.coolPapersVenueSlug) {
		await ensureCoolRes();
		if (coolRes.items.length >= 100) {
			const reconciled = reconcileFreshWithExisting(
				dedupeVenueChannelItems([coolRes.items]),
				existingLookup,
				venue,
			);
			primaryItems = reconciled.items;
			authoritativeMainTrack = true;
			handledPrimary = true;
		}
	}

	// Tier A: Strict authoritative main-track roster required (`NDSS`, `CCS`, `SAS`, `ASE`, `ICPC`, `RE`, `SANER`, `ICSME`, `ESEM`)
	if (!handledPrimary && spec?.trackRosterMode === "required") {
		const roster = await fetchOfficialTrackRoster(venue, year, fetchText);
		const rosterReconciled = reconcileFreshWithExisting(
			roster.items,
			existingLookup,
			venue,
		);
		if (
			roster.items.length > 0 &&
			rosterReconciled.incompleteOrNewIndices.length === 0
		) {
			primaryItems = rosterReconciled.items;
		} else {
			const csdlRes = spec.csdlIdPrefix
				? await fetchCsdlVenuePapers(venue, year, fetchJson)
				: { items: [], remoteTotalCount: 0 };
			const dataciteRes = spec.doiPrefixFilter
				?.toLowerCase()
				.startsWith("10.4230/")
				? await fetchDataCiteLipicsPapers(venue, year, fetchJson)
				: { items: [], remoteTotalCount: 0 };
			const optionalCool = spec.coolPapersVenueSlug
				? await ensureCoolRes()
				: { items: [], remoteTotalCount: 0 };
			const directPublisherItems = dedupeVenueChannelItems([
				csdlRes.items,
				dataciteRes.items,
			]);
			const structuredRan = directPublisherItems.length < roster.items.length;
			const structured = !structuredRan
				? { items: [], remoteTotalCount: directPublisherItems.length }
				: await fetchVenueStructuredPapers(venue, year, fetchJson, {
						maxPages,
						preloadedItems: existingLookup.completeItems,
						signal: options?.signal,
						onProgress: options?.onProgress,
					});
			primaryItems = await mergePublisherIntoTrackRoster(
				roster.items,
				dedupeVenueChannelItems([
					directPublisherItems,
					structured.items,
					optionalCool.items,
				]),
				venue,
				fetchJson,
				{
					openAlexHydrated: structuredRan,
					skipTitleSearch: options?.skipTitleSearch,
					existingLookup,
					signal: options?.signal,
				},
			);
		}
		structuredRemoteTotal = primaryItems.length;
		authoritativeMainTrack = true;
		authoritativeViaRoster = true;
		handledPrimary = true;
	}

	// Tier B: Official MiniConf (`neurips-2026`, `iclr-2026`, `icml-2026`) — graceful fallthrough to papers.cool when empty/unavailable
	if (!handledPrimary && spec?.miniConfSlug) {
		const prevErr = lastError;
		const miniConfRes = await fetchMiniConfVenuePapers(
			venue,
			year,
			fetchJson,
			options?.signal,
		);
		if (miniConfRes.items.length > 0) {
			primaryItems = reconcileFreshWithExisting(
				dedupeVenueChannelItems([miniConfRes.items]),
				existingLookup,
				venue,
			).items;
			structuredRemoteTotal = Math.max(
				primaryItems.length,
				miniConfRes.remoteTotalCount,
			);
			authoritativeMainTrack = true;
			authoritativeViaRoster = true;
			handledPrimary = true;
		} else {
			lastError = prevErr;
		}
	}

	// Tier C: Official ACL Anthology volumes + `aclweb.org/program/accepted_papers/` — graceful fallthrough to papers.cool when unavailable
	if (!handledPrimary && venue.id === "acl-2026") {
		const prevErr = lastError;
		const aclRes = await fetchAclAnthologyVenuePapers(
			venue,
			year,
			fetchText,
			options?.signal,
		);
		aclAcceptedRoster = aclRes.acceptedRoster;
		if (aclRes.items.length > 0) {
			primaryItems = reconcileFreshWithExisting(
				dedupeVenueChannelItems([aclRes.items]),
				existingLookup,
				venue,
			).items;
			structuredRemoteTotal = Math.max(
				primaryItems.length,
				aclRes.remoteTotalCount,
			);
			authoritativeMainTrack = true;
			authoritativeViaRoster = true;
			handledPrimary = true;
		} else {
			lastError = prevErr;
		}
	}

	// Tier D: USENIX Security `technical-sessions` + `existingLookup` + 1 optional `papers.cool` + concurrency-6 presentation subpages
	if (!handledPrimary && venue.id === "usenix-sec-2026") {
		const prevErr = lastError;
		const usenixRoster = await fetchOfficialVenueProgramPapers(
			venue,
			year,
			fetchText,
		);
		if (usenixRoster.items.length > 0) {
			let usenixItems = reconcileFreshWithExisting(
				dedupeVenueChannelItems([usenixRoster.items]),
				existingLookup,
				venue,
			).items;
			const needsCoolHydration = usenixItems.some(
				(p) => isPlaceholderAbstract(p.abstract, venue.name) || !p.pdfUrl,
			);
			if (needsCoolHydration && spec?.coolPapersVenueSlug) {
				try {
					const coolSupp = await ensureCoolRes();
					if (coolSupp.items.length > 0) {
						usenixItems = backfillMissingMetadataFromChannel(
							usenixItems,
							coolSupp.items,
						);
					}
				} catch (err) {
					if (options?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
						throw err;
					}
					// Optional `papers.cool` supplement; proceed with presentation subpages.
				}
			}
			usenixItems = await hydrateUsenixPresentationSubpages(
				usenixItems,
				venue,
				fetchText,
				{
					concurrency: 6,
					signal: options?.signal,
					onProgress: options?.onProgress,
				},
			);
			primaryItems = usenixItems;
			structuredRemoteTotal = primaryItems.length;
			authoritativeMainTrack = true;
			authoritativeViaRoster = true;
			handledPrimary = true;
		} else {
			lastError = prevErr;
		}
	}

	if (!handledPrimary) {
		// Publisher GraphQL / DataCite feeds + OpenAlex / Crossref structured proceedings & journals
		const csdlRes = spec?.csdlIdPrefix
			? await fetchCsdlVenuePapers(venue, year, fetchJson)
			: { items: [], remoteTotalCount: 0 };
		const dataciteRes = spec?.doiPrefixFilter
			?.toLowerCase()
			.startsWith("10.4230/")
			? await fetchDataCiteLipicsPapers(venue, year, fetchJson)
			: { items: [], remoteTotalCount: 0 };
		const directPublisherItems = dedupeVenueChannelItems([
			csdlRes.items,
			dataciteRes.items,
		]);

		const structuredRan = directPublisherItems.length < 25;
		const structured = !structuredRan
			? { items: [], remoteTotalCount: directPublisherItems.length }
			: await fetchVenueStructuredPapers(venue, year, fetchJson, {
					maxPages,
					preloadedItems: existingLookup.completeItems,
					signal: options?.signal,
					onProgress: options?.onProgress,
				});
		structuredRemoteTotal = Math.max(
			structured.remoteTotalCount ?? 0,
			csdlRes.remoteTotalCount,
			dataciteRes.remoteTotalCount,
		);

		const reconciled = reconcileFreshWithExisting(
			dedupeVenueChannelItems([
				directPublisherItems,
				structured.items,
				coolRes.items,
			]),
			existingLookup,
			venue,
		);
		primaryItems = reconciled.items;

		// When direct publisher feeds (`CSDL` / `DataCite`) skipped OpenAlex list pages,
		// enrich ONLY items still missing an abstract or publisher DOI — never re-query
		// OpenAlex for papers that already have publisher metadata + author keywords.
		const missingCoreMetadataIndices = reconciled.incompleteOrNewIndices.filter(
			(idx) => {
				const p = primaryItems[idx];
				return Boolean(
					p && (isPlaceholderAbstract(p.abstract, venue.name) || !p.doi),
				);
			},
		);
		if (!structuredRan && missingCoreMetadataIndices.length > 0) {
			primaryItems = await enrichSubsetInPlace(
				primaryItems,
				missingCoreMetadataIndices,
				venue,
				fetchJson,
				existingLookup.completeItems,
				{
					skipTitleSearch: options?.skipTitleSearch,
					signal: options?.signal,
					onProgress: options?.onProgress,
				},
			);
		}

		if (
			primaryItems.length > 0 &&
			(spec?.doiPrefixFilter ||
				spec?.doiPrefixFilters?.length ||
				spec?.crossrefIsbns?.length ||
				spec?.csdlIdPrefix ||
				spec?.pacmIssue ||
				spec?.kind === "journal")
		) {
			authoritativeMainTrack = true;
		}

		// Official accepted-papers track fallback when proceedings DOIs aren't minted yet (`ISSRE 2026`, `S&P 2026`, `ACL 2026` aclweb, or custom tracks)
		const hasTrackFallback =
			spec?.trackRosterMode === "fallback" ||
			(!spec && (venue.tracks?.length ?? 0) > 0) ||
			aclAcceptedRoster.length > 0;
		if (primaryItems.length < 25 && hasTrackFallback) {
			const officialRes =
				aclAcceptedRoster.length > 0
					? {
							items: aclAcceptedRoster,
							remoteTotalCount: aclAcceptedRoster.length,
						}
					: await fetchOfficialVenueProgramPapers(venue, year, fetchText);
			if (officialRes.items.length > 0) {
				const officialReconciled = reconcileFreshWithExisting(
					officialRes.items,
					existingLookup,
					venue,
				);
				let finalizedOfficial = officialReconciled.items;
				if (officialReconciled.incompleteOrNewIndices.length > 0) {
					const s2Supp = spec?.s2VenueNames?.length
						? await fetchSemanticScholarVenuePapers(venue, year, fetchJson, {
								maxPages: 3,
							})
						: { items: [], totalResults: 0 };
					const arxivSupp = spec?.arxivVenueAliases?.length
						? await fetchArxivAcceptedForVenue(venue, year, fetchText, {
								maxPages: 5,
							})
						: { items: [], totalResults: 0 };
					finalizedOfficial = await enrichSubsetInPlace(
						officialReconciled.items,
						officialReconciled.incompleteOrNewIndices,
						venue,
						fetchJson,
						[
							...structured.items,
							...s2Supp.items,
							...arxivSupp.items,
							...existingLookup.completeItems,
						],
						{
							skipTitleSearch: options?.skipTitleSearch,
							signal: options?.signal,
							onProgress: options?.onProgress,
						},
					);
				}
				primaryItems = dedupeVenueChannelItems([
					finalizedOfficial,
					primaryItems,
				]);
				authoritativeMainTrack = true;
			}
		}
	}

	// Targeted S2 Bulk abstract backfill (single page) only when >=15% of a non-Springer venue still lacks abstracts
	const missingAbstractCount = primaryItems.filter((p) => !p.abstract).length;
	const isAllSpringer =
		primaryItems.length > 0 &&
		primaryItems.every((p) => p.doi?.toLowerCase().startsWith("10.1007/"));
	if (
		primaryItems.length >= 20 &&
		!isAllSpringer &&
		missingAbstractCount >=
			Math.max(5, Math.ceil(primaryItems.length * 0.15)) &&
		spec?.s2VenueNames?.length
	) {
		const s2Backfill = await fetchSemanticScholarVenuePapers(
			venue,
			year,
			fetchJson,
			{
				maxPages: 1,
			},
		);
		if (s2Backfill.items.length > 0) {
			primaryItems = backfillMissingMetadataFromChannel(
				primaryItems,
				s2Backfill.items,
			);
		}
	}

	const hasAuthoritativeProceedingsFilter = Boolean(
		spec?.doiPrefixFilter ||
			spec?.doiPrefixFilters?.length ||
			spec?.crossrefIsbns?.length ||
			spec?.csdlIdPrefix ||
			spec?.pacmIssue ||
			spec?.kind === "journal",
	);

	// Tier 3: S2 Bulk + arXiv accepted metadata ONLY when official proceedings are not indexed yet (e.g. `NeurIPS 2026`),
	// never inflating already-resolved proceedings like `SAS 2026` (21 LNCS papers).
	const needEarlyPreprintChannels =
		!authoritativeMainTrack &&
		(primaryItems.length === 0 ||
			(!hasAuthoritativeProceedingsFilter && primaryItems.length < 25));

	let s2Items: CollectionPaperItem[] = [];
	let s2Total = 0;
	if (needEarlyPreprintChannels && spec?.s2VenueNames?.length) {
		const s2Res = await fetchSemanticScholarVenuePapers(
			venue,
			year,
			fetchJson,
			{
				maxPages: 5,
			},
		);
		s2Items = s2Res.items;
		s2Total = s2Res.totalResults;
	}

	let arxivVenueItems: CollectionPaperItem[] = [];
	let arxivTotal = 0;
	if (needEarlyPreprintChannels && spec?.arxivVenueAliases?.length) {
		const arxivRes = await fetchArxivAcceptedForVenue(venue, year, fetchText, {
			maxPages: 18,
		});
		arxivTotal = arxivRes.totalResults;
		if (arxivRes.items.length > 0) {
			arxivVenueItems = await enrichArxivItemsBatch(
				arxivRes.items,
				fetchJson,
				arxivRes.items.length,
				{
					keywordLlmFetch: options?.keywordLlmFetch,
					signal: options?.signal,
					onProgress: options?.onProgress
						? (completed, total) => options.onProgress?.({ completed, total })
						: undefined,
				},
			);
		}
	}

	let merged = needEarlyPreprintChannels
		? dedupeVenueChannelItems([primaryItems, s2Items, arxivVenueItems])
		: primaryItems;

	if (options?.existingItems?.length) {
		merged = reconcileFreshWithExisting(merged, existingLookup, venue).items;
	}

	// Tier 4: Public Springer HTML abstract backfill for 10.1007/* papers (`SAS 2026`, `ASE (J) 2026`, `ESE 2026`)
	if (
		merged.some(
			(p) =>
				isPlaceholderAbstract(p.abstract, venue.name) &&
				p.doi?.toLowerCase().startsWith("10.1007/"),
		)
	) {
		merged = await backfillSpringerAbstracts(merged, fetchText, 220, {
			signal: options?.signal,
			onProgress: options?.onProgress,
		});
	}

	// Tier 5: Keyword LLM fallback for Venue papers still missing keywords after Author ∪ OpenAlex union
	merged = await backfillMissingVenueKeywordsWithKeywordLlm(merged, {
		keywordLlmFetch: options?.keywordLlmFetch,
		signal: options?.signal,
		onProgress: options?.onProgress,
	});

	if (merged.length === 0 && requestCount > 0 && lastError) {
		throw lastError;
	}

	let latestPublishedAt: string | null = null;
	for (const item of merged) {
		if (!latestPublishedAt || item.publishedAt > latestPublishedAt) {
			latestPublishedAt = item.publishedAt;
		}
	}

	const remoteTotalCount =
		coolRes.items.length >= 100 && !authoritativeViaRoster
			? Math.max(merged.length, coolRes.remoteTotalCount)
			: spec?.trackRosterMode === "required" || authoritativeViaRoster
				? Math.max(merged.length, structuredRemoteTotal)
				: needEarlyPreprintChannels
					? Math.max(merged.length, arxivTotal, s2Total)
					: Math.max(merged.length, structuredRemoteTotal);

	return {
		items: merged,
		remoteTotalCount,
		latestPublishedAt,
		authoritativeMainTrack,
	};
}
