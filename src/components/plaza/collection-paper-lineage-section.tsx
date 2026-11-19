import {
	ArrowUpRight,
	BookOpenCheck,
	ChevronDown,
	ChevronRight,
	GitFork,
	Library,
	Search,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { PlazaSourceBadge } from "@/components/icons/plaza-icons";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/core/utils";
import {
	type CollectionPaperItem,
	formatArxivCategoriesLabel,
} from "@/lib/plaza/collection";
import {
	type CollectionPaperLineageResult,
	type CollectionVaultPaperMatch,
	getCollectionSummarySnapshot,
	subscribeCollectionSummary,
} from "@/lib/plaza/collection-store";

type LineageListTab = "cited" | "references" | "shared";

const LINEAGE_VISIBLE_STEP = 50;

function normalizeIdKey(value?: string | null): string | null {
	const trimmed = value?.trim().toLowerCase();
	return trimmed ? trimmed : null;
}

function stripArxivVersion(arxivId?: string | null): string | null {
	const norm = normalizeIdKey(arxivId);
	if (!norm) return null;
	return norm.replace(/v\d+$/, "");
}

function buildVaultLookupKeys(
	matches: readonly CollectionVaultPaperMatch[],
): Set<string> {
	const keys = new Set<string>();
	for (const m of matches) {
		const doi = normalizeIdKey(m.doi);
		if (doi) keys.add(`doi:${doi}`);
		const ax = stripArxivVersion(m.arxivId);
		if (ax) keys.add(`arxiv:${ax}`);
	}
	return keys;
}

function isPaperInVaultLookup(
	paper: CollectionPaperItem,
	vaultKeys: ReadonlySet<string>,
): boolean {
	if (vaultKeys.size === 0) return false;
	const doi = normalizeIdKey(paper.doi);
	if (doi && vaultKeys.has(`doi:${doi}`)) return true;
	const ax = stripArxivVersion(paper.arxivId);
	if (ax && vaultKeys.has(`arxiv:${ax}`)) return true;
	return false;
}

export function CollectionPaperLineageSection({
	lineage,
	loadingCounts = false,
	loadingItems = false,
	vaultPath,
	onRequestItems,
	onSelectPaper,
	onOpenVaultPaper,
}: {
	lineage: CollectionPaperLineageResult | null;
	loadingCounts?: boolean;
	loadingItems?: boolean;
	vaultPath: string | null;
	onRequestItems?: () => void;
	onSelectPaper: (paper: CollectionPaperItem) => void;
	onOpenVaultPaper: (relPath: string) => void;
}) {
	const { t } = useTranslation("sidebar");
	const collectionSummary = useSyncExternalStore(
		subscribeCollectionSummary,
		getCollectionSummarySnapshot,
	);
	const orderedCategories = collectionSummary.categories;
	const [expanded, setExpanded] = useState(false);
	const [activeTab, setActiveTab] = useState<LineageListTab>("cited");
	const [titleQuery, setTitleQuery] = useState("");
	const [visibleLimit, setVisibleLimit] = useState(LINEAGE_VISIBLE_STEP);

	const citedByInPool = lineage?.citedByInPool ?? [];
	const referencesInPool = lineage?.referencesInPool ?? [];
	const sharedRefPeers = lineage?.sharedRefPeers ?? [];
	const vaultMatches = lineage?.vaultMatches ?? [];
	const itemsLoaded = Boolean(lineage?.itemsLoaded);

	const citedCount = lineage?.citedByCount ?? citedByInPool.length;
	const referencesCount = lineage?.referencesCount ?? referencesInPool.length;
	const sharedCount = lineage?.sharedRefCount ?? sharedRefPeers.length;

	const hasAnyListItems =
		citedCount > 0 || referencesCount > 0 || sharedCount > 0;
	const hasAnything = hasAnyListItems || vaultMatches.length > 0;

	useEffect(() => {
		const counts: Record<LineageListTab, number> = {
			cited: citedCount,
			references: referencesCount,
			shared: sharedCount,
		};
		if (counts[activeTab] > 0) return;
		if (counts.cited > 0) setActiveTab("cited");
		else if (counts.references > 0) setActiveTab("references");
		else if (counts.shared > 0) setActiveTab("shared");
	}, [activeTab, citedCount, referencesCount, sharedCount]);

	const handleToggleExpand = (preferredTab?: LineageListTab) => {
		if (preferredTab) {
			setActiveTab(preferredTab);
			setVisibleLimit(LINEAGE_VISIBLE_STEP);
			if (!expanded) {
				setExpanded(true);
				if (!itemsLoaded && !loadingItems) {
					onRequestItems?.();
				}
			}
			return;
		}
		const next = !expanded;
		setExpanded(next);
		if (next && !itemsLoaded && !loadingItems) {
			onRequestItems?.();
		}
	};

	const normalizedTitleQuery = titleQuery.trim().toLowerCase();

	const filteredCitedByInPool = useMemo(
		() =>
			normalizedTitleQuery
				? citedByInPool.filter((item) =>
						item.title.toLowerCase().includes(normalizedTitleQuery),
					)
				: citedByInPool,
		[citedByInPool, normalizedTitleQuery],
	);

	const filteredReferencesInPool = useMemo(
		() =>
			normalizedTitleQuery
				? referencesInPool.filter((item) =>
						item.title.toLowerCase().includes(normalizedTitleQuery),
					)
				: referencesInPool,
		[referencesInPool, normalizedTitleQuery],
	);

	const filteredSharedRefPeers = useMemo(
		() =>
			normalizedTitleQuery
				? sharedRefPeers.filter((peer) =>
						peer.paper.title.toLowerCase().includes(normalizedTitleQuery),
					)
				: sharedRefPeers,
		[sharedRefPeers, normalizedTitleQuery],
	);

	const activeFilteredCount =
		activeTab === "cited"
			? filteredCitedByInPool.length
			: activeTab === "references"
				? filteredReferencesInPool.length
				: filteredSharedRefPeers.length;

	const effectiveLimit = normalizedTitleQuery
		? activeFilteredCount
		: visibleLimit;

	const visibleCitedByInPool = useMemo(
		() => filteredCitedByInPool.slice(0, effectiveLimit),
		[effectiveLimit, filteredCitedByInPool],
	);
	const visibleReferencesInPool = useMemo(
		() => filteredReferencesInPool.slice(0, effectiveLimit),
		[effectiveLimit, filteredReferencesInPool],
	);
	const visibleSharedRefPeers = useMemo(
		() => filteredSharedRefPeers.slice(0, effectiveLimit),
		[effectiveLimit, filteredSharedRefPeers],
	);
	const hasMoreRows =
		!normalizedTitleQuery && activeFilteredCount > visibleLimit;

	const vaultLookupKeys = useMemo(
		() => buildVaultLookupKeys(vaultMatches),
		[vaultMatches],
	);

	if (loadingCounts && !lineage) {
		return (
			<section
				data-lineage-section
				data-lineage-skeleton
				className="space-y-2"
				aria-label={t("plaza.collection.lineage.title")}
			>
				<div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--magpie-surface)] px-2.5 py-2 shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)]">
					<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
						<ChevronRight className="size-3.5" />
						<GitFork className="size-3" />
						<span className="font-medium">
							{t("plaza.collection.lineage.title")}
						</span>
					</div>
					<div className="flex items-center gap-1.5">
						<Skeleton className="h-5 w-16 rounded-md" />
						<Skeleton className="h-5 w-16 rounded-md" />
						<Skeleton className="h-5 w-16 rounded-md" />
					</div>
				</div>
			</section>
		);
	}

	if (!hasAnything) return null;

	const countTabs = [
		{
			id: "cited" as const,
			label: t("plaza.collection.lineage.citedInPool"),
			count: citedCount,
		},
		{
			id: "references" as const,
			label: t("plaza.collection.lineage.referencesInPool"),
			count: referencesCount,
		},
		{
			id: "shared" as const,
			label: t("plaza.collection.lineage.sharedRefs"),
			count: sharedCount,
		},
	] as const;

	return (
		<section
			data-lineage-section
			className="space-y-2.5"
			aria-label={t("plaza.collection.lineage.title")}
		>
			{!hasAnyListItems ? (
				<div className="flex items-center justify-between gap-2">
					<h4 className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
						<GitFork className="size-3" />
						<span>{t("plaza.collection.lineage.title")}</span>
					</h4>
				</div>
			) : null}

			{/* Personal Vault Matches Highlight Bar (always visible) */}
			{vaultMatches.length > 0 ? (
				<div className="flex flex-col gap-1.5" data-lineage-vault-matches>
					{vaultMatches.map((match) => {
						const isSelf = match.relation === "self";
						const canOpen = Boolean(vaultPath && match.relPath);
						const badgeLabel = isSelf
							? t("plaza.collection.lineage.inVault")
							: t("plaza.collection.lineage.citesVault");
						const content = (
							<>
								<span
									className={cn(
										"inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-[0.6875rem] leading-none",
										isSelf
											? "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/22 dark:text-emerald-200"
											: "bg-brand/14 text-brand",
									)}
								>
									{isSelf ? (
										<BookOpenCheck className="size-3" />
									) : (
										<Library className="size-3" />
									)}
									<span>{badgeLabel}</span>
								</span>
								<span className="min-w-0 flex-1 truncate font-medium text-foreground text-xs">
									{match.title}
								</span>
								{canOpen ? (
									<ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/vault:translate-x-0.5 group-hover/vault:-translate-y-0.5 motion-reduce:transition-none" />
								) : null}
							</>
						);

						return canOpen ? (
							<button
								key={`${match.relation}:${match.relPath}`}
								type="button"
								onClick={() => onOpenVaultPaper(match.relPath)}
								className={cn(
									"group/vault flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors motion-reduce:transition-none",
									isSelf
										? "bg-emerald-500/8 ring-1 ring-emerald-500/25 ring-inset hover:bg-emerald-500/14 dark:bg-emerald-500/12 dark:ring-emerald-400/30 dark:hover:bg-emerald-500/18"
										: "bg-brand/7 ring-1 ring-brand/22 ring-inset hover:bg-brand/12",
								)}
							>
								{content}
							</button>
						) : (
							<div
								key={`${match.relation}:${match.relPath}`}
								className={cn(
									"flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5",
									isSelf
										? "bg-emerald-500/8 ring-1 ring-emerald-500/25 ring-inset dark:bg-emerald-500/12 dark:ring-emerald-400/30"
										: "bg-brand/7 ring-1 ring-brand/22 ring-inset",
								)}
							>
								{content}
							</div>
						);
					})}
				</div>
			) : null}

			{/* Collapsible Lineage Box (shows 3 counts collapsed; lazy-loads list on expand) */}
			{hasAnyListItems ? (
				<div className="rounded-lg bg-[var(--magpie-surface)] shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)]">
					<div className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-2">
						<button
							type="button"
							data-lineage-toggle
							aria-expanded={expanded}
							onClick={() => handleToggleExpand()}
							className="inline-flex items-center gap-1.5 font-medium text-muted-foreground text-xs transition-colors hover:text-foreground"
						>
							{expanded ? (
								<ChevronDown className="size-3.5 shrink-0" />
							) : (
								<ChevronRight className="size-3.5 shrink-0" />
							)}
							<GitFork className="size-3 shrink-0" />
							<span>{t("plaza.collection.lineage.title")}</span>
						</button>

						<div className="flex flex-wrap items-center gap-1.5">
							{countTabs.map((tab) => {
								const isActive = expanded && activeTab === tab.id;
								return (
									<button
										key={tab.id}
										type="button"
										data-lineage-count-pill={tab.id}
										data-active={isActive}
										disabled={tab.count === 0}
										onClick={() => handleToggleExpand(tab.id)}
										className={cn(
											"inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[0.6875rem] leading-none transition-all disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none",
											isActive
												? "bg-brand/14 font-medium text-brand shadow-[0_1px_2px_rgba(0,0,0,0.16),inset_0_0.5px_0_rgba(255,255,255,0.14)] ring-1 ring-brand/25 ring-inset"
												: "bg-background/80 text-muted-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12),inset_0_0.5px_0_var(--magpie-edge)] ring-1 ring-border/60 ring-inset hover:bg-background hover:text-foreground hover:shadow-[0_1px_3px_rgba(0,0,0,0.18)] dark:bg-white/[0.06] dark:shadow-[0_1px_3px_rgba(0,0,0,0.35),inset_0_0.5px_0_rgba(255,255,255,0.08)] dark:ring-white/12 dark:hover:bg-white/[0.11] dark:hover:ring-white/20",
										)}
									>
										<span>{tab.label}</span>
										<span className="font-mono tabular-nums opacity-85">
											{tab.count}
										</span>
									</button>
								);
							})}
						</div>
					</div>

					{expanded ? (
						<div className="space-y-2 border-border/50 border-t p-2.5">
							<div className="relative flex w-full items-center">
								<Search className="pointer-events-none absolute left-2.5 size-3 text-muted-foreground" />
								<input
									type="text"
									value={titleQuery}
									onChange={(e) => setTitleQuery(e.target.value)}
									data-lineage-title-search
									placeholder={t(
										"plaza.collection.lineage.searchTitlePlaceholder",
									)}
									aria-label={t(
										"plaza.collection.lineage.searchTitlePlaceholder",
									)}
									className="h-7 w-full rounded-md border border-border/70 bg-background/70 pr-7 pl-7 text-foreground text-xs placeholder:text-muted-foreground/70 focus:border-brand/60 focus:outline-none focus:ring-1 focus:ring-brand/40"
								/>
								{titleQuery ? (
									<button
										type="button"
										onClick={() => setTitleQuery("")}
										aria-label={t("plaza.collection.clearSearch")}
										className="absolute right-2 inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
									>
										<X className="size-3" />
									</button>
								) : null}
							</div>

							{loadingItems || !itemsLoaded ? (
								<div className="space-y-1.5 py-1" data-lineage-rows-skeleton>
									{[0, 1, 2].map((idx) => (
										<div
											key={idx}
											className="flex items-start justify-between gap-2.5 rounded-md px-2 py-1.5"
										>
											<div className="min-w-0 flex-1 space-y-1.5">
												<Skeleton className="h-3.5 w-4/5" />
												<div className="flex items-center gap-1.5">
													<Skeleton className="h-4 w-14 rounded-full" />
													<Skeleton className="h-3.5 w-16" />
												</div>
											</div>
											<Skeleton className="h-4 w-9 shrink-0 rounded" />
										</div>
									))}
								</div>
							) : (
								<div className="agentero-scroll max-h-[15rem] space-y-1 overflow-y-auto pr-0.5">
									{activeTab === "cited" &&
										visibleCitedByInPool.map((item) => (
											<LineagePaperRow
												key={item.id}
												paper={item}
												orderedCategories={orderedCategories}
												inVault={isPaperInVaultLookup(item, vaultLookupKeys)}
												onSelect={() => onSelectPaper(item)}
											/>
										))}

									{activeTab === "references" &&
										visibleReferencesInPool.map((item) => (
											<LineagePaperRow
												key={item.id}
												paper={item}
												orderedCategories={orderedCategories}
												inVault={isPaperInVaultLookup(item, vaultLookupKeys)}
												onSelect={() => onSelectPaper(item)}
											/>
										))}

									{activeTab === "shared" &&
										visibleSharedRefPeers.map((peer) => (
											<LineagePaperRow
												key={peer.paper.id}
												paper={peer.paper}
												orderedCategories={orderedCategories}
												sharedCount={peer.sharedCount}
												inVault={isPaperInVaultLookup(
													peer.paper,
													vaultLookupKeys,
												)}
												onSelect={() => onSelectPaper(peer.paper)}
											/>
										))}

									{hasMoreRows ? (
										<div className="flex justify-center pt-1.5 pb-0.5">
											<button
												type="button"
												data-lineage-load-more
												onClick={() =>
													setVisibleLimit((prev) => prev + LINEAGE_VISIBLE_STEP)
												}
												className="inline-flex h-6 items-center gap-1 rounded-md border border-border/70 bg-background/70 px-2.5 text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
											>
												<ChevronDown className="size-3" />
												<span>
													{t("plaza.collection.loadMoreStep", {
														step: Math.min(
															LINEAGE_VISIBLE_STEP,
															activeFilteredCount - visibleLimit,
														),
														shown: visibleLimit,
														total: activeFilteredCount,
													})}
												</span>
											</button>
										</div>
									) : null}

									{normalizedTitleQuery && activeFilteredCount === 0 ? (
										<p className="py-4 text-center text-muted-foreground text-xs">
											{t("plaza.collection.emptyFiltered")}
										</p>
									) : null}
								</div>
							)}
						</div>
					) : null}
				</div>
			) : null}
		</section>
	);
}

function LineagePaperRow({
	paper,
	orderedCategories,
	sharedCount,
	inVault,
	onSelect,
}: {
	paper: CollectionPaperItem;
	orderedCategories: readonly string[];
	sharedCount?: number;
	inVault?: boolean;
	onSelect: () => void;
}) {
	const badgeLabel =
		paper.sourceType === "arxiv"
			? formatArxivCategoriesLabel(paper, orderedCategories)
			: paper.sourceLabel;
	return (
		<button
			type="button"
			onClick={onSelect}
			className="group flex w-full items-start justify-between gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/65 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/60 motion-reduce:transition-none"
		>
			<div className="min-w-0 flex-1 space-y-1">
				<p className="line-clamp-2 font-medium text-foreground text-xs leading-snug group-hover:text-brand">
					{paper.title}
				</p>
				<div className="flex flex-wrap items-center gap-1.5">
					<PlazaSourceBadge source={paper.sourceType} label={badgeLabel} />
					{paper.ccfRank ? (
						<span className="rounded bg-brand/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-brand leading-none">
							{paper.ccfRank}
						</span>
					) : null}
					<span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
						{paper.publishedAt.slice(0, 10)}
					</span>
					{inVault ? (
						<Library className="size-3 text-emerald-600 dark:text-emerald-300" />
					) : null}
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-1 pt-0.5">
				{typeof sharedCount === "number" && sharedCount > 0 ? (
					<span className="rounded bg-brand/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-brand tabular-nums leading-none">
						×{sharedCount}
					</span>
				) : null}
				<span className="inline-flex items-center gap-1 rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[0.6875rem] text-foreground tabular-nums leading-none">
					<GitFork className="size-2.5 text-muted-foreground" />
					{paper.citationCount ?? 0}
				</span>
			</div>
		</button>
	);
}
