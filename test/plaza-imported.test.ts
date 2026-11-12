import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearLibraryVaultState,
	libraryStore,
} from "@/lib/paper/library-store";
import {
	importedIdsInLibrary,
	matchingImportedIds,
} from "@/lib/plaza/imported";

const mocks = vi.hoisted(() => ({
	vaultPath: "/vault-empty" as string | null,
	listPapers: vi.fn(async () => [] as Array<{ path: string; title: string }>),
}));

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/vault/store", () => ({
	getVaultPath: () => mocks.vaultPath,
}));
vi.mock("@/lib/paper/api", () => ({
	listPapers: mocks.listPapers,
	rescanPapers: vi.fn(async () => undefined),
	setPaperTags: vi.fn(),
}));

describe("ModelScope & Plaza imported ids", () => {
	beforeEach(() => {
		clearLibraryVaultState();
		mocks.vaultPath = "/vault-empty";
		mocks.listPapers.mockReset();
		mocks.listPapers.mockResolvedValue([]);
	});

	it("matches a catalog arXiv id and ignores the version suffix", () => {
		const matched = matchingImportedIds(
			["2501.00001", "2501.00002v3", "not-a-paper"],
			[{ arxiv_id: "2501.00001v1", path: "papers/other" }],
		);
		expect(matched).toEqual(["2501.00001"]);
	});

	it("matches a paper whose folder name is the arXiv id", () => {
		const matched = matchingImportedIds(
			["2503.11111"],
			[{ arxiv_id: null, path: "papers\\2503.11111" }],
		);
		expect(matched).toEqual(["2503.11111"]);
	});

	it("fetches paper_list only once when the open vault library is empty (no subscribe loop)", async () => {
		let subscriberSyncCalls = 0;
		const unsub = libraryStore.subscribe((state, prev) => {
			if (state.papers !== prev.papers) {
				subscriberSyncCalls += 1;
				void importedIdsInLibrary(["2603.00001"]);
			}
		});

		try {
			const first = await importedIdsInLibrary(["2603.00001"]);
			const second = await importedIdsInLibrary(["2603.00001"]);
			expect(first).toEqual([]);
			expect(second).toEqual([]);
			expect(mocks.listPapers).toHaveBeenCalledTimes(1);
			expect(subscriberSyncCalls).toBe(0);
		} finally {
			unsub();
		}
	});

	it("supports unbounded id lists for local Paper Collection sync", async () => {
		mocks.listPapers.mockResolvedValueOnce([
			{
				path: "papers/2603.00250",
				title: "Paper 250",
				arxiv_id: "2603.00250",
				updated_at: "2026-03-01T00:00:00Z",
				is_read: false,
				has_pdf: true,
			} as never,
		]);
		const ids = Array.from(
			{ length: 260 },
			(_, i) => `2603.${String(i + 1).padStart(5, "0")}`,
		);
		const matched = await importedIdsInLibrary(ids, {
			limit: Number.POSITIVE_INFINITY,
		});
		expect(matched).toEqual(["2603.00250"]);
	});
});
