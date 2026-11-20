import { AlertTriangle, Loader2, RefreshCw, Settings } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PlazaSourceBadge } from "@/components/icons/plaza-icons";
import { COLLECTION_PRIMARY_BTN_CLASS } from "@/components/plaza/collection-paper-detail-dialog";
import { ProbeDot } from "@/components/settings/provider-card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { hasSecret } from "@/lib/core/secret-mask";
import { cn } from "@/lib/core/utils";
import {
	DEFAULT_KEYWORD_LLM_MODEL,
	hasBuiltinKeywordLlmKey,
	isDefaultKeywordLlmBaseUrl,
	isKeywordLlmConfigured,
	type KeywordLlmProbeStatus,
	probeKeywordLlm,
} from "@/lib/keyword-llm";
import { type OpenAlexProbeStatus, probeOpenAlexKey } from "@/lib/openalex";
import {
	ensureSettingsLoaded,
	type KeywordLlmSettings,
	loadSettings,
	subscribeSettings,
} from "@/lib/settings";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import type { ProbeStatus } from "@/lib/ui/probe-status";

export type CollectionRefreshRequest =
	| { scope: "all" }
	| { scope: "arxiv"; categories?: string[]; targetLabel?: string }
	| { scope: "venue"; venueIds?: string[]; targetLabel?: string };

export type CollectionRefreshSelection = {
	arxiv: boolean;
	venue: boolean;
};

const WARNING_CONFIRM_BTN_CLASS =
	"border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/18 hover:text-amber-800 dark:border-amber-400/35 dark:bg-amber-500/15 dark:text-amber-300 dark:hover:bg-amber-500/25 dark:hover:text-amber-200";

function ModeBadge({ variant }: { variant: "incremental" | "fullVenue" }) {
	const { t } = useTranslation("sidebar");
	if (variant === "incremental") {
		return (
			<span className="inline-flex shrink-0 items-center rounded-md bg-brand/10 px-1.5 py-0.5 font-medium text-[0.6875rem] text-brand leading-none">
				{t("plaza.collection.refreshConfirm.modeIncremental")}
			</span>
		);
	}
	return (
		<span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/12 px-1.5 py-0.5 font-medium text-[0.6875rem] text-amber-700 leading-none dark:bg-amber-500/18 dark:text-amber-300">
			<AlertTriangle className="size-3 shrink-0" aria-hidden />
			{t("plaza.collection.refreshConfirm.modeFullVenue")}
		</span>
	);
}

function ServiceReadinessRow({
	label,
	status,
	configured,
	readyTitle,
	onRecheck,
	onOpenSettings,
}: {
	label: string;
	status: ProbeStatus;
	configured: boolean;
	readyTitle?: string;
	onRecheck: () => void;
	onOpenSettings: () => void;
}) {
	const { t } = useTranslation("sidebar");
	const statusText =
		status === "probing"
			? t("plaza.collection.refreshConfirm.keywordChecking")
			: status === "ok"
				? t("plaza.collection.refreshConfirm.keywordReady")
				: status === "fail"
					? t("plaza.collection.refreshConfirm.keywordUnavailable")
					: t("plaza.collection.refreshConfirm.keywordUnconfigured");

	const showSettingsAction = status === "idle" || status === "fail";

	return (
		<div className="flex items-center justify-between gap-3 px-3 py-2.5">
			<span className="flex min-w-0 items-center gap-2">
				<ProbeDot status={status} configured={configured} label={statusText} />
				<span className="truncate font-medium text-foreground text-xs">
					{label}
				</span>
			</span>

			<div className="flex shrink-0 items-center gap-1.5">
				<span
					title={status === "ok" && readyTitle ? readyTitle : undefined}
					className={cn(
						"inline-flex items-center gap-1 text-xs",
						status === "ok" &&
							"font-medium text-emerald-600 dark:text-emerald-400",
						status === "probing" && "text-muted-foreground",
						status === "idle" &&
							"font-medium text-amber-600 dark:text-amber-400",
						status === "fail" && "font-medium text-destructive",
					)}
				>
					{status === "probing" ? (
						<Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
					) : null}
					<span>{statusText}</span>
				</span>

				{status === "fail" ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label={`${t("plaza.collection.refreshConfirm.keywordRecheck")} · ${label}`}
								onClick={onRecheck}
							>
								<RefreshCw className="size-3" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{t("plaza.collection.refreshConfirm.keywordRecheck")}
						</TooltipContent>
					</Tooltip>
				) : null}

				{showSettingsAction ? (
					<Button
						type="button"
						variant="outline"
						size="xs"
						onClick={onOpenSettings}
					>
						<Settings data-icon="inline-start" className="size-3" />
						{t("plaza.collection.refreshConfirm.keywordSettings")}
					</Button>
				) : null}
			</div>
		</div>
	);
}

export function CollectionRefreshConfirmDialog({
	request,
	onOpenChange,
	onConfirm,
}: {
	request: CollectionRefreshRequest | null;
	onOpenChange: (open: boolean) => void;
	onConfirm: (
		request: CollectionRefreshRequest,
		selection: CollectionRefreshSelection,
	) => void;
}) {
	const { t } = useTranslation(["sidebar", "common"]);
	const open = request !== null;
	const arxivCheckboxId = useId();
	const venueCheckboxId = useId();

	const [includeArxiv, setIncludeArxiv] = useState(true);
	const [includeVenue, setIncludeVenue] = useState(false);

	const [keywordLlm, setKeywordLlm] = useState<KeywordLlmSettings>(
		() => loadSettings().keywordLlm,
	);
	const [openAlexKey, setOpenAlexKey] = useState<string>(
		() => loadSettings().openAlexKey,
	);
	const [hasBuiltinKey, setHasBuiltinKey] = useState(false);
	const [builtinChecked, setBuiltinChecked] = useState(false);
	const [keywordProbeStatus, setKeywordProbeStatus] =
		useState<KeywordLlmProbeStatus>("probing");
	const [openAlexProbeStatus, setOpenAlexProbeStatus] =
		useState<OpenAlexProbeStatus>("idle");
	const [keywordRecheckSeq, setKeywordRecheckSeq] = useState(0);
	const [openAlexRecheckSeq, setOpenAlexRecheckSeq] = useState(0);
	const keywordAbortRef = useRef<AbortController | null>(null);
	const openAlexAbortRef = useRef<AbortController | null>(null);

	// Reset toggle defaults whenever a new refresh confirmation opens.
	useEffect(() => {
		if (!request) return;
		setIncludeArxiv(request.scope !== "venue");
		setIncludeVenue(request.scope === "venue");
	}, [request]);

	// Keep Keyword LLM and OpenAlex settings synced while open.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		const initial = loadSettings();
		setKeywordLlm(initial.keywordLlm);
		setOpenAlexKey(initial.openAlexKey);
		void ensureSettingsLoaded().then((loaded) => {
			if (!cancelled) {
				setKeywordLlm(loaded.keywordLlm);
				setOpenAlexKey(loaded.openAlexKey);
			}
		});
		const unsubscribe = subscribeSettings((next) => {
			setKeywordLlm(next.keywordLlm);
			setOpenAlexKey(next.openAlexKey);
		});
		setBuiltinChecked(false);
		void hasBuiltinKeywordLlmKey().then((ok) => {
			if (!cancelled) {
				setHasBuiltinKey(ok);
				setBuiltinChecked(true);
			}
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [open]);

	const keywordConfigured =
		isKeywordLlmConfigured(keywordLlm) ||
		(isDefaultKeywordLlmBaseUrl(keywordLlm.baseUrl) && hasBuiltinKey);
	const openAlexConfigured = hasSecret(openAlexKey);

	// Probe Keyword LLM readiness whenever dialog opens or config changes.
	useEffect(() => {
		if (!open) {
			keywordAbortRef.current?.abort();
			keywordAbortRef.current = null;
			return;
		}
		if (!builtinChecked) {
			setKeywordProbeStatus("probing");
			return;
		}
		if (!keywordConfigured) {
			keywordAbortRef.current?.abort();
			keywordAbortRef.current = null;
			setKeywordProbeStatus("idle");
			return;
		}

		keywordAbortRef.current?.abort();
		const ac = new AbortController();
		keywordAbortRef.current = ac;
		setKeywordProbeStatus("probing");

		// Dependencies intentionally include key/base/model/recheckSeq so saved edits re-probe.
		void keywordRecheckSeq;
		void keywordLlm.baseUrl;
		void keywordLlm.apiKey;
		void keywordLlm.model;

		void probeKeywordLlm(null, ac.signal).then((ok) => {
			if (ac.signal.aborted) return;
			setKeywordProbeStatus(ok ? "ok" : "fail");
		});

		return () => {
			ac.abort();
		};
	}, [
		open,
		builtinChecked,
		keywordConfigured,
		keywordLlm.baseUrl,
		keywordLlm.apiKey,
		keywordLlm.model,
		keywordRecheckSeq,
	]);

	// Probe OpenAlex API key readiness whenever dialog opens or key changes.
	useEffect(() => {
		if (!open) {
			openAlexAbortRef.current?.abort();
			openAlexAbortRef.current = null;
			return;
		}
		if (!openAlexConfigured) {
			openAlexAbortRef.current?.abort();
			openAlexAbortRef.current = null;
			setOpenAlexProbeStatus("idle");
			return;
		}

		openAlexAbortRef.current?.abort();
		const ac = new AbortController();
		openAlexAbortRef.current = ac;
		setOpenAlexProbeStatus("probing");

		void openAlexRecheckSeq;
		void openAlexKey;

		void probeOpenAlexKey(null, ac.signal).then((ok) => {
			if (ac.signal.aborted) return;
			setOpenAlexProbeStatus(ok ? "ok" : "fail");
		});

		return () => {
			ac.abort();
		};
	}, [open, openAlexConfigured, openAlexKey, openAlexRecheckSeq]);

	const handleConfirm = useCallback(() => {
		if (!request) return;
		const selection: CollectionRefreshSelection =
			request.scope === "all"
				? { arxiv: includeArxiv, venue: includeVenue }
				: request.scope === "arxiv"
					? { arxiv: true, venue: false }
					: { arxiv: false, venue: true };
		if (!selection.arxiv && !selection.venue) return;
		onOpenChange(false);
		onConfirm(request, selection);
	}, [includeArxiv, includeVenue, onConfirm, onOpenChange, request]);

	const openGeneralSettings = useCallback(() => {
		openSettingsWindow("general");
	}, []);

	const title = !request
		? ""
		: request.scope === "all"
			? t("plaza.collection.refreshConfirm.titleAll")
			: request.scope === "arxiv"
				? t("plaza.collection.refreshConfirm.titleTarget", {
						target: request.targetLabel ?? "arXiv",
					})
				: t("plaza.collection.refreshConfirm.titleTarget", {
						target: request.targetLabel ?? t("plaza.collection.source.venue"),
					});

	const includesVenue =
		request?.scope === "venue" || (request?.scope === "all" && includeVenue);
	const canConfirm =
		request !== null &&
		(request.scope !== "all" || includeArxiv || includeVenue);

	const activeModel =
		keywordLlm.model.trim() ||
		(isDefaultKeywordLlmBaseUrl(keywordLlm.baseUrl)
			? DEFAULT_KEYWORD_LLM_MODEL
			: "");

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent aria-describedby={undefined} className="sm:max-w-[25rem]">
				<DialogHeader>
					<DialogTitle className="text-sm">{title}</DialogTitle>
				</DialogHeader>

				{request ? (
					<div className="flex flex-col gap-2.5">
						<div className="divide-y divide-border/60 overflow-hidden rounded-lg border bg-muted/25">
							{request.scope === "all" ? (
								<>
									<label
										htmlFor={arxivCheckboxId}
										className={cn(
											"flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 transition-opacity",
											!includeArxiv && "opacity-60",
										)}
									>
										<span className="flex min-w-0 items-center gap-2">
											<Checkbox
												id={arxivCheckboxId}
												checked={includeArxiv}
												onCheckedChange={(checked) =>
													setIncludeArxiv(checked === true)
												}
											/>
											<span className="font-medium text-foreground text-xs">
												arXiv
											</span>
										</span>
										<ModeBadge variant="incremental" />
									</label>

									<label
										htmlFor={venueCheckboxId}
										className={cn(
											"flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 transition-colors",
											includeVenue ? "bg-amber-500/[0.07]" : "opacity-80",
										)}
									>
										<span className="flex min-w-0 items-center gap-2">
											<Checkbox
												id={venueCheckboxId}
												checked={includeVenue}
												onCheckedChange={(checked) =>
													setIncludeVenue(checked === true)
												}
											/>
											<span className="font-medium text-foreground text-xs">
												{t("plaza.collection.source.venue")}
											</span>
										</span>
										<ModeBadge variant="fullVenue" />
									</label>
								</>
							) : request.scope === "arxiv" ? (
								<div className="flex items-center justify-between gap-3 px-3 py-2.5">
									<PlazaSourceBadge
										source="arxiv"
										label={request.targetLabel ?? "arXiv"}
									/>
									<ModeBadge variant="incremental" />
								</div>
							) : (
								<div className="flex items-center justify-between gap-3 bg-amber-500/[0.07] px-3 py-2.5">
									<PlazaSourceBadge
										source="venue"
										label={
											request.targetLabel ?? t("plaza.collection.source.venue")
										}
									/>
									<ModeBadge variant="fullVenue" />
								</div>
							)}
						</div>

						<div className="divide-y divide-border/60 overflow-hidden rounded-lg border bg-muted/25">
							<ServiceReadinessRow
								label={t("plaza.collection.refreshConfirm.keywordLlm")}
								status={keywordProbeStatus}
								configured={keywordConfigured}
								readyTitle={activeModel || undefined}
								onRecheck={() => setKeywordRecheckSeq((n) => n + 1)}
								onOpenSettings={openGeneralSettings}
							/>
							<ServiceReadinessRow
								label={t("plaza.collection.refreshConfirm.openAlex")}
								status={openAlexProbeStatus}
								configured={openAlexConfigured}
								onRecheck={() => setOpenAlexRecheckSeq((n) => n + 1)}
								onOpenSettings={openGeneralSettings}
							/>
						</div>
					</div>
				) : null}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onOpenChange(false)}
					>
						{t("common:cancel")}
					</Button>
					<Button
						type="button"
						variant={includesVenue ? "outline" : "default"}
						size="sm"
						disabled={!canConfirm}
						onClick={handleConfirm}
						className={
							includesVenue
								? WARNING_CONFIRM_BTN_CLASS
								: COLLECTION_PRIMARY_BTN_CLASS
						}
					>
						{includesVenue
							? t("plaza.collection.refreshConfirm.confirmAnyway")
							: t("plaza.collection.refreshConfirm.confirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
