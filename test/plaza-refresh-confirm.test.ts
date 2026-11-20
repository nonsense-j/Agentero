// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CollectionRefreshConfirmDialog,
	type CollectionRefreshRequest,
	type CollectionRefreshSelection,
} from "@/components/plaza/collection-refresh-confirm-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import i18n from "@/i18n";
import {
	PLAZA_SOURCES,
	plazaSourceLabel,
	plazaTitleForPath,
} from "@/lib/plaza";
import { DEFAULT_KEYWORD_LLM_SETTINGS } from "@/lib/settings/defaults";
import type { AppSettings, KeywordLlmSettings } from "@/lib/settings/types";

const mockHasBuiltinKey = vi.fn(async () => false);
const mockProbeKeywordLlm = vi.fn(async () => true);
const mockOpenSettingsWindow = vi.fn();

let mockKeywordLlm: KeywordLlmSettings = { ...DEFAULT_KEYWORD_LLM_SETTINGS };
const settingsListeners = new Set<(next: AppSettings) => void>();

vi.mock("@/lib/keyword-llm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/keyword-llm")>();
	return {
		...actual,
		hasBuiltinKeywordLlmKey: () => mockHasBuiltinKey(),
		probeKeywordLlm: (...args: Parameters<typeof actual.probeKeywordLlm>) => {
			void args;
			return mockProbeKeywordLlm();
		},
	};
});

vi.mock("@/lib/settings", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/settings")>();
	const buildSnapshot = (): AppSettings => ({
		...actual.loadSettings(),
		keywordLlm: { ...mockKeywordLlm },
	});
	return {
		...actual,
		loadSettings: () => buildSnapshot(),
		ensureSettingsLoaded: async () => buildSnapshot(),
		subscribeSettings: (listener: (next: AppSettings) => void) => {
			settingsListeners.add(listener);
			return () => {
				settingsListeners.delete(listener);
			};
		},
	};
});

vi.mock("@/lib/shell/settings-window", () => ({
	openSettingsWindow: (section?: string) => mockOpenSettingsWindow(section),
}));

let root: Root;
let container: HTMLDivElement;

async function flushMicrotasks() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function renderDialog(
	request: CollectionRefreshRequest | null,
	onConfirm: (
		req: CollectionRefreshRequest,
		selection: CollectionRefreshSelection,
	) => void = () => {},
	onOpenChange: (open: boolean) => void = () => {},
) {
	await act(async () => {
		root.render(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(
					TooltipProvider,
					null,
					createElement(CollectionRefreshConfirmDialog, {
						request,
						onOpenChange,
						onConfirm,
					}),
				),
			),
		);
	});
	await flushMicrotasks();
}

const buttons = () => [...document.body.querySelectorAll("button")];
const buttonByText = (text: string) =>
	buttons().find((btn) => btn.textContent?.trim() === text);
const checkboxes = () => [
	...document.body.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'),
];

async function click(el: Element | undefined) {
	if (!el) throw new Error("Expected element to click");
	await act(async () => {
		el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	await i18n.changeLanguage("en");
	mockKeywordLlm = { ...DEFAULT_KEYWORD_LLM_SETTINGS };
	mockHasBuiltinKey.mockReset().mockResolvedValue(false);
	mockProbeKeywordLlm.mockReset().mockResolvedValue(true);
	mockOpenSettingsWindow.mockReset();
	settingsListeners.clear();

	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	await i18n.changeLanguage("en");
});

describe("Plaza Paper ** localized names", () => {
	it("maps all four Paper ** Plaza entries to Chinese names in zh-CN and preserves English in en", async () => {
		await i18n.changeLanguage("zh-CN");
		expect(
			PLAZA_SOURCES.map((source) => [source.id, plazaSourceLabel(source)]),
		).toEqual([
			["collection", "论文集"],
			["discover", "论文发现"],
			["survey", "论文综述"],
			["arxiv-rec", "论文推荐"],
			["ccf-deadlines", "CCF Deadline"],
		]);
		expect(plazaTitleForPath("agentero:plaza/collection")).toBe("论文集");
		expect(plazaTitleForPath("agentero:plaza/discover")).toBe("论文发现");
		expect(plazaTitleForPath("agentero:plaza/survey")).toBe("论文综述");
		expect(plazaTitleForPath("agentero:plaza/arxiv-rec")).toBe("论文推荐");

		await i18n.changeLanguage("en");
		expect(
			PLAZA_SOURCES.map((source) => [source.id, plazaSourceLabel(source)]),
		).toEqual([
			["collection", "Paper Collection"],
			["discover", "Paper Discover"],
			["survey", "Paper Survey"],
			["arxiv-rec", "Paper Recommend"],
			["ccf-deadlines", "CCF Deadline"],
		]);
	});
});

describe("CollectionRefreshConfirmDialog", () => {
	it("defaults 'all' scope to arXiv incremental checked and Venue full re-fetch unchecked", async () => {
		const onConfirm = vi.fn();
		const onOpenChange = vi.fn();

		await renderDialog({ scope: "all" }, onConfirm, onOpenChange);

		const text = document.body.textContent ?? "";
		expect(text).toContain("Incremental");
		expect(text).toContain("Full re-fetch · Skip advised");

		const [arxivBox, venueBox] = checkboxes();
		expect(arxivBox?.getAttribute("aria-checked")).toBe("true");
		expect(venueBox?.getAttribute("aria-checked")).toBe("false");

		// Default confirm refreshes arXiv only, avoiding accidental full Venue re-fetch.
		await click(buttonByText("Refresh"));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onConfirm).toHaveBeenCalledWith(
			{ scope: "all" },
			{ arxiv: true, venue: false },
		);
	});

	it("switches CTA to warning label when Venue is opted in and disables confirm when both are unchecked", async () => {
		const onConfirm = vi.fn();
		await renderDialog({ scope: "all" }, onConfirm);

		const [arxivBox, venueBox] = checkboxes();
		await click(arxivBox);
		expect(buttonByText("Refresh")?.disabled).toBe(true);

		await click(venueBox);
		const anywayBtn = buttonByText("Refresh anyway");
		expect(anywayBtn).toBeDefined();
		expect(anywayBtn?.disabled).toBe(false);

		await click(anywayBtn);
		expect(onConfirm).toHaveBeenCalledWith(
			{ scope: "all" },
			{ arxiv: false, venue: true },
		);
	});

	it("shows Keyword LLM unconfigured state and opens general settings", async () => {
		await renderDialog({ scope: "arxiv", targetLabel: "cs.SE" });

		const text = document.body.textContent ?? "";
		expect(text).toContain("Refresh cs.SE");
		expect(text).toContain("Not configured");
		expect(mockProbeKeywordLlm).not.toHaveBeenCalled();

		await click(buttonByText("Settings"));
		expect(mockOpenSettingsWindow).toHaveBeenCalledWith("general");
	});

	it("probes Keyword LLM and reflects Ready / Unavailable with recheck support", async () => {
		mockKeywordLlm = {
			...DEFAULT_KEYWORD_LLM_SETTINGS,
			apiKey: "sk-live-key",
		};
		mockProbeKeywordLlm
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);

		await renderDialog({
			scope: "venue",
			venueIds: ["ase-2026"],
			targetLabel: "ASE 2026",
		});

		expect(mockProbeKeywordLlm).toHaveBeenCalledTimes(1);
		expect(document.body.textContent ?? "").toContain("Unavailable");
		expect(buttonByText("Refresh anyway")).toBeDefined();

		const recheckBtn = document.body.querySelector(
			'button[aria-label="Recheck"]',
		);
		await click(recheckBtn ?? undefined);
		await flushMicrotasks();

		expect(mockProbeKeywordLlm).toHaveBeenCalledTimes(2);
		expect(document.body.textContent ?? "").toContain("Ready");
	});
});
