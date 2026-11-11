/**
 * Plaza — Paper Collection venue taxonomy (28 DBLP 2026 venues),
 * shared types, IndexedDB pool persistence, and complete abstract / keyword / citation enrichment.
 */

export type CollectionSourceType = "arxiv" | "venue";
export type VenueKind = "conference" | "journal";
export type VenueDomain = "PL/SE" | "CR" | "AI";
export type VenueCcfRank = "CCF-A" | "CCF-B";

export const CURRENT_VENUE_SYNC_VERSION = 5;

export type VenueConfig = {
	id: string;
	/** Short display name, e.g. `ASE 2026`, `ISSTA 2026`, `TOSEM 2026`. */
	name: string;
	/** DBLP venue stream page URL, e.g. `https://dblp.uni-trier.de/db/conf/issta/`. */
	url: string;
	/** Extraction mode: deterministic DBLP + metadata (`auto`) or Agent-assisted (`agent`). */
	mode: "auto" | "agent";
	kind?: VenueKind;
	domain?: VenueDomain;
	ccfRank?: VenueCcfRank;
	dblpStream?: string;
	lastFetchedAt?: string | null;
	/** Newest `publishedAt` ISO timestamp observed for incremental diffing. */
	latestPublishedAt?: string | null;
	/** Upstream total paper count observed at last sync for watermark diffing. */
	remoteTotalCount?: number;
	/** Schema / pagination version so older truncated caches upgrade once automatically. */
	syncVersion?: number;
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
};

export type FetchTextFn = (url: string, accept?: string) => Promise<string>;
export type FetchJsonFn = <T = unknown>(url: string) => Promise<T>;

export type DblpVenueSpec = {
	id: string;
	name: string;
	url: string;
	kind: VenueKind;
	domain: VenueDomain;
	ccfRank: VenueCcfRank;
	dblpStream: string;
	openAlexSourceIds?: readonly string[];
	pacmIssue?: string;
	issn?: string;
	doiPrefixFilter?: string;
	/** Multiple exact proceedings DOI prefixes queried via `doi_starts_with:p1|p2` in OpenAlex. */
	doiPrefixFilters?: readonly string[];
	/** Companion / workshop / wrong-year DOI prefixes excluded from main conference portals. */
	excludeDoiPrefixes?: readonly string[];
	/** Optional case-insensitive whitelist of DBLP `publishedIn` labels to exclude co-located workshops. */
	dblpAllowedPubIn?: readonly string[];
	/** `papers.cool/venue/{slug}` identifier carrying complete abstracts, keywords, and direct PDF links. */
	coolPapersVenueSlug?: string;
	/** Official static accepted-papers / schedule page when publisher DOIs are not yet minted. */
	officialProgramUrl?: string;
	/** Semantic Scholar `/paper/search/bulk?venue=...` canonical venue name(s). */
	s2VenueNames?: readonly string[];
	/** Exact accepted-venue aliases matched in `<arxiv:comment>` / `<arxiv:journal_ref>`. */
	arxivVenueAliases?: readonly string[];
	/** Optional Crossref `container-title` substring guard when querying Crossref. */
	crossrefContainerMatch?: string;
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
export const DBLP_2026_VENUE_SPECS: readonly DblpVenueSpec[] = [
	// 1a. PL/SE Conferences — CCF-A
	{
		id: "ase-2026",
		name: "ASE 2026",
		url: "https://dblp.uni-trier.de/db/conf/kbse/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/kbse",
		openAlexSourceIds: ["S4363608212"],
		doiPrefixFilters: ["10.1145/3832783"],
		dblpAllowedPubIn: ["ASE"],
		s2VenueNames: ["ASE"],
		arxivVenueAliases: ["ASE 2026"],
	},
	{
		id: "icse-2026",
		name: "ICSE 2026",
		url: "https://dblp.uni-trier.de/db/conf/icse/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/icse",
		openAlexSourceIds: ["S4210203175", "S7407089274"],
		doiPrefixFilters: [
			"10.1145/3744916",
			"10.1145/3786583",
			"10.1145/3786582",
			"10.1145/3786581",
			"10.1145/3786580",
		],
		excludeDoiPrefixes: ["10.1145/3774748"],
		dblpAllowedPubIn: [
			"ICSE",
			"ICSE-SEIP",
			"ICSE-NIER",
			"ICSE-SEIS",
			"ICSE-SEET",
		],
		s2VenueNames: ["ICSE"],
		arxivVenueAliases: ["ICSE 2026"],
	},
	{
		id: "issta-2026",
		name: "ISSTA 2026",
		url: "https://dblp.uni-trier.de/db/conf/issta/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/issta",
		openAlexSourceIds: ["S4404663975", "S7407085879"],
		pacmIssue: "ISSTA",
		issn: "2994-970X",
		dblpAllowedPubIn: ["ISSTA", "Proc. ACM Softw. Eng."],
		s2VenueNames: ["ISSTA"],
		arxivVenueAliases: ["ISSTA 2026"],
	},
	{
		id: "fse-2026",
		name: "FSE 2026",
		url: "https://dblp.uni-trier.de/db/conf/sigsoft/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/sigsoft",
		openAlexSourceIds: ["S4404663975"],
		pacmIssue: "FSE",
		issn: "2994-970X",
		dblpAllowedPubIn: ["Proc. ACM Softw. Eng.", "ESEC/SIGSOFT FSE", "FSE"],
		s2VenueNames: ["FSE"],
		arxivVenueAliases: ["FSE 2026", "ESEC/FSE 2026"],
	},
	{
		id: "pldi-2026",
		name: "PLDI 2026",
		url: "https://dblp.uni-trier.de/db/conf/pldi/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/pldi",
		openAlexSourceIds: ["S4210216081"],
		pacmIssue: "PLDI",
		issn: "2475-1421",
		dblpAllowedPubIn: ["Proc. ACM Program. Lang.", "PLDI"],
		s2VenueNames: ["PLDI"],
		arxivVenueAliases: ["PLDI 2026"],
	},
	{
		id: "popl-2026",
		name: "POPL 2026",
		url: "https://dblp.uni-trier.de/db/conf/popl/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/popl",
		openAlexSourceIds: ["S4210216081", "S7407088133"],
		pacmIssue: "POPL",
		issn: "2475-1421",
		dblpAllowedPubIn: ["Proc. ACM Program. Lang.", "POPL"],
		s2VenueNames: ["POPL"],
		arxivVenueAliases: ["POPL 2026"],
	},
	{
		id: "oopsla-2026",
		name: "OOPSLA 2026",
		url: "https://dblp.uni-trier.de/db/conf/oopsla/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/oopsla",
		openAlexSourceIds: ["S4210216081"],
		pacmIssue: "OOPSLA",
		issn: "2475-1421",
		dblpAllowedPubIn: ["Proc. ACM Program. Lang.", "OOPSLA"],
		s2VenueNames: ["OOPSLA"],
		arxivVenueAliases: ["OOPSLA 2026"],
	},

	// 1a. PL/SE Conferences — CCF-B
	{
		id: "ecoop-2026",
		name: "ECOOP 2026",
		url: "https://dblp.uni-trier.de/db/conf/ecoop/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		dblpStream: "streams/conf/ecoop",
		doiPrefixFilter: "10.4230/lipics.ecoop.2026",
		dblpAllowedPubIn: ["ECOOP"],
		s2VenueNames: ["ECOOP"],
		arxivVenueAliases: ["ECOOP 2026"],
	},
	{
		id: "icpc-2026",
		name: "ICPC 2026",
		url: "https://dblp.uni-trier.de/db/conf/iwpc/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		dblpStream: "streams/conf/iwpc",
		openAlexSourceIds: ["S7407088527", "S4306419777"],
		doiPrefixFilters: ["10.1145/3794763"],
		dblpAllowedPubIn: ["ICPC"],
		s2VenueNames: ["ICPC"],
		arxivVenueAliases: ["ICPC 2026"],
	},
	{
		id: "re-2026",
		name: "RE 2026",
		url: "https://dblp.uni-trier.de/db/conf/re/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		dblpStream: "streams/conf/re",
		openAlexSourceIds: ["S7407086818"],
		doiPrefixFilters: ["10.1109/re68928.2026"],
		excludeDoiPrefixes: ["10.1109/rew"],
		dblpAllowedPubIn: ["RE"],
		csdlIdPrefix: "re",
		arxivVenueAliases: ["RE 2026"],
	},
	{
		id: "saner-2026",
		name: "SANER 2026",
		url: "https://dblp.uni-trier.de/db/conf/wcre/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		dblpStream: "streams/conf/wcre",
		openAlexSourceIds: ["S4363608226"],
		doiPrefixFilters: ["10.1109/saner67736.2026"],
		excludeDoiPrefixes: ["10.1109/saner-c"],
		dblpAllowedPubIn: ["SANER"],
		csdlIdPrefix: "saner",
		s2VenueNames: ["SANER"],
		arxivVenueAliases: ["SANER 2026"],
	},
	{
		id: "icsme-2026",
		name: "ICSME 2026",
		url: "https://dblp.uni-trier.de/db/conf/icsm/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		dblpStream: "streams/conf/icsm",
		openAlexSourceIds: ["S4210174939"],
		doiPrefixFilters: ["10.1109/icsme67971.2026"],
		dblpAllowedPubIn: ["ICSME"],
		csdlIdPrefix: "icsme",
		s2VenueNames: ["ICSME"],
		arxivVenueAliases: ["ICSME 2026"],
	},
	{
		id: "sas-2026",
		name: "SAS 2026",
		url: "https://dblp.uni-trier.de/db/conf/sas/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		dblpStream: "streams/conf/sas",
		openAlexSourceIds: ["S4306420942"],
		doiPrefixFilters: ["10.1007/978-3-032-40374-2"],
		excludeDoiPrefixes: ["10.1007/978-3-032-07106-4"],
		crossrefIsbns: ["9783032403735", "9783032403742"],
		dblpAllowedPubIn: ["SAS"],
		arxivVenueAliases: ["SAS 2026"],
	},
	{
		id: "esem-2026",
		name: "ESEM 2026",
		url: "https://dblp.uni-trier.de/db/conf/esem/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		dblpStream: "streams/conf/esem",
		openAlexSourceIds: ["S4210197744"],
		doiPrefixFilter: "10.4230/lipics.esem.2026",
		issn: "1949-3770",
		dblpAllowedPubIn: ["ESEM"],
		s2VenueNames: ["ESEM"],
		arxivVenueAliases: ["ESEM 2026"],
	},
	{
		id: "issre-2026",
		name: "ISSRE 2026",
		url: "https://dblp.uni-trier.de/db/conf/issre/",
		kind: "conference",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		dblpStream: "streams/conf/issre",
		openAlexSourceIds: ["S4210220341"],
		officialProgramUrl:
			"https://cyprusconferences.org/issre2026/accepted-papers/",
		dblpAllowedPubIn: ["ISSRE"],
		s2VenueNames: ["ISSRE"],
		arxivVenueAliases: ["ISSRE 2026"],
	},

	// 1b. PL/SE Journals — CCF-A & CCF-B
	{
		id: "tse-2026",
		name: "TSE 2026",
		url: "https://dblp.uni-trier.de/db/journals/tse/",
		kind: "journal",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		dblpStream: "streams/journals/tse",
		openAlexSourceIds: ["S8351582"],
		issn: "0098-5589",
		csdlIdPrefix: "ts",
		arxivVenueAliases: ["IEEE TSE 2026"],
	},
	{
		id: "tosem-2026",
		name: "TOSEM 2026",
		url: "https://dblp.uni-trier.de/db/journals/tosem/",
		kind: "journal",
		domain: "PL/SE",
		ccfRank: "CCF-A",
		dblpStream: "streams/journals/tosem",
		openAlexSourceIds: ["S142627899"],
		issn: "1049-331X",
		arxivVenueAliases: ["TOSEM 2026", "ACM TOSEM 2026"],
	},
	{
		id: "ase-journal-2026",
		name: "ASE (J) 2026",
		url: "https://dblp.uni-trier.de/db/journals/ase/",
		kind: "journal",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		dblpStream: "streams/journals/ase",
		openAlexSourceIds: ["S4210177399"],
		issn: "1573-7535",
	},
	{
		id: "ese-2026",
		name: "ESE 2026",
		url: "https://dblp.uni-trier.de/db/journals/ese/",
		kind: "journal",
		domain: "PL/SE",
		ccfRank: "CCF-B",
		dblpStream: "streams/journals/ese",
		openAlexSourceIds: ["S109852484"],
		issn: "1382-3256",
		arxivVenueAliases: ["EMSE 2026"],
	},

	// 2. CR Conferences — CCF-A
	{
		id: "ccs-2026",
		name: "CCS 2026",
		url: "https://dblp.uni-trier.de/db/conf/ccs/",
		kind: "conference",
		domain: "CR",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/ccs",
		openAlexSourceIds: ["S4393917527"],
		officialProgramUrl:
			"https://www.sigsac.org/ccs/CCS2026/program/schedule.html",
		dblpAllowedPubIn: ["CCS"],
		s2VenueNames: ["CCS"],
		arxivVenueAliases: ["CCS 2026", "ACM CCS 2026"],
	},
	{
		id: "sp-2026",
		name: "S&P 2026",
		url: "https://dblp.uni-trier.de/db/conf/sp/",
		kind: "conference",
		domain: "CR",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/sp",
		openAlexSourceIds: ["S4210233669"],
		doiPrefixFilters: ["10.1109/sp63933.2026"],
		excludeDoiPrefixes: ["10.1109/spw"],
		dblpAllowedPubIn: ["SP", "IEEE Symposium on Security and Privacy"],
		csdlIdPrefix: "sp",
		arxivVenueAliases: ["IEEE S&P 2026", "Oakland 2026"],
	},
	{
		id: "usenix-sec-2026",
		name: "USENIX Security 2026",
		url: "https://dblp.uni-trier.de/db/conf/uss/",
		kind: "conference",
		domain: "CR",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/uss",
		openAlexSourceIds: ["S4306421123"],
		coolPapersVenueSlug: "USENIX-Sec.2026",
		dblpAllowedPubIn: ["USENIX Security Symposium"],
		s2VenueNames: ["USENIX Security Symposium", "USENIX Security"],
		arxivVenueAliases: ["USENIX Security 2026"],
	},
	{
		id: "ndss-2026",
		name: "NDSS 2026",
		url: "https://dblp.uni-trier.de/db/conf/ndss/",
		kind: "conference",
		domain: "CR",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/ndss",
		openAlexSourceIds: ["S4306420590"],
		coolPapersVenueSlug: "NDSS.2026",
		dblpAllowedPubIn: ["NDSS"],
		s2VenueNames: ["NDSS"],
		arxivVenueAliases: ["NDSS 2026"],
	},

	// 3. AI Conferences — CCF-A
	{
		id: "aaai-2026",
		name: "AAAI 2026",
		url: "https://dblp.uni-trier.de/db/conf/aaai/",
		kind: "conference",
		domain: "AI",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/aaai",
		openAlexSourceIds: ["S4210191458"],
		coolPapersVenueSlug: "AAAI.2026",
		dblpAllowedPubIn: ["AAAI"],
		issn: "2374-3468",
		s2VenueNames: ["AAAI"],
		arxivVenueAliases: ["AAAI 2026"],
	},
	{
		id: "neurips-2026",
		name: "NeurIPS 2026",
		url: "https://dblp.uni-trier.de/db/conf/nips/",
		kind: "conference",
		domain: "AI",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/nips",
		openAlexSourceIds: ["S4363606243"],
		coolPapersVenueSlug: "NeurIPS.2026",
		dblpAllowedPubIn: ["NeurIPS"],
		s2VenueNames: ["NeurIPS", "Neural Information Processing Systems"],
		arxivVenueAliases: ["NeurIPS 2026"],
	},
	{
		id: "acl-2026",
		name: "ACL 2026",
		url: "https://dblp.uni-trier.de/db/conf/acl/",
		kind: "conference",
		domain: "AI",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/acl",
		openAlexSourceIds: ["S4393915740"],
		coolPapersVenueSlug: "ACL.2026",
		crossrefContainerMatch: "Association for Computational Linguistics",
		s2VenueNames: ["ACL"],
		arxivVenueAliases: ["ACL 2026", "Findings of ACL 2026"],
	},
	{
		id: "iclr-2026",
		name: "ICLR 2026",
		url: "https://dblp.uni-trier.de/db/conf/iclr/",
		kind: "conference",
		domain: "AI",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/iclr",
		openAlexSourceIds: ["S4306419637"],
		coolPapersVenueSlug: "ICLR.2026",
		dblpAllowedPubIn: ["ICLR"],
		s2VenueNames: [
			"ICLR",
			"International Conference on Learning Representations",
		],
		arxivVenueAliases: ["ICLR 2026"],
	},
	{
		id: "icml-2026",
		name: "ICML 2026",
		url: "https://dblp.uni-trier.de/db/conf/icml/",
		kind: "conference",
		domain: "AI",
		ccfRank: "CCF-A",
		dblpStream: "streams/conf/icml",
		openAlexSourceIds: ["S4306419644"],
		coolPapersVenueSlug: "ICML.2026",
		dblpAllowedPubIn: ["ICML"],
		s2VenueNames: ["ICML", "International Conference on Machine Learning"],
		arxivVenueAliases: ["ICML 2026"],
	},
];

export const VENUE_SPEC_BY_ID = new Map<string, DblpVenueSpec>(
	DBLP_2026_VENUE_SPECS.map((s) => [s.id, s]),
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
	return /^(front\s*matter|back\s*matter|title page|copyright(?:\s+page)?|table of contents|contents\b|message from|welcome (?:from|message|to\b)|foreword|preface|proceedings of\b|companion proceedings\b|adjunct proceedings\b|extended abstracts of\b|conference organization|program committee|organizing committee|artifact evaluation committee|steering committee|external reviewers|additional reviewers|list of reviewers|reviewers?\b|author index|subject index|index of authors|sponsors?\b|corporate sponsors?\b|session details\s*:|keynote|panel:|tutorial:|editorial)\b/i.test(
		t,
	);
}

/** Reject co-located workshop, companion, or doctoral symposium sub-venues on main conference portals. */
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
	return /\b(workshops?|companion|adjunct|doctoral\s+symposium|student\s+research\s+competition|posters?\s+and\s+(?:tool\s+)?demos?|fast\s+abstracts?)\b/i.test(
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

const DOMAIN_KEYWORD_DICTIONARY: readonly [RegExp, string][] = [
	[/\bllm\s+agents?\b|\bagentic\b/i, "LLM Agent"],
	[/\blarge\s+language\s+models?\b|\bllms?\b/i, "Large Language Model"],
	[/\bmulti-agent\b/i, "Multi-Agent"],
	[/\bfuzz(?:ing|er|ers)\b/i, "Fuzzing"],
	[/\bstatic\s+analysis\b/i, "Static Analysis"],
	[/\bdynamic\s+analysis\b/i, "Dynamic Analysis"],
	[/\bsymbolic\s+execution\b/i, "Symbolic Execution"],
	[/\bprogram\s+repair\b|\bapr\b/i, "Program Repair"],
	[/\bvulnerabilit(?:y|ies)\b/i, "Vulnerability Detection"],
	[/\bformal\s+verification\b/i, "Formal Verification"],
	[/\bsmart\s+contracts?\b/i, "Smart Contract"],
	[/\bcode\s+generation\b/i, "Code Generation"],
	[/\bcode\s+translation\b|\bc-to-rust\b/i, "Code Translation"],
	[/\bcompiler(?:s|\s+testing|\s+bugs?)?\b/i, "Compiler"],
	[/\btype\s+systems?\b|\btyping\b/i, "Type System"],
	[/\babstract\s+interpretation\b/i, "Abstract Interpretation"],
	[/\bmodel\s+checking\b/i, "Model Checking"],
	[/\bmutation\s+testing\b|\bmutation\s+analysis\b/i, "Mutation Testing"],
	[/\bunit\s+test(?:s|ing)?\b|\btest\s+generation\b/i, "Test Generation"],
	[/\bfault\s+localization\b/i, "Fault Localization"],
	[/\bcode\s+review\b/i, "Code Review"],
	[/\bdecompil(?:ation|er)\b|\bbinary\s+analysis\b/i, "Binary Analysis"],
	[/\bmemory\s+safety\b|\buse-after-free\b/i, "Memory Safety"],
	[/\brust\b/i, "Rust"],
	[/\bwebassembly\b|\bwasm\b/i, "WebAssembly"],
	[/\bretrieval-augmented\b|\brag\b/i, "RAG"],
	[/\bprompt\s+injection\b/i, "Prompt Injection"],
	[/\bjailbreak(?:ing)?\b/i, "Jailbreak"],
	[/\bbackdoor\b|\bdata\s+poisoning\b/i, "Backdoor Attack"],
	[/\bdifferential\s+privacy\b/i, "Differential Privacy"],
	[/\bzero-knowledge\b|\bzkp\b/i, "Zero-Knowledge Proof"],
	[/\bpost-quantum\b|\bcryptograph(?:y|ic)\b/i, "Cryptography"],
	[/\bside-channel\b/i, "Side-Channel"],
	[/\bmalware\b/i, "Malware Analysis"],
	[/\breinforcement\s+learning\b|\brlhf\b/i, "Reinforcement Learning"],
	[/\bchain-of-thought\b|\breasoning\b/i, "Reasoning"],
	[/\bbenchmark(?:s|ing)?\b|\bswe-bench\b/i, "Benchmark"],
	[/\btransformer(?:s)?\b|\battention\b/i, "Transformer"],
	[/\bmultimodal\b|\bvision-language\b/i, "Multimodal"],
	[/\bhallucination(?:s)?\b/i, "Hallucination"],
];

/**
 * Normalize upstream keywords (OpenAlex / Crossref / S2) and supplement with
 * deterministic technical keyphrases from title + abstract so every paper has keywords.
 */
export function derivePaperKeywords(
	title: string,
	abstract: string,
	categories: readonly string[],
	upstreamKeywords?: readonly string[],
): string[] {
	const result: string[] = [];
	const seen = new Set<string>();

	const addKw = (raw: string) => {
		const cleaned = raw.replace(/\s+/g, " ").trim();
		if (cleaned.length < 2 || cleaned.length > 48) return;
		const key = cleaned.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		result.push(cleaned);
	};

	if (upstreamKeywords) {
		for (const kw of upstreamKeywords) {
			addKw(kw);
			if (result.length >= 8) return result;
		}
	}

	const hay = `${title} ${abstract}`;
	for (const [pattern, label] of DOMAIN_KEYWORD_DICTIONARY) {
		if (pattern.test(hay)) {
			addKw(label);
			if (result.length >= 8) return result;
		}
	}

	// Extract salient capitalized / hyphenated technical terms from title if still sparse
	if (result.length < 4) {
		const titleParts = title
			.replace(/[:?—–()[\]]/g, " ")
			.split(/\s+/)
			.filter((w) => /^[A-Z][A-Za-z0-9-]{2,20}$/.test(w))
			.filter(
				(w) =>
					!/^(The|And|For|With|Via|From|Into|Over|Under|Toward|Towards|Beyond|Using|Based|Study|Empirical|Automated|Enhancing|Learning|Large|Model|Models|System|Systems|Framework|Approach|Analysis)$/.test(
						w,
					),
			);
		for (const part of titleParts.slice(0, 3)) {
			addKw(part);
		}
	}

	if (result.length === 0) {
		for (const cat of categories) {
			addKw(ARXIV_CATEGORY_SUBTITLES[cat] ?? cat);
			if (result.length >= 3) break;
		}
	}

	return result;
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
		lower.includes("/db/journals/tse") ||
		lower.includes("/db/journals/tosem") ||
		lower.includes("/db/journals/ase") ||
		lower.includes("/db/journals/ese") ||
		/\b(tosem|tse|ese|journal|transactions)\b/.test(lower)
	) {
		return "journal";
	}
	return "conference";
}

// ─── IndexedDB Pool Persistence (for large 2026-Now preloaded pools) ───

const IDB_NAME = "agentero_plaza_collection_v2";
const IDB_STORE = "pool";
const IDB_KEY = "items";

function openPoolDb(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === "undefined") return Promise.resolve(null);
	return new Promise((resolve) => {
		try {
			const req = indexedDB.open(IDB_NAME, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(IDB_STORE)) {
					db.createObjectStore(IDB_STORE);
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

export async function saveItemsToIndexedDb(
	items: CollectionPaperItem[],
): Promise<void> {
	const db = await openPoolDb();
	if (!db) return;
	await new Promise<void>((resolve) => {
		try {
			const tx = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).put(items, IDB_KEY);
			tx.oncomplete = () => {
				db.close();
				resolve();
			};
			tx.onerror = () => {
				db.close();
				resolve();
			};
		} catch {
			db.close();
			resolve();
		}
	});
}

export async function loadItemsFromIndexedDb(): Promise<
	CollectionPaperItem[] | null
> {
	const db = await openPoolDb();
	if (!db) return null;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(IDB_STORE, "readonly");
			const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
			req.onsuccess = () => {
				db.close();
				resolve(Array.isArray(req.result) ? req.result : null);
			};
			req.onerror = () => {
				db.close();
				resolve(null);
			};
		} catch {
			db.close();
			resolve(null);
		}
	});
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
	keywords?: Array<{ display_name?: string | null }> | null;
	topics?: Array<{ display_name?: string | null }> | null;
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
	open_access?: {
		is_oa?: boolean | null;
		oa_url?: string | null;
	} | null;
	authorships?: Array<{
		author?: { display_name?: string | null } | null;
	}> | null;
};

export const OPENALEX_SELECT =
	"id,type,title,publication_year,publication_date,doi,ids,cited_by_count,abstract_inverted_index,keywords,topics,biblio,primary_location,open_access,authorships";
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

function extractArxivIdFromOpenAlex(row: OpenAlexWork): string | undefined {
	const fromIds = row.ids?.arxiv ?? "";
	const m1 = /arxiv\.org\/abs\/(\d{4}\.\d{4,5})/i.exec(fromIds);
	if (m1?.[1]) return m1[1];
	const doi = cleanDoi(row.doi);
	const m2 = /^10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i.exec(doi ?? "");
	if (m2?.[1]) return m2[1];
	const landing = row.primary_location?.landing_page_url ?? "";
	const m3 = /arxiv\.org\/abs\/(\d{4}\.\d{4,5})/i.exec(landing);
	return m3?.[1] || undefined;
}

function normTitleKey(title: string): string {
	return title.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function extractOpenAlexUpstreamKeywords(row: OpenAlexWork): string[] {
	const out: string[] = [];
	for (const k of row.keywords ?? []) {
		if (k?.display_name) out.push(k.display_name);
	}
	for (const t of row.topics ?? []) {
		if (t?.display_name) out.push(t.display_name);
	}
	return out;
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

function matchesPacmIssue(row: OpenAlexWork, pacmIssue?: string): boolean {
	if (!pacmIssue) return true;
	const sourceId = row.primary_location?.source?.id ?? "";
	// Only filter by issue when coming from shared PACMSE / PACMPL journal streams
	if (!sourceId.endsWith("S4404663975") && !sourceId.endsWith("S4210216081")) {
		return true;
	}
	const issue = (row.biblio?.issue ?? "").trim().toUpperCase();
	if (!issue) return false;
	const target = pacmIssue.toUpperCase();
	return issue === target || issue.startsWith(target);
}

export function openAlexWorkToVenueItem(
	row: OpenAlexWork,
	venue: VenueConfig,
	spec: DblpVenueSpec | undefined,
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
	if (!matchesPacmIssue(row, spec?.pacmIssue)) return null;

	const year = row.publication_year ?? targetYear;
	if (year < targetYear) return null;

	const doi = cleanDoi(row.doi);
	if (isExcludedByDoiPrefix(doi, spec?.excludeDoiPrefixes)) {
		return null;
	}
	// Reject bare IEEE conference-volume root DOIs such as `10.1109/re68928.2026` (papers end in `.00xxx` or `.11xxxxxx`)
	if (doi && /^10\.1109\/[a-z0-9-]+\.\d{4}$/i.test(doi)) {
		return null;
	}

	const venueKind = spec?.kind ?? inferVenueKind(venue);
	const sourceId = row.primary_location?.source?.id ?? "";
	const sourceExplicitlyCurated = Boolean(
		(spec?.openAlexSourceIds?.some((sid) => sourceId.endsWith(sid)) ?? false) ||
			(doi &&
				[
					...(spec?.doiPrefixFilters ?? []),
					...(spec?.doiPrefixFilter ? [spec.doiPrefixFilter] : []),
				].some((prefix) => doi.toLowerCase().startsWith(prefix.toLowerCase()))),
	);
	const sourceDisplayName =
		row.primary_location?.source?.display_name?.trim() ?? "";
	if (
		venueKind === "conference" &&
		!sourceExplicitlyCurated &&
		sourceDisplayName &&
		isWorkshopOrCompanionVenue(sourceDisplayName)
	) {
		return null;
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
		sourceDisplayName && !isWorkshopOrCompanionVenue(sourceDisplayName)
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
		url:
			row.primary_location?.landing_page_url ||
			(doi ? `https://doi.org/${doi}` : venue.url),
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
		pages: formatPages(row.biblio?.first_page, row.biblio?.last_page),
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
	},
): Promise<{
	items: CollectionPaperItem[];
	remoteTotalCount?: number;
	hadSuccessfulResponse?: boolean;
}> {
	const spec = VENUE_SPEC_BY_ID.get(venue.id);
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
				out[idx] = item;
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
			if ((page - 1) * 200 >= filterTotal) break;
			attemptedRequests += 1;
			try {
				const oaUrl = `https://api.openalex.org/works?filter=${encodeURIComponent(filterExpr)}&sort=publication_date:desc&per-page=200&page=${page}&select=${OPENALEX_SELECT}&mailto=${MAILTO}`;
				const data = await fetchJson<{
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
				if (batch.length < 200) {
					break;
				}
			} catch {
				break;
			}
		}
	}

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

	if (crossrefFilters.length > 0) {
		const rawCrossrefPendingEnrich: CollectionPaperItem[] = [];
		const crMaxPages = Math.min(maxPages, 12);

		for (const crFilter of crossrefFilters) {
			let crCursor: string | null = "*";
			for (let page = 0; page < crMaxPages && crCursor; page++) {
				attemptedRequests += 1;
				try {
					// Note: Crossref rejects `sort=published` when combined with `cursor=` (HTTP 400).
					const crUrl: string = `https://api.crossref.org/works?filter=${crFilter}&rows=100&cursor=${encodeURIComponent(crCursor)}&mailto=${MAILTO}`;
					const crData = await fetchJson<{
						message?: {
							"total-results"?: number;
							"next-cursor"?: string;
							items?: Array<{
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
							}>;
						};
					}>(crUrl);
					succeededRequests += 1;

					if (
						page === 0 &&
						!sinceDate &&
						!spec?.pacmIssue &&
						typeof crData.message?.["total-results"] === "number"
					) {
						remoteTotalCount = Math.max(
							remoteTotalCount ?? 0,
							crData.message["total-results"],
						);
					}

					const rows = crData.message?.items ?? [];
					if (rows.length === 0) break;

					for (const row of rows) {
						const rowType = (row.type ?? "").toLowerCase();
						if (
							rowType === "book" ||
							rowType === "proceedings" ||
							rowType === "journal-issue" ||
							rowType === "journal-volume"
						) {
							continue;
						}
						const doi = cleanDoi(row.DOI);
						const title = (row.title?.[0] ?? "").replace(/\s+/g, " ").trim();
						if (!doi || !title || isFrontmatterTitle(title)) continue;
						if (isExcludedByDoiPrefix(doi, spec?.excludeDoiPrefixes)) continue;

						const containerTitle = (row["container-title"]?.[0] ?? "").trim();
						if (
							spec?.crossrefContainerMatch &&
							!containerTitle
								.toLowerCase()
								.includes(spec.crossrefContainerMatch.toLowerCase())
						) {
							continue;
						}
						if (
							spec?.kind === "conference" &&
							containerTitle &&
							isWorkshopOrCompanionVenue(containerTitle)
						) {
							continue;
						}

						if (spec?.pacmIssue) {
							const iss = (row.issue ?? "").trim().toUpperCase();
							if (!iss.startsWith(spec.pacmIssue.toUpperCase())) continue;
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
						if (y < year && !spec?.crossrefIsbns?.length) continue;
						const m = String(parts[1] ?? 1).padStart(2, "0");
						const d = String(parts[2] ?? 1).padStart(2, "0");
						const authors = (row.author ?? [])
							.map((a) => `${a.given ?? ""} ${a.family ?? ""}`.trim())
							.filter(Boolean);
						if (authors.length === 0) continue;

						const rawAbs = (row.abstract ?? "")
							.replace(/<[^>]+>/g, " ")
							.replace(/^abstract[:.\s-]*/i, "")
							.replace(/\s+/g, " ")
							.trim();
						const cleanAbs = isPlaceholderAbstract(rawAbs, venue.name)
							? ""
							: rawAbs;

						const categories = [
							venue.name,
							...(spec?.domain ? [spec.domain] : []),
							...(spec?.ccfRank ? [spec.ccfRank] : []),
						];
						const candidate: CollectionPaperItem = {
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
							venueKind: spec?.kind,
							venueDomain: spec?.domain,
							ccfRank: spec?.ccfRank,
							venueFull: containerTitle || venue.name,
							citationCount: Math.max(0, row["is-referenced-by-count"] ?? 0),
							keywords: derivePaperKeywords(
								title,
								cleanAbs,
								categories,
								row.subject,
							),
							volume: row.volume,
							issue: row.issue,
							pages: row.page,
						};

						if (cleanAbs) {
							pushUnique(candidate);
						} else {
							rawCrossrefPendingEnrich.push(candidate);
						}
					}

					const nextCrCursor = crData.message?.["next-cursor"] ?? null;
					if (!nextCrCursor || nextCrCursor === crCursor || rows.length < 100) {
						break;
					}
					crCursor = nextCrCursor;
				} catch {
					break;
				}
			}
		}

		if (rawCrossrefPendingEnrich.length > 0) {
			const enrichedCr = await enrichDblpItemsBatch(
				rawCrossrefPendingEnrich,
				venue,
				fetchJson,
				out,
			);
			for (const item of enrichedCr) {
				pushUnique(item);
			}
		}
	}

	return {
		items: out,
		remoteTotalCount,
		hadSuccessfulResponse: attemptedRequests === 0 || succeededRequests > 0,
	};
}

/**
 * Batch-enrich DBLP records with abstracts, citation counts, and keywords
 * via preloaded OpenAlex/Crossref items first, followed by OpenAlex DOI batches and title lookup.
 * Retains all valid non-frontmatter papers even when no public abstract is available.
 */
export async function enrichDblpItemsBatch(
	items: CollectionPaperItem[],
	venue: VenueConfig,
	fetchJson: FetchJsonFn,
	preloadedItems?: readonly CollectionPaperItem[],
): Promise<CollectionPaperItem[]> {
	if (items.length === 0) return [];

	const preloadedByDoi = new Map<string, CollectionPaperItem>();
	const preloadedByTitle = new Map<string, CollectionPaperItem>();
	if (preloadedItems && preloadedItems.length > 0) {
		for (const p of preloadedItems) {
			if (p.doi) preloadedByDoi.set(p.doi.toLowerCase(), p);
			const tk = normTitleKey(p.title);
			if (tk) {
				const prev = preloadedByTitle.get(tk);
				if (!prev || p.abstract.length > prev.abstract.length) {
					preloadedByTitle.set(tk, p);
				}
			}
		}
	}

	const byDoi = new Map<string, OpenAlexWork>();
	const doisToFetch = Array.from(
		new Set(
			items
				.map((i) => i.doi?.toLowerCase())
				.filter(
					(d): d is string =>
						Boolean(d) && !preloadedByDoi.get(d ?? "")?.abstract,
				),
		),
	);

	// Skip redundant OpenAlex DOI batch calls when `preloadedItems` already covered the DOIs
	const unmatchedDois = doisToFetch.filter((d) => !preloadedByDoi.has(d));
	let openAlexRateLimited = false;
	const CHUNK = 45;
	for (let i = 0; i < unmatchedDois.length; i += CHUNK) {
		const batch = unmatchedDois.slice(i, i + CHUNK);
		const filter = `doi:${batch.map((d) => `https://doi.org/${d}`).join("|")}`;
		try {
			const url = `https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&per-page=${CHUNK}&select=${OPENALEX_SELECT}&mailto=${MAILTO}`;
			const res = await fetchJson<{ error?: string; results?: OpenAlexWork[] }>(
				url,
			);
			if (res.error) {
				openAlexRateLimited = true;
				break;
			}
			for (const row of res.results ?? []) {
				const d = cleanDoi(row.doi)?.toLowerCase();
				if (d) byDoi.set(d, row);
			}
		} catch {
			openAlexRateLimited = true;
			break;
		}
	}

	// Batch title lookup in OpenAlex ONLY for genuinely DOI-less DBLP records (max 24 titles),
	// because OpenAlex bills `title.search:` at 100x the cost of `doi:` filter queries.
	const byTitle = new Map<string, OpenAlexWork>();
	const missingDoiTitles = openAlexRateLimited
		? []
		: items
				.filter((i) => {
					if (i.doi) return false;
					const tk = normTitleKey(i.title);
					return !(tk && preloadedByTitle.get(tk)?.abstract);
				})
				.map((i) => i.title)
				.slice(0, 24);
	const TITLE_CHUNK = 12;
	for (let i = 0; i < missingDoiTitles.length; i += TITLE_CHUNK) {
		const batch = missingDoiTitles
			.slice(i, i + TITLE_CHUNK)
			.map((t) =>
				t
					.replace(/["|:;,()[\]{}\\/]+/g, " ")
					.replace(/\s+/g, " ")
					.trim(),
			)
			.filter((t) => t.length >= 12);
		if (batch.length === 0) continue;
		const expr = batch.map((t) => `"${t}"`).join("|");
		try {
			const url = `https://api.openalex.org/works?filter=${encodeURIComponent(`title.search:${expr}`)}&per-page=50&select=${OPENALEX_SELECT}&mailto=${MAILTO}`;
			const res = await fetchJson<{ error?: string; results?: OpenAlexWork[] }>(
				url,
			);
			if (res.error) break;
			for (const row of res.results ?? []) {
				const rt = (row.title ?? row.display_name ?? "").trim();
				if (!rt || /^artifact release for\b/i.test(rt)) continue;
				const key = normTitleKey(rt);
				if (!key) continue;
				const prev = byTitle.get(key);
				const nextWords = Object.keys(row.abstract_inverted_index ?? {}).length;
				const prevWords = Object.keys(
					prev?.abstract_inverted_index ?? {},
				).length;
				if (!prev || nextWords > prevWords) {
					byTitle.set(key, row);
				}
			}
		} catch {
			break;
		}
	}

	const enriched: CollectionPaperItem[] = [];
	for (const item of items) {
		if (isFrontmatterTitle(item.title)) continue;
		const tKey = normTitleKey(item.title);
		const pre =
			(item.doi ? preloadedByDoi.get(item.doi.toLowerCase()) : undefined) ??
			(tKey ? preloadedByTitle.get(tKey) : undefined);
		const row =
			(item.doi ? byDoi.get(item.doi.toLowerCase()) : undefined) ??
			(tKey ? byTitle.get(tKey) : undefined);

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
				(venueFull && venueFull !== venue.name ? venueFull : undefined) ||
				(!isWorkshopOrCompanionVenue(rowSourceName)
					? rowSourceName
					: undefined) ||
				venueFull;
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
			venueFull,
			citationCount,
			volume,
			issue,
			pages,
			keywords: derivePaperKeywords(
				item.title,
				normalizedAbstract,
				item.categories,
				upstreamKw,
			),
		});
	}

	return enriched;
}

/**
 * Batch-enrich arXiv items with OpenAlex `cited_by_count` and upstream `keywords`
 * using `10.48550/arxiv.<id>` DOIs, while immediately populating `keywords` & `citationCount`.
 */
export async function enrichArxivItemsBatch(
	items: CollectionPaperItem[],
	fetchJson: FetchJsonFn,
	maxLookup = 180,
): Promise<CollectionPaperItem[]> {
	if (items.length === 0) return [];
	const withDefaults = items.map((item) => ({
		...item,
		citationCount: item.citationCount ?? 0,
		keywords:
			item.keywords && item.keywords.length > 0
				? item.keywords
				: derivePaperKeywords(item.title, item.abstract, item.categories),
	}));

	const candidates = withDefaults.filter((i) => i.arxivId).slice(0, maxLookup);
	const byArxiv = new Map<string, OpenAlexWork>();
	const CHUNK = 45;

	for (let i = 0; i < candidates.length; i += CHUNK) {
		const batch = candidates.slice(i, i + CHUNK);
		const filter = `doi:${batch.map((p) => `https://doi.org/10.48550/arxiv.${p.arxivId}`).join("|")}`;
		try {
			const url = `https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&per-page=${CHUNK}&select=doi,ids,cited_by_count,keywords,topics&mailto=${MAILTO}`;
			const res = await fetchJson<{ results?: OpenAlexWork[] }>(url);
			for (const row of res.results ?? []) {
				const aid = extractArxivIdFromOpenAlex(row);
				if (aid) byArxiv.set(aid.toLowerCase(), row);
			}
		} catch {
			// Best-effort citation & keyword enrichment.
		}
	}

	if (byArxiv.size === 0) return withDefaults;

	return withDefaults.map((item) => {
		const aid = item.arxivId?.toLowerCase();
		const row = aid ? byArxiv.get(aid) : undefined;
		if (!row) return item;
		const upstream = extractOpenAlexUpstreamKeywords(row);
		return {
			...item,
			doi:
				item.doi ||
				(item.arxivId ? `10.48550/arxiv.${item.arxivId}` : undefined),
			citationCount: Math.max(item.citationCount ?? 0, row.cited_by_count ?? 0),
			keywords: derivePaperKeywords(
				item.title,
				item.abstract,
				item.categories,
				upstream,
			),
		};
	});
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
): Promise<CollectionPaperItem[]> {
	const targets: number[] = [];
	for (let i = 0; i < items.length; i++) {
		const p = items[i];
		if (!p?.doi?.toLowerCase().startsWith("10.1007/")) continue;
		if (!isPlaceholderAbstract(p.abstract, p.sourceLabel)) continue;
		targets.push(i);
		if (targets.length >= maxItems) break;
	}
	if (targets.length === 0) return items;

	const result = [...items];
	const CONCURRENCY = 5;
	let cursor = 0;

	const worker = async () => {
		while (cursor < targets.length) {
			const targetIdx = targets[cursor++];
			if (targetIdx === undefined) break;
			const item = result[targetIdx];
			if (!item?.doi) continue;
			const abs = await fetchSpringerAbstract(item.doi, fetchText);
			if (abs && !isPlaceholderAbstract(abs, item.sourceLabel)) {
				result[targetIdx] = {
					...item,
					abstract: abs,
					keywords: derivePaperKeywords(
						item.title,
						abs,
						item.categories,
						item.keywords,
					),
				};
			}
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
 * (complete abstract, citation count, or keywords) was not yet populated.
 */
export async function enrichSinglePaperOnDemand(
	paper: CollectionPaperItem,
	fetchJson: FetchJsonFn,
	fetchText?: FetchTextFn,
): Promise<CollectionPaperItem> {
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

	const lookupDoi = doi || (arxivId ? `10.48550/arxiv.${arxivId}` : undefined);
	if (lookupDoi) {
		try {
			const oa = await fetchJson<OpenAlexWork>(
				`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(lookupDoi)}?select=${OPENALEX_SELECT}&mailto=${MAILTO}`,
			);
			applyOpenAlex(oa);
		} catch {
			// Fall through to title search / Semantic Scholar.
		}
	}

	if (
		isPlaceholderAbstract(abstract, paper.sourceLabel) ||
		citationCount === undefined
	) {
		try {
			const oaSearch = await fetchJson<{ results?: OpenAlexWork[] }>(
				`https://api.openalex.org/works?search=${encodeURIComponent(paper.title)}&per-page=5&select=${OPENALEX_SELECT}&mailto=${MAILTO}`,
			);
			const targetKey = normTitleKey(paper.title);
			const matches = (oaSearch.results ?? []).filter(
				(r) => normTitleKey(r.title ?? r.display_name ?? "") === targetKey,
			);
			if (matches.length > 0) {
				for (const m of matches) applyOpenAlex(m);
			} else if (oaSearch.results?.[0]) {
				applyOpenAlex(oaSearch.results[0]);
			}
		} catch {
			// Fall through to Crossref / Springer / Semantic Scholar.
		}
	}

	if (isPlaceholderAbstract(abstract, paper.sourceLabel) && doi) {
		try {
			const cr = await fetchJson<{
				message?: { abstract?: string; "is-referenced-by-count"?: number };
			}>(
				`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${MAILTO}`,
			);
			const crAbs = (cr.message?.abstract ?? "")
				.replace(/<[^>]+>/g, " ")
				.replace(/^abstract[:.\s-]*/i, "")
				.replace(/\s+/g, " ")
				.trim();
			if (!isPlaceholderAbstract(crAbs, paper.sourceLabel)) {
				abstract = crAbs;
			}
			if (typeof cr.message?.["is-referenced-by-count"] === "number") {
				citationCount = Math.max(
					citationCount ?? 0,
					cr.message["is-referenced-by-count"],
				);
			}
		} catch {
			// Fall through.
		}
	}

	if (
		isPlaceholderAbstract(abstract, paper.sourceLabel) &&
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
				upstreamKw.push(...art.keywords);
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

	if (
		isPlaceholderAbstract(abstract, paper.sourceLabel) ||
		citationCount === undefined
	) {
		try {
			const s2Id = doi ? `DOI:${doi}` : arxivId ? `ARXIV:${arxivId}` : null;
			if (s2Id) {
				const s2 = await fetchJson<{
					abstract?: string | null;
					citationCount?: number | null;
					externalIds?: { ArXiv?: string | null; DOI?: string | null } | null;
					s2FieldsOfStudy?: Array<{ category?: string | null }> | null;
				}>(
					`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(s2Id)}?fields=abstract,citationCount,externalIds,s2FieldsOfStudy`,
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
				for (const f of s2.s2FieldsOfStudy ?? []) {
					if (f?.category) upstreamKw.push(f.category);
				}
			}
		} catch {
			// Fall through to title search if needed.
		}
	}

	if (isPlaceholderAbstract(abstract, paper.sourceLabel)) {
		try {
			const s2Search = await fetchJson<{
				data?: Array<{
					title?: string | null;
					abstract?: string | null;
					citationCount?: number | null;
					externalIds?: { ArXiv?: string | null } | null;
				}>;
			}>(
				`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(paper.title)}&limit=3&fields=title,abstract,citationCount,externalIds`,
			);
			const targetKey = normTitleKey(paper.title);
			for (const cand of s2Search.data ?? []) {
				if (normTitleKey(cand.title ?? "") !== targetKey) continue;
				if (
					cand.abstract &&
					!isPlaceholderAbstract(cand.abstract, paper.sourceLabel)
				) {
					abstract = cand.abstract.trim();
				}
				if (typeof cand.citationCount === "number") {
					citationCount = Math.max(citationCount ?? 0, cand.citationCount);
				}
				arxivId = arxivId || cand.externalIds?.ArXiv?.trim() || undefined;
			}
		} catch {
			// Best-effort fallback completed.
		}
	}

	const finalAbstract = isPlaceholderAbstract(abstract, paper.sourceLabel)
		? ""
		: abstract;

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
		keywords: derivePaperKeywords(
			paper.title,
			finalAbstract,
			paper.categories,
			upstreamKw,
		),
	};
}
