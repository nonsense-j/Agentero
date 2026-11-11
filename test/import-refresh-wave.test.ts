import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	backgroundTasksStore,
	startBackgroundTask,
} from "@/lib/core/background-tasks";
import {
	clearRefreshWave,
	noteCommittedPaths,
	noteExternalLibraryPaths,
	noteTreePaths,
	noteWikiPath,
	registerWikiRevisionBump,
} from "@/lib/lifecycle/refresh-wave";
import { ensurePaperRows, listPapers } from "@/lib/paper/api";
import { setLibraryPapers } from "@/lib/paper/library-store";
import {
	getVaultPath,
	refreshKnownDirectories,
	removeTreePaths,
} from "@/lib/vault/store";
import { applyWikiPaths } from "@/lib/wiki/api";
import { notifyWikiEmbedTargets } from "@/lib/wiki/embed-refresh";

vi.mock("@/lib/paper/api", () => ({
	ensurePaperRows: vi.fn(async () => ({ count: 1, rescanned: false })),
	listPapers: vi.fn(async () => [{ path: "papers/a", title: "A" }]),
}));
vi.mock("@/lib/paper/library-store", () => ({
	setLibraryPapers: vi.fn(),
}));
vi.mock("@/lib/vault/store", () => ({
	getVaultPath: vi.fn(() => "/vault"),
	scheduleTreeRefresh: vi.fn(),
	refreshKnownDirectories: vi.fn(async () => undefined),
	removeTreePaths: vi.fn(),
}));
vi.mock("@/lib/vault/shell-activity", () => ({
	watchRefreshDelayMs: () => 400,
}));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/wiki/api", () => ({
	applyWikiPaths: vi.fn(async () => ({ indexedFiles: 1, edges: 0, nodes: 1 })),
}));
vi.mock("@/lib/wiki/embed-refresh", () => ({
	notifyWikiEmbedTargets: vi.fn(),
}));

function settleTask(id: string): void {
	backgroundTasksStore.setState((state) => ({
		tasks: state.tasks.map((task) =>
			task.id === id ? { ...task, status: "completed" as const } : task,
		),
	}));
}

describe("import refresh wave", () => {
	const bump = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		clearRefreshWave();
		backgroundTasksStore.setState({ tasks: [], expanded: false });
		registerWikiRevisionBump(bump);
	});

	it("refreshes once after an import and recognition wave, not once per paper", async () => {
		const first = startBackgroundTask({
			kind: "import",
			title: "import",
			id: "import-1",
		});
		noteCommittedPaths(["/vault/papers/a"]);
		noteCommittedPaths(["/vault/papers/b"]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(listPapers).not.toHaveBeenCalled();
		expect(applyWikiPaths).not.toHaveBeenCalled();

		settleTask(first);
		const recognize = startBackgroundTask({
			kind: "recognizeMetadata",
			title: "recognize",
			id: "recognize-1",
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(listPapers).not.toHaveBeenCalled();

		settleTask(recognize);
		await vi.advanceTimersByTimeAsync(400);

		expect(listPapers).toHaveBeenCalledTimes(1);
		expect(ensurePaperRows).not.toHaveBeenCalled();
		expect(applyWikiPaths).toHaveBeenCalledTimes(1);
		expect(applyWikiPaths).toHaveBeenCalledWith("/vault", [
			"/vault/papers/a",
			"/vault/papers/b",
		]);
		expect(refreshKnownDirectories).toHaveBeenCalledWith([
			"/vault/papers/a",
			"/vault/papers/b",
		]);
		expect(removeTreePaths).not.toHaveBeenCalled();
		expect(setLibraryPapers).toHaveBeenCalledTimes(1);
		expect(bump).toHaveBeenCalledTimes(1);
		expect(notifyWikiEmbedTargets).toHaveBeenCalledTimes(1);
	});

	it("holds watcher refreshes until the import wave finishes", async () => {
		const job = startBackgroundTask({
			kind: "import",
			title: "import",
			id: "import-hold",
		});
		noteCommittedPaths(["/vault/papers/nlp/a"]);
		noteExternalLibraryPaths(["/vault/papers/nlp/b/NOTES.md"]);
		noteTreePaths(["/vault/papers/nlp/b"]);
		await vi.advanceTimersByTimeAsync(2000);
		expect(listPapers).not.toHaveBeenCalled();
		expect(ensurePaperRows).not.toHaveBeenCalled();
		expect(refreshKnownDirectories).not.toHaveBeenCalled();

		settleTask(job);
		await vi.advanceTimersByTimeAsync(400);
		expect(ensurePaperRows).toHaveBeenCalledWith("/vault", [
			"/vault/papers/nlp/b/NOTES.md",
		]);
		expect(refreshKnownDirectories).toHaveBeenCalledWith(
			expect.arrayContaining(["/vault/papers/nlp/a", "/vault/papers/nlp/b"]),
		);
	});

	it("ensures external paper paths instead of treating them as a committed list", async () => {
		noteExternalLibraryPaths(["/vault/papers/ext/NOTES.md"]);
		await vi.advanceTimersByTimeAsync(400);

		expect(ensurePaperRows).toHaveBeenCalledWith("/vault", [
			"/vault/papers/ext/NOTES.md",
		]);
		expect(listPapers).toHaveBeenCalledTimes(1);
		expect(applyWikiPaths).toHaveBeenCalledWith("/vault", [
			"/vault/papers/ext/NOTES.md",
		]);
	});

	it("keeps watcher echoes of a committed paper on the wave", async () => {
		noteCommittedPaths(["/vault/papers/a"]);
		noteExternalLibraryPaths(["/vault/papers/a/NOTES.md"]);
		noteWikiPath("/vault/papers/a/paper.pdf");
		await vi.advanceTimersByTimeAsync(400);

		expect(ensurePaperRows).not.toHaveBeenCalled();
		expect(listPapers).toHaveBeenCalledTimes(1);
		expect(applyWikiPaths).toHaveBeenCalledWith(
			"/vault",
			expect.arrayContaining([
				"/vault/papers/a",
				"/vault/papers/a/NOTES.md",
				"/vault/papers/a/paper.pdf",
			]),
		);
	});

	it("skips the flush when no vault is open", async () => {
		vi.mocked(getVaultPath).mockReturnValue(null);
		noteWikiPath("/vault/notes/External.md");
		await vi.advanceTimersByTimeAsync(400);
		expect(applyWikiPaths).not.toHaveBeenCalled();
		expect(listPapers).not.toHaveBeenCalled();
	});
});
