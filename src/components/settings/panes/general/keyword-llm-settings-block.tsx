import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { cn } from "@/lib/core/utils";
import {
	fetchKeywordLlmModels,
	isKeywordLlmConfigured,
	type KeywordLlmProbeStatus,
	OPENROUTER_KEY_URL,
	probeKeywordLlm,
} from "@/lib/keyword-llm";
import {
	type AppSettings,
	DEFAULT_OPEN_ROUTER_BASE_URL,
	DEFAULT_OPEN_ROUTER_MODEL,
	DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
	KEYWORD_LLM_PROVIDER_IDS,
	KEYWORD_LLM_PROVIDER_PRESETS,
	type KeywordLlmProviderId,
	type KeywordLlmSettings,
	saveSettingsAsync,
} from "@/lib/settings";

const KEYWORD_LLM_DATALIST_ID = "keyword-llm-models";

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
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		setDraft(saved);
	}, [saved]);

	const configured = isKeywordLlmConfigured(saved);

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
		setDraft((prev) => {
			const trimmedUrl = prev.baseUrl.trim();
			const trimmedModel = prev.model.trim();
			let nextUrl = prev.baseUrl;
			let nextModel = prev.model;
			if (nextProvider === "openrouter") {
				if (!trimmedUrl || trimmedUrl === DEFAULT_OPENAI_COMPATIBLE_BASE_URL) {
					nextUrl = DEFAULT_OPEN_ROUTER_BASE_URL;
				}
				if (!trimmedModel) {
					nextModel = DEFAULT_OPEN_ROUTER_MODEL;
				}
			} else {
				if (!trimmedUrl || trimmedUrl === DEFAULT_OPEN_ROUTER_BASE_URL) {
					nextUrl = DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
				}
				if (trimmedModel === DEFAULT_OPEN_ROUTER_MODEL) {
					nextModel = "";
				}
			}
			return {
				...prev,
				provider: nextProvider,
				baseUrl: nextUrl,
				model: nextModel,
			};
		});
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
		if (draft.provider === "openrouter") {
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

	const canRefreshModels =
		hasSecret(draft.apiKey) || Boolean(draft.baseUrl.trim());

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
							{draft.provider === "openrouter" ? (
								<Button
									type="button"
									variant="link"
									size="xs"
									className="-ml-1.5 h-auto shrink-0 px-1.5 text-primary"
									onClick={() => void openExternalUrl(OPENROUTER_KEY_URL)}
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
										{t(
											id === "openrouter"
												? "general.keywordLlm.providerOpenRouter"
												: "general.keywordLlm.providerOpenAiCompatible",
										)}
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
							placeholder={t(
								draft.provider === "openrouter"
									? "general.keywordLlm.keyPlaceholderOpenRouter"
									: "general.keywordLlm.keyPlaceholderByok",
							)}
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
						<div className="flex min-w-0 flex-1 items-center gap-1.5">
							<Input
								id="keyword-llm-model"
								list={KEYWORD_LLM_DATALIST_ID}
								autoComplete="off"
								placeholder={
									draft.provider === "openrouter"
										? DEFAULT_OPEN_ROUTER_MODEL
										: t("general.keywordLlm.modelPlaceholderByok")
								}
								className={PROVIDER_INPUT_CLASS}
								value={draft.model}
								onChange={(e) => {
									const nextModel = e.currentTarget.value;
									setDraft((prev) => ({ ...prev, model: nextModel }));
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" && changed && !saving) {
										void handleConfirm();
									}
								}}
							/>
							<datalist id={KEYWORD_LLM_DATALIST_ID}>
								{modelOptions.map((id) => (
									<option key={id} value={id} />
								))}
							</datalist>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="outline"
										size="icon-xs"
										className="size-8 shrink-0"
										disabled={refreshingModels || !canRefreshModels}
										aria-label={t("general.keywordLlm.refreshModels")}
										onClick={() => void handleRefreshModels()}
									>
										<RefreshCw
											className={cn(
												"size-3.5",
												refreshingModels && "animate-spin",
											)}
										/>
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{t("general.keywordLlm.refreshModels")}
								</TooltipContent>
							</Tooltip>
						</div>
					</ProviderFieldRow>
				</div>
			</ProviderCard>
		</div>
	);
}
