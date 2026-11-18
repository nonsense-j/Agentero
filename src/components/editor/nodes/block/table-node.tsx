"use client";

import { PlateElement, type PlateElementProps } from "platejs/react";

export function TableElement(props: PlateElementProps) {
	return (
		<PlateElement
			{...props}
			as="table"
			className="my-3 w-full table-fixed border-collapse border border-border/65 text-[0.875em]"
		>
			<tbody>{props.children}</tbody>
		</PlateElement>
	);
}

export function TableRowElement(props: PlateElementProps) {
	return (
		<PlateElement
			{...props}
			as="tr"
			className="border-border/60 border-b transition-colors hover:bg-muted/25"
		/>
	);
}

export function TableCellElement(props: PlateElementProps) {
	return (
		<PlateElement
			{...props}
			as="td"
			className="border border-border/60 px-3.5 py-2 align-top leading-relaxed"
		>
			{props.children}
		</PlateElement>
	);
}

export function TableCellHeaderElement(props: PlateElementProps) {
	return (
		<PlateElement
			{...props}
			as="th"
			className="border border-border/65 bg-muted/45 px-3.5 py-2 text-left align-top font-semibold text-foreground/90"
		>
			{props.children}
		</PlateElement>
	);
}
