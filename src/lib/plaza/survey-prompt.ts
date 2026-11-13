/**
 * Plaza — `Paper Survey` prompt and output contract.
 *
 * Runs on the `plaza_survey` workflow: the Host envelope scopes the agent to
 * the read-only `agentero-collection` MCP; this prompt carries the seed-paper
 * context and the exact output contract `survey-parse.ts` reads.
 */

import type { SurveySeedContext } from "@/lib/plaza/survey-context";
import { SURVEY_REFERENCES_MARKER } from "@/lib/plaza/survey-parse";
import type { SurveyFormat } from "@/lib/plaza/survey-types";

export const SURVEY_WORKFLOW = "plaza_survey";

const MAX_AUTHORS = 8;

function seedBlock(seed: SurveySeedContext): string {
	const p = seed.paper;
	const authors =
		p.authors.length > MAX_AUTHORS
			? `${p.authors.slice(0, MAX_AUTHORS).join(", ")}, et al.`
			: p.authors.join(", ");
	const facts = [
		p.year ? `Year: ${p.year}` : null,
		p.publication ? `Venue: ${p.publication}` : null,
		p.doi ? `DOI: ${p.doi}` : null,
		p.arxiv_id ? `arXiv: ${p.arxiv_id}` : null,
	].filter(Boolean);
	return [
		`### ${seed.ref}: ${p.title}`,
		authors ? `- Authors: ${authors}` : null,
		facts.length ? `- ${facts.join(" | ")}` : null,
		seed.abstract
			? `- Abstract: ${seed.abstract}`
			: "- Abstract: (not available)",
		seed.introduction
			? `- Introduction (excerpt, ends where the Introduction ends):\n\n${seed.introduction
					.split("\n")
					.map((l) => `  > ${l}`)
					.join("\n")}`
			: null,
	]
		.filter(Boolean)
		.join("\n");
}

const REFERENCE_SHAPE =
	'{ "id": "<cite id>", "title": "...", "authors": ["..."], "year": 2024, "venue": "...", "doi": "...", "arxivId": "..." }';

const PARAGRAPH_CONTRACT = `## Output: Short Paragraph (one Related Work subsection)
Write ONE Related Work subsection for a research paper on the topic: 2-4 paragraphs, about 250-600 words in total, organized by theme or method family (not paper by paper). Compare approaches, state their limitations, and close by positioning the topic against them.

End your final reply with exactly one fenced block tagged \`survey-json\` and nothing after it:

\`\`\`survey-json
{
  "title": "<subsection title>",
  "paragraphs": [
    [
      { "text": "<one sentence>", "cites": ["S1", "<collection id>"] },
      { "text": "<one sentence without citations>", "cites": [] }
    ]
  ],
  "references": [${REFERENCE_SHAPE}]
}
\`\`\`

Rules for the block:
- \`paragraphs\` is a list of paragraphs; each paragraph is a list of sentences in reading order.
- \`text\` is plain prose: no LaTeX, no Markdown, no citation markers such as [1] or (Author, 2020). Citations go ONLY in \`cites\`.
- Every sentence that describes specific prior work cites it. Cite 8-20 distinct papers overall.
- \`references\` lists every id used in \`cites\`, with metadata copied from the seed list or tool outputs.
- The block must be valid JSON (double quotes, no comments, no trailing commas).`;

const REPORT_CONTRACT = `## Output: Long Report (standalone illustrated HTML)
Write a comprehensive but not overly detailed survey report: roughly 1800-2500 words plus 2-4 figures or tables, at most about 4 A4 pages when printed.
Suggested structure: title and short abstract; background and problem definition; a taxonomy of approaches (as a figure); method families with a comparison table; trends or a timeline; open challenges and future directions; conclusion.

Your final reply contains, in this order:
1. One fenced block tagged \`survey-json\`:
\`\`\`survey-json
{ "title": "<report title>", "summary": "<one or two sentences>", "references": [${REFERENCE_SHAPE}] }
\`\`\`
2. The complete HTML document from \`<!DOCTYPE html>\` to \`</html>\`, in a fenced \`html\` block.

HTML rules:
- One self-contained file: all CSS inline in a \`<style>\` element; figures and diagrams as inline \`<svg>\` or HTML/CSS; tables as \`<table>\`.
- No \`<script>\`, no event handlers, no external URLs for fonts, images, stylesheets or icons.
- Do not size \`html\` / \`body\` with \`100vh\` or \`height: 100%\`; the document must flow to its natural height. Make it print-friendly (A4, readable on white).
- Cite inline right after the claim with tokens \`[[cite:ID]]\` or \`[[cite:ID1|ID2]]\` (ids as defined below). Do not number citations and do not write a reference list yourself.
- End \`<body>\` with \`<section id="references"><h2>References</h2>${SURVEY_REFERENCES_MARKER}</section>\` (translate the heading to the report language); the reference list is inserted there.
- \`references\` in the JSON block lists every cited id.`;

export function buildSurveyPrompt(input: {
	topic: string;
	format: SurveyFormat;
	seeds: readonly SurveySeedContext[];
}): string {
	const handles = input.seeds.map((s) => s.ref).join(", ");
	return [
		"# Paper Survey",
		`Topic: ${input.topic.trim()}`,
		`Format: ${input.format === "paragraph" ? "Short Paragraph (Related Work subsection)" : "Long Report (standalone HTML)"}`,
		"",
		"## Seed papers (from the user's Library)",
		`The user selected these papers as the starting point. Only metadata, abstract and at most the Introduction are given: do not try to read full texts or PDFs. Cite them by handle (${handles}).`,
		"",
		input.seeds.map(seedBlock).join("\n\n"),
		"",
		"## Procedure",
		"1. Understand each seed paper's problem, core idea and contribution from the context above.",
		'2. Search the Paper Collection with `collection_search` (`mode: "ranked"`) using several boolean queries built from the topic and the seeds\' key terms. Find seeds in the collection by title and snowball from them with `collection_citations` when useful.',
		"3. Keep searching until you can organize the related work into clear themes and you know which papers matter most. Prefer influential and recent work that is genuinely related.",
		"4. Then write the result following the output contract below.",
		"",
		"## Citation ids",
		`- Seed papers: their handles (${handles}).`,
		"- Paper Collection papers: the exact `id` string from tool outputs (e.g. `arxiv:2401.01234`, `doi:10.1145/...`).",
		"- Cite nothing else, and never invent ids or metadata.",
		"",
		input.format === "paragraph" ? PARAGRAPH_CONTRACT : REPORT_CONTRACT,
	].join("\n");
}
