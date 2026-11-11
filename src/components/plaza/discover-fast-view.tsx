import {
	ArrowLeft,
	CheckSquare,
	ChevronDown,
	Download,
	Loader2,
	RotateCcw,
	Search,
	SlidersHorizontal,
	Square,
	X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DiscoverPaperCard } from "@/components/plaza/discover-paper-card";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import type {
	CollectionPaperItem,
	CollectionState,
	VenueDomain,
	VenueKind,
} from "@/lib/plaza/collection";
import {
	DEFAULT_FAST_SEARCH_FILTERS,
	type FastRankFilter,
	type FastSearchField,
	type FastSearchFilters,
	type FastSearchSort,
	type FastTimePreset,
	searchCollectionFast,
} from "@/lib/plaza/paper-search";

const PAGE_STEP = 80;

export function DiscoverFastView({
	collection,
	importedSet,
	isPaperImported,
	onBackToHub,
	onOpenDetail,
	onImportPaper,
	onBatchImport,
}: {
	collection: CollectionState;
	importedSet: ReadonlySet<string>;
	isPaperImported: (
		paper: CollectionPaperItem,
		set: ReadonlySet<string>,
	) => boolean;
	onBackToHub: () => void;
	onOpenDetail: (paper: CollectionPaperItem) => void;
	onImportPaper: (paper: CollectionPaperItem) => Promise<void>;
	onBatchImport: (papers: CollectionPaperItem[]) => Promise<void>;
}) {
	const { t } = useTranslation("sidebar");
	const [query, setQuery] = useState("");
	const [filters, setFilters] = useState<FastSearchFilters>(
		DEFAULT_FAST_SEARCH_FILTERS,
	);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [visibleLimit, setVisibleLimit] = useState(PAGE_STEP);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [batchBusy, setBatchBusy] = useState(false);

	const searchResult = useMemo(
		() => searchCollectionFast(collection.items, query, filters),
		[collection.items, query, filters],
	);

	const visibleItems = useMemo(
		() => searchResult.items.slice(0, visibleLimit),
		[searchResult.items, visibleLimit],
	);

	const availableVenues = useMemo(() => {
		return collection.venues.filter((v) => {
			if (
				filters.venueKind !== "all" &&
				v.kind &&
				v.kind !== filters.venueKind
			) {
				return false;
			}
			if (
				filters.venueDomain !== "all" &&
				v.domain &&
				v.domain !== filters.venueDomain
			) {
				return false;
			}
			return true;
		});
	}, [collection.venues, filters.venueKind, filters.venueDomain]);

	const toggleArrayItem = <T extends string>(list: T[], item: T): T[] =>
		list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

	const toggleField = (field: FastSearchField) => {
		setFilters((prev) => {
			const has = prev.fields.includes(field);
			if (has && prev.fields.length <= 1) return prev;
			return {
				...prev,
				fields: has
					? prev.fields.filter((f) => f !== field)
					: [...prev.fields, field],
			};
		});
		setVisibleLimit(PAGE_STEP);
	};

	const resetFilters = () => {
		setFilters((prev) => ({
			...DEFAULT_FAST_SEARCH_FILTERS,
			sort: prev.sort,
		}));
		setVisibleLimit(PAGE_STEP);
	};

	const toggleSelect = (id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const allVisibleSelected =
		visibleItems.length > 0 &&
		visibleItems.every((entry) => selectedIds.has(entry.paper.id));

	const toggleSelectAllVisible = () => {
		if (allVisibleSelected) {
			setSelectedIds(new Set());
			return;
		}
		setSelectedIds(new Set(visibleItems.map((entry) => entry.paper.id)));
	};

	const handleBatchImport = async () => {
		if (selectedIds.size === 0 || batchBusy) return;
		const chosen = searchResult.items
			.map((e) => e.paper)
			.filter((p) => selectedIds.has(p.id) && !isPaperImported(p, importedSet));
		if (chosen.length === 0) {
			setSelectedIds(new Set());
			return;
		}
		setBatchBusy(true);
		try {
			await onBatchImport(chosen);
			setSelectedIds(new Set());
		} finally {
			setBatchBusy(false);
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden">
			{/* Top toolbar */}
			<header className="flex shrink-0 flex-col gap-2.5 border-b px-4 py-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={onBackToHub}
							className="h-7 gap-1.5 px-2 text-xs"
						>
							<ArrowLeft className="size-3.5" />
							{t("plaza.discover.backToHub")}
						</Button>
						<span className="rounded-md bg-brand/10 px-2 py-0.5 font-medium text-brand text-xs">
							{t("plaza.discover.fastTitle")}
						</span>
						<span className="font-mono text-muted-foreground text-xs tabular-nums">
							{t("plaza.discover.matchedCount", {
								count: searchResult.totalMatched,
							})}{" "}
							/ {collection.items.length}
						</span>
					</div>

					<div className="flex items-center gap-1.5">
						{/* Sort segmented pills */}
						<div className="inline-flex items-center rounded-lg bg-muted/65 p-0.5">
							{(
								[
									["relevance", t("plaza.discover.sortRelevance")],
									["newest", t("plaza.discover.sortNewest")],
									["citations", t("plaza.discover.sortCitations")],
								] as Array<[FastSearchSort, string]>
							).map(([sortKey, label]) => (
								<button
									key={sortKey}
									type="button"
									onClick={() =>
										setFilters((prev) => ({ ...prev, sort: sortKey }))
									}
									className={cn(
										"rounded-md px-2 py-1 font-medium text-xs transition-colors motion-reduce:transition-none",
										filters.sort === sortKey
											? "bg-background text-foreground shadow-xs"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{label}
								</button>
							))}
						</div>

						{visibleItems.length > 0 ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-xs"
										onClick={toggleSelectAllVisible}
										aria-label={t("plaza.collection.toggleSelectAll")}
									>
										{allVisibleSelected ? (
											<CheckSquare className="size-3.5 text-brand" />
										) : (
											<Square className="size-3.5" />
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">
									{t("plaza.collection.toggleSelectAll")}
								</TooltipContent>
							</Tooltip>
						) : null}

						{selectedIds.size > 0 ? (
							<Button
								type="button"
								size="sm"
								disabled={batchBusy}
								onClick={() => void handleBatchImport()}
								className="h-7 gap-1.5 px-2.5 text-xs tabular-nums"
							>
								{batchBusy ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									<Download className="size-3.5" />
								)}
								{t("plaza.collection.importSelected", {
									count: selectedIds.size,
								})}
							</Button>
						) : null}
					</div>
				</div>

				{/* Search input + Advanced Search toggle */}
				<div className="flex items-center gap-2">
					<div className="relative flex min-w-0 flex-1 items-center">
						<Search className="pointer-events-none absolute left-3 size-3.5 text-muted-foreground" />
						<input
							type="text"
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								setVisibleLimit(PAGE_STEP);
							}}
							placeholder={t("plaza.discover.searchPlaceholder")}
							className="h-8 w-full rounded-lg border bg-background pr-8 pl-8 text-xs text-foreground placeholder:text-muted-foreground focus:border-brand/60 focus:outline-none"
						/>
						{query ? (
							<button
								type="button"
								onClick={() => {
									setQuery("");
									setVisibleLimit(PAGE_STEP);
								}}
								aria-label={t("plaza.collection.clearSearch")}
								className="absolute right-2 rounded p-0.5 text-muted-foreground hover:text-foreground"
							>
								<X className="size-3.5" />
							</button>
						) : null}
					</div>

					<Button
						type="button"
						variant={
							advancedOpen || searchResult.activeFilterCount > 0
								? "secondary"
								: "outline"
						}
						size="sm"
						onClick={() => setAdvancedOpen((v) => !v)}
						className="h-8 shrink-0 gap-1.5 px-2.5 text-xs tabular-nums"
					>
						<SlidersHorizontal className="size-3.5" />
						{t("plaza.discover.advanced")}
						{searchResult.activeFilterCount > 0 ? (
							<span className="rounded-full bg-brand px-1.5 py-0.2 font-mono text-[0.6875rem] text-primary-foreground leading-tight">
								{searchResult.activeFilterCount}
							</span>
						) : null}
						<ChevronDown
							className={cn(
								"size-3.5 transition-transform motion-reduce:transition-none",
								advancedOpen && "rotate-180",
							)}
						/>
					</Button>
				</div>

				{/* Collapsible Advanced Search Panel */}
				{advancedOpen ? (
					<div className="magpie-card flex flex-col gap-3 p-3">
						{/* Row 1: Time Range & Search Fields */}
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div className="flex flex-wrap items-center gap-1.5">
								<span className="mr-1 font-medium text-muted-foreground text-xs">
									{t("plaza.discover.filterTime")}
								</span>
								{(
									[
										["all", t("plaza.discover.timeAll")],
										["7d", t("plaza.collection.time.7d")],
										["30d", t("plaza.collection.time.30d")],
										["90d", t("plaza.discover.time90d")],
										["custom", t("plaza.discover.timeCustom")],
									] as Array<[FastTimePreset, string]>
								).map(([preset, label]) => (
									<button
										key={preset}
										type="button"
										onClick={() => {
											setFilters((prev) => ({ ...prev, timePreset: preset }));
											setVisibleLimit(PAGE_STEP);
										}}
										className={cn(
											"rounded-md px-2 py-1 font-medium text-xs transition-colors",
											filters.timePreset === preset
												? "bg-brand text-primary-foreground"
												: "bg-muted/70 text-muted-foreground hover:text-foreground",
										)}
									>
										{label}
									</button>
								))}

								{filters.timePreset === "custom" ? (
									<div className="flex items-center gap-1.5">
										<input
											type="date"
											value={filters.dateFrom}
											onChange={(e) =>
												setFilters((prev) => ({
													...prev,
													dateFrom: e.target.value,
												}))
											}
											className="h-7 rounded-md border bg-background px-2 font-mono text-xs"
										/>
										<span className="text-muted-foreground text-xs">~</span>
										<input
											type="date"
											value={filters.dateTo}
											onChange={(e) =>
												setFilters((prev) => ({
													...prev,
													dateTo: e.target.value,
												}))
											}
											className="h-7 rounded-md border bg-background px-2 font-mono text-xs"
										/>
									</div>
								) : null}
							</div>

							<div className="flex flex-wrap items-center gap-1.5">
								<span className="mr-1 font-medium text-muted-foreground text-xs">
									{t("plaza.discover.filterFields")}
								</span>
								{(
									[
										["title", t("plaza.discover.fieldTitle")],
										["abstract", t("plaza.discover.fieldAbstract")],
										["keywords", t("plaza.discover.fieldKeywords")],
									] as Array<[FastSearchField, string]>
								).map(([fieldKey, label]) => {
									const active = filters.fields.includes(fieldKey);
									return (
										<button
											key={fieldKey}
											type="button"
											onClick={() => toggleField(fieldKey)}
											className={cn(
												"rounded-md px-2 py-1 font-medium text-xs transition-colors",
												active
													? "bg-brand/15 text-brand ring-1 ring-brand/30"
													: "bg-muted/70 text-muted-foreground hover:text-foreground",
											)}
										>
											{label}
										</button>
									);
								})}
							</div>
						</div>

						{/* Row 2: Combinable CCF/arXiv Ranks + Source Scope + Reset */}
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div className="flex flex-wrap items-center gap-1.5">
								<span className="mr-1 font-medium text-muted-foreground text-xs">
									{t("plaza.discover.filterRank")}
								</span>
								{(["CCF-A", "CCF-B", "arxiv"] as FastRankFilter[]).map(
									(rank) => {
										const active = filters.ccfRanks.includes(rank);
										return (
											<button
												key={rank}
												type="button"
												onClick={() => {
													setFilters((prev) => ({
														...prev,
														ccfRanks: toggleArrayItem(prev.ccfRanks, rank),
													}));
													setVisibleLimit(PAGE_STEP);
												}}
												className={cn(
													"rounded-md px-2 py-1 font-medium font-mono text-xs transition-colors",
													active
														? "bg-brand text-primary-foreground"
														: "bg-muted/70 text-muted-foreground hover:text-foreground",
												)}
											>
												{rank === "arxiv" ? "arXiv" : rank}
											</button>
										);
									},
								)}

								<span className="mx-1 h-3.5 w-px bg-border" />

								{(
									[
										["all", t("plaza.collection.source.all")],
										["arxiv", t("plaza.collection.source.arxiv")],
										["venue", t("plaza.collection.source.venue")],
									] as const
								).map(([srcKey, label]) => (
									<button
										key={srcKey}
										type="button"
										onClick={() => {
											setFilters((prev) => ({
												...prev,
												sourceType: srcKey,
											}));
											setVisibleLimit(PAGE_STEP);
										}}
										className={cn(
											"rounded-md px-2 py-1 font-medium text-xs transition-colors",
											filters.sourceType === srcKey
												? "bg-brand/15 text-brand ring-1 ring-brand/30"
												: "bg-muted/70 text-muted-foreground hover:text-foreground",
										)}
									>
										{label}
									</button>
								))}
							</div>

							{searchResult.activeFilterCount > 0 ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={resetFilters}
									className="h-7 gap-1 px-2 text-xs"
								>
									<RotateCcw className="size-3" />
									{t("plaza.discover.resetFilters")}
								</Button>
							) : null}
						</div>

						{/* Row 3a: arXiv Categories */}
						{filters.sourceType !== "venue" &&
						collection.categories.length > 0 ? (
							<div className="flex flex-wrap items-center gap-1.5">
								<span className="mr-1 font-medium font-mono text-muted-foreground text-xs">
									arXiv:
								</span>
								{collection.categories.map((cat) => {
									const active = filters.categories.includes(cat);
									return (
										<button
											key={cat}
											type="button"
											onClick={() => {
												setFilters((prev) => ({
													...prev,
													categories: toggleArrayItem(prev.categories, cat),
												}));
												setVisibleLimit(PAGE_STEP);
											}}
											className={cn(
												"rounded-md px-2 py-0.5 font-mono text-xs transition-colors",
												active
													? "bg-brand text-primary-foreground"
													: "bg-muted/65 text-muted-foreground hover:text-foreground",
											)}
										>
											{cat}
										</button>
									);
								})}
							</div>
						) : null}

						{/* Row 3b: Venue Kind, Domain & Specific Venues */}
						{filters.sourceType !== "arxiv" && collection.venues.length > 0 ? (
							<div className="flex flex-col gap-2">
								<div className="flex flex-wrap items-center gap-1.5">
									<span className="mr-1 font-medium text-muted-foreground text-xs">
										{t("plaza.collection.source.venue")}:
									</span>
									{(
										[
											["all", t("plaza.collection.venueKind.all")],
											[
												"conference",
												t("plaza.collection.venueKind.conference"),
											],
											["journal", t("plaza.collection.venueKind.journal")],
										] as Array<["all" | VenueKind, string]>
									).map(([vk, label]) => (
										<button
											key={vk}
											type="button"
											onClick={() => {
												setFilters((prev) => ({ ...prev, venueKind: vk }));
												setVisibleLimit(PAGE_STEP);
											}}
											className={cn(
												"rounded-md px-2 py-0.5 font-medium text-xs transition-colors",
												filters.venueKind === vk
													? "bg-brand/15 text-brand ring-1 ring-brand/30"
													: "bg-muted/65 text-muted-foreground hover:text-foreground",
											)}
										>
											{label}
										</button>
									))}

									<span className="mx-1 h-3.5 w-px bg-border" />

									<span className="font-medium text-muted-foreground text-xs">
										{t("plaza.discover.filterDomain")}:
									</span>
									{(
										["all", "PL/SE", "CR", "AI"] as Array<"all" | VenueDomain>
									).map((dom) => (
										<button
											key={dom}
											type="button"
											onClick={() => {
												setFilters((prev) => ({ ...prev, venueDomain: dom }));
												setVisibleLimit(PAGE_STEP);
											}}
											className={cn(
												"rounded-md px-2 py-0.5 font-mono text-xs transition-colors",
												filters.venueDomain === dom
													? "bg-brand/15 text-brand ring-1 ring-brand/30"
													: "bg-muted/65 text-muted-foreground hover:text-foreground",
											)}
										>
											{dom === "all" ? t("plaza.collection.source.all") : dom}
										</button>
									))}
								</div>

								<div className="agentero-scroll flex max-h-24 flex-wrap gap-1 overflow-y-auto pt-0.5">
									{availableVenues.map((venue) => {
										const active = filters.venues.includes(venue.id);
										return (
											<button
												key={venue.id}
												type="button"
												onClick={() => {
													setFilters((prev) => ({
														...prev,
														venues: toggleArrayItem(prev.venues, venue.id),
													}));
													setVisibleLimit(PAGE_STEP);
												}}
												className={cn(
													"inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[0.6875rem] transition-colors",
													active
														? "bg-brand text-primary-foreground"
														: "bg-muted/55 text-muted-foreground hover:text-foreground",
												)}
											>
												<span>{venue.name}</span>
												{venue.ccfRank ? (
													<span className="opacity-75">· {venue.ccfRank}</span>
												) : null}
											</button>
										);
									})}
								</div>
							</div>
						) : null}
					</div>
				) : null}
			</header>

			{/* Results list */}
			<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-4">
				{collection.items.length === 0 ? (
					<div className="flex h-48 flex-col items-center justify-center gap-2 text-center text-muted-foreground text-xs">
						<p>{t("plaza.discover.poolEmptyHint")}</p>
					</div>
				) : visibleItems.length === 0 ? (
					<div className="flex h-48 flex-col items-center justify-center gap-2 text-center text-muted-foreground text-xs">
						<p>{t("plaza.collection.emptyFiltered")}</p>
						{searchResult.activeFilterCount > 0 ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={resetFilters}
								className="h-7 gap-1.5 text-xs"
							>
								<RotateCcw className="size-3" />
								{t("plaza.discover.resetFilters")}
							</Button>
						) : null}
					</div>
				) : (
					<div className="mx-auto flex w-full max-w-4xl flex-col gap-2.5">
						{visibleItems.map((entry) => (
							<DiscoverPaperCard
								key={entry.paper.id}
								paper={entry.paper}
								selected={selectedIds.has(entry.paper.id)}
								imported={isPaperImported(entry.paper, importedSet)}
								onToggleSelect={toggleSelect}
								onOpenDetail={onOpenDetail}
								onImport={onImportPaper}
							/>
						))}

						{visibleItems.length < searchResult.totalMatched ? (
							<div className="flex justify-center pt-2 pb-4">
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => setVisibleLimit((prev) => prev + PAGE_STEP)}
									className="tabular-nums text-xs"
								>
									{t("plaza.collection.loadMoreStep", {
										step: PAGE_STEP,
										shown: visibleItems.length,
										total: searchResult.totalMatched,
									})}
								</Button>
							</div>
						) : null}
					</div>
				)}
			</div>
		</div>
	);
}
