/**
 * Shared Plaza Paper Collection refresh runner + store.
 *
 * Keeps `arXiv` and `Venue` refreshes as two independent background tasks in the
 * bottom-left `BackgroundTasksPanel` (with monotonic % progress, `<current> ·
 * arXiv|Venue <completed>/<total>` status counters, and AbortSignal cancellation),
 * while mirroring live progress to Plaza Collection and Discover views across tab switches.
 */

import { createStore, useStore } from "zustand";
import i18n from "@/i18n";
import { isBackgroundTaskCancelledError } from "@/lib/core/background-tasks";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { runLocalActivity } from "@/lib/core/tasks";
import {
	type ArxivRefreshProgress,
	isSeedSyncActive,
	refreshArxivCollection,
	refreshVenueCollection,
	type VenueRefreshProgress,
} from "@/lib/plaza/collection";
import {
	formatArxivCategoryList,
	raceWithAbort,
} from "@/lib/plaza/collection-enrichment";
import { getCollectionSummarySnapshot } from "@/lib/plaza/collection-store";

export type CollectionRefreshState = {
	refreshingArxiv: boolean;
	refreshingVenue: boolean;
	arxivRefreshLabel: string | null;
	venueRefreshLabel: string | null;
	refreshingCategories: Set<string>;
	refreshedCategories: Set<string>;
	refreshingVenueIds: Set<string>;
	refreshedVenueIds: Set<string>;
};

export const collectionRefreshStore = createStore<CollectionRefreshState>(
	() => ({
		refreshingArxiv: false,
		refreshingVenue: false,
		arxivRefreshLabel: null,
		venueRefreshLabel: null,
		refreshingCategories: new Set<string>(),
		refreshedCategories: new Set<string>(),
		refreshingVenueIds: new Set<string>(),
		refreshedVenueIds: new Set<string>(),
	}),
);

export function useCollectionRefreshStore<T>(
	selector: (state: CollectionRefreshState) => T,
): T {
	return useStore(collectionRefreshStore, selector);
}

export function formatArxivTaskTitle(_p?: ArxivRefreshProgress): string {
	return i18n.t("app:tasks.plazaArxivRefresh");
}

export function formatVenueTaskTitle(p: VenueRefreshProgress): string {
	const base = i18n.t("app:tasks.plazaVenueRefresh");
	if (p.total <= 0) return base;
	const current = Math.min(p.total, p.completed + 1);
	return `${base} ${current}/${p.total}`;
}

export function computeCollectionTaskProgress(p: {
	completed: number;
	total: number;
	subCompleted?: number;
	subTotal?: number;
}): number | null {
	if (p.total <= 0 || p.completed >= p.total) return 100;
	if (p.subTotal != null && p.subTotal > 0 && p.subCompleted != null) {
		return Math.min(
			100,
			Math.max(0, Math.round((p.subCompleted / p.subTotal) * 100)),
		);
	}
	return null;
}

export function formatArxivTaskDetail(
	p: ArxivRefreshProgress,
	targetCategories?: readonly string[],
): string {
	if (!p.category || p.completed >= p.total) {
		const names =
			targetCategories && targetCategories.length > 0
				? targetCategories
				: p.category
					? [p.category]
					: [];
		if (names.length > 0) {
			return i18n.t("app:tasks.plazaArxivFinished", {
				targets: names.join(", "),
			});
		}
		return i18n.t("app:tasks.plazaArxivProgress", {
			completed: p.completed,
			total: p.total,
		});
	}
	if (p.stage === "preparing") {
		const totalCats = Math.max(1, p.total);
		const current = Math.min(
			totalCats,
			Math.max(1, p.preparingIndex ?? p.completed + 1),
		);
		if (p.subTotal != null && p.subTotal > 0 && p.subCompleted != null) {
			return i18n.t("app:tasks.plazaPreparingPapersCount", {
				current,
				total: totalCats,
				target: p.category,
				completed: p.subCompleted,
				totalPapers: p.subTotal,
			});
		}
		return i18n.t("app:tasks.plazaPreparingPapers", {
			current,
			total: totalCats,
			target: p.category,
		});
	}
	const compactTarget = p.category.includes(",")
		? formatArxivCategoryList(p.category.split(","))
		: p.category;
	if (p.subTotal != null && p.subTotal > 0 && p.subCompleted != null) {
		return i18n.t("app:tasks.plazaCollectingPapers", {
			target: compactTarget,
			completed: p.subCompleted,
			total: p.subTotal,
		});
	}
	return i18n.t("app:tasks.plazaCollectingPapersPending", {
		target: compactTarget,
	});
}

export function formatVenueTaskDetail(
	p: VenueRefreshProgress,
	targetVenueNames?: readonly string[],
): string {
	if (!p.venueName || p.completed >= p.total) {
		const names =
			targetVenueNames && targetVenueNames.length > 0
				? targetVenueNames
				: p.venueName
					? [p.venueName]
					: [];
		if (names.length > 0 && names.length <= 3) {
			return i18n.t("app:tasks.plazaVenueFinished", {
				targets: names.join(", "),
			});
		}
		if (p.total > 0) {
			return i18n.t("app:tasks.plazaVenueFinished", {
				targets: `${p.completed}/${p.total}`,
			});
		}
		return i18n.t("app:tasks.plazaVenueProgress", {
			completed: p.completed,
			total: p.total,
		});
	}
	if (p.subTotal != null && p.subTotal > 0 && p.subCompleted != null) {
		return i18n.t("app:tasks.plazaCollectingPapers", {
			target: p.venueName,
			completed: p.subCompleted,
			total: p.subTotal,
		});
	}
	return i18n.t("app:tasks.plazaCollectingPapersPending", {
		target: p.venueName,
	});
}

export function formatArxivInlineLabel(p: ArxivRefreshProgress): string {
	return formatArxivTaskDetail(p);
}

export function formatVenueInlineLabel(p: VenueRefreshProgress): string {
	return formatVenueTaskDetail(p);
}

let inflightArxivRefresh: Promise<void> | null = null;
let inflightVenueRefresh: Promise<void> | null = null;
let arxivRefreshRunId = 0;
let venueRefreshRunId = 0;

/** Run `arXiv` collection refresh as an integrated bottom-left background task. */
export async function refreshArxivInBackground(options?: {
	categories?: string[];
	incremental?: boolean;
}): Promise<void> {
	if (inflightArxivRefresh) return inflightArxivRefresh;
	if (isSeedSyncActive()) return;

	const summary = getCollectionSummarySnapshot();
	const targetCats = options?.categories ?? summary.categories;
	const initialProgress: ArxivRefreshProgress = {
		category: targetCats[0] ?? "",
		completed: 0,
		total: targetCats.length,
		stage: "preparing",
		preparingIndex: 1,
		overallProgress: 0,
	};

	collectionRefreshStore.setState((s) => {
		const nextRefreshing = new Set(s.refreshingCategories);
		const nextRefreshed = new Set(s.refreshedCategories);
		for (const cat of targetCats) {
			nextRefreshing.add(cat);
			nextRefreshed.delete(cat);
		}
		return {
			...s,
			refreshingArxiv: true,
			arxivRefreshLabel: formatArxivInlineLabel(initialProgress),
			refreshingCategories: nextRefreshing,
			refreshedCategories: nextRefreshed,
		};
	});

	const runId = ++arxivRefreshRunId;
	const taskPromise = (async () => {
		try {
			await runLocalActivity(
				{
					kind: "plazaArxivRefresh",
					title: formatArxivTaskTitle(initialProgress),
					detail: formatArxivTaskDetail(initialProgress, targetCats),
				},
				async ({ signal, setTitle, setProgress, setDetail }) => {
					setProgress(computeCollectionTaskProgress(initialProgress));
					await raceWithAbort(
						refreshArxivCollection({
							categories: options?.categories,
							incremental: options?.incremental ?? true,
							signal,
							onProgress: (progress) => {
								if (signal.aborted) return;
								setTitle(formatArxivTaskTitle(progress));
								setProgress(computeCollectionTaskProgress(progress));
								setDetail(formatArxivTaskDetail(progress, targetCats));
								collectionRefreshStore.setState({
									arxivRefreshLabel: formatArxivInlineLabel(progress),
								});
							},
							onCategoryStatus: (cat, status) => {
								if (signal.aborted) return;
								collectionRefreshStore.setState((s) => {
									const nextRefreshing = new Set(s.refreshingCategories);
									const nextRefreshed = new Set(s.refreshedCategories);
									if (status === "refreshing") {
										nextRefreshing.add(cat);
										nextRefreshed.delete(cat);
									} else if (status === "done") {
										nextRefreshing.delete(cat);
										nextRefreshed.add(cat);
									} else {
										nextRefreshing.delete(cat);
									}
									return {
										...s,
										refreshingCategories: nextRefreshing,
										refreshedCategories: nextRefreshed,
									};
								});
							},
						}),
						signal,
					);
				},
			);
		} catch (err) {
			if (!isBackgroundTaskCancelledError(err)) {
				notifyError(errorText(err));
			}
		} finally {
			if (arxivRefreshRunId === runId) {
				inflightArxivRefresh = null;
				collectionRefreshStore.setState({
					refreshingArxiv: false,
					arxivRefreshLabel: null,
					refreshingCategories: new Set<string>(),
				});
			}
		}
	})();

	inflightArxivRefresh = taskPromise;
	return taskPromise;
}

/** Run `Venue` collection refresh as an integrated bottom-left background task. */
export async function refreshVenueInBackground(options?: {
	venueIds?: string[];
	skipLoaded?: boolean;
}): Promise<void> {
	if (inflightVenueRefresh) return inflightVenueRefresh;
	if (isSeedSyncActive()) return;

	const summary = getCollectionSummarySnapshot();
	const idSet =
		options?.venueIds && options.venueIds.length > 0
			? new Set(options.venueIds)
			: null;
	const targetVenues = idSet
		? summary.venues.filter((v) => idSet.has(v.id))
		: summary.venues;
	const targetVenueNames = targetVenues.map((v) => v.name);
	const firstVenue = targetVenues[0];
	const initialProgress: VenueRefreshProgress = {
		venueId: firstVenue?.id ?? "",
		venueName: firstVenue?.name ?? "",
		completed: 0,
		total: targetVenues.length,
		overallProgress: 0,
	};

	collectionRefreshStore.setState((s) => {
		const nextRefreshing = new Set(s.refreshingVenueIds);
		const nextRefreshed = new Set(s.refreshedVenueIds);
		for (const v of targetVenues) {
			nextRefreshing.add(v.id);
			nextRefreshed.delete(v.id);
		}
		return {
			...s,
			refreshingVenue: true,
			venueRefreshLabel: formatVenueInlineLabel(initialProgress),
			refreshingVenueIds: nextRefreshing,
			refreshedVenueIds: nextRefreshed,
		};
	});

	const runId = ++venueRefreshRunId;
	const taskPromise = (async () => {
		try {
			await runLocalActivity(
				{
					kind: "plazaVenueRefresh",
					title: formatVenueTaskTitle(initialProgress),
					detail: formatVenueTaskDetail(initialProgress, targetVenueNames),
				},
				async ({ signal, setTitle, setProgress, setDetail }) => {
					setProgress(computeCollectionTaskProgress(initialProgress));
					await raceWithAbort(
						refreshVenueCollection({
							venueIds: options?.venueIds,
							skipLoaded: options?.skipLoaded,
							signal,
							onProgress: (progress) => {
								if (signal.aborted) return;
								setTitle(formatVenueTaskTitle(progress));
								setProgress(computeCollectionTaskProgress(progress));
								setDetail(formatVenueTaskDetail(progress, targetVenueNames));
								collectionRefreshStore.setState({
									venueRefreshLabel: formatVenueInlineLabel(progress),
								});
							},
							onVenueStatus: (venue, status) => {
								if (signal.aborted) return;
								collectionRefreshStore.setState((s) => {
									const nextRefreshing = new Set(s.refreshingVenueIds);
									const nextRefreshed = new Set(s.refreshedVenueIds);
									if (status === "refreshing") {
										nextRefreshing.add(venue.id);
										nextRefreshed.delete(venue.id);
									} else if (status === "done") {
										nextRefreshing.delete(venue.id);
										nextRefreshed.add(venue.id);
									} else {
										nextRefreshing.delete(venue.id);
									}
									return {
										...s,
										refreshingVenueIds: nextRefreshing,
										refreshedVenueIds: nextRefreshed,
									};
								});
							},
						}),
						signal,
					);
				},
			);
		} catch (err) {
			if (!isBackgroundTaskCancelledError(err)) {
				notifyError(errorText(err));
			}
		} finally {
			if (venueRefreshRunId === runId) {
				inflightVenueRefresh = null;
				collectionRefreshStore.setState({
					refreshingVenue: false,
					venueRefreshLabel: null,
					refreshingVenueIds: new Set<string>(),
				});
			}
		}
	})();

	inflightVenueRefresh = taskPromise;
	return taskPromise;
}

/**
 * Refresh both `arXiv` and `Venue` as two separate background tasks so the
 * bottom-left panel displays each pipeline's progress and cancel action independently.
 */
export async function refreshAllInBackground(options?: {
	incrementalArxiv?: boolean;
	skipLoadedVenues?: boolean;
}): Promise<void> {
	await Promise.all([
		refreshArxivInBackground({
			incremental: options?.incrementalArxiv,
		}),
		refreshVenueInBackground({
			skipLoaded: options?.skipLoadedVenues,
		}),
	]);
}
