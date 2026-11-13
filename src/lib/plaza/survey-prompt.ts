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
Write an editorial-grade academic survey report with a strict A4 print budget (at most 4 A4 pages when printed): **1,500-2,200 English words** (or **2,400-3,600 Chinese characters** when writing in Chinese), plus **2-3 inline \`<svg>\` figures** and **1 structured comparison \`<table>\`**. Match the language of the user's topic.

Suggested structure:
1. Title, concise deck/metadata line, and a 3-5 sentence abstract;
2. Background and problem formulation;
3. Taxonomy of approaches with a \`<figure>\` method-taxonomy diagram;
4. Method families and a structured comparison \`<table>\` (cite representative works with \`[[cite:ID]]\` inside cells);
5. Architectural / capability trade-offs with a second \`<figure>\` diagram (pipeline, trade-off space, or evolution timeline);
6. Open challenges, future directions, and brief conclusion;
7. \`<section id="references"><h2>References</h2>${SURVEY_REFERENCES_MARKER}</section>\` at the end of \`<body>\` (translate the heading to the report language).

Your final reply contains, in this order:
1. One fenced block tagged \`survey-json\`:
\`\`\`survey-json
{ "title": "<report title>", "summary": "<one or two sentences>", "references": [${REFERENCE_SHAPE}] }
\`\`\`
2. The complete HTML document from \`<!DOCTYPE html>\` to \`</html>\`, in a fenced \`html\` block.

HTML, editorial A4 layout, and print rules:
- One self-contained file: all CSS inline in a \`<style>\` element; no \`<script>\`, no \`on*\` event handlers, and no external URLs for fonts, images, stylesheets, or icons.
- A4 sheet geometry & print rules: center the main container with \`max-width: 210mm; margin: 0 auto; padding: 14mm 16mm\` on a clean white surface; include \`@page { size: A4; margin: 14mm }\`, \`figure, table { break-inside: avoid }\`, and \`h2, h3 { break-after: avoid }\`.
- Never size \`html\` or \`body\` with \`100vh\` or \`height: 100%\`; the document must flow to its natural height.
- Clean academic CSS typography: legible body copy (~10.5pt-11pt, \`line-height: 1.55\`), clear section hierarchy, restrained scholarly palette (dark ink, subtle slate rules, 1-2 muted accent hues that remain crisp on white paper), and compact table styling (\`border-collapse: collapse\`).
- Visuals: include 2-3 \`<figure>\` elements using inline \`<svg viewBox="0 0 720 ...">\` (\`width: 100%; height: auto\`, generous box padding so labels never clip or overlap, \`<figcaption>\`) — e.g., a method taxonomy diagram and an architecture/trade-off diagram — plus 1 structured comparison \`<table>\` with \`[[cite:ID]]\` cells.
- Cite inline right after claims and in table cells with tokens \`[[cite:ID]]\` or \`[[cite:ID1|ID2]]\` (ids as defined below). Do not number citations manually and do not write a reference list yourself; \`${SURVEY_REFERENCES_MARKER}\` is replaced automatically.
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
