/**
 * Native 广场 panel: Paper Recommend.
 *
 * Matches and pushes papers from the local 2026 Paper Collection pool using
 * user-configured keyword chips (`LLM Agent`, `Program Analysis`, `Fuzzing`,
 * `Vulnerability Detection`, `Code Generation`, `Formal Verification`, etc.).
 *
 * Strictly non-repeating: every pushed paper ID is recorded in `pushedIds` and
 * never pushed again. Supports toggling between `Recent` (latest push batch)
 * and `Full` (complete recommendation history), abstract translation, and
 * single/multi-select "Add to Library".
 */

import {
	ArrowUpRight,
	BookOpen,
	Check,
	CheckSquare,
	Download,
	History,
	Languages,
	Loader2,
	Plus,
	RefreshCw,
	Sparkles,
	Square,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { formatLocaleTimestamp } from "@/i18n";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { lookupSubmit } from "@/lib/paper/import-actions";
import {
	loadRecommendPoolState,
	type PushedRecommendPaper,
	pushFromCollection,
	type RecommendKeywordChip,
	type RecommendPoolState,
	saveRecommendPoolState,
} from "@/lib/plaza/recommend-pool";
import { runTranslate } from "@/lib/translate";
import { openRemoteArxivPaper } from "@/lib/workspace/actions";

type RecommendViewMode = "recent" | "full";

export function PlazaArxivRecView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const [poolState, setPoolState] = useState<RecommendPoolState>(
		loadRecommendPoolState,
	);
	const [viewMode, setViewMode] = useState<RecommendViewMode>("recent");
	const [newKeyword, setNewKeyword] = useState("");
	const [addingKeyword, setAddingKeyword] = useState(false);
	const [busy, setBusy] = useState(false);
	const [translations, setTranslations] = useState<Record<string, string>>({});
	const [translating, setTranslating] = useState(false);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
	const [batchImporting, setBatchImporting] = useState(false);
	const mountedRef = useRef(false);

	const runPush = useCallback(async () => {
		if (busy) return;
		setBusy(true);
		try {
			const res = await pushFromCollection({
				maxBatchSize: 16,
				ensureCollectionLoaded: true,
			});
			setPoolState(res.state);
		} catch (err) {
			notifyError(errorText(err));
		} finally {
			setBusy(false);
		}
	}, [busy]);

	// On first open, if there are no items yet, push an initial batch from Collection.
	useEffect(() => {
		if (mountedRef.current) return;
		mountedRef.current = true;
		if (poolState.history.length === 0) {
			void runPush();
		}
	}, [poolState.history.length, runPush]);

	const handleAddKeyword = useCallback(() => {
		const term = newKeyword.trim();
		if (!term) return;
		const exists = poolState.keywords.some(
			(k) => k.term.toLowerCase() === term.toLowerCase(),
		);
		const nextKeywords: RecommendKeywordChip[] = exists
			? poolState.keywords.map((k) =>
					k.term.toLowerCase() === term.toLowerCase()
						? { ...k, enabled: true }
						: k,
				)
			: [
					...poolState.keywords,
					{
						id: `kw-${Date.now()}`,
						term,
						enabled: true,
					},
				];
		const next: RecommendPoolState = {
			...poolState,
			keywords: nextKeywords,
		};
		saveRecommendPoolState(next);
		setPoolState(next);
		setNewKeyword("");
		setAddingKeyword(false);
		void runPush();
	}, [newKeyword, poolState, runPush]);

	const handleToggleKeyword = useCallback(
		(id: string) => {
			const nextKeywords = poolState.keywords.map((k) =>
				k.id === id ? { ...k, enabled: !k.enabled } : k,
			);
			if (!nextKeywords.some((k) => k.enabled)) return;
			const next: RecommendPoolState = {
				...poolState,
				keywords: nextKeywords,
			};
			saveRecommendPoolState(next);
			setPoolState(next);
		},
		[poolState],
	);

	const handleRemoveKeyword = useCallback(
		(id: string) => {
			const nextKeywords = poolState.keywords.filter((k) => k.id !== id);
			if (nextKeywords.length === 0) return;
			const next: RecommendPoolState = {
				...poolState,
				keywords: nextKeywords,
			};
			saveRecommendPoolState(next);
			setPoolState(next);
		},
		[poolState],
	);

	const recentItems = useMemo(() => {
		if (!poolState.recentBatchId) return poolState.history.slice(0, 16);
		return poolState.history.filter(
			(item: PushedRecommendPaper) => item.batchId === poolState.recentBatchId,
		);
	}, [poolState.history, poolState.recentBatchId]);

	const visibleItems = useMemo(
		() => (viewMode === "recent" ? recentItems : poolState.history),
		[poolState.history, recentItems, viewMode],
	);

	const translateAll = useCallback(async () => {
		if (translating || visibleItems.length === 0) return;
		setTranslating(true);
		const results = await Promise.allSettled(
			visibleItems.map((item: PushedRecommendPaper) =>
				runTranslate({
					text: item.abstract || item.title,
					context: { surface: "arxiv-rec", paperId: item.id },
				}),
			),
		);
		const next: Record<string, string> = { ...translations };
		let failed = 0;
		visibleItems.forEach((item: PushedRecommendPaper, i: number) => {
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
				failed === visibleItems.length
					? "Translation failed"
					: `Translation failed for ${failed} of ${visibleItems.length} papers`,
			);
		}
	}, [translating, translations, visibleItems]);

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
				visibleItems.length > 0 &&
				visibleItems.every((item: PushedRecommendPaper) => prev.has(item.id));
			if (allSelected) return new Set();
			return new Set(visibleItems.map((item: PushedRecommendPaper) => item.id));
		});
	}, [visibleItems]);

	const importPapers = useCallback(
		async (targets: PushedRecommendPaper[]) => {
			if (targets.length === 0 || batchImporting) return;
			const identifiers = targets
				.map((tItem) =>
					tItem.arxivId
						? `arXiv:${tItem.arxivId}`
						: tItem.doi
							? `https://doi.org/${tItem.doi}`
							: tItem.url || tItem.title,
				)
				.filter(Boolean);
			if (identifiers.length === 0) return;
			setBatchImporting(true);
			try {
				await lookupSubmit(identifiers, {
					onComplete: () => {
						setImportedIds((prev) => {
							const next = new Set(prev);
							for (const item of targets) next.add(item.id);
							return next;
						});
						setSelectedIds((prev) => {
							const next = new Set(prev);
							for (const item of targets) next.delete(item.id);
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

	const selectedItems = useMemo(
		() =>
			visibleItems.filter((item: PushedRecommendPaper) =>
				selectedIds.has(item.id),
			),
		[selectedIds, visibleItems],
	);

	return (
		<div
			className={cn(
				"magpie-canvas magpie-view-in relative flex h-full min-h-0 flex-col",
				className,
			)}
		>
			{/* Sticky Translucent Magpie Header */}
			<div
				data-plaza-header
				className="sticky top-0 z-10 flex flex-col gap-2 bg-background/80 px-3 py-2.5 shadow-[0_0.5px_0_0_var(--magpie-hairline)] backdrop-blur-xl backdrop-saturate-150"
			>
				<div className="flex flex-wrap items-center gap-2">
					{/* View Mode Segmented Control: Recent vs Full History */}
					<div className="magpie-seg">
						<button
							type="button"
							data-active={viewMode === "recent"}
							onClick={() => setViewMode("recent")}
							className="magpie-seg-btn"
						>
							<Sparkles className="size-3" />
							<span>{t("plaza.arxivRec.viewRecent")}</span>
							<span className="text-muted-foreground tabular-nums">
								{recentItems.length}
							</span>
						</button>
						<button
							type="button"
							data-active={viewMode === "full"}
							onClick={() => setViewMode("full")}
							className="magpie-seg-btn"
						>
							<History className="size-3" />
							<span>{t("plaza.arxivRec.viewFull")}</span>
							<span className="text-muted-foreground tabular-nums">
								{poolState.history.length}
							</span>
						</button>
					</div>

					{/* Right actions */}
					<div className="ml-auto flex items-center gap-1.5">
						{poolState.lastPushedAt ? (
							<span className="hidden text-caption text-muted-foreground sm:inline">
								{formatLocaleTimestamp(poolState.lastPushedAt)}
							</span>
						) : null}

						{selectedItems.length > 0 ? (
							<Button
								type="button"
								size="sm"
								disabled={batchImporting}
								onClick={() => void importPapers(selectedItems)}
								className="h-6 gap-1 rounded-md px-2.5 text-caption"
							>
								{batchImporting ? (
									<Loader2 className="size-3 animate-spin" />
								) : (
									<Download className="size-3" />
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
									disabled={visibleItems.length === 0}
									onClick={toggleSelectAllVisible}
									aria-label={t("plaza.collection.toggleSelectAll")}
								>
									{selectedItems.length > 0 &&
									selectedItems.length === visibleItems.length ? (
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

						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									disabled={translating || busy || visibleItems.length === 0}
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
							<TooltipContent>
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
									disabled={busy}
									onClick={() => void runPush()}
									className="h-6 gap-1 rounded-md px-2.5 text-caption"
								>
									{busy ? (
										<Loader2 className="size-3 animate-spin" />
									) : (
										<RefreshCw className="size-3" />
									)}
									{t("plaza.arxivRec.pushNext")}
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("plaza.arxivRec.refresh")}</TooltipContent>
						</Tooltip>
					</div>
				</div>

				{/* Dynamic Keyword Chips Row */}
				<div className="flex flex-wrap items-center gap-1.5">
					{poolState.keywords.map((kw: RecommendKeywordChip) => (
						<span
							key={kw.id}
							data-active={kw.enabled}
							className="magpie-chip group gap-1"
						>
							<button
								type="button"
								onClick={() => handleToggleKeyword(kw.id)}
								className="cursor-pointer"
							>
								{kw.term}
							</button>
							<button
								type="button"
								disabled={busy || poolState.keywords.length <= 1}
								onClick={() => handleRemoveKeyword(kw.id)}
								aria-label={t("plaza.arxivRec.removeCategory", {
									category: kw.term,
								})}
								className="rounded-full p-0.5 text-muted-foreground opacity-60 transition-opacity hover:text-foreground group-hover:opacity-100"
							>
								<X className="size-2.5" />
							</button>
						</span>
					))}

					{addingKeyword ? (
						<div className="inline-flex items-center gap-1">
							<input
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
								className="h-6 w-32 rounded-full border bg-background px-2.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-brand/60"
							/>
							<button
								type="button"
								onClick={handleAddKeyword}
								className="magpie-chip px-1.5"
							>
								<Check className="size-3" />
							</button>
						</div>
					) : (
						<button
							type="button"
							onClick={() => setAddingKeyword(true)}
							aria-label={t("plaza.arxivRec.addKeyword")}
							className="magpie-chip px-2 text-muted-foreground hover:text-foreground"
						>
							<Plus className="size-3" />
							<span>{t("plaza.arxivRec.addKeyword")}</span>
						</button>
					)}
				</div>
			</div>

			{/* Recommended Papers Stream */}
			<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-3">
				{busy && visibleItems.length === 0 ? (
					<div className="flex items-center justify-center gap-2 py-14 text-muted-foreground text-xs">
						<Loader2 className="size-4 animate-spin" />
						<span>{t("plaza.arxivRec.computing")}</span>
					</div>
				) : visibleItems.length === 0 ? (
					<div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
						<p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
							{t("plaza.arxivRec.noMoreUnpushed")}
						</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => void runPush()}
						>
							<RefreshCw className="size-3.5" />
							{t("plaza.arxivRec.pushNext")}
						</Button>
					</div>
				) : (
					<div className="grid gap-2.5">
						{visibleItems.map((item: PushedRecommendPaper) => (
							<RecommendPoolCard
								key={item.id}
								item={item}
								translation={translations[item.id]}
								selected={selectedIds.has(item.id)}
								imported={importedIds.has(item.id)}
								onToggleSelect={() => toggleSelect(item.id)}
								onImport={() => void importPapers([item])}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function RecommendPoolCard({
	item,
	translation,
	selected,
	imported,
	onToggleSelect,
	onImport,
}: {
	item: PushedRecommendPaper;
	translation?: string;
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
					aria-label={item.title}
				/>
			</div>

			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<PlazaSourceBadge source={item.sourceType} label={item.sourceLabel} />
					{item.matchedKeywords.map((kw: string) => (
						<span
							key={kw}
							className="inline-flex h-4 items-center rounded-full bg-brand/12 px-2 font-medium text-[10px] text-foreground"
						>
							#{kw}
						</span>
					))}
					<span className="font-mono text-[11px] text-muted-foreground tabular-nums">
						{item.publishedAt.slice(0, 10)}
					</span>
				</div>

				<h3
					className="mt-1 line-clamp-2 font-medium text-foreground text-sm leading-snug"
					title={item.title}
				>
					{item.title}
				</h3>

				{translation || item.abstract ? (
					<SelectionSurface
						source={{
							sourcePath: item.url,
							sourceUrl: item.url,
							sourceTitle: item.title,
							origin: "markdown",
							surface: "abstract",
						}}
						className="mt-1.5 line-clamp-3 select-text text-muted-foreground text-xs leading-relaxed"
					>
						{translation ?? item.abstract}
					</SelectionSurface>
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
						<TooltipContent>{t("plaza.arxivRec.read")}</TooltipContent>
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
