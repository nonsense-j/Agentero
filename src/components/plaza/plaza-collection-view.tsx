/**
 * Native 广场 panel: Paper Collection (2026 arXiv + SE/AI/PL/Security Venues
 * including ASE, ICSE, FSE, ISSTA, PLDI, TOSEM, TSE).
 *
 * Local-first persistence with arXiv latest-submission update detection,
 * fixed researchr/Crossref/DBLP parsers + optional Agent extraction for custom
 * venue URLs, time & keyword filtering, and single/batch Add to Library.
 */

import {
	ArrowUpRight,
	BookOpen,
	Check,
	CheckSquare,
	Download,
	Loader2,
	Plus,
	RefreshCw,
	Search,
	Settings2,
	Sparkles,
	Square,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PlazaSourceBadge } from "@/components/icons/plaza-icons";
import { SelectionSurface } from "@/components/selection/selection-surface";
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
	fetchMoreArxivCollection,
	loadCollectionState,
	mergeCollectionItems,
	refreshPaperCollection,
	saveCollectionState,
	searchArxivCollection,
	type VenueConfig,
} from "@/lib/plaza/collection";
import { ARXIV_ALL_CATEGORIES } from "@/lib/plaza/feeds";
import { openRemoteArxivPaper } from "@/lib/workspace/actions";

type SourceFilter = "all" | CollectionSourceType;
type TimeRangeFilter = "all" | "30d" | "7d";

export function PlazaCollectionView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const [state, setState] = useState<CollectionState>(loadCollectionState);
	const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
	const [subFilter, setSubFilter] = useState<string | null>(null);
	const [timeRange, setTimeRange] = useState<TimeRangeFilter>("all");
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [checkingUpdate, setCheckingUpdate] = useState(false);
	const [updateHint, setUpdateHint] = useState<ArxivUpdateCheckResult | null>(
		null,
	);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
	const [batchImporting, setBatchImporting] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [arxivOffset, setArxivOffset] = useState(150);
	const mountedRef = useRef(false);
	const checkTimerRef = useRef<number | null>(null);

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

	const handleRefresh = useCallback(async () => {
		if (busy) return;
		setBusy(true);
		setUpdateHint(null);
		try {
			const next = await refreshPaperCollection({
				categories: state.categories,
				venues: state.venues,
			});
			setState(next);
			setArxivOffset(150);
		} catch (err) {
			notifyError(errorText(err));
		} finally {
			setBusy(false);
		}
	}, [busy, state.categories, state.venues]);

	const handleLoadMoreArxiv = useCallback(async () => {
		if (loadingMore || busy) return;
		setLoadingMore(true);
		try {
			const targetCats =
				subFilter && state.categories.includes(subFilter)
					? [subFilter]
					: state.categories;
			const { state: next } = await fetchMoreArxivCollection({
				categories: targetCats,
				startOffset: arxivOffset,
				maxResultsPerCategory: 100,
			});
			setState(next);
			setArxivOffset((prev) => prev + 100);
		} catch (err) {
			notifyError(errorText(err));
		} finally {
			setLoadingMore(false);
		}
	}, [arxivOffset, busy, loadingMore, state.categories, subFilter]);

	// Initial load: if empty or any configured category/venue is missing from cache, refresh automatically; otherwise check for arXiv updates silently.
	useEffect(() => {
		if (mountedRef.current) return;
		mountedRef.current = true;
		const missingCategory = state.categories.some(
			(cat) =>
				!state.items.some(
					(item) =>
						item.sourceType === "arxiv" &&
						(item.sourceLabel === cat || item.categories.includes(cat)),
				),
		);
		const missingVenue = state.venues.some(
			(venue) =>
				!state.items.some(
					(item) =>
						item.sourceType === "venue" &&
						(item.venueId === venue.id || item.sourceLabel === venue.name),
				),
		);
		if (state.items.length === 0 || missingCategory || missingVenue) {
			void handleRefresh();
		} else {
			void runCheckUpdate(true);
		}
	}, [
		handleRefresh,
		runCheckUpdate,
		state.categories,
		state.items,
		state.venues,
	]);

	// Trigger update check and on-demand arXiv category search when user searches (debounced).
	const handleQueryChange = useCallback(
		(nextQuery: string) => {
			setQuery(nextQuery);
			if (checkTimerRef.current) {
				window.clearTimeout(checkTimerRef.current);
			}
			const trimmed = nextQuery.trim();
			if (trimmed.length >= 2) {
				checkTimerRef.current = window.setTimeout(() => {
					void runCheckUpdate(true);
					void searchArxivCollection(trimmed, state.categories)
						.then((found) => {
							if (found.length === 0) return;
							setState((prev) => {
								const merged = mergeCollectionItems([prev.items, found]);
								if (merged.length === prev.items.length) return prev;
								const next = { ...prev, items: merged };
								saveCollectionState(next);
								return next;
							});
						})
						.catch(() => undefined);
				}, 550);
			}
		},
		[runCheckUpdate, state.categories],
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

	const visiblePapers = useMemo(() => {
		const now = Date.now();
		const q = query.trim().toLowerCase();
		const qTokens = q ? q.split(/\s+/).filter(Boolean) : [];
		return state.items.filter((paper: CollectionPaperItem) => {
			if (sourceFilter !== "all" && paper.sourceType !== sourceFilter) {
				return false;
			}
			if (
				subFilter &&
				paper.sourceLabel !== subFilter &&
				!paper.categories.includes(subFilter)
			) {
				return false;
			}
			if (timeRange !== "all") {
				const days = timeRange === "7d" ? 7 : 30;
				const ts = Date.parse(paper.publishedAt);
				if (!Number.isNaN(ts) && now - ts > days * 86_400_000) {
					return false;
				}
			}
			if (qTokens.length > 0) {
				const hay =
					`${paper.title} ${paper.abstract} ${paper.authors.join(" ")} ${paper.sourceLabel} ${paper.categories.join(" ")} ${paper.arxivId ?? ""} ${paper.doi ?? ""}`.toLowerCase();
				if (!qTokens.every((tok) => hay.includes(tok))) return false;
			}
			return true;
		});
	}, [query, sourceFilter, state.items, subFilter, timeRange]);

	const availableSubFilters = useMemo(() => {
		const counts = new Map<string, number>();
		if (sourceFilter !== "venue") {
			for (const cat of state.categories) {
				counts.set(cat, 0);
			}
		}
		for (const p of state.items) {
			if (sourceFilter !== "all" && p.sourceType !== sourceFilter) continue;
			if (p.sourceType === "arxiv") {
				const matchedCats = state.categories.filter(
					(cat) => p.sourceLabel === cat || p.categories.includes(cat),
				);
				if (matchedCats.length > 0) {
					for (const cat of matchedCats) {
						counts.set(cat, (counts.get(cat) ?? 0) + 1);
					}
				} else {
					counts.set(p.sourceLabel, (counts.get(p.sourceLabel) ?? 0) + 1);
				}
			} else {
				counts.set(p.sourceLabel, (counts.get(p.sourceLabel) ?? 0) + 1);
			}
		}
		const pinnedOrder = new Map(state.categories.map((cat, idx) => [cat, idx]));
		return Array.from(counts.entries())
			.filter(([label, count]) => count > 0 || pinnedOrder.has(label))
			.sort((a, b) => {
				const aPin = pinnedOrder.get(a[0]);
				const bPin = pinnedOrder.get(b[0]);
				if (aPin !== undefined && bPin !== undefined) return aPin - bPin;
				if (aPin !== undefined) return -1;
				if (bPin !== undefined) return 1;
				return b[1] - a[1];
			});
	}, [sourceFilter, state.categories, state.items]);

	const toggleSelect = useCallback((id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const toggleSelectAllVisible = useCallback(() => {
		setSelectedIds((prev) => {
			const allSelected =
				visiblePapers.length > 0 &&
				visiblePapers.every((p: CollectionPaperItem) => prev.has(p.id));
			if (allSelected) return new Set();
			return new Set(visiblePapers.map((p: CollectionPaperItem) => p.id));
		});
	}, [visiblePapers]);

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
		() =>
			visiblePapers.filter((p: CollectionPaperItem) => selectedIds.has(p.id)),
		[selectedIds, visiblePapers],
	);

	return (
		<div
			className={cn(
				"magpie-canvas magpie-view-in relative flex h-full min-h-0 flex-col",
				className,
			)}
		>
			{/* Sticky translucent Magpie control bar */}
			<div
				data-plaza-header
				className="sticky top-0 z-10 flex flex-col gap-2 bg-background/80 px-3 py-2.5 shadow-[0_0.5px_0_0_var(--magpie-hairline)] backdrop-blur-xl backdrop-saturate-150"
			>
				<div className="flex flex-wrap items-center gap-2">
					{/* Source Segmented Control */}
					<div className="magpie-seg">
						{(["all", "arxiv", "venue"] as const).map((kind) => (
							<button
								key={kind}
								type="button"
								data-active={sourceFilter === kind}
								onClick={() => {
									setSourceFilter(kind);
									setSubFilter(null);
								}}
								className="magpie-seg-btn"
							>
								{t(`plaza.collection.source.${kind}`)}
							</button>
						))}
					</div>

					{/* Time Range Segmented Control */}
					<div className="magpie-seg">
						{(["all", "30d", "7d"] as const).map((range) => (
							<button
								key={range}
								type="button"
								data-active={timeRange === range}
								onClick={() => setTimeRange(range)}
								className="magpie-seg-btn"
							>
								{t(`plaza.collection.time.${range}`)}
							</button>
						))}
					</div>

					{/* Search box */}
					<div className="relative min-w-[180px] flex-1">
						<Search
							className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
							aria-hidden
						/>
						<input
							type="search"
							value={query}
							onChange={(e) => handleQueryChange(e.target.value)}
							placeholder={t("plaza.collection.searchPlaceholder")}
							className="h-7 w-full rounded-lg bg-[var(--magpie-surface)] pr-7 pl-8 text-xs shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)] placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-brand/60"
						/>
						{query ? (
							<button
								type="button"
								onClick={() => setQuery("")}
								className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
								aria-label={t("plaza.collection.clearSearch")}
							>
								<X className="size-3" />
							</button>
						) : null}
					</div>

					{/* Right actions: Select all, Batch import, Config, Refresh */}
					<div className="ml-auto flex items-center gap-1.5">
						{selectedPapers.length > 0 ? (
							<Button
								type="button"
								size="sm"
								disabled={batchImporting}
								onClick={() => void importPapers(selectedPapers)}
								className="h-6 gap-1 rounded-md px-2.5 text-caption"
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
									onClick={toggleSelectAllVisible}
									disabled={visiblePapers.length === 0}
									aria-label={t("plaza.collection.toggleSelectAll")}
								>
									{selectedPapers.length > 0 &&
									selectedPapers.length === visiblePapers.length ? (
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
								updateConfig((prev) => ({ ...prev, categories: cats }));
								void refreshPaperCollection({
									categories: cats,
									venues: state.venues,
								})
									.then((next) => setState(next))
									.catch(() => undefined);
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
									disabled={busy}
									onClick={() => void handleRefresh()}
									aria-label={t("plaza.collection.refresh")}
								>
									{busy ? (
										<Loader2 className="size-3.5 animate-spin" />
									) : (
										<RefreshCw className="size-3.5" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("plaza.collection.refresh")}</TooltipContent>
						</Tooltip>
					</div>
				</div>

				{/* Sub-filter chips (cs.SE, cs.AI, TOSEM 2026, TSE 2026, ICSE 2026, etc.) */}
				{availableSubFilters.length > 0 ? (
					<div className="flex items-center gap-1.5 overflow-x-auto py-0.5">
						<button
							type="button"
							data-active={subFilter === null}
							onClick={() => setSubFilter(null)}
							className="magpie-chip shrink-0"
						>
							{t("plaza.collection.allTags")}
							<span className="text-muted-foreground tabular-nums">
								{state.items.length}
							</span>
						</button>
						{availableSubFilters.map(([label, count]) => (
							<button
								key={label}
								type="button"
								data-active={subFilter === label}
								onClick={() =>
									setSubFilter((prev) => (prev === label ? null : label))
								}
								className="magpie-chip shrink-0"
							>
								<span>{label}</span>
								<span className="text-muted-foreground tabular-nums">
									{count}
								</span>
							</button>
						))}
					</div>
				) : null}

				{/* Update Reminder Banner when newer arXiv papers are detected */}
				{updateHint?.hasUpdate && updateHint.remoteLatestTitle ? (
					<div className="flex items-center justify-between gap-2 rounded-lg bg-brand/10 px-3 py-1.5 text-xs shadow-[inset_0_0_0_0.5px_color-mix(in_oklch,var(--brand)_40%,transparent)]">
						<span className="min-w-0 truncate text-foreground">
							<span className="font-medium">
								{t("plaza.collection.updateAvailable")}
							</span>{" "}
							<span className="text-muted-foreground">
								({updateHint.remoteLatestId} · {updateHint.remoteLatestTitle})
							</span>
						</span>
						<div className="flex shrink-0 items-center gap-1">
							<Button
								type="button"
								size="sm"
								disabled={busy}
								onClick={() => void handleRefresh()}
								className="h-6 px-2 text-caption"
							>
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

			{/* Main Paper Card Stream */}
			<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-3">
				{busy && state.items.length === 0 ? (
					<div className="flex items-center justify-center gap-2 py-14 text-muted-foreground text-xs">
						<Loader2 className="size-4 animate-spin" />
						<span>{t("plaza.collection.loading")}</span>
					</div>
				) : visiblePapers.length === 0 ? (
					<div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
						<p className="text-muted-foreground text-xs">
							{state.items.length === 0
								? t("plaza.collection.empty")
								: t("plaza.collection.emptyFiltered")}
						</p>
						{state.items.length === 0 ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => void handleRefresh()}
							>
								<RefreshCw className="size-3.5" />
								{t("plaza.collection.refresh")}
							</Button>
						) : null}
					</div>
				) : (
					<div className="grid gap-2.5">
						{visiblePapers.map((paper: CollectionPaperItem) => (
							<CollectionPaperCard
								key={paper.id}
								paper={paper}
								selected={selectedIds.has(paper.id)}
								imported={importedIds.has(paper.id)}
								onToggleSelect={() => toggleSelect(paper.id)}
								onImport={() => void importPapers([paper])}
							/>
						))}
						{sourceFilter !== "venue" &&
						(!subFilter || state.categories.includes(subFilter)) ? (
							<div className="flex justify-center py-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={loadingMore || busy}
									onClick={() => void handleLoadMoreArxiv()}
									className="h-7 gap-1.5 text-xs"
								>
									{loadingMore ? (
										<>
											<Loader2 className="size-3.5 animate-spin" />
											<span>{t("plaza.collection.loadingMoreArxiv")}</span>
										</>
									) : (
										<>
											<RefreshCw className="size-3.5" />
											<span>{t("plaza.collection.loadMoreArxiv")}</span>
										</>
									)}
								</Button>
							</div>
						) : null}
					</div>
				)}
			</div>
		</div>
	);
}

function CollectionPaperCard({
	paper,
	selected,
	imported,
	onToggleSelect,
	onImport,
}: {
	paper: CollectionPaperItem;
	selected: boolean;
	imported: boolean;
	onToggleSelect: () => void;
	onImport: () => void;
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

	return (
		<div
			className={cn(
				"magpie-card group relative flex items-start gap-3 p-3.5",
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

			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<PlazaSourceBadge
						source={paper.sourceType}
						label={paper.sourceLabel}
					/>
					<span className="font-mono text-[11px] text-muted-foreground tabular-nums">
						{paper.publishedAt.slice(0, 10)}
					</span>
					{paper.authors.length > 0 ? (
						<span className="truncate text-caption text-muted-foreground">
							· {paper.authors.slice(0, 3).join(", ")}
							{paper.authors.length > 3 ? " et al." : ""}
						</span>
					) : null}
				</div>

				<h3
					className="mt-1 line-clamp-2 font-medium text-foreground text-sm leading-snug"
					title={paper.title}
				>
					{paper.title}
				</h3>

				{paper.abstract ? (
					<SelectionSurface
						source={{
							sourcePath: paper.url,
							sourceUrl: paper.url,
							sourceTitle: paper.title,
							origin: "markdown",
							surface: "abstract",
						}}
						className="mt-1.5 line-clamp-3 select-text text-muted-foreground text-xs leading-relaxed"
					>
						{paper.abstract}
					</SelectionSurface>
				) : null}
			</div>

			<div className="flex shrink-0 items-center gap-0.5">
				{paper.arxivId ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("plaza.arxivRec.read")}
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
						className="inline-flex size-7 items-center justify-center text-brand"
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
	const [newVenueAgent, setNewVenueAgent] = useState(true);

	const orderedCategories = useMemo(() => {
		const seen = new Set<string>();
		const list: string[] = [];
		for (const cat of [
			...DEFAULT_ARXIV_CATEGORIES,
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
		onChangeVenues([
			...venues,
			{
				id: `${id}-${Date.now()}`,
				name,
				url,
				mode: newVenueAgent ? "agent" : "auto",
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
					<div className="mt-1.5 max-h-44 space-y-1.5 overflow-y-auto pr-1">
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
								className="h-6 gap-1 px-2 text-caption"
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
