// @vitest-environment happy-dom

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollectionPaperDetailDialog } from "@/components/plaza/collection-paper-detail-dialog";
import { MAX_LINEAGE_GRAPH_NODES } from "@/components/plaza/collection-paper-lineage-section";
import { TooltipProvider } from "@/components/ui/tooltip";
import { backgroundTasksStore } from "@/lib/core/background-tasks";
import { commands } from "@/lib/core/bindings";
import {
	type CollectionPaperItem,
	clearCollection,
	ensureCollectionSummaryHydrated,
	getCollectionSummarySnapshot,
	parseArxivAtomXml,
	refreshArxivCollection,
	resetCollectionStoreForTests,
	shouldEnrichPaperOnDemand,
	updateCollectionConfig,
} from "@/lib/plaza/collection";
import { recommendNextFromCollection } from "@/lib/plaza/recommend-pool";
import { setVaultPath } from "@/lib/vault/store";
import { installMockCollectionIpc } from "./helpers/mock-collection-ipc";

const notifyErrorSpy = vi.fn();
const openPaperSpy = vi.fn();

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));

vi.mock("@/lib/core/notify", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/core/notify")>();
	return {
		...actual,
		notifyError: (...args: unknown[]) => notifyErrorSpy(...args),
	};
});

vi.mock("@/lib/workspace/navigation", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/workspace/navigation")>();
	return {
		...actual,
		openPaper: (...args: unknown[]) => openPaperSpy(...args),
	};
});

vi.mock("react-i18next", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-i18next")>();
	return {
		...actual,
		useTranslation: () => ({
			t: (key: string, opts?: Record<string, unknown>) => {
				const tail = key.split(".").pop() ?? key;
				return opts?.count !== undefined ? `${tail}:${opts.count}` : tail;
			},
			i18n: { language: "en" },
		}),
	};
});

const flush = async (cycles = 4) => {
	for (let i = 0; i < cycles; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};

function makePaper(
	overrides: Partial<CollectionPaperItem> & { id: string; title: string },
): CollectionPaperItem {
	return {
		authors: ["Alice", "Bob"],
		abstract:
			"We introduce a modular static and dynamic program analysis framework for Rust concurrency bugs with formal soundness guarantees.",
		publishedAt: "2026-03-15T00:00:00Z",
		year: 2026,
		sourceType: "venue",
		sourceLabel: "ICSE 2026",
		venueId: "icse-2026",
		venueKind: "conference",
		venueDomain: "PL/SE",
		ccfRank: "CCF-A",
		categories: ["ICSE 2026"],
		url: `https://example.org/${overrides.id}`,
		citationCount: 0,
		keywords: ["Program Analysis", "Concurrency Testing"],
		keywordSource: "maintainer_llm",
		...overrides,
	};
}

describe("Stage 2 Plaza Seed Sync, Metadata Rules, and Paper Graph Lineage UI", () => {
	let mockDb: ReturnType<typeof installMockCollectionIpc>;

	beforeEach(() => {
		notifyErrorSpy.mockClear();
		openPaperSpy.mockClear();
		backgroundTasksStore.setState({ tasks: [], expanded: false });
		setVaultPath(null);
		resetCollectionStoreForTests();
		mockDb = installMockCollectionIpc();
	});

	afterEach(() => {
		mockDb.restore();
		setVaultPath(null);
		document.body.innerHTML = "";
	});

	it("silently warms up from collection seed on cold start, skips when seedCleared, and pulls addon-cs-ai on toggle", async () => {
		const corePaper = makePaper({
			id: "doi:10.1145/core.1",
			title: "Core Seed Paper on Symbolic Fuzzing",
			doi: "10.1145/core.1",
		});
		const csAiPaper = makePaper({
			id: "arxiv:2604.01234",
			title: "Addon cs.AI Multi-Agent Planning",
			sourceType: "arxiv",
			sourceLabel: "cs.AI",
			categories: ["cs.AI"],
			arxivId: "2604.01234",
			doi: "10.48550/arxiv.2604.01234",
			venueId: undefined,
			venueKind: undefined,
			venueDomain: undefined,
			ccfRank: undefined,
		});

		mockDb.seed({
			categories: ["cs.SE", "cs.CR", "cs.PL"],
			seedShards: [
				{ id: "core-2026", kind: "core", items: [corePaper] },
				{
					id: "addon-cs-ai-2026",
					kind: "addon",
					category: "cs.AI",
					items: [csAiPaper],
				},
			],
		});

		await ensureCollectionSummaryHydrated();
		await flush(6);

		const afterColdStart = getCollectionSummarySnapshot();
		expect(afterColdStart.totalCount).toBe(1);
		expect(afterColdStart.appliedSeedIds).toEqual(["core-2026"]);
		expect(notifyErrorSpy).not.toHaveBeenCalled();

		// Enabling cs.AI triggers background sync for addon-cs-ai
		await updateCollectionConfig({
			categories: ["cs.SE", "cs.CR", "cs.PL", "cs.AI"],
		});
		await flush(6);

		const afterAddon = getCollectionSummarySnapshot();
		expect(afterAddon.totalCount).toBe(2);
		expect(afterAddon.appliedSeedIds).toEqual([
			"core-2026",
			"addon-cs-ai-2026",
		]);

		// Clearing all sets seedCleared = true and prevents automatic re-seeding
		await clearCollection("all");
		expect(getCollectionSummarySnapshot().seedCleared).toBe(true);

		const syncSpy = vi.spyOn(commands, "plazaCollectionSeedSync");
		syncSpy.mockClear();
		resetCollectionStoreForTests();
		mockDb.seed({
			seedCleared: true,
			seedShards: [{ id: "core-2026", kind: "core", items: [corePaper] }],
		});
		await ensureCollectionSummaryHydrated();
		await flush(6);
		expect(syncSpy).not.toHaveBeenCalled();
	});

	it("degrades silently without error toast or failed task when cold-start seed sync fails offline", async () => {
		vi.spyOn(commands, "plazaCollectionSeedSync").mockRejectedValueOnce(
			new Error("offline network unreachable"),
		);

		await ensureCollectionSummaryHydrated();
		await flush(6);

		expect(notifyErrorSpy).not.toHaveBeenCalled();
		expect(
			backgroundTasksStore.getState().tasks.filter((t) => t.status === "error"),
		).toHaveLength(0);
	});

	it("runs seed sync before manual arXiv incremental refresh", async () => {
		const callOrder: string[] = [];
		vi.spyOn(commands, "plazaCollectionSeedSync").mockImplementation(
			async () => {
				callOrder.push("seedSync");
				return {
					ok: true,
					data: {
						state: {
							categories: ["cs.SE"],
							venues: [],
							arxivWatermarks: {
								"cs.SE": {
									latestPublishedAt: "2026-04-10T00:00:00Z",
									latestArxivId: "2604.09999",
									lastSyncedAt: "2026-04-10T01:00:00Z",
									oldestSyncedPublishedAt: "2026-01-01T00:00:00Z",
									remoteTotal: 10,
									historyComplete: true,
								},
							},
							lastRefreshedAt: "2026-04-10T01:00:00Z",
							latestArxiv: null,
							totalCount: 1,
							arxivCount: 1,
							venueCount: 0,
							conferenceCount: 0,
							journalCount: 0,
							categoryCounts: { "cs.SE": 1 },
							seedCleared: false,
							appliedSeedIds: ["core-2026"],
						},
						appliedShards: ["core-2026"],
						importedPapers: 1,
						skipped: false,
					},
					error: null,
				};
			},
		);

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => {
				callOrder.push("arxivFetch");
				return new Response(
					`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`,
					{ status: 200 },
				);
			});

		try {
			await refreshArxivCollection({
				categories: ["cs.SE"],
				incremental: true,
			});
			expect(callOrder[0]).toBe("seedSync");
			expect(callOrder).toContain("arxivFetch");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("preserves publisher <arxiv:doi>, ignores undefined citationCount in shouldEnrichPaperOnDemand, and forwards vaultPath in Recommend", async () => {
		const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2602.05555v1</id>
    <published>2026-02-12T10:00:00Z</published>
    <title>Compiler Verification with Publisher DOI</title>
    <summary>Full abstract describing mechanized verification of compiler passes in Coq and Lean.</summary>
    <author><name>Jane Roe</name></author>
    <arxiv:doi>10.1145/3777777.3777778</arxiv:doi>
    <category term="cs.PL" />
  </entry>
</feed>`;
		const parsed = parseArxivAtomXml(atomXml, 2026, {
			defaultCategory: "cs.PL",
		});
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.doi).toBe("10.1145/3777777.3777778");

		const completeWithoutCitations = makePaper({
			id: "doi:10.1145/no-cite",
			title: "Complete Paper Without External Citation Count",
			citationCount: undefined,
			keywords: ["Formal Verification"],
		});
		expect(shouldEnrichPaperOnDemand(completeWithoutCitations)).toBe(false);

		const foundationalVaultDoi = "10.1145/vault.foundation";
		const recCandidate = makePaper({
			id: "doi:10.1145/rec.1",
			title: "Program Analysis Guided by Vault Foundations",
			doi: "10.1145/rec.1",
			keywords: ["Program Analysis"],
			rawRefs: [`doi:${foundationalVaultDoi}`],
		});
		mockDb.seed({
			items: [recCandidate],
			recommendState: {
				keywords: [{ id: "k1", term: "Program Analysis", enabled: true }],
				selectedCloudTerms: [],
				wordCloudTopN: 50,
				lastRecommendedAt: null,
			},
			vaultPapers: [
				{
					relPath: "papers/vault-foundation",
					title: "Vault Foundational Paper",
					doi: foundationalVaultDoi,
				},
			],
		});

		setVaultPath("C:/Users/Test/ResearchVault");
		const recOut = await recommendNextFromCollection(15);
		expect(recOut.items).toHaveLength(1);
		expect(recOut.items[0]?.citedVaultCount).toBe(1);
	});

	it("renders Paper Graph Lineage (Vault highlight, List <-> 3-column SVG Graph <= 25 nodes, and in-dialog Back navigation)", async () => {
		const rootPaper = makePaper({
			id: "doi:10.1145/root.paper",
			title: "Root Paper: Directed Greybox Fuzzing",
			doi: "10.1145/root.paper",
			rawRefs: Array.from({ length: 16 }, (_, i) => `doi:10.1145/ref.${i + 1}`),
		});

		const refPapers = Array.from({ length: 16 }, (_, i) =>
			makePaper({
				id: `doi:10.1145/ref.${i + 1}`,
				title: `Foundational Reference Paper #${i + 1}`,
				doi: `10.1145/ref.${i + 1}`,
				publishedAt: `2026-01-${String((i % 20) + 1).padStart(2, "0")}T00:00:00Z`,
			}),
		);

		const citingPapers = Array.from({ length: 16 }, (_, i) =>
			makePaper({
				id: `doi:10.1145/citing.${i + 1}`,
				title: `Follow-up Citing Paper #${i + 1}`,
				doi: `10.1145/citing.${i + 1}`,
				rawRefs: ["doi:10.1145/root.paper"],
				publishedAt: `2026-04-${String((i % 20) + 1).padStart(2, "0")}T00:00:00Z`,
			}),
		);

		const coCitedPeer = makePaper({
			id: "doi:10.1145/peer.1",
			title: "Co-Cited Sibling Paper",
			doi: "10.1145/peer.1",
			rawRefs: ["doi:10.1145/ref.1", "doi:10.1145/ref.2"],
		});

		mockDb.seed({
			items: [rootPaper, ...refPapers, ...citingPapers, coCitedPeer],
			vaultPapers: [
				{
					relPath: "papers/ref-1",
					title: "Foundational Reference Paper #1",
					doi: "10.1145/ref.1",
				},
			],
		});
		setVaultPath("C:/Users/Test/MyVault");

		const syncedRoot = mockDb.getRawItem(rootPaper.id) ?? rootPaper;
		let dialogOpen = true;

		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);

		root.render(
			createElement(
				TooltipProvider,
				{ delayDuration: 0 },
				createElement(CollectionPaperDetailDialog, {
					paper: syncedRoot,
					open: dialogOpen,
					imported: false,
					onOpenChange: (next) => {
						dialogOpen = next;
					},
					onImport: () => {},
				}),
			),
		);
		await flush(8);

		const lineageSection = document.querySelector("[data-lineage-section]");
		expect(lineageSection).not.toBeNull();

		// Personal Vault highlight bar renders "citesVault" and opens Vault paper on click
		const vaultBar = document.querySelector("[data-lineage-vault-matches]");
		expect(vaultBar?.textContent).toContain("citesVault");
		expect(vaultBar?.textContent).toContain("Foundational Reference Paper #1");

		// Switch to 3-column SVG Graph view and verify total nodes <= 25
		const graphBtn = document.querySelector(
			"button[aria-label='graphView']",
		) as HTMLButtonElement | null;
		expect(graphBtn).not.toBeNull();
		graphBtn?.click();
		await flush(4);

		const graphContainer = document.querySelector("[data-lineage-graph]");
		expect(graphContainer).not.toBeNull();
		const graphNodes = graphContainer?.querySelectorAll("[data-lineage-node]");
		expect(graphNodes?.length).toBeLessThanOrEqual(MAX_LINEAGE_GRAPH_NODES);
		expect(graphNodes?.length).toBe(25);

		// Click a node in the graph to navigate inside the dialog (newest 12 are shown: citing.16 .. citing.5)
		const firstCitingNode = graphContainer?.querySelector(
			"[data-lineage-node='doi:10.1145/citing.16']",
		) as HTMLButtonElement | null;
		expect(firstCitingNode).not.toBeNull();
		firstCitingNode?.click();
		await flush(8);

		expect(document.body.textContent).toContain("Follow-up Citing Paper #16");

		// Back button appears in header and restores Root Paper
		const backBtn = document.querySelector(
			"button[aria-label='back']",
		) as HTMLButtonElement | null;
		expect(backBtn).not.toBeNull();
		backBtn?.click();
		await flush(8);

		expect(document.body.textContent).toContain(
			"Root Paper: Directed Greybox Fuzzing",
		);

		// Clicking Vault match opens paper in workspace and closes dialog
		const vaultMatchBtn = document.querySelector(
			"[data-lineage-vault-matches] button",
		) as HTMLButtonElement | null;
		expect(vaultMatchBtn).not.toBeNull();
		vaultMatchBtn?.click();
		await flush(2);

		expect(openPaperSpy).toHaveBeenCalledTimes(1);
		expect(String(openPaperSpy.mock.calls[0]?.[0]).replace(/\\/g, "/")).toBe(
			"C:/Users/Test/MyVault/papers/ref-1",
		);
		expect(dialogOpen).toBe(false);

		root.unmount();
	});
});
