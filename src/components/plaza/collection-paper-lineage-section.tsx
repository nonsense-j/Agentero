import {
	ArrowUpRight,
	BookOpenCheck,
	GitFork,
	Library,
	List,
	Workflow,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { PlazaSourceBadge } from "@/components/icons/plaza-icons";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import type { CollectionPaperItem } from "@/lib/plaza/collection";
import type {
	CollectionPaperLineageResult,
	CollectionVaultPaperMatch,
} from "@/lib/plaza/collection-store";

export const MAX_LINEAGE_SIDE_NODES = 12;
export const MAX_LINEAGE_GRAPH_NODES = MAX_LINEAGE_SIDE_NODES * 2 + 1;

type LineageViewMode = "list" | "graph";
type LineageListTab = "cited" | "references" | "shared";

type DirectedEdgePath = {
	key: string;
	nodeId: string;
	d: string;
};

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

function buildBezierD(x1: number, y1: number, x2: number, y2: number): string {
	const span = Math.max(16, Math.abs(x2 - x1) * 0.48);
	const cx1 = x1 + span;
	const cx2 = x2 - span;
	return `M ${x1.toFixed(2)} ${y1.toFixed(2)} C ${cx1.toFixed(2)} ${y1.toFixed(2)}, ${cx2.toFixed(2)} ${y2.toFixed(2)}, ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export function CollectionPaperLineageSection({
	currentPaper,
	lineage,
	vaultPath,
	onSelectPaper,
	onOpenVaultPaper,
}: {
	currentPaper: CollectionPaperItem;
	lineage: CollectionPaperLineageResult | null;
	vaultPath: string | null;
	onSelectPaper: (paper: CollectionPaperItem) => void;
	onOpenVaultPaper: (relPath: string) => void;
}) {
	const { t } = useTranslation("sidebar");
	const [viewMode, setViewMode] = useState<LineageViewMode>("list");
	const [activeTab, setActiveTab] = useState<LineageListTab>("cited");

	const citedByInPool = lineage?.citedByInPool ?? [];
	const referencesInPool = lineage?.referencesInPool ?? [];
	const sharedRefPeers = lineage?.sharedRefPeers ?? [];
	const vaultMatches = lineage?.vaultMatches ?? [];

	const hasDirectEdges =
		citedByInPool.length > 0 || referencesInPool.length > 0;
	const hasAnyListItems = hasDirectEdges || sharedRefPeers.length > 0;
	const hasAnything = hasAnyListItems || vaultMatches.length > 0;

	useEffect(() => {
		const counts: Record<LineageListTab, number> = {
			cited: citedByInPool.length,
			references: referencesInPool.length,
			shared: sharedRefPeers.length,
		};
		if (counts[activeTab] > 0) return;
		if (counts.cited > 0) setActiveTab("cited");
		else if (counts.references > 0) setActiveTab("references");
		else if (counts.shared > 0) setActiveTab("shared");
	}, [
		activeTab,
		citedByInPool.length,
		referencesInPool.length,
		sharedRefPeers.length,
	]);

	const vaultLookupKeys = useMemo(
		() => buildVaultLookupKeys(vaultMatches),
		[vaultMatches],
	);

	if (!hasAnything) return null;

	const effectiveViewMode: LineageViewMode =
		viewMode === "graph" && hasDirectEdges ? "graph" : "list";

	return (
		<section
			data-lineage-section
			className="space-y-2.5"
			aria-label={t("plaza.collection.lineage.title")}
		>
			{/* Section Header + List/Graph Mode Switcher */}
			<div className="flex items-center justify-between gap-2">
				<h4 className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
					<GitFork className="size-3" />
					<span>{t("plaza.collection.lineage.title")}</span>
				</h4>

				{hasDirectEdges ? (
					<div className="magpie-seg">
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									data-active={effectiveViewMode === "list"}
									aria-label={t("plaza.collection.lineage.listView")}
									onClick={() => setViewMode("list")}
									className="magpie-seg-btn px-2 py-0.5"
								>
									<List className="size-3" />
								</button>
							</TooltipTrigger>
							<TooltipContent side="top">
								{t("plaza.collection.lineage.listView")}
							</TooltipContent>
						</Tooltip>

						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									data-active={effectiveViewMode === "graph"}
									aria-label={t("plaza.collection.lineage.graphView")}
									onClick={() => setViewMode("graph")}
									className="magpie-seg-btn px-2 py-0.5"
								>
									<Workflow className="size-3" />
								</button>
							</TooltipTrigger>
							<TooltipContent side="top">
								{t("plaza.collection.lineage.graphView")}
							</TooltipContent>
						</Tooltip>
					</div>
				) : null}
			</div>

			{/* Personal Vault Matches Highlight Bar */}
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

			{/* Main Lineage Body: List Mode vs 3-Column Directed SVG Graph Mode */}
			{!hasAnyListItems ? null : effectiveViewMode === "graph" ? (
				<ThreeColumnLineageGraph
					currentPaper={currentPaper}
					referencesInPool={referencesInPool}
					citedByInPool={citedByInPool}
					vaultLookupKeys={vaultLookupKeys}
					onSelectPaper={onSelectPaper}
					onOverflowClick={(tab) => {
						setActiveTab(tab);
						setViewMode("list");
					}}
				/>
			) : (
				<div className="space-y-2 rounded-lg bg-[var(--magpie-surface)] p-2.5 shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)]">
					<div className="flex flex-wrap items-center gap-1.5">
						<div className="magpie-seg">
							{(
								[
									{
										id: "cited" as const,
										label: t("plaza.collection.lineage.citedInPool"),
										count: citedByInPool.length,
									},
									{
										id: "references" as const,
										label: t("plaza.collection.lineage.referencesInPool"),
										count: referencesInPool.length,
									},
									{
										id: "shared" as const,
										label: t("plaza.collection.lineage.sharedRefs"),
										count: sharedRefPeers.length,
									},
								] as const
							).map((tab) => (
								<button
									key={tab.id}
									type="button"
									disabled={tab.count === 0}
									data-active={activeTab === tab.id}
									onClick={() => setActiveTab(tab.id)}
									className="magpie-seg-btn gap-1 disabled:pointer-events-none disabled:opacity-40"
								>
									<span>{tab.label}</span>
									<span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
										{tab.count}
									</span>
								</button>
							))}
						</div>
					</div>

					<div className="agentero-scroll max-h-[15rem] space-y-1 overflow-y-auto pr-0.5">
						{activeTab === "cited" &&
							citedByInPool.map((item) => (
								<LineagePaperRow
									key={item.id}
									paper={item}
									inVault={isPaperInVaultLookup(item, vaultLookupKeys)}
									onSelect={() => onSelectPaper(item)}
								/>
							))}

						{activeTab === "references" &&
							referencesInPool.map((item) => (
								<LineagePaperRow
									key={item.id}
									paper={item}
									inVault={isPaperInVaultLookup(item, vaultLookupKeys)}
									onSelect={() => onSelectPaper(item)}
								/>
							))}

						{activeTab === "shared" &&
							sharedRefPeers.map((peer) => (
								<LineagePaperRow
									key={peer.paper.id}
									paper={peer.paper}
									sharedCount={peer.sharedCount}
									inVault={isPaperInVaultLookup(peer.paper, vaultLookupKeys)}
									onSelect={() => onSelectPaper(peer.paper)}
								/>
							))}
					</div>
				</div>
			)}
		</section>
	);
}

function LineagePaperRow({
	paper,
	sharedCount,
	inVault,
	onSelect,
}: {
	paper: CollectionPaperItem;
	sharedCount?: number;
	inVault?: boolean;
	onSelect: () => void;
}) {
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
					<PlazaSourceBadge
						source={paper.sourceType}
						label={paper.sourceLabel}
					/>
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

function ThreeColumnLineageGraph({
	currentPaper,
	referencesInPool,
	citedByInPool,
	vaultLookupKeys,
	onSelectPaper,
	onOverflowClick,
}: {
	currentPaper: CollectionPaperItem;
	referencesInPool: readonly CollectionPaperItem[];
	citedByInPool: readonly CollectionPaperItem[];
	vaultLookupKeys: ReadonlySet<string>;
	onSelectPaper: (paper: CollectionPaperItem) => void;
	onOverflowClick: (tab: "cited" | "references") => void;
}) {
	const { t } = useTranslation("sidebar");
	const rawMarkerId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const defaultMarkerId = `lineage-arrow-${rawMarkerId}`;
	const activeMarkerId = `lineage-arrow-active-${rawMarkerId}`;

	const refsSlice = useMemo(
		() => referencesInPool.slice(0, MAX_LINEAGE_SIDE_NODES),
		[referencesInPool],
	);
	const citedSlice = useMemo(
		() =>
			citedByInPool.slice(
				0,
				Math.min(
					MAX_LINEAGE_SIDE_NODES,
					MAX_LINEAGE_GRAPH_NODES - 1 - refsSlice.length,
				),
			),
		[citedByInPool, refsSlice.length],
	);

	const refsOverflow = Math.max(0, referencesInPool.length - refsSlice.length);
	const citedOverflow = Math.max(0, citedByInPool.length - citedSlice.length);

	const containerRef = useRef<HTMLDivElement | null>(null);
	const leftColRef = useRef<HTMLDivElement | null>(null);
	const rightColRef = useRef<HTMLDivElement | null>(null);
	const centerCardRef = useRef<HTMLDivElement | null>(null);
	const refNodeRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
	const citedNodeRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

	const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
	const [edges, setEdges] = useState<DirectedEdgePath[]>([]);
	const [svgSize, setSvgSize] = useState<{ width: number; height: number }>({
		width: 0,
		height: 0,
	});

	const recomputeEdges = useCallback(() => {
		const container = containerRef.current;
		const center = centerCardRef.current;
		if (!container || !center) {
			setEdges([]);
			return;
		}

		const cRect = container.getBoundingClientRect();
		const mRect = center.getBoundingClientRect();
		if (cRect.width <= 0 || cRect.height <= 0) {
			setEdges([]);
			return;
		}

		setSvgSize((prev) =>
			Math.abs(prev.width - cRect.width) < 0.5 &&
			Math.abs(prev.height - cRect.height) < 0.5
				? prev
				: { width: cRect.width, height: cRect.height },
		);

		const centerLeftX = mRect.left - cRect.left;
		const centerRightX = mRect.right - cRect.left;
		const centerMidY = mRect.top + mRect.height / 2 - cRect.top;

		const nextEdges: DirectedEdgePath[] = [];

		for (const refPaper of refsSlice) {
			const el = refNodeRefs.current.get(refPaper.id);
			if (!el) continue;
			const rRect = el.getBoundingClientRect();
			const x1 = rRect.right - cRect.left;
			const y1 = rRect.top + rRect.height / 2 - cRect.top;
			nextEdges.push({
				key: `ref:${refPaper.id}`,
				nodeId: refPaper.id,
				d: buildBezierD(x1, y1, centerLeftX, centerMidY),
			});
		}

		for (const citedPaper of citedSlice) {
			const el = citedNodeRefs.current.get(citedPaper.id);
			if (!el) continue;
			const rRect = el.getBoundingClientRect();
			const x2 = rRect.left - cRect.left;
			const y2 = rRect.top + rRect.height / 2 - cRect.top;
			nextEdges.push({
				key: `cited:${citedPaper.id}`,
				nodeId: citedPaper.id,
				d: buildBezierD(centerRightX, centerMidY, x2, y2),
			});
		}

		setEdges(nextEdges);
	}, [citedSlice, refsSlice]);

	useLayoutEffect(() => {
		recomputeEdges();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			recomputeEdges();
		});
		if (containerRef.current) observer.observe(containerRef.current);
		if (leftColRef.current) observer.observe(leftColRef.current);
		if (centerCardRef.current) observer.observe(centerCardRef.current);
		if (rightColRef.current) observer.observe(rightColRef.current);
		return () => {
			observer.disconnect();
		};
	}, [recomputeEdges]);

	return (
		<div
			data-lineage-graph
			className="rounded-lg bg-[var(--magpie-surface)] p-3 shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)]"
		>
			{/* Column Headers */}
			<div className="mb-2 grid grid-cols-3 items-center gap-5 text-[0.6875rem] text-muted-foreground">
				<div className="flex items-center justify-between gap-1">
					<span className="truncate font-medium">
						{t("plaza.collection.lineage.referencesInPool")}
					</span>
					<span className="font-mono tabular-nums">
						{referencesInPool.length}
					</span>
				</div>
				<div className="text-center font-medium text-brand">
					{t("plaza.collection.lineage.current")}
				</div>
				<div className="flex items-center justify-between gap-1">
					<span className="truncate font-medium">
						{t("plaza.collection.lineage.citedInPool")}
					</span>
					<span className="font-mono tabular-nums">{citedByInPool.length}</span>
				</div>
			</div>

			{/* 3-Column Directed Graph Canvas */}
			<div
				ref={containerRef}
				className="relative grid min-h-[9.5rem] grid-cols-3 items-center gap-5 py-1"
			>
				<svg
					aria-hidden="true"
					viewBox={
						svgSize.width > 0 && svgSize.height > 0
							? `0 0 ${svgSize.width} ${svgSize.height}`
							: undefined
					}
					className="pointer-events-none absolute inset-0 z-0 h-full w-full overflow-visible"
				>
					<defs>
						<marker
							id={defaultMarkerId}
							viewBox="0 0 8 8"
							refX="7"
							refY="4"
							markerWidth="4.5"
							markerHeight="4.5"
							orient="auto"
							className="text-muted-foreground/55"
						>
							<path
								d="M 1 1.5 L 7 4 L 1 6.5"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</marker>
						<marker
							id={activeMarkerId}
							viewBox="0 0 8 8"
							refX="7"
							refY="4"
							markerWidth="5"
							markerHeight="5"
							orient="auto"
							className="text-brand"
						>
							<path
								d="M 1 1.5 L 7 4 L 1 6.5"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.6"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</marker>
					</defs>

					{edges.map((edge) => {
						const highlighted = hoveredNodeId === edge.nodeId;
						const dimmed = hoveredNodeId !== null && !highlighted;
						return (
							<path
								key={edge.key}
								d={edge.d}
								fill="none"
								stroke="currentColor"
								strokeWidth={highlighted ? 1.75 : 1.15}
								markerEnd={`url(#${highlighted ? activeMarkerId : defaultMarkerId})`}
								className={cn(
									"transition-[opacity,color] duration-150 motion-reduce:transition-none",
									highlighted
										? "text-brand opacity-95"
										: dimmed
											? "text-border opacity-35"
											: "text-muted-foreground/45 opacity-85",
								)}
							/>
						);
					})}
				</svg>

				{/* Left Column: References in Pool */}
				<div ref={leftColRef} className="relative z-10 flex flex-col gap-1.5">
					{refsSlice.length === 0 ? (
						<div className="rounded-md border border-dashed px-2 py-3 text-center font-mono text-[0.6875rem] text-muted-foreground/60">
							0
						</div>
					) : (
						refsSlice.map((item) => (
							<GraphNodeCard
								key={item.id}
								paper={item}
								inVault={isPaperInVaultLookup(item, vaultLookupKeys)}
								highlighted={hoveredNodeId === item.id}
								setNodeRef={(el) => {
									if (el) refNodeRefs.current.set(item.id, el);
									else refNodeRefs.current.delete(item.id);
								}}
								onHover={(active) => setHoveredNodeId(active ? item.id : null)}
								onSelect={() => onSelectPaper(item)}
							/>
						))
					)}
					{refsOverflow > 0 ? (
						<button
							type="button"
							onClick={() => onOverflowClick("references")}
							className="self-center rounded-full bg-muted/70 px-2 py-0.5 font-mono text-[0.625rem] text-muted-foreground hover:bg-muted hover:text-foreground"
						>
							+{refsOverflow}
						</button>
					) : null}
				</div>

				{/* Center Column: Current Paper */}
				<div className="relative z-10 flex flex-col justify-center">
					<div
						ref={centerCardRef}
						data-lineage-node="current"
						className="rounded-lg bg-brand/10 p-2.5 ring-1 ring-brand/45 ring-inset"
					>
						<p className="line-clamp-3 font-semibold text-foreground text-xs leading-snug">
							{currentPaper.title}
						</p>
						<div className="mt-1.5 flex flex-wrap items-center justify-between gap-1">
							<PlazaSourceBadge
								source={currentPaper.sourceType}
								label={currentPaper.sourceLabel}
							/>
							<span className="inline-flex items-center gap-0.5 font-mono text-[0.6875rem] text-brand tabular-nums">
								<GitFork className="size-2.5" />
								{currentPaper.citationCount ?? 0}
							</span>
						</div>
					</div>
				</div>

				{/* Right Column: Cited in Pool */}
				<div ref={rightColRef} className="relative z-10 flex flex-col gap-1.5">
					{citedSlice.length === 0 ? (
						<div className="rounded-md border border-dashed px-2 py-3 text-center font-mono text-[0.6875rem] text-muted-foreground/60">
							0
						</div>
					) : (
						citedSlice.map((item) => (
							<GraphNodeCard
								key={item.id}
								paper={item}
								inVault={isPaperInVaultLookup(item, vaultLookupKeys)}
								highlighted={hoveredNodeId === item.id}
								setNodeRef={(el) => {
									if (el) citedNodeRefs.current.set(item.id, el);
									else citedNodeRefs.current.delete(item.id);
								}}
								onHover={(active) => setHoveredNodeId(active ? item.id : null)}
								onSelect={() => onSelectPaper(item)}
							/>
						))
					)}
					{citedOverflow > 0 ? (
						<button
							type="button"
							onClick={() => onOverflowClick("cited")}
							className="self-center rounded-full bg-muted/70 px-2 py-0.5 font-mono text-[0.625rem] text-muted-foreground hover:bg-muted hover:text-foreground"
						>
							+{citedOverflow}
						</button>
					) : null}
				</div>
			</div>
		</div>
	);
}

function GraphNodeCard({
	paper,
	inVault,
	highlighted,
	setNodeRef,
	onHover,
	onSelect,
}: {
	paper: CollectionPaperItem;
	inVault?: boolean;
	highlighted: boolean;
	setNodeRef: (el: HTMLButtonElement | null) => void;
	onHover: (active: boolean) => void;
	onSelect: () => void;
}) {
	return (
		<button
			ref={setNodeRef}
			type="button"
			data-lineage-node={paper.id}
			onClick={onSelect}
			onMouseEnter={() => onHover(true)}
			onMouseLeave={() => onHover(false)}
			onFocus={() => onHover(true)}
			onBlur={() => onHover(false)}
			title={paper.title}
			className={cn(
				"flex w-full flex-col gap-1 rounded-md bg-background/85 p-1.5 text-left ring-1 ring-border/75 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-brand motion-reduce:transition-none dark:bg-white/[0.04]",
				highlighted && "bg-brand/6 ring-brand/50 dark:bg-brand/12",
			)}
		>
			<span className="line-clamp-2 font-medium text-[0.6875rem] text-foreground leading-tight">
				{paper.title}
			</span>
			<span className="flex items-center justify-between gap-1 text-[0.625rem] text-muted-foreground">
				<span className="inline-flex min-w-0 items-center gap-1 truncate font-mono">
					<span className="truncate">{paper.sourceLabel}</span>
					{inVault ? (
						<Library className="size-2.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
					) : null}
				</span>
				<span className="inline-flex shrink-0 items-center gap-0.5 font-mono tabular-nums">
					<GitFork className="size-2.5" />
					{paper.citationCount ?? 0}
				</span>
			</span>
		</button>
	);
}
