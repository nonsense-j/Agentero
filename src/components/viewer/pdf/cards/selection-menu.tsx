import { Bookmark, MessageSquare } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { SelectionActionMenu } from "@/components/selection/selection-action-menu";
import {
	SelectionToolbarDivider,
	SelectionToolbarIconButton,
} from "@/components/selection/selection-toolbar";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import type { HighlightColor } from "@/lib/pdf/highlight/palette";
import {
	HIGHLIGHT_COLOR_STACK_EXPANDED_W,
	HighlightColorStack,
} from "./highlight-color-stack";

type SelectionMenuProps = {
	screen: ScreenPoint;
	onHighlight: (color: HighlightColor) => void;
	onAsk: () => void;
	onAddToChat: () => void;
	onTranslate: () => void;
	onCopy?: () => Promise<boolean>;
	onBookmark?: () => void;
	onNote?: () => void;
	showHighlight?: boolean;
	showTranslate?: boolean;
};

/** PDF-only extensions composed into the application selection menu. */
export function SelectionMenu({
	screen,
	onHighlight,
	onAsk,
	onAddToChat,
	onTranslate,
	onCopy,
	onBookmark,
	onNote,
	showHighlight = true,
	showTranslate = true,
}: SelectionMenuProps) {
	const { t } = useTranslation("viewer");
	const dividerRef = useRef<HTMLDivElement>(null);
	const colorsRef = useRef<HTMLFieldSetElement>(null);
	return (
		<SelectionActionMenu
			screen={screen}
			onAsk={onAsk}
			onAddToChat={onAddToChat}
			onTranslate={showTranslate ? onTranslate : undefined}
			onCopy={onCopy}
			anchorRef={dividerRef}
			expandingRef={colorsRef}
			expandedWidth={HIGHLIGHT_COLOR_STACK_EXPANDED_W}
			beforeActions={
				showHighlight ? (
					<>
						<HighlightColorStack ref={colorsRef} onSelect={onHighlight} />
						{onNote && (
							<SelectionToolbarIconButton
								label={t("selection.note")}
								onClick={onNote}
							>
								<MessageSquare className="size-3.5" />
							</SelectionToolbarIconButton>
						)}
						<SelectionToolbarDivider
							ref={dividerRef}
							data-selection-anchor=""
						/>
					</>
				) : undefined
			}
			afterActions={
				onBookmark ? (
					<SelectionToolbarIconButton
						label={t("pdf.bookmarks.add")}
						onClick={onBookmark}
					>
						<Bookmark className="size-3.5" />
					</SelectionToolbarIconButton>
				) : undefined
			}
		/>
	);
}
