/**
 * Generic OpenAI-compatible helpers for academic keyword extraction across arXiv
 * and Venue papers when upstream publisher / OpenAlex keywords are absent.
 *
 * Defaults to `https://openrouter.ai/api/v1` + `baidu/ernie-5.5-flash-preview:free`
 * and works with any OpenAI-compatible endpoint (`Base URL`, `API Key`, `Model`,
 * `Batch Size`, `Concurrency`).
 *
 * On desktop (`isTauri()`), probes, `/models` fetches, and `/chat/completions`
 * execute inside the Rust Host so BYOK keys remain masked (`*`) in the WebView,
 * avoid CORS restrictions, and honor app proxy settings.
 */

import { BackgroundTaskCancelledError } from "@/lib/core/background-tasks";
import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { hasSecret, isSecretMask } from "@/lib/core/secret-mask";
import { isTauri } from "@/lib/core/tauri";
import {
	clampKeywordLlmBatchSize,
	clampKeywordLlmConcurrency,
	DEFAULT_KEYWORD_LLM_BASE_URL,
	DEFAULT_KEYWORD_LLM_BATCH_SIZE,
	DEFAULT_KEYWORD_LLM_CONCURRENCY,
	DEFAULT_KEYWORD_LLM_MODEL,
} from "@/lib/settings/defaults";
import { loadSettings } from "@/lib/settings/store";
import type { KeywordLlmSettings } from "@/lib/settings/types";
import type { ProbeStatus } from "@/lib/ui/probe-status";

export {
	DEFAULT_KEYWORD_LLM_BASE_URL,
	DEFAULT_KEYWORD_LLM_BATCH_SIZE,
	DEFAULT_KEYWORD_LLM_CONCURRENCY,
	DEFAULT_KEYWORD_LLM_MODEL,
};

export const KEYWORD_LLM_KEY_URL = "https://openrouter.ai/settings/keys";

export type KeywordLlmProbeStatus = ProbeStatus;

export type KeywordLlmInput = {
	id: string;
	title: string;
	abstract?: string;
};

export const KEYWORD_SYSTEM_PROMPT = [
	"Extract 4 to 6 canonical English academic keywords for each paper from its Title and Abstract.",
	"Rules:",
	"- Output ONLY a valid JSON object mapping each paper index string to an array of 4-6 strings, with no markdown fences and no commentary.",
	"- Cover BOTH (1) the research subfield or problem category (e.g., Code Generation, Vulnerability Detection, Program Repair, Smart Contract Security, Prompt Injection, Medical Image Segmentation) AND (2) the core technique or methodology class (e.g., Fuzzing, Random Testing, Unit Test Generation, Static Analysis, Symbolic Execution, Formal Verification, Type System, AI Agent, Low-Rank Adaptation).",
	"- Format every keyword as a general, reusable, singular noun phrase in English Title Case (1-4 words, preserving standard acronyms like LLM, RAG, eBPF, SMT) suitable for cross-paper clustering and search.",
	"- STRICTLY FORBID paper-coined system, method, tool, framework, model, dataset, or benchmark names and title acronyms (never output bespoke names like VulnGPT, AutoFuzz, Tree-of-Mutations, VulnFuzz, RankSeg).",
	"- STRICTLY FORBID generic academic filler (paper, study, method, approach, proposed, framework, system, analysis, experiment, evaluation, performance, benchmark) and overly broad top-level disciplines (Computer Science, Software Engineering, Artificial Intelligence).",
	"",
	"Example Input:",
	"[0] Title: VulnFuzz: Fuzzing Smart Contracts via Symbolic Taint Guided Mutation | Abstract: Smart contract vulnerabilities cause severe financial losses. We present VulnFuzz, combining static taint tracking with coverage-guided fuzzing and symbolic execution on EVM bytecode to uncover reentrancy and integer overflow bugs.",
	"[1] Title: RankSeg: Low-Rank Adaptation of Vision-Language Models for Few-Shot Medical Segmentation | Abstract: Adapting large vision-language foundation models to volumetric CT and MRI scans is memory intensive. We introduce RankSeg, using rank-decomposed cross-modal adapters that tune 0.8% parameters for few-shot organ segmentation.",
	"",
	"Example Output:",
	'{"0":["Smart Contract Security","Vulnerability Detection","Coverage-Guided Fuzzing","Taint Analysis","Symbolic Execution"],"1":["Medical Image Segmentation","Few-Shot Learning","Vision-Language Model","Low-Rank Adaptation","Parameter-Efficient Fine-Tuning"]}',
].join("\n");

let testConfigOverride: KeywordLlmSettings | null | undefined;

function stripTrailingCiSuffix(value: string, suffix: string): string | null {
	if (value.length < suffix.length) return null;
	if (value.slice(-suffix.length).toLowerCase() === suffix.toLowerCase()) {
		return value.slice(0, -suffix.length);
	}
	return null;
}

function resolveOpenAiCompatibleEndpoint(
	baseUrl: string | null | undefined,
	suffix: "/chat/completions" | "/models",
): string {
	const raw = baseUrl?.trim() || DEFAULT_KEYWORD_LLM_BASE_URL;
	let cleaned = raw.replace(/\/+$/, "");
	for (const known of ["/chat/completions", "/models"]) {
		const stripped = stripTrailingCiSuffix(cleaned, known);
		if (stripped !== null) {
			cleaned = stripped.replace(/\/+$/, "");
			break;
		}
	}
	try {
		const url = new URL(cleaned);
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		const trimmedPath = url.pathname.replace(/\/+$/, "");
		url.pathname = trimmedPath ? `${trimmedPath}${suffix}` : `/v1${suffix}`;
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return "";
	}
}

export function resolveKeywordLlmChatUrl(baseUrl?: string | null): string {
	return resolveOpenAiCompatibleEndpoint(baseUrl, "/chat/completions");
}

export function resolveKeywordLlmModelsUrl(baseUrl?: string | null): string {
	return resolveOpenAiCompatibleEndpoint(baseUrl, "/models");
}

/** True when `baseUrl` is empty or matches the built-in default endpoint. */
export function isDefaultKeywordLlmBaseUrl(baseUrl?: string | null): boolean {
	const normalized = resolveKeywordLlmChatUrl(baseUrl);
	return (
		Boolean(normalized) &&
		normalized === resolveKeywordLlmChatUrl(DEFAULT_KEYWORD_LLM_BASE_URL)
	);
}

export function isKeywordLlmConfigured(cfg: KeywordLlmSettings): boolean {
	const baseUrl = cfg.baseUrl.trim() || DEFAULT_KEYWORD_LLM_BASE_URL;
	const model = cfg.model.trim();
	if (!model) return false;
	if (hasSecret(cfg.apiKey)) return true;
	// Allow keyless custom endpoints (e.g. Ollama / vLLM), while requiring a key on the default endpoint.
	return !isDefaultKeywordLlmBaseUrl(baseUrl);
}

/** True when the Rust Host embeds a compile-time `AGENTERO_KEYWORD_LLM_API_KEY`. */
export async function hasBuiltinKeywordLlmKey(): Promise<boolean> {
	if (!isTauri()) return false;
	try {
		return await callApi(() => commands.keywordLlmHasBuiltinKey(), {
			fallback: "Built-in keyword LLM key check failed",
		});
	} catch {
		return false;
	}
}

export type KeywordLlmOverride = Partial<Omit<KeywordLlmSettings, "apiKey">> & {
	apiKey?: string | null;
};

/**
 * Override or reset the keyword-LLM config in unit tests.
 * - `undefined`: clear override and read from `loadSettings().keywordLlm`
 * - `null`: force-disable keyword extraction
 * - `{ ... }`: supply active in-memory baseUrl/apiKey/model
 */
export function setCachedKeywordLlmConfigForTests(
	override: KeywordLlmOverride | null | undefined,
): void {
	if (override === undefined) {
		testConfigOverride = undefined;
		return;
	}
	if (override === null) {
		testConfigOverride = null;
		return;
	}
	const baseUrl =
		override.baseUrl !== undefined
			? override.baseUrl.trim() || DEFAULT_KEYWORD_LLM_BASE_URL
			: DEFAULT_KEYWORD_LLM_BASE_URL;
	const model =
		override.model !== undefined
			? override.model.trim() || DEFAULT_KEYWORD_LLM_MODEL
			: DEFAULT_KEYWORD_LLM_MODEL;
	testConfigOverride = {
		baseUrl,
		apiKey: (override.apiKey ?? "").trim(),
		model,
		batchSize: clampKeywordLlmBatchSize(override.batchSize),
		concurrency: clampKeywordLlmConcurrency(override.concurrency),
	};
}

/**
 * Active Keyword LLM batch size and concurrency from settings (or test override).
 */
export function getKeywordLlmExecutionConfig(): {
	batchSize: number;
	concurrency: number;
} {
	const cfg =
		testConfigOverride === undefined
			? loadSettings().keywordLlm
			: testConfigOverride;
	return {
		batchSize: clampKeywordLlmBatchSize(cfg?.batchSize),
		concurrency: clampKeywordLlmConcurrency(cfg?.concurrency),
	};
}

/**
 * Deterministic signature used by Plaza enrichment session caches to reset
 * previous no-op attempts when keyword-LLM settings change.
 */
export function getKeywordLlmConfigSignature(): string {
	const cfg =
		testConfigOverride === undefined
			? loadSettings().keywordLlm
			: testConfigOverride;
	if (!cfg || !isKeywordLlmConfigured(cfg)) {
		return "disabled";
	}
	const baseUrl = cfg.baseUrl.trim() || DEFAULT_KEYWORD_LLM_BASE_URL;
	const model = cfg.model.trim() || DEFAULT_KEYWORD_LLM_MODEL;
	return [baseUrl, cfg.apiKey.trim(), model].join("\0");
}

function toOverrideArgs(override?: KeywordLlmOverride | null) {
	if (!override) return null;
	return {
		baseUrl: override.baseUrl ?? null,
		apiKey: override.apiKey ?? null,
		model: override.model ?? null,
	};
}

function sortModelIds(
	ids: Iterable<string>,
	pinnedModel?: string | null,
): string[] {
	const all = new Set<string>();
	for (const raw of ids) {
		const id = raw.trim();
		if (id) all.add(id);
	}
	const pin = pinnedModel?.trim() ?? "";
	const hasPinned = Boolean(pin && all.delete(pin));
	const sorted = Array.from(all).sort((a, b) => a.localeCompare(b));
	return hasPinned ? [pin, ...sorted] : sorted;
}

/**
 * Probe a keyword-LLM configuration (field overrides or stored Host settings).
 */
export async function probeKeywordLlm(
	override?: KeywordLlmOverride | null,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!isTauri()) return false;
	try {
		const ok = await callApi(
			() => commands.keywordLlmProbe(toOverrideArgs(override)),
			{ fallback: "Keyword LLM probe failed" },
		);
		if (signal?.aborted) return false;
		return ok;
	} catch {
		return false;
	}
}

/**
 * Fetch available model IDs from an OpenAI-compatible `/models` endpoint,
 * sorted alphabetically with the configured model pinned first if present.
 */
export async function fetchKeywordLlmModels(
	override?: KeywordLlmOverride | null,
	fetchFn?: typeof fetch,
): Promise<string[]> {
	const stored = loadSettings().keywordLlm;
	const baseUrl =
		(override?.baseUrl !== undefined
			? override.baseUrl
			: stored.baseUrl
		).trim() || DEFAULT_KEYWORD_LLM_BASE_URL;
	const explicitKey =
		override?.apiKey !== undefined ? (override.apiKey ?? "") : stored.apiKey;
	const usableKey =
		explicitKey.trim() && !isSecretMask(explicitKey)
			? explicitKey.trim()
			: null;
	const configuredModel =
		(override?.model !== undefined ? override.model : stored.model).trim() ||
		(isDefaultKeywordLlmBaseUrl(baseUrl) ? DEFAULT_KEYWORD_LLM_MODEL : "");
	const fallbackList = configuredModel ? [configuredModel] : [];

	// Use explicit `fetchFn` directly (allows unit tests to mock even under mocked `isTauri()`).
	if (fetchFn === undefined && isTauri()) {
		try {
			const list = await callApi(
				() => commands.keywordLlmModelsList(toOverrideArgs(override)),
				{ fallback: "Keyword LLM models list failed" },
			);
			const cleaned = list.map((m) => m.trim()).filter(Boolean);
			if (cleaned.length > 0) {
				return Array.from(new Set(cleaned));
			}
		} catch {
			return fallbackList;
		}
	}

	const activeFetch = fetchFn ?? globalThis.fetch;
	const modelsUrl = resolveKeywordLlmModelsUrl(baseUrl);
	if (typeof activeFetch === "function" && modelsUrl) {
		try {
			const headers: Record<string, string> = { Accept: "application/json" };
			if (usableKey) {
				headers.Authorization = `Bearer ${usableKey}`;
			}
			const resp = await activeFetch(modelsUrl, { headers });
			if (resp.ok) {
				const json = (await resp.json()) as
					| { data?: Array<{ id?: string | null }> }
					| Array<{ id?: string | null }>;
				const list = Array.isArray(json) ? json : (json.data ?? []);
				const ids: string[] = [];
				for (const item of list) {
					const id = item.id?.trim() ?? "";
					if (id) ids.push(id);
				}
				return sortModelIds(ids, configuredModel);
			}
		} catch {
			// Fall back below.
		}
	}

	return fallbackList;
}

export function parseKeywordBatchJson(
	rawContent: string,
): Record<string, string[]> {
	const withoutThink = rawContent
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/```(?:json)?/gi, "")
		.trim();
	const start = withoutThink.indexOf("{");
	const end = withoutThink.lastIndexOf("}");
	if (start < 0 || end <= start) return {};
	try {
		const parsed = JSON.parse(withoutThink.slice(start, end + 1)) as Record<
			string,
			unknown
		>;
		const out: Record<string, string[]> = {};
		if (Array.isArray(parsed.items)) {
			for (const entry of parsed.items) {
				if (!entry || typeof entry !== "object") continue;
				const rec = entry as { idx?: number | string; keywords?: unknown };
				if (rec.idx === undefined || !Array.isArray(rec.keywords)) continue;
				const strings = rec.keywords
					.filter((x): x is string => typeof x === "string")
					.map((s) => s.trim())
					.filter(Boolean);
				if (strings.length > 0) {
					out[String(rec.idx).trim()] = strings;
				}
			}
		}
		for (const [k, val] of Object.entries(parsed)) {
			if (k === "items" || !Array.isArray(val)) continue;
			const strings = val
				.filter((x): x is string => typeof x === "string")
				.map((s) => s.trim())
				.filter(Boolean);
			if (strings.length > 0) {
				out[k.trim()] = strings;
			}
		}
		return out;
	} catch {
		return {};
	}
}

function buildChunkUserPrompt(chunk: readonly KeywordLlmInput[]): string {
	return chunk
		.map((item, idx) => {
			const title = item.title.replace(/\s+/g, " ").trim().slice(0, 260);
			const abs = (item.abstract ?? "").replace(/\s+/g, " ").trim();
			return abs
				? `[${idx}] Title: ${title} | Abstract: ${abs}`
				: `[${idx}] Title: ${title}`;
		})
		.join("\n");
}

function extractChatContentFromJson(json: unknown): string {
	if (!json || typeof json !== "object") return "";
	const msgContent = (
		json as {
			choices?: Array<{
				message?: { content?: string | Array<{ text?: string }> | null };
			}>;
		}
	).choices?.[0]?.message?.content;
	if (typeof msgContent === "string") return msgContent;
	if (Array.isArray(msgContent)) {
		return msgContent
			.map((part) => (typeof part?.text === "string" ? part.text : ""))
			.join("");
	}
	return "";
}

const KEYWORD_LLM_REQUEST_TIMEOUT_MS = 60_000;
const PROD_RATE_LIMIT_BACKOFF_MS = [3_000, 6_000, 12_000, 20_000] as const;
const TEST_RATE_LIMIT_BACKOFF_MS = [15, 25, 35, 45] as const;
const PROD_TRANSIENT_BACKOFF_MS = [2_000, 5_000, 10_000] as const;
const TEST_TRANSIENT_BACKOFF_MS = [15, 25, 35] as const;
const MAX_PROD_RETRY_AFTER_MS = 60_000;
const MAX_TEST_RETRY_AFTER_MS = 60;

function parseRetryAfterHeaderMs(
	rawHeader: string | null | undefined,
): number | undefined {
	if (!rawHeader) return undefined;
	const trimmed = rawHeader.trim();
	if (!trimmed) return undefined;
	const asSeconds = Number(trimmed);
	if (Number.isFinite(asSeconds) && asSeconds >= 0) {
		return Math.ceil(asSeconds * 1000);
	}
	const asDateMs = Date.parse(trimmed);
	if (!Number.isNaN(asDateMs)) {
		return Math.max(0, asDateMs - Date.now());
	}
	return undefined;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(new BackgroundTaskCancelledError());
	}
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new BackgroundTaskCancelledError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function resolveBackoffWaitMs(
	baseWaitMs: number,
	retryAfterMs: number | undefined,
	isFastTest: boolean,
): number {
	if (retryAfterMs === undefined || retryAfterMs <= 0) {
		return baseWaitMs;
	}
	const capped = Math.min(
		retryAfterMs,
		isFastTest ? MAX_TEST_RETRY_AFTER_MS : MAX_PROD_RETRY_AFTER_MS,
	);
	return Math.max(baseWaitMs, capped);
}

async function runChunkWithPatientRetries(
	attemptOnce: () => Promise<{
		status: number;
		content: string;
		retryAfterMs?: number;
	} | null>,
	signal?: AbortSignal,
): Promise<{
	byIndex: Record<string, string[]>;
	abortRemaining: boolean;
}> {
	const isFastTest = testConfigOverride !== undefined;
	const rateBackoffs = isFastTest
		? TEST_RATE_LIMIT_BACKOFF_MS
		: PROD_RATE_LIMIT_BACKOFF_MS;
	const transientBackoffs = isFastTest
		? TEST_TRANSIENT_BACKOFF_MS
		: PROD_TRANSIENT_BACKOFF_MS;

	let rateRetryIdx = 0;
	let transientRetryIdx = 0;

	while (true) {
		if (signal?.aborted) {
			throw new BackgroundTaskCancelledError();
		}
		let outcome: {
			status: number;
			content: string;
			retryAfterMs?: number;
		} | null = null;
		try {
			outcome = await attemptOnce();
		} catch (err) {
			if (signal?.aborted || err instanceof BackgroundTaskCancelledError) {
				throw new BackgroundTaskCancelledError();
			}
			const waitMs = transientBackoffs[transientRetryIdx++];
			if (waitMs !== undefined) {
				await sleepAbortable(waitMs, signal);
				continue;
			}
			return { byIndex: {}, abortRemaining: false };
		}

		if (!outcome) {
			return { byIndex: {}, abortRemaining: true };
		}
		const { status, content, retryAfterMs } = outcome;
		if (status === 401 || status === 402) {
			return { byIndex: {}, abortRemaining: true };
		}
		if (status === 429) {
			const baseWaitMs = rateBackoffs[rateRetryIdx++];
			if (baseWaitMs !== undefined) {
				await sleepAbortable(
					resolveBackoffWaitMs(baseWaitMs, retryAfterMs, isFastTest),
					signal,
				);
				continue;
			}
			return { byIndex: {}, abortRemaining: true };
		}
		if (status === 408 || status >= 500) {
			const baseWaitMs = transientBackoffs[transientRetryIdx++];
			if (baseWaitMs !== undefined) {
				await sleepAbortable(
					resolveBackoffWaitMs(baseWaitMs, retryAfterMs, isFastTest),
					signal,
				);
				continue;
			}
			return { byIndex: {}, abortRemaining: false };
		}
		if (status < 200 || status >= 300) {
			return { byIndex: {}, abortRemaining: false };
		}

		const byIndex = parseKeywordBatchJson(content);
		if (Object.keys(byIndex).length === 0) {
			const waitMs = transientBackoffs[transientRetryIdx++];
			if (waitMs !== undefined) {
				await sleepAbortable(waitMs, signal);
				continue;
			}
		}
		return { byIndex, abortRemaining: false };
	}
}

function isUnsupportedParamStatus(status: number): boolean {
	return status === 400 || status === 422;
}

async function callKeywordLlmChunkViaFetch(
	chunk: readonly KeywordLlmInput[],
	cfg: KeywordLlmSettings,
	fetchFn: typeof fetch,
	signal?: AbortSignal,
	batchState?: { reasoningRejected: boolean },
): Promise<{
	byIndex: Record<string, string[]>;
	abortRemaining: boolean;
}> {
	if (signal?.aborted) {
		throw new BackgroundTaskCancelledError();
	}
	const chatUrl = resolveKeywordLlmChatUrl(cfg.baseUrl);
	if (!chatUrl) {
		return { byIndex: {}, abortRemaining: true };
	}
	const model = cfg.model.trim() || DEFAULT_KEYWORD_LLM_MODEL;
	if (!model) {
		return { byIndex: {}, abortRemaining: true };
	}
	const apiKey = cfg.apiKey.trim();
	const messages = [
		{ role: "system", content: KEYWORD_SYSTEM_PROMPT },
		{ role: "user", content: buildChunkUserPrompt(chunk) },
	];

	const sendOnce = async (
		includeReasoning: boolean,
		includeTemperature: boolean,
	): Promise<Response> => {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), KEYWORD_LLM_REQUEST_TIMEOUT_MS);
		const onExternalAbort = () => ac.abort();
		if (signal) {
			if (signal.aborted) ac.abort();
			else signal.addEventListener("abort", onExternalAbort, { once: true });
		}
		try {
			const body: Record<string, unknown> = {
				model,
				messages,
			};
			if (includeTemperature) {
				body.temperature = 0;
			}
			if (includeReasoning) {
				body.reasoning = { effort: "low", exclude: true };
			}
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Accept: "application/json",
			};
			if (apiKey && !isSecretMask(apiKey)) {
				headers.Authorization = `Bearer ${apiKey}`;
			}
			return await fetchFn(chatUrl, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: ac.signal,
			});
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onExternalAbort);
		}
	};

	return runChunkWithPatientRetries(async () => {
		const tryReasoning = !(batchState?.reasoningRejected ?? false);
		const tiers: Array<{ reasoning: boolean; temperature: boolean }> = [
			...(tryReasoning ? [{ reasoning: true, temperature: true }] : []),
			{ reasoning: false, temperature: true },
			{ reasoning: false, temperature: false },
		];
		let resp!: Response;
		for (let i = 0; i < tiers.length; i += 1) {
			const tier = tiers[i];
			if (!tier) break;
			resp = await sendOnce(tier.reasoning, tier.temperature);
			if (signal?.aborted) {
				throw new BackgroundTaskCancelledError();
			}
			const unsupported = isUnsupportedParamStatus(resp.status);
			if (tryReasoning && i === 1 && !unsupported && batchState) {
				batchState.reasoningRejected = true;
			}
			if (!unsupported || i === tiers.length - 1) {
				break;
			}
		}
		if (!resp.ok) {
			return {
				status: resp.status,
				content: "",
				retryAfterMs: parseRetryAfterHeaderMs(
					resp.headers?.get?.("retry-after"),
				),
			};
		}
		const json = (await resp.json()) as unknown;
		return {
			status: resp.status,
			content: extractChatContentFromJson(json),
		};
	}, signal);
}

async function callKeywordLlmChunkViaHost(
	chunk: readonly KeywordLlmInput[],
	signal?: AbortSignal,
): Promise<{
	byIndex: Record<string, string[]>;
	abortRemaining: boolean;
}> {
	return runChunkWithPatientRetries(async () => {
		if (signal?.aborted) {
			throw new BackgroundTaskCancelledError();
		}
		const callPromise = callApi(
			() =>
				commands.keywordLlmChatComplete(
					KEYWORD_SYSTEM_PROMPT,
					buildChunkUserPrompt(chunk),
					null,
				),
			{ fallback: "Keyword LLM completion failed" },
		);
		return signal
			? await new Promise<Awaited<typeof callPromise>>((resolve, reject) => {
					const onAbort = () => reject(new BackgroundTaskCancelledError());
					signal.addEventListener("abort", onAbort, { once: true });
					callPromise.then(
						(val) => {
							signal.removeEventListener("abort", onAbort);
							resolve(val);
						},
						(err) => {
							signal.removeEventListener("abort", onAbort);
							reject(err);
						},
					);
				})
			: await callPromise;
	}, signal);
}

/**
 * Extract 4–6 canonical technical keywords for arXiv and Venue papers missing
 * upstream/OpenAlex keywords using the configured Keyword Extraction LLM.
 * Returns an empty map when unconfigured or disabled.
 */
export async function extractKeywordsWithKeywordLlmBatch(
	items: readonly KeywordLlmInput[],
	options?: {
		batchSize?: number;
		concurrency?: number;
		minSpacingMs?: number;
		fetchFn?: typeof fetch;
		signal?: AbortSignal;
		onProgress?: (completed: number, total: number) => void;
	},
): Promise<Map<string, string[]>> {
	if (options?.signal?.aborted) {
		throw new BackgroundTaskCancelledError();
	}
	const result = new Map<string, string[]>();
	if (items.length === 0) return result;

	const useDirectFetch =
		options?.fetchFn !== undefined ||
		testConfigOverride !== undefined ||
		!isTauri();

	let directCfg: KeywordLlmSettings | null = null;
	if (useDirectFetch) {
		directCfg =
			testConfigOverride === undefined
				? loadSettings().keywordLlm
				: testConfigOverride;
		if (!directCfg || !isKeywordLlmConfigured(directCfg)) {
			return result;
		}
		if (isSecretMask(directCfg.apiKey)) {
			return result;
		}
		const activeFetch = options?.fetchFn ?? globalThis.fetch;
		if (typeof activeFetch !== "function") return result;
	} else {
		const storedCfg = loadSettings().keywordLlm;
		if (
			!isKeywordLlmConfigured(storedCfg) &&
			!(
				isDefaultKeywordLlmBaseUrl(storedCfg.baseUrl) &&
				(await hasBuiltinKeywordLlmKey())
			)
		) {
			return result;
		}
	}

	const validItems = items.filter(
		(item) => item.id && item.title.trim().length > 3,
	);
	if (validItems.length === 0) return result;

	const execCfg = getKeywordLlmExecutionConfig();
	const batchSize = clampKeywordLlmBatchSize(
		options?.batchSize ?? execCfg.batchSize,
	);
	const concurrency = clampKeywordLlmConcurrency(
		options?.concurrency ?? execCfg.concurrency,
	);
	const minSpacingMs = Math.max(0, options?.minSpacingMs ?? 0);
	const chunks: KeywordLlmInput[][] = [];
	for (let i = 0; i < validItems.length; i += batchSize) {
		chunks.push(validItems.slice(i, i + batchSize));
	}

	let cursor = 0;
	let completedItems = 0;
	let circuitBroken = false;
	let nextSlotMs = 0;
	const batchState = { reasoningRejected: false };
	const fetchFn = options?.fetchFn ?? globalThis.fetch;
	options?.onProgress?.(0, validItems.length);

	const worker = async () => {
		while (
			!circuitBroken &&
			!options?.signal?.aborted &&
			cursor < chunks.length
		) {
			const idx = cursor++;
			const chunk = chunks[idx];
			if (!chunk) continue;
			try {
				if (minSpacingMs > 0) {
					const now = Date.now();
					const waitUntil = Math.max(now, nextSlotMs);
					nextSlotMs = waitUntil + minSpacingMs;
					if (waitUntil > now) {
						await sleepAbortable(waitUntil - now, options?.signal);
					}
				}
				const { byIndex, abortRemaining } =
					useDirectFetch && directCfg
						? await callKeywordLlmChunkViaFetch(
								chunk,
								directCfg,
								fetchFn,
								options?.signal,
								batchState,
							)
						: await callKeywordLlmChunkViaHost(chunk, options?.signal);
				if (abortRemaining) {
					circuitBroken = true;
					return;
				}
				for (let k = 0; k < chunk.length; k++) {
					const target = chunk[k];
					const kws = byIndex[String(k)];
					if (target && kws && kws.length > 0) {
						result.set(target.id, kws);
					}
				}
			} catch (err) {
				if (options?.signal?.aborted) {
					throw err;
				}
				// Best-effort fallback: never fail arXiv or Venue refresh when LLM endpoint errors.
			} finally {
				if (!options?.signal?.aborted) {
					completedItems = Math.min(
						validItems.length,
						completedItems + chunk.length,
					);
					options?.onProgress?.(completedItems, validItems.length);
				}
			}
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(concurrency, chunks.length) }, () =>
			worker(),
		),
	);
	if (options?.signal?.aborted) {
		throw new BackgroundTaskCancelledError();
	}

	return result;
}
