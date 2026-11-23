import {
	AlertCircle,
	Database,
	Download,
	Globe,
	Loader2,
	PauseCircle,
	RotateCcw,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useSettings } from "@/hooks/use-app-stores";
import { formatBytes } from "@/lib/core/background-tasks";
import { cn } from "@/lib/core/utils";
import {
	type CollectionSeedSyncState,
	cancelCollectionSeedSync,
	collectionSeedStore,
	dismissCollectionSeedOverlayForSession,
	isSeedDownloadSlow,
	retryCollectionSeedSync,
} from "@/lib/plaza/collection";
import { openSettingsWindow } from "@/lib/shell/settings-window";

type SeedStepKey =
	| "fetchingManifest"
	| "stepDownloading"
	| "stepImporting"
	| "stepIndexing";

type SeedDisplayModel = {
	isError: boolean;
	isCancelled: boolean;
	isTerminalFailure: boolean;
	stepKey: SeedStepKey;
	shardSuffix: string;
	metricText: string | null;
	speedText: string | null;
	progressValue: number | null;
	indeterminate: boolean;
};

function buildSeedDisplayModel(
	seed: CollectionSeedSyncState,
): SeedDisplayModel {
	const isError = seed.phase === "error";
	const isCancelled = seed.phase === "cancelled";
	const isTerminalFailure = isError || isCancelled;

	if (seed.phase === "downloading") {
		const hasTotal = seed.totalBytes != null && seed.totalBytes > 0;
		const pct = hasTotal
			? Math.min(
					100,
					Math.max(
						0,
						Math.round(
							(seed.downloadedBytes / (seed.totalBytes as number)) * 100,
						),
					),
				)
			: null;
		const shardSuffix =
			seed.shardCount > 1 && seed.shardIndex > 0
				? ` (${seed.shardIndex}/${seed.shardCount})`
				: "";
		const metricText = hasTotal
			? `${formatBytes(seed.downloadedBytes)} / ${formatBytes(seed.totalBytes as number)} · ${pct}%`
			: seed.downloadedBytes > 0
				? formatBytes(seed.downloadedBytes)
				: null;
		const speedText =
			seed.bytesPerSec != null && seed.bytesPerSec > 0
				? `${formatBytes(seed.bytesPerSec)}/s`
				: null;
		return {
			isError,
			isCancelled,
			isTerminalFailure,
			stepKey: "stepDownloading",
			shardSuffix,
			metricText,
			speedText,
			progressValue: pct,
			indeterminate: pct == null,
		};
	}

	if (seed.phase === "importing") {
		const hasTotal = seed.totalPapers != null && seed.totalPapers > 0;
		const pct = hasTotal
			? Math.min(
					100,
					Math.max(
						0,
						Math.round(
							(seed.importedPapers / (seed.totalPapers as number)) * 100,
						),
					),
				)
			: null;
		const metricText = hasTotal
			? `${seed.importedPapers.toLocaleString()} / ${(seed.totalPapers as number).toLocaleString()} · ${pct}%`
			: seed.importedPapers > 0
				? seed.importedPapers.toLocaleString()
				: null;
		return {
			isError,
			isCancelled,
			isTerminalFailure,
			stepKey: "stepImporting",
			shardSuffix: "",
			metricText,
			speedText: null,
			progressValue: pct,
			indeterminate: pct == null,
		};
	}

	if (seed.phase === "indexing") {
		return {
			isError,
			isCancelled,
			isTerminalFailure,
			stepKey: "stepIndexing",
			shardSuffix: "",
			metricText: null,
			speedText: null,
			progressValue: 96,
			indeterminate: true,
		};
	}

	return {
		isError,
		isCancelled,
		isTerminalFailure,
		stepKey: "fetchingManifest",
		shardSuffix: "",
		metricText: null,
		speedText: null,
		progressValue: null,
		indeterminate: true,
	};
}

function useSlowDownloadCheck(seed: CollectionSeedSyncState): boolean {
	const [nowMs, setNowMs] = useState(() => Date.now());
	const tracking = seed.active && seed.phase === "downloading";

	useEffect(() => {
		if (!tracking) return;
		setNowMs(Date.now());
		const id = window.setInterval(() => {
			setNowMs(Date.now());
		}, 1000);
		return () => window.clearInterval(id);
	}, [tracking]);

	return isSeedDownloadSlow(seed, nowMs);
}

function SeedCardBody({
	compact = false,
	showSkip = true,
}: {
	compact?: boolean;
	showSkip?: boolean;
}) {
	const { t } = useTranslation(["sidebar", "common"]);
	const seed = useStore(collectionSeedStore);
	const networkProxyEnabled = useSettings((s) => s.networkProxyEnabled);
	const slowDownload = useSlowDownloadCheck(seed);
	const model = buildSeedDisplayModel(seed);
	const stepLabel = `${t(`sidebar:plaza.collection.seed.${model.stepKey}`)}${model.shardSuffix}`;
	const showSlowProxyHint =
		!model.isTerminalFailure && slowDownload && !networkProxyEnabled;

	if (model.isTerminalFailure) {
		return (
			<div className={cn("flex flex-col", compact ? "gap-2.5" : "gap-3.5")}>
				<div className="flex items-start gap-2.5">
					<div
						className={cn(
							"flex shrink-0 items-center justify-center rounded-xl",
							compact ? "size-8" : "size-9",
							model.isError
								? "bg-destructive/10 text-destructive"
								: "bg-muted text-muted-foreground",
						)}
					>
						{model.isError ? (
							<AlertCircle className="size-4" aria-hidden />
						) : (
							<PauseCircle className="size-4" aria-hidden />
						)}
					</div>
					<div className="min-w-0 flex-1 space-y-1">
						<h3 className="font-semibold text-foreground text-sm leading-tight">
							{model.isError
								? t("sidebar:plaza.collection.seed.errorTitle")
								: t("sidebar:plaza.collection.seed.cancelledTitle")}
						</h3>
						{model.isError && seed.error ? (
							<p
								className="line-clamp-3 break-words text-muted-foreground text-xs leading-relaxed"
								title={seed.error}
							>
								{seed.error}
							</p>
						) : (
							<p className="text-muted-foreground text-xs leading-relaxed">
								{t("sidebar:plaza.collection.seed.cancelledHint")}
							</p>
						)}
					</div>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="sm"
						onClick={() => void retryCollectionSeedSync()}
						className="h-7 gap-1.5 px-3 text-xs"
					>
						<RotateCcw className="size-3.5" aria-hidden />
						{t("sidebar:plaza.collection.seed.retry")}
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => openSettingsWindow("general")}
						className="h-7 gap-1.5 px-2.5 text-xs"
					>
						<Globe className="size-3.5" aria-hidden />
						{t("sidebar:plaza.collection.seed.proxySettings")}
					</Button>
					{showSkip ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => dismissCollectionSeedOverlayForSession()}
							className="ml-auto h-7 px-2 text-muted-foreground text-xs hover:text-foreground"
						>
							{t("sidebar:plaza.collection.seed.skip")}
						</Button>
					) : null}
				</div>
			</div>
		);
	}

	return (
		<div className={cn("flex flex-col", compact ? "gap-2.5" : "gap-3.5")}>
			<div className="flex items-start justify-between gap-2.5">
				<div className="flex min-w-0 items-start gap-2.5">
					<div
						className={cn(
							"flex shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand",
							compact ? "size-8" : "size-9",
						)}
					>
						{seed.phase === "downloading" ? (
							<Download className="size-4" aria-hidden />
						) : seed.phase === "importing" || seed.phase === "indexing" ? (
							<Database className="size-4" aria-hidden />
						) : (
							<Loader2 className="size-4 animate-spin" aria-hidden />
						)}
					</div>
					<div className="min-w-0 space-y-0.5">
						<h3 className="font-semibold text-foreground text-sm leading-tight">
							{t("sidebar:plaza.collection.seed.title")}
						</h3>
						<p className="text-muted-foreground text-xs leading-relaxed">
							{t("sidebar:plaza.collection.seed.subtitle")}
						</p>
					</div>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					onClick={() => cancelCollectionSeedSync()}
					aria-label={t("common:cancel")}
					className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
				>
					<X className="size-3.5" aria-hidden />
				</Button>
			</div>

			<div className="space-y-1.5">
				<div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs">
					<span className="inline-flex items-center gap-1.5 font-medium text-foreground">
						<Loader2 className="size-3 shrink-0 animate-spin text-brand" />
						<span>{stepLabel}</span>
					</span>
					{model.metricText ? (
						<span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
							{model.metricText}
						</span>
					) : null}
				</div>

				<Progress
					value={model.progressValue ?? undefined}
					className={cn(
						"h-1.5",
						model.indeterminate && "animate-pulse opacity-75",
					)}
				/>

				{model.speedText || showSlowProxyHint ? (
					<div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
						{showSlowProxyHint ? (
							<button
								type="button"
								onClick={() => openSettingsWindow("general")}
								className="inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
							>
								<Globe className="size-3 shrink-0" aria-hidden />
								<span>{t("sidebar:plaza.collection.seed.slowProxyHint")}</span>
							</button>
						) : (
							<span />
						)}
						{model.speedText ? (
							<span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
								{model.speedText}
							</span>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	);
}

/**
 * First-launch floating dashed-frame overlay scoped strictly to the Plaza
 * Collection container (never blocks other tabs, Vault, Notes, PDFs, or Settings).
 */
export function CollectionSeedOverlay({
	open,
	className,
}: {
	open: boolean;
	className?: string;
}) {
	if (!open) return null;

	return (
		<div
			data-collection-seed-overlay
			role="status"
			aria-live="polite"
			className={cn(
				"absolute inset-0 z-20 flex items-center justify-center p-6",
				"transition-opacity duration-200 motion-reduce:transition-none",
				className,
			)}
		>
			<div
				data-seed-overlay-card
				className="w-full max-w-[26rem] rounded-2xl border border-border/80 border-dashed bg-background/90 p-5 shadow-sm backdrop-blur-md"
			>
				<SeedCardBody />
			</div>
		</div>
	);
}

/**
 * Inline dashed-frame seed progress / recovery card for sibling Collection-backed
 * Plaza views (`Discover`, `Recommend`, `Survey`) when `totalCount === 0`.
 */
export function CollectionSeedStatusBanner({
	compact = false,
	showSkip = true,
	className,
}: {
	compact?: boolean;
	showSkip?: boolean;
	className?: string;
}) {
	return (
		<div
			data-collection-seed-banner
			role="status"
			aria-live="polite"
			data-seed-overlay-card
			className={cn(
				"rounded-2xl border border-border/80 border-dashed bg-background/90 shadow-sm backdrop-blur-md",
				compact ? "p-3.5" : "p-4",
				className,
			)}
		>
			<SeedCardBody compact={compact} showSkip={showSkip} />
		</div>
	);
}
