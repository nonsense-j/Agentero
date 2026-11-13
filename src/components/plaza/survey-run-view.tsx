/**
 * One Paper Survey run: header (topic, seeds, actions), live progress while
 * the Agent works, then the result — a cited Related Work paragraph or the
 * long HTML report card.
 */

import {
	AlignLeft,
	Check,
	CheckCircle2,
	Circle,
	ExternalLink,
	FileDown,
	FileText,
	Library,
	Loader2,
	PenLine,
	RotateCcw,
	Square,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageResponse } from "@/components/agent/message";
import {
	CitationCluster,
	CopyIconButton,
	SurveyReferenceList,
} from "@/components/plaza/survey-citation";
import { SurveyReportFrame } from "@/components/plaza/survey-report-frame";
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
import {
	Trace,
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "@/components/ui/trace";
import i18n from "@/i18n";
import { cn } from "@/lib/core/utils";
import { buildSurveyLatex } from "@/lib/plaza/survey-export";
import {
	cancelSurvey,
	exportSurveyLatex,
	exportSurveyReport,
	openSurveyReport,
	removeSurvey,
	rerunSurvey,
} from "@/lib/plaza/survey-store";
import type {
	SurveyCitation,
	SurveyParagraphResult,
	SurveyPhase,
	SurveyReportResult,
	SurveyRun,
	SurveyToolCall,
} from "@/lib/plaza/survey-types";

const PHASES: readonly SurveyPhase[] = [
	"preparing",
	"researching",
	"writing",
	"finalizing",
];

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** Short run timestamp in the app language. */
export function formatRunDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const lang = i18n.language || "en";
	let format = dateFormats.get(lang);
	if (!format) {
		format = new Intl.DateTimeFormat(lang, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
		dateFormats.set(lang, format);
	}
	return format.format(date);
}

function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Re-render once a second while `active`. */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [active]);
	return now;
}

function shortToolName(raw: string): string {
	return (
		raw
			.replace(/^mcp__[^_]+__/, "")
			.replace(/^agentero-collection[/:.]/, "")
			.trim() || "tool"
	);
}

function toolStatus(status: string): "running" | "error" | undefined {
	if (status === "pending" || status === "in_progress") return "running";
	if (status === "failed") return "error";
	return undefined;
}

function ToolSteps({ calls }: { calls: readonly SurveyToolCall[] }) {
	return (
		<Trace className="gap-1.5">
			{calls.map((call) => {
				const status = toolStatus(call.status);
				return (
					<TraceLine key={call.id} status={status} className="text-xs">
						<TraceIcon>
							{status === "running" ? (
								<Loader2 className="size-3.5 animate-spin text-brand" />
							) : status === "error" ? (
								<TriangleAlert className="size-3.5" />
							) : (
								<CheckCircle2 className="size-3.5 text-brand/80" />
							)}
						</TraceIcon>
						<TraceTitle className="font-mono text-[0.6875rem]">
							{shortToolName(call.title)}
						</TraceTitle>
						{call.detail ? (
							<span className="min-w-0 truncate text-muted-foreground/80">
								{call.detail}
							</span>
						) : null}
					</TraceLine>
				);
			})}
		</Trace>
	);
}

function ReasoningBlock({ text }: { text: string }) {
	const { t } = useTranslation("sidebar");
	if (!text.trim()) return null;
	return (
		<TraceCollapsible>
			<TraceCollapsibleTrigger className="text-xs">
				{t("plaza.discover.thinking")}
			</TraceCollapsibleTrigger>
			<TraceCollapsibleContent className="agentero-scroll max-h-64 select-text overflow-y-auto whitespace-pre-wrap text-xs">
				{text}
			</TraceCollapsibleContent>
		</TraceCollapsible>
	);
}

function PhaseStepper({ phase }: { phase: SurveyPhase }) {
	const { t } = useTranslation("sidebar");
	const current = PHASES.indexOf(phase);
	return (
		<ol className="grid grid-cols-4 gap-2">
			{PHASES.map((p, i) => {
				const done = i < current;
				const active = i === current;
				return (
					<li key={p} className="flex min-w-0 flex-col gap-1.5">
						<span
							className={cn(
								"h-0.5 rounded-full transition-colors duration-500 motion-reduce:transition-none",
								done || active ? "bg-brand" : "bg-border",
								active && "animate-pulse motion-reduce:animate-none",
							)}
						/>
						<span
							className={cn(
								"flex min-w-0 items-center gap-1 text-[0.6875rem]",
								active
									? "font-medium text-foreground"
									: done
										? "text-muted-foreground"
										: "text-muted-foreground/60",
							)}
						>
							{done ? (
								<Check className="size-3 shrink-0 text-brand" />
							) : active ? (
								<Loader2 className="size-3 shrink-0 animate-spin text-brand" />
							) : (
								<Circle className="size-2.5 shrink-0" />
							)}
							<span className="truncate">{t(`plaza.survey.phase.${p}`)}</span>
						</span>
					</li>
				);
			})}
		</ol>
	);
}

function SurveyProgress({ run }: { run: SurveyRun }) {
	return (
		<div className="magpie-card flex flex-col gap-4 rounded-2xl p-4">
			<PhaseStepper phase={run.phase} />
			{run.toolCalls.length > 0 ? <ToolSteps calls={run.toolCalls} /> : null}
			<ReasoningBlock text={run.reasoning} />
		</div>
	);
}

/** Collapsed record of how a finished run got there. */
function ProcessTrace({ run }: { run: SurveyRun }) {
	const { t } = useTranslation("sidebar");
	if (run.toolCalls.length === 0 && !run.reasoning.trim()) return null;
	return (
		<TraceCollapsible>
			<TraceCollapsibleTrigger className="text-xs">
				{t("plaza.survey.steps", { count: run.toolCalls.length })}
			</TraceCollapsibleTrigger>
			<TraceCollapsibleContent className="flex flex-col gap-3">
				{run.toolCalls.length > 0 ? <ToolSteps calls={run.toolCalls} /> : null}
				<ReasoningBlock text={run.reasoning} />
			</TraceCollapsibleContent>
		</TraceCollapsible>
	);
}

/** Split trailing sentence punctuation so markers sit before it, LaTeX-style. */
function splitTrailingPunct(text: string): [string, string] {
	const match = text.match(/^([\s\S]*?)([.!?;:。！？；：]+["'”’)]?\s*)$/);
	return match ? [match[1], match[2]] : [text, ""];
}

function ParagraphCard({ result }: { result: SurveyParagraphResult }) {
	const { t } = useTranslation("sidebar");
	const byKey = useMemo(() => {
		const map = new Map<string, SurveyCitation>();
		for (const c of result.citations) map.set(c.key, c);
		return map;
	}, [result.citations]);
	const latex = useMemo(() => buildSurveyLatex(result), [result]);

	return (
		<article className="magpie-card flex flex-col rounded-2xl">
			<header className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
				<h3 className="min-w-0 font-semibold text-[0.9375rem] text-foreground leading-snug">
					{result.title}
				</h3>
				<div className="-mt-0.5 -mr-1.5 flex shrink-0 items-center gap-0.5">
					<CopyIconButton
						text={latex.tex}
						label={t("plaza.survey.copyLatex")}
					/>
					<CopyIconButton
						text={latex.bib}
						label={t("plaza.survey.copyBibtex")}
					/>
				</div>
			</header>
			<div className="flex select-text flex-col gap-3 px-5 pb-4 text-foreground text-sm leading-7">
				{result.paragraphs.map((sentences, pi) => (
					<p
						// biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are static once parsed
						key={pi}
					>
						{sentences.map((sentence, si) => {
							const [body, punct] = splitTrailingPunct(sentence.text);
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: sentences are static once parsed
								<span key={si}>
									{si > 0 ? " " : null}
									{body}
									<CitationCluster keys={sentence.cites} byKey={byKey} />
									{punct}
								</span>
							);
						})}
					</p>
				))}
			</div>
			{result.citations.length > 0 ? (
				<footer className="border-t px-3 pt-2.5 pb-3">
					<p className="mb-1 px-2 font-medium text-[0.6875rem] text-muted-foreground uppercase tracking-wide">
						{t("plaza.survey.references", {
							count: result.citations.length,
						})}
					</p>
					<SurveyReferenceList citations={result.citations} />
				</footer>
			) : null}
		</article>
	);
}

function ReportCard({
	runId,
	result,
}: {
	runId: string;
	result: SurveyReportResult;
}) {
	const { t } = useTranslation("sidebar");
	return (
		<article className="magpie-card flex flex-col overflow-hidden rounded-2xl">
			<header className="flex items-start gap-3 px-5 py-4">
				<div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
					<FileText className="size-4.5" />
				</div>
				<div className="min-w-0 flex-1">
					<h3 className="font-semibold text-[0.9375rem] text-foreground leading-snug">
						{result.title}
					</h3>
					{result.summary ? (
						<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
							{result.summary}
						</p>
					) : null}
					{result.citations.length > 0 ? (
						<p className="mt-1.5 font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
							{t("plaza.survey.references", {
								count: result.citations.length,
							})}
						</p>
					) : null}
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void openSurveyReport(runId)}
					className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
				>
					<ExternalLink className="size-3.5" />
					{t("plaza.openInSystemBrowser")}
				</Button>
			</header>
			<div className="border-t">
				<SurveyReportFrame
					key={result.htmlPath}
					runId={runId}
					title={result.title}
				/>
			</div>
		</article>
	);
}

/** Two-step delete: the first click arms, the second confirms. */
export function DeleteRunButton({
	runId,
	compact,
	className,
}: {
	runId: string;
	/** Smaller variant for list rows. */
	compact?: boolean;
	className?: string;
}) {
	const { t } = useTranslation("sidebar");
	const [armed, setArmed] = useState(false);
	const timer = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (timer.current) window.clearTimeout(timer.current);
		},
		[],
	);
	const label = armed
		? t("plaza.survey.confirmDelete")
		: t("plaza.survey.delete");
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size={compact ? "icon-xs" : "icon-sm"}
					aria-label={label}
					data-armed={armed || undefined}
					onClick={() => {
						if (armed) {
							void removeSurvey(runId);
							return;
						}
						setArmed(true);
						timer.current = window.setTimeout(() => setArmed(false), 2500);
					}}
					className={cn(
						"text-muted-foreground",
						armed &&
							"bg-destructive/10 text-destructive hover:text-destructive",
						className,
					)}
				>
					<Trash2 className={compact ? "size-3" : "size-3.5"} />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

function SeedsBadge({ run }: { run: SurveyRun }) {
	const { t } = useTranslation("sidebar");
	if (run.seeds.length === 0) return null;
	return (
		<HoverCard openDelay={150} closeDelay={80}>
			<HoverCardTrigger asChild>
				<span className="inline-flex cursor-default items-center gap-1 rounded-md bg-muted/70 px-1.5 py-0.5 tabular-nums">
					<Library className="size-3" />
					{run.seeds.length}
				</span>
			</HoverCardTrigger>
			<HoverCardContent align="start" className="w-80 p-2">
				<p className="px-1.5 pt-0.5 pb-1.5 font-medium text-[0.6875rem] text-muted-foreground">
					{t("plaza.survey.papers")}
				</p>
				<ul className="agentero-scroll flex max-h-64 flex-col gap-0.5 overflow-y-auto">
					{run.seeds.map((seed) => (
						<li
							key={seed.path}
							className="rounded-md px-1.5 py-1 text-foreground text-xs leading-snug"
						>
							<span className="line-clamp-2">{seed.title}</span>
							{seed.year ? (
								<span className="text-[0.6875rem] text-muted-foreground tabular-nums">
									{seed.year}
								</span>
							) : null}
						</li>
					))}
				</ul>
			</HoverCardContent>
		</HoverCard>
	);
}

function LoadToComposerButton({ onLoad }: { onLoad: () => void }) {
	const { t } = useTranslation("sidebar");
	const [loaded, setLoaded] = useState(false);
	const timer = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (timer.current) window.clearTimeout(timer.current);
		},
		[],
	);
	const label = t("plaza.survey.editInComposer");
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					onClick={() => {
						onLoad();
						setLoaded(true);
						if (timer.current) window.clearTimeout(timer.current);
						timer.current = window.setTimeout(() => setLoaded(false), 1200);
					}}
					aria-label={label}
					className="text-muted-foreground"
				>
					{loaded ? (
						<Check className="size-3.5 text-brand" />
					) : (
						<PenLine className="size-3.5" />
					)}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

export function SurveyRunView({
	run,
	onLoadToComposer,
}: {
	run: SurveyRun;
	onLoadToComposer?: (run: SurveyRun) => void;
}) {
	const { t } = useTranslation("sidebar");
	const running = run.status === "running";
	const now = useNow(running);
	const [exporting, setExporting] = useState(false);
	const elapsed =
		(running ? now : new Date(run.updatedAt).getTime()) -
		new Date(run.createdAt).getTime();
	const FormatIcon = run.format === "report" ? FileText : AlignLeft;
	const paragraph =
		run.status === "completed" && run.result?.kind === "paragraph"
			? run.result
			: undefined;
	const report =
		run.status === "completed" && run.result?.kind === "report"
			? run.result
			: undefined;

	return (
		<div
			className={cn(
				"mx-auto flex w-full flex-col gap-4 pb-6",
				run.format === "report" ? "max-w-4xl" : "max-w-3xl",
			)}
		>
			<header className="flex items-start justify-between gap-3">
				<div className="min-w-0 space-y-1.5">
					<h2 className="select-text font-semibold text-base text-foreground leading-snug">
						{run.topic}
					</h2>
					<div className="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
						<span className="inline-flex items-center gap-1 rounded-md bg-brand/10 px-1.5 py-0.5 font-medium text-brand">
							<FormatIcon className="size-3" />
							{run.format === "report"
								? t("plaza.survey.formatReport")
								: t("plaza.survey.formatParagraph")}
						</span>
						<SeedsBadge run={run} />
						<span className="tabular-nums">{formatRunDate(run.createdAt)}</span>
						{Number.isFinite(elapsed) && elapsed > 0 ? (
							<span className="font-mono tabular-nums">
								{formatElapsed(elapsed)}
							</span>
						) : null}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					{running ? (
						<>
							{onLoadToComposer ? (
								<LoadToComposerButton onLoad={() => onLoadToComposer(run)} />
							) : null}
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => void cancelSurvey(run.id)}
								className="ml-1 h-7 gap-1.5 px-2.5 text-xs"
							>
								<Square className="size-3 fill-current" />
								{t("plaza.survey.stop")}
							</Button>
						</>
					) : (
						<>
							{paragraph ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={exporting}
											onClick={async () => {
												setExporting(true);
												try {
													await exportSurveyLatex(run.id);
												} finally {
													setExporting(false);
												}
											}}
											aria-label={t("plaza.survey.exportLatex")}
											className="mr-1 h-7 gap-1.5 px-2.5 font-mono text-[0.6875rem]"
										>
											{exporting ? (
												<Loader2 className="size-3.5 animate-spin" />
											) : (
												<FileDown className="size-3.5" />
											)}
											.tex + .bib
										</Button>
									</TooltipTrigger>
									<TooltipContent side="bottom">
										{t("plaza.survey.exportLatex")}
									</TooltipContent>
								</Tooltip>
							) : null}
							{report ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={exporting}
									onClick={async () => {
										setExporting(true);
										try {
											await exportSurveyReport(run.id);
										} finally {
											setExporting(false);
										}
									}}
									className="mr-1 h-7 gap-1.5 px-2.5 text-xs"
								>
									{exporting ? (
										<Loader2 className="size-3.5 animate-spin" />
									) : (
										<FileDown className="size-3.5" />
									)}
									{t("plaza.survey.exportReport")}
								</Button>
							) : null}
							{onLoadToComposer ? (
								<LoadToComposerButton onLoad={() => onLoadToComposer(run)} />
							) : null}
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										onClick={() => void rerunSurvey(run.id)}
										aria-label={t("plaza.survey.rerun")}
										className="text-muted-foreground"
									>
										<RotateCcw className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">
									{t("plaza.survey.rerun")}
								</TooltipContent>
							</Tooltip>
							<DeleteRunButton runId={run.id} />
						</>
					)}
				</div>
			</header>

			{running ? <SurveyProgress run={run} /> : null}

			{run.status === "failed" ? (
				<div className="flex items-start gap-2.5 rounded-xl bg-destructive/8 px-3.5 py-3 text-xs">
					<TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
					<div className="min-w-0 flex-1 space-y-0.5">
						<p className="font-medium text-destructive">
							{t("plaza.survey.failed")}
						</p>
						{run.error ? (
							<p className="select-text whitespace-pre-wrap text-muted-foreground leading-relaxed">
								{run.error}
							</p>
						) : null}
					</div>
				</div>
			) : null}

			{run.status === "cancelled" ? (
				<p className="flex items-center gap-1.5 rounded-xl bg-muted/50 px-3.5 py-2.5 text-muted-foreground text-xs">
					<Square className="size-3" />
					{t("plaza.survey.cancelled")}
				</p>
			) : null}

			{run.status === "completed" && run.result?.kind === "paragraph" ? (
				<ParagraphCard result={run.result} />
			) : null}

			{run.status === "completed" && run.result?.kind === "report" ? (
				<ReportCard runId={run.id} result={run.result} />
			) : null}

			{run.status !== "running" && !run.result && run.content.trim() ? (
				<div className="magpie-card select-text rounded-2xl p-4">
					<MessageResponse className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed">
						{run.content}
					</MessageResponse>
				</div>
			) : null}

			{!running ? <ProcessTrace run={run} /> : null}
		</div>
	);
}
