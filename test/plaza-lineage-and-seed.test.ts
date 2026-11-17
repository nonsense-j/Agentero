// @vitest-environment happy-dom

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollectionPaperDetailDialog } from "@/components/plaza/collection-paper-detail-dialog";
import { DiscoverFastView } from "@/components/plaza/discover-fast-view";
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
import {
	collectLibraryImportedKeys,
	isCollectionPaperImported,
} from "@/lib/plaza/imported";
import {
	computePaperGraphLayout,
	formatPaperGraphLabel,
} from "@/lib/plaza/paper-graph";
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

	it("renders list-only Lineage in single-paper detail dialog (no Graph View toggle, Vault highlight, and Back navigation)", async () => {
		const rootPaper = makePaper({
			id: "doi:10.1145/root.paper",
			title: "Root Paper: Directed Greybox Fuzzing",
			doi: "10.1145/root.paper",
			rawRefs: ["doi:10.1145/ref.1", "doi:10.1145/ref.2"],
		});

		const refPaper1 = makePaper({
			id: "doi:10.1145/ref.1",
			title: "Foundational Reference Paper #1",
			doi: "10.1145/ref.1",
			publishedAt: "2026-01-05T00:00:00Z",
		});

		const citingPaper = makePaper({
			id: "doi:10.1145/citing.1",
			title: "Follow-up Citing Paper #1",
			doi: "10.1145/citing.1",
			rawRefs: ["doi:10.1145/root.paper"],
			publishedAt: "2026-04-16T00:00:00Z",
		});

		mockDb.seed({
			items: [rootPaper, refPaper1, citingPaper],
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

		// Single-paper card does NOT expose a Graph View switcher or SVG graph
		expect(
			lineageSection?.querySelector("button[aria-label='graphView']"),
		).toBeNull();
		expect(document.querySelector("[data-lineage-graph]")).toBeNull();

		// Personal Vault highlight bar renders "citesVault" and opens Vault paper on click
		const vaultBar = document.querySelector("[data-lineage-vault-matches]");
		expect(vaultBar?.textContent).toContain("citesVault");
		expect(vaultBar?.textContent).toContain("Foundational Reference Paper #1");

		// Click a row in the list view to navigate inside the dialog
		const citingRow = Array.from(
			lineageSection?.querySelectorAll("button") ?? [],
		).find((btn) => btn.textContent?.includes("Follow-up Citing Paper #1"));
		expect(citingRow).toBeDefined();
		citingRow?.click();
		await flush(8);

		expect(document.body.textContent).toContain("Follow-up Citing Paper #1");

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

	it("renders Fast Search Graph View with XXX@YYY pills, Library highlight, citation + shared-ref edges, node expand, and click-to-card", async () => {
		expect(
			formatPaperGraphLabel({
				authors: ["Alice B. Smith"],
				title: "A Survey of Greybox Fuzzing",
			}),
		).toBe("Smith@Survey");
		expect(
			formatPaperGraphLabel({
				authors: ["O'Connor, Liam 0001"],
				title: "The Multi-Agent Repair Engine",
			}),
		).toBe("O'Connor@Multi-Agent");

		const layoutCheck = computePaperGraphLayout(
			[
				{ id: "n1", label: "Smith@Fuzzing" },
				{ id: "n2", label: "Chen@Symbolic" },
				{ id: "n3", label: "Doe@Isolated" },
			],
			[{ citingId: "n1", citedId: "n2" }],
			[],
		);
		expect(layoutCheck.positions.size).toBe(3);

		// Search matches pA, pB, pC, pIso; pOutsideRef and pOutsideCiting are outside the query
		const pA = makePaper({
			id: "doi:10.1145/graph.a",
			title: "A Fuzzing Engine for Rust",
			authors: ["Alice Smith"],
			doi: "10.1145/graph.a",
			rawRefs: [
				"doi:10.1145/graph.b",
				"doi:10.1145/outside.ref",
				"doi:10.1145/common.1",
				"doi:10.1145/common.2",
				"doi:10.1145/common.3",
			],
		});
		const pB = makePaper({
			id: "doi:10.1145/graph.b",
			title: "The Harness Synthesis Framework",
			authors: ["Bob Chen"],
			doi: "10.1145/graph.b",
		});
		const pC = makePaper({
			id: "doi:10.1145/graph.c",
			title: "Sanitizer Guided Fuzzing",
			authors: ["Carol Li"],
			doi: "10.1145/graph.c",
			rawRefs: [
				"doi:10.1145/common.1",
				"doi:10.1145/common.2",
				"doi:10.1145/common.3",
			],
		});
		const pIso = makePaper({
			id: "doi:10.1145/graph.iso",
			title: "Standalone Fuzzing Benchmark",
			authors: ["Dan Wu"],
			doi: "10.1145/graph.iso",
		});
		const pOutsideRef = makePaper({
			id: "doi:10.1145/outside.ref",
			title: "Foundational Symbolic Solver",
			authors: ["Eve Taylor"],
			abstract: "Pure SMT solver internals without the target keyword.",
			keywords: ["Formal Verification"],
			doi: "10.1145/outside.ref",
		});
		const pOutsideCiting = makePaper({
			id: "doi:10.1145/outside.citing",
			title: "Downstream Kernel Verifier",
			authors: ["Frank Miller"],
			abstract: "Kernel verification built atop earlier engines.",
			keywords: ["Formal Verification"],
			doi: "10.1145/outside.citing",
			rawRefs: ["doi:10.1145/graph.a"],
		});

		mockDb.seed({
			items: [pA, pB, pC, pIso, pOutsideRef, pOutsideCiting],
		});
		await ensureCollectionSummaryHydrated();
		await flush(4);

		// pB and pOutsideRef are in the user's Library
		const libraryKeys = collectLibraryImportedKeys([
			{
				id: "lib-b",
				title: pB.title,
				authors: pB.authors,
				doi: pB.doi,
				path: "papers/lib-b",
			},
			{
				id: "lib-out",
				title: pOutsideRef.title,
				authors: pOutsideRef.authors,
				doi: pOutsideRef.doi,
				path: "papers/lib-out",
			},
		]);

		let openedPaper: CollectionPaperItem | null = null;
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);

		const renderFast = () => {
			root.render(
				createElement(
					TooltipProvider,
					{ delayDuration: 0 },
					createElement(DiscoverFastView, {
						summary: getCollectionSummarySnapshot(),
						importedSet: libraryKeys,
						isPaperImported: isCollectionPaperImported,
						onBackToHub: () => {},
						onOpenDetail: (p) => {
							openedPaper = p;
						},
						onImportPaper: async () => {},
						onBatchImport: async () => {},
					}),
				),
			);
		};

		renderFast();
		await flush(8);

		// Filter to "Fuzzing OR Harness" so pOutsideRef & pOutsideCiting are excluded from initial search
		const searchInput = host.querySelector(
			"input[type='text']",
		) as HTMLInputElement | null;
		expect(searchInput).not.toBeNull();
		const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set;
		nativeInputValueSetter?.call(searchInput, "Fuzzing OR Harness");
		searchInput?.dispatchEvent(new Event("input", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 200));
		await flush(8);

		// Switch Fast Search to Graph View
		const graphSwitchBtn = host.querySelector(
			"button[aria-label='graphView']",
		) as HTMLButtonElement | null;
		expect(graphSwitchBtn).not.toBeNull();
		graphSwitchBtn?.click();
		await flush(8);

		const graphCanvas = host.querySelector("[data-discover-graph-view]");
		expect(graphCanvas).not.toBeNull();

		// All 4 matched nodes (including isolated pIso) are rendered with XXX@YYY labels
		const initialNodes = graphCanvas?.querySelectorAll("[data-graph-node]");
		expect(initialNodes?.length).toBe(4);
		expect(graphCanvas?.textContent).toContain("Smith@Fuzzing");
		expect(graphCanvas?.textContent).toContain("Chen@Harness");
		expect(graphCanvas?.textContent).toContain("Li@Sanitizer");
		expect(graphCanvas?.textContent).toContain("Wu@Standalone");

		// Direct citation edge (pA -> pB) + dashed shared-ref edge (pA <-> pC)
		expect(
			graphCanvas?.querySelectorAll("[data-graph-edge='citation']").length,
		).toBe(1);
		expect(
			graphCanvas?.querySelectorAll("[data-graph-edge='shared']").length,
		).toBe(1);

		// Library paper pB is highlighted
		const nodeB = graphCanvas?.querySelector(
			`[data-graph-node='${pB.id}']`,
		) as HTMLElement | null;
		expect(nodeB?.getAttribute("data-in-library")).toBe("true");
		const nodeA = graphCanvas?.querySelector(
			`[data-graph-node='${pA.id}']`,
		) as HTMLElement | null;
		expect(nodeA?.getAttribute("data-in-library")).toBeNull();

		// Expand pA -> pulls in both pOutsideRef (ref) and pOutsideCiting (cite)
		const expandABtn = graphCanvas?.querySelector(
			`[data-graph-expand='${pA.id}']`,
		) as HTMLButtonElement | null;
		expect(expandABtn).not.toBeNull();
		expandABtn?.click();
		await flush(10);

		const expandedNodes = graphCanvas?.querySelectorAll("[data-graph-node]");
		expect(expandedNodes?.length).toBe(6);
		expect(graphCanvas?.textContent).toContain("Taylor@Foundational");
		expect(graphCanvas?.textContent).toContain("Miller@Downstream");

		// Expanded Library neighbor pOutsideRef is also highlighted
		const nodeOutRef = graphCanvas?.querySelector(
			`[data-graph-node='${pOutsideRef.id}']`,
		) as HTMLElement | null;
		expect(nodeOutRef?.getAttribute("data-in-library")).toBe("true");
		expect(nodeOutRef?.getAttribute("data-expanded-neighbor")).toBe("true");

		// Clicking a node pill opens the paper detail card
		const pillBtnA = nodeA?.querySelector("button") as HTMLButtonElement | null;
		pillBtnA?.click();
		await flush(2);
		expect(openedPaper?.id).toBe(pA.id);

		root.unmount();
	});
});
