/**
 * Plaza — Paper Collection venue taxonomy (28 curated 2026 venues),
 * shared types, and stateless abstract / keyword / citation enrichment.
 */

import {
	BackgroundTaskCancelledError,
	isBackgroundTaskCancelledError,
} from "@/lib/core/background-tasks";
import { extractKeywordsWithKeywordLlmBatch } from "@/lib/keyword-llm";
import {
	ensureOpenAlexRuntimeKeyLoaded,
	hasCachedOpenAlexApiKey,
	withOpenAlexApiKey,
} from "@/lib/openalex";
import { canonicalizePaperKeywords } from "@/lib/plaza/keyword-synonyms";

export type CollectionSourceType = "arxiv" | "venue";
export type VenueKind = "conference" | "journal";
export type VenueDomain = "PL/SE" | "CR" | "AI";
export type VenueCcfRank = "CCF-A" | "CCF-B";

export type VenueConfig = {
	id: string;
	/** Short display name, e.g. `ASE 2026`, `ISSTA 2026`, `TOSEM 2026`. */
	name: string;
	/** Official conference or journal homepage URL, e.g. `https://conf.researchr.org/home/ase-2026`. */
	url: string;
	/** Official Main / Research / Technical Track page URLs (empty for journals). */
	tracks?: string[];
	/** Optional prompt hints / instructions passed to the user's Agent when extracting or expanding this venue. */
	notes?: string;
	/** Extraction mode: deterministic structured metadata (`auto`) or Agent-assisted (`agent`). */
	mode: "auto" | "agent";
	kind?: VenueKind;
	domain?: VenueDomain;
	ccfRank?: VenueCcfRank;
	lastFetchedAt?: string | null;
	/** Newest `publishedAt` ISO timestamp observed for incremental diffing. */
	latestPublishedAt?: string | null;
	/** Upstream total paper count observed at last sync for watermark diffing. */
	remoteTotalCount?: number;
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
	/** Primary category (e.g. `cs.SE`) or Venue badge (e.g. `ISSTA 2026`). */
	sourceLabel: string;
	/** All arXiv categories or venue/domain tags. */
	categories: string[];
	url: string;
	pdfUrl?: string;
	arxivId?: string;
	doi?: string;
	venueId?: string;
	venueKind?: VenueKind;
	venueDomain?: VenueDomain;
	ccfRank?: VenueCcfRank;
	venueFull?: string;
	citationCount?: number;
	keywords?: string[];
	volume?: string;
	issue?: string;
	pages?: string;
	bibtex?: string;
	/** Optional `papers.cool` venue catalog id (e.g. `aIH1jyU37z@OpenReview`) for lossless PDF + metadata import. */
	coolPapersId?: string;
	/** ISO timestamp recorded when this paper was surfaced in Paper Recommend. */
	recommendedAt?: string;
};

export type FetchTextFn = (url: string, accept?: string) => Promise<string>;
export type FetchJsonFn = <T = unknown>(url: string) => Promise<T>;

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new BackgroundTaskCancelledError();
	}
}

export async function sleepWithAbort(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new BackgroundTaskCancelledError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function raceWithAbort<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		return Promise.reject(new BackgroundTaskCancelledError());
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new BackgroundTaskCancelledError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(val) => {
				signal.removeEventListener("abort", onAbort);
				resolve(val);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

export function wrapFetchTextWithAbort(
	fetchText: FetchTextFn,
	signal?: AbortSignal,
): FetchTextFn {
	if (!signal) return fetchText;
	return (url, accept) => raceWithAbort(fetchText(url, accept), signal);
}

export function wrapFetchJsonWithAbort(
	fetchJson: FetchJsonFn,
	signal?: AbortSignal,
): FetchJsonFn {
	if (!signal) return fetchJson;
	return <T = unknown>(url: string) => raceWithAbort(fetchJson<T>(url), signal);
}

export type VenueSpec = {
	id: string;
	name: string;
	/** Official conference or journal homepage URL. */
	url: string;
	/** Official Main / Research / Technical Track page URLs (empty for journals). */
	tracks: readonly string[];
	/**
	 * How `tracks` participates in paper resolution:
	 * - `"required"`: combined-volume conference whose publisher proceedings merge non-main tracks;
	 *   `tracks` MUST be fetched and used as the authoritative Research/Technical Track roster.
	 * - `"fallback"`: `tracks` provides official accepted-papers program HTML when publisher DOIs are not yet minted.
	 */
	trackRosterMode?: "required" | "fallback";
	kind: VenueKind;
	domain: VenueDomain;
	ccfRank: VenueCcfRank;
	openAlexSourceIds?: readonly string[];
	pacmIssue?: string;
	issn?: string;
	doiPrefixFilter?: string;
	/** Multiple exact proceedings DOI prefixes queried via `doi_starts_with:p1|p2` in OpenAlex. */
	doiPrefixFilters?: readonly string[];
	/** Companion / workshop / wrong-year DOI prefixes excluded from main conference portals. */
	excludeDoiPrefixes?: readonly string[];
	/** Require any non-arXiv publisher DOI to match `doiPrefixFilters` / `doiPrefixFilter`. */
	requireDoiPrefixMatch?: boolean;
	/** `papers.cool/venue/{slug}` identifier carrying complete abstracts, keywords, and direct PDF links. */
	coolPapersVenueSlug?: string;
	/** Whitelist of `papers.cool` `?group=...` main-track subject groups (e.g. `["Long Papers", "Short Papers"]`). */
	coolPapersAllowedGroups?: readonly string[];
	/** Blacklist regex for `papers.cool` `?group=...` non-main-track groups (e.g. AAAI Student Abstract / IAAI / EAAI). */
	coolPapersExcludedGroupPattern?: RegExp;
	/** Exclude `Position: ...` Position Paper Track entries on AI conferences (`ICML`, `NeurIPS`). */
	excludePositionPapers?: boolean;
	/** Semantic Scholar `/paper/search/bulk?venue=...` canonical venue name(s). */
	s2VenueNames?: readonly string[];
	/** Exact accepted-venue aliases matched in `<arxiv:comment>` / `<arxiv:journal_ref>`. */
	arxivVenueAliases?: readonly string[];
	/** Optional Crossref `container-title` substring guard when querying Crossref. */
	crossrefContainerMatch?: string;
	/** Optional Crossref `query.container-title` proceedings title for offset fallback when OpenAlex is rate-limited. */
	crossrefProceedingsQuery?: string;
	/** Optional Crossref proceedings ISBNs (e.g. Springer LNCS `SAS 2026`). */
	crossrefIsbns?: readonly string[];
	/** IEEE Computer Society Digital Library (`computer.org/csdl/api/v1/graphql`) `idPrefix` for full official abstracts. */
	csdlIdPrefix?: string;
};

/**
 * Complete 2026 Venue catalog (28 CCF-A / CCF-B venues across PL/SE, CR, and AI):
 * 1. PL/SE Conferences (CCF-A & CCF-B) + Journals (CCF-A & CCF-B)
 * 2. CR Conferences (CCF-A)
 * 3. AI Conferences (CCF-A)
 */
export const VENUE_SPECS: readonly VenueSpec[] = [
	// 1a. PL/SE Conferences — CCF-A
	{
		id: "ase-2026",
		name: "ASE 2026",
		url: "https://conf.researchr.org/home/ase-2026",
		tracks: [
			"https://conf.researchr.org/track/ase-2026/ase-2026-research-track",
		],
		trackRosterMode: "required",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4363608212"],
		doiPrefixFilters: ["10.1145/3832783"],
		crossrefProceedingsQuery:
			"41st IEEE/ACM International Conference on Automated Software Engineering",
		s2VenueNames: ["ASE"],
		arxivVenueAliases: ["ASE 2026"],
	},
	{
		id: "icse-2026",
		name: "ICSE 2026",
		url: "https://conf.researchr.org/home/icse-2026",
		tracks: [
			"https://conf.researchr.org/track/icse-2026/icse-2026-research-track",
		],
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4210203175"],
		doiPrefixFilters: ["10.1145/3744916"],
		requireDoiPrefixMatch: true,
		excludeDoiPrefixes: [
			"10.1145/3774748",
			"10.1145/3786583",
			"10.1145/3786582",
			"10.1145/3786581",
			"10.1145/3786580",
		],
		crossrefProceedingsQuery:
			"48th International Conference on Software Engineering",
		s2VenueNames: ["ICSE"],
		arxivVenueAliases: ["ICSE 2026"],
	},
	{
		id: "issta-2026",
		name: "ISSTA 2026",
		url: "https://conf.researchr.org/home/issta-2026",
		tracks: ["https://conf.researchr.org/track/issta-2026/issta-2026-papers"],
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4404663975"],
		pacmIssue: "ISSTA",
		issn: "2994-970X",
		s2VenueNames: ["ISSTA"],
		arxivVenueAliases: ["ISSTA 2026"],
	},
	{
		id: "fse-2026",
		name: "FSE 2026",
		url: "https://conf.researchr.org/home/fse-2026",
		tracks: [
			"https://conf.researchr.org/track/fse-2026/fse-2026-research-papers",
		],
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4404663975"],
		pacmIssue: "FSE",
		issn: "2994-970X",
		s2VenueNames: ["FSE"],
		arxivVenueAliases: ["FSE 2026", "ESEC/FSE 2026"],
	},
	{
		id: "pldi-2026",
		name: "PLDI 2026",
		url: "https://pldi26.sigplan.org",
		tracks: ["https://pldi26.sigplan.org/track/pldi-2026-papers"],
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4210216081"],
		pacmIssue: "PLDI",
		issn: "2475-1421",
		s2VenueNames: ["PLDI"],
		arxivVenueAliases: ["PLDI 2026"],
	},
	{
		id: "popl-2026",
		name: "POPL 2026",
		url: "https://popl26.sigplan.org",
		tracks: ["https://popl26.sigplan.org/track/POPL-2026-popl-research-papers"],
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4210216081"],
		pacmIssue: "POPL",
		issn: "2475-1421",
		s2VenueNames: ["POPL"],
		arxivVenueAliases: ["POPL 2026"],
	},
	{
		id: "oopsla-2026",
		name: "OOPSLA 2026",
		url: "https://2026.splashcon.org",
		tracks: ["https://2026.splashcon.org/track/oopsla-2026"],
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4210216081"],
		pacmIssue: "OOPSLA",
		issn: "2475-1421",
		s2VenueNames: ["OOPSLA"],
		arxivVenueAliases: ["OOPSLA 2026"],
	},

	// 1a. PL/SE Conferences — CCF-B
	{
		id: "ecoop-2026",
		name: "ECOOP 2026",
		url: "https://2026.ecoop.org",
		tracks: ["https://2026.ecoop.org/track/ecoop-2026-papers"],
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		doiPrefixFilter: "10.4230/lipics.ecoop.2026",
		requireDoiPrefixMatch: true,
		crossrefProceedingsQuery:
			"European Conference on Object-Oriented Programming",
		s2VenueNames: ["ECOOP"],
		arxivVenueAliases: ["ECOOP 2026"],
	},
	{
		id: "icpc-2026",
		name: "ICPC 2026",
		url: "https://conf.researchr.org/home/icpc-2026",
		tracks: ["https://conf.researchr.org/track/icpc-2026/icpc-2026-research"],
		trackRosterMode: "required",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		openAlexSourceIds: ["S7407088527", "S4306419777"],
		doiPrefixFilters: ["10.1145/3794763"],
		crossrefProceedingsQuery:
			"34th IEEE/ACM International Conference on Program Comprehension",
		s2VenueNames: ["ICPC"],
		arxivVenueAliases: ["ICPC 2026"],
	},
	{
		id: "re-2026",
		name: "RE 2026",
		url: "https://conf.researchr.org/home/RE-2026",
		tracks: [
			"https://conf.researchr.org/track/RE-2026/RE-2026-Research-Papers",
		],
		trackRosterMode: "required",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		openAlexSourceIds: ["S7407086818"],
		doiPrefixFilters: ["10.1109/re68928.2026"],
		excludeDoiPrefixes: ["10.1109/rew"],
		csdlIdPrefix: "re",
		arxivVenueAliases: ["RE 2026"],
	},
	{
		id: "saner-2026",
		name: "SANER 2026",
		url: "https://conf.researchr.org/home/saner-2026",
		tracks: ["https://conf.researchr.org/track/saner-2026/saner-2026-papers"],
		trackRosterMode: "required",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		openAlexSourceIds: ["S4363608226"],
		doiPrefixFilters: ["10.1109/saner67736.2026"],
		excludeDoiPrefixes: ["10.1109/saner-c"],
		csdlIdPrefix: "saner",
		s2VenueNames: ["SANER"],
		arxivVenueAliases: ["SANER 2026"],
	},
	{
		id: "icsme-2026",
		name: "ICSME 2026",
		url: "https://conf.researchr.org/home/icsme-2026",
		tracks: ["https://conf.researchr.org/track/icsme-2026/icsme-2026-papers"],
		trackRosterMode: "required",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		openAlexSourceIds: ["S4210174939"],
		doiPrefixFilters: ["10.1109/icsme67971.2026"],
		csdlIdPrefix: "icsme",
		s2VenueNames: ["ICSME"],
		arxivVenueAliases: ["ICSME 2026"],
	},
	{
		id: "sas-2026",
		name: "SAS 2026",
		url: "https://2026.splashcon.org/home/sas-2026",
		tracks: ["https://2026.splashcon.org/track/sas-2026-papers"],
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		openAlexSourceIds: ["S4306420942"],
		doiPrefixFilters: ["10.1007/978-3-032-40374-2"],
		requireDoiPrefixMatch: true,
		excludeDoiPrefixes: ["10.1007/978-3-032-07106-4"],
		crossrefIsbns: ["9783032403735", "9783032403742"],
		arxivVenueAliases: ["Static Analysis Symposium 2026"],
	},
	{
		id: "esem-2026",
		name: "ESEM 2026",
		url: "https://conf.researchr.org/home/eseiw-2026",
		tracks: [
			"https://conf.researchr.org/track/eseiw-2026/eseiw-2026-esem---technical-track",
		],
		trackRosterMode: "required",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		openAlexSourceIds: ["S4210197744"],
		doiPrefixFilter: "10.4230/lipics.esem.2026",
		issn: "1949-3770",
		s2VenueNames: ["ESEM"],
		arxivVenueAliases: ["ESEM 2026"],
	},
	{
		id: "issre-2026",
		name: "ISSRE 2026",
		url: "https://cyprusconferences.org/issre2026/",
		tracks: ["https://cyprusconferences.org/issre2026/accepted-papers/"],
		trackRosterMode: "fallback",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		openAlexSourceIds: ["S4210220341"],
		s2VenueNames: ["ISSRE"],
		arxivVenueAliases: ["ISSRE 2026"],
	},

	// 1b. PL/SE Journals — CCF-A & CCF-B
	{
		id: "tse-2026",
		name: "TSE 2026",
		url: "https://www.computer.org/csdl/journal/ts",
		tracks: [],
		kind: "journal",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S8351582"],
		issn: "0098-5589",
		csdlIdPrefix: "ts",
		arxivVenueAliases: ["IEEE TSE 2026"],
	},
	{
		id: "tosem-2026",
		name: "TOSEM 2026",
		url: "https://dl.acm.org/journal/tosem",
		tracks: [],
		kind: "journal",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S142627899"],
		issn: "1049-331X",
		arxivVenueAliases: ["TOSEM 2026", "ACM TOSEM 2026"],
	},
	{
		id: "ase-journal-2026",
		name: "ASE (J) 2026",
		url: "https://link.springer.com/journal/10515",
		tracks: [],
		kind: "journal",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		openAlexSourceIds: ["S4210177399"],
		issn: "1573-7535",
	},
	{
		id: "ese-2026",
		name: "ESE 2026",
		url: "https://link.springer.com/journal/10664",
		tracks: [],
		kind: "journal",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		openAlexSourceIds: ["S109852484"],
		issn: "1382-3256",
		arxivVenueAliases: ["EMSE 2026"],
	},

	// 2. CR Conferences — CCF-A
	{
		id: "ccs-2026",
		name: "CCS 2026",
		url: "https://www.sigsac.org/ccs/CCS2026/",
		tracks: ["https://www.sigsac.org/ccs/CCS2026/program/schedule.html"],
		trackRosterMode: "fallback",
		kind: "conference",
		domain: "CR",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4393917527"],
		s2VenueNames: ["CCS"],
		arxivVenueAliases: ["CCS 2026", "ACM CCS 2026"],
	},
	{
		id: "sp-2026",
		name: "S&P 2026",
		url: "https://sp2026.ieee-security.org/",
		tracks: ["https://sp2026.ieee-security.org/program-papers.html"],
		kind: "conference",
		domain: "CR",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4210233669"],
		doiPrefixFilters: ["10.1109/sp63933.2026"],
		requireDoiPrefixMatch: true,
		excludeDoiPrefixes: ["10.1109/spw"],
		csdlIdPrefix: "sp",
		arxivVenueAliases: ["IEEE S&P 2026", "Oakland 2026"],
	},
	{
		id: "usenix-sec-2026",
		name: "USENIX Security 2026",
		url: "https://www.usenix.org/conference/usenixsecurity26",
		tracks: [
			"https://www.usenix.org/conference/usenixsecurity26/technical-sessions",
		],
		kind: "conference",
		domain: "CR",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4306421123"],
		coolPapersVenueSlug: "USENIX-Sec.2026",
		coolPapersExcludedGroupPattern:
			/\b(workshops?|posters?|demos?|demonstrations?|tutorials?|doctoral)\b/i,
		s2VenueNames: ["USENIX Security Symposium", "USENIX Security"],
		arxivVenueAliases: ["USENIX Security 2026"],
	},
	{
		id: "ndss-2026",
		name: "NDSS 2026",
		url: "https://www.ndss-symposium.org/ndss2026/",
		tracks: ["https://www.ndss-symposium.org/ndss2026/accepted-papers/"],
		kind: "conference",
		domain: "CR",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4306420590"],
		coolPapersVenueSlug: "NDSS.2026",
		coolPapersExcludedGroupPattern:
			/\b(workshops?|posters?|demos?|demonstrations?|tutorials?|doctoral)\b/i,
		s2VenueNames: ["NDSS"],
		arxivVenueAliases: ["NDSS 2026"],
	},

	// 3. AI Conferences — CCF-A
	{
		id: "aaai-2026",
		name: "AAAI 2026",
		url: "https://aaai.org/conference/aaai/aaai-26/",
		tracks: ["https://ojs.aaai.org/index.php/AAAI/issue/archive"],
		kind: "conference",
		domain: "AI",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4210191458"],
		coolPapersVenueSlug: "AAAI.2026",
		coolPapersExcludedGroupPattern:
			/\b(special\s+track|senior\s+member|new\s+faculty|journal\s+track|emerging\s+trends|doctoral\s+consortium|student\s+abstract|undergraduate\s+consortium|demonstration|demos?\b|iaai|eaai|workshops?|bridges?|tutorials?)\b/i,
		issn: "2374-3468",
		s2VenueNames: ["AAAI"],
		arxivVenueAliases: ["AAAI 2026"],
	},
	{
		id: "neurips-2026",
		name: "NeurIPS 2026",
		url: "https://neurips.cc/Conferences/2026",
		tracks: ["https://openreview.net/group?id=NeurIPS.cc/2026/Conference"],
		kind: "conference",
		domain: "AI",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4363606243"],
		excludeDoiPrefixes: ["10.52202/079017", "10.52202/085713"],
		coolPapersVenueSlug: "NeurIPS.2026",
		coolPapersAllowedGroups: ["Oral", "Spotlight", "Poster"],
		excludePositionPapers: true,
		s2VenueNames: ["NeurIPS", "Neural Information Processing Systems"],
		arxivVenueAliases: ["NeurIPS 2026"],
	},
	{
		id: "acl-2026",
		name: "ACL 2026",
		url: "https://2026.aclweb.org/",
		tracks: [
			"https://aclanthology.org/volumes/2026.acl-long/",
			"https://aclanthology.org/volumes/2026.acl-short/",
		],
		kind: "conference",
		domain: "AI",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4393915740"],
		excludeDoiPrefixes: [
			"10.18653/v1/2026.findings-",
			"10.18653/v1/2026.acl-industry",
			"10.18653/v1/2026.acl-srw",
			"10.18653/v1/2026.acl-demo",
			"10.18653/v1/2026.acl-tutorials",
		],
		coolPapersVenueSlug: "ACL.2026",
		coolPapersAllowedGroups: ["Long Papers", "Short Papers"],
		crossrefContainerMatch: "Association for Computational Linguistics",
		s2VenueNames: ["ACL"],
		arxivVenueAliases: ["ACL 2026"],
	},
	{
		id: "iclr-2026",
		name: "ICLR 2026",
		url: "https://iclr.cc/Conferences/2026",
		tracks: ["https://openreview.net/group?id=ICLR.cc/2026/Conference"],
		kind: "conference",
		domain: "AI",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4306419637"],
		coolPapersVenueSlug: "ICLR.2026",
		coolPapersAllowedGroups: ["Oral", "Spotlight", "Poster"],
		s2VenueNames: [
			"ICLR",
			"International Conference on Learning Representations",
		],
		arxivVenueAliases: ["ICLR 2026"],
	},
	{
		id: "icml-2026",
		name: "ICML 2026",
		url: "https://icml.cc/Conferences/2026",
		tracks: ["https://openreview.net/group?id=ICML.cc/2026/Conference"],
		kind: "conference",
		domain: "AI",
		ccfRank: "CCF-A",
		openAlexSourceIds: ["S4306419644"],
		coolPapersVenueSlug: "ICML.2026",
		coolPapersAllowedGroups: ["Oral", "Spotlight", "Poster"],
		excludePositionPapers: true,
		s2VenueNames: ["ICML", "International Conference on Machine Learning"],
		arxivVenueAliases: ["ICML 2026"],
	},
];

export const VENUE_SPEC_BY_ID = new Map<string, VenueSpec>(
	VENUE_SPECS.map((s) => [s.id, s]),
);

export const ARXIV_CATEGORY_SUBTITLES: Record<string, string> = {
	"cs.SE": "Software Engineering",
	"cs.CR": "Cryptography & Security",
	"cs.PL": "Programming Languages",
	"cs.AI": "Artificial Intelligence",
	"cs.LG": "Machine Learning",
	"cs.CL": "Computation & Language",
	"cs.CV": "Computer Vision",
	"cs.DC": "Distributed Computing",
	"cs.DB": "Databases",
	"cs.OS": "Operating Systems",
	"cs.NI": "Networking",
	"cs.LO": "Logic in CS",
};

/** Reconstruct complete abstract text from OpenAlex `abstract_inverted_index`. */
export function reconstructOpenAlexAbstract(
	inverted: Record<string, number[]> | null | undefined,
): string {
	if (!inverted) return "";
	let maxPos = -1;
	for (const positions of Object.values(inverted)) {
		if (!Array.isArray(positions)) continue;
		for (const pos of positions) {
			if (typeof pos === "number" && pos > maxPos) maxPos = pos;
		}
	}
	if (maxPos < 0 || maxPos > 25_000) return "";
	const words = new Array<string>(maxPos + 1).fill("");
	for (const [word, positions] of Object.entries(inverted)) {
		if (!Array.isArray(positions)) continue;
		for (const pos of positions) {
			if (typeof pos === "number" && pos >= 0 && pos <= maxPos) {
				words[pos] = word;
			}
		}
	}
	return words
		.filter(Boolean)
		.join(" ")
		.replace(/^abstract[:.\s-]*/i, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Reject non-abstract placeholder strings (such as `"ICSE 2026 · ICSE"`). */
export function isPlaceholderAbstract(
	abstract: string | undefined | null,
	venueLabel?: string,
): boolean {
	if (!abstract) return true;
	const trimmed = abstract.trim();
	if (trimmed.length < 36) return true;
	if (/accepted paper$/i.test(trimmed)) return true;
	if (venueLabel && trimmed.toLowerCase() === venueLabel.trim().toLowerCase()) {
		return true;
	}
	if (
		/^[A-Za-z0-9&()/.\s-]{2,32}\s·\s[A-Za-z0-9&()/.\s-]{2,48}$/.test(trimmed)
	) {
		return true;
	}
	return false;
}

export function isFrontmatterTitle(title: string): boolean {
	const t = title.trim();
	if (t.length < 8) return true;
	if (
		/^(front\s*matter|back\s*matter|title page|copyright(?:\s+page)?|table of contents|contents\b|message from|welcome (?:from|message|to\b)|foreword|preface|proceedings of\b|companion proceedings\b|adjunct proceedings\b|extended abstracts of\b|conference organization|program committee|organizing committee|artifact evaluation committee|steering committee|external reviewers|additional reviewers|list of reviewers|reviewers?\b|author index|subject index|index of authors|sponsors?\b|corporate sponsors?\b|session details\s*:|keynote\b|panel:|tutorial:|editorial\b|guest\s+editorial\b|introduction\s+to\s+the\s+special\s+(?:issue|section)\b|corrigendum\b|erratum\b|errata\b|corrections?\s+to\b|retraction\b|in\s+memoriam\b)/i.test(
			t,
		)
	) {
		return true;
	}
	return /[[(](?:keynote(?:\s+talk|\s+address)?|invited\s+(?:talk|paper|keynote)|tutorial|panel|extended\s+abstract|student\s+abstract|tool\s+demonstration|demo(?:\s+paper)?|poster(?:\s+abstract)?)[\])]\s*$/i.test(
		t,
	);
}

/** Reject non-research items in journals (Guest Editorials, TOSEM RCR Reports, short <=4p commentaries). */
export function isNonResearchJournalItem(
	title: string,
	pages?: string | null,
): boolean {
	const t = title.trim();
	if (isFrontmatterTitle(t)) return true;
	if (
		/^rcr\s+report\b/i.test(t) ||
		/(?:—|--|–|-|:)\s*rcr\s+report\s*$/i.test(t) ||
		/\breplicated\s+computational\s+results\s+report\b/i.test(t) ||
		/^(?:letter\s+to\s+the\s+editor|book\s+review|issue\s+information|reviewer\s+acknowledg)/i.test(
			t,
		)
	) {
		return true;
	}
	const p = (pages ?? "").trim();
	const rangeMatch = /^(\d+)\s*[-–]\s*(\d+)$/.exec(p);
	if (rangeMatch?.[1] && rangeMatch[2]) {
		const start = Number.parseInt(rangeMatch[1], 10);
		const end = Number.parseInt(rangeMatch[2], 10);
		if (
			Number.isFinite(start) &&
			Number.isFinite(end) &&
			end >= start &&
			end - start + 1 <= 4
		) {
			return true;
		}
	}
	return false;
}

/** Detect AI conference Position Paper Track titles (`Position: ...` / `Position Paper: ...`). */
export function isPositionPaperTitle(title: string): boolean {
	return /^position(?:\s+paper)?\s*:/i.test(title.trim());
}

/** Detect generic preprint/archive repositories that should never overwrite `venueFull`. */
export function isGenericRepositoryVenueName(name: string): boolean {
	const s = name.trim();
	if (!s) return false;
	return /^(?:arxiv(?:\s*\(.*\))?|zenodo|figshare|ssrn|hal|osf\s*preprints?|techrxiv|research\s*square|rare\s*&\s*special\s*e-zone)$/i.test(
		s,
	);
}

/** Reject prior-year conference proceedings spillover (e.g. NeurIPS 2024/2025 indexed with online date 2026). */
export function hasPriorConferenceYearSpillover(
	targetYear: number,
	...fields: Array<string | undefined | null>
): boolean {
	for (const raw of fields) {
		if (!raw) continue;
		const s = raw.trim();
		if (!s) continue;
		for (const m of s.matchAll(
			/(?:\/paper_files\/paper\/|\/volumes\/|\/)(20\d{2})(?:\/|\.[a-z])/gi,
		)) {
			const y = Number.parseInt(m[1] ?? "", 10);
			if (y >= 2018 && y < targetYear) return true;
		}
		for (const m of s.matchAll(/\b(20\d{2})\b/g)) {
			const y = Number.parseInt(m[1] ?? "", 10);
			if (y >= 2018 && y < targetYear && !s.startsWith("10.")) {
				return true;
			}
		}
	}
	return false;
}

/** Reject co-located workshop, companion, or non-main-track sub-venues on main conference portals. */
export function isWorkshopOrCompanionVenue(venueLabel: string): boolean {
	const s = venueLabel.trim();
	if (!s) return false;
	if (s.includes("@")) return true;
	if (
		/^(?:REW|SPW|ASEW|ICSEW|ICSMEW|ISSREW|SANER-C|WOOT|SOUPS|EuroS&P|EuroSP)$/i.test(
			s,
		)
	) {
		return true;
	}
	return /\b(workshops?|companion|adjunct|doctoral\s+(?:symposium|consortium)|student\s+(?:research\s+competition|abstract)|posters?\s+and\s+(?:tool\s+)?demos?|fast\s+abstracts?|seip|seet|seis|nier|findings\s+of|datasets?\s+(?:and|&)\s+benchmarks?|position\s+paper\s+track|demonstrations?\s+track|industry\s+(?:track|showcase)|industrial\s+innovation|replications?\s+(?:and|&)\s+negative)\b/i.test(
		s,
	);
}

export function isExcludedByDoiPrefix(
	doi: string | undefined,
	excludePrefixes: readonly string[] | undefined,
): boolean {
	if (!doi || !excludePrefixes || excludePrefixes.length === 0) return false;
	const lower = doi.toLowerCase();
	return excludePrefixes.some((p) => lower.startsWith(p.toLowerCase()));
}

export function matchesConfiguredDoiPrefix(
	doi: string | undefined,
	spec: VenueSpec | undefined,
): boolean {
	if (!spec) return true;
	const prefixes = [
		...(spec.doiPrefixFilters ?? []),
		...(spec.doiPrefixFilter ? [spec.doiPrefixFilter] : []),
	];
	if (prefixes.length === 0) return true;
	if (!doi) return false;
	const lower = doi.toLowerCase();
	return prefixes.some((p) => lower.startsWith(p.toLowerCase()));
}

/**
 * Normalize paper-level keywords (`Publisher/OpenAlex + OpenRouter LLM fallback + Synonym Canonicalization`),
 * stripping broad discipline buckets, venue badges, and arXiv category codes, then
 * collapsing synonyms case-insensitively into canonical singular Title Case terms.
 */
export function normalizePaperKeywords(
	upstreamKeywords?: readonly string[] | null,
	maxCount = 8,
): string[] {
	return canonicalizePaperKeywords(upstreamKeywords, maxCount);
}

/**
 * Normalize paper keywords (`Publisher/OpenAlex + OpenRouter LLM fallback + Synonym Canonicalization`).
 */
export function derivePaperKeywords(
	_title: string,
	_abstract: string,
	_categories: readonly string[],
	upstreamKeywords?: readonly string[] | null,
): string[] {
	return normalizePaperKeywords(upstreamKeywords);
}

/**
 * True when a paper has both a genuine non-placeholder abstract and at least one
 * normalized paper-level keyword.
 */
export function isPaperMetadataComplete(
	paper: Pick<CollectionPaperItem, "abstract" | "keywords" | "sourceLabel">,
	venueLabel?: string,
): boolean {
	return (
		!isPlaceholderAbstract(paper.abstract, venueLabel ?? paper.sourceLabel) &&
		normalizePaperKeywords(paper.keywords).length > 0
	);
}

/** Academic reference string for citation display & one-click copy. */
export function formatPaperCitationText(paper: CollectionPaperItem): string {
	const authorText =
		paper.authors.length > 0 ? paper.authors.join(", ") : "Unknown Authors";
	const year = paper.year || 2026;
	const title = paper.title.replace(/\.$/, "");
	const venueName = paper.venueFull || paper.sourceLabel;
	const volIssue = [
		paper.volume ? `Vol. ${paper.volume}` : "",
		paper.issue ? `No. ${paper.issue}` : "",
		paper.pages ? `pp. ${paper.pages}` : "",
	]
		.filter(Boolean)
		.join(", ");

	if (paper.sourceType === "arxiv" && paper.arxivId) {
		const doiSuffix = paper.doi ? ` https://doi.org/${paper.doi}` : "";
		return `${authorText}. (${year}). ${title}. arXiv preprint arXiv:${paper.arxivId}.${doiSuffix || ` ${paper.url}`}`;
	}

	const venuePart = volIssue ? `${venueName} (${volIssue})` : venueName;
	const linkPart = paper.doi ? `https://doi.org/${paper.doi}` : paper.url || "";
	return `${authorText}. (${year}). ${title}. In ${venuePart}.${linkPart ? ` ${linkPart}` : ""}`;
}

/** Deterministic BibTeX record for any CollectionPaperItem. */
export function formatPaperBibtex(paper: CollectionPaperItem): string {
	if (paper.bibtex?.trim()) return paper.bibtex.trim();
	const firstAuthorLast =
		(paper.authors[0] ?? "paper")
			.trim()
			.split(/\s+/)
			.pop()
			?.replace(/[^A-Za-z0-9]/g, "")
			.toLowerCase() || "paper";
	const firstTitleWord =
		paper.title
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.trim()
			.split(/\s+/)
			.find((w) => w.length >= 4) ?? "work";
	const citeKey = `${firstAuthorLast}${paper.year || 2026}${firstTitleWord}`;
	const authorBib =
		paper.authors.length > 0 ? paper.authors.join(" and ") : "Unknown";

	if (paper.sourceType === "arxiv" && paper.arxivId) {
		return [
			`@misc{${citeKey},`,
			`  title = {${paper.title}},`,
			`  author = {${authorBib}},`,
			`  year = {${paper.year || 2026}},`,
			`  eprint = {${paper.arxivId}},`,
			`  archivePrefix = {arXiv},`,
			`  primaryClass = {${paper.sourceLabel}},`,
			paper.doi ? `  doi = {${paper.doi}},` : null,
			`  url = {${paper.url}}`,
			`}`,
		]
			.filter(Boolean)
			.join("\n");
	}

	const isJournal = paper.venueKind === "journal";
	const entryType = isJournal ? "article" : "inproceedings";
	const venueField = isJournal ? "journal" : "booktitle";
	return [
		`@${entryType}{${citeKey},`,
		`  title = {${paper.title}},`,
		`  author = {${authorBib}},`,
		`  ${venueField} = {${paper.venueFull || paper.sourceLabel}},`,
		`  year = {${paper.year || 2026}},`,
		paper.volume ? `  volume = {${paper.volume}},` : null,
		paper.issue ? `  number = {${paper.issue}},` : null,
		paper.pages ? `  pages = {${paper.pages}},` : null,
		paper.doi ? `  doi = {${paper.doi}},` : null,
		`  url = {${paper.url}}`,
		`}`,
	]
		.filter(Boolean)
		.join("\n");
}

/** Infer Conference vs Journal for any VenueConfig. */
export function inferVenueKind(
	venue: Pick<VenueConfig, "id" | "name" | "url" | "kind">,
): VenueKind {
	if (venue.kind === "conference" || venue.kind === "journal") {
		return venue.kind;
	}
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	if (spec) return spec.kind;
	const lower = `${venue.id} ${venue.name} ${venue.url}`.toLowerCase();
	if (
		lower.includes("/journal/") ||
		/\b(tosem|tse|ese|journal|transactions)\b/.test(lower)
	) {
		return "journal";
	}
	return "conference";
}

// ─── OpenAlex / Crossref / Semantic Scholar Enrichment & Venue Loading ───

export type OpenAlexWork = {
	id?: string;
	type?: string | null;
	title?: string | null;
	display_name?: string | null;
	publication_year?: number | null;
	publication_date?: string | null;
	doi?: string | null;
	ids?: { arxiv?: string | null; doi?: string | null } | null;
	cited_by_count?: number | null;
	abstract_inverted_index?: Record<string, number[]> | null;
	keywords?: Array<{
		display_name?: string | null;
		score?: number | null;
	}> | null;
	biblio?: {
		volume?: string | null;
		issue?: string | null;
		first_page?: string | null;
		last_page?: string | null;
	} | null;
	primary_location?: {
		landing_page_url?: string | null;
		pdf_url?: string | null;
		source?: { id?: string | null; display_name?: string | null } | null;
	} | null;
	locations?: Array<{
		landing_page_url?: string | null;
		pdf_url?: string | null;
		source?: { id?: string | null; display_name?: string | null } | null;
	}> | null;
	open_access?: {
		is_oa?: boolean | null;
		oa_url?: string | null;
	} | null;
	authorships?: Array<{
		author?: { display_name?: string | null } | null;
	}> | null;
};

export const OPENALEX_SELECT =
	"id,type,title,publication_year,publication_date,doi,ids,cited_by_count,abstract_inverted_index,keywords,biblio,primary_location,locations,open_access,authorships";
const OPENALEX_ARXIV_SELECT =
	"doi,ids,title,cited_by_count,abstract_inverted_index,keywords,locations";
export const MAILTO = "agentero@users.noreply.github.com";

export function cleanDoi(raw: string | null | undefined): string | undefined {
	if (!raw) return undefined;
	const stripped = raw
		.trim()
		.replace(/^doi:\s*/i, "")
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.replace(/[.,;>)"']+$/, "")
		.trim();
	if (/^10\.\d{4,9}\/\S+/i.test(stripped)) {
		return stripped;
	}
	const embedded = /\b(10\.\d{4,9}\/[^\s?#<>"']+)/i.exec(stripped)?.[1];
	if (embedded) {
		return embedded.replace(/[.,;>)"']+$/, "") || undefined;
	}
	return undefined;
}

export function buildVenuePaperId(
	venueId: string,
	doi: string | undefined,
	arxivId: string | undefined,
	title: string,
): string {
	if (doi) return `venue:${venueId}:doi:${doi.toLowerCase()}`;
	if (arxivId) return `venue:${venueId}:arxiv:${arxivId.toLowerCase()}`;
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "")
		.slice(0, 140);
	return `venue:${venueId}:${slug || "paper"}`;
}

const ARXIV_ID_EXTRACT_RE =
	/(?:arxiv\.org\/(?:abs|pdf|html)\/|10\.48550\/arxiv\.)(\d{4}\.\d{4,5})/i;

function stripArxivVersion(raw: string | null | undefined): string {
	return (raw ?? "").trim().replace(/v\d+$/i, "");
}

function extractAllArxivIdsFromOpenAlex(row: OpenAlexWork): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const pushFrom = (raw: string | null | undefined) => {
		if (!raw) return;
		const m = ARXIV_ID_EXTRACT_RE.exec(raw);
		if (!m?.[1]) return;
		const id = m[1].toLowerCase();
		if (!seen.has(id)) {
			seen.add(id);
			found.push(id);
		}
	};

	pushFrom(row.ids?.arxiv);
	pushFrom(row.doi);
	pushFrom(row.primary_location?.landing_page_url);
	pushFrom(row.primary_location?.pdf_url);
	for (const loc of row.locations ?? []) {
		pushFrom(loc?.landing_page_url);
		pushFrom(loc?.pdf_url);
	}
	return found;
}

function extractArxivIdFromOpenAlex(row: OpenAlexWork): string | undefined {
	return extractAllArxivIdsFromOpenAlex(row)[0];
}

function stripCombiningDiacritics(raw: string): string {
	return raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normTitleKey(title: string): string {
	return stripCombiningDiacritics(title)
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function normalizeSpellingToken(token: string): string {
	return token
		.replace(/modelling/g, "modeling")
		.replace(/behaviour/g, "behavior")
		.replace(/colour/g, "color")
		.replace(/favour/g, "favor")
		.replace(/honour/g, "honor")
		.replace(/optimis/g, "optimiz")
		.replace(/visualis/g, "visualiz")
		.replace(/categoris/g, "categoriz")
		.replace(/customis/g, "customiz")
		.replace(/generalis/g, "generaliz")
		.replace(/localis/g, "localiz")
		.replace(/prioritis/g, "prioritiz")
		.replace(/standardis/g, "standardiz")
		.replace(/summarised/g, "summarized")
		.replace(/organisation/g, "organization")
		.replace(/programme/g, "program")
		.replace(/catalogue/g, "catalog")
		.replace(/dialogue/g, "dialog")
		.replace(/grey/g, "gray")
		.replace(/judgement/g, "judgment")
		.replace(/acknowledgement/g, "acknowledgment")
		.replace(/defence/g, "defense")
		.replace(/offence/g, "defense")
		.replace(/centre/g, "center")
		.replace(/metre/g, "meter")
		.replace(/litre/g, "liter")
		.replace(/practise/g, "practice")
		.replace(/licence/g, "license")
		.replace(/isation$/, "ization")
		.replace(/ising$/, "izing")
		.replace(/ised$/, "ized")
		.replace(/yse$/, "yze")
		.replace(/ysing$/, "yzing")
		.replace(/ysed$/, "yzed");
}

export function tokenizeTitleForFuzzyMatch(title: string): Set<string> {
	const tokens = new Set<string>();
	for (const raw of stripCombiningDiacritics(title)
		.toLowerCase()
		.split(/[^a-z0-9]+/)) {
		if (raw.length < 3) continue;
		tokens.add(normalizeSpellingToken(raw));
	}
	return tokens;
}

export function extractAuthorSurnames(authors: readonly string[]): Set<string> {
	const out = new Set<string>();
	const suffixes = new Set(["jr", "sr", "ii", "iii", "iv"]);
	for (const a of authors) {
		const normalized = stripCombiningDiacritics(a).toLowerCase();
		const surnameSegment = normalized.includes(",")
			? (normalized.split(",")[0] ?? normalized)
			: normalized;
		const parts = surnameSegment
			.replace(/[^a-z\s]+/g, " ")
			.trim()
			.split(/\s+/)
			.filter((t) => t.length >= 2 && !suffixes.has(t));
		const last = parts[parts.length - 1];
		if (last) out.add(last);
	}
	return out;
}

export function computeSetJaccard(
	a: ReadonlySet<string>,
	b: ReadonlySet<string>,
): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const tok of a) {
		if (b.has(tok)) inter += 1;
	}
	const union = a.size + b.size - inter;
	return union > 0 ? inter / union : 0;
}

function countSetIntersection(
	a: ReadonlySet<string>,
	b: ReadonlySet<string>,
): number {
	let inter = 0;
	for (const tok of a) {
		if (b.has(tok)) inter += 1;
	}
	return inter;
}

function extractTitleLeadTokens(title: string): string {
	const beforeSep = title.split(/[:?—–]/, 1)[0] ?? "";
	if (!beforeSep || beforeSep.length === title.length) return "";
	const tokens = [...tokenizeTitleForFuzzyMatch(beforeSep)];
	if (tokens.length < 2) return "";
	return tokens.join(" ");
}

/**
 * Match submission-time track titles against camera-ready publisher titles (e.g.
 * `Beyond Response Time: Quantifying...` -> `Beyond Response Time: Investigating...`)
 * using normalized author-team overlap + title lead/containment kinship.
 */
export function scoreCameraReadyCandidateMatch(
	targetTitle: string,
	targetAuthors: readonly string[],
	candidateTitle: string,
	candidateAuthors: readonly string[],
): { matched: boolean; score: number } {
	const normA = normTitleKey(targetTitle);
	const normB = normTitleKey(candidateTitle);
	if (normA && normA === normB) {
		return { matched: true, score: 100 };
	}

	const aSurnames = extractAuthorSurnames(targetAuthors);
	const bSurnames = extractAuthorSurnames(candidateAuthors);
	const surnameInter = countSetIntersection(aSurnames, bSurnames);
	if (surnameInter === 0) {
		return { matched: false, score: 0 };
	}

	const aTokens = tokenizeTitleForFuzzyMatch(targetTitle);
	const bTokens = tokenizeTitleForFuzzyMatch(candidateTitle);
	const titleInter = countSetIntersection(aTokens, bTokens);
	const titleJaccard = computeSetJaccard(aTokens, bTokens);
	const authorJaccard = computeSetJaccard(aSurnames, bSurnames);

	if (titleJaccard >= 0.72) {
		return { matched: true, score: 10 + titleJaccard * 5 + authorJaccard };
	}

	const minAuthors = Math.min(aSurnames.size, bSurnames.size);
	const strongAuthorTeam =
		minAuthors >= 2
			? authorJaccard >= 0.6 ||
				(surnameInter >= 2 &&
					surnameInter >= minAuthors - 1 &&
					authorJaccard >= 0.5)
			: aSurnames.size === 1 && bSurnames.size === 1 && surnameInter === 1;
	if (!strongAuthorTeam) {
		return { matched: false, score: 0 };
	}

	const minTitleTokens = Math.min(aTokens.size, bTokens.size);
	const titleContain = minTitleTokens > 0 ? titleInter / minTitleTokens : 0;
	const leadA = extractTitleLeadTokens(targetTitle);
	const leadB = extractTitleLeadTokens(candidateTitle);
	const sameLead = leadA.length >= 10 && leadA === leadB;

	const titleKinship =
		minAuthors === 1
			? (sameLead && titleInter >= 4) ||
				(titleContain >= 0.72 && titleInter >= 4)
			: (sameLead && titleInter >= 3) ||
				(titleContain >= 0.65 && titleInter >= 4) ||
				(titleJaccard >= 0.5 && titleInter >= 4);

	if (!titleKinship) {
		return { matched: false, score: 0 };
	}

	return {
		matched: true,
		score:
			titleJaccard * 3 +
			titleContain * 2 +
			authorJaccard * 2 +
			(sameLead ? 2 : 0),
	};
}

function extractOpenAlexAuthorNames(row: OpenAlexWork): string[] {
	return (row.authorships ?? [])
		.map((a) => a.author?.display_name?.trim() ?? "")
		.filter(Boolean);
}

function extractOpenAlexUpstreamKeywords(row: OpenAlexWork): string[] {
	const entries = (row.keywords ?? []).filter(
		(k): k is { display_name: string; score?: number | null } =>
			Boolean(k?.display_name?.trim()) &&
			(typeof k?.score !== "number" || k.score >= 0.25),
	);
	entries.sort((a, b) => (b.score ?? 1) - (a.score ?? 1));
	return entries.map((k) => k.display_name);
}

function formatPages(
	first?: string | null,
	last?: string | null,
): string | undefined {
	const f = (first ?? "").trim();
	const l = (last ?? "").trim();
	if (f && l && f !== l) return `${f}-${l}`;
	return f || l || undefined;
}

function matchesPacmIssue(
	row: OpenAlexWork,
	pacmIssue?: string,
	doi?: string,
): boolean {
	if (!pacmIssue) return true;
	if (doi && !doi.toLowerCase().startsWith("10.1145/")) {
		return false;
	}
	const issue = (row.biblio?.issue ?? "").trim().toUpperCase();
	if (!issue) return false;
	const target = pacmIssue.toUpperCase();
	return issue === target || issue.startsWith(target);
}

export function openAlexWorkToVenueItem(
	row: OpenAlexWork,
	venue: VenueConfig,
	spec: VenueSpec | undefined,
	targetYear: number,
): CollectionPaperItem | null {
	if (
		row.type &&
		/^(paratext|peer-review|erratum|letter|editorial|grant|retraction|book|proceedings|journal-issue)$/i.test(
			row.type.trim(),
		)
	) {
		return null;
	}
	const rawTitle = (row.title ?? row.display_name ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (!rawTitle || isFrontmatterTitle(rawTitle)) return null;
	if (spec?.excludePositionPapers && isPositionPaperTitle(rawTitle)) {
		return null;
	}

	const doi = cleanDoi(row.doi);
	if (!matchesPacmIssue(row, spec?.pacmIssue, doi)) return null;

	const year = row.publication_year ?? targetYear;
	if (year < targetYear) return null;

	if (isExcludedByDoiPrefix(doi, spec?.excludeDoiPrefixes)) {
		return null;
	}
	if (spec?.requireDoiPrefixMatch && !matchesConfiguredDoiPrefix(doi, spec)) {
		return null;
	}
	// Reject bare IEEE conference-volume root DOIs such as `10.1109/re68928.2026` (papers end in `.00xxx` or `.11xxxxxx`)
	if (doi && /^10\.1109\/[a-z0-9-]+\.\d{4}$/i.test(doi)) {
		return null;
	}

	const venueKind = spec?.kind ?? inferVenueKind(venue);
	const pages = formatPages(row.biblio?.first_page, row.biblio?.last_page);
	if (venueKind === "journal" && isNonResearchJournalItem(rawTitle, pages)) {
		return null;
	}

	const sourceId = row.primary_location?.source?.id ?? "";
	const sourceExplicitlyCurated = Boolean(
		(spec?.openAlexSourceIds?.some((sid) => sourceId.endsWith(sid)) ?? false) ||
			(doi &&
				matchesConfiguredDoiPrefix(doi, spec) &&
				Boolean(spec?.doiPrefixFilters?.length || spec?.doiPrefixFilter)),
	);
	const sourceDisplayName =
		row.primary_location?.source?.display_name?.trim() ?? "";
	const landingPageUrl = row.primary_location?.landing_page_url?.trim() ?? "";
	if (venueKind === "conference") {
		if (
			hasPriorConferenceYearSpillover(
				targetYear,
				landingPageUrl,
				doi,
				sourceDisplayName,
			)
		) {
			return null;
		}
		if (
			!sourceExplicitlyCurated &&
			sourceDisplayName &&
			isWorkshopOrCompanionVenue(sourceDisplayName)
		) {
			return null;
		}
	}

	const rawAbs = reconstructOpenAlexAbstract(row.abstract_inverted_index);
	const abstract = isPlaceholderAbstract(rawAbs, venue.name) ? "" : rawAbs;
	const arxivId = extractArxivIdFromOpenAlex(row);
	const authors = (row.authorships ?? [])
		.map((a) => (a?.author?.display_name ?? "").trim())
		.filter(Boolean);
	if (authors.length === 0) return null;

	const venueDomain = spec?.domain ?? venue.domain;
	const ccfRank = spec?.ccfRank ?? venue.ccfRank;
	const venueFull =
		sourceDisplayName &&
		!isWorkshopOrCompanionVenue(sourceDisplayName) &&
		!isGenericRepositoryVenueName(sourceDisplayName)
			? sourceDisplayName
			: venue.name;
	const categories = [
		venue.name,
		...(venueDomain ? [venueDomain] : []),
		...(ccfRank ? [ccfRank] : []),
	];
	const keywords = derivePaperKeywords(
		rawTitle,
		abstract,
		categories,
		extractOpenAlexUpstreamKeywords(row),
	);
	const oaUrl = row.open_access?.oa_url?.trim() || "";
	const oaPdfCandidate =
		oaUrl && (/\.pdf(?:$|[?#])/i.test(oaUrl) || /\/pdf\//i.test(oaUrl))
			? oaUrl
			: undefined;

	return {
		id: buildVenuePaperId(venue.id, doi, arxivId, rawTitle),
		title: rawTitle,
		authors,
		abstract,
		publishedAt: `${row.publication_date || `${year}-01-01`}T00:00:00Z`,
		year,
		sourceType: "venue",
		sourceLabel: venue.name,
		categories,
		url: landingPageUrl || (doi ? `https://doi.org/${doi}` : venue.url),
		pdfUrl:
			row.primary_location?.pdf_url ||
			oaPdfCandidate ||
			(arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined),
		arxivId,
		doi,
		venueId: venue.id,
		venueKind,
		venueDomain,
		ccfRank,
		venueFull,
		citationCount: Math.max(0, row.cited_by_count ?? 0),
		keywords,
		volume: row.biblio?.volume?.trim() || undefined,
		issue: row.biblio?.issue?.trim() || undefined,
		pages,
	};
}

/**
 * Fetch 2026 venue papers with abstracts (when publicly available), citations, and keywords
 * from OpenAlex (`page=1..N`, avoiding OpenAlex's API-key gate on `cursor=`) + Crossref,
 * with optional `sinceDate` incremental watermark filtering. Valid proceedings/journal papers
 * without public abstracts are retained with `abstract: ""` rather than discarded.
 */
export async function fetchVenueStructuredPapers(
	venue: VenueConfig,
	year: number,
	fetchJson: FetchJsonFn,
	options?: {
		sinceDate?: string | null;
		maxPages?: number;
		preloadedItems?: readonly CollectionPaperItem[];
		signal?: AbortSignal;
		onProgress?: (progress: { completed: number; total: number }) => void;
	},
): Promise<{
	items: CollectionPaperItem[];
	remoteTotalCount?: number;
	hadSuccessfulResponse?: boolean;
}> {
	throwIfAborted(options?.signal);
	const effectiveFetchJson = wrapFetchJsonWithAbort(fetchJson, options?.signal);
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
	await ensureOpenAlexRuntimeKeyLoaded();
	const out: CollectionPaperItem[] = [];
	const seenIds = new Set<string>();
	const maxPages = Math.min(options?.maxPages ?? 25, 48);
	const sinceDate = options?.sinceDate?.slice(0, 10) || null;
	let remoteTotalCount: number | undefined;
	let attemptedRequests = 0;
	let succeededRequests = 0;

	const pushUnique = (item: CollectionPaperItem) => {
		if (seenIds.has(item.id)) {
			const idx = out.findIndex((x) => x.id === item.id);
			if (idx >= 0 && !out[idx]?.abstract && item.abstract) {
				const prevRec = out[idx]?.recommendedAt;
				out[idx] =
					prevRec && !item.recommendedAt
						? { ...item, recommendedAt: prevRec }
						: item;
			}
			return;
		}
		seenIds.add(item.id);
		out.push(item);
	};

	const filters: string[] = [];
	const dateFilter = sinceDate
		? `publication_year:${year},from_publication_date:${sinceDate}`
		: `publication_year:${year}`;
	if (spec?.openAlexSourceIds && spec.openAlexSourceIds.length > 0) {
		filters.push(
			`locations.source.id:${spec.openAlexSourceIds.join("|")},${dateFilter}`,
		);
	}
	const doiPrefixes = [
		...(spec?.doiPrefixFilters ?? []),
		...(spec?.doiPrefixFilter ? [spec.doiPrefixFilter] : []),
	].map((p) => p.toLowerCase());
	if (doiPrefixes.length > 0) {
		filters.push(`doi_starts_with:${doiPrefixes.join("|")},${dateFilter}`);
	} else if (
		spec?.issn &&
		(!spec.openAlexSourceIds || spec.openAlexSourceIds.length === 0)
	) {
		filters.push(`primary_location.source.issn:${spec.issn},${dateFilter}`);
	}

	for (const filterExpr of filters) {
		let filterTotal = Number.POSITIVE_INFINITY;
		for (let page = 1; page <= maxPages; page++) {
			throwIfAborted(options?.signal);
			if ((page - 1) * 200 >= filterTotal) break;
			attemptedRequests += 1;
			try {
				const oaUrl = withOpenAlexApiKey(
					`https://api.openalex.org/works?filter=${encodeURIComponent(filterExpr)}&sort=publication_date:desc&per-page=200&page=${page}&select=${OPENALEX_SELECT}&mailto=${MAILTO}`,
				);
				const data = await effectiveFetchJson<{
					meta?: { count?: number; next_cursor?: string | null };
					results?: OpenAlexWork[];
				}>(oaUrl);
				succeededRequests += 1;
				if (page === 1 && typeof data.meta?.count === "number") {
					filterTotal = data.meta.count;
					if (!sinceDate && !spec?.pacmIssue) {
						remoteTotalCount = Math.max(remoteTotalCount ?? 0, data.meta.count);
					}
				}
				const batch = data.results ?? [];
				for (const row of batch) {
					const item = openAlexWorkToVenueItem(row, venue, spec, year);
					if (item) {
						pushUnique(item);
					}
				}
				if (Number.isFinite(filterTotal) && filterTotal > 0) {
					const totalPages = Math.max(
						page,
						Math.min(maxPages, Math.ceil(filterTotal / 200)),
					);
					options?.onProgress?.({
						completed: batch.length < 200 ? totalPages : page,
						total: totalPages,
					});
				}
				if (batch.length < 200) {
					break;
				}
			} catch (err) {
				if (options?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
					throw err;
				}
				break;
			}
		}
	}

	const openAlexFailed = attemptedRequests > 0 && succeededRequests === 0;

	type CrossrefWorkRow = {
		DOI?: string;
		type?: string;
		title?: string[];
		abstract?: string;
		subject?: string[];
		volume?: string;
		issue?: string;
		page?: string;
		"is-referenced-by-count"?: number;
		"container-title"?: string[];
		author?: Array<{ given?: string; family?: string }>;
		published?: { "date-parts"?: number[][] };
		"published-online"?: { "date-parts"?: number[][] };
		"published-print"?: { "date-parts"?: number[][] };
	};

	const convertCrossrefRow = (
		row: CrossrefWorkRow,
		requireDoiPrefix: boolean,
	): CollectionPaperItem | null => {
		const rowType = (row.type ?? "").toLowerCase();
		if (
			rowType === "book" ||
			rowType === "proceedings" ||
			rowType === "journal-issue" ||
			rowType === "journal-volume"
		) {
			return null;
		}
		const doi = cleanDoi(row.DOI);
		const title = (row.title?.[0] ?? "").replace(/\s+/g, " ").trim();
		if (!doi || !title || isFrontmatterTitle(title)) return null;
		if (spec?.excludePositionPapers && isPositionPaperTitle(title)) return null;
		if (isExcludedByDoiPrefix(doi, spec?.excludeDoiPrefixes)) return null;
		if (requireDoiPrefix || spec?.requireDoiPrefixMatch) {
			const lowerDoi = doi.toLowerCase();
			const matched =
				doiPrefixes.length === 0 ||
				doiPrefixes.some(
					(px) =>
						lowerDoi.startsWith(px) &&
						(lowerDoi.length === px.length ||
							/^[./_-]/.test(lowerDoi.slice(px.length))),
				);
			if (!matched) return null;
		}

		const venueKind = spec?.kind ?? inferVenueKind(venue);
		if (venueKind === "journal" && isNonResearchJournalItem(title, row.page)) {
			return null;
		}

		const containerTitle = (row["container-title"]?.[0] ?? "").trim();
		if (
			spec?.crossrefContainerMatch &&
			!containerTitle
				.toLowerCase()
				.includes(spec.crossrefContainerMatch.toLowerCase())
		) {
			return null;
		}
		if (venueKind === "conference") {
			if (hasPriorConferenceYearSpillover(year, doi, containerTitle)) {
				return null;
			}
			if (containerTitle && isWorkshopOrCompanionVenue(containerTitle)) {
				return null;
			}
		}

		if (spec?.pacmIssue) {
			if (!doi.toLowerCase().startsWith("10.1145/")) return null;
			const iss = (row.issue ?? "").trim().toUpperCase();
			if (!iss.startsWith(spec.pacmIssue.toUpperCase())) return null;
		}

		const onlineParts = row["published-online"]?.["date-parts"]?.[0];
		const printParts = row["published-print"]?.["date-parts"]?.[0];
		const pubParts = row.published?.["date-parts"]?.[0];
		const parts = printParts ?? onlineParts ?? pubParts ?? [];
		const maxYear = Math.max(
			typeof onlineParts?.[0] === "number" ? onlineParts[0] : 0,
			typeof printParts?.[0] === "number" ? printParts[0] : 0,
			typeof pubParts?.[0] === "number" ? pubParts[0] : 0,
		);
		const y = maxYear > 0 ? maxYear : year;
		if (y < year && !spec?.crossrefIsbns?.length && !requireDoiPrefix) {
			return null;
		}
		const m = String(parts[1] ?? 1).padStart(2, "0");
		const d = String(parts[2] ?? 1).padStart(2, "0");
		const authors = (row.author ?? [])
			.map((a) => `${a.given ?? ""} ${a.family ?? ""}`.trim())
			.filter(Boolean);
		if (authors.length === 0) return null;

		const rawAbs = (row.abstract ?? "")
			.replace(/<[^>]+>/g, " ")
			.replace(/^abstract[:.\s-]*/i, "")
			.replace(/\s+/g, " ")
			.trim();
		const cleanAbs = isPlaceholderAbstract(rawAbs, venue.name) ? "" : rawAbs;

		const categories = [
			venue.name,
			...(spec?.domain ? [spec.domain] : []),
			...(spec?.ccfRank ? [spec.ccfRank] : []),
		];
		return {
			id: buildVenuePaperId(venue.id, doi, undefined, title),
			title,
			authors,
			abstract: cleanAbs,
			publishedAt: `${Math.max(y, year)}-${m}-${d}T00:00:00Z`,
			year: Math.max(y, year),
			sourceType: "venue",
			sourceLabel: venue.name,
			categories,
			url: `https://doi.org/${doi}`,
			doi,
			venueId: venue.id,
			venueKind,
			venueDomain: spec?.domain,
			ccfRank: spec?.ccfRank,
			venueFull:
				containerTitle && !isGenericRepositoryVenueName(containerTitle)
					? containerTitle
					: venue.name,
			citationCount: Math.max(0, row["is-referenced-by-count"] ?? 0),
			keywords: [],
			volume: row.volume,
			issue: row.issue,
			pages: row.page,
		};
	};

	const crossrefFilters: string[] = [];
	const fromDate = sinceDate ?? `${year}-01-01`;
	const untilDate = `${year}-12-31`;
	if (spec?.crossrefIsbns && spec.crossrefIsbns.length > 0 && out.length < 15) {
		crossrefFilters.push(
			spec.crossrefIsbns.map((isbn) => `isbn:${isbn}`).join(","),
		);
	}
	if (spec?.issn && (out.length < 40 || spec.kind === "journal")) {
		crossrefFilters.push(
			`issn:${encodeURIComponent(spec.issn)},from-pub-date:${fromDate},until-pub-date:${untilDate}`,
		);
	}

	const rawCrossrefPendingEnrich: CollectionPaperItem[] = [];

	if (crossrefFilters.length > 0) {
		const crMaxPages = Math.min(maxPages, 12);

		for (const crFilter of crossrefFilters) {
			let crCursor: string | null = "*";
			let crTotal = Number.POSITIVE_INFINITY;
			for (let page = 0; page < crMaxPages && crCursor; page++) {
				throwIfAborted(options?.signal);
				attemptedRequests += 1;
				try {
					// Note: Crossref rejects `sort=published` when combined with `cursor=` (HTTP 400).
					const crUrl: string = `https://api.crossref.org/works?filter=${crFilter}&rows=100&cursor=${encodeURIComponent(crCursor)}&mailto=${MAILTO}`;
					const crData = await effectiveFetchJson<{
						message?: {
							"total-results"?: number;
							"next-cursor"?: string;
							items?: CrossrefWorkRow[];
						};
					}>(crUrl);
					succeededRequests += 1;

					if (
						page === 0 &&
						typeof crData.message?.["total-results"] === "number"
					) {
						crTotal = crData.message["total-results"];
						if (!sinceDate && !spec?.pacmIssue) {
							remoteTotalCount = Math.max(remoteTotalCount ?? 0, crTotal);
						}
					}

					const rows = crData.message?.items ?? [];
					if (rows.length === 0) break;

					for (const row of rows) {
						const candidate = convertCrossrefRow(row, false);
						if (!candidate || seenIds.has(candidate.id)) continue;
						rawCrossrefPendingEnrich.push(candidate);
					}

					if (Number.isFinite(crTotal) && crTotal > 0) {
						const totalPages = Math.max(
							page + 1,
							Math.min(crMaxPages, Math.ceil(crTotal / 100)),
						);
						options?.onProgress?.({
							completed: rows.length < 100 ? totalPages : page + 1,
							total: totalPages,
						});
					}

					const nextCrCursor = crData.message?.["next-cursor"] ?? null;
					if (!nextCrCursor || nextCrCursor === crCursor || rows.length < 100) {
						break;
					}
					crCursor = nextCrCursor;
				} catch (err) {
					if (options?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
						throw err;
					}
					break;
				}
			}
		}
	}

	// Offset-paginated Crossref proceedings fallback when OpenAlex is rate-limited / empty
	// (`cursor=*` disables relevance ranking, whereas `offset=` ranks exact container-title matches first).
	if (
		out.length + rawCrossrefPendingEnrich.length < 40 &&
		spec?.crossrefProceedingsQuery &&
		doiPrefixes.length > 0
	) {
		const pubRoot = doiPrefixes[0]?.split("/")[0] ?? "";
		if (pubRoot) {
			const typeClause =
				pubRoot === "10.1145" ? ",type:proceedings-article" : "";
			const procFilter = `prefix:${encodeURIComponent(pubRoot)}${typeClause},from-pub-date:${fromDate},until-pub-date:${untilDate}`;
			const pageSize = 250;
			const maxOffsetPages = Math.min(maxPages, 6);
			for (let page = 0; page < maxOffsetPages; page++) {
				const offset = page * pageSize;
				attemptedRequests += 1;
				try {
					const crUrl = `https://api.crossref.org/works?filter=${procFilter}&query.container-title=${encodeURIComponent(spec.crossrefProceedingsQuery)}&rows=${pageSize}&offset=${offset}&mailto=${MAILTO}`;
					const crData = await fetchJson<{
						message?: {
							items?: CrossrefWorkRow[];
						};
					}>(crUrl);
					succeededRequests += 1;
					const rows = crData.message?.items ?? [];
					if (rows.length === 0) break;

					let matchedOnPage = 0;
					for (const row of rows) {
						const candidate = convertCrossrefRow(row, true);
						if (!candidate) continue;
						matchedOnPage += 1;
						if (!seenIds.has(candidate.id)) {
							rawCrossrefPendingEnrich.push(candidate);
						}
					}
					if (matchedOnPage === 0 || rows.length < pageSize) {
						break;
					}
				} catch {
					break;
				}
			}
		}
	}

	if (rawCrossrefPendingEnrich.length > 0) {
		const finalizedCr = await enrichVenueItemsBatch(
			rawCrossrefPendingEnrich,
			venue,
			fetchJson,
			options?.preloadedItems?.length
				? [...out, ...options.preloadedItems]
				: out,
			{ skipOpenAlexFilter: openAlexFailed },
		);
		for (const item of finalizedCr) {
			pushUnique(item);
		}
	}

	return {
		items: out,
		remoteTotalCount,
		hadSuccessfulResponse: attemptedRequests === 0 || succeededRequests > 0,
	};
}

const IS_ENRICH_TEST_ENV =
	typeof import.meta !== "undefined" && import.meta.env?.MODE === "test";

let openAlexSingletonNextSlotMs = 0;

async function acquireOpenAlexSingletonSlot(): Promise<void> {
	if (IS_ENRICH_TEST_ENV) return;
	const now = Date.now();
	const scheduled = Math.max(now, openAlexSingletonNextSlotMs);
	openAlexSingletonNextSlotMs = scheduled + 125;
	const waitMs = scheduled - now;
	if (waitMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, waitMs));
	}
}

async function fetchOpenAlexSingletonsByDoi(
	dois: readonly string[],
	fetchJson: FetchJsonFn,
	outMap: Map<string, OpenAlexWork>,
	maxItems = 260,
	options?: {
		signal?: AbortSignal;
		onProgress?: (completed: number, total: number) => void;
	},
): Promise<void> {
	throwIfAborted(options?.signal);
	const targets = dois.filter((d) => !outMap.has(d)).slice(0, maxItems);
	if (targets.length === 0) return;

	const CONCURRENCY = 4;
	let cursor = 0;
	let processed = 0;
	let succeeded = 0;
	let consecutiveFailures = 0;

	const worker = async () => {
		while (cursor < targets.length) {
			throwIfAborted(options?.signal);
			if (succeeded === 0 && consecutiveFailures >= 6) break;
			const doi = targets[cursor++];
			if (!doi) break;
			const url = withOpenAlexApiKey(
				`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=${OPENALEX_SELECT}&mailto=${MAILTO}`,
			);
			let fetched: OpenAlexWork | null = null;
			try {
				await acquireOpenAlexSingletonSlot();
				throwIfAborted(options?.signal);
				fetched = await fetchJson<OpenAlexWork>(url);
			} catch (err) {
				if (options?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
					throw err;
				}
				const msg = err instanceof Error ? err.message : String(err);
				if (!IS_ENRICH_TEST_ENV && /\b(?:429|502|503|504)\b/i.test(msg)) {
					await sleepWithAbort(1100, options?.signal);
					try {
						await acquireOpenAlexSingletonSlot();
						throwIfAborted(options?.signal);
						fetched = await fetchJson<OpenAlexWork>(url);
					} catch (retryErr) {
						if (
							options?.signal?.aborted ||
							isBackgroundTaskCancelledError(retryErr)
						) {
							throw retryErr;
						}
						fetched = null;
					}
				}
			}
			if (fetched && (fetched.id || fetched.doi || fetched.title)) {
				const clean = cleanDoi(fetched.doi)?.toLowerCase() || doi;
				outMap.set(clean, fetched);
				outMap.set(doi, fetched);
				succeeded += 1;
				consecutiveFailures = 0;
			} else {
				consecutiveFailures += 1;
			}
			processed += 1;
			options?.onProgress?.(processed, targets.length);
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () =>
			worker(),
		),
	);
	throwIfAborted(options?.signal);
}

function formatTitleSearchClause(rawTitle: string): string {
	let cleaned = rawTitle
		.replace(/[|,"'():[\]{}!?]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length > 115) {
		const wordBoundary = cleaned.lastIndexOf(" ", 115);
		cleaned =
			wordBoundary > 40
				? cleaned.slice(0, wordBoundary).trim()
				: cleaned.slice(0, 115).trim();
	}
	return cleaned;
}

/**
 * Hydrate proceedings/journal records by DOI using preloaded items first, then OpenAlex
 * `filter=doi:...` chunks (fast path when daily credits exist), automatically falling back
 * to OpenAlex's 0-credit singleton endpoint (`/works/doi:{doi}`) when list credits are exhausted,
 * plus batched `title.search` lookup for DOI-less proceedings (`USENIX Security`, `CCS`, etc.).
 */
export async function enrichVenueItemsBatch(
	items: CollectionPaperItem[],
	venue: VenueConfig,
	fetchJson: FetchJsonFn,
	preloadedItems?: readonly CollectionPaperItem[],
	options?: {
		skipOpenAlexFilter?: boolean;
		maxDoiLessLookups?: number;
		signal?: AbortSignal;
	},
): Promise<CollectionPaperItem[]> {
	throwIfAborted(options?.signal);
	if (items.length === 0) return [];
	const safeFetchJson = wrapFetchJsonWithAbort(fetchJson, options?.signal);
	await ensureOpenAlexRuntimeKeyLoaded();
	throwIfAborted(options?.signal);

	const preloadedByDoi = new Map<string, CollectionPaperItem>();
	const preloadedByTitle = new Map<string, CollectionPaperItem>();
	if (preloadedItems && preloadedItems.length > 0) {
		for (const p of preloadedItems) {
			if (p.doi) preloadedByDoi.set(p.doi.toLowerCase(), p);
			if (p.arxivId) {
				const aid = stripArxivVersion(p.arxivId).toLowerCase();
				if (aid && !preloadedByDoi.has(`10.48550/arxiv.${aid}`)) {
					preloadedByDoi.set(`10.48550/arxiv.${aid}`, p);
				}
			}
			const tk = normTitleKey(p.title);
			if (tk) {
				const prev = preloadedByTitle.get(tk);
				if (!prev || p.abstract.length > prev.abstract.length) {
					preloadedByTitle.set(tk, p);
				}
			}
		}
	}

	const isPreloadedComplete = (p: CollectionPaperItem | undefined): boolean =>
		Boolean(p && isPaperMetadataComplete(p, venue.name));

	const resolveLookupDoi = (item: CollectionPaperItem): string | undefined =>
		item.doi?.toLowerCase() ||
		(item.arxivId
			? `10.48550/arxiv.${stripArxivVersion(item.arxivId).toLowerCase()}`
			: undefined);

	const byDoi = new Map<string, OpenAlexWork>();
	const unmatchedDois = Array.from(
		new Set(
			items
				.map(resolveLookupDoi)
				.filter(
					(d): d is string =>
						Boolean(d) && !isPreloadedComplete(preloadedByDoi.get(d ?? "")),
				),
		),
	);

	let openAlexFilterFailed = Boolean(options?.skipOpenAlexFilter);
	if (!openAlexFilterFailed && unmatchedDois.length > 0) {
		const CHUNK = 50;
		for (let i = 0; i < unmatchedDois.length; i += CHUNK) {
			throwIfAborted(options?.signal);
			const batch = unmatchedDois.slice(i, i + CHUNK);
			const filter = `doi:${batch.map((d) => `https://doi.org/${d}`).join("|")}`;
			try {
				const url = withOpenAlexApiKey(
					`https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&per-page=${CHUNK}&select=${OPENALEX_SELECT}&mailto=${MAILTO}`,
				);
				const res = await safeFetchJson<{
					error?: string;
					results?: OpenAlexWork[];
				}>(url);
				if (res.error) {
					openAlexFilterFailed = true;
					break;
				}
				for (const row of res.results ?? []) {
					const d = cleanDoi(row.doi)?.toLowerCase();
					if (d) mergeOpenAlexRowIntoMap(byDoi, d, row);
					for (const aid of extractAllArxivIdsFromOpenAlex(row)) {
						mergeOpenAlexRowIntoMap(byDoi, `10.48550/arxiv.${aid}`, row);
					}
				}
			} catch (err) {
				if (options?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
					throw err;
				}
				openAlexFilterFailed = true;
				break;
			}
		}
	}

	// Zero-credit OpenAlex singleton fallback (`/works/doi:{doi}`) when daily list credits
	// were rate-limited or skipped, ensuring preload still hydrates ~100% abstracts + keywords.
	if (openAlexFilterFailed && unmatchedDois.length > 0) {
		await fetchOpenAlexSingletonsByDoi(
			unmatchedDois,
			safeFetchJson,
			byDoi,
			260,
			{
				signal: options?.signal,
			},
		);
	}

	// Batched OpenAlex `title.search` lookup for DOI-less proceedings records
	// (e.g. `USENIX Security 2026`, `CCS 2026`, `ISSRE 2026` before publisher DOIs are minted).
	const byTitle = new Map<string, OpenAlexWork>();
	const titleSearchRows: OpenAlexWork[] = [];
	if (!openAlexFilterFailed) {
		const maxDoiLess =
			options?.maxDoiLessLookups ?? (hasCachedOpenAlexApiKey() ? 1800 : 600);
		const doiLessItems = items
			.filter(
				(i) =>
					!resolveLookupDoi(i) &&
					!isPreloadedComplete(preloadedByTitle.get(normTitleKey(i.title))),
			)
			.slice(0, Math.max(0, maxDoiLess));
		const targetTitleKeys = new Set(
			doiLessItems.map((i) => normTitleKey(i.title)).filter(Boolean),
		);
		const TITLE_CHUNK = 15;
		const batches: CollectionPaperItem[][] = [];
		for (let i = 0; i < doiLessItems.length; i += TITLE_CHUNK) {
			batches.push(doiLessItems.slice(i, i + TITLE_CHUNK));
		}

		if (batches.length > 0) {
			const CONCURRENCY = 4;
			let batchCursor = 0;
			let aborted = false;

			const worker = async () => {
				while (!aborted && batchCursor < batches.length) {
					throwIfAborted(options?.signal);
					const batch = batches[batchCursor++];
					if (!batch) break;
					const clauses = batch
						.map((item) => formatTitleSearchClause(item.title))
						.filter((t) => t.length > 8);
					if (clauses.length === 0) continue;
					const filter = `title.search:${clauses.map((t) => `"${t}"`).join("|")},from_publication_date:2023-01-01`;
					try {
						const url = withOpenAlexApiKey(
							`https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&per-page=80&select=${OPENALEX_SELECT}&mailto=${MAILTO}`,
						);
						const res = await safeFetchJson<{
							error?: string;
							results?: OpenAlexWork[];
						}>(url);
						if (res.error) {
							aborted = true;
							break;
						}
						for (const row of res.results ?? []) {
							titleSearchRows.push(row);
							const tk = normTitleKey(row.title || row.display_name || "");
							if (tk && targetTitleKeys.has(tk)) {
								mergeOpenAlexRowIntoMap(byTitle, tk, row);
							}
						}
					} catch (err) {
						if (
							options?.signal?.aborted ||
							isBackgroundTaskCancelledError(err)
						) {
							throw err;
						}
						aborted = true;
						break;
					}
				}
			};

			await Promise.all(
				Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () =>
					worker(),
				),
			);
			throwIfAborted(options?.signal);
		}
	}

	const enriched: CollectionPaperItem[] = [];
	for (const item of items) {
		if (isFrontmatterTitle(item.title)) continue;
		const tKey = normTitleKey(item.title);
		const lookupDoi = resolveLookupDoi(item);
		let pre =
			(item.doi ? preloadedByDoi.get(item.doi.toLowerCase()) : undefined) ??
			(tKey ? preloadedByTitle.get(tKey) : undefined);
		if (!pre && preloadedItems && preloadedItems.length > 0) {
			let bestPreScore = 0;
			for (const cand of preloadedItems) {
				const res = scoreCameraReadyCandidateMatch(
					item.title,
					item.authors,
					cand.title,
					cand.authors,
				);
				if (res.matched && res.score > bestPreScore) {
					bestPreScore = res.score;
					pre = cand;
				}
			}
		}
		let row =
			(lookupDoi ? byDoi.get(lookupDoi) : undefined) ??
			(tKey ? byTitle.get(tKey) : undefined);
		if (!row && titleSearchRows.length > 0) {
			let bestRowScore = 0;
			for (const cand of titleSearchRows) {
				const candTitle = cand.title || cand.display_name || "";
				if (!candTitle) continue;
				const res = scoreCameraReadyCandidateMatch(
					item.title,
					item.authors,
					candTitle,
					extractOpenAlexAuthorNames(cand),
				);
				if (res.matched && res.score > bestRowScore) {
					bestRowScore = res.score;
					row = cand;
				}
			}
		}

		let abstract = item.abstract;
		let doi = item.doi;
		let citationCount = item.citationCount ?? 0;
		let upstreamKw: string[] = [...(item.keywords ?? [])];
		let volume = item.volume;
		let issue = item.issue;
		let pages = item.pages;
		let venueFull = item.venueFull;
		let arxivId = item.arxivId;
		let pdfUrl = item.pdfUrl;
		let publishedAt = item.publishedAt;
		let coolPapersId = item.coolPapersId;
		let recommendedAt = item.recommendedAt;

		if (pre) {
			if (
				isPlaceholderAbstract(abstract, venue.name) &&
				!isPlaceholderAbstract(pre.abstract, venue.name)
			) {
				abstract = pre.abstract;
			}
			doi = doi || pre.doi;
			citationCount = Math.max(citationCount, pre.citationCount ?? 0);
			upstreamKw = [...upstreamKw, ...(pre.keywords ?? [])];
			volume = volume || pre.volume;
			issue = issue || pre.issue;
			pages = pages || pre.pages;
			venueFull =
				venueFull && venueFull !== venue.name ? venueFull : pre.venueFull;
			arxivId = arxivId || pre.arxivId;
			pdfUrl = pdfUrl || pre.pdfUrl;
			coolPapersId = coolPapersId || pre.coolPapersId;
			recommendedAt = recommendedAt || pre.recommendedAt;
			if (
				pre.publishedAt &&
				(publishedAt.endsWith("-01-01T00:00:00Z") ||
					pre.publishedAt > publishedAt)
			) {
				publishedAt = pre.publishedAt;
			}
		}

		if (row) {
			const oaAbs = reconstructOpenAlexAbstract(row.abstract_inverted_index);
			if (
				isPlaceholderAbstract(abstract, venue.name) &&
				!isPlaceholderAbstract(oaAbs, venue.name)
			) {
				abstract = oaAbs;
			}
			doi = doi || cleanDoi(row.doi);
			citationCount = Math.max(citationCount, row.cited_by_count ?? 0);
			upstreamKw = [...upstreamKw, ...extractOpenAlexUpstreamKeywords(row)];
			volume = volume || row.biblio?.volume?.trim() || undefined;
			issue = issue || row.biblio?.issue?.trim() || undefined;
			pages =
				pages || formatPages(row.biblio?.first_page, row.biblio?.last_page);
			const rowSourceName =
				row.primary_location?.source?.display_name?.trim() || "";
			venueFull =
				(venueFull &&
				venueFull !== venue.name &&
				!isGenericRepositoryVenueName(venueFull)
					? venueFull
					: undefined) ||
				(!isWorkshopOrCompanionVenue(rowSourceName) &&
				!isGenericRepositoryVenueName(rowSourceName)
					? rowSourceName
					: undefined) ||
				venue.name;
			arxivId = arxivId || extractArxivIdFromOpenAlex(row);
			const oaUrl = row.open_access?.oa_url?.trim() || "";
			const oaPdf =
				oaUrl && (/\.pdf(?:$|[?#])/i.test(oaUrl) || /\/pdf\//i.test(oaUrl))
					? oaUrl
					: undefined;
			pdfUrl =
				pdfUrl ||
				row.primary_location?.pdf_url ||
				oaPdf ||
				(arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined);
			if (row.publication_date) {
				publishedAt = `${row.publication_date}T00:00:00Z`;
			}
		}

		const normalizedAbstract = isPlaceholderAbstract(abstract, venue.name)
			? ""
			: abstract;

		enriched.push({
			...item,
			id: item.venueId
				? buildVenuePaperId(item.venueId, doi, arxivId, item.title)
				: item.id,
			doi,
			abstract: normalizedAbstract,
			publishedAt,
			arxivId,
			pdfUrl,
			coolPapersId,
			...(recommendedAt ? { recommendedAt } : {}),
			venueFull,
			citationCount,
			volume,
			issue,
			pages,
			keywords: normalizePaperKeywords(upstreamKw),
		});
	}

	return enriched;
}

function decodeBasicHtmlEntities(raw: string): string {
	return raw
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
			const cp = Number.parseInt(hex, 16);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
		})
		.replace(/&#(\d+);/g, (_, dec) => {
			const cp = Number.parseInt(dec, 10);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
		});
}

/**
 * Extract author-declared LaTeX `\keywords{...}` / `Index Terms` from public
 * `https://arxiv.org/html/<id>` LaTeXML markup:
 * - `<div class="ltx_keywords">...</div>` (`IEEEtran`, standard `\keywords`)
 * - `<div class="ltx_classification"><h6>keywords</h6>...</div>` (ACM `acmart`, `elsarticle`, excluding `ccs`)
 * - Inline `<p class="ltx_p"><b>Keywords:</b> ...</p>` paragraphs
 * - `<meta name="keywords" content="...">`
 */
export function extractArxivHtmlKeywords(html: string): string[] {
	if (!html) return [];
	const rawFragments: string[] = [];

	const ltxRegex =
		/<div[^>]+class=["'][^"']*\bltx_keywords\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
	for (let m = ltxRegex.exec(html); m !== null; m = ltxRegex.exec(html)) {
		if (m[1]) rawFragments.push(m[1]);
	}

	const classRegex =
		/<div[^>]+class=["'][^"']*\bltx_classification\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
	for (let m = classRegex.exec(html); m !== null; m = classRegex.exec(html)) {
		const body = m[1] ?? "";
		const headingText = decodeBasicHtmlEntities(
			(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(body)?.[1] ?? "").replace(
				/<[^>]+>/g,
				" ",
			),
		)
			.replace(/\s+/g, " ")
			.replace(/[:：.—–-]+$/, "")
			.trim();
		const plainCheck = decodeBasicHtmlEntities(body.replace(/<[^>]+>/g, " "))
			.replace(/\s+/g, " ")
			.trim();
		if (
			/^(?:keywords?|key\s+words?|index\s+terms?)$/i.test(headingText) ||
			(!headingText &&
				/^(?:keywords?|key\s+words?|index\s+terms?)\b/i.test(plainCheck))
		) {
			rawFragments.push(body);
		}
	}

	if (rawFragments.length === 0) {
		const inlineRegex =
			/<(?:p|div)[^>]*>\s*<(?:span|b|strong|em|i)\b[^>]*>\s*(?:Keywords?|Key\s+words?|Index\s+Terms?)\s*[:：.—–-]?\s*<\/(?:span|b|strong|em|i)>\s*[:：.—–-]?\s*([\s\S]{3,360}?)<\/(?:p|div)>/gi;
		for (
			let m = inlineRegex.exec(html);
			m !== null;
			m = inlineRegex.exec(html)
		) {
			if (m[1]) rawFragments.push(m[1]);
		}
	}

	const metaKw =
		/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']+)["']/i.exec(
			html,
		)?.[1] ??
		/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']keywords["']/i.exec(
			html,
		)?.[1];
	if (metaKw) rawFragments.push(metaKw);

	if (rawFragments.length === 0) return [];

	const candidates: string[] = [];
	for (const frag of rawFragments) {
		const plain = decodeBasicHtmlEntities(
			frag
				.replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi, " ")
				.replace(/<[^>]+>/g, " "),
		)
			.replace(
				/^(?:keywords?|key\s+words?|index\s+terms?)\s*[:：.—–-]*\s*/i,
				"",
			)
			.replace(/\s+/g, " ")
			.replace(/\.+$/, "")
			.trim();
		if (!plain) continue;
		const parts = plain
			.split(/[,;|·•\n]+/)
			.map((p) => p.trim())
			.filter(Boolean);
		// Skip malformed LNCS run-on blocks where LaTeXML stripped `\and` into plain spaces
		if (parts.length === 1 && (parts[0]?.split(/\s+/).length ?? 0) > 5) {
			continue;
		}
		for (const part of parts) {
			const leaf = part
				.split(/\s*(?:→|->)\s*/)
				.pop()
				?.replace(/\.+$/, "")
				.trim();
			if (leaf) candidates.push(leaf);
		}
	}

	return normalizePaperKeywords(candidates);
}

export type EnrichArxivBatchOptions = {
	keywordLlmFetch?: typeof fetch;
	signal?: AbortSignal;
	onProgress?: (completed: number, total: number) => void;
};

function mergeOpenAlexRowIntoMap(
	map: Map<string, OpenAlexWork>,
	key: string,
	next: OpenAlexWork,
): void {
	const prev = map.get(key);
	if (!prev) {
		map.set(key, next);
		return;
	}
	const prevDoi = cleanDoi(prev.doi);
	const nextDoi = cleanDoi(next.doi);
	const preferredDoi =
		prevDoi && !prevDoi.toLowerCase().startsWith("10.48550/arxiv.")
			? prev.doi
			: nextDoi && !nextDoi.toLowerCase().startsWith("10.48550/arxiv.")
				? next.doi
				: prev.doi || next.doi;
	map.set(key, {
		...prev,
		doi: preferredDoi,
		publication_date: prev.publication_date || next.publication_date,
		abstract_inverted_index:
			prev.abstract_inverted_index ?? next.abstract_inverted_index,
		biblio: prev.biblio ?? next.biblio,
		primary_location: prev.primary_location ?? next.primary_location,
		locations: [...(prev.locations ?? []), ...(next.locations ?? [])],
		open_access: prev.open_access ?? next.open_access,
		cited_by_count: Math.max(
			prev.cited_by_count ?? 0,
			next.cited_by_count ?? 0,
		),
		keywords: [...(prev.keywords ?? []), ...(next.keywords ?? [])],
	});
}

/**
 * Batch-enrich arXiv items with OpenAlex `cited_by_count`, reconstructed abstract
 * (when missing), and paper-level `work.keywords` using `10.48550/arxiv.<id>` DOIs
 * and OAI-PMH `locations.landing_page_url` (falling back to 0-credit OpenAlex singletons
 * on rate-limit), then directly extract keywords via OpenRouter `:free` LLM for any
 * candidate paper whose keywords remain empty.
 */
export async function enrichArxivItemsBatch(
	items: CollectionPaperItem[],
	fetchJson: FetchJsonFn,
	maxLookup = items.length,
	options?: EnrichArxivBatchOptions,
): Promise<CollectionPaperItem[]> {
	throwIfAborted(options?.signal);
	if (items.length === 0) return [];
	const safeFetchJson = wrapFetchJsonWithAbort(fetchJson, options?.signal);
	await ensureOpenAlexRuntimeKeyLoaded();
	throwIfAborted(options?.signal);
	const withDefaults: CollectionPaperItem[] = items.map((item) => ({
		...item,
		citationCount: item.citationCount ?? 0,
		keywords: normalizePaperKeywords(item.keywords),
	}));

	const maxCandidateCount = Math.max(0, maxLookup);
	const candidateIndices: number[] = [];
	for (let idx = 0; idx < withDefaults.length; idx++) {
		if (candidateIndices.length >= maxCandidateCount) break;
		if (stripArxivVersion(withDefaults[idx]?.arxivId)) {
			candidateIndices.push(idx);
		}
	}
	if (candidateIndices.length === 0) return withDefaults;
	const candidates = candidateIndices
		.map((idx) => withDefaults[idx])
		.filter((x): x is CollectionPaperItem => Boolean(x));

	const totalWork = candidates.length;
	let lastEmittedProgress = -1;
	const emitBatchProgress = (completed: number) => {
		const clamped = Math.max(0, Math.min(totalWork, Math.round(completed)));
		if (clamped <= lastEmittedProgress) return;
		lastEmittedProgress = clamped;
		options?.onProgress?.(clamped, totalWork);
	};
	emitBatchProgress(0);

	const byArxiv = new Map<string, OpenAlexWork>();
	const byTitle = new Map<string, OpenAlexWork>();
	const candidateTitleKeys = new Set(
		candidates.map((c) => normTitleKey(c.title)).filter(Boolean),
	);
	const CHUNK = 80;
	let openAlexFilterFailed = false;

	const indexOpenAlexRow = (row: OpenAlexWork) => {
		for (const aid of extractAllArxivIdsFromOpenAlex(row)) {
			mergeOpenAlexRowIntoMap(byArxiv, aid, row);
		}
		const tk = normTitleKey(row.title ?? row.display_name ?? "");
		if (tk && candidateTitleKeys.has(tk)) {
			mergeOpenAlexRowIntoMap(byTitle, tk, row);
		}
	};

	for (let i = 0; i < candidates.length; i += CHUNK) {
		throwIfAborted(options?.signal);
		const batch = candidates.slice(i, i + CHUNK);
		const filter = `doi:${batch.map((p) => `10.48550/arxiv.${stripArxivVersion(p.arxivId)}`).join("|")}`;
		try {
			const url = withOpenAlexApiKey(
				`https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&per-page=100&select=${OPENALEX_ARXIV_SELECT}&mailto=${MAILTO}`,
			);
			const res = await safeFetchJson<{
				error?: string;
				results?: OpenAlexWork[];
			}>(url);
			if (res.error) {
				openAlexFilterFailed = true;
				break;
			}
			for (const row of res.results ?? []) {
				indexOpenAlexRow(row);
			}
			const processed = Math.min(totalWork, i + batch.length);
			emitBatchProgress(Math.max(1, Math.round(processed * 0.2)));
		} catch (err) {
			if (options?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
				throw err;
			}
			openAlexFilterFailed = true;
			break;
		}
	}

	// Secondary OpenAlex OAI-PMH lookup (`locations.landing_page_url:https://arxiv.org/abs/<id>`)
	// for preprints ingested via OAI-PMH whose DataCite `10.48550/arxiv.<id>` DOI is not linked yet.
	if (!openAlexFilterFailed) {
		const oaiUnmatchedAids = Array.from(
			new Set(
				candidates
					.map((c) => stripArxivVersion(c.arxivId).toLowerCase())
					.filter((aid) => Boolean(aid) && !byArxiv.has(aid)),
			),
		);
		const OAI_CHUNK = 50;
		for (let i = 0; i < oaiUnmatchedAids.length; i += OAI_CHUNK) {
			throwIfAborted(options?.signal);
			const batchAids = oaiUnmatchedAids.slice(i, i + OAI_CHUNK);
			const filter = `locations.landing_page_url:${batchAids.map((aid) => `https://arxiv.org/abs/${aid}`).join("|")}`;
			try {
				const url = withOpenAlexApiKey(
					`https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&per-page=100&select=${OPENALEX_ARXIV_SELECT}&mailto=${MAILTO}`,
				);
				const res = await safeFetchJson<{
					error?: string;
					results?: OpenAlexWork[];
				}>(url);
				if (res.error) break;
				for (const row of res.results ?? []) {
					indexOpenAlexRow(row);
				}
				const oaiFraction =
					(i + batchAids.length) / Math.max(1, oaiUnmatchedAids.length);
				emitBatchProgress(Math.round(totalWork * (0.2 + 0.1 * oaiFraction)));
			} catch (err) {
				if (options?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
					throw err;
				}
				break;
			}
		}
	}

	if (openAlexFilterFailed) {
		const unmatchedDois = Array.from(
			new Set(
				candidates
					.map((c) => stripArxivVersion(c.arxivId).toLowerCase())
					.filter((aid) => Boolean(aid) && !byArxiv.has(aid))
					.map((aid) => `10.48550/arxiv.${aid}`),
			),
		);
		if (unmatchedDois.length > 0) {
			const singletonByDoi = new Map<string, OpenAlexWork>();
			const singletonBaseline = Math.max(0, lastEmittedProgress);
			await fetchOpenAlexSingletonsByDoi(
				unmatchedDois,
				safeFetchJson,
				singletonByDoi,
				260,
				{
					signal: options?.signal,
					onProgress: (done, total) => {
						const frac = total > 0 ? done / total : 1;
						const target = Math.max(
							singletonBaseline + 1,
							Math.round(totalWork * (0.12 + 0.25 * frac)),
						);
						emitBatchProgress(Math.min(totalWork, target));
					},
				},
			);
			for (const [doiKey, row] of singletonByDoi.entries()) {
				indexOpenAlexRow(row);
				const m = /^10\.48550\/arxiv\.(\d{4}\.\d{4,5})$/i.exec(doiKey);
				if (m?.[1]) {
					mergeOpenAlexRowIntoMap(byArxiv, m[1].toLowerCase(), row);
				}
			}
		}
	}

	const enriched: CollectionPaperItem[] = withDefaults.map((item) => {
		const cleanAid = stripArxivVersion(item.arxivId).toLowerCase();
		const row =
			(cleanAid ? byArxiv.get(cleanAid) : undefined) ??
			byTitle.get(normTitleKey(item.title));
		if (!row) {
			return {
				...item,
				doi:
					item.doi ||
					(item.arxivId
						? `10.48550/arxiv.${stripArxivVersion(item.arxivId)}`
						: undefined),
			};
		}
		const oaAbs = reconstructOpenAlexAbstract(row.abstract_inverted_index);
		const bestAbstract =
			isPlaceholderAbstract(item.abstract, item.sourceLabel) &&
			!isPlaceholderAbstract(oaAbs, item.sourceLabel)
				? oaAbs
				: item.abstract;
		const upstream = [
			...(item.keywords ?? []),
			...extractOpenAlexUpstreamKeywords(row),
		];
		return {
			...item,
			abstract: bestAbstract,
			doi:
				item.doi ||
				(item.arxivId
					? `10.48550/arxiv.${stripArxivVersion(item.arxivId)}`
					: undefined),
			citationCount: Math.max(item.citationCount ?? 0, row.cited_by_count ?? 0),
			keywords: normalizePaperKeywords(upstream),
		};
	});

	// Direct Keyword LLM fallback for any candidate arXiv paper still lacking keywords
	const llmMissingIndices = candidateIndices.filter(
		(idx) => normalizePaperKeywords(enriched[idx]?.keywords).length === 0,
	);
	if (llmMissingIndices.length > 0) {
		const llmInputs = llmMissingIndices
			.map((idx) => enriched[idx])
			.filter((x): x is CollectionPaperItem => Boolean(x))
			.map((item) => ({
				id: item.id,
				title: item.title,
				abstract: item.abstract,
			}));
		if (llmInputs.length > 0) {
			const llmBaseline = Math.max(
				Math.round(totalWork * 0.35),
				lastEmittedProgress,
			);
			try {
				const extracted = await extractKeywordsWithKeywordLlmBatch(llmInputs, {
					fetchFn: options?.keywordLlmFetch,
					signal: options?.signal,
					onProgress: (done, total) => {
						const frac = total > 0 ? done / total : 1;
						emitBatchProgress(
							llmBaseline + Math.round((totalWork - llmBaseline) * frac),
						);
					},
				});
				for (const idx of llmMissingIndices) {
					const item = enriched[idx];
					if (!item) continue;
					const llmKws = normalizePaperKeywords(extracted.get(item.id), 8);
					if (llmKws.length > 0) {
						enriched[idx] = {
							...item,
							keywords: llmKws,
						};
					}
				}
			} catch (err) {
				if (options?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
					throw err;
				}
				// Best-effort fallback when Keyword LLM is unconfigured or rate-limited.
			}
		}
	}

	emitBatchProgress(totalWork);
	return enriched;
}

/**
 * Extract full abstract from a public Springer article or LNCS chapter HTML page
 * (`https://link.springer.com/article/<doi>` or `/chapter/<doi>`).
 */
export function extractSpringerHtmlAbstract(html: string): string {
	const absDiv =
		/<div[^>]+id=["']Abs\d+-content["'][^>]*>([\s\S]*?)<\/div>/i.exec(
			html,
		)?.[1] ??
		/<section[^>]+data-title=["']Abstract["'][^>]*>([\s\S]*?)<\/section>/i.exec(
			html,
		)?.[1];
	if (absDiv) {
		const cleaned = decodeBasicHtmlEntities(
			absDiv
				.replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi, " ")
				.replace(/<[^>]+>/g, " "),
		)
			.replace(/^abstract[:.\s-]*/i, "")
			.replace(/\s+/g, " ")
			.trim();
		if (cleaned.length >= 40) return cleaned;
	}
	const metaDesc =
		/<meta[^>]+name=["']dc\.description["'][^>]+content=["']([^"']+)["']/i.exec(
			html,
		)?.[1] ??
		/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']dc\.description["']/i.exec(
			html,
		)?.[1];
	if (metaDesc) {
		const cleaned = decodeBasicHtmlEntities(metaDesc)
			.replace(/^abstract[:.\s-]*/i, "")
			.replace(/\s+/g, " ")
			.trim();
		if (cleaned.length >= 40) return cleaned;
	}
	return "";
}

/** Fetch public abstract from `link.springer.com` for `10.1007/*` DOIs (LNCS chapters & journals). */
export async function fetchSpringerAbstract(
	doi: string,
	fetchText: FetchTextFn,
): Promise<string> {
	const clean = cleanDoi(doi);
	if (!clean?.toLowerCase().startsWith("10.1007/")) return "";
	const isBookChapter = /^10\.1007\/978-/i.test(clean);
	const paths = isBookChapter
		? [`chapter/${clean}`, `article/${clean}`]
		: [`article/${clean}`, `chapter/${clean}`];
	for (const p of paths) {
		try {
			const html = await fetchText(
				`https://link.springer.com/${p}`,
				"text/html,application/xhtml+xml",
			);
			const abs = extractSpringerHtmlAbstract(html);
			if (abs) return abs;
		} catch {
			// Try alternate path if any.
		}
	}
	return "";
}

/**
 * Batch-backfill missing abstracts for Springer conference proceedings (`SAS 2026`)
 * and Springer journals (`ASE (J) 2026`, `ESE 2026`) where OpenAlex/Crossref omit abstracts
 * while `link.springer.com` serves complete `#Abs1-content` publicly.
 */
export async function backfillSpringerAbstracts(
	items: CollectionPaperItem[],
	fetchText: FetchTextFn,
	maxItems = 180,
	options?: {
		signal?: AbortSignal;
		onProgress?: (progress: { completed: number; total: number }) => void;
	},
): Promise<CollectionPaperItem[]> {
	throwIfAborted(options?.signal);
	const targets: number[] = [];
	for (let i = 0; i < items.length; i++) {
		const p = items[i];
		if (!p?.doi?.toLowerCase().startsWith("10.1007/")) continue;
		if (!isPlaceholderAbstract(p.abstract, p.sourceLabel)) continue;
		targets.push(i);
		if (targets.length >= maxItems) break;
	}
	if (targets.length === 0) return items;

	const effectiveFetchText = wrapFetchTextWithAbort(fetchText, options?.signal);
	const result = [...items];
	const CONCURRENCY = 5;
	let cursor = 0;
	let completed = 0;

	const worker = async () => {
		while (cursor < targets.length) {
			throwIfAborted(options?.signal);
			const targetIdx = targets[cursor++];
			if (targetIdx === undefined) break;
			const item = result[targetIdx];
			if (!item?.doi) continue;
			const abs = await fetchSpringerAbstract(item.doi, effectiveFetchText);
			if (abs && !isPlaceholderAbstract(abs, item.sourceLabel)) {
				result[targetIdx] = {
					...item,
					abstract: abs,
					keywords: normalizePaperKeywords(item.keywords),
				};
			}
			completed += 1;
			options?.onProgress?.({ completed, total: targets.length });
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () =>
			worker(),
		),
	);
	return result;
}

/**
 * On-demand single-paper detail resolver when clicking a paper card if any field
 * (complete abstract, citation count, or canonical keywords) is still missing:
 * 1. OpenAlex 0-credit singleton (`works/doi:{doi}`, OAI-PMH landing URL, or title fallback)
 * 2. Direct publisher fallback (`CSDL GraphQL` for `10.1109/*`, Springer HTML for `10.1007/*`, or `papers.cool`)
 * 3. Semantic Scholar (`DOI:` / `ARXIV:` — abstract, citationCount, OA PDF, arXiv ID) + arXiv Atom abstract recovery
 * 4. Public `arxiv.org/html/<id>` author `\keywords{...}` fallback (Venue preprints only)
 * 5. Keyword LLM extraction when keywords remain empty (both arXiv and Venue)
 */
export async function enrichSinglePaperOnDemand(
	paper: CollectionPaperItem,
	fetchJson: FetchJsonFn,
	fetchText?: FetchTextFn,
	options?: {
		keywordLlmFetch?: typeof fetch;
		signal?: AbortSignal;
	},
): Promise<CollectionPaperItem> {
	throwIfAborted(options?.signal);
	const safeFetchJson = wrapFetchJsonWithAbort(fetchJson, options?.signal);
	await ensureOpenAlexRuntimeKeyLoaded();
	throwIfAborted(options?.signal);
	let abstract = paper.abstract;
	let citationCount = paper.citationCount;
	const upstreamKw: string[] = [...(paper.keywords ?? [])];
	let doi = paper.doi;
	let arxivId = paper.arxivId;
	let pdfUrl = paper.pdfUrl;
	let volume = paper.volume;
	let issue = paper.issue;
	let pages = paper.pages;
	let venueFull = paper.venueFull;

	const applyOpenAlex = (row: OpenAlexWork | null | undefined) => {
		if (!row) return;
		const oaAbs = reconstructOpenAlexAbstract(row.abstract_inverted_index);
		if (
			isPlaceholderAbstract(abstract, paper.sourceLabel) &&
			!isPlaceholderAbstract(oaAbs, paper.sourceLabel)
		) {
			abstract = oaAbs;
		}
		if (typeof row.cited_by_count === "number") {
			citationCount = Math.max(citationCount ?? 0, row.cited_by_count);
		}
		upstreamKw.push(...extractOpenAlexUpstreamKeywords(row));
		doi = doi || cleanDoi(row.doi);
		arxivId = arxivId || extractArxivIdFromOpenAlex(row);
		const oaUrl = row.open_access?.oa_url?.trim() || "";
		const oaPdf =
			oaUrl && (/\.pdf(?:$|[?#])/i.test(oaUrl) || /\/pdf\//i.test(oaUrl))
				? oaUrl
				: undefined;
		pdfUrl = pdfUrl || row.primary_location?.pdf_url || oaPdf;
		volume = volume || row.biblio?.volume?.trim() || undefined;
		issue = issue || row.biblio?.issue?.trim() || undefined;
		pages = pages || formatPages(row.biblio?.first_page, row.biblio?.last_page);
		venueFull = venueFull || row.primary_location?.source?.display_name?.trim();
	};

	// Step 1: OpenAlex 0-credit singleton by DOI, OAI-PMH landing URL fallback, or title search
	const lookupDoi =
		doi ||
		(arxivId ? `10.48550/arxiv.${stripArxivVersion(arxivId)}` : undefined);
	if (lookupDoi) {
		try {
			const oa = await fetchJson<OpenAlexWork>(
				withOpenAlexApiKey(
					`https://api.openalex.org/works/doi:${encodeURIComponent(lookupDoi)}?select=${OPENALEX_SELECT}&mailto=${MAILTO}`,
				),
			);
			applyOpenAlex(oa);
		} catch {
			// Fall through to OAI-PMH / publisher / Semantic Scholar.
		}
	}
	if (
		arxivId &&
		(isPlaceholderAbstract(abstract, paper.sourceLabel) ||
			normalizePaperKeywords(upstreamKw).length === 0)
	) {
		const cleanAid = stripArxivVersion(arxivId);
		if (cleanAid) {
			try {
				const oaLanding = await fetchJson<{ results?: OpenAlexWork[] }>(
					withOpenAlexApiKey(
						`https://api.openalex.org/works?filter=${encodeURIComponent(`locations.landing_page_url:https://arxiv.org/abs/${cleanAid}`)}&per-page=3&select=${OPENALEX_SELECT}&mailto=${MAILTO}`,
					),
				);
				for (const m of oaLanding.results ?? []) {
					applyOpenAlex(m);
				}
			} catch {
				// Fall through.
			}
		}
	}
	if (
		!lookupDoi &&
		(isPlaceholderAbstract(abstract, paper.sourceLabel) ||
			citationCount === undefined ||
			normalizePaperKeywords(upstreamKw).length === 0)
	) {
		try {
			const oaSearch = await safeFetchJson<{ results?: OpenAlexWork[] }>(
				withOpenAlexApiKey(
					`https://api.openalex.org/works?search=${encodeURIComponent(paper.title)}&per-page=5&select=${OPENALEX_SELECT}&mailto=${MAILTO}`,
				),
			);
			const targetKey = normTitleKey(paper.title);
			let matchedExact = false;
			let bestFuzzyWork: OpenAlexWork | undefined;
			let bestFuzzyScore = 0;
			for (const m of oaSearch.results ?? []) {
				const mTitle = m.title ?? m.display_name ?? "";
				if (!mTitle) continue;
				if (normTitleKey(mTitle) === targetKey) {
					matchedExact = true;
					applyOpenAlex(m);
					continue;
				}
				if (
					typeof m.publication_year === "number" &&
					paper.year > 0 &&
					Math.abs(m.publication_year - paper.year) > 1
				) {
					continue;
				}
				const res = scoreCameraReadyCandidateMatch(
					paper.title,
					paper.authors,
					mTitle,
					extractOpenAlexAuthorNames(m),
				);
				if (res.matched && res.score > bestFuzzyScore) {
					bestFuzzyScore = res.score;
					bestFuzzyWork = m;
				}
			}
			if (!matchedExact && bestFuzzyWork) {
				applyOpenAlex(bestFuzzyWork);
			}
		} catch (err) {
			if (options?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
				throw err;
			}
			// Fall through.
		}
	}

	// Step 2: Direct publisher fallback when abstract or IEEE author keywords are still missing
	if (
		(isPlaceholderAbstract(abstract, paper.sourceLabel) ||
			upstreamKw.length === 0) &&
		doi?.toLowerCase().startsWith("10.1109/")
	) {
		try {
			const csdlRes = await fetchJson<{
				data?: {
					articleByDoi?: {
						abstract?: string | null;
						keywords?: string[] | null;
						pages?: string | null;
						volume?: string | null;
						issueNum?: string | null;
					} | null;
				};
			}>(
				`https://www.computer.org/csdl/api/v1/graphql?query=${encodeURIComponent(`{ articleByDoi(doi: "${doi}") { abstract keywords pages volume issueNum } }`)}`,
			);
			const art = csdlRes.data?.articleByDoi;
			if (art?.abstract) {
				const cleaned = decodeBasicHtmlEntities(
					art.abstract.replace(/<[^>]+>/g, " "),
				)
					.replace(/\s+/g, " ")
					.trim();
				if (!isPlaceholderAbstract(cleaned, paper.sourceLabel)) {
					abstract = cleaned;
				}
			}
			if (art?.keywords?.length) {
				upstreamKw.unshift(...art.keywords);
			}
			volume = volume || art?.volume || undefined;
			issue = issue || art?.issueNum || undefined;
			pages = pages || art?.pages || undefined;
		} catch {
			// Fall through.
		}
	}

	if (
		isPlaceholderAbstract(abstract, paper.sourceLabel) &&
		fetchText &&
		doi?.toLowerCase().startsWith("10.1007/")
	) {
		const spAbs = await fetchSpringerAbstract(doi, fetchText);
		if (!isPlaceholderAbstract(spAbs, paper.sourceLabel)) {
			abstract = spAbs;
		}
	}

	if (
		isPlaceholderAbstract(abstract, paper.sourceLabel) &&
		fetchText &&
		paper.coolPapersId
	) {
		try {
			const html = await fetchText(
				`https://papers.cool/venue/${encodeURIComponent(paper.coolPapersId)}`,
				"text/html,application/xhtml+xml",
			);
			const sumMatch =
				/<p[^>]+class=["'][^"']*summary[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(
					html,
				)?.[1];
			if (sumMatch) {
				const cleaned = decodeBasicHtmlEntities(
					sumMatch.replace(/<[^>]+>/g, " "),
				)
					.replace(/\s+/g, " ")
					.trim();
				if (!isPlaceholderAbstract(cleaned, paper.sourceLabel)) {
					abstract = cleaned;
				}
			}
			const metaPdf =
				/<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i.exec(
					html,
				)?.[1];
			if (metaPdf && !pdfUrl) {
				pdfUrl = metaPdf.trim();
			}
		} catch {
			// Fall through.
		}
	}

	// Step 3: Semantic Scholar single-paper lookup + arXiv Atom abstract recovery
	if (
		isPlaceholderAbstract(abstract, paper.sourceLabel) ||
		citationCount === undefined
	) {
		const s2Id = doi ? `DOI:${doi}` : arxivId ? `ARXIV:${arxivId}` : null;
		if (s2Id) {
			try {
				const s2 = await fetchJson<{
					abstract?: string | null;
					citationCount?: number | null;
					openAccessPdf?: { url?: string | null } | null;
					externalIds?: { ArXiv?: string | null; DOI?: string | null } | null;
				}>(
					`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(s2Id)}?fields=abstract,citationCount,externalIds,openAccessPdf`,
				);
				if (
					s2.abstract &&
					!isPlaceholderAbstract(s2.abstract, paper.sourceLabel)
				) {
					abstract = s2.abstract.trim();
				}
				if (typeof s2.citationCount === "number") {
					citationCount = Math.max(citationCount ?? 0, s2.citationCount);
				}
				arxivId = arxivId || s2.externalIds?.ArXiv?.trim() || undefined;
				pdfUrl = pdfUrl || s2.openAccessPdf?.url?.trim() || undefined;
			} catch {
				// Best-effort fallback.
			}
		} else if (isPlaceholderAbstract(abstract, paper.sourceLabel)) {
			try {
				const s2Search = await safeFetchJson<{
					data?: Array<{
						title?: string | null;
						abstract?: string | null;
						citationCount?: number | null;
						year?: number | null;
						authors?: Array<{ name?: string | null }> | null;
						openAccessPdf?: { url?: string | null } | null;
						externalIds?: { ArXiv?: string | null; DOI?: string | null } | null;
					}>;
				}>(
					`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(paper.title)}&limit=5&fields=title,abstract,citationCount,externalIds,openAccessPdf,authors,year`,
				);
				const targetKey = normTitleKey(paper.title);
				const candidates = s2Search.data ?? [];
				type S2SearchCand = NonNullable<typeof s2Search.data>[number];
				const exactMatches: S2SearchCand[] = [];
				let bestFuzzy: S2SearchCand | undefined;
				let bestFuzzyScore = 0;
				for (const cand of candidates) {
					const cTitle = cand.title ?? "";
					if (!cTitle) continue;
					if (normTitleKey(cTitle) === targetKey) {
						exactMatches.push(cand);
						continue;
					}
					if (
						typeof cand.year === "number" &&
						paper.year > 0 &&
						Math.abs(cand.year - paper.year) > 1
					) {
						continue;
					}
					const candAuthors = (cand.authors ?? [])
						.map((a) => a.name ?? "")
						.filter(Boolean);
					const res = scoreCameraReadyCandidateMatch(
						paper.title,
						paper.authors,
						cTitle,
						candAuthors,
					);
					if (res.matched && res.score > bestFuzzyScore) {
						bestFuzzyScore = res.score;
						bestFuzzy = cand;
					}
				}
				const toApply =
					exactMatches.length > 0 ? exactMatches : bestFuzzy ? [bestFuzzy] : [];
				for (const cand of toApply) {
					if (
						cand.abstract &&
						!isPlaceholderAbstract(cand.abstract, paper.sourceLabel)
					) {
						abstract = cand.abstract.trim();
					}
					if (typeof cand.citationCount === "number") {
						citationCount = Math.max(citationCount ?? 0, cand.citationCount);
					}
					doi = doi || cleanDoi(cand.externalIds?.DOI);
					arxivId = arxivId || cand.externalIds?.ArXiv?.trim() || undefined;
					pdfUrl = pdfUrl || cand.openAccessPdf?.url?.trim() || undefined;
				}
			} catch (err) {
				if (options?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
					throw err;
				}
				// Best-effort fallback completed.
			}
		}
	}

	if (
		isPlaceholderAbstract(abstract, paper.sourceLabel) &&
		arxivId &&
		fetchText
	) {
		const cleanAid = stripArxivVersion(arxivId);
		if (cleanAid) {
			try {
				const atomXml = await fetchText(
					`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanAid)}&max_results=1`,
					"application/atom+xml,text/xml,*/*",
				);
				const sumRaw =
					/<entry\b[\s\S]*?<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(
						atomXml,
					)?.[1];
				if (sumRaw) {
					const atomAbs = decodeBasicHtmlEntities(sumRaw)
						.replace(/\s+/g, " ")
						.trim();
					if (!isPlaceholderAbstract(atomAbs, paper.sourceLabel)) {
						abstract = atomAbs;
					}
				}
			} catch {
				// Best-effort fallback.
			}
		}
	}

	// Step 4: Public `arxiv.org/html/<id>` author LaTeX `\keywords{...}` / `Index Terms` fallback (Venue preprints only)
	if (
		paper.sourceType !== "arxiv" &&
		normalizePaperKeywords(upstreamKw).length === 0 &&
		arxivId &&
		fetchText
	) {
		const cleanAid = stripArxivVersion(arxivId);
		if (cleanAid) {
			try {
				const html = await fetchText(
					`https://arxiv.org/html/${encodeURIComponent(cleanAid)}`,
					"text/html,application/xhtml+xml",
				);
				const htmlKws = extractArxivHtmlKeywords(html);
				if (htmlKws.length > 0) {
					upstreamKw.push(...htmlKws);
				}
			} catch {
				// Best-effort fallback: paper may not have an HTML rendering or author `\keywords`.
			}
		}
	}

	const finalAbstract = isPlaceholderAbstract(abstract, paper.sourceLabel)
		? ""
		: abstract;

	// Step 5: Keyword LLM fallback when any paper (arXiv or Venue) still has zero keywords
	if (normalizePaperKeywords(upstreamKw).length === 0) {
		try {
			const extracted = await extractKeywordsWithKeywordLlmBatch(
				[{ id: paper.id, title: paper.title, abstract: finalAbstract }],
				{
					fetchFn: options?.keywordLlmFetch,
					signal: options?.signal,
				},
			);
			const llmKws = extracted.get(paper.id);
			if (llmKws?.length) {
				upstreamKw.push(...llmKws);
			}
		} catch (err) {
			if (options?.signal?.aborted || isBackgroundTaskCancelledError(err)) {
				throw err;
			}
			// Best-effort fallback when Keyword LLM is unconfigured or rate-limited.
		}
	}

	return {
		...paper,
		abstract: finalAbstract,
		doi,
		arxivId,
		pdfUrl:
			pdfUrl || (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined),
		volume,
		issue,
		pages,
		venueFull,
		citationCount: citationCount ?? 0,
		keywords: normalizePaperKeywords(upstreamKw),
	};
}
