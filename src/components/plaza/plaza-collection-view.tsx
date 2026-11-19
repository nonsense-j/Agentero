/**
 * Native 广场 panel: Paper Collection (2026–Now arXiv + 2026 Main-Track Venues).
 *
 * Two-stage flow backed by `collection.sqlite`:
 * 1. Portal Hub: Separate `arXiv` (`cs.SE`, `cs.CR`, `cs.PL`, `cs.AI`, …) and
 *    `Venue` (`Conference` + `Journal`, 2026 Main/Research/Technical Track) entry cards
 *    powered by `CollectionSummarySnapshot` (zero paper rows in JS memory).
 * 2. List View: Top navigation bar with source switcher, `arXiv`-only time filter
 *    (`2026-Now` / `30d` / `7d`), sub-entry chips, 50-paper paginated SQLite query
 *    with +50 Load More increments, and full detail dialog on card click.
 */

import {
	ArrowLeft,
	ArrowUpRight,
	BookOpen,
	Check,
	ChevronDown,
	Download,
	GitFork,
	ListChecks,
	Loader2,
	Pencil,
	Plus,
	RefreshCw,
	Settings2,
	Sparkles,
	Trash2,
	X,
} from "lucide-react";
import {
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
	PlazaSourceBadge,
	PlazaSourceJumpButton,
} from "@/components/icons/plaza-icons";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { libraryStore } from "@/lib/paper/library-store";
import {
	type CollectionLinkedPeer,
	type CollectionListPapersQuery,
	type CollectionPaperItem,
	type CollectionSourceType,
	clearCollection,
	DEFAULT_ARXIV_CATEGORIES,
	ensureCollectionSummaryHydrated,
	fetchMoreArxivCollection,
	formatArxivCategoriesLabel,
	getCollectionPaperDetail,
	getCollectionSummarySnapshot,
	inferVenueKind,
	isPreloadingCollection,
	listCollectionPapers,
	subscribeCollectionSummary,
	subscribePreloadingCollection,
	updateCollectionConfig,
	type VenueConfig,
	type VenueDomain,
} from "@/lib/plaza/collection";
import { importCollectionPapers } from "@/lib/plaza/collection-import";
import {
	refreshAllInBackground,
	refreshArxivInBackground,
	refreshVenueInBackground,
	useCollectionRefreshStore,
} from "@/lib/plaza/collection-refresh";
import { ARXIV_ALL_CATEGORIES } from "@/lib/plaza/feeds";
import {
	addCollectionPaperKeys,
	isCollectionPaperImported,
	syncCollectionImportedKeys,
} from "@/lib/plaza/imported";
import { openRemoteArxivPaper } from "@/lib/workspace/actions";

type ViewStage = "hub" | "list";
type TimeRangeFilter = "all" | "30d" | "7d";
type DomainFilter = "all" | VenueDomain;

const INITIAL_DISPLAY_COUNT = 50;
const LOAD_MORE_STEP = 50;
const SKELETON_CARD_KEYS = ["sk-1", "sk-2", "sk-3", "sk-4", "sk-5"] as const;

const COLLECTION_ICON_BTN_CLASS =
	"text-foreground/80 hover:bg-black/[0.06] hover:text-foreground dark:bg-white/[0.08] dark:text-zinc-100 dark:ring-1 dark:ring-inset dark:ring-white/15 dark:hover:bg-white/[0.15] dark:hover:text-white";

const COLLECTION_CARD_IMPORT_BTN_CLASS =
	"bg-blue-500/10 text-blue-600 ring-1 ring-inset ring-blue-500/20 hover:bg-blue-600 hover:text-white dark:bg-blue-500/20 dark:text-blue-200 dark:ring-blue-400/35 dark:hover:bg-blue-500 dark:hover:text-white";

const checkPaperImported = isCollectionPaperImported;

export function PlazaCollectionView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const summary = useSyncExternalStore(
		subscribeCollectionSummary,
		getCollectionSummarySnapshot,
	);
	const preloading = useSyncExternalStore(
		subscribePreloadingCollection,
		isPreloadingCollection,
	);

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
	const [sortOrder, setSortOrder] = useState<"newest" | "citations">("newest");

	// Paginated slice state (never holds full 20,000-paper pool in React memory)
	const [pageItems, setPageItems] = useState<CollectionPaperItem[]>([]);
	const [pageTotal, setPageTotal] = useState(0);
	const [pageHasMore, setPageHasMore] = useState(false);
	const [loadingPage, setLoadingPage] = useState(false);
	const [loadingMorePage, setLoadingMorePage] = useState(false);
	const loadedTargetRef = useRef(INITIAL_DISPLAY_COUNT);
	const listReqSeqRef = useRef(0);

	const refreshingArxiv = useCollectionRefreshStore((s) => s.refreshingArxiv);
	const refreshingVenue = useCollectionRefreshStore((s) => s.refreshingVenue);
	const refreshingCategories = useCollectionRefreshStore(
		(s) => s.refreshingCategories,
	);
	const refreshedCategories = useCollectionRefreshStore(
		(s) => s.refreshedCategories,
	);
	const refreshingVenueIds = useCollectionRefreshStore(
		(s) => s.refreshingVenueIds,
	);
	const refreshedVenueIds = useCollectionRefreshStore(
		(s) => s.refreshedVenueIds,
	);
	const [loadingMoreRemote, setLoadingMoreRemote] = useState(false);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
	const manualImportedKeysRef = useRef<Set<string>>(new Set());
	const [batchImporting, setBatchImporting] = useState(false);
	const [detailPaper, setDetailPaper] = useState<CollectionPaperItem | null>(
		null,
	);
	const [pendingDetailPeer, setPendingDetailPeer] =
		useState<CollectionLinkedPeer | null>(null);
	const linkedPeerReqSeqRef = useRef(0);

	// Hydrate lightweight SQLite summary on open; never auto-fetch arXiv or Venue
	useEffect(() => {
		void ensureCollectionSummaryHydrated().catch((err) => {
			notifyError(errorText(err));
		});
	}, []);

	const syncLibraryImported = useCallback(
		async (items: readonly CollectionPaperItem[]) => {
			try {
				const next = await syncCollectionImportedKeys(
					items,
					manualImportedKeysRef.current,
				);
				setImportedIds(next);
			} catch {
				// Ignore when no Vault is open
			}
		},
		[],
	);

	useEffect(() => {
		if (pageItems.length === 0) return;
		void syncLibraryImported(pageItems);
		return libraryStore.subscribe((state, prevState) => {
			if (state.papers !== prevState.papers) {
				void syncLibraryImported(pageItems);
			}
		});
	}, [pageItems, syncLibraryImported]);

	const resetPagination = useCallback(() => {
		loadedTargetRef.current = INITIAL_DISPLAY_COUNT;
		setSelectedIds(new Set());
	}, []);

	const listQuery = useMemo<CollectionListPapersQuery>(() => {
		if (activeSource === "arxiv") {
			return {
				sourceType: "arxiv",
				category: selectedCategory,
				timePreset: timeRange,
				sort: sortOrder,
			};
		}
		return {
			sourceType: "venue",
			venueKind: venueKindFilter === "all" ? null : venueKindFilter,
			venueDomain: venueDomainFilter === "all" ? null : venueDomainFilter,
			venueId: selectedVenueId,
			sort: sortOrder,
		};
	}, [
		activeSource,
		selectedCategory,
		selectedVenueId,
		sortOrder,
		timeRange,
		venueDomainFilter,
		venueKindFilter,
	]);

	// Fetch visible page from `collection.sqlite` whenever list filters or store `revision` change
	useEffect(() => {
		if (viewStage !== "list" || summary.revision < 0) return;
		const seq = ++listReqSeqRef.current;
		const limit = Math.min(
			1000,
			Math.max(INITIAL_DISPLAY_COUNT, loadedTargetRef.current),
		);
		setLoadingPage(true);

		void listCollectionPapers({
			...listQuery,
			limit,
			offset: 0,
		})
			.then((res) => {
				if (seq !== listReqSeqRef.current) return;
				setPageItems(res.items);
				setPageTotal(res.total);
				setPageHasMore(res.hasMore);
			})
			.catch((err) => {
				if (seq !== listReqSeqRef.current) return;
				notifyError(errorText(err));
			})
			.finally(() => {
				if (seq === listReqSeqRef.current) {
					setLoadingPage(false);
				}
			});
	}, [listQuery, summary.revision, viewStage]);

	const handleLoadMorePage = useCallback(async () => {
		if (loadingMorePage || loadingPage || !pageHasMore) return;
		const seq = listReqSeqRef.current;
		setLoadingMorePage(true);
		try {
			const res = await listCollectionPapers({
				...listQuery,
				limit: LOAD_MORE_STEP,
				offset: pageItems.length,
			});
			if (seq !== listReqSeqRef.current) return;
			setPageItems((prev) => {
				const seen = new Set(prev.map((p) => p.id));
				const merged = [...prev];
				for (const item of res.items) {
					if (!seen.has(item.id)) {
						seen.add(item.id);
						merged.push(item);
					}
				}
				loadedTargetRef.current = Math.max(
					INITIAL_DISPLAY_COUNT,
					merged.length,
				);
				return merged;
			});
			setPageTotal(res.total);
			setPageHasMore(res.hasMore);
		} catch (err) {
			if (seq === listReqSeqRef.current) {
				notifyError(errorText(err));
			}
		} finally {
			if (seq === listReqSeqRef.current) {
				setLoadingMorePage(false);
			}
		}
	}, [listQuery, loadingMorePage, loadingPage, pageHasMore, pageItems.length]);

	const handleRefreshArxiv = useCallback(
		async (targetCategories?: string[]) => {
			await refreshArxivInBackground({
				categories: targetCategories,
				incremental: true,
			});
		},
		[],
	);

	const handleRefreshVenue = useCallback(async (targetVenueIds?: string[]) => {
		await refreshVenueInBackground({
			venueIds: targetVenueIds,
			skipLoaded: false,
		});
	}, []);

	const handleRefreshAll = useCallback(async () => {
		await refreshAllInBackground({
			incrementalArxiv: true,
			skipLoadedVenues: false,
		});
	}, []);

	const handleEnterArxiv = useCallback(
		(category: string | null) => {
			setActiveSource("arxiv");
			setSelectedCategory(category);
			resetPagination();
			setViewStage("list");
		},
		[resetPagination],
	);

	const handleEnterVenue = useCallback(
		(kind: VenueKindFilter, venueId: string | null) => {
			setActiveSource("venue");
			setVenueKindFilter(kind);
			setVenueDomainFilter("all");
			setSelectedVenueId(venueId);
			resetPagination();
			setViewStage("list");
		},
		[resetPagination],
	);

	const handleJumpToLinkedVenue = useCallback(
		(peer: CollectionLinkedPeer) => {
			const matchedVenue = summary.venues.find(
				(v) =>
					(peer.venueId && v.id === peer.venueId) ||
					v.name.toLowerCase() === peer.sourceLabel.toLowerCase(),
			);
			const targetKind: VenueKindFilter =
				peer.venueKind ?? matchedVenue?.kind ?? "all";
			const targetVenueId = peer.venueId ?? matchedVenue?.id ?? null;
			handleEnterVenue(targetKind, targetVenueId);
		},
		[handleEnterVenue, summary.venues],
	);

	const handleOpenDetailPaper = useCallback((paper: CollectionPaperItem) => {
		linkedPeerReqSeqRef.current += 1;
		setPendingDetailPeer(null);
		setDetailPaper(paper);
	}, []);

	const handleOpenLinkedArxiv = useCallback(
		async (peer: CollectionLinkedPeer) => {
			const seq = ++linkedPeerReqSeqRef.current;
			setDetailPaper(null);
			setPendingDetailPeer(peer);
			try {
				const detail = await getCollectionPaperDetail(peer.id);
				if (seq !== linkedPeerReqSeqRef.current) return;
				if (detail) {
					const { citationText: _cite, ...paperItem } = detail;
					setPendingDetailPeer(null);
					setDetailPaper(paperItem);
				} else {
					setPendingDetailPeer(null);
				}
			} catch (err) {
				if (seq === linkedPeerReqSeqRef.current) {
					setPendingDetailPeer(null);
					notifyError(errorText(err));
				}
			}
		},
		[],
	);

	const handleCategoriesChange = useCallback(
		(cats: string[]) => {
			if (selectedCategory && !cats.includes(selectedCategory)) {
				setSelectedCategory(null);
				resetPagination();
			}
			void updateCollectionConfig({ categories: cats }).catch((err) => {
				notifyError(errorText(err));
			});
		},
		[resetPagination, selectedCategory],
	);

	const handleVenuesChange = useCallback((venues: VenueConfig[]) => {
		void updateCollectionConfig({ venues }).catch((err) => {
			notifyError(errorText(err));
		});
	}, []);

	const handleRemoveVenue = useCallback(
		(venueId: string) => {
			if (selectedVenueId === venueId) {
				setSelectedVenueId(null);
				resetPagination();
			}
			const nextVenues = summary.venues.filter((v) => v.id !== venueId);
			void (async () => {
				await clearCollection("venue", venueId);
				await updateCollectionConfig({ venues: nextVenues });
			})().catch((err) => {
				notifyError(errorText(err));
			});
		},
		[resetPagination, selectedVenueId, summary.venues],
	);

	const filteredVenuesForBar = useMemo(() => {
		return summary.venues.filter((v) => {
			if (venueKindFilter !== "all" && inferVenueKind(v) !== venueKindFilter) {
				return false;
			}
			if (venueDomainFilter !== "all" && v.domain !== venueDomainFilter) {
				return false;
			}
			return true;
		});
	}, [summary.venues, venueDomainFilter, venueKindFilter]);

	const venueChipCounts = useMemo(() => {
		const map = new Map<string, number>();
		let sum = 0;
		for (const v of filteredVenuesForBar) {
			const cnt = v.paperCount ?? 0;
			map.set(v.id, cnt);
			sum += cnt;
		}
		const total =
			venueKindFilter === "all" && venueDomainFilter === "all"
				? summary.venueCount
				: sum;
		return { total, map };
	}, [
		filteredVenuesForBar,
		summary.venueCount,
		venueDomainFilter,
		venueKindFilter,
	]);

	const isActiveArxivHistoryComplete = useMemo(() => {
		const targetCats = selectedCategory
			? [selectedCategory]
			: summary.categories;
		return (
			targetCats.length > 0 &&
			targetCats.every((cat) =>
				Boolean(summary.arxivWatermarks?.[cat]?.historyComplete),
			)
		);
	}, [selectedCategory, summary.arxivWatermarks, summary.categories]);

	const handlePullDeeperRemoteArxiv = useCallback(async () => {
		if (loadingMoreRemote || refreshingArxiv) return;
		setLoadingMoreRemote(true);
		try {
			const targetCats = selectedCategory
				? [selectedCategory]
				: summary.categories;
			loadedTargetRef.current += LOAD_MORE_STEP;
			await fetchMoreArxivCollection({
				categories: targetCats,
				maxResultsPerCategory: 150,
			});
		} catch (err) {
			notifyError(errorText(err));
		} finally {
			setLoadingMoreRemote(false);
		}
	}, [
		loadingMoreRemote,
		refreshingArxiv,
		selectedCategory,
		summary.categories,
	]);

	const selectedVenueName = useMemo(() => {
		if (!selectedVenueId) return null;
		return summary.venues.find((v) => v.id === selectedVenueId)?.name ?? null;
	}, [selectedVenueId, summary.venues]);

	const activeRefreshingVenueIds = refreshingVenueIds;

	const isHubArxivRefreshed =
		!refreshingArxiv &&
		summary.categories.length > 0 &&
		summary.categories.every((cat) => refreshedCategories.has(cat));

	const isHubVenueRefreshed =
		!refreshingVenue &&
		summary.venues.length > 0 &&
		summary.venues.every((v) => refreshedVenueIds.has(v.id));

	const isAllArxivRefreshed = isHubArxivRefreshed;
	const isAllArxivRefreshing =
		refreshingArxiv &&
		summary.categories.length > 0 &&
		summary.categories.every((cat) => refreshingCategories.has(cat));

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
				: refreshingVenue;

	const isCurrentViewRefreshed =
		!isCurrentViewRefreshing &&
		(activeSource === "arxiv"
			? selectedCategory
				? refreshedCategories.has(selectedCategory)
				: isAllArxivRefreshed
			: selectedVenueId
				? refreshedVenueIds.has(selectedVenueId)
				: isAllFilteredVenuesRefreshed);

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
			void handleRefreshVenue([selectedVenueId]);
			return;
		}
		void handleRefreshVenue(filteredVenuesForBar.map((v) => v.id));
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
				pageItems.length > 0 && pageItems.every((p) => prev.has(p.id));
			if (allSelected) return new Set();
			return new Set(pageItems.map((p) => p.id));
		});
	}, [pageItems]);

	const importPapers = useCallback(
		async (targets: CollectionPaperItem[]) => {
			if (targets.length === 0 || batchImporting) return;
			const markTargetsDone = (done: CollectionPaperItem[]) => {
				if (done.length === 0) return;
				for (const p of done) {
					addCollectionPaperKeys(manualImportedKeysRef.current, p);
				}
				setImportedIds((prev) => {
					const next = new Set(prev);
					for (const p of done) {
						addCollectionPaperKeys(next, p);
					}
					return next;
				});
				setSelectedIds((prev) => {
					const next = new Set(prev);
					for (const p of done) next.delete(p.id);
					return next;
				});
			};

			setBatchImporting(true);
			try {
				await importCollectionPapers(targets, {
					onMarked: markTargetsDone,
				});
			} catch (err) {
				notifyError(errorText(err));
			} finally {
				setBatchImporting(false);
			}
		},
		[batchImporting],
	);

	const handleImportSinglePaper = useCallback(
		(paper: CollectionPaperItem) => importPapers([paper]),
		[importPapers],
	);

	const selectedPapers = useMemo(
		() => pageItems.filter((p) => selectedIds.has(p.id)),
		[pageItems, selectedIds],
	);
	const allDisplayedSelected =
		pageItems.length > 0 && pageItems.every((p) => selectedIds.has(p.id));

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
							<span className="font-mono tabular-nums">
								{t("plaza.collection.papersCount", {
									count: summary.totalCount,
								})}
							</span>
						</div>

						<div className="flex items-center gap-1.5">
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										disabled={refreshingArxiv || refreshingVenue}
										onClick={() => void handleRefreshAll()}
										aria-label={t("plaza.collection.refresh")}
										className={cn(
											"group/refresh-btn",
											COLLECTION_ICON_BTN_CLASS,
										)}
									>
										{refreshingArxiv || refreshingVenue ? (
											<Loader2 className="size-3.5 animate-spin text-brand" />
										) : isHubArxivRefreshed && isHubVenueRefreshed ? (
											<>
												<Check className="size-3.5 text-emerald-500 group-hover/refresh-btn:hidden" />
												<RefreshCw className="hidden size-3.5 group-hover/refresh-btn:block" />
											</>
										) : (
											<RefreshCw className="size-3.5" />
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent>{t("plaza.collection.refresh")}</TooltipContent>
							</Tooltip>

							<CollectionConfigPopover
								arxivCategories={summary.categories}
								venues={summary.venues}
								onChangeCategories={handleCategoriesChange}
								onChangeVenues={handleVenuesChange}
								onRemoveVenue={handleRemoveVenue}
							/>
						</div>
					</div>

					{/* Two-Card Portal Hub */}
					<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto">
						<CollectionPortalHub
							categories={summary.categories}
							venues={summary.venues}
							arxivCount={summary.arxivCount}
							venueCount={summary.venueCount}
							conferenceCount={summary.conferenceCount}
							journalCount={summary.journalCount}
							categoryCounts={summary.categoryCounts}
							arxivWatermarks={summary.arxivWatermarks}
							preloadingArxiv={preloading}
							refreshingArxiv={refreshingArxiv}
							refreshedArxiv={isHubArxivRefreshed}
							refreshingVenue={refreshingVenue}
							refreshedVenue={isHubVenueRefreshed}
							refreshingCategories={refreshingCategories}
							refreshedCategories={refreshedCategories}
							refreshingVenueIds={activeRefreshingVenueIds}
							refreshedVenueIds={refreshedVenueIds}
							onRefreshArxiv={() => void handleRefreshArxiv()}
							onRefreshVenue={() => void handleRefreshVenue()}
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
											resetPagination();
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
												resetPagination();
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
													resetPagination();
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
													resetPagination();
												}}
												className="magpie-seg-btn"
											>
												{dom === "all" ? t("plaza.collection.allTags") : dom}
											</button>
										))}
									</div>
								</>
							)}

							{/* Sort Switcher: Newest | In-Pool Citations */}
							<div className="magpie-seg">
								{(["newest", "citations"] as const).map((mode) => (
									<button
										key={mode}
										type="button"
										data-active={sortOrder === mode}
										onClick={() => {
											setSortOrder(mode);
											resetPagination();
										}}
										className="magpie-seg-btn gap-1"
									>
										{mode === "citations" ? (
											<GitFork className="size-3" />
										) : null}
										<span>
											{mode === "newest"
												? t("plaza.discover.sortNewest")
												: t("plaza.discover.sortCitations")}
										</span>
									</button>
								))}
							</div>

							{/* Right actions */}
							<div className="ml-auto flex items-center gap-1.5">
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
											disabled={pageItems.length === 0}
											aria-label={t("plaza.collection.toggleSelectAll")}
											aria-pressed={allDisplayedSelected}
											className={cn(
												COLLECTION_ICON_BTN_CLASS,
												allDisplayedSelected &&
													"bg-brand/12 text-brand hover:bg-brand/18 hover:text-brand dark:bg-brand/20 dark:text-brand",
											)}
										>
											<ListChecks className="size-3.5" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{t("plaza.collection.toggleSelectAll")}
									</TooltipContent>
								</Tooltip>

								<CollectionConfigPopover
									arxivCategories={summary.categories}
									venues={summary.venues}
									onChangeCategories={handleCategoriesChange}
									onChangeVenues={handleVenuesChange}
									onRemoveVenue={handleRemoveVenue}
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
										resetPagination();
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
										{summary.arxivCount}
									</span>
								</button>
								{summary.categories.map((cat) => {
									const catRefreshing =
										refreshingCategories.has(cat) ||
										(preloading &&
											!summary.arxivWatermarks?.[cat]?.historyComplete);
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
												resetPagination();
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
												{summary.categoryCounts[cat] ?? 0}
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
										resetPagination();
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
												resetPagination();
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
					</div>

					{/* Main Paper List (50 initial, +50 per Load More from SQLite) */}
					<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-3">
						{(isCurrentViewRefreshing || loadingPage) &&
						pageItems.length === 0 ? (
							<div className="grid gap-2.5" data-collection-list-skeleton>
								{SKELETON_CARD_KEYS.map((key) => (
									<CollectionPaperCardSkeleton key={key} />
								))}
							</div>
						) : pageItems.length === 0 ? (
							<div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
								<p className="text-muted-foreground text-xs">
									{summary.totalCount === 0
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
								{pageItems.map((paper) => (
									<CollectionPaperCard
										key={paper.id}
										paper={paper}
										orderedCategories={summary.categories}
										selected={selectedIds.has(paper.id)}
										imported={checkPaperImported(paper, importedIds)}
										onToggleSelect={toggleSelect}
										onImport={handleImportSinglePaper}
										onOpenDetail={handleOpenDetailPaper}
										onJumpToVenue={handleJumpToLinkedVenue}
										onOpenLinkedArxiv={handleOpenLinkedArxiv}
									/>
								))}

								{/* Paginated Footer (+50 per click) */}
								<div className="flex flex-col items-center justify-center gap-2 py-3">
									{pageHasMore && pageItems.length < pageTotal ? (
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={loadingMorePage || loadingPage}
											onClick={() => void handleLoadMorePage()}
											className={cn(
												"h-8 gap-1.5 px-4 text-xs",
												COLLECTION_OUTLINE_BTN_CLASS,
											)}
										>
											{loadingMorePage ? (
												<Loader2 className="size-3.5 animate-spin" />
											) : (
												<ChevronDown className="size-3.5" />
											)}
											<span>
												{t("plaza.collection.loadMoreStep", {
													step: Math.min(
														LOAD_MORE_STEP,
														Math.max(1, pageTotal - pageItems.length),
													),
													shown: pageItems.length,
													total: pageTotal,
												})}
											</span>
										</Button>
									) : (
										<div className="flex flex-wrap items-center justify-center gap-2">
											<span className="text-muted-foreground text-xs tabular-nums">
												{t("plaza.collection.showingAll", {
													total: Math.max(pageTotal, pageItems.length),
												})}
											</span>
											{activeSource === "arxiv" &&
											timeRange === "all" &&
											!isActiveArxivHistoryComplete ? (
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
				pendingPeer={pendingDetailPeer}
				open={detailPaper !== null || pendingDetailPeer !== null}
				imported={
					detailPaper !== null && checkPaperImported(detailPaper, importedIds)
				}
				onOpenChange={(open) => {
					if (!open) {
						linkedPeerReqSeqRef.current += 1;
						setDetailPaper(null);
						setPendingDetailPeer(null);
					}
				}}
				onImport={handleImportSinglePaper}
				onJumpToVenue={handleJumpToLinkedVenue}
				onPaperUpdated={(updated) => {
					setDetailPaper(updated);
					setPageItems((prev) =>
						prev.map((it) => (it.id === updated.id ? updated : it)),
					);
				}}
			/>
		</div>
	);
}

function CollectionPaperCardSkeleton() {
	return (
		<div className="magpie-card flex items-start gap-3 p-3.5">
			<Skeleton className="mt-0.5 size-4 shrink-0 rounded" />
			<div className="min-w-0 flex-1 space-y-2">
				<div className="flex flex-wrap items-center gap-1.5">
					<Skeleton className="h-5 w-16 rounded-full" />
					<Skeleton className="h-5 w-12 rounded" />
					<Skeleton className="h-5 w-20 rounded" />
					<Skeleton className="h-4 w-36 rounded" />
				</div>
				<Skeleton className="h-4 w-5/6 rounded" />
				<div className="space-y-1.5 pt-0.5">
					<Skeleton className="h-3 w-full rounded" />
					<Skeleton className="h-3 w-11/12 rounded" />
				</div>
				<div className="flex items-center gap-1.5 pt-0.5">
					<Skeleton className="h-4 w-16 rounded" />
					<Skeleton className="h-4 w-20 rounded" />
					<Skeleton className="h-4 w-14 rounded" />
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<Skeleton className="size-7 rounded-md" />
				<Skeleton className="size-7 rounded-md" />
			</div>
		</div>
	);
}

const CollectionPaperCard = memo(function CollectionPaperCard({
	paper,
	orderedCategories,
	selected,
	imported,
	onToggleSelect,
	onImport,
	onOpenDetail,
	onJumpToVenue,
	onOpenLinkedArxiv,
}: {
	paper: CollectionPaperItem;
	orderedCategories: readonly string[];
	selected: boolean;
	imported: boolean;
	onToggleSelect: (id: string) => void;
	onImport: (paper: CollectionPaperItem) => Promise<void> | void;
	onOpenDetail: (paper: CollectionPaperItem) => void;
	onJumpToVenue: (peer: CollectionLinkedPeer) => void;
	onOpenLinkedArxiv: (peer: CollectionLinkedPeer) => Promise<void> | void;
}) {
	const { t } = useTranslation("sidebar");
	const [busy, setBusy] = useState(false);

	const triggerImport = async () => {
		if (busy || imported) return;
		setBusy(true);
		try {
			await onImport(paper);
		} finally {
			setBusy(false);
		}
	};

	const topKeywords = paper.keywords?.slice(0, 4) ?? [];
	const primaryLabel =
		paper.sourceType === "arxiv"
			? formatArxivCategoriesLabel(paper, orderedCategories)
			: paper.sourceLabel;
	const linkedPeer = paper.linkedPeer;

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
					onCheckedChange={() => onToggleSelect(paper.id)}
					aria-label={paper.title}
				/>
			</div>

			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<PlazaSourceBadge source={paper.sourceType} label={primaryLabel} />
					{paper.sourceType === "arxiv" &&
					linkedPeer?.sourceType === "venue" ? (
						<PlazaSourceJumpButton
							source="venue"
							label={linkedPeer.sourceLabel}
							onClick={(e) => {
								e.stopPropagation();
								onJumpToVenue(linkedPeer);
							}}
						/>
					) : null}
					{paper.sourceType === "venue" &&
					linkedPeer?.sourceType === "arxiv" ? (
						<PlazaSourceJumpButton
							source="arxiv"
							label={formatArxivCategoriesLabel(linkedPeer, orderedCategories)}
							onClick={(e) => {
								e.stopPropagation();
								void onOpenLinkedArxiv(linkedPeer);
							}}
						/>
					) : null}
					{paper.ccfRank ? (
						<span className="inline-flex h-5 items-center rounded bg-brand/10 px-1.5 font-mono text-[0.625rem] text-brand leading-none">
							{paper.ccfRank}
						</span>
					) : null}
					<span className="inline-flex h-5 items-center font-mono text-[0.6875rem] text-muted-foreground tabular-nums leading-none">
						{paper.publishedAt.slice(0, 10)}
					</span>
					<span
						title={t("plaza.collection.citations", {
							count: paper.citationCount ?? 0,
						})}
						className="inline-flex h-5 items-center gap-1 rounded bg-muted/60 px-1.5 font-mono text-[0.625rem] text-muted-foreground tabular-nums leading-none"
					>
						<GitFork className="size-2.5 shrink-0" />
						{paper.citationCount ?? 0}
					</span>
					{paper.authors.length > 0 ? (
						<span className="inline-flex h-5 max-w-full items-center text-caption text-muted-foreground leading-none">
							<span className="truncate">
								· {paper.authors.slice(0, 3).join(", ")}
								{paper.authors.length > 3 ? " et al." : ""}
							</span>
						</span>
					) : null}
				</div>

				<button
					type="button"
					onClick={() => onOpenDetail(paper)}
					className="mt-1 block w-full cursor-pointer text-left focus:outline-none"
				>
					<h3
						className="line-clamp-2 font-medium text-foreground text-sm leading-snug group-hover:text-brand"
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
			</div>

			<div className="flex shrink-0 items-center gap-1">
				{paper.arxivId ? (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						title={t("plaza.arxivRec.read")}
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
				) : null}

				{paper.url ? (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						title={t("plaza.feeds.openOriginal")}
						aria-label={t("plaza.feeds.openOriginal")}
						className={COLLECTION_ICON_BTN_CLASS}
						onClick={() => openExternalUrl(paper.url)}
					>
						<ArrowUpRight className="size-3.5" />
					</Button>
				) : null}

				{imported ? (
					<span
						className="inline-flex size-7 items-center justify-center rounded-[min(var(--radius-md),12px)] bg-emerald-500/12 text-emerald-600 ring-1 ring-emerald-500/25 ring-inset dark:bg-emerald-500/20 dark:text-emerald-300 dark:ring-emerald-400/35"
						title={t("plaza.feeds.imported")}
					>
						<Check className="size-3.5" />
					</span>
				) : (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						disabled={busy}
						title={t("plaza.feeds.import")}
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
				)}
			</div>
		</div>
	);
});

function parseTracksInput(raw: string): string[] {
	return Array.from(
		new Set(
			raw
				.split(/[\n,]+/)
				.map((s) => s.trim())
				.filter(Boolean),
		),
	);
}

function CollectionConfigPopover({
	arxivCategories,
	venues,
	onChangeCategories,
	onChangeVenues,
	onRemoveVenue,
}: {
	arxivCategories: string[];
	venues: VenueConfig[];
	onChangeCategories: (next: string[]) => void;
	onChangeVenues: (next: VenueConfig[]) => void;
	onRemoveVenue: (venueId: string) => void;
}) {
	const { t } = useTranslation("sidebar");
	const [catSearch, setCatSearch] = useState("");
	const [editingVenueId, setEditingVenueId] = useState<string | null>(null);
	const [venueLabel, setVenueLabel] = useState("");
	const [venueUrl, setVenueUrl] = useState("");
	const [venueTracksText, setVenueTracksText] = useState("");
	const [venueNotes, setVenueNotes] = useState("");
	const [venueAgent, setVenueAgent] = useState(true);

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

	const resetVenueForm = () => {
		setEditingVenueId(null);
		setVenueLabel("");
		setVenueUrl("");
		setVenueTracksText("");
		setVenueNotes("");
		setVenueAgent(true);
	};

	const startEditVenue = (v: VenueConfig) => {
		setEditingVenueId(v.id);
		setVenueLabel(v.name);
		setVenueUrl(v.url);
		setVenueTracksText((v.tracks ?? []).join("\n"));
		setVenueNotes(v.notes ?? "");
		setVenueAgent(v.mode === "agent");
	};

	const submitVenueForm = () => {
		const name = venueLabel.trim();
		const url = venueUrl.trim();
		if (!name || !url) return;
		const tracks = parseTracksInput(venueTracksText);
		const notes = venueNotes.trim() || undefined;

		if (editingVenueId) {
			onChangeVenues(
				venues.map((item) =>
					item.id === editingVenueId
						? {
								...item,
								name,
								url,
								tracks,
								notes,
								mode: venueAgent ? "agent" : "auto",
								kind: item.kind ?? inferVenueKind({ id: item.id, name, url }),
							}
						: item,
				),
			);
			resetVenueForm();
			return;
		}

		const slug = name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");
		const id = `${slug || "venue"}-${Date.now()}`;
		const kind = inferVenueKind({ id, name, url });
		onChangeVenues([
			...venues,
			{
				id,
				name,
				url,
				tracks,
				...(notes ? { notes } : {}),
				mode: venueAgent ? "agent" : "auto",
				kind,
			},
		]);
		resetVenueForm();
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
					<div className="agentero-scroll mt-1.5 flex max-h-36 flex-wrap gap-1 overflow-y-auto pr-1">
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
						{t("plaza.collection.venuesTitle")} ({venues.length})
					</p>
					<div className="agentero-scroll mt-1.5 max-h-44 space-y-1.5 overflow-y-auto pr-1">
						{venues.map((v) => (
							<div
								key={v.id}
								className={cn(
									"flex items-center justify-between gap-1.5 rounded-md bg-muted/40 px-2 py-1 text-xs",
									editingVenueId === v.id && "ring-1 ring-brand/50",
								)}
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
									title={v.notes || v.url}
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
								<div className="flex shrink-0 items-center gap-1">
									<button
										type="button"
										onClick={() => startEditVenue(v)}
										className="text-muted-foreground hover:text-foreground"
										aria-label={v.name}
									>
										<Pencil className="size-3" />
									</button>
									<button
										type="button"
										onClick={() => {
											if (editingVenueId === v.id) resetVenueForm();
											onRemoveVenue(v.id);
										}}
										className="text-muted-foreground hover:text-destructive"
										aria-label={t("plaza.feeds.remove")}
									>
										<Trash2 className="size-3" />
									</button>
								</div>
							</div>
						))}
					</div>

					<div className="mt-2 space-y-1.5 border-t pt-2">
						<input
							type="text"
							value={venueLabel}
							onChange={(e) => setVenueLabel(e.target.value)}
							placeholder={t("plaza.collection.venueNamePlaceholder")}
							className="h-7 w-full rounded-md border bg-background px-2 text-xs"
						/>
						<input
							type="url"
							value={venueUrl}
							onChange={(e) => setVenueUrl(e.target.value)}
							placeholder={t("plaza.collection.venueUrlPlaceholder")}
							className="h-7 w-full rounded-md border bg-background px-2 text-xs"
						/>
						<input
							type="text"
							value={venueTracksText}
							onChange={(e) => setVenueTracksText(e.target.value)}
							placeholder={t("plaza.collection.venueTracksPlaceholder")}
							className="h-7 w-full rounded-md border bg-background px-2 text-xs"
						/>
						<textarea
							rows={2}
							value={venueNotes}
							onChange={(e) => setVenueNotes(e.target.value)}
							placeholder={t("plaza.collection.venueNotesPlaceholder")}
							className="w-full resize-none rounded-md border bg-background px-2 py-1 text-xs leading-snug"
						/>
						<div className="flex items-center justify-between gap-2">
							<label
								htmlFor="collection-new-venue-agent"
								className="flex cursor-pointer items-center gap-1.5 text-caption text-muted-foreground"
							>
								<Checkbox
									id="collection-new-venue-agent"
									checked={venueAgent}
									onCheckedChange={(c) => setVenueAgent(c === true)}
								/>
								<span>{t("plaza.collection.agentExtract")}</span>
							</label>
							<div className="flex items-center gap-1">
								{editingVenueId ? (
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										onClick={resetVenueForm}
										className="size-7"
									>
										<X className="size-3.5" />
									</Button>
								) : null}
								<Button
									type="button"
									size="sm"
									onClick={submitVenueForm}
									disabled={!venueLabel.trim() || !venueUrl.trim()}
									className={cn(
										"h-7 gap-1 text-caption",
										COLLECTION_PRIMARY_BTN_CLASS,
									)}
								>
									{editingVenueId ? (
										<Check className="size-3.5" />
									) : (
										<>
											<Plus className="size-3" />
											{t("plaza.feeds.add")}
										</>
									)}
								</Button>
							</div>
						</div>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
