import { BookMarked, ChevronRight, Layers, Sparkles } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PlazaSourceBadge } from "@/components/icons/plaza-icons";
import {
	ARXIV_CATEGORY_SUBTITLES,
	type CollectionPaperItem,
	inferVenueKind,
	type VenueConfig,
	type VenueKind,
} from "@/lib/plaza/collection";

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
	items,
	onEnterArxiv,
	onEnterVenue,
}: {
	categories: string[];
	venues: VenueConfig[];
	items: CollectionPaperItem[];
	onEnterArxiv: (category: string | null) => void;
	onEnterVenue: (kind: VenueKindFilter, venueId: string | null) => void;
}) {
	const { t } = useTranslation("sidebar");

	const {
		arxivTotal,
		venueTotal,
		catCounts,
		venueCounts,
		conferenceTotal,
		journalTotal,
		conferences,
		journals,
	} = useMemo(() => {
		const cMap = new Map<string, number>();
		for (const cat of categories) cMap.set(cat, 0);
		const vMap = new Map<string, number>();
		for (const v of venues) vMap.set(v.id, 0);

		let aCount = 0;
		let vCount = 0;
		let confCount = 0;
		let jourCount = 0;

		for (const p of items) {
			if (p.sourceType === "arxiv") {
				aCount += 1;
				for (const cat of categories) {
					if (p.sourceLabel === cat || p.categories.includes(cat)) {
						cMap.set(cat, (cMap.get(cat) ?? 0) + 1);
					}
				}
			} else {
				vCount += 1;
				if (p.venueId) {
					vMap.set(p.venueId, (vMap.get(p.venueId) ?? 0) + 1);
				}
				if (p.venueKind === "journal") jourCount += 1;
				else confCount += 1;
			}
		}

		const confList = venues.filter((v) => inferVenueKind(v) === "conference");
		const jourList = venues.filter((v) => inferVenueKind(v) === "journal");

		return {
			arxivTotal: aCount,
			venueTotal: vCount,
			catCounts: cMap,
			venueCounts: vMap,
			conferenceTotal: confCount,
			journalTotal: jourCount,
			conferences: groupVenuesByDomainAndRank(confList),
			journals: groupVenuesByDomainAndRank(jourList),
		};
	}, [categories, items, venues]);

	return (
		<div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
			{/* Card 1: arXiv Entry Portal */}
			<section className="magpie-card flex flex-col gap-3.5 p-4">
				<button
					type="button"
					onClick={() => onEnterArxiv(null)}
					className="group flex w-full items-start justify-between gap-3 rounded-lg text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/60"
				>
					<div className="min-w-0 space-y-1">
						<div className="flex flex-wrap items-center gap-2">
							<PlazaSourceBadge source="arxiv" label="arXiv" />
							<span className="rounded-md bg-brand/10 px-1.5 py-0.5 font-medium font-mono text-[11px] text-brand">
								{t("plaza.collection.time.all")}
							</span>
							<span className="font-mono text-muted-foreground text-xs tabular-nums">
								{t("plaza.collection.papersCount", { count: arxivTotal })}
							</span>
						</div>
						<p className="text-muted-foreground text-xs leading-relaxed">
							{t("plaza.collection.arxivDesc")}
						</p>
					</div>
					<span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--magpie-surface)] text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground">
						<ChevronRight className="size-4" />
					</span>
				</button>

				<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
					{categories.map((cat) => {
						const count = catCounts.get(cat) ?? 0;
						const subtitle = ARXIV_CATEGORY_SUBTITLES[cat];
						return (
							<button
								key={cat}
								type="button"
								onClick={() => onEnterArxiv(cat)}
								className="group flex items-center justify-between gap-2 rounded-lg bg-[var(--magpie-surface)] px-3 py-2.5 text-left shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)] transition-colors hover:bg-muted/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/60"
							>
								<div className="min-w-0">
									<div className="font-medium font-mono text-foreground text-xs">
										{cat}
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
				<button
					type="button"
					onClick={() => onEnterVenue("all", null)}
					className="group flex w-full items-start justify-between gap-3 rounded-lg text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/60"
				>
					<div className="min-w-0 space-y-1">
						<div className="flex flex-wrap items-center gap-2">
							<PlazaSourceBadge
								source="venue"
								label={t("plaza.collection.source.venue")}
							/>
							<span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
								DBLP 2026
							</span>
							<span className="font-mono text-muted-foreground text-xs tabular-nums">
								{t("plaza.collection.papersCount", { count: venueTotal })}
							</span>
						</div>
						<p className="text-muted-foreground text-xs leading-relaxed">
							{t("plaza.collection.venueDesc")}
						</p>
					</div>
					<span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--magpie-surface)] text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground">
						<ChevronRight className="size-4" />
					</span>
				</button>

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
						</span>
						<span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums group-hover:text-foreground">
							{conferenceTotal}
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
										const cnt = venueCounts.get(v.id) ?? v.paperCount ?? 0;
										return (
											<button
												key={v.id}
												type="button"
												onClick={() => onEnterVenue("conference", v.id)}
												className="magpie-chip hover:border-brand/40 hover:text-foreground"
											>
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
						</span>
						<span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums group-hover:text-foreground">
							{journalTotal}
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
										const cnt = venueCounts.get(v.id) ?? v.paperCount ?? 0;
										return (
											<button
												key={v.id}
												type="button"
												onClick={() => onEnterVenue("journal", v.id)}
												className="magpie-chip hover:border-brand/40 hover:text-foreground"
											>
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
