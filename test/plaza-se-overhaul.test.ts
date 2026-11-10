import { describe, expect, it } from "vitest";
import { PLAZA_SOURCES } from "@/lib/plaza";
import {
	type CollectionPaperItem,
	DEFAULT_ARXIV_CATEGORIES,
	DEFAULT_COLLECTION_VENUES,
	parseArxivAtomXml,
	parseResearchrHtml,
	saveCollectionState,
} from "@/lib/plaza/collection";
import { ARXIV_FEED_CHIPS } from "@/lib/plaza/feeds";
import {
	applyGrillOption,
	type DeepSearchSession,
	dedupeDiscoverPapers,
} from "@/lib/plaza/paper-search";
import {
	pushFromCollection,
	saveRecommendPoolState,
	scorePaperAgainstKeywords,
} from "@/lib/plaza/recommend-pool";

describe("Plaza AI & SE overhaul", () => {
	it("sets default arXiv categories to cs.SE, cs.CR, cs.PL, cs.AI", () => {
		expect(DEFAULT_ARXIV_CATEGORIES).toEqual([
			"cs.SE",
			"cs.CR",
			"cs.PL",
			"cs.AI",
		]);
		expect(ARXIV_FEED_CHIPS).toEqual(["cs.SE", "cs.CR", "cs.PL", "cs.AI"]);
	});

	it("exposes the 4 Plaza modules in order: collection, discover, arxiv-rec, ccf-deadlines", () => {
		expect(PLAZA_SOURCES.map((s) => s.id)).toEqual([
			"collection",
			"discover",
			"arxiv-rec",
			"ccf-deadlines",
		]);
	});

	it("includes ASE, ICSE, FSE, ISSTA, PLDI, TOSEM, and TSE in default 2026 venues", () => {
		const ids = DEFAULT_COLLECTION_VENUES.map((v) => v.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				"ase-2026",
				"icse-2026",
				"fse-2026",
				"issta-2026",
				"pldi-2026",
				"tosem-2026",
				"tse-2026",
			]),
		);
	});

	it("parses 2026 arXiv Atom XML and drops pre-2026 entries when 2026 items exist", () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2603.12345v1</id>
    <published>2026-03-15T10:00:00Z</published>
    <title>LLM-Guided Fuzzing for Rust Compiler Bugs</title>
    <summary>We propose an automated fuzzing technique for Rust compilers.</summary>
    <author><name>Alice Smith</name></author>
    <arxiv:primary_category term="cs.SE"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2512.00001v1</id>
    <published>2025-12-30T10:00:00Z</published>
    <title>Old 2025 Paper</title>
    <summary>Should be filtered out by filterYear=2026.</summary>
  </entry>
</feed>`;
		const items = parseArxivAtomXml(xml, 2026);
		expect(items).toHaveLength(1);
		expect(items[0]?.arxivId).toBe("2603.12345");
		expect(items[0]?.sourceLabel).toBe("cs.SE");
	});

	it("extracts accepted papers from conf.researchr.org #event-overview HTML while ignoring schedule noise and award badges", () => {
		const html = `
<div class="schedule-modal">
  <table class="table-condensed">
    <tr><td><a href="#" data-event-modal="yoga-1">ICSE Yoga</a></td></tr>
  </table>
</div>
<div id="event-overview">
  <table>
    <tr>
      <td>
        <a href="#" data-event-modal="event-1">Automated Program Repair via Neuro-Symbolic Execution<span class="pull-right">Distinguished Paper</span></a>
        <a href="https://arxiv.org/abs/2602.09876" class="publication-link">Preprint</a>
        <div class="performers"><a href="/profile/1">Jane Doe</a>, <a href="/profile/2">John Roe</a></div>
      </td>
    </tr>
  </table>
</div>`;
		const venue =
			DEFAULT_COLLECTION_VENUES.find((v) => v.id === "icse-2026") ??
			DEFAULT_COLLECTION_VENUES[0];
		if (!venue) throw new Error("Missing venue");
		const papers = parseResearchrHtml(html, venue);
		expect(papers).toHaveLength(1);
		expect(papers[0]?.title).toBe(
			"Automated Program Repair via Neuro-Symbolic Execution",
		);
		expect(papers[0]?.authors).toEqual(["Jane Doe", "John Roe"]);
		expect(papers[0]?.arxivId).toBe("2602.09876");
		expect(papers[0]?.sourceLabel).toBe("ICSE 2026");
	});

	it("deduplicates discovered papers across sources and merges DOIs/arXiv IDs", () => {
		const deduped = dedupeDiscoverPapers([
			{
				id: "dblp:1",
				title: "Greybox Fuzzing for Smart Contracts",
				authors: ["Alice"],
				abstract: "",
				year: 2026,
				venue: "ICSE",
				source: "dblp",
				sources: ["dblp"],
				url: "https://doi.org/10.1145/12345",
				pdfUrl: "",
				doi: "10.1145/12345",
				arxivId: "",
				citationCount: 2,
				matchedQueries: ["fuzzing"],
			},
			{
				id: "arxiv:2601.00001",
				title: "Greybox Fuzzing for Smart Contracts!",
				authors: ["Alice", "Bob"],
				abstract: "Full abstract from arXiv.",
				year: 2026,
				venue: "arXiv",
				source: "arxiv",
				sources: ["arxiv"],
				url: "https://arxiv.org/abs/2601.00001",
				pdfUrl: "https://arxiv.org/pdf/2601.00001.pdf",
				doi: "",
				arxivId: "2601.00001",
				citationCount: 5,
				matchedQueries: ["fuzzing"],
			},
		]);
		expect(deduped).toHaveLength(1);
		expect(deduped[0]?.doi).toBe("10.1145/12345");
		expect(deduped[0]?.arxivId).toBe("2601.00001");
		expect(deduped[0]?.abstract).toBe("Full abstract from arXiv.");
	});

	it("refines split queries step-by-step in Grill-Me Deep Search session", () => {
		const firstOption = {
			id: "se-focus",
			label: "(Recommended) SE & Program Analysis",
			addedQueries: ["LLM vulnerability repair static analysis"],
			recommended: true,
		};
		const session: DeepSearchSession = {
			originalQuery: "LLM vulnerability repair",
			probeSummary: "Initial probe",
			probePreviewPapers: [],
			splitQueries: ["LLM vulnerability repair"],
			stepIndex: 0,
			steps: [
				{
					id: "granularity",
					stepNumber: 1,
					totalSteps: 1,
					question: "Target scope?",
					options: [firstOption],
				},
			],
			answers: [],
			readyToExecute: false,
		};
		const next = applyGrillOption(session, firstOption);
		expect(next.readyToExecute).toBe(true);
		expect(next.splitQueries).toContain(
			"LLM vulnerability repair static analysis",
		);
	});

	it("matches keywords and never repeats previously pushed papers in Paper Recommend", async () => {
		const firstPaper: CollectionPaperItem = {
			id: "arxiv:2601.11111",
			title: "Directed Fuzzing with Large Language Models",
			authors: ["A"],
			abstract: "Combines LLM reasoning with coverage-guided fuzzing.",
			publishedAt: "2026-02-10T00:00:00Z",
			year: 2026,
			sourceType: "arxiv",
			sourceLabel: "cs.SE",
			categories: ["cs.SE"],
			url: "https://arxiv.org/abs/2601.11111",
			arxivId: "2601.11111",
		};
		const secondPaper: CollectionPaperItem = {
			id: "venue:tosem-2026:2",
			title: "Formal Verification of Rust Unsafe Blocks",
			authors: ["B"],
			abstract: "Published in TOSEM 2026.",
			publishedAt: "2026-03-01T00:00:00Z",
			year: 2026,
			sourceType: "venue",
			sourceLabel: "TOSEM 2026",
			categories: ["TOSEM 2026"],
			url: "https://doi.org/10.1145/99999",
		};
		const pool: CollectionPaperItem[] = [firstPaper, secondPaper];

		const scored = scorePaperAgainstKeywords(firstPaper, [
			{ id: "k1", term: "LLM", enabled: true },
			{ id: "k2", term: "Fuzzing", enabled: true },
		]);
		expect(scored.matchedKeywords).toEqual(["LLM", "Fuzzing"]);
		expect(scored.score).toBeGreaterThan(3);

		saveCollectionState({
			categories: ["cs.AI", "cs.CR", "cs.PL", "cs.SE"],
			venues: [...DEFAULT_COLLECTION_VENUES],
			items: pool,
			lastRefreshedAt: "2026-03-10T00:00:00Z",
			latestArxiv: null,
		});
		saveRecommendPoolState({
			keywords: [
				{ id: "k1", term: "LLM", enabled: true },
				{ id: "k2", term: "Fuzzing", enabled: true },
				{ id: "k3", term: "Formal Verification", enabled: true },
			],
			recentBatchId: null,
			history: [],
			pushedIds: [],
			lastPushedAt: null,
		});

		const firstPush = await pushFromCollection({
			maxBatchSize: 1,
			ensureCollectionLoaded: false,
		});
		expect(firstPush.newlyPushedCount).toBe(1);
		expect(firstPush.state.history[0]?.id).toBe("arxiv:2601.11111");
		expect(firstPush.state.pushedIds).toContain("arxiv:2601.11111");

		// Second push must NOT repeat arxiv:2601.11111 and must pick venue:tosem-2026:2
		const secondPush = await pushFromCollection({
			maxBatchSize: 1,
			ensureCollectionLoaded: false,
		});
		expect(secondPush.newlyPushedCount).toBe(1);
		expect(secondPush.state.history[0]?.id).toBe("venue:tosem-2026:2");
		expect(secondPush.state.history).toHaveLength(2);
	});
});
