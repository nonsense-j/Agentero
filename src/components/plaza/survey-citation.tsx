/**
 * Paper Survey citation UI: inline citation markers (small source icon +
 * number) with a paper hover card, and the numbered reference list.
 */

import {
	BookOpen,
	Check,
	Copy,
	ExternalLink,
	Globe,
	Library,
} from "lucide-react";
import { type ComponentType, type SVGProps, useState } from "react";
import { useTranslation } from "react-i18next";
import { PlazaCollectionIcon } from "@/components/icons/plaza-icons";
import { Button } from "@/components/ui/button";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import type {
	SurveyCitation,
	SurveyCitationSource,
} from "@/lib/plaza/survey-types";
import { joinVaultPath } from "@/lib/vault/path";
import { getVaultPath } from "@/lib/vault/store";
import { openPaper } from "@/lib/workspace/navigation";

const SOURCE_ICON: Record<
	SurveyCitationSource,
	ComponentType<SVGProps<SVGSVGElement>>
> = {
	library: Library,
	collection: PlazaCollectionIcon,
	external: Globe,
};

const SOURCE_TONE: Record<SurveyCitationSource, string> = {
	library: "bg-brand/12 text-brand hover:bg-brand/20",
	collection:
		"bg-sky-500/12 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300",
	external: "bg-muted text-muted-foreground hover:bg-muted/80",
};

const SOURCE_LABEL_KEY = {
	library: "plaza.survey.sourceLibrary",
	collection: "plaza.survey.sourceCollection",
	external: "plaza.survey.sourceExternal",
} as const satisfies Record<SurveyCitationSource, string>;

/** Best public landing page for a citation, or null. */
export function citationUrl(citation: SurveyCitation): string | null {
	if (citation.doi) return `https://doi.org/${citation.doi}`;
	if (citation.arxivId) return `https://arxiv.org/abs/${citation.arxivId}`;
	if (citation.url && /^https?:\/\//i.test(citation.url)) return citation.url;
	return null;
}

/** Open a Library citation's paper in the workspace. False when not possible. */
function openLibraryCitation(citation: SurveyCitation): boolean {
	const vaultPath = getVaultPath();
	if (!vaultPath || !citation.libraryPath) return false;
	openPaper(joinVaultPath(vaultPath, citation.libraryPath));
	return true;
}

function formatAuthors(authors: readonly string[], etAl: string): string {
	if (authors.length === 0) return "";
	if (authors.length <= 3) return authors.join(", ");
	return `${authors.slice(0, 3).join(", ")} ${etAl}`;
}

/** Small icon button that flips to a check mark after a successful copy. */
export function CopyIconButton({
	text,
	label,
	className,
}: {
	text: string | (() => string);
	label: string;
	className?: string;
}) {
	const { t } = useTranslation("sidebar");
	const [copied, setCopied] = useState(false);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={label}
					className={cn("text-muted-foreground", className)}
					onClick={async () => {
						const value = typeof text === "function" ? text() : text;
						const ok = await copyTextToClipboard(value, {
							errorMessage: t("plaza.survey.copyFailed"),
						});
						if (!ok) return;
						setCopied(true);
						window.setTimeout(() => setCopied(false), 1400);
					}}
				>
					{copied ? (
						<Check className="size-3.5 text-brand" />
					) : (
						<Copy className="size-3.5" />
					)}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

function CitationCard({ citation }: { citation: SurveyCitation }) {
	const { t } = useTranslation("sidebar");
	const url = citationUrl(citation);
	const SourceIcon = SOURCE_ICON[citation.source];
	const meta = [citation.year, citation.venue].filter(Boolean).join(" · ");
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-2">
				<span
					className={cn(
						"inline-flex h-5 items-center gap-1 rounded-full px-2 font-medium text-[0.6875rem]",
						SOURCE_TONE[citation.source],
					)}
				>
					<SourceIcon className="size-3" />
					{t(SOURCE_LABEL_KEY[citation.source])}
				</span>
				<span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
					[{citation.index}] {citation.key}
				</span>
			</div>
			<p className="line-clamp-3 font-medium text-foreground text-sm leading-snug">
				{citation.title}
			</p>
			{citation.authors.length > 0 ? (
				<p className="line-clamp-2 text-muted-foreground text-xs">
					{formatAuthors(citation.authors, t("plaza.survey.etAl"))}
				</p>
			) : null}
			{meta ? (
				<p className="text-muted-foreground text-xs tabular-nums">{meta}</p>
			) : null}
			{citation.abstract ? (
				<p className="line-clamp-4 text-muted-foreground/90 text-xs leading-relaxed">
					{citation.abstract}
				</p>
			) : null}
			<div className="-mb-1 flex items-center justify-end gap-0.5 border-t pt-1.5">
				{citation.libraryPath ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label={t("plaza.survey.openPaper")}
								className="text-muted-foreground"
								onClick={() => openLibraryCitation(citation)}
							>
								<BookOpen className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{t("plaza.survey.openPaper")}
						</TooltipContent>
					</Tooltip>
				) : null}
				{url ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label={t("plaza.survey.openLink")}
								className="text-muted-foreground"
								onClick={() => openExternalUrl(url)}
							>
								<ExternalLink className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{t("plaza.survey.openLink")}
						</TooltipContent>
					</Tooltip>
				) : null}
				<CopyIconButton
					text={`\\cite{${citation.key}}`}
					label={t("plaza.survey.copyCite")}
				/>
			</div>
		</div>
	);
}

/** One citation as a compact icon + number pill with a hover card. */
function CitationMarker({ citation }: { citation: SurveyCitation }) {
	const SourceIcon = SOURCE_ICON[citation.source];
	const openable = Boolean(citation.libraryPath) || citationUrl(citation);
	return (
		<HoverCard openDelay={120} closeDelay={80}>
			<HoverCardTrigger asChild>
				<button
					type="button"
					aria-label={citation.title}
					onClick={() => {
						if (openLibraryCitation(citation)) return;
						const url = citationUrl(citation);
						if (url) openExternalUrl(url);
					}}
					className={cn(
						"inline-flex h-[1.05rem] items-center gap-0.5 rounded-full px-1 align-[0.12em] font-medium font-mono text-[0.625rem] tabular-nums leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
						SOURCE_TONE[citation.source],
						!openable && "cursor-default",
					)}
				>
					<SourceIcon className="size-2.5" />
					{citation.index}
				</button>
			</HoverCardTrigger>
			<HoverCardContent side="top" className="w-80">
				<CitationCard citation={citation} />
			</HoverCardContent>
		</HoverCard>
	);
}

/** Cluster of citation markers after a sentence (unknown keys are skipped). */
export function CitationCluster({
	keys,
	byKey,
}: {
	keys: readonly string[];
	byKey: ReadonlyMap<string, SurveyCitation>;
}) {
	const items = keys
		.map((key) => byKey.get(key))
		.filter((c): c is SurveyCitation => Boolean(c));
	if (items.length === 0) return null;
	return (
		<span className="ml-0.5 inline-flex gap-0.5 whitespace-nowrap">
			{items.map((c) => (
				<CitationMarker key={c.key} citation={c} />
			))}
		</span>
	);
}

/** Numbered reference list in citation order. */
export function SurveyReferenceList({
	citations,
}: {
	citations: readonly SurveyCitation[];
}) {
	const { t } = useTranslation("sidebar");
	const sorted = [...citations].sort((a, b) => a.index - b.index);
	return (
		<ol className="flex flex-col gap-0.5">
			{sorted.map((c) => {
				const SourceIcon = SOURCE_ICON[c.source];
				const meta = [
					formatAuthors(c.authors, t("plaza.survey.etAl")),
					c.year,
					c.venue,
				]
					.filter(Boolean)
					.join(" · ");
				return (
					<li key={c.key}>
						<HoverCard openDelay={300} closeDelay={80}>
							<HoverCardTrigger asChild>
								<div className="group flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50">
									<span
										className={cn(
											"mt-0.5 inline-flex h-[1.05rem] shrink-0 items-center gap-0.5 rounded-full px-1 font-medium font-mono text-[0.625rem] tabular-nums leading-none",
											SOURCE_TONE[c.source],
										)}
									>
										<SourceIcon className="size-2.5" />
										{c.index}
									</span>
									<div className="min-w-0 flex-1">
										<p className="line-clamp-2 text-foreground text-xs leading-snug">
											{c.title}
										</p>
										{meta ? (
											<p className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">
												{meta}
											</p>
										) : null}
									</div>
								</div>
							</HoverCardTrigger>
							<HoverCardContent side="left" align="start" className="w-80">
								<CitationCard citation={c} />
							</HoverCardContent>
						</HoverCard>
					</li>
				);
			})}
		</ol>
	);
}
