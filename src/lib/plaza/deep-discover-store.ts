/**
 * Plaza — Paper Discover `Deep Search` multi-turn session store.
 *
 * Manages dedicated multi-turn exploration conversations between the user and
 * the ACP Agent over the local `Paper Collection` (`agentero-collection` MCP).
 *
 * Isolated from the Vault reading sidebar (`hideFromChatHistory: true`,
 * `vaultPath: undefined`) and persisted locally under `plaza:discover:deep-sessions:v1`.
 */

import {
	type AgentDescriptor,
	type AgentModelChoice,
	type AgentToolEvent,
	cancelAgentRun,
	listAgents,
	listenAgentCompleted,
	listenAgentFailed,
	listenAgentModels,
	listenAgentSessionInfo,
	listenAgentStream,
	listenAgentTool,
	loadModelCatalog,
	loadModelPref,
	runOnce,
	saveModelCatalog,
	saveModelPref,
	warmAgent,
} from "@/lib/agent";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import { isTauri } from "@/lib/core/tauri";

const STORAGE_KEY = "plaza:discover:deep-sessions:v1";
const MAX_SESSIONS = 24;

export type DeepToolCallRecord = {
	id: string;
	title: string;
	kind: string;
	status: string;
	input?: unknown;
	output?: unknown;
};

export type DeepChatMessage = {
	id: string;
	role: "user" | "assistant";
	content: string;
	reasoning?: string;
	toolCalls?: DeepToolCallRecord[];
	suggestedFollowUps?: string[];
	createdAt: string;
	streaming?: boolean;
	error?: string;
};

export type CuratedPaperRef = {
	id: string;
	reason?: string;
};

export type CuratedPaperGroup = {
	label: string;
	items: CuratedPaperRef[];
};

export type DeepDiscoverSession = {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	agentId: string | null;
	modelId: string | null;
	providerSessionId: string | null;
	messages: DeepChatMessage[];
	curatedGroups: CuratedPaperGroup[];
	pinnedIds: string[];
	sampledIds: string[];
};

export type DeepDiscoverStoreState = {
	sessions: DeepDiscoverSession[];
	activeSessionId: string | null;
	agents: AgentDescriptor[];
	defaultAgentId: string | null;
	selectedAgentId: string | null;
	selectedModelId: string | null;
	modelsByAgent: Record<string, AgentModelChoice[]>;
	runningRuntimeSessionId: string | null;
	runningExplorationId: string | null;
};

function makeId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function tryParseJsonString(raw: string): Record<string, unknown> | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const clean = trimmed.replace(/\n… \[truncated \d+ of \d+ bytes\]\s*$/, "");
	try {
		const parsed = JSON.parse(clean);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Fall through: might be markdown-fenced or truncated JSON
	}
	const fenceMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenceMatch) {
		try {
			const parsed = JSON.parse(fenceMatch[1].trim());
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Ignore
		}
	}
	return null;
}

/**
 * Unwrap ACP / MCP tool outputs (`Json<T>`, `{ stdout: "{...}" }`,
 * `{ rawOutput: {...} }`, `{ content: [{ text: "{...}" }] }`, or raw JSON string).
 */
export function extractMcpToolJsonPayload(
	raw: unknown,
): Record<string, unknown> | null {
	if (!raw) return null;
	if (typeof raw === "string") {
		return tryParseJsonString(raw);
	}
	if (typeof raw !== "object" || Array.isArray(raw)) return null;

	const obj = raw as Record<string, unknown>;

	// Direct structured payload from tool
	if (
		Array.isArray(obj.groups) ||
		Array.isArray(obj.items) ||
		typeof obj.totalPapers === "number" ||
		Array.isArray(obj.resolvedSeeds)
	) {
		return obj;
	}

	// Unwrap ACP `tool_output_payload` wrapper (`stdout` / `rawOutput` / `structuredContent`)
	for (const key of ["structuredContent", "rawOutput", "result", "data"]) {
		const nested = obj[key];
		if (nested) {
			const extracted = extractMcpToolJsonPayload(nested);
			if (extracted) return extracted;
		}
	}

	if (typeof obj.stdout === "string") {
		const extracted = tryParseJsonString(obj.stdout);
		if (extracted) return extracted;
	}

	if (Array.isArray(obj.content)) {
		for (const block of obj.content) {
			if (block && typeof block === "object") {
				const text = (block as Record<string, unknown>).text;
				if (typeof text === "string") {
					const extracted = tryParseJsonString(text);
					if (extracted) return extracted;
				}
			}
		}
	}

	return null;
}

/**
 * Fallback ID extractor when a large `collection_search` (`random_sample`) JSON
 * string was capped at 32 KB by the Host webview relay.
 */
function extractTruncatedSampleIds(rawOutput: unknown): string[] {
	let text = "";
	if (typeof rawOutput === "string") {
		text = rawOutput;
	} else if (rawOutput && typeof rawOutput === "object") {
		const obj = rawOutput as Record<string, unknown>;
		if (typeof obj.stdout === "string") text = obj.stdout;
	}
	if (!text.includes('"random_sample"')) return [];
	const ids: string[] = [];
	const seen = new Set<string>();
	const regex = /"id"\s*:\s*"((?:arxiv|doi|venue):[^"]+)"/g;
	for (const match of text.matchAll(regex)) {
		const id = match[1]?.trim();
		if (id && !seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	}
	return ids;
}

function normalizeCurateGroups(rawGroups: unknown): CuratedPaperGroup[] {
	if (!Array.isArray(rawGroups)) return [];
	const groups: CuratedPaperGroup[] = [];
	for (const g of rawGroups) {
		if (!g || typeof g !== "object") continue;
		const rec = g as Record<string, unknown>;
		const label =
			typeof rec.label === "string" && rec.label.trim()
				? rec.label.trim()
				: "Recommended";
		const rawItems = Array.isArray(rec.items) ? rec.items : [];
		const items: CuratedPaperRef[] = [];
		const seen = new Set<string>();
		for (const it of rawItems) {
			if (!it || typeof it !== "object") continue;
			const itemRec = it as Record<string, unknown>;
			const id = typeof itemRec.id === "string" ? itemRec.id.trim() : "";
			if (!id || seen.has(id)) continue;
			seen.add(id);
			const reason =
				typeof itemRec.reason === "string" && itemRec.reason.trim()
					? itemRec.reason.trim()
					: undefined;
			items.push({ id, reason });
		}
		if (items.length > 0) {
			groups.push({ label, items });
		}
	}
	return groups;
}

function mergeCuratedGroups(
	existing: CuratedPaperGroup[],
	incoming: CuratedPaperGroup[],
	mode: "replace" | "append",
	pinnedIds: string[],
): CuratedPaperGroup[] {
	if (incoming.length === 0) return existing;

	if (mode === "append") {
		const byLabel = new Map<string, CuratedPaperRef[]>();
		const order: string[] = [];
		const globalSeen = new Set<string>();

		for (const g of existing) {
			byLabel.set(g.label, [...g.items]);
			order.push(g.label);
			for (const item of g.items) globalSeen.add(item.id);
		}
		for (const g of incoming) {
			let bucket = byLabel.get(g.label);
			if (!bucket) {
				bucket = [];
				byLabel.set(g.label, bucket);
				order.push(g.label);
			}
			for (const item of g.items) {
				if (globalSeen.has(item.id)) continue;
				globalSeen.add(item.id);
				bucket.push(item);
			}
		}
		return order
			.map((label) => ({ label, items: byLabel.get(label) ?? [] }))
			.filter((g) => g.items.length > 0);
	}

	// mode === "replace": preserve pinned papers that weren't re-included
	const incomingIds = new Set<string>();
	for (const g of incoming) {
		for (const item of g.items) incomingIds.add(item.id);
	}

	const pinnedSet = new Set(pinnedIds);
	const CarryPinnedLabel = "Pinned";
	const carriedPinned: CuratedPaperRef[] = [];
	const seenCarried = new Set<string>();

	for (const g of existing) {
		for (const item of g.items) {
			if (
				pinnedSet.has(item.id) &&
				!incomingIds.has(item.id) &&
				!seenCarried.has(item.id)
			) {
				seenCarried.add(item.id);
				carriedPinned.push(item);
			}
		}
	}

	return carriedPinned.length > 0
		? [{ label: CarryPinnedLabel, items: carriedPinned }, ...incoming]
		: incoming;
}

/**
 * Pure reducer that applies `agentero-collection` MCP tool outputs (or inputs fallback)
 * to a `DeepDiscoverSession`, updating `curatedGroups`, `sampledIds`, and `suggestedFollowUps`.
 */
export function applyCollectionToolOutputToSession(
	session: DeepDiscoverSession,
	toolTitle: string,
	rawOutput: unknown,
	rawInput?: unknown,
): { session: DeepDiscoverSession; suggestedFollowUps?: string[] } {
	const titleLc = toolTitle.toLowerCase();
	const payload =
		extractMcpToolJsonPayload(rawOutput) ??
		(titleLc.includes("collection_curate")
			? extractMcpToolJsonPayload(rawInput)
			: null);

	// 1. collection_curate
	if (
		titleLc.includes("collection_curate") ||
		(payload && Array.isArray(payload.groups))
	) {
		if (!payload) return { session };
		const groups = normalizeCurateGroups(payload.groups);
		const mode =
			typeof payload.mode === "string" &&
			payload.mode.toLowerCase() === "append"
				? "append"
				: "replace";
		const followUps = Array.isArray(payload.suggestedFollowUps)
			? payload.suggestedFollowUps
					.filter((s): s is string => typeof s === "string" && s.trim() !== "")
					.map((s) => s.trim())
					.slice(0, 6)
			: undefined;

		return {
			session: {
				...session,
				curatedGroups: mergeCuratedGroups(
					session.curatedGroups,
					groups,
					mode,
					session.pinnedIds,
				),
				updatedAt: new Date().toISOString(),
			},
			suggestedFollowUps:
				followUps && followUps.length > 0 ? followUps : undefined,
		};
	}

	// 2. collection_search (capture `random_sample` pool)
	if (
		titleLc.includes("collection_search") ||
		(payload &&
			typeof payload.mode === "string" &&
			Array.isArray(payload.items))
	) {
		if (
			payload &&
			payload.mode === "random_sample" &&
			Array.isArray(payload.items)
		) {
			const ids = payload.items
				.map((it) =>
					it && typeof it === "object"
						? (it as Record<string, unknown>).id
						: null,
				)
				.filter(
					(id): id is string => typeof id === "string" && id.trim() !== "",
				);
			if (ids.length > 0) {
				return {
					session: {
						...session,
						sampledIds: ids,
						updatedAt: new Date().toISOString(),
					},
				};
			}
		} else {
			const fallbackIds = extractTruncatedSampleIds(rawOutput);
			if (fallbackIds.length > 0) {
				return {
					session: {
						...session,
						sampledIds: fallbackIds,
						updatedAt: new Date().toISOString(),
					},
				};
			}
		}
	}

	return { session };
}

// ─── Reactive Store ───

function loadPersistedSessions(): DeepDiscoverSession[] {
	const raw = readJsonStorage<DeepDiscoverSession[]>(STORAGE_KEY, []);
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((s) => s && typeof s.id === "string" && Array.isArray(s.messages))
		.map((s) => ({
			...s,
			messages: s.messages.map((m) =>
				m.streaming ? { ...m, streaming: false } : m,
			),
			curatedGroups: Array.isArray(s.curatedGroups) ? s.curatedGroups : [],
			pinnedIds: Array.isArray(s.pinnedIds) ? s.pinnedIds : [],
			sampledIds: Array.isArray(s.sampledIds) ? s.sampledIds : [],
		}));
}

function persistSessions(sessions: DeepDiscoverSession[]): void {
	writeJsonStorage(STORAGE_KEY, sessions.slice(0, MAX_SESSIONS));
}

const initialSessions = loadPersistedSessions();

let storeState: DeepDiscoverStoreState = {
	sessions: initialSessions,
	activeSessionId: initialSessions[0]?.id ?? null,
	agents: [],
	defaultAgentId: null,
	selectedAgentId: initialSessions[0]?.agentId ?? null,
	selectedModelId: initialSessions[0]?.modelId ?? null,
	modelsByAgent: {},
	runningRuntimeSessionId: null,
	runningExplorationId: null,
};

const listeners = new Set<() => void>();

function emitChange(): void {
	for (const l of listeners) l();
}

function updateState(
	updater: (prev: DeepDiscoverStoreState) => DeepDiscoverStoreState,
	persist = false,
): void {
	const next = updater(storeState);
	if (next === storeState) return;
	storeState = next;
	if (persist) persistSessions(next.sessions);
	emitChange();
}

function updateExplorationById(
	explorationId: string,
	updater: (session: DeepDiscoverSession) => DeepDiscoverSession,
	persist = true,
): void {
	updateState((prev) => {
		const idx = prev.sessions.findIndex((s) => s.id === explorationId);
		if (idx < 0) return prev;
		const updated = updater(prev.sessions[idx]);
		const nextSessions = [...prev.sessions];
		nextSessions[idx] = updated;
		return { ...prev, sessions: nextSessions };
	}, persist);
}

let listenersAttached = false;

function ensureAgentListenersAttached(): void {
	if (listenersAttached || !isTauri()) return;
	listenersAttached = true;

	void listenAgentStream((ev) => {
		if (ev.sessionId !== storeState.runningRuntimeSessionId) return;
		const expId = storeState.runningExplorationId;
		if (!expId) return;
		updateExplorationById(
			expId,
			(session) => {
				const msgs = [...session.messages];
				const lastIdx = msgs.length - 1;
				if (lastIdx < 0 || msgs[lastIdx].role !== "assistant") return session;
				const last = msgs[lastIdx];
				if (ev.kind === "thought") {
					msgs[lastIdx] = {
						...last,
						reasoning: `${last.reasoning ?? ""}${ev.chunk}`,
					};
				} else {
					msgs[lastIdx] = {
						...last,
						content: `${last.content}${ev.chunk}`,
					};
				}
				return { ...session, messages: msgs };
			},
			false,
		);
	});

	void listenAgentTool((ev: AgentToolEvent) => {
		if (ev.sessionId !== storeState.runningRuntimeSessionId) return;
		const expId = storeState.runningExplorationId;
		if (!expId) return;
		updateExplorationById(
			expId,
			(session) => {
				const msgs = [...session.messages];
				const lastIdx = msgs.length - 1;
				if (lastIdx < 0 || msgs[lastIdx].role !== "assistant") return session;
				const last = msgs[lastIdx];
				const tools = [...(last.toolCalls ?? [])];
				const existingIdx = tools.findIndex((t) => t.id === ev.toolCallId);

				let mergedTool: DeepToolCallRecord;
				if (existingIdx >= 0) {
					const prevTool = tools[existingIdx];
					mergedTool = {
						id: ev.toolCallId,
						title: ev.title ?? prevTool.title,
						kind: ev.kind ?? prevTool.kind,
						status: ev.status ?? prevTool.status,
						input: ev.input !== undefined ? ev.input : prevTool.input,
						output: ev.output !== undefined ? ev.output : prevTool.output,
					};
					tools[existingIdx] = mergedTool;
				} else {
					mergedTool = {
						id: ev.toolCallId,
						title: ev.title ?? "tool",
						kind: ev.kind ?? "mcp",
						status: ev.status ?? "in_progress",
						input: ev.input,
						output: ev.output,
					};
					tools.push(mergedTool);
				}

				let nextSession: DeepDiscoverSession = {
					...session,
					messages: msgs.map((m, i) =>
						i === lastIdx ? { ...m, toolCalls: tools } : m,
					),
				};

				if (
					mergedTool.output !== undefined ||
					mergedTool.status === "completed"
				) {
					const applied = applyCollectionToolOutputToSession(
						nextSession,
						mergedTool.title,
						mergedTool.output,
						mergedTool.input,
					);
					nextSession = applied.session;
					if (applied.suggestedFollowUps) {
						nextSession = {
							...nextSession,
							messages: nextSession.messages.map((m, i) =>
								i === lastIdx
									? { ...m, suggestedFollowUps: applied.suggestedFollowUps }
									: m,
							),
						};
					}
				}

				return nextSession;
			},
			true,
		);
	});

	void listenAgentSessionInfo((ev) => {
		if (ev.sessionId !== storeState.runningRuntimeSessionId) return;
		const expId = storeState.runningExplorationId;
		if (!expId || !ev.providerSessionId) return;
		updateExplorationById(
			expId,
			(session) => ({
				...session,
				providerSessionId: ev.providerSessionId ?? session.providerSessionId,
			}),
			true,
		);
	});

	void listenAgentModels((ev) => {
		if (!ev.agentId || !Array.isArray(ev.models)) return;
		saveModelCatalog(ev.agentId, {
			configId: ev.configId,
			currentId: ev.currentId,
			models: ev.models,
		});
		updateState((prev) => ({
			...prev,
			modelsByAgent: {
				...prev.modelsByAgent,
				[ev.agentId]: ev.models,
			},
			selectedModelId:
				prev.selectedAgentId === ev.agentId && !prev.selectedModelId
					? ev.currentId || ev.models[0]?.id || null
					: prev.selectedModelId,
		}));
	});

	void listenAgentCompleted((ev) => {
		if (ev.sessionId !== storeState.runningRuntimeSessionId) return;
		const expId = storeState.runningExplorationId;
		if (expId) {
			updateExplorationById(
				expId,
				(session) => {
					const msgs = [...session.messages];
					const lastIdx = msgs.length - 1;
					if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
						const last = msgs[lastIdx];
						msgs[lastIdx] = {
							...last,
							content: last.content.trim() ? last.content : ev.content,
							reasoning: last.reasoning ?? ev.reasoning ?? undefined,
							streaming: false,
						};
					}
					return {
						...session,
						providerSessionId:
							ev.providerSessionId ?? session.providerSessionId,
						messages: msgs,
						updatedAt: new Date().toISOString(),
					};
				},
				true,
			);
		}
		updateState((prev) => ({
			...prev,
			runningRuntimeSessionId: null,
			runningExplorationId: null,
		}));
	});

	void listenAgentFailed((ev) => {
		if (ev.sessionId !== storeState.runningRuntimeSessionId) return;
		const expId = storeState.runningExplorationId;
		if (expId) {
			updateExplorationById(
				expId,
				(session) => {
					const msgs = [...session.messages];
					const lastIdx = msgs.length - 1;
					if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
						msgs[lastIdx] = {
							...msgs[lastIdx],
							streaming: false,
							error: ev.error,
						};
					}
					return {
						...session,
						messages: msgs,
						updatedAt: new Date().toISOString(),
					};
				},
				true,
			);
		}
		updateState((prev) => ({
			...prev,
			runningRuntimeSessionId: null,
			runningExplorationId: null,
		}));
		notifyError(ev.error);
	});
}

export function getDeepDiscoverState(): DeepDiscoverStoreState {
	return storeState;
}

export function subscribeDeepDiscoverState(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export async function initDeepDiscoverAgents(): Promise<void> {
	if (!isTauri()) return;
	ensureAgentListenersAttached();
	try {
		const res = await listAgents();
		const available = res.agents.filter((a) => a.available);
		const chosenAgentId =
			(storeState.selectedAgentId &&
			available.some((a) => a.id === storeState.selectedAgentId)
				? storeState.selectedAgentId
				: null) ??
			(res.defaultId && available.some((a) => a.id === res.defaultId)
				? res.defaultId
				: null) ??
			available[0]?.id ??
			null;

		const modelsByAgent: Record<string, AgentModelChoice[]> = {
			...storeState.modelsByAgent,
		};
		for (const agent of available) {
			const cached = loadModelCatalog(agent.id);
			if (cached?.models?.length) {
				modelsByAgent[agent.id] = cached.models;
			}
		}

		const prefModel = chosenAgentId
			? (loadModelPref(chosenAgentId) ??
				loadModelCatalog(chosenAgentId)?.currentId ??
				null)
			: null;

		updateState((prev) => ({
			...prev,
			agents: available,
			defaultAgentId: res.defaultId,
			selectedAgentId: chosenAgentId,
			selectedModelId: prev.selectedModelId ?? prefModel,
			modelsByAgent,
		}));

		if (chosenAgentId && !modelsByAgent[chosenAgentId]?.length) {
			void warmAgent({ agentId: chosenAgentId }).catch(() => undefined);
		}
	} catch {
		// Ignore when no agent configured yet
	}
}

export function setDeepDiscoverAgent(agentId: string): void {
	const cached = loadModelCatalog(agentId);
	const nextModel =
		loadModelPref(agentId) ??
		cached?.currentId ??
		cached?.models?.[0]?.id ??
		null;
	updateState((prev) => ({
		...prev,
		selectedAgentId: agentId,
		selectedModelId: nextModel,
	}));
	if (isTauri() && !storeState.modelsByAgent[agentId]?.length) {
		void warmAgent({ agentId }).catch(() => undefined);
	}
}

export function setDeepDiscoverModel(modelId: string): void {
	const agentId = storeState.selectedAgentId;
	if (agentId && modelId) {
		saveModelPref(agentId, modelId);
	}
	updateState((prev) => ({
		...prev,
		selectedModelId: modelId || null,
	}));
}

export function createDeepDiscoverSession(): DeepDiscoverSession {
	const now = new Date().toISOString();
	const session: DeepDiscoverSession = {
		id: makeId("deep"),
		title: "",
		createdAt: now,
		updatedAt: now,
		agentId: storeState.selectedAgentId,
		modelId: storeState.selectedModelId,
		providerSessionId: null,
		messages: [],
		curatedGroups: [],
		pinnedIds: [],
		sampledIds: [],
	};
	updateState(
		(prev) => ({
			...prev,
			sessions: [session, ...prev.sessions].slice(0, MAX_SESSIONS),
			activeSessionId: session.id,
		}),
		true,
	);
	return session;
}

export function selectDeepDiscoverSession(sessionId: string): void {
	const found = storeState.sessions.find((s) => s.id === sessionId);
	if (!found) return;
	updateState((prev) => ({
		...prev,
		activeSessionId: found.id,
		selectedAgentId: found.agentId ?? prev.selectedAgentId,
		selectedModelId: found.modelId ?? prev.selectedModelId,
	}));
}

export function deleteDeepDiscoverSession(sessionId: string): void {
	if (
		storeState.runningExplorationId === sessionId &&
		storeState.runningRuntimeSessionId
	) {
		void cancelAgentRun(storeState.runningRuntimeSessionId).catch(
			() => undefined,
		);
	}
	updateState((prev) => {
		const remaining = prev.sessions.filter((s) => s.id !== sessionId);
		const nextActive =
			prev.activeSessionId === sessionId
				? (remaining[0]?.id ?? null)
				: prev.activeSessionId;
		return {
			...prev,
			sessions: remaining,
			activeSessionId: nextActive,
			runningExplorationId:
				prev.runningExplorationId === sessionId
					? null
					: prev.runningExplorationId,
			runningRuntimeSessionId:
				prev.runningExplorationId === sessionId
					? null
					: prev.runningRuntimeSessionId,
		};
	}, true);
}

export function togglePinDeepPaper(
	explorationId: string,
	paperId: string,
): void {
	updateExplorationById(
		explorationId,
		(session) => {
			const has = session.pinnedIds.includes(paperId);
			const pinnedIds = has
				? session.pinnedIds.filter((id) => id !== paperId)
				: [...session.pinnedIds, paperId];
			return { ...session, pinnedIds };
		},
		true,
	);
}

function buildPriorTranscript(messages: DeepChatMessage[]): string | undefined {
	const completed = messages.filter(
		(m) => !m.streaming && m.content.trim().length > 0,
	);
	if (completed.length === 0) return undefined;
	const lines = completed.slice(-10).map((m) => {
		const speaker = m.role === "user" ? "User" : "Assistant";
		const body =
			m.content.length > 1800 ? `${m.content.slice(0, 1800)}…` : m.content;
		return `${speaker}: ${body}`;
	});
	return `Earlier turns in this Paper Discover session:\n\n${lines.join("\n\n")}`;
}

let launchingTurn = false;

export async function sendDeepDiscoverTurn(rawPrompt: string): Promise<void> {
	const prompt = rawPrompt.trim();
	if (!prompt) return;
	if (launchingTurn || storeState.runningRuntimeSessionId) return;
	launchingTurn = true;

	ensureAgentListenersAttached();

	let session = storeState.sessions.find(
		(s) => s.id === storeState.activeSessionId,
	);
	if (!session) {
		session = createDeepDiscoverSession();
	}

	const agentChanged =
		session.agentId != null &&
		storeState.selectedAgentId != null &&
		session.agentId !== storeState.selectedAgentId;
	const resumeSessionId = agentChanged
		? undefined
		: (session.providerSessionId ?? undefined);
	const resumeTranscript = buildPriorTranscript(session.messages);

	const now = new Date().toISOString();
	const userMsg: DeepChatMessage = {
		id: makeId("usr"),
		role: "user",
		content: prompt,
		createdAt: now,
	};
	const assistantMsg: DeepChatMessage = {
		id: makeId("ast"),
		role: "assistant",
		content: "",
		toolCalls: [],
		createdAt: now,
		streaming: true,
	};

	const autoTitle =
		session.title.trim() ||
		(prompt.length > 48 ? `${prompt.slice(0, 48)}…` : prompt);

	const explorationId = session.id;
	updateExplorationById(
		explorationId,
		(prev) => ({
			...prev,
			title: autoTitle,
			updatedAt: now,
			agentId: storeState.selectedAgentId ?? prev.agentId,
			modelId: storeState.selectedModelId ?? prev.modelId,
			providerSessionId: agentChanged ? null : prev.providerSessionId,
			messages: [...prev.messages, userMsg, assistantMsg],
		}),
		true,
	);

	try {
		const accepted = await runOnce({
			agentId: storeState.selectedAgentId ?? undefined,
			sessionId: resumeSessionId,
			prompt,
			workflow: "plaza_deep_discover",
			modelId: storeState.selectedModelId ?? undefined,
			permissionMode: "auto",
			hideFromChatHistory: true,
			resumeTranscript,
		});

		updateState((prev) => ({
			...prev,
			runningRuntimeSessionId: accepted.sessionId,
			runningExplorationId: explorationId,
		}));
	} catch (err) {
		const msg = errorText(err);
		updateExplorationById(
			explorationId,
			(prev) => ({
				...prev,
				messages: prev.messages.map((m) =>
					m.id === assistantMsg.id ? { ...m, streaming: false, error: msg } : m,
				),
			}),
			true,
		);
		notifyError(msg);
	} finally {
		launchingTurn = false;
	}
}

export async function stopDeepDiscoverTurn(): Promise<void> {
	const runtimeId = storeState.runningRuntimeSessionId;
	const expId = storeState.runningExplorationId;
	if (!runtimeId) return;
	try {
		await cancelAgentRun(runtimeId);
	} catch (err) {
		notifyError(errorText(err));
	} finally {
		if (expId) {
			updateExplorationById(
				expId,
				(prev) => ({
					...prev,
					messages: prev.messages.map((m) =>
						m.streaming ? { ...m, streaming: false } : m,
					),
				}),
				true,
			);
		}
		updateState((prev) => ({
			...prev,
			runningRuntimeSessionId: null,
			runningExplorationId: null,
		}));
	}
}
