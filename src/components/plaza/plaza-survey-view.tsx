/**
 * Native 广场 panel: Paper Survey (`agentero:plaza/survey`).
 *
 * Left: composer — seed papers from the vault Library, a concrete topic and
 * the output format (Related Work paragraph or illustrated HTML report).
 * Right: the active run (live progress, then the cited result) with a
 * history switcher. Data/lifecycle live in `lib/plaza/survey-store.ts`.
 */

import {
	AlignLeft,
	ArrowUp,
	CheckCircle2,
	ChevronDown,
	FileText,
	History,
	Library,
	Loader2,
	type LucideIcon,
	PenLine,
	Plus,
	Square,
	TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PlazaSurveyIcon } from "@/components/icons/plaza-icons";
import { SurveyAgentPicker } from "@/components/plaza/survey-agent-picker";
import { SurveyPaperPicker } from "@/components/plaza/survey-paper-picker";
import {
	DeleteRunButton,
	formatRunDate,
	SurveyRunView,
} from "@/components/plaza/survey-run-view";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	ResizableGroup,
	ResizableHandle,
	ResizablePanel,
} from "@/components/ui/resizable";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import {
	initSurveyAgents,
	selectSurveyRun,
	startSurvey,
	usePaperSurveyStore,
} from "@/lib/plaza/survey-store";
import type {
	SurveyFormat,
	SurveyRun,
	SurveyRunStatus,
} from "@/lib/plaza/survey-types";

const COMPOSER_MIN_PX = 300;
/** Composer width survives view remounts within the app session. */
let lastComposerWidthPx = 352;
/** Composer draft survives tab switches within the app session. */
let lastDraft: { topic: string; format: SurveyFormat; papers: string[] } = {
	topic: "",
	format: "paragraph",
	papers: [],
};

const FORMAT_OPTIONS = [
	{
		id: "paragraph",
		icon: AlignLeft,
		labelKey: "plaza.survey.formatParagraph",
		hintKey: "plaza.survey.formatParagraphHint",
	},
	{
		id: "report",
		icon: FileText,
		labelKey: "plaza.survey.formatReport",
		hintKey: "plaza.survey.formatReportHint",
	},
] as const satisfies readonly {
	id: SurveyFormat;
	icon: LucideIcon;
	labelKey: string;
	hintKey: string;
}[];

const EMPTY_STEPS = [
	{ icon: Library, key: "plaza.survey.stepPapers" },
	{ icon: PenLine, key: "plaza.survey.stepTopic" },
	{ icon: FileText, key: "plaza.survey.stepFormat" },
] as const;

function RunStatusIcon({ status }: { status: SurveyRunStatus }) {
	if (status === "running") {
		return <Loader2 className="size-3.5 shrink-0 animate-spin text-brand" />;
	}
	if (status === "failed") {
		return <TriangleAlert className="size-3.5 shrink-0 text-destructive" />;
	}
	if (status === "cancelled") {
		return <Square className="size-3 shrink-0 text-muted-foreground" />;
	}
	return <CheckCircle2 className="size-3.5 shrink-0 text-brand/80" />;
}

function RunRow({
	run,
	active,
	onSelect,
	deletable,
}: {
	run: SurveyRun;
	active?: boolean;
	onSelect: () => void;
	deletable?: boolean;
}) {
	const FormatIcon = run.format === "report" ? FileText : AlignLeft;
	return (
		<div
			className={cn(
				"group flex items-center gap-1 rounded-lg pr-1 text-xs transition-colors",
				active ? "bg-brand/10" : "hover:bg-muted/70",
			)}
		>
			<button
				type="button"
				onClick={onSelect}
				className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
			>
				<RunStatusIcon status={run.status} />
				<span className="min-w-0 flex-1 truncate text-foreground">
					{run.topic}
				</span>
				<FormatIcon className="size-3 shrink-0 text-muted-foreground" />
				<span className="shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">
					{formatRunDate(run.createdAt)}
				</span>
			</button>
			{deletable && run.status !== "running" ? (
				<DeleteRunButton
					runId={run.id}
					compact
					className="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[armed]:opacity-100"
				/>
			) : null}
		</div>
	);
}

function EmptyHero({
	recent,
	onOpen,
}: {
	recent: readonly SurveyRun[];
	onOpen: (id: string) => void;
}) {
	const { t } = useTranslation("sidebar");
	return (
		<div className="mx-auto flex w-full max-w-xl flex-col gap-6 py-10">
			<div className="space-y-2">
				<div className="flex size-10 items-center justify-center rounded-xl bg-brand/10 text-brand">
					<PlazaSurveyIcon className="size-5" />
				</div>
				<h2 className="font-semibold text-base text-foreground">
					{t("plaza.survey.emptyTitle")}
				</h2>
				<p className="text-muted-foreground text-xs leading-relaxed">
					{t("plaza.survey.emptyDesc")}
				</p>
			</div>
			<ol className="grid grid-cols-1 gap-2 sm:grid-cols-3">
				{EMPTY_STEPS.map((step, i) => (
					<li
						key={step.key}
						className="magpie-card flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-foreground text-xs"
					>
						<span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
							{i + 1}
						</span>
						<step.icon className="size-3.5 shrink-0 text-muted-foreground" />
						<span className="min-w-0 truncate">{t(step.key)}</span>
					</li>
				))}
			</ol>
			{recent.length > 0 ? (
				<div className="space-y-1">
					<p className="px-2 font-medium text-[0.6875rem] text-muted-foreground">
						{t("plaza.survey.history")}
					</p>
					{recent.map((run) => (
						<RunRow key={run.id} run={run} onSelect={() => onOpen(run.id)} />
					))}
				</div>
			) : null}
		</div>
	);
}

export function PlazaSurveyView({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const runs = usePaperSurveyStore((s) => s.runs);
	const activeRunId = usePaperSurveyStore((s) => s.activeRunId);
	const agentCount = usePaperSurveyStore((s) => s.agents.length);
	const selectedAgentId = usePaperSurveyStore((s) => s.selectedAgentId);

	const [topic, setTopic] = useState(lastDraft.topic);
	const [format, setFormat] = useState<SurveyFormat>(lastDraft.format);
	const [papers, setPapers] = useState<string[]>(lastDraft.papers);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [starting, setStarting] = useState(false);

	useEffect(() => {
		lastDraft = { topic, format, papers };
	}, [topic, format, papers]);

	useEffect(() => {
		void initSurveyAgents();
	}, []);

	const activeRun = useMemo(
		() => runs.find((r) => r.id === activeRunId) ?? null,
		[runs, activeRunId],
	);

	const canStart =
		!starting &&
		topic.trim().length > 0 &&
		papers.length > 0 &&
		Boolean(selectedAgentId);

	const start = async () => {
		if (!canStart) return;
		setStarting(true);
		try {
			await startSurvey({ topic: topic.trim(), format, paperPaths: papers });
		} finally {
			setStarting(false);
		}
	};

	return (
		<div
			className={cn(
				"flex h-full min-h-0 flex-col overflow-hidden bg-background",
				className,
			)}
		>
			<header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
				<div className="flex min-w-0 items-center gap-2">
					<PlazaSurveyIcon className="size-4 shrink-0 text-brand" />
					<h1 className="font-semibold text-foreground text-sm">
						{t("plaza.survey.label")}
					</h1>
					<Popover open={historyOpen} onOpenChange={setHistoryOpen}>
						<PopoverTrigger asChild>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="ml-1 h-7 max-w-56 gap-1.5 px-2.5 text-xs"
							>
								<History className="size-3.5 shrink-0 text-muted-foreground" />
								<span className="truncate">
									{activeRun?.topic ?? t("plaza.survey.history")}
								</span>
								<ChevronDown className="size-3 shrink-0 text-muted-foreground" />
							</Button>
						</PopoverTrigger>
						<PopoverContent align="start" className="w-80 p-1.5">
							{runs.length === 0 ? (
								<p className="px-2 py-4 text-center text-muted-foreground text-xs">
									{t("plaza.survey.noRuns")}
								</p>
							) : (
								<div className="agentero-scroll max-h-72 space-y-0.5 overflow-y-auto">
									{runs.map((run) => (
										<RunRow
											key={run.id}
											run={run}
											active={run.id === activeRunId}
											onSelect={() => {
												selectSurveyRun(run.id);
												setHistoryOpen(false);
											}}
											deletable
										/>
									))}
								</div>
							)}
						</PopoverContent>
					</Popover>
					{activeRun ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									onClick={() => selectSurveyRun(null)}
									aria-label={t("plaza.survey.newSurvey")}
								>
									<Plus className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{t("plaza.survey.newSurvey")}
							</TooltipContent>
						</Tooltip>
					) : null}
				</div>
				<SurveyAgentPicker />
			</header>

			<ResizableGroup
				orientation="horizontal"
				className="min-h-0 flex-1 overflow-hidden"
			>
				<ResizablePanel
					id="survey-composer"
					defaultSize={lastComposerWidthPx}
					minSize={COMPOSER_MIN_PX}
					maxSize="50%"
					groupResizeBehavior="preserve-pixel-size"
					onResize={(size) => {
						if (size.inPixels >= COMPOSER_MIN_PX) {
							lastComposerWidthPx = size.inPixels;
						}
					}}
					className="min-h-0 overflow-hidden"
				>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void start();
						}}
						className="flex h-full min-h-0 flex-col gap-4 bg-muted/15 p-4"
					>
						<div className="flex shrink-0 flex-col gap-1.5">
							<label
								htmlFor="survey-topic"
								className="font-medium text-muted-foreground text-xs"
							>
								{t("plaza.survey.topic")}
							</label>
							<Textarea
								id="survey-topic"
								rows={3}
								value={topic}
								onChange={(e) => setTopic(e.target.value)}
								onKeyDown={(e) => {
									if (
										e.key === "Enter" &&
										(e.metaKey || e.ctrlKey) &&
										!e.nativeEvent.isComposing
									) {
										e.preventDefault();
										void start();
									}
								}}
								placeholder={t("plaza.survey.topicPlaceholder")}
								className="agentero-scroll max-h-40 min-h-[4.5rem] resize-none bg-background text-xs leading-relaxed"
							/>
						</div>

						<fieldset className="grid shrink-0 grid-cols-2 gap-2">
							<legend className="sr-only">{t("plaza.survey.format")}</legend>
							{FORMAT_OPTIONS.map((opt) => {
								const checked = format === opt.id;
								return (
									<label
										key={opt.id}
										className={cn(
											"flex cursor-pointer flex-col gap-1 rounded-xl border bg-background px-3 py-2.5 text-left transition-[border-color,box-shadow,background-color] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50 motion-reduce:transition-none",
											checked
												? "border-brand/60 bg-brand/6 ring-1 ring-brand/20"
												: "hover:border-foreground/20",
										)}
									>
										<input
											type="radio"
											name="survey-format"
											value={opt.id}
											checked={checked}
											onChange={() => setFormat(opt.id)}
											className="sr-only"
										/>
										<span
											className={cn(
												"flex items-center gap-1.5 font-medium text-xs",
												checked ? "text-brand" : "text-foreground",
											)}
										>
											<opt.icon className="size-3.5 shrink-0" />
											{t(opt.labelKey)}
										</span>
										<span className="text-[0.6875rem] text-muted-foreground leading-snug">
											{t(opt.hintKey)}
										</span>
									</label>
								);
							})}
						</fieldset>

						<SurveyPaperPicker selected={papers} onChange={setPapers} />

						<div className="flex shrink-0 flex-col gap-1.5">
							{agentCount === 0 ? (
								<p className="text-amber-600 text-xs dark:text-amber-400">
									{t("plaza.discover.noAgentAvailable")}
								</p>
							) : null}
							<Button
								type="submit"
								disabled={!canStart}
								className="h-9 w-full gap-1.5 rounded-xl text-xs"
							>
								{starting ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									<ArrowUp className="size-3.5" />
								)}
								{t("plaza.survey.start")}
							</Button>
						</div>
					</form>
				</ResizablePanel>

				<ResizableHandle />

				<ResizablePanel
					id="survey-result"
					minSize={360}
					className="flex min-h-0 min-w-0 flex-col overflow-hidden"
				>
					<div className="agentero-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5">
						{activeRun ? (
							<SurveyRunView key={activeRun.id} run={activeRun} />
						) : (
							<EmptyHero
								recent={runs.slice(0, 4)}
								onOpen={(id) => selectSurveyRun(id)}
							/>
						)}
					</div>
				</ResizablePanel>
			</ResizableGroup>
		</div>
	);
}
