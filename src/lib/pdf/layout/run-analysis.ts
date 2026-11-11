import type {
	PdfDocumentObject,
	PdfEngine,
	PdfTextRun,
} from "@embedpdf/models";
import { events } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { isTauri } from "@/lib/core/tauri";
import { findCanonicalPaperPdfPath, localFileToArrayBuffer } from "@/lib/paper";
import {
	type LayoutSidecarMode,
	layoutSidecarNeedsTextLayer,
	layoutSidecarWasReplaced,
	readLayoutSidecar,
	writeLayoutIndexFromRaw,
	writeLayoutSidecar,
	writeLayoutTextBackfill,
} from "@/lib/pdf/layout/io";
import { mergeCaptionsIntoHosts } from "@/lib/pdf/layout/merge-captions";
import {
	buildLayoutDocumentResult,
	summarizeLayoutResult,
} from "@/lib/pdf/layout/normalize";
import {
	invokeLayoutRemoteAnalyzePdf,
	paddlePageToRegions,
} from "@/lib/pdf/layout/paddle";
import {
	isRemoteLayoutProvider,
	layoutProviderFor,
	type RemoteLayoutProviderDescriptor,
} from "@/lib/pdf/layout/providers";
import {
	setLayoutAnalysisUi,
	setLayoutDocumentResult,
} from "@/lib/pdf/layout/store";
import {
	attachTitlesFromTextRuns,
	enrichCaptionRegionsWithText,
} from "@/lib/pdf/layout/title-text";
import type {
	PdfLayoutDocumentResult,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";
import { loadSettings } from "@/lib/settings/store";

export type LayoutTextSource = {
	getPageSize: (pageIndex: number) => { width: number; height: number } | null;
	getPageTextRuns: (pageIndex: number) => Promise<{ runs?: PdfTextRun[] }>;
};

export function createPdfEngineLayoutTextSource(
	engine: PdfEngine,
	getDocument: () => PdfDocumentObject | null | undefined,
): LayoutTextSource {
	return {
		getPageSize: (pageIndex) => {
			const size = getDocument()?.pages[pageIndex]?.size;
			return size && size.width > 0 && size.height > 0 ? size : null;
		},
		getPageTextRuns: async (pageIndex) => {
			const doc = getDocument();
			const page = doc?.pages[pageIndex];
			if (!doc || !page) return { runs: [] };
			return engine.getPageTextRuns(doc, page).toPromise();
		},
	};
}

export type RunLayoutAnalysisOptions = {
	/**
	 * When true, ignore `source/layout.json` and re-run remote layout analysis.
	 * When false (default), load the sidecar if present and only re-run
	 * merge/filter into the sidebar store (JSON→regions).
	 */
	force?: boolean;
	/** Paper folder path; when present, raw layout persists to source/layout.json. */
	paperAbsPath?: string | null;
	/** PDF page count for progress bar before the first page-complete event. */
	totalPages?: number | null;
	/** Label shown in progress UI instead of the generic "Analyzing layout…". */
	paperLabel?: string;
	/** Optional live document guard for viewer-bound analysis. */
	isDocumentOpen?: () => boolean;
	/**
	 * True PDF page size in points for remote backends (the service renders
	 * pages itself, so sizes cannot come from a local render).
	 */
	pageSizeAt?: (pageIndex: number) => { width: number; height: number } | null;
	onDone?: (summary: string, total: number) => void;
	onError?: (message: string, aborted: boolean) => void;
};

export type LayoutTaskErrorReason = {
	type?: string;
	message?: string;
};

/** Task handle returned by an active remote layout analysis run. */
export type LayoutTaskLike = {
	wait: (
		ok: () => void,
		err: (e: { type?: string; reason?: unknown }) => void,
	) => void;
	abort: (reason?: LayoutTaskErrorReason) => void;
};

class LayoutDocumentClosedError extends Error {
	constructor() {
		super("document closed");
		this.name = "LayoutDocumentClosedError";
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (!error || typeof error !== "object") return "";
	const record = error as Record<string, unknown>;
	if (typeof record.message === "string") return record.message;
	const reason = record.reason;
	if (typeof reason === "string") return reason;
	if (reason && typeof reason === "object") {
		const reasonMessage = (reason as Record<string, unknown>).message;
		if (typeof reasonMessage === "string") return reasonMessage;
	}
	return "";
}

function isPdfDocumentCloseRaceError(error: unknown): boolean {
	return /document (does not|is not|not) open/i.test(errorMessage(error));
}

function isLayoutDocumentClosedError(error: unknown): boolean {
	return (
		error instanceof LayoutDocumentClosedError ||
		isPdfDocumentCloseRaceError(error)
	);
}

function assertDocumentOpen(isDocumentOpen?: () => boolean): void {
	if (isDocumentOpen && !isDocumentOpen()) {
		throw new LayoutDocumentClosedError();
	}
}

function clampProgress(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function buildResultFromRawRegions(
	documentId: string,
	rawRegions: PdfLayoutRegion[],
): PdfLayoutDocumentResult {
	return buildLayoutDocumentResult(
		documentId,
		mergeCaptionsIntoHosts(rawRegions),
		rawRegions,
	);
}

/** Prefer PDF page size; else recover size from point-rect / normalized bbox. */
function estimatePageSizesFromRegions(
	regions: readonly PdfLayoutRegion[],
	textSource: LayoutTextSource,
	options: RunLayoutAnalysisOptions,
): Map<number, { width: number; height: number }> {
	const pageSizes = new Map<number, { width: number; height: number }>();
	const pages = new Set(regions.map((r) => r.pageIndex));
	for (let pageIndex = 0; pageIndex < (options.totalPages ?? 0); pageIndex++) {
		pages.add(pageIndex);
	}
	for (const pageIndex of pages) {
		assertDocumentOpen(options.isDocumentOpen);
		const size =
			options.pageSizeAt?.(pageIndex) ?? textSource.getPageSize(pageIndex);
		if (size && size.width > 0 && size.height > 0) {
			pageSizes.set(pageIndex, size);
			continue;
		}
		// rect (points) / bbox (0–1) ⇒ page size.
		let width = 0;
		let height = 0;
		for (const r of regions) {
			if (r.pageIndex !== pageIndex) continue;
			if (r.bbox.w > 0.02) width = Math.max(width, r.rect.w / r.bbox.w);
			if (r.bbox.h > 0.02) height = Math.max(height, r.rect.h / r.bbox.h);
		}
		// Keep unknown pages in the walk so they cannot be marked complete.
		pageSizes.set(pageIndex, { width, height });
	}
	return pageSizes;
}

/** Pull PDF text layer into caption / body / abstract fields per page. */
async function enrichRawRegionsWithPageText(
	textSource: LayoutTextSource,
	raw: PdfLayoutRegion[],
	pageSizes: Map<number, { width: number; height: number }>,
	isDocumentOpen?: () => boolean,
): Promise<{ regions: PdfLayoutRegion[]; complete: boolean }> {
	let next = raw;
	let complete = true;
	const pages = new Set([...pageSizes.keys(), ...raw.map((r) => r.pageIndex)]);
	for (const pageIndex of pages) {
		assertDocumentOpen(isDocumentOpen);
		const pageSize = pageSizes.get(pageIndex);
		if (!pageSize || pageSize.width <= 0 || pageSize.height <= 0) {
			complete = false;
			continue;
		}
		try {
			const textRuns = await textSource.getPageTextRuns(pageIndex);
			assertDocumentOpen(isDocumentOpen);
			const runs = textRuns.runs ?? [];
			next = enrichCaptionRegionsWithText(next, pageIndex, runs, pageSize);
		} catch (error) {
			if (
				isLayoutDocumentClosedError(error) ||
				(isDocumentOpen && !isDocumentOpen())
			) {
				throw new LayoutDocumentClosedError();
			}
			complete = false;
		}
	}
	return { regions: next, complete };
}

/**
 * Shared analyze-all-pages runner for toolbar + PdfViewerHandle + figures panel.
 */
export async function runDocumentLayoutAnalysis(
	textSource: LayoutTextSource,
	documentId: string,
	options: RunLayoutAnalysisOptions = {},
): Promise<LayoutTaskLike | null> {
	const started = performance.now();
	const onDone = options.onDone;
	options = {
		...options,
		onDone: (summary, count) => {
			logger.info("pdf.layout.complete", {
				documentId,
				duration_ms: Math.round(performance.now() - started),
			});
			onDone?.(summary, count);
		},
	};

	/** Attribute progress to this paper so the open Figures rail can match. */
	const paperKey = options.paperAbsPath ?? null;
	const setUi = (
		ui: Parameters<typeof setLayoutAnalysisUi>[0],
		withPaper = false,
	) => {
		setLayoutAnalysisUi(ui, documentId, withPaper ? paperKey : undefined);
	};

	const cancelClosedDocument = () => {
		setUi({ stage: "cancelled" });
		options.onError?.("document closed", true);
	};
	if (options.isDocumentOpen && !options.isDocumentOpen()) {
		cancelClosedDocument();
		return null;
	}

	// Default path: JSON→sidebar re-merge from layout.json.
	// `force` skips this and re-runs remote layout analysis.
	if (!options.force && options.paperAbsPath) {
		const cached = await readLayoutSidecar(options.paperAbsPath);
		if (options.isDocumentOpen && !options.isDocumentOpen()) {
			cancelClosedDocument();
			return null;
		}
		if (cached) {
			try {
				// No textLayerExtracted flag: walk the text layer once, including
				// boxes that already have text, then write it back. A flagged
				// sidecar only merges in memory and does not show analyzing.
				const needsText = layoutSidecarNeedsTextLayer(cached);
				if (needsText) {
					setUi(
						{
							stage: "running",
							message: "Rebuilding from cached layout…",
							progress: null,
						},
						true,
					);
				}
				const extracted = needsText
					? await enrichRawRegionsWithPageText(
							textSource,
							cached.regions,
							estimatePageSizesFromRegions(cached.regions, textSource, options),
							options.isDocumentOpen,
						)
					: null;
				const raw = extracted?.regions ?? cached.regions;
				if (options.isDocumentOpen && !options.isDocumentOpen()) {
					cancelClosedDocument();
					return null;
				}
				// A force re-run can replace layout.json while this merge is
				// still on the previous parse. Publishing that parse would put
				// the stale regions back into the open viewer's store.
				const latest = await readLayoutSidecar(options.paperAbsPath);
				if (
					layoutSidecarWasReplaced(
						cached.source.generatedAt,
						latest?.source.generatedAt,
					)
				) {
					return null;
				}
				if (options.isDocumentOpen && !options.isDocumentOpen()) {
					cancelClosedDocument();
					return null;
				}
				// Always re-run merge/filter so algorithm tweaks apply from cache.
				const result = buildResultFromRawRegions(documentId, raw);
				// A finished text walk is written back onto this same parse. A newer
				// sidecar (mode, generatedAt, or box geometry) is left untouched.
				if (needsText && extracted?.complete) {
					try {
						const wrote = await writeLayoutTextBackfill(
							options.paperAbsPath,
							cached,
							raw,
						);
						if (!wrote) {
							logger.warn(
								"layout text backfill skipped; sidecar parse changed",
							);
						}
					} catch (error) {
						logger.warn("layout text backfill failed", {
							error: errorText(error),
						});
					}
				}
				setLayoutDocumentResult(result);
				const summary = summarizeLayoutResult(result);
				setUi({
					stage: "done",
					message: summary,
					total: result.regions.length,
				});
				console.info("[layout-analysis]", {
					documentId,
					summary,
					cache: true,
					regions: result.regions,
				});
				// The index write is a no-op when the content is unchanged.
				void writeLayoutIndexFromRaw(options.paperAbsPath, raw).catch(
					() => undefined,
				);
				options.onDone?.(summary, result.regions.length);
				return null;
			} catch (error) {
				if (
					isLayoutDocumentClosedError(error) ||
					(options.isDocumentOpen && !options.isDocumentOpen())
				) {
					cancelClosedDocument();
					return null;
				}
				throw error;
			}
		}
	}

	const analyzingMessage = options.paperLabel?.trim() || "Analyzing layout…";

	setUi(
		{
			stage: "running",
			message: analyzingMessage,
			progress: null,
		},
		true,
	);

	// Remote layout backend (Settings → Layout): whole-PDF async job.
	const provider = layoutProviderFor(loadSettings().layout.backend);
	if (
		provider &&
		isRemoteLayoutProvider(provider) &&
		options.paperAbsPath &&
		typeof options.totalPages === "number" &&
		options.totalPages > 0
	) {
		return startRemoteLayoutAnalysis(
			provider,
			textSource,
			documentId,
			options,
			{
				paperAbsPath: options.paperAbsPath,
				totalPages: Math.floor(options.totalPages),
				analyzingMessage,
				cancelClosedDocument,
			},
		);
	}

	const message = "Layout analysis requires a local paper PDF";
	setUi({ stage: "error", message });
	options.onError?.(message, false);
	return null;
}

/** Minimal task handle for a remote provider run. */
class RemoteLayoutTask implements LayoutTaskLike {
	private settled = false;
	private aborted = false;

	wait(
		ok: () => void,
		err: (e: { type?: string; reason?: unknown }) => void,
	): void {
		this.onSettle = (e) => {
			if (e === "ok") ok();
			else err(e);
		};
		if (this.settled && this.settleError) {
			this.onSettle(this.settleError);
		} else if (this.settled) {
			this.onSettle("ok");
		}
	}

	abort(reason?: LayoutTaskErrorReason): void {
		if (this.settled) return;
		this.aborted = true;
		this.settle({ type: "abort", reason });
	}

	get isAborted(): boolean {
		return this.aborted;
	}

	private onSettle:
		| ((e: "ok" | { type?: string; reason?: unknown }) => void)
		| null = null;
	private settleError: { type?: string; reason?: unknown } | null = null;

	settle(error?: { type?: string; reason?: unknown }): void {
		if (this.settled) return;
		this.settled = true;
		this.settleError = error ?? null;
		if (this.onSettle) this.onSettle(error ?? "ok");
	}
}

/** Shared tail of remote runners: enrich → merge → sidecar → store. */
async function finalizeRemoteLayoutRegions(args: {
	textSource: LayoutTextSource;
	documentId: string;
	options: RunLayoutAnalysisOptions;
	task: RemoteLayoutTask;
	raw: PdfLayoutRegion[];
	pageSizes: Map<number, { width: number; height: number }>;
	totalPages: number;
	backendLabel: string;
	sidecarMode: LayoutSidecarMode;
	cancelClosedDocument: () => void;
}): Promise<void> {
	const { textSource, documentId, options, task, pageSizes, totalPages } = args;
	assertDocumentOpen(options.isDocumentOpen);
	setLayoutAnalysisUi(
		{
			stage: "running",
			message: "Merging figures & captions…",
			progress: 99,
			page: totalPages,
			completed: totalPages,
			total: totalPages,
		},
		documentId,
		options.paperAbsPath,
	);

	const extracted = await enrichRawRegionsWithPageText(
		textSource,
		args.raw,
		pageSizes,
		options.isDocumentOpen,
	);
	let enriched = extracted.regions;
	const textLayerExtracted = extracted.complete;
	assertDocumentOpen(options.isDocumentOpen);

	let result = buildResultFromRawRegions(documentId, enriched);
	let regions = result.regions;
	for (const pageIndex of pageSizes.keys()) {
		assertDocumentOpen(options.isDocumentOpen);
		const pageSize = pageSizes.get(pageIndex);
		if (!pageSize) continue;
		const need = regions.some(
			(r) => r.pageIndex === pageIndex && r.titleBbox && !r.title?.trim(),
		);
		if (!need) continue;
		try {
			const textRuns = await textSource.getPageTextRuns(pageIndex);
			assertDocumentOpen(options.isDocumentOpen);
			regions = attachTitlesFromTextRuns(
				regions,
				pageIndex,
				textRuns.runs ?? [],
				pageSize,
			);
			result = buildLayoutDocumentResult(documentId, regions, enriched);
		} catch (error) {
			if (
				isLayoutDocumentClosedError(error) ||
				(options.isDocumentOpen && !options.isDocumentOpen())
			) {
				throw new LayoutDocumentClosedError();
			}
			// ignore per-page title failures
		}
	}
	enriched = result.rawRegions;

	try {
		await writeLayoutSidecar(options.paperAbsPath, enriched, args.sidecarMode, {
			textLayerExtracted,
		});
	} catch (e) {
		const message = errorText(e);
		logger.warn("layout sidecar write failed", { error: message });
	}
	try {
		await writeLayoutIndexFromRaw(options.paperAbsPath, enriched);
	} catch (e) {
		const message = errorText(e);
		logger.warn("layout index write failed", { error: message });
	}

	if (options.isDocumentOpen && !options.isDocumentOpen()) {
		args.cancelClosedDocument();
		return;
	}
	setLayoutDocumentResult(result);
	const summary = summarizeLayoutResult(result);
	setLayoutAnalysisUi(
		{ stage: "done", message: summary, total: result.regions.length },
		documentId,
	);
	console.info("[layout-analysis]", {
		documentId,
		summary,
		backend: args.backendLabel,
		regions: result.regions,
	});
	options.onDone?.(summary, result.regions.length);
	task.settle();
}

type RemoteRunDeps = {
	paperAbsPath: string;
	totalPages: number;
	analyzingMessage: string;
	cancelClosedDocument: () => void;
};

/** Only affects the point `rect` when no real page size is known. */
const CLOUD_FALLBACK_PAGE_SIZE = { width: 595, height: 842 };

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(
			...bytes.subarray(offset, offset + chunkSize),
		);
	}
	return btoa(binary);
}

/**
 * Remote provider run: upload the whole PDF once as an async job; the Host
 * polls and streams progress events, then per-page boxes come back in one
 * result — no per-page rendering or requests on our side.
 */
function startRemoteLayoutAnalysis(
	provider: RemoteLayoutProviderDescriptor,
	textSource: LayoutTextSource,
	documentId: string,
	options: RunLayoutAnalysisOptions,
	deps: RemoteRunDeps,
): RemoteLayoutTask {
	const task = new RemoteLayoutTask();
	const { paperAbsPath, totalPages, analyzingMessage } = deps;

	void (async () => {
		let unlisten: (() => void) | null = null;
		try {
			assertDocumentOpen(options.isDocumentOpen);
			const pdfPath = await findCanonicalPaperPdfPath(paperAbsPath);
			if (!pdfPath) throw new Error("No local PDF for layout analysis");
			const buffer = await localFileToArrayBuffer(pdfPath);
			if (!buffer) throw new Error("Failed to read paper PDF");
			assertDocumentOpen(options.isDocumentOpen);

			const requestId = `layout-remote-${documentId}`;
			// Host emits job progress (upload → pending/running → download).
			if (isTauri()) {
				unlisten = await events.layoutRemoteProgress.listen((event) => {
					const p = event.payload;
					if (p.requestId && p.requestId !== requestId) return;
					const known =
						typeof p.totalPages === "number" && p.totalPages > 0
							? p.totalPages
							: totalPages;
					const done =
						typeof p.extractedPages === "number" ? p.extractedPages : 0;
					const progress =
						p.phase === "uploading"
							? 3
							: p.phase === "downloading" || p.phase === "done"
								? 96
								: clampProgress(6 + (done / known) * 88);
					setLayoutAnalysisUi(
						{
							stage: "running",
							message: analyzingMessage,
							progress,
							page: Math.min(done + 1, known),
							completed: done,
							total: known,
						},
						documentId,
						paperAbsPath,
					);
				});
			}

			setLayoutAnalysisUi(
				{
					stage: "running",
					message: analyzingMessage,
					progress: 2,
					completed: 0,
					total: totalPages,
				},
				documentId,
				paperAbsPath,
			);
			const res = await invokeLayoutRemoteAnalyzePdf({
				provider: provider.id,
				pdfBase64: arrayBufferToBase64(buffer),
				fileName: pdfPath.split(/[/\\]/).pop() || "paper.pdf",
				requestId,
			});
			unlisten?.();
			unlisten = null;
			assertDocumentOpen(options.isDocumentOpen);
			if (task.isAborted) return;

			const raw: PdfLayoutRegion[] = [];
			const pageSizes = new Map<number, { width: number; height: number }>();
			for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
				const sourceSize = textSource.getPageSize(pageIndex);
				const injected = options.pageSizeAt?.(pageIndex) ?? null;
				const size =
					sourceSize && sourceSize.width > 0 && sourceSize.height > 0
						? sourceSize
						: injected && injected.width > 0 && injected.height > 0
							? injected
							: CLOUD_FALLBACK_PAGE_SIZE;
				pageSizes.set(pageIndex, size);
				const page = res.pages[pageIndex];
				if (!page) continue;
				raw.push(
					...paddlePageToRegions({
						page,
						pageIndex,
						pageWidth: size.width,
						pageHeight: size.height,
						idPrefix: provider.id,
					}),
				);
			}

			await finalizeRemoteLayoutRegions({
				textSource,
				documentId,
				options,
				task,
				raw,
				pageSizes,
				totalPages,
				backendLabel: provider.id,
				sidecarMode: provider.sidecarMode,
				cancelClosedDocument: deps.cancelClosedDocument,
			});
		} catch (error) {
			if (
				isLayoutDocumentClosedError(error) ||
				(options.isDocumentOpen && !options.isDocumentOpen())
			) {
				deps.cancelClosedDocument();
				task.settle({
					type: "abort",
					reason: { type: "no-document", message: "document closed" },
				});
				return;
			}
			const message = errorText(error);
			setLayoutAnalysisUi({ stage: "error", message }, documentId);
			options.onError?.(message, false);
			task.settle({ type: "error", reason: { message } });
		} finally {
			unlisten?.();
		}
	})();

	return task;
}
