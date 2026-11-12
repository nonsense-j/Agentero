/**
 * Cross-portal paper work identity (`title + first 2 authors`, `arxivId`, publisher `doi`).
 *
 * Mirrors `crates/agentero-core/src/features/paper/util.rs` and `collection/store.rs`
 * with zero internal imports so both `plaza/*` and test helpers can depend on it
 * without introducing module cycles.
 */

export type PaperIdentityLike = {
	title: string;
	authors: readonly string[];
	arxivId?: string | null;
	doi?: string | null;
};

const AUTHOR_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

const LATIN_FOLD_MAP: Record<string, string> = {
	à: "a",
	á: "a",
	â: "a",
	ã: "a",
	ä: "a",
	å: "a",
	ā: "a",
	ă: "a",
	ą: "a",
	æ: "ae",
	ç: "c",
	ć: "c",
	č: "c",
	ĉ: "c",
	ċ: "c",
	ď: "d",
	đ: "d",
	ð: "d",
	è: "e",
	é: "e",
	ê: "e",
	ë: "e",
	ē: "e",
	ĕ: "e",
	ė: "e",
	ę: "e",
	ě: "e",
	ğ: "g",
	ĝ: "g",
	ġ: "g",
	ģ: "g",
	ĥ: "h",
	ħ: "h",
	ì: "i",
	í: "i",
	î: "i",
	ï: "i",
	ĩ: "i",
	ī: "i",
	ĭ: "i",
	į: "i",
	ı: "i",
	ĵ: "j",
	ķ: "k",
	ĺ: "l",
	ļ: "l",
	ľ: "l",
	ŀ: "l",
	ł: "l",
	ñ: "n",
	ń: "n",
	ņ: "n",
	ň: "n",
	ò: "o",
	ó: "o",
	ô: "o",
	õ: "o",
	ö: "o",
	ø: "o",
	ō: "o",
	ŏ: "o",
	ő: "o",
	œ: "oe",
	ŕ: "r",
	ŗ: "r",
	ř: "r",
	ß: "ss",
	ś: "s",
	ŝ: "s",
	ş: "s",
	š: "s",
	ș: "s",
	ť: "t",
	ţ: "t",
	ŧ: "t",
	ț: "t",
	ù: "u",
	ú: "u",
	û: "u",
	ü: "u",
	ũ: "u",
	ū: "u",
	ŭ: "u",
	ů: "u",
	ű: "u",
	ų: "u",
	ŵ: "w",
	ý: "y",
	ÿ: "y",
	ŷ: "y",
	ź: "z",
	ż: "z",
	ž: "z",
	þ: "th",
};

/**
 * Canonical title comparison key: lowercase ASCII alphanumerics + CJK ideographs.
 */
export function normTitleKey(raw: string): string {
	const lower = raw.trim().toLowerCase();
	let out = "";
	for (const ch of lower) {
		const code = ch.codePointAt(0) ?? 0;
		if (
			(code >= 0x30 && code <= 0x39) ||
			(code >= 0x61 && code <= 0x7a) ||
			(code >= 0x4e00 && code <= 0x9fff)
		) {
			out += ch;
		}
	}
	return out;
}

function stripParentheticals(raw: string): string {
	let out = "";
	let depth = 0;
	for (const ch of raw) {
		if (ch === "(" || ch === "[") {
			depth += 1;
		} else if (ch === ")" || ch === "]") {
			if (depth > 0) depth -= 1;
		} else if (depth === 0) {
			out += ch;
		}
	}
	return out;
}

function foldLatinToAsciiOrSpace(raw: string): string {
	let out = "";
	for (const ch of raw.toLowerCase()) {
		const code = ch.codePointAt(0) ?? 0;
		if (
			(code >= 0x30 && code <= 0x39) ||
			(code >= 0x61 && code <= 0x7a) ||
			(code >= 0x4e00 && code <= 0x9fff)
		) {
			out += ch;
		} else if (ch in LATIN_FOLD_MAP) {
			out += LATIN_FOLD_MAP[ch];
		} else {
			out += " ";
		}
	}
	return out;
}

function isDigitsOnly(tok: string): boolean {
	if (!tok) return false;
	for (let i = 0; i < tok.length; i += 1) {
		const c = tok.charCodeAt(i);
		if (c < 0x30 || c > 0x39) return false;
	}
	return true;
}

function parseNormalizedAuthor(
	raw: string,
): { given: string; surname: string } | null {
	const cleaned = stripParentheticals(raw);
	let reordered: string;
	if (cleaned.includes(",")) {
		const parts: string[] = [];
		for (const seg of cleaned.split(",")) {
			const toks = foldLatinToAsciiOrSpace(seg)
				.split(/\s+/)
				.filter(
					(t) => t.length > 0 && !isDigitsOnly(t) && !AUTHOR_SUFFIXES.has(t),
				);
			if (toks.length > 0) {
				parts.push(toks.join(" "));
			}
		}
		if (parts.length >= 2) {
			const surname = parts[0];
			reordered = `${parts.slice(1).join(" ")} ${surname}`;
		} else {
			reordered = parts[0] ?? "";
		}
	} else {
		reordered = foldLatinToAsciiOrSpace(cleaned);
	}

	const rawTokens = reordered
		.split(/\s+/)
		.filter((t) => t.length > 0 && !isDigitsOnly(t) && !AUTHOR_SUFFIXES.has(t));
	if (rawTokens.length === 0) return null;
	if (rawTokens.length === 1) {
		return { given: "", surname: rawTokens[0] };
	}

	const filtered: string[] = [];
	const lastIdx = rawTokens.length - 1;
	for (let idx = 0; idx < rawTokens.length; idx += 1) {
		const tok = rawTokens[idx];
		const code = tok.charCodeAt(0);
		const isMiddleInitial =
			idx > 0 &&
			idx < lastIdx &&
			tok.length === 1 &&
			code >= 0x61 &&
			code <= 0x7a;
		if (!isMiddleInitial) {
			filtered.push(tok);
		}
	}
	const surname = filtered.pop() ?? "";
	const given = filtered.join("");
	return { given, surname };
}

/**
 * Canonical key for a single author name (`"Alice B. Smith"` / `"Smith, Alice 0001"` -> `"alicesmith"`).
 */
export function normAuthorKey(raw: string): string {
	const parsed = parseNormalizedAuthor(raw);
	if (!parsed) return "";
	return `${parsed.given}${parsed.surname}`;
}

/**
 * Canonical O(1) hash key identifying a paper work by normalized title + first 2 author names.
 */
export function paperWorkKey(
	title: string,
	authors: readonly string[],
): string | null {
	const t = normTitleKey(title);
	if (!t) return null;
	const firstTwo: string[] = [];
	for (const a of authors) {
		const k = normAuthorKey(a);
		if (k) {
			firstTwo.push(k);
			if (firstTwo.length === 2) break;
		}
	}
	if (firstTwo.length === 0) return null;
	return `${t}::${firstTwo.join("|")}`;
}

function authorPairCompatible(
	a: { given: string; surname: string },
	b: { given: string; surname: string },
): boolean {
	if (!a.surname || a.surname !== b.surname) return false;
	if (a.given === b.given) return true;
	if (a.given.length === 1 && b.given.startsWith(a.given)) return true;
	if (b.given.length === 1 && a.given.startsWith(b.given)) return true;
	return false;
}

/**
 * True when two papers share the same normalized title and compatible first 2 authors
 * (including abbreviated initials such as `"A. Smith"` vs `"Alice Smith"`).
 */
export function sameWorkByTitleAndAuthors(
	titleA: string,
	authorsA: readonly string[],
	titleB: string,
	authorsB: readonly string[],
): boolean {
	const ta = normTitleKey(titleA);
	if (!ta || ta !== normTitleKey(titleB)) return false;

	const pa: Array<{ given: string; surname: string }> = [];
	for (const raw of authorsA) {
		const parsed = parseNormalizedAuthor(raw);
		if (parsed) {
			pa.push(parsed);
			if (pa.length === 2) break;
		}
	}
	const pb: Array<{ given: string; surname: string }> = [];
	for (const raw of authorsB) {
		const parsed = parseNormalizedAuthor(raw);
		if (parsed) {
			pb.push(parsed);
			if (pb.length === 2) break;
		}
	}
	if (pa.length === 0 || pa.length !== pb.length) return false;
	return pa.every((item, idx) => authorPairCompatible(item, pb[idx]));
}

export function cleanArxivKey(raw?: string | null): string | null {
	if (!raw) return null;
	const cleaned = raw
		.trim()
		.replace(/^arxiv:\s*/i, "")
		.replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf|html)\//i, "")
		.replace(/\.pdf$/i, "")
		.replace(/v\d+$/i, "")
		.trim()
		.toLowerCase();
	return cleaned || null;
}

export function cleanDoiKey(raw?: string | null): string | null {
	if (!raw) return null;
	const cleaned = raw
		.trim()
		.replace(/^doi:\s*/i, "")
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.trim()
		.toLowerCase();
	return cleaned || null;
}

export function isPublisherDoi(doiNorm?: string | null): boolean {
	return Boolean(doiNorm && !doiNorm.startsWith("10.48550/arxiv."));
}

/**
 * True when two collection/library paper objects represent the same scholarly work
 * across arXiv and Venue portals.
 */
export function sameCollectionPaperWork(
	a: PaperIdentityLike,
	b: PaperIdentityLike,
): boolean {
	const axA = cleanArxivKey(a.arxivId);
	const axB = cleanArxivKey(b.arxivId);
	if (axA && axB && axA === axB) return true;

	const doiA = cleanDoiKey(a.doi);
	const doiB = cleanDoiKey(b.doi);
	if (doiA && doiB && isPublisherDoi(doiA) && doiA === doiB) return true;

	return sameWorkByTitleAndAuthors(a.title, a.authors, b.title, b.authors);
}
