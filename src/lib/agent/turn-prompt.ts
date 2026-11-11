/**
 * Pure assembly of an Agent turn prompt from composer inputs: context path /
 * selection / visual-annotation blocks, the final prompt string, merged image
 * payload, chat visual annotations, and the history title fallback.
 * No side effects — the send pipeline keeps session/ref mutation.
 */
import type { TFunction } from "i18next";
import {
	annotationAppendix,
	planAnnotationRefs,
	proseWithAnnotationMarkers,
	visualDraftsInAnnotationOrder,
} from "@/lib/agent/annotation-prompt";
import type { PromptImage } from "@/lib/agent/api";
import type { ChatVisualAnnotation } from "@/lib/agent/chat-state";
import {
	hasTranscriptChips,
	inlineMarkupToPlain,
	stripInlineTokens,
} from "@/lib/agent/composer-inline-tokens";
import {
	plazaMentionPromptBlock,
	splitContextPaths,
} from "@/lib/agent/plaza-mention";
import type { PdfVisualDraft } from "@/lib/agent/visual-context-store";
import { buildVisualAnnotationsPrompt } from "@/lib/pdf/agent-trace/prompt";

export type AssembleTurnPromptInput = {
	text: string;
	contextPaths: string[];
	visualDrafts: PdfVisualDraft[];
	attachedImages: PromptImage[];
	isAcpCommand: boolean;
	/** Mention path → scratch full-text markdown path (plaza entries). */
	plazaScratchByPath?: ReadonlyMap<string, string> | null;
	t: TFunction<"agent", undefined>;
};

export type AssembledTurnPrompt = {
	prompt: string;
	images: PromptImage[] | undefined;
	visualAnnotations: ChatVisualAnnotation[] | undefined;
	historyTitle: string;
};

export function assembleTurnPrompt({
	text,
	contextPaths,
	visualDrafts,
	attachedImages,
	isAcpCommand,
	plazaScratchByPath,
	t,
}: AssembleTurnPromptInput): AssembledTurnPrompt {
	const displayText = stripInlineTokens(text).trim();
	const annotationRefs = planAnnotationRefs(text);
	const prose =
		annotationRefs.length > 0 ? proseWithAnnotationMarkers(text) : displayText;
	const draftsById = new Map(visualDrafts.map((draft) => [draft.id, draft]));
	const orderedVisualDrafts =
		annotationRefs.length > 0
			? visualDraftsInAnnotationOrder(annotationRefs, visualDrafts)
			: visualDrafts;
	const hasVisualDrafts = orderedVisualDrafts.length > 0;
	const hasAttachedImages = attachedImages.length > 0;

	const contextBlocks: string[] = [];
	// Plaza mentions are virtual paths with no file for the agent to read —
	// expand their metadata inline instead of the vault read-instruction list.
	const { plazaPaths } = splitContextPaths(contextPaths);
	if (plazaPaths.length) {
		contextBlocks.push(
			plazaMentionPromptBlock({
				plazaPaths,
				scratchByPath: plazaScratchByPath,
				t,
			}),
		);
	}
	if (annotationRefs.length > 0) {
		const appendix = annotationAppendix(
			annotationRefs,
			draftsById,
			hasAttachedImages,
		);
		if (appendix) contextBlocks.push(appendix);
	}
	if (annotationRefs.length === 0 && hasVisualDrafts && !isAcpCommand) {
		contextBlocks.push(
			buildVisualAnnotationsPrompt(
				orderedVisualDrafts.map((draft) => ({
					page: draft.page,
					comment: draft.comment,
				})),
			),
		);
	}

	const promptBodyParts: string[] = [];
	if (prose) promptBodyParts.push(prose);
	if (!isAcpCommand && contextBlocks.length) {
		promptBodyParts.push(...contextBlocks);
	}
	const prompt =
		isAcpCommand && displayText
			? displayText
			: promptBodyParts.join("\n\n") ||
				(hasVisualDrafts
					? buildVisualAnnotationsPrompt(
							orderedVisualDrafts.map((draft) => ({
								page: draft.page,
								comment: draft.comment,
							})),
						)
					: hasAttachedImages
						? t("composer.imageOnlyPrompt", {
								count: attachedImages.length,
							})
						: "");

	const visualImages = hasVisualDrafts
		? orderedVisualDrafts.map((draft) => draft.image)
		: [];
	const images =
		visualImages.length || attachedImages.length
			? [...visualImages, ...attachedImages]
			: undefined;

	const visualAnnotations = hasVisualDrafts
		? orderedVisualDrafts.map((draft) => ({
				id: draft.id,
				page: draft.page,
				comment: draft.comment,
				paperPath: draft.paperPath,
				image: {
					data: draft.image.data,
					mimeType: draft.image.mimeType || "image/png",
				},
			}))
		: undefined;

	const historyTitle =
		displayText ||
		(hasTranscriptChips(text) ? inlineMarkupToPlain(text) : "") ||
		orderedVisualDrafts.find((d) => d.comment.trim())?.comment.trim() ||
		(hasVisualDrafts
			? t("composer.visualAnnotationsTitle", {
					count: orderedVisualDrafts.length,
				})
			: hasAttachedImages
				? t("composer.attachedImagesTitle", {
						count: attachedImages.length,
					})
				: t("composer.visualAnnotation"));

	return { prompt, images, visualAnnotations, historyTitle };
}
