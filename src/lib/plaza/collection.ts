/**
 * Plaza — Paper Collection (2026 arXiv & Venue paper pool).
 *
 * Focuses on 2026 papers across configured arXiv categories (defaulting to
 * `cs.AI`, `cs.CR`, `cs.PL`, `cs.SE`) and configured conference Venue URLs
 * (with a built-in deterministic parser for `conf.researchr.org` tracks plus
 * DBLP 2026 venue indexing and optional Agent extraction for arbitrary pages).
 *
 * Only lightweight metadata is stored locally (~1 KB/paper). PDFs are never
 * downloaded until the user explicitly adds selected papers to the Library.
 */

import { listenAgentCompleted, listenAgentFailed, runOnce } from "@/lib/agent";
import { commands } from "@/lib/core/bindings";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import { resolveConfiguredTranslateAgent } from "@/lib/translate/resolve-agent";
import { getVaultPath } from "@/lib/vault/store";
import { webViewProxyUrl } from "@/lib/web-view/proxy-url";

export const DEFAULT_ARXIV_CATEGORIES = [
	"cs.SE",
	"cs.CR",
	"cs.PL",
	"cs.AI",
] as const;

export type CollectionSourceType = "arxiv" | "venue";

export type VenueConfig = {
	id: string;
	/** Short display name, e.g. `ASE 2026`, `ICSE 2026`. */
	name: string;
	/** Conference track URL, e.g. `https://conf.researchr.org/track/ase-2026/...`. */
	url: string;
	/** Extraction mode: deterministic script (`auto`) or Agent-assisted (`agent`). */
	mode: "auto" | "agent";
	lastFetchedAt?: string | null;
	paperCount?: number;
};

export type CollectionPaperItem = {
	/** Canonical deduplication id (`arxiv:<id>`, `doi:<doi>`, or `venue:<slug>`). */
	id: string;
	title: string;
	authors: string[];
	abstract: string;
	publishedAt: string;
	year: number;
	sourceType: CollectionSourceType;
	/** Primary category (e.g. `cs.SE`) or Venue badge (e.g. `ASE 2026`). */
	sourceLabel: string;
	/** All arXiv categories or track tags. */
	categories: string[];
	url: string;
	pdfUrl?: string;
	arxivId?: string;
	doi?: string;
	venueId?: string;
};

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

const STORAGE_KEY = "plaza:collection:state:v1";
const TARGET_YEAR = 2026;

export const DEFAULT_COLLECTION_VENUES: readonly VenueConfig[] = [
	{
		id: "ase-2026",
		name: "ASE 2026",
		url: "https://conf.researchr.org/track/ase-2026/ase-2026-research-track?#event-overview",
		mode: "auto",
	},
	{
		id: "icse-2026",
		name: "ICSE 2026",
		url: "https://conf.researchr.org/track/icse-2026/icse-2026-research-track?#event-overview",
		mode: "auto",
	},
	{
		id: "fse-2026",
		name: "FSE 2026",
		url: "https://conf.researchr.org/track/fse-2026/fse-2026-research-papers?#event-overview",
		mode: "auto",
	},
	{
		id: "issta-2026",
		name: "ISSTA 2026",
		url: "https://conf.researchr.org/track/issta-2026/issta-2026-papers?#event-overview",
		mode: "auto",
	},
	{
		id: "pldi-2026",
		name: "PLDI 2026",
		url: "https://conf.researchr.org/track/pldi-2026/pldi-2026-papers?#event-overview",
		mode: "auto",
	},
	{
		id: "tosem-2026",
		name: "TOSEM 2026",
		url: "https://dl.acm.org/journal/tosem",
		mode: "auto",
	},
	{
		id: "tse-2026",
		name: "TSE 2026",
		url: "https://www.computer.org/csdl/journal/ts",
		mode: "auto",
	},
];

type Listener = (state: CollectionState) => void;
const listeners = new Set<Listener>();

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

export function loadCollectionState(): CollectionState {
	const raw = readJsonStorage<Partial<CollectionState> | null>(
		STORAGE_KEY,
		memoryState,
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
			? raw.venues
			: [...DEFAULT_COLLECTION_VENUES];
	const items = Array.isArray(raw?.items) ? raw.items : [];
	return {
		categories,
		venues,
		items,
		lastRefreshedAt:
			typeof raw?.lastRefreshedAt === "string" ? raw.lastRefreshedAt : null,
		latestArxiv: raw?.latestArxiv ?? null,
	};
}

export function saveCollectionState(next: CollectionState): void {
	memoryState = next;
	writeJsonStorage(STORAGE_KEY, next);
	for (const listener of listeners) {
		listener(next);
	}
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
 * the Tauri WebView so non-CORS academic sites (`conf.researchr.org`, `dblp.org`,
 * `eprint.iacr.org`, `export.arxiv.org`) succeed cleanly.
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
			if (res.ok) {
				return await res.text();
			}
		} catch {
			// Fall through to direct fetch below.
		}
	} else if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
		try {
			const proxied = `/__plaza_proxy?url=${encodeURIComponent(cleanUrl)}`;
			const res = await fetch(proxied, {
				headers: { Accept: accept },
			});
			if (res.ok) {
				return await res.text();
			}
		} catch {
			// Fall through to direct fetch below.
		}
	}
	const direct = await fetch(cleanUrl, {
		headers: { Accept: accept },
	});
	if (!direct.ok) {
		throw new Error(`HTTP ${direct.status} fetching ${cleanUrl}`);
	}
	return await direct.text();
}

export async function plazaFetchJson<T = unknown>(url: string): Promise<T> {
	const text = await plazaFetchText(url, "application/json");
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

		items.push({
			id: `arxiv:${arxivId}`,
			arxivId,
			title: decodeHtmlEntities(rawTitle),
			authors,
			abstract: decodeHtmlEntities(rawSummary),
			publishedAt: dateStr || `${year}-01-01T00:00:00Z`,
			year,
			sourceType: "arxiv",
			sourceLabel: primaryCat,
			categories: categories.length > 0 ? categories : [primaryCat],
			url,
			pdfUrl,
		});
	}

	if (filterYear !== null) {
		const yearFiltered = items.filter((item) => item.year >= filterYear);
		// Keep 2026+ items when available; if arXiv returned older items on a quiet category, keep top items marked with their year.
		if (yearFiltered.length > 0) {
			return yearFiltered;
		}
	}
	return items;
}

/**
 * Fetch 2026 arXiv papers for the given categories (`cs.SE`, `cs.CR`, `cs.PL`, `cs.AI`).
 * Queries each category independently in parallel so high-volume categories (`cs.AI`)
 * never crowd out specialized categories (`cs.SE`, `cs.PL`, `cs.CR`).
 */
export async function fetchArxivCollection(
	categories: readonly string[],
	maxResultsPerCategory = 60,
): Promise<{
	items: CollectionPaperItem[];
	latest: ArxivLatestRecord | null;
}> {
	const cleanCats = categories.map((c) => c.trim()).filter(Boolean);
	if (cleanCats.length === 0) {
		return { items: [], latest: null };
	}
	const perCatResults = await Promise.allSettled(
		cleanCats.map(async (cat) => {
			const apiUrl = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(cat)}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResultsPerCategory}`;
			const xml = await plazaFetchText(
				apiUrl,
				"application/atom+xml,text/xml,*/*",
			);
			return parseArxivAtomXml(xml, TARGET_YEAR, {
				preferredCategories: cleanCats,
				defaultCategory: cat,
			});
		}),
	);

	const groups: CollectionPaperItem[][] = [];
	for (const outcome of perCatResults) {
		if (outcome.status === "fulfilled" && outcome.value.length > 0) {
			groups.push(outcome.value);
		}
	}

	if (groups.length === 0) {
		const catQuery =
			cleanCats.length === 1
				? `cat:${cleanCats[0]}`
				: `(${cleanCats.map((c) => `cat:${c}`).join("+OR+")})`;
		const apiUrl = `https://export.arxiv.org/api/query?search_query=${catQuery}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResultsPerCategory * cleanCats.length}`;
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

	const items = mergeCollectionItems(groups);
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

/**
 * Deterministic parser for `conf.researchr.org/track/<conf>/<track>` HTML pages.
 * Extracts accepted papers from `#event-overview` and program tables.
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
			const rows = doc.querySelectorAll(
				"#event-overview tr, table.table-condensed tr, table.table tr",
			);
			for (const row of rows) {
				const titleAnchor =
					row.querySelector<HTMLAnchorElement>("a[data-event-modal]") ??
					row.querySelector<HTMLAnchorElement>(
						"td a[href*='/details/'], td strong a",
					);
				if (!titleAnchor) continue;
				const title = cleanWhitespace(titleAnchor.textContent ?? "");
				if (!title || title.length < 6) continue;
				const normTitle = title.toLowerCase();
				if (seenTitles.has(normTitle)) continue;
				seenTitles.add(normTitle);

				const authorEls = row.querySelectorAll(".performers a, .performers");
				const authors: string[] = [];
				if (authorEls.length > 0) {
					for (const el of authorEls) {
						if (el.tagName.toLowerCase() === "a") {
							const name = cleanWhitespace(el.textContent ?? "");
							if (name && !authors.includes(name)) authors.push(name);
						}
					}
					if (authors.length === 0) {
						const rawAuthors = cleanWhitespace(
							row.querySelector(".performers")?.textContent ?? "",
						);
						for (const part of rawAuthors.split(",")) {
							const name = part.trim();
							if (name) authors.push(name);
						}
					}
				}

				const trackText = cleanWhitespace(
					row.querySelector(".prog-track")?.textContent ?? venue.name,
				);
				const href = titleAnchor.getAttribute("href") ?? "";
				const itemUrl =
					href && href !== "#" && !href.startsWith("javascript:")
						? new URL(href, baseUrl).href
						: baseUrl;

				const slug = normTitle
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, "")
					.slice(0, 64);

				results.push({
					id: `venue:${venue.id}:${slug}`,
					title,
					authors,
					abstract: trackText ? `${venue.name} · ${trackText}` : venue.name,
					publishedAt: `${year}-01-01T00:00:00Z`,
					year,
					sourceType: "venue",
					sourceLabel: venue.name,
					categories: [venue.name, ...(trackText ? [trackText] : [])],
					url: itemUrl,
					venueId: venue.id,
				});
			}
		} catch {
			// Fall back to regex parser below.
		}
	}

	if (results.length === 0) {
		const rowRegex =
			/<a[^>]*data-event-modal=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>([\s\S]*?)<\/tr>/gi;
		for (const match of html.matchAll(rowRegex)) {
			const title = decodeHtmlEntities(match[2] ?? "");
			if (!title || title.length < 6) continue;
			const normTitle = title.toLowerCase();
			if (seenTitles.has(normTitle)) continue;
			seenTitles.add(normTitle);

			const tail = match[3] ?? "";
			const authors: string[] = [];
			const performersBlock =
				/<div[^>]*class=["'][^"']*performers[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(
					tail,
				)?.[1] ?? tail;
			for (const aMatch of performersBlock.matchAll(
				/<a[^>]*>([\s\S]*?)<\/a>/gi,
			)) {
				const name = decodeHtmlEntities(aMatch[1] ?? "");
				if (name && !authors.includes(name)) authors.push(name);
			}
			const slug = normTitle
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "")
				.slice(0, 64);

			results.push({
				id: `venue:${venue.id}:${slug}`,
				title,
				authors,
				abstract: `${venue.name} Accepted Paper`,
				publishedAt: `${year}-01-01T00:00:00Z`,
				year,
				sourceType: "venue",
				sourceLabel: venue.name,
				categories: [venue.name],
				url: baseUrl,
				venueId: venue.id,
			});
		}
	}

	return results;
}

/**
 * Known journal ISSN map for SE journals (TOSEM, TSE) so Crossref returns full
 * 2026 abstracts, exact publication dates, and DOIs alongside DBLP.
 */
const JOURNAL_ISSN_MAP: Record<string, string> = {
	tosem: "1049-331X",
	tse: "0098-5589",
};

async function fetchCrossrefJournalForVenue(
	venue: VenueConfig,
	year: number,
): Promise<CollectionPaperItem[]> {
	const lower = `${venue.id} ${venue.name} ${venue.url}`.toLowerCase();
	const issn = lower.includes("tosem")
		? JOURNAL_ISSN_MAP.tosem
		: lower.includes("tse") || lower.includes("/csdl/journal/ts")
			? JOURNAL_ISSN_MAP.tse
			: null;
	if (!issn) return [];

	const url = `https://api.crossref.org/works?filter=issn:${issn},from-pub-date:${year}-01-01&rows=35&sort=published&order=desc`;
	try {
		const data = await plazaFetchJson<{
			message?: {
				items?: Array<{
					DOI?: string;
					title?: string[];
					abstract?: string;
					author?: Array<{ given?: string; family?: string }>;
					published?: { "date-parts"?: number[][] };
					"published-online"?: { "date-parts"?: number[][] };
					"published-print"?: { "date-parts"?: number[][] };
				}>;
			};
		}>(url);

		const items = data.message?.items ?? [];
		const out: CollectionPaperItem[] = [];
		for (const item of items) {
			const doi = (item.DOI ?? "").trim();
			const title = decodeHtmlEntities(item.title?.[0] ?? "");
			if (!doi || !title) continue;
			const parts =
				item["published-online"]?.["date-parts"]?.[0] ??
				item["published-print"]?.["date-parts"]?.[0] ??
				item.published?.["date-parts"]?.[0] ??
				[];
			const y = typeof parts[0] === "number" ? parts[0] : year;
			const m = String(parts[1] ?? 1).padStart(2, "0");
			const d = String(parts[2] ?? 1).padStart(2, "0");
			const authors = (item.author ?? [])
				.map((a) => `${a.given ?? ""} ${a.family ?? ""}`.trim())
				.filter(Boolean);
			const rawAbs = (item.abstract ?? "").replace(/<[^>]+>/g, " ");
			const abstract = decodeHtmlEntities(rawAbs) || venue.name;

			out.push({
				id: `doi:${doi.toLowerCase()}`,
				title,
				authors,
				abstract,
				publishedAt: `${y}-${m}-${d}T00:00:00Z`,
				year: y,
				sourceType: "venue",
				sourceLabel: venue.name,
				categories: [venue.name],
				url: `https://doi.org/${doi}`,
				doi,
				venueId: venue.id,
			});
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Fallback/supplementary DBLP + Crossref fetcher for a configured 2026 Venue
 * (conferences and journals like TOSEM, TSE).
 */
async function fetchDblpForVenue(
	venue: VenueConfig,
): Promise<CollectionPaperItem[]> {
	const shortVenue =
		venue.name.replace(/\b20\d{2}\b/g, "").trim() || venue.name;
	const yearMatch = /\b(20\d{2})\b/.exec(`${venue.name} ${venue.url}`);
	const year = yearMatch ? Number(yearMatch[1]) : TARGET_YEAR;

	const crossrefItems = await fetchCrossrefJournalForVenue(venue, year);

	const q = encodeURIComponent(`${shortVenue} ${year}`);
	const dblpUrl = `https://dblp.org/search/publ/api?q=${q}&format=json&h=40`;

	try {
		const data = await plazaFetchJson<{
			result?: {
				hits?: {
					hit?:
						| Array<{
								info?: {
									title?: string;
									venue?: string;
									year?: string;
									doi?: string;
									ee?: string | string[];
									url?: string;
									authors?: {
										author?:
											| Array<{ text?: string } | string>
											| { text?: string }
											| string;
									};
								};
						  }>
						| {
								info?: {
									title?: string;
									venue?: string;
									year?: string;
									doi?: string;
									ee?: string | string[];
									url?: string;
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
		}>(dblpUrl);

		const rawHits = data.result?.hits?.hit;
		const hits = Array.isArray(rawHits) ? rawHits : rawHits ? [rawHits] : [];

		const out: CollectionPaperItem[] = [];
		for (const hit of hits) {
			const info = hit.info;
			if (!info?.title) continue;
			const itemYear = info.year ? Number(info.year) : year;
			if (itemYear < TARGET_YEAR) continue;
			const title = cleanWhitespace(info.title.replace(/\.$/, ""));
			const rawAuthor = info.authors?.author;
			const authorList = Array.isArray(rawAuthor)
				? rawAuthor
				: rawAuthor
					? [rawAuthor]
					: [];
			const authors = authorList
				.map((a) => (typeof a === "string" ? a : (a.text ?? "")))
				.map((s) => s.trim())
				.filter(Boolean);
			const ee = Array.isArray(info.ee) ? info.ee[0] : info.ee;
			const doi = info.doi?.trim() || undefined;
			const url =
				ee || (doi ? `https://doi.org/${doi}` : info.url || venue.url);
			const slug = title
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.slice(0, 64);

			out.push({
				id: doi ? `doi:${doi.toLowerCase()}` : `venue:${venue.id}:${slug}`,
				title,
				authors,
				abstract: `${venue.name}${info.venue ? ` · ${info.venue}` : ""}`,
				publishedAt: `${itemYear}-01-01T00:00:00Z`,
				year: itemYear,
				sourceType: "venue",
				sourceLabel: venue.name,
				categories: [venue.name],
				url,
				doi,
				venueId: venue.id,
			});
		}
		return mergeCollectionItems([crossrefItems, out]);
	} catch {
		return crossrefItems;
	}
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
		`{"title": "string", "authors": ["string"], "track": "string", "url": "string"}`,
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
			const slug = title
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.slice(0, 64);
			return {
				id: `venue:${venue.id}:${slug}`,
				title,
				authors: Array.isArray(row.authors) ? row.authors : [],
				abstract: row.track ? `${venue.name} · ${row.track}` : venue.name,
				publishedAt: `${year}-01-01T00:00:00Z`,
				year,
				sourceType: "venue" as const,
				sourceLabel: venue.name,
				categories: [venue.name, ...(row.track ? [row.track] : [])],
				url: row.url || venue.url,
				venueId: venue.id,
			};
		});
}

/**
 * Fetch papers for a single VenueConfig (runs deterministic `conf.researchr.org`
 * script first, supplements with DBLP 2026, or invokes Agent when mode === "agent").
 */
export async function fetchSingleVenuePapers(
	venue: VenueConfig,
	forceAgent = false,
): Promise<CollectionPaperItem[]> {
	let html = "";
	try {
		html = await plazaFetchText(venue.url);
	} catch {
		html = "";
	}

	if (forceAgent || venue.mode === "agent") {
		try {
			const agentItems = await extractVenueWithAgent(venue, html || undefined);
			if (agentItems.length > 0) return agentItems;
		} catch (err) {
			if (forceAgent) throw err;
		}
	}

	if (html) {
		const parsed = parseResearchrHtml(html, venue);
		if (parsed.length > 0) {
			return parsed;
		}
	}

	return await fetchDblpForVenue(venue);
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
					map.set(existingKey, {
						...prev,
						abstract:
							prev.abstract.length >= item.abstract.length
								? prev.abstract
								: item.abstract,
						pdfUrl: prev.pdfUrl || item.pdfUrl,
						doi: prev.doi || item.doi,
						arxivId: prev.arxivId || item.arxivId,
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
 * Full refresh of Paper Collection (2026 arXiv categories + configured Venues).
 */
export async function refreshPaperCollection(options?: {
	categories?: string[];
	venues?: VenueConfig[];
}): Promise<CollectionState> {
	const current = loadCollectionState();
	const categories = options?.categories ?? current.categories;
	const venues = options?.venues ?? current.venues;

	const [arxivOutcome, ...venueOutcomes] = await Promise.allSettled([
		fetchArxivCollection(categories, 100),
		...venues.map((v) => fetchSingleVenuePapers(v)),
	]);

	const arxivItems =
		arxivOutcome.status === "fulfilled"
			? arxivOutcome.value.items
			: current.items.filter((i) => i.sourceType === "arxiv");
	const latestArxiv =
		arxivOutcome.status === "fulfilled" && arxivOutcome.value.latest
			? arxivOutcome.value.latest
			: current.latestArxiv;

	const nowIso = new Date().toISOString();
	const updatedVenues: VenueConfig[] = venues.map((venue, idx) => {
		const outcome = venueOutcomes[idx];
		if (outcome?.status === "fulfilled") {
			return {
				...venue,
				lastFetchedAt: nowIso,
				paperCount: outcome.value.length,
			};
		}
		return venue;
	});

	const venueItemGroups = venueOutcomes.map((outcome, idx) => {
		if (outcome.status === "fulfilled") {
			return outcome.value;
		}
		const venueId = venues[idx]?.id;
		return current.items.filter(
			(i) => i.sourceType === "venue" && i.venueId === venueId,
		);
	});

	const merged = mergeCollectionItems([arxivItems, ...venueItemGroups]);
	const nextState: CollectionState = {
		categories,
		venues: updatedVenues,
		items: merged,
		lastRefreshedAt: nowIso,
		latestArxiv,
	};
	saveCollectionState(nextState);
	return nextState;
}
