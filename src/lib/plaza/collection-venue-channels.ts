/**
 * Plaza — Multi-channel, multi-page 2026 Venue full fetcher.
 *
 * Why multi-channel instead of single-source DBLP:
 * 1. `dblp.uni-trier.de` / `dblp.org` frequently challenge automated clients with HTTP 202
 *    Anubis PoW gates and strict per-IP rate limits (~1 req / 2s), causing proxy errors when
 *    refreshing 28 venues.
 * 2. OpenReview-hosted AI venues (`NeurIPS 2026`, `ICML 2026`, `ICLR 2026`) mint proceedings
 *    DOIs in OpenAlex/Crossref months after acceptance, whereas accepted papers are immediately
 *    indexed in Semantic Scholar Bulk Search and arXiv `<arxiv:comment>` / `<arxiv:journal_ref>`.
 * 3. Every channel supports multi-page pagination (`cursor` / `token` / `start` offset) so
 *    each Venue refresh performs a complete, untruncated full update beyond the single-page 200 cap.
 */

import {
	buildVenuePaperId,
	type CollectionPaperItem,
	cleanDoi,
	type DblpVenueSpec,
	derivePaperKeywords,
	enrichArxivItemsBatch,
	enrichDblpItemsBatch,
	type FetchJsonFn,
	type FetchTextFn,
	fetchVenueStructuredPapers,
	inferVenueKind,
	isFrontmatterTitle,
	isPlaceholderAbstract,
	isWorkshopOrCompanionVenue,
	VENUE_SPEC_BY_ID,
	type VenueConfig,
} from "@/lib/plaza/collection-enrichment";

const IS_TEST_ENV =
	typeof import.meta !== "undefined" && import.meta.env?.MODE === "test";

const HOST_MIN_INTERVAL_MS: Record<string, number> = {
	"api.openalex.org": 140,
	"sparql.dblp.org": 200,
	"api.crossref.org": 100,
	"api.semanticscholar.org": 1400,
	"export.arxiv.org": 2200,
};

const hostNextSlotMs = new Map<string, number>();

async function acquireHostSlot(url: string): Promise<void> {
	if (IS_TEST_ENV) return;
	let host = "";
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return;
	}
	const interval = HOST_MIN_INTERVAL_MS[host];
	if (!interval) return;

	const now = Date.now();
	const scheduled = Math.max(now, hostNextSlotMs.get(host) ?? 0);
	hostNextSlotMs.set(host, scheduled + interval);
	const waitMs = scheduled - now;
	if (waitMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, waitMs));
	}
}

export function createPoliteFetchText(rawFetchText: FetchTextFn): FetchTextFn {
	return async (url: string, accept?: string): Promise<string> => {
		await acquireHostSlot(url);
		try {
			return await rawFetchText(url, accept);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!IS_TEST_ENV && /\b(?:429|502|503|504)\b/.test(msg)) {
				await new Promise((resolve) => setTimeout(resolve, 1500));
				await acquireHostSlot(url);
				return await rawFetchText(url, accept);
			}
			throw err;
		}
	};
}

export function createPoliteFetchJson(rawFetchJson: FetchJsonFn): FetchJsonFn {
	return async <T = unknown>(url: string): Promise<T> => {
		await acquireHostSlot(url);
		try {
			return await rawFetchJson<T>(url);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!IS_TEST_ENV && /\b(?:429|502|503|504)\b/.test(msg)) {
				await new Promise((resolve) => setTimeout(resolve, 1500));
				await acquireHostSlot(url);
				return await rawFetchJson<T>(url);
			}
			throw err;
		}
	};
}

function cleanXmlText(raw: string): string {
	return raw
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function stripArxivVersion(id: string): string {
	return id.replace(/v\d+$/i, "").trim();
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const REJECT_VENUE_COMMENT_RE =
	/\b(workshop|workshops|ws\b|submitted\s+to|under\s+review|in\s+submission|preprint\s+submitted|rejected|withdrawn|doctoral\s+symposium|student\s+abstract|challenge|competition|tutorial|extended\s+abstract|demo\s+track)\b/i;

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
	spec: DblpVenueSpec | undefined,
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
			keywords: derivePaperKeywords(title, abstract, categories),
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
	const maxPages = options?.maxPages ?? 4;
	const sinceTs = options?.sinceDate
		? Date.parse(options.sinceDate)
		: Number.NaN;
	const out: CollectionPaperItem[] = [];
	let totalResults = 0;
	let latestUpdatedAt: string | null = null;

	for (let page = 0; page < maxPages; page++) {
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
	s2FieldsOfStudy?: Array<{ category?: string | null }> | null;
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
			"title,abstract,authors,year,publicationDate,citationCount,externalIds,venue,s2FieldsOfStudy,url,openAccessPdf";
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

				const rawAbstract = (row.abstract ?? "").replace(/\s+/g, " ").trim();
				const abstract = isPlaceholderAbstract(rawAbstract, venue.name)
					? ""
					: rawAbstract;

				const authors = (row.authors ?? [])
					.map((a) => (a?.name ?? "").trim())
					.filter(Boolean);
				if (authors.length === 0) continue;

				const doi = cleanDoi(row.externalIds?.DOI);
				const arxivId = row.externalIds?.ArXiv?.trim() || undefined;
				const upstreamKw = (row.s2FieldsOfStudy ?? [])
					.map((f) => f?.category ?? "")
					.filter(Boolean);
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
					keywords: derivePaperKeywords(
						title,
						abstract,
						categories,
						upstreamKw,
					),
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
				keywords: Array.from(
					new Set([...(prev.keywords ?? []), ...(item.keywords ?? [])]),
				).slice(0, 8),
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
		return {
			...item,
			abstract: bestAbstract,
			arxivId: bestArxivId,
			pdfUrl:
				item.pdfUrl ||
				match.pdfUrl ||
				(bestArxivId ? `https://arxiv.org/pdf/${bestArxivId}.pdf` : undefined),
			citationCount: Math.max(
				item.citationCount ?? 0,
				match.citationCount ?? 0,
			),
			keywords: derivePaperKeywords(item.title, bestAbstract, item.categories, [
				...(item.keywords ?? []),
				...(match.keywords ?? []),
			]),
		};
	});
}

type DblpSparqlBinding = {
	rec?: { value?: string };
	title?: { value?: string };
	doi?: { value?: string };
	ee?: { value?: string };
	pubIn?: { value?: string };
	pages?: { value?: string };
	authors?: { value?: string };
};

function resolveDblpStreamKey(
	venue: VenueConfig,
	spec: DblpVenueSpec | undefined,
): string | null {
	if (spec?.dblpStream) return spec.dblpStream;
	if (venue.dblpStream) return venue.dblpStream;
	const urlMatch = /\/db\/(conf|journals)\/([^/?#]+)/i.exec(venue.url);
	if (urlMatch?.[1] && urlMatch[2]) {
		return `streams/${urlMatch[1].toLowerCase()}/${urlMatch[2].toLowerCase()}`;
	}
	return null;
}

/**
 * Official DBLP SPARQL endpoint (`https://sparql.dblp.org/sparql`) paginated full fetcher.
 * CORS-enabled (`Access-Control-Allow-Origin: *`), free of `dblp.uni-trier.de`'s
 * Anubis HTTP 202 PoW gates, paginates `LIMIT/OFFSET` across large venues (up to 8,000 records),
 * filters out proceedings editorship records and co-located `@` workshops, and batch-enriches
 * metadata via OpenAlex while keeping every valid main-venue paper.
 */
export async function fetchDblpSparqlVenuePapers(
	venue: VenueConfig,
	year: number,
	alreadyCoveredTitles: ReadonlySet<string>,
	fetchJson: FetchJsonFn,
	options?: {
		pageSize?: number;
		maxPages?: number;
		preloadedItems?: readonly CollectionPaperItem[];
	},
): Promise<{ items: CollectionPaperItem[]; totalResults: number }> {
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const stream = resolveDblpStreamKey(venue, spec);
	if (!stream) return { items: [], totalResults: 0 };

	const pageSize = options?.pageSize ?? 1000;
	const maxPages = options?.maxPages ?? 8;
	const venueKind = spec?.kind ?? inferVenueKind(venue);
	const venueDomain = spec?.domain ?? venue.domain;
	const ccfRank = spec?.ccfRank ?? venue.ccfRank;
	const categories = [
		venue.name,
		...(venueDomain ? [venueDomain] : []),
		...(ccfRank ? [ccfRank] : []),
	];

	const seenRecs = new Set<string>();
	const seenTitles = new Set<string>(alreadyCoveredTitles);
	const candidates: CollectionPaperItem[] = [];
	let totalBindingsObserved = 0;

	for (let page = 0; page < maxPages; page++) {
		const offset = page * pageSize;
		const sparql = `PREFIX dblp: <https://dblp.org/rdf/schema#>
SELECT ?rec ?title (SAMPLE(?d) AS ?doi) (SAMPLE(?e) AS ?ee) (SAMPLE(?v) AS ?pubIn) (SAMPLE(?p) AS ?pages) (GROUP_CONCAT(DISTINCT ?authorName; separator="||") AS ?authors) WHERE {
  ?rec dblp:publishedInStream <https://dblp.org/${stream}> ;
       dblp:yearOfPublication "${year}"^^<http://www.w3.org/2001/XMLSchema#gYear> ;
       dblp:title ?title .
  FILTER NOT EXISTS { ?rec a dblp:Editorship }
  OPTIONAL { ?rec dblp:doi ?d }
  OPTIONAL { ?rec dblp:primaryElectronicEdition ?e }
  OPTIONAL { ?rec dblp:publishedIn ?v }
  OPTIONAL { ?rec dblp:pagination ?p }
  OPTIONAL { ?rec dblp:authoredBy ?a . ?a dblp:primaryCreatorName ?authorName }
} GROUP BY ?rec ?title ORDER BY ?rec LIMIT ${pageSize} OFFSET ${offset}`;

		try {
			const url = `https://sparql.dblp.org/sparql?query=${encodeURIComponent(sparql)}`;
			const data = await fetchJson<{
				results?: { bindings?: DblpSparqlBinding[] };
			}>(url);
			const bindings = data.results?.bindings ?? [];
			if (bindings.length === 0) break;
			totalBindingsObserved += bindings.length;

			for (const row of bindings) {
				const recUri = row.rec?.value?.trim();
				if (recUri) {
					if (seenRecs.has(recUri)) continue;
					seenRecs.add(recUri);
				}

				const rawTitle = (row.title?.value ?? "")
					.replace(/\.$/, "")
					.replace(/\s+/g, " ")
					.trim();
				if (!rawTitle || isFrontmatterTitle(rawTitle)) continue;

				const pubIn = (row.pubIn?.value ?? "").trim();
				if (
					venueKind === "conference" &&
					pubIn &&
					isWorkshopOrCompanionVenue(pubIn)
				) {
					continue;
				}

				const normTitle = rawTitle.toLowerCase().replace(/[^a-z0-9]+/g, "");
				if (normTitle && seenTitles.has(normTitle)) continue;
				if (normTitle) seenTitles.add(normTitle);

				const authors = (row.authors?.value ?? "")
					.split("||")
					.map((s) => s.replace(/\s+\d{4}$/, "").trim())
					.filter(Boolean);
				if (authors.length === 0) continue;

				const doi = cleanDoi(row.doi?.value);
				const ee = row.ee?.value?.trim();
				const arxivMatch = ee
					? /arxiv\.org\/abs\/(\d{4}\.\d{4,5})/i.exec(ee)
					: null;
				const arxivId = arxivMatch?.[1];
				const pages = row.pages?.value?.trim() || undefined;

				candidates.push({
					id: buildVenuePaperId(venue.id, doi, arxivId, rawTitle),
					title: rawTitle,
					authors,
					abstract: "",
					publishedAt: `${year}-01-01T00:00:00Z`,
					year,
					sourceType: "venue",
					sourceLabel: venue.name,
					categories,
					url: ee || (doi ? `https://doi.org/${doi}` : venue.url),
					pdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined,
					arxivId,
					doi,
					venueId: venue.id,
					venueKind,
					venueDomain,
					ccfRank,
					venueFull: pubIn || venue.name,
					citationCount: 0,
					pages,
				});
			}

			if (bindings.length < pageSize) break;
		} catch {
			break;
		}
	}

	if (candidates.length === 0) {
		return { items: [], totalResults: totalBindingsObserved };
	}

	const enriched = await enrichDblpItemsBatch(
		candidates,
		venue,
		fetchJson,
		options?.preloadedItems,
	);
	return { items: enriched, totalResults: enriched.length };
}

/**
 * Fetch complete, multi-page 2026 venue papers (full update per Venue):
 * 1. Official DBLP SPARQL (`sparql.dblp.org`, paginated `LIMIT/OFFSET` up to 8,000 records,
 *    excluding proceedings editorships and `@` co-located workshops) + OpenAlex/Crossref
 *    cursor-paginated full proceedings & journals (up to 5,000 records, retaining abstract-less
 *    publisher papers rather than dropping them).
 * 2. Semantic Scholar Bulk abstract & arXiv-preprint backfill onto primary proceedings papers
 *    when publisher records omit public abstracts (common for ACM/IEEE conferences like ASE/ICSE).
 * 3. Early pre-proceedings fallback (Semantic Scholar Bulk + arXiv confirmed accepted papers)
 *    when neither DBLP nor OpenAlex/Crossref has indexed the 2026 proceedings yet (< 25 papers).
 */
export async function fetchMultiChannelVenuePapers(
	venue: VenueConfig,
	year: number,
	rawFetchJson: FetchJsonFn,
	rawFetchText: FetchTextFn,
	options?: {
		maxPages?: number;
	},
): Promise<{
	items: CollectionPaperItem[];
	remoteTotalCount: number;
	latestPublishedAt: string | null;
}> {
	let requestCount = 0;
	let successCount = 0;
	let lastError: unknown = null;

	const trackedFetchJson: FetchJsonFn = async <T = unknown>(
		url: string,
	): Promise<T> => {
		requestCount += 1;
		try {
			const res = await rawFetchJson<T>(url);
			successCount += 1;
			return res;
		} catch (err) {
			lastError = err;
			throw err;
		}
	};

	const trackedFetchText: FetchTextFn = async (
		url: string,
		accept?: string,
	): Promise<string> => {
		requestCount += 1;
		try {
			const res = await rawFetchText(url, accept);
			successCount += 1;
			return res;
		} catch (err) {
			lastError = err;
			throw err;
		}
	};

	const fetchJson = createPoliteFetchJson(trackedFetchJson);
	const fetchText = createPoliteFetchText(trackedFetchText);
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	const venueKind = spec?.kind ?? inferVenueKind(venue);
	const maxPages = options?.maxPages ?? 25;

	// Tier 1: OpenAlex + Crossref cursor-paginated full proceedings & journals
	const structured = await fetchVenueStructuredPapers(venue, year, fetchJson, {
		maxPages,
	});

	// Tier 2: First-class paginated DBLP SPARQL enriched in-memory from `structured.items` first
	const dblpRes = await fetchDblpSparqlVenuePapers(
		venue,
		year,
		new Set(),
		fetchJson,
		{
			preloadedItems: structured.items,
		},
	);

	// When DBLP has indexed a conference, its main-venue paper list is authoritative (excluding
	// co-located workshops/companion tracks that OpenAlex sometimes bundles under one source ID).
	// When DBLP lags behind publisher proceedings (e.g. newly published ACM/IEEE volumes) or for
	// journals, union DBLP + OpenAlex/Crossref so zero published papers are missed.
	const dblpIsAuthoritativeConference =
		venueKind === "conference" &&
		dblpRes.items.length >= 25 &&
		dblpRes.items.length >= structured.items.length * 0.45;

	let primaryItems = dblpIsAuthoritativeConference
		? dedupeVenueChannelItems([dblpRes.items])
		: dedupeVenueChannelItems([dblpRes.items, structured.items]);

	// Backfill missing abstracts & arXiv PDFs via S2 Bulk for proceedings with sparse publisher abstracts
	const missingAbstractCount = primaryItems.filter((p) => !p.abstract).length;
	if (
		primaryItems.length >= 25 &&
		missingAbstractCount >= 15 &&
		spec?.s2VenueNames?.length
	) {
		const s2Backfill = await fetchSemanticScholarVenuePapers(
			venue,
			year,
			fetchJson,
			{
				maxPages: 2,
			},
		);
		if (s2Backfill.items.length > 0) {
			primaryItems = backfillMissingMetadataFromChannel(
				primaryItems,
				s2Backfill.items,
			);
		}
	}

	// Tier 3: S2 Bulk + arXiv accepted metadata ONLY when official proceedings are not indexed yet (< 25 papers)
	const needEarlyPreprintChannels = primaryItems.length < 25;

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
			maxPages: 4,
		});
		arxivTotal = arxivRes.totalResults;
		if (arxivRes.items.length > 0) {
			arxivVenueItems = await enrichArxivItemsBatch(
				arxivRes.items,
				fetchJson,
				225,
			);
		}
	}

	const merged = needEarlyPreprintChannels
		? dedupeVenueChannelItems([primaryItems, s2Items, arxivVenueItems])
		: primaryItems;

	if (
		merged.length === 0 &&
		requestCount > 0 &&
		successCount === 0 &&
		lastError
	) {
		throw lastError;
	}

	let latestPublishedAt: string | null = null;
	for (const item of merged) {
		if (!latestPublishedAt || item.publishedAt > latestPublishedAt) {
			latestPublishedAt = item.publishedAt;
		}
	}

	const remoteTotalCount = dblpIsAuthoritativeConference
		? merged.length
		: Math.max(
				merged.length,
				structured.remoteTotalCount ?? 0,
				dblpRes.totalResults,
				needEarlyPreprintChannels ? arxivTotal : 0,
				needEarlyPreprintChannels ? s2Total : 0,
			);

	return {
		items: merged,
		remoteTotalCount,
		latestPublishedAt,
	};
}
