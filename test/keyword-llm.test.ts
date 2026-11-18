import { afterEach, describe, expect, it } from "vitest";
import {
	extractKeywordsWithKeywordLlmBatch,
	fetchKeywordLlmModels,
	KEYWORD_SYSTEM_PROMPT,
	parseKeywordBatchJson,
	resolveKeywordLlmChatUrl,
	resolveKeywordLlmModelsUrl,
	setCachedKeywordLlmConfigForTests,
} from "@/lib/keyword-llm";
import {
	DEFAULT_KEYWORD_LLM_BASE_URL,
	DEFAULT_KEYWORD_LLM_MODEL,
	DEFAULT_KEYWORD_LLM_SETTINGS,
	DEFAULT_SETTINGS,
} from "@/lib/settings/defaults";
import { applyExternalSettings, loadSettings } from "@/lib/settings/store";
import type { AppSettings } from "@/lib/settings/types";

afterEach(() => {
	setCachedKeywordLlmConfigForTests(undefined);
	applyExternalSettings(DEFAULT_SETTINGS);
});

describe("Keyword LLM settings normalization, URL resolution & batch extraction", () => {
	it("uses single OpenAI-compatible 3-field defaults and ignores unknown legacy fields", () => {
		expect(DEFAULT_KEYWORD_LLM_SETTINGS).toEqual({
			baseUrl: DEFAULT_KEYWORD_LLM_BASE_URL,
			apiKey: "",
			model: DEFAULT_KEYWORD_LLM_MODEL,
		});

		const legacyPayload = {
			...DEFAULT_SETTINGS,
			keywordLlm: {
				provider: "x666",
				baseUrl: "",
				apiKey: "  sk-legacy-123 ",
				model: "",
			},
		} as unknown as AppSettings;
		applyExternalSettings(legacyPayload);

		expect(loadSettings().keywordLlm).toEqual({
			baseUrl: DEFAULT_KEYWORD_LLM_BASE_URL,
			apiKey: "sk-legacy-123",
			model: DEFAULT_KEYWORD_LLM_MODEL,
		});

		applyExternalSettings({
			...DEFAULT_SETTINGS,
			keywordLlm: {
				baseUrl: "  https://api.example.com/v1/  ",
				apiKey: "  sk-byok-456 ",
				model: " gpt-4.1-mini ",
			},
		});

		expect(loadSettings().keywordLlm).toEqual({
			baseUrl: "https://api.example.com/v1/",
			apiKey: "sk-byok-456",
			model: "gpt-4.1-mini",
		});
	});

	it("enforces subfield + methodology categories and forbids paper-coined tool/benchmark names in KEYWORD_SYSTEM_PROMPT", () => {
		expect(KEYWORD_SYSTEM_PROMPT).toContain("research subfield");
		expect(KEYWORD_SYSTEM_PROMPT).toContain("methodology class");
		expect(KEYWORD_SYSTEM_PROMPT).toContain("Code Generation");
		expect(KEYWORD_SYSTEM_PROMPT).toContain("Random Testing");
		expect(KEYWORD_SYSTEM_PROMPT).toContain("Fuzzing");
		expect(KEYWORD_SYSTEM_PROMPT).toContain("Vulnerability Detection");
		expect(KEYWORD_SYSTEM_PROMPT).toContain("Program Repair");
		expect(KEYWORD_SYSTEM_PROMPT).toContain("STRICTLY FORBID paper-coined");
		expect(KEYWORD_SYSTEM_PROMPT).not.toContain('"VulnFuzz"');
		expect(KEYWORD_SYSTEM_PROMPT).not.toContain('"RankSeg"');
	});

	it("resolves OpenAI-compatible /chat/completions and /models endpoints without double /v1", () => {
		expect(resolveKeywordLlmChatUrl("")).toBe(
			"https://x666.me/v1/chat/completions",
		);
		expect(resolveKeywordLlmModelsUrl("")).toBe("https://x666.me/v1/models");
		expect(resolveKeywordLlmChatUrl("https://my-gateway.example.com")).toBe(
			"https://my-gateway.example.com/v1/chat/completions",
		);
		expect(resolveKeywordLlmChatUrl("http://localhost:11434/v1/")).toBe(
			"http://localhost:11434/v1/chat/completions",
		);
		expect(
			resolveKeywordLlmModelsUrl("http://localhost:8000/v1/chat/completions"),
		).toBe("http://localhost:8000/v1/models");
		expect(
			resolveKeywordLlmChatUrl("https://openrouter.ai/api/v1/models"),
		).toBe("https://openrouter.ai/api/v1/chat/completions");
	});

	it("parses JSON responses (with <think> blocks or code fences) and sorts /models alphabetically with configured model first", async () => {
		const parsed = parseKeywordBatchJson(
			`<think>Analyzing subfield and methodology</think>\n\`\`\`json\n{"0":["Code Generation","Random Testing","Unit Test Generation"],"1":["Vulnerability Detection","Static Analysis"]}\n\`\`\``,
		);
		expect(parsed).toEqual({
			"0": ["Code Generation", "Random Testing", "Unit Test Generation"],
			"1": ["Vulnerability Detection", "Static Analysis"],
		});

		const models = await fetchKeywordLlmModels(
			{
				baseUrl: "https://openrouter.ai/api/v1",
				model: "qwen/qwen3-coder:free",
			},
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "openai/gpt-4o-mini" },
							{ id: "anthropic/claude-3.5-sonnet" },
							{ id: "qwen/qwen3-coder:free" },
						],
					}),
					{ status: 200 },
				),
		);
		expect(models).toEqual([
			"qwen/qwen3-coder:free",
			"anthropic/claude-3.5-sonnet",
			"openai/gpt-4o-mini",
		]);

		const defaultModels = await fetchKeywordLlmModels(
			undefined,
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "gpt-4o-mini" },
							{ id: "ernie-5.5-flash-preview" },
							{ id: "deepseek-v3.2" },
						],
					}),
					{ status: 200 },
				),
		);
		expect(defaultModels).toEqual([
			"ernie-5.5-flash-preview",
			"deepseek-v3.2",
			"gpt-4o-mini",
		]);

		setCachedKeywordLlmConfigForTests({
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: "sk-or-test-key",
			model: "openai/gpt-4o-mini",
		});
		let capturedUrl = "";
		let capturedBody: Record<string, unknown> = {};
		const batchMap = await extractKeywordsWithKeywordLlmBatch(
			[
				{
					id: "arxiv:2605.00001",
					title: "AutoMutate: Guided Random Testing for Rust Libraries",
					abstract:
						"We evaluate feedback-directed random testing for unit test generation.",
				},
			],
			{
				fetchFn: async (input, init) => {
					capturedUrl = String(input);
					capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<
						string,
						unknown
					>;
					return new Response(
						JSON.stringify({
							choices: [
								{
									message: {
										content:
											'{"0":["Random Testing","Unit Test Generation","Rust","Software Testing"]}',
									},
								},
							],
						}),
						{ status: 200 },
					);
				},
			},
		);

		expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(capturedBody.model).toBe("openai/gpt-4o-mini");
		expect(capturedBody.max_tokens).toBeUndefined();
		expect(capturedBody.reasoning).toEqual({
			effort: "low",
			exclude: true,
		});
		expect(
			(capturedBody.messages as Array<{ role: string; content: string }>)?.[0]
				?.content,
		).toBe(KEYWORD_SYSTEM_PROMPT);
		expect(batchMap.get("arxiv:2605.00001")).toEqual([
			"Random Testing",
			"Unit Test Generation",
			"Rust",
			"Software Testing",
		]);
	});

	it("serializes default concurrency chunks and patiently retries multiple HTTP 429s + empty reasoning outputs on the configured model", async () => {
		setCachedKeywordLlmConfigForTests({
			apiKey: "sk-test-key",
			model: DEFAULT_KEYWORD_LLM_MODEL,
		});

		let activeRequests = 0;
		let maxConcurrent = 0;
		let totalCalls = 0;

		const items = Array.from({ length: 8 }, (_, idx) => ({
			id: `arxiv:2611.${10000 + idx}`,
			title: `Automated Program Repair Study Number ${idx + 1}`,
			abstract: "Fault localization and patch validation on real defects.",
		}));

		const out = await extractKeywordsWithKeywordLlmBatch(items, {
			batchSize: 4,
			fetchFn: async (_input, init) => {
				totalCalls += 1;
				activeRequests += 1;
				maxConcurrent = Math.max(maxConcurrent, activeRequests);
				await new Promise((r) => setTimeout(r, 10));
				activeRequests -= 1;

				const body = JSON.parse(String(init?.body ?? "{}")) as {
					model?: string;
					max_tokens?: number;
					reasoning?: { effort?: string; exclude?: boolean };
				};
				// Strictly uses the user's configured model on every attempt
				expect(body.model).toBe(DEFAULT_KEYWORD_LLM_MODEL);
				expect(body.max_tokens).toBeUndefined();
				expect(body.reasoning).toEqual({ effort: "low", exclude: true });

				// Simulate 3 consecutive 429s on chunk 1, then an empty reasoning truncation on chunk 2 before succeeding
				if (totalCalls <= 3) {
					return new Response('{"error":{"message":"Rate limit exceeded"}}', {
						status: 429,
					});
				}
				if (totalCalls === 5) {
					return new Response(
						JSON.stringify({
							choices: [{ finish_reason: "length", message: { content: "" } }],
						}),
						{ status: 200 },
					);
				}
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										"0": ["Program Repair", "Fault Localization"],
										"1": ["Program Repair", "Software Testing"],
										"2": ["Patch Validation", "Program Repair"],
										"3": ["Automated Debugging", "Program Repair"],
									}),
								},
							},
						],
					}),
					{ status: 200 },
				);
			},
		});

		expect(maxConcurrent).toBe(1);
		expect(totalCalls).toBe(6); // 3x 429 + 1 ok (chunk 1) + 1 empty + 1 ok (chunk 2)
		expect(out.size).toBe(8);
		expect(out.get("arxiv:2611.10000")).toEqual([
			"Program Repair",
			"Fault Localization",
		]);
		expect(out.get("arxiv:2611.10007")).toEqual([
			"Automated Debugging",
			"Program Repair",
		]);
	});

	it("supports BYOK OpenAI-compatible endpoints with custom Base URL, optional API key, and any model ID", async () => {
		setCachedKeywordLlmConfigForTests({
			baseUrl: "http://127.0.0.1:11434/v1/",
			apiKey: "",
			model: "qwen2.5:14b",
		});

		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};
		let capturedBody: Record<string, unknown> = {};
		const batchMap = await extractKeywordsWithKeywordLlmBatch(
			[
				{
					id: "venue:sp-2026:1",
					title: "Hardware Enclaves for Confidential Container Scheduling",
					abstract:
						"We analyze trusted execution environments under memory side-channel attacks.",
				},
			],
			{
				fetchFn: async (input, init) => {
					capturedUrl = String(input);
					capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
					capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<
						string,
						unknown
					>;
					return new Response(
						JSON.stringify({
							choices: [
								{
									message: {
										content:
											'{"0":["Trusted Execution Environment","Confidential Computing","Side-Channel Analysis"]}',
									},
								},
							],
						}),
						{ status: 200 },
					);
				},
			},
		);

		expect(capturedUrl).toBe("http://127.0.0.1:11434/v1/chat/completions");
		expect(capturedHeaders.Authorization).toBeUndefined();
		expect(capturedBody.model).toBe("qwen2.5:14b");
		expect(capturedBody.max_tokens).toBeUndefined();
		expect(capturedBody.reasoning).toEqual({ effort: "low", exclude: true });
		expect(batchMap.get("venue:sp-2026:1")).toEqual([
			"Trusted Execution Environment",
			"Confidential Computing",
			"Side-Channel Analysis",
		]);
	});

	it("falls back cleanly without reasoning when an endpoint rejects reasoning with HTTP 400/422", async () => {
		setCachedKeywordLlmConfigForTests({
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKey: "sk-local",
			model: "local-instruct",
		});

		const bodies: Array<Record<string, unknown>> = [];
		const out = await extractKeywordsWithKeywordLlmBatch(
			[
				{
					id: "p1",
					title: "Static Taint Analysis for Rust",
					abstract: "Abstract 1",
				},
				{
					id: "p2",
					title: "Coverage-Guided Fuzzing for Kernel",
					abstract: "Abstract 2",
				},
			],
			{
				batchSize: 1,
				concurrency: 1,
				fetchFn: async (_input, init) => {
					const body = JSON.parse(String(init?.body ?? "{}")) as Record<
						string,
						unknown
					>;
					bodies.push(body);
					if (body.reasoning !== undefined) {
						return new Response('{"error":"unknown field: reasoning"}', {
							status: 422,
						});
					}
					return new Response(
						JSON.stringify({
							choices: [
								{
									message: {
										content:
											'{"0":["Static Analysis","Rust","Taint Analysis"]}',
									},
								},
							],
						}),
						{ status: 200 },
					);
				},
			},
		);

		// Chunk 0: tries reasoning -> 422 -> retries without reasoning -> 200.
		// Chunk 1: skips reasoning directly -> 200 (3 total calls instead of 4).
		expect(bodies).toHaveLength(3);
		expect(bodies[0]?.reasoning).toEqual({ effort: "low", exclude: true });
		expect(bodies[1]?.reasoning).toBeUndefined();
		expect(bodies[1]?.temperature).toBe(0);
		expect(bodies[2]?.reasoning).toBeUndefined();
		expect(out.size).toBe(2);
	});

	it("preserves full untruncated abstracts in user prompts and retries HTTP 429 Retry-After + 503 transient errors", async () => {
		setCachedKeywordLlmConfigForTests({
			baseUrl: "http://127.0.0.1:8011/v1",
			apiKey: "",
			model: "mercury-3-instant",
		});

		const filler = "Background motivation on distributed verification. ".repeat(
			45,
		); // ~2205 chars (> 1600)
		const tailMethod =
			"We introduce Relational E-Graph Saturation with Counterexample-Guided Inductive Generalization.";
		const longAbstract = `${filler}${tailMethod}`;
		expect(longAbstract.length).toBeGreaterThan(2200);

		let capturedUserPrompt = "";
		let attempts = 0;

		const out = await extractKeywordsWithKeywordLlmBatch(
			[
				{
					id: "arxiv:2612.00001",
					title: "Scalable Relational Verification via Equality Saturation",
					abstract: longAbstract,
				},
			],
			{
				fetchFn: async (_input, init) => {
					attempts += 1;
					const parsed = JSON.parse(String(init?.body ?? "{}")) as {
						messages?: Array<{ role: string; content: string }>;
					};
					capturedUserPrompt = parsed.messages?.[1]?.content ?? "";

					if (attempts === 1) {
						return new Response('{"error":"rate limited"}', {
							status: 429,
							headers: { "Retry-After": "1" },
						});
					}
					if (attempts === 2) {
						return new Response("upstream overloaded", {
							status: 503,
							headers: { "Retry-After": "1" },
						});
					}
					return new Response(
						JSON.stringify({
							choices: [
								{
									message: {
										content:
											'{"0":["Equality Saturation","Relational Verification","Inductive Generalization"]}',
									},
								},
							],
						}),
						{ status: 200 },
					);
				},
			},
		);

		expect(attempts).toBe(3);
		expect(capturedUserPrompt).toContain("Relational E-Graph Saturation");
		expect(capturedUserPrompt).toContain(
			"Counterexample-Guided Inductive Generalization",
		);
		expect(out.get("arxiv:2612.00001")).toEqual([
			"Equality Saturation",
			"Relational Verification",
			"Inductive Generalization",
		]);
	});
});
