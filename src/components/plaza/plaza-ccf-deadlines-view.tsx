/**
 * Native 广场 panel: upcoming CCF conference deadlines.
 *
 * Supports toggling between the Magpie-styled Native Deadlines list and the
 * embedded `https://ccfddl.com/` web view.
 */

import {
	ExternalLink,
	Globe,
	LayoutList,
	Loader2,
	Search,
	X,
} from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { PlazaWebFrame } from "@/components/plaza/plaza-web-frame";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import {
	type CcfDeadlineItem,
	type CcfRank,
	loadCcfDeadlines,
} from "@/lib/plaza/ccf-deadlines";
import { webViewProxyUrl } from "@/lib/web-view/proxy-url";

const RANKS: readonly CcfRank[] = ["A", "B", "C", "N"];

const RANK_CLASS: Record<CcfRank, string> = {
	A: "bg-foreground text-background shadow-xs",
	B: "bg-foreground/15 text-foreground",
	C: "bg-foreground/6 text-muted-foreground",
	N: "text-muted-foreground/70",
};

const SE_AI_SPOTLIGHT = new Set([
	"ICSE",
	"FSE",
	"ESEC/FSE",
	"ASE",
	"ISSTA",
	"PLDI",
	"POPL",
	"OOPSLA",
	"TOSEM",
	"TSE",
	"S&P",
	"USENIX Security",
	"CCS",
	"NDSS",
	"NeurIPS",
	"ICML",
	"ICLR",
	"AAAI",
	"ACL",
]);

export function PlazaCcfDeadlinesView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const [items, setItems] = useState<CcfDeadlineItem[]>([]);
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState(false);
	const [rankFilter, setRankFilter] = useState<CcfRank[]>([]);
	const [focusAiSe, setFocusAiSe] = useState(false);
	const [query, setQuery] = useState("");
	const [displayMode, setDisplayMode] = useState<"native" | "web">("native");
	const loadedRef = useRef(false);

	const load = useCallback(async () => {
		setBusy(true);
		try {
			setItems(await loadCcfDeadlines());
			setError(false);
		} catch (err) {
			setError(true);
			notifyError(errorText(err) || t("plaza.ccfDeadlines.loadFailed"));
		} finally {
			setBusy(false);
		}
	}, [t]);

	useEffect(() => {
		if (loadedRef.current) return;
		loadedRef.current = true;
		void load();
	}, [load]);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return items.filter((item) => {
			if (rankFilter.length > 0 && !rankFilter.includes(item.rank)) {
				return false;
			}
			if (focusAiSe) {
				const upper = item.title.toUpperCase();
				const matched = Array.from(SE_AI_SPOTLIGHT).some(
					(v) =>
						upper === v.toUpperCase() ||
						upper.startsWith(`${v.toUpperCase()} `),
				);
				if (!matched) return false;
			}
			if (q) {
				const hay =
					`${item.title} ${item.comment ?? ""} ${item.year}`.toLowerCase();
				if (!hay.includes(q)) return false;
			}
			return true;
		});
	}, [focusAiSe, items, query, rankFilter]);

	const toggleRank = (rank: CcfRank) =>
		setRankFilter((prev) =>
			prev.includes(rank) ? prev.filter((r) => r !== rank) : [...prev, rank],
		);

	return (
		<div
			className={cn(
				"magpie-canvas magpie-view-in relative flex h-full min-h-0 flex-col",
				className,
			)}
		>
			{/* Sticky Translucent Magpie Header */}
			<div
				data-plaza-header
				className="sticky top-0 z-10 flex flex-wrap items-center gap-2 bg-background/80 px-3 py-2.5 shadow-[0_0.5px_0_0_var(--magpie-hairline)] backdrop-blur-xl backdrop-saturate-150"
			>
				<RankFilter
					selected={rankFilter}
					onToggle={toggleRank}
					onClear={() => setRankFilter([])}
				/>

				{displayMode === "native" ? (
					<>
						<button
							type="button"
							data-active={focusAiSe}
							onClick={() => setFocusAiSe((v) => !v)}
							className="magpie-chip"
						>
							{t("plaza.ccfDeadlines.focusAiSe")}
						</button>

						<div className="relative min-w-[140px] flex-1">
							<Search
								className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
								aria-hidden
							/>
							<input
								type="search"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder={t("plaza.ccfDeadlines.searchPlaceholder")}
								className="h-7 w-full rounded-lg bg-[var(--magpie-surface)] pr-7 pl-8 text-xs shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)] placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-brand/60"
							/>
							{query ? (
								<button
									type="button"
									onClick={() => setQuery("")}
									className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
								>
									<X className="size-3" />
								</button>
							) : null}
						</div>
					</>
				) : null}

				{/* Native vs Web Mode Segmented Toggle */}
				<div className="magpie-seg ml-auto">
					<button
						type="button"
						data-active={displayMode === "native"}
						onClick={() => setDisplayMode("native")}
						className="magpie-seg-btn"
					>
						<LayoutList className="size-3" />
						<span>{t("plaza.ccfDeadlines.modeNative")}</span>
					</button>
					<button
						type="button"
						data-active={displayMode === "web"}
						onClick={() => setDisplayMode("web")}
						className="magpie-seg-btn"
					>
						<Globe className="size-3" />
						<span>ccfddl.com</span>
					</button>
				</div>
			</div>

			{displayMode === "web" ? (
				<div className="min-h-0 flex-1">
					<PlazaWebFrame
						homeUrl="https://ccfddl.com/"
						embedOrigin={webViewProxyUrl("https://ccfddl.com/")}
						lastPathStorageKey="agentero:plaza:ccf-deadlines:last-path"
						title="ccfddl.com"
						className="h-full w-full"
					/>
				</div>
			) : (
				<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto p-3">
					{busy && items.length === 0 ? (
						<div className="flex items-center justify-center py-10 text-muted-foreground text-xs">
							<Loader2 className="size-3.5 animate-spin" aria-hidden />
						</div>
					) : visible.length === 0 ? (
						<p className="py-10 text-center text-muted-foreground text-xs">
							{items.length === 0
								? t(
										error
											? "plaza.ccfDeadlines.loadFailed"
											: "plaza.ccfDeadlines.empty",
									)
								: t("plaza.ccfDeadlines.emptyFiltered")}
						</p>
					) : (
						<div className="grid gap-1.5">
							{visible.map((item) => (
								<DeadlineRow key={item.key} item={item} />
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function DeadlineRow({ item }: { item: CcfDeadlineItem }) {
	const { t } = useTranslation("sidebar");
	const days =
		item.at === null ? null : Math.ceil((item.at - Date.now()) / 86_400_000);
	const urgent = days !== null && days <= 3;
	const countdown =
		days === null
			? null
			: days <= 0
				? t("plaza.ccfDeadlines.today")
				: t("plaza.ccfDeadlines.daysLeft", { days });

	return (
		<div className="magpie-card group flex items-center gap-2.5 px-3 py-2">
			<span
				className={cn(
					"inline-flex size-5 shrink-0 items-center justify-center rounded-md font-semibold text-caption tabular-nums",
					RANK_CLASS[item.rank],
				)}
				title={`CCF ${item.rank}`}
			>
				{item.rank}
			</span>
			<span className="min-w-0 truncate font-medium text-sm">{item.title}</span>
			{item.estimated ? (
				<span
					className="shrink-0 rounded border border-border/60 px-1 text-caption text-muted-foreground/70"
					title={t("plaza.ccfDeadlines.estimatedHint")}
				>
					{t("plaza.ccfDeadlines.estimated")}
				</span>
			) : null}
			{item.year ? (
				<span className="shrink-0 text-caption tabular-nums text-muted-foreground">
					{item.year}
				</span>
			) : null}
			{item.comment ? (
				<span className="hidden min-w-0 truncate text-caption text-muted-foreground/80 md:inline">
					{item.comment}
				</span>
			) : null}
			<span className="ml-auto flex shrink-0 items-center gap-2">
				<span className="font-mono text-caption tabular-nums text-muted-foreground/75">
					{item.deadline.slice(0, 16)}
					{item.timezone ? (
						<span className="ml-1 text-muted-foreground/50">
							{item.timezone}
						</span>
					) : null}
				</span>
				{countdown ? (
					<span
						className={cn(
							"w-14 whitespace-nowrap text-right text-caption tabular-nums",
							urgent ? "font-semibold text-brand" : "text-muted-foreground",
						)}
					>
						{countdown}
					</span>
				) : null}
				{item.link ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("plaza.ccfDeadlines.openOfficial")}
								onClick={() => openExternalUrl(item.link)}
							>
								<ExternalLink className="size-3.5" aria-hidden />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{t("plaza.ccfDeadlines.openOfficial")}
						</TooltipContent>
					</Tooltip>
				) : (
					<span className="size-6" aria-hidden />
				)}
			</span>
		</div>
	);
}

function RankFilter({
	selected,
	onToggle,
	onClear,
}: {
	selected: readonly CcfRank[];
	onToggle: (rank: CcfRank) => void;
	onClear: () => void;
}) {
	const { t } = useTranslation("sidebar");
	const allActive = selected.length === 0;
	return (
		<fieldset className="magpie-seg m-0">
			<legend className="sr-only">{t("plaza.ccfDeadlines.filterLabel")}</legend>
			<Segment active={allActive} onClick={onClear}>
				{t("plaza.ccfDeadlines.rankAll")}
			</Segment>
			{RANKS.map((rank) => (
				<Segment
					key={rank}
					active={selected.includes(rank)}
					onClick={() => onToggle(rank)}
				>
					{rank}
				</Segment>
			))}
		</fieldset>
	);
}

function Segment({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			data-active={active}
			onClick={onClick}
			className="magpie-seg-btn"
		>
			{children}
		</button>
	);
}
