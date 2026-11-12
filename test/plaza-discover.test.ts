import { describe, expect, it, vi } from "vitest";
import { commands } from "@/lib/core/bindings";
import type { CollectionPaperItem } from "@/lib/plaza/collection";
import {
	applyCollectionToolOutputToSession,
	type DeepDiscoverSession,
} from "@/lib/plaza/deep-discover-store";
import {
	parseBooleanSearchQuery,
	searchCollectionFast,
	searchCollectionFastRemote,
} from "@/lib/plaza/paper-search";
import { installMockCollectionIpc } from "./helpers/mock-collection-ipc";

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));

describe("Plaza Paper Discover (Fast Search & Deep Search)", () => {
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

	it("delegates searchCollectionFastRemote to plazaCollectionSearch IPC with normalized filters, pagination, and activeFilterCount", async () => {
		const ipc = installMockCollectionIpc({
			items: [
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
					title: "Multi-Agent Symbolic Execution Survey",
					authors: ["Bob"],
					abstract: "A comprehensive survey of multi-agent symbolic execution.",
					publishedAt: "2026-03-25T00:00:00Z",
					year: 2026,
					sourceType: "arxiv",
					sourceLabel: "cs.SE",
					categories: ["cs.SE"],
					url: "https://arxiv.org/abs/2603.00999",
					arxivId: "2603.00999",
					citationCount: 4,
					keywords: ["Multi-Agent", "Symbolic Execution"],
				},
			],
		});

		try {
			const result = await searchCollectionFastRemote(
				'"multi-agent" -survey',
				{
					sourceType: "venue",
					venueDomain: "PL/SE",
					ccfRanks: ["CCF-A"],
					fields: ["title", "keywords"],
					sort: "citations",
				},
				{ limit: 50, offset: 0 },
			);

			expect(commands.plazaCollectionSearch).toHaveBeenCalledWith({
				query: '"multi-agent" -survey',
				timePreset: "all",
				dateFrom: null,
				dateTo: null,
				sourceType: "venue",
				categories: [],
				venues: [],
				venueKind: null,
				venueDomain: "PL/SE",
				ccfRanks: ["CCF-A"],
				fields: ["title", "keywords"],
				sort: "citations",
				limit: 50,
				offset: 0,
			});
			expect(result.totalMatched).toBe(1);
			expect(result.activeFilterCount).toBe(4);
			expect(result.items[0]?.paper.id).toBe("doi:10.1145/icse-1");
			expect(result.items[0]?.paper.ccfRank).toBe("CCF-A");
			expect(result.items[0]?.matchedFields).toEqual(["title", "keywords"]);
		} finally {
			ipc.restore();
		}
	});
});
