/**
 * Native 广场 panel: Paper Collection (2026–Now arXiv + 28 DBLP 2026 Venues).
 *
 * Two-stage flow:
 * 1. Portal Hub: Separate `arXiv` (`cs.SE`, `cs.CR`, `cs.PL`, `cs.AI`, …) and
 *    `Venue` (`Conference` + `Journal`, all 2026 from DBLP) entry cards.
 * 2. List View: Top navigation bar with source switcher, `arXiv`-only time filter
 *    (`2026-Now` / `30d` / `7d`), sub-entry chips, 100-paper initial slice with
 *    +50 preloaded Load More, and full detail dialog on card click.
 */

import {
	ArrowLeft,
	ArrowUpRight,
	BookOpen,
	Check,
	CheckSquare,
	ChevronDown,
	Download,
	Loader2,
	Plus,
	Quote,
	RefreshCw,
	Settings2,
	Sparkles,
	Square,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PlazaSourceBadge } from "@/components/icons/plaza-icons";
import {
	COLLECTION_OUTLINE_BTN_CLASS,
	COLLECTION_PRIMARY_BTN_CLASS,
	CollectionPaperDetailDialog,
} from "@/components/plaza/collection-paper-detail-dialog";
import {
	CollectionPortalHub,
	type VenueKindFilter,
} from "@/components/plaza/collection-portal-hub";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { lookupSubmit } from "@/lib/paper/import-actions";
import {
	type ArxivUpdateCheckResult,
	type CollectionPaperItem,
	type CollectionSourceType,
	type CollectionState,
	checkArxivCollectionUpdate,
	DEFAULT_ARXIV_CATEGORIES,
	ensureVenueLoaded,
	fetchMoreArxivCollection,
	hydrateCollectionStateFromIdb,
	inferVenueKind,
	isPreloadingCollection,
	isVenueAlreadyLoaded,
	loadCollectionState,
	matchesAnyArxivCategory,
	preloadAll2026ArxivInBackground,
	refreshArxivCollection,
	refreshVenueCollection,
	saveCollectionState,
	subscribeCollectionState,
	subscribePreloadingCollection,
	type VenueConfig,
	type VenueDomain,
} from "@/lib/plaza/collection";
import { ARXIV_ALL_CATEGORIES } from "@/lib/plaza/feeds";
import { openRemoteArxivPaper } from "@/lib/workspace/actions";

type ViewStage = "hub" | "list";
type TimeRangeFilter = "all" | "30d" | "7d";
type DomainFilter = "all" | VenueDomain;

const INITIAL_DISPLAY_COUNT = 100;
const LOAD_MORE_STEP = 50;

const COLLECTION_ICON_BTN_CLASS =
	"text-foreground/80 hover:bg-black/[0.06] hover:text-foreground dark:bg-white/[0.08] dark:text-zinc-100 dark:ring-1 dark:ring-inset dark:ring-white/15 dark:hover:bg-white/[0.15] dark:hover:text-white";

const COLLECTION_CARD_IMPORT_BTN_CLASS =
	"bg-blue-500/10 text-blue-600 ring-1 ring-inset ring-blue-500/20 hover:bg-blue-600 hover:text-white dark:bg-blue-500/20 dark:text-blue-200 dark:ring-blue-400/35 dark:hover:bg-blue-500 dark:hover:text-white";

export function PlazaCollectionView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const [state, setState] = useState<CollectionState>(loadCollectionState);
	const [preloading, setPreloading] = useState<boolean>(isPreloadingCollection);

	const [viewStage, setViewStage] = useState<ViewStage>("hub");
	const [activeSource, setActiveSource] =
		useState<CollectionSourceType>("arxiv");
	const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
	const [venueKindFilter, setVenueKindFilter] =
		useState<VenueKindFilter>("all");
	const [venueDomainFilter, setVenueDomainFilter] =
		useState<DomainFilter>("all");
	const [selectedVenueId, setSelectedVenueId] = useState<string | null>(null);
	const [timeRange, setTimeRange] = useState<TimeRangeFilter>("all");
	const [displayLimit, setDisplayLimit] = useState(INITIAL_DISPLAY_COUNT);

	const [refreshingArxiv, setRefreshingArxiv] = useState(false);
	const [refreshingVenue, setRefreshingVenue] = useState(false);
	const [backgroundInitVenues, setBackgroundInitVenues] = useState(false);
	const [arxivRefreshLabel, setArxivRefreshLabel] = useState<string | null>(
		null,
	);
	const [venueRefreshLabel, setVenueRefreshLabel] = useState<string | null>(
		null,
	);
	const [refreshingCategories, setRefreshingCategories] = useState<Set<string>>(
		new Set(),
	);
	const [refreshedCategories, setRefreshedCategories] = useState<Set<string>>(
		new Set(),
	);
	const [refreshingVenueIds, setRefreshingVenueIds] = useState<Set<string>>(
		new Set(),
	);
	const [refreshedVenueIds, setRefreshedVenueIds] = useState<Set<string>>(
		new Set(),
	);
	const [idbReady, setIdbReady] = useState(false);
	const [loadingVenueId, setLoadingVenueId] = useState<string | null>(null);
	const [loadingMoreRemote, setLoadingMoreRemote] = useState(false);
	const [checkingUpdate, setCheckingUpdate] = useState(false);
	const [updateHint, setUpdateHint] = useState<ArxivUpdateCheckResult | null>(
		null,
	);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
	const [batchImporting, setBatchImporting] = useState(false);
	const [detailPaper, setDetailPaper] = useState<CollectionPaperItem | null>(
		null,
	);

	const mountedRef = useRef(false);

	// Subscribe to reactive collection state & background preloader updates
	useEffect(() => {
		const unsubState = subscribeCollectionState((next) => setState(next));
		const unsubPreload = subscribePreloadingCollection((flag) =>
			setPreloading(flag),
		);
		void hydrateCollectionStateFromIdb()
			.then((hydrated) => setState(hydrated))
			.finally(() => setIdbReady(true));
		return () => {
			unsubState();
			unsubPreload();
		};
	}, []);

	const runCheckUpdate = useCallback(
		async (silent = false) => {
			if (checkingUpdate) return;
			setCheckingUpdate(true);
			try {
				const res = await checkArxivCollectionUpdate(state.categories);
				if (res.hasUpdate) {
					setUpdateHint(res);
				} else if (!silent) {
					setUpdateHint(null);
				}
			} catch (err) {
				if (!silent) notifyError(errorText(err));
			} finally {
				setCheckingUpdate(false);
			}
		},
		[checkingUpdate, state.categories],
	);

	const handleRefreshArxiv = useCallback(
		async (
			targetCategories?: string[],
			replaceCategories = false,
			isBackgroundInit = false,
		) => {
			if (refreshingArxiv) return;
			const cats = targetCategories ?? state.categories;
			const label =
				targetCategories && targetCategories.length === 1
					? (targetCategories[0] ?? "arXiv")
					: "arXiv";
			setRefreshingArxiv(true);
			setArxivRefreshLabel(label);
			setUpdateHint(null);
			setRefreshingCategories((prev) => {
				const next = new Set(prev);
				for (const c of cats) next.add(c);
				return next;
			});
			if (!isBackgroundInit) {
				setRefreshedCategories((prev) => {
					const next = new Set(prev);
					for (const c of cats) next.delete(c);
					return next;
				});
			}
			try {
				const next = await refreshArxivCollection({
					categories: cats,
					replaceCategories,
					incremental: true,
					onCategoryStatus: (cat, status) => {
						if (status === "refreshing") {
							setRefreshingCategories((prev) => new Set(prev).add(cat));
							return;
						}
						setRefreshingCategories((prev) => {
							const s = new Set(prev);
							s.delete(cat);
							return s;
						});
						if (status === "done" && !isBackgroundInit) {
							setRefreshedCategories((prev) => new Set(prev).add(cat));
						}
					},
				});
				setState(next);
			} catch (err) {
				notifyError(errorText(err));
			} finally {
				setRefreshingArxiv(false);
				setArxivRefreshLabel(null);
				setRefreshingCategories((prev) => {
					const next = new Set(prev);
					for (const c of cats) next.delete(c);
					return next;
				});
			}
		},
		[refreshingArxiv, state.categories],
	);

	const handleRefreshVenue = useCallback(
		async (
			targetVenueIds?: string[],
			skipLoaded = false,
			isBackgroundInit = false,
		) => {
			const venuePortalLabel = t("plaza.collection.source.venue");

			// Single-venue manual refresh (e.g. inside `ASE 2026`) runs immediately without
			// waiting behind any background cold-start batch.
			if (!isBackgroundInit && targetVenueIds && targetVenueIds.length === 1) {
				const singleId = targetVenueIds[0];
				if (!singleId || loadingVenueId === singleId) return;
				const singleName =
					state.venues.find((v) => v.id === singleId)?.name ?? venuePortalLabel;
				setLoadingVenueId(singleId);
				setVenueRefreshLabel(singleName);
				setRefreshingVenueIds((prev) => new Set(prev).add(singleId));
				setRefreshedVenueIds((prev) => {
					const next = new Set(prev);
					next.delete(singleId);
					return next;
				});
				try {
					const next = await ensureVenueLoaded(singleId);
					setState(next);
					setRefreshedVenueIds((prev) => new Set(prev).add(singleId));
				} catch (err) {
					notifyError(errorText(err));
				} finally {
					setLoadingVenueId((prev) => (prev === singleId ? null : prev));
					setVenueRefreshLabel((prev) => (prev === singleName ? null : prev));
					setRefreshingVenueIds((prev) => {
						const next = new Set(prev);
						next.delete(singleId);
						return next;
					});
				}
				return;
			}

			if (isBackgroundInit) {
				if (backgroundInitVenues) return;
				setBackgroundInitVenues(true);
				try {
					const next = await refreshVenueCollection({
						venues: state.venues,
						venueIds: targetVenueIds,
						skipLoaded,
						onVenueProgress: (venue, idx, total) => {
							setVenueRefreshLabel((prev) => {
								if (refreshingVenue && prev) return prev;
								return total > 1
									? `${venuePortalLabel} · ${venue.name} (${idx}/${total})`
									: venue.name;
							});
						},
						onVenueStatus: (venue, status) => {
							setRefreshingVenueIds((prev) => {
								const next = new Set(prev);
								if (status === "refreshing") next.add(venue.id);
								else next.delete(venue.id);
								return next;
							});
						},
					});
					setState(next);
				} catch (err) {
					notifyError(errorText(err));
				} finally {
					setBackgroundInitVenues(false);
					if (!refreshingVenue) {
						setVenueRefreshLabel(null);
					}
				}
				return;
			}

			if (refreshingVenue) return;
			const scopedIds = targetVenueIds ?? state.venues.map((v) => v.id);
			setRefreshingVenue(true);
			setVenueRefreshLabel(venuePortalLabel);
			setRefreshedVenueIds((prev) => {
				const next = new Set(prev);
				for (const id of scopedIds) next.delete(id);
				return next;
			});
			try {
				const next = await refreshVenueCollection({
					venues: state.venues,
					venueIds: targetVenueIds,
					skipLoaded,
					onVenueProgress: (venue, idx, total) => {
						setVenueRefreshLabel(
							total > 1
								? `${venuePortalLabel} · ${venue.name} (${idx}/${total})`
								: venue.name,
						);
					},
					onVenueStatus: (venue, status) => {
						if (status === "refreshing") {
							setRefreshingVenueIds((prev) => new Set(prev).add(venue.id));
							return;
						}
						setRefreshingVenueIds((prev) => {
							const next = new Set(prev);
							next.delete(venue.id);
							return next;
						});
						if (status === "done") {
							setRefreshedVenueIds((prev) => new Set(prev).add(venue.id));
						}
					},
				});
				setState(next);
			} catch (err) {
				notifyError(errorText(err));
			} finally {
				setRefreshingVenue(false);
				setVenueRefreshLabel(null);
				setRefreshingVenueIds((prev) => {
					const next = new Set(prev);
					for (const id of scopedIds) next.delete(id);
					return next;
				});
			}
		},
		[backgroundInitVenues, loadingVenueId, refreshingVenue, state.venues, t],
	);

	// Initial open: check arXiv incrementally; NEVER re-check or re-fetch Venues that are already loaded
	useEffect(() => {
		if (!idbReady || mountedRef.current) return;
		mountedRef.current = true;

		const missingCategories = state.categories.filter(
			(cat) =>
				!state.items.some(
					(item) =>
						item.sourceType === "arxiv" &&
						(item.sourceLabel === cat || item.categories.includes(cat)),
				),
		);
		if (missingCategories.length > 0) {
			void handleRefreshArxiv(missingCategories, false, true);
		} else {
			void runCheckUpdate(true);
			const arxivCount = state.items.filter(
				(i) =>
					i.sourceType === "arxiv" &&
					matchesAnyArxivCategory(i, state.categories),
			).length;
			if (arxivCount < 200) {
				void preloadAll2026ArxivInBackground(state.categories);
			}
		}

		// Venues stay immutable once loaded; only initialize venues that have never been synced
		const unloadedVenueIds = state.venues
			.filter((v) => !isVenueAlreadyLoaded(v, state.items))
			.map((v) => v.id);
		if (unloadedVenueIds.length > 0) {
			void handleRefreshVenue(unloadedVenueIds, true, true);
		}
	}, [
		handleRefreshArxiv,
		handleRefreshVenue,
		idbReady,
		runCheckUpdate,
		state.categories,
		state.items,
		state.venues,
	]);

	// Priority-load selected venue ONLY if it has never been loaded yet (never re-checks once loaded)
	useEffect(() => {
		if (viewStage !== "list" || activeSource !== "venue" || !selectedVenueId) {
			return;
		}
		const venueMeta = state.venues.find((v) => v.id === selectedVenueId);
		if (venueMeta && isVenueAlreadyLoaded(venueMeta, state.items)) {
			return;
		}

		let cancelled = false;
		setLoadingVenueId(selectedVenueId);
		void ensureVenueLoaded(selectedVenueId)
			.then((next) => {
				if (!cancelled) setState(next);
			})
			.catch((err) => {
				if (!cancelled) notifyError(errorText(err));
			})
			.finally(() => {
				if (!cancelled) setLoadingVenueId(null);
			});
		return () => {
			cancelled = true;
		};
	}, [activeSource, selectedVenueId, state.items, state.venues, viewStage]);

	const handleEnterArxiv = useCallback((category: string | null) => {
		setActiveSource("arxiv");
		setSelectedCategory(category);
		setDisplayLimit(INITIAL_DISPLAY_COUNT);
		setViewStage("list");
	}, []);

	const handleEnterVenue = useCallback(
		(kind: VenueKindFilter, venueId: string | null) => {
			setActiveSource("venue");
			setVenueKindFilter(kind);
			setVenueDomainFilter("all");
			setSelectedVenueId(venueId);
			setDisplayLimit(INITIAL_DISPLAY_COUNT);
			setViewStage("list");
		},
		[],
	);

	const updateConfig = useCallback(
		(updater: (prev: CollectionState) => CollectionState) => {
			setState((prev) => {
				const next = updater(prev);
				saveCollectionState(next);
				return next;
			});
		},
		[],
	);

	const filteredVenuesForBar = useMemo(() => {
		return state.venues.filter((v) => {
			if (venueKindFilter !== "all" && inferVenueKind(v) !== venueKindFilter) {
				return false;
			}
			if (venueDomainFilter !== "all" && v.domain !== venueDomainFilter) {
				return false;
			}
			return true;
		});
	}, [state.venues, venueDomainFilter, venueKindFilter]);

	const visiblePapers = useMemo(() => {
		const now = Date.now();

		return state.items.filter((paper: CollectionPaperItem) => {
			if (paper.sourceType !== activeSource) return false;

			if (activeSource === "arxiv") {
				if (!matchesAnyArxivCategory(paper, state.categories)) {
					return false;
				}
				if (
					selectedCategory &&
					paper.sourceLabel !== selectedCategory &&
					!paper.categories.includes(selectedCategory)
				) {
					return false;
				}
				// Time range applies ONLY to arXiv (`2026-Now`, `30d`, `7d`)
				if (timeRange === "all") {
					if (paper.year < 2026) return false;
				} else {
					const days = timeRange === "7d" ? 7 : 30;
					const ts = Date.parse(paper.publishedAt);
					if (!Number.isNaN(ts) && now - ts > days * 86_400_000) {
						return false;
					}
				}
			} else {
				const vKind = paper.venueKind ?? "conference";
				if (venueKindFilter !== "all" && vKind !== venueKindFilter) {
					return false;
				}
				if (
					venueDomainFilter !== "all" &&
					paper.venueDomain !== venueDomainFilter
				) {
					return false;
				}
				if (selectedVenueId && paper.venueId !== selectedVenueId) {
					return false;
				}
			}

			return true;
		});
	}, [
		activeSource,
		selectedCategory,
		selectedVenueId,
		state.categories,
		state.items,
		timeRange,
		venueDomainFilter,
		venueKindFilter,
	]);

	const displayedPapers = useMemo(
		() => visiblePapers.slice(0, displayLimit),
		[displayLimit, visiblePapers],
	);

	const arxivChipCounts = useMemo(() => {
		const map = new Map<string, number>();
		let total = 0;
		for (const cat of state.categories) map.set(cat, 0);
		for (const p of state.items) {
			if (p.sourceType !== "arxiv" || p.year < 2026) continue;
			if (!matchesAnyArxivCategory(p, state.categories)) continue;
			total += 1;
			for (const cat of state.categories) {
				if (p.sourceLabel === cat || p.categories.includes(cat)) {
					map.set(cat, (map.get(cat) ?? 0) + 1);
				}
			}
		}
		return { total, map };
	}, [state.categories, state.items]);

	const venueChipCounts = useMemo(() => {
		const map = new Map<string, number>();
		let total = 0;
		for (const v of filteredVenuesForBar) map.set(v.id, 0);
		for (const p of state.items) {
			if (p.sourceType !== "venue") continue;
			const vKind = p.venueKind ?? "conference";
			if (venueKindFilter !== "all" && vKind !== venueKindFilter) continue;
			if (venueDomainFilter !== "all" && p.venueDomain !== venueDomainFilter) {
				continue;
			}
			total += 1;
			if (p.venueId && map.has(p.venueId)) {
				map.set(p.venueId, (map.get(p.venueId) ?? 0) + 1);
			}
		}
		return { total, map };
	}, [filteredVenuesForBar, state.items, venueDomainFilter, venueKindFilter]);

	const handleRevealNext50 = useCallback(() => {
		const nextLimit = displayLimit + LOAD_MORE_STEP;
		setDisplayLimit(nextLimit);
		// Keep preloaded pool comfortably ahead when browsing arXiv
		if (
			activeSource === "arxiv" &&
			visiblePapers.length - nextLimit < 80 &&
			!preloading &&
			!loadingMoreRemote
		) {
			const targetCats = selectedCategory
				? [selectedCategory]
				: state.categories;
			setLoadingMoreRemote(true);
			void fetchMoreArxivCollection({
				categories: targetCats,
				maxResultsPerCategory: 150,
			})
				.then(({ state: next }) => setState(next))
				.catch(() => undefined)
				.finally(() => setLoadingMoreRemote(false));
		}
	}, [
		activeSource,
		displayLimit,
		loadingMoreRemote,
		preloading,
		selectedCategory,
		state.categories,
		visiblePapers.length,
	]);

	const handlePullDeeperRemoteArxiv = useCallback(async () => {
		if (loadingMoreRemote || refreshingArxiv) return;
		setLoadingMoreRemote(true);
		try {
			const targetCats = selectedCategory
				? [selectedCategory]
				: state.categories;
			const { state: next } = await fetchMoreArxivCollection({
				categories: targetCats,
				maxResultsPerCategory: 150,
			});
			setState(next);
			setDisplayLimit((prev) => prev + LOAD_MORE_STEP);
		} catch (err) {
			notifyError(errorText(err));
		} finally {
			setLoadingMoreRemote(false);
		}
	}, [loadingMoreRemote, refreshingArxiv, selectedCategory, state.categories]);

	const selectedVenueName = useMemo(() => {
		if (!selectedVenueId) return null;
		return state.venues.find((v) => v.id === selectedVenueId)?.name ?? null;
	}, [selectedVenueId, state.venues]);

	const activeRefreshingVenueIds = useMemo(() => {
		if (!loadingVenueId || refreshingVenueIds.has(loadingVenueId)) {
			return refreshingVenueIds;
		}
		return new Set(refreshingVenueIds).add(loadingVenueId);
	}, [loadingVenueId, refreshingVenueIds]);

	const isHubArxivRefreshed =
		!refreshingArxiv &&
		state.categories.length > 0 &&
		state.categories.every((cat) => refreshedCategories.has(cat));

	const isHubVenueRefreshed =
		!refreshingVenue &&
		!backgroundInitVenues &&
		state.venues.length > 0 &&
		state.venues.every((v) => refreshedVenueIds.has(v.id));

	const isAllArxivRefreshed = isHubArxivRefreshed;
	const isAllArxivRefreshing =
		refreshingArxiv &&
		state.categories.length > 0 &&
		state.categories.every((cat) => refreshingCategories.has(cat));

	const isAllFilteredVenuesRefreshing =
		refreshingVenue &&
		filteredVenuesForBar.some((v) => activeRefreshingVenueIds.has(v.id));
	const isAllFilteredVenuesRefreshed =
		!isAllFilteredVenuesRefreshing &&
		filteredVenuesForBar.length > 0 &&
		filteredVenuesForBar.every((v) => refreshedVenueIds.has(v.id));

	const isCurrentViewRefreshing =
		activeSource === "arxiv"
			? selectedCategory
				? refreshingCategories.has(selectedCategory)
				: refreshingArxiv
			: selectedVenueId
				? activeRefreshingVenueIds.has(selectedVenueId)
				: refreshingVenue || backgroundInitVenues || Boolean(loadingVenueId);

	const isCurrentViewRefreshed =
		!isCurrentViewRefreshing &&
		(activeSource === "arxiv"
			? selectedCategory
				? refreshedCategories.has(selectedCategory)
				: isAllArxivRefreshed
			: selectedVenueId
				? refreshedVenueIds.has(selectedVenueId)
				: isAllFilteredVenuesRefreshed);

	const hubRefreshTarget = arxivRefreshLabel ?? venueRefreshLabel;

	const listRefreshTarget = useMemo(() => {
		if (activeSource === "arxiv") {
			return arxivRefreshLabel;
		}
		if (selectedVenueId) {
			if (loadingVenueId === selectedVenueId) {
				return selectedVenueName ?? venueRefreshLabel;
			}
			return refreshingVenue ? venueRefreshLabel : null;
		}
		return venueRefreshLabel ?? selectedVenueName;
	}, [
		activeSource,
		arxivRefreshLabel,
		loadingVenueId,
		refreshingVenue,
		selectedVenueId,
		selectedVenueName,
		venueRefreshLabel,
	]);

	const scopedRefreshLabel = useMemo(() => {
		const base = t("plaza.collection.refresh");
		if (activeSource === "arxiv") {
			return selectedCategory
				? `${base} · ${selectedCategory}`
				: `${base} · arXiv`;
		}
		return selectedVenueName
			? `${base} · ${selectedVenueName}`
			: `${base} · ${t("plaza.collection.source.venue")}`;
	}, [activeSource, selectedCategory, selectedVenueName, t]);

	const handleScopedListRefresh = useCallback(() => {
		if (activeSource === "arxiv") {
			void handleRefreshArxiv(
				selectedCategory ? [selectedCategory] : undefined,
			);
			return;
		}
		if (selectedVenueId) {
			void handleRefreshVenue([selectedVenueId], false);
			return;
		}
		void handleRefreshVenue(
			filteredVenuesForBar.map((v) => v.id),
			false,
		);
	}, [
		activeSource,
		filteredVenuesForBar,
		handleRefreshArxiv,
		handleRefreshVenue,
		selectedCategory,
		selectedVenueId,
	]);

	const toggleSelect = useCallback((id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const toggleSelectAllDisplayed = useCallback(() => {
		setSelectedIds((prev) => {
			const allSelected =
				displayedPapers.length > 0 &&
				displayedPapers.every((p) => prev.has(p.id));
			if (allSelected) return new Set();
			return new Set(displayedPapers.map((p) => p.id));
		});
	}, [displayedPapers]);

	const importPapers = useCallback(
		async (targets: CollectionPaperItem[]) => {
			if (targets.length === 0 || batchImporting) return;
			const identifiers = targets
				.map((p) =>
					p.arxivId
						? `arXiv:${p.arxivId}`
						: p.doi
							? `https://doi.org/${p.doi}`
							: p.url || p.title,
				)
				.filter(Boolean);
			if (identifiers.length === 0) return;
			setBatchImporting(true);
			try {
				await lookupSubmit(identifiers, {
					onComplete: () => {
						setImportedIds((prev) => {
							const next = new Set(prev);
							for (const p of targets) next.add(p.id);
							return next;
						});
						setSelectedIds((prev) => {
							const next = new Set(prev);
							for (const p of targets) next.delete(p.id);
							return next;
						});
						setBatchImporting(false);
					},
				});
			} catch (err) {
				notifyError(errorText(err));
				setBatchImporting(false);
			}
		},
		[batchImporting],
	);

	const selectedPapers = useMemo(
		() => visiblePapers.filter((p) => selectedIds.has(p.id)),
		[selectedIds, visiblePapers],
	);

	return (
		<div
			className={cn(
				"magpie-canvas magpie-view-in relative flex h-full min-h-0 flex-col",
				className,
			)}
		>
			{viewStage === "hub" ? (
				<>
					{/* Hub Header */}
					<div
						data-plaza-header
						className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-background/80 px-4 py-2 shadow-[0_0.5px_0_0_var(--magpie-hairline)] backdrop-blur-xl backdrop-saturate-150"
					>
						<div className="flex items-center gap-2 text-muted-foreground text-xs">
							{hubRefreshTarget ? (
								<span className="inline-flex items-center gap-1.5 text-brand">
									<Loader2 className="size-3.5 animate-spin" />
									<span>
										{t("plaza.collection.refreshingTarget", {
											target: hubRefreshTarget,
										})}
									</span>
								</span>
							) : preloading ? (
								<span className="inline-flex items-center gap-1.5 text-brand">
									<Loader2 className="size-3.5 animate-spin" />
									<span>{t("plaza.collection.preloading")}</span>
								</span>
							) : (
								<span className="font-mono tabular-nums">
									{t("plaza.collection.papersCount", {
										count: state.items.length,
									})}
								</span>
							)}
						</div>

						<div className="flex items-center gap-1.5">
							<CollectionConfigPopover
								arxivCategories={state.categories}
								venues={state.venues}
								onChangeCategories={(cats) => {
									updateConfig((prev) => ({ ...prev, categories: cats }));
									void handleRefreshArxiv(cats, true);
								}}
								onChangeVenues={(venues) =>
									updateConfig((prev) => ({ ...prev, venues }))
								}
							/>
						</div>
					</div>

					{/* Two-Card Portal Hub */}
					<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto">
						<CollectionPortalHub
							categories={state.categories}
							venues={state.venues}
							items={state.items}
							refreshingArxiv={refreshingArxiv}
							refreshedArxiv={isHubArxivRefreshed}
							refreshingVenue={refreshingVenue || backgroundInitVenues}
							refreshedVenue={isHubVenueRefreshed}
							refreshingCategories={refreshingCategories}
							refreshedCategories={refreshedCategories}
							refreshingVenueIds={activeRefreshingVenueIds}
							refreshedVenueIds={refreshedVenueIds}
							onRefreshArxiv={() => void handleRefreshArxiv()}
							onRefreshVenue={() => void handleRefreshVenue(undefined, false)}
							onEnterArxiv={handleEnterArxiv}
							onEnterVenue={handleEnterVenue}
						/>
					</div>
				</>
			) : (
				<>
					{/* List View Top Navigation Bar */}
					<div
						data-plaza-header
						className="sticky top-0 z-10 flex flex-col gap-2 bg-background/80 px-3 py-2.5 shadow-[0_0.5px_0_0_var(--magpie-hairline)] backdrop-blur-xl backdrop-saturate-150"
					>
						<div className="flex flex-wrap items-center gap-2">
							{/* Back to Portal Hub */}
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										onClick={() => setViewStage("hub")}
										aria-label={t("plaza.collection.backToHub")}
										className={COLLECTION_ICON_BTN_CLASS}
									>
										<ArrowLeft className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{t("plaza.collection.backToHub")}
								</TooltipContent>
							</Tooltip>

							{/* Source Switcher: arXiv | Venue */}
							<div className="magpie-seg">
								{(["arxiv", "venue"] as const).map((kind) => (
									<button
										key={kind}
										type="button"
										data-active={activeSource === kind}
										onClick={() => {
											setActiveSource(kind);
											setDisplayLimit(INITIAL_DISPLAY_COUNT);
										}}
										className="magpie-seg-btn"
									>
										{t(`plaza.collection.source.${kind}`)}
									</button>
								))}
							</div>

							{/* arXiv ONLY: Time Range (`2026-Now`, `30d`, `7d`) */}
							{activeSource === "arxiv" ? (
								<div className="magpie-seg">
									{(["all", "30d", "7d"] as const).map((range) => (
										<button
											key={range}
											type="button"
											data-active={timeRange === range}
											onClick={() => {
												setTimeRange(range);
												setDisplayLimit(INITIAL_DISPLAY_COUNT);
											}}
											className="magpie-seg-btn"
										>
											{t(`plaza.collection.time.${range}`)}
										</button>
									))}
								</div>
							) : (
								<>
									{/* Venue ONLY: Conference | Journal + Domain Switcher */}
									<div className="magpie-seg">
										{(["all", "conference", "journal"] as const).map((vk) => (
											<button
												key={vk}
												type="button"
												data-active={venueKindFilter === vk}
												onClick={() => {
													setVenueKindFilter(vk);
													setSelectedVenueId(null);
													setDisplayLimit(INITIAL_DISPLAY_COUNT);
												}}
												className="magpie-seg-btn"
											>
												{t(`plaza.collection.venueKind.${vk}`)}
											</button>
										))}
									</div>

									<div className="magpie-seg">
										{(["all", "PL/SE", "CR", "AI"] as const).map((dom) => (
											<button
												key={dom}
												type="button"
												data-active={venueDomainFilter === dom}
												onClick={() => {
													setVenueDomainFilter(dom);
													setSelectedVenueId(null);
													setDisplayLimit(INITIAL_DISPLAY_COUNT);
												}}
												className="magpie-seg-btn"
											>
												{dom === "all" ? t("plaza.collection.allTags") : dom}
											</button>
										))}
									</div>
								</>
							)}

							{/* Right actions */}
							<div className="ml-auto flex items-center gap-1.5">
								{isCurrentViewRefreshing && listRefreshTarget ? (
									<span className="inline-flex items-center gap-1.5 text-brand text-xs">
										<Loader2 className="size-3 animate-spin" />
										<span className="max-w-56 truncate">
											{t("plaza.collection.refreshingTarget", {
												target: listRefreshTarget,
											})}
										</span>
									</span>
								) : activeSource === "arxiv" && preloading ? (
									<span
										className="hidden items-center gap-1.5 text-[11px] text-brand xl:inline-flex"
										title={t("plaza.collection.preloading")}
									>
										<Loader2 className="size-3 animate-spin" />
										<span>{t("plaza.collection.preloading")}</span>
									</span>
								) : null}

								{selectedPapers.length > 0 ? (
									<Button
										type="button"
										size="sm"
										disabled={batchImporting}
										onClick={() => void importPapers(selectedPapers)}
										className={cn(
											"h-6 gap-1 rounded-md px-2.5 text-caption",
											COLLECTION_PRIMARY_BTN_CLASS,
										)}
									>
										{batchImporting ? (
											<Loader2 className="size-3 animate-spin" />
										) : (
											<Download className="size-3" />
										)}
										{t("plaza.collection.importSelected", {
											count: selectedPapers.length,
										})}
									</Button>
								) : null}

								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											onClick={toggleSelectAllDisplayed}
											disabled={displayedPapers.length === 0}
											aria-label={t("plaza.collection.toggleSelectAll")}
											className={COLLECTION_ICON_BTN_CLASS}
										>
											{displayedPapers.length > 0 &&
											displayedPapers.every((p) => selectedIds.has(p.id)) ? (
												<CheckSquare className="size-3.5 text-brand" />
											) : (
												<Square className="size-3.5" />
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{t("plaza.collection.toggleSelectAll")}
									</TooltipContent>
								</Tooltip>

								<CollectionConfigPopover
									arxivCategories={state.categories}
									venues={state.venues}
									onChangeCategories={(cats) => {
										if (selectedCategory && !cats.includes(selectedCategory)) {
											setSelectedCategory(null);
										}
										updateConfig((prev) => ({ ...prev, categories: cats }));
										void handleRefreshArxiv(cats, true);
									}}
									onChangeVenues={(venues) =>
										updateConfig((prev) => ({ ...prev, venues }))
									}
								/>

								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											disabled={isCurrentViewRefreshing}
											onClick={handleScopedListRefresh}
											aria-label={scopedRefreshLabel}
											className={cn(
												"group/refresh-btn",
												COLLECTION_ICON_BTN_CLASS,
											)}
										>
											{isCurrentViewRefreshing ? (
												<Loader2 className="size-3.5 animate-spin text-brand" />
											) : isCurrentViewRefreshed ? (
												<>
													<Check className="size-3.5 text-emerald-500 group-hover/refresh-btn:hidden" />
													<RefreshCw className="hidden size-3.5 group-hover/refresh-btn:block" />
												</>
											) : (
												<RefreshCw className="size-3.5" />
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent>{scopedRefreshLabel}</TooltipContent>
								</Tooltip>
							</div>
						</div>

						{/* Sub-navigation bar: cs.XX tags for arXiv OR DBLP 2026 venue chips for Venue */}
						{activeSource === "arxiv" ? (
							<div className="flex items-center gap-1.5 overflow-x-auto py-0.5">
								<button
									type="button"
									data-active={selectedCategory === null}
									onClick={() => {
										setSelectedCategory(null);
										setDisplayLimit(INITIAL_DISPLAY_COUNT);
									}}
									className="magpie-chip shrink-0"
								>
									{isAllArxivRefreshing ? (
										<Loader2 className="size-3 shrink-0 animate-spin text-brand" />
									) : isAllArxivRefreshed ? (
										<Check className="size-3 shrink-0 text-emerald-500" />
									) : null}
									<span>{t("plaza.collection.allTags")}</span>
									<span className="text-muted-foreground tabular-nums">
										{arxivChipCounts.total}
									</span>
								</button>
								{state.categories.map((cat) => {
									const catRefreshing = refreshingCategories.has(cat);
									const catRefreshed =
										!catRefreshing && refreshedCategories.has(cat);
									return (
										<button
											key={cat}
											type="button"
											data-active={selectedCategory === cat}
											onClick={() => {
												setSelectedCategory((prev) =>
													prev === cat ? null : cat,
												);
												setDisplayLimit(INITIAL_DISPLAY_COUNT);
											}}
											className="magpie-chip shrink-0 font-mono"
										>
											{catRefreshing ? (
												<Loader2 className="size-3 shrink-0 animate-spin text-brand" />
											) : catRefreshed ? (
												<Check className="size-3 shrink-0 text-emerald-500" />
											) : null}
											<span>{cat}</span>
											<span className="text-muted-foreground tabular-nums">
												{arxivChipCounts.map.get(cat) ?? 0}
											</span>
										</button>
									);
								})}
							</div>
						) : (
							<div className="flex items-center gap-1.5 overflow-x-auto py-0.5">
								<button
									type="button"
									data-active={selectedVenueId === null}
									onClick={() => {
										setSelectedVenueId(null);
										setDisplayLimit(INITIAL_DISPLAY_COUNT);
									}}
									className="magpie-chip shrink-0"
								>
									{isAllFilteredVenuesRefreshing ? (
										<Loader2 className="size-3 shrink-0 animate-spin text-brand" />
									) : isAllFilteredVenuesRefreshed ? (
										<Check className="size-3 shrink-0 text-emerald-500" />
									) : null}
									<span>{t("plaza.collection.allTags")}</span>
									<span className="text-muted-foreground tabular-nums">
										{venueChipCounts.total}
									</span>
								</button>
								{filteredVenuesForBar.map((v) => {
									const cnt = venueChipCounts.map.get(v.id) ?? 0;
									const vRefreshing = activeRefreshingVenueIds.has(v.id);
									const vRefreshed =
										!vRefreshing && refreshedVenueIds.has(v.id);
									return (
										<button
											key={v.id}
											type="button"
											data-active={selectedVenueId === v.id}
											onClick={() => {
												setSelectedVenueId((prev) =>
													prev === v.id ? null : v.id,
												);
												setDisplayLimit(INITIAL_DISPLAY_COUNT);
											}}
											className="magpie-chip shrink-0"
										>
											{vRefreshing ? (
												<Loader2 className="size-3 shrink-0 animate-spin text-brand" />
											) : vRefreshed ? (
												<Check className="size-3 shrink-0 text-emerald-500" />
											) : null}
											<span>{v.name}</span>
											{v.ccfRank ? (
												<span className="font-mono text-[10px] text-brand/80">
													{v.ccfRank.replace("CCF-", "")}
												</span>
											) : null}
											<span className="text-muted-foreground tabular-nums">
												{cnt}
											</span>
										</button>
									);
								})}
							</div>
						)}

						{/* Update Reminder Banner for arXiv */}
						{activeSource === "arxiv" &&
						updateHint?.hasUpdate &&
						updateHint.remoteLatestTitle ? (
							<div className="flex items-center justify-between gap-2 rounded-lg bg-brand/10 px-3 py-1.5 text-xs shadow-[inset_0_0_0_0.5px_color-mix(in_oklch,var(--brand)_40%,transparent)]">
								<span className="min-w-0 truncate text-foreground">
									<span className="font-medium">
										{t("plaza.collection.updateAvailable")}
									</span>{" "}
									<span className="text-muted-foreground">
										({updateHint.remoteLatestId} ·{" "}
										{updateHint.remoteLatestTitle})
									</span>
								</span>
								<div className="flex shrink-0 items-center gap-1.5">
									<Button
										type="button"
										size="sm"
										disabled={refreshingArxiv}
										onClick={() =>
											void handleRefreshArxiv(
												selectedCategory ? [selectedCategory] : undefined,
											)
										}
										className={cn(
											"h-6 gap-1 rounded-md px-2.5 text-caption",
											COLLECTION_PRIMARY_BTN_CLASS,
										)}
									>
										{refreshingArxiv ? (
											<Loader2 className="size-3 animate-spin" />
										) : (
											<RefreshCw className="size-3" />
										)}
										{t("plaza.collection.refreshNow")}
									</Button>
									<button
										type="button"
										onClick={() => setUpdateHint(null)}
										className="rounded p-0.5 text-muted-foreground hover:text-foreground"
										aria-label={t("plaza.collection.dismissUpdate")}
									>
										<X className="size-3" />
									</button>
								</div>
							</div>
						) : null}
					</div>

					{/* Main Paper List (100 initial, +50 per Load More from preloaded pool) */}
					<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-3">
						{isCurrentViewRefreshing && visiblePapers.length === 0 ? (
							<div className="flex items-center justify-center gap-2 py-14 text-muted-foreground text-xs">
								<Loader2 className="size-4 animate-spin" />
								<span>
									{listRefreshTarget
										? t("plaza.collection.refreshingTarget", {
												target: listRefreshTarget,
											})
										: t("plaza.collection.loading")}
								</span>
							</div>
						) : visiblePapers.length === 0 ? (
							<div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
								<p className="text-muted-foreground text-xs">
									{state.items.length === 0
										? t("plaza.collection.empty")
										: t("plaza.collection.emptyFiltered")}
								</p>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={isCurrentViewRefreshing}
									onClick={handleScopedListRefresh}
									className={COLLECTION_OUTLINE_BTN_CLASS}
								>
									{isCurrentViewRefreshing ? (
										<Loader2 className="size-3.5 animate-spin text-brand" />
									) : isCurrentViewRefreshed ? (
										<Check className="size-3.5 text-emerald-500" />
									) : (
										<RefreshCw className="size-3.5" />
									)}
									{scopedRefreshLabel}
								</Button>
							</div>
						) : (
							<div className="grid gap-2.5">
								{displayedPapers.map((paper) => (
									<CollectionPaperCard
										key={paper.id}
										paper={paper}
										selected={selectedIds.has(paper.id)}
										imported={importedIds.has(paper.id)}
										onToggleSelect={() => toggleSelect(paper.id)}
										onImport={() => void importPapers([paper])}
										onOpenDetail={() => setDetailPaper(paper)}
									/>
								))}

								{/* Preloaded Pagination Footer (+50 per click) */}
								<div className="flex flex-col items-center justify-center gap-2 py-3">
									{displayLimit < visiblePapers.length ? (
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={handleRevealNext50}
											className={cn(
												"h-8 gap-1.5 px-4 text-xs",
												COLLECTION_OUTLINE_BTN_CLASS,
											)}
										>
											<ChevronDown className="size-3.5" />
											<span>
												{t("plaza.collection.loadMoreStep", {
													step: Math.min(
														LOAD_MORE_STEP,
														visiblePapers.length - displayLimit,
													),
													shown: displayedPapers.length,
													total: visiblePapers.length,
												})}
											</span>
										</Button>
									) : (
										<div className="flex flex-wrap items-center justify-center gap-2">
											<span className="text-muted-foreground text-xs tabular-nums">
												{t("plaza.collection.showingAll", {
													total: visiblePapers.length,
												})}
											</span>
											{activeSource === "arxiv" ? (
												<Button
													type="button"
													variant="outline"
													size="sm"
													disabled={loadingMoreRemote || refreshingArxiv}
													onClick={() => void handlePullDeeperRemoteArxiv()}
													className={cn(
														"h-7 gap-1.5 text-xs",
														COLLECTION_OUTLINE_BTN_CLASS,
													)}
												>
													{loadingMoreRemote ? (
														<>
															<Loader2 className="size-3.5 animate-spin" />
															<span>
																{t("plaza.collection.loadingMoreArxiv")}
															</span>
														</>
													) : (
														<>
															<RefreshCw className="size-3.5" />
															<span>{t("plaza.collection.loadMoreArxiv")}</span>
														</>
													)}
												</Button>
											) : null}
										</div>
									)}
								</div>
							</div>
						)}
					</div>
				</>
			)}

			{/* Complete Paper Detail Dialog on Card Click */}
			<CollectionPaperDetailDialog
				paper={detailPaper}
				open={detailPaper !== null}
				imported={detailPaper ? importedIds.has(detailPaper.id) : false}
				onOpenChange={(open) => {
					if (!open) setDetailPaper(null);
				}}
				onImport={(p) => importPapers([p])}
				onPaperUpdated={(updated) => {
					setDetailPaper(updated);
				}}
			/>
		</div>
	);
}

function CollectionPaperCard({
	paper,
	selected,
	imported,
	onToggleSelect,
	onImport,
	onOpenDetail,
}: {
	paper: CollectionPaperItem;
	selected: boolean;
	imported: boolean;
	onToggleSelect: () => void;
	onImport: () => void;
	onOpenDetail: () => void;
}) {
	const { t } = useTranslation("sidebar");
	const [busy, setBusy] = useState(false);

	const triggerImport = async () => {
		if (busy || imported) return;
		setBusy(true);
		try {
			await onImport();
		} finally {
			setBusy(false);
		}
	};

	const topKeywords = paper.keywords?.slice(0, 4) ?? [];

	return (
		<div
			className={cn(
				"magpie-card group relative flex items-start gap-3 p-3.5 transition-colors hover:bg-muted/30",
				selected && "magpie-card-selected",
			)}
		>
			<div className="pt-0.5">
				<Checkbox
					checked={selected}
					onCheckedChange={() => onToggleSelect()}
					aria-label={paper.title}
				/>
			</div>

			<button
				type="button"
				onClick={onOpenDetail}
				className="min-w-0 flex-1 cursor-pointer text-left focus:outline-none"
			>
				<div className="flex flex-wrap items-center gap-1.5">
					<PlazaSourceBadge
						source={paper.sourceType}
						label={paper.sourceLabel}
					/>
					{paper.ccfRank ? (
						<span className="rounded bg-brand/10 px-1.5 py-0.5 font-mono text-[10px] text-brand">
							{paper.ccfRank}
						</span>
					) : null}
					<span className="font-mono text-[11px] text-muted-foreground tabular-nums">
						{paper.publishedAt.slice(0, 10)}
					</span>
					<span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
						<Quote className="size-2.5" />
						{paper.citationCount ?? 0}
					</span>
					{paper.authors.length > 0 ? (
						<span className="truncate text-caption text-muted-foreground">
							· {paper.authors.slice(0, 3).join(", ")}
							{paper.authors.length > 3 ? " et al." : ""}
						</span>
					) : null}
				</div>

				<h3
					className="mt-1 line-clamp-2 font-medium text-foreground text-sm leading-snug group-hover:text-brand"
					title={paper.title}
				>
					{paper.title}
				</h3>

				{paper.abstract ? (
					<p className="mt-1.5 line-clamp-3 text-muted-foreground text-xs leading-relaxed">
						{paper.abstract}
					</p>
				) : null}

				{topKeywords.length > 0 ? (
					<div className="mt-2 flex flex-wrap items-center gap-1">
						{topKeywords.map((kw) => (
							<span
								key={kw}
								className="rounded bg-[var(--magpie-surface)] px-1.5 py-0.5 text-[11px] text-muted-foreground shadow-[0_0_0_0.5px_var(--magpie-hairline)]"
							>
								{kw}
							</span>
						))}
					</div>
				) : null}
			</button>

			<div className="flex shrink-0 items-center gap-1">
				{paper.arxivId ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("plaza.arxivRec.read")}
								className={COLLECTION_ICON_BTN_CLASS}
								onClick={() =>
									openRemoteArxivPaper({
										arxivId: paper.arxivId ?? "",
										title: paper.title,
										abstract: paper.abstract,
										url: paper.url,
										score: 1,
									})
								}
							>
								<BookOpen className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("plaza.arxivRec.read")}</TooltipContent>
					</Tooltip>
				) : null}

				{paper.url ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("plaza.feeds.openOriginal")}
								className={COLLECTION_ICON_BTN_CLASS}
								onClick={() => openExternalUrl(paper.url)}
							>
								<ArrowUpRight className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("plaza.feeds.openOriginal")}</TooltipContent>
					</Tooltip>
				) : null}

				{imported ? (
					<span
						className="inline-flex size-7 items-center justify-center rounded-[min(var(--radius-md),12px)] bg-emerald-500/12 text-emerald-600 ring-1 ring-emerald-500/25 ring-inset dark:bg-emerald-500/20 dark:text-emerald-300 dark:ring-emerald-400/35"
						title={t("plaza.feeds.imported")}
					>
						<Check className="size-3.5" />
					</span>
				) : (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								disabled={busy}
								aria-label={t("plaza.feeds.import")}
								className={COLLECTION_CARD_IMPORT_BTN_CLASS}
								onClick={() => void triggerImport()}
							>
								{busy ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									<Download className="size-3.5" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("plaza.feeds.import")}</TooltipContent>
					</Tooltip>
				)}
			</div>
		</div>
	);
}

function CollectionConfigPopover({
	arxivCategories,
	venues,
	onChangeCategories,
	onChangeVenues,
}: {
	arxivCategories: string[];
	venues: VenueConfig[];
	onChangeCategories: (next: string[]) => void;
	onChangeVenues: (next: VenueConfig[]) => void;
}) {
	const { t } = useTranslation("sidebar");
	const [catSearch, setCatSearch] = useState("");
	const [newVenueLabel, setNewVenueLabel] = useState("");
	const [newVenueUrl, setNewVenueUrl] = useState("");
	const [newVenueAgent, setNewVenueAgent] = useState(false);

	const orderedCategories = useMemo(() => {
		const seen = new Set<string>();
		const list: string[] = [];
		for (const cat of [
			...DEFAULT_ARXIV_CATEGORIES,
			"cs.AI",
			...arxivCategories,
			...ARXIV_ALL_CATEGORIES,
		]) {
			if (!seen.has(cat)) {
				seen.add(cat);
				list.push(cat);
			}
		}
		const q = catSearch.trim().toLowerCase();
		if (!q) return list;
		return list.filter((cat) => cat.toLowerCase().includes(q));
	}, [arxivCategories, catSearch]);

	const toggleCategory = (cat: string) => {
		if (arxivCategories.includes(cat)) {
			if (arxivCategories.length <= 1) return;
			onChangeCategories(arxivCategories.filter((c) => c !== cat));
		} else {
			onChangeCategories([...arxivCategories, cat]);
		}
	};

	const addVenue = () => {
		const name = newVenueLabel.trim();
		const url = newVenueUrl.trim();
		if (!name || !url) return;
		const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
		const kind = inferVenueKind({ id, name, url });
		onChangeVenues([
			...venues,
			{
				id: `${id}-${Date.now()}`,
				name,
				url,
				mode: newVenueAgent ? "agent" : "auto",
				kind,
			},
		]);
		setNewVenueLabel("");
		setNewVenueUrl("");
	};

	return (
		<Popover>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t("plaza.collection.configureSources")}
							className={COLLECTION_ICON_BTN_CLASS}
						>
							<Settings2 className="size-3.5" />
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>
					{t("plaza.collection.configureSources")}
				</TooltipContent>
			</Tooltip>
			<PopoverContent align="end" className="w-80 space-y-3 p-3">
				<div>
					<div className="flex items-center justify-between gap-2">
						<p className="font-medium text-xs">
							{t("plaza.collection.arxivCategories")}
						</p>
						<input
							type="search"
							value={catSearch}
							onChange={(e) => setCatSearch(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									const custom = catSearch.trim();
									if (custom && !arxivCategories.includes(custom)) {
										e.preventDefault();
										onChangeCategories([...arxivCategories, custom]);
										setCatSearch("");
									}
								}
							}}
							placeholder={t("plaza.arxivRec.searchCategory")}
							className="h-6 w-32 rounded-md border bg-background px-2 text-[11px]"
						/>
					</div>
					<div className="agentero-scroll mt-1.5 flex max-h-40 flex-wrap gap-1 overflow-y-auto pr-1">
						{orderedCategories.map((cat) => {
							const active = arxivCategories.includes(cat);
							return (
								<button
									key={cat}
									type="button"
									data-active={active}
									onClick={() => toggleCategory(cat)}
									className="magpie-chip font-mono"
								>
									{cat}
								</button>
							);
						})}
					</div>
				</div>

				<div className="border-t pt-2.5">
					<p className="font-medium text-xs">
						{t("plaza.collection.venuesTitle")}
					</p>
					<div className="agentero-scroll mt-1.5 max-h-44 space-y-1.5 overflow-y-auto pr-1">
						{venues.map((v) => (
							<div
								key={v.id}
								className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1 text-xs"
							>
								<button
									type="button"
									onClick={() =>
										onChangeVenues(
											venues.map((item) =>
												item.id === v.id
													? {
															...item,
															mode: item.mode === "agent" ? "auto" : "agent",
														}
													: item,
											),
										)
									}
									className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
									title={t("plaza.collection.agentExtract")}
								>
									<span className="truncate font-medium">{v.name}</span>
									{v.ccfRank ? (
										<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
											{v.ccfRank}
										</span>
									) : null}
									{v.mode === "agent" ? (
										<Sparkles className="size-3 shrink-0 text-brand" />
									) : null}
								</button>
								<button
									type="button"
									onClick={() =>
										onChangeVenues(venues.filter((item) => item.id !== v.id))
									}
									className="text-muted-foreground hover:text-destructive"
									aria-label={t("plaza.feeds.remove")}
								>
									<Trash2 className="size-3" />
								</button>
							</div>
						))}
					</div>

					<div className="mt-2 space-y-1.5 border-t pt-2">
						<input
							type="text"
							value={newVenueLabel}
							onChange={(e) => setNewVenueLabel(e.target.value)}
							placeholder={t("plaza.collection.venueNamePlaceholder")}
							className="h-7 w-full rounded-md border bg-background px-2 text-xs"
						/>
						<input
							type="url"
							value={newVenueUrl}
							onChange={(e) => setNewVenueUrl(e.target.value)}
							placeholder={t("plaza.collection.venueUrlPlaceholder")}
							className="h-7 w-full rounded-md border bg-background px-2 text-xs"
						/>
						<div className="flex items-center justify-between gap-2">
							<label
								htmlFor="collection-new-venue-agent"
								className="flex cursor-pointer items-center gap-1.5 text-caption text-muted-foreground"
							>
								<Checkbox
									id="collection-new-venue-agent"
									checked={newVenueAgent}
									onCheckedChange={(c) => setNewVenueAgent(c === true)}
								/>
								<span>{t("plaza.collection.agentExtract")}</span>
							</label>
							<Button
								type="button"
								size="sm"
								onClick={addVenue}
								disabled={!newVenueLabel.trim() || !newVenueUrl.trim()}
								className={cn(
									"h-6 gap-1 px-2 text-caption",
									COLLECTION_PRIMARY_BTN_CLASS,
								)}
							>
								<Plus className="size-3" />
								{t("lookup.add")}
							</Button>
						</div>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
