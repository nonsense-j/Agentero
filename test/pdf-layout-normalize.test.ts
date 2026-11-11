import { describe, expect, it } from "vitest";
import { mergeCaptionsIntoHosts } from "@/lib/pdf/layout/merge-captions";
import {
	buildLayoutDocumentResult,
	summarizeLayoutResult,
} from "@/lib/pdf/layout/normalize";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

describe("buildLayoutDocumentResult", () => {
	it("aggregates document counts and summarizes titled figures", () => {
		const rawRegions: PdfLayoutRegion[] = [
			{
				id: "1",
				pageIndex: 0,
				kind: "image",
				label: "image",
				score: 1,
				rect: { x: 60, y: 80, w: 360, h: 280 },
				bbox: { x: 0.1, y: 0.1, w: 0.6, h: 0.35 },
				readingOrder: 0,
			},
			{
				id: "cap",
				pageIndex: 0,
				kind: "figure_title",
				label: "figure_title",
				score: 0.9,
				rect: { x: 60, y: 368, w: 360, h: 40 },
				bbox: { x: 0.1, y: 0.46, w: 0.6, h: 0.05 },
				readingOrder: 1,
				title: "Figure 1: Overview",
			},
			{
				id: "2",
				pageIndex: 0,
				kind: "formula",
				label: "display_formula",
				score: 1,
				rect: { x: 0, y: 0, w: 12, h: 16 },
				bbox: { x: 0, y: 0, w: 0.02, h: 0.02 },
				readingOrder: 2,
			},
		];
		const merged = mergeCaptionsIntoHosts(rawRegions);
		const result = buildLayoutDocumentResult("doc-1", merged, rawRegions);
		// Merged figure keeps image kind; unnumbered formula dropped; bare captions dropped.
		expect(result.counts.image).toBe(1);
		expect(result.counts.formula).toBe(0);
		expect(result.rawRegions).toHaveLength(3);
		expect(summarizeLayoutResult(result)).toBe(
			"image 1, chart 0, table 0, algorithm 0, titled 1",
		);
	});
});
