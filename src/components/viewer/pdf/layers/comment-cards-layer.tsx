/**
 * Comment rail: one persistent card per annotated highlight / visual note,
 * pinned just outside the page's right edge (`left: 100%` inside the
 * overflow-visible page container). Cards
 * stack vertically with collision avoidance and clamp into the page height.
 *
 * Click a card to edit the note in place (Notion-style): the body becomes a
 * textarea, ⌘/Ctrl+Enter or blur saves, Escape cancels. No floating editor.
 *
 * The rail is laid out in unscaled page space and the whole layer is zoomed
 * exactly with the PDF zoom, so cards keep a constant ratio to the page while
 * text, icons, and padding are laid out at their final size.
 */

import { Crop, Link2, MessageSquarePlus, Trash2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageResponse } from "@/components/agent/message";
import { QuietIconButton } from "@/components/ui/quiet-icon-button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
	PageAnnotationComment,
	SelectionCommentDraft,
} from "@/components/viewer/pdf/types";
import { useImeGuard } from "@/hooks/use-ime-guard";
import { cn } from "@/lib/core/utils";
import { applyMarkdownTextareaShortcut } from "@/lib/markdown/textarea-shortcuts";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import {
	DEFAULT_HIGHLIGHT_COLOR,
	swatchColorClass,
} from "@/lib/pdf/highlight/palette";
/** Card width in CSS px — shared by saved cards and selection drafts. */
export const COMMENT_CARD_WIDTH_PX = 216;
/** Horizontal gap between the page edge and the rail. */
export const COMMENT_CARD_GAP_PX = 8;
/** Extra px so ring + shadow aren't clipped by the viewport overflow. */
const COMMENT_RAIL_BLEED_PX = 6;
/** Viewport right padding that keeps the rail clear of horizontal scroll. */
export const COMMENT_RAIL_WIDTH_PX =
	COMMENT_CARD_WIDTH_PX + COMMENT_CARD_GAP_PX + COMMENT_RAIL_BLEED_PX;

const CARD_GAP_PX = 8;
/** text-[0.8125rem] leading-[1.55] ≈ 13px × 1.55 ≈ 20px. */
const CARD_LINE_HEIGHT_PX = 20;
/** Conservative chars per line at 216px with accent-strip padding (CJK-heavy notes). */
const CARD_CHARS_PER_LINE = 14;
/** Vertical padding (py-2.5 = 20px) + border (2px). */
const CARD_BASE_HEIGHT_PX = 22;
/** View-mode clamp for the note body. */
const VIEW_COMMENT_LINES = 3;
/** View-mode clamp for the inline visual-mark conversation preview. */
const VIEW_CONVERSATION_PREVIEW_LINES = 3;
/** In-place editor: min rows so an empty new note has room to type. */
const EDIT_MIN_COMMENT_LINES = 3;
/** In-place editor: layout estimate cap; textarea scrolls past this. */
const EDIT_MAX_COMMENT_LINES = 12;
const COMMENT_CARD_SURFACE_CLASS =
	"group pointer-events-auto absolute select-none rounded-xl border border-border/65 bg-card/96 shadow-raised ring-1 ring-inset ring-white/50 backdrop-blur-md transition-[box-shadow,border-color,background-color,transform] duration-150 ease-out hover:z-[7] hover:border-foreground/20 hover:bg-card hover:shadow-overlay hover:!h-auto supports-backdrop-blur:bg-card/92 dark:border-white/10 dark:bg-card/94 dark:ring-white/5";
const COMMENT_DRAFT_SURFACE_CLASS =
	"group/draft pointer-events-auto absolute z-[7] cursor-text overflow-hidden rounded-xl border border-brand/50 bg-card text-left shadow-overlay ring-2 ring-brand/20 backdrop-blur-md outline-none dark:bg-card/96";
/** Horizontal action bar floating just above the card's top-right corner. */
const COMMENT_ACTION_BAR_CLASS =
	"pointer-events-none absolute right-0 bottom-full mb-1 z-[1] flex translate-y-0.5 items-center gap-0.5 rounded-lg border border-border/65 bg-popover/95 p-0.5 shadow-raised backdrop-blur-md transition-[opacity,transform] duration-150 ease-out group-hover:pointer-events-auto group-hover:translate-y-0 group-focus-within:translate-y-0 motion-reduce:transition-opacity dark:border-white/10";

type CommentCardsLayerProps = {
	inset?: boolean;
	/** Comments for this page only. */
	items: PageAnnotationComment[];
	/** Rendered page width in px (zoom-aware); used by the hover connector. */
	pageWidthPx: number;
	/** Rendered page height in px (zoom-aware). */
	pageHeightPx: number;
	/** PDF zoom; the rail is laid out in page space and scaled to match. */
	scale?: number;
	/** Id of the card currently being edited in place; null when idle. */
	editingId: string | null;
	/** Resolvable wiki target; copy buttons only render when set. */
	wikiTarget: string | null;
	/** Id of the card currently being hovered; null when idle. */
	hoveredId: string | null;
	/** Selection snapshot opened for editing from the toolbar. */
	selectionDraft?: SelectionCommentDraft | null;
	/** Persist a note from `selectionDraft` (non-empty text only). */
	onCommitSelectionComment?: (comment: string) => void;
	/** Editor is focused — keeps the draft after selection clear. */
	onSelectionCommentActiveChange?: (active: boolean) => void;
	/** Drop the sticky draft (Escape). */
	onDismissSelectionComment?: () => void;
	onOpen: (comment: PageAnnotationComment) => void;
	onSave: (comment: PageAnnotationComment, text: string) => void;
	onCancel: () => void;
	onDelete: (comment: PageAnnotationComment) => void;
	onCopyLink: (comment: PageAnnotationComment) => void;
	onCopyEmbed: (comment: PageAnnotationComment) => void;
	/** Add this visual mark's crop to the Agent sidebar composer (#396). */
	onAddToChat: (comment: PageAnnotationComment) => void;
	onHover: (comment: PageAnnotationComment) => void;
	onLeave: () => void;
};

export type CommentCardPlacement = {
	id: string;
	topPx: number;
	heightPx: number;
};

/** Visual line count after clamping (comment: view 3 / edit 12). */
function clampedLines(text: string, max: number): number {
	let lines = 0;
	for (const raw of text.split("\n")) {
		lines += Math.max(1, Math.ceil(raw.length / CARD_CHARS_PER_LINE));
		if (lines >= max) return max;
	}
	return Math.max(1, lines);
}

/** Conservative card height estimate from clamped comment + conversation lines. */
export function estimateCommentCardHeight(
	item: PageAnnotationComment,
	editing = false,
): number {
	const commentLines = editing
		? Math.max(
				EDIT_MIN_COMMENT_LINES,
				clampedLines(item.comment, EDIT_MAX_COMMENT_LINES),
			)
		: clampedLines(item.comment, VIEW_COMMENT_LINES);
	const conversationPreviewLines =
		!editing && item.messages && item.messages.length > 0
			? Math.min(
					VIEW_CONVERSATION_PREVIEW_LINES,
					item.messages.reduce(
						(sum, m) => sum + clampedLines(m.content, VIEW_COMMENT_LINES),
						0,
					),
				)
			: 0;
	return (
		CARD_BASE_HEIGHT_PX +
		commentLines * CARD_LINE_HEIGHT_PX +
		conversationPreviewLines * CARD_LINE_HEIGHT_PX
	);
}

/**
 * Anchor each card at its highlight height, then nudge overlapping cards
 * downward (never sideways) and clamp the whole stack into the page height.
 */
export function layoutCommentCards(
	items: PageAnnotationComment[],
	pageHeightPx: number,
	editingId?: string | null,
): CommentCardPlacement[] {
	const sorted = [...items].sort(
		(a, b) => a.anchorY - b.anchorY || a.id.localeCompare(b.id),
	);
	const laid: CommentCardPlacement[] = [];

	for (const item of sorted) {
		const heightPx = estimateCommentCardHeight(item, item.id === editingId);
		const anchorTop = item.anchorY * pageHeightPx;
		const prev = laid[laid.length - 1];
		const topPx = Math.max(
			anchorTop,
			prev ? prev.topPx + prev.heightPx + CARD_GAP_PX : 0,
		);
		laid.push({ id: item.id, topPx, heightPx });
	}

	// Clamp the stack into the page: shift cards up bottom-first, keeping the
	// avoidance gap between neighbours.
	for (let i = laid.length - 1; i >= 0; i -= 1) {
		const card = laid[i];
		const next = laid[i + 1];
		const maxTop = next
			? next.topPx - CARD_GAP_PX - card.heightPx
			: pageHeightPx - card.heightPx;
		card.topPx = Math.max(0, Math.min(card.topPx, maxTop));
	}

	return laid;
}

/**
 * Word / Feishu-style orthogonal leader from the nearest highlight segment to
 * the laid-out card's left midpoint, folding at the page's right edge.
 * Multi-line highlights pick the rect closest to the card (not the envelope mid).
 * Returns an SVG path `d` in unscaled page-space pixels, or null when undrawable.
 */
export function commentConnectorPath(
	rects: readonly PdfAskNormalizedRect[],
	placement: CommentCardPlacement,
	pageWidthPx: number,
	pageHeightPx: number,
): string | null {
	if (rects.length === 0 || pageWidthPx <= 0 || pageHeightPx <= 0) return null;

	const round = (n: number) => Math.round(n * 100) / 100;
	const y2 = placement.topPx + placement.heightPx / 2;
	const y2Norm = y2 / pageHeightPx;

	let best = rects[0];
	let bestDist = Number.POSITIVE_INFINITY;
	for (const rect of rects) {
		const top = rect.y;
		const bottom = rect.y + rect.h;
		// Distance from the card mid to the closest point inside this segment.
		const clamped = Math.min(Math.max(y2Norm, top), bottom);
		const dist = Math.abs(clamped - y2Norm);
		const right = rect.x + rect.w;
		const bestRight = best.x + best.w;
		if (
			dist < bestDist ||
			(dist === bestDist &&
				(right > bestRight || (right === bestRight && rect.y < best.y)))
		) {
			best = rect;
			bestDist = dist;
		}
	}

	const attachYNorm = Math.min(Math.max(y2Norm, best.y), best.y + best.h);
	const x1 = round((best.x + best.w) * pageWidthPx);
	const y1 = round(attachYNorm * pageHeightPx);
	const xMid = round(pageWidthPx);
	const x2 = round(pageWidthPx + COMMENT_CARD_GAP_PX);
	const y2Rounded = round(y2);

	return `M ${x1} ${y1} L ${xMid} ${y1} L ${xMid} ${y2Rounded} L ${x2} ${y2Rounded}`;
}

function autosizeTextarea(el: HTMLTextAreaElement | null) {
	if (!el) return;
	el.style.height = "0px";
	el.style.height = `${Math.max(el.scrollHeight, CARD_LINE_HEIGHT_PX * EDIT_MIN_COMMENT_LINES)}px`;
}

type CommentCardProps = {
	inset?: boolean;
	item: PageAnnotationComment;
	topPx: number;
	heightPx: number;
	editing: boolean;
	wikiTarget: string | null;
	hovered: boolean;
	onOpen: (comment: PageAnnotationComment) => void;
	onSave: (comment: PageAnnotationComment, text: string) => void;
	onCancel: () => void;
	onDelete: (comment: PageAnnotationComment) => void;
	onCopyLink: (comment: PageAnnotationComment) => void;
	onCopyEmbed: (comment: PageAnnotationComment) => void;
	onAddToChat: (comment: PageAnnotationComment) => void;
	onHover: (comment: PageAnnotationComment) => void;
	onLeave: () => void;
};

const CommentCard = memo(function CommentCard({
	inset,
	item,
	topPx,
	heightPx,
	editing,
	wikiTarget,
	hovered,
	onOpen,
	onSave,
	onCancel,
	onDelete,
	onCopyLink,
	onCopyEmbed,
	onAddToChat,
	onHover,
	onLeave,
}: CommentCardProps) {
	const { t } = useTranslation("viewer");
	const rootRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const cancelledRef = useRef(false);
	const itemRef = useRef(item);
	itemRef.current = item;
	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;
	const onCancelRef = useRef(onCancel);
	onCancelRef.current = onCancel;
	const draftRef = useRef(item.comment);
	const commentSeedRef = useRef(item.comment);
	commentSeedRef.current = item.comment;
	const { isBlockedByIme, compositionProps } = useImeGuard();

	useEffect(() => {
		if (!editing) return;
		cancelledRef.current = false;
		draftRef.current = commentSeedRef.current;
		const el = textareaRef.current;
		if (!el) return;
		el.focus();
		const len = el.value.length;
		el.setSelectionRange(len, len);
		autosizeTextarea(el);
	}, [editing]);

	// Page virtualization unmounts the card if the user scrolls away — treat
	// dirty drafts like blur and commit. Skip no-op saves so React StrictMode's
	// fake unmount doesn't close a freshly opened editor.
	useEffect(() => {
		if (!editing) return;
		return () => {
			if (cancelledRef.current) return;
			if (draftRef.current === commentSeedRef.current) return;
			onSaveRef.current(itemRef.current, draftRef.current);
		};
	}, [editing]);

	const commit = (text: string) => {
		cancelledRef.current = true;
		draftRef.current = text;
		onSave(item, text);
	};

	const cancel = () => {
		cancelledRef.current = true;
		onCancel();
	};

	// Clicking the page does not always blur the textarea. A new empty note
	// should disappear on that click; typed text still commits.
	useEffect(() => {
		if (!editing) return;
		const onPointerDown = (event: PointerEvent) => {
			const current = itemRef.current;
			if (!current.isNew || cancelledRef.current) return;
			const target = event.target as Node | null;
			if (!target || rootRef.current?.contains(target)) return;
			const text = textareaRef.current?.value ?? draftRef.current;
			if (!text.trim()) {
				cancelledRef.current = true;
				onCancelRef.current();
				return;
			}
			cancelledRef.current = true;
			draftRef.current = text;
			onSaveRef.current(current, text);
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, [editing]);

	return (
		<div
			ref={rootRef}
			data-pdf-chrome
			className={cn(
				COMMENT_CARD_SURFACE_CLASS,
				editing
					? "z-[6] border-brand/50 bg-card shadow-overlay ring-2 ring-brand/20"
					: hovered
						? "z-[6] border-foreground/25 bg-card shadow-overlay"
						: "",
			)}
			style={{
				...(inset
					? { right: COMMENT_CARD_GAP_PX }
					: { left: `calc(100% + ${COMMENT_CARD_GAP_PX}px)` }),
				top: topPx,
				width: COMMENT_CARD_WIDTH_PX,
				height: editing ? undefined : heightPx,
				minHeight: heightPx,
			}}
			onPointerEnter={() => onHover(item)}
			onPointerLeave={onLeave}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: blur/pointer isolation for the in-place editor */}
			<div
				className={cn(
					"relative h-full rounded-[inherit] py-2.5 pr-3 pl-3.5",
					editing
						? "overflow-visible"
						: "overflow-hidden group-hover:overflow-visible group-focus-within:overflow-visible",
				)}
				onPointerDown={(e) => e.stopPropagation()}
				onBlur={
					editing
						? (e) => {
								const next = e.relatedTarget as Node | null;
								if (
									next &&
									(e.currentTarget.contains(next) ||
										rootRef.current?.contains(next))
								) {
									return;
								}
								if (cancelledRef.current) return;
								const text = textareaRef.current?.value ?? "";
								if (item.isNew && !text.trim()) {
									cancel();
									return;
								}
								commit(text);
							}
						: undefined
				}
			>
				{/* Left highlight accent bar */}
				<span
					aria-hidden
					className={cn(
						"pointer-events-none absolute top-2.5 bottom-2.5 left-1.5 w-[3px] rounded-full",
						item.kind === "visual"
							? "bg-violet-500/75 dark:bg-violet-400/75"
							: swatchColorClass(item.color),
					)}
				/>
				<div className={cn(!editing && "max-h-[70vh] overflow-y-auto")}>
					{editing ? (
						<div className="block w-full text-left">
							{item.kind === "visual" ? (
								<div className="mb-1 flex items-center gap-1 text-muted-foreground">
									<Crop
										className="size-3 text-violet-600 dark:text-violet-400"
										aria-hidden
									/>
								</div>
							) : null}
							<textarea
								ref={textareaRef}
								className="max-h-60 w-full resize-none bg-transparent p-0 text-[0.8125rem] text-foreground/92 leading-[1.55] outline-none placeholder:text-muted-foreground/65 select-text"
								placeholder={t("annotations.placeholder")}
								aria-label={t("annotations.editorLabel")}
								defaultValue={item.comment}
								rows={EDIT_MIN_COMMENT_LINES}
								{...compositionProps}
								onChange={(e) => {
									draftRef.current = e.currentTarget.value;
									autosizeTextarea(e.currentTarget);
								}}
								onClick={(e) => e.stopPropagation()}
								onKeyDown={(e) => {
									e.stopPropagation();
									if (
										applyMarkdownTextareaShortcut(e, (value) => {
											draftRef.current = value;
											autosizeTextarea(e.currentTarget);
										})
									)
										return;
									if (e.key === "Escape") {
										e.preventDefault();
										cancel();
										return;
									}
									if (
										e.key === "Enter" &&
										(e.metaKey || e.ctrlKey) &&
										!isBlockedByIme(e)
									) {
										e.preventDefault();
										commit(e.currentTarget.value);
									}
								}}
							/>
						</div>
					) : (
						// biome-ignore lint/a11y/useSemanticElements: a native <button> cannot wrap the blockquote/p flow content
						<div
							role="button"
							tabIndex={0}
							className="block w-full cursor-text rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
							onClick={(e) => {
								e.stopPropagation();
								if ((e.target as Element).closest("a, button")) return;
								onOpen(item);
							}}
							onKeyDown={(e) => {
								if (e.target !== e.currentTarget) return;
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onOpen(item);
								}
							}}
						>
							<div
								className={cn(
									"max-h-[3.9rem] overflow-hidden break-words text-[0.8125rem] leading-[1.55] group-hover:max-h-none group-hover:overflow-x-auto",
									item.comment.trim()
										? "text-foreground/90"
										: "text-muted-foreground/65",
								)}
							>
								{item.kind === "visual" && !item.comment.trim() ? (
									<span className="inline-flex items-center gap-1">
										<Crop
											className="size-3 shrink-0 text-violet-600 dark:text-violet-400"
											aria-hidden
										/>
										<span>{t("annotations.placeholder")}</span>
									</span>
								) : item.comment.trim() ? (
									<div className="flex items-start gap-1.5">
										{item.kind === "visual" ? (
											<Crop
												className="mt-1 size-3 shrink-0 text-violet-600 dark:text-violet-400"
												aria-hidden
											/>
										) : null}
										<MessageResponse className="agentero-markdown-compact min-w-0 flex-1 text-[0.8125rem] leading-[1.55] text-foreground/90 [&_p]:my-0 [&_table]:min-w-max">
											{item.comment}
										</MessageResponse>
									</div>
								) : (
									t("annotations.placeholder")
								)}
							</div>
							{item.messages && item.messages.length > 0 ? (
								<div className="mt-2 border-border/45 border-t pt-1.5">
									<div className="line-clamp-3 space-y-1 group-hover:line-clamp-none">
										{item.messages.map((m) => (
											<p
												key={m.id}
												className={cn(
													"whitespace-pre-wrap break-words text-caption leading-relaxed",
													m.role === "assistant"
														? "text-muted-foreground"
														: "font-medium text-foreground/85",
												)}
											>
												{m.content}
											</p>
										))}
									</div>
								</div>
							) : null}
						</div>
					)}
				</div>
				<div
					className={cn(
						COMMENT_ACTION_BAR_CLASS,
						editing
							? "opacity-0 group-hover:opacity-100"
							: "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
					)}
				>
					{wikiTarget ? (
						<>
							<Tooltip>
								<TooltipTrigger asChild>
									<QuietIconButton
										aria-label={t("annotations.copyLink")}
										onClick={(e) => {
											e.stopPropagation();
											onCopyLink(item);
										}}
									>
										<Link2 className="size-3.5" />
									</QuietIconButton>
								</TooltipTrigger>
								<TooltipContent>{t("annotations.copyLink")}</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger asChild>
									<QuietIconButton
										aria-label={t("annotations.copyEmbed")}
										onClick={(e) => {
											e.stopPropagation();
											onCopyEmbed(item);
										}}
									>
										<span className="font-mono text-caption leading-none">
											![[
										</span>
									</QuietIconButton>
								</TooltipTrigger>
								<TooltipContent>{t("annotations.copyEmbed")}</TooltipContent>
							</Tooltip>
						</>
					) : null}
					<Tooltip>
						<TooltipTrigger asChild>
							<QuietIconButton
								aria-label={t("pdfExplain.addToSidebarChat")}
								onClick={(e) => {
									e.stopPropagation();
									onAddToChat(item);
								}}
							>
								<MessageSquarePlus className="size-3.5" />
							</QuietIconButton>
						</TooltipTrigger>
						<TooltipContent>{t("pdfExplain.addToSidebarChat")}</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<QuietIconButton
								tone="destructive"
								aria-label={t("annotations.delete")}
								onClick={(e) => {
									e.stopPropagation();
									cancelledRef.current = true;
									onDelete(item);
								}}
							>
								<Trash2 className="size-3.5" />
							</QuietIconButton>
						</TooltipTrigger>
						<TooltipContent>{t("annotations.delete")}</TooltipContent>
					</Tooltip>
				</div>
			</div>
		</div>
	);
});

type SelectionCommentAffordanceProps = {
	inset?: boolean;
	draft: SelectionCommentDraft;
	pageHeightPx: number;
	onCommit: (comment: string) => void;
	onActiveChange?: (active: boolean) => void;
	/** Dismiss the sticky draft (Escape with empty text). */
	onDismiss?: () => void;
};

/** Selection note editor opened explicitly from the floating toolbar. */
const SelectionCommentAffordance = memo(function SelectionCommentAffordance({
	inset,
	draft,
	pageHeightPx,
	onCommit,
	onActiveChange,
	onDismiss,
}: SelectionCommentAffordanceProps) {
	const { t } = useTranslation("viewer");
	const rootRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const draftTextRef = useRef("");
	const committedRef = useRef(false);
	const onCommitRef = useRef(onCommit);
	onCommitRef.current = onCommit;
	const onActiveChangeRef = useRef(onActiveChange);
	onActiveChangeRef.current = onActiveChange;
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;
	const aliveRef = useRef(true);
	const closingRef = useRef(false);
	const { isBlockedByIme, compositionProps } = useImeGuard();

	const heightPx = estimateCommentCardHeight(
		{
			id: "__selection-draft__",
			pageIndex: draft.page - 1,
			anchorY: draft.anchorY,
			rects: [],
			quote: draft.quote,
			comment: "",
			color: DEFAULT_HIGHLIGHT_COLOR,
			kind: "highlight",
			linkAlias: null,
		},
		true,
	);
	const topPx = Math.max(
		0,
		Math.min(draft.anchorY * pageHeightPx, pageHeightPx - heightPx),
	);

	const commit = useCallback((text: string) => {
		if (committedRef.current) return;
		const trimmed = text.trim();
		if (!trimmed) return;
		committedRef.current = true;
		closingRef.current = true;
		onActiveChangeRef.current?.(false);
		onCommitRef.current(trimmed);
	}, []);

	useEffect(() => {
		aliveRef.current = true;
		onActiveChangeRef.current?.(true);
		const frame = requestAnimationFrame(() => {
			const el = textareaRef.current;
			if (!el || closingRef.current) return;
			el.focus();
			autosizeTextarea(el);
		});
		return () => {
			cancelAnimationFrame(frame);
			aliveRef.current = false;
			onActiveChangeRef.current?.(false);
		};
	}, []);

	// Clicking outside the note (e.g. anywhere on the PDF page) commits typed
	// text or drops an empty draft. Chrome elements (like the selection toolbar)
	// do not trigger dismissal.
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node) || rootRef.current?.contains(target)) {
				return;
			}
			if ((target as Element).closest?.("[data-pdf-chrome]")) {
				return;
			}
			const text = (textareaRef.current?.value ?? draftTextRef.current).trim();
			closingRef.current = true;
			if (text) {
				commit(text);
			} else {
				onDismissRef.current?.();
			}
			textareaRef.current?.blur();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, [commit]);

	return (
		// biome-ignore lint/a11y/useSemanticElements: hosts a textarea; native <button> cannot wrap it
		<div
			ref={rootRef}
			role="group"
			aria-label={t("selection.note")}
			data-pdf-chrome
			data-selection-comment=""
			className={COMMENT_DRAFT_SURFACE_CLASS}
			style={{
				...(inset
					? { right: COMMENT_CARD_GAP_PX }
					: { left: `calc(100% + ${COMMENT_CARD_GAP_PX}px)` }),
				top: topPx,
				width: COMMENT_CARD_WIDTH_PX,
				minHeight: heightPx,
			}}
			onPointerDown={(e) => {
				// Page-local hit: stop EmbedPDF from treating this as click-away
				// before the textarea can take focus. Do not preventDefault.
				e.stopPropagation();
			}}
		>
			<div className="relative py-2.5 pr-3 pl-3.5">
				<span
					className={cn(
						"pointer-events-none absolute top-2.5 bottom-2.5 left-1.5 w-[3px] rounded-full",
						swatchColorClass(DEFAULT_HIGHLIGHT_COLOR),
					)}
					aria-hidden
				/>
				<textarea
					ref={textareaRef}
					className="max-h-60 w-full resize-none bg-transparent p-0 text-[0.8125rem] text-foreground/92 leading-[1.55] outline-none placeholder:text-muted-foreground/65 select-text"
					placeholder={t("annotations.placeholder")}
					aria-label={t("annotations.editorLabel")}
					rows={EDIT_MIN_COMMENT_LINES}
					{...compositionProps}
					onFocus={() => {
						onActiveChangeRef.current?.(true);
					}}
					onChange={(e) => {
						draftTextRef.current = e.currentTarget.value;
						autosizeTextarea(e.currentTarget);
					}}
					onBlur={(e) => {
						if (!aliveRef.current || closingRef.current) return;
						const next = e.relatedTarget as Node | null;
						if (next && rootRef.current?.contains(next)) return;
						const text = draftTextRef.current;
						if (text.trim()) {
							commit(text);
							return;
						}
						closingRef.current = true;
						onDismissRef.current?.();
					}}
					onClick={(e) => e.stopPropagation()}
					onPointerDown={(e) => e.stopPropagation()}
					onKeyDown={(e) => {
						e.stopPropagation();
						if (
							applyMarkdownTextareaShortcut(e, (value) => {
								draftTextRef.current = value;
								autosizeTextarea(e.currentTarget);
							})
						)
							return;
						if (e.key === "Escape") {
							e.preventDefault();
							draftTextRef.current = "";
							e.currentTarget.value = "";
							closingRef.current = true;
							onActiveChangeRef.current?.(false);
							onDismissRef.current?.();
							e.currentTarget.blur();
							return;
						}
						if (
							e.key === "Enter" &&
							(e.metaKey || e.ctrlKey) &&
							!isBlockedByIme(e)
						) {
							e.preventDefault();
							commit(e.currentTarget.value);
						}
					}}
				/>
			</div>
		</div>
	);
});

export const CommentCardsLayer = memo(function CommentCardsLayer({
	inset = false,
	items,
	pageWidthPx,
	pageHeightPx,
	scale = 1,
	editingId,
	wikiTarget,
	hoveredId,
	selectionDraft = null,
	onCommitSelectionComment,
	onSelectionCommentActiveChange,
	onDismissSelectionComment,
	onOpen,
	onSave,
	onCancel,
	onDelete,
	onCopyLink,
	onCopyEmbed,
	onAddToChat,
	onHover,
	onLeave,
}: CommentCardsLayerProps) {
	const [retainedHoverId, setRetainedHoverId] = useState<string | null>(null);
	useEffect(() => {
		if (!inset) return;
		if (hoveredId) {
			setRetainedHoverId(hoveredId);
			return;
		}
		// Let the pointer cross from the source highlight into the inset card.
		const timer = setTimeout(() => setRetainedHoverId(null), 250);
		return () => clearTimeout(timer);
	}, [inset, hoveredId]);
	// Build the rail in page space, then zoom the whole layer with the same
	// ratio as the page so cards shrink and grow with it. Layout `zoom`
	// re-computes the cards' font, icon, and padding sizes before painting;
	// `transform: scale` would stretch a pre-rasterized layer instead.
	const zoom = scale > 0 ? scale : 1;
	const pageWidth = pageWidthPx / zoom;
	const pageHeight = pageHeightPx / zoom;
	// Stacking depends only on items / page height / the edited card; hover
	// re-renders (hoveredId flips) must not redo layout for the whole rail.
	const laid = useMemo(
		() => layoutCommentCards(items, pageHeight, editingId),
		[items, pageHeight, editingId],
	);
	const byId = useMemo(
		() => new Map(items.map((item) => [item.id, item])),
		[items],
	);
	if (!items.length && !selectionDraft) return null;
	const hoveredPlacement = hoveredId
		? (laid.find((pos) => pos.id === hoveredId) ?? null)
		: null;
	const hoveredItem = hoveredId ? (byId.get(hoveredId) ?? null) : null;
	const connectorD =
		!inset && hoveredItem && hoveredPlacement
			? commentConnectorPath(
					hoveredItem.rects,
					hoveredPlacement,
					pageWidth,
					pageHeight,
				)
			: null;
	const svgWidth = pageWidth + COMMENT_CARD_GAP_PX + COMMENT_CARD_WIDTH_PX;

	return (
		// Above translated glyphs (also z-6, mounted earlier) so the rail stays visible.
		<div
			className="pointer-events-none absolute top-0 left-0 z-[6] overflow-visible"
			style={{
				width: pageWidth,
				height: pageHeight,
				zoom,
			}}
		>
			{connectorD ? (
				// Decorative hover leader; announced via the card / hit-target labels.
				// biome-ignore lint/a11y/noSvgWithoutTitle: purely visual connector
				<svg
					aria-hidden
					focusable="false"
					className="pointer-events-none absolute top-0 left-0 overflow-visible"
					width={svgWidth}
					height={pageHeight}
					viewBox={`0 0 ${svgWidth} ${pageHeight}`}
				>
					<path
						d={connectorD}
						fill="none"
						className="stroke-background/85 dark:stroke-background/80"
						strokeWidth={3.5}
						strokeLinecap="round"
						strokeLinejoin="round"
						vectorEffect="non-scaling-stroke"
					/>
					<path
						d={connectorD}
						fill="none"
						className="stroke-foreground/45"
						strokeWidth={1.5}
						strokeLinecap="round"
						strokeLinejoin="round"
						vectorEffect="non-scaling-stroke"
					/>
				</svg>
			) : null}
			<TooltipProvider delayDuration={200}>
				{laid.map((pos) => {
					const item = byId.get(pos.id);
					if (!item) return null;
					if (
						inset &&
						item.id !== editingId &&
						item.id !== hoveredId &&
						item.id !== retainedHoverId &&
						!item.isNew
					)
						return null;
					return (
						<CommentCard
							inset={inset}
							key={item.id}
							item={item}
							topPx={pos.topPx}
							heightPx={pos.heightPx}
							editing={item.id === editingId}
							wikiTarget={wikiTarget}
							hovered={item.id === hoveredId}
							onOpen={onOpen}
							onSave={onSave}
							onCancel={onCancel}
							onDelete={onDelete}
							onCopyLink={onCopyLink}
							onCopyEmbed={onCopyEmbed}
							onAddToChat={onAddToChat}
							onHover={onHover}
							onLeave={onLeave}
						/>
					);
				})}
				{selectionDraft && onCommitSelectionComment ? (
					<SelectionCommentAffordance
						inset={inset}
						draft={selectionDraft}
						pageHeightPx={pageHeight}
						onCommit={onCommitSelectionComment}
						onActiveChange={onSelectionCommentActiveChange}
						onDismiss={onDismissSelectionComment}
					/>
				) : null}
			</TooltipProvider>
		</div>
	);
});
