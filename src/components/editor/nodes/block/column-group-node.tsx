"use client";

import type { TElement } from "platejs";
import { PlateElement, type PlateElementProps } from "platejs/react";

export function ColumnGroupElement(props: PlateElementProps<TElement>) {
	const children = props.element.children as TElement[];
	const count = children.length;

	return (
		<PlateElement
			{...props}
			className="grid grid-cols-[repeat(var(--cols),minmax(0,1fr))] gap-4 py-2"
			style={{ "--cols": count } as React.CSSProperties}
		>
			{props.children}
		</PlateElement>
	);
}

export function ColumnElement(props: PlateElementProps<TElement>) {
	return (
		<PlateElement {...props} className="min-w-0">
			{props.children}
		</PlateElement>
	);
}
