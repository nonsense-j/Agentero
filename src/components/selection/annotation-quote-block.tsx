import { cn } from "@/lib/core/utils";
import {
	DEFAULT_HIGHLIGHT_COLOR,
	type HighlightColor,
	swatchBorderClass,
	swatchColorClass,
} from "@/lib/pdf/highlight/palette";

/** Quote row shared by note embeds and the composer reference card. */
export function AnnotationQuoteBlock({
	quote,
	translation,
	locationLabel,
	color = DEFAULT_HIGHLIGHT_COLOR,
	showSwatch = true,
	selectable = false,
	textClassName,
}: {
	quote?: string | null;
	translation?: string | null;
	locationLabel?: string | null;
	color?: HighlightColor;
	showSwatch?: boolean;
	/** Let the quote and translation be drag-selected. */
	selectable?: boolean;
	textClassName?: string;
}) {
	const quoteText = quote?.trim() ? quote : null;
	if (!locationLabel && !quoteText) return null;
	return (
		<div>
			{locationLabel || showSwatch ? (
				<div className="flex items-center gap-1.5">
					{showSwatch ? (
						<span
							className={cn(
								"size-2 shrink-0 rounded-full",
								swatchColorClass(color),
							)}
							aria-hidden
						/>
					) : null}
					{locationLabel ? (
						<span
							className={cn(
								"min-w-0 truncate font-medium text-muted-foreground tracking-wide",
								textClassName,
							)}
							title={locationLabel}
						>
							{locationLabel}
						</span>
					) : null}
				</div>
			) : null}
			{quoteText ? (
				<blockquote
					data-annotation-selectable={selectable ? "" : undefined}
					className={cn(
						"rounded-r-md border-l-[2.5px] bg-muted/30 py-1.5 pr-2.5 pl-3 not-italic leading-relaxed text-muted-foreground whitespace-pre-wrap break-words",
						locationLabel || showSwatch ? "mt-1.5" : undefined,
						textClassName,
						selectable && "cursor-text select-text",
						showSwatch ? swatchBorderClass(color) : "border-border/80",
					)}
				>
					{quoteText}
					{translation?.trim() ? (
						<span
							className={cn(
								"mt-1 block leading-relaxed text-muted-foreground/60 whitespace-pre-wrap break-words",
								textClassName,
							)}
						>
							{translation}
						</span>
					) : null}
				</blockquote>
			) : null}
		</div>
	);
}
