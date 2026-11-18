"use client";

import { PlateLeaf, type PlateLeafProps } from "platejs/react";

/**
 * Every leaf renderer is the same element with a different tag and classes,
 * so they are declared through one factory rather than repeated five times.
 */
function leafRenderer(
	displayName: string,
	as: "code" | "kbd" | "mark",
	className: string,
) {
	const Leaf = (props: PlateLeafProps) => (
		<PlateLeaf {...props} as={as} className={className}>
			{props.children}
		</PlateLeaf>
	);
	Leaf.displayName = displayName;
	return Leaf;
}

export const CodeLeaf = leafRenderer(
	"CodeLeaf",
	"code",
	"whitespace-pre-wrap rounded-[5px] border border-border/55 bg-muted/65 px-[0.35em] py-[0.12em] font-mono text-[0.86em] text-foreground/90",
);

export const HighlightLeaf = leafRenderer(
	"HighlightLeaf",
	"mark",
	"rounded-[3px] bg-highlight/35 px-0.5 text-inherit box-decoration-clone",
);

export const KbdLeaf = leafRenderer(
	"KbdLeaf",
	"kbd",
	"rounded-[5px] border border-border/80 bg-muted/70 px-1.5 py-0.5 font-mono text-[0.82em] shadow-[0_1px_0_0_var(--border)]",
);

export const SearchHighlightLeaf = leafRenderer(
	"SearchHighlightLeaf",
	"mark",
	"rounded-[2px] bg-yellow-300/45 text-inherit dark:bg-yellow-400/30",
);

export const SearchHighlightActiveLeaf = leafRenderer(
	"SearchHighlightActiveLeaf",
	"mark",
	"rounded-[2px] bg-orange-400/70 text-inherit ring-1 ring-orange-500/60 dark:bg-orange-400/50",
);
