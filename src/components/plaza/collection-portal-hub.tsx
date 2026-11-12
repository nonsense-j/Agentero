import {
	BookMarked,
	Check,
	ChevronRight,
	Layers,
	Loader2,
	RefreshCw,
	Sparkles,
} from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PlazaSourceBadge } from "@/components/icons/plaza-icons";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	ARXIV_CATEGORY_SUBTITLES,
	type ArxivCategoryWatermark,
	inferVenueKind,
	type VenueConfig,
	type VenueKind,
} from "@/lib/plaza/collection";

const HUB_ICON_BTN_CLASS =
	"text-foreground/80 hover:bg-black/[0.06] hover:text-foreground dark:bg-white/[0.08] dark:text-zinc-100 dark:ring-1 dark:ring-inset dark:ring-white/15 dark:hover:bg-white/[0.15] dark:hover:text-white";

export type VenueKindFilter = "all" | VenueKind;

type VenueGroup = {
	label: string;
	venues: VenueConfig[];
};

function groupVenuesByDomainAndRank(venues: VenueConfig[]): VenueGroup[] {
	const buckets: Array<{
		key: string;
		label: string;
		match: (v: VenueConfig) => boolean;
	}> = [
		{
			key: "plse-a",
			label: "PL/SE · CCF-A",
			match: (v) => v.domain === "PL/SE" && v.ccfRank === "CCF-A",
		},
		{
			key: "plse-b",
			label: "PL/SE · CCF-B",
			match: (v) => v.domain === "PL/SE" && v.ccfRank === "CCF-B",
		},
		{
			key: "cr-a",
			label: "CR · CCF-A",
			match: (v) => v.domain === "CR",
		},
		{
			key: "ai-a",
			label: "AI · CCF-A",
			match: (v) => v.domain === "AI",
		},
	];

	const assigned = new Set<string>();
	const groups: VenueGroup[] = [];

	for (const b of buckets) {
		const matched = venues.filter((v) => {
			if (assigned.has(v.id)) return false;
			if (b.match(v)) {
				assigned.add(v.id);
				return true;
			}
			return false;
		});
		if (matched.length > 0) {
			groups.push({ label: b.label, venues: matched });
		}
	}

	const custom = venues.filter((v) => !assigned.has(v.id));
	if (custom.length > 0) {
		groups.push({ label: "Custom · 2026", venues: custom });
	}
	return groups;
}

export function CollectionPortalHub({
	categories,
	venues,
	arxivCount,
	venueCount,
	conferenceCount,
	journalCount,
	categoryCounts,
	arxivWatermarks,
	preloadingArxiv = false,
	refreshingArxiv = false,
	refreshedArxiv = false,
	refreshingVenue = false,
	refreshedVenue = false,
	refreshingCategories,
	refreshedCategories,
	refreshingVenueIds,
	refreshedVenueIds,
	onRefreshArxiv,
	onRefreshVenue,
	onEnterArxiv,
	onEnterVenue,
}: {
	categories: string[];
	venues: VenueConfig[];
	arxivCount: number;
	venueCount: number;
	conferenceCount: number;
	journalCount: number;
	categoryCounts: Readonly<Record<string, number>>;
	arxivWatermarks?: Record<string, ArxivCategoryWatermark>;
	preloadingArxiv?: boolean;
	refreshingArxiv?: boolean;
	refreshedArxiv?: boolean;
	refreshingVenue?: boolean;
	refreshedVenue?: boolean;
	refreshingCategories?: ReadonlySet<string>;
	refreshedCategories?: ReadonlySet<string>;
	refreshingVenueIds?: ReadonlySet<string>;
	refreshedVenueIds?: ReadonlySet<string>;
	onRefreshArxiv: () => void;
	onRefreshVenue: () => void;
	onEnterArxiv: (category: string | null) => void;
	onEnterVenue: (kind: VenueKindFilter, venueId: string | null) => void;
}) {
	const { t } = useTranslation("sidebar");

	const { confList, jourList, conferences, journals } = useMemo(() => {
		const cList = venues.filter((v) => inferVenueKind(v) === "conference");
		const jList = venues.filter((v) => inferVenueKind(v) === "journal");

		return {
			confList: cList,
			jourList: jList,
			conferences: groupVenuesByDomainAndRank(cList),
			journals: groupVenuesByDomainAndRank(jList),
		};
	}, [venues]);

	const isConfRefreshing = confList.some((v) => refreshingVenueIds?.has(v.id));
	const isConfRefreshed =
		!isConfRefreshing &&
		confList.length > 0 &&
		confList.every((v) => refreshedVenueIds?.has(v.id));
	const isJourRefreshing = jourList.some((v) => refreshingVenueIds?.has(v.id));
	const isJourRefreshed =
		!isJourRefreshing &&
		jourList.length > 0 &&
		jourList.every((v) => refreshedVenueIds?.has(v.id));

	return (
		<div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
			{/* Card 1: arXiv Entry Portal */}
			<section className="magpie-card flex flex-col gap-3.5 p-4">
				<div className="flex items-start justify-between gap-2">
					<button
						type="button"
						onClick={() => onEnterArxiv(null)}
						className="group min-w-0 flex-1 space-y-1 rounded-lg text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/60"
					>
						<div className="flex flex-wrap items-center gap-2">
							<PlazaSourceBadge source="arxiv" label="arXiv" />
							<span className="rounded-md bg-brand/10 px-1.5 py-0.5 font-medium font-mono text-[11px] text-brand">
								{t("plaza.collection.time.all")}
							</span>
							<span className="font-mono text-muted-foreground text-xs tabular-nums">
								{t("plaza.collection.papersCount", { count: arxivCount })}
							</span>
						</div>
						<p className="text-muted-foreground text-xs leading-relaxed">
							{t("plaza.collection.arxivDesc")}
						</p>
					</button>
					<div className="mt-0.5 flex shrink-0 items-center gap-1.5">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									disabled={refreshingArxiv}
									onClick={onRefreshArxiv}
									aria-label={`${t("plaza.collection.refresh")} · arXiv`}
									className={`group/refresh-btn ${HUB_ICON_BTN_CLASS}`}
								>
									{refreshingArxiv ? (
										<Loader2 className="size-3.5 animate-spin text-brand" />
									) : refreshedArxiv ? (
										<>
											<Check className="size-3.5 text-emerald-500 group-hover/refresh-btn:hidden" />
											<RefreshCw className="hidden size-3.5 group-hover/refresh-btn:block" />
										</>
									) : (
										<RefreshCw className="size-3.5" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{t("plaza.collection.refresh")} · arXiv
							</TooltipContent>
						</Tooltip>
						<button
							type="button"
							onClick={() => onEnterArxiv(null)}
							aria-label="arXiv"
							className="inline-flex size-7 items-center justify-center rounded-md bg-[var(--magpie-surface)] text-muted-foreground transition-transform duration-150 hover:translate-x-0.5 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/60"
						>
							<ChevronRight className="size-4" />
						</button>
					</div>
				</div>

				<div
					className={
						categories.length === 3
							? "grid gap-2 sm:grid-cols-3"
							: "grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
					}
				>
					{categories.map((cat) => {
						const count = categoryCounts[cat] ?? 0;
						const subtitle = ARXIV_CATEGORY_SUBTITLES[cat];
						const catRefreshing =
							(refreshingCategories?.has(cat) ?? false) ||
							(preloadingArxiv && !arxivWatermarks?.[cat]?.historyComplete);
						const catRefreshed =
							!catRefreshing && (refreshedCategories?.has(cat) ?? false);
						return (
							<button
								key={cat}
								type="button"
								onClick={() => onEnterArxiv(cat)}
								className="group flex items-center justify-between gap-2 rounded-lg bg-[var(--magpie-surface)] px-3 py-2.5 text-left shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)] transition-colors hover:bg-muted/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/60"
							>
								<div className="min-w-0">
									<div className="flex items-center gap-1.5 font-medium font-mono text-foreground text-xs">
										<span>{cat}</span>
										{catRefreshing ? (
											<Loader2 className="size-3 shrink-0 animate-spin text-brand" />
										) : catRefreshed ? (
											<Check className="size-3 shrink-0 text-emerald-500" />
										) : null}
									</div>
									{subtitle ? (
										<div className="truncate text-[11px] text-muted-foreground">
											{subtitle}
										</div>
									) : null}
								</div>
								<div className="flex shrink-0 items-center gap-1 text-muted-foreground">
									<span className="font-mono text-[11px] tabular-nums">
										{count}
									</span>
									<ChevronRight className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground" />
								</div>
							</button>
						);
					})}
				</div>
			</section>

			{/* Card 2: Venue Entry Portal (Conference + Journal via DBLP 2026) */}
			<section className="magpie-card flex flex-col gap-3.5 p-4">
				<div className="flex items-start justify-between gap-2">
					<button
						type="button"
						onClick={() => onEnterVenue("all", null)}
						className="group min-w-0 flex-1 space-y-1 rounded-lg text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/60"
					>
						<div className="flex flex-wrap items-center gap-2">
							<PlazaSourceBadge
								source="venue"
								label={t("plaza.collection.source.venue")}
							/>
							<span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
								DBLP 2026
							</span>
							<span className="font-mono text-muted-foreground text-xs tabular-nums">
								{t("plaza.collection.papersCount", { count: venueCount })}
							</span>
						</div>
						<p className="text-muted-foreground text-xs leading-relaxed">
							{t("plaza.collection.venueDesc")}
						</p>
					</button>
					<div className="mt-0.5 flex shrink-0 items-center gap-1.5">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									disabled={refreshingVenue}
									onClick={onRefreshVenue}
									aria-label={`${t("plaza.collection.refresh")} · ${t("plaza.collection.source.venue")}`}
									className={`group/refresh-btn ${HUB_ICON_BTN_CLASS}`}
								>
									{refreshingVenue ? (
										<Loader2 className="size-3.5 animate-spin text-brand" />
									) : refreshedVenue ? (
										<>
											<Check className="size-3.5 text-emerald-500 group-hover/refresh-btn:hidden" />
											<RefreshCw className="hidden size-3.5 group-hover/refresh-btn:block" />
										</>
									) : (
										<RefreshCw className="size-3.5" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{t("plaza.collection.refresh")} ·{" "}
								{t("plaza.collection.source.venue")}
							</TooltipContent>
						</Tooltip>
						<button
							type="button"
							onClick={() => onEnterVenue("all", null)}
							aria-label={t("plaza.collection.source.venue")}
							className="inline-flex size-7 items-center justify-center rounded-md bg-[var(--magpie-surface)] text-muted-foreground transition-transform duration-150 hover:translate-x-0.5 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/60"
						>
							<ChevronRight className="size-4" />
						</button>
					</div>
				</div>

				{/* Category A: Conference */}
				<div className="space-y-2 rounded-lg bg-[var(--magpie-surface)] p-3 shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)]">
					<button
						type="button"
						onClick={() => onEnterVenue("conference", null)}
						className="group flex w-full items-center justify-between text-left"
					>
						<span className="inline-flex items-center gap-1.5 font-medium text-foreground text-xs">
							<Layers className="size-3.5 text-brand" />
							{t("plaza.collection.venueKind.conference")}
							{isConfRefreshing ? (
								<Loader2 className="size-3 shrink-0 animate-spin text-brand" />
							) : isConfRefreshed ? (
								<Check className="size-3 shrink-0 text-emerald-500" />
							) : null}
						</span>
						<span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums group-hover:text-foreground">
							{conferenceCount}
							<ChevronRight className="size-3.5" />
						</span>
					</button>

					<div className="space-y-2">
						{conferences.map((grp) => (
							<div key={grp.label} className="space-y-1">
								<div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
									{grp.label}
								</div>
								<div className="flex flex-wrap gap-1.5">
									{grp.venues.map((v) => {
										const cnt = v.paperCount ?? 0;
										const vRefreshing = refreshingVenueIds?.has(v.id) ?? false;
										const vRefreshed =
											!vRefreshing && (refreshedVenueIds?.has(v.id) ?? false);
										return (
											<button
												key={v.id}
												type="button"
												onClick={() => onEnterVenue("conference", v.id)}
												className="magpie-chip hover:border-brand/40 hover:text-foreground"
											>
												{vRefreshing ? (
													<Loader2 className="size-3 shrink-0 animate-spin text-brand" />
												) : vRefreshed ? (
													<Check className="size-3 shrink-0 text-emerald-500" />
												) : null}
												<span>{v.name}</span>
												{v.mode === "agent" ? (
													<Sparkles className="size-2.5 text-brand" />
												) : null}
												{cnt > 0 ? (
													<span className="font-mono text-[10px] text-muted-foreground tabular-nums">
														{cnt}
													</span>
												) : null}
											</button>
										);
									})}
								</div>
							</div>
						))}
					</div>
				</div>

				{/* Category B: Journal */}
				<div className="space-y-2 rounded-lg bg-[var(--magpie-surface)] p-3 shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)]">
					<button
						type="button"
						onClick={() => onEnterVenue("journal", null)}
						className="group flex w-full items-center justify-between text-left"
					>
						<span className="inline-flex items-center gap-1.5 font-medium text-foreground text-xs">
							<BookMarked className="size-3.5 text-brand" />
							{t("plaza.collection.venueKind.journal")}
							{isJourRefreshing ? (
								<Loader2 className="size-3 shrink-0 animate-spin text-brand" />
							) : isJourRefreshed ? (
								<Check className="size-3 shrink-0 text-emerald-500" />
							) : null}
						</span>
						<span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums group-hover:text-foreground">
							{journalCount}
							<ChevronRight className="size-3.5" />
						</span>
					</button>

					<div className="space-y-2">
						{journals.map((grp) => (
							<div key={grp.label} className="space-y-1">
								<div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
									{grp.label}
								</div>
								<div className="flex flex-wrap gap-1.5">
									{grp.venues.map((v) => {
										const cnt = v.paperCount ?? 0;
										const vRefreshing = refreshingVenueIds?.has(v.id) ?? false;
										const vRefreshed =
											!vRefreshing && (refreshedVenueIds?.has(v.id) ?? false);
										return (
											<button
												key={v.id}
												type="button"
												onClick={() => onEnterVenue("journal", v.id)}
												className="magpie-chip hover:border-brand/40 hover:text-foreground"
											>
												{vRefreshing ? (
													<Loader2 className="size-3 shrink-0 animate-spin text-brand" />
												) : vRefreshed ? (
													<Check className="size-3 shrink-0 text-emerald-500" />
												) : null}
												<span>{v.name}</span>
												{cnt > 0 ? (
													<span className="font-mono text-[10px] text-muted-foreground tabular-nums">
														{cnt}
													</span>
												) : null}
											</button>
										);
									})}
								</div>
							</div>
						))}
					</div>
				</div>
			</section>
		</div>
	);
}
