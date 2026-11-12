import { normalizeArxivId } from "@/lib/paper/arxiv";
import { libraryStore, refreshLibrary } from "@/lib/paper/library-store";
import {
	cleanDoiKey,
	isPublisherDoi,
	normTitleKey,
	paperWorkKey,
	sameWorkByTitleAndAuthors,
} from "@/lib/plaza/paper-identity";
import { getVaultPath } from "@/lib/vault/store";

/** Bare arXiv id, without a version suffix. ModelScope and the catalog disagree on `vN`. */
export function bareArxivId(raw: string): string | null {
	const id = normalizeArxivId(raw);
	if (!id) return null;
	return id.replace(/v\d+$/i, "").toLowerCase();
}

export type LibraryCatalogPaperLike = {
	id?: string | null;
	title?: string | null;
	authors?: readonly string[] | null;
	arxiv_id?: string | null;
	doi?: string | null;
	path?: string | null;
	meta_source?: string | null;
};

export type CollectionImportedTarget = {
	id: string;
	title: string;
	authors: readonly string[];
	arxivId?: string | null;
	doi?: string | null;
	coolPapersId?: string | null;
};

/** Ids from a 广场 page that already match a library paper. */
export function matchingImportedIds(
	queried: string[],
	papers: LibraryCatalogPaperLike[],
): string[] {
	const have = new Set<string>();
	const folders = new Set<string>();
	for (const paper of papers) {
		const folder = paper.path?.split(/[/\\]/).pop();
		for (const raw of [paper.arxiv_id, folder]) {
			if (!raw) continue;
			const bare = bareArxivId(raw);
			if (bare) have.add(bare);
		}
		// Papers with Code rows without an arXiv version are stored as
		// `pwc-<catalog id>`, which is not an arXiv id.
		if (folder) folders.add(folder.toLowerCase());
	}
	return queried.filter((id) => {
		const bare = bareArxivId(id);
		if (bare != null && have.has(bare)) return true;
		return folders.has(`pwc-${id}`.toLowerCase());
	});
}

/**
 * Record every cross-portal lookup key (`id`, `coolPapersId`, `arxivId`, publisher `doi`,
 * and `work:${paperWorkKey(title, authors)}`) for a Plaza paper so both its Venue card
 * and its arXiv twin immediately match `isCollectionPaperImported`.
 */
export function addCollectionPaperKeys(
	target: Set<string>,
	paper: CollectionImportedTarget,
): void {
	if (paper.id) target.add(paper.id);
	if (paper.coolPapersId) target.add(paper.coolPapersId.toLowerCase());
	if (paper.arxivId) {
		target.add(paper.arxivId);
		const bare = bareArxivId(paper.arxivId);
		if (bare) target.add(bare);
	}
	if (paper.doi) {
		target.add(paper.doi.toLowerCase());
		const cleanDoi = cleanDoiKey(paper.doi);
		if (cleanDoi && isPublisherDoi(cleanDoi)) {
			target.add(`doi:${cleanDoi}`);
		}
	}
	const wk = paperWorkKey(paper.title, paper.authors);
	if (wk) {
		target.add(`work:${wk}`);
	}
}

/**
 * Check whether a Plaza `arXiv` or `Venue` card is already imported in the Vault Library
 * (matching by ID, arXiv ID, publisher DOI, or cross-portal `title + first 2 authors`).
 */
export function isCollectionPaperImported(
	paper: CollectionImportedTarget,
	importedSet: ReadonlySet<string>,
): boolean {
	if (paper.id && importedSet.has(paper.id)) return true;
	if (paper.coolPapersId && importedSet.has(paper.coolPapersId.toLowerCase())) {
		return true;
	}
	if (paper.arxivId) {
		const bare = bareArxivId(paper.arxivId);
		if (bare && importedSet.has(bare)) return true;
		if (importedSet.has(paper.arxivId)) return true;
	}
	if (paper.doi) {
		if (importedSet.has(paper.doi.toLowerCase())) return true;
		const cleanDoi = cleanDoiKey(paper.doi);
		if (
			cleanDoi &&
			isPublisherDoi(cleanDoi) &&
			importedSet.has(`doi:${cleanDoi}`)
		) {
			return true;
		}
	}
	const wk = paperWorkKey(paper.title, paper.authors);
	if (wk && importedSet.has(`work:${wk}`)) return true;
	return false;
}

/**
 * Build an O(1) key set from Vault `libraryStore` catalog rows so both `Venue` and
 * `arXiv` twins of any imported paper resolve as imported. Also bridges abbreviated
 * given-name initials (`"A. Smith"` <-> `"Alice Smith"`) for `observedPapers`.
 */
export function collectLibraryImportedKeys(
	libraryPapers: readonly LibraryCatalogPaperLike[],
	observedPapers?: readonly CollectionImportedTarget[],
): Set<string> {
	const keys = new Set<string>();
	const byTitle = new Map<
		string,
		Array<{ title: string; authors: readonly string[] }>
	>();

	for (const lib of libraryPapers) {
		if (lib.id) keys.add(lib.id);
		const folder = lib.path?.split(/[/\\]/).pop();
		if (folder) {
			keys.add(folder.toLowerCase());
			const bareFolder = bareArxivId(folder);
			if (bareFolder) keys.add(bareFolder);
		}
		if (lib.arxiv_id) {
			keys.add(lib.arxiv_id);
			const bare = bareArxivId(lib.arxiv_id);
			if (bare) keys.add(bare);
		}
		if (lib.doi) {
			keys.add(lib.doi.toLowerCase());
			const cleanDoi = cleanDoiKey(lib.doi);
			if (cleanDoi && isPublisherDoi(cleanDoi)) {
				keys.add(`doi:${cleanDoi}`);
			}
		}

		const isUnverifiedLocalOnly =
			lib.meta_source === "local" && !lib.arxiv_id && !lib.doi;
		if (!isUnverifiedLocalOnly && lib.title && lib.authors?.length) {
			const wk = paperWorkKey(lib.title, lib.authors);
			if (wk) keys.add(`work:${wk}`);
			const tk = normTitleKey(lib.title);
			if (tk) {
				const arr = byTitle.get(tk) ?? [];
				arr.push({ title: lib.title, authors: lib.authors });
				byTitle.set(tk, arr);
			}
		}
	}

	if (observedPapers && observedPapers.length > 0 && byTitle.size > 0) {
		for (const obs of observedPapers) {
			if (isCollectionPaperImported(obs, keys)) continue;
			const tk = normTitleKey(obs.title);
			const candidates = tk ? byTitle.get(tk) : undefined;
			if (!candidates) continue;
			if (
				candidates.some((c) =>
					sameWorkByTitleAndAuthors(obs.title, obs.authors, c.title, c.authors),
				)
			) {
				addCollectionPaperKeys(keys, obs);
			}
		}
	}

	return keys;
}

function waitUntilLibraryIdle(): Promise<void> {
	if (!libraryStore.getState().loading) return Promise.resolve();
	return new Promise((resolve) => {
		const unsubscribe = libraryStore.subscribe((state) => {
			if (!state.loading) {
				unsubscribe();
				resolve();
			}
		});
	});
}

async function ensureLibraryHydratedIfVaultOpen(): Promise<void> {
	if (libraryStore.getState().papers.length === 0) {
		if (libraryStore.getState().loading) await waitUntilLibraryIdle();
		const vaultPath = getVaultPath();
		const state = libraryStore.getState();
		if (
			vaultPath &&
			state.papers.length === 0 &&
			state.loadedVaultPath !== vaultPath
		) {
			await refreshLibrary();
		}
	}
}

/** Answer a Plaza panel or ModelScope frame that wants to label rows already in the library. */
export async function importedIdsInLibrary(
	ids: string[],
	options?: { limit?: number },
): Promise<string[]> {
	const limit = options?.limit ?? 200;
	const filtered = ids.filter((id) => typeof id === "string" && id.trim());
	const queried = Number.isFinite(limit) ? filtered.slice(0, limit) : filtered;
	if (!queried.length) return [];
	await ensureLibraryHydratedIfVaultOpen();
	return matchingImportedIds(queried, libraryStore.getState().papers);
}

/**
 * Hydrate Vault Library if needed and return the merged cross-portal `imported` key set
 * (`manualKeys` + all catalog keys + initial-compatible matches on `observedPapers`).
 */
export async function syncCollectionImportedKeys(
	observedPapers?: readonly CollectionImportedTarget[],
	manualKeys?: Iterable<string>,
): Promise<Set<string>> {
	await ensureLibraryHydratedIfVaultOpen();
	const keys = collectLibraryImportedKeys(
		libraryStore.getState().papers,
		observedPapers,
	);
	if (manualKeys) {
		for (const k of manualKeys) {
			keys.add(k);
		}
	}
	return keys;
}
