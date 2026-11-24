/**
 * Plaza — Citation & Shared-Reference Graph View data model, `XXX@YYY` citekey
 * formatter, and deterministic rectangular-capsule layout solver.
 *
 * Design notes & references:
 * - Node shorthand `XXX@YYY` follows academic citation-key conventions (first author
 *   surname + first non-article title word, e.g. `Smith@Fuzzing`).
 * - Layout adapts spring-embedder principles (cf. `d3-force` / Connected Papers)
 *   with exact AABB capsule collision (`width × height`) so variable-width pill
 *   labels never overlap, while keeping degree-0 search hits in a tidy below-cluster
 *   band so citation & shared-ref edges stay legible.
 */

export type GraphCitationEdge = {
	citingId: string;
	citedId: string;
};

export type GraphSharedRefEdge = {
	sourceId: string;
	targetId: string;
	sharedCount: number;
};

export type PaperGraphNodeInput = {
	id: string;
	label: string;
	citationCount?: number;
	hasExpandAction?: boolean;
	inLibrary?: boolean;
	/** When newly brought in by expanding a seed node, spawn near that seed. */
	expandAnchorId?: string;
};

export type PaperGraphPosition = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type PaperGraphBounds = {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
};

export type PaperGraphLayout = {
	positions: Map<string, PaperGraphPosition>;
	bounds: PaperGraphBounds;
};

const AUTHOR_SUFFIXES = new Set([
	"jr",
	"jr.",
	"sr",
	"sr.",
	"ii",
	"iii",
	"iv",
	"v",
]);

const LEADING_TITLE_ARTICLES = new Set(["a", "an", "the"]);

const MAX_LABEL_PART_CHARS = 14;
const PILL_HEIGHT = 30;
const COLLIDE_GAP_X = 18;
const COLLIDE_GAP_Y = 14;

function stripParentheticals(raw: string): string {
	let out = "";
	let depth = 0;
	for (const ch of raw) {
		if (ch === "(" || ch === "[") {
			depth += 1;
		} else if (ch === ")" || ch === "]") {
			if (depth > 0) depth -= 1;
		} else if (depth === 0) {
			out += ch;
		}
	}
	return out;
}

function isDigitsOnly(tok: string): boolean {
	return tok.length > 0 && /^\d+$/.test(tok);
}

function cleanAuthorToken(raw: string): string {
	return raw
		.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
		.replace(/[^\p{L}\p{N}'’-]/gu, "");
}

function normalizeDisplayCapitalization(word: string): string {
	if (!word) return word;
	// Preserve mixed-case tokens (`LeCun`, `FuzzBench`, `eBPF`, `LLM`) and CJK
	if (/^[a-z]/.test(word) && word === word.toLowerCase()) {
		return word.charAt(0).toUpperCase() + word.slice(1);
	}
	return word;
}

function clampPart(word: string): string {
	const chars = Array.from(word);
	if (chars.length <= MAX_LABEL_PART_CHARS) return word;
	return `${chars.slice(0, MAX_LABEL_PART_CHARS - 1).join("")}…`;
}

function extractFirstAuthorSurname(authors: readonly string[]): string {
	const firstRaw = authors[0]?.trim() ?? "";
	if (!firstRaw) return "Anon";

	const stripped = stripParentheticals(firstRaw).trim();
	if (!stripped) return "Anon";

	let candidateTokens: string[];
	if (stripped.includes(",")) {
		const surnameSegment = stripped.split(",")[0] ?? "";
		candidateTokens = surnameSegment
			.split(/\s+/)
			.map(cleanAuthorToken)
			.filter(
				(t) =>
					t.length > 0 &&
					!isDigitsOnly(t) &&
					!AUTHOR_SUFFIXES.has(t.toLowerCase()),
			);
		if (candidateTokens.length > 0) {
			return clampPart(
				normalizeDisplayCapitalization(candidateTokens.join("")),
			);
		}
	}

	candidateTokens = stripped
		.split(/\s+/)
		.map(cleanAuthorToken)
		.filter(
			(t) =>
				t.length > 0 &&
				!isDigitsOnly(t) &&
				!AUTHOR_SUFFIXES.has(t.toLowerCase()),
		);
	if (candidateTokens.length === 0) return "Anon";
	const surname = candidateTokens[candidateTokens.length - 1] ?? "Anon";
	return clampPart(normalizeDisplayCapitalization(surname));
}

function extractFirstTitleWord(title: string): string {
	const trimmed = title.trim();
	if (!trimmed) return "Paper";

	const rawTokens = trimmed.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
	if (rawTokens.length === 0) return "Paper";

	const nonArticle =
		rawTokens.find((tok) => !LEADING_TITLE_ARTICLES.has(tok.toLowerCase())) ??
		rawTokens[0] ??
		"Paper";

	// Keep concise hyphenated terms (`Multi-Agent`, `LLM-Based`), split overly long ones
	const chosen =
		nonArticle.includes("-") && Array.from(nonArticle).length > 12
			? (nonArticle.split("-")[0] ?? nonArticle)
			: nonArticle;

	return clampPart(normalizeDisplayCapitalization(chosen));
}

/**
 * Format a compact academic node label `XXX@YYY` (first author surname + first
 * non-article title word, e.g. `Smith@Fuzzing`).
 */
export function formatPaperGraphLabel(paper: {
	title: string;
	authors: readonly string[];
}): string {
	const authorPart = extractFirstAuthorSurname(paper.authors);
	const titlePart = extractFirstTitleWord(paper.title);
	return `${authorPart}@${titlePart}`;
}

export function estimateCapsuleWidth(
	label: string,
	options?: { hasExpandAction?: boolean; inLibrary?: boolean },
): number {
	let textPx = 0;
	for (const ch of label) {
		const code = ch.codePointAt(0) ?? 0;
		textPx += code > 0x2e7f ? 12.5 : 7.1;
	}
	const libraryExtra = options?.inLibrary ? 16 : 0;
	const expandExtra = options?.hasExpandAction ? 22 : 0;
	return Math.max(
		88,
		Math.min(204, Math.round(textPx + 24 + libraryExtra + expandExtra)),
	);
}

type SimNode = {
	id: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	width: number;
	height: number;
	pinnedRef?: { x: number; y: number };
};

function resolveCapsuleCollisions(nodes: SimNode[], passes: number): void {
	if (nodes.length < 2) return;
	for (let pass = 0; pass < passes; pass += 1) {
		let moved = false;
		for (let i = 0; i < nodes.length; i += 1) {
			const a = nodes[i];
			for (let j = i + 1; j < nodes.length; j += 1) {
				const b = nodes[j];
				const minDx = (a.width + b.width) / 2 + COLLIDE_GAP_X;
				const minDy = (a.height + b.height) / 2 + COLLIDE_GAP_Y;
				let dx = b.x - a.x;
				let dy = b.y - a.y;
				if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
					const angle = ((i * 7 + j * 13) % 360) * (Math.PI / 180);
					dx = Math.cos(angle);
					dy = Math.sin(angle);
				}
				const overlapX = minDx - Math.abs(dx);
				const overlapY = minDy - Math.abs(dy);
				if (overlapX <= 0 || overlapY <= 0) continue;

				moved = true;
				// Push apart along axis of smaller normalized penetration
				if (overlapX / minDx < overlapY / minDy) {
					const sign = dx >= 0 ? 1 : -1;
					const shift = overlapX * 0.52;
					a.x -= sign * shift;
					b.x += sign * shift;
				} else {
					const sign = dy >= 0 ? 1 : -1;
					const shift = overlapY * 0.52;
					a.y -= sign * shift;
					b.y += sign * shift;
				}
			}
		}
		if (!moved) break;
	}
}

function computeBounds(
	positions: Map<string, PaperGraphPosition>,
): PaperGraphBounds {
	if (positions.size === 0) {
		return {
			minX: -200,
			minY: -150,
			maxX: 200,
			maxY: 150,
			width: 400,
			height: 300,
		};
	}
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const p of positions.values()) {
		minX = Math.min(minX, p.x - p.width / 2);
		minY = Math.min(minY, p.y - p.height / 2);
		maxX = Math.max(maxX, p.x + p.width / 2);
		maxY = Math.max(maxY, p.y + p.height / 2);
	}
	const pad = 36;
	minX -= pad;
	minY -= pad;
	maxX += pad;
	maxY += pad;
	return {
		minX,
		minY,
		maxX,
		maxY,
		width: Math.max(240, maxX - minX),
		height: Math.max(180, maxY - minY),
	};
}

/**
 * Deterministic spring + capsule-collision layout for the search Graph View.
 * Connected citation / shared-ref components settle near the center while
 * degree-0 nodes sit in a tidy multi-column band below, preserving previous
 * coordinates on incremental node expansion.
 */
export function computePaperGraphLayout(
	nodes: readonly PaperGraphNodeInput[],
	citationEdges: readonly GraphCitationEdge[],
	sharedRefEdges: readonly GraphSharedRefEdge[],
	previousPositions?: ReadonlyMap<string, { x: number; y: number }>,
): PaperGraphLayout {
	const positions = new Map<string, PaperGraphPosition>();
	if (nodes.length === 0) {
		return { positions, bounds: computeBounds(positions) };
	}

	const nodeById = new Map<string, PaperGraphNodeInput>();
	for (const n of nodes) {
		nodeById.set(n.id, n);
	}

	const degree = new Map<string, number>();
	const validCitations = citationEdges.filter(
		(e) =>
			e.citingId !== e.citedId &&
			nodeById.has(e.citingId) &&
			nodeById.has(e.citedId),
	);
	const validShared = sharedRefEdges.filter(
		(e) =>
			e.sourceId !== e.targetId &&
			nodeById.has(e.sourceId) &&
			nodeById.has(e.targetId),
	);

	for (const e of validCitations) {
		degree.set(e.citingId, (degree.get(e.citingId) ?? 0) + 1);
		degree.set(e.citedId, (degree.get(e.citedId) ?? 0) + 1);
	}
	for (const e of validShared) {
		degree.set(e.sourceId, (degree.get(e.sourceId) ?? 0) + 1);
		degree.set(e.targetId, (degree.get(e.targetId) ?? 0) + 1);
	}

	const connectedInputs: PaperGraphNodeInput[] = [];
	const isolatedInputs: PaperGraphNodeInput[] = [];
	for (const n of nodes) {
		if ((degree.get(n.id) ?? 0) > 0) {
			connectedInputs.push(n);
		} else {
			isolatedInputs.push(n);
		}
	}

	// Sort connected seeds by degree descending for stable central placement
	const sortedConnected = [...connectedInputs].sort(
		(a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0),
	);

	const simNodes: SimNode[] = [];
	const simIdxById = new Map<string, number>();
	const goldenAngle = Math.PI * (3 - Math.sqrt(5));
	let anchorSpawnSeq = 0;

	sortedConnected.forEach((n, idx) => {
		const width = estimateCapsuleWidth(n.label, {
			hasExpandAction: n.hasExpandAction,
			inLibrary: n.inLibrary,
		});
		const prev = previousPositions?.get(n.id);
		const anchor =
			!prev && n.expandAnchorId
				? previousPositions?.get(n.expandAnchorId)
				: undefined;

		let x: number;
		let y: number;
		if (prev) {
			x = prev.x;
			y = prev.y;
		} else if (anchor) {
			anchorSpawnSeq += 1;
			const theta = anchorSpawnSeq * 1.15;
			x = anchor.x + Math.cos(theta) * 125;
			y = anchor.y + Math.sin(theta) * 95;
		} else {
			const radius = idx === 0 ? 0 : 78 * Math.sqrt(idx + 0.6);
			const theta = idx * goldenAngle;
			x = Math.cos(theta) * radius * 1.25;
			y = Math.sin(theta) * radius * 0.9;
		}

		simIdxById.set(n.id, simNodes.length);
		simNodes.push({
			id: n.id,
			x,
			y,
			vx: 0,
			vy: 0,
			width,
			height: PILL_HEIGHT,
			pinnedRef: prev ? { x: prev.x, y: prev.y } : undefined,
		});
	});

	if (simNodes.length > 0) {
		const hasIncrementalPrev = simNodes.some((s) => s.pinnedRef !== undefined);
		const iterations = hasIncrementalPrev ? 85 : 130;

		for (let iter = 0; iter < iterations; iter += 1) {
			const alpha = 1 - iter / iterations;

			// Pairwise repulsion
			for (let i = 0; i < simNodes.length; i += 1) {
				const a = simNodes[i];
				for (let j = i + 1; j < simNodes.length; j += 1) {
					const b = simNodes[j];
					const dx = b.x - a.x;
					const dy = b.y - a.y;
					const distSq = dx * dx + dy * dy + 160;
					const dist = Math.sqrt(distSq);
					const strength = (6200 * alpha) / distSq;
					const fx = (dx / dist) * strength;
					const fy = (dy / dist) * strength * 0.85;
					a.vx -= fx;
					a.vy -= fy;
					b.vx += fx;
					b.vy += fy;
				}
			}

			// Direct citation springs (solid directed edges: mild left-to-right flow)
			for (const edge of validCitations) {
				const si = simIdxById.get(edge.citingId);
				const ti = simIdxById.get(edge.citedId);
				if (si === undefined || ti === undefined) continue;
				const s = simNodes[si];
				const t = simNodes[ti];
				const idealDist = (s.width + t.width) / 2 + 64;
				const dx = t.x - s.x;
				const dy = t.y - s.y;
				const dist = Math.max(1, Math.hypot(dx, dy));
				const k = 0.13 * alpha;
				const force = (dist - idealDist) * k;
				const fx = (dx / dist) * force;
				const fy = (dy / dist) * force;
				s.vx += fx;
				s.vy += fy;
				t.vx -= fx;
				t.vy -= fy;
			}

			// Shared-reference springs (dashed edges)
			for (const edge of validShared) {
				const si = simIdxById.get(edge.sourceId);
				const ti = simIdxById.get(edge.targetId);
				if (si === undefined || ti === undefined) continue;
				const s = simNodes[si];
				const t = simNodes[ti];
				const idealDist = (s.width + t.width) / 2 + 84;
				const dx = t.x - s.x;
				const dy = t.y - s.y;
				const dist = Math.max(1, Math.hypot(dx, dy));
				const weight = Math.min(1.8, Math.max(0.7, edge.sharedCount / 3));
				const k = 0.065 * weight * alpha;
				const force = (dist - idealDist) * k;
				const fx = (dx / dist) * force;
				const fy = (dy / dist) * force;
				s.vx += fx;
				s.vy += fy;
				t.vx -= fx;
				t.vy -= fy;
			}

			// Center gravity + warm-start spatial memory
			for (const s of simNodes) {
				if (s.pinnedRef) {
					s.vx += (s.pinnedRef.x - s.x) * 0.16 * alpha;
					s.vy += (s.pinnedRef.y - s.y) * 0.16 * alpha;
				} else {
					s.vx += -s.x * 0.032 * alpha;
					s.vy += -s.y * 0.042 * alpha;
				}
				s.x += Math.max(-28, Math.min(28, s.vx));
				s.y += Math.max(-24, Math.min(24, s.vy));
				s.vx *= 0.58;
				s.vy *= 0.58;
			}

			if (iter % 18 === 17) {
				resolveCapsuleCollisions(simNodes, 2);
			}
		}

		resolveCapsuleCollisions(simNodes, 28);

		for (const s of simNodes) {
			positions.set(s.id, {
				x: Math.round(s.x * 10) / 10,
				y: Math.round(s.y * 10) / 10,
				width: s.width,
				height: s.height,
			});
		}
	}

	// Arrange isolated (degree-0) nodes cleanly in compact rows below connected clusters
	if (isolatedInputs.length > 0) {
		const hadConnected = simNodes.length > 0;
		let startY = 0;
		let targetHalfSpanX = 360;
		if (hadConnected) {
			let maxConnectedY = Number.NEGATIVE_INFINITY;
			let minConnectedX = Number.POSITIVE_INFINITY;
			let maxConnectedX = Number.NEGATIVE_INFINITY;
			for (const p of positions.values()) {
				maxConnectedY = Math.max(maxConnectedY, p.y + p.height / 2);
				minConnectedX = Math.min(minConnectedX, p.x - p.width / 2);
				maxConnectedX = Math.max(maxConnectedX, p.x + p.width / 2);
			}
			startY = maxConnectedY + 54;
			targetHalfSpanX = Math.max(
				320,
				Math.min(540, (maxConnectedX - minConnectedX) / 2),
			);
		} else {
			const colsGuess = Math.max(
				2,
				Math.ceil(Math.sqrt(isolatedInputs.length * 1.35)),
			);
			targetHalfSpanX = Math.max(260, Math.min(540, (colsGuess * 156) / 2));
		}

		const maxRowWidth = targetHalfSpanX * 2;
		const rows: Array<Array<{ id: string; width: number }>> = [];
		let currentRow: Array<{ id: string; width: number }> = [];
		let currentWidth = 0;

		for (const n of isolatedInputs) {
			const width = estimateCapsuleWidth(n.label, {
				hasExpandAction: n.hasExpandAction,
				inLibrary: n.inLibrary,
			});
			const needed = currentRow.length === 0 ? width : width + COLLIDE_GAP_X;
			if (currentRow.length > 0 && currentWidth + needed > maxRowWidth) {
				rows.push(currentRow);
				currentRow = [{ id: n.id, width }];
				currentWidth = width;
			} else {
				currentRow.push({ id: n.id, width });
				currentWidth += needed;
			}
		}
		if (currentRow.length > 0) {
			rows.push(currentRow);
		}

		const rowStepY = PILL_HEIGHT + COLLIDE_GAP_Y;
		const baseOffsetY = !hadConnected
			? -((rows.length - 1) * rowStepY) / 2
			: startY;

		rows.forEach((row, rowIdx) => {
			const totalRowW =
				row.reduce((acc, it) => acc + it.width, 0) +
				Math.max(0, row.length - 1) * COLLIDE_GAP_X;
			let cursorX = -totalRowW / 2;
			const y = baseOffsetY + rowIdx * rowStepY;
			for (const item of row) {
				const cx = cursorX + item.width / 2;
				positions.set(item.id, {
					x: Math.round(cx * 10) / 10,
					y: Math.round(y * 10) / 10,
					width: item.width,
					height: PILL_HEIGHT,
				});
				cursorX += item.width + COLLIDE_GAP_X;
			}
		});
	}

	return {
		positions,
		bounds: computeBounds(positions),
	};
}

/**
 * Compute intersection of a ray from capsule center `(cx, cy)` toward `(tx, ty)`
 * with the rounded-rectangle boundary `(width, height)`, so directed arrowheads
 * terminate crisply on the pill edge instead of hiding underneath the node.
 */
export function clipSegmentToCapsuleEdge(
	source: PaperGraphPosition,
	target: PaperGraphPosition,
): { x1: number; y1: number; x2: number; y2: number } {
	const dx = target.x - source.x;
	const dy = target.y - source.y;
	const len = Math.hypot(dx, dy);
	if (len < 1e-3) {
		return { x1: source.x, y1: source.y, x2: target.x, y2: target.y };
	}
	const ux = dx / len;
	const uy = dy / len;

	const boundaryDistance = (
		pos: PaperGraphPosition,
		dirX: number,
		dirY: number,
	) => {
		const hw = pos.width / 2 + 2;
		const hh = pos.height / 2 + 2;
		const tx =
			Math.abs(dirX) > 1e-5 ? hw / Math.abs(dirX) : Number.POSITIVE_INFINITY;
		const ty =
			Math.abs(dirY) > 1e-5 ? hh / Math.abs(dirY) : Number.POSITIVE_INFINITY;
		return Math.min(tx, ty);
	};

	const d1 = Math.min(len * 0.45, boundaryDistance(source, ux, uy));
	const d2 = Math.min(len * 0.45, boundaryDistance(target, -ux, -uy));

	return {
		x1: source.x + ux * d1,
		y1: source.y + uy * d1,
		x2: target.x - ux * d2,
		y2: target.y - uy * d2,
	};
}
