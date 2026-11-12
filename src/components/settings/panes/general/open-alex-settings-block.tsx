import { ExternalLink } from "lucide-react";
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
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { openExternalUrl } from "@/lib/core/open-external";
import { hasSecret, isSecretMask, maskSecret } from "@/lib/core/secret-mask";
import {
	OPENALEX_KEY_URL,
	type OpenAlexProbeStatus,
	probeOpenAlexKey,
} from "@/lib/openalex";

export function OpenAlexSettingsBlock({
	savedKey,
	keyDraft,
	onKeyDraftChange,
	onCommitKey,
}: {
	savedKey: string;
	keyDraft: string;
	onKeyDraftChange: (value: string) => void;
	onCommitKey: (value: string) => Promise<void>;
}) {
	const { t } = useTranslation("settings");
	const [status, setStatus] = useState<OpenAlexProbeStatus>("idle");
	const abortRef = useRef<AbortController | null>(null);

	const runProbe = useCallback(async () => {
		if (!hasSecret(savedKey)) {
			setStatus("idle");
			return;
		}
		abortRef.current?.abort();
		const ac = new AbortController();
		abortRef.current = ac;
		setStatus("probing");
		const ok = await probeOpenAlexKey(null, ac.signal);
		if (ac.signal.aborted) return;
		setStatus(ok ? "ok" : "fail");
	}, [savedKey]);

	useEffect(() => {
		void runProbe();
		return () => {
			abortRef.current?.abort();
		};
	}, [runProbe]);

	const changed = useMemo(() => {
		const saved = savedKey.trim();
		const draft = keyDraft.trim();
		if (!saved && !draft) return false;
		if (!saved || !draft) return true;
		return draft !== saved;
	}, [savedKey, keyDraft]);

	const handleConfirm = async () => {
		await onCommitKey(keyDraft.trim());
	};

	const statusLabel = t(
		status === "idle"
			? "general.openAlex.probeIdle"
			: status === "probing"
				? "general.openAlex.probeProbing"
				: status === "ok"
					? "general.openAlex.probeOk"
					: "general.openAlex.probeFail",
	);

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
										configured={hasSecret(savedKey)}
										label={statusLabel}
									/>
								</TooltipTrigger>
								<TooltipContent>{statusLabel}</TooltipContent>
							</Tooltip>
							<p className="min-w-0 truncate font-medium text-sm">
								{t("general.openAlex.section")}
							</p>
							<Button
								type="button"
								variant="link"
								size="xs"
								className="-ml-1.5 h-auto shrink-0 px-1.5 text-primary"
								onClick={() => void openExternalUrl(OPENALEX_KEY_URL)}
							>
								<ExternalLink data-icon="inline-start" className="size-3" />
								{t("general.openAlex.openKeyPage")}
							</Button>
						</>
					}
					right={
						<Button
							type="button"
							variant="outline"
							size="xs"
							disabled={!changed || status === "probing"}
							onClick={() => void handleConfirm()}
						>
							{t("general.openAlex.confirm")}
						</Button>
					}
				/>
				<div className="grid gap-1.5">
					<ProviderFieldRow
						label={t("general.openAlex.keyLabel")}
						htmlFor="open-alex-key"
					>
						<Input
							id="open-alex-key"
							type="password"
							autoComplete="off"
							placeholder={t("general.openAlex.placeholder")}
							className={PROVIDER_INPUT_CLASS}
							value={keyDraft}
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
									onKeyDraftChange(next.slice(shownMask.length));
								} else {
									onKeyDraftChange(next);
								}
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									void handleConfirm();
								}
							}}
						/>
					</ProviderFieldRow>
				</div>
			</ProviderCard>
		</div>
	);
}
