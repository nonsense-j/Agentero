/**
 * Fallback LLM helpers for academic keyword extraction across arXiv and Venue
 * papers when upstream publisher / OpenAlex keywords are absent.
 *
 * Supports:
 * - `openrouter` preset (`https://openrouter.ai/api/v1`, default `baidu/ernie-5.5-flash-preview:free`)
 * - `openaiCompatible` BYOK (`Base URL`, `API Key`, `Model`, defaulting to `https://api.openai.com/v1`)
 *
 * On desktop (`isTauri()`), probes, `/models` fetches, and `/chat/completions`
 * execute inside the Rust Host so BYOK keys remain masked (`*`) in the WebView,
 * avoid CORS restrictions, and honor app proxy settings.
 */

import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { hasSecret, isSecretMask } from "@/lib/core/secret-mask";
import { isTauri } from "@/lib/core/tauri";
import {
	DEFAULT_OPEN_ROUTER_BASE_URL,
	DEFAULT_OPEN_ROUTER_MODEL,
	DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
} from "@/lib/settings/defaults";
import { loadSettings } from "@/lib/settings/store";
import type {
	KeywordLlmProviderId,
	KeywordLlmSettings,
} from "@/lib/settings/types";
import type { ProbeStatus } from "@/lib/ui/probe-status";

export {
	DEFAULT_OPEN_ROUTER_BASE_URL,
	DEFAULT_OPEN_ROUTER_MODEL,
	DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
};

export const OPENROUTER_KEY_URL = "https://openrouter.ai/settings/keys";

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

function defaultBaseUrlForProvider(provider: KeywordLlmProviderId): string {
	return provider === "openrouter"
		? DEFAULT_OPEN_ROUTER_BASE_URL
		: DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
}

function stripTrailingCiSuffix(value: string, suffix: string): string | null {
	if (value.length < suffix.length) return null;
	if (value.slice(-suffix.length).toLowerCase() === suffix.toLowerCase()) {
		return value.slice(0, -suffix.length);
	}
	return null;
}

function resolveOpenAiCompatibleEndpoint(
	baseUrl: string | null | undefined,
	provider: KeywordLlmProviderId,
	suffix: "/chat/completions" | "/models",
): string {
	const fallbackRoot = defaultBaseUrlForProvider(provider);
	const raw = baseUrl?.trim() || fallbackRoot;
	let cleaned = raw.replace(/\/+$/, "");
	const withoutChat = stripTrailingCiSuffix(cleaned, "/chat/completions");
	const withoutModels = stripTrailingCiSuffix(cleaned, "/models");
	if (withoutChat !== null) {
		cleaned = withoutChat.replace(/\/+$/, "");
	} else if (withoutModels !== null) {
		cleaned = withoutModels.replace(/\/+$/, "");
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

export function resolveKeywordLlmChatUrl(
	baseUrl?: string | null,
	provider: KeywordLlmProviderId = "openaiCompatible",
): string {
	return resolveOpenAiCompatibleEndpoint(
		baseUrl,
		provider,
		"/chat/completions",
	);
}

export function resolveKeywordLlmModelsUrl(
	baseUrl?: string | null,
	provider: KeywordLlmProviderId = "openaiCompatible",
): string {
	return resolveOpenAiCompatibleEndpoint(baseUrl, provider, "/models");
}

function isOpenRouterEndpoint(urlStr: string): boolean {
	try {
		return new URL(urlStr).hostname.toLowerCase() === "openrouter.ai";
	} catch {
		return false;
	}
}

export function isKeywordLlmConfigured(cfg: KeywordLlmSettings): boolean {
	if (cfg.provider === "openrouter") {
		const model = cfg.model.trim() || DEFAULT_OPEN_ROUTER_MODEL;
		return hasSecret(cfg.apiKey) && Boolean(model);
	}
	const model = cfg.model.trim();
	if (!model) return false;
	return hasSecret(cfg.apiKey) || Boolean(cfg.baseUrl.trim());
}

/**
 * Override or reset the keyword-LLM config in unit tests.
 * - `undefined`: clear override and read from `loadSettings().keywordLlm`
 * - `null`: force-disable keyword extraction
 * - `{ ... }`: supply active in-memory provider/baseUrl/apiKey/model
 */
export function setCachedKeywordLlmConfigForTests(
	override:
		| (Partial<Omit<KeywordLlmSettings, "apiKey">> & {
				apiKey?: string | null;
		  })
		| null
		| undefined,
): void {
	if (override === undefined) {
		testConfigOverride = undefined;
		return;
	}
	if (override === null) {
		testConfigOverride = null;
		return;
	}
	const provider: KeywordLlmProviderId =
		override.provider === "openaiCompatible"
			? "openaiCompatible"
			: "openrouter";
	testConfigOverride = {
		provider,
		baseUrl:
			override.baseUrl !== undefined
				? override.baseUrl.trim()
				: provider === "openrouter"
					? DEFAULT_OPEN_ROUTER_BASE_URL
					: "",
		apiKey: (override.apiKey ?? "").trim(),
		model:
			override.model !== undefined
				? override.model.trim()
				: provider === "openrouter"
					? DEFAULT_OPEN_ROUTER_MODEL
					: "",
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
	const model =
		cfg.model.trim() ||
		(cfg.provider === "openrouter" ? DEFAULT_OPEN_ROUTER_MODEL : "");
	return [cfg.provider, cfg.baseUrl.trim(), cfg.apiKey.trim(), model].join(
		"\0",
	);
}

function toOverrideArgs(
	override?:
		| (Partial<Omit<KeywordLlmSettings, "apiKey">> & {
				apiKey?: string | null;
		  })
		| null,
) {
	if (!override) return null;
	return {
		provider: override.provider ?? null,
		baseUrl: override.baseUrl ?? null,
		apiKey: override.apiKey ?? null,
		model: override.model ?? null,
	};
}

function sortModelIds(
	ids: Iterable<string>,
	prioritizeOpenRouterFree: boolean,
): string[] {
	const all = new Set<string>();
	for (const raw of ids) {
		const id = raw.trim();
		if (id) all.add(id);
	}
	if (!prioritizeOpenRouterFree) {
		return Array.from(all).sort((a, b) => a.localeCompare(b));
	}
	const free: string[] = [];
	const paid: string[] = [];
	for (const id of all) {
		if (id === DEFAULT_OPEN_ROUTER_MODEL) continue;
		if (id.toLowerCase().endsWith(":free")) {
			free.push(id);
		} else {
			paid.push(id);
		}
	}
	free.sort((a, b) => a.localeCompare(b));
	paid.sort((a, b) => a.localeCompare(b));
	return [DEFAULT_OPEN_ROUTER_MODEL, ...free, ...paid];
}

/**
 * Probe a keyword-LLM configuration (field overrides or stored Host settings).
 */
export async function probeKeywordLlm(
	override?:
		| (Partial<Omit<KeywordLlmSettings, "apiKey">> & {
				apiKey?: string | null;
		  })
		| null,
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
 * Fetch available model IDs from an OpenAI-compatible `/models` endpoint.
 * For OpenRouter, `:free` models (starting with `DEFAULT_OPEN_ROUTER_MODEL`)
 * are placed first, followed by paid models.
 */
export async function fetchKeywordLlmModels(
	override?:
		| (Partial<Omit<KeywordLlmSettings, "apiKey">> & {
				apiKey?: string | null;
		  })
		| null,
	fetchFn?: typeof fetch,
): Promise<string[]> {
	const stored = loadSettings().keywordLlm;
	const provider: KeywordLlmProviderId =
		override?.provider === "openaiCompatible"
			? "openaiCompatible"
			: override?.provider === "openrouter"
				? "openrouter"
				: stored.provider;
	const baseUrl =
		override?.baseUrl !== undefined ? override.baseUrl : stored.baseUrl;
	const explicitKey =
		override?.apiKey !== undefined ? (override.apiKey ?? "") : stored.apiKey;
	const usableKey =
		explicitKey.trim() && !isSecretMask(explicitKey)
			? explicitKey.trim()
			: null;

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
			return provider === "openrouter" ? [DEFAULT_OPEN_ROUTER_MODEL] : [];
		}
	}

	const activeFetch = fetchFn ?? globalThis.fetch;
	const modelsUrl = resolveKeywordLlmModelsUrl(baseUrl, provider);
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
				return sortModelIds(
					ids,
					provider === "openrouter" || isOpenRouterEndpoint(modelsUrl),
				);
			}
		} catch {
			// Fall back below.
		}
	}

	return provider === "openrouter" ? [DEFAULT_OPEN_ROUTER_MODEL] : [];
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
			const abs = (item.abstract ?? "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 900);
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

async function callKeywordLlmChunkViaFetch(
	chunk: readonly KeywordLlmInput[],
	cfg: KeywordLlmSettings,
	fetchFn: typeof fetch,
): Promise<{
	byIndex: Record<string, string[]>;
	abortRemaining: boolean;
}> {
	const chatUrl = resolveKeywordLlmChatUrl(cfg.baseUrl, cfg.provider);
	if (!chatUrl) {
		return { byIndex: {}, abortRemaining: true };
	}
	const model =
		cfg.model.trim() ||
		(cfg.provider === "openrouter" ? DEFAULT_OPEN_ROUTER_MODEL : "");
	if (!model) {
		return { byIndex: {}, abortRemaining: true };
	}
	const apiKey = cfg.apiKey.trim();
	const messages = [
		{ role: "system", content: KEYWORD_SYSTEM_PROMPT },
		{ role: "user", content: buildChunkUserPrompt(chunk) },
	];

	const sendOnce = async (minimalFallback: boolean): Promise<Response> => {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 22_000);
		try {
			const body: Record<string, unknown> = {
				model,
				messages,
			};
			if (!minimalFallback) {
				body.temperature = 0;
				body.max_tokens = 700;
				if (isOpenRouterEndpoint(chatUrl)) {
					body.reasoning = { effort: "minimal", exclude: true };
				}
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
		}
	};

	let resp = await sendOnce(false);
	if (resp.status === 400) {
		resp = await sendOnce(true);
	}
	if (resp.status === 401 || resp.status === 402 || resp.status === 429) {
		return { byIndex: {}, abortRemaining: true };
	}
	if (!resp.ok) {
		return { byIndex: {}, abortRemaining: false };
	}
	const json = (await resp.json()) as unknown;
	return {
		byIndex: parseKeywordBatchJson(extractChatContentFromJson(json)),
		abortRemaining: false,
	};
}

async function callKeywordLlmChunkViaHost(
	chunk: readonly KeywordLlmInput[],
): Promise<{
	byIndex: Record<string, string[]>;
	abortRemaining: boolean;
}> {
	const res = await callApi(
		() =>
			commands.keywordLlmChatComplete(
				KEYWORD_SYSTEM_PROMPT,
				buildChunkUserPrompt(chunk),
				700,
			),
		{ fallback: "Keyword LLM completion failed" },
	);
	if (!res) {
		return { byIndex: {}, abortRemaining: true };
	}
	if (res.status === 401 || res.status === 402 || res.status === 429) {
		return { byIndex: {}, abortRemaining: true };
	}
	if (res.status < 200 || res.status >= 300) {
		return { byIndex: {}, abortRemaining: false };
	}
	return {
		byIndex: parseKeywordBatchJson(res.content),
		abortRemaining: false,
	};
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
		fetchFn?: typeof fetch;
	},
): Promise<Map<string, string[]>> {
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
		if (!isKeywordLlmConfigured(storedCfg)) {
			return result;
		}
	}

	const validItems = items.filter(
		(item) => item.id && item.title.trim().length > 3,
	);
	if (validItems.length === 0) return result;

	const batchSize = Math.max(1, Math.min(8, options?.batchSize ?? 6));
	const concurrency = Math.max(1, Math.min(4, options?.concurrency ?? 2));
	const chunks: KeywordLlmInput[][] = [];
	for (let i = 0; i < validItems.length; i += batchSize) {
		chunks.push(validItems.slice(i, i + batchSize));
	}

	let cursor = 0;
	let circuitBroken = false;
	const fetchFn = options?.fetchFn ?? globalThis.fetch;

	const worker = async () => {
		while (!circuitBroken && cursor < chunks.length) {
			const idx = cursor++;
			const chunk = chunks[idx];
			if (!chunk) continue;
			try {
				const { byIndex, abortRemaining } =
					useDirectFetch && directCfg
						? await callKeywordLlmChunkViaFetch(chunk, directCfg, fetchFn)
						: await callKeywordLlmChunkViaHost(chunk);
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
			} catch {
				// Best-effort fallback: never fail arXiv or Venue refresh when LLM endpoint errors.
			}
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(concurrency, chunks.length) }, () =>
			worker(),
		),
	);

	return result;
}
