/**
 * Native 广场 panel: Paper Recommend (`agentero:plaza/arxiv-rec`).
 *
 * Two-stage SQLite-backed recommendation flow over `Paper Collection`:
 * 1. Keyword Hub (`stage === "select"`): top header with collection pool status
 *    and top-right `Recommend` action, `Recent Keywords` chips (freely
 *    toggleable down to 0 selected, removable, custom keyword input), and
 *    `All Keywords` with a stationary Top-N `Slider` above the interactive
 *    word cloud (default Top 50, adjustable 15–150, sliced locally in O(1)).
 * 2. Recommended Papers (`stage === "results"`): displays the selected keywords
 *    at top and pushes 15 unrecommended papers per batch. Recommended status is
 *    persisted as `recommended_at` in `collection.sqlite`.
 */

import {
	ArrowLeft,
	ArrowUpRight,
	BookOpen,
	Check,
	CheckSquare,
	Database,
	Download,
	Languages,
	Loader2,
	Minus,
	Plus,
	Quote,
	RefreshCw,
	RotateCcw,
	Sparkles,
	Square,
	Tag,
	X,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { PlazaSourceBadge } from "@/components/icons/plaza-icons";
import {
	COLLECTION_PRIMARY_BTN_CLASS,
	CollectionPaperDetailDialog,
} from "@/components/plaza/collection-paper-detail-dialog";
import { SelectionSurface } from "@/components/selection/selection-surface";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
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
import { libraryStore } from "@/lib/paper/library-store";
import {
	type CollectionPaperItem,
	ensureCollectionSummaryHydrated,
	getCollectionSummarySnapshot,
	isPreloadingCollection,
	subscribeCollectionSummary,
	subscribePreloadingCollection,
} from "@/lib/plaza/collection";
import { importPlazaPaper } from "@/lib/plaza/import";
import { bareArxivId, importedIdsInLibrary } from "@/lib/plaza/imported";
import {
	addCustomRecentKeyword,
	type CollectionWordCloudResult,
	createDefaultRecommendPoolState,
	DEFAULT_RECOMMEND_BATCH_SIZE,
	DEFAULT_WORD_CLOUD_TOP_N,
	fetchCollectionWordCloud,
	fetchRecommendPoolState,
	getActiveSelectedTerms,
	isKeywordSelected,
	MAX_WORD_CLOUD_TOP_N,
	MIN_WORD_CLOUD_TOP_N,
	type RecommendedPaperItem,
	type RecommendKeywordChip,
	type RecommendPoolState,
	recommendNextFromCollection,
	removeRecentKeyword,
	resetRecommendedHistory,
	saveRecommendPoolState,
	setWordCloudTopN,
	toggleRecentKeywordById,
	toggleRecommendTerm,
	type WordCloudKeyword,
} from "@/lib/plaza/recommend-pool";
import { runTranslate } from "@/lib/translate";
import { openRemoteArxivPaper } from "@/lib/workspace/actions";

type RecommendStage = "select" | "results";

const WORD_CLOUD_STEP = 5;
const SLIDER_PERSIST_DEBOUNCE_MS = 180;

const EMPTY_WORD_CLOUD: CollectionWordCloudResult = {
	keywords: [],
	totalUniqueKeywords: 0,
	totalCandidatePapers: 0,
	unrecommendedPaperCount: 0,
};

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

export function PlazaArxivRecView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const summary = useSyncExternalStore(
		subscribeCollectionSummary,
		getCollectionSummarySnapshot,
	);
	const preloading = useSyncExternalStore(
		subscribePreloadingCollection,
		isPreloadingCollection,
	);

	const [poolState, setPoolState] = useState<RecommendPoolState>(
		createDefaultRecommendPoolState,
	);
	const [fullWordCloud, setFullWordCloud] =
		useState<CollectionWordCloudResult>(EMPTY_WORD_CLOUD);
	const [wordCloudLoading, setWordCloudLoading] = useState(false);

	const [stage, setStage] = useState<RecommendStage>("select");
	const [recommendedItems, setRecommendedItems] = useState<
		RecommendedPaperItem[]
	>([]);
	const [recommendedKeywords, setRecommendedKeywords] = useState<string[]>([]);

	const [newKeyword, setNewKeyword] = useState("");
	const [addingKeyword, setAddingKeyword] = useState(false);
	const [busy, setBusy] = useState(false);
	const [resettingHistory, setResettingHistory] = useState(false);
	const [translations, setTranslations] = useState<Record<string, string>>({});
	const [translating, setTranslating] = useState(false);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
	const [batchImporting, setBatchImporting] = useState(false);
	const [detailPaper, setDetailPaper] = useState<CollectionPaperItem | null>(
		null,
	);

	const keywordInputRef = useRef<HTMLInputElement | null>(null);
	const resultsScrollRef = useRef<HTMLDivElement | null>(null);
	const latestPoolStateRef = useRef<RecommendPoolState>(poolState);
	const userMutatedPoolRef = useRef(false);
	const dirtyPoolStateRef = useRef(false);
	const saveTimerRef = useRef<number | null>(null);
	const inFlightSaveRef = useRef<Promise<void> | null>(null);
	const wordCloudReqSeqRef = useRef(0);

	const flushPoolSave = useCallback(async () => {
		if (saveTimerRef.current !== null) {
			window.clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		if (inFlightSaveRef.current) {
			await inFlightSaveRef.current;
		}
		while (dirtyPoolStateRef.current) {
			dirtyPoolStateRef.current = false;
			const snapshot = latestPoolStateRef.current;
			const task = saveRecommendPoolState(snapshot)
				.then(() => undefined)
				.catch((err) => {
					notifyError(errorText(err));
				});
			inFlightSaveRef.current = task;
			await task;
			inFlightSaveRef.current = null;
		}
	}, []);

	const schedulePoolSave = useCallback(
		(delayMs = 0) => {
			dirtyPoolStateRef.current = true;
			if (saveTimerRef.current !== null) {
				window.clearTimeout(saveTimerRef.current);
				saveTimerRef.current = null;
			}
			if (delayMs <= 0) {
				void flushPoolSave();
				return;
			}
			saveTimerRef.current = window.setTimeout(() => {
				saveTimerRef.current = null;
				void flushPoolSave();
			}, delayMs);
		},
		[flushPoolSave],
	);

	useEffect(() => {
		return () => {
			if (saveTimerRef.current !== null) {
				window.clearTimeout(saveTimerRef.current);
				saveTimerRef.current = null;
			}
			if (dirtyPoolStateRef.current) {
				dirtyPoolStateRef.current = false;
				void saveRecommendPoolState(latestPoolStateRef.current).catch(
					() => undefined,
				);
			}
		};
	}, []);

	// Hydrate summary + recommend pool state from SQLite on mount
	useEffect(() => {
		let cancelled = false;
		void ensureCollectionSummaryHydrated().catch((err) => {
			if (!cancelled) notifyError(errorText(err));
		});
		void fetchRecommendPoolState()
			.then((loaded) => {
				if (cancelled || userMutatedPoolRef.current) return;
				latestPoolStateRef.current = loaded;
				setPoolState(loaded);
			})
			.catch((err) => {
				if (!cancelled) notifyError(errorText(err));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Fetch Top-150 word cloud from SQLite when summary revision changes; slice Top-N locally in O(1)
	useEffect(() => {
		if (summary.revision < 0) return;
		if (!summary.hydrated && summary.totalCount === 0) return;
		if (summary.totalCount === 0) {
			setFullWordCloud(EMPTY_WORD_CLOUD);
			setWordCloudLoading(false);
			return;
		}

		const seq = ++wordCloudReqSeqRef.current;
		setWordCloudLoading(true);
		void fetchCollectionWordCloud(MAX_WORD_CLOUD_TOP_N)
			.then((cloud) => {
				if (seq !== wordCloudReqSeqRef.current) return;
				setFullWordCloud(cloud);
			})
			.catch((err) => {
				if (seq !== wordCloudReqSeqRef.current) return;
				notifyError(errorText(err));
			})
			.finally(() => {
				if (seq === wordCloudReqSeqRef.current) {
					setWordCloudLoading(false);
				}
			});
	}, [summary.hydrated, summary.revision, summary.totalCount]);

	// Sync imported status against Library store ONLY for currently recommended batch
	const syncLibraryImported = useCallback(
		async (items: readonly CollectionPaperItem[]) => {
			const arxivQueries = items
				.map((p) => p.arxivId)
				.filter((id): id is string => Boolean(id));
			if (arxivQueries.length === 0) return;
			try {
				const matched = await importedIdsInLibrary(arxivQueries, {
					limit: Number.POSITIVE_INFINITY,
				});
				if (matched.length === 0) return;
				setImportedIds((prev) => {
					const next = new Set(prev);
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

	useEffect(() => {
		void syncLibraryImported(recommendedItems);
		return libraryStore.subscribe((state, prevState) => {
			if (state.papers !== prevState.papers) {
				void syncLibraryImported(recommendedItems);
			}
		});
	}, [recommendedItems, syncLibraryImported]);

	useEffect(() => {
		if (addingKeyword) {
			keywordInputRef.current?.focus();
		}
	}, [addingKeyword]);

	const updatePoolState = useCallback(
		(
			updater: (prev: RecommendPoolState) => RecommendPoolState,
			debounceMs = 0,
		) => {
			userMutatedPoolRef.current = true;
			const next = updater(latestPoolStateRef.current);
			latestPoolStateRef.current = next;
			setPoolState(next);
			schedulePoolSave(debounceMs);
		},
		[schedulePoolSave],
	);

	const activeTerms = useMemo(
		() => getActiveSelectedTerms(poolState),
		[poolState],
	);

	const sliderMax = Math.max(
		MIN_WORD_CLOUD_TOP_N,
		Math.min(
			MAX_WORD_CLOUD_TOP_N,
			fullWordCloud.totalUniqueKeywords || MAX_WORD_CLOUD_TOP_N,
		),
	);

	const effectiveTopN = Math.max(
		MIN_WORD_CLOUD_TOP_N,
		Math.min(poolState.wordCloudTopN || DEFAULT_WORD_CLOUD_TOP_N, sliderMax),
	);

	const visibleCloudKeywords = useMemo(
		() => fullWordCloud.keywords.slice(0, effectiveTopN),
		[fullWordCloud.keywords, effectiveTopN],
	);

	const cloudBounds = useMemo(() => {
		if (visibleCloudKeywords.length === 0) return { min: 0, max: 0 };
		let min = Number.POSITIVE_INFINITY;
		let max = 0;
		for (const kw of visibleCloudKeywords) {
			if (kw.count < min) min = kw.count;
			if (kw.count > max) max = kw.count;
		}
		return { min: Number.isFinite(min) ? min : 0, max };
	}, [visibleCloudKeywords]);

	const hasRecommendedHistory =
		Boolean(poolState.lastRecommendedAt) ||
		fullWordCloud.unrecommendedPaperCount < fullWordCloud.totalCandidatePapers;

	const handleToggleRecentChip = useCallback(
		(id: string) => {
			updatePoolState((prev) => toggleRecentKeywordById(prev, id));
		},
		[updatePoolState],
	);

	const handleRemoveRecentChip = useCallback(
		(id: string) => {
			updatePoolState((prev) => removeRecentKeyword(prev, id));
		},
		[updatePoolState],
	);

	const handleAddKeyword = useCallback(() => {
		const term = newKeyword.trim();
		if (!term) {
			setAddingKeyword(false);
			return;
		}
		updatePoolState((prev) => addCustomRecentKeyword(prev, term));
		setNewKeyword("");
		setAddingKeyword(false);
	}, [newKeyword, updatePoolState]);

	const handleToggleCloudWord = useCallback(
		(term: string) => {
			updatePoolState((prev) => toggleRecommendTerm(prev, term));
		},
		[updatePoolState],
	);

	const handleClearSelection = useCallback(() => {
		updatePoolState((prev) => ({
			...prev,
			keywords: prev.keywords.map((k) =>
				k.enabled ? { ...k, enabled: false } : k,
			),
			selectedCloudTerms: [],
		}));
	}, [updatePoolState]);

	const handleStepTopN = useCallback(
		(delta: number) => {
			const target = Math.max(
				MIN_WORD_CLOUD_TOP_N,
				Math.min(sliderMax, effectiveTopN + delta),
			);
			updatePoolState((prev) => setWordCloudTopN(prev, target));
		},
		[effectiveTopN, sliderMax, updatePoolState],
	);

	const runRecommend = useCallback(async () => {
		if (busy || activeTerms.length === 0) return;
		setBusy(true);
		try {
			await flushPoolSave();
			const res = await recommendNextFromCollection(
				DEFAULT_RECOMMEND_BATCH_SIZE,
			);
			latestPoolStateRef.current = res.state;
			setPoolState(res.state);
			setRecommendedItems(res.items);
			setRecommendedKeywords(res.selectedKeywords);
			setSelectedIds(new Set());
			setStage("results");
			resultsScrollRef.current?.scrollTo({ top: 0 });
		} catch (err) {
			notifyError(errorText(err));
		} finally {
			setBusy(false);
		}
	}, [activeTerms.length, busy, flushPoolSave]);

	const handleResetHistory = useCallback(
		async (recommendAfterReset: boolean) => {
			if (resettingHistory || busy) return;
			setResettingHistory(true);
			try {
				await flushPoolSave();
				await resetRecommendedHistory();
				const clearedState: RecommendPoolState = {
					...latestPoolStateRef.current,
					lastRecommendedAt: null,
				};
				latestPoolStateRef.current = clearedState;
				setPoolState(clearedState);
				await saveRecommendPoolState(clearedState);
				if (recommendAfterReset && activeTerms.length > 0) {
					const res = await recommendNextFromCollection(
						DEFAULT_RECOMMEND_BATCH_SIZE,
					);
					latestPoolStateRef.current = res.state;
					setPoolState(res.state);
					setRecommendedItems(res.items);
					setRecommendedKeywords(res.selectedKeywords);
					setSelectedIds(new Set());
					setStage("results");
					resultsScrollRef.current?.scrollTo({ top: 0 });
				}
			} catch (err) {
				notifyError(errorText(err));
			} finally {
				setResettingHistory(false);
			}
		},
		[activeTerms.length, busy, flushPoolSave, resettingHistory],
	);

	const translateAll = useCallback(async () => {
		if (translating || recommendedItems.length === 0) return;
		setTranslating(true);
		const results = await Promise.allSettled(
			recommendedItems.map((item) =>
				runTranslate({
					text: item.abstract || item.title,
					context: { surface: "arxiv-rec", paperId: item.id },
				}),
			),
		);
		const next: Record<string, string> = { ...translations };
		let failed = 0;
		recommendedItems.forEach((item, i) => {
			const r = results[i];
			if (r && r.status === "fulfilled") {
				next[item.id] = r.value;
			} else {
				failed += 1;
			}
		});
		setTranslations(next);
		setTranslating(false);
		if (failed > 0) {
			notifyError(
				failed === recommendedItems.length
					? t("plaza.arxivRec.translateFailed")
					: t("plaza.arxivRec.translatePartialFailed", {
							failed,
							total: recommendedItems.length,
						}),
			);
		}
	}, [recommendedItems, t, translating, translations]);

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
			const selectable = recommendedItems.filter(
				(item) => !checkPaperImported(item, importedIds),
			);
			const targets = selectable.length > 0 ? selectable : recommendedItems;
			const allSelected =
				targets.length > 0 && targets.every((item) => prev.has(item.id));
			if (allSelected) return new Set();
			return new Set(targets.map((item) => item.id));
		});
	}, [importedIds, recommendedItems]);

	const importBatchPapers = useCallback(
		async (papers: CollectionPaperItem[]) => {
			const pending = papers.filter((p) => !checkPaperImported(p, importedIds));
			if (pending.length === 0 || batchImporting) return;

			const coolTargets = pending.filter((p) => !p.arxivId && p.coolPapersId);
			const lookupTargets = pending.filter((p) => p.arxivId || !p.coolPapersId);
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
				setImportedIds((prev) => {
					const next = new Set(prev);
					for (const p of done) {
						next.add(p.id);
						if (p.coolPapersId) next.add(p.coolPapersId.toLowerCase());
						if (p.arxivId) {
							next.add(p.arxivId);
							const bare = bareArxivId(p.arxivId);
							if (bare) next.add(bare);
						}
						if (p.doi) next.add(p.doi.toLowerCase());
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
						onComplete: () => {
							markImported(lookupTargets);
							setBatchImporting(false);
						},
					});
				} else {
					setBatchImporting(false);
				}
			} catch (err) {
				notifyError(errorText(err));
				setBatchImporting(false);
			}
		},
		[batchImporting, importedIds],
	);

	const importSinglePaper = useCallback(
		async (paper: CollectionPaperItem) => {
			await importBatchPapers([paper]);
		},
		[importBatchPapers],
	);

	const handlePaperUpdated = useCallback((updated: CollectionPaperItem) => {
		setDetailPaper(updated);
		setRecommendedItems((prev) =>
			prev.map((it) => (it.id === updated.id ? { ...it, ...updated } : it)),
		);
	}, []);

	const selectedItems = useMemo(
		() =>
			recommendedItems.filter(
				(item) =>
					selectedIds.has(item.id) && !checkPaperImported(item, importedIds),
			),
		[importedIds, recommendedItems, selectedIds],
	);

	const displayedHeaderKeywords =
		recommendedKeywords.length > 0 ? recommendedKeywords : activeTerms;

	return (
		<div
			className={cn(
				"magpie-canvas magpie-view-in relative flex h-full min-h-0 flex-col overflow-hidden",
				className,
			)}
		>
			{stage === "select" ? (
				<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-6">
					<div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
						{/* Header + Live Paper Collection Pool Status + Top-Right Recommend CTA */}
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div className="space-y-1">
								<div className="flex items-center gap-2">
									<Sparkles className="size-4 text-brand" />
									<h1 className="font-semibold text-base text-foreground">
										{t("plaza.arxivRec.label")}
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

							<div className="flex items-center gap-1.5">
								{hasRecommendedHistory ? (
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant="outline"
												size="icon-sm"
												disabled={resettingHistory || busy}
												onClick={() => void handleResetHistory(false)}
												aria-label={t("plaza.discover.resetFilters")}
											>
												{resettingHistory ? (
													<Loader2 className="size-3.5 animate-spin" />
												) : (
													<RotateCcw className="size-3.5" />
												)}
											</Button>
										</TooltipTrigger>
										<TooltipContent side="bottom">
											{t("plaza.discover.resetFilters")}
										</TooltipContent>
									</Tooltip>
								) : null}

								<Button
									type="button"
									size="sm"
									disabled={
										activeTerms.length === 0 || busy || resettingHistory
									}
									onClick={() => void runRecommend()}
									className={cn(
										"h-8 gap-1.5 px-3.5 font-medium text-xs transition-transform active:scale-[0.98] motion-reduce:transform-none",
										activeTerms.length > 0 && COLLECTION_PRIMARY_BTN_CLASS,
									)}
								>
									{busy ? (
										<Loader2 className="size-3.5 animate-spin" />
									) : (
										<Sparkles className="size-3.5" />
									)}
									<span>{t("plaza.arxivRec.recommend")}</span>
									{activeTerms.length > 0 ? (
										<span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-white/20 px-1 font-mono text-[0.6875rem] tabular-nums leading-none">
											{activeTerms.length}
										</span>
									) : null}
								</Button>
							</div>
						</div>

						{/* Top Section: Recent Keywords */}
						<section className="magpie-card flex flex-col gap-3 rounded-2xl p-4 sm:p-5">
							<div className="flex items-center justify-between gap-2">
								<div className="flex items-center gap-2">
									<Sparkles className="size-3.5 text-brand" />
									<h2 className="font-semibold text-foreground text-sm">
										{t("plaza.arxivRec.recentKeywords")}
									</h2>
									{activeTerms.length > 0 ? (
										<span className="rounded-full bg-brand/12 px-2 py-0.5 font-medium font-mono text-[0.6875rem] text-brand tabular-nums leading-none">
											{activeTerms.length}
										</span>
									) : null}
								</div>

								{activeTerms.length > 0 ? (
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon-xs"
												onClick={handleClearSelection}
												aria-label={t("plaza.arxivRec.clearSelection")}
												className="text-muted-foreground hover:text-foreground"
											>
												<RotateCcw className="size-3.5" />
											</Button>
										</TooltipTrigger>
										<TooltipContent side="bottom">
											{t("plaza.arxivRec.clearSelection")}
										</TooltipContent>
									</Tooltip>
								) : null}
							</div>

							<div className="flex flex-wrap items-center gap-1.5">
								{poolState.keywords.map((kw: RecommendKeywordChip) => {
									const active = isKeywordSelected(poolState, kw.term);
									return (
										<span
											key={kw.id}
											data-active={active}
											className="magpie-chip group h-6 gap-1 px-2.5 text-xs"
										>
											<button
												type="button"
												aria-pressed={active}
												onClick={() => handleToggleRecentChip(kw.id)}
												className="select-none active:scale-[0.97] motion-reduce:transform-none"
											>
												{kw.term}
											</button>
											<button
												type="button"
												disabled={busy}
												onClick={() => handleRemoveRecentChip(kw.id)}
												aria-label={t("plaza.arxivRec.removeCategory", {
													category: kw.term,
												})}
												className="-mr-1 inline-flex size-4 items-center justify-center rounded-full text-muted-foreground opacity-65 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 motion-reduce:transition-none"
											>
												<X className="size-2.5" />
											</button>
										</span>
									);
								})}

								{poolState.selectedCloudTerms.map((term: string) => (
									<span
										key={`cloud-${term.toLowerCase()}`}
										data-active="true"
										className="magpie-chip group h-6 gap-1 px-2.5 text-xs"
									>
										<button
											type="button"
											aria-pressed={true}
											onClick={() => handleToggleCloudWord(term)}
											className="select-none active:scale-[0.97] motion-reduce:transform-none"
										>
											{term}
										</button>
										<button
											type="button"
											disabled={busy}
											onClick={() => handleToggleCloudWord(term)}
											aria-label={t("plaza.arxivRec.removeCategory", {
												category: term,
											})}
											className="-mr-1 inline-flex size-4 items-center justify-center rounded-full text-muted-foreground opacity-65 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 motion-reduce:transition-none"
										>
											<X className="size-2.5" />
										</button>
									</span>
								))}

								{addingKeyword ? (
									<div className="inline-flex items-center gap-1">
										<input
											ref={keywordInputRef}
											type="text"
											value={newKeyword}
											onChange={(e) => setNewKeyword(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter") {
													e.preventDefault();
													handleAddKeyword();
												} else if (e.key === "Escape") {
													setAddingKeyword(false);
													setNewKeyword("");
												}
											}}
											placeholder={t("plaza.arxivRec.keywordPlaceholder")}
											className="h-6 w-36 rounded-full border bg-background px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand/60"
										/>
										<button
											type="button"
											onClick={handleAddKeyword}
											aria-label={t("plaza.arxivRec.addKeyword")}
											className="magpie-chip h-6 px-2"
										>
											<Check className="size-3" />
										</button>
									</div>
								) : (
									<button
										type="button"
										onClick={() => setAddingKeyword(true)}
										aria-label={t("plaza.arxivRec.addKeyword")}
										className="magpie-chip h-6 px-2.5 text-muted-foreground text-xs hover:text-foreground active:scale-[0.97] motion-reduce:transform-none"
									>
										<Plus className="size-3" />
										<span>{t("plaza.arxivRec.addKeyword")}</span>
									</button>
								)}
							</div>
						</section>

						{/* Bottom Section: All Keywords Slider (Top) + Word Cloud (Bottom) */}
						<section className="magpie-card flex flex-col gap-3.5 rounded-2xl p-4 sm:p-5">
							<div className="flex items-center gap-2">
								<Tag className="size-3.5 text-brand" />
								<h2 className="font-semibold text-foreground text-sm">
									{t("plaza.arxivRec.allKeywords")}
								</h2>
								{fullWordCloud.totalUniqueKeywords > 0 ? (
									<span className="font-mono text-muted-foreground text-xs tabular-nums">
										{visibleCloudKeywords.length} /{" "}
										{fullWordCloud.totalUniqueKeywords}
									</span>
								) : null}
								{wordCloudLoading ? (
									<Loader2 className="size-3.5 animate-spin text-muted-foreground" />
								) : null}
							</div>

							{(preloading || !summary.hydrated || wordCloudLoading) &&
							visibleCloudKeywords.length === 0 ? (
								<div className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-xs">
									<Loader2 className="size-4 animate-spin" />
									<span>
										{preloading
											? t("plaza.collection.preloading")
											: t("plaza.arxivRec.computing")}
									</span>
								</div>
							) : summary.totalCount === 0 ||
								visibleCloudKeywords.length === 0 ? (
								<div className="flex flex-col items-center justify-center py-8 text-center">
									<p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
										{t("plaza.discover.poolEmptyHint")}
									</p>
								</div>
							) : (
								<>
									{/* Word Cloud Top-N Slider (anchored above word cloud so dragging never shifts slider vertically) */}
									<div className="flex items-center gap-2.5 border-border/60 border-b pb-3">
										<Button
											type="button"
											variant="ghost"
											size="icon-xs"
											disabled={effectiveTopN <= MIN_WORD_CLOUD_TOP_N}
											onClick={() => handleStepTopN(-WORD_CLOUD_STEP)}
											aria-label={t("plaza.arxivRec.wordCloudSize")}
											className="text-muted-foreground hover:text-foreground"
										>
											<Minus className="size-3.5" />
										</Button>

										<Slider
											min={MIN_WORD_CLOUD_TOP_N}
											max={sliderMax}
											step={WORD_CLOUD_STEP}
											value={[effectiveTopN]}
											onValueChange={([v]) => {
												if (typeof v === "number") {
													updatePoolState(
														(prev) => setWordCloudTopN(prev, v),
														SLIDER_PERSIST_DEBOUNCE_MS,
													);
												}
											}}
											aria-label={t("plaza.arxivRec.wordCloudSize")}
											className="flex-1"
										/>

										<Button
											type="button"
											variant="ghost"
											size="icon-xs"
											disabled={effectiveTopN >= sliderMax}
											onClick={() => handleStepTopN(WORD_CLOUD_STEP)}
											aria-label={t("plaza.arxivRec.wordCloudSize")}
											className="text-muted-foreground hover:text-foreground"
										>
											<Plus className="size-3.5" />
										</Button>

										<span className="min-w-[3.75rem] text-right font-mono text-muted-foreground text-xs tabular-nums">
											{t("plaza.arxivRec.topKeywords", {
												count: effectiveTopN,
											})}
										</span>
									</div>

									{/* Interactive Word Cloud */}
									<div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-2 py-1.5">
										{visibleCloudKeywords.map((kw: WordCloudKeyword) => {
											const selected = isKeywordSelected(poolState, kw.term);
											const ratio =
												cloudBounds.max > cloudBounds.min
													? Math.sqrt(
															(kw.count - cloudBounds.min) /
																(cloudBounds.max - cloudBounds.min),
														)
													: 0.5;
											const fontSizeRem = (0.75 + ratio * 0.4375).toFixed(4);
											const fontWeight =
												ratio >= 0.7 ? 600 : ratio >= 0.35 ? 500 : 400;

											return (
												<button
													key={kw.normalized}
													type="button"
													aria-pressed={selected}
													onClick={() => handleToggleCloudWord(kw.term)}
													title={`${kw.term} (${kw.count})`}
													style={{
														fontSize: `${fontSizeRem}rem`,
														fontWeight,
														letterSpacing: ratio >= 0.65 ? "-0.015em" : "0em",
													}}
													className={cn(
														"inline-flex select-none items-baseline gap-1 rounded-full px-2.5 py-1 leading-tight transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 motion-reduce:transform-none motion-reduce:transition-none",
														selected
															? "bg-brand/14 text-brand shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_1px_color-mix(in_oklch,var(--brand)_58%,transparent),inset_0_0.5px_0_var(--magpie-edge)]"
															: ratio >= 0.6
																? "bg-[var(--magpie-surface)] text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.05),0_0_0_0.5px_var(--magpie-hairline),inset_0_0.5px_0_var(--magpie-edge)] hover:bg-[var(--magpie-surface-hover)]"
																: ratio >= 0.25
																	? "bg-[var(--magpie-surface)]/80 text-foreground/85 shadow-[0_0_0_0.5px_var(--magpie-hairline),inset_0_0.5px_0_var(--magpie-edge)] hover:bg-[var(--magpie-surface-hover)] hover:text-foreground"
																	: "bg-muted/45 text-muted-foreground hover:bg-[var(--magpie-surface)] hover:text-foreground",
													)}
												>
													<span>{kw.term}</span>
													<span
														className={cn(
															"font-mono text-[0.625rem] tabular-nums leading-none",
															selected
																? "text-brand/80"
																: "text-muted-foreground/70",
														)}
													>
														{kw.count}
													</span>
												</button>
											);
										})}
									</div>
								</>
							)}
						</section>
					</div>
				</div>
			) : (
				<>
					{/* Stage 2: Sticky Translucent Header with Selected Keywords */}
					<div
						data-plaza-header
						className="sticky top-0 z-10 flex shrink-0 flex-col gap-2 bg-background/80 px-3.5 py-2.5 shadow-[0_0.5px_0_0_var(--magpie-hairline)] backdrop-blur-xl backdrop-saturate-150"
					>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setStage("select")}
									className="h-7 shrink-0 gap-1.5 px-2 text-xs"
								>
									<ArrowLeft className="size-3.5" />
									<span>{t("plaza.arxivRec.backToKeywords")}</span>
								</Button>

								{displayedHeaderKeywords.map((term) => (
									<span
										key={term}
										data-active="true"
										className="magpie-chip select-none px-2.5 text-xs"
									>
										{term}
									</span>
								))}
							</div>

							<div className="flex shrink-0 items-center gap-1.5">
								{selectedItems.length > 0 ? (
									<Button
										type="button"
										size="sm"
										disabled={batchImporting}
										onClick={() => void importBatchPapers(selectedItems)}
										className="h-7 gap-1.5 rounded-md px-2.5 text-xs tabular-nums"
									>
										{batchImporting ? (
											<Loader2 className="size-3.5 animate-spin" />
										) : (
											<Download className="size-3.5" />
										)}
										{t("plaza.collection.importSelected", {
											count: selectedItems.length,
										})}
									</Button>
								) : null}

								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											disabled={recommendedItems.length === 0}
											onClick={toggleSelectAllVisible}
											aria-label={t("plaza.collection.toggleSelectAll")}
										>
											{selectedItems.length > 0 &&
											selectedItems.length ===
												recommendedItems.filter(
													(item) => !checkPaperImported(item, importedIds),
												).length ? (
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

								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											disabled={
												translating || busy || recommendedItems.length === 0
											}
											aria-label={
												translating
													? t("plaza.arxivRec.translating")
													: t("plaza.arxivRec.translate")
											}
											onClick={() => void translateAll()}
										>
											{translating ? (
												<Loader2 className="size-3.5 animate-spin" />
											) : (
												<Languages className="size-3.5" />
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent side="bottom">
										{translating
											? t("plaza.arxivRec.translating")
											: t("plaza.arxivRec.translate")}
									</TooltipContent>
								</Tooltip>

								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											size="sm"
											variant="outline"
											disabled={
												busy || resettingHistory || activeTerms.length === 0
											}
											onClick={() => void runRecommend()}
											className="h-7 gap-1.5 rounded-md px-2.5 text-xs"
										>
											{busy ? (
												<Loader2 className="size-3.5 animate-spin" />
											) : (
												<RefreshCw className="size-3.5" />
											)}
											{t("plaza.arxivRec.pushNext")}
										</Button>
									</TooltipTrigger>
									<TooltipContent side="bottom">
										{t("plaza.arxivRec.refresh")}
									</TooltipContent>
								</Tooltip>
							</div>
						</div>
					</div>

					{/* Stage 2 Body: 15 Recommended Papers */}
					<div
						ref={resultsScrollRef}
						className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-3.5"
					>
						{(busy || resettingHistory) && recommendedItems.length === 0 ? (
							<div className="flex items-center justify-center gap-2 py-14 text-muted-foreground text-xs">
								<Loader2 className="size-4 animate-spin" />
								<span>{t("plaza.arxivRec.computing")}</span>
							</div>
						) : recommendedItems.length === 0 ? (
							<div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
								<p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
									{t("plaza.arxivRec.noMoreUnpushed")}
								</p>
								<div className="flex items-center gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => setStage("select")}
										className="h-7 gap-1.5 text-xs"
									>
										<ArrowLeft className="size-3.5" />
										{t("plaza.arxivRec.backToKeywords")}
									</Button>
									<Button
										type="button"
										variant="secondary"
										size="sm"
										disabled={resettingHistory || busy}
										onClick={() => void handleResetHistory(true)}
										className="h-7 gap-1.5 text-xs"
									>
										<RotateCcw className="size-3.5" />
										{t("plaza.discover.resetFilters")}
									</Button>
								</div>
							</div>
						) : (
							<div className="grid gap-2.5">
								{recommendedItems.map((item) => (
									<RecommendPaperCard
										key={item.id}
										item={item}
										translation={translations[item.id]}
										selected={selectedIds.has(item.id)}
										imported={checkPaperImported(item, importedIds)}
										onToggleSelect={() => toggleSelect(item.id)}
										onOpenDetail={() => setDetailPaper(item)}
										onImport={() => importSinglePaper(item)}
									/>
								))}
							</div>
						)}
					</div>
				</>
			)}

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

function RecommendPaperCard({
	item,
	translation,
	selected,
	imported,
	onToggleSelect,
	onOpenDetail,
	onImport,
}: {
	item: RecommendedPaperItem;
	translation?: string;
	selected: boolean;
	imported: boolean;
	onToggleSelect: () => void;
	onOpenDetail: () => void;
	onImport: () => Promise<void>;
}) {
	const { t } = useTranslation("sidebar");
	const [busy, setBusy] = useState(false);
	const [expanded, setExpanded] = useState(false);

	const triggerImport = async () => {
		if (busy || imported) return;
		setBusy(true);
		try {
			await onImport();
		} finally {
			setBusy(false);
		}
	};

	const abstractText = translation ?? item.abstract;
	const dateLabel = item.publishedAt ? item.publishedAt.slice(0, 10) : "";

	return (
		<article
			className={cn(
				"magpie-card group relative flex items-start gap-3 p-3.5 transition-colors motion-reduce:transition-none",
				selected && "magpie-card-selected",
			)}
		>
			<div className="pt-0.5">
				<Checkbox
					checked={selected}
					onCheckedChange={() => onToggleSelect()}
					aria-label={item.title}
				/>
			</div>

			<div className="min-w-0 flex-1 space-y-1.5">
				<div className="flex flex-wrap items-center gap-1.5">
					<PlazaSourceBadge source={item.sourceType} label={item.sourceLabel} />
					{item.ccfRank ? (
						<span className="rounded-md bg-brand/12 px-1.5 py-0.5 font-medium font-mono text-[0.6875rem] text-brand leading-none">
							{item.ccfRank}
						</span>
					) : null}
					{item.matchedKeywords.map((kw: string) => (
						<span
							key={kw}
							className="inline-flex h-4 items-center rounded-full bg-brand/12 px-2 font-medium text-[0.625rem] text-foreground"
						>
							#{kw}
						</span>
					))}
					{dateLabel ? (
						<span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
							{dateLabel}
						</span>
					) : null}
					{typeof item.citationCount === "number" ? (
						<span className="inline-flex items-center gap-1 rounded-md bg-muted/65 px-1.5 py-0.5 font-medium text-[0.6875rem] text-foreground tabular-nums leading-none">
							<Quote className="size-2.5 text-muted-foreground" />
							{item.citationCount}
						</span>
					) : null}
				</div>

				<div className="space-y-1">
					<button
						type="button"
						onClick={onOpenDetail}
						className="w-full text-left font-medium text-foreground text-sm leading-snug transition-colors hover:text-brand focus:outline-none focus-visible:underline motion-reduce:transition-none"
						title={item.title}
					>
						{item.title}
					</button>

					{item.authors.length > 0 ? (
						<p className="line-clamp-1 select-text text-muted-foreground text-xs">
							{item.authors.slice(0, 6).join(", ")}
							{item.authors.length > 6 ? " et al." : ""}
						</p>
					) : null}
				</div>

				{abstractText ? (
					<div className="space-y-1">
						<SelectionSurface
							source={{
								sourcePath: item.url,
								sourceUrl: item.url,
								sourceTitle: item.title,
								origin: "markdown",
								surface: "abstract",
							}}
							className={cn(
								"select-text text-muted-foreground text-xs leading-relaxed",
								!expanded && "line-clamp-3",
							)}
						>
							{abstractText}
						</SelectionSurface>
						{abstractText.length > 240 ? (
							<button
								type="button"
								onClick={() => setExpanded((v) => !v)}
								className="font-medium text-[0.6875rem] text-brand/85 hover:text-brand focus:outline-none"
							>
								{expanded
									? t("plaza.discover.collapseAbstract")
									: t("plaza.discover.expandAbstract")}
							</button>
						) : null}
					</div>
				) : null}
			</div>

			<div className="flex shrink-0 items-center gap-0.5">
				{item.arxivId ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("plaza.arxivRec.read")}
								onClick={() =>
									openRemoteArxivPaper({
										arxivId: item.arxivId ?? "",
										title: item.title,
										abstract: item.abstract,
										url: item.url,
										score: item.score,
									})
								}
							>
								<BookOpen className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{t("plaza.arxivRec.read")}
						</TooltipContent>
					</Tooltip>
				) : null}

				{item.url ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("plaza.feeds.openOriginal")}
								onClick={() => openExternalUrl(item.url)}
							>
								<ArrowUpRight className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{t("plaza.feeds.openOriginal")}
						</TooltipContent>
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
						<TooltipContent side="bottom">
							{t("plaza.feeds.import")}
						</TooltipContent>
					</Tooltip>
				)}
			</div>
		</article>
	);
}
