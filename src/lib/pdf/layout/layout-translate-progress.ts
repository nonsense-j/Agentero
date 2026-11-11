import type { LayoutTranslateItemStatus } from "@/lib/pdf/layout/types";

/**
 * Share of a translation job that has already settled.
 *
 * Running blocks include their settled sentence share. Done, failed, and skipped
 * blocks are finished work, so a failed block does not pin the meter open.
 * No blocks yet means the total is unknown.
 */
export function layoutTranslateSettledRatio(
	items: readonly { status: LayoutTranslateItemStatus; progress?: number }[],
): number | null {
	if (items.length === 0) return null;
	let settled = 0;
	for (const item of items) {
		if (
			item.status === "done" ||
			item.status === "error" ||
			item.status === "skipped"
		) {
			settled += 1;
		} else if (item.status === "running" && Number.isFinite(item.progress)) {
			settled += Math.max(0, Math.min(1, item.progress ?? 0));
		}
	}
	return settled / items.length;
}
