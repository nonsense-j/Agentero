import {
	ArrowLeft,
	ExternalLink,
	KeyRound,
	LoaderCircle,
	Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChoiceCard } from "@/components/onboarding/choice-card";
import type { OnboardingStepId } from "@/components/onboarding/flow";
import { ProbeDot } from "@/components/settings/provider-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { openExternalUrl } from "@/lib/core/open-external";
import { hasSecret, isSecretMask, maskSecret } from "@/lib/core/secret-mask";
import { OPENALEX_KEY_URL, probeOpenAlexKey } from "@/lib/openalex";
import { type AppSettings, saveSettingsAsync } from "@/lib/settings";
import type { ProbeStatus } from "@/lib/ui/probe-status";

const PROBE_LABEL_KEYS = {
	ok: "openalex.probeOk",
	fail: "openalex.probeFail",
	probing: "openalex.probeProbing",
	idle: "openalex.probeIdle",
} as const satisfies Record<ProbeStatus, string>;

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
	const [draftKey, setDraftKey] = useState<string | undefined>(undefined);
	const [probe, setProbe] = useState<ProbeStatus>("idle");

	// OpenAlex works out-of-the-box without an API key, so Next is always allowed.
	useEffect(() => {
		onNextChange("openalex", true);
	}, [onNextChange]);

	const savedKey = settings.openAlexKey;
	const displayKey = draftKey !== undefined ? draftKey : savedKey;

	const persistIfChanged = async (rawValue: string): Promise<string> => {
		const trimmed = rawValue.trim();
		if (trimmed === savedKey.trim()) return trimmed;
		const next = await saveSettingsAsync({
			...settings,
			openAlexKey: trimmed,
		});
		patch({ openAlexKey: next.openAlexKey });
		setDraftKey(undefined);
		return trimmed;
	};

	const confirm = async () => {
		const trimmed = displayKey.trim();
		if (!trimmed) return;
		await persistIfChanged(trimmed);
		setProbe("probing");
		const ok = await probeOpenAlexKey(isSecretMask(trimmed) ? null : trimmed);
		setProbe(ok ? "ok" : "fail");
	};

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
		<div className="space-y-3">
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
				<Button
					type="button"
					variant="ghost"
					size="xs"
					className="shrink-0"
					onClick={() => void openExternalUrl(OPENALEX_KEY_URL)}
				>
					<ExternalLink data-icon="inline-start" className="size-4" />
					{t("openalex.openDocsLabel")}
				</Button>
				<div className="ml-auto flex items-center gap-2">
					<ProbeDot
						status={probe}
						configured={hasSecret(displayKey)}
						label={t(PROBE_LABEL_KEYS[probe])}
						title={t(PROBE_LABEL_KEYS[probe])}
					/>
					<Button
						type="button"
						size="sm"
						className={probe === "probing" ? "disabled:opacity-100" : undefined}
						disabled={probe === "probing" || !displayKey.trim()}
						onClick={() => void confirm()}
					>
						{probe === "probing" ? (
							<LoaderCircle data-icon="inline-start" className="animate-spin" />
						) : null}
						{t("openalex.test")}
					</Button>
				</div>
			</div>
			<Input
				type="password"
				autoComplete="off"
				value={displayKey}
				placeholder={t("openalex.apiKeyPlaceholder")}
				aria-label={t("openalex.apiKeyPlaceholder")}
				onChange={(e) => {
					const next = e.currentTarget.value;
					const shownMask = hasSecret(savedKey)
						? isSecretMask(savedKey)
							? savedKey
							: maskSecret(savedKey)
						: null;
					if (
						shownMask != null &&
						(next === shownMask || next.startsWith(shownMask))
					) {
						setDraftKey(next.slice(shownMask.length));
					} else {
						setDraftKey(next);
					}
					setProbe("idle");
				}}
				onBlur={() => {
					if (draftKey !== undefined) {
						void persistIfChanged(draftKey);
					}
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						void confirm();
					}
				}}
				className="h-8"
			/>
		</div>
	);
}
