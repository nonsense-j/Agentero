/**
 * Plaza — `Paper Survey` seed-paper context.
 *
 * Seed papers are summarized from catalog metadata plus, when the vault holds
 * a parsed `PAPER.md`, the Introduction section only. The agent never needs
 * to read full texts or PDFs.
 */

import type { PaperMetadata } from "@/lib/paper/types";
import { readVaultFile, vaultPathExists } from "@/lib/vault/fs";
import { joinVaultPath } from "@/lib/vault/path";

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

async function readIntroduction(
	vaultPath: string,
	paper: PaperMetadata,
	maxChars: number,
): Promise<string | null> {
	if (!paper.path) return null;
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
