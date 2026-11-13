import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import {
	backgroundTasksStore,
	cancelBackgroundTask,
} from "@/lib/core/background-tasks";
import { notifyError } from "@/lib/core/notify";
import {
	extractKeywordsWithKeywordLlmBatch,
	setCachedKeywordLlmConfigForTests,
} from "@/lib/keyword-llm";
import * as collectionMod from "@/lib/plaza/collection";
import { enrichSinglePaperOnDemand } from "@/lib/plaza/collection-enrichment";
import {
	collectionRefreshStore,
	formatArxivInlineLabel,
	formatArxivTaskDetail,
	formatVenueInlineLabel,
	formatVenueTaskDetail,
	refreshAllInBackground,
	refreshArxivInBackground,
	refreshVenueInBackground,
} from "@/lib/plaza/collection-refresh";
import { fetchMultiChannelVenuePapers } from "@/lib/plaza/collection-venue-channels";
import { installMockCollectionIpc } from "./helpers/mock-collection-ipc";

const globalWithWindow = globalThis as typeof globalThis & {
	window?: { setTimeout: typeof setTimeout };
};
globalWithWindow.window = { setTimeout };

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/notify", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/core/notify")>();
	return {
		...actual,
		notifyError: vi.fn(),
	};
});

describe("Plaza Paper Collection background task integration", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
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
		vi.mocked(notifyError).mockClear();
		installMockCollectionIpc({
			initialState: {
				categories: ["cs.SE", "cs.CR", "cs.PL"],
				venues: [
					{
						id: "ase-2026",
						name: "ASE 2026",
						url: "https://conf.researchr.org/home/ase-2026",
						mode: "auto",
					},
					{
						id: "neurips-2026",
						name: "NeurIPS 2026",
						url: "https://neurips.cc/Conferences/2026",
						mode: "auto",
					},
				],
			},
		});
		await collectionMod.ensureCollectionSummaryHydrated();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setCachedKeywordLlmConfigForTests(undefined);
		collectionMod.resetCollectionMemoryForTests();
		backgroundTasksStore.setState({ tasks: [], expanded: false });
	});

	it("formats Venue and arXiv counters with completed/total labels and optional sub-progress", () => {
		expect(
			formatVenueTaskDetail({
				venueId: "neurips-2026",
				venueName: "NeurIPS 2026",
				completed: 25,
				total: 28,
				overallProgress: 89,
			}),
		).toBe("NeurIPS 2026 · Venue 25/28");

		expect(
			formatVenueTaskDetail({
				venueId: "neurips-2026",
				venueName: "NeurIPS 2026",
				completed: 25,
				total: 28,
				subCompleted: 2,
				subTotal: 5,
				overallProgress: 91,
			}),
		).toBe("NeurIPS 2026 (2/5) · Venue 25/28");

		expect(
			formatVenueInlineLabel({
				venueId: "neurips-2026",
				venueName: "NeurIPS 2026",
				completed: 25,
				total: 28,
				overallProgress: 89,
			}),
		).toBe("NeurIPS 2026 · Venue 25/28");

		expect(
			formatArxivTaskDetail({
				category: "cs.SE",
				completed: 1,
				total: 3,
				subCompleted: 1000,
				subTotal: 3850,
				overallProgress: 42,
			}),
		).toBe("cs.SE (1000/3850) · arXiv 1/3");

		expect(
			formatArxivInlineLabel({
				category: "cs.SE",
				completed: 1,
				total: 3,
				subCompleted: 12,
				subTotal: 150,
				overallProgress: 42,
			}),
		).toBe("cs.SE (12/150) · arXiv 1/3");

		expect(
			formatArxivInlineLabel({
				category: "cs.SE",
				completed: 1,
				total: 3,
				overallProgress: 42,
			}),
		).toBe("cs.SE · arXiv 1/3");
	});

	it("creates two independent background tasks for refreshAllInBackground and tracks monotonic progress", async () => {
		const seenVenueProgress: Array<{
			progress: number | null;
			detail?: string;
		}> = [];
		const seenArxivProgress: Array<{
			progress: number | null;
			detail?: string;
		}> = [];

		vi.spyOn(collectionMod, "refreshArxivCollection").mockImplementation(
			async (opts) => {
				opts?.onProgress?.({
					category: "cs.SE",
					completed: 0,
					total: 3,
					subCompleted: 500,
					subTotal: 1000,
					overallProgress: 16,
				});
				let task = backgroundTasksStore
					.getState()
					.tasks.find((t) => t.kind === "plazaArxivRefresh");
				if (task) {
					seenArxivProgress.push({
						progress: task.progress,
						detail: task.detail,
					});
				}
				opts?.onCategoryStatus?.("cs.SE", "done");
				opts?.onProgress?.({
					category: "cs.CR",
					completed: 1,
					total: 3,
					overallProgress: 35,
				});
				task = backgroundTasksStore
					.getState()
					.tasks.find((t) => t.kind === "plazaArxivRefresh");
				if (task) {
					seenArxivProgress.push({
						progress: task.progress,
						detail: task.detail,
					});
				}
				opts?.onProgress?.({
					category: "cs.PL",
					completed: 3,
					total: 3,
					overallProgress: 100,
				});
				return collectionMod.getCollectionSummarySnapshot();
			},
		);

		vi.spyOn(collectionMod, "refreshVenueCollection").mockImplementation(
			async (opts) => {
				opts?.onProgress?.({
					venueId: "ase-2026",
					venueName: "ASE 2026",
					completed: 0,
					total: 2,
					subCompleted: 1,
					subTotal: 4,
					overallProgress: 12,
				});
				let task = backgroundTasksStore
					.getState()
					.tasks.find((t) => t.kind === "plazaVenueRefresh");
				if (task) {
					seenVenueProgress.push({
						progress: task.progress,
						detail: task.detail,
					});
				}
				opts?.onVenueStatus?.(
					{ id: "ase-2026", name: "ASE 2026", url: "", mode: "auto" },
					"done",
					1,
					2,
				);
				opts?.onProgress?.({
					venueId: "neurips-2026",
					venueName: "NeurIPS 2026",
					completed: 1,
					total: 2,
					overallProgress: 52,
				});
				task = backgroundTasksStore
					.getState()
					.tasks.find((t) => t.kind === "plazaVenueRefresh");
				if (task) {
					seenVenueProgress.push({
						progress: task.progress,
						detail: task.detail,
					});
				}
				opts?.onProgress?.({
					venueId: "neurips-2026",
					venueName: "NeurIPS 2026",
					completed: 2,
					total: 2,
					overallProgress: 100,
				});
				return collectionMod.getCollectionSummarySnapshot();
			},
		);

		await refreshAllInBackground();

		const tasks = backgroundTasksStore.getState().tasks;
		const arxivTask = tasks.find((t) => t.kind === "plazaArxivRefresh");
		const venueTask = tasks.find((t) => t.kind === "plazaVenueRefresh");
		expect(arxivTask?.status).toBe("completed");
		expect(arxivTask?.progress).toBe(100);
		expect(arxivTask?.detail).toBe("arXiv 3/3");

		expect(venueTask?.status).toBe("completed");
		expect(venueTask?.progress).toBe(100);
		expect(venueTask?.detail).toBe("Venue 2/2");

		expect(seenArxivProgress).toEqual([
			{ progress: 16, detail: "cs.SE (500/1000) · arXiv 0/3" },
			{ progress: 35, detail: "cs.CR · arXiv 1/3" },
		]);
		expect(seenVenueProgress).toEqual([
			{ progress: 12, detail: "ASE 2026 (1/4) · Venue 0/2" },
			{ progress: 52, detail: "NeurIPS 2026 · Venue 1/2" },
		]);
		expect(
			collectionRefreshStore.getState().refreshedCategories.has("cs.SE"),
		).toBe(true);
		expect(
			collectionRefreshStore.getState().refreshedVenueIds.has("ase-2026"),
		).toBe(true);
	});

	it("aborts in-flight refresh when cancelled from the background tasks panel without error toast", async () => {
		let receivedSignal: AbortSignal | undefined;
		let rejectRun!: (reason?: unknown) => void;

		vi.spyOn(collectionMod, "refreshVenueCollection").mockImplementation(
			async (opts) => {
				receivedSignal = opts?.signal;
				await new Promise<void>((_resolve, reject) => {
					rejectRun = reject;
					opts?.signal?.addEventListener("abort", () => {
						reject(new Error("aborted"));
					});
				});
				return collectionMod.getCollectionSummarySnapshot();
			},
		);

		const runPromise = refreshVenueInBackground();
		// Wait a microtask for `runLocalActivity` to register the task.
		await Promise.resolve();

		const runningTask = backgroundTasksStore
			.getState()
			.tasks.find((t) => t.kind === "plazaVenueRefresh");
		expect(runningTask?.status).toBe("running");
		if (!runningTask) {
			throw new Error("Expected plazaVenueRefresh task to be registered");
		}
		expect(collectionRefreshStore.getState().refreshingVenue).toBe(true);

		cancelBackgroundTask(runningTask.id);
		expect(receivedSignal?.aborted).toBe(true);

		await runPromise;

		const settled = backgroundTasksStore
			.getState()
			.tasks.find((t) => t.id === runningTask.id);
		expect(settled?.status).toBe("cancelled");
		expect(collectionRefreshStore.getState().refreshingVenue).toBe(false);
		expect(collectionRefreshStore.getState().venueRefreshLabel).toBeNull();
		expect(vi.mocked(notifyError)).not.toHaveBeenCalled();
		void rejectRun;
	});

	it("deduplicates concurrent arXiv refreshes to a single background task", async () => {
		let resolveRefresh!: () => void;
		const spy = vi
			.spyOn(collectionMod, "refreshArxivCollection")
			.mockImplementation(async () => {
				await new Promise<void>((resolve) => {
					resolveRefresh = resolve;
				});
				return collectionMod.getCollectionSummarySnapshot();
			});

		const p1 = refreshArxivInBackground();
		const p2 = refreshArxivInBackground();
		await Promise.resolve();

		expect(spy).toHaveBeenCalledTimes(1);
		expect(
			backgroundTasksStore
				.getState()
				.tasks.filter((t) => t.kind === "plazaArxivRefresh"),
		).toHaveLength(1);

		resolveRefresh();
		await Promise.all([p1, p2]);
	});

	it("aborts real refreshVenueCollection and refreshArxivCollection loops promptly when AbortSignal aborts", async () => {
		const abortController = new AbortController();
		const events: collectionMod.VenueRefreshProgress[] = [];

		abortController.abort();
		await expect(
			collectionMod.refreshVenueCollection({
				signal: abortController.signal,
				onProgress: (p) => events.push(p),
			}),
		).rejects.toThrow("background task cancelled");
		expect(events).toHaveLength(0);

		await expect(
			collectionMod.refreshArxivCollection({
				signal: abortController.signal,
			}),
		).rejects.toThrow("background task cancelled");
	});

	it("emits live intermediate percentages and per-paper sub-progress during arXiv cold-start, preload, and keyword backfill", async () => {
		setCachedKeywordLlmConfigForTests({
			provider: "openaiCompatible",
			baseUrl: "https://mock.llm.local/v1",
			apiKey: "test-key",
			model: "mock-model",
		});

		const makeAtomFeed = (
			prefix: string,
			count: number,
			totalResults: number,
		) => {
			const entries = Array.from({ length: count }, (_, idx) => {
				const num = String(idx + 1).padStart(5, "0");
				return `<entry>
					<id>http://arxiv.org/abs/2608.${prefix}${num}v1</id>
					<published>2026-08-${String(28 - idx).padStart(2, "0")}T12:00:00Z</published>
					<title>Automated Software Verification Study ${prefix}-${idx + 1}</title>
					<summary>We present an empirical evaluation of automated verification method ${prefix}-${idx + 1} with realistic benchmarks and abstract text.</summary>
					<author><name>Researcher ${idx + 1}</name></author>
				</entry>`;
			}).join("\n");
			return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
				<opensearch:totalResults>${totalResults}</opensearch:totalResults>
				${entries}
			</feed>`;
		};

		const events: collectionMod.ArxivRefreshProgress[] = [];
		const keywordLlmFetch: typeof fetch = async (_url, init) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				messages?: Array<{ role: string; content: string }>;
			};
			const userText = body.messages?.[1]?.content ?? "";
			const matches = [...userText.matchAll(/\[(\d+)\]/g)];
			const out: Record<string, string[]> = {};
			for (const m of matches) {
				if (m[1]) {
					out[m[1]] = ["Software Verification", "Empirical Study"];
				}
			}
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: JSON.stringify(out) } }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		await collectionMod.refreshArxivCollection({
			categories: ["cs.SE", "cs.CR", "cs.PL"],
			onProgress: (p) => {
				events.push({ ...p });
			},
			transport: {
				keywordLlmFetch,
				fetchText: async (url) => {
					if (url.includes("rss.arxiv.org")) return "<rss></rss>";
					if (url.includes("TO+209912312359]")) {
						if (url.includes("cs.SE")) return makeAtomFeed("10", 8, 8);
						if (url.includes("cs.CR")) return makeAtomFeed("20", 2, 2);
						if (url.includes("cs.PL")) return makeAtomFeed("30", 2, 2);
					}
					return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
						<opensearch:totalResults>0</opensearch:totalResults>
					</feed>`;
				},
				fetchJson: async <T>() => ({ results: [] }) as T,
			},
		});

		const intermediatePcts = events
			.map((e) => e.overallProgress)
			.filter((pct) => pct > 0 && pct < 100);
		expect(intermediatePcts.length).toBeGreaterThanOrEqual(3);
		for (let i = 1; i < events.length; i++) {
			const cur = events[i];
			const prev = events[i - 1];
			expect(cur?.overallProgress).toBeGreaterThanOrEqual(
				prev?.overallProgress ?? 0,
			);
		}
		expect(
			events.some(
				(e) =>
					e.subTotal != null &&
					e.subTotal > 0 &&
					e.subCompleted != null &&
					e.subCompleted > 0,
			),
		).toBe(true);
		const lastEvent = events[events.length - 1];
		expect(lastEvent?.overallProgress).toBe(100);
		expect(lastEvent?.completed).toBe(3);
		expect(lastEvent?.total).toBe(3);
	});

	it("reports chunk progress and aborts promptly via AbortSignal in extractKeywordsWithKeywordLlmBatch", async () => {
		setCachedKeywordLlmConfigForTests({
			provider: "openaiCompatible",
			baseUrl: "https://mock.llm.local/v1",
			apiKey: "test-key",
			model: "mock-model",
		});

		const abortController = new AbortController();
		const progressCalls: Array<{ completed: number; total: number }> = [];
		let fetchCount = 0;

		const inputs = Array.from({ length: 8 }, (_, idx) => ({
			id: `arxiv:2608.9000${idx}`,
			title: `Empirical Program Analysis Paper ${idx}`,
			abstract: `Detailed evaluation of analysis technique ${idx} on real-world software systems.`,
		}));

		const mockFetch: typeof fetch = async () => {
			fetchCount += 1;
			if (fetchCount === 1) {
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										1: ["Program Analysis"],
										2: ["Program Analysis"],
										3: ["Program Analysis"],
										4: ["Program Analysis"],
										5: ["Program Analysis"],
										6: ["Program Analysis"],
									}),
								},
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error("Should not execute second chunk after abort");
		};

		await expect(
			extractKeywordsWithKeywordLlmBatch(inputs, {
				concurrency: 1,
				fetchFn: mockFetch,
				signal: abortController.signal,
				onProgress: (completed, total) => {
					progressCalls.push({ completed, total });
					if (completed === 6) {
						abortController.abort();
					}
				},
			}),
		).rejects.toThrow("background task cancelled");

		expect(fetchCount).toBe(1);
		expect(progressCalls).toEqual([
			{ completed: 0, total: 8 },
			{ completed: 6, total: 8 },
		]);
	});

	it("matches ESEM 2026 camera-ready title revisions and uppercase diacritics to DataCite LIPIcs abstracts", async () => {
		const researchrHtml = `
			<div id="event-overview">
				<table>
					<tr>
						<td>
							<a data-event-modal="m1">Do LLM Vulnerability-Detection Agents Reason Better? An Empirical Decomposition of Stability, Independence, and Grounding</a>
							<div class="performers"><a>Zhen Yu</a>, <a>Zhiyu Wang</a>, <a>Yifan Yang</a>, <a>Chengwei Liu</a>, <a>Jun Li</a>, <a>Shuo Huang</a>, <a>Wei Zhang</a>, <a>Yang Liu</a>, <a>Ling Liu</a></div>
						</td>
					</tr>
					<tr>
						<td>
							<a data-event-modal="m2">Beyond Response Time: Quantifying the Energy Cost of Performance Antipatterns in Microservices</a>
							<div class="performers"><a>Vincenzo Stoico</a>, <a>Lucia Berardinelli</a>, <a>Raffaela Mirandola</a></div>
						</td>
					</tr>
					<tr>
						<td>
							<a data-event-modal="m3">Lawyers\u2019 Experiences with Dark Patterns in Consent Banners</a>
							<div class="performers"><a>Lorena S\u00c1NCHEZ CHAMORRO</a>, <a>Cristiana Santos</a>, <a>Vincent Koenig</a>, <a>Carine Lallemand</a></div>
						</td>
					</tr>
				</table>
			</div>
		`;

		const datacitePayload = {
			meta: { total: 3, totalPages: 1, page: 1 },
			data: [
				{
					id: "10.4230/lipics.esem.2026.28",
					attributes: {
						titles: [
							{
								title:
									"Do LLM Vulnerability-Detection Agents Reason Better? An Empirical Decomposition of Robustness, Resistance, and Grounding",
							},
						],
						creators: [
							{ givenName: "Zhen", familyName: "Yu" },
							{ givenName: "Zhiyu", familyName: "Wang" },
							{ givenName: "Yifan", familyName: "Yang" },
							{ givenName: "Chengwei", familyName: "Liu" },
							{ givenName: "Jun", familyName: "Li" },
							{ givenName: "Shuo", familyName: "Huang" },
							{ givenName: "Wei", familyName: "Zhang" },
							{ givenName: "Yang", familyName: "Liu" },
						],
						descriptions: [
							{
								descriptionType: "Abstract",
								description:
									"We systematically decompose LLM vulnerability-detection agents across robustness, resistance, and grounding dimensions on real CVEs.",
							},
						],
						url: "https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ESEM.2026.28",
						contentUrl:
							"https://drops.dagstuhl.de/storage/00lipics/lipics-vol300-esem2026/LIPIcs.ESEM.2026.28/LIPIcs.ESEM.2026.28.pdf",
					},
				},
				{
					id: "10.4230/lipics.esem.2026.30",
					attributes: {
						titles: [
							{
								title:
									"Beyond Response Time: Investigating the Power Behavior of Performance Antipatterns",
							},
						],
						creators: [
							{ givenName: "Vincenzo", familyName: "Stoico" },
							{ givenName: "Lucia", familyName: "Berardinelli" },
							{ givenName: "Raffaela", familyName: "Mirandola" },
						],
						descriptions: [
							{
								descriptionType: "Abstract",
								description:
									"We empirically measure the power and energy impact of microservice performance antipatterns under realistic workloads.",
							},
						],
						url: "https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ESEM.2026.30",
						contentUrl:
							"https://drops.dagstuhl.de/storage/00lipics/lipics-vol300-esem2026/LIPIcs.ESEM.2026.30/LIPIcs.ESEM.2026.30.pdf",
					},
				},
				{
					id: "10.4230/lipics.esem.2026.14",
					attributes: {
						titles: [
							{
								title:
									"Legal Experts\u2019 Experiences with Dark Patterns in Consent Banners",
							},
						],
						creators: [
							{ givenName: "Lorena", familyName: "S\u00e1nchez Chamorro" },
							{ givenName: "Cristiana", familyName: "Santos" },
							{ givenName: "Vincent", familyName: "Koenig" },
							{ givenName: "Carine", familyName: "Lallemand" },
						],
						descriptions: [
							{
								descriptionType: "Abstract",
								description:
									"An interview study examining how legal experts assess manipulative consent banner interfaces under GDPR rules.",
							},
						],
						url: "https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ESEM.2026.14",
						contentUrl:
							"https://drops.dagstuhl.de/storage/00lipics/lipics-vol300-esem2026/LIPIcs.ESEM.2026.14/LIPIcs.ESEM.2026.14.pdf",
					},
				},
			],
		};

		const res = await fetchMultiChannelVenuePapers(
			{
				id: "esem-2026",
				name: "ESEM 2026",
				url: "https://conf.researchr.org/home/eseiw-2026",
				tracks: [
					"https://conf.researchr.org/track/eseiw-2026/eseiw-2026-esem---technical-track",
				],
				mode: "auto",
			},
			2026,
			async <T>(url: string) => {
				if (url.includes("api.datacite.org/dois")) {
					return datacitePayload as T;
				}
				return { results: [] } as T;
			},
			async () => researchrHtml,
		);

		expect(res.items).toHaveLength(3);
		for (const item of res.items) {
			expect(item.abstract.length).toBeGreaterThan(60);
			expect(item.doi).toMatch(/^10\.4230\/lipics\.esem\.2026\.\d+$/);
			expect(item.pdfUrl).toContain(".pdf");
		}
	});

	it("recovers camera-ready abstracts via OpenAlex and Semantic Scholar title search fallbacks in enrichSinglePaperOnDemand", async () => {
		const oaRecovered = await enrichSinglePaperOnDemand(
			{
				id: "venue:esem-2026:beyondresponsetime",
				title:
					"Beyond Response Time: Quantifying the Energy Cost of Performance Antipatterns in Microservices",
				authors: [
					"Vincenzo Stoico",
					"Lucia Berardinelli",
					"Raffaela Mirandola",
				],
				abstract: "",
				publishedAt: "2026-01-01T00:00:00Z",
				year: 2026,
				sourceType: "venue",
				sourceLabel: "ESEM 2026",
				categories: ["ESEM 2026"],
				url: "https://conf.researchr.org/home/eseiw-2026",
				citationCount: 0,
				keywords: ["Microservices"],
			},
			async <T>(url: string) => {
				if (url.includes("api.openalex.org/works?search=")) {
					return {
						results: [
							{
								id: "https://openalex.org/W1",
								title:
									"Beyond Response Time: Investigating the Power Behavior of Performance Antipatterns",
								publication_year: 2026,
								doi: "https://doi.org/10.4230/LIPIcs.ESEM.2026.30",
								cited_by_count: 2,
								abstract_inverted_index: {
									Camera: [0],
									ready: [1],
									power: [2],
									behavior: [3],
									abstract: [4],
									from: [5],
									OpenAlex: [6],
									index: [7],
								},
								authorships: [
									{ author: { display_name: "Vincenzo Stoico" } },
									{ author: { display_name: "Raffaela Mirandola" } },
								],
							},
						],
					} as T;
				}
				return {} as T;
			},
		);
		expect(oaRecovered.abstract).toBe(
			"Camera ready power behavior abstract from OpenAlex index",
		);
		expect(oaRecovered.doi).toBe("10.4230/LIPIcs.ESEM.2026.30");

		const s2Recovered = await enrichSinglePaperOnDemand(
			{
				id: "venue:esem-2026:llmvuln",
				title:
					"Do LLM Vulnerability-Detection Agents Reason Better? An Empirical Decomposition of Stability, Independence, and Grounding",
				authors: ["Zhen Yu", "Zhiyu Wang", "Yang Liu"],
				abstract: "",
				publishedAt: "2026-01-01T00:00:00Z",
				year: 2026,
				sourceType: "venue",
				sourceLabel: "ESEM 2026",
				categories: ["ESEM 2026"],
				url: "https://conf.researchr.org/home/eseiw-2026",
				citationCount: 0,
				keywords: ["Vulnerability Detection"],
			},
			async <T>(url: string) => {
				if (url.includes("api.openalex.org/works?search=")) {
					return { results: [] } as T;
				}
				if (url.includes("api.semanticscholar.org/graph/v1/paper/search")) {
					return {
						data: [
							{
								title:
									"Do LLM Vulnerability-Detection Agents Reason Better? An Empirical Decomposition of Robustness, Resistance, and Grounding",
								year: 2026,
								authors: [
									{ name: "Zhen Yu" },
									{ name: "Zhiyu Wang" },
									{ name: "Yang Liu" },
								],
								abstract:
									"Semantic Scholar camera-ready abstract covering robustness and resistance of LLM agents.",
								citationCount: 4,
								externalIds: { DOI: "10.4230/LIPIcs.ESEM.2026.28" },
							},
						],
					} as T;
				}
				return {} as T;
			},
		);
		expect(s2Recovered.abstract).toBe(
			"Semantic Scholar camera-ready abstract covering robustness and resistance of LLM agents.",
		);
		expect(s2Recovered.doi).toBe("10.4230/LIPIcs.ESEM.2026.28");
	});
});
