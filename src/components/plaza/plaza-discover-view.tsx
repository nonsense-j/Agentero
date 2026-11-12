/**
 * Native 广场 panel: Paper Discover (`agentero:plaza/discover`).
 *
 * Strictly scoped to the user's local `Paper Collection` pool:
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
	Search,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CollectionPaperDetailDialog } from "@/components/plaza/collection-paper-detail-dialog";
import { DiscoverDeepView } from "@/components/plaza/discover-deep-view";
import { DiscoverFastView } from "@/components/plaza/discover-fast-view";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import { lookupSubmit } from "@/lib/paper/import-actions";
import { libraryStore } from "@/lib/paper/library-store";
import {
	type CollectionPaperItem,
	type CollectionState,
	hydrateCollectionStateFromIdb,
	loadCollectionState,
	saveCollectionState,
	subscribeCollectionState,
} from "@/lib/plaza/collection";
import { scheduleCollectionSnapshotSync } from "@/lib/plaza/collection-sync";
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
	const [collection, setCollection] =
		useState<CollectionState>(loadCollectionState);

	const [stage, setStage] = useState<DiscoverStage>("hub");
	const [visitedFast, setVisitedFast] = useState(false);
	const [visitedDeep, setVisitedDeep] = useState(false);

	const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
	const [detailPaper, setDetailPaper] = useState<CollectionPaperItem | null>(
		null,
	);

	// Hydrate Paper Collection from IndexedDB & keep Host snapshot synced
	useEffect(() => {
		const unsubState = subscribeCollectionState((next) => {
			setCollection(next);
			scheduleCollectionSnapshotSync(next);
		});
		void hydrateCollectionStateFromIdb().then((hydrated) => {
			setCollection(hydrated);
			scheduleCollectionSnapshotSync(hydrated);
		});
		return () => {
			unsubState();
		};
	}, []);

	// Sync imported status against Library store
	const syncLibraryImported = useCallback(
		async (items: CollectionPaperItem[]) => {
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
		void syncLibraryImported(collection.items);
		return libraryStore.subscribe((state, prevState) => {
			if (state.papers !== prevState.papers) {
				void syncLibraryImported(collection.items);
			}
		});
	}, [collection.items, syncLibraryImported]);

	const stats = useMemo(() => {
		let arxiv = 0;
		let venue = 0;
		for (const item of collection.items) {
			if (item.sourceType === "arxiv") arxiv += 1;
			else venue += 1;
		}
		return { total: collection.items.length, arxiv, venue };
	}, [collection.items]);

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
		setCollection((prev) => {
			const next: CollectionState = {
				...prev,
				items: prev.items.map((it) => (it.id === updated.id ? updated : it)),
			};
			saveCollectionState(next);
			scheduleCollectionSnapshotSync(next);
			return next;
		});
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
										total: stats.total,
										arxiv: stats.arxiv,
										venue: stats.venue,
									})}
								</p>
							</div>
						</div>

						{stats.total === 0 ? (
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
						collection={collection}
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
						collection={collection}
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
