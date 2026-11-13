/**
 * Plaza — `Paper Survey` citations, BibTeX / LaTeX export and report HTML.
 *
 * Citation metadata comes from the Library / Collection (resolved by the
 * store); this module only assigns stable keys, renders entries and rewrites
 * agent citation tokens. Pure functions, covered by `test/plaza-survey.test.ts`.
 */

import { parseBibEntries } from "@/lib/bibtex";
import {
	normalizeCiteIds,
	SURVEY_CITE_TOKEN_RE,
	SURVEY_REFERENCES_MARKER,
} from "@/lib/plaza/survey-parse";
import type {
	SurveyCitation,
	SurveyParagraphResult,
	SurveySentence,
} from "@/lib/plaza/survey-types";

/** Resolved metadata for one cited paper, before key assignment. */
export type SurveyCitationMeta = Omit<
	SurveyCitation,
	"key" | "index" | "bibtex"
> & {
	/** Existing key to keep when valid (Library `bibtex_key`). */
	preferredKey?: string | null;
	/** Authoritative upstream entry (Collection DBLP / publisher BibTeX). */
	upstreamBibtex?: string | null;
	entryType?: "article" | "inproceedings" | "misc";
	volume?: string | null;
	issue?: string | null;
	pages?: string | null;
};

// ─── Keys ───

const TITLE_STOPWORDS = new Set([
	"a",
	"an",
	"the",
	"on",
	"of",
	"for",
	"in",
	"to",
	"and",
	"with",
	"towards",
	"toward",
	"via",
	"from",
	"is",
	"are",
	"do",
	"does",
	"how",
	"what",
	"why",
	"when",
]);
const VALID_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_:.+/-]*$/;

function asciiFold(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/ß/g, "ss")
		.replace(/[øØ]/g, "o")
		.replace(/[łŁ]/g, "l")
		.toLowerCase();
}

function authorSurname(author: string): string {
	const trimmed = author.trim();
	if (!trimmed) return "";
	const surname = trimmed.includes(",")
		? trimmed.split(",")[0]
		: (trimmed.split(/\s+/).pop() ?? "");
	return asciiFold(surname).replace(/[^a-z0-9]/g, "");
}

/** `lastnameYearFirstword`, e.g. `vaswani2017attention`. */
export function makeCiteKey(meta: {
	authors: readonly string[];
	year?: number | null;
	title: string;
}): string {
	const surname = authorSurname(meta.authors[0] ?? "") || "anon";
	const year = meta.year && meta.year > 0 ? String(meta.year) : "nd";
	const word =
		asciiFold(meta.title)
			.replace(/[^a-z0-9\s-]/g, " ")
			.split(/[\s-]+/)
			.find((w) => w.length > 1 && !TITLE_STOPWORDS.has(w)) ?? "paper";
	return `${surname}${year}${word}`;
}

/** Assign unique keys in order; collisions get `a`, `b`, … suffixes. */
export function assignCiteKeys(
	items: readonly {
		preferredKey?: string | null;
		authors: readonly string[];
		year?: number | null;
		title: string;
	}[],
): string[] {
	const used = new Set<string>();
	return items.map((item) => {
		const preferred = item.preferredKey?.trim();
		const base =
			preferred && VALID_KEY_RE.test(preferred) ? preferred : makeCiteKey(item);
		let key = base;
		for (let n = 0; used.has(key.toLowerCase()); n++) {
			key =
				n < 26 ? `${base}${String.fromCharCode(97 + n)}` : `${base}${n - 25}`;
		}
		used.add(key.toLowerCase());
		return key;
	});
}

// ─── BibTeX ───

/** Placeholder for `\` while other specials are escaped (private-use char). */
const BACKSLASH_MARK = "\uE000";

function escapeTexSpecials(text: string): string {
	return text
		.replace(/\\/g, BACKSLASH_MARK)
		.replace(/([{}&%$#_])/g, "\\$1")
		.replace(/~/g, "\\textasciitilde{}")
		.replace(/\^/g, "\\textasciicircum{}")
		.replaceAll(BACKSLASH_MARK, "\\textbackslash{}");
}

/** Escape a BibTeX field value for `{…}` delimiters (LaTeX specials). */
export function escapeBibtex(value: string): string {
	return escapeTexSpecials(value.replace(/\s+/g, " ").trim());
}

/** URL / DOI fields: no LaTeX escaping, only unbalanced braces removed. */
function rawField(value: string): string {
	return value.replace(/[{}\s]/g, "");
}

/** Replace the key of an upstream entry; null when it does not parse. */
export function rekeyBibtex(raw: string, key: string): string | null {
	const entry = parseBibEntries(raw)[0];
	if (!entry?.fields.title) return null;
	const text = raw.slice(entry.from, entry.to);
	const rekeyed = text.replace(/^@(\w+)\s*([{(])\s*[^,]*,/, `@$1$2${key},`);
	return rekeyed === text && !text.includes(`${key},`) ? null : rekeyed;
}

function inferEntryType(
	meta: SurveyCitationMeta,
): "article" | "inproceedings" | "misc" {
	if (meta.entryType) return meta.entryType;
	const venue = meta.venue?.trim() ?? "";
	if (!venue || /^arxiv\b/i.test(venue) || /corr/i.test(venue)) return "misc";
	if (/journal|transactions|letters|review|magazine/i.test(venue)) {
		return "article";
	}
	return "inproceedings";
}

export function buildBibtexEntry(
	meta: SurveyCitationMeta,
	key: string,
): string {
	if (meta.upstreamBibtex?.trim()) {
		const rekeyed = rekeyBibtex(meta.upstreamBibtex, key);
		if (rekeyed) return rekeyed;
	}
	const type = inferEntryType(meta);
	const fields: [string, string][] = [
		["title", escapeBibtex(meta.title)],
		[
			"author",
			meta.authors.length > 0
				? meta.authors.map(escapeBibtex).join(" and ")
				: "Anonymous",
		],
	];
	if (type === "article" && meta.venue) {
		fields.push(["journal", escapeBibtex(meta.venue)]);
	} else if (type === "inproceedings" && meta.venue) {
		fields.push(["booktitle", escapeBibtex(meta.venue)]);
	}
	if (meta.year) fields.push(["year", String(meta.year)]);
	if (meta.volume) fields.push(["volume", escapeBibtex(meta.volume)]);
	if (meta.issue) fields.push(["number", escapeBibtex(meta.issue)]);
	if (meta.pages) {
		fields.push(["pages", escapeBibtex(meta.pages).replace(/\s*-+\s*/, "--")]);
	}
	if (meta.doi) fields.push(["doi", rawField(meta.doi)]);
	if (meta.arxivId) {
		fields.push(["eprint", rawField(meta.arxivId)]);
		fields.push(["archivePrefix", "arXiv"]);
	}
	if (meta.url) fields.push(["url", rawField(meta.url)]);
	const body = fields.map(([k, v]) => `  ${k} = {${v}}`).join(",\n");
	return `@${type}{${key},\n${body}\n}`;
}

/** Keys + display numbers + entries for metadata in first-citation order. */
export function buildCitations(
	metas: readonly SurveyCitationMeta[],
): SurveyCitation[] {
	const keys = assignCiteKeys(metas);
	return metas.map((meta, i) => {
		const {
			preferredKey: _preferredKey,
			upstreamBibtex: _upstreamBibtex,
			entryType: _entryType,
			volume: _volume,
			issue: _issue,
			pages: _pages,
			...rest
		} = meta;
		return {
			...rest,
			key: keys[i],
			index: i + 1,
			bibtex: buildBibtexEntry(meta, keys[i]),
		};
	});
}

// ─── LaTeX ───

/** Escape plain prose for LaTeX body text. */
export function escapeLatex(text: string): string {
	return escapeTexSpecials(text);
}

/** `text~\cite{a,b}.` — the citation sits before the closing punctuation. */
export function sentenceToLatex(sentence: SurveySentence): string {
	const text = escapeLatex(sentence.text.trim());
	if (sentence.cites.length === 0) return text;
	const cite = `~\\cite{${sentence.cites.join(",")}}`;
	const m = text.match(/^(.*?)([.!?;:。！？；：]+["'”’)]*)$/s);
	return m ? `${m[1].trimEnd()}${cite}${m[2]}` : `${text}${cite}`;
}

/**
 * Ready-to-`\input` subsection plus the matching `.bib`. Only cited entries
 * are written, so every `\cite` key resolves and nothing is unused.
 */
export function buildSurveyLatex(
	result: SurveyParagraphResult,
	bibStem = "references",
): { tex: string; bib: string } {
	const cited = new Set(result.paragraphs.flat().flatMap((s) => s.cites));
	const citations = result.citations.filter((c) => cited.has(c.key));
	const title = escapeLatex(result.title.trim() || "Related Work");
	const body = result.paragraphs
		.map((p) => p.map(sentenceToLatex).join(" "))
		.join("\n\n");
	const tex = [
		"% Generated by Agentero Paper Survey.",
		`% Bibliography: \\bibliography{${bibStem}} (BibTeX) or \\addbibresource{${bibStem}.bib} (biblatex).`,
		`\\subsection{${title}}`,
		"",
		body,
		"",
	].join("\n");
	const bib = `${citations.map((c) => c.bibtex).join("\n\n")}\n`;
	return { tex, bib };
}

// ─── Report HTML ───

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Attribute value: double-quoted, single-quoted or unquoted. */
const ATTR_VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s>]+)`;
/** Remote URL value (`https://…`, `http://…`, protocol-relative `//…`). */
const REMOTE_VALUE = String.raw`(?:"\s*(?:https?:)?//[^"]*"|'\s*(?:https?:)?//[^']*'|(?:https?:)?//[^\s>]*)`;
const HANDLER_ATTR_RE = new RegExp(
	String.raw`[\s/]on[a-z]+\s*=\s*${ATTR_VALUE}`,
	"gi",
);
const JS_URL_ATTR_RE =
	/[\s/][a-z:-]+\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi;
const REMOTE_SRC_ATTR_RE = new RegExp(
	String.raw`[\s/](?:src|srcset|poster|background|xlink:href)\s*=\s*${REMOTE_VALUE}`,
	"gi",
);
/** One start tag; quoted attribute values may contain `>`. */
const TAG_RE = /<[a-zA-Z][^\s/>]*(?:[^>"']|"[^"]*"|'[^']*')*>/g;
/** SVG elements that fetch their plain `href`. */
const SVG_FETCH_TAG_RE = /^<(image|use|feimage)\b/i;
const REMOTE_HREF_ATTR_RE = new RegExp(
	String.raw`[\s/]href\s*=\s*${REMOTE_VALUE}`,
	"gi",
);

/**
 * Strip scripts, handlers, embeds and network assets: the report is opened
 * from disk in a real browser, so it must be inert and offline. Links
 * (`<a href>`) stay clickable.
 */
export function sanitizeReportHtml(html: string): string {
	return html
		.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
		.replace(/<script\b[^>]*\/?>/gi, "")
		.replace(
			/<(iframe|object|embed|frame|frameset|applet|form)\b[\s\S]*?<\/\1\s*>/gi,
			"",
		)
		.replace(/<(iframe|object|embed|frame|base|link|applet)\b[^>]*\/?>/gi, "")
		.replace(/<meta\b[^>]*http-equiv[^>]*>/gi, "")
		.replace(TAG_RE, (tag) => {
			const clean = tag
				.replace(HANDLER_ATTR_RE, " ")
				.replace(JS_URL_ATTR_RE, " ")
				.replace(REMOTE_SRC_ATTR_RE, " ");
			return SVG_FETCH_TAG_RE.test(clean)
				? clean.replace(REMOTE_HREF_ATTR_RE, " ")
				: clean;
		})
		.replace(/@import\b[^;]*;?/gi, "")
		.replace(/url\(\s*['"]?\s*(?:https?:)?\/\/[^)]*\)/gi, "none")
		.replace(/(min-|max-)?height\s*:\s*100d?vh\s*;?/gi, "");
}

function citationLabel(c: SurveyCitation): string {
	const first = c.authors[0]?.trim();
	const who = first
		? `${first}${c.authors.length > 1 ? " et al." : ""}`
		: undefined;
	return [who, c.year, c.title].filter(Boolean).join(", ");
}

function referenceItem(c: SurveyCitation): string {
	const authors =
		c.authors.length > 6
			? `${c.authors.slice(0, 6).join(", ")}, et al.`
			: c.authors.join(", ");
	const link = c.doi
		? `https://doi.org/${c.doi}`
		: c.arxivId
			? `https://arxiv.org/abs/${c.arxivId}`
			: c.url;
	const parts = [
		authors ? `${escapeHtml(authors)}.` : "",
		c.year ? ` (${c.year}).` : "",
		` <em>${escapeHtml(c.title)}</em>.`,
		c.venue ? ` ${escapeHtml(c.venue)}.` : "",
		link
			? ` <a href="${escapeHtml(link)}">${escapeHtml(c.doi ? `doi:${c.doi}` : link)}</a>`
			: "",
	];
	return `<li id="ref-${escapeHtml(c.key)}">${parts.join("").trim()}</li>`;
}

const REPORT_STYLE = `<style data-agentero-survey>
html,body{height:auto!important;min-height:0!important}
a.cite{text-decoration:none;color:inherit;font-weight:600}
.cites{white-space:nowrap;font-size:.85em;color:#2563eb}
#references ol{padding-left:1.6em;font-size:.9em;line-height:1.5}
#references li{margin:.25em 0;word-break:break-word}
@page{size:A4;margin:18mm}
@media print{a{color:inherit}}
</style>`;

/**
 * Final report document: sanitized, `[[cite:…]]` tokens → numbered anchors
 * (`<a class="cite" href="#ref-KEY">`), reference list with `id="ref-KEY"`.
 * `idToKey` maps agent ids (`S1`, `arxiv:…`) to citation keys.
 */
export function renderReportHtml(
	html: string,
	citations: readonly SurveyCitation[],
	idToKey: ReadonlyMap<string, string>,
): string {
	const byKey = new Map(citations.map((c) => [c.key, c]));
	let doc = sanitizeReportHtml(html).replace(
		SURVEY_CITE_TOKEN_RE,
		(_m, ids: string) => {
			const seen = new Set<string>();
			const links: string[] = [];
			for (const id of normalizeCiteIds(ids)) {
				const key = idToKey.get(id);
				const c = key ? byKey.get(key) : undefined;
				if (!c || seen.has(c.key)) continue;
				seen.add(c.key);
				links.push(
					`<a class="cite" href="#ref-${escapeHtml(c.key)}" title="${escapeHtml(citationLabel(c))}">${c.index}</a>`,
				);
			}
			return links.length
				? `<span class="cites">[${links.join(", ")}]</span>`
				: "";
		},
	);
	const list = `<ol>${citations.map(referenceItem).join("")}</ol>`;
	if (doc.includes(SURVEY_REFERENCES_MARKER)) {
		doc = doc.replace(SURVEY_REFERENCES_MARKER, list);
	} else if (citations.length > 0) {
		const section = `<section id="references" class="agentero-references"><h2>References</h2>${list}</section>`;
		doc = /<\/body>/i.test(doc)
			? doc.replace(/<\/body>/i, `${section}</body>`)
			: `${doc}${section}`;
	}
	if (!/<meta[^>]+charset/i.test(doc)) {
		doc = doc.replace(/<head([^>]*)>/i, '<head$1><meta charset="utf-8">');
	}
	return /<\/head>/i.test(doc)
		? doc.replace(/<\/head>/i, `${REPORT_STYLE}</head>`)
		: `${REPORT_STYLE}${doc}`;
}
