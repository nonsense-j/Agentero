/**
 * 广场（Plaza）— academic discovery & collection sources.
 *
 * Virtual tree/tab paths only; nothing here ever touches disk. Adding a source
 * is a single {@link PLAZA_SOURCES} entry — the sidebar child row and the
 * center panel both derive from this registry.
 *
 * @see docs/development/plaza.md
 */

import i18n from "@/i18n";

/** Virtual tree/tab path for the Plaza parent node. */
export const PLAZA_VIRTUAL_PATH = "agentero:plaza";

/**
 * Icon key for a plaza source. Lib only carries the name; the
 * name→component map lives in the components layer
 * (`components/plaza/source-icons.ts`).
 */
export type PlazaSourceIcon =
	| "collection"
	| "discover"
	| "coolPapers"
	| "modelScope"
	| "conference"
	| "sparkles"
	| "rss"
	| "telescope"
	| "calendarClock";

export type PlazaSource = {
	id: string;
	/** `agentero:plaza/<id>` — virtual, never a filesystem path. */
	path: string;
	label: string;
	/**
	 * Canonical public site: used for "open in browser", and embedded directly
	 * when there is no proxy. `null` with no {@link panel} is a placeholder.
	 */
	url: string | null;
	/** Minimum virtual viewport for a fixed desktop layout; other sites reflow normally. */
	desktopWidth?: number;
	/** Native plaza panel (not a bare iframe). */
	panel?:
		| "collection"
		| "discover"
		| "arxivRec"
		| "ccfDeadlines"
		| "skills"
		| "feeds";
	/**
	 * Host proxy scheme origin used for embedding. A cross-origin frame cannot
	 * retarget the site's `target="_blank"` links or report its navigations, so
	 * sources meant for in-frame browsing are served under our own scheme.
	 * `null` embeds {@link url} as-is.
	 */
	embedOrigin: (() => string) | null;
	/** Icon name; rendered through the components-layer icon map. */
	icon: PlazaSourceIcon;
};

function sourcePath(id: string): string {
	return `${PLAZA_VIRTUAL_PATH}/${id}`;
}

export const PLAZA_SOURCES: readonly PlazaSource[] = [
	{
		id: "collection",
		path: sourcePath("collection"),
		label: "Paper Collection",
		url: null,
		embedOrigin: null,
		panel: "collection",
		icon: "collection",
	},
	{
		id: "discover",
		path: sourcePath("discover"),
		label: "Paper Discover",
		url: null,
		embedOrigin: null,
		panel: "discover",
		icon: "discover",
	},
	{
		id: "arxiv-rec",
		path: sourcePath("arxiv-rec"),
		label: "Paper Recommend",
		url: null,
		embedOrigin: null,
		panel: "arxivRec",
		icon: "telescope",
	},
	{
		id: "ccf-deadlines",
		path: sourcePath("ccf-deadlines"),
		label: "CCF Deadline",
		url: "https://ccfddl.com/",
		embedOrigin: null,
		panel: "ccfDeadlines",
		icon: "calendarClock",
	},
];

/** True for the Plaza parent node and every source under this parent. */
export function isPlazaVirtualPath(path: string | null | undefined): boolean {
	if (!path) return false;
	return (
		path === PLAZA_VIRTUAL_PATH || path.startsWith(`${PLAZA_VIRTUAL_PATH}/`)
	);
}

/** The source owning this path, or `null` for the Plaza root / non-Plaza paths. */
export function plazaSourceForPath(
	path: string | null | undefined,
): PlazaSource | null {
	if (!path) return null;
	return PLAZA_SOURCES.find((source) => source.path === path) ?? null;
}

/** Sources not hidden by the user (`plazaHiddenSources` setting). */
export function visiblePlazaSources(
	hiddenIds: readonly string[],
): PlazaSource[] {
	if (hiddenIds.length === 0) return [...PLAZA_SOURCES];
	const hidden = new Set(hiddenIds);
	return PLAZA_SOURCES.filter((source) => !hidden.has(source.id));
}

/** Tab title for any Plaza path. */
export function plazaSourceLabel(source: PlazaSource): string {
	switch (source.id) {
		case "collection":
			return i18n.t("sidebar:plaza.collection.label", {
				defaultValue: "Paper Collection",
			});
		case "discover":
			return i18n.t("sidebar:plaza.discover.label", {
				defaultValue: "Paper Discover",
			});
		case "arxiv-rec":
			return i18n.t("sidebar:plaza.arxivRec.label", {
				defaultValue: "Paper Recommend",
			});
		case "ccf-deadlines":
			return i18n.t("sidebar:plaza.ccfDeadlines.label", {
				defaultValue: "CCF Deadline",
			});
		default:
			return source.label;
	}
}

export function plazaTitleForPath(path: string): string {
	const source = plazaSourceForPath(path);
	return source ? plazaSourceLabel(source) : i18n.t("sidebar:plaza.plaza");
}
