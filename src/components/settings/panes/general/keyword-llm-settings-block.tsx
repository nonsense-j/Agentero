import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeywordLlmModelPicker } from "@/components/settings/keyword-llm-model-picker";
import {
	PROVIDER_INPUT_CLASS,
	ProbeDot,
	ProviderCard,
	ProviderCardHeader,
	ProviderFieldRow,
} from "@/components/settings/provider-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { openExternalUrl } from "@/lib/core/open-external";
import { hasSecret, isSecretMask, maskSecret } from "@/lib/core/secret-mask";
import {
	fetchKeywordLlmModels,
	hasBuiltinKeywordLlmKey,
	isKeywordLlmConfigured,
	type KeywordLlmProbeStatus,
	probeKeywordLlm,
	switchKeywordLlmProviderDraft,
} from "@/lib/keyword-llm";
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

const PROVIDER_LABEL_KEYS = {
	x666: "general.keywordLlm.providerX666",
	openrouter: "general.keywordLlm.providerOpenRouter",
	openaiCompatible: "general.keywordLlm.providerOpenAiCompatible",
} as const satisfies Record<KeywordLlmProviderId, string>;

function normalizeDraft(value: KeywordLlmSettings): KeywordLlmSettings {
	return {
		provider: value.provider,
		baseUrl: value.baseUrl.trim(),
		apiKey: value.apiKey.trim(),
		model: value.model.trim(),
	};
}

export function KeywordLlmSettingsBlock({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation("settings");
	const saved = settings.keywordLlm;

	const [draft, setDraft] = useState<KeywordLlmSettings>(saved);
	const [status, setStatus] = useState<KeywordLlmProbeStatus>("idle");
	const [saving, setSaving] = useState(false);
	const [models, setModels] = useState<string[]>([]);
	const [refreshingModels, setRefreshingModels] = useState(false);
	const [hasBuiltinKey, setHasBuiltinKey] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		setDraft(saved);
	}, [saved]);

	useEffect(() => {
		let cancelled = false;
		void hasBuiltinKeywordLlmKey().then((ok) => {
			if (!cancelled) setHasBuiltinKey(ok);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const configured =
		isKeywordLlmConfigured(saved) ||
		(saved.provider === "x666" && hasBuiltinKey);

	const runProbe = useCallback(async () => {
		if (!configured) {
			setStatus("idle");
			return;
		}
		abortRef.current?.abort();
		const ac = new AbortController();
		abortRef.current = ac;
		setStatus("probing");
		const ok = await probeKeywordLlm(null, ac.signal);
		if (ac.signal.aborted) return;
		setStatus(ok ? "ok" : "fail");
	}, [configured]);

	useEffect(() => {
		void runProbe();
		return () => {
			abortRef.current?.abort();
		};
	}, [runProbe]);

	useEffect(() => {
		if (!configured) return;
		let cancelled = false;
		void fetchKeywordLlmModels(normalizeDraft(saved)).then((list) => {
			if (!cancelled && list.length > 0) {
				setModels(list);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [configured, saved]);

	const changed = useMemo(() => {
		const a = normalizeDraft(saved);
		const b = normalizeDraft(draft);
		return (
			a.provider !== b.provider ||
			a.baseUrl !== b.baseUrl ||
			a.apiKey !== b.apiKey ||
			a.model !== b.model
		);
	}, [saved, draft]);

	const handleProviderChange = (value: string) => {
		const nextProvider = value as KeywordLlmProviderId;
		setModels([]);
		setDraft((prev) => switchKeywordLlmProviderDraft(prev, nextProvider));
	};

	const handleConfirm = async () => {
		const committed = normalizeDraft(draft);
		setSaving(true);
		try {
			const next = await saveSettingsAsync({
				...settings,
				keywordLlm: committed,
			});
			setDraft(next.keywordLlm);
			patch({ keywordLlm: next.keywordLlm });
		} finally {
			setSaving(false);
		}
	};

	const handleRefreshModels = async () => {
		setRefreshingModels(true);
		try {
			const fetched = await fetchKeywordLlmModels(normalizeDraft(draft));
			setModels(fetched);
		} finally {
			setRefreshingModels(false);
		}
	};

	const modelOptions = useMemo(() => {
		const unique = new Set<string>();
		if (draft.provider === "x666") {
			unique.add(DEFAULT_X666_MODEL);
		} else if (draft.provider === "openrouter") {
			unique.add(DEFAULT_OPEN_ROUTER_MODEL);
		}
		for (const id of models) {
			if (id.trim()) unique.add(id.trim());
		}
		return Array.from(unique);
	}, [draft.provider, models]);

	const statusLabel = t(
		status === "idle"
			? "general.keywordLlm.probeIdle"
			: status === "probing"
				? "general.keywordLlm.probeProbing"
				: status === "ok"
					? "general.keywordLlm.probeOk"
					: "general.keywordLlm.probeFail",
	);

	const keyUrl = KEYWORD_LLM_PROVIDER_PRESETS[draft.provider].keyUrl;
	const canRefreshModels =
		hasSecret(draft.apiKey) ||
		Boolean(draft.baseUrl.trim()) ||
		(draft.provider === "x666" && hasBuiltinKey);
	const keyPlaceholder =
		draft.provider === "x666"
			? t(
					hasBuiltinKey
						? "general.keywordLlm.keyPlaceholderBuiltin"
						: "general.keywordLlm.keyPlaceholderX666",
				)
			: t(
					draft.provider === "openrouter"
						? "general.keywordLlm.keyPlaceholderOpenRouter"
						: "general.keywordLlm.keyPlaceholderByok",
				);
	const modelPlaceholder =
		draft.provider === "x666"
			? DEFAULT_X666_MODEL
			: draft.provider === "openrouter"
				? DEFAULT_OPEN_ROUTER_MODEL
				: t("general.keywordLlm.modelPlaceholderByok");

	return (
		<div className="mb-5">
			<ProviderCard>
				<ProviderCardHeader
					left={
						<>
							<Tooltip>
								<TooltipTrigger asChild>
									<ProbeDot
										status={status}
										configured={configured}
										label={statusLabel}
									/>
								</TooltipTrigger>
								<TooltipContent>{statusLabel}</TooltipContent>
							</Tooltip>
							<p className="min-w-0 truncate font-medium text-sm">
								{t("general.keywordLlm.section")}
							</p>
							{keyUrl ? (
								<Button
									type="button"
									variant="link"
									size="xs"
									className="-ml-1.5 h-auto shrink-0 px-1.5 text-primary"
									onClick={() => void openExternalUrl(keyUrl)}
								>
									<ExternalLink data-icon="inline-start" className="size-3" />
									{t("general.keywordLlm.openKeyPage")}
								</Button>
							) : null}
						</>
					}
					right={
						<Button
							type="button"
							variant="outline"
							size="xs"
							disabled={!changed || saving || status === "probing"}
							onClick={() => void handleConfirm()}
						>
							{t("general.keywordLlm.confirm")}
						</Button>
					}
				/>
				<div className="grid gap-1.5">
					<ProviderFieldRow
						label={t("general.keywordLlm.providerLabel")}
						htmlFor="keyword-llm-provider"
					>
						<Select value={draft.provider} onValueChange={handleProviderChange}>
							<SelectTrigger
								id="keyword-llm-provider"
								size="sm"
								className="h-8 min-w-0 flex-1 text-xs"
							>
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
					</ProviderFieldRow>

					<ProviderFieldRow
						label={t("general.keywordLlm.baseUrlLabel")}
						htmlFor="keyword-llm-base-url"
					>
						<Input
							id="keyword-llm-base-url"
							type="url"
							autoComplete="off"
							placeholder={KEYWORD_LLM_PROVIDER_PRESETS[draft.provider].baseUrl}
							className={PROVIDER_INPUT_CLASS}
							value={draft.baseUrl}
							onChange={(e) => {
								const nextUrl = e.currentTarget.value;
								setDraft((prev) => ({ ...prev, baseUrl: nextUrl }));
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" && changed && !saving) {
									void handleConfirm();
								}
							}}
						/>
					</ProviderFieldRow>

					<ProviderFieldRow
						label={t("general.keywordLlm.keyLabel")}
						htmlFor="keyword-llm-key"
					>
						<Input
							id="keyword-llm-key"
							type="password"
							autoComplete="off"
							placeholder={keyPlaceholder}
							className={PROVIDER_INPUT_CLASS}
							value={draft.apiKey}
							onChange={(e) => {
								const next = e.currentTarget.value;
								const shownMask = hasSecret(saved.apiKey)
									? isSecretMask(saved.apiKey)
										? saved.apiKey
										: maskSecret(saved.apiKey)
									: null;
								const resolvedKey =
									shownMask != null &&
									(next === shownMask || next.startsWith(shownMask))
										? next.slice(shownMask.length)
										: next;
								setDraft((prev) => ({ ...prev, apiKey: resolvedKey }));
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" && changed && !saving) {
									void handleConfirm();
								}
							}}
						/>
					</ProviderFieldRow>

					<ProviderFieldRow
						label={t("general.keywordLlm.modelLabel")}
						htmlFor="keyword-llm-model"
					>
						<KeywordLlmModelPicker
							id="keyword-llm-model"
							value={draft.model}
							placeholder={modelPlaceholder}
							options={modelOptions}
							refreshing={refreshingModels}
							canRefresh={canRefreshModels}
							chooseLabel={t("general.keywordLlm.chooseModel")}
							searchPlaceholder={t("general.keywordLlm.searchModels")}
							emptyLabel={t("general.keywordLlm.noModelsFound")}
							refreshLabel={t("general.keywordLlm.refreshModels")}
							onChange={(nextModel) => {
								setDraft((prev) => ({ ...prev, model: nextModel }));
							}}
							onSubmit={() => {
								if (changed && !saving) {
									void handleConfirm();
								}
							}}
							onRefreshModels={handleRefreshModels}
						/>
					</ProviderFieldRow>
				</div>
			</ProviderCard>
		</div>
	);
}
