import {
	ArrowLeft,
	ArrowUp,
	Bot,
	Check,
	CheckCircle2,
	CheckSquare,
	ChevronDown,
	ChevronRight,
	Download,
	History,
	Loader2,
	PanelRight,
	Paperclip,
	Plus,
	Sparkles,
	Square,
	Trash2,
	Wrench,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { MessageResponse } from "@/components/agent/message";
import { DiscoverPaperCard } from "@/components/plaza/discover-paper-card";
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
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import {
	type CollectionPaperItem,
	type CollectionSummarySnapshot,
	getCollectionPapersByIds,
} from "@/lib/plaza/collection";
import {
	createDeepDiscoverSession,
	currentDeepTurnId,
	type DeepReferencePaper,
	type DeepToolCallRecord,
	type DeepTrayEntry,
	deleteDeepDiscoverSession,
	getDeepDiscoverState,
	initDeepDiscoverAgents,
	selectDeepDiscoverSession,
	sendDeepDiscoverTurn,
	setDeepDiscoverAgent,
	setDeepDiscoverModel,
	setDeepPapersKept,
	stopDeepDiscoverTurn,
	subscribeDeepDiscoverState,
} from "@/lib/plaza/deep-discover-store";
import { sameCollectionPaperWork } from "@/lib/plaza/paper-identity";
import { mergeArxivIntoVenueItem } from "@/lib/plaza/paper-search";

type TrayTab = "selected" | "turn" | "history";

const TRAY_MIN_PX = 280;
/** Tray width survives view remounts within the app session. */
let lastTrayWidthPx = 384;

type TrayItem = { entry: DeepTrayEntry; paper: CollectionPaperItem };

type TrayGroup = {
	key: string;
	label: string;
	hint?: string;
	items: TrayItem[];
};

function groupTrayItems(
	items: TrayItem[],
	keyOf: (item: TrayItem) => string,
): Map<string, TrayItem[]> {
	const groups = new Map<string, TrayItem[]>();
	for (const item of items) {
		const key = keyOf(item);
		const bucket = groups.get(key);
		if (bucket) bucket.push(item);
		else groups.set(key, [item]);
	}
	return groups;
}

function formatShortToolName(rawTitle: string): string {
	const cleaned = rawTitle
		.replace(/^mcp__[^_]+__/, "")
		.replace(/^agentero-collection[/:.]/, "")
		.trim();
	return cleaned || "tool";
}

function ToolCallChip({ tool }: { tool: DeepToolCallRecord }) {
	const [open, setOpen] = useState(false);
	const running = tool.status === "pending" || tool.status === "in_progress";
	const failed = tool.status === "failed";
	const shortName = formatShortToolName(tool.title);
	const hasPayload = tool.input !== undefined || tool.output !== undefined;

	return (
		<div
			className={cn(
				"overflow-hidden rounded-xl border border-border/55 bg-card/75 text-xs transition-colors dark:bg-muted/25",
				open && "col-span-full border-border/80 bg-card dark:bg-muted/35",
			)}
		>
			<button
				type="button"
				disabled={!hasPayload}
				onClick={() => hasPayload && setOpen((v) => !v)}
				className={cn(
					"flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left transition-colors",
					hasPayload && "hover:bg-muted/45",
				)}
			>
				<span className="flex min-w-0 items-center gap-1.5">
					{running ? (
						<Loader2 className="size-3 shrink-0 animate-spin text-brand" />
					) : failed ? (
						<Wrench className="size-3 shrink-0 text-destructive" />
					) : (
						<CheckCircle2 className="size-3 shrink-0 text-brand/85" />
					)}
					<span className="truncate font-mono text-[0.6875rem] text-foreground/90">
						{shortName}
					</span>
				</span>
				{hasPayload ? (
					<ChevronRight
						className={cn(
							"size-3 shrink-0 text-muted-foreground/70 transition-transform duration-150 motion-reduce:transition-none",
							open && "rotate-90",
						)}
					/>
				) : null}
			</button>
			{open && hasPayload ? (
				<div className="space-y-1.5 border-border/50 border-t bg-muted/20 px-2.5 py-2">
					{tool.input !== undefined ? (
						<pre className="agentero-scroll max-h-28 overflow-auto rounded-md border border-border/45 bg-background/90 p-2 font-mono text-[0.6875rem] leading-relaxed text-muted-foreground">
							{typeof tool.input === "string"
								? tool.input
								: JSON.stringify(tool.input, null, 2)}
						</pre>
					) : null}
					{tool.output !== undefined ? (
						<pre className="agentero-scroll max-h-36 overflow-auto rounded-md border border-border/45 bg-background/90 p-2 font-mono text-[0.6875rem] leading-relaxed text-muted-foreground">
							{typeof tool.output === "string"
								? tool.output.slice(0, 1200)
								: JSON.stringify(tool.output, null, 2).slice(0, 1200)}
						</pre>
					) : null}
				</div>
			) : null}
		</div>
	);
}

export function DiscoverDeepView({
	summary,
	onObservePapers,
	importedSet,
	isPaperImported,
	onBackToHub,
	onOpenDetail,
	onImportPaper,
	onBatchImport,
}: {
	summary: CollectionSummarySnapshot;
	onObservePapers?: (papers: readonly CollectionPaperItem[]) => void;
	importedSet: ReadonlySet<string>;
	isPaperImported: (
		paper: CollectionPaperItem,
		set: ReadonlySet<string>,
	) => boolean;
	onBackToHub: () => void;
	onOpenDetail: (paper: CollectionPaperItem) => void;
	onImportPaper: (paper: CollectionPaperItem) => Promise<void>;
	onBatchImport: (papers: CollectionPaperItem[]) => Promise<void>;
}) {
	const { t } = useTranslation("sidebar");
	const store = useSyncExternalStore(
		subscribeDeepDiscoverState,
		getDeepDiscoverState,
	);

	const [draft, setDraft] = useState("");
	const [trayOpen, setTrayOpen] = useState(true);
	const [trayTab, setTrayTab] = useState<TrayTab>("turn");
	const [sessionsPopoverOpen, setSessionsPopoverOpen] = useState(false);
	const [agentPopoverOpen, setAgentPopoverOpen] = useState(false);
	const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
	const [openReasoningIds, setOpenReasoningIds] = useState<Set<string>>(
		new Set(),
	);
	const [batchBusy, setBatchBusy] = useState(false);
	const [collectionById, setCollectionById] = useState<
		Map<string, CollectionPaperItem>
	>(() => new Map());

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const stickToBottomRef = useRef(true);
	const trayReqSeqRef = useRef(0);
	const onObservePapersRef = useRef(onObservePapers);
	onObservePapersRef.current = onObservePapers;

	useEffect(() => {
		void initDeepDiscoverAgents();
	}, []);

	const activeSession = useMemo(
		() =>
			store.sessions.find((s) => s.id === store.activeSessionId) ??
			store.sessions[0] ??
			null,
		[store.sessions, store.activeSessionId],
	);

	const isRunning = store.runningRuntimeSessionId !== null;

	const trayRaw = activeSession?.tray;

	const neededIdsKey = useMemo(() => {
		if (!trayRaw?.length) return "";
		return Array.from(new Set(trayRaw.map((e) => e.id))).join("\u0000");
	}, [trayRaw]);

	useEffect(() => {
		if (summary.revision < 0) return;
		if (!neededIdsKey) {
			setCollectionById(new Map());
			return;
		}
		const ids = neededIdsKey.split("\u0000");
		const seq = ++trayReqSeqRef.current;
		void getCollectionPapersByIds(ids)
			.then((papers) => {
				if (seq !== trayReqSeqRef.current) return;
				const map = new Map<string, CollectionPaperItem>();
				for (const p of papers) {
					map.set(p.id, p);
				}
				setCollectionById(map);
				onObservePapersRef.current?.(papers);
			})
			.catch((err) => {
				if (seq !== trayReqSeqRef.current) return;
				notifyError(errorText(err));
			});
	}, [neededIdsKey, summary.revision]);

	const turnId = activeSession ? currentDeepTurnId(activeSession) : null;

	/** Tray entries resolved to Collection papers, deduped by work (newest wins). */
	const trayItems = useMemo<TrayItem[]>(() => {
		if (!trayRaw?.length) return [];
		const allPapers = Array.from(collectionById.values());
		const upgradeToVenue = (
			paper: CollectionPaperItem,
		): CollectionPaperItem => {
			if (paper.sourceType !== "arxiv") return paper;
			const venueTwin = allPapers.find(
				(cand) =>
					cand.sourceType === "venue" && sameCollectionPaperWork(paper, cand),
			);
			return venueTwin ? mergeArxivIntoVenueItem(venueTwin, paper) : paper;
		};
		const out: TrayItem[] = [];
		for (let i = trayRaw.length - 1; i >= 0; i--) {
			const entry = trayRaw[i];
			const raw = collectionById.get(entry.id);
			if (!raw) continue;
			const paper = upgradeToVenue(raw);
			if (out.some((prev) => sameCollectionPaperWork(prev.paper, paper))) {
				continue;
			}
			out.push({ entry, paper });
		}
		return out.reverse();
	}, [trayRaw, collectionById]);

	const turnGroups = useMemo<TrayGroup[]>(() => {
		const current = trayItems.filter((it) => it.entry.turnId === turnId);
		return Array.from(
			groupTrayItems(current, (it) => it.entry.group ?? ""),
			([key, items]) => ({
				key,
				label: key || t("plaza.discover.groupOther"),
				items,
			}),
		);
	}, [trayItems, turnId, t]);

	const turnCount = useMemo(
		() => turnGroups.reduce((sum, g) => sum + g.items.length, 0),
		[turnGroups],
	);

	const selectedItems = useMemo(
		() =>
			trayItems
				.filter((it) => it.entry.kept)
				.sort((a, b) =>
					(a.entry.keptAt ?? "").localeCompare(b.entry.keptAt ?? ""),
				),
		[trayItems],
	);

	/** Earlier turns, newest first, labelled with the user question that started them. */
	const historyGroups = useMemo<TrayGroup[]>(() => {
		const messages = activeSession?.messages ?? [];
		const turnMeta = new Map<string, { index: number; question: string }>();
		let index = 0;
		let question = "";
		for (const msg of messages) {
			if (msg.role === "user") question = msg.content;
			else turnMeta.set(msg.id, { index: ++index, question });
		}
		const past = trayItems.filter((it) => it.entry.turnId !== turnId);
		return Array.from(
			groupTrayItems(past, (it) => it.entry.turnId),
			([key, items]) => {
				const meta = turnMeta.get(key);
				return {
					key,
					label: meta
						? t("plaza.discover.historyTurn", { index: meta.index })
						: t("plaza.discover.groupOther"),
					hint: meta?.question,
					items,
					order: meta?.index ?? 0,
				};
			},
		).sort((a, b) => b.order - a.order);
	}, [activeSession?.messages, trayItems, turnId, t]);

	const historyCount = useMemo(
		() => historyGroups.reduce((sum, g) => sum + g.items.length, 0),
		[historyGroups],
	);

	const activeTrayItems = useMemo<TrayItem[]>(() => {
		if (trayTab === "selected") return selectedItems;
		const groups = trayTab === "turn" ? turnGroups : historyGroups;
		return groups.flatMap((g) => g.items);
	}, [trayTab, selectedItems, turnGroups, historyGroups]);

	const referencePapers = useMemo<DeepReferencePaper[]>(
		() =>
			selectedItems.map((it) => ({ id: it.entry.id, title: it.paper.title })),
		[selectedItems],
	);

	// A new turn fills `This turn`; show it while the Agent works.
	useEffect(() => {
		if (isRunning) setTrayTab("turn");
	}, [isRunning]);

	const lastMsgContentLen =
		activeSession?.messages[activeSession.messages.length - 1]?.content
			.length ?? 0;
	const msgCount = activeSession?.messages.length ?? 0;

	// Auto-scroll when near bottom
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || !stickToBottomRef.current) return;
		if (msgCount === 0 && lastMsgContentLen === 0) return;
		el.scrollTop = el.scrollHeight;
	}, [msgCount, lastMsgContentLen]);

	const handleScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
		stickToBottomRef.current = distance < 96;
	};

	const submitPrompt = useCallback(
		async (text: string) => {
			const trimmed = text.trim();
			if (!trimmed || isRunning) return;
			stickToBottomRef.current = true;
			setDraft("");
			await sendDeepDiscoverTurn(trimmed, referencePapers);
		},
		[isRunning, referencePapers],
	);

	const handleSnowball = useCallback(
		(paper: CollectionPaperItem) => {
			const prompt = t("plaza.discover.snowballPrompt", {
				title: paper.title,
				id: paper.id,
			});
			if (!isRunning) {
				void submitPrompt(prompt);
			} else {
				setDraft(prompt);
			}
		},
		[isRunning, submitPrompt, t],
	);

	const setKept = (items: readonly TrayItem[], kept: boolean) => {
		if (!activeSession) return;
		setDeepPapersKept(
			activeSession.id,
			items.map((it) => it.entry.id),
			kept,
		);
	};

	const allTrayKept =
		activeTrayItems.length > 0 && activeTrayItems.every((it) => it.entry.kept);

	const importableSelected = selectedItems.filter(
		(it) => !isPaperImported(it.paper, importedSet),
	);

	const handleSelectedBatchImport = async () => {
		if (importableSelected.length === 0 || batchBusy) return;
		setBatchBusy(true);
		try {
			await onBatchImport(importableSelected.map((it) => it.paper));
		} finally {
			setBatchBusy(false);
		}
	};

	const renderTrayCard = ({ entry, paper }: TrayItem) => (
		<DiscoverPaperCard
			key={entry.id}
			paper={paper}
			compact
			reason={entry.reason}
			selected={Boolean(entry.kept)}
			imported={isPaperImported(paper, importedSet)}
			snowballDisabled={isRunning}
			onToggleSelect={() => setKept([{ entry, paper }], !entry.kept)}
			onOpenDetail={onOpenDetail}
			onImport={onImportPaper}
			onSnowball={handleSnowball}
		/>
	);

	const currentAgent =
		store.agents.find((a) => a.id === store.selectedAgentId) ?? null;
	const currentModels = store.selectedAgentId
		? (store.modelsByAgent[store.selectedAgentId] ?? [])
		: [];
	const currentModel =
		currentModels.find((m) => m.id === store.selectedModelId) ?? null;

	const starters = [
		t("plaza.discover.starter1"),
		t("plaza.discover.starter2"),
		t("plaza.discover.starter3"),
		t("plaza.discover.starter4"),
	];

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden">
			{/* Top bar */}
			<header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
				<div className="flex min-w-0 items-center gap-2">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={onBackToHub}
						className="h-7 gap-1.5 px-2 text-xs"
					>
						<ArrowLeft className="size-3.5" />
						{t("plaza.discover.backToHub")}
					</Button>

					<span className="inline-flex items-center gap-1 rounded-md bg-brand/10 px-2 py-0.5 font-medium text-brand text-xs">
						<Sparkles className="size-3" />
						{t("plaza.discover.deepTitle")}
					</span>

					{/* Exploration session switcher */}
					<Popover
						open={sessionsPopoverOpen}
						onOpenChange={setSessionsPopoverOpen}
					>
						<PopoverTrigger asChild>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-7 max-w-52 gap-1.5 px-2.5 text-xs"
							>
								<History className="size-3.5 shrink-0 text-muted-foreground" />
								<span className="truncate">
									{activeSession?.title || t("plaza.discover.newSession")}
								</span>
								<ChevronDown className="size-3 shrink-0 text-muted-foreground" />
							</Button>
						</PopoverTrigger>
						<PopoverContent align="start" className="w-72 p-2">
							<div className="mb-1.5 flex items-center justify-between px-1">
								<span className="font-medium text-muted-foreground text-xs">
									{t("plaza.discover.sessions")}
								</span>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => {
										createDeepDiscoverSession();
										setSessionsPopoverOpen(false);
									}}
									className="h-6 gap-1 px-2 text-xs"
								>
									<Plus className="size-3" />
									{t("plaza.discover.newSession")}
								</Button>
							</div>
							{store.sessions.length === 0 ? (
								<p className="px-2 py-3 text-center text-muted-foreground text-xs">
									{t("plaza.discover.noSessions")}
								</p>
							) : (
								<div className="agentero-scroll max-h-60 space-y-0.5 overflow-y-auto">
									{store.sessions.map((sess) => {
										const isActive = sess.id === activeSession?.id;
										return (
											<div
												key={sess.id}
												className={cn(
													"flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-xs",
													isActive
														? "bg-brand/10 text-foreground"
														: "hover:bg-muted/70",
												)}
											>
												<button
													type="button"
													onClick={() => {
														selectDeepDiscoverSession(sess.id);
														setSessionsPopoverOpen(false);
													}}
													className="min-w-0 flex-1 truncate text-left"
												>
													{sess.title || t("plaza.discover.newSession")}
												</button>
												<Button
													type="button"
													variant="ghost"
													size="icon-xs"
													onClick={(e) => {
														e.stopPropagation();
														deleteDeepDiscoverSession(sess.id);
													}}
													aria-label="Delete"
													className="shrink-0 text-muted-foreground hover:text-destructive"
												>
													<Trash2 className="size-3" />
												</Button>
											</div>
										);
									})}
								</div>
							)}
						</PopoverContent>
					</Popover>

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								disabled={isRunning}
								onClick={() => createDeepDiscoverSession()}
								aria-label={t("plaza.discover.newSession")}
							>
								<Plus className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{t("plaza.discover.newSession")}
						</TooltipContent>
					</Tooltip>
				</div>

				{/* Right controls: Agent picker, Model picker, Candidate Tray toggle */}
				<div className="flex items-center gap-1.5">
					{/* Agent selector */}
					<Popover open={agentPopoverOpen} onOpenChange={setAgentPopoverOpen}>
						<PopoverTrigger asChild>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={isRunning || store.agents.length === 0}
								className="h-7 gap-1.5 px-2.5 text-xs"
							>
								<Bot className="size-3.5 text-muted-foreground" />
								<span className="max-w-28 truncate">
									{currentAgent?.name ?? t("plaza.discover.selectAgent")}
								</span>
								<ChevronDown className="size-3 text-muted-foreground" />
							</Button>
						</PopoverTrigger>
						<PopoverContent align="end" className="w-52 p-1.5">
							{store.agents.map((agent) => (
								<button
									key={agent.id}
									type="button"
									onClick={() => {
										setDeepDiscoverAgent(agent.id);
										setAgentPopoverOpen(false);
									}}
									className={cn(
										"flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/70",
										agent.id === store.selectedAgentId &&
											"bg-brand/10 font-medium text-brand",
									)}
								>
									<span className="truncate">{agent.name}</span>
									{agent.id === store.selectedAgentId ? (
										<Check className="size-3.5 shrink-0" />
									) : null}
								</button>
							))}
						</PopoverContent>
					</Popover>

					{/* Model selector (when available for selected agent) */}
					{currentModels.length > 0 ? (
						<Popover open={modelPopoverOpen} onOpenChange={setModelPopoverOpen}>
							<PopoverTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={isRunning}
									className="h-7 max-w-44 gap-1 px-2.5 text-xs"
								>
									<span className="truncate">
										{currentModel?.name ??
											store.selectedModelId ??
											t("plaza.discover.selectModel")}
									</span>
									<ChevronDown className="size-3 shrink-0 text-muted-foreground" />
								</Button>
							</PopoverTrigger>
							<PopoverContent align="end" className="w-60 p-1.5">
								<div className="agentero-scroll max-h-60 space-y-0.5 overflow-y-auto">
									{currentModels.map((model) => (
										<button
											key={model.id}
											type="button"
											onClick={() => {
												setDeepDiscoverModel(model.id);
												setModelPopoverOpen(false);
											}}
											className={cn(
												"flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/70",
												model.id === store.selectedModelId &&
													"bg-brand/10 font-medium text-brand",
											)}
										>
											<span className="truncate">{model.name}</span>
											{model.id === store.selectedModelId ? (
												<Check className="size-3.5 shrink-0" />
											) : null}
										</button>
									))}
								</div>
							</PopoverContent>
						</Popover>
					) : null}

					{/* Candidate tray toggle */}
					<Button
						type="button"
						variant={trayOpen ? "secondary" : "outline"}
						size="sm"
						onClick={() => setTrayOpen((v) => !v)}
						className="h-7 gap-1.5 px-2.5 text-xs tabular-nums"
					>
						<PanelRight className="size-3.5" />
						<span className="hidden sm:inline">
							{t("plaza.discover.trayTitle")}
						</span>
						<span className="rounded-full bg-brand/15 px-1.5 py-0.2 font-mono text-[0.6875rem] text-brand leading-tight">
							{turnCount}
						</span>
					</Button>
				</div>
			</header>

			{/* Dual-pane body: drag the sash to resize the tray */}
			<ResizableGroup
				orientation="horizontal"
				className="min-h-0 flex-1 overflow-hidden"
			>
				{/* Left / Main Multi-Turn Dialog */}
				<ResizablePanel
					id="deep-chat"
					minSize={360}
					className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--magpie-canvas)]/55 dark:bg-background"
				>
					<div
						ref={scrollRef}
						onScroll={handleScroll}
						className="agentero-scroll min-h-0 flex-1 overflow-y-auto px-5 py-5"
					>
						{!activeSession || activeSession.messages.length === 0 ? (
							<div className="mx-auto flex max-w-2xl flex-col gap-5 py-10">
								<div className="space-y-2">
									<div className="inline-flex items-center gap-1.5 rounded-md bg-brand/10 px-2 py-1 font-medium text-brand text-xs">
										<Sparkles className="size-3.5" />
										{t("plaza.discover.deepTitle")}
									</div>
									<h2 className="font-heading font-semibold text-lg text-foreground tracking-tight">
										{t("plaza.discover.deepEmptyTitle")}
									</h2>
									<p className="text-muted-foreground text-[0.8125rem] leading-relaxed">
										{t("plaza.discover.deepEmptyDesc")}
									</p>
									{store.agents.length === 0 ? (
										<p className="text-amber-600 text-xs dark:text-amber-400">
											{t("plaza.discover.noAgentAvailable")}
										</p>
									) : null}
								</div>

								<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
									{starters.map((starter) => (
										<button
											key={starter}
											type="button"
											disabled={isRunning || summary.totalCount === 0}
											onClick={() => void submitPrompt(starter)}
											className="magpie-card rounded-xl px-4 py-3.5 text-left text-foreground/90 text-xs leading-relaxed transition-all hover:-translate-y-0.5 hover:text-foreground disabled:opacity-50 motion-reduce:hover:translate-y-0"
										>
											{starter}
										</button>
									))}
								</div>
							</div>
						) : (
							<div className="mx-auto flex max-w-3xl flex-col gap-5">
								{activeSession.messages.map((msg) => {
									if (msg.role === "user") {
										return (
											<div
												key={msg.id}
												className="flex flex-col items-end gap-1.5"
											>
												<div className="max-w-[84%] select-text whitespace-pre-wrap rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-secondary-foreground text-sm leading-relaxed shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-inset ring-foreground/6">
													{msg.content}
												</div>
												{msg.referenceIds?.length ? (
													<span className="inline-flex items-center gap-1 px-1 text-[0.6875rem] text-muted-foreground tabular-nums">
														<Paperclip className="size-3" />
														{t("plaza.discover.attachedSelected", {
															count: msg.referenceIds.length,
														})}
													</span>
												) : null}
											</div>
										);
									}

									const reasoningOpen = openReasoningIds.has(msg.id);

									return (
										<div key={msg.id} className="flex flex-col gap-2.5">
											{/* MCP Tool Calls */}
											{msg.toolCalls && msg.toolCalls.length > 0 ? (
												<div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
													{msg.toolCalls.map((tc) => (
														<ToolCallChip key={tc.id} tool={tc} />
													))}
												</div>
											) : null}

											{/* Optional Reasoning collapse */}
											{msg.reasoning ? (
												<div className="overflow-hidden rounded-xl border border-border/55 bg-card/65 dark:bg-muted/20">
													<button
														type="button"
														onClick={() =>
															setOpenReasoningIds((prev) => {
																const next = new Set(prev);
																if (next.has(msg.id)) next.delete(msg.id);
																else next.add(msg.id);
																return next;
															})
														}
														className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left font-medium text-[0.6875rem] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
													>
														<ChevronRight
															className={cn(
																"size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
																reasoningOpen && "rotate-90",
															)}
														/>
														{t("plaza.discover.thinking")}
													</button>
													{reasoningOpen ? (
														<div className="border-border/45 border-t px-3.5 py-2.5">
															<MessageResponse
																isAnimating={Boolean(msg.streaming)}
																className="agentero-markdown-compact text-muted-foreground"
															>
																{msg.reasoning}
															</MessageResponse>
														</div>
													) : null}
												</div>
											) : null}

											{/* Assistant Markdown Response */}
											{msg.content ? (
												<div className="magpie-card select-text rounded-2xl px-5 py-4">
													<MessageResponse
														isAnimating={Boolean(msg.streaming)}
														enableOpenUiBlocks
													>
														{msg.content}
													</MessageResponse>
												</div>
											) : msg.streaming ? (
												<div className="flex items-center gap-2 px-1 py-2 text-muted-foreground text-xs">
													<Loader2 className="size-3.5 animate-spin text-brand" />
													<span>{t("plaza.discover.thinking")}…</span>
												</div>
											) : null}

											{/* Inline error fallback */}
											{msg.error ? (
												<p className="rounded-xl border border-destructive/20 bg-destructive/8 px-3.5 py-2.5 text-destructive text-xs leading-relaxed">
													{msg.error}
												</p>
											) : null}

											{/* Follow-up quick reply pills */}
											{!msg.streaming &&
											msg.suggestedFollowUps &&
											msg.suggestedFollowUps.length > 0 ? (
												<div className="flex flex-wrap gap-1.5 pt-0.5">
													{msg.suggestedFollowUps.map((pill) => (
														<button
															key={pill}
															type="button"
															disabled={isRunning}
															onClick={() => void submitPrompt(pill)}
															className="magpie-button-pop rounded-full px-3 py-1 text-left text-foreground/90 text-xs transition-colors hover:text-brand disabled:opacity-50"
														>
															{pill}
														</button>
													))}
												</div>
											) : null}
										</div>
									);
								})}
							</div>
						)}
					</div>

					{/* Always-visible Multi-Turn Composer */}
					<div className="shrink-0 border-border/50 border-t bg-background/85 px-5 py-3 backdrop-blur-md">
						{selectedItems.length > 0 ? (
							<div className="mx-auto mb-2 flex max-w-3xl">
								<button
									type="button"
									onClick={() => {
										setTrayOpen(true);
										setTrayTab("selected");
									}}
									className="magpie-chip hover:border-brand/50"
								>
									<Paperclip className="size-3 text-brand" />
									<span className="tabular-nums">
										{t("plaza.discover.attachedSelected", {
											count: selectedItems.length,
										})}
									</span>
								</button>
							</div>
						) : null}
						<form
							onSubmit={(e) => {
								e.preventDefault();
								void submitPrompt(draft);
							}}
							className="magpie-card mx-auto flex max-w-3xl items-end gap-2 rounded-2xl px-3 py-2 focus-within:ring-2 focus-within:ring-brand/25"
						>
							<textarea
								rows={2}
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								onKeyDown={(e) => {
									if (
										e.key === "Enter" &&
										!e.shiftKey &&
										!e.nativeEvent.isComposing
									) {
										e.preventDefault();
										void submitPrompt(draft);
									}
								}}
								placeholder={t("plaza.discover.composerPlaceholder")}
								className="agentero-scroll max-h-36 min-h-[2.5rem] flex-1 resize-none bg-transparent px-1 py-1 text-foreground text-sm leading-relaxed placeholder:text-muted-foreground/75 focus:outline-none"
							/>

							{isRunning ? (
								<Button
									type="button"
									variant="destructive"
									size="icon-sm"
									onClick={() => void stopDeepDiscoverTurn()}
									aria-label={t("plaza.discover.stop")}
									className="shrink-0 rounded-xl"
								>
									<Square className="size-3.5 fill-current" />
								</Button>
							) : (
								<Button
									type="submit"
									size="icon-sm"
									disabled={!draft.trim() || summary.totalCount === 0}
									aria-label={t("plaza.discover.send")}
									className="shrink-0 rounded-xl"
								>
									<ArrowUp className="size-4" />
								</Button>
							)}
						</form>
					</div>
				</ResizablePanel>

				{/* Right Collapsible Paper Tray: Selected / This turn / History */}
				{trayOpen ? <ResizableHandle /> : null}
				{trayOpen ? (
					<ResizablePanel
						id="deep-tray"
						defaultSize={lastTrayWidthPx}
						minSize={TRAY_MIN_PX}
						maxSize="65%"
						groupResizeBehavior="preserve-pixel-size"
						onResize={(size) => {
							if (size.inPixels >= TRAY_MIN_PX) lastTrayWidthPx = size.inPixels;
						}}
						className="min-h-0 overflow-hidden"
					>
						<aside className="flex h-full flex-col overflow-hidden bg-background">
							<div className="flex shrink-0 items-center justify-between gap-2 border-border/55 border-b px-3 py-2">
								<div className="magpie-seg">
									{(
										[
											["selected", "tabSelected", selectedItems.length],
											["turn", "tabTurn", turnCount],
											["history", "tabHistory", historyCount],
										] as const
									).map(([tab, labelKey, count]) => (
										<button
											key={tab}
											type="button"
											data-active={trayTab === tab}
											onClick={() => setTrayTab(tab)}
											className="magpie-seg-btn tabular-nums"
										>
											{t(`plaza.discover.${labelKey}`, { count })}
										</button>
									))}
								</div>

								<div className="flex items-center gap-1">
									{activeTrayItems.length > 0 ? (
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													type="button"
													variant="ghost"
													size="icon-xs"
													onClick={() => setKept(activeTrayItems, !allTrayKept)}
													aria-label={t("plaza.collection.toggleSelectAll")}
												>
													{allTrayKept ? (
														<CheckSquare className="size-3.5 text-brand" />
													) : (
														<Square className="size-3.5" />
													)}
												</Button>
											</TooltipTrigger>
											<TooltipContent side="bottom">
												{t("plaza.collection.toggleSelectAll")}
											</TooltipContent>
										</Tooltip>
									) : null}

									{importableSelected.length > 0 ? (
										<Button
											type="button"
											size="sm"
											disabled={batchBusy}
											onClick={() => void handleSelectedBatchImport()}
											className="h-6 gap-1 px-2 text-[0.6875rem] tabular-nums"
										>
											{batchBusy ? (
												<Loader2 className="size-3 animate-spin" />
											) : (
												<Download className="size-3" />
											)}
											{t("plaza.collection.importSelected", {
												count: importableSelected.length,
											})}
										</Button>
									) : null}
								</div>
							</div>

							<div className="agentero-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
								{activeTrayItems.length === 0 ? (
									<div className="flex h-40 items-center justify-center px-4 text-center text-muted-foreground text-xs leading-relaxed">
										{trayTab === "selected"
											? t("plaza.discover.trayEmptySelected")
											: trayTab === "turn"
												? t("plaza.discover.trayEmptyTurn")
												: t("plaza.discover.trayEmptyHistory")}
									</div>
								) : trayTab === "selected" ? (
									<div className="space-y-2">
										{selectedItems.map(renderTrayCard)}
									</div>
								) : (
									(trayTab === "turn" ? turnGroups : historyGroups).map(
										(group) => (
											<section key={group.key} className="space-y-2">
												<div className="flex items-baseline justify-between gap-2 px-0.5">
													<h4 className="flex min-w-0 items-baseline gap-1.5 text-xs">
														<span className="shrink-0 font-semibold text-foreground">
															{group.label}
														</span>
														{group.hint ? (
															<span className="truncate text-muted-foreground">
																{group.hint}
															</span>
														) : null}
													</h4>
													<span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
														{group.items.length}
													</span>
												</div>
												<div className="space-y-2">
													{group.items.map(renderTrayCard)}
												</div>
											</section>
										),
									)
								)}
							</div>
						</aside>
					</ResizablePanel>
				) : null}
			</ResizableGroup>
		</div>
	);
}
