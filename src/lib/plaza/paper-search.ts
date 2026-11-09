/**
 * Plaza — Paper Discover Engine.
 *
 * Ports the lightweight multi-source metadata searchers and deduplication logic
 * from `dr-dumpling/PaperSearch` (`DBLPSearcher`, `ACMSearcher`, `USENIXSearcher`,
 * `IACRSearcher`, `OpenReviewSearcher`, `ArxivSearcher`, `SemanticScholarSearcher`,
 * `OpenAlexSearcher`) into Agentero for AI & SE researchers.
 *
 * Search is strictly metadata-only (zero PDF bytes downloaded during search).
 * Users select/multi-select papers and click "Add to Library" to trigger PDF
 * download and Vault ingestion.
 */

import { listenAgentCompleted, listenAgentFailed, runOnce } from "@/lib/agent";
import {
	parseArxivAtomXml,
	plazaFetchJson,
	plazaFetchText,
} from "@/lib/plaza/collection";
import { resolveConfiguredTranslateAgent } from "@/lib/translate/resolve-agent";
import { getVaultPath } from "@/lib/vault/store";

export type DiscoverSourceId =
	| "dblp"
	| "acm"
	| "arxiv"
	| "s2"
	| "openreview"
	| "iacr"
	| "usenix"
	| "openalex";

export const DISCOVER_SOURCES: readonly {
	id: DiscoverSourceId;
	label: string;
	shortLabel: string;
	description: string;
}[] = [
	{
		id: "dblp",
		label: "DBLP",
		shortLabel: "DBLP",
		description: "CS / SE / PL / Security conferences & journals",
	},
	{
		id: "acm",
		label: "ACM DL",
		shortLabel: "ACM",
		description: "ICSE, FSE, ASE, ISSTA, PLDI, POPL, OOPSLA, CCS (10.1145)",
	},
	{
		id: "arxiv",
		label: "arXiv",
		shortLabel: "arXiv",
		description: "cs.AI, cs.CR, cs.PL, cs.SE preprints",
	},
	{
		id: "s2",
		label: "Semantic Scholar",
		shortLabel: "S2",
		description: "AI & CS citation graph and abstracts",
	},
	{
		id: "openreview",
		label: "OpenReview",
		shortLabel: "OR",
		description: "ICLR, NeurIPS, ICML & workshops",
	},
	{
		id: "usenix",
		label: "USENIX",
		shortLabel: "USENIX",
		description: "USENIX Security, OSDI, NSDI, ATC",
	},
	{
		id: "iacr",
		label: "IACR ePrint",
		shortLabel: "IACR",
		description: "Cryptography & Security ePrint archive",
	},
	{
		id: "openalex",
		label: "OpenAlex",
		shortLabel: "OA",
		description: "Global scholarly index & metadata",
	},
];

export const DEFAULT_DISCOVER_SOURCES: readonly DiscoverSourceId[] = [
	"dblp",
	"acm",
	"arxiv",
	"s2",
	"openreview",
	"usenix",
];

export type DiscoverPaper = {
	id: string;
	title: string;
	authors: string[];
	abstract: string;
	year: number | null;
	venue: string;
	source: DiscoverSourceId;
	sources: DiscoverSourceId[];
	doi: string;
	arxivId: string;
	url: string;
	pdfUrl: string;
	citationCount: number;
	matchedQueries: string[];
};

export type DiscoverSearchOptions = {
	sources?: readonly DiscoverSourceId[];
	yearFrom?: number;
	maxPerSource?: number;
};

export type DiscoverSearchReport = {
	query: string;
	queriesExecuted: string[];
	papers: DiscoverPaper[];
	sourceCounts: Partial<Record<DiscoverSourceId, number>>;
	failedSources: DiscoverSourceId[];
};

function cleanText(text: string): string {
	return text
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeTitleKey(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "")
		.trim();
}

/**
 * Ported from `dr-dumpling/PaperSearch/src/platforms/DBLPSearcher.ts`.
 */
async function searchDblp(
	query: string,
	maxResults: number,
	yearFrom?: number,
): Promise<DiscoverPaper[]> {
	const q = encodeURIComponent(query.trim());
	const url = `https://dblp.org/search/publ/api?q=${q}&format=json&h=${Math.min(maxResults * 2, 50)}&c=0`;
	const data = await plazaFetchJson<{
		result?: {
			hits?: {
				hit?:
					| Array<{
							"@id"?: string;
							info?: {
								title?: string;
								venue?: string;
								year?: string;
								doi?: string;
								ee?: string | string[];
								url?: string;
								key?: string;
								authors?: {
									author?:
										| Array<{ text?: string } | string>
										| { text?: string }
										| string;
								};
							};
					  }>
					| {
							"@id"?: string;
							info?: {
								title?: string;
								venue?: string;
								year?: string;
								doi?: string;
								ee?: string | string[];
								url?: string;
								key?: string;
								authors?: {
									author?:
										| Array<{ text?: string } | string>
										| { text?: string }
										| string;
								};
							};
					  };
			};
		};
	}>(url);

	const rawHit = data.result?.hits?.hit;
	const hits = Array.isArray(rawHit) ? rawHit : rawHit ? [rawHit] : [];
	const out: DiscoverPaper[] = [];

	for (const hit of hits) {
		const info = hit.info;
		if (!info?.title) continue;
		const year = info.year ? Number(info.year) || null : null;
		if (yearFrom && year && year < yearFrom) continue;

		const rawAuthors = info.authors?.author;
		const authorArr = Array.isArray(rawAuthors)
			? rawAuthors
			: rawAuthors
				? [rawAuthors]
				: [];
		const authors = authorArr
			.map((a) => (typeof a === "string" ? a : (a.text ?? "")))
			.map((s) => s.trim())
			.filter(Boolean);

		const doi = (info.doi ?? "").trim();
		const ee = Array.isArray(info.ee) ? (info.ee[0] ?? "") : (info.ee ?? "");
		const itemUrl = ee || (doi ? `https://doi.org/${doi}` : (info.url ?? ""));
		const title = cleanText(info.title.replace(/\.$/, ""));
		const venue = cleanText(info.venue ?? "DBLP");
		const arxivMatch = /arxiv\.org\/abs\/([^\s/?#]+)/i.exec(ee);
		const arxivId = arxivMatch ? arxivMatch[1].replace(/v\d+$/i, "") : "";

		out.push({
			id: doi
				? `doi:${doi.toLowerCase()}`
				: info.key
					? `dblp:${info.key}`
					: `dblp:${normalizeTitleKey(title)}`,
			title,
			authors,
			abstract: "",
			year,
			venue,
			source: "dblp",
			sources: ["dblp"],
			doi,
			arxivId,
			url: itemUrl || `https://dblp.org/rec/${info.key ?? ""}`,
			pdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : "",
			citationCount: 0,
			matchedQueries: [query],
		});
		if (out.length >= maxResults) break;
	}
	return out;
}

/**
 * Ported from `dr-dumpling/PaperSearch/src/platforms/ACMSearcher.ts`.
 * Queries Crossref with `prefix:10.1145` for ACM Digital Library papers + abstracts.
 */
async function searchAcm(
	query: string,
	maxResults: number,
	yearFrom?: number,
): Promise<DiscoverPaper[]> {
	const filters = ["prefix:10.1145"];
	if (yearFrom) {
		filters.push(`from-pub-date:${yearFrom}`);
	}
	const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&filter=${encodeURIComponent(filters.join(","))}&rows=${Math.min(maxResults * 2, 30)}&sort=relevance`;
	const data = await plazaFetchJson<{
		message?: {
			items?: Array<{
				DOI?: string;
				title?: string[];
				abstract?: string;
				author?: Array<{ given?: string; family?: string }>;
				"container-title"?: string[];
				"is-referenced-by-count"?: number;
				published?: { "date-parts"?: number[][] };
				"published-print"?: { "date-parts"?: number[][] };
				"published-online"?: { "date-parts"?: number[][] };
			}>;
		};
	}>(url);

	const items = data.message?.items ?? [];
	const out: DiscoverPaper[] = [];

	for (const item of items) {
		const doi = (item.DOI ?? "").trim();
		const title = cleanText(item.title?.[0] ?? "");
		if (!doi || !title) continue;

		const dateParts =
			item["published-print"]?.["date-parts"]?.[0] ??
			item["published-online"]?.["date-parts"]?.[0] ??
			item.published?.["date-parts"]?.[0] ??
			[];
		const year = typeof dateParts[0] === "number" ? dateParts[0] : null;
		if (yearFrom && year && year < yearFrom) continue;

		const authors = (item.author ?? [])
			.map((a) => `${a.given ?? ""} ${a.family ?? ""}`.trim())
			.filter(Boolean);
		const venue = cleanText(item["container-title"]?.[0] ?? "ACM DL");
		const abstract = cleanText(item.abstract ?? "");

		out.push({
			id: `doi:${doi.toLowerCase()}`,
			title,
			authors,
			abstract,
			year,
			venue,
			source: "acm",
			sources: ["acm"],
			doi,
			arxivId: "",
			url: `https://dl.acm.org/doi/${doi}`,
			pdfUrl: "",
			citationCount: item["is-referenced-by-count"] ?? 0,
			matchedQueries: [query],
		});
		if (out.length >= maxResults) break;
	}
	return out;
}

/**
 * Ported from `dr-dumpling/PaperSearch/src/platforms/USENIXSearcher.ts`.
 */
const USENIX_TERMS = [
	"usenix",
	"osdi",
	"fast",
	"nsdi",
	"atc",
	"security symposium",
	"woot",
	"soups",
];

async function searchUsenix(
	query: string,
	maxResults: number,
	yearFrom?: number,
): Promise<DiscoverPaper[]> {
	const dblpItems = await searchDblp(
		`${query} USENIX`,
		Math.max(maxResults * 3, 24),
		yearFrom,
	);
	return dblpItems
		.filter((paper) => {
			const hay =
				`${paper.title} ${paper.venue} ${paper.url} ${paper.doi}`.toLowerCase();
			return USENIX_TERMS.some((term) => hay.includes(term));
		})
		.map((paper) => ({
			...paper,
			source: "usenix" as const,
			sources: ["usenix" as const],
		}))
		.slice(0, maxResults);
}

/**
 * Ported from `dr-dumpling/PaperSearch/src/platforms/OpenReviewSearcher.ts`.
 */
async function searchOpenReview(
	query: string,
	maxResults: number,
	yearFrom?: number,
): Promise<DiscoverPaper[]> {
	const url = `https://api.openreview.net/notes/search?term=${encodeURIComponent(query)}&limit=${Math.min(maxResults * 2, 30)}`;
	const data = await plazaFetchJson<{
		notes?: Array<{
			id?: string;
			forum?: string;
			cdate?: number;
			pdate?: number;
			tcdate?: number;
			content?: Record<string, unknown>;
		}>;
	}>(url);

	const notes = data.notes ?? [];
	const out: DiscoverPaper[] = [];

	const readVal = (content: Record<string, unknown>, key: string): unknown => {
		const raw = content[key];
		if (
			raw &&
			typeof raw === "object" &&
			!Array.isArray(raw) &&
			"value" in raw
		) {
			return (raw as { value?: unknown }).value;
		}
		return raw;
	};

	for (const note of notes) {
		const content = note.content ?? {};
		const rawTitle = readVal(content, "title");
		const title = typeof rawTitle === "string" ? cleanText(rawTitle) : "";
		if (!title) continue;

		const rawAuthors = readVal(content, "authors");
		const authors = Array.isArray(rawAuthors)
			? rawAuthors.map((a) => String(a).trim()).filter(Boolean)
			: [];
		const rawAbstract = readVal(content, "abstract");
		const abstract =
			typeof rawAbstract === "string" ? cleanText(rawAbstract) : "";
		const rawVenue =
			readVal(content, "venue") ?? readVal(content, "venueid") ?? "OpenReview";
		const venue =
			typeof rawVenue === "string" ? cleanText(rawVenue) : "OpenReview";
		const ts = note.pdate || note.cdate || note.tcdate;
		const year = ts ? new Date(ts).getFullYear() : null;
		if (yearFrom && year && year < yearFrom) continue;

		const forumId = note.forum || note.id || "";
		const itemUrl = forumId
			? `https://openreview.net/forum?id=${forumId}`
			: "https://openreview.net";
		const pdfUrl = forumId ? `https://openreview.net/pdf?id=${forumId}` : "";

		out.push({
			id: `openreview:${forumId || normalizeTitleKey(title)}`,
			title,
			authors,
			abstract,
			year,
			venue,
			source: "openreview",
			sources: ["openreview"],
			doi: "",
			arxivId: "",
			url: itemUrl,
			pdfUrl,
			citationCount: 0,
			matchedQueries: [query],
		});
		if (out.length >= maxResults) break;
	}
	return out;
}

/**
 * Ported from `dr-dumpling/PaperSearch/src/platforms/IACRSearcher.ts`.
 */
async function searchIacr(
	query: string,
	maxResults: number,
	yearFrom?: number,
): Promise<DiscoverPaper[]> {
	const url = `https://eprint.iacr.org/search?q=${encodeURIComponent(query)}`;
	const html = await plazaFetchText(url);
	const out: DiscoverPaper[] = [];

	const itemRegex =
		/<a[^>]*href=["']\/(\d{4}\/\d{3,6})["'][^>]*>[\s\S]*?<\/a>([\s\S]*?)(?=<a[^>]*href=["']\/\d{4}\/\d{3,6}["']|$)/gi;
	for (const match of html.matchAll(itemRegex)) {
		const paperId = (match[1] ?? "").trim();
		const block = match[2] ?? "";
		if (!paperId) continue;
		const year = Number(paperId.slice(0, 4)) || null;
		if (yearFrom && year && year < yearFrom) continue;

		const titleMatch =
			/<strong[^>]*>([\s\S]*?)<\/strong>/i.exec(block) ??
			/<span[^>]*class=["'][^"']*paper-title[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(
				block,
			);
		const title = cleanText(titleMatch?.[1] ?? "");
		if (!title || title.length < 5) continue;

		out.push({
			id: `iacr:${paperId}`,
			title,
			authors: [],
			abstract: cleanText(block).slice(0, 360),
			year,
			venue: `IACR ePrint ${paperId}`,
			source: "iacr",
			sources: ["iacr"],
			doi: "",
			arxivId: "",
			url: `https://eprint.iacr.org/${paperId}`,
			pdfUrl: `https://eprint.iacr.org/${paperId}.pdf`,
			citationCount: 0,
			matchedQueries: [query],
		});
		if (out.length >= maxResults) break;
	}
	return out;
}

async function searchArxiv(
	query: string,
	maxResults: number,
	yearFrom?: number,
): Promise<DiscoverPaper[]> {
	const terms = query
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((t) => `all:${encodeURIComponent(t)}`)
		.join("+AND+");
	if (!terms) return [];
	const catFilter =
		"(cat:cs.AI+OR+cat:cs.CR+OR+cat:cs.PL+OR+cat:cs.SE+OR+cat:cs.LG+OR+cat:cs.CL)";
	const url = `https://export.arxiv.org/api/query?search_query=(${terms})+AND+${catFilter}&sortBy=relevance&sortOrder=descending&max_results=${Math.min(maxResults * 2, 30)}`;
	const xml = await plazaFetchText(url, "application/atom+xml,text/xml,*/*");
	const parsed = parseArxivAtomXml(xml, yearFrom ?? null);
	return parsed.slice(0, maxResults).map((item) => ({
		id: item.id,
		title: item.title,
		authors: item.authors,
		abstract: item.abstract,
		year: item.year,
		venue: `arXiv · ${item.sourceLabel}`,
		source: "arxiv" as const,
		sources: ["arxiv" as const],
		doi: item.doi ?? "",
		arxivId: item.arxivId ?? "",
		url: item.url,
		pdfUrl: item.pdfUrl ?? "",
		citationCount: 0,
		matchedQueries: [query],
	}));
}

async function searchSemanticScholar(
	query: string,
	maxResults: number,
	yearFrom?: number,
): Promise<DiscoverPaper[]> {
	const yearParam = yearFrom ? `&year=${yearFrom}-` : "";
	const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${Math.min(maxResults, 25)}&fields=title,authors,year,abstract,venue,externalIds,url,openAccessPdf,citationCount${yearParam}`;
	const data = await plazaFetchJson<{
		data?: Array<{
			paperId?: string;
			title?: string;
			abstract?: string | null;
			year?: number | null;
			venue?: string | null;
			url?: string | null;
			citationCount?: number | null;
			authors?: Array<{ name?: string }>;
			externalIds?: { DOI?: string; ArXiv?: string };
			openAccessPdf?: { url?: string };
		}>;
	}>(url);

	const rows = data.data ?? [];
	const out: DiscoverPaper[] = [];
	for (const row of rows) {
		const title = cleanText(row.title ?? "");
		if (!title) continue;
		const doi = (row.externalIds?.DOI ?? "").trim();
		const arxivId = (row.externalIds?.ArXiv ?? "").trim();
		const pdfUrl =
			row.openAccessPdf?.url ??
			(arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : "");
		const itemUrl =
			row.url ||
			(doi
				? `https://doi.org/${doi}`
				: arxivId
					? `https://arxiv.org/abs/${arxivId}`
					: "");

		out.push({
			id: doi
				? `doi:${doi.toLowerCase()}`
				: arxivId
					? `arxiv:${arxivId}`
					: `s2:${row.paperId ?? normalizeTitleKey(title)}`,
			title,
			authors: (row.authors ?? [])
				.map((a) => (a.name ?? "").trim())
				.filter(Boolean),
			abstract: cleanText(row.abstract ?? ""),
			year: row.year ?? null,
			venue: cleanText(row.venue || (arxivId ? "arXiv" : "Semantic Scholar")),
			source: "s2",
			sources: ["s2"],
			doi,
			arxivId,
			url: itemUrl,
			pdfUrl,
			citationCount: row.citationCount ?? 0,
			matchedQueries: [query],
		});
	}
	return out;
}

async function searchOpenAlex(
	query: string,
	maxResults: number,
	yearFrom?: number,
): Promise<DiscoverPaper[]> {
	const filterParam = yearFrom
		? `&filter=from_publication_date:${yearFrom}-01-01`
		: "";
	const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${Math.min(maxResults, 25)}${filterParam}`;
	const data = await plazaFetchJson<{
		results?: Array<{
			id?: string;
			title?: string;
			publication_year?: number;
			doi?: string | null;
			cited_by_count?: number;
			primary_location?: {
				landing_page_url?: string | null;
				pdf_url?: string | null;
				source?: { display_name?: string | null } | null;
			} | null;
			authorships?: Array<{
				author?: { display_name?: string | null };
			}>;
		}>;
	}>(url);

	const rows = data.results ?? [];
	const out: DiscoverPaper[] = [];
	for (const row of rows) {
		const title = cleanText(row.title ?? "");
		if (!title) continue;
		const rawDoi = (row.doi ?? "")
			.replace(/^https?:\/\/doi\.org\//i, "")
			.trim();
		const venue = cleanText(
			row.primary_location?.source?.display_name ?? "OpenAlex",
		);
		const itemUrl =
			row.primary_location?.landing_page_url ||
			(rawDoi ? `https://doi.org/${rawDoi}` : (row.id ?? ""));

		out.push({
			id: rawDoi
				? `doi:${rawDoi.toLowerCase()}`
				: `openalex:${row.id ?? normalizeTitleKey(title)}`,
			title,
			authors: (row.authorships ?? [])
				.map((a) => (a.author?.display_name ?? "").trim())
				.filter(Boolean),
			abstract: "",
			year: row.publication_year ?? null,
			venue,
			source: "openalex",
			sources: ["openalex"],
			doi: rawDoi,
			arxivId: "",
			url: itemUrl,
			pdfUrl: row.primary_location?.pdf_url ?? "",
			citationCount: row.cited_by_count ?? 0,
			matchedQueries: [query],
		});
	}
	return out;
}

/**
 * Deduplicate and fuse multi-source paper results (ported and enhanced from
 * `dr-dumpling/PaperSearch/src/capabilities/metadata-search/MultiSourceSearchService.ts`).
 */
export function dedupeDiscoverPapers(
	papers: readonly DiscoverPaper[],
): DiscoverPaper[] {
	const byKey = new Map<string, number>();
	const byTitle = new Map<string, number>();
	const out: DiscoverPaper[] = [];

	const isPreprint = (p: DiscoverPaper) =>
		p.source === "arxiv" ||
		p.source === "iacr" ||
		/^10\.48550\/arxiv\./i.test(p.doi);

	for (const paper of papers) {
		const doiKey = paper.doi ? `doi:${paper.doi.toLowerCase()}` : "";
		const arxivKey = paper.arxivId
			? `arxiv:${paper.arxivId.toLowerCase().replace(/v\d+$/, "")}`
			: "";
		const titleKey = normalizeTitleKey(paper.title);

		const existingIdx =
			(doiKey ? byKey.get(doiKey) : undefined) ??
			(arxivKey ? byKey.get(arxivKey) : undefined) ??
			(titleKey ? byTitle.get(titleKey) : undefined);

		if (existingIdx === undefined) {
			const idx = out.length;
			out.push({
				...paper,
				sources: [...paper.sources],
				matchedQueries: [...paper.matchedQueries],
			});
			if (doiKey) byKey.set(doiKey, idx);
			if (arxivKey) byKey.set(arxivKey, idx);
			if (titleKey) byTitle.set(titleKey, idx);
			continue;
		}

		const prev = out[existingIdx];
		if (!prev) continue;

		const preferCurrent = isPreprint(prev) && !isPreprint(paper);
		const primary = preferCurrent ? paper : prev;
		const secondary = preferCurrent ? prev : paper;

		const mergedSources = Array.from(
			new Set([...prev.sources, ...paper.sources]),
		);
		const mergedQueries = Array.from(
			new Set([...prev.matchedQueries, ...paper.matchedQueries]),
		);

		out[existingIdx] = {
			...primary,
			abstract:
				primary.abstract.length >= secondary.abstract.length
					? primary.abstract
					: secondary.abstract,
			authors:
				primary.authors.length >= secondary.authors.length
					? primary.authors
					: secondary.authors,
			doi: primary.doi || secondary.doi,
			arxivId: primary.arxivId || secondary.arxivId,
			pdfUrl: primary.pdfUrl || secondary.pdfUrl,
			url: primary.url || secondary.url,
			year: primary.year ?? secondary.year,
			citationCount: Math.max(primary.citationCount, secondary.citationCount),
			sources: mergedSources,
			matchedQueries: mergedQueries,
		};
	}

	// Score by multi-query consensus, multi-source consensus, recency, and citations.
	return out.sort((a, b) => {
		const qDiff = b.matchedQueries.length - a.matchedQueries.length;
		if (qDiff !== 0) return qDiff;
		const sDiff = b.sources.length - a.sources.length;
		if (sDiff !== 0) return sDiff;
		const yDiff = (b.year ?? 0) - (a.year ?? 0);
		if (Math.abs(yDiff) > 1) return yDiff;
		return b.citationCount - a.citationCount;
	});
}

async function runSingleSourceSearch(
	source: DiscoverSourceId,
	query: string,
	maxResults: number,
	yearFrom?: number,
): Promise<DiscoverPaper[]> {
	switch (source) {
		case "dblp":
			return await searchDblp(query, maxResults, yearFrom);
		case "acm":
			return await searchAcm(query, maxResults, yearFrom);
		case "usenix":
			return await searchUsenix(query, maxResults, yearFrom);
		case "openreview":
			return await searchOpenReview(query, maxResults, yearFrom);
		case "iacr":
			return await searchIacr(query, maxResults, yearFrom);
		case "arxiv":
			return await searchArxiv(query, maxResults, yearFrom);
		case "s2":
			return await searchSemanticScholar(query, maxResults, yearFrom);
		case "openalex":
			return await searchOpenAlex(query, maxResults, yearFrom);
	}
}

/**
 * Execute a fast multi-source metadata search across the selected PaperSearch platforms.
 */
export async function searchPaperDiscover(
	query: string,
	options: DiscoverSearchOptions = {},
): Promise<DiscoverSearchReport> {
	return await executeMultiQueryDiscover([query], options);
}

/**
 * Execute multiple split sub-queries concurrently across selected PaperSearch platforms.
 */
export async function executeMultiQueryDiscover(
	queries: readonly string[],
	options: DiscoverSearchOptions = {},
): Promise<DiscoverSearchReport> {
	const cleanQueries = queries.map((q) => q.trim()).filter(Boolean);
	const sources =
		options.sources && options.sources.length > 0
			? options.sources
			: DEFAULT_DISCOVER_SOURCES;
	const maxPerSource = options.maxPerSource ?? 10;

	const sourceCounts: Partial<Record<DiscoverSourceId, number>> = {};
	const failedSet = new Set<DiscoverSourceId>();
	const allPapers: DiscoverPaper[] = [];

	const tasks: Array<
		Promise<{
			source: DiscoverSourceId;
			ok: boolean;
			items: DiscoverPaper[];
		}>
	> = [];

	for (const q of cleanQueries) {
		for (const source of sources) {
			tasks.push(
				runSingleSourceSearch(source, q, maxPerSource, options.yearFrom)
					.then((items) => ({ source, ok: true, items }))
					.catch(() => ({ source, ok: false, items: [] })),
			);
		}
	}

	const outcomes = await Promise.all(tasks);
	for (const outcome of outcomes) {
		if (!outcome.ok) {
			failedSet.add(outcome.source);
			continue;
		}
		sourceCounts[outcome.source] =
			(sourceCounts[outcome.source] ?? 0) + outcome.items.length;
		allPapers.push(...outcome.items);
	}

	const deduped = dedupeDiscoverPapers(allPapers);
	return {
		query: cleanQueries[0] ?? "",
		queriesExecuted: cleanQueries,
		papers: deduped,
		sourceCounts,
		failedSources: Array.from(failedSet),
	};
}

// ---------------------------------------------------------------------------
// Grill-Me Interactive Agent Deep Search (Query Clarification & Splitting)
// ---------------------------------------------------------------------------

export type GrillOption = {
	id: string;
	label: string;
	/** Sub-queries or modifiers added when this option is picked. */
	addedQueries: string[];
	recommended?: boolean;
};

export type GrillQuestionStep = {
	id: string;
	stepNumber: number;
	totalSteps: number;
	question: string;
	options: GrillOption[];
};

export type DeepSearchSession = {
	originalQuery: string;
	probeSummary: string;
	probePreviewPapers: DiscoverPaper[];
	splitQueries: string[];
	stepIndex: number;
	steps: GrillQuestionStep[];
	answers: Array<{ question: string; chosenLabel: string }>;
	readyToExecute: boolean;
};

/**
 * Domain-aware AI & SE query splitter and Grill-Me clarification generator.
 * Runs a fast probe search first so the clarification options reflect actual
 * preliminary findings, then optionally enriches with the configured Agent.
 */
export async function createDeepSearchSession(
	rawQuery: string,
	options: DiscoverSearchOptions = {},
): Promise<DeepSearchSession> {
	const query = rawQuery.trim();
	// 1. Run a lightweight probe across DBLP + arXiv + S2 (4 results each, zero PDF download)
	const probeReport = await executeMultiQueryDiscover([query], {
		sources: ["dblp", "arxiv", "acm"],
		maxPerSource: 4,
		yearFrom: options.yearFrom,
	});

	const sampleVenues = Array.from(
		new Set(
			probeReport.papers
				.map((p) => p.venue)
				.filter(Boolean)
				.slice(0, 4),
		),
	);

	// Build initial smart split queries based on query tokens & AI/SE domain patterns
	const baseSplits = buildHeuristicSplitQueries(query);
	const defaultSteps = buildGrillStepsForQuery(query, sampleVenues);

	let probeSummary =
		probeReport.papers.length > 0
			? `初步探测命中 ${probeReport.papers.length} 篇候选文献（涵盖 ${sampleVenues.join(" / ") || "arXiv / DBLP"}）。已为你生成初步 Query 拆分，可通过下方追问进一步确定粒度，或随时直接开始检索。`
			: "已完成领域语义分析并生成多维子 Query 组合。可通过下方交互快速收敛检索粒度，或随时点击「立即开始检索」。";

	// Try to enrich splitQueries + first question via configured Agent with a tight 6s timeout
	try {
		const agentEnriched = await tryAgentGrillEnrichment(
			query,
			probeReport.papers.slice(0, 5),
		);
		if (agentEnriched) {
			if (agentEnriched.summary) probeSummary = agentEnriched.summary;
			if (agentEnriched.splitQueries.length > 0) {
				for (const sq of agentEnriched.splitQueries) {
					if (!baseSplits.includes(sq)) baseSplits.push(sq);
				}
			}
			if (agentEnriched.steps.length > 0) {
				return {
					originalQuery: query,
					probeSummary,
					probePreviewPapers: probeReport.papers.slice(0, 4),
					splitQueries: baseSplits.slice(0, 5),
					stepIndex: 0,
					steps: agentEnriched.steps,
					answers: [],
					readyToExecute: false,
				};
			}
		}
	} catch {
		// Fall back seamlessly to domain heuristic steps.
	}

	return {
		originalQuery: query,
		probeSummary,
		probePreviewPapers: probeReport.papers.slice(0, 4),
		splitQueries: baseSplits.slice(0, 5),
		stepIndex: 0,
		steps: defaultSteps,
		answers: [],
		readyToExecute: false,
	};
}

function buildHeuristicSplitQueries(query: string): string[] {
	const q = query.trim();
	const lower = q.toLowerCase();
	const splits = [q];

	if (
		lower.includes("agent") ||
		lower.includes("llm") ||
		lower.includes("code")
	) {
		splits.push(`${q} software engineering`);
		splits.push(`${q} benchmark evaluation`);
	} else if (
		lower.includes("fuzz") ||
		lower.includes("vuln") ||
		lower.includes("taint") ||
		lower.includes("security")
	) {
		splits.push(`${q} vulnerability detection`);
		splits.push(`${q} program analysis`);
	} else {
		splits.push(`${q} automated software engineering`);
		splits.push(`${q} deep learning LLM`);
	}
	return Array.from(new Set(splits));
}

function buildGrillStepsForQuery(
	query: string,
	sampleVenues: string[],
): GrillQuestionStep[] {
	const venueHint =
		sampleVenues.length > 0
			? sampleVenues.slice(0, 3).join(", ")
			: "ICSE, FSE, ASE, CCS, NeurIPS";
	return [
		{
			id: "granularity",
			stepNumber: 1,
			totalSteps: 3,
			question: `针对「${query}」，你最关注哪个研究切入粒度？`,
			options: [
				{
					id: "method-system",
					label:
						"(Recommended) 核心技术、系统框架与算法设计（Method / Framework / Tool）",
					addedQueries: [
						`${query} framework approach`,
						`${query} static dynamic analysis`,
					],
					recommended: true,
				},
				{
					id: "empirical-bench",
					label:
						"实证研究、Benchmark 评测与综述（Empirical Study / Benchmark / Survey）",
					addedQueries: [
						`${query} empirical study benchmark`,
						`${query} survey taxonomy`,
					],
				},
				{
					id: "security-reliability",
					label:
						"安全漏洞、形式化验证与可靠性保障（Security / Vulnerability / Verification）",
					addedQueries: [
						`${query} vulnerability detection security`,
						`${query} formal verification testing`,
					],
				},
			],
		},
		{
			id: "venue-scope",
			stepNumber: 2,
			totalSteps: 3,
			question: `初步结果涉及 ${venueHint} 等来源，你希望如何侧重检索渠道？`,
			options: [
				{
					id: "se-pl-sec-top",
					label:
						"(Recommended) 重点聚焦 SE / PL / Security 顶会（ICSE, FSE, ASE, ISSTA, PLDI, CCS, USENIX）与最新 arXiv",
					addedQueries: [
						`${query} ICSE FSE ASE ISSTA`,
						`${query} CCS USENIX PLDI`,
					],
					recommended: true,
				},
				{
					id: "ai-ml-top",
					label:
						"重点聚焦 AI / LLM 顶会（NeurIPS, ICLR, ICML, AAAI, ACL）与预印本",
					addedQueries: [`${query} LLM agent NeurIPS ICLR`],
				},
				{
					id: "broad-all",
					label: "全库广度覆盖（不额外限定顶会缩写，最大化召回率）",
					addedQueries: [],
				},
			],
		},
		{
			id: "application-target",
			stepNumber: 3,
			totalSteps: 3,
			question:
				"是否需要补充特定技术路线关键词（如 LLM Agent、程序分析、模糊测试）？",
			options: [
				{
					id: "llm-agent-se",
					label:
						"(Recommended) 结合 LLM / Agent 自动化方法（LLM-based / Autonomous Agent）",
					addedQueries: [`${query} large language model agent`],
					recommended: true,
				},
				{
					id: "program-analysis",
					label:
						"结合传统程序分析 / 符号执行 / Fuzzing（AST / CFG / Fuzzing / Symbolic）",
					addedQueries: [`${query} program analysis fuzzing`],
				},
				{
					id: "keep-current",
					label: "保持当前已拆分的 Query 组合，直接完成确认",
					addedQueries: [],
				},
			],
		},
	];
}

async function tryAgentGrillEnrichment(
	query: string,
	previewPapers: DiscoverPaper[],
): Promise<{
	summary?: string;
	splitQueries: string[];
	steps: GrillQuestionStep[];
} | null> {
	const resolved = await resolveConfiguredTranslateAgent();
	if (!resolved.agentId) return null;

	const previewLines = previewPapers
		.map((p, i) => `${i + 1}. ${p.title} (${p.venue}, ${p.year ?? "?"})`)
		.join("\n");

	const prompt = [
		"You are an AI & Software Engineering academic search strategist.",
		`User query: "${query}"`,
		"Preliminary hits:",
		previewLines || "(none yet)",
		"",
		"Return ONLY a JSON object with this exact shape (no markdown fences):",
		`{"summary": "1-sentence Chinese analysis of the topic & hits", "splitQueries": ["3 concise English search queries"], "question": "1 concise Chinese clarification question on search granularity", "options": [{"label": "(Recommended) Chinese option 1", "addedQuery": "English query"}, {"label": "Chinese option 2", "addedQuery": "English query"}, {"label": "Chinese option 3", "addedQuery": "English query"}]}`,
	].join("\n");

	const timeoutPromise = new Promise<null>((resolve) =>
		setTimeout(() => resolve(null), 5500),
	);

	const runPromise = (async () => {
		const accepted = await runOnce({
			prompt,
			agentId: resolved.agentId,
			modelId: resolved.modelId,
			vaultPath: getVaultPath() ?? undefined,
			workflow: "free",
			permissionMode: "auto",
			hideFromChatHistory: true,
		});

		const text = await new Promise<string>((resolve, reject) => {
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
				reject(new Error(ev.error || "Agent failed"));
			}).then((u) => unsubs.push(u));
		});

		const match = /\{[\s\S]*\}/.exec(text);
		if (!match) return null;
		const parsed = JSON.parse(match[0]) as {
			summary?: string;
			splitQueries?: string[];
			question?: string;
			options?: Array<{ label?: string; addedQuery?: string }>;
		};

		const fallbackSteps = buildGrillStepsForQuery(query, []);
		if (
			parsed.question &&
			Array.isArray(parsed.options) &&
			parsed.options.length >= 2
		) {
			fallbackSteps[0] = {
				id: "agent-step-1",
				stepNumber: 1,
				totalSteps: fallbackSteps.length,
				question: parsed.question,
				options: parsed.options.map((opt, idx) => ({
					id: `agent-opt-${idx}`,
					label: opt.label || `选项 ${idx + 1}`,
					addedQueries: opt.addedQuery ? [opt.addedQuery] : [],
					recommended: idx === 0,
				})),
			};
		}

		return {
			summary: parsed.summary,
			splitQueries: Array.isArray(parsed.splitQueries)
				? parsed.splitQueries.filter((s): s is string => typeof s === "string")
				: [],
			steps: fallbackSteps,
		};
	})();

	return await Promise.race([runPromise, timeoutPromise]);
}

/**
 * Apply the user's answer to the current Grill-Me question and advance to the next step.
 */
export function applyGrillOption(
	session: DeepSearchSession,
	option: GrillOption,
): DeepSearchSession {
	const currentStep = session.steps[session.stepIndex];
	const nextSplits = Array.from(
		new Set([...session.splitQueries, ...option.addedQueries]),
	).slice(0, 7);
	const nextIndex = session.stepIndex + 1;
	const isDone = nextIndex >= session.steps.length;

	return {
		...session,
		splitQueries: nextSplits,
		stepIndex: nextIndex,
		answers: [
			...session.answers,
			{
				question: currentStep?.question ?? "",
				chosenLabel: option.label.replace(/^\(Recommended\)\s*/i, ""),
			},
		],
		readyToExecute: isDone,
	};
}
