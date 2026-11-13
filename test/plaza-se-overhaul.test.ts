import { describe, expect, it, vi } from "vitest";
import { PLAZA_SOURCES } from "@/lib/plaza";
import {
	type CollectionPaperItem,
	DEFAULT_ARXIV_CATEGORIES,
	DEFAULT_COLLECTION_VENUES,
	derivePaperKeywords,
	formatPaperBibtex,
	formatPaperCitationText,
	isPaperMetadataComplete,
	isPlaceholderAbstract,
	normalizePaperKeywords,
	parseArxivAtomXml,
	parseArxivRssXml,
	parseResearchrHtml,
	reconstructOpenAlexAbstract,
	resetCollectionMemoryForTests,
	VENUE_SPECS,
} from "@/lib/plaza/collection";
import {
	applyCollectionToolOutputToSession,
	type DeepDiscoverSession,
} from "@/lib/plaza/deep-discover-store";
import { ARXIV_FEED_CHIPS } from "@/lib/plaza/feeds";
import {
	parseBooleanSearchQuery,
	searchCollectionFast,
} from "@/lib/plaza/paper-search";
import {
	DEFAULT_WORD_CLOUD_TOP_N,
	recommendNextFromCollection,
	saveRecommendPoolState,
	scorePaperAgainstKeywords,
} from "@/lib/plaza/recommend-pool";
import { installMockCollectionIpc } from "./helpers/mock-collection-ipc";

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));

describe("Plaza AI & SE overhaul", () => {
	it("sets default Collection arXiv categories to cs.SE, cs.CR, cs.PL (cs.AI off by default) while keeping cs.AI in feed chips", () => {
		expect(DEFAULT_ARXIV_CATEGORIES).toEqual(["cs.SE", "cs.CR", "cs.PL"]);
		expect(ARXIV_FEED_CHIPS).toEqual(["cs.SE", "cs.CR", "cs.PL", "cs.AI"]);
	});

	it("exposes the 5 Plaza modules in order: collection, discover, survey, arxiv-rec, ccf-deadlines", () => {
		expect(PLAZA_SOURCES.map((s) => s.id)).toEqual([
			"collection",
			"discover",
			"survey",
			"arxiv-rec",
			"ccf-deadlines",
		]);
	});

	it("configures all 28 built-in 2026 venues with official URLs and tracks across PL/SE, CR, and AI", () => {
		expect(VENUE_SPECS).toHaveLength(28);
		expect(DEFAULT_COLLECTION_VENUES).toHaveLength(28);

		for (const v of DEFAULT_COLLECTION_VENUES) {
			expect(v.url).toMatch(/^https:\/\//);
			expect(v.url).not.toContain("dblp");
			expect(Array.isArray(v.tracks)).toBe(true);
			if (v.kind === "journal") {
				expect(v.tracks).toEqual([]);
			} else {
				expect(v.tracks.length).toBeGreaterThan(0);
			}
			expect(v.name).toContain("2026");
		}

		const plseConfA = DEFAULT_COLLECTION_VENUES.filter(
			(v) =>
				v.domain === "PL/SE" &&
				v.kind === "conference" &&
				v.ccfRank === "CCF-A",
		).map((v) => v.id);
		expect(plseConfA).toEqual([
			"ase-2026",
			"icse-2026",
			"issta-2026",
			"fse-2026",
			"pldi-2026",
			"popl-2026",
			"oopsla-2026",
		]);

		const plseConfB = DEFAULT_COLLECTION_VENUES.filter(
			(v) =>
				v.domain === "PL/SE" &&
				v.kind === "conference" &&
				v.ccfRank === "CCF-B",
		).map((v) => v.id);
		expect(plseConfB).toEqual([
			"ecoop-2026",
			"icpc-2026",
			"re-2026",
			"saner-2026",
			"icsme-2026",
			"sas-2026",
			"esem-2026",
			"issre-2026",
		]);

		const plseJournals = DEFAULT_COLLECTION_VENUES.filter(
			(v) => v.domain === "PL/SE" && v.kind === "journal",
		).map((v) => v.id);
		expect(plseJournals).toEqual([
			"tse-2026",
			"tosem-2026",
			"ase-journal-2026",
			"ese-2026",
		]);

		const crConfs = DEFAULT_COLLECTION_VENUES.filter(
			(v) => v.domain === "CR",
		).map((v) => v.id);
		expect(crConfs).toEqual([
			"ccs-2026",
			"sp-2026",
			"usenix-sec-2026",
			"ndss-2026",
		]);

		const aiConfs = DEFAULT_COLLECTION_VENUES.filter(
			(v) => v.domain === "AI",
		).map((v) => v.id);
		expect(aiConfs).toEqual([
			"aaai-2026",
			"neurips-2026",
			"acl-2026",
			"iclr-2026",
			"icml-2026",
		]);
	});

	it("reconstructs OpenAlex abstracts, rejects placeholder abstracts, and formats keywords & citations", () => {
		const abstract = reconstructOpenAlexAbstract({
			We: [0],
			present: [1],
			a: [2],
			static: [3],
			analysis: [4],
			fuzzer: [5],
			for: [6],
			Rust: [7],
			compilers: [8],
			with: [9],
			soundness: [10],
			guarantees: [11],
		});
		expect(abstract).toBe(
			"We present a static analysis fuzzer for Rust compilers with soundness guarantees",
		);
		expect(isPlaceholderAbstract("ICSE 2026 · ICSE", "ICSE 2026")).toBe(true);
		expect(isPlaceholderAbstract(abstract, "ICSE 2026")).toBe(false);

		const noUpstreamKeywords = derivePaperKeywords(
			"Directed Fuzzing for Smart Contracts via Static Analysis",
			abstract,
			["cs.SE"],
		);
		expect(noUpstreamKeywords).toEqual([]);

		const keywords = derivePaperKeywords(
			"Directed Fuzzing for Smart Contracts via Static Analysis",
			abstract,
			["cs.SE"],
			["Directed Fuzzing", "Smart Contract Verification", "Computer Science"],
		);
		expect(keywords).toEqual([
			"Directed Fuzzing",
			"Smart Contract Verification",
		]);

		// Collapses shared-word synonyms on the same paper into a single canonical keyword
		expect(
			normalizePaperKeywords([
				"Defect Detection",
				"Vulnerability Detection",
				"Bug Detection",
				"LLM Agents; Agentic AI",
				"Computer Science",
				"cs.SE",
			]),
		).toEqual(["Vulnerability Detection", "AI Agent"]);

		const sampleItem: CollectionPaperItem = {
			id: "doi:10.1145/3770000",
			title: "Directed Fuzzing for Smart Contracts",
			authors: ["Alice Smith", "Bob Jones"],
			abstract,
			publishedAt: "2026-04-01T00:00:00Z",
			year: 2026,
			sourceType: "venue",
			sourceLabel: "ISSTA 2026",
			venueKind: "conference",
			venueFull: "Proceedings of ISSTA 2026",
			categories: ["ISSTA 2026"],
			url: "https://doi.org/10.1145/3770000",
			doi: "10.1145/3770000",
			citationCount: 12,
			keywords,
		};
		expect(formatPaperCitationText(sampleItem)).toContain(
			"Alice Smith, Bob Jones. (2026). Directed Fuzzing for Smart Contracts.",
		);
		expect(formatPaperBibtex(sampleItem)).toContain(
			"@inproceedings{smith2026directed,",
		);
		expect(isPaperMetadataComplete(sampleItem)).toBe(true);
		expect(isPaperMetadataComplete({ ...sampleItem, keywords: [] })).toBe(
			false,
		);
		expect(
			isPaperMetadataComplete({
				...sampleItem,
				abstract: "ISSTA 2026 · ISSTA",
			}),
		).toBe(false);
	});

	it("parses fast rss.arxiv.org XML feeds with complete abstracts and derived keywords", () => {
		const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <item>
      <title>Symbolic Execution for LLM Agents (arXiv:2604.01234v1 [cs.SE])</title>
      <link>https://arxiv.org/abs/2604.01234</link>
      <description>arXiv:2604.01234v1 Announce Type: new 
Abstract: We introduce a symbolic execution engine tailored for verifying multi-agent LLM tool invocations.</description>
      <dc:creator>Ada Lovelace, Alan Turing</dc:creator>
      <pubDate>Tue, 07 Apr 2026 00:00:00 -0400</pubDate>
      <category>cs.SE</category>
      <category>cs.AI</category>
    </item>
  </channel>
</rss>`;
		const parsed = parseArxivRssXml(rss, "cs.SE", ["cs.SE", "cs.AI"]);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.arxivId).toBe("2604.01234");
		expect(parsed[0]?.abstract).toBe(
			"We introduce a symbolic execution engine tailored for verifying multi-agent LLM tool invocations.",
		);
		expect(parsed[0]?.keywords).toEqual([]);
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

	it("searches strictly within Paper Collection using boolean syntax and combinable CCF/Venue/Date filters in Fast Search", () => {
		const pool: CollectionPaperItem[] = [
			{
				id: "doi:10.1145/icse-1",
				title: "Multi-Agent Program Repair for Rust Memory Bugs",
				authors: ["Alice"],
				abstract:
					"We present an autonomous multi-agent workflow for repairing memory safety bugs.",
				publishedAt: "2026-03-20T00:00:00Z",
				year: 2026,
				sourceType: "venue",
				sourceLabel: "ICSE 2026",
				venueId: "icse-2026",
				venueKind: "conference",
				venueDomain: "PL/SE",
				ccfRank: "CCF-A",
				categories: ["ICSE 2026"],
				url: "https://doi.org/10.1145/icse-1",
				doi: "10.1145/icse-1",
				citationCount: 15,
				keywords: ["Multi-Agent", "Program Repair"],
			},
			{
				id: "arxiv:2603.00999",
				title: "Symbolic Execution and Greybox Fuzzing Survey",
				authors: ["Bob"],
				abstract: "A comprehensive survey of symbolic execution and fuzzing.",
				publishedAt: "2026-03-25T00:00:00Z",
				year: 2026,
				sourceType: "arxiv",
				sourceLabel: "cs.SE",
				categories: ["cs.SE"],
				url: "https://arxiv.org/abs/2603.00999",
				arxivId: "2603.00999",
				citationCount: 4,
				keywords: ["Symbolic Execution", "Fuzzing"],
			},
			{
				id: "doi:10.1145/saner-2",
				title: "Multi-Agent Test Generation in Industry",
				authors: ["Carol"],
				abstract: "Evaluates multi-agent test generation without survey noise.",
				publishedAt: "2026-01-10T00:00:00Z",
				year: 2026,
				sourceType: "venue",
				sourceLabel: "SANER 2026",
				venueId: "saner-2026",
				venueKind: "conference",
				venueDomain: "PL/SE",
				ccfRank: "CCF-B",
				categories: ["SANER 2026"],
				url: "https://doi.org/10.1145/saner-2",
				doi: "10.1145/saner-2",
				citationCount: 6,
				keywords: ["Multi-Agent", "Software Testing"],
			},
		];

		const parsed = parseBooleanSearchQuery('"multi-agent" OR fuzzing -survey');
		expect(parsed.branches).toHaveLength(2);

		// Negation `-survey` drops arxiv:2603.00999; combinable CCF-A + arxiv drops CCF-B SANER
		const filtered = searchCollectionFast(
			pool,
			'"multi-agent" OR fuzzing -survey',
			{
				ccfRanks: ["CCF-A", "arxiv"],
			},
		);
		expect(filtered.totalMatched).toBe(1);
		expect(filtered.items[0]?.paper.id).toBe("doi:10.1145/icse-1");

		// Custom date range filter
		const marchOnly = searchCollectionFast(pool, "", {
			timePreset: "custom",
			dateFrom: "2026-03-01",
			dateTo: "2026-03-31",
			sort: "citations",
		});
		expect(marchOnly.items.map((x) => x.paper.id)).toEqual([
			"doi:10.1145/icse-1",
			"arxiv:2603.00999",
		]);
	});

	it("tracks This turn / History / Selected in the Deep Search tray across turns", () => {
		const turn = (id: string) => ({
			id,
			role: "assistant" as const,
			content: "",
			createdAt: "2026-04-01T00:00:00Z",
		});
		const initial: DeepDiscoverSession = {
			id: "deep_1",
			title: "Multi-agent testing",
			createdAt: "2026-04-01T00:00:00Z",
			updatedAt: "2026-04-01T00:00:00Z",
			agentId: "codex",
			modelId: null,
			providerSessionId: null,
			messages: [turn("ast_1")],
			tray: [],
		};

		// Turn 1: two curate calls merge; `keep: true` selects a paper.
		const afterA = applyCollectionToolOutputToSession(
			initial,
			"mcp__agentero-collection__collection_curate",
			{
				structuredContent: {
					groups: [
						{
							label: "Multi-Agent Repair",
							items: [
								{
									id: "arxiv:2603.00001",
									reason: "Core repair workflow",
									keep: true,
								},
							],
						},
					],
					suggestedFollowUps: ["Zoom into multi-agent repair"],
					unkeepIds: [],
					droppedUnknownIds: [],
				},
			},
		);
		expect(afterA.suggestedFollowUps).toEqual(["Zoom into multi-agent repair"]);
		const afterB = applyCollectionToolOutputToSession(
			afterA.session,
			"collection_curate",
			undefined,
			{
				groups: [
					{
						label: "Benchmarks",
						items: [{ id: "doi:10.1145/icse-2", reason: "CCF-A benchmark" }],
					},
				],
			},
		);
		expect(
			afterB.session.tray.map((e) => [e.id, e.turnId, Boolean(e.kept)]),
		).toEqual([
			["arxiv:2603.00001", "ast_1", true],
			["doi:10.1145/icse-2", "ast_1", false],
		]);

		// Turn 2: the benchmark paper re-surfaces; the kept one moves to History, then is unkept.
		const turn2 = {
			...afterB.session,
			messages: [...afterB.session.messages, turn("ast_2")],
		};
		const afterC = applyCollectionToolOutputToSession(
			turn2,
			"collection_curate",
			{
				groups: [
					{
						label: "Still relevant",
						items: [{ id: "doi:10.1145/icse-2" }, { id: "doi:10.1145/fse-9" }],
					},
				],
				unkeepIds: ["arxiv:2603.00001"],
			},
		);
		const byId = new Map(afterC.session.tray.map((e) => [e.id, e]));
		expect(byId.get("arxiv:2603.00001")).toMatchObject({ turnId: "ast_1" });
		expect(byId.get("arxiv:2603.00001")?.kept).toBeFalsy();
		expect(byId.get("doi:10.1145/icse-2")).toMatchObject({
			turnId: "ast_2",
			group: "Still relevant",
			reason: "CCF-A benchmark",
		});
		expect(byId.get("doi:10.1145/fse-9")?.turnId).toBe("ast_2");
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
		expect(scored.matchedKeywords).toEqual(["Large Language Model", "Fuzzing"]);
		expect(scored.score).toBeGreaterThan(3);

		resetCollectionMemoryForTests();
		const ipc = installMockCollectionIpc({
			categories: ["cs.AI", "cs.CR", "cs.PL", "cs.SE"],
			venues: [...DEFAULT_COLLECTION_VENUES],
			items: pool,
			lastRefreshedAt: "2026-03-10T00:00:00Z",
			latestArxiv: null,
		});
		try {
			await saveRecommendPoolState({
				keywords: [
					{ id: "k1", term: "LLM", enabled: true },
					{ id: "k2", term: "Fuzzing", enabled: true },
					{ id: "k3", term: "Formal Verification", enabled: true },
				],
				selectedCloudTerms: [],
				wordCloudTopN: DEFAULT_WORD_CLOUD_TOP_N,
				lastRecommendedAt: null,
			});

			const firstPush = await recommendNextFromCollection(1);
			expect(firstPush.items).toHaveLength(1);
			expect(firstPush.items[0]?.id).toBe("arxiv:2601.11111");
			expect(firstPush.items[0]?.recommendedAt).toBeTruthy();

			// Second push must NOT repeat arxiv:2601.11111 and must pick venue:tosem-2026:2
			const secondPush = await recommendNextFromCollection(1);
			expect(secondPush.items).toHaveLength(1);
			expect(secondPush.items[0]?.id).toBe("venue:tosem-2026:2");
			expect(secondPush.items[0]?.recommendedAt).toBeTruthy();
		} finally {
			ipc.restore();
			resetCollectionMemoryForTests();
		}
	});
});
