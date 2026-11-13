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
	refreshArxivCollection,
	refreshVenueCollection,
	type VenueRefreshProgress,
} from "@/lib/plaza/collection";
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

export function formatArxivTaskDetail(p: ArxivRefreshProgress): string {
	const counter = i18n.t("app:tasks.plazaArxivProgress", {
		completed: p.completed,
		total: p.total,
	});
	if (!p.category || p.completed >= p.total) {
		return counter;
	}
	const subject =
		p.subTotal != null && p.subTotal > 0 && p.subCompleted != null
			? `${p.category} (${p.subCompleted}/${p.subTotal})`
			: p.category;
	return `${subject} · ${counter}`;
}

export function formatVenueTaskDetail(p: VenueRefreshProgress): string {
	const counter = i18n.t("app:tasks.plazaVenueProgress", {
		completed: p.completed,
		total: p.total,
	});
	if (!p.venueName || p.completed >= p.total) {
		return counter;
	}
	const subject =
		p.subTotal != null && p.subTotal > 0 && p.subCompleted != null
			? `${p.venueName} (${p.subCompleted}/${p.subTotal})`
			: p.venueName;
	return `${subject} · ${counter}`;
}

export function formatArxivInlineLabel(p: ArxivRefreshProgress): string {
	return formatArxivTaskDetail(p);
}

export function formatVenueInlineLabel(p: VenueRefreshProgress): string {
	return formatVenueTaskDetail(p);
}

let inflightArxivRefresh: Promise<void> | null = null;
let inflightVenueRefresh: Promise<void> | null = null;

/** Run `arXiv` collection refresh as an integrated bottom-left background task. */
export async function refreshArxivInBackground(options?: {
	categories?: string[];
	incremental?: boolean;
}): Promise<void> {
	if (inflightArxivRefresh) return inflightArxivRefresh;

	const summary = getCollectionSummarySnapshot();
	const targetCats = options?.categories ?? summary.categories;
	const initialProgress: ArxivRefreshProgress = {
		category: targetCats[0] ?? "",
		completed: 0,
		total: targetCats.length,
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

	const taskPromise = (async () => {
		let maxProgress = 0;
		try {
			await runLocalActivity(
				{
					kind: "plazaArxivRefresh",
					title: i18n.t("app:tasks.plazaArxivRefresh"),
					detail: formatArxivTaskDetail(initialProgress),
				},
				async ({ signal, setProgress, setDetail }) => {
					setProgress(0);
					await refreshArxivCollection({
						categories: options?.categories,
						incremental: options?.incremental ?? true,
						signal,
						onProgress: (progress) => {
							maxProgress = Math.max(maxProgress, progress.overallProgress);
							setProgress(maxProgress);
							setDetail(formatArxivTaskDetail(progress));
							collectionRefreshStore.setState({
								arxivRefreshLabel: formatArxivInlineLabel(progress),
							});
						},
						onCategoryStatus: (cat, status) => {
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
					});
				},
			);
		} catch (err) {
			if (!isBackgroundTaskCancelledError(err)) {
				notifyError(errorText(err));
			}
		} finally {
			inflightArxivRefresh = null;
			collectionRefreshStore.setState({
				refreshingArxiv: false,
				arxivRefreshLabel: null,
				refreshingCategories: new Set<string>(),
			});
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

	const summary = getCollectionSummarySnapshot();
	const idSet =
		options?.venueIds && options.venueIds.length > 0
			? new Set(options.venueIds)
			: null;
	const targetVenues = idSet
		? summary.venues.filter((v) => idSet.has(v.id))
		: summary.venues;
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

	const taskPromise = (async () => {
		let maxProgress = 0;
		try {
			await runLocalActivity(
				{
					kind: "plazaVenueRefresh",
					title: i18n.t("app:tasks.plazaVenueRefresh"),
					detail: formatVenueTaskDetail(initialProgress),
				},
				async ({ signal, setProgress, setDetail }) => {
					setProgress(0);
					await refreshVenueCollection({
						venueIds: options?.venueIds,
						skipLoaded: options?.skipLoaded,
						signal,
						onProgress: (progress) => {
							maxProgress = Math.max(maxProgress, progress.overallProgress);
							setProgress(maxProgress);
							setDetail(formatVenueTaskDetail(progress));
							collectionRefreshStore.setState({
								venueRefreshLabel: formatVenueInlineLabel(progress),
							});
						},
						onVenueStatus: (venue, status) => {
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
					});
				},
			);
		} catch (err) {
			if (!isBackgroundTaskCancelledError(err)) {
				notifyError(errorText(err));
			}
		} finally {
			inflightVenueRefresh = null;
			collectionRefreshStore.setState({
				refreshingVenue: false,
				venueRefreshLabel: null,
				refreshingVenueIds: new Set<string>(),
			});
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
