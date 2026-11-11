/**
 * Headless layout analysis: open a paper PDF off-viewer, run remote layout
 * analysis, and write `{paper}/source/layout.json`. Used after download/import
 * so sidecar is ready before the user opens the paper.
 */

import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { errorText } from "@/lib/core/error";
import { findCanonicalPaperPdfPath, localFileToArrayBuffer } from "@/lib/paper";
import { createPdfEngine } from "@/lib/pdf/engine";
import {
	layoutSidecarBlocksAnalysis,
	readLayoutSidecar,
	writeLayoutIndexFromRaw,
} from "@/lib/pdf/layout/io";
import {
	createPdfEngineLayoutTextSource,
	type LayoutTaskLike,
	runDocumentLayoutAnalysis,
} from "@/lib/pdf/layout/run-analysis";
import { clearLayoutDocumentResult } from "@/lib/pdf/layout/store";

let analysisEngine: PdfEngine | null = null;
let analysisEnginePromise: Promise<PdfEngine> | null = null;

export async function getHeadlessPdfEngine(): Promise<PdfEngine> {
	if (analysisEngine) return analysisEngine;
	if (analysisEnginePromise) return analysisEnginePromise;
	const pending = createPdfEngine().then((engine) => {
		analysisEngine = engine;
		return engine;
	});
	analysisEnginePromise = pending;
	try {
		return await pending;
	} finally {
		if (analysisEnginePromise === pending) analysisEnginePromise = null;
	}
}

export type HeadlessLayoutResult = {
	fromCache: boolean;
	summary: string;
	regionCount: number;
};

/**
 * Ensure layout sidecar exists for a paper folder. Hits cache when present
 * unless `force` is set. Opens `{paper}/{id}.pdf` only — never an
 * illustration PDF under `source/assets/`.
 */
export async function analyzePaperLayoutHeadless(opts: {
	paperAbsPath: string;
	/** Label shown in the background-task toast instead of "Analyzing layout…". */
	paperLabel?: string;
	/** Caller-owned EmbedPDF document id, so progress can be attributed to this run. */
	documentId?: string;
	/**
	 * Re-run even when `source/layout.json` already has regions. JobCenter
	 * stores this on the task; it has to be read here or a force enqueue
	 * still returns the cached sidecar.
	 */
	force?: boolean;
	signal?: AbortSignal;
}): Promise<HeadlessLayoutResult> {
	const paperAbsPath = opts.paperAbsPath.replace(/[/\\]+$/, "");
	if (opts.signal?.aborted) throw new Error("cancelled");

	const existing = await readLayoutSidecar(paperAbsPath);
	if (opts.signal?.aborted) throw new Error("cancelled");
	if (
		existing &&
		layoutSidecarBlocksAnalysis(opts.force, existing.regions.length)
	) {
		// Ensure CLI-facing sidebar index exists even on raw-only cache hits.
		try {
			if (opts.signal?.aborted) throw new Error("cancelled");
			await writeLayoutIndexFromRaw(paperAbsPath, existing.regions);
		} catch (error) {
			if (opts.signal?.aborted || errorText(error) === "cancelled") {
				throw new Error("cancelled");
			}
			// non-fatal
		}
		return {
			fromCache: true,
			summary: `cached ${existing.regions.length} regions`,
			regionCount: existing.regions.length,
		};
	}

	const pdfPath = await findCanonicalPaperPdfPath(paperAbsPath);
	if (!pdfPath) {
		// Soft-skip: callers may race ahead of DownloadAssets. Re-enqueue after
		// the PDF lands rather than failing the job with "No local PDF".
		return {
			fromCache: false,
			summary: "skipped: no local PDF",
			regionCount: 0,
		};
	}
	const buffer = await localFileToArrayBuffer(pdfPath);
	if (!buffer) {
		throw new Error("Failed to read paper PDF");
	}
	if (opts.signal?.aborted) throw new Error("cancelled");

	const engine = await getHeadlessPdfEngine();
	const documentId =
		opts.documentId ?? `headless-layout-${Date.now().toString(36)}`;
	let doc: PdfDocumentObject | null = null;
	let docOpen = false;

	try {
		doc = await engine
			.openDocumentBuffer({
				id: documentId,
				content: buffer,
			})
			.toPromise();
		docOpen = true;
		const pageCount = doc.pageCount ?? 0;
		if (opts.signal?.aborted) throw new Error("cancelled");

		const textSource = createPdfEngineLayoutTextSource(engine, () =>
			docOpen ? doc : null,
		);
		const summary = await new Promise<string>((resolve, reject) => {
			let settled = false;
			let layoutTask: LayoutTaskLike | null = null;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				opts.signal?.removeEventListener("abort", onAbort);
				fn();
			};
			function onAbort() {
				layoutTask?.abort({ type: "no-document", message: "cancelled" });
				layoutTask = null;
				finish(() => reject(new Error("cancelled")));
			}
			opts.signal?.addEventListener("abort", onAbort);
			void runDocumentLayoutAnalysis(textSource, documentId, {
				paperAbsPath,
				paperLabel: opts.paperLabel,
				totalPages: pageCount > 0 ? pageCount : null,
				force: opts.force === true,
				pageSizeAt: (pageIndex) => {
					const size = doc?.pages[pageIndex]?.size;
					return size && size.width > 0 && size.height > 0 ? size : null;
				},
				isDocumentOpen: () => docOpen && !opts.signal?.aborted,
				onDone: (s) => finish(() => resolve(s)),
				onError: (message, aborted) => {
					finish(() => {
						if (aborted) reject(new Error("cancelled"));
						else reject(new Error(message));
					});
				},
			})
				.then((task) => {
					layoutTask = task;
					// Cache path: onDone already fired before null return.
					if (task == null && !settled) {
						finish(() => resolve("cached"));
					} else if (task && opts.signal?.aborted) {
						onAbort();
					}
				})
				.catch((e) =>
					finish(() => reject(e instanceof Error ? e : new Error(String(e)))),
				);
		});

		const sidecar = await readLayoutSidecar(paperAbsPath);
		return {
			fromCache: false,
			summary,
			regionCount: sidecar?.regions?.length ?? 0,
		};
	} finally {
		const openedDoc = doc;
		docOpen = false;
		doc = null;
		if (openedDoc) {
			try {
				await engine
					.closeDocument(openedDoc)
					.toPromise()
					.catch(() => undefined);
			} catch {
				// ignore close errors
			}
		}
		clearLayoutDocumentResult(documentId);
	}
}
