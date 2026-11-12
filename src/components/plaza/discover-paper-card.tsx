import {
	ArrowUpRight,
	BookOpen,
	Check,
	ChevronDown,
	Copy,
	Download,
	FileCode2,
	GitFork,
	Loader2,
	Quote,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { PlazaSourceBadge } from "@/components/icons/plaza-icons";
import { SelectionSurface } from "@/components/selection/selection-surface";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import {
	type CollectionPaperItem,
	formatPaperBibtex,
	formatPaperCitationText,
	getCollectionPaperDetail,
} from "@/lib/plaza/collection";
import { openRemoteArxivPaper } from "@/lib/workspace/actions";

function IconAction({
	label,
	onClick,
	disabled,
	className,
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	className?: string;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					disabled={disabled}
					onClick={onClick}
					aria-label={label}
					className={className}
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

/**
 * Paper card for Discover. `compact` (Deep Search tray) collapses to
 * header + title + authors + the Agent's one-sentence summary; clicking the
 * summary or chevron reveals the abstract, keywords, and secondary actions.
 */
export function DiscoverPaperCard({
	paper,
	compact = false,
	reason,
	selected = false,
	imported = false,
	snowballDisabled = false,
	onToggleSelect,
	onOpenDetail,
	onImport,
	onSnowball,
}: {
	paper: CollectionPaperItem;
	compact?: boolean;
	reason?: string;
	selected?: boolean;
	imported?: boolean;
	snowballDisabled?: boolean;
	onToggleSelect?: (id: string) => void;
	onOpenDetail?: (paper: CollectionPaperItem) => void;
	onImport: (paper: CollectionPaperItem) => Promise<void> | void;
	onSnowball?: (paper: CollectionPaperItem) => void;
}) {
	const { t } = useTranslation("sidebar");
	const [expanded, setExpanded] = useState(false);
	const [importing, setImporting] = useState(false);
	const [copiedKind, setCopiedKind] = useState<"citation" | "bibtex" | null>(
		null,
	);

	const keywords = paper.keywords ?? [];
	const collapsed = compact && !expanded;

	const copyToClipboard = async (kind: "citation" | "bibtex") => {
		try {
			const detail = await getCollectionPaperDetail(paper.id).catch(() => null);
			const resolved = detail ?? paper;
			const text =
				kind === "citation"
					? detail?.citationText?.trim() || formatPaperCitationText(resolved)
					: resolved.bibtex?.trim() || formatPaperBibtex(resolved);
			await navigator.clipboard.writeText(text);
			setCopiedKind(kind);
			window.setTimeout(() => {
				setCopiedKind((prev) => (prev === kind ? null : prev));
			}, 1600);
		} catch {
			// Ignore clipboard failure
		}
	};

	const handleImport = async () => {
		if (importing || imported) return;
		setImporting(true);
		try {
			await onImport(paper);
		} finally {
			setImporting(false);
		}
	};

	const dateLabel = compact
		? paper.year
			? String(paper.year)
			: ""
		: paper.publishedAt
			? paper.publishedAt.slice(0, 10)
			: "";

	const secondaryActions = (
		<>
			{onSnowball ? (
				<IconAction
					label={t("plaza.discover.snowballAction")}
					disabled={snowballDisabled}
					onClick={() => onSnowball(paper)}
				>
					<GitFork className="size-3.5" />
				</IconAction>
			) : null}
			<IconAction
				label={
					copiedKind === "citation"
						? t("plaza.collection.copied")
						: t("plaza.collection.copyCitation")
				}
				onClick={() => void copyToClipboard("citation")}
			>
				{copiedKind === "citation" ? (
					<Check className="size-3.5 text-brand" />
				) : (
					<Copy className="size-3.5" />
				)}
			</IconAction>
			<IconAction
				label={
					copiedKind === "bibtex"
						? t("plaza.collection.copied")
						: t("plaza.collection.copyBibtex")
				}
				onClick={() => void copyToClipboard("bibtex")}
			>
				{copiedKind === "bibtex" ? (
					<Check className="size-3.5 text-brand" />
				) : (
					<FileCode2 className="size-3.5" />
				)}
			</IconAction>
			{paper.arxivId ? (
				<IconAction
					label={t("plaza.arxivRec.read")}
					onClick={() =>
						openRemoteArxivPaper({
							arxivId: paper.arxivId ?? "",
							title: paper.title,
							abstract: paper.abstract,
							url: paper.url,
							score: 1,
						})
					}
				>
					<BookOpen className="size-3.5" />
				</IconAction>
			) : null}
			{paper.url ? (
				<IconAction
					label={t("plaza.feeds.openOriginal")}
					onClick={() => openExternalUrl(paper.url)}
				>
					<ArrowUpRight className="size-3.5" />
				</IconAction>
			) : null}
		</>
	);

	const importAction = (
		<IconAction
			label={imported ? t("plaza.feeds.imported") : t("plaza.feeds.import")}
			disabled={importing || imported}
			onClick={() => void handleImport()}
		>
			{imported ? (
				<Check className="size-3.5 text-brand" />
			) : importing ? (
				<Loader2 className="size-3.5 animate-spin" />
			) : (
				<Download className="size-3.5" />
			)}
		</IconAction>
	);

	const expandLabel = expanded
		? t("plaza.discover.collapseAbstract")
		: t("plaza.discover.expandAbstract");

	return (
		<article
			className={cn(
				"magpie-card group flex flex-col transition-colors motion-reduce:transition-none",
				compact ? "gap-1.5 p-2.5" : "gap-2.5 p-3.5",
				selected && "ring-1 ring-brand/45",
			)}
		>
			{/* Header: selection + metadata badges + actions */}
			<div className="flex items-center justify-between gap-2">
				<div className="flex min-w-0 flex-wrap items-center gap-1.5">
					{onToggleSelect ? (
						<Checkbox
							checked={selected}
							onCheckedChange={() => onToggleSelect(paper.id)}
							aria-label={paper.title}
							className="mr-0.5"
						/>
					) : null}

					<PlazaSourceBadge
						source={paper.sourceType}
						label={paper.sourceLabel}
					/>

					{paper.ccfRank ? (
						<span className="rounded-md bg-brand/12 px-1.5 py-0.5 font-medium font-mono text-[0.6875rem] text-brand leading-none">
							{paper.ccfRank}
						</span>
					) : null}

					{!compact && paper.venueDomain ? (
						<span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground leading-none">
							{paper.venueDomain}
						</span>
					) : null}

					{dateLabel ? (
						<span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
							{dateLabel}
						</span>
					) : null}

					<span className="inline-flex items-center gap-1 rounded-md bg-muted/65 px-1.5 py-0.5 font-medium text-[0.6875rem] text-foreground tabular-nums leading-none">
						<Quote className="size-2.5 text-muted-foreground" />
						{paper.citationCount ?? 0}
					</span>
				</div>

				<div className="flex shrink-0 items-center gap-0.5">
					{compact ? null : secondaryActions}
					{importAction}
					{compact ? (
						<IconAction
							label={expandLabel}
							onClick={() => setExpanded((v) => !v)}
						>
							<ChevronDown
								className={cn(
									"size-3.5 transition-transform motion-reduce:transition-none",
									expanded && "rotate-180",
								)}
							/>
						</IconAction>
					) : null}
				</div>
			</div>

			{/* Title & Authors */}
			<div className="space-y-0.5">
				{onOpenDetail ? (
					<button
						type="button"
						onClick={() => onOpenDetail(paper)}
						className={cn(
							"w-full text-left font-medium text-foreground leading-snug transition-colors hover:text-brand focus:outline-none focus-visible:underline",
							compact ? "text-xs" : "text-sm",
						)}
					>
						{paper.title}
					</button>
				) : (
					<h3
						className={cn(
							"select-text font-medium text-foreground leading-snug",
							compact ? "text-xs" : "text-sm",
						)}
					>
						{paper.title}
					</h3>
				)}

				{paper.authors.length > 0 ? (
					<p
						className={cn(
							"line-clamp-1 select-text text-muted-foreground",
							compact ? "text-[0.6875rem]" : "text-xs",
						)}
					>
						{paper.authors.slice(0, compact ? 3 : 6).join(", ")}
						{paper.authors.length > (compact ? 3 : 6) ? " et al." : ""}
					</p>
				) : null}
			</div>

			{/* Tray card: the full one-sentence summary is always visible; click toggles details */}
			{compact && reason ? (
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					className="w-full rounded-md bg-brand/8 px-2 py-1 text-left text-foreground text-xs leading-relaxed hover:bg-brand/12"
				>
					{reason}
				</button>
			) : null}

			{collapsed ? null : (
				<>
					{/* Agent curation reason */}
					{!compact && reason ? (
						<p className="select-text rounded-md bg-brand/8 px-2.5 py-1.5 text-foreground text-xs leading-relaxed">
							{reason}
						</p>
					) : null}

					{/* Abstract */}
					{paper.abstract ? (
						<div className="space-y-1">
							<SelectionSurface
								source={{
									sourcePath: paper.url,
									sourceUrl: paper.url,
									sourceTitle: paper.title,
									origin: "markdown",
									surface: "abstract",
								}}
								className={cn(
									"select-text text-muted-foreground text-xs leading-relaxed",
									!compact && !expanded && "line-clamp-3",
								)}
							>
								{paper.abstract}
							</SelectionSurface>
							{!compact && paper.abstract.length > 240 ? (
								<button
									type="button"
									onClick={() => setExpanded((v) => !v)}
									className="font-medium text-[0.6875rem] text-brand/85 hover:text-brand focus:outline-none"
								>
									{expandLabel}
								</button>
							) : null}
						</div>
					) : null}

					{/* Keyword chips */}
					{keywords.length > 0 ? (
						<div className="flex flex-wrap gap-1">
							{keywords.slice(0, compact ? 4 : 6).map((kw) => (
								<span
									key={kw}
									className="rounded bg-muted/70 px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground leading-none"
								>
									{kw}
								</span>
							))}
						</div>
					) : null}

					{compact ? (
						<div className="-ml-1 flex items-center gap-0.5">
							{secondaryActions}
						</div>
					) : null}
				</>
			)}
		</article>
	);
}
