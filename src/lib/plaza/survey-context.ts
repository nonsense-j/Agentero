/**
 * Plaza — `Paper Survey` seed-paper context.
 *
 * Seed papers are summarized from catalog metadata plus the Introduction
 * section only (preferring LaTeX under `<paper>/source/*.tex`, falling back to
 * `<paper>/PAPER.md`). The agent never needs to read full texts or PDFs.
 */

import { readDir } from "@tauri-apps/plugin-fs";
import { basenameOf, dirnameOf } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import type { PaperMetadata } from "@/lib/paper/types";
import { readVaultFile, vaultPathExists } from "@/lib/vault/fs";
import { joinVaultPath } from "@/lib/vault/path";
import { ensureLocalFsScope } from "@/lib/vault/scope";

/** Per-seed Introduction cap; shrinks with many seeds to bound the prompt. */
export const SURVEY_INTRO_MAX_CHARS = 6000;
const SURVEY_INTRO_TOTAL_BUDGET = 48_000;
const SURVEY_ABSTRACT_MAX_CHARS = 2500;

export type SurveySeedContext = {
	/** Stable handle the agent cites (`S1`, `S2`, …). */
	ref: string;
	paper: PaperMetadata;
	abstract: string | null;
	introduction: string | null;
};

type Heading = { level: number; title: string };

const MD_HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
/** `1 Introduction`, `1. INTRODUCTION`, `I. Introduction` on their own line. */
const PLAIN_SECTION_RE =
	/^\s*((?:\d+|[IVX]+)\.?)\s+([A-Z\u4e00-\u9fff][^\n]{0,80})$/;
const INTRO_TITLE_RE = /^(introduction|intro|引言|简介|绪论|介绍)(?![A-Za-z])/i;
const SECTION_NUMBER_RE = /^((?:\d+(?:\.\d+)*|[IVX]+)\.?)\s+/;

function cleanTitle(raw: string): string {
	return raw
		.replace(/\*\*|__|`/g, "")
		.replace(/<[^>]+>/g, "")
		.trim();
}

function parseHeading(line: string): Heading | null {
	const md = line.match(MD_HEADING_RE);
	if (md) return { level: md[1].length, title: cleanTitle(md[2]) };
	const plain = line.match(PLAIN_SECTION_RE);
	if (plain && !/[.:;,]$/.test(plain[2].trim())) {
		return { level: 0, title: cleanTitle(`${plain[1]} ${plain[2]}`) };
	}
	return null;
}

function sectionNumber(title: string): string | null {
	const m = title.match(SECTION_NUMBER_RE);
	return m ? m[1].replace(/\.$/, "") : null;
}

function stripNumber(title: string): string {
	return title.replace(SECTION_NUMBER_RE, "").trim();
}

function capText(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const boundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
	return `${(boundary > max * 0.6 ? cut.slice(0, boundary + 1) : cut).trimEnd()} …`;
}

/**
 * Extract the Introduction section body from a parsed paper Markdown.
 * Stops at the first following section that is not a sub-section of the
 * Introduction. Returns null when no Introduction heading exists.
 */
export function extractIntroduction(
	markdown: string,
	maxChars = SURVEY_INTRO_MAX_CHARS,
): string | null {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	let start = -1;
	let introLevel = 0;
	let introNumber: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const h = parseHeading(lines[i]);
		if (h && INTRO_TITLE_RE.test(stripNumber(h.title))) {
			start = i + 1;
			introLevel = h.level;
			introNumber = sectionNumber(h.title);
			break;
		}
	}
	if (start < 0) return null;

	const body: string[] = [];
	for (let i = start; i < lines.length; i++) {
		const h = parseHeading(lines[i]);
		if (h) {
			const num = sectionNumber(h.title);
			const isSubsection =
				(introNumber != null && num?.startsWith(`${introNumber}.`)) ||
				(h.level > 0 && introLevel > 0 && h.level > introLevel);
			// Plain-text lines only end the section when they look like the next
			// numbered section (avoids cutting at enumerations).
			const isPlainNext =
				h.level === 0 &&
				introNumber != null &&
				num != null &&
				/^\d+$/.test(introNumber) &&
				num === String(Number(introNumber) + 1);
			if (h.level > 0 ? !isSubsection : isPlainNext) break;
		}
		body.push(lines[i]);
	}
	const text = body
		.join("\n")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return text ? capText(text, maxChars) : null;
}

const TEX_NAME_RE = /\.(tex|ltx)$/i;
const TEX_MAX_FILES = 25;
const TEX_MAX_DIR_DEPTH = 2;
const TEX_MAX_INPUT_DEPTH = 2;
const TEX_SKIP_DIRS = new Set([
	"assets",
	"figures",
	"fig",
	"figs",
	"img",
	"images",
	"agentero_attachments",
	"attachments",
	".git",
]);
const STANDALONE_INTRO_FILE_RE =
	/^(?:0?1[-_.]?)?intro(?:duction)?\.(?:tex|ltx)$/i;
const TEX_SECTION_OPEN_RE =
	/\\section(?![a-zA-Z])\s*\*?\s*(?:\[[^\]]*\]\s*)?\{/g;
const TEX_INTRO_STOP_RE =
	/(?:\\section|\\chapter|\\appendix|\\bibliography|\\begin\s*\{\s*thebibliography\s*\}|\\end\s*\{\s*document\s*\})(?![a-zA-Z])/;
const TEX_FLOAT_ENV_RE =
	/\\begin\s*\{\s*(figure\*?|table\*?|wrapfigure|wraptable|tikzpicture|algorithm\*?|lstlisting|verbatim)\s*\}[\s\S]*?\\end\s*\{\s*\1\s*\}/g;

function normalizeTexKey(raw: string): string {
	const parts = raw
		.trim()
		.replace(/\\/g, "/")
		.replace(/^(?:\.\/|\/)+/, "")
		.split("/");
	const resolved: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") resolved.pop();
		else resolved.push(part);
	}
	return resolved.join("/");
}

/** Strip `%` comments while preserving `\%` and dropping pure-comment lines. */
function stripTexComments(tex: string): string {
	const lines = tex.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	for (const line of lines) {
		if (/^\s*%/.test(line)) continue;
		let cut = -1;
		let slashes = 0;
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (c === "\\") {
				slashes++;
				continue;
			}
			if (c === "%" && slashes % 2 === 0) {
				cut = i;
				break;
			}
			slashes = 0;
		}
		out.push(cut >= 0 ? line.slice(0, cut).trimEnd() : line);
	}
	return out.join("\n");
}

function readBraced(
	text: string,
	openIdx: number,
): { content: string; end: number } | null {
	if (text[openIdx] !== "{") return null;
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) {
				return { content: text.slice(openIdx + 1, i), end: i + 1 };
			}
		}
	}
	return null;
}

function replaceBracedMacro(
	text: string,
	openRe: RegExp,
	render: (macro: string, content: string) => string,
): string {
	const re = new RegExp(openRe.source, "g");
	let out = "";
	let cursor = 0;
	for (let m = re.exec(text); m !== null; m = re.exec(text)) {
		const braceIdx = m.index + m[0].length - 1;
		const braced = readBraced(text, braceIdx);
		if (!braced) continue;
		out += text.slice(cursor, m.index) + render(m[1] ?? "", braced.content);
		cursor = braced.end;
		re.lastIndex = braced.end;
	}
	return cursor === 0 ? text : out + text.slice(cursor);
}

function replaceTwoArgMacro(
	text: string,
	openRe: RegExp,
	pick: "first" | "second",
): string {
	const re = new RegExp(openRe.source, "g");
	let out = "";
	let cursor = 0;
	for (let m = re.exec(text); m !== null; m = re.exec(text)) {
		const first = readBraced(text, m.index + m[0].length - 1);
		if (!first) continue;
		const ws = text.slice(first.end).match(/^\s*\{/);
		if (!ws) continue;
		const second = readBraced(text, first.end + ws[0].length - 1);
		if (!second) continue;
		out +=
			text.slice(cursor, m.index) +
			(pick === "first" ? first.content : second.content);
		cursor = second.end;
		re.lastIndex = second.end;
	}
	return cursor === 0 ? text : out + text.slice(cursor);
}

function unwrapTexFormatting(input: string): string {
	let cur = input;
	for (let pass = 0; pass < 6; pass++) {
		const next = replaceBracedMacro(
			replaceTwoArgMacro(
				replaceTwoArgMacro(cur, /\\texorpdfstring(?![a-zA-Z])\s*\{/g, "first"),
				/\\href(?![a-zA-Z])\s*\{/g,
				"second",
			),
			/\\(textbf|emph|textit|textrm|texttt|textsf|textsc|text|underline|mbox|url|uppercase|MakeUppercase)(?![a-zA-Z])\s*\{/g,
			(_cmd, inner) => inner,
		);
		if (next === cur) break;
		cur = next;
	}
	return cur;
}

function cleanTexHeadingTitle(raw: string): string {
	return unwrapTexFormatting(raw.replace(/\\label\s*\{[^}]*\}/g, ""))
		.replace(/\\[a-zA-Z]+\*?/g, " ")
		.replace(/[{}]/g, "")
		.replace(
			/^(?:(?:\d+(?:\.\d+)*|[IVX]+)(?:\.\s*|\s+)|[一二三四五六七八九十]+(?:[、.．]\s*|\s+))/i,
			"",
		)
		.trim();
}

function sliceDocumentBody(tex: string): string {
	const begin = tex.match(/\\begin\s*\{\s*document\s*\}/);
	const afterBegin = begin
		? tex.slice((begin.index ?? 0) + begin[0].length)
		: tex;
	const end = afterBegin.match(/\\end\s*\{\s*document\s*\}/);
	return end ? afterBegin.slice(0, end.index ?? afterBegin.length) : afterBegin;
}

function extractIntroSectionFromTex(tex: string): string | null {
	const doc = sliceDocumentBody(tex);
	const re = new RegExp(TEX_SECTION_OPEN_RE.source, "g");
	for (let m = re.exec(doc); m !== null; m = re.exec(doc)) {
		const braced = readBraced(doc, m.index + m[0].length - 1);
		if (!braced) continue;
		const title = cleanTexHeadingTitle(braced.content);
		if (INTRO_TITLE_RE.test(title)) {
			const rest = doc.slice(braced.end);
			const stop = rest.match(TEX_INTRO_STOP_RE);
			return stop ? rest.slice(0, stop.index ?? rest.length) : rest;
		}
		re.lastIndex = braced.end;
	}
	return null;
}

function cleanTexBody(raw: string): string {
	let text = raw.replace(TEX_FLOAT_ENV_RE, "\n\n");
	text = text
		.replace(
			/\\(?:begin|end)\s*\{\s*(?:itemize|enumerate|description|compactitem|compactenum|inparaenum|quote|quotation)\s*\}(?:\s*\[[^\]]*\])?/g,
			"\n",
		)
		.replace(
			/\\item(?![a-zA-Z])\s*(?:\[([^\]]*)\]\s*)?/g,
			(_m, label?: string) => (label?.trim() ? `\n- ${label.trim()} ` : "\n- "),
		);
	text = replaceBracedMacro(
		text,
		/\\(sub(?:sub)?section|paragraph)(?![a-zA-Z])\s*\*?\s*(?:\[[^\]]*\]\s*)?\{/g,
		(cmd, inner) => {
			const heading = unwrapTexFormatting(
				inner.replace(/\\label\s*\{[^}]*\}/g, ""),
			).trim();
			if (!heading) return "";
			if (cmd === "paragraph") return `\n\n${heading} `;
			const hashes = cmd === "subsection" ? "###" : "####";
			return `\n\n${hashes} ${heading}\n\n`;
		},
	);
	text = text
		.replace(
			/~?\s*\\(?:cite[a-zA-Z]*|(?:paren|text|auto|foot|no)cite)\*?(?:\s*\[[^\]]*\])*\s*\{[^}]*\}/g,
			"",
		)
		.replace(/\\label\s*\{[^}]*\}/g, "")
		.replace(/~?\s*\\(?:eq|auto|c|C|page|name)?ref\*?\s*\{[^}]*\}/g, "")
		.replace(
			/\\(?:input|include|subfile|bibliography|bibliographystyle)\s*\{[^}]*\}/g,
			"",
		)
		.replace(/\\(?:vspace|hspace)\*?\s*\{[^}]*\}/g, "")
		.replace(/\\par(?![a-zA-Z])/g, "\n\n")
		.replace(
			/\\(?:noindent|xspace|centering|small|footnotesize|scriptsize|normalsize|large|Large|newpage|clearpage|pagebreak|linebreak|allowbreak)(?![a-zA-Z])\s*/g,
			"",
		);
	text = unwrapTexFormatting(text)
		.replace(/\\([%&_$#{}])/g, "$1")
		.replace(/\\\\(?:\s*\[[^\]]*\])?/g, "\n")
		.replace(/~/g, " ")
		.replace(/``/g, '"')
		.replace(/''/g, '"')
		.replace(/[ \t]+([.,;:!?])/g, "$1");
	return text
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function mainCandidateScore(key: string, content: string): number {
	let score = 0;
	if (/\\documentclass(?![a-zA-Z])/.test(content)) score += 4;
	if (/\\begin\s*\{\s*document\s*\}/.test(content)) score += 4;
	if (
		/\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*(?:standalone|beamer)\s*\}/.test(
			content,
		)
	) {
		score -= 6;
	}
	if (!key.includes("/")) score += 3;
	const base = basenameOf(key).toLowerCase();
	if (/^(?:main|paper|ms|article|root)\.(?:tex|ltx)$/.test(base)) score += 3;
	if (/rebuttal|response|supp|appendix|cover|letter|poster|slide/.test(base)) {
		score -= 5;
	}
	return score;
}

/**
 * Extract the Introduction section from a paper's `source/` LaTeX files
 * (`relative path -> content`). Expands `\input` / `\include` up to depth 2
 * from the main `.tex`, falling back to standalone `01-intro.tex`-style files.
 */
export function extractTexIntroduction(
	files: ReadonlyMap<string, string>,
	maxChars = SURVEY_INTRO_MAX_CHARS,
): string | null {
	if (files.size === 0) return null;
	const stripped = new Map<string, string>();
	const lowerLookup = new Map<string, string>();
	for (const [rawKey, rawContent] of files) {
		const key = normalizeTexKey(rawKey);
		if (!key) continue;
		const clean = stripTexComments(rawContent).split(
			/\\endinput(?![a-zA-Z])/,
		)[0];
		stripped.set(key, clean);
		lowerLookup.set(key.toLowerCase(), key);
	}
	if (stripped.size === 0) return null;

	const resolveIncludeKey = (
		target: string,
		fromKey: string,
	): string | null => {
		const cleanTarget = target.trim().replace(/^["']|["']$/g, "");
		if (!cleanTarget) return null;
		const dir = dirnameOf(fromKey);
		const prefixes = dir ? ["", `${dir}/`] : [""];
		for (const prefix of prefixes) {
			for (const ext of ["", ".tex", ".ltx"]) {
				const candidate = normalizeTexKey(`${prefix}${cleanTarget}${ext}`);
				if (!candidate) continue;
				if (stripped.has(candidate)) return candidate;
				const ci = lowerLookup.get(candidate.toLowerCase());
				if (ci) return ci;
			}
		}
		return null;
	};

	const expandInputs = (
		content: string,
		currentKey: string,
		depth: number,
		seen: ReadonlySet<string>,
	): string => {
		if (depth >= TEX_MAX_INPUT_DEPTH) return content;
		return content.replace(
			/\\(?:input|include|subfile)(?![a-zA-Z])\s*\{([^}]+)\}/g,
			(full, rawTarget: string) => {
				const targetKey = resolveIncludeKey(rawTarget, currentKey);
				if (!targetKey || seen.has(targetKey)) return full;
				const child = stripped.get(targetKey);
				if (child === undefined) return full;
				const nextSeen = new Set(seen);
				nextSeen.add(targetKey);
				return `\n${expandInputs(child, targetKey, depth + 1, nextSeen)}\n`;
			},
		);
	};

	const finalize = (rawSection: string): string | null => {
		const cleaned = cleanTexBody(rawSection);
		return cleaned ? capText(cleaned, maxChars) : null;
	};

	const keys = [...stripped.keys()];
	const mainKeys = keys
		.filter((k) => {
			const c = stripped.get(k) ?? "";
			return /\\documentclass(?![a-zA-Z])|\\begin\s*\{\s*document\s*\}/.test(c);
		})
		.sort(
			(a, b) =>
				mainCandidateScore(b, stripped.get(b) ?? "") -
					mainCandidateScore(a, stripped.get(a) ?? "") || a.localeCompare(b),
		);

	for (const key of mainKeys) {
		const expanded = expandInputs(
			stripped.get(key) ?? "",
			key,
			0,
			new Set([key]),
		);
		const section = extractIntroSectionFromTex(expanded);
		if (section !== null) {
			const out = finalize(section);
			if (out) return out;
		}
	}

	// Standalone intro file fallback (`intro.tex`, `01-introduction.tex`, …).
	const standaloneKeys = keys
		.filter((k) => STANDALONE_INTRO_FILE_RE.test(basenameOf(k)))
		.sort(
			(a, b) =>
				Number(a.includes("/")) - Number(b.includes("/")) || a.localeCompare(b),
		);
	for (const key of standaloneKeys) {
		const expanded = expandInputs(
			stripped.get(key) ?? "",
			key,
			0,
			new Set([key]),
		);
		const section = extractIntroSectionFromTex(expanded);
		if (section !== null) {
			const out = finalize(section);
			if (out) return out;
			continue;
		}
		const doc = sliceDocumentBody(expanded);
		const stop = doc.match(TEX_INTRO_STOP_RE);
		const body = stop ? doc.slice(0, stop.index ?? doc.length) : doc;
		const out = finalize(body);
		if (out) return out;
	}

	// Partial source archive without `\documentclass`: check remaining files for `\section{Introduction}`.
	for (const key of keys) {
		if (mainKeys.includes(key) || standaloneKeys.includes(key)) continue;
		const expanded = expandInputs(
			stripped.get(key) ?? "",
			key,
			0,
			new Set([key]),
		);
		const section = extractIntroSectionFromTex(expanded);
		if (section !== null) {
			const out = finalize(section);
			if (out) return out;
		}
	}

	return null;
}

async function readTexIntroduction(
	vaultPath: string,
	paper: PaperMetadata,
	maxChars: number,
): Promise<string | null> {
	if (!isTauri() || !paper.path) return null;
	const sourceDir = joinVaultPath(
		joinVaultPath(vaultPath, paper.path),
		"source",
	);
	try {
		if (!(await vaultPathExists(sourceDir))) return null;
	} catch {
		return null;
	}

	const files = new Map<string, string>();
	const queue: Array<{ abs: string; rel: string; depth: number }> = [
		{ abs: sourceDir, rel: "", depth: 0 },
	];

	while (queue.length > 0 && files.size < TEX_MAX_FILES) {
		const cur = queue.shift();
		if (!cur) break;
		let entries: Awaited<ReturnType<typeof readDir>>;
		try {
			entries = await readDir(cur.abs);
		} catch {
			continue;
		}
		entries.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
		for (const entry of entries) {
			if (files.size >= TEX_MAX_FILES) break;
			if (!entry.name || !entry.isFile || !TEX_NAME_RE.test(entry.name)) {
				continue;
			}
			const relKey = cur.rel ? `${cur.rel}/${entry.name}` : entry.name;
			try {
				const content = await readVaultFile(joinVaultPath(cur.abs, entry.name));
				files.set(relKey, content);
			} catch {
				// Skip unreadable / non-UTF8 files.
			}
		}
		if (cur.depth >= TEX_MAX_DIR_DEPTH) continue;
		for (const entry of entries) {
			if (!entry.name || !entry.isDirectory) continue;
			if (
				entry.name.startsWith(".") ||
				TEX_SKIP_DIRS.has(entry.name.toLowerCase())
			) {
				continue;
			}
			queue.push({
				abs: joinVaultPath(cur.abs, entry.name),
				rel: cur.rel ? `${cur.rel}/${entry.name}` : entry.name,
				depth: cur.depth + 1,
			});
		}
	}

	return files.size > 0 ? extractTexIntroduction(files, maxChars) : null;
}

async function readIntroduction(
	vaultPath: string,
	paper: PaperMetadata,
	maxChars: number,
): Promise<string | null> {
	if (!paper.path || vaultPath.startsWith("remote:")) return null;
	await ensureLocalFsScope(vaultPath);
	const texIntro = await readTexIntroduction(vaultPath, paper, maxChars);
	if (texIntro) return texIntro;
	const file = joinVaultPath(joinVaultPath(vaultPath, paper.path), "PAPER.md");
	try {
		if (!(await vaultPathExists(file))) return null;
		return extractIntroduction(await readVaultFile(file), maxChars);
	} catch {
		return null;
	}
}

/** Build seed contexts in selection order (`S1` … `Sn`). */
export async function buildSeedContexts(
	vaultPath: string | null,
	papers: readonly PaperMetadata[],
): Promise<SurveySeedContext[]> {
	const introMax = Math.min(
		SURVEY_INTRO_MAX_CHARS,
		Math.floor(SURVEY_INTRO_TOTAL_BUDGET / Math.max(1, papers.length)),
	);
	return Promise.all(
		papers.map(async (paper, i) => ({
			ref: `S${i + 1}`,
			paper,
			abstract: paper.abstract?.trim()
				? capText(paper.abstract.trim(), SURVEY_ABSTRACT_MAX_CHARS)
				: null,
			introduction: vaultPath
				? await readIntroduction(vaultPath, paper, introMax)
				: null,
		})),
	);
}
