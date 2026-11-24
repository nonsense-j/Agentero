import {
	GitBranchPlus,
	Library,
	Loader2,
	Maximize2,
	Minus,
	Plus,
	RotateCcw,
	ZoomIn,
	ZoomOut,
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
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import {
	type CollectionPaperItem,
	type CollectionSubgraphResult,
	getCollectionPaperLineage,
	getCollectionSubgraph,
} from "@/lib/plaza/collection";
import {
	clipSegmentToCapsuleEdge,
	computePaperGraphLayout,
	formatPaperGraphLabel,
	type PaperGraphBounds,
	type PaperGraphPosition,
} from "@/lib/plaza/paper-graph";
import { sameCollectionPaperWork } from "@/lib/plaza/paper-identity";

const MAX_EXPAND_NEIGHBORS_PER_NODE = 16;
const EXPAND_ALL_CONCURRENCY = 6;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.4;
const DRAG_CLICK_THRESHOLD_PX = 5;

async function fetchExpandNeighbors(
	paperId: string,
): Promise<CollectionPaperItem[]> {
	const lineage = await getCollectionPaperLineage(paperId, null);
	const combined: CollectionPaperItem[] = [];
	for (const item of [...lineage.citedByInPool, ...lineage.referencesInPool]) {
		if (item.id === paperId) continue;
		if (combined.some((c) => sameCollectionPaperWork(c, item))) continue;
		combined.push(item);
	}
	combined.sort(
		(a, b) =>
			(b.citationCount ?? 0) - (a.citationCount ?? 0) ||
			b.publishedAt.localeCompare(a.publishedAt),
	);
	return combined.slice(0, MAX_EXPAND_NEIGHBORS_PER_NODE);
}

type ResolvedGraphNode = {
	paper: CollectionPaperItem;
	label: string;
	inLibrary: boolean;
	isSeed: boolean;
	expandAnchorId?: string;
};

type CameraTransform = {
	tx: number;
	ty: number;
	scale: number;
};

function computeFitTransform(
	bounds: PaperGraphBounds,
	viewport: { width: number; height: number },
): CameraTransform {
	const vw = Math.max(320, viewport.width);
	const vh = Math.max(240, viewport.height);
	const usableW = Math.max(200, vw - 48);
	const usableH = Math.max(160, vh - 72);
	const rawScale = Math.min(usableW / bounds.width, usableH / bounds.height);
	const scale = Math.max(0.35, Math.min(1.12, rawScale));
	const cx = (bounds.minX + bounds.maxX) / 2;
	const cy = (bounds.minY + bounds.maxY) / 2;
	return {
		tx: vw / 2 - cx * scale,
		ty: vh / 2 - cy * scale,
		scale,
	};
}

export function DiscoverGraphView({
	seedPapers,
	resetKey,
	summaryRevision,
	totalMatched,
	loadingMore,
	onLoadMore,
	onObservePapers,
	importedSet,
	isPaperImported,
	onOpenDetail,
}: {
	seedPapers: readonly CollectionPaperItem[];
	resetKey: string;
	summaryRevision: number;
	totalMatched: number;
	loadingMore: boolean;
	onLoadMore: () => void;
	onObservePapers?: (papers: readonly CollectionPaperItem[]) => void;
	importedSet: ReadonlySet<string>;
	isPaperImported: (
		paper: CollectionPaperItem,
		set: ReadonlySet<string>,
	) => boolean;
	onOpenDetail: (paper: CollectionPaperItem) => void;
}) {
	const { t } = useTranslation("sidebar");
	const rawMarkerId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const citeMarkerId = `discover-cite-arrow-${rawMarkerId}`;
	const citeActiveMarkerId = `discover-cite-arrow-active-${rawMarkerId}`;

	const containerRef = useRef<HTMLDivElement | null>(null);
	const [viewport, setViewport] = useState<{ width: number; height: number }>({
		width: 840,
		height: 540,
	});
	const [containerHidden, setContainerHidden] = useState(false);

	const [expandedBySeed, setExpandedBySeed] = useState<
		Map<string, CollectionPaperItem[]>
	>(() => new Map());
	const [expandingIds, setExpandingIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [expandingAll, setExpandingAll] = useState(false);
	const [subgraph, setSubgraph] = useState<CollectionSubgraphResult>({
		citationEdges: [],
		sharedRefEdges: [],
		unexpandedCounts: {},
	});
	const [loadingSubgraph, setLoadingSubgraph] = useState(false);
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [manualOffsets, setManualOffsets] = useState<
		Map<string, { x: number; y: number }>
	>(() => new Map());
	const [camera, setCamera] = useState<CameraTransform>({
		tx: 420,
		ty: 270,
		scale: 1,
	});

	const prevLayoutPositionsRef = useRef<Map<string, { x: number; y: number }>>(
		new Map(),
	);
	const needsAutoFitRef = useRef(true);
	const pendingFitAfterSubgraphRef = useRef(true);
	const graphEpochRef = useRef(0);
	const prevResetKeyRef = useRef(resetKey);
	const subgraphReqSeqRef = useRef(0);
	const onObservePapersRef = useRef(onObservePapers);
	onObservePapersRef.current = onObservePapers;

	useEffect(() => {
		return () => {
			graphEpochRef.current += 1;
		};
	}, []);

	// Reset expanded neighborhood & manual drags when search query or filters change
	useEffect(() => {
		if (prevResetKeyRef.current === resetKey) return;
		prevResetKeyRef.current = resetKey;
		graphEpochRef.current += 1;
		pendingFitAfterSubgraphRef.current = true;
		setExpandedBySeed(new Map());
		setExpandingIds(new Set());
		setExpandingAll(false);
		setManualOffsets(new Map());
		setHoveredId(null);
		prevLayoutPositionsRef.current = new Map();
		needsAutoFitRef.current = true;
	}, [resetKey]);

	useLayoutEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const updateSize = () => {
			const rect = el.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				setContainerHidden(false);
				setViewport((prev) =>
					Math.abs(prev.width - rect.width) < 1 &&
					Math.abs(prev.height - rect.height) < 1
						? prev
						: { width: rect.width, height: rect.height },
				);
			} else {
				setContainerHidden(true);
				setHoveredId(null);
			}
		};
		updateSize();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(updateSize);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// Merge search seed papers + user-expanded citation/reference papers (deduped by work)
	const resolvedNodes = useMemo<ResolvedGraphNode[]>(() => {
		const out: ResolvedGraphNode[] = [];
		const seenIds = new Set<string>();

		for (const paper of seedPapers) {
			if (seenIds.has(paper.id)) continue;
			seenIds.add(paper.id);
			out.push({
				paper,
				label: formatPaperGraphLabel(paper),
				inLibrary: isPaperImported(paper, importedSet),
				isSeed: true,
			});
		}

		for (const [anchorId, neighbors] of expandedBySeed.entries()) {
			for (const neighbor of neighbors) {
				if (seenIds.has(neighbor.id)) continue;
				if (
					out.some((existing) =>
						sameCollectionPaperWork(existing.paper, neighbor),
					)
				) {
					continue;
				}
				seenIds.add(neighbor.id);
				out.push({
					paper: neighbor,
					label: formatPaperGraphLabel(neighbor),
					inLibrary: isPaperImported(neighbor, importedSet),
					isSeed: false,
					expandAnchorId: anchorId,
				});
			}
		}

		return out;
	}, [seedPapers, expandedBySeed, importedSet, isPaperImported]);

	const nodeIdsKey = useMemo(
		() => resolvedNodes.map((n) => n.paper.id).join("\u0000"),
		[resolvedNodes],
	);

	// Fetch direct citation edges, shared-ref dashed edges, and unexpanded neighbor counts
	useEffect(() => {
		if (summaryRevision < 0) return;
		if (!nodeIdsKey) {
			setSubgraph({
				citationEdges: [],
				sharedRefEdges: [],
				unexpandedCounts: {},
			});
			setLoadingSubgraph(false);
			return;
		}
		const ids = nodeIdsKey.split("\u0000");
		const seq = ++subgraphReqSeqRef.current;
		setLoadingSubgraph(true);
		void getCollectionSubgraph(ids)
			.then((res) => {
				if (seq !== subgraphReqSeqRef.current) return;
				if (pendingFitAfterSubgraphRef.current) {
					pendingFitAfterSubgraphRef.current = false;
					needsAutoFitRef.current = true;
				}
				setSubgraph(res);
			})
			.catch((err) => {
				if (seq !== subgraphReqSeqRef.current) return;
				pendingFitAfterSubgraphRef.current = false;
				notifyError(errorText(err));
			})
			.finally(() => {
				if (seq === subgraphReqSeqRef.current) {
					setLoadingSubgraph(false);
				}
			});
	}, [nodeIdsKey, summaryRevision]);

	const layoutInputs = useMemo(
		() =>
			resolvedNodes.map((n) => {
				const unexpanded = subgraph.unexpandedCounts[n.paper.id] ?? 0;
				const isExpanded = expandedBySeed.has(n.paper.id);
				return {
					id: n.paper.id,
					label: n.label,
					citationCount: n.paper.citationCount,
					hasExpandAction: unexpanded > 0 || isExpanded,
					inLibrary: n.inLibrary,
					expandAnchorId: n.expandAnchorId,
				};
			}),
		[resolvedNodes, subgraph.unexpandedCounts, expandedBySeed],
	);

	const baseLayout = useMemo(() => {
		const computed = computePaperGraphLayout(
			layoutInputs,
			subgraph.citationEdges,
			subgraph.sharedRefEdges,
			prevLayoutPositionsRef.current.size > 0
				? prevLayoutPositionsRef.current
				: undefined,
		);
		const nextPrev = new Map<string, { x: number; y: number }>();
		for (const [id, pos] of computed.positions.entries()) {
			nextPrev.set(id, { x: pos.x, y: pos.y });
		}
		prevLayoutPositionsRef.current = nextPrev;
		return computed;
	}, [layoutInputs, subgraph.citationEdges, subgraph.sharedRefEdges]);

	const effectivePositions = useMemo(() => {
		if (manualOffsets.size === 0) return baseLayout.positions;
		const merged = new Map<string, PaperGraphPosition>(baseLayout.positions);
		for (const [id, override] of manualOffsets.entries()) {
			const base = merged.get(id);
			if (base) {
				merged.set(id, { ...base, x: override.x, y: override.y });
			}
		}
		return merged;
	}, [baseLayout.positions, manualOffsets]);

	const handleFitView = useCallback(() => {
		setCamera(computeFitTransform(baseLayout.bounds, viewport));
	}, [baseLayout.bounds, viewport]);

	useEffect(() => {
		if (resolvedNodes.length === 0) return;
		if (needsAutoFitRef.current) {
			needsAutoFitRef.current = false;
			setCamera(computeFitTransform(baseLayout.bounds, viewport));
		}
	}, [resolvedNodes.length, baseLayout.bounds, viewport]);

	// Active neighborhood lookup for hover focus
	const hoveredNeighbors = useMemo(() => {
		if (!hoveredId) return null;
		const connected = new Set<string>([hoveredId]);
		for (const e of subgraph.citationEdges) {
			if (e.citingId === hoveredId) connected.add(e.citedId);
			else if (e.citedId === hoveredId) connected.add(e.citingId);
		}
		for (const e of subgraph.sharedRefEdges) {
			if (e.sourceId === hoveredId) connected.add(e.targetId);
			else if (e.targetId === hoveredId) connected.add(e.sourceId);
		}
		return connected;
	}, [hoveredId, subgraph.citationEdges, subgraph.sharedRefEdges]);

	const expandableNodes = useMemo(
		() =>
			resolvedNodes.filter(
				(n) =>
					!expandedBySeed.has(n.paper.id) &&
					(subgraph.unexpandedCounts[n.paper.id] ?? 0) > 0,
			),
		[resolvedNodes, expandedBySeed, subgraph.unexpandedCounts],
	);

	const handleToggleExpand = useCallback(
		async (paper: CollectionPaperItem) => {
			if (expandingIds.has(paper.id)) return;
			if (expandedBySeed.has(paper.id)) {
				setExpandedBySeed((prev) => {
					const next = new Map(prev);
					next.delete(paper.id);
					return next;
				});
				return;
			}

			const epoch = graphEpochRef.current;
			setExpandingIds((prev) => {
				const next = new Set(prev);
				next.add(paper.id);
				return next;
			});

			try {
				const picked = await fetchExpandNeighbors(paper.id);
				if (graphEpochRef.current !== epoch) return;
				if (picked.length > 0) {
					onObservePapersRef.current?.(picked);
				}
				setExpandedBySeed((prev) => {
					const next = new Map(prev);
					next.set(paper.id, picked);
					return next;
				});
			} catch (err) {
				if (graphEpochRef.current === epoch) {
					notifyError(errorText(err));
				}
			} finally {
				if (graphEpochRef.current === epoch) {
					setExpandingIds((prev) => {
						const next = new Set(prev);
						next.delete(paper.id);
						return next;
					});
				}
			}
		},
		[expandedBySeed, expandingIds],
	);

	const handleExpandAll = useCallback(async () => {
		if (expandingAll || loadingSubgraph) return;
		const targets = expandableNodes.filter(
			(n) => !expandingIds.has(n.paper.id),
		);
		if (targets.length === 0) return;

		const epoch = graphEpochRef.current;
		const targetIds = targets.map((n) => n.paper.id);
		const existingNodeIds = new Set(resolvedNodes.map((n) => n.paper.id));

		setExpandingAll(true);
		setExpandingIds((prev) => {
			const next = new Set(prev);
			for (const id of targetIds) next.add(id);
			return next;
		});

		const results = new Map<string, CollectionPaperItem[]>();
		let firstError: unknown = null;
		let cursor = 0;

		const worker = async () => {
			while (cursor < targetIds.length) {
				if (graphEpochRef.current !== epoch) return;
				const idx = cursor++;
				const id = targetIds[idx];
				if (!id) continue;
				try {
					const picked = await fetchExpandNeighbors(id);
					if (graphEpochRef.current !== epoch) return;
					results.set(id, picked);
				} catch (err) {
					if (firstError === null) firstError = err;
				}
			}
		};

		try {
			const workerCount = Math.min(EXPAND_ALL_CONCURRENCY, targetIds.length);
			await Promise.all(Array.from({ length: workerCount }, () => worker()));
			if (graphEpochRef.current !== epoch) return;

			if (firstError !== null) {
				notifyError(errorText(firstError));
			}

			if (results.size > 0) {
				const observed: CollectionPaperItem[] = [];
				const seenObserved = new Set<string>();
				let addedNewNode = false;
				for (const picked of results.values()) {
					for (const item of picked) {
						if (!existingNodeIds.has(item.id)) {
							addedNewNode = true;
						}
						if (!seenObserved.has(item.id)) {
							seenObserved.add(item.id);
							observed.push(item);
						}
					}
				}
				if (observed.length > 0) {
					onObservePapersRef.current?.(observed);
				}
				if (addedNewNode) {
					pendingFitAfterSubgraphRef.current = true;
				}
				setExpandedBySeed((prev) => {
					const next = new Map(prev);
					for (const [id, picked] of results.entries()) {
						next.set(id, picked);
					}
					return next;
				});
			}
		} finally {
			if (graphEpochRef.current === epoch) {
				setExpandingIds((prev) => {
					const next = new Set(prev);
					for (const id of targetIds) next.delete(id);
					return next;
				});
				setExpandingAll(false);
			}
		}
	}, [
		expandableNodes,
		expandingAll,
		expandingIds,
		loadingSubgraph,
		resolvedNodes,
	]);

	const handleResetExpanded = useCallback(() => {
		graphEpochRef.current += 1;
		pendingFitAfterSubgraphRef.current = false;
		setExpandingIds(new Set());
		setExpandingAll(false);
		setExpandedBySeed(new Map());
		setManualOffsets(new Map());
		prevLayoutPositionsRef.current = new Map();
		needsAutoFitRef.current = true;
	}, []);

	const zoomByFactor = useCallback(
		(factor: number, originX?: number, originY?: number) => {
			setCamera((prev) => {
				const nextScale = Math.max(
					MIN_SCALE,
					Math.min(MAX_SCALE, prev.scale * factor),
				);
				if (Math.abs(nextScale - prev.scale) < 1e-4) return prev;
				const ox = originX ?? viewport.width / 2;
				const oy = originY ?? viewport.height / 2;
				const ratio = nextScale / prev.scale;
				return {
					scale: nextScale,
					tx: ox - (ox - prev.tx) * ratio,
					ty: oy - (oy - prev.ty) * ratio,
				};
			});
		},
		[viewport.height, viewport.width],
	);

	// Wheel zoom anchored at cursor
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const rect = el.getBoundingClientRect();
			const ox = e.clientX - rect.left;
			const oy = e.clientY - rect.top;
			const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
			zoomByFactor(factor, ox, oy);
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [zoomByFactor]);

	// Pan state on background drag
	const panRef = useRef<{
		pointerId: number;
		startX: number;
		startY: number;
		origTx: number;
		origTy: number;
	} | null>(null);

	const handleCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		if ((e.target as HTMLElement).closest("[data-graph-node]")) return;
		e.currentTarget.setPointerCapture?.(e.pointerId);
		panRef.current = {
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			origTx: camera.tx,
			origTy: camera.ty,
		};
	};

	const handleCanvasPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		const pan = panRef.current;
		if (!pan || pan.pointerId !== e.pointerId) return;
		setCamera((prev) => ({
			...prev,
			tx: pan.origTx + (e.clientX - pan.startX),
			ty: pan.origTy + (e.clientY - pan.startY),
		}));
	};

	const handleCanvasPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
		if (panRef.current?.pointerId === e.pointerId) {
			panRef.current = null;
		}
	};

	// Individual node drag vs click disambiguation
	const suppressedClickNodeIdRef = useRef<string | null>(null);
	const nodeDragRef = useRef<{
		nodeId: string;
		pointerId: number;
		startX: number;
		startY: number;
		origNodeX: number;
		origNodeY: number;
		moved: boolean;
	} | null>(null);

	const handleNodePointerDown = (
		e: React.PointerEvent<HTMLButtonElement>,
		nodeId: string,
	) => {
		if (e.button !== 0) return;
		const pos = effectivePositions.get(nodeId);
		if (!pos) return;
		suppressedClickNodeIdRef.current = null;
		e.stopPropagation();
		e.currentTarget.setPointerCapture?.(e.pointerId);
		nodeDragRef.current = {
			nodeId,
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			origNodeX: pos.x,
			origNodeY: pos.y,
			moved: false,
		};
	};

	const handleNodePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
		const drag = nodeDragRef.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		const dxScreen = e.clientX - drag.startX;
		const dyScreen = e.clientY - drag.startY;
		if (
			!drag.moved &&
			Math.hypot(dxScreen, dyScreen) >= DRAG_CLICK_THRESHOLD_PX
		) {
			drag.moved = true;
			suppressedClickNodeIdRef.current = drag.nodeId;
		}
		if (!drag.moved) return;
		const nextX = drag.origNodeX + dxScreen / camera.scale;
		const nextY = drag.origNodeY + dyScreen / camera.scale;
		setManualOffsets((prev) => {
			const next = new Map(prev);
			next.set(drag.nodeId, { x: nextX, y: nextY });
			return next;
		});
		prevLayoutPositionsRef.current.set(drag.nodeId, { x: nextX, y: nextY });
	};

	const handleNodePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
		if (nodeDragRef.current?.pointerId === e.pointerId) {
			nodeDragRef.current = null;
		}
	};

	return (
		<div
			ref={containerRef}
			data-discover-graph-view
			onPointerDown={handleCanvasPointerDown}
			onPointerMove={handleCanvasPointerMove}
			onPointerUp={handleCanvasPointerUp}
			onPointerCancel={handleCanvasPointerUp}
			className="relative h-full w-full cursor-grab select-none overflow-hidden bg-[radial-gradient(circle_at_1px_1px,var(--color-border)_0.75px,transparent_0)] bg-[size:1.25rem_1.25rem] active:cursor-grabbing"
		>
			{/* Transformed world layer: SVG edges + interactive capsule pills */}
			<div
				style={{
					transform: `translate3d(${camera.tx}px, ${camera.ty}px, 0) scale(${camera.scale})`,
					transformOrigin: "0 0",
				}}
				className="pointer-events-none absolute top-0 left-0 h-0 w-0"
			>
				<svg
					aria-hidden="true"
					className="pointer-events-none overflow-visible"
				>
					<defs>
						<marker
							id={citeMarkerId}
							viewBox="0 0 8 8"
							refX="7"
							refY="4"
							markerWidth="5"
							markerHeight="5"
							orient="auto"
							className="text-foreground/55"
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
							id={citeActiveMarkerId}
							viewBox="0 0 8 8"
							refX="7"
							refY="4"
							markerWidth="5.5"
							markerHeight="5.5"
							orient="auto"
							className="text-brand"
						>
							<path
								d="M 1 1.5 L 7 4 L 1 6.5"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.65"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</marker>
					</defs>

					{/* Shared reference edges (dashed) */}
					{subgraph.sharedRefEdges.map((edge) => {
						const sPos = effectivePositions.get(edge.sourceId);
						const tPos = effectivePositions.get(edge.targetId);
						if (!sPos || !tPos) return null;
						const clipped = clipSegmentToCapsuleEdge(sPos, tPos);
						const active =
							hoveredId === edge.sourceId || hoveredId === edge.targetId;
						const dimmed = hoveredId !== null && !active;
						return (
							<line
								key={`shared:${edge.sourceId}:${edge.targetId}`}
								data-graph-edge="shared"
								data-source={edge.sourceId}
								data-target={edge.targetId}
								x1={clipped.x1}
								y1={clipped.y1}
								x2={clipped.x2}
								y2={clipped.y2}
								stroke="currentColor"
								strokeWidth={active ? 1.75 : 1.15}
								strokeDasharray="4 3.5"
								className={cn(
									"transition-opacity duration-150 motion-reduce:transition-none",
									active
										? "text-brand/90 opacity-95"
										: dimmed
											? "text-muted-foreground opacity-15"
											: "text-muted-foreground/45 opacity-80",
								)}
							/>
						);
					})}

					{/* Direct citation edges (solid directed) */}
					{subgraph.citationEdges.map((edge) => {
						const sPos = effectivePositions.get(edge.citingId);
						const tPos = effectivePositions.get(edge.citedId);
						if (!sPos || !tPos) return null;
						const clipped = clipSegmentToCapsuleEdge(sPos, tPos);
						const active =
							hoveredId === edge.citingId || hoveredId === edge.citedId;
						const dimmed = hoveredId !== null && !active;
						return (
							<line
								key={`cite:${edge.citingId}:${edge.citedId}`}
								data-graph-edge="citation"
								data-citing={edge.citingId}
								data-cited={edge.citedId}
								x1={clipped.x1}
								y1={clipped.y1}
								x2={clipped.x2}
								y2={clipped.y2}
								stroke="currentColor"
								strokeWidth={active ? 2 : 1.35}
								markerEnd={`url(#${active ? citeActiveMarkerId : citeMarkerId})`}
								className={cn(
									"transition-opacity duration-150 motion-reduce:transition-none",
									active
										? "text-brand opacity-100"
										: dimmed
											? "text-muted-foreground opacity-15"
											: "text-foreground/50 opacity-90",
								)}
							/>
						);
					})}
				</svg>

				{/* Capsule Nodes (`XXX@YYY`) */}
				{resolvedNodes.map((node) => {
					const pos = effectivePositions.get(node.paper.id);
					if (!pos) return null;
					const id = node.paper.id;
					const unexpandedCount = subgraph.unexpandedCounts[id] ?? 0;
					const isExpanded = expandedBySeed.has(id);
					const isExpanding = expandingIds.has(id);
					const showExpandBtn =
						unexpandedCount > 0 || isExpanded || isExpanding;
					const isHovered = hoveredId === id;
					const isDimmed =
						hoveredNeighbors !== null && !hoveredNeighbors.has(id);

					return (
						<div
							key={id}
							data-graph-node={id}
							data-in-library={node.inLibrary ? "true" : undefined}
							data-expanded-neighbor={!node.isSeed ? "true" : undefined}
							style={{
								transform: `translate3d(${pos.x - pos.width / 2}px, ${pos.y - pos.height / 2}px, 0)`,
								width: `${pos.width}px`,
								height: `${pos.height}px`,
							}}
							className={cn(
								"pointer-events-auto absolute top-0 left-0 flex items-center rounded-full transition-opacity duration-150 motion-reduce:transition-none",
								node.inLibrary
									? "bg-emerald-500/16 text-emerald-950 ring-[1.5px] ring-emerald-500/80 shadow-[0_2px_10px_-2px_rgba(16,185,129,0.4)] dark:bg-emerald-500/24 dark:text-emerald-50 dark:ring-emerald-400/85"
									: !node.isSeed
										? "bg-background/95 text-foreground ring-1 ring-brand/40 shadow-2xs dark:bg-zinc-900/95 dark:ring-brand/50"
										: "bg-background/95 text-foreground ring-1 ring-border shadow-2xs dark:bg-zinc-900/95 dark:ring-white/18",
								isHovered && "z-20 ring-brand",
								isDimmed && "opacity-45",
							)}
						>
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										aria-label={node.paper.title}
										onMouseEnter={() => setHoveredId(id)}
										onMouseLeave={() =>
											setHoveredId((prev) => (prev === id ? null : prev))
										}
										onFocus={() => setHoveredId(id)}
										onBlur={() =>
											setHoveredId((prev) => (prev === id ? null : prev))
										}
										onPointerDown={(e) => handleNodePointerDown(e, id)}
										onPointerMove={handleNodePointerMove}
										onPointerUp={handleNodePointerUp}
										onPointerCancel={handleNodePointerUp}
										onClick={() => {
											if (suppressedClickNodeIdRef.current === id) {
												suppressedClickNodeIdRef.current = null;
												return;
											}
											onOpenDetail(node.paper);
										}}
										className={cn(
											"flex h-full min-w-0 flex-1 cursor-pointer items-center justify-center gap-1 rounded-full pl-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60",
											showExpandBtn ? "pr-1" : "pr-2.5",
										)}
									>
										{node.inLibrary ? (
											<Library className="size-3 shrink-0 text-emerald-600 dark:text-emerald-300" />
										) : null}
										<span className="truncate font-medium font-mono text-[0.6875rem] leading-none">
											{node.label}
										</span>
									</button>
								</TooltipTrigger>
								{!containerHidden ? (
									<TooltipContent
										side="top"
										className="max-w-xs space-y-1 py-1.5"
									>
										<p className="font-medium text-xs leading-snug">
											{node.paper.title}
										</p>
										<p className="flex flex-wrap items-center gap-1.5 font-mono text-[0.625rem] opacity-80">
											<span>{node.paper.sourceLabel}</span>
											{node.paper.ccfRank ? (
												<span>· {node.paper.ccfRank}</span>
											) : null}
											{node.inLibrary ? (
												<span className="text-emerald-400">
													· {t("plaza.collection.lineage.inVault")}
												</span>
											) : null}
										</p>
									</TooltipContent>
								) : null}
							</Tooltip>

							{showExpandBtn ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											data-graph-expand={id}
											disabled={isExpanding}
											aria-label={
												isExpanded
													? t("plaza.discover.graphCollapseNode")
													: t("plaza.discover.graphExpandNode")
											}
											onMouseEnter={() => setHoveredId(id)}
											onMouseLeave={() =>
												setHoveredId((prev) => (prev === id ? null : prev))
											}
											onPointerDown={(e) => e.stopPropagation()}
											onClick={(e) => {
												e.stopPropagation();
												void handleToggleExpand(node.paper);
											}}
											className={cn(
												"mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand motion-reduce:transition-none",
												isExpanded
													? "bg-brand/18 text-brand hover:bg-brand/28"
													: "bg-muted/80 text-muted-foreground hover:bg-brand/15 hover:text-brand dark:bg-white/10",
											)}
										>
											{isExpanding ? (
												<Loader2 className="size-2.5 animate-spin" />
											) : isExpanded ? (
												<Minus className="size-2.5" />
											) : (
												<Plus className="size-2.5" />
											)}
										</button>
									</TooltipTrigger>
									{!containerHidden ? (
										<TooltipContent side="top">
											{isExpanded
												? t("plaza.discover.graphCollapseNode")
												: `${t("plaza.discover.graphExpandNode")}${unexpandedCount > 0 ? ` (+${unexpandedCount})` : ""}`}
										</TooltipContent>
									) : null}
								</Tooltip>
							) : null}
						</div>
					);
				})}
			</div>

			{/* Bottom-left compact legend */}
			<div
				onPointerDown={(e) => e.stopPropagation()}
				className="pointer-events-auto absolute bottom-3 left-3 z-20 flex flex-wrap items-center gap-3 rounded-lg border bg-background/85 px-2.5 py-1.5 text-[0.6875rem] text-muted-foreground shadow-xs backdrop-blur-md"
			>
				<span className="inline-flex items-center gap-1.5">
					<span className="h-[1.5px] w-4 bg-foreground/65" />
					<span>{t("plaza.discover.graphDirectEdge")}</span>
				</span>
				<span className="inline-flex items-center gap-1.5">
					<span className="h-0 w-4 border-muted-foreground border-t border-dashed" />
					<span>{t("plaza.discover.graphSharedEdge")}</span>
				</span>
				<span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
					<Library className="size-3" />
					<span>{t("plaza.collection.lineage.inVault")}</span>
				</span>
				{loadingSubgraph ? (
					<Loader2 className="size-3 animate-spin text-muted-foreground" />
				) : null}
			</div>

			{/* Top-right floating controls: Expand All + Reset + Viewport */}
			<div
				onPointerDown={(e) => e.stopPropagation()}
				className="pointer-events-auto absolute top-3 right-3 z-20 flex items-center gap-1 rounded-lg border bg-background/85 p-1 shadow-xs backdrop-blur-md"
			>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							data-graph-expand-all
							disabled={
								expandingAll || loadingSubgraph || expandableNodes.length === 0
							}
							onClick={() => void handleExpandAll()}
							aria-label={t("plaza.discover.graphExpandAll")}
							className="h-6 gap-1 px-2 text-xs tabular-nums"
						>
							{expandingAll ? (
								<Loader2 className="size-3 animate-spin" />
							) : (
								<GitBranchPlus className="size-3.5" />
							)}
							<span>{t("plaza.discover.graphExpandAll")}</span>
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">
						{expandableNodes.length > 0
							? `${t("plaza.discover.graphExpandAll")} (${expandableNodes.length})`
							: t("plaza.discover.graphExpandAll")}
					</TooltipContent>
				</Tooltip>

				{expandedBySeed.size > 0 ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								data-graph-reset-expanded
								onClick={handleResetExpanded}
								aria-label={t("plaza.discover.graphResetExpanded")}
							>
								<RotateCcw className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{t("plaza.discover.graphResetExpanded")}
						</TooltipContent>
					</Tooltip>
				) : null}

				<span className="mx-0.5 h-3.5 w-px bg-border" />

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							onClick={() => zoomByFactor(1.2)}
							aria-label={t("plaza.zoomIn")}
						>
							<ZoomIn className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">{t("plaza.zoomIn")}</TooltipContent>
				</Tooltip>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							onClick={() => zoomByFactor(1 / 1.2)}
							aria-label={t("plaza.zoomOut")}
						>
							<ZoomOut className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">{t("plaza.zoomOut")}</TooltipContent>
				</Tooltip>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							onClick={handleFitView}
							aria-label={t("plaza.discover.graphFitView")}
						>
							<Maximize2 className="size-3.5" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">
						{t("plaza.discover.graphFitView")}
					</TooltipContent>
				</Tooltip>
			</div>

			{/* Load more button when search has additional pages */}
			{seedPapers.length < totalMatched ? (
				<div
					onPointerDown={(e) => e.stopPropagation()}
					className="pointer-events-auto absolute right-3 bottom-3 z-20"
				>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={loadingMore}
						onClick={onLoadMore}
						className="h-7 gap-1.5 bg-background/90 px-2.5 text-xs tabular-nums backdrop-blur-md"
					>
						{loadingMore ? <Loader2 className="size-3 animate-spin" /> : null}
						<span>
							{seedPapers.length} / {totalMatched}
						</span>
						<Plus className="size-3" />
					</Button>
				</div>
			) : null}
		</div>
	);
}
