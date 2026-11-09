/**
 * Native 广场 panel: Paper Discover.
 *
 * Dual-mode scholarly search powered by metadata searchers ported from
 * `dr-dumpling/PaperSearch` (DBLP, ACM, USENIX, OpenReview, IACR ePrint, arXiv,
 * Semantic Scholar, OpenAlex) with zero PDF downloads during search:
 * 1. Fast Search — concurrent multi-source metadata query.
 * 2. Agent Deep Search (Grill-Me style) — dynamic split-query chips + 1-by-1
 *    clarification questions with an instant "Start Search Now / No More
 *    Questions" action.
 */

import {
	ArrowUpRight,
	BookOpen,
	Check,
	CheckSquare,
	Compass,
	Download,
	Loader2,
	Play,
	Plus,
	Search,
	Sparkles,
	Square,
	X,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PlazaSourceBadge } from "@/components/icons/plaza-icons";
import { SelectionSurface } from "@/components/selection/selection-surface";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
	applyGrillOption,
	createDeepSearchSession,
	type DeepSearchSession,
	type DiscoverPaper,
	type DiscoverSourceId,
	executeMultiQueryDiscover,
	type GrillOption,
	searchPaperDiscover,
} from "@/lib/plaza/paper-search";
import { openRemoteArxivPaper } from "@/lib/workspace/actions";

type DiscoverMode = "fast" | "deep";

const ALL_SOURCES: readonly DiscoverSourceId[] = [
	"dblp",
	"acm",
	"usenix",
	"openreview",
	"iacr",
	"arxiv",
	"s2",
	"openalex",
];

export function PlazaDiscoverView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const [mode, setMode] = useState<DiscoverMode>("fast");
	const [query, setQuery] = useState("");
	const [enabledSources, setEnabledSources] = useState<DiscoverSourceId[]>([
		...ALL_SOURCES,
	]);
	const [sourceFilter, setSourceFilter] = useState<DiscoverSourceId | "all">(
		"all",
	);
	const [papers, setPapers] = useState<DiscoverPaper[]>([]);
	const [busy, setBusy] = useState(false);
	const [grillSession, setGrillSession] = useState<DeepSearchSession | null>(
		null,
	);
	const [newChipText, setNewChipText] = useState("");
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
	const [batchImporting, setBatchImporting] = useState(false);

	const toggleSource = (src: DiscoverSourceId) => {
		setEnabledSources((prev) => {
			if (prev.includes(src)) {
				if (prev.length <= 1) return prev;
				return prev.filter((s) => s !== src);
			}
			return [...prev, src];
		});
	};

	const executeSplitQueries = useCallback(
		async (queries: string[]) => {
			const activeQueries = queries.map((q) => q.trim()).filter(Boolean);
			if (activeQueries.length === 0) return;
			setBusy(true);
			try {
				const report = await executeMultiQueryDiscover(activeQueries, {
					sources: enabledSources,
					maxPerSource: 8,
				});
				setPapers(report.papers);
			} catch (err) {
				notifyError(errorText(err));
			} finally {
				setBusy(false);
			}
		},
		[enabledSources],
	);

	const handleSearchSubmit = useCallback(
		async (e?: React.FormEvent) => {
			e?.preventDefault();
			const q = query.trim();
			if (!q || busy) return;
			setBusy(true);
			setSelectedIds(new Set());
			try {
				if (mode === "deep") {
					const session = await createDeepSearchSession(q, {
						sources: enabledSources,
					});
					setGrillSession(session);
					setPapers(session.probePreviewPapers);
				} else {
					setGrillSession(null);
					const report = await searchPaperDiscover(q, {
						sources: enabledSources,
						maxPerSource: 10,
					});
					setPapers(report.papers);
				}
			} catch (err) {
				notifyError(errorText(err));
			} finally {
				setBusy(false);
			}
		},
		[busy, enabledSources, mode, query],
	);

	const handleAnswerGrill = useCallback(
		(option: GrillOption) => {
			if (!grillSession) return;
			const next = applyGrillOption(grillSession, option);
			setGrillSession(next);
			if (next.readyToExecute) {
				void executeSplitQueries(next.splitQueries);
			}
		},
		[executeSplitQueries, grillSession],
	);

	const handleStartDeepSearchNow = useCallback(() => {
		if (!grillSession) return;
		const readySession: DeepSearchSession = {
			...grillSession,
			readyToExecute: true,
		};
		setGrillSession(readySession);
		void executeSplitQueries(readySession.splitQueries);
	}, [executeSplitQueries, grillSession]);

	const removeSplitChip = (qText: string) => {
		if (!grillSession) return;
		if (grillSession.splitQueries.length <= 1) return;
		setGrillSession({
			...grillSession,
			splitQueries: grillSession.splitQueries.filter(
				(item: string) => item !== qText,
			),
		});
	};

	const addSplitChip = () => {
		const text = newChipText.trim();
		if (!text || !grillSession) return;
		if (grillSession.splitQueries.includes(text)) {
			setNewChipText("");
			return;
		}
		setGrillSession({
			...grillSession,
			splitQueries: [...grillSession.splitQueries, text],
		});
		setNewChipText("");
	};

	const visiblePapers = useMemo(() => {
		if (sourceFilter === "all") return papers;
		return papers.filter((p) => p.source === sourceFilter);
	}, [papers, sourceFilter]);

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
				visiblePapers.every((p: DiscoverPaper) => prev.has(p.id));
			if (allSelected) return new Set();
			return new Set(visiblePapers.map((p: DiscoverPaper) => p.id));
		});
	}, [visiblePapers]);

	const importPapers = useCallback(
		async (targets: DiscoverPaper[]) => {
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
		() => visiblePapers.filter((p: DiscoverPaper) => selectedIds.has(p.id)),
		[selectedIds, visiblePapers],
	);

	const currentQuestion =
		grillSession && !grillSession.readyToExecute
			? grillSession.steps[grillSession.stepIndex]
			: null;

	return (
		<div
			className={cn(
				"magpie-canvas magpie-view-in relative flex h-full min-h-0 flex-col",
				className,
			)}
		>
			{/* Top Sticky Control Header */}
			<div
				data-plaza-header
				className="sticky top-0 z-10 flex flex-col gap-2 bg-background/80 px-3 py-2.5 shadow-[0_0.5px_0_0_var(--magpie-hairline)] backdrop-blur-xl backdrop-saturate-150"
			>
				<form
					onSubmit={(e) => void handleSearchSubmit(e)}
					className="flex flex-wrap items-center gap-2"
				>
					{/* Mode Toggle: Fast Search vs Grill-Me Deep Search */}
					<div className="magpie-seg">
						<button
							type="button"
							data-active={mode === "fast"}
							onClick={() => setMode("fast")}
							className="magpie-seg-btn"
						>
							<Compass className="size-3" />
							{t("plaza.discover.modeFast")}
						</button>
						<button
							type="button"
							data-active={mode === "deep"}
							onClick={() => setMode("deep")}
							className="magpie-seg-btn"
						>
							<Sparkles className="size-3" />
							{t("plaza.discover.modeDeep")}
						</button>
					</div>

					{/* Search Input */}
					<div className="relative min-w-[200px] flex-1">
						<Search
							className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
							aria-hidden
						/>
						<input
							type="search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder={t("plaza.discover.searchPlaceholder")}
							className="h-7 w-full rounded-lg bg-[var(--magpie-surface)] pr-7 pl-8 text-xs shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)] placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-brand/60"
						/>
						{query ? (
							<button
								type="button"
								onClick={() => setQuery("")}
								className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
							>
								<X className="size-3" />
							</button>
						) : null}
					</div>

					<Button
						type="submit"
						size="sm"
						disabled={busy || !query.trim()}
						className="h-7 gap-1 rounded-lg px-3 text-xs"
					>
						{busy ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : mode === "deep" ? (
							<Sparkles className="size-3.5" />
						) : (
							<Search className="size-3.5" />
						)}
						{t("plaza.discover.searchBtn")}
					</Button>

					{/* Batch selection & import */}
					{selectedPapers.length > 0 ? (
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={batchImporting}
							onClick={() => void importPapers(selectedPapers)}
							className="h-7 gap-1 px-2.5 text-caption"
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
								disabled={visiblePapers.length === 0}
								onClick={toggleSelectAllVisible}
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
				</form>

				{/* Source Provider Chips (DBLP, ACM, USENIX, OpenReview, IACR, arXiv, S2, OpenAlex) */}
				<div className="flex items-center gap-1.5 overflow-x-auto py-0.5">
					<button
						type="button"
						data-active={sourceFilter === "all"}
						onClick={() => setSourceFilter("all")}
						className="magpie-chip shrink-0"
					>
						{t("plaza.collection.allTags")}
						{papers.length > 0 ? (
							<span className="text-muted-foreground tabular-nums">
								{papers.length}
							</span>
						) : null}
					</button>
					{ALL_SOURCES.map((src) => {
						const count = papers.filter((p) => p.source === src).length;
						const active =
							papers.length > 0
								? sourceFilter === src
								: enabledSources.includes(src);
						return (
							<button
								key={src}
								type="button"
								data-active={active}
								onClick={() => {
									if (papers.length > 0) {
										setSourceFilter((prev) => (prev === src ? "all" : src));
									} else {
										toggleSource(src);
									}
								}}
								className="magpie-chip shrink-0 font-mono uppercase"
							>
								<span>{src}</span>
								{papers.length > 0 ? (
									<span className="text-muted-foreground tabular-nums">
										{count}
									</span>
								) : null}
							</button>
						);
					})}
				</div>
			</div>

			{/* Scrollable Content */}
			<div className="agentero-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
				{/* Grill-Me Deep Search Interactive Clarification & Split Query Panel */}
				{grillSession ? (
					<div className="magpie-card space-y-3 p-3.5">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex items-center gap-1.5">
								<Sparkles className="size-3.5 text-brand" />
								<span className="font-medium text-xs">
									{t("plaza.discover.splitQueriesTitle")}
								</span>
							</div>
							<Button
								type="button"
								size="sm"
								disabled={busy}
								onClick={handleStartDeepSearchNow}
								className="h-6 gap-1 rounded-md px-2.5 text-caption"
							>
								<Play className="size-3" />
								{t("plaza.discover.startSearchNow")}
							</Button>
						</div>

						{grillSession.probeSummary ? (
							<p className="text-caption text-muted-foreground leading-relaxed">
								{grillSession.probeSummary}
							</p>
						) : null}

						{/* Dynamic Split Query Chips */}
						<div className="flex flex-wrap items-center gap-1.5">
							{grillSession.splitQueries.map((qText: string) => (
								<span
									key={qText}
									data-active="true"
									className="magpie-chip group gap-1"
								>
									<span className="max-w-[240px] truncate" title={qText}>
										{qText}
									</span>
									<button
										type="button"
										onClick={() => removeSplitChip(qText)}
										disabled={grillSession.splitQueries.length <= 1}
										className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
									>
										<X className="size-2.5" />
									</button>
								</span>
							))}
							<div className="inline-flex items-center gap-1">
								<input
									type="text"
									value={newChipText}
									onChange={(e) => setNewChipText(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											addSplitChip();
										}
									}}
									placeholder={t("plaza.discover.addSplitQuery")}
									className="h-6 w-32 rounded-full border bg-background px-2.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-brand/60"
								/>
								{newChipText.trim() ? (
									<button
										type="button"
										onClick={addSplitChip}
										className="magpie-chip px-1.5"
									>
										<Plus className="size-3" />
									</button>
								) : null}
							</div>
						</div>

						{/* 1-by-1 Clarification Question (Grill-Me) */}
						{currentQuestion ? (
							<div className="rounded-lg bg-muted/45 p-2.5 shadow-[inset_0_0_0_0.5px_var(--magpie-hairline)]">
								<div className="flex items-center justify-between gap-2">
									<p className="font-medium text-foreground text-xs">
										{currentQuestion.question}
									</p>
									<span className="font-mono text-[10px] text-muted-foreground tabular-nums">
										{grillSession.stepIndex + 1} / {grillSession.steps.length}
									</span>
								</div>
								<div className="mt-2 flex flex-wrap gap-1.5">
									{currentQuestion.options.map((opt: GrillOption) => (
										<button
											key={opt.id}
											type="button"
											onClick={() => handleAnswerGrill(opt)}
											className="magpie-button-pop rounded-md px-2.5 py-1 text-left font-medium text-foreground text-xs"
										>
											{opt.label}
										</button>
									))}
								</div>
							</div>
						) : null}
					</div>
				) : null}

				{/* Results Stream */}
				{busy && papers.length === 0 ? (
					<div className="flex items-center justify-center gap-2 py-14 text-muted-foreground text-xs">
						<Loader2 className="size-4 animate-spin" />
						<span>{t("plaza.discover.searching")}</span>
					</div>
				) : visiblePapers.length === 0 ? (
					<div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
						<p className="max-w-md text-muted-foreground text-xs leading-relaxed">
							{t("plaza.discover.emptyHint")}
						</p>
					</div>
				) : (
					<div className="grid gap-2.5">
						{visiblePapers.map((paper: DiscoverPaper) => (
							<DiscoverPaperCard
								key={paper.id}
								paper={paper}
								selected={selectedIds.has(paper.id)}
								imported={importedIds.has(paper.id)}
								onToggleSelect={() => toggleSelect(paper.id)}
								onImport={() => void importPapers([paper])}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function DiscoverPaperCard({
	paper,
	selected,
	imported,
	onToggleSelect,
	onImport,
}: {
	paper: DiscoverPaper;
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
						source={paper.source}
						label={paper.venue || paper.source.toUpperCase()}
					/>
					{paper.year ? (
						<span className="font-mono text-[11px] text-muted-foreground tabular-nums">
							{paper.year}
						</span>
					) : null}
					{paper.citationCount > 0 ? (
						<span className="font-mono text-[11px] text-muted-foreground tabular-nums">
							·{" "}
							{t("lookup.searchCitations", {
								count: paper.citationCount,
							})}
						</span>
					) : null}
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
										arxivId: paper.arxivId,
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
