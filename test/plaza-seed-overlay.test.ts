// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlazaCollectionView } from "@/components/plaza/plaza-collection-view";
import { TooltipProvider } from "@/components/ui/tooltip";
import i18n from "@/i18n";
import {
	backgroundTasksStore,
	cancelBackgroundTask,
} from "@/lib/core/background-tasks";
import {
	type CollectionSeedProgress,
	commands,
	events,
} from "@/lib/core/bindings";
import {
	applyCollectionSeedProgress,
	type CollectionPaperItem,
	collectionSeedStore,
	ensureCollectionSummaryHydrated,
	getCollectionSeedSyncSnapshot,
	getCollectionSummarySnapshot,
	isSeedDownloadSlow,
	refreshArxivCollection,
	refreshVenueCollection,
	resetCollectionMemoryForTests,
	shouldShowCollectionSeedOverlay,
	syncCollectionSeedInBackground,
	updateCollectionConfig,
} from "@/lib/plaza/collection";
import {
	collectionRefreshStore,
	refreshArxivInBackground,
	refreshVenueInBackground,
} from "@/lib/plaza/collection-refresh";
import { loadSettings } from "@/lib/settings";
import { applyExternalSettings } from "@/lib/settings/store";
import { installMockCollectionIpc } from "./helpers/mock-collection-ipc";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockOpenSettingsWindow = vi.fn();
const notifyErrorSpy = vi.fn();

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/shell/settings-window", () => ({
	openSettingsWindow: (section?: string) => mockOpenSettingsWindow(section),
}));
vi.mock("@/lib/core/notify", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/core/notify")>();
	return {
		...actual,
		notifyError: (...args: unknown[]) => notifyErrorSpy(...args),
	};
});

function makePaper(
	overrides: Partial<CollectionPaperItem> & { id: string; title: string },
): CollectionPaperItem {
	return {
		authors: ["Alice"],
		abstract: "Detailed abstract text describing a systems paper.",
		publishedAt: "2026-03-10T00:00:00Z",
		year: 2026,
		sourceType: "venue",
		sourceLabel: "ASE 2026",
		venueId: "ase-2026",
		venueKind: "conference",
		venueDomain: "PL/SE",
		ccfRank: "CCF-A",
		categories: ["ASE 2026"],
		url: `https://example.org/${overrides.id}`,
		citationCount: 0,
		keywords: ["Program Analysis"],
		keywordSource: "maintainer_llm",
		...overrides,
	};
}

async function flush(cycles = 5) {
	for (let i = 0; i < cycles; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}

describe("Collection Seed first-launch overlay, refresh guards, and concurrency", () => {
	let mockDb: ReturnType<typeof installMockCollectionIpc>;
	let host: HTMLDivElement | null = null;
	let root: Root | null = null;

	beforeEach(async () => {
		await i18n.changeLanguage("en");
		mockOpenSettingsWindow.mockClear();
		notifyErrorSpy.mockClear();
		backgroundTasksStore.setState({ tasks: [], expanded: false });
		collectionRefreshStore.setState({
			refreshingArxiv: false,
			refreshingVenue: false,
			arxivRefreshLabel: null,
			venueRefreshLabel: null,
			refreshingCategories: new Set(),
			refreshedCategories: new Set(),
			refreshingVenueIds: new Set(),
			refreshedVenueIds: new Set(),
		});
		resetCollectionMemoryForTests();
		mockDb = installMockCollectionIpc();
	});

	afterEach(() => {
		if (root) {
			act(() => {
				root?.unmount();
			});
		}
		root = null;
		host?.remove();
		host = null;
		mockDb.restore();
		resetCollectionMemoryForTests();
		backgroundTasksStore.setState({ tasks: [], expanded: false });
	});

	it("enforces zero-flicker warm launch gating and slow-download detection", () => {
		const baseSummary = {
			hydrated: false,
			totalCount: 0,
			seedCleared: false,
			appliedSeedIds: [] as string[],
		};
		const idleSeed = { phase: "idle" as const, sessionDismissed: false };

		// Never flashes before hydration resolves
		expect(shouldShowCollectionSeedOverlay(baseSummary, idleSeed)).toBe(false);
		// Shows on hydrated clean empty DB
		expect(
			shouldShowCollectionSeedOverlay(
				{ ...baseSummary, hydrated: true },
				idleSeed,
			),
		).toBe(true);
		// Warm launches open directly (totalCount > 0 or appliedSeedIds > 0 or seedCleared)
		expect(
			shouldShowCollectionSeedOverlay(
				{ ...baseSummary, hydrated: true, totalCount: 10 },
				{ phase: "downloading", sessionDismissed: false },
			),
		).toBe(false);
		expect(
			shouldShowCollectionSeedOverlay(
				{ ...baseSummary, hydrated: true, appliedSeedIds: ["core-2026"] },
				idleSeed,
			),
		).toBe(false);
		expect(
			shouldShowCollectionSeedOverlay(
				{ ...baseSummary, hydrated: true, seedCleared: true },
				idleSeed,
			),
		).toBe(false);
		// Skipped or session-dismissed hides overlay
		expect(
			shouldShowCollectionSeedOverlay(
				{ ...baseSummary, hydrated: true },
				{ phase: "skipped", sessionDismissed: false },
			),
		).toBe(false);
		expect(
			shouldShowCollectionSeedOverlay(
				{ ...baseSummary, hydrated: true },
				{ phase: "error", sessionDismissed: true },
			),
		).toBe(false);

		// Slow download detection: >10s with <5% or <50KB/s
		expect(
			isSeedDownloadSlow(
				{
					active: true,
					phase: "downloading",
					downloadStartedAt: 1000,
					downloadedBytes: 500_000,
					totalBytes: 40_000_000,
					bytesPerSec: 10_000,
				},
				12_000,
			),
		).toBe(true);
		expect(
			isSeedDownloadSlow(
				{
					active: true,
					phase: "downloading",
					downloadStartedAt: 1000,
					downloadedBytes: 10_000_000,
					totalBytes: 40_000_000,
					bytesPerSec: 2_000_000,
				},
				12_000,
			),
		).toBe(false);
	});

	it("deduplicates background seed task row when cs.AI is toggled mid-sync and blocks concurrent refresh tasks", async () => {
		let resolveSeed!: () => void;
		const corePaper = makePaper({
			id: "doi:10.1145/seed.1",
			title: "Seeded ASE Paper",
			doi: "10.1145/seed.1",
		});

		let callCount = 0;
		vi.spyOn(commands, "plazaCollectionSeedSync").mockImplementation(
			async () => {
				callCount += 1;
				if (callCount === 1) {
					await new Promise<void>((resolve) => {
						resolveSeed = resolve;
					});
				}
				return {
					ok: true,
					data: {
						state: {
							...getCollectionSummarySnapshot(),
							venues: getCollectionSummarySnapshot().venues.map((v) => ({
								...v,
								tracks: v.tracks ?? [],
								notes: v.notes ?? null,
								kind: v.kind ?? null,
								domain: v.domain ?? null,
								ccfRank: v.ccfRank ?? null,
								lastFetchedAt: v.lastFetchedAt ?? null,
								latestPublishedAt: v.latestPublishedAt ?? null,
								remoteTotalCount: v.remoteTotalCount ?? null,
								paperCount: v.id === "ase-2026" ? 1 : 0,
							})),
							arxivWatermarks: {},
							totalCount: 1,
							arxivCount: 0,
							venueCount: 1,
							conferenceCount: 1,
							journalCount: 0,
							categoryCounts: {},
							seedCleared: false,
							appliedSeedIds: ["core-2026"],
						},
						appliedShards: callCount === 1 ? ["core-2026"] : [],
						importedPapers: callCount === 1 ? 1 : 0,
						skipped: callCount > 1,
					},
					error: null,
				};
			},
		);

		void corePaper;
		await ensureCollectionSummaryHydrated();
		await flush(2);

		// Exactly one active seed task row
		expect(
			backgroundTasksStore
				.getState()
				.tasks.filter((t) => t.status === "running"),
		).toHaveLength(1);

		// Calling syncCollectionSeedInBackground again or toggling cs.AI must NOT create a #2 seed row
		const dup = syncCollectionSeedInBackground();
		await updateCollectionConfig({
			categories: ["cs.SE", "cs.CR", "cs.PL", "cs.AI"],
		});
		// Programmatic Refresh calls while seed is active must NOT enqueue #2/#3 tasks
		await refreshArxivInBackground();
		await refreshVenueInBackground();

		const runningTasks = backgroundTasksStore
			.getState()
			.tasks.filter((t) => t.status === "running");
		expect(runningTasks).toHaveLength(1);
		expect(runningTasks[0]?.title).toBe("Sync collection seed");

		resolveSeed();
		await dup;
		await flush(4);
		// Follow-up sync ran cleanly after the first finished
		expect(callCount).toBe(2);
	});

	it("aborts cold manual refresh when seed sync fails instead of cascading into a full cold scrape", async () => {
		vi.spyOn(commands, "plazaCollectionSeedSync").mockRejectedValueOnce(
			new Error("connection timed out"),
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await expect(
			refreshArxivCollection({ categories: ["cs.SE"], incremental: true }),
		).rejects.toThrow("connection timed out");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(getCollectionSeedSyncSnapshot().phase).toBe("error");
		fetchSpy.mockRestore();
	});

	it("skips redundant full 28-venue re-scrape when cold seed just populated venues", async () => {
		const venuePaper = makePaper({
			id: "doi:10.1145/ase.2026.1",
			title: "Automated Verification at Scale",
			doi: "10.1145/ase.2026.1",
		});
		mockDb.seed({
			venues: [
				{
					id: "ase-2026",
					name: "ASE 2026",
					url: "https://conf.researchr.org/home/ase-2026",
					mode: "auto",
					kind: "conference",
					domain: "PL/SE",
					ccfRank: "CCF-A",
				},
			],
			seedShards: [{ id: "core-2026", kind: "core", items: [venuePaper] }],
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const summary = await refreshVenueCollection({ skipLoaded: false });
		expect(summary.venueCount).toBe(1);
		// Should NOT scrape researchr/OpenAlex for already-seeded ASE 2026
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("renders blurred Hub + dashed progress overlay on clean launch, handles error/skip/proxy retry, and opens directly on warm launch", async () => {
		let rejectFirstSeed!: (err: Error) => void;
		let seedAttempts = 0;
		const seededPaper = makePaper({
			id: "doi:10.1145/warm.1",
			title: "Warm Pool Paper",
			doi: "10.1145/warm.1",
		});

		vi.spyOn(commands, "plazaCollectionSeedSync").mockImplementation(
			async () => {
				seedAttempts += 1;
				if (seedAttempts === 1) {
					await new Promise<void>((_resolve, reject) => {
						rejectFirstSeed = reject;
					});
				}
				mockDb.seed({
					items: [seededPaper],
					appliedSeedIds: ["core-2026"],
				});
				const stateRes = await commands.plazaCollectionStateGet();
				if (!stateRes.ok || !stateRes.data) {
					throw new Error("Expected mock collection state");
				}
				return {
					ok: true,
					data: {
						state: stateRes.data,
						appliedShards: ["core-2026"],
						importedPapers: 1,
						skipped: false,
					},
					error: null,
				};
			},
		);

		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		act(() => {
			root?.render(
				createElement(
					I18nextProvider,
					{ i18n },
					createElement(
						TooltipProvider,
						{ delayDuration: 0 },
						createElement(PlazaCollectionView),
					),
				),
			);
		});
		await flush(6);

		// Overlay visible + underlying hub blurred & inert + header refresh disabled
		const overlay = host.querySelector("[data-collection-seed-overlay]");
		expect(overlay).not.toBeNull();
		const backdrop = host.querySelector("[data-seed-blur-backdrop]");
		expect(backdrop?.getAttribute("aria-hidden")).toBe("true");
		const refreshBtn = host.querySelector(
			"button[aria-label='Refresh collection']",
		) as HTMLButtonElement | null;
		expect(refreshBtn?.disabled).toBe(true);

		// Determinate progress updates render both Step 1/2 Downloading and Step 2/2 Importing
		act(() => {
			applyCollectionSeedProgress({
				phase: "downloading",
				shardIndex: 1,
				shardCount: 1,
				downloadedBytes: 20 * 1024 * 1024,
				totalBytes: 40 * 1024 * 1024,
				bytesPerSec: 2 * 1024 * 1024,
				importedPapers: 0,
				totalPapers: 0,
				error: null,
			});
		});
		expect(overlay?.textContent).toContain("Step 1/2 · Downloading");
		expect(overlay?.textContent).toContain("50%");

		act(() => {
			applyCollectionSeedProgress({
				phase: "importing",
				shardIndex: 1,
				shardCount: 1,
				downloadedBytes: 40 * 1024 * 1024,
				totalBytes: 40 * 1024 * 1024,
				bytesPerSec: null,
				importedPapers: 24500,
				totalPapers: 49000,
				error: null,
			});
		});
		expect(overlay?.textContent).toContain("Step 2/2 · Parsing & importing");
		expect(overlay?.textContent).toContain("50%");

		// Simulate network error -> shows Retry, Proxy Settings, Skip
		rejectFirstSeed(new Error("TLS handshake timed out"));
		await flush(6);
		expect(overlay?.textContent).toContain("Collection Seed download failed");
		expect(overlay?.textContent).toContain("TLS handshake timed out");

		const proxyBtn = Array.from(overlay?.querySelectorAll("button") ?? []).find(
			(b) => b.textContent?.includes("Proxy Settings"),
		);
		act(() => {
			proxyBtn?.click();
		});
		expect(mockOpenSettingsWindow).toHaveBeenCalledWith("general");

		// Updating proxy settings auto-retries and unblurs on completion
		const currentSettings = loadSettings();
		act(() => {
			applyExternalSettings({
				...currentSettings,
				networkProxyEnabled: !currentSettings.networkProxyEnabled,
			});
		});
		await flush(8);
		expect(seedAttempts).toBe(2);
		expect(host.querySelector("[data-collection-seed-overlay]")).toBeNull();
		expect(getCollectionSummarySnapshot().totalCount).toBe(1);
		expect(getCollectionSummarySnapshot().seedCleared).toBe(false);
		expect(collectionSeedStore.getState().active).toBe(false);
	});

	it("supports session-only Skip without setting seedCleared, and opens directly on warm launch", async () => {
		vi.spyOn(commands, "plazaCollectionSeedSync").mockRejectedValueOnce(
			new Error("offline"),
		);

		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		act(() => {
			root?.render(
				createElement(
					I18nextProvider,
					{ i18n },
					createElement(
						TooltipProvider,
						{ delayDuration: 0 },
						createElement(PlazaCollectionView),
					),
				),
			);
		});
		await flush(6);

		const overlay = host.querySelector("[data-collection-seed-overlay]");
		expect(overlay).not.toBeNull();
		const skipBtn = Array.from(overlay?.querySelectorAll("button") ?? []).find(
			(b) => b.textContent?.trim() === "Skip",
		);
		expect(skipBtn).toBeDefined();
		act(() => {
			skipBtn?.click();
		});
		await flush(2);
		expect(host.querySelector("[data-collection-seed-overlay]")).toBeNull();
		expect(getCollectionSummarySnapshot().seedCleared).toBe(false);
		expect(collectionSeedStore.getState().sessionDismissed).toBe(true);

		// Unmount and mount a warm-launch view: zero overlay and zero seed sync IPC
		act(() => {
			root?.unmount();
		});
		resetCollectionMemoryForTests();
		const warmPaper = makePaper({
			id: "doi:10.1145/warm.direct",
			title: "Already Seeded Paper",
			doi: "10.1145/warm.direct",
		});
		mockDb.seed({
			items: [warmPaper],
			appliedSeedIds: ["core-2026"],
		});
		const seedSpy = vi.spyOn(commands, "plazaCollectionSeedSync");
		seedSpy.mockClear();

		root = createRoot(host);
		act(() => {
			root?.render(
				createElement(
					I18nextProvider,
					{ i18n },
					createElement(
						TooltipProvider,
						{ delayDuration: 0 },
						createElement(PlazaCollectionView),
					),
				),
			);
		});
		// Must not flash before hydration OR after hydration
		expect(host.querySelector("[data-collection-seed-overlay]")).toBeNull();
		await flush(6);
		expect(host.querySelector("[data-collection-seed-overlay]")).toBeNull();
		expect(seedSpy).not.toHaveBeenCalled();
	});

	it("plumbs plazaCollectionSeedProgress events to overlay + task panel and supports cancel + retry cleanly", async () => {
		let emitProgress: ((payload: CollectionSeedProgress) => void) | null = null;
		vi.spyOn(events.plazaCollectionSeedProgress, "listen").mockImplementation(
			async (cb) => {
				emitProgress = (payload) =>
					cb({
						event: "plaza-collection:seed-progress",
						id: 1,
						payload,
					});
				return () => {
					emitProgress = null;
				};
			},
		);

		let attempt = 0;
		let finishCancelledAttempt: (() => void) | null = null;
		let finishThirdAttempt: (() => void) | null = null;
		const cancelSpy = vi
			.spyOn(commands, "plazaCollectionSeedCancel")
			.mockImplementation(async () => ({ ok: true, data: true, error: null }));

		vi.spyOn(commands, "plazaCollectionSeedSync").mockImplementation(
			async () => {
				attempt += 1;
				if (attempt === 1) {
					await new Promise<void>((resolve) => {
						finishCancelledAttempt = resolve;
					});
					return {
						ok: false,
						data: null,
						error: {
							code: "seed_sync_cancelled",
							message: "Collection seed sync cancelled",
						},
					};
				}
				if (attempt === 2) {
					// Keep attempt 2 open until cancelled from BackgroundTasksPanel
					await new Promise<void>((resolve) => {
						finishThirdAttempt = resolve;
					});
					return {
						ok: false,
						data: null,
						error: {
							code: "seed_sync_cancelled",
							message: "Collection seed sync cancelled",
						},
					};
				}
				const seededPaper = makePaper({
					id: "doi:10.1145/stageb.done",
					title: "Stage B Seeded Paper",
					doi: "10.1145/stageb.done",
				});
				mockDb.seed({
					items: [seededPaper],
					appliedSeedIds: ["core-2026"],
				});
				const stateRes = await commands.plazaCollectionStateGet();
				if (!stateRes.ok || !stateRes.data) {
					throw new Error("Expected mock collection state");
				}
				return {
					ok: true,
					data: {
						state: stateRes.data,
						appliedShards: ["core-2026"],
						importedPapers: 1,
						skipped: false,
					},
					error: null,
				};
			},
		);

		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		act(() => {
			root?.render(
				createElement(
					I18nextProvider,
					{ i18n },
					createElement(
						TooltipProvider,
						{ delayDuration: 0 },
						createElement(PlazaCollectionView),
					),
				),
			);
		});
		await flush(6);

		expect(emitProgress).not.toBeNull();
		const overlay = host.querySelector("[data-collection-seed-overlay]");
		expect(overlay).not.toBeNull();

		// 1. Emit real Tauri event payloads and verify BOTH overlay & backgroundTasksStore update
		act(() => {
			emitProgress?.({
				phase: "downloading",
				shardIndex: 1,
				shardCount: 1,
				downloadedBytes: 20 * 1024 * 1024,
				totalBytes: 40 * 1024 * 1024,
				bytesPerSec: 4 * 1024 * 1024,
				importedPapers: 0,
				totalPapers: 0,
				error: null,
			});
		});
		expect(overlay?.textContent).toContain("Step 1/2 · Downloading");
		expect(overlay?.textContent).toContain("50%");
		let task = backgroundTasksStore.getState().tasks[0];
		expect(task?.progress).toBe(38);
		expect(task?.detail).toContain("20 MB / 40 MB · 4.0 MB/s");

		act(() => {
			emitProgress?.({
				phase: "importing",
				shardIndex: 1,
				shardCount: 1,
				downloadedBytes: 40 * 1024 * 1024,
				totalBytes: 40 * 1024 * 1024,
				bytesPerSec: null,
				importedPapers: 25000,
				totalPapers: 50000,
				error: null,
			});
		});
		expect(overlay?.textContent).toContain("Step 2/2 · Parsing & importing");
		task = backgroundTasksStore.getState().tasks[0];
		expect(task?.progress).toBe(85);
		expect(task?.detail).toContain("25,000 / 50,000");

		act(() => {
			emitProgress?.({
				phase: "indexing",
				shardIndex: 1,
				shardCount: 1,
				downloadedBytes: 40 * 1024 * 1024,
				totalBytes: 40 * 1024 * 1024,
				bytesPerSec: null,
				importedPapers: 50000,
				totalPapers: 50000,
				error: null,
			});
		});
		expect(overlay?.textContent).toContain(
			"Step 2/2 · Building search & citation index",
		);
		expect(backgroundTasksStore.getState().tasks[0]?.progress).toBe(96);

		// A premature `done` event before the IPC resolves must NOT flash-hide the overlay onto a 0-paper Hub
		act(() => {
			emitProgress?.({
				phase: "done",
				shardIndex: 1,
				shardCount: 1,
				downloadedBytes: 40 * 1024 * 1024,
				totalBytes: 40 * 1024 * 1024,
				bytesPerSec: null,
				importedPapers: 50000,
				totalPapers: 50000,
				error: null,
			});
		});
		expect(host.querySelector("[data-collection-seed-overlay]")).not.toBeNull();

		// 2. Click Overlay Cancel (X) -> calls plazaCollectionSeedCancel ONCE, ignores stale ticks, no error toast
		const cancelBtn = overlay?.querySelector(
			"button[aria-label='Cancel']",
		) as HTMLButtonElement | null;
		expect(cancelBtn).not.toBeNull();
		act(() => {
			cancelBtn?.click();
		});
		expect(cancelSpy).toHaveBeenCalledTimes(1);
		expect(collectionSeedStore.getState().phase).toBe("cancelled");
		expect(backgroundTasksStore.getState().tasks[0]?.status).toBe("cancelled");
		expect(notifyErrorSpy).not.toHaveBeenCalled();

		// Stale downloading tick arriving after cancel must be ignored
		act(() => {
			emitProgress?.({
				phase: "downloading",
				shardIndex: 1,
				shardCount: 1,
				downloadedBytes: 25 * 1024 * 1024,
				totalBytes: 40 * 1024 * 1024,
				bytesPerSec: 2 * 1024 * 1024,
				importedPapers: 0,
				totalPapers: 0,
				error: null,
			});
		});
		expect(collectionSeedStore.getState().phase).toBe("cancelled");

		// 3. Clicking Retry while attempt 1 is still unwinding waits for attempt 1 before starting attempt 2
		const retryBtn = Array.from(overlay?.querySelectorAll("button") ?? []).find(
			(b) => b.textContent?.includes("Retry"),
		);
		expect(retryBtn).toBeDefined();
		act(() => {
			retryBtn?.click();
		});
		await flush(2);
		expect(attempt).toBe(1);

		finishCancelledAttempt?.();
		await flush(6);
		expect(attempt).toBe(2);
		expect(collectionSeedStore.getState().active).toBe(true);

		// 4. Cancelling via BackgroundTasksPanel also invokes plazaCollectionSeedCancel once & flips overlay
		const runningTask = backgroundTasksStore
			.getState()
			.tasks.find((t) => t.status === "running");
		expect(runningTask).toBeDefined();
		act(() => {
			if (runningTask) cancelBackgroundTask(runningTask.id);
		});
		expect(cancelSpy).toHaveBeenCalledTimes(2);
		expect(collectionSeedStore.getState().phase).toBe("cancelled");
		expect(notifyErrorSpy).not.toHaveBeenCalled();

		// 5. Retry again after attempt 2 unwinds -> succeeds and unblurs cleanly
		finishThirdAttempt?.();
		await flush(4);
		const retryBtn2 = Array.from(
			host.querySelectorAll("[data-collection-seed-overlay] button"),
		).find((b) => b.textContent?.includes("Retry"));
		act(() => {
			(retryBtn2 as HTMLButtonElement | undefined)?.click();
		});
		await flush(8);
		expect(attempt).toBe(3);
		expect(host.querySelector("[data-collection-seed-overlay]")).toBeNull();
		expect(getCollectionSummarySnapshot().totalCount).toBe(1);
		expect(notifyErrorSpy).not.toHaveBeenCalled();
	});
});
