import { ArrowUpRight, BookOpenCheck, GitFork, Library } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PlazaSourceBadge } from "@/components/icons/plaza-icons";
import { cn } from "@/lib/core/utils";
import type { CollectionPaperItem } from "@/lib/plaza/collection";
import type {
	CollectionPaperLineageResult,
	CollectionVaultPaperMatch,
} from "@/lib/plaza/collection-store";

type LineageListTab = "cited" | "references" | "shared";

function normalizeIdKey(value?: string | null): string | null {
	const trimmed = value?.trim().toLowerCase();
	return trimmed ? trimmed : null;
}

function stripArxivVersion(arxivId?: string | null): string | null {
	const norm = normalizeIdKey(arxivId);
	if (!norm) return null;
	return norm.replace(/v\d+$/, "");
}

function buildVaultLookupKeys(
	matches: readonly CollectionVaultPaperMatch[],
): Set<string> {
	const keys = new Set<string>();
	for (const m of matches) {
		const doi = normalizeIdKey(m.doi);
		if (doi) keys.add(`doi:${doi}`);
		const ax = stripArxivVersion(m.arxivId);
		if (ax) keys.add(`arxiv:${ax}`);
	}
	return keys;
}

function isPaperInVaultLookup(
	paper: CollectionPaperItem,
	vaultKeys: ReadonlySet<string>,
): boolean {
	if (vaultKeys.size === 0) return false;
	const doi = normalizeIdKey(paper.doi);
	if (doi && vaultKeys.has(`doi:${doi}`)) return true;
	const ax = stripArxivVersion(paper.arxivId);
	if (ax && vaultKeys.has(`arxiv:${ax}`)) return true;
	return false;
}

export function CollectionPaperLineageSection({
	lineage,
	vaultPath,
	onSelectPaper,
	onOpenVaultPaper,
}: {
	lineage: CollectionPaperLineageResult | null;
	vaultPath: string | null;
	onSelectPaper: (paper: CollectionPaperItem) => void;
	onOpenVaultPaper: (relPath: string) => void;
}) {
	const { t } = useTranslation("sidebar");
	const [activeTab, setActiveTab] = useState<LineageListTab>("cited");

	const citedByInPool = lineage?.citedByInPool ?? [];
	const referencesInPool = lineage?.referencesInPool ?? [];
	const sharedRefPeers = lineage?.sharedRefPeers ?? [];
	const vaultMatches = lineage?.vaultMatches ?? [];

	const hasAnyListItems =
		citedByInPool.length > 0 ||
		referencesInPool.length > 0 ||
		sharedRefPeers.length > 0;
	const hasAnything = hasAnyListItems || vaultMatches.length > 0;

	useEffect(() => {
		const counts: Record<LineageListTab, number> = {
			cited: citedByInPool.length,
			references: referencesInPool.length,
			shared: sharedRefPeers.length,
		};
		if (counts[activeTab] > 0) return;
		if (counts.cited > 0) setActiveTab("cited");
		else if (counts.references > 0) setActiveTab("references");
		else if (counts.shared > 0) setActiveTab("shared");
	}, [
		activeTab,
		citedByInPool.length,
		referencesInPool.length,
		sharedRefPeers.length,
	]);

	const vaultLookupKeys = useMemo(
		() => buildVaultLookupKeys(vaultMatches),
		[vaultMatches],
	);

	if (!hasAnything) return null;

	return (
		<section
			data-lineage-section
			className="space-y-2.5"
			aria-label={t("plaza.collection.lineage.title")}
		>
			<div className="flex items-center justify-between gap-2">
				<h4 className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
					<GitFork className="size-3" />
					<span>{t("plaza.collection.lineage.title")}</span>
				</h4>
			</div>

			{/* Personal Vault Matches Highlight Bar */}
			{vaultMatches.length > 0 ? (
				<div className="flex flex-col gap-1.5" data-lineage-vault-matches>
					{vaultMatches.map((match) => {
						const isSelf = match.relation === "self";
						const canOpen = Boolean(vaultPath && match.relPath);
						const badgeLabel = isSelf
							? t("plaza.collection.lineage.inVault")
							: t("plaza.collection.lineage.citesVault");
						const content = (
							<>
								<span
									className={cn(
										"inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-[0.6875rem] leading-none",
										isSelf
											? "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/22 dark:text-emerald-200"
											: "bg-brand/14 text-brand",
									)}
								>
									{isSelf ? (
										<BookOpenCheck className="size-3" />
									) : (
										<Library className="size-3" />
									)}
									<span>{badgeLabel}</span>
								</span>
								<span className="min-w-0 flex-1 truncate font-medium text-foreground text-xs">
									{match.title}
								</span>
								{canOpen ? (
									<ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/vault:translate-x-0.5 group-hover/vault:-translate-y-0.5 motion-reduce:transition-none" />
								) : null}
							</>
						);

						return canOpen ? (
							<button
								key={`${match.relation}:${match.relPath}`}
								type="button"
								onClick={() => onOpenVaultPaper(match.relPath)}
								className={cn(
									"group/vault flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors motion-reduce:transition-none",
									isSelf
										? "bg-emerald-500/8 ring-1 ring-emerald-500/25 ring-inset hover:bg-emerald-500/14 dark:bg-emerald-500/12 dark:ring-emerald-400/30 dark:hover:bg-emerald-500/18"
										: "bg-brand/7 ring-1 ring-brand/22 ring-inset hover:bg-brand/12",
								)}
							>
								{content}
							</button>
						) : (
							<div
								key={`${match.relation}:${match.relPath}`}
								className={cn(
									"flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5",
									isSelf
										? "bg-emerald-500/8 ring-1 ring-emerald-500/25 ring-inset dark:bg-emerald-500/12 dark:ring-emerald-400/30"
										: "bg-brand/7 ring-1 ring-brand/22 ring-inset",
								)}
							>
								{content}
							</div>
						);
					})}
				</div>
			) : null}

			{/* Lineage List Body */}
			{hasAnyListItems ? (
				<div className="space-y-2 rounded-lg bg-[var(--magpie-surface)] p-2.5 shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)]">
					<div className="flex flex-wrap items-center gap-1.5">
						<div className="magpie-seg">
							{(
								[
									{
										id: "cited" as const,
										label: t("plaza.collection.lineage.citedInPool"),
										count: citedByInPool.length,
									},
									{
										id: "references" as const,
										label: t("plaza.collection.lineage.referencesInPool"),
										count: referencesInPool.length,
									},
									{
										id: "shared" as const,
										label: t("plaza.collection.lineage.sharedRefs"),
										count: sharedRefPeers.length,
									},
								] as const
							).map((tab) => (
								<button
									key={tab.id}
									type="button"
									disabled={tab.count === 0}
									data-active={activeTab === tab.id}
									onClick={() => setActiveTab(tab.id)}
									className="magpie-seg-btn gap-1 disabled:pointer-events-none disabled:opacity-40"
								>
									<span>{tab.label}</span>
									<span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
										{tab.count}
									</span>
								</button>
							))}
						</div>
					</div>

					<div className="agentero-scroll max-h-[15rem] space-y-1 overflow-y-auto pr-0.5">
						{activeTab === "cited" &&
							citedByInPool.map((item) => (
								<LineagePaperRow
									key={item.id}
									paper={item}
									inVault={isPaperInVaultLookup(item, vaultLookupKeys)}
									onSelect={() => onSelectPaper(item)}
								/>
							))}

						{activeTab === "references" &&
							referencesInPool.map((item) => (
								<LineagePaperRow
									key={item.id}
									paper={item}
									inVault={isPaperInVaultLookup(item, vaultLookupKeys)}
									onSelect={() => onSelectPaper(item)}
								/>
							))}

						{activeTab === "shared" &&
							sharedRefPeers.map((peer) => (
								<LineagePaperRow
									key={peer.paper.id}
									paper={peer.paper}
									sharedCount={peer.sharedCount}
									inVault={isPaperInVaultLookup(peer.paper, vaultLookupKeys)}
									onSelect={() => onSelectPaper(peer.paper)}
								/>
							))}
					</div>
				</div>
			) : null}
		</section>
	);
}

function LineagePaperRow({
	paper,
	sharedCount,
	inVault,
	onSelect,
}: {
	paper: CollectionPaperItem;
	sharedCount?: number;
	inVault?: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className="group flex w-full items-start justify-between gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/65 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/60 motion-reduce:transition-none"
		>
			<div className="min-w-0 flex-1 space-y-1">
				<p className="line-clamp-2 font-medium text-foreground text-xs leading-snug group-hover:text-brand">
					{paper.title}
				</p>
				<div className="flex flex-wrap items-center gap-1.5">
					<PlazaSourceBadge
						source={paper.sourceType}
						label={paper.sourceLabel}
					/>
					{paper.ccfRank ? (
						<span className="rounded bg-brand/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-brand leading-none">
							{paper.ccfRank}
						</span>
					) : null}
					<span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
						{paper.publishedAt.slice(0, 10)}
					</span>
					{inVault ? (
						<Library className="size-3 text-emerald-600 dark:text-emerald-300" />
					) : null}
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-1 pt-0.5">
				{typeof sharedCount === "number" && sharedCount > 0 ? (
					<span className="rounded bg-brand/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-brand tabular-nums leading-none">
						×{sharedCount}
					</span>
				) : null}
				<span className="inline-flex items-center gap-1 rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[0.6875rem] text-foreground tabular-nums leading-none">
					<GitFork className="size-2.5 text-muted-foreground" />
					{paper.citationCount ?? 0}
				</span>
			</div>
		</button>
	);
}
