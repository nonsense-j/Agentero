import {
	ArrowLeft,
	ExternalLink,
	KeyRound,
	LoaderCircle,
	Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChoiceCard } from "@/components/onboarding/choice-card";
import type { OnboardingStepId } from "@/components/onboarding/flow";
import { KeywordLlmModelPicker } from "@/components/settings/keyword-llm-model-picker";
import { ProbeDot } from "@/components/settings/provider-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { openExternalUrl } from "@/lib/core/open-external";
import { hasSecret, isSecretMask, maskSecret } from "@/lib/core/secret-mask";
import {
	fetchKeywordLlmModels,
	hasBuiltinKeywordLlmKey,
	isKeywordLlmConfigured,
	probeKeywordLlm,
	switchKeywordLlmProviderDraft,
} from "@/lib/keyword-llm";
import { OPENALEX_KEY_URL, probeOpenAlexKey } from "@/lib/openalex";
import {
	type AppSettings,
	DEFAULT_OPEN_ROUTER_MODEL,
	DEFAULT_X666_MODEL,
	KEYWORD_LLM_PROVIDER_IDS,
	KEYWORD_LLM_PROVIDER_PRESETS,
	type KeywordLlmProviderId,
	type KeywordLlmSettings,
	saveSettingsAsync,
} from "@/lib/settings";
import type { ProbeStatus } from "@/lib/ui/probe-status";

const PROVIDER_LABEL_KEYS = {
	x666: "openalex.providerX666",
	openrouter: "openalex.providerOpenRouter",
	openaiCompatible: "openalex.providerOpenAiCompatible",
} as const satisfies Record<KeywordLlmProviderId, string>;

const PROBE_LABEL_KEYS = {
	ok: "openalex.probeOk",
	fail: "openalex.probeFail",
	probing: "openalex.probeProbing",
	idle: "openalex.probeIdle",
} as const satisfies Record<ProbeStatus, string>;

function normalizeKeywordLlm(value: KeywordLlmSettings): KeywordLlmSettings {
	return {
		provider: value.provider,
		baseUrl: value.baseUrl.trim(),
		apiKey: value.apiKey.trim(),
		model: value.model.trim(),
	};
}

function keywordLlmEqual(
	a: KeywordLlmSettings,
	b: KeywordLlmSettings,
): boolean {
	return (
		a.provider === b.provider &&
		a.baseUrl === b.baseUrl &&
		a.apiKey === b.apiKey &&
		a.model === b.model
	);
}

export function OpenAlexStep({
	settings,
	patch,
	onUseDefault,
	onNextChange,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	/** User picked "skip for now" — wizard should advance immediately. */
	onUseDefault: () => void;
	/** Report whether Next is enabled. */
	onNextChange: (id: OnboardingStepId, allowed: boolean) => void;
}) {
	const { t } = useTranslation("onboarding");
	const [mode, setMode] = useState<"choose" | "configure">("choose");
	const [draftOpenAlexKey, setDraftOpenAlexKey] = useState<string | undefined>(
		undefined,
	);
	const [draftKeywordLlm, setDraftKeywordLlm] = useState<KeywordLlmSettings>(
		settings.keywordLlm,
	);
	const [openAlexProbe, setOpenAlexProbe] = useState<ProbeStatus>("idle");
	const [keywordProbe, setKeywordProbe] = useState<ProbeStatus>("idle");
	const [models, setModels] = useState<string[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const [hasBuiltinKey, setHasBuiltinKey] = useState(false);

	const latestKeywordLlmRef = useRef(settings.keywordLlm);
	latestKeywordLlmRef.current = draftKeywordLlm;

	useEffect(() => {
		setDraftKeywordLlm(settings.keywordLlm);
	}, [settings.keywordLlm]);

	useEffect(() => {
		let cancelled = false;
		void hasBuiltinKeywordLlmKey().then((ok) => {
			if (!cancelled) setHasBuiltinKey(ok);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	// Both OpenAlex and keyword LLM fallback are optional, so Next is always allowed.
	useEffect(() => {
		onNextChange("openalex", true);
	}, [onNextChange]);

	const loadModels = useCallback(async (override?: KeywordLlmSettings) => {
		setLoadingModels(true);
		try {
			const list = await fetchKeywordLlmModels(
				normalizeKeywordLlm(override ?? latestKeywordLlmRef.current),
			);
			setModels(list);
		} finally {
			setLoadingModels(false);
		}
	}, []);

	useEffect(() => {
		if (mode === "configure") {
			void loadModels(latestKeywordLlmRef.current);
		}
	}, [mode, loadModels]);

	const savedOpenAlexKey = settings.openAlexKey;
	const displayOpenAlexKey =
		draftOpenAlexKey !== undefined ? draftOpenAlexKey : savedOpenAlexKey;

	const persistOpenAlexIfChanged = async (
		rawValue: string,
	): Promise<string> => {
		const trimmed = rawValue.trim();
		if (trimmed === savedOpenAlexKey.trim()) return trimmed;
		const next = await saveSettingsAsync({
			...settings,
			openAlexKey: trimmed,
		});
		patch({ openAlexKey: next.openAlexKey });
		setDraftOpenAlexKey(undefined);
		return trimmed;
	};

	const persistKeywordLlm = async (
		nextDraft: KeywordLlmSettings,
	): Promise<KeywordLlmSettings> => {
		const trimmed = normalizeKeywordLlm(nextDraft);
		const savedTrimmed = normalizeKeywordLlm(settings.keywordLlm);
		if (keywordLlmEqual(trimmed, savedTrimmed)) {
			return settings.keywordLlm;
		}
		const next = await saveSettingsAsync({
			...settings,
			keywordLlm: trimmed,
		});
		patch({ keywordLlm: next.keywordLlm });
		setDraftKeywordLlm(next.keywordLlm);
		return next.keywordLlm;
	};

	const confirmOpenAlex = async () => {
		const trimmed = displayOpenAlexKey.trim();
		if (!trimmed) return;
		await persistOpenAlexIfChanged(trimmed);
		setOpenAlexProbe("probing");
		const ok = await probeOpenAlexKey(isSecretMask(trimmed) ? null : trimmed);
		setOpenAlexProbe(ok ? "ok" : "fail");
	};

	const handleProviderChange = (value: string) => {
		const nextProvider = value as KeywordLlmProviderId;
		setModels([]);
		setKeywordProbe("idle");
		const updated = switchKeywordLlmProviderDraft(
			draftKeywordLlm,
			nextProvider,
		);
		setDraftKeywordLlm(updated);
		void persistKeywordLlm(updated);
	};

	const confirmKeywordLlm = async () => {
		if (!keywordConfigured) return;
		await persistKeywordLlm(draftKeywordLlm);
		setKeywordProbe("probing");
		const ok = await probeKeywordLlm(null);
		setKeywordProbe(ok ? "ok" : "fail");
	};

	const modelOptions = useMemo(() => {
		const unique = new Set<string>();
		if (draftKeywordLlm.provider === "x666") {
			unique.add(DEFAULT_X666_MODEL);
		} else if (draftKeywordLlm.provider === "openrouter") {
			unique.add(DEFAULT_OPEN_ROUTER_MODEL);
		}
		for (const id of models) {
			if (id.trim()) unique.add(id.trim());
		}
		return Array.from(unique);
	}, [draftKeywordLlm.provider, models]);

	const keywordConfigured =
		isKeywordLlmConfigured(draftKeywordLlm) ||
		(draftKeywordLlm.provider === "x666" && hasBuiltinKey);
	const keyUrl = KEYWORD_LLM_PROVIDER_PRESETS[draftKeywordLlm.provider].keyUrl;
	const canRefreshModels =
		hasSecret(draftKeywordLlm.apiKey) ||
		Boolean(draftKeywordLlm.baseUrl.trim()) ||
		(draftKeywordLlm.provider === "x666" && hasBuiltinKey);
	const modelPlaceholder =
		draftKeywordLlm.provider === "x666"
			? DEFAULT_X666_MODEL
			: draftKeywordLlm.provider === "openrouter"
				? DEFAULT_OPEN_ROUTER_MODEL
				: t("openalex.keywordModelPlaceholder");

	if (mode === "choose") {
		return (
			<div className="grid grid-cols-2 gap-3">
				<ChoiceCard
					icon={<KeyRound className="size-5 text-muted-foreground" />}
					title={t("openalex.configureOwn")}
					description={t("openalex.configureOwnDesc")}
					onClick={() => setMode("configure")}
				/>
				<ChoiceCard
					icon={<Sparkles className="size-5 text-muted-foreground" />}
					title={t("openalex.useDefault")}
					description={t("openalex.useDefaultDesc")}
					recommended
					recommendedLabel={t("recommended")}
					onClick={onUseDefault}
				/>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="space-y-2 rounded-lg border border-border/70 p-3">
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="-ml-1.5 shrink-0"
						aria-label={t("actions.back")}
						title={t("actions.back")}
						onClick={() => setMode("choose")}
					>
						<ArrowLeft className="size-4" />
					</Button>
					<span className="font-medium text-sm">
						{t("openalex.primaryLabel")}
					</span>
					<Button
						type="button"
						variant="ghost"
						size="xs"
						className="shrink-0"
						onClick={() => void openExternalUrl(OPENALEX_KEY_URL)}
					>
						<ExternalLink data-icon="inline-start" className="size-3.5" />
						{t("openalex.openDocsLabel")}
					</Button>
					<div className="ml-auto flex items-center gap-2">
						<ProbeDot
							status={openAlexProbe}
							configured={hasSecret(displayOpenAlexKey)}
							label={t(PROBE_LABEL_KEYS[openAlexProbe])}
							title={t(PROBE_LABEL_KEYS[openAlexProbe])}
						/>
						<Button
							type="button"
							size="xs"
							className={
								openAlexProbe === "probing" ? "disabled:opacity-100" : undefined
							}
							disabled={
								openAlexProbe === "probing" || !displayOpenAlexKey.trim()
							}
							onClick={() => void confirmOpenAlex()}
						>
							{openAlexProbe === "probing" ? (
								<LoaderCircle
									data-icon="inline-start"
									className="animate-spin"
								/>
							) : null}
							{t("openalex.test")}
						</Button>
					</div>
				</div>
				<Input
					type="password"
					autoComplete="off"
					value={displayOpenAlexKey}
					placeholder={t("openalex.apiKeyPlaceholder")}
					aria-label={t("openalex.apiKeyPlaceholder")}
					onChange={(e) => {
						const next = e.currentTarget.value;
						const shownMask = hasSecret(savedOpenAlexKey)
							? isSecretMask(savedOpenAlexKey)
								? savedOpenAlexKey
								: maskSecret(savedOpenAlexKey)
							: null;
						if (
							shownMask != null &&
							(next === shownMask || next.startsWith(shownMask))
						) {
							setDraftOpenAlexKey(next.slice(shownMask.length));
						} else {
							setDraftOpenAlexKey(next);
						}
						setOpenAlexProbe("idle");
					}}
					onBlur={() => {
						if (draftOpenAlexKey !== undefined) {
							void persistOpenAlexIfChanged(draftOpenAlexKey);
						}
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							void confirmOpenAlex();
						}
					}}
					className="h-8"
				/>
			</div>

			<div className="space-y-2 rounded-lg border border-border/70 p-3">
				<div className="flex items-center gap-2">
					<span className="font-medium text-sm">
						{t("openalex.keywordLlmLabel")}
					</span>
					{keyUrl ? (
						<Button
							type="button"
							variant="ghost"
							size="xs"
							className="shrink-0"
							onClick={() => void openExternalUrl(keyUrl)}
						>
							<ExternalLink data-icon="inline-start" className="size-3.5" />
							{t("openalex.openDocsLabel")}
						</Button>
					) : null}
					<div className="ml-auto flex items-center gap-2">
						<ProbeDot
							status={keywordProbe}
							configured={keywordConfigured}
							label={t(PROBE_LABEL_KEYS[keywordProbe])}
							title={t(PROBE_LABEL_KEYS[keywordProbe])}
						/>
						<Button
							type="button"
							size="xs"
							className={
								keywordProbe === "probing" ? "disabled:opacity-100" : undefined
							}
							disabled={keywordProbe === "probing" || !keywordConfigured}
							onClick={() => void confirmKeywordLlm()}
						>
							{keywordProbe === "probing" ? (
								<LoaderCircle
									data-icon="inline-start"
									className="animate-spin"
								/>
							) : null}
							{t("openalex.test")}
						</Button>
					</div>
				</div>

				<Select
					value={draftKeywordLlm.provider}
					onValueChange={handleProviderChange}
				>
					<SelectTrigger size="sm" className="h-8 w-full text-xs">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{KEYWORD_LLM_PROVIDER_IDS.map((id) => (
							<SelectItem key={id} value={id} className="text-xs">
								{t(PROVIDER_LABEL_KEYS[id])}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<Input
					type="url"
					autoComplete="off"
					value={draftKeywordLlm.baseUrl}
					placeholder={
						KEYWORD_LLM_PROVIDER_PRESETS[draftKeywordLlm.provider].baseUrl ||
						t("openalex.baseUrlPlaceholder")
					}
					aria-label={t("openalex.baseUrlPlaceholder")}
					onChange={(e) => {
						const nextUrl = e.currentTarget.value;
						setDraftKeywordLlm((prev) => ({ ...prev, baseUrl: nextUrl }));
						setKeywordProbe("idle");
					}}
					onBlur={() => void persistKeywordLlm(draftKeywordLlm)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							void confirmKeywordLlm();
						}
					}}
					className="h-8 font-mono text-xs"
				/>

				<Input
					type="password"
					autoComplete="off"
					value={draftKeywordLlm.apiKey}
					placeholder={t(
						draftKeywordLlm.provider === "x666" && hasBuiltinKey
							? "openalex.keywordKeyPlaceholderBuiltin"
							: "openalex.keywordKeyPlaceholder",
					)}
					aria-label={t(
						draftKeywordLlm.provider === "x666" && hasBuiltinKey
							? "openalex.keywordKeyPlaceholderBuiltin"
							: "openalex.keywordKeyPlaceholder",
					)}
					onChange={(e) => {
						const next = e.currentTarget.value;
						const savedKey = settings.keywordLlm.apiKey;
						const shownMask = hasSecret(savedKey)
							? isSecretMask(savedKey)
								? savedKey
								: maskSecret(savedKey)
							: null;
						const resolvedKey =
							shownMask != null &&
							(next === shownMask || next.startsWith(shownMask))
								? next.slice(shownMask.length)
								: next;
						setDraftKeywordLlm((prev) => ({ ...prev, apiKey: resolvedKey }));
						setKeywordProbe("idle");
					}}
					onBlur={() => void persistKeywordLlm(draftKeywordLlm)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							void confirmKeywordLlm();
						}
					}}
					className="h-8 font-mono text-xs"
				/>

				<KeywordLlmModelPicker
					compact
					value={draftKeywordLlm.model}
					placeholder={modelPlaceholder}
					ariaLabel={t("openalex.keywordModelPlaceholder")}
					options={modelOptions}
					refreshing={loadingModels}
					canRefresh={canRefreshModels}
					chooseLabel={t("openalex.chooseModel")}
					searchPlaceholder={t("openalex.searchModels")}
					emptyLabel={t("openalex.noModelsFound")}
					refreshLabel={t("openalex.refreshModels")}
					onChange={(nextModel) => {
						setDraftKeywordLlm((prev) => ({ ...prev, model: nextModel }));
						setKeywordProbe("idle");
					}}
					onSelectOption={(nextModel) => {
						const updated = { ...draftKeywordLlm, model: nextModel };
						setDraftKeywordLlm(updated);
						setKeywordProbe("idle");
						void persistKeywordLlm(updated);
					}}
					onBlur={() => void persistKeywordLlm(draftKeywordLlm)}
					onSubmit={() => void confirmKeywordLlm()}
					onRefreshModels={() => loadModels(draftKeywordLlm)}
				/>
			</div>
		</div>
	);
}
