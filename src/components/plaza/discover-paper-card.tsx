import {
	ArrowUpRight,
	BookOpen,
	Check,
	Copy,
	Download,
	FileCode2,
	GitFork,
	Loader2,
	Pin,
	Quote,
} from "lucide-react";
import { useMemo, useState } from "react";
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
	derivePaperKeywords,
	formatPaperBibtex,
	formatPaperCitationText,
} from "@/lib/plaza/collection";
import { openRemoteArxivPaper } from "@/lib/workspace/actions";

export function DiscoverPaperCard({
	paper,
	compact = false,
	reason,
	selected = false,
	imported = false,
	pinned = false,
	snowballDisabled = false,
	onToggleSelect,
	onOpenDetail,
	onImport,
	onTogglePin,
	onSnowball,
}: {
	paper: CollectionPaperItem;
	compact?: boolean;
	reason?: string;
	selected?: boolean;
	imported?: boolean;
	pinned?: boolean;
	snowballDisabled?: boolean;
	onToggleSelect?: (id: string) => void;
	onOpenDetail?: (paper: CollectionPaperItem) => void;
	onImport: (paper: CollectionPaperItem) => Promise<void> | void;
	onTogglePin?: (id: string) => void;
	onSnowball?: (paper: CollectionPaperItem) => void;
}) {
	const { t } = useTranslation("sidebar");
	const [expanded, setExpanded] = useState(false);
	const [importing, setImporting] = useState(false);
	const [copiedKind, setCopiedKind] = useState<"citation" | "bibtex" | null>(
		null,
	);

	const keywords = useMemo(() => {
		if (paper.keywords && paper.keywords.length > 0) return paper.keywords;
		return derivePaperKeywords(paper.title, paper.abstract, paper.categories);
	}, [paper]);

	const copyToClipboard = async (kind: "citation" | "bibtex") => {
		try {
			const text =
				kind === "citation"
					? formatPaperCitationText(paper)
					: formatPaperBibtex(paper);
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

	const dateLabel = paper.publishedAt ? paper.publishedAt.slice(0, 10) : "";

	return (
		<article
			className={cn(
				"magpie-card group flex flex-col transition-colors motion-reduce:transition-none",
				compact ? "gap-2 p-3" : "gap-2.5 p-3.5",
				selected && "ring-1 ring-brand/45",
				pinned && "border-brand/35",
			)}
		>
			{/* Top row: metadata badges + icon actions */}
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
					{onTogglePin ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									onClick={() => onTogglePin(paper.id)}
									aria-label={
										pinned
											? t("plaza.discover.unpinPaper")
											: t("plaza.discover.pinPaper")
									}
									className={cn(pinned && "text-brand")}
								>
									<Pin className={cn("size-3.5", pinned && "fill-current")} />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{pinned
									? t("plaza.discover.unpinPaper")
									: t("plaza.discover.pinPaper")}
							</TooltipContent>
						</Tooltip>
					) : null}

					{onSnowball ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									disabled={snowballDisabled}
									onClick={() => onSnowball(paper)}
									aria-label={t("plaza.discover.snowballAction")}
								>
									<GitFork className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{t("plaza.discover.snowballAction")}
							</TooltipContent>
						</Tooltip>
					) : null}

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								onClick={() => void copyToClipboard("citation")}
								aria-label={t("plaza.collection.copyCitation")}
							>
								{copiedKind === "citation" ? (
									<Check className="size-3.5 text-brand" />
								) : (
									<Copy className="size-3.5" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{copiedKind === "citation"
								? t("plaza.collection.copied")
								: t("plaza.collection.copyCitation")}
						</TooltipContent>
					</Tooltip>

					{!compact ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									onClick={() => void copyToClipboard("bibtex")}
									aria-label={t("plaza.collection.copyBibtex")}
								>
									{copiedKind === "bibtex" ? (
										<Check className="size-3.5 text-brand" />
									) : (
										<FileCode2 className="size-3.5" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{copiedKind === "bibtex"
									? t("plaza.collection.copied")
									: t("plaza.collection.copyBibtex")}
							</TooltipContent>
						</Tooltip>
					) : null}

					{paper.arxivId ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									onClick={() =>
										openRemoteArxivPaper({
											arxivId: paper.arxivId ?? "",
											title: paper.title,
											abstract: paper.abstract,
											url: paper.url,
											score: 1,
										})
									}
									aria-label={t("plaza.arxivRec.read")}
								>
									<BookOpen className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{t("plaza.arxivRec.read")}
							</TooltipContent>
						</Tooltip>
					) : null}

					{paper.url ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									onClick={() => openExternalUrl(paper.url)}
									aria-label={t("plaza.feeds.openOriginal")}
								>
									<ArrowUpRight className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{t("plaza.feeds.openOriginal")}
							</TooltipContent>
						</Tooltip>
					) : null}

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								disabled={importing || imported}
								onClick={() => void handleImport()}
								aria-label={
									imported ? t("plaza.feeds.imported") : t("plaza.feeds.import")
								}
							>
								{imported ? (
									<Check className="size-3.5 text-brand" />
								) : importing ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									<Download className="size-3.5" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{imported ? t("plaza.feeds.imported") : t("plaza.feeds.import")}
						</TooltipContent>
					</Tooltip>
				</div>
			</div>

			{/* Title & Authors */}
			<div className="space-y-1">
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
					<p className="line-clamp-1 select-text text-muted-foreground text-xs">
						{paper.authors.slice(0, 6).join(", ")}
						{paper.authors.length > 6 ? " et al." : ""}
					</p>
				) : null}
			</div>

			{/* Agent curation reason */}
			{reason ? (
				<p className="rounded-md bg-brand/8 px-2.5 py-1.5 text-foreground text-xs leading-relaxed">
					{reason}
				</p>
			) : null}

			{/* Expandable Abstract */}
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
							!expanded && (compact ? "line-clamp-2" : "line-clamp-3"),
						)}
					>
						{paper.abstract}
					</SelectionSurface>
					{paper.abstract.length > (compact ? 140 : 240) ? (
						<button
							type="button"
							onClick={() => setExpanded((v) => !v)}
							className="font-medium text-[0.6875rem] text-brand/85 hover:text-brand focus:outline-none"
						>
							{expanded
								? t("plaza.discover.collapseAbstract")
								: t("plaza.discover.expandAbstract")}
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
		</article>
	);
}
