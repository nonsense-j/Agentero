import { describe, expect, it } from "vitest";
import { layoutTranslateSettledRatio } from "@/lib/pdf/layout/layout-translate-progress";

describe("layoutTranslateSettledRatio", () => {
	it("stays unknown until the job has blocks", () => {
		expect(layoutTranslateSettledRatio([])).toBeNull();
	});

	it("counts finished blocks and leaves the ones still translating empty", () => {
		expect(
			layoutTranslateSettledRatio([
				{ status: "done" },
				{ status: "running" },
				{ status: "pending" },
				{ status: "error" },
				{ status: "skipped" },
			]),
		).toBe(0.6);
	});

	it("reaches full when every block has settled", () => {
		expect(
			layoutTranslateSettledRatio([{ status: "done" }, { status: "error" }]),
		).toBe(1);
	});
	it("includes completed sentences in an unfinished paragraph", () => {
		expect(
			layoutTranslateSettledRatio([
				{ status: "running", progress: 0.5 },
				{ status: "done" },
			]),
		).toBe(0.75);
	});
});
