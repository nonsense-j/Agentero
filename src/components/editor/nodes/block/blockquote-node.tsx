"use client";

import { PlateElement, type PlateElementProps } from "platejs/react";

export function BlockquoteElement(props: PlateElementProps) {
	return (
		<PlateElement
			as="blockquote"
			className="relative my-2.5 rounded-r-lg border-l-[3px] border-brand/50 bg-muted/35 py-1.5 pr-3.5 pl-4 text-foreground/80 not-italic [&>*:first-child]:pt-0.5 [&>*:last-child]:pb-0.5"
			{...props}
		/>
	);
}
