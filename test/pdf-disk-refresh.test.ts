import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPlaceholderTab,
	type DocTab,
	refreshPdfTab,
} from "@/lib/workspace/tabs";

const readVaultFileMock = vi.hoisted(() => vi.fn());
const localFileToArrayBufferMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/vault", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/vault")>();
	return { ...actual, readVaultFile: readVaultFileMock };
});

vi.mock("@/lib/paper", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/paper")>();
	return { ...actual, localFileToArrayBuffer: localFileToArrayBufferMock };
});

vi.mock("@/lib/core/notify", () => ({
	notifyError: vi.fn(),
	notifyUndo: vi.fn(),
	notifyWarning: vi.fn(),
	notifySuccess: vi.fn(),
}));

// Import after the mocks: applyDiskChange reads through the mocked barrels.
import {
	clearBookmarkWrites,
	noteBookmarkWrite,
} from "@/lib/pdf/bookmark-echo";
import { applyDiskChange } from "@/lib/workspace/actions";

const PDF_PATH = "/Users/philfan/l/paper/plans/a.pdf";

function makePdfTab(path: string, overrides: Partial<DocTab> = {}): DocTab {
	return {
		...createPlaceholderTab(path, "pdf"),
		loaded: true,
		pdfBytes: new ArrayBuffer(8),
		...overrides,
	};
}

describe("refreshPdfTab", () => {
	it("swaps bytes for matching pdf and translation panes", () => {
		const oldBytes = new ArrayBuffer(8);
		const pdf = makePdfTab(PDF_PATH, { pdfBytes: oldBytes });
		const translation = {
			...makePdfTab(PDF_PATH, { pdfBytes: oldBytes }),
			mode: "translation" as const,
		};
		const otherBytes = new ArrayBuffer(8);
		const other = makePdfTab("/vault/other.pdf", { pdfBytes: otherBytes });

		const fresh = new ArrayBuffer(16);
		const next = refreshPdfTab([pdf, translation, other], PDF_PATH, fresh);

		expect(next[0]?.pdfBytes).toBe(fresh);
		expect(next[0]?.loaded).toBe(true);
		expect(next[1]?.pdfBytes).toBe(fresh);
		expect(next[2]?.pdfBytes).toBe(otherBytes);
	});
});

describe("applyDiskChange pdf panes", () => {
	beforeEach(() => {
		readVaultFileMock.mockReset();
		localFileToArrayBufferMock.mockReset();
		clearBookmarkWrites();
	});

	/** Observed DiskChangeSink double: applies transforms to a local tab list. */
	function makeSink(initial: DocTab[]) {
		let tabs = initial;
		const updateTabs = vi.fn((update: (prev: DocTab[]) => DocTab[]) => {
			tabs = update(tabs);
		});
		return { getTabs: () => tabs, updateTabs };
	}

	it("re-reads the file and refreshes an open pdf pane", async () => {
		const sink = makeSink([makePdfTab(PDF_PATH)]);
		const bytes = new ArrayBuffer(16);
		localFileToArrayBufferMock.mockResolvedValue(bytes);

		await applyDiskChange(PDF_PATH, sink);

		expect(localFileToArrayBufferMock).toHaveBeenCalledWith(PDF_PATH);
		expect(sink.updateTabs).toHaveBeenCalledTimes(1);
		expect(sink.getTabs()[0]?.pdfBytes).toBe(bytes);
		// No text editor owns the path: no UTF-8 read should happen.
		expect(readVaultFileMock).not.toHaveBeenCalled();
	});

	it("skips the utf-8 read when no text tab owns the path", async () => {
		const mdTab = {
			...createPlaceholderTab("/vault/notes.md", "markdown"),
			loaded: true,
		};
		const sink = makeSink([makePdfTab(PDF_PATH), mdTab]);
		const bytes = new ArrayBuffer(4);
		localFileToArrayBufferMock.mockResolvedValue(bytes);
		readVaultFileMock.mockResolvedValue("# fresh");

		await applyDiskChange(PDF_PATH, sink);

		// Only the pdf transform lands; the markdown tab owns another path.
		expect(sink.updateTabs).toHaveBeenCalledTimes(1);
		expect(sink.getTabs()[0]?.pdfBytes).toBe(bytes);
		expect(readVaultFileMock).not.toHaveBeenCalled();
	});

	it("does not reload a pdf pane for this editor's own bookmark write", async () => {
		const sink = makeSink([makePdfTab(PDF_PATH)]);
		const previous = sink.getTabs()[0]?.pdfBytes;
		noteBookmarkWrite(PDF_PATH);

		await applyDiskChange(PDF_PATH, sink);

		expect(localFileToArrayBufferMock).not.toHaveBeenCalled();
		expect(sink.updateTabs).not.toHaveBeenCalled();
		expect(sink.getTabs()[0]?.pdfBytes).toBe(previous);
	});

	it("does nothing when the byte read fails", async () => {
		const sink = makeSink([makePdfTab(PDF_PATH)]);
		localFileToArrayBufferMock.mockResolvedValue(null);

		await applyDiskChange(PDF_PATH, sink);

		expect(sink.updateTabs).not.toHaveBeenCalled();
	});

	it("ignores changes while no pdf pane is open", async () => {
		const sink = makeSink([makePdfTab("/vault/other.pdf")]);

		await applyDiskChange(PDF_PATH, sink);

		expect(localFileToArrayBufferMock).not.toHaveBeenCalled();
		expect(sink.updateTabs).not.toHaveBeenCalled();
	});

	it("bumps a local html preview without reading the file as text", async () => {
		const htmlPath = "/vault/notes/logic.html";
		const tab = {
			...createPlaceholderTab(htmlPath, "html"),
			loaded: true,
			htmlKey: 2,
		};
		const sink = makeSink([tab]);

		await applyDiskChange(htmlPath, sink);

		expect(sink.getTabs()[0]?.htmlKey).toBe(3);
		expect(readVaultFileMock).not.toHaveBeenCalled();
		expect(localFileToArrayBufferMock).not.toHaveBeenCalled();
	});
});
