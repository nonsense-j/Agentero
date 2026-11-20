import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
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
import { hasSecret, unwrapMaskedSecretInput } from "@/lib/core/secret-mask";
import {
	fetchKeywordLlmModels,
	hasBuiltinKeywordLlmKey,
	isDefaultKeywordLlmBaseUrl,
	isKeywordLlmConfigured,
	KEYWORD_LLM_KEY_URL,
	type KeywordLlmProbeStatus,
	probeKeywordLlm,
} from "@/lib/keyword-llm";
import {
	type AppSettings,
	clampKeywordLlmBatchSize,
	clampKeywordLlmConcurrency,
	DEFAULT_KEYWORD_LLM_BASE_URL,
	DEFAULT_KEYWORD_LLM_MODEL,
	KEYWORD_LLM_BATCH_SIZE_CHOICES,
	KEYWORD_LLM_CONCURRENCY_CHOICES,
	type KeywordLlmSettings,
	saveSettingsAsync,
} from "@/lib/settings";

function normalizeDraft(value: KeywordLlmSettings): KeywordLlmSettings {
	return {
		baseUrl: value.baseUrl.trim(),
		apiKey: value.apiKey.trim(),
		model: value.model.trim(),
		batchSize: clampKeywordLlmBatchSize(value.batchSize),
		concurrency: clampKeywordLlmConcurrency(value.concurrency),
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
		(isDefaultKeywordLlmBaseUrl(saved.baseUrl) && hasBuiltinKey);

	const savedBaseUrl = saved.baseUrl.trim();
	const savedApiKey = saved.apiKey.trim();
	const savedModel = saved.model.trim();

	const runProbe = useCallback(async () => {
		if (!configured) {
			setStatus("idle");
			return;
		}
		abortRef.current?.abort();
		const ac = new AbortController();
		abortRef.current = ac;
		setStatus("probing");
		const ok = await probeKeywordLlm(
			{
				baseUrl: savedBaseUrl,
				apiKey: savedApiKey,
				model: savedModel,
			},
			ac.signal,
		);
		if (ac.signal.aborted) return;
		setStatus(ok ? "ok" : "fail");
	}, [configured, savedApiKey, savedBaseUrl, savedModel]);

	useEffect(() => {
		void configured;
		void savedBaseUrl;
		void savedApiKey;
		void savedModel;
		abortRef.current?.abort();
		abortRef.current = null;
		setStatus("idle");
		return () => {
			abortRef.current?.abort();
			abortRef.current = null;
		};
	}, [configured, savedBaseUrl, savedApiKey, savedModel]);

	const changed = useMemo(() => {
		const a = normalizeDraft(saved);
		const b = normalizeDraft(draft);
		return (
			a.baseUrl !== b.baseUrl ||
			a.apiKey !== b.apiKey ||
			a.model !== b.model ||
			a.batchSize !== b.batchSize ||
			a.concurrency !== b.concurrency
		);
	}, [saved, draft]);

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

	const isDefaultEndpoint = isDefaultKeywordLlmBaseUrl(draft.baseUrl);
	const modelOptions = useMemo(() => {
		const unique = new Set<string>();
		if (isDefaultEndpoint) {
			unique.add(DEFAULT_KEYWORD_LLM_MODEL);
		}
		for (const id of models) {
			if (id.trim()) unique.add(id.trim());
		}
		return Array.from(unique);
	}, [isDefaultEndpoint, models]);

	const statusLabel = t(
		status === "idle"
			? configured
				? "general.keywordLlm.probeConfigured"
				: "general.keywordLlm.probeIdle"
			: status === "probing"
				? "general.keywordLlm.probeProbing"
				: status === "ok"
					? "general.keywordLlm.probeOk"
					: "general.keywordLlm.probeFail",
	);

	const canRefreshModels =
		hasSecret(draft.apiKey) ||
		Boolean(draft.baseUrl.trim()) ||
		(isDefaultEndpoint && hasBuiltinKey);
	const keyPlaceholder = t(
		isDefaultEndpoint && hasBuiltinKey
			? "general.keywordLlm.keyPlaceholderBuiltin"
			: "general.keywordLlm.keyPlaceholder",
	);
	const modelPlaceholder = isDefaultEndpoint
		? DEFAULT_KEYWORD_LLM_MODEL
		: t("general.keywordLlm.modelPlaceholder");

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
										className={
											configured && status !== "probing"
												? "cursor-pointer"
												: undefined
										}
										onClick={
											configured && status !== "probing"
												? () => void runProbe()
												: undefined
										}
									/>
								</TooltipTrigger>
								<TooltipContent>{statusLabel}</TooltipContent>
							</Tooltip>
							<p className="min-w-0 truncate font-medium text-sm">
								{t("general.keywordLlm.section")}
							</p>
							{isDefaultEndpoint ? (
								<Button
									type="button"
									variant="link"
									size="xs"
									className="-ml-1.5 h-auto shrink-0 px-1.5 text-primary"
									onClick={() => void openExternalUrl(KEYWORD_LLM_KEY_URL)}
								>
									<ExternalLink data-icon="inline-start" className="size-3" />
									{t("general.keywordLlm.openKeyPage")}
								</Button>
							) : null}
						</>
					}
					right={
						<div className="flex shrink-0 items-center gap-1.5">
							{configured ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon-xs"
											disabled={changed || saving || status === "probing"}
											aria-label={t("general.keywordLlm.check")}
											onClick={() => void runProbe()}
										>
											{status === "probing" ? (
												<Loader2 className="size-3 animate-spin" />
											) : (
												<RefreshCw className="size-3" />
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{t("general.keywordLlm.check")}
									</TooltipContent>
								</Tooltip>
							) : null}
							<Button
								type="button"
								variant="outline"
								size="xs"
								disabled={!changed || saving || status === "probing"}
								onClick={() => void handleConfirm()}
							>
								{t("general.keywordLlm.confirm")}
							</Button>
						</div>
					}
				/>
				<div className="grid gap-1.5">
					<ProviderFieldRow
						label={t("general.keywordLlm.baseUrlLabel")}
						htmlFor="keyword-llm-base-url"
					>
						<Input
							id="keyword-llm-base-url"
							type="url"
							autoComplete="off"
							placeholder={DEFAULT_KEYWORD_LLM_BASE_URL}
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
								const resolvedKey = unwrapMaskedSecretInput(
									e.currentTarget.value,
									saved.apiKey,
								);
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

					<div className="grid grid-cols-2 gap-3">
						<ProviderFieldRow
							label={t("general.keywordLlm.batchSizeLabel")}
							htmlFor="keyword-llm-batch-size"
						>
							<Select
								value={String(clampKeywordLlmBatchSize(draft.batchSize))}
								onValueChange={(value) => {
									setDraft((prev) => ({
										...prev,
										batchSize: clampKeywordLlmBatchSize(Number(value)),
									}));
								}}
							>
								<SelectTrigger
									id="keyword-llm-batch-size"
									className="h-8 min-w-0 flex-1 text-xs"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Array.from(
										new Set([
											...KEYWORD_LLM_BATCH_SIZE_CHOICES,
											clampKeywordLlmBatchSize(draft.batchSize),
										]),
									)
										.sort((a, b) => a - b)
										.map((value) => (
											<SelectItem key={value} value={String(value)}>
												{value}
											</SelectItem>
										))}
								</SelectContent>
							</Select>
						</ProviderFieldRow>

						<ProviderFieldRow
							label={t("general.keywordLlm.concurrencyLabel")}
							htmlFor="keyword-llm-concurrency"
						>
							<Select
								value={String(clampKeywordLlmConcurrency(draft.concurrency))}
								onValueChange={(value) => {
									setDraft((prev) => ({
										...prev,
										concurrency: clampKeywordLlmConcurrency(Number(value)),
									}));
								}}
							>
								<SelectTrigger
									id="keyword-llm-concurrency"
									className="h-8 min-w-0 flex-1 text-xs"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Array.from(
										new Set([
											...KEYWORD_LLM_CONCURRENCY_CHOICES,
											clampKeywordLlmConcurrency(draft.concurrency),
										]),
									)
										.sort((a, b) => a - b)
										.map((value) => (
											<SelectItem key={value} value={String(value)}>
												{value}
											</SelectItem>
										))}
								</SelectContent>
							</Select>
						</ProviderFieldRow>
					</div>
				</div>
			</ProviderCard>
		</div>
	);
}
