/**
 * Plaza — Multi-channel, multi-page 2026 Venue main-track fetcher.
 *
 * Unifies authoritative official track rosters (`conf.researchr.org` / official program pages),
 * curated main-track proceedings (`papers.cool`), and scholarly metadata indexes
 * (`OpenAlex`, `Crossref`, `IEEE CSDL`, `DataCite LIPIcs`, `Semantic Scholar`, `arXiv`)
 * without any DBLP dependency.
 */

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
	hasPriorConferenceYearSpillover,
	inferVenueKind,
	isExcludedByDoiPrefix,
	isFrontmatterTitle,
	isNonResearchJournalItem,
	isPaperMetadataComplete,
	isPlaceholderAbstract,
	isPositionPaperTitle,
	isWorkshopOrCompanionVenue,
	matchesConfiguredDoiPrefix,
	normalizePaperKeywords,
	scoreCameraReadyCandidateMatch,
	throwIfAborted,
	VENUE_SPEC_BY_ID,
	type VenueConfig,
	type VenueSpec,
	wrapFetchJsonWithAbort,
	wrapFetchTextWithAbort,
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
let openAlexListCooldownUntil = 0;

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

async function acquireHostSlot(host: string): Promise<void> {
	if (IS_TEST_ENV || !host) return;
	const interval =
		host === "api.openalex.org" && hasCachedOpenAlexApiKey()
			? 105
			: HOST_MIN_INTERVAL_MS[host];
	if (!interval) return;

	const now = Date.now();
	const scheduled = Math.max(now, hostNextSlotMs.get(host) ?? 0);
	hostNextSlotMs.set(host, scheduled + interval);
	const waitMs = scheduled - now;
	if (waitMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, waitMs));
	}
}

async function withHostGate<T>(
	url: string,
	task: () => Promise<T>,
): Promise<T> {
	const host = extractHostname(url);
	if (
		!IS_TEST_ENV &&
		isOpenAlexListUrl(url) &&
		Date.now() < openAlexListCooldownUntil
	) {
		throw new Error(`OpenAlex list rate-limit cooldown active for ${url}`);
	}
	if (IS_TEST_ENV || !SERIALIZED_HOSTS.has(host)) {
		await acquireHostSlot(host);
		return await task();
	}

	const prev = hostInFlightChain.get(host) ?? Promise.resolve();
	let release: () => void = () => {};
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	hostInFlightChain.set(host, current);

	await prev;
	try {
		await acquireHostSlot(host);
		return await task();
	} finally {
		if (hostInFlightChain.get(host) === current) {
			hostInFlightChain.delete(host);
		}
		release();
	}
}

function isTransientNetworkError(msg: string): boolean {
	return /\b(?:429|502|503|504)\b|timeout|timed\s*out|aborted|fetch\s+failed|econnreset/i.test(
		msg,
	);
}

export function createPoliteFetchText(rawFetchText: FetchTextFn): FetchTextFn {
	return async (url: string, accept?: string): Promise<string> => {
		try {
			return await withHostGate(url, () => rawFetchText(url, accept));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!IS_TEST_ENV && isTransientNetworkError(msg)) {
				await new Promise((resolve) => setTimeout(resolve, 1500));
				return await withHostGate(url, () => rawFetchText(url, accept));
			}
			throw err;
		}
	};
}

export function createPoliteFetchJson(rawFetchJson: FetchJsonFn): FetchJsonFn {
	return async <T = unknown>(url: string): Promise<T> => {
		try {
			return await withHostGate(url, () => rawFetchJson<T>(url));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!IS_TEST_ENV && isOpenAlexListUrl(url) && /\b429\b/.test(msg)) {
				openAlexListCooldownUntil = Date.now() + 5 * 60_000;
				throw err;
			}
			if (!IS_TEST_ENV && isTransientNetworkError(msg)) {
				await new Promise((resolve) => setTimeout(resolve, 1500));
				return await withHostGate(url, () => rawFetchJson<T>(url));
			}
			throw err;
		}
	};
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

const REJECT_VENUE_COMMENT_RE =
	/\b(workshop|workshops|ws\b|submitted\s+to|under\s+review|in\s+submission|preprint\s+submitted|rejected|withdrawn|doctoral\s+symposium|doctoral\s+consortium|student\s+abstract|student\s+research|challenge|competition|tutorial|extended\s+abstract|demo\s+track|demonstrations?\s+track|tool\s+demos?|findings\s+of|position\s+paper\s+track|datasets?\s+(?:and|&)\s+benchmarks?|industry\s+track|seip\b|nier\b|seet\b|seis\b|replications?\s+(?:and|&)\s+negative|registered\s+reports?)\b/i;

/**
 * Verify that an arXiv `<arxiv:comment>` or `<arxiv:journal_ref>` string genuinely
 * declares acceptance at one of the target main-track venue aliases (rejecting
 * workshops such as `"ICML 2026 Workshop"` or `"EIML@ICML 2026"` and unaccepted submissions).
 */
export function isConfirmedVenueAcceptance(
	commentOrJournalRef: string,
	aliases: readonly string[],
): boolean {
	const text = commentOrJournalRef.replace(/\s+/g, " ").trim();
	if (!text || aliases.length === 0) return false;
	if (REJECT_VENUE_COMMENT_RE.test(text)) return false;

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
		if (!isConfirmedVenueAcceptance(combinedMeta, aliases)) {
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
		if (isExcludedByDoiPrefix(explicitDoi, spec?.excludeDoiPrefixes)) {
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

type S2BulkPaper = {
	paperId?: string;
	title?: string | null;
	abstract?: string | null;
	year?: number | null;
	publicationDate?: string | null;
	citationCount?: number | null;
	venue?: string | null;
	url?: string | null;
	openAccessPdf?: { url?: string | null } | null;
	externalIds?: {
		DOI?: string | null;
		ArXiv?: string | null;
		DBLP?: string | null;
	} | null;
	authors?: Array<{ name?: string | null }> | null;
};

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

	const venueKind = spec?.kind ?? inferVenueKind(venue);
	const venueDomain = spec?.domain ?? venue.domain;
	const ccfRank = spec?.ccfRank ?? venue.ccfRank;
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
			"title,abstract,authors,year,publicationDate,citationCount,externalIds,venue,url,openAccessPdf";
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
				const title = (row.title ?? "").replace(/\s+/g, " ").trim();
				if (!title || isFrontmatterTitle(title)) continue;
				if (spec?.excludePositionPapers && isPositionPaperTitle(title)) {
					continue;
				}
				if (
					venueKind === "journal" &&
					isNonResearchJournalItem(title, undefined)
				) {
					continue;
				}
				const itemYear = row.year ?? year;
				if (itemYear < year) continue;

				const rowVenue = (row.venue ?? "").trim();
				if (
					venueKind === "conference" &&
					rowVenue &&
					isWorkshopOrCompanionVenue(rowVenue)
				) {
					continue;
				}

				const doi = cleanDoi(row.externalIds?.DOI);
				if (isExcludedByDoiPrefix(doi, spec?.excludeDoiPrefixes)) {
					continue;
				}
				if (hasPriorConferenceYearSpillover(year, doi, rowVenue)) {
					continue;
				}
				if (
					spec?.requireDoiPrefixMatch &&
					(spec.doiPrefixFilter || spec.doiPrefixFilters?.length) &&
					doi &&
					!/^10\.48550\/arxiv\./i.test(doi) &&
					!matchesConfiguredDoiPrefix(doi, spec)
				) {
					continue;
				}

				const rawAbstract = (row.abstract ?? "").replace(/\s+/g, " ").trim();
				const abstract = isPlaceholderAbstract(rawAbstract, venue.name)
					? ""
					: rawAbstract;

				const authors = (row.authors ?? [])
					.map((a) => (a?.name ?? "").trim())
					.filter(Boolean);
				if (authors.length === 0) continue;

				const arxivId = row.externalIds?.ArXiv?.trim() || undefined;
				const categories = [
					venue.name,
					...(venueDomain ? [venueDomain] : []),
					...(ccfRank ? [ccfRank] : []),
				];

				out.push({
					id: buildVenuePaperId(venue.id, doi, arxivId, title),
					title,
					authors,
					abstract,
					publishedAt: row.publicationDate
						? `${row.publicationDate}T00:00:00Z`
						: `${itemYear}-01-01T00:00:00Z`,
					year: itemYear,
					sourceType: "venue",
					sourceLabel: venue.name,
					categories,
					url:
						(doi ? `https://doi.org/${doi}` : undefined) ||
						(arxivId ? `https://arxiv.org/abs/${arxivId}` : undefined) ||
						row.url ||
						venue.url,
					pdfUrl:
						row.openAccessPdf?.url ||
						(arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined),
					arxivId,
					doi: doi || (arxivId ? `10.48550/arxiv.${arxivId}` : undefined),
					venueId: venue.id,
					venueKind,
					venueDomain,
					ccfRank,
					venueFull: rowVenue || venue.name,
					citationCount: Math.max(0, row.citationCount ?? 0),
					keywords: [],
				});
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
 * Multi-page `papers.cool/venue/{slug}?skip=...&show=500` fetcher (up to 8,000 papers).
 * When a small explicit `coolPapersAllowedGroups` whitelist is configured (e.g. `ACL 2026`
 * `Long Papers` + `Short Papers`), queries those exact groups directly.
 */
export async function fetchCoolPapersVenuePapers(
	venue: VenueConfig,
	year: number,
	fetchText: FetchTextFn,
	options?: {
		maxPages?: number;
	},
): Promise<{ items: CollectionPaperItem[]; remoteTotalCount: number }> {
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const slug = spec?.coolPapersVenueSlug;
	if (!slug) return { items: [], remoteTotalCount: 0 };

	const pageSize = 500;
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
			} catch {
				if (IS_TEST_ENV) break;
				try {
					await new Promise((resolve) => setTimeout(resolve, 1200));
					html = await fetchText(url, "text/html,application/xhtml+xml,*/*");
				} catch {
					break;
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

function stripResearchrBadges(rawTitleHtmlOrText: string): string {
	return rawTitleHtmlOrText
		.replace(
			/<span[^>]*class=["'][^"']*(?:pull-right|output-badge|badge)[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,
			" ",
		)
		.replace(/<[^>]+>/g, " ")
		.replace(
			/\s*(?:Distinguished Paper|Virtual Attendance|Artifact Available|Artifact Evaluated|ACM SIGSOFT Distinguished Paper)\s*$/gi,
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

/**
 * Parse official accepted-paper program pages for conferences whose proceedings DOIs
 * have not yet been minted (e.g. `CCS 2026` schedule & `ISSRE 2026` accepted papers).
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
	) => {
		const title = rawTitle.replace(/\s+/g, " ").trim();
		if (!title || isFrontmatterTitle(title) || authors.length === 0) return;
		const normTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
		if (!normTitle || seenTitles.has(normTitle)) return;
		seenTitles.add(normTitle);
		const categories = trackLabel
			? Array.from(new Set([...baseCategories, trackLabel]))
			: baseCategories;
		out.push({
			id: buildVenuePaperId(venue.id, undefined, undefined, title),
			title,
			authors,
			abstract: "",
			publishedAt: `${targetYear}-01-01T00:00:00Z`,
			year: targetYear,
			sourceType: "venue",
			sourceLabel: venue.name,
			categories,
			url: sourceUrl,
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
						: stripParentheticalAffiliations(
								decodeHtmlEntities(p.authors ?? ""),
							)
								.split(/\s*(?:,|;|\band\b)\s*/i)
								.map((a) => a.trim())
								.filter(Boolean);
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
		const authorsPlain = stripParentheticalAffiliations(
			decodeHtmlEntities(authorsBlock.replace(/<[^>]+>/g, " ")),
		);
		const authors = authorsPlain
			.split(",")
			.map((a) => a.replace(/\s+/g, " ").trim())
			.filter(Boolean);
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
			lastFetchErr = err;
			if (!IS_TEST_ENV) {
				try {
					await new Promise((resolve) => setTimeout(resolve, 1200));
					html = await fetchText(
						trackUrl,
						"text/html,application/xhtml+xml,*/*",
					);
				} catch (retryErr) {
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
				keywords: normalizePaperKeywords(authorSubjects),
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
			keywords: normalizePaperKeywords(row.keywords),
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

function pickPreferredDoi(
	a: string | undefined,
	b: string | undefined,
): string | undefined {
	if (a && !isArxivDoi(a)) return a;
	if (b && !isArxivDoi(b)) return b;
	return a || b;
}

function dedupeVenueChannelItems(
	groups: readonly CollectionPaperItem[][],
): CollectionPaperItem[] {
	const byId = new Map<string, CollectionPaperItem>();
	const doiToId = new Map<string, string>();
	const titleToId = new Map<string, string>();

	for (const group of groups) {
		for (const item of group) {
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
					prev.publishedAt >= item.publishedAt
						? prev.publishedAt
						: item.publishedAt,
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
function backfillMissingMetadataFromChannel(
	primaryItems: readonly CollectionPaperItem[],
	supplementItems: readonly CollectionPaperItem[],
): CollectionPaperItem[] {
	if (primaryItems.length === 0 || supplementItems.length === 0) {
		return [...primaryItems];
	}
	const suppByDoi = new Map<string, CollectionPaperItem>();
	const suppByTitle = new Map<string, CollectionPaperItem>();
	for (const s of supplementItems) {
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
		const tk = item.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
		const match =
			(item.doi && !isArxivDoi(item.doi)
				? suppByDoi.get(item.doi.toLowerCase())
				: undefined) ?? (tk ? suppByTitle.get(tk) : undefined);
		if (!match) return item;
		const bestAbstract =
			item.abstract.length >= match.abstract.length
				? item.abstract
				: match.abstract;
		const bestArxivId = item.arxivId || match.arxivId;
		const bestDoi = pickPreferredDoi(item.doi, match.doi);
		return {
			...item,
			abstract: bestAbstract,
			doi: bestDoi,
			arxivId: bestArxivId,
			coolPapersId: item.coolPapersId || match.coolPapersId,
			pdfUrl:
				item.pdfUrl ||
				match.pdfUrl ||
				(bestArxivId ? `https://arxiv.org/pdf/${bestArxivId}.pdf` : undefined),
			citationCount: Math.max(
				item.citationCount ?? 0,
				match.citationCount ?? 0,
			),
			keywords: normalizePaperKeywords([
				...(item.keywords ?? []),
				...(match.keywords ?? []),
			]),
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
		isPaperMetadataComplete(item, venueName);

	for (const ex of existingItems ?? []) {
		if (!ex) continue;
		existingList.push(ex);
		if (isComplete(ex)) {
			completeItems.push(ex);
		}
		if (ex.id) byId.set(ex.id, ex);
		const d = cleanDoi(ex.doi)?.toLowerCase();
		if (d && !isArxivDoi(d)) byDoi.set(d, ex);
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
			let matched =
				byId.get(item.id) ??
				(d && !isArxivDoi(d) ? byDoi.get(d) : undefined) ??
				(aid ? byArxiv.get(aid) : undefined) ??
				(tk ? byTitle.get(tk) : undefined);
			if (!matched && existingList.length > 0 && item.authors.length > 0) {
				let bestScore = 0;
				for (const ex of existingList) {
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
	const freshPlaceholder = isPlaceholderAbstract(fresh.abstract, venue.name);
	const exPlaceholder = isPlaceholderAbstract(existing.abstract, venue.name);
	const bestAbstract =
		freshPlaceholder && !exPlaceholder
			? existing.abstract
			: !freshPlaceholder && exPlaceholder
				? fresh.abstract
				: fresh.abstract.length >= existing.abstract.length
					? fresh.abstract
					: existing.abstract;
	const bestDoi = pickPreferredDoi(fresh.doi, existing.doi);
	const bestArxivId = fresh.arxivId || existing.arxivId;
	const bestPublishedAt =
		fresh.publishedAt.endsWith("-01-01T00:00:00Z") &&
		existing.publishedAt &&
		!existing.publishedAt.endsWith("-01-01T00:00:00Z")
			? existing.publishedAt
			: fresh.publishedAt || existing.publishedAt;

	const bestTitle =
		existing.title &&
		existing.doi &&
		!isArxivDoi(existing.doi) &&
		(!fresh.doi || isArxivDoi(fresh.doi))
			? existing.title
			: fresh.title;

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
			existing.pdfUrl ||
			(bestArxivId ? `https://arxiv.org/pdf/${bestArxivId}.pdf` : undefined),
		coolPapersId: fresh.coolPapersId || existing.coolPapersId,
		volume: fresh.volume || existing.volume,
		issue: fresh.issue || existing.issue,
		pages: fresh.pages || existing.pages,
		bibtex: fresh.bibtex || existing.bibtex,
		...(fresh.recommendedAt || existing.recommendedAt
			? { recommendedAt: fresh.recommendedAt || existing.recommendedAt }
			: {}),
		venueFull:
			fresh.venueFull && fresh.venueFull !== venue.name
				? fresh.venueFull
				: existing.venueFull || fresh.venueFull,
		citationCount: Math.max(
			fresh.citationCount ?? 0,
			existing.citationCount ?? 0,
		),
		keywords: normalizePaperKeywords([
			...(fresh.keywords ?? []),
			...(existing.keywords ?? []),
		]),
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
		if (!isComplete) {
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
	keywordLlmFetch?: typeof fetch,
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
		fetchFn: keywordLlmFetch,
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
			};
		}
	}
	return next;
}

/**
 * Reconcile freshly extracted custom / Agent venue items against cached SQLite rows,
 * enriching only new or incomplete items via OpenAlex + author union and Keyword LLM fallback.
 */
export async function finalizeVenuePapersWithSmartDiff(
	freshItems: readonly CollectionPaperItem[],
	venue: VenueConfig,
	fetchJson: FetchJsonFn,
	options?: {
		existingItems?: readonly CollectionPaperItem[];
		keywordLlmFetch?: typeof fetch;
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
	const enriched = await enrichSubsetInPlace(
		reconciled.items,
		reconciled.incompleteOrNewIndices,
		venue,
		fetchJson,
		existingLookup.completeItems,
	);
	return backfillMissingVenueKeywordsWithKeywordLlm(
		enriched,
		options?.keywordLlmFetch,
	);
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
		if (!p) continue;
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
				let candidate: CollectionPaperItem = {
					...r,
					id: buildVenuePaperId(venue.id, bestDoi, bestArxivId, bestTitle),
					title: bestTitle,
					authors: pub.authors.length > 0 ? pub.authors : r.authors,
					abstract: bestAbstract,
					publishedAt:
						pub.publishedAt && pub.publishedAt !== `${r.year}-01-01T00:00:00Z`
							? pub.publishedAt
							: r.publishedAt,
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
					keywords: normalizePaperKeywords([
						...(pub.keywords ?? []),
						...(r.keywords ?? []),
					]),
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
					(!candidate.abstract ||
						!candidate.doi ||
						!options?.openAlexHydrated ||
						normalizePaperKeywords(candidate.keywords).length === 0)
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
		if (!exRosterHit?.isComplete) {
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
			{ signal: options?.signal },
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
 * Fetch complete, multi-page 2026 venue papers (strict Main / Research / Technical Track):
 * 1. Curated `papers.cool/venue/{slug}` main-track index (with group & position-paper filtering)
 *    for OpenReview (`ICML`, `ICLR`, `NeurIPS`), `ACL`, `AAAI`, `USENIX Security`, and `NDSS`.
 * 2. Authoritative `venue.tracks` (`conf.researchr.org` `#event-overview`) roster intersected with
 *    publisher metadata (`CSDL`, `DataCite LIPIcs`, `OpenAlex`, `Crossref`) for combined-volume SE
 *    conferences (`ASE`, `ICPC`, `RE`, `SANER`, `ICSME`, `ESEM`).
 * 3. Publisher proceedings & journals (`ICSE`, `ISSTA`, `FSE`, `PLDI`, `POPL`, `OOPSLA`, `ECOOP`,
 *    `SAS`, `S&P`, `TSE`, `TOSEM`, `ASE (J)`, `ESE`) with strict issue/DOI/frontmatter filtering.
 * 4. Official conference accepted-papers program fallback (`CCS 2026`, `ISSRE 2026`) and Springer
 *    HTML abstract backfill (`#Abs1-content`), plus Smart Diff against `existingItems` and
 *    Keyword LLM fallback for papers still lacking keywords.
 */
export async function fetchMultiChannelVenuePapers(
	venue: VenueConfig,
	year: number,
	rawFetchJson: FetchJsonFn,
	rawFetchText: FetchTextFn,
	options?: {
		maxPages?: number;
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
	const abortableRawFetchJson = wrapFetchJsonWithAbort(
		rawFetchJson,
		options?.signal,
	);
	const abortableRawFetchText = wrapFetchTextWithAbort(
		rawFetchText,
		options?.signal,
	);

	const trackedFetchJson: FetchJsonFn = async <T = unknown>(
		url: string,
	): Promise<T> => {
		throwIfAborted(options?.signal);
		requestCount += 1;
		try {
			return await abortableRawFetchJson<T>(url);
		} catch (err) {
			lastError = err;
			throw err;
		}
	};

	const trackedFetchText: FetchTextFn = async (
		url: string,
		accept?: string,
	): Promise<string> => {
		throwIfAborted(options?.signal);
		requestCount += 1;
		try {
			return await abortableRawFetchText(url, accept);
		} catch (err) {
			lastError = err;
			throw err;
		}
	};

	const fetchJson = createPoliteFetchJson(trackedFetchJson);
	const fetchText = createPoliteFetchText(trackedFetchText);
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const maxPages = options?.maxPages ?? 25;
	const existingLookup = buildExistingVenueLookup(
		options?.existingItems,
		venue.name,
	);

	// Tier 0: Curated papers.cool venue list (100% abstracts + PDFs for AI & USENIX/NDSS venues)
	const coolRes = spec?.coolPapersVenueSlug
		? await fetchCoolPapersVenuePapers(venue, year, fetchText)
		: { items: [], remoteTotalCount: 0 };

	let primaryItems: CollectionPaperItem[] = [];
	let structuredRemoteTotal = 0;
	let authoritativeMainTrack = false;

	if (coolRes.items.length >= 100) {
		const reconciled = reconcileFreshWithExisting(
			dedupeVenueChannelItems([coolRes.items]),
			existingLookup,
			venue,
		);
		primaryItems = reconciled.items;

		if (reconciled.incompleteOrNewIndices.length > 0) {
			const structuredBudget = Math.min(
				maxPages,
				Math.max(4, Math.ceil(coolRes.items.length / 200) + 2),
			);
			const structured =
				reconciled.incompleteOrNewIndices.length >= 80
					? await fetchVenueStructuredPapers(venue, year, fetchJson, {
							maxPages: structuredBudget,
							preloadedItems: existingLookup.completeItems,
							signal: options?.signal,
							onProgress: options?.onProgress,
						})
					: { items: [], remoteTotalCount: 0 };
			structuredRemoteTotal = structured.remoteTotalCount ?? 0;
			if (structured.items.length > 0) {
				primaryItems = backfillMissingMetadataFromChannel(
					primaryItems,
					structured.items,
				);
			}

			const stillIncompleteIndices = reconciled.incompleteOrNewIndices.filter(
				(idx) => {
					const p = primaryItems[idx];
					return Boolean(p && !isPaperMetadataComplete(p, venue.name));
				},
			);
			if (stillIncompleteIndices.length > 0) {
				primaryItems = await enrichSubsetInPlace(
					primaryItems,
					stillIncompleteIndices,
					venue,
					fetchJson,
					existingLookup.completeItems.length > 0
						? [...structured.items, ...existingLookup.completeItems]
						: structured.items,
				);
			}
		}
		authoritativeMainTrack = true;
	} else if (spec?.trackRosterMode === "required") {
		// Strict Main / Research / Technical Track roster required (`ASE`, `ICPC`, `RE`, `SANER`, `ICSME`, `ESEM`)
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
				dedupeVenueChannelItems([directPublisherItems, structured.items]),
				venue,
				fetchJson,
				{
					openAlexHydrated: structuredRan,
					existingLookup,
					signal: options?.signal,
				},
			);
		}
		structuredRemoteTotal = primaryItems.length;
		authoritativeMainTrack = true;
	} else {
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
		// enrich only brand-new or incomplete items so they obtain `Author ∪ OpenAlex` keywords.
		if (!structuredRan && reconciled.incompleteOrNewIndices.length > 0) {
			primaryItems = await enrichSubsetInPlace(
				primaryItems,
				reconciled.incompleteOrNewIndices,
				venue,
				fetchJson,
				existingLookup.completeItems,
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

		// Official accepted-papers track fallback when proceedings DOIs aren't minted yet (`CCS 2026`, `ISSRE 2026`, or custom tracks)
		const hasTrackFallback =
			spec?.trackRosterMode === "fallback" ||
			(!spec && (venue.tracks?.length ?? 0) > 0);
		if (primaryItems.length < 25 && hasTrackFallback) {
			const officialRes = await fetchOfficialVenueProgramPapers(
				venue,
				year,
				fetchText,
			);
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
				{ keywordLlmFetch: options?.keywordLlmFetch },
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
	merged = await backfillMissingVenueKeywordsWithKeywordLlm(
		merged,
		options?.keywordLlmFetch,
	);

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
		coolRes.items.length >= 100
			? Math.max(merged.length, coolRes.remoteTotalCount)
			: spec?.trackRosterMode === "required"
				? merged.length
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
