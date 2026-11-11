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
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import type {
	CollectionPaperItem,
	CollectionState,
} from "@/lib/plaza/collection";
import {
	createDeepDiscoverSession,
	type DeepToolCallRecord,
	deleteDeepDiscoverSession,
	getDeepDiscoverState,
	initDeepDiscoverAgents,
	selectDeepDiscoverSession,
	sendDeepDiscoverTurn,
	setDeepDiscoverAgent,
	setDeepDiscoverModel,
	stopDeepDiscoverTurn,
	subscribeDeepDiscoverState,
	togglePinDeepPaper,
} from "@/lib/plaza/deep-discover-store";

type TrayTab = "curated" | "sampled";

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

	return (
		<div className="rounded-lg border bg-muted/35 text-xs">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left"
			>
				<span className="flex min-w-0 items-center gap-1.5">
					{running ? (
						<Loader2 className="size-3 shrink-0 animate-spin text-brand" />
					) : failed ? (
						<Wrench className="size-3 shrink-0 text-destructive" />
					) : (
						<CheckCircle2 className="size-3 shrink-0 text-brand" />
					)}
					<span className="truncate font-mono text-[0.6875rem] text-foreground">
						{shortName}
					</span>
				</span>
				<ChevronRight
					className={cn(
						"size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
						open && "rotate-90",
					)}
				/>
			</button>
			{open && (tool.input !== undefined || tool.output !== undefined) ? (
				<div className="space-y-1.5 border-t px-2.5 py-2">
					{tool.input !== undefined ? (
						<pre className="agentero-scroll max-h-28 overflow-auto rounded bg-background/80 p-1.5 font-mono text-[0.6875rem] text-muted-foreground">
							{typeof tool.input === "string"
								? tool.input
								: JSON.stringify(tool.input, null, 2)}
						</pre>
					) : null}
					{tool.output !== undefined ? (
						<pre className="agentero-scroll max-h-32 overflow-auto rounded bg-background/80 p-1.5 font-mono text-[0.6875rem] text-muted-foreground">
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
	collection,
	importedSet,
	isPaperImported,
	onBackToHub,
	onOpenDetail,
	onImportPaper,
	onBatchImport,
}: {
	collection: CollectionState;
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
	const [trayTab, setTrayTab] = useState<TrayTab>("curated");
	const [sessionsPopoverOpen, setSessionsPopoverOpen] = useState(false);
	const [agentPopoverOpen, setAgentPopoverOpen] = useState(false);
	const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
	const [openReasoningIds, setOpenReasoningIds] = useState<Set<string>>(
		new Set(),
	);
	const [selectedTrayIds, setSelectedTrayIds] = useState<Set<string>>(
		new Set(),
	);
	const [batchBusy, setBatchBusy] = useState(false);

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const stickToBottomRef = useRef(true);

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

	const collectionById = useMemo(() => {
		const map = new Map<string, CollectionPaperItem>();
		for (const item of collection.items) {
			map.set(item.id, item);
		}
		return map;
	}, [collection.items]);

	const resolvedCuratedGroups = useMemo(() => {
		if (!activeSession) return [];
		return activeSession.curatedGroups
			.map((group) => ({
				label: group.label,
				items: group.items.flatMap((entry) => {
					const paper = collectionById.get(entry.id);
					return paper ? [{ paper, reason: entry.reason }] : [];
				}),
			}))
			.filter((group) => group.items.length > 0);
	}, [activeSession, collectionById]);

	const curatedCount = useMemo(
		() =>
			resolvedCuratedGroups.reduce((sum, group) => sum + group.items.length, 0),
		[resolvedCuratedGroups],
	);

	const resolvedSampledPapers = useMemo(() => {
		if (!activeSession) return [];
		return activeSession.sampledIds
			.map((id) => collectionById.get(id))
			.filter((p): p is CollectionPaperItem => p !== undefined);
	}, [activeSession, collectionById]);

	const pinnedSet = useMemo(
		() => new Set(activeSession?.pinnedIds ?? []),
		[activeSession?.pinnedIds],
	);

	const activeTrayPapers = useMemo(() => {
		if (trayTab === "sampled") return resolvedSampledPapers;
		const seen = new Set<string>();
		const list: CollectionPaperItem[] = [];
		for (const g of resolvedCuratedGroups) {
			for (const it of g.items) {
				if (!seen.has(it.paper.id)) {
					seen.add(it.paper.id);
					list.push(it.paper);
				}
			}
		}
		return list;
	}, [trayTab, resolvedSampledPapers, resolvedCuratedGroups]);

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
			await sendDeepDiscoverTurn(trimmed, collection);
		},
		[collection, isRunning],
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

	const toggleTraySelect = (id: string) => {
		setSelectedTrayIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const allTraySelected =
		activeTrayPapers.length > 0 &&
		activeTrayPapers.every((p) => selectedTrayIds.has(p.id));

	const toggleSelectAllTray = () => {
		if (allTraySelected) {
			setSelectedTrayIds(new Set());
			return;
		}
		setSelectedTrayIds(new Set(activeTrayPapers.map((p) => p.id)));
	};

	const handleTrayBatchImport = async () => {
		if (selectedTrayIds.size === 0 || batchBusy) return;
		const chosen = activeTrayPapers.filter(
			(p) => selectedTrayIds.has(p.id) && !isPaperImported(p, importedSet),
		);
		if (chosen.length === 0) {
			setSelectedTrayIds(new Set());
			return;
		}
		setBatchBusy(true);
		try {
			await onBatchImport(chosen);
			setSelectedTrayIds(new Set());
		} finally {
			setBatchBusy(false);
		}
	};

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
							{curatedCount}
						</span>
					</Button>
				</div>
			</header>

			{/* Dual-pane body */}
			<div className="flex min-h-0 flex-1 overflow-hidden">
				{/* Left / Main Multi-Turn Dialog */}
				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
					<div
						ref={scrollRef}
						onScroll={handleScroll}
						className="agentero-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4"
					>
						{!activeSession || activeSession.messages.length === 0 ? (
							<div className="mx-auto flex max-w-2xl flex-col gap-5 py-8">
								<div className="space-y-2">
									<div className="inline-flex items-center gap-1.5 rounded-md bg-brand/10 px-2 py-1 font-medium text-brand text-xs">
										<Sparkles className="size-3.5" />
										{t("plaza.discover.deepTitle")}
									</div>
									<h2 className="font-semibold text-base text-foreground">
										{t("plaza.discover.deepEmptyTitle")}
									</h2>
									<p className="text-muted-foreground text-xs leading-relaxed">
										{t("plaza.discover.deepEmptyDesc")}
									</p>
									{store.agents.length === 0 ? (
										<p className="text-amber-600 text-xs dark:text-amber-400">
											{t("plaza.discover.noAgentAvailable")}
										</p>
									) : null}
								</div>

								<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
									{starters.map((starter) => (
										<button
											key={starter}
											type="button"
											disabled={isRunning || collection.items.length === 0}
											onClick={() => void submitPrompt(starter)}
											className="magpie-card rounded-xl p-3 text-left text-foreground text-xs leading-relaxed transition-colors hover:border-brand/40 disabled:opacity-50"
										>
											{starter}
										</button>
									))}
								</div>
							</div>
						) : (
							<div className="mx-auto flex max-w-3xl flex-col gap-4">
								{activeSession.messages.map((msg) => {
									if (msg.role === "user") {
										return (
											<div key={msg.id} className="flex justify-end">
												<div className="max-w-[85%] select-text whitespace-pre-wrap rounded-2xl bg-brand/12 px-3.5 py-2.5 text-foreground text-sm leading-relaxed">
													{msg.content}
												</div>
											</div>
										);
									}

									const reasoningOpen = openReasoningIds.has(msg.id);

									return (
										<div key={msg.id} className="flex flex-col gap-2">
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
												<div className="rounded-lg border bg-muted/25 px-2.5 py-1.5">
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
														className="flex items-center gap-1 font-medium text-[0.6875rem] text-muted-foreground hover:text-foreground"
													>
														<ChevronRight
															className={cn(
																"size-3 transition-transform",
																reasoningOpen && "rotate-90",
															)}
														/>
														{t("plaza.discover.thinking")}
													</button>
													{reasoningOpen ? (
														<p className="mt-1.5 select-text whitespace-pre-wrap text-muted-foreground text-xs leading-relaxed">
															{msg.reasoning}
														</p>
													) : null}
												</div>
											) : null}

											{/* Assistant Markdown Response */}
											{msg.content ? (
												<div className="magpie-card select-text rounded-xl p-3.5">
													<MessageResponse className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed">
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
												<p className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive text-xs">
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
															className="rounded-full border bg-background px-3 py-1 text-left text-foreground text-xs transition-colors hover:border-brand/50 hover:bg-brand/8 disabled:opacity-50"
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
					<div className="shrink-0 border-t bg-background/80 px-4 py-3">
						<form
							onSubmit={(e) => {
								e.preventDefault();
								void submitPrompt(draft);
							}}
							className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border bg-background p-2 shadow-xs focus-within:border-brand/60"
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
								className="agentero-scroll max-h-36 min-h-[2.5rem] flex-1 resize-none bg-transparent px-1.5 py-1 text-foreground text-xs leading-relaxed placeholder:text-muted-foreground focus:outline-none"
							/>

							{isRunning ? (
								<Button
									type="button"
									variant="destructive"
									size="icon-sm"
									onClick={() => void stopDeepDiscoverTurn()}
									aria-label={t("plaza.discover.stop")}
									className="shrink-0 rounded-lg"
								>
									<Square className="size-3.5 fill-current" />
								</Button>
							) : (
								<Button
									type="submit"
									size="icon-sm"
									disabled={!draft.trim() || collection.items.length === 0}
									aria-label={t("plaza.discover.send")}
									className="shrink-0 rounded-lg"
								>
									<ArrowUp className="size-4" />
								</Button>
							)}
						</form>
					</div>
				</div>

				{/* Right Collapsible Candidate Tray */}
				{trayOpen ? (
					<aside className="flex w-80 shrink-0 flex-col overflow-hidden border-l bg-muted/15 lg:w-96">
						<div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
							<div className="inline-flex items-center rounded-lg bg-muted/70 p-0.5">
								<button
									type="button"
									onClick={() => setTrayTab("curated")}
									className={cn(
										"rounded-md px-2 py-1 font-medium text-xs tabular-nums transition-colors",
										trayTab === "curated"
											? "bg-background text-foreground shadow-xs"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{t("plaza.discover.tabCurated", { count: curatedCount })}
								</button>
								<button
									type="button"
									onClick={() => setTrayTab("sampled")}
									className={cn(
										"rounded-md px-2 py-1 font-medium text-xs tabular-nums transition-colors",
										trayTab === "sampled"
											? "bg-background text-foreground shadow-xs"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{t("plaza.discover.tabSampled", {
										count: resolvedSampledPapers.length,
									})}
								</button>
							</div>

							<div className="flex items-center gap-1">
								{activeTrayPapers.length > 0 ? (
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon-xs"
												onClick={toggleSelectAllTray}
												aria-label={t("plaza.collection.toggleSelectAll")}
											>
												{allTraySelected ? (
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

								{selectedTrayIds.size > 0 ? (
									<Button
										type="button"
										size="sm"
										disabled={batchBusy}
										onClick={() => void handleTrayBatchImport()}
										className="h-6 gap-1 px-2 text-[0.6875rem] tabular-nums"
									>
										{batchBusy ? (
											<Loader2 className="size-3 animate-spin" />
										) : (
											<Download className="size-3" />
										)}
										{t("plaza.collection.importSelected", {
											count: selectedTrayIds.size,
										})}
									</Button>
								) : null}
							</div>
						</div>

						<div className="agentero-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
							{trayTab === "curated" ? (
								resolvedCuratedGroups.length === 0 ? (
									<div className="flex h-40 items-center justify-center px-4 text-center text-muted-foreground text-xs leading-relaxed">
										{t("plaza.discover.trayEmptyCurated")}
									</div>
								) : (
									resolvedCuratedGroups.map((group) => (
										<section key={group.label} className="space-y-2">
											<div className="flex items-center justify-between px-0.5">
												<h4 className="font-semibold text-foreground text-xs">
													{group.label}
												</h4>
												<span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
													{group.items.length}
												</span>
											</div>
											<div className="space-y-2">
												{group.items.map(({ paper, reason }) => (
													<DiscoverPaperCard
														key={paper.id}
														paper={paper}
														compact
														reason={reason}
														selected={selectedTrayIds.has(paper.id)}
														imported={isPaperImported(paper, importedSet)}
														pinned={pinnedSet.has(paper.id)}
														snowballDisabled={isRunning}
														onToggleSelect={toggleTraySelect}
														onOpenDetail={onOpenDetail}
														onImport={onImportPaper}
														onTogglePin={
															activeSession
																? (id) =>
																		togglePinDeepPaper(activeSession.id, id)
																: undefined
														}
														onSnowball={handleSnowball}
													/>
												))}
											</div>
										</section>
									))
								)
							) : resolvedSampledPapers.length === 0 ? (
								<div className="flex h-40 items-center justify-center px-4 text-center text-muted-foreground text-xs leading-relaxed">
									{t("plaza.discover.trayEmptySampled")}
								</div>
							) : (
								<div className="space-y-2">
									{resolvedSampledPapers.map((paper) => (
										<DiscoverPaperCard
											key={paper.id}
											paper={paper}
											compact
											selected={selectedTrayIds.has(paper.id)}
											imported={isPaperImported(paper, importedSet)}
											pinned={pinnedSet.has(paper.id)}
											snowballDisabled={isRunning}
											onToggleSelect={toggleTraySelect}
											onOpenDetail={onOpenDetail}
											onImport={onImportPaper}
											onTogglePin={
												activeSession
													? (id) => togglePinDeepPaper(activeSession.id, id)
													: undefined
											}
											onSnowball={handleSnowball}
										/>
									))}
								</div>
							)}
						</div>
					</aside>
				) : null}
			</div>
		</div>
	);
}
