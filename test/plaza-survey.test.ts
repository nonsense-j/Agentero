import { describe, expect, it } from "vitest";
import type { PaperMetadata } from "@/lib/paper/types";
import {
	extractIntroduction,
	extractTexIntroduction,
} from "@/lib/plaza/survey-context";
import {
	assignCiteKeys,
	buildBibtexEntry,
	buildCitations,
	buildSurveyLatex,
	makeCiteKey,
	renderReportHtml,
	type SurveyCitationMeta,
	sanitizeReportHtml,
} from "@/lib/plaza/survey-export";
import { orderedCiteIds, parseSurveyOutput } from "@/lib/plaza/survey-parse";
import {
	dedupeSurveyCitations,
	mergeCitationWithLibrary,
} from "@/lib/plaza/survey-store";
import type { SurveyParagraphResult } from "@/lib/plaza/survey-types";

describe("Paper Survey parsing", () => {
	it("reads the last survey-json block amid prose and tolerates trailing commas", () => {
		const reply = [
			"I searched the collection.",
			"```json",
			'{"note": "draft"}',
			"```",
			"Final:",
			"```survey-json",
			"{",
			'  "title": "Fuzzing",',
			'  "paragraphs": [[{"text": "AFL popularized coverage feedback [[cite:arxiv:1|S1]] .", "cites": ["S1"]},',
			'    {"text": "Plain sentence.", "cites": []},]],',
			'  "references": [{"id": "arxiv:1", "title": "AFL", "authors": "A. One and B. Two", "year": "2016"}]',
			"}",
			"```",
		].join("\n");
		const out = parseSurveyOutput(reply, "paragraph");
		expect(out.ok).toBe(true);
		if (!out.ok || out.value.kind !== "paragraph") return;
		expect(out.value.paragraphs[0][0]).toEqual({
			text: "AFL popularized coverage feedback.",
			cites: ["S1", "arxiv:1"],
		});
		expect(out.value.references[0]).toMatchObject({
			authors: ["A. One", "B. Two"],
			year: 2016,
		});
		expect(orderedCiteIds(out.value)).toEqual(["S1", "arxiv:1"]);
	});

	it("reports missing vs malformed JSON and missing HTML", () => {
		expect(parseSurveyOutput("no block here", "paragraph")).toEqual({
			ok: false,
			code: "noJson",
		});
		expect(
			parseSurveyOutput('```survey-json\n{"title": oops}\n```', "paragraph"),
		).toEqual({ ok: false, code: "badJson" });
		expect(parseSurveyOutput("```survey-json\n{}\n```", "report")).toEqual({
			ok: false,
			code: "noHtml",
		});
	});

	it("extracts the report document and its title without JSON", () => {
		const out = parseSurveyOutput(
			"Here:\n```html\n<!DOCTYPE html><html><head><title>LLM Agents</title><style>p{color:red}</style></head><body>x [[cite:S2]]</body></html>\n```",
			"report",
		);
		expect(out.ok && out.value.kind === "report" && out.value.title).toBe(
			"LLM Agents",
		);
		if (out.ok) expect(orderedCiteIds(out.value)).toEqual(["S2"]);
	});
});

describe("Paper Survey citation keys and BibTeX", () => {
	it("builds lastnameYearFirstword keys and dedupes collisions", () => {
		expect(
			makeCiteKey({
				authors: ["Ashish Vaswani"],
				year: 2017,
				title: "Attention Is All You Need",
			}),
		).toBe("vaswani2017attention");
		expect(
			makeCiteKey({ authors: ["Müller, Jörg"], title: "On the Fuzzing" }),
		).toBe("muller" + "nd" + "fuzzing");
		const keys = assignCiteKeys([
			{ authors: ["A Smith"], year: 2020, title: "Graph nets" },
			{ authors: ["B Smith"], year: 2020, title: "Graph models" },
			{ preferredKey: "custom:key", authors: [], title: "x" },
			{
				preferredKey: "bad key{",
				authors: ["C Smith"],
				year: 2020,
				title: "Graph",
			},
		]);
		expect(keys).toEqual([
			"smith2020graph",
			"smith2020grapha",
			"custom:key",
			"smith2020graphb",
		]);
	});

	it("escapes generated entries and re-keys upstream BibTeX", () => {
		const entry = buildBibtexEntry(
			{
				source: "collection",
				title: "50% of {Bugs} & C_1",
				authors: ["A. B"],
				year: 2021,
				venue: "IEEE Transactions on Software Engineering",
				doi: "10.1/x_y",
			},
			"k1",
		);
		expect(entry).toContain("@article{k1,");
		expect(entry).toContain("title = {50\\% of \\{Bugs\\} \\& C\\_1}");
		expect(entry).toContain("doi = {10.1/x_y}");
		const rekeyed = buildBibtexEntry(
			{
				source: "collection",
				title: "T",
				authors: [],
				upstreamBibtex: "@inproceedings{DBLP:conf/x/Y21,\n  title = {T},\n}",
			},
			"y2021t",
		);
		expect(rekeyed.startsWith("@inproceedings{y2021t,")).toBe(true);
	});

	it("exports .tex whose \\cite keys exactly match the .bib entries", () => {
		const citations = buildCitations([
			{ source: "library", title: "Alpha", authors: ["X Lee"], year: 2020 },
			{ source: "collection", title: "Beta", authors: ["Y Lee"], year: 2020 },
			{ source: "collection", title: "Unused", authors: ["Z"], year: 2019 },
		]);
		const result: SurveyParagraphResult = {
			kind: "paragraph",
			title: "Related Work",
			paragraphs: [
				[
					{
						text: "Prior work covers 90% of cases.",
						cites: [citations[0].key, citations[1].key],
					},
					{ text: "No citation here", cites: [] },
				],
			],
			citations,
		};
		const { tex, bib } = buildSurveyLatex(result, "refs");
		expect(tex).toContain(
			`covers 90\\% of cases~\\cite{${citations[0].key},${citations[1].key}}.`,
		);
		const texKeys = [...tex.matchAll(/\\cite\{([^}]+)\}/g)].flatMap((m) =>
			m[1].split(","),
		);
		const bibKeys = [...bib.matchAll(/^@\w+\{([^,]+),/gm)].map((m) => m[1]);
		expect(new Set(texKeys)).toEqual(new Set(bibKeys));
		expect(bib).not.toContain("Unused");
	});
});

describe("Paper Survey report HTML", () => {
	it("sanitizes, numbers citations and fills the reference marker", () => {
		const citations = buildCitations([
			{ source: "library", title: "Alpha", authors: ["X Lee"], year: 2020 },
		]);
		const html = renderReportHtml(
			'<!DOCTYPE html><html><head><style>body{min-height:100vh}</style></head><body onload="x()"><script>alert(1)</script><img src="https://e.com/a.png"><p>Claim [[cite:S1|bogus]].</p><section id="references"><h2>参考文献</h2><!--SURVEY-REFERENCES--></section></body></html>',
			citations,
			new Map([["S1", citations[0].key]]),
		);
		expect(html).not.toMatch(/<script|onload|https:\/\/e\.com|100vh/);
		expect(html).toContain(`<a class="cite" href="#ref-${citations[0].key}"`);
		expect(html).toContain(`<li id="ref-${citations[0].key}">`);
		expect(html).toContain("参考文献");
	});

	it("neutralizes slash-separated handlers, unquoted js URLs and protocol-relative assets", () => {
		const html = sanitizeReportHtml(
			'<svg/onload=alert(1)><image href="//evil/x.png"/></svg><a href=javascript:alert(1)>x</a><img alt=">" onerror="y()" src="//cdn/x.png"><div style="background:url(//h/a.png)">one = two</div><a href="https://doi.org/1">ok</a><a href="https://x.org/a/one=1">q</a>',
		);
		expect(html).not.toMatch(
			/onload|onerror|javascript:|\/\/evil|\/\/cdn|\/\/h\//,
		);
		expect(html).toContain("one = two");
		expect(html).toContain('href="https://doi.org/1"');
		expect(html).toContain('<a href="https://x.org/a/one=1">q</a>');
	});
});

describe("Paper Survey seed context", () => {
	it("keeps only the Introduction including its subsections", () => {
		const md = [
			"# Title",
			"Abstract text.",
			"## 1 Introduction",
			"Intro body.",
			"### 1.1 Contributions",
			"We contribute.",
			"## 2 Related Work",
			"Should not appear.",
		].join("\n");
		const intro = extractIntroduction(md);
		expect(intro).toContain("Intro body.");
		expect(intro).toContain("We contribute.");
		expect(intro).not.toContain("Should not appear");
		expect(extractIntroduction("# Title\nNo sections")).toBeNull();
	});

	it("stops plain-text PDF bodies at the next numbered section", () => {
		const md = "1 INTRODUCTION\nBody line.\n2 BACKGROUND\nLater.";
		expect(extractIntroduction(md)).toBe("Body line.");
		expect(
			extractIntroduction("## 1 引言\n中文引言。\n## 2 相关工作\n不应出现"),
		).toBe("中文引言。");
	});

	it("extracts TeX Introduction inline, strips floats/macros/comments and stops at next section", () => {
		const tex = [
			"\\documentclass{article}",
			"\\begin{document}",
			"\\section{Introduction}\\label{sec:intro}",
			"% full-line comment",
			"Fuzzers reach \\textbf{95\\% coverage} on \\emph{real \\textit{targets}}~\\citep[see][]{afl2016}. % trailing comment",
			"\\begin{figure*}[t]\\caption{Hidden figure}\\end{figure*}",
			"\\begin{table}[h]\\caption{Hidden table}\\end{table}",
			"\\subsection{Contributions}",
			"As shown in Section~\\ref{sec:method} and Eq.~\\eqref{eq:loss}, we propose X.",
			"\\subsubsection{Scope}",
			"Scoped details.",
			"\\section{Related Work}",
			"Must not leak.",
			"\\end{document}",
		].join("\n");
		const intro = extractTexIntroduction(new Map([["main.tex", tex]]));
		expect(intro).toContain("Fuzzers reach 95% coverage on real targets.");
		expect(intro).toContain("### Contributions");
		expect(intro).toContain("#### Scope");
		expect(intro).toContain("Scoped details.");
		expect(intro).not.toMatch(
			/Hidden figure|Hidden table|trailing comment|Must not leak|\\label|\\citep|\\ref|\\eqref|\\textbf/,
		);

		const cjk = extractTexIntroduction(
			new Map([
				[
					"paper.tex",
					"\\begin{document}\\section*{引言}\n中文导论内容。\n\\end{document}",
				],
			]),
		);
		expect(cjk).toBe("中文导论内容。");
	});

	it("expands \\input and \\include up to depth 2 and falls back to standalone intro.tex", () => {
		const expanded = extractTexIntroduction(
			new Map([
				[
					"main.tex",
					"\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\include{sections/related.tex}\n\\end{document}",
				],
				[
					"sections/intro.tex",
					"\\section{Introduction}\nLead paragraph.\n\\input{sections/contrib}",
				],
				[
					"sections/contrib.tex",
					"\\subsection{Key Ideas}\nDepth-two contribution.\n\\input{sections/too_deep}",
				],
				["sections/too_deep.tex", "Depth-three should not expand."],
				["sections/related.tex", "\\section{Related Work}\nPrior systems."],
			]),
		);
		expect(expanded).toContain("Lead paragraph.");
		expect(expanded).toContain("Depth-two contribution.");
		expect(expanded).not.toContain("Depth-three should not expand.");
		expect(expanded).not.toContain("Prior systems.");

		const fallback = extractTexIntroduction(
			new Map([
				[
					"main.tex",
					"\\documentclass{article}\\begin{document}\\section{Method}Only method.\\end{document}",
				],
				[
					"sections/01-introduction.tex",
					"Standalone \\emph{intro} prose.\n\\subsection{Motivation}\nWhy it matters.",
				],
			]),
		);
		expect(fallback).toContain("Standalone intro prose.");
		expect(fallback).toContain("Why it matters.");
		expect(fallback).not.toContain("Only method.");
	});
});

function makeLibraryPaper(
	overrides: Partial<PaperMetadata> &
		Pick<PaperMetadata, "id" | "path" | "title">,
): PaperMetadata {
	return {
		type: "other",
		authors: ["Alice Smith"],
		year: 2024,
		tags: [],
		status: "completed",
		is_read: false,
		added_at: "",
		updated_at: "",
		...overrides,
	};
}

describe("Paper Survey library-first citation deduplication", () => {
	const libPaper = makeLibraryPaper({
		id: "2401.01234",
		path: "papers/smith-2024-fuzzing",
		title: "Coverage‐Guided Fuzzing: A New Look",
		authors: ["Alice Smith", "Bob Jones"],
		year: 2024,
		arxiv_id: "2401.01234v2",
		bibtex_key: "smith2024fuzzing",
		zotero_item_type: "preprint",
	});

	const richCollection: SurveyCitationMeta = {
		source: "collection",
		paperId: "doi:10.1145/3597503.3639123",
		title: "Coverage-Guided Fuzzing: A New Look",
		authors: ["Alice Smith", "Bob Jones"],
		year: 2024,
		venue: "Proceedings of ICSE 2024",
		doi: "10.1145/3597503.3639123",
		arxivId: "2401.01234",
		abstract: "Collection abstract.",
		upstreamBibtex:
			"@inproceedings{DBLP:conf/icse/SmithJ24,\n  title = {Coverage-Guided Fuzzing: A New Look},\n  booktitle = {ICSE},\n  year = {2024},\n}",
		entryType: "inproceedings",
		volume: "1",
		issue: "2",
		pages: "10-22",
	};

	it("upgrades Collection/external citations matching Library by arXiv, DOI, or title", () => {
		const byArxiv = mergeCitationWithLibrary(richCollection, [libPaper]);
		expect(byArxiv).toMatchObject({
			source: "library",
			libraryPath: "papers/smith-2024-fuzzing",
			preferredKey: "smith2024fuzzing",
			venue: "Proceedings of ICSE 2024",
			doi: "10.1145/3597503.3639123",
			arxivId: "2401.01234v2",
			abstract: "Collection abstract.",
			upstreamBibtex: richCollection.upstreamBibtex,
			volume: "1",
			issue: "2",
			pages: "10-22",
		});

		const doiLib = makeLibraryPaper({
			id: "p2",
			path: "papers/doi-paper",
			title: "Different Short Title",
			doi: "10.1145/3597503.3639123",
			bibtex_key: "myDoiKey",
		});
		const byDoi = mergeCitationWithLibrary(
			{
				source: "external",
				title: "Unnormalized Variant",
				authors: ["Alice Smith"],
				doi: "https://doi.org/10.1145/3597503.3639123",
			},
			[doiLib],
		);
		expect(byDoi.source).toBe("library");
		expect(byDoi.libraryPath).toBe("papers/doi-paper");
		expect(byDoi.preferredKey).toBe("myDoiKey");

		const byTitle = mergeCitationWithLibrary(
			{
				source: "external",
				title: "coverage guided fuzzing a new look",
				authors: ["A. Smith"],
			},
			[libPaper],
		);
		expect(byTitle.source).toBe("library");
		expect(byTitle.libraryPath).toBe("papers/smith-2024-fuzzing");
		expect(byTitle.preferredKey).toBe("smith2024fuzzing");
	});

	it("deduplicates colliding S1 seed and Collection ID in either order while keeping preferredKey", () => {
		const seedMeta: SurveyCitationMeta = {
			source: "library",
			paperId: libPaper.id,
			libraryPath: libPaper.path,
			preferredKey: libPaper.bibtex_key,
			title: libPaper.title,
			authors: libPaper.authors,
			year: libPaper.year ?? undefined,
			arxivId: libPaper.arxiv_id ?? undefined,
		};
		const metas = new Map<string, SurveyCitationMeta>([
			["S1", seedMeta],
			["doi:10.1145/3597503.3639123", richCollection],
		]);

		for (const order of [
			["S1", "doi:10.1145/3597503.3639123"],
			["doi:10.1145/3597503.3639123", "S1"],
		]) {
			const { unique, idToIndex } = dedupeSurveyCitations(order, metas, [
				libPaper,
			]);
			expect(unique).toHaveLength(1);
			expect(idToIndex.get("S1")).toBe(0);
			expect(idToIndex.get("doi:10.1145/3597503.3639123")).toBe(0);
			const citations = buildCitations(unique);
			expect(citations[0]).toMatchObject({
				key: "smith2024fuzzing",
				source: "library",
				libraryPath: "papers/smith-2024-fuzzing",
				venue: "Proceedings of ICSE 2024",
				doi: "10.1145/3597503.3639123",
				abstract: "Collection abstract.",
			});
			expect(
				citations[0].bibtex.startsWith("@inproceedings{smith2024fuzzing,"),
			).toBe(true);
		}
	});
});
