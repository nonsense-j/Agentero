/**
 * Syncs the Plaza Paper Collection state to the local Host cache
 * (`<cache>/agentero/plaza-collection/snapshot.json`) so Deep Search's
 * session-scoped `agentero-collection` MCP server always reads fresh papers.
 */

import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";
import type { CollectionState } from "@/lib/plaza/collection";

let lastSyncedFingerprint: string | null = null;
let inFlightFingerprint: string | null = null;
let inFlightPromise: Promise<void> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function computeStateFingerprint(state: CollectionState): string {
	const firstId = state.items[0]?.id ?? "";
	const lastId = state.items[state.items.length - 1]?.id ?? "";
	return [
		state.lastRefreshedAt ?? "",
		state.items.length,
		firstId,
		lastId,
		state.categories.join(","),
		state.venues.length,
	].join("|");
}

function toSnapshotPayload(state: CollectionState) {
	return {
		updatedAt: state.lastRefreshedAt ?? new Date().toISOString(),
		categories: state.categories,
		venues: state.venues.map((v) => ({
			id: v.id,
			name: v.name,
			kind: v.kind ?? null,
			domain: v.domain ?? null,
			ccfRank: v.ccfRank ?? null,
		})),
		items: state.items.map((item) => ({
			id: item.id,
			title: item.title,
			authors: item.authors,
			abstract: item.abstract,
			publishedAt: item.publishedAt,
			year: item.year,
			sourceType: item.sourceType,
			sourceLabel: item.sourceLabel,
			categories: item.categories,
			url: item.url,
			pdfUrl: item.pdfUrl ?? null,
			arxivId: item.arxivId ?? null,
			doi: item.doi ?? null,
			venueId: item.venueId ?? null,
			venueKind: item.venueKind ?? null,
			venueDomain: item.venueDomain ?? null,
			ccfRank: item.ccfRank ?? null,
			venueFull: item.venueFull ?? null,
			citationCount: item.citationCount ?? 0,
			keywords: item.keywords ?? [],
		})),
	};
}

/**
 * Immediately flush `state` to the Host snapshot file if not already synced.
 * Safe to await right before spawning a Deep Search turn.
 */
export async function ensureCollectionSnapshotSynced(
	state: CollectionState,
): Promise<void> {
	if (!isTauri()) return;
	if (debounceTimer) {
		clearTimeout(debounceTimer);
		debounceTimer = null;
	}
	const fp = computeStateFingerprint(state);
	if (lastSyncedFingerprint === fp) return;
	if (inFlightPromise && inFlightFingerprint === fp) {
		await inFlightPromise;
		return;
	}

	const payload = toSnapshotPayload(state);
	inFlightFingerprint = fp;
	const task = callApi(() => commands.plazaCollectionSyncSnapshot(payload))
		.then(() => {
			lastSyncedFingerprint = fp;
		})
		.finally(() => {
			if (inFlightFingerprint === fp) {
				inFlightFingerprint = null;
				inFlightPromise = null;
			}
		});
	inFlightPromise = task;
	await task;
}

/**
 * Debounced background sync triggered when `CollectionState` updates in Plaza.
 */
export function scheduleCollectionSnapshotSync(state: CollectionState): void {
	if (!isTauri()) return;
	const fp = computeStateFingerprint(state);
	if (lastSyncedFingerprint === fp) return;
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		void ensureCollectionSnapshotSynced(state).catch(() => undefined);
	}, 350);
}
