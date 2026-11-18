"use client";

import { cva, type VariantProps } from "class-variance-authority";
import type { PlateElementProps } from "platejs/react";
import { PlateElement } from "platejs/react";
import { cn } from "@/lib/core/utils";

/*
 * Heading sizes step down with the editor pane width (`@container/editor` in
 * markdown-editor): at ~200px a fixed text-4xl h1 wraps one word per line.
 * Without that named container (export surface, embeds) the base size applies.
 */
const headingVariants = cva(
	// Document-start spacing is applied from `path` (not :first-child): block
	// drag wrappers make every heading the first child of its own parent.
	"relative text-foreground transition-colors duration-300 data-[nav-target=true]:rounded-md data-[nav-target=true]:bg-highlight/20",
	{
		variants: {
			variant: {
				h1: "mt-6 mb-2 border-b border-border/45 pb-2 font-bold font-heading text-[1.75rem] leading-[1.24] tracking-[-0.024em] @max-sm/editor:text-2xl @max-2xs/editor:text-xl",
				h2: "mt-6 mb-1.5 font-heading font-semibold text-[1.35rem] leading-[1.3] tracking-[-0.018em] @max-2xs/editor:text-lg",
				h3: "mt-6 mb-1 font-heading font-semibold text-[1.125rem] leading-[1.36] tracking-[-0.014em] @max-2xs/editor:text-base",
				h4: "mt-4 mb-0.5 font-heading font-semibold text-[1rem] leading-[1.4] tracking-[-0.008em]",
				h5: "mt-4 mb-0.5 font-semibold text-[0.925rem] leading-[1.42] text-foreground/90",
				h6: "mt-4 mb-0.5 font-medium text-[0.875rem] leading-[1.45] text-muted-foreground",
			},
		},
	},
);

export function HeadingElement({
	variant = "h1",
	...props
}: PlateElementProps & VariantProps<typeof headingVariants>) {
	const isDocumentStart =
		Array.isArray(props.path) && props.path.length === 1 && props.path[0] === 0;
	const attributes = {
		...props.attributes,
		// @platejs/toc 53.0.0 identifies IntersectionObserver targets by DOM
		// `id`. Plate 53.2.x only emits `data-block-id`, so mirror the node id.
		id: typeof props.element.id === "string" ? props.element.id : undefined,
	};

	return (
		<PlateElement
			as={variant ?? "h1"}
			className={cn(headingVariants({ variant }), isDocumentStart && "mt-0")}
			{...props}
			attributes={attributes}
		>
			{props.children}
		</PlateElement>
	);
}

export function H1Element(props: PlateElementProps) {
	return <HeadingElement variant="h1" {...props} />;
}

export function H2Element(props: PlateElementProps) {
	return <HeadingElement variant="h2" {...props} />;
}

export function H3Element(props: PlateElementProps) {
	return <HeadingElement variant="h3" {...props} />;
}

export function H4Element(props: PlateElementProps) {
	return <HeadingElement variant="h4" {...props} />;
}

export function H5Element(props: PlateElementProps) {
	return <HeadingElement variant="h5" {...props} />;
}

export function H6Element(props: PlateElementProps) {
	return <HeadingElement variant="h6" {...props} />;
}
