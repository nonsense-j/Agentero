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
	formatArxivCategoriesLabel,
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

		// Personal Vault highlight bar renders "citesVault" immediately even while Lineage list is collapsed
		const vaultBar = document.querySelector("[data-lineage-vault-matches]");
		expect(vaultBar?.textContent).toContain("citesVault");
		expect(vaultBar?.textContent).toContain("Foundational Reference Paper #1");

		// Lineage section starts collapsed with counts visible and zero row buttons rendered
		const lineageToggle = lineageSection?.querySelector(
			"button[data-lineage-toggle]",
		) as HTMLButtonElement | null;
		expect(lineageToggle?.getAttribute("aria-expanded")).toBe("false");
		expect(lineageSection?.querySelector(".agentero-scroll")).toBeNull();

		// Expand Lineage to lazy-load full list rows
		lineageToggle?.click();
		await flush(8);
		expect(lineageToggle?.getAttribute("aria-expanded")).toBe("true");

		// Click a row in the list view to navigate inside the dialog
		const citingRow = Array.from(
			lineageSection?.querySelectorAll(".agentero-scroll button") ?? [],
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

	it("shows all >40 cited-in-pool papers matching header count and filters strictly by title", async () => {
		const target = makePaper({
			id: "doi:10.1145/target.45",
			title: "Target Paper With Many Citations",
			doi: "10.1145/target.45",
		});
		const citers: CollectionPaperItem[] = Array.from({ length: 45 }, (_, i) =>
			makePaper({
				id: `doi:10.1145/citer.${i + 1}`,
				title:
					i === 42
						? "Symbolic Execution for Kernel Drivers"
						: `General Paper Number ${i + 1}`,
				abstract:
					i === 1
						? "This abstract mentions Symbolic Execution in body only."
						: "Standard empirical study abstract.",
				doi: `10.1145/citer.${i + 1}`,
				rawRefs: ["doi:10.1145/target.45"],
				publishedAt: `2026-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
			}),
		);

		mockDb.seed({ items: [target, ...citers] });
		const syncedTarget = mockDb.getRawItem(target.id) ?? target;

		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);

		root.render(
			createElement(
				TooltipProvider,
				{ delayDuration: 0 },
				createElement(CollectionPaperDetailDialog, {
					paper: syncedTarget,
					open: true,
					imported: false,
					onOpenChange: () => {},
					onImport: () => {},
				}),
			),
		);
		await flush(8);

		// Header cited count and collapsed Cited in Pool pill both show all 45 (not capped at 40)
		expect(document.body.textContent).toContain("citations:45");
		const lineageSection = document.querySelector("[data-lineage-section]");
		expect(lineageSection).not.toBeNull();
		const citedCountPill = lineageSection?.querySelector(
			"button[data-lineage-count-pill='cited']",
		) as HTMLButtonElement | null;
		expect(citedCountPill?.textContent).toContain("45");
		// Collapsed by default: no rows mounted until user clicks to expand
		expect(lineageSection?.querySelector(".agentero-scroll")).toBeNull();

		// Clicking the Cited count pill expands and lazy-loads all 45 rows without rendering a duplicate tab bar
		citedCountPill?.click();
		await flush(8);

		expect(citedCountPill?.getAttribute("data-active")).toBe("true");
		expect(lineageSection?.querySelector(".magpie-seg-btn")).toBeNull();

		// Displays all 45 citing papers inside the scroll box (<=50 initial step)
		const getVisibleRows = () =>
			lineageSection?.querySelectorAll(".agentero-scroll button") ?? [];
		expect(getVisibleRows().length).toBe(45);

		// Title search matches only paper #43 whose title contains "Symbolic Execution"
		// (ignores paper #2 which mentions it only in abstract)
		const titleInput = lineageSection?.querySelector(
			"input[data-lineage-title-search]",
		) as HTMLInputElement | null;
		expect(titleInput).not.toBeNull();
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(titleInput, "symbolic execution");
		titleInput?.dispatchEvent(new Event("input", { bubbles: true }));
		await flush(4);

		expect(getVisibleRows().length).toBe(1);
		expect(getVisibleRows()[0]?.textContent).toContain(
			"Symbolic Execution for Kernel Drivers",
		);

		// Clearing restores all 45 rows
		setter?.call(titleInput, "");
		titleInput?.dispatchEvent(new Event("input", { bubbles: true }));
		await flush(4);
		expect(getVisibleRows().length).toBe(45);

		root.unmount();
	});

	it("formats multi-category arXiv badges in Collection order (SE, CR, PL) and renders cross-portal jump buttons", async () => {
		expect(
			formatArxivCategoriesLabel(
				{ sourceLabel: "cs.PL", categories: ["cs.PL", "cs.SE", "cs.AI"] },
				["cs.SE", "cs.CR", "cs.PL"],
			),
		).toBe("cs.SE/PL");
		expect(
			formatArxivCategoriesLabel(
				{ sourceLabel: "cs.PL", categories: ["cs.PL", "cs.CR", "cs.SE"] },
				["cs.SE", "cs.CR", "cs.PL"],
			),
		).toBe("cs.SE/CR/PL");

		const arxivPaper = makePaper({
			id: "arxiv:2605.30001",
			title: "Cross-Portal Twin Study",
			sourceType: "arxiv",
			sourceLabel: "cs.PL",
			categories: ["cs.PL", "cs.SE"],
			arxivId: "2605.30001",
			venueId: undefined,
			venueKind: undefined,
			venueDomain: undefined,
			ccfRank: undefined,
			linkedPeer: {
				id: "doi:10.1145/icse.30001",
				sourceType: "venue",
				sourceLabel: "ICSE 2026",
				categories: ["ICSE 2026"],
				venueId: "icse-2026",
				venueKind: "conference",
				ccfRank: "CCF-A",
			},
		});
		const venuePaper = makePaper({
			id: "doi:10.1145/icse.30001",
			title: "Cross-Portal Twin Study",
			sourceType: "venue",
			sourceLabel: "ICSE 2026",
			categories: ["ICSE 2026"],
			arxivId: "2605.30001",
			doi: "10.1145/icse.30001",
			venueId: "icse-2026",
			venueKind: "conference",
			ccfRank: "CCF-A",
			linkedPeer: {
				id: "arxiv:2605.30001",
				sourceType: "arxiv",
				sourceLabel: "cs.PL",
				categories: ["cs.PL", "cs.SE"],
			},
		});

		mockDb.seed({
			categories: ["cs.SE", "cs.CR", "cs.PL"],
			items: [arxivPaper, venuePaper],
		});
		await ensureCollectionSummaryHydrated();

		const jumpVenueSpy = vi.fn();
		let dialogOpen = true;
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);

		// 1. arXiv card shows cs.SE/PL and clickable ICSE 2026 jump button
		root.render(
			createElement(
				TooltipProvider,
				{ delayDuration: 0 },
				createElement(CollectionPaperDetailDialog, {
					paper: arxivPaper,
					open: dialogOpen,
					imported: false,
					onOpenChange: (next) => {
						dialogOpen = next;
					},
					onImport: () => {},
					onJumpToVenue: jumpVenueSpy,
				}),
			),
		);
		await flush(6);

		expect(document.body.textContent).toContain("cs.SE/PL");
		const venueJumpBtn = document.querySelector(
			"button[aria-label='ICSE 2026']",
		) as HTMLButtonElement | null;
		expect(venueJumpBtn).not.toBeNull();
		venueJumpBtn?.click();
		await flush(2);
		expect(jumpVenueSpy).toHaveBeenCalledWith(arxivPaper.linkedPeer);
		expect(dialogOpen).toBe(false);

		// 2. Venue card shows both DOI and clickable arXiv ID tags below authors, and clicking arXiv tag jumps to arXiv card
		dialogOpen = true;
		root.render(
			createElement(
				TooltipProvider,
				{ delayDuration: 0 },
				createElement(CollectionPaperDetailDialog, {
					paper: venuePaper,
					open: dialogOpen,
					imported: false,
					onOpenChange: (next) => {
						dialogOpen = next;
					},
					onImport: () => {},
				}),
			),
		);
		await flush(6);

		const doiTag = document.querySelector(
			"[data-paper-identifiers] button[data-paper-doi-tag]",
		) as HTMLButtonElement | null;
		const arxivIdTag = document.querySelector(
			"[data-paper-identifiers] button[data-paper-arxiv-tag]",
		) as HTMLButtonElement | null;
		expect(doiTag?.textContent).toContain("10.1145/icse.30001");
		expect(arxivIdTag?.textContent).toContain("2605.30001");
		arxivIdTag?.click();
		await flush(6);
		expect(document.querySelector("button[aria-label='back']")).not.toBeNull();

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
