/**
 * Plaza — `Paper Survey` agent output parsing.
 *
 * The agent ends its reply with a fenced `survey-json` block (and, for the
 * report, a full HTML document). Parsing tolerates prose around the block,
 * other fence tags, loose shapes and trailing commas, and returns a code on
 * failure that the store maps to a translated message.
 */

import type { SurveyFormat } from "@/lib/plaza/survey-types";

/** Citation token used in report HTML: `[[cite:S1]]`, `[[cite:S1|arxiv:2401.01234]]`. */
export const SURVEY_CITE_TOKEN_RE = /\[\[\s*cite\s*:([^\]]+)\]\]/gi;
/** Placeholder the report's reference section carries; replaced by the list. */
export const SURVEY_REFERENCES_MARKER = "<!--SURVEY-REFERENCES-->";

export type SurveyRawReference = {
	id: string;
	title?: string;
	authors?: string[];
	year?: number;
	venue?: string;
	doi?: string;
	arxivId?: string;
	url?: string;
};

/** Sentence with raw agent cite ids (`S1`, `arxiv:…`). */
export type SurveyRawSentence = { text: string; cites: string[] };

export type ParsedSurveyParagraph = {
	kind: "paragraph";
	title: string;
	paragraphs: SurveyRawSentence[][];
	references: SurveyRawReference[];
};

export type ParsedSurveyReport = {
	kind: "report";
	title: string;
	summary?: string;
	html: string;
	references: SurveyRawReference[];
};

export type ParsedSurvey = ParsedSurveyParagraph | ParsedSurveyReport;

export type SurveyParseErrorCode =
	| "noJson"
	| "badJson"
	| "noParagraphs"
	| "noHtml";

export type SurveyParseOutcome =
	| { ok: true; value: ParsedSurvey }
	| { ok: false; code: SurveyParseErrorCode };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

function tryParseObject(raw: string): JsonObject | null {
	const attempts = [raw.trim(), raw.trim().replace(/,\s*([}\]])/g, "$1")];
	for (const attempt of attempts) {
		try {
			const parsed: unknown = JSON.parse(attempt);
			if (isObject(parsed)) return parsed;
		} catch {
			// next attempt
		}
	}
	return null;
}

/** String-aware balanced `{…}` end index, or -1. */
function balancedEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === "\\") i++;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

const FENCE_RE = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;

function looksLikeSurvey(obj: JsonObject): boolean {
	return "paragraphs" in obj || "references" in obj || "title" in obj;
}

/**
 * Locate the survey JSON object: last `survey-json` fence, then last `json`
 * fence, then the last balanced object in plain text that looks like one.
 * `found` distinguishes "nothing there" from "present but malformed".
 */
export function extractSurveyJson(text: string): {
	value: JsonObject | null;
	found: boolean;
} {
	const fences = [...text.matchAll(FENCE_RE)].map((m) => ({
		lang: m[1].toLowerCase(),
		body: m[2],
	}));
	let found = false;
	for (const lang of ["survey-json", "json", ""]) {
		const bodies = fences.filter((f) => f.lang === lang).reverse();
		for (const f of bodies) {
			if (lang === "" && !f.body.trim().startsWith("{")) continue;
			found = true;
			const obj = tryParseObject(f.body);
			if (obj && looksLikeSurvey(obj)) return { value: obj, found };
		}
	}
	// Plain-text fallback without the HTML document (its CSS braces are noise).
	const plain = text.replace(/<!doctype html[\s\S]*?<\/html>/gi, "");
	let best: JsonObject | null = null;
	for (let i = plain.indexOf("{"); i >= 0; i = plain.indexOf("{", i + 1)) {
		const end = balancedEnd(plain, i);
		if (end < 0) continue;
		const slice = plain.slice(i, end + 1);
		if (!/"(paragraphs|references|title)"/.test(slice)) continue;
		found = true;
		const obj = tryParseObject(slice);
		if (obj && looksLikeSurvey(obj)) {
			best = obj;
			i = end;
		}
	}
	return { value: best, found };
}

/** Split `"S1, arxiv:x | S2"` / arrays into trimmed unique ids. */
export function normalizeCiteIds(value: unknown): string[] {
	const raw: string[] = Array.isArray(value)
		? value.flatMap((v) =>
				typeof v === "string"
					? [v]
					: isObject(v) && str(v.id)
						? [str(v.id) as string]
						: [],
			)
		: typeof value === "string"
			? value.split(/[|,;]/)
			: [];
	const out: string[] = [];
	for (const item of raw) {
		const id = item.trim().replace(/^\[+|\]+$/g, "");
		if (id && !out.includes(id)) out.push(id);
	}
	return out;
}

function normalizeSentence(value: unknown): SurveyRawSentence | null {
	let text: string | undefined;
	let cites: string[] = [];
	if (typeof value === "string") {
		text = value;
	} else if (isObject(value)) {
		text = str(value.text) ?? str(value.sentence);
		cites = normalizeCiteIds(
			value.cites ?? value.citations ?? value.refs ?? value.cite,
		);
	}
	if (!text) return null;
	// Inline tokens the model may still emit move into `cites`.
	const inline = [...text.matchAll(SURVEY_CITE_TOKEN_RE)].flatMap((m) =>
		normalizeCiteIds(m[1]),
	);
	for (const id of inline) if (!cites.includes(id)) cites.push(id);
	const clean = text
		.replace(SURVEY_CITE_TOKEN_RE, "")
		.replace(/\s+([.,;:!?])/g, "$1")
		.replace(/\s{2,}/g, " ")
		.trim();
	return clean ? { text: clean, cites } : null;
}

function normalizeParagraphs(value: unknown): SurveyRawSentence[][] {
	if (!Array.isArray(value)) return [];
	// Flat list of sentences → one paragraph.
	const isFlat = value.every(
		(v) => typeof v === "string" || (isObject(v) && !("sentences" in v)),
	);
	const groups: unknown[][] = isFlat
		? [value]
		: value.map((p) =>
				Array.isArray(p)
					? p
					: isObject(p) && Array.isArray(p.sentences)
						? p.sentences
						: [p],
			);
	return groups
		.map((g) =>
			g
				.map(normalizeSentence)
				.filter((s): s is SurveyRawSentence => s !== null),
		)
		.filter((p) => p.length > 0);
}

function normalizeReferences(value: unknown): SurveyRawReference[] {
	if (!Array.isArray(value)) return [];
	const out: SurveyRawReference[] = [];
	for (const item of value) {
		if (!isObject(item)) continue;
		const id = str(item.id) ?? str(item.paperId) ?? str(item.key);
		if (!id || out.some((r) => r.id === id)) continue;
		const authors = Array.isArray(item.authors)
			? item.authors.map(str).filter((a): a is string => Boolean(a))
			: typeof item.authors === "string"
				? item.authors
						.split(/\s+and\s+|;|,\s*(?=[A-Z])/)
						.map((a) => a.trim())
						.filter(Boolean)
				: undefined;
		const year = Number.parseInt(str(item.year) ?? "", 10);
		out.push({
			id,
			title: str(item.title),
			authors,
			year: Number.isFinite(year) ? year : undefined,
			venue: str(item.venue) ?? str(item.booktitle) ?? str(item.journal),
			doi: str(item.doi),
			arxivId: str(item.arxivId) ?? str(item.arxiv_id) ?? str(item.arxiv),
			url: str(item.url),
		});
	}
	return out;
}

/** The complete HTML document in the reply (doctype / html tags or `html` fence). */
export function extractReportHtml(text: string): string | null {
	const doc =
		text.match(/<!doctype html[\s\S]*<\/html>/i)?.[0] ??
		text.match(/<html[\s>][\s\S]*<\/html>/i)?.[0];
	if (doc) return doc.trim();
	const fence = [...text.matchAll(FENCE_RE)]
		.reverse()
		.find((m) => m[1].toLowerCase() === "html");
	return fence?.[2].trim() || null;
}

function htmlTitle(html: string): string | undefined {
	const raw =
		html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
		html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
	return raw ? str(raw.replace(/<[^>]+>/g, "")) : undefined;
}

export function parseSurveyOutput(
	text: string,
	format: SurveyFormat,
): SurveyParseOutcome {
	const { value, found } = extractSurveyJson(text);
	if (format === "report") {
		const html = extractReportHtml(text);
		if (!html) return { ok: false, code: "noHtml" };
		return {
			ok: true,
			value: {
				kind: "report",
				title: str(value?.title) ?? htmlTitle(html) ?? "",
				summary: str(value?.summary),
				html,
				references: normalizeReferences(value?.references),
			},
		};
	}
	if (!value) return { ok: false, code: found ? "badJson" : "noJson" };
	const paragraphs = normalizeParagraphs(value.paragraphs ?? value.sentences);
	if (paragraphs.length === 0) return { ok: false, code: "noParagraphs" };
	return {
		ok: true,
		value: {
			kind: "paragraph",
			title: str(value.title) ?? "",
			paragraphs,
			references: normalizeReferences(value.references),
		},
	};
}

/** Cite ids in first-appearance order across a parsed survey. */
export function orderedCiteIds(parsed: ParsedSurvey): string[] {
	const ids: string[] = [];
	const push = (id: string) => {
		if (!ids.includes(id)) ids.push(id);
	};
	if (parsed.kind === "paragraph") {
		for (const p of parsed.paragraphs)
			for (const s of p) for (const id of s.cites) push(id);
	} else {
		for (const m of parsed.html.matchAll(SURVEY_CITE_TOKEN_RE))
			for (const id of normalizeCiteIds(m[1])) push(id);
	}
	return ids;
}
