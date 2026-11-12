/**
 * Native 广场 panel: Paper Discover (`agentero:plaza/discover`).
 *
 * Strictly scoped to the user's local `Paper Collection` SQLite pool (`collection.sqlite`):
 * - Landing Hub presents two distinct entry cards: `Fast Search` and `Deep Search`.
 * - `Fast Search`: Instant weighted boolean search across title + abstract + keywords
 *   with Advanced Search range filters (Time, Venue/arXiv, CCF-A/B, Fields).
 * - `Deep Search`: Multi-turn dialogue with an ACP Agent via the session-scoped
 *   `agentero-collection` MCP (50-paper random sampling, method taxonomy,
 *   citation/co-citation snowballing, and a live Candidate Tray).
 */

import {
	ChevronRight,
	Compass,
	Database,
	Loader2,
	RefreshCw,
	Search,
	Sparkles,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { CollectionPaperDetailDialog } from "@/components/plaza/collection-paper-detail-dialog";
import { DiscoverDeepView } from "@/components/plaza/discover-deep-view";
import { DiscoverFastView } from "@/components/plaza/discover-fast-view";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import { lookupSubmit } from "@/lib/paper/import-actions";
import { libraryStore } from "@/lib/paper/library-store";
import {
	type CollectionPaperItem,
	ensureCollectionSummaryHydrated,
	getCollectionSummarySnapshot,
	isPreloadingCollection,
	refreshAllCollection,
	subscribeCollectionSummary,
	subscribePreloadingCollection,
} from "@/lib/plaza/collection";
import { importPlazaPaper } from "@/lib/plaza/import";
import { bareArxivId, importedIdsInLibrary } from "@/lib/plaza/imported";

type DiscoverStage = "hub" | "fast" | "deep";

function checkPaperImported(
	paper: CollectionPaperItem,
	importedSet: ReadonlySet<string>,
): boolean {
	if (importedSet.has(paper.id)) return true;
	if (paper.coolPapersId && importedSet.has(paper.coolPapersId.toLowerCase())) {
		return true;
	}
	if (paper.arxivId) {
		const bare = bareArxivId(paper.arxivId);
		if (bare && importedSet.has(bare)) return true;
		if (importedSet.has(paper.arxivId)) return true;
	}
	if (paper.doi && importedSet.has(paper.doi.toLowerCase())) return true;
	return false;
}

export function PlazaDiscoverView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const summary = useSyncExternalStore(
		subscribeCollectionSummary,
		getCollectionSummarySnapshot,
	);
	const preloading = useSyncExternalStore(
		subscribePreloadingCollection,
		isPreloadingCollection,
	);

	const [stage, setStage] = useState<DiscoverStage>("hub");
	const [visitedFast, setVisitedFast] = useState(false);
	const [visitedDeep, setVisitedDeep] = useState(false);
	const [refreshing, setRefreshing] = useState(false);

	const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
	const [detailPaper, setDetailPaper] = useState<CollectionPaperItem | null>(
		null,
	);

	const observedArxivIdsRef = useRef<Set<string>>(new Set());
	const manualImportedIdsRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		void ensureCollectionSummaryHydrated().catch((err) => {
			notifyError(errorText(err));
		});
	}, []);

	const syncArxivQueries = useCallback(
		async (queries: string[], replaceFromManual = false) => {
			if (queries.length === 0) {
				if (replaceFromManual) {
					setImportedIds(new Set(manualImportedIdsRef.current));
				}
				return;
			}
			try {
				const matched = await importedIdsInLibrary(queries, {
					limit: Number.POSITIVE_INFINITY,
				});
				if (matched.length === 0 && !replaceFromManual) return;
				setImportedIds((prev) => {
					const next = replaceFromManual
						? new Set(manualImportedIdsRef.current)
						: new Set(prev);
					for (const raw of matched) {
						next.add(raw);
						const bare = bareArxivId(raw);
						if (bare) next.add(bare);
					}
					return next;
				});
			} catch {
				// Ignore when no Vault is open
			}
		},
		[],
	);

	const observePapers = useCallback(
		(papers: readonly CollectionPaperItem[]) => {
			const newArxivIds: string[] = [];
			for (const p of papers) {
				if (p.arxivId && !observedArxivIdsRef.current.has(p.arxivId)) {
					observedArxivIdsRef.current.add(p.arxivId);
					newArxivIds.push(p.arxivId);
				}
			}
			if (newArxivIds.length > 0) {
				void syncArxivQueries(newArxivIds, false);
			}
		},
		[syncArxivQueries],
	);

	useEffect(() => {
		return libraryStore.subscribe((state, prevState) => {
			if (state.papers !== prevState.papers) {
				void syncArxivQueries(Array.from(observedArxivIdsRef.current), true);
			}
		});
	}, [syncArxivQueries]);

	const handleRefreshPool = useCallback(async () => {
		if (refreshing || preloading) return;
		setRefreshing(true);
		try {
			await refreshAllCollection();
		} catch (err) {
			notifyError(errorText(err));
		} finally {
			setRefreshing(false);
		}
	}, [preloading, refreshing]);

	const importBatchPapers = useCallback(
		async (papers: CollectionPaperItem[]) => {
			if (papers.length === 0) return;
			const coolTargets = papers.filter((p) => !p.arxivId && p.coolPapersId);
			const lookupTargets = papers.filter((p) => p.arxivId || !p.coolPapersId);
			const identifiers = lookupTargets
				.map((p) =>
					p.arxivId
						? `arXiv:${p.arxivId}`
						: p.doi
							? `https://doi.org/${p.doi}`
							: p.url || p.title,
				)
				.filter(Boolean);
			if (coolTargets.length === 0 && identifiers.length === 0) return;

			const markImported = (done: CollectionPaperItem[]) => {
				if (done.length === 0) return;
				const recordKey = (key: string) => {
					manualImportedIdsRef.current.add(key);
				};
				setImportedIds((prev) => {
					const next = new Set(prev);
					for (const p of done) {
						next.add(p.id);
						recordKey(p.id);
						if (p.coolPapersId) {
							const lower = p.coolPapersId.toLowerCase();
							next.add(lower);
							recordKey(lower);
						}
						if (p.arxivId) {
							next.add(p.arxivId);
							recordKey(p.arxivId);
							const bare = bareArxivId(p.arxivId);
							if (bare) {
								next.add(bare);
								recordKey(bare);
							}
						}
						if (p.doi) {
							const lowerDoi = p.doi.toLowerCase();
							next.add(lowerDoi);
							recordKey(lowerDoi);
						}
					}
					return next;
				});
			};

			try {
				for (const p of coolTargets) {
					const ok = await importPlazaPaper({
						id: p.coolPapersId ?? p.id,
						branch: "venue",
						url: p.url,
						title: p.title,
					});
					if (ok) markImported([p]);
				}
				if (identifiers.length > 0) {
					await lookupSubmit(identifiers, {
						onComplete: () => markImported(lookupTargets),
					});
				}
			} catch (err) {
				notifyError(errorText(err));
			}
		},
		[],
	);

	const importSinglePaper = useCallback(
		async (paper: CollectionPaperItem) => {
			await importBatchPapers([paper]);
		},
		[importBatchPapers],
	);

	const handlePaperUpdated = useCallback((updated: CollectionPaperItem) => {
		setDetailPaper(updated);
	}, []);

	const enterFast = () => {
		setVisitedFast(true);
		setStage("fast");
	};

	const enterDeep = () => {
		setVisitedDeep(true);
		setStage("deep");
	};

	return (
		<div
			className={cn(
				"flex h-full min-h-0 flex-col overflow-hidden bg-background",
				className,
			)}
		>
			{/* Stage 1: Two-Entry Portal Hub */}
			{stage === "hub" ? (
				<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-6">
					<div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
						{/* Header + Live Paper Collection Pool Status */}
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div className="space-y-1">
								<div className="flex items-center gap-2">
									<Compass className="size-4 text-brand" />
									<h1 className="font-semibold text-base text-foreground">
										{t("plaza.discover.label")}
									</h1>
								</div>
								<p className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs tabular-nums">
									<Database className="size-3.5 shrink-0" />
									{t("plaza.discover.poolSummary", {
										total: summary.totalCount,
										arxiv: summary.arxivCount,
										venue: summary.venueCount,
									})}
								</p>
							</div>

							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="outline"
										size="icon-sm"
										disabled={refreshing || preloading}
										onClick={() => void handleRefreshPool()}
										aria-label={t("plaza.collection.refresh")}
									>
										<RefreshCw
											className={cn(
												"size-3.5",
												(refreshing || preloading) && "animate-spin",
											)}
										/>
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">
									{t("plaza.collection.refresh")}
								</TooltipContent>
							</Tooltip>
						</div>

						{preloading && summary.totalCount === 0 ? (
							<div className="magpie-card flex items-center gap-2 rounded-xl px-4 py-3 text-muted-foreground text-xs">
								<Loader2 className="size-3.5 shrink-0 animate-spin" />
								<span>{t("plaza.collection.preloading")}</span>
							</div>
						) : summary.hydrated && summary.totalCount === 0 ? (
							<div className="magpie-card rounded-xl px-4 py-3 text-muted-foreground text-xs leading-relaxed">
								{t("plaza.discover.poolEmptyHint")}
							</div>
						) : null}

						{/* Two Distinct Mode Entry Cards */}
						<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
							{/* Entry 1: Fast Search */}
							<button
								type="button"
								onClick={enterFast}
								className="magpie-card group flex flex-col justify-between gap-5 rounded-2xl p-5 text-left transition-all hover:border-brand/45 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/60 motion-reduce:transition-none"
							>
								<div className="space-y-3">
									<div className="flex items-center justify-between">
										<div className="flex size-10 items-center justify-center rounded-xl bg-brand/10 text-brand">
											<Search className="size-5" />
										</div>
										<ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-brand motion-reduce:transition-none" />
									</div>

									<div className="space-y-1.5">
										<h2 className="font-semibold text-base text-foreground">
											{t("plaza.discover.fastTitle")}
										</h2>
										<p className="text-muted-foreground text-xs leading-relaxed">
											{t("plaza.discover.fastSubtitle")}
										</p>
									</div>
								</div>

								<div className="flex flex-wrap gap-1.5 pt-1">
									<span className="rounded-md bg-muted/80 px-2 py-0.5 font-mono text-[0.6875rem] text-muted-foreground">
										{t("plaza.discover.fastTagBoolean")}
									</span>
									<span className="rounded-md bg-muted/80 px-2 py-0.5 font-mono text-[0.6875rem] text-muted-foreground">
										{t("plaza.discover.fastTagFilters")}
									</span>
								</div>
							</button>

							{/* Entry 2: Deep Search */}
							<button
								type="button"
								onClick={enterDeep}
								className="magpie-card group flex flex-col justify-between gap-5 rounded-2xl p-5 text-left transition-all hover:border-brand/45 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/60 motion-reduce:transition-none"
							>
								<div className="space-y-3">
									<div className="flex items-center justify-between">
										<div className="flex size-10 items-center justify-center rounded-xl bg-brand/12 text-brand">
											<Sparkles className="size-5" />
										</div>
										<ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-brand motion-reduce:transition-none" />
									</div>

									<div className="space-y-1.5">
										<h2 className="font-semibold text-base text-foreground">
											{t("plaza.discover.deepTitle")}
										</h2>
										<p className="text-muted-foreground text-xs leading-relaxed">
											{t("plaza.discover.deepSubtitle")}
										</p>
									</div>
								</div>

								<div className="flex flex-wrap gap-1.5 pt-1">
									<span className="rounded-md bg-brand/10 px-2 py-0.5 font-mono text-[0.6875rem] text-brand">
										{t("plaza.discover.deepTagSample")}
									</span>
									<span className="rounded-md bg-muted/80 px-2 py-0.5 font-mono text-[0.6875rem] text-muted-foreground">
										{t("plaza.discover.deepTagSnowball")}
									</span>
								</div>
							</button>
						</div>
					</div>
				</div>
			) : null}

			{/* Stage 2a: Fast Search View (kept mounted once visited to preserve query & filters) */}
			{visitedFast || stage === "fast" ? (
				<div
					className={cn(
						"min-h-0 flex-1 overflow-hidden",
						stage !== "fast" && "hidden",
					)}
				>
					<DiscoverFastView
						summary={summary}
						onObservePapers={observePapers}
						importedSet={importedIds}
						isPaperImported={checkPaperImported}
						onBackToHub={() => setStage("hub")}
						onOpenDetail={setDetailPaper}
						onImportPaper={importSinglePaper}
						onBatchImport={importBatchPapers}
					/>
				</div>
			) : null}

			{/* Stage 2b: Deep Search Multi-Turn Workbench (kept mounted once visited to preserve chat) */}
			{visitedDeep || stage === "deep" ? (
				<div
					className={cn(
						"min-h-0 flex-1 overflow-hidden",
						stage !== "deep" && "hidden",
					)}
				>
					<DiscoverDeepView
						summary={summary}
						onObservePapers={observePapers}
						importedSet={importedIds}
						isPaperImported={checkPaperImported}
						onBackToHub={() => setStage("hub")}
						onOpenDetail={setDetailPaper}
						onImportPaper={importSinglePaper}
						onBatchImport={importBatchPapers}
					/>
				</div>
			) : null}

			{/* Shared Full Metadata & BibTeX Dialog */}
			<CollectionPaperDetailDialog
				paper={detailPaper}
				open={detailPaper !== null}
				imported={
					detailPaper !== null && checkPaperImported(detailPaper, importedIds)
				}
				onOpenChange={(open) => {
					if (!open) setDetailPaper(null);
				}}
				onImport={importSinglePaper}
				onPaperUpdated={handlePaperUpdated}
			/>
		</div>
	);
}
