import { afterEach, describe, expect, it, vi } from "vitest";
import * as importActions from "@/lib/paper/import-actions";
import {
	type CollectionPaperItem,
	listCollectionPapers,
	resetCollectionMemoryForTests,
} from "@/lib/plaza/collection";
import { importCollectionPapers } from "@/lib/plaza/collection-import";
import {
	addCollectionPaperKeys,
	collectLibraryImportedKeys,
	isCollectionPaperImported,
} from "@/lib/plaza/imported";
import {
	paperWorkKey,
	sameCollectionPaperWork,
} from "@/lib/plaza/paper-identity";
import {
	searchCollectionFast,
	searchCollectionFastRemote,
} from "@/lib/plaza/paper-search";
import {
	recommendNextFromCollection,
	saveRecommendPoolState,
} from "@/lib/plaza/recommend-pool";
import { installMockCollectionIpc } from "./helpers/mock-collection-ipc";

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));

const ARXIV_TWIN: CollectionPaperItem = {
	id: "arxiv:2603.00777",
	title: "Multi-Agent Vulnerability Repair: A Systematic Study",
	authors: ["Alice B. Smith", "Bob Jones", "Carol Lee"],
	abstract:
		"We present a systematic study of multi-agent vulnerability repair across 200 real-world CVEs.",
	publishedAt: "2026-03-04T00:00:00Z",
	year: 2026,
	sourceType: "arxiv",
	sourceLabel: "cs.SE",
	categories: ["cs.SE"],
	url: "https://arxiv.org/abs/2603.00777",
	pdfUrl: "https://arxiv.org/pdf/2603.00777",
	arxivId: "2603.00777",
	keywords: ["Vulnerability Repair", "Multi-Agent"],
	citationCount: 19,
};

const VENUE_TWIN_WITHOUT_ARXIV_ID: CollectionPaperItem = {
	id: "venue:icse-2026:doi:10.1145/3660000.3660777",
	title: "Multi-Agent Vulnerability Repair - A Systematic Study.",
	authors: ["Smith, Alice", "B. Jones", "Different Third"],
	abstract: "",
	publishedAt: "2026-04-12T00:00:00Z",
	year: 2026,
	sourceType: "venue",
	sourceLabel: "ICSE 2026",
	categories: ["ICSE 2026"],
	url: "https://doi.org/10.1145/3660000.3660777",
	doi: "10.1145/3660000.3660777",
	venueId: "icse-2026",
	venueKind: "conference",
	venueDomain: "PL/SE",
	ccfRank: "CCF-A",
	keywords: ["ICSE"],
	citationCount: 7,
};

afterEach(() => {
	vi.restoreAllMocks();
	resetCollectionMemoryForTests();
});

describe("Plaza cross-portal (arXiv + Venue) deduplication and unified import", () => {
	it("identifies cross-portal twins by normalized title + first 2 authors without false positives", () => {
		expect(paperWorkKey(ARXIV_TWIN.title, ARXIV_TWIN.authors)).toBe(
			"multiagentvulnerabilityrepairasystematicstudy::alicesmith|bobjones",
		);
		expect(
			sameCollectionPaperWork(ARXIV_TWIN, VENUE_TWIN_WITHOUT_ARXIV_ID),
		).toBe(true);

		const distinctAuthorPaper: CollectionPaperItem = {
			...ARXIV_TWIN,
			id: "arxiv:2603.00999",
			arxivId: "2603.00999",
			authors: ["Aaron Smith", "Bob Jones"],
		};
		expect(
			sameCollectionPaperWork(VENUE_TWIN_WITHOUT_ARXIV_ID, distinctAuthorPaper),
		).toBe(false);
	});

	it("keeps both arXiv and Venue in the full Paper Collection pool while keeping only Venue in search and recommend", async () => {
		const ipc = installMockCollectionIpc({
			items: [ARXIV_TWIN, VENUE_TWIN_WITHOUT_ARXIV_ID],
		});
		try {
			// Full pool retains both entries
			const fullPage = await listCollectionPapers({});
			expect(fullPage.total).toBe(2);
			expect(fullPage.items.map((p) => p.sourceType).sort()).toEqual([
				"arxiv",
				"venue",
			]);

			// Local & remote Fast Search keep ONLY Venue, even when query matches arXiv-only text
			const localRes = searchCollectionFast(
				[ARXIV_TWIN, VENUE_TWIN_WITHOUT_ARXIV_ID],
				'"vulnerability repair"',
			);
			expect(localRes.totalMatched).toBe(1);
			expect(localRes.items[0].paper.id).toBe(VENUE_TWIN_WITHOUT_ARXIV_ID.id);
			expect(localRes.items[0].paper.arxivId).toBe("2603.00777");
			expect(localRes.items[0].paper.pdfUrl).toBe(
				"https://arxiv.org/pdf/2603.00777",
			);
			expect(localRes.items[0].paper.citationCount).toBe(19);

			const remoteRes = await searchCollectionFastRemote("CVEs");
			expect(remoteRes.totalMatched).toBe(1);
			expect(remoteRes.items[0].paper.id).toBe(VENUE_TWIN_WITHOUT_ARXIV_ID.id);
			expect(remoteRes.items[0].paper.sourceType).toBe("venue");

			// Explicit `sourceType: "arxiv"` still returns arXiv when requested
			const arxivOnly = await searchCollectionFastRemote("CVEs", {
				sourceType: "arxiv",
			});
			expect(arxivOnly.totalMatched).toBe(1);
			expect(arxivOnly.items[0].paper.id).toBe(ARXIV_TWIN.id);

			// Paper Recommend returns ONLY Venue and marks BOTH Venue and arXiv as recommendedAt
			await saveRecommendPoolState({
				keywords: [
					{ id: "kw-vr", term: "Vulnerability Repair", enabled: true },
				],
				selectedCloudTerms: [],
				wordCloudTopN: 25,
				lastRecommendedAt: null,
			});
			const rec1 = await recommendNextFromCollection(5);
			expect(rec1.items).toHaveLength(1);
			expect(rec1.items[0].id).toBe(VENUE_TWIN_WITHOUT_ARXIV_ID.id);
			expect(rec1.items[0].arxivId).toBe("2603.00777");
			expect(rec1.exhausted).toBe(true);

			const rec2 = await recommendNextFromCollection(5);
			expect(rec2.items).toHaveLength(0);
		} finally {
			ipc.restore();
		}
	});

	it("resolves sibling arXiv ID when importing a Venue card and marks both Venue and arXiv cards as imported", async () => {
		const ipc = installMockCollectionIpc({
			items: [ARXIV_TWIN, VENUE_TWIN_WITHOUT_ARXIV_ID],
		});
		const submittedIdentifiers: string[] = [];
		vi.spyOn(importActions, "lookupSubmit").mockImplementation(
			async (texts, opts) => {
				submittedIdentifiers.push(...texts);
				await opts?.onComplete?.({
					imported: [
						{
							id: "2603.00777",
							title: ARXIV_TWIN.title,
							path: "papers/2603.00777",
							paperDir: "/vault/papers/2603.00777",
							usedTranslator: false,
							translatorBaseUrl: "",
							status: "created",
						},
					],
					skillCandidates: [],
					searchCandidates: [],
					errors: [],
				});
			},
		);

		try {
			const importedSet = new Set<string>();
			await importCollectionPapers([VENUE_TWIN_WITHOUT_ARXIV_ID], {
				onMarked: (done) => {
					for (const p of done) {
						addCollectionPaperKeys(importedSet, p);
					}
				},
			});

			// Automatically upgraded to `arXiv:2603.00777` so PDF + LaTeX source are fetched
			// while backend `enrich_paper_record_from_collection` attaches ICSE 2026 + DOI
			expect(submittedIdentifiers).toEqual(["arXiv:2603.00777"]);
			expect(
				isCollectionPaperImported(VENUE_TWIN_WITHOUT_ARXIV_ID, importedSet),
			).toBe(true);
			expect(isCollectionPaperImported(ARXIV_TWIN, importedSet)).toBe(true);

			// Also verify catalog hydration marks both cards even when matched solely by `title + first 2 authors`
			const catalogKeys = collectLibraryImportedKeys(
				[
					{
						id: "smith2026repair",
						title: "Multi-Agent Vulnerability Repair: A Systematic Study",
						authors: ["Alice Smith", "Bob Jones"],
						meta_source: "crossref",
						path: "papers/smith2026repair",
					},
				],
				[ARXIV_TWIN, VENUE_TWIN_WITHOUT_ARXIV_ID],
			);
			expect(
				isCollectionPaperImported(VENUE_TWIN_WITHOUT_ARXIV_ID, catalogKeys),
			).toBe(true);
			expect(isCollectionPaperImported(ARXIV_TWIN, catalogKeys)).toBe(true);
		} finally {
			ipc.restore();
		}
	});
});
