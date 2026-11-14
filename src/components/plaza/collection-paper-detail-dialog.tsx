import {
	ArrowLeft,
	ArrowUpRight,
	BookOpen,
	Check,
	Copy,
	Download,
	GitFork,
	Loader2,
	Tag,
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
import { CollectionPaperLineageSection } from "@/components/plaza/collection-paper-lineage-section";
import { SelectionSurface } from "@/components/selection/selection-surface";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import {
	type CollectionPaperItem,
	ensurePaperFullDetails,
	formatPaperBibtex,
	formatPaperCitationText,
	getCollectionPaperDetail,
	shouldEnrichPaperOnDemand,
} from "@/lib/plaza/collection";
import {
	type CollectionPaperLineageResult,
	getCollectionPaperLineage,
} from "@/lib/plaza/collection-store";
import { joinVaultPath } from "@/lib/vault/path";
import { getVaultPath, vaultStore } from "@/lib/vault/store";
import { openRemoteArxivPaper } from "@/lib/workspace/actions";
import { openPaper } from "@/lib/workspace/navigation";

export const COLLECTION_PRIMARY_BTN_CLASS =
	"border-blue-600/30 bg-blue-600 text-white shadow-xs hover:bg-blue-500 hover:text-white active:bg-blue-700 dark:border-blue-400/50 dark:bg-blue-600 dark:text-white dark:shadow-[0_1px_3px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.22)] dark:hover:bg-blue-500 dark:active:bg-blue-700";

export const COLLECTION_OUTLINE_BTN_CLASS =
	"border-border bg-[var(--magpie-surface)] text-foreground shadow-2xs hover:bg-muted hover:text-foreground dark:border-white/20 dark:bg-white/[0.09] dark:text-zinc-100 dark:hover:bg-white/[0.16] dark:hover:text-white";

export function CollectionPaperDetailDialog({
	paper,
	open,
	imported,
	onOpenChange,
	onImport,
	onPaperUpdated,
}: {
	paper: CollectionPaperItem | null;
	open: boolean;
	imported: boolean;
	onOpenChange: (open: boolean) => void;
	onImport: (paper: CollectionPaperItem) => Promise<void> | void;
	onPaperUpdated?: (updated: CollectionPaperItem) => void;
}) {
	const { t } = useTranslation("sidebar");
	const vaultPath = useSyncExternalStore(vaultStore.subscribe, getVaultPath);
	const bodyScrollRef = useRef<HTMLDivElement | null>(null);

	const [history, setHistory] = useState<CollectionPaperItem[]>([]);
	const [navTarget, setNavTarget] = useState<CollectionPaperItem | null>(paper);
	const [resolvedPaper, setResolvedPaper] =
		useState<CollectionPaperItem | null>(paper);
	const [lineage, setLineage] = useState<CollectionPaperLineageResult | null>(
		null,
	);
	const [serverCitationText, setServerCitationText] = useState<string | null>(
		null,
	);
	const [enriching, setEnriching] = useState(false);
	const [importing, setImporting] = useState(false);
	const [locallyImportedIds, setLocallyImportedIds] = useState<Set<string>>(
		new Set(),
	);
	const [copiedKind, setCopiedKind] = useState<"citation" | "bibtex" | null>(
		null,
	);

	const prevExternalIdRef = useRef<string | null>(paper?.id ?? null);
	const prevOpenRef = useRef<boolean>(open);

	// Reset navigation stack when dialog closes or caller switches to a different root paper
	useEffect(() => {
		const externalId = paper?.id ?? null;
		const reopened = open && !prevOpenRef.current;
		const rootChanged = externalId !== prevExternalIdRef.current;
		prevOpenRef.current = open;
		prevExternalIdRef.current = externalId;

		if (!open) {
			setHistory([]);
			setNavTarget(paper);
			setLineage(null);
			return;
		}

		if (reopened || rootChanged) {
			setHistory([]);
			setNavTarget(paper);
		} else if (paper && navTarget && paper.id === navTarget.id) {
			setNavTarget(paper);
		}
	}, [open, paper, navTarget]);

	const targetPaper = navTarget ?? paper;

	useEffect(() => {
		setResolvedPaper(targetPaper);
		setServerCitationText(null);
		setCopiedKind(null);
		setLineage(null);
		if (!open || !targetPaper) {
			setEnriching(false);
			return;
		}

		let cancelled = false;
		const needsInitialEnrich = shouldEnrichPaperOnDemand(targetPaper);
		setEnriching(needsInitialEnrich);

		void (async () => {
			try {
				const [dbDetail, dbLineage] = await Promise.all([
					getCollectionPaperDetail(targetPaper.id).catch(() => null),
					getCollectionPaperLineage(targetPaper.id, vaultPath).catch(
						() => null,
					),
				]);
				if (cancelled) return;

				if (dbLineage) {
					setLineage(dbLineage);
				}

				let candidate: CollectionPaperItem = targetPaper;
				if (dbDetail) {
					const { citationText: cite, ...detailPaper } = dbDetail;
					candidate = detailPaper;
					setResolvedPaper(detailPaper);
					setServerCitationText(cite || null);
				}

				if (!shouldEnrichPaperOnDemand(candidate)) {
					return;
				}
				setEnriching(true);
				const updated = await ensurePaperFullDetails(candidate);
				if (cancelled) return;
				setResolvedPaper(updated);
				setServerCitationText(formatPaperCitationText(updated));
				if (updated.id === paper?.id) {
					onPaperUpdated?.(updated);
				}
				const refreshedLineage = await getCollectionPaperLineage(
					updated.id,
					vaultPath,
				).catch(() => null);
				if (!cancelled && refreshedLineage) {
					setLineage(refreshedLineage);
				}
			} catch {
				// Ignore transient network / offline failures; fall back to local formatting
			} finally {
				if (!cancelled) setEnriching(false);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [open, targetPaper, vaultPath, paper?.id, onPaperUpdated]);

	const active = resolvedPaper ?? targetPaper;
	const keywords = active?.keywords ?? [];

	const handleSelectLineagePaper = useCallback(
		(next: CollectionPaperItem) => {
			if (!active || next.id === active.id) return;
			setHistory((prev) => [...prev, active]);
			setNavTarget(next);
			bodyScrollRef.current?.scrollTo({ top: 0 });
		},
		[active],
	);

	const handleNavigateBack = useCallback(() => {
		setHistory((prev) => {
			if (prev.length === 0) return prev;
			const nextStack = prev.slice(0, -1);
			const previous = prev[prev.length - 1] ?? null;
			setNavTarget(previous);
			bodyScrollRef.current?.scrollTo({ top: 0 });
			return nextStack;
		});
	}, []);

	const handleOpenVaultPaper = useCallback(
		(relPath: string) => {
			if (!vaultPath || !relPath) return;
			openPaper(joinVaultPath(vaultPath, relPath));
			onOpenChange(false);
		},
		[onOpenChange, vaultPath],
	);

	const citationText = useMemo(
		() =>
			serverCitationText?.trim() ||
			(active ? formatPaperCitationText(active) : ""),
		[active, serverCitationText],
	);
	const bibtexText = useMemo(
		() => active?.bibtex?.trim() || (active ? formatPaperBibtex(active) : ""),
		[active],
	);

	if (!active) return null;

	const isSelfInVault = Boolean(
		lineage?.vaultMatches.some((m) => m.relation === "self"),
	);
	const isActiveImported =
		(active.id === paper?.id && imported) ||
		locallyImportedIds.has(active.id) ||
		isSelfInVault;
	const previousPaper = history.length > 0 ? history[history.length - 1] : null;

	const copyText = async (kind: "citation" | "bibtex") => {
		try {
			let text = kind === "citation" ? citationText : bibtexText;
			if (!active.bibtex) {
				const detail = await getCollectionPaperDetail(active.id).catch(
					() => null,
				);
				if (detail) {
					const { citationText: cite, ...detailPaper } = detail;
					setResolvedPaper(detailPaper);
					if (cite) setServerCitationText(cite);
					text =
						kind === "citation"
							? cite?.trim() || formatPaperCitationText(detailPaper)
							: detailPaper.bibtex?.trim() || formatPaperBibtex(detailPaper);
				}
			}
			await navigator.clipboard.writeText(text);
			setCopiedKind(kind);
			window.setTimeout(() => {
				setCopiedKind((prev) => (prev === kind ? null : prev));
			}, 1800);
		} catch {
			// Ignore clipboard failure
		}
	};

	const handleImportClick = async () => {
		if (importing || isActiveImported) return;
		setImporting(true);
		try {
			await onImport(active);
			setLocallyImportedIds((prev) => {
				const next = new Set(prev);
				next.add(active.id);
				return next;
			});
		} finally {
			setImporting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
				<DialogHeader className="shrink-0 border-b px-5 pt-5 pr-11 pb-3.5">
					<div className="flex flex-wrap items-center gap-1.5">
						{previousPaper ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-xs"
										onClick={handleNavigateBack}
										aria-label={t("plaza.collection.lineage.back", {
											title: previousPaper.title,
										})}
										className="-ml-1 mr-0.5 text-muted-foreground hover:text-foreground"
									>
										<ArrowLeft className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom" className="max-w-xs truncate">
									{t("plaza.collection.lineage.back", {
										title: previousPaper.title,
									})}
								</TooltipContent>
							</Tooltip>
						) : null}

						<PlazaSourceBadge
							source={active.sourceType}
							label={active.sourceLabel}
						/>
						{active.ccfRank ? (
							<span className="rounded-md bg-brand/12 px-1.5 py-0.5 font-medium font-mono text-[11px] text-brand">
								{active.ccfRank}
							</span>
						) : null}
						{active.venueDomain ? (
							<span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
								{active.venueDomain}
							</span>
						) : null}
						<span className="font-mono text-[11px] text-muted-foreground tabular-nums">
							{active.publishedAt.slice(0, 10)}
						</span>
						<span className="inline-flex items-center gap-1 rounded-md bg-muted/70 px-1.5 py-0.5 font-medium text-[11px] text-foreground tabular-nums">
							<GitFork className="size-2.5 text-muted-foreground" />
							{t("plaza.collection.citations", {
								count: active.citationCount ?? 0,
							})}
						</span>
						{active.arxivId ? (
							<span className="font-mono text-[11px] text-muted-foreground">
								arXiv:{active.arxivId}
							</span>
						) : active.doi ? (
							<span className="max-w-[200px] truncate font-mono text-[11px] text-muted-foreground">
								DOI:{active.doi}
							</span>
						) : null}
					</div>

					<DialogTitle className="mt-1.5 select-text font-semibold text-base leading-snug">
						{active.title}
					</DialogTitle>

					<DialogDescription className="select-text text-xs leading-relaxed">
						{active.authors.length > 0
							? active.authors.join(", ")
							: active.sourceLabel}
					</DialogDescription>
				</DialogHeader>

				<div
					ref={bodyScrollRef}
					className="agentero-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4"
				>
					{enriching ? (
						<div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-muted-foreground text-xs">
							<Loader2 className="size-3.5 animate-spin" />
							<span>{t("plaza.collection.fetchingDetail")}</span>
						</div>
					) : null}

					{/* Keywords */}
					{keywords.length > 0 ? (
						<section className="space-y-1.5">
							<h4 className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
								<Tag className="size-3" />
								{t("plaza.collection.keywords")}
							</h4>
							<div className="flex flex-wrap gap-1.5">
								{keywords.map((kw) => (
									<span
										key={kw}
										className="rounded-md bg-[var(--magpie-surface)] px-2 py-0.5 text-foreground text-xs shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)]"
									>
										{kw}
									</span>
								))}
							</div>
						</section>
					) : null}

					{/* Complete Abstract */}
					{active.abstract?.trim() ? (
						<section className="space-y-1.5">
							<h4 className="font-medium text-muted-foreground text-xs">
								{t("plaza.collection.abstract")}
							</h4>
							<SelectionSurface
								source={{
									sourcePath: active.url,
									sourceUrl: active.url,
									sourceTitle: active.title,
									origin: "markdown",
									surface: "abstract",
								}}
								className="select-text whitespace-pre-line rounded-lg bg-[var(--magpie-surface)] p-3.5 text-foreground text-sm leading-relaxed shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)]"
							>
								{active.abstract}
							</SelectionSurface>
						</section>
					) : null}

					{/* In-Pool Paper Graph Lineage & Personal Vault Association */}
					<CollectionPaperLineageSection
						currentPaper={active}
						lineage={lineage}
						vaultPath={vaultPath}
						onSelectPaper={handleSelectLineagePaper}
						onOpenVaultPaper={handleOpenVaultPaper}
					/>

					{/* Citation Info & BibTeX */}
					<section className="space-y-2">
						<div className="flex items-center justify-between gap-2">
							<h4 className="font-medium text-muted-foreground text-xs">
								{t("plaza.collection.citationInfo")}
							</h4>
							<div className="flex items-center gap-1.5">
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => void copyText("citation")}
									className={cn(
										"h-6 gap-1 px-2 text-caption",
										COLLECTION_OUTLINE_BTN_CLASS,
									)}
								>
									{copiedKind === "citation" ? (
										<Check className="size-3 text-brand" />
									) : (
										<Copy className="size-3" />
									)}
									{copiedKind === "citation"
										? t("plaza.collection.copied")
										: t("plaza.collection.copyCitation")}
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => void copyText("bibtex")}
									className={cn(
										"h-6 gap-1 px-2 text-caption",
										COLLECTION_OUTLINE_BTN_CLASS,
									)}
								>
									{copiedKind === "bibtex" ? (
										<Check className="size-3 text-brand" />
									) : (
										<Copy className="size-3" />
									)}
									{copiedKind === "bibtex"
										? t("plaza.collection.copied")
										: t("plaza.collection.copyBibtex")}
								</Button>
							</div>
						</div>

						<p className="select-text rounded-lg bg-muted/40 p-2.5 text-foreground text-xs leading-relaxed">
							{citationText}
						</p>

						<pre className="agentero-scroll max-h-36 select-text overflow-x-auto rounded-lg bg-muted/50 p-2.5 font-mono text-[11px] text-muted-foreground leading-relaxed">
							{bibtexText}
						</pre>
					</section>
				</div>

				<DialogFooter className="m-0 shrink-0 border-t bg-muted/30 px-5 py-3">
					<div className="flex w-full flex-wrap items-center justify-end gap-2">
						{active.arxivId ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => {
									openRemoteArxivPaper({
										arxivId: active.arxivId ?? "",
										title: active.title,
										abstract: active.abstract,
										url: active.url,
										score: 1,
									});
									onOpenChange(false);
								}}
								className={cn("gap-1.5", COLLECTION_OUTLINE_BTN_CLASS)}
							>
								<BookOpen className="size-3.5" />
								{t("plaza.arxivRec.read")}
							</Button>
						) : null}

						{active.url ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => openExternalUrl(active.url)}
								className={cn("gap-1.5", COLLECTION_OUTLINE_BTN_CLASS)}
							>
								<ArrowUpRight className="size-3.5" />
								{t("plaza.feeds.openOriginal")}
							</Button>
						) : null}

						<Button
							type="button"
							size="sm"
							disabled={importing || isActiveImported}
							onClick={() => void handleImportClick()}
							className={cn(
								"gap-1.5",
								isActiveImported
									? "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 disabled:opacity-100 dark:border-emerald-400/35 dark:bg-emerald-500/20 dark:text-emerald-200"
									: COLLECTION_PRIMARY_BTN_CLASS,
							)}
						>
							{isActiveImported ? (
								<>
									<Check className="size-3.5" />
									{t("plaza.feeds.imported")}
								</>
							) : importing ? (
								<>
									<Loader2 className="size-3.5 animate-spin" />
									{t("plaza.feeds.import")}
								</>
							) : (
								<>
									<Download className="size-3.5" />
									{t("plaza.feeds.import")}
								</>
							)}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
