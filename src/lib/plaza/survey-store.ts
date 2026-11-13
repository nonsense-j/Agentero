/**
 * Plaza — `Paper Survey` run store.
 *
 * One-shot ACP runs on the `plaza_survey` workflow (read-only
 * `agentero-collection` MCP, hidden from Agent chat history). Runs persist
 * under `plaza:survey:runs:v1`; report HTML lives in the vault's
 * `.agentero/surveys/` (app data without a vault) and is copied to the app
 * cache right before opening it in the default browser.
 */

import { appCacheDir, appDataDir } from "@tauri-apps/api/path";
import { create } from "zustand";
import i18n from "@/i18n";
import {
	type AgentDescriptor,
	type AgentModelChoice,
	type AgentToolEvent,
	cancelAgentRun,
	listAgents,
	listenAgentCompleted,
	listenAgentFailed,
	listenAgentModels,
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
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { basenameOf, joinPath } from "@/lib/core/path";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import { isTauri } from "@/lib/core/tauri";
import { libraryStore, refreshLibrary } from "@/lib/paper/library-store";
import type { PaperMetadata } from "@/lib/paper/types";
import { getCollectionPaperDetail } from "@/lib/plaza/collection-store";
import { buildSeedContexts } from "@/lib/plaza/survey-context";
import {
	buildCitations,
	buildSurveyLatex,
	renderReportHtml,
	type SurveyCitationMeta,
} from "@/lib/plaza/survey-export";
import {
	orderedCiteIds,
	type ParsedSurvey,
	parseSurveyOutput,
	type SurveyParseErrorCode,
	type SurveyRawReference,
} from "@/lib/plaza/survey-parse";
import { buildSurveyPrompt, SURVEY_WORKFLOW } from "@/lib/plaza/survey-prompt";
import type {
	SurveyPhase,
	SurveyResult,
	SurveyRun,
	SurveySeedPaper,
	SurveyStartInput,
	SurveyToolCall,
} from "@/lib/plaza/survey-types";
import { readVaultFile, removeVaultPath, writeVaultFile } from "@/lib/vault/fs";
import { joinVaultPath } from "@/lib/vault/path";
import { getVaultPath } from "@/lib/vault/store";

const STORAGE_KEY = "plaza:survey:runs:v1";
const MAX_RUNS = 30;
const MAX_REASONING_CHARS = 20_000;
/** Raw reply kept only for failed parses (diagnostics). */
const MAX_FAILED_CONTENT_CHARS = 60_000;
const SURVEY_DIR = "surveys";

export type PaperSurveyState = {
	/** Newest first. */
	runs: SurveyRun[];
	activeRunId: string | null;
	agents: AgentDescriptor[];
	defaultAgentId: string | null;
	selectedAgentId: string | null;
	selectedModelId: string | null;
	modelsByAgent: Record<string, AgentModelChoice[]>;
};

const PARSE_ERROR_TEXT: Record<SurveyParseErrorCode, () => string> = {
	noJson: () => i18n.t("sidebar:plaza.survey.parseError.noJson"),
	badJson: () => i18n.t("sidebar:plaza.survey.parseError.badJson"),
	noParagraphs: () => i18n.t("sidebar:plaza.survey.parseError.noParagraphs"),
	noHtml: () => i18n.t("sidebar:plaza.survey.parseError.noHtml"),
};

function makeId(): string {
	return `survey_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
	return new Date().toISOString();
}

// ─── Persistence ───

function loadRuns(): SurveyRun[] {
	const raw = readJsonStorage<SurveyRun[]>(STORAGE_KEY, []);
	if (!Array.isArray(raw)) return [];
	return raw
		.filter(
			(r): r is SurveyRun =>
				Boolean(r) && typeof r.id === "string" && typeof r.topic === "string",
		)
		.map((r) =>
			// A run cannot survive an app restart: its ACP session is gone.
			r.status === "running" ? { ...r, status: "cancelled" } : r,
		);
}

function persistRuns(runs: SurveyRun[]): void {
	writeJsonStorage(STORAGE_KEY, runs.slice(0, MAX_RUNS));
}

const initialRuns = loadRuns();

export const usePaperSurveyStore = create<PaperSurveyState>(() => ({
	runs: initialRuns,
	activeRunId: initialRuns[0]?.id ?? null,
	agents: [],
	defaultAgentId: null,
	selectedAgentId: initialRuns[0]?.agentId ?? null,
	selectedModelId: initialRuns[0]?.modelId ?? null,
	modelsByAgent: {},
}));

function getRun(runId: string): SurveyRun | undefined {
	return usePaperSurveyStore.getState().runs.find((r) => r.id === runId);
}

function updateRun(
	runId: string,
	updater: (run: SurveyRun) => SurveyRun,
	persist = true,
): void {
	const { runs } = usePaperSurveyStore.getState();
	const idx = runs.findIndex((r) => r.id === runId);
	if (idx < 0) return;
	const next = [...runs];
	next[idx] = updater(runs[idx]);
	usePaperSurveyStore.setState({ runs: next });
	if (persist) persistRuns(next);
}

// ─── Runtime session mapping ───

/** ACP runtime session id → survey run id (runs may overlap). */
const runtimeToRun = new Map<string, string>();

function runtimeOf(runId: string): string | undefined {
	for (const [runtime, id] of runtimeToRun) if (id === runId) return runtime;
	return undefined;
}

function toolDetail(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const obj = input as Record<string, unknown>;
	const value = obj.query ?? obj.paperIds ?? obj.ids ?? obj.q;
	const text = Array.isArray(value)
		? value.join(", ")
		: typeof value === "string"
			? value
			: undefined;
	if (!text?.trim()) return undefined;
	return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function looksLikeFinalOutput(content: string): boolean {
	return /```survey-json|<!doctype html/i.test(content);
}

let listenersAttached = false;

function ensureListeners(): void {
	if (listenersAttached || !isTauri()) return;
	listenersAttached = true;

	void listenAgentStream((ev) => {
		const runId = runtimeToRun.get(ev.sessionId);
		if (!runId) return;
		updateRun(
			runId,
			(run) => {
				if (ev.kind === "thought") {
					return {
						...run,
						reasoning: `${run.reasoning}${ev.chunk}`.slice(
							-MAX_REASONING_CHARS,
						),
					};
				}
				const content = `${run.content}${ev.chunk}`;
				const phase: SurveyPhase = looksLikeFinalOutput(content)
					? "writing"
					: run.phase;
				return { ...run, content, phase };
			},
			false,
		);
	});

	void listenAgentTool((ev: AgentToolEvent) => {
		const runId = runtimeToRun.get(ev.sessionId);
		if (!runId) return;
		updateRun(runId, (run) => {
			const tools = [...run.toolCalls];
			const idx = tools.findIndex((tc) => tc.id === ev.toolCallId);
			const prev = idx >= 0 ? tools[idx] : undefined;
			const merged: SurveyToolCall = {
				id: ev.toolCallId,
				title: ev.title ?? prev?.title ?? "tool",
				kind: ev.kind ?? prev?.kind ?? "mcp",
				status: ev.status ?? prev?.status ?? "in_progress",
				detail: toolDetail(ev.input) ?? prev?.detail,
			};
			if (idx >= 0) tools[idx] = merged;
			else tools.push(merged);
			return {
				...run,
				toolCalls: tools,
				phase: run.phase === "preparing" ? "researching" : run.phase,
				updatedAt: nowIso(),
			};
		});
	});

	void listenAgentModels((ev) => {
		if (!ev.agentId || !Array.isArray(ev.models)) return;
		saveModelCatalog(ev.agentId, {
			configId: ev.configId,
			currentId: ev.currentId,
			models: ev.models,
		});
		usePaperSurveyStore.setState((prev) => ({
			modelsByAgent: { ...prev.modelsByAgent, [ev.agentId]: ev.models },
			selectedModelId:
				prev.selectedAgentId === ev.agentId && !prev.selectedModelId
					? ev.currentId || ev.models[0]?.id || null
					: prev.selectedModelId,
		}));
	});

	void listenAgentCompleted((ev) => {
		const runId = runtimeToRun.get(ev.sessionId);
		if (!runId) return;
		runtimeToRun.delete(ev.sessionId);
		const run = getRun(runId);
		if (run?.status !== "running") return;
		const content = run.content.trim() ? run.content : (ev.content ?? "");
		updateRun(runId, (r) => ({
			...r,
			content,
			reasoning:
				r.reasoning || (ev.reasoning ?? "").slice(-MAX_REASONING_CHARS),
			phase: "finalizing",
		}));
		void finalizeRun(runId, content);
	});

	void listenAgentFailed((ev) => {
		const runId = runtimeToRun.get(ev.sessionId);
		if (!runId) return;
		runtimeToRun.delete(ev.sessionId);
		failRun(runId, ev.error);
	});
}

function failRun(runId: string, message: string): void {
	updateRun(runId, (run) => ({
		...run,
		status: "failed",
		error: message,
		content: run.content.slice(-MAX_FAILED_CONTENT_CHARS),
		updatedAt: nowIso(),
	}));
	notifyError(message);
}

// ─── Agents ───

export async function initSurveyAgents(): Promise<void> {
	if (!isTauri()) return;
	ensureListeners();
	try {
		const res = await listAgents();
		const available = res.agents.filter((a) => a.available);
		const state = usePaperSurveyStore.getState();
		const has = (id: string | null) =>
			Boolean(id && available.some((a) => a.id === id));
		const chosen =
			(has(state.selectedAgentId) ? state.selectedAgentId : null) ??
			(has(res.defaultId) ? res.defaultId : null) ??
			available[0]?.id ??
			null;
		const modelsByAgent = { ...state.modelsByAgent };
		for (const agent of available) {
			const cached = loadModelCatalog(agent.id);
			if (cached?.models?.length) modelsByAgent[agent.id] = cached.models;
		}
		const prefModel = chosen
			? (loadModelPref(chosen) ?? loadModelCatalog(chosen)?.currentId ?? null)
			: null;
		usePaperSurveyStore.setState((prev) => ({
			agents: available,
			defaultAgentId: res.defaultId,
			selectedAgentId: chosen,
			selectedModelId:
				prev.selectedAgentId === chosen
					? (prev.selectedModelId ?? prefModel)
					: prefModel,
			modelsByAgent,
		}));
		if (chosen && !modelsByAgent[chosen]?.length) {
			void warmAgent({ agentId: chosen }).catch(() => undefined);
		}
	} catch {
		// No agent configured yet.
	}
}

export function setSurveyAgent(agentId: string): void {
	const cached = loadModelCatalog(agentId);
	usePaperSurveyStore.setState({
		selectedAgentId: agentId,
		selectedModelId:
			loadModelPref(agentId) ??
			cached?.currentId ??
			cached?.models?.[0]?.id ??
			null,
	});
	if (
		isTauri() &&
		!usePaperSurveyStore.getState().modelsByAgent[agentId]?.length
	) {
		void warmAgent({ agentId }).catch(() => undefined);
	}
}

export function setSurveyModel(modelId: string): void {
	const agentId = usePaperSurveyStore.getState().selectedAgentId;
	if (agentId && modelId) saveModelPref(agentId, modelId);
	usePaperSurveyStore.setState({ selectedModelId: modelId || null });
}

// ─── Library ───

/** Load the vault catalog for the paper picker when it is not loaded yet. */
export async function ensureSurveyLibraryLoaded(): Promise<void> {
	const vault = getVaultPath();
	if (!vault) return;
	const { loadedVaultPath, loading } = libraryStore.getState();
	if (loadedVaultPath === vault || loading) return;
	await refreshLibrary();
}

function libraryPaperByPath(path: string): PaperMetadata | undefined {
	const { paperMetaByRelPath, papers } = libraryStore.getState();
	const norm = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return paperMetaByRelPath.get(norm) ?? papers.find((p) => p.path === path);
}

// ─── Run lifecycle ───

export function selectSurveyRun(runId: string | null): void {
	usePaperSurveyStore.setState({ activeRunId: runId });
}

/** Library seeds in selection order; loads the catalog once if needed. */
async function resolveSeedPapers(paths: string[]): Promise<PaperMetadata[]> {
	let papers = paths.map(libraryPaperByPath);
	if (papers.some((p) => !p)) {
		await ensureSurveyLibraryLoaded();
		papers = paths.map(libraryPaperByPath);
	}
	return papers.filter((p): p is PaperMetadata => Boolean(p));
}

export async function startSurvey(
	input: SurveyStartInput,
): Promise<string | null> {
	const topic = input.topic.trim();
	if (!topic) {
		notifyError(i18n.t("sidebar:plaza.survey.errors.noTopic"));
		return null;
	}
	if (!isTauri()) {
		notifyError(i18n.t("sidebar:plaza.survey.errors.desktopOnly"));
		return null;
	}
	const papers = await resolveSeedPapers([...new Set(input.paperPaths)]);
	if (papers.length === 0) {
		notifyError(i18n.t("sidebar:plaza.survey.errors.noPapers"));
		return null;
	}
	ensureListeners();

	const state = usePaperSurveyStore.getState();
	const agentId = input.agentId ?? state.selectedAgentId;
	const modelId = input.modelId ?? state.selectedModelId;
	const vaultPath = getVaultPath();
	const now = nowIso();
	const seeds: SurveySeedPaper[] = papers.map((p) => ({
		path: p.path,
		id: p.id,
		title: p.title,
		authors: p.authors,
		year: p.year ?? null,
	}));
	const run: SurveyRun = {
		id: makeId(),
		topic,
		format: input.format,
		seeds,
		vaultPath,
		agentId,
		modelId,
		status: "running",
		phase: "preparing",
		createdAt: now,
		updatedAt: now,
		reasoning: "",
		content: "",
		toolCalls: [],
	};
	const runs = [run, ...state.runs].slice(0, MAX_RUNS);
	usePaperSurveyStore.setState({ runs, activeRunId: run.id });
	persistRuns(runs);

	try {
		const contexts = await buildSeedContexts(vaultPath, papers);
		if (getRun(run.id)?.status !== "running") return run.id;
		const accepted = await runOnce({
			agentId: agentId ?? undefined,
			modelId: modelId ?? undefined,
			prompt: buildSurveyPrompt({
				topic,
				format: input.format,
				seeds: contexts,
			}),
			workflow: SURVEY_WORKFLOW,
			permissionMode: "auto",
			hideFromChatHistory: true,
		});
		if (getRun(run.id)?.status !== "running") {
			// Cancelled or removed while the session was starting.
			void cancelAgentRun(accepted.sessionId).catch(() => undefined);
			return run.id;
		}
		runtimeToRun.set(accepted.sessionId, run.id);
	} catch (err) {
		failRun(run.id, errorText(err));
	}
	return run.id;
}

export async function cancelSurvey(runId: string): Promise<void> {
	const runtime = runtimeOf(runId);
	if (runtime) runtimeToRun.delete(runtime);
	if (getRun(runId)?.status === "running") {
		updateRun(runId, (run) => ({
			...run,
			status: "cancelled",
			updatedAt: nowIso(),
		}));
	}
	if (!runtime) return;
	try {
		await cancelAgentRun(runtime);
	} catch (err) {
		notifyError(errorText(err));
	}
}

export async function removeSurvey(runId: string): Promise<void> {
	const run = getRun(runId);
	if (!run) return;
	if (run.status === "running") await cancelSurvey(runId);
	const { runs, activeRunId } = usePaperSurveyStore.getState();
	const remaining = runs.filter((r) => r.id !== runId);
	usePaperSurveyStore.setState({
		runs: remaining,
		activeRunId:
			activeRunId === runId ? (remaining[0]?.id ?? null) : activeRunId,
	});
	persistRuns(remaining);
	reportHtmlCache.delete(runId);
	if (run.result?.kind === "report" && isTauri()) {
		void removeVaultPath(run.result.htmlPath).catch(() => undefined);
		void cacheCopyPath(runId)
			.then((p) => removeVaultPath(p))
			.catch(() => undefined);
	}
}

export async function rerunSurvey(runId: string): Promise<string | null> {
	const run = getRun(runId);
	if (!run) return null;
	return startSurvey({
		topic: run.topic,
		format: run.format,
		paperPaths: run.seeds.map((s) => s.path),
		agentId: run.agentId,
		modelId: run.modelId,
	});
}

// ─── Finalize: parse → resolve citations → result ───

function libraryMeta(p: PaperMetadata): SurveyCitationMeta {
	const type = p.zotero_item_type ?? "";
	return {
		source: "library",
		paperId: p.id,
		libraryPath: p.path,
		title: p.title,
		authors: p.authors,
		year: p.year ?? undefined,
		venue: p.publication ?? undefined,
		doi: p.doi ?? undefined,
		arxivId: p.arxiv_id ?? undefined,
		url: p.source_url ?? p.html_url ?? undefined,
		abstract: p.abstract ?? undefined,
		preferredKey: p.bibtex_key,
		entryType:
			type === "journalArticle"
				? "article"
				: type === "conferencePaper"
					? "inproceedings"
					: type === "preprint"
						? "misc"
						: undefined,
		volume: p.volume,
		issue: p.issue,
		pages: p.pages,
	};
}

function seedMeta(seed: SurveySeedPaper): SurveyCitationMeta {
	const paper = libraryPaperByPath(seed.path);
	if (paper) return libraryMeta(paper);
	return {
		source: "library",
		paperId: seed.id,
		libraryPath: seed.path,
		title: seed.title,
		authors: seed.authors,
		year: seed.year ?? undefined,
	};
}

async function collectionMeta(id: string): Promise<SurveyCitationMeta | null> {
	const item = await getCollectionPaperDetail(id).catch(() => null);
	if (!item) return null;
	const isPreprint = item.sourceType === "arxiv" && !item.venueFull;
	return {
		source: "collection",
		paperId: item.id,
		title: item.title,
		authors: item.authors,
		year: item.year || undefined,
		venue: isPreprint ? undefined : item.venueFull || item.sourceLabel,
		doi: item.doi,
		arxivId: item.arxivId,
		url: item.url || undefined,
		abstract: item.abstract || undefined,
		upstreamBibtex: item.bibtex,
		entryType: isPreprint
			? "misc"
			: item.venueKind === "journal"
				? "article"
				: "inproceedings",
		volume: item.volume,
		issue: item.issue,
		pages: item.pages,
	};
}

function externalMeta(ref: SurveyRawReference): SurveyCitationMeta | null {
	if (!ref.title) return null;
	return {
		source: "external",
		title: ref.title,
		authors: ref.authors ?? [],
		year: ref.year,
		venue: ref.venue,
		doi: ref.doi,
		arxivId: ref.arxivId,
		url: ref.url,
	};
}

/** Agent id → metadata, preferring Library seeds, then Collection, then the agent's own. */
async function resolveCitationMetas(
	run: SurveyRun,
	parsed: ParsedSurvey,
): Promise<Map<string, SurveyCitationMeta>> {
	const refs = new Map(parsed.references.map((r) => [r.id, r]));
	const ids = orderedCiteIds(parsed);
	const entries = await Promise.all(
		ids.map(async (id): Promise<[string, SurveyCitationMeta | null]> => {
			const seedIndex = /^s(\d+)$/i.exec(id);
			if (seedIndex) {
				const seed = run.seeds[Number(seedIndex[1]) - 1];
				if (seed) return [id, seedMeta(seed)];
			}
			const fromCollection = await collectionMeta(id);
			if (fromCollection) return [id, fromCollection];
			const ref = refs.get(id);
			return [id, ref ? externalMeta(ref) : null];
		}),
	);
	const out = new Map<string, SurveyCitationMeta>();
	for (const [id, meta] of entries) if (meta) out.set(id, meta);
	const missing = ids.filter((id) => !out.has(id));
	if (missing.length > 0) {
		console.warn("[paper-survey] dropped unresolved citations", missing);
	}
	return out;
}

/** Same paper cited under two ids (seed handle + collection id) shares one key. */
function paperIdentity(meta: SurveyCitationMeta, citeId: string): string {
	const doi = meta.doi?.toLowerCase().trim();
	if (doi) return `doi:${doi}`;
	const arxiv = meta.arxivId?.toLowerCase().replace(/v\d+$/, "").trim();
	if (arxiv) return `arxiv:${arxiv}`;
	const title = meta.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
	if (title) return `title:${title}`;
	return `id:${meta.paperId ?? citeId}`;
}

async function buildResult(
	run: SurveyRun,
	parsed: ParsedSurvey,
): Promise<SurveyResult> {
	const metas = await resolveCitationMetas(run, parsed);
	const identityToIndex = new Map<string, number>();
	const unique: SurveyCitationMeta[] = [];
	const idToUnique = new Map<string, number>();
	for (const id of orderedCiteIds(parsed)) {
		const meta = metas.get(id);
		if (!meta) continue;
		const identity = paperIdentity(meta, id);
		let idx = identityToIndex.get(identity);
		if (idx === undefined) {
			idx = unique.length;
			unique.push(meta);
			identityToIndex.set(identity, idx);
		}
		idToUnique.set(id, idx);
	}
	const citations = buildCitations(unique);
	const idToKey = new Map(
		[...idToUnique].map(([id, idx]) => [id, citations[idx].key]),
	);
	if (parsed.kind === "paragraph") {
		return {
			kind: "paragraph",
			title: parsed.title,
			paragraphs: parsed.paragraphs.map((p) =>
				p.map((s) => ({
					text: s.text,
					cites: [
						...new Set(
							s.cites
								.map((id) => idToKey.get(id))
								.filter((k): k is string => Boolean(k)),
						),
					],
				})),
			),
			citations,
		};
	}
	const html = renderReportHtml(parsed.html, citations, idToKey);
	const htmlPath = await writeReportHtml(run, html);
	reportHtmlCache.set(run.id, html);
	return {
		kind: "report",
		title: parsed.title || run.topic,
		summary: parsed.summary,
		htmlPath,
		citations,
	};
}

async function finalizeRun(runId: string, content: string): Promise<void> {
	const run = getRun(runId);
	if (!run) return;
	const parsed = parseSurveyOutput(content, run.format);
	if (!parsed.ok) {
		failRun(runId, PARSE_ERROR_TEXT[parsed.code]());
		return;
	}
	try {
		const result = await buildResult(run, parsed.value);
		if (getRun(runId)?.status !== "running") return;
		updateRun(runId, (r) => ({
			...r,
			status: "completed",
			phase: "finalizing",
			result,
			content: "",
			error: undefined,
			updatedAt: nowIso(),
		}));
	} catch (err) {
		failRun(runId, errorText(err));
	}
}

// ─── Report files ───

const reportHtmlCache = new Map<string, string>();

function reportFileName(run: SurveyRun): string {
	const slug =
		run.topic
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "survey";
	return `${slug}-${run.id.slice(-6)}.html`;
}

async function writeReportHtml(run: SurveyRun, html: string): Promise<string> {
	const name = reportFileName(run);
	if (run.vaultPath) {
		const path = joinVaultPath(
			run.vaultPath,
			`.agentero/${SURVEY_DIR}/${name}`,
		);
		try {
			await writeVaultFile(path, html);
			return path;
		} catch {
			// Remote / read-only vault: fall back to app data.
		}
	}
	const path = joinPath(joinPath(await appDataDir(), SURVEY_DIR), name);
	await writeVaultFile(path, html);
	return path;
}

async function cacheCopyPath(runId: string): Promise<string> {
	return joinPath(joinPath(await appCacheDir(), SURVEY_DIR), `${runId}.html`);
}

/** Report HTML for the in-app sandboxed preview. */
export async function loadSurveyReportHtml(runId: string): Promise<string> {
	const cached = reportHtmlCache.get(runId);
	if (cached) return cached;
	const run = getRun(runId);
	if (run?.result?.kind !== "report")
		throw new Error(i18n.t("sidebar:plaza.survey.errors.reportMissing"));
	try {
		const html = await readVaultFile(run.result.htmlPath);
		reportHtmlCache.set(runId, html);
		return html;
	} catch {
		throw new Error(i18n.t("sidebar:plaza.survey.errors.reportMissing"));
	}
}

/**
 * Open the report in the system default browser. The opener capability only
 * allows `$APPCACHE/surveys/*.html`, so a copy is written there first.
 */
export async function openSurveyReport(runId: string): Promise<void> {
	try {
		const html = await loadSurveyReportHtml(runId);
		const copy = await cacheCopyPath(runId);
		await writeVaultFile(copy, html);
		const { openPath } = await import("@tauri-apps/plugin-opener");
		await openPath(copy);
	} catch (err) {
		notifyError(errorText(err));
	}
}

// ─── LaTeX export ───

function texFileStem(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "related-work"
	);
}

/**
 * Save the subsection `.tex` and its `.bib` (same stem, same folder). If the
 * sibling `.bib` cannot be written there, a second dialog asks where to put it.
 * Returns false when the user cancels.
 */
export async function exportSurveyLatex(runId: string): Promise<boolean> {
	const run = getRun(runId);
	if (run?.result?.kind !== "paragraph") return false;
	try {
		const { save } = await import("@tauri-apps/plugin-dialog");
		const { writeTextFile } = await import("@tauri-apps/plugin-fs");
		const texPath = await save({
			defaultPath: `${texFileStem(run.result.title || run.topic)}.tex`,
			filters: [{ name: "LaTeX", extensions: ["tex"] }],
		});
		if (!texPath) return false;
		const result = run.result;
		const bib = buildSurveyLatex(result).bib;
		let bibPath = `${texPath.replace(/\.tex$/i, "")}.bib`;
		try {
			await writeTextFile(bibPath, bib);
		} catch {
			const picked = await save({
				defaultPath: basenameOf(bibPath),
				filters: [{ name: "BibTeX", extensions: ["bib"] }],
			});
			if (!picked) return false;
			bibPath = picked;
			await writeTextFile(bibPath, bib);
		}
		// The `\bibliography{…}` hint names the .bib actually written.
		const bibStem = basenameOf(bibPath).replace(/\.bib$/i, "");
		await writeTextFile(texPath, buildSurveyLatex(result, bibStem).tex);
		notifySuccess(
			i18n.t("sidebar:plaza.survey.exported", {
				tex: basenameOf(texPath),
				bib: basenameOf(bibPath),
			}),
		);
		return true;
	} catch (err) {
		notifyError(errorText(err));
		return false;
	}
}
