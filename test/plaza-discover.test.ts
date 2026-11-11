import { describe, expect, it } from "vitest";
import type { CollectionPaperItem } from "@/lib/plaza/collection";
import {
	applyCollectionToolOutputToSession,
	type DeepDiscoverSession,
} from "@/lib/plaza/deep-discover-store";
import {
	parseBooleanSearchQuery,
	searchCollectionFast,
} from "@/lib/plaza/paper-search";

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

	it("updates sampled pool, curated groups, follow-up pills, and preserves pinned papers in Deep Search", () => {
		const initial: DeepDiscoverSession = {
			id: "deep_1",
			title: "Multi-agent testing",
			createdAt: "2026-04-01T00:00:00Z",
			updatedAt: "2026-04-01T00:00:00Z",
			agentId: "codex",
			modelId: null,
			providerSessionId: null,
			messages: [],
			curatedGroups: [],
			pinnedIds: ["arxiv:2603.00001"],
			sampledIds: [],
		};

		// Turn 1: collection_search(mode="random_sample")
		const afterSample = applyCollectionToolOutputToSession(
			initial,
			"mcp__agentero-collection__collection_search",
			{
				stdout: JSON.stringify({
					mode: "random_sample",
					totalMatched: 42,
					returnedCount: 2,
					items: [{ id: "arxiv:2603.00001" }, { id: "doi:10.1145/icse-2" }],
				}),
			},
		);
		expect(afterSample.session.sampledIds).toEqual([
			"arxiv:2603.00001",
			"doi:10.1145/icse-2",
		]);

		// Turn 1: collection_curate(mode="replace")
		const afterCurate1 = applyCollectionToolOutputToSession(
			afterSample.session,
			"collection_curate",
			{
				mode: "replace",
				groups: [
					{
						label: "Multi-Agent Repair",
						items: [
							{ id: "arxiv:2603.00001", reason: "Core repair workflow" },
							{ id: "doi:10.1145/icse-2", reason: "CCF-A benchmark" },
						],
					},
				],
				suggestedFollowUps: [
					"Zoom into multi-agent repair",
					"Snowball citations of ICSE paper",
				],
			},
		);
		expect(afterCurate1.suggestedFollowUps).toEqual([
			"Zoom into multi-agent repair",
			"Snowball citations of ICSE paper",
		]);
		expect(afterCurate1.session.curatedGroups).toHaveLength(1);

		// Turn 2: collection_curate(mode="replace") with a new group must keep pinned arxiv:2603.00001
		const afterCurate2 = applyCollectionToolOutputToSession(
			afterCurate1.session,
			"collection_curate",
			{
				mode: "replace",
				groups: [
					{
						label: "Snowballed Lineage",
						items: [{ id: "doi:10.1145/fse-9", reason: "Co-cited 2026 work" }],
					},
				],
			},
		);
		expect(afterCurate2.session.curatedGroups).toHaveLength(2);
		expect(afterCurate2.session.curatedGroups[0]?.label).toBe("Pinned");
		expect(afterCurate2.session.curatedGroups[0]?.items[0]?.id).toBe(
			"arxiv:2603.00001",
		);
		expect(afterCurate2.session.curatedGroups[1]?.label).toBe(
			"Snowballed Lineage",
		);
	});
});
