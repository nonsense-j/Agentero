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
	DEFAULT_KEYWORD_LLM_SETTINGS,
	DEFAULT_OPEN_ROUTER_BASE_URL,
	DEFAULT_OPEN_ROUTER_MODEL,
	DEFAULT_SETTINGS,
} from "@/lib/settings/defaults";
import { applyExternalSettings, loadSettings } from "@/lib/settings/store";
import type { AppSettings } from "@/lib/settings/types";

afterEach(() => {
	setCachedKeywordLlmConfigForTests(undefined);
	applyExternalSettings(DEFAULT_SETTINGS);
});

describe("Keyword LLM settings migration, URL resolution & batch extraction", () => {
	it("migrates legacy openRouterKey/openRouterModel into keywordLlm and preserves BYOK settings", () => {
		expect(DEFAULT_KEYWORD_LLM_SETTINGS).toEqual({
			provider: "openrouter",
			baseUrl: DEFAULT_OPEN_ROUTER_BASE_URL,
			apiKey: "",
			model: DEFAULT_OPEN_ROUTER_MODEL,
		});

		const legacyPayload = {
			...DEFAULT_SETTINGS,
			openRouterKey: "sk-or-legacy-123",
			openRouterModel: "openai/gpt-4o-mini",
		} as Record<string, unknown>;
		delete legacyPayload.keywordLlm;
		applyExternalSettings(legacyPayload as unknown as AppSettings);

		expect(loadSettings().keywordLlm).toEqual({
			provider: "openrouter",
			baseUrl: DEFAULT_OPEN_ROUTER_BASE_URL,
			apiKey: "sk-or-legacy-123",
			model: "openai/gpt-4o-mini",
		});

		applyExternalSettings({
			...DEFAULT_SETTINGS,
			keywordLlm: {
				provider: "openaiCompatible",
				baseUrl: "  https://api.example.com/v1/  ",
				apiKey: "  sk-byok-456 ",
				model: " gpt-4.1-mini ",
			},
		});

		expect(loadSettings().keywordLlm).toEqual({
			provider: "openaiCompatible",
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
		expect(resolveKeywordLlmChatUrl("", "openaiCompatible")).toBe(
			"https://api.openai.com/v1/chat/completions",
		);
		expect(resolveKeywordLlmModelsUrl("", "openaiCompatible")).toBe(
			"https://api.openai.com/v1/models",
		);
		expect(
			resolveKeywordLlmChatUrl(
				"https://my-gateway.example.com",
				"openaiCompatible",
			),
		).toBe("https://my-gateway.example.com/v1/chat/completions");
		expect(
			resolveKeywordLlmChatUrl(
				"http://localhost:11434/v1/",
				"openaiCompatible",
			),
		).toBe("http://localhost:11434/v1/chat/completions");
		expect(
			resolveKeywordLlmModelsUrl(
				"http://localhost:8000/v1/chat/completions",
				"openaiCompatible",
			),
		).toBe("http://localhost:8000/v1/models");
		expect(
			resolveKeywordLlmChatUrl(
				"https://openrouter.ai/api/v1/models",
				"openrouter",
			),
		).toBe("https://openrouter.ai/api/v1/chat/completions");
	});

	it("parses JSON responses (with <think> blocks or code fences) on OpenRouter preset including non-free models", async () => {
		const parsed = parseKeywordBatchJson(
			`<think>Analyzing subfield and methodology</think>\n\`\`\`json\n{"0":["Code Generation","Random Testing","Unit Test Generation"],"1":["Vulnerability Detection","Static Analysis"]}\n\`\`\``,
		);
		expect(parsed).toEqual({
			"0": ["Code Generation", "Random Testing", "Unit Test Generation"],
			"1": ["Vulnerability Detection", "Static Analysis"],
		});

		const models = await fetchKeywordLlmModels(
			{ provider: "openrouter" },
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "openai/gpt-4o-mini" },
							{ id: "qwen/qwen3-coder:free" },
						],
					}),
					{ status: 200 },
				),
		);
		expect(models).toEqual([
			"baidu/ernie-5.5-flash-preview:free",
			"qwen/qwen3-coder:free",
			"openai/gpt-4o-mini",
		]);

		setCachedKeywordLlmConfigForTests({
			provider: "openrouter",
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
		expect(capturedBody.reasoning).toEqual({
			effort: "minimal",
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

	it("supports BYOK OpenAI-compatible endpoints with custom Base URL, optional API key, and any model ID", async () => {
		setCachedKeywordLlmConfigForTests({
			provider: "openaiCompatible",
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
		expect(capturedBody.reasoning).toBeUndefined();
		expect(batchMap.get("venue:sp-2026:1")).toEqual([
			"Trusted Execution Environment",
			"Confidential Computing",
			"Side-Channel Analysis",
		]);
	});
});
