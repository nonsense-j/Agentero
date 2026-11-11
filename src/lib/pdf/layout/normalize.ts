import type {
	PdfLayoutDocumentResult,
	PdfLayoutKind,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";

function emptyCounts(): Record<PdfLayoutKind, number> {
	return {
		image: 0,
		table: 0,
		algorithm: 0,
		formula: 0,
		formula_number: 0,
		chart: 0,
		figure_title: 0,
		header: 0,
		abstract: 0,
		text: 0,
	};
}

export function buildLayoutDocumentResult(
	documentId: string,
	regions: PdfLayoutRegion[],
	/** Pre-merge detections; defaults to `regions` when not provided. */
	rawRegions: PdfLayoutRegion[] = regions,
): PdfLayoutDocumentResult {
	const counts = emptyCounts();
	for (const region of regions) {
		counts[region.kind] += 1;
	}
	return {
		documentId,
		updatedAt: Date.now(),
		regions,
		rawRegions,
		counts,
	};
}

export function summarizeLayoutResult(result: PdfLayoutDocumentResult): string {
	const { counts } = result;
	const titled = result.regions.filter((r) => Boolean(r.title?.trim())).length;
	const formulaPart = counts.formula > 0 ? `, formula ${counts.formula}` : "";
	return `image ${counts.image}, chart ${counts.chart}, table ${counts.table}, algorithm ${counts.algorithm}${formulaPart}${titled ? `, titled ${titled}` : ""}`;
}
