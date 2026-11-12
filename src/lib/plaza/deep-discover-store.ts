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
/** Per-session tray cap; the oldest unkept History entries go first. */
const MAX_TRAY_ENTRIES = 400;

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
	/** User turn only: selected paper IDs attached as reference context. */
	referenceIds?: string[];
	createdAt: string;
	streaming?: boolean;
	error?: string;
};

/**
 * One paper in the Deep Search tray. `turnId` is the assistant message of the
 * latest turn that surfaced it: the latest turn is `This turn`, older ones are
 * `History`. `kept` is the user's selection (checkbox or Agent `keep: true`),
 * attached to the next prompt as reference.
 */
export type DeepTrayEntry = {
	id: string;
	turnId: string;
	reason?: string;
	group?: string;
	kept?: boolean;
	keptAt?: string;
};

export type DeepReferencePaper = { id: string; title: string };

export type DeepDiscoverSession = {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	agentId: string | null;
	modelId: string | null;
	providerSessionId: string | null;
	messages: DeepChatMessage[];
	tray: DeepTrayEntry[];
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

type CurateItem = {
	id: string;
	reason?: string;
	group: string;
	keep: boolean;
};

function trimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(trimmedString).filter((s): s is string => s !== undefined);
}

function normalizeCurateItems(rawGroups: unknown): CurateItem[] {
	if (!Array.isArray(rawGroups)) return [];
	const items: CurateItem[] = [];
	const seen = new Set<string>();
	for (const g of rawGroups) {
		if (!g || typeof g !== "object") continue;
		const rec = g as Record<string, unknown>;
		const group = trimmedString(rec.label) ?? "";
		for (const it of Array.isArray(rec.items) ? rec.items : []) {
			if (!it || typeof it !== "object") continue;
			const itemRec = it as Record<string, unknown>;
			const id = trimmedString(itemRec.id);
			if (!id || seen.has(id)) continue;
			seen.add(id);
			items.push({
				id,
				reason: trimmedString(itemRec.reason),
				group,
				keep: itemRec.keep === true,
			});
		}
	}
	return items;
}

/** Assistant message id of the latest turn; tray entries with it form `This turn`. */
export function currentDeepTurnId(session: DeepDiscoverSession): string | null {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		if (session.messages[i].role === "assistant") return session.messages[i].id;
	}
	return null;
}

function capTray(entries: DeepTrayEntry[], turnId: string): DeepTrayEntry[] {
	let overflow = entries.length - MAX_TRAY_ENTRIES;
	if (overflow <= 0) return entries;
	return entries.filter((e) => {
		if (overflow > 0 && !e.kept && e.turnId !== turnId) {
			overflow--;
			return false;
		}
		return true;
	});
}

/**
 * Merge one `collection_curate` call into the tray: every curated paper moves
 * to the current turn (re-surfaced History papers included), `keep: true`
 * selects it, and `unkeepIds` clear the selection. Calls within one turn merge.
 */
function applyCurateToTray(
	tray: DeepTrayEntry[],
	turnId: string,
	items: CurateItem[],
	unkeepIds: string[],
	now: string,
): DeepTrayEntry[] {
	const unkeep = new Set(unkeepIds);
	const byId = new Map(tray.map((e) => [e.id, e]));
	const incoming = new Set(items.map((it) => it.id));
	const next = tray
		.filter((e) => !incoming.has(e.id))
		.map((e) =>
			unkeep.has(e.id) && e.kept ? { ...e, kept: false, keptAt: undefined } : e,
		);
	for (const it of items) {
		const prev = byId.get(it.id);
		const kept = it.keep || (prev?.kept === true && !unkeep.has(it.id));
		next.push({
			id: it.id,
			turnId,
			reason: it.reason ?? prev?.reason,
			group: it.group || prev?.group,
			kept: kept || undefined,
			keptAt: kept ? (prev?.kept ? prev.keptAt : now) : undefined,
		});
	}
	return capTray(next, turnId);
}

/**
 * Pure reducer that applies `agentero-collection` `collection_curate` output
 * (or its input as fallback) to the session tray and returns follow-up pills.
 */
export function applyCollectionToolOutputToSession(
	session: DeepDiscoverSession,
	toolTitle: string,
	rawOutput: unknown,
	rawInput?: unknown,
): { session: DeepDiscoverSession; suggestedFollowUps?: string[] } {
	const isCurate = toolTitle.toLowerCase().includes("collection_curate");
	const fromOutput = extractMcpToolJsonPayload(rawOutput);
	const payload =
		fromOutput && Array.isArray(fromOutput.groups)
			? fromOutput
			: isCurate
				? extractMcpToolJsonPayload(rawInput)
				: null;
	if (!payload || !Array.isArray(payload.groups)) return { session };
	const turnId = currentDeepTurnId(session);
	if (!turnId) return { session };

	const items = normalizeCurateItems(payload.groups);
	const unkeepIds = stringList(payload.unkeepIds);
	const followUps = stringList(payload.suggestedFollowUps).slice(0, 6);
	if (items.length === 0 && unkeepIds.length === 0) {
		return {
			session,
			suggestedFollowUps: followUps.length > 0 ? followUps : undefined,
		};
	}
	const now = new Date().toISOString();
	return {
		session: {
			...session,
			tray: applyCurateToTray(session.tray, turnId, items, unkeepIds, now),
			updatedAt: now,
		},
		suggestedFollowUps: followUps.length > 0 ? followUps : undefined,
	};
}

/** Prompt suffix carrying the user's selection; the envelope documents the tag. */
export function buildSelectedPapersBlock(
	papers: readonly DeepReferencePaper[],
): string {
	if (papers.length === 0) return "";
	const lines = papers.map((p) => `- \`${p.id}\` ${p.title}`);
	return `\n\n<selected_papers>\n${lines.join("\n")}\n</selected_papers>`;
}

type LegacySession = Partial<DeepDiscoverSession> & {
	curatedGroups?: Array<{
		label?: string;
		items?: Array<{ id?: string; reason?: string }>;
	}>;
	pinnedIds?: string[];
};

/** Convert pre-tray sessions (`curatedGroups` / `pinnedIds` / `sampledIds`). */
function migrateLegacyTray(
	s: LegacySession,
	messages: DeepChatMessage[],
): DeepTrayEntry[] {
	if (Array.isArray(s.tray)) return s.tray;
	const turnId =
		[...messages].reverse().find((m) => m.role === "assistant")?.id ?? "";
	const pinned = new Set(Array.isArray(s.pinnedIds) ? s.pinnedIds : []);
	const tray: DeepTrayEntry[] = [];
	const seen = new Set<string>();
	for (const g of Array.isArray(s.curatedGroups) ? s.curatedGroups : []) {
		for (const it of Array.isArray(g?.items) ? g.items : []) {
			const id = trimmedString(it?.id);
			if (!id || seen.has(id)) continue;
			seen.add(id);
			const kept = pinned.has(id);
			tray.push({
				id,
				turnId,
				reason: trimmedString(it.reason),
				group: trimmedString(g.label),
				kept: kept || undefined,
				keptAt: kept ? s.updatedAt : undefined,
			});
		}
	}
	return tray;
}

// ─── Reactive Store ───

function loadPersistedSessions(): DeepDiscoverSession[] {
	const raw = readJsonStorage<LegacySession[]>(STORAGE_KEY, []);
	if (!Array.isArray(raw)) return [];
	return raw
		.filter(
			(s): s is LegacySession & { id: string; messages: DeepChatMessage[] } =>
				Boolean(s) && typeof s.id === "string" && Array.isArray(s.messages),
		)
		.map((s) => {
			const messages = s.messages.map((m) =>
				m.streaming ? { ...m, streaming: false } : m,
			);
			return {
				id: s.id,
				title: s.title ?? "",
				createdAt: s.createdAt ?? "",
				updatedAt: s.updatedAt ?? "",
				agentId: s.agentId ?? null,
				modelId: s.modelId ?? null,
				providerSessionId: s.providerSessionId ?? null,
				messages,
				tray: migrateLegacyTray(s, messages),
			};
		});
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
		tray: [],
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

/** Check / uncheck tray papers; checked papers are attached to the next prompt. */
export function setDeepPapersKept(
	explorationId: string,
	paperIds: readonly string[],
	kept: boolean,
): void {
	if (paperIds.length === 0) return;
	const ids = new Set(paperIds);
	const now = new Date().toISOString();
	updateExplorationById(
		explorationId,
		(session) => ({
			...session,
			tray: session.tray.map((e) => {
				if (!ids.has(e.id) || Boolean(e.kept) === kept) return e;
				return kept
					? { ...e, kept: true, keptAt: now }
					: { ...e, kept: undefined, keptAt: undefined };
			}),
		}),
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

export async function sendDeepDiscoverTurn(
	rawPrompt: string,
	references: readonly DeepReferencePaper[] = [],
): Promise<void> {
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
		referenceIds:
			references.length > 0 ? references.map((p) => p.id) : undefined,
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
			prompt: `${prompt}${buildSelectedPapersBlock(references)}`,
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
