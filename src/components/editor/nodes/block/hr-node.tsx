"use client";

import {
	PlateElement,
	type PlateElementProps,
	useFocused,
	useReadOnly,
	useSelected,
} from "platejs/react";
import { cn } from "@/lib/core/utils";

export function HrElement(props: PlateElementProps) {
	const readOnly = useReadOnly();
	const selected = useSelected();
	const focused = useFocused();

	return (
		<PlateElement {...props}>
			<div className="py-4" contentEditable={false}>
				<hr
					className={cn(
						"h-px rounded-full border-none bg-border/75",
						selected && focused && "ring-2 ring-ring ring-offset-2",
						!readOnly && "cursor-pointer",
					)}
				/>
			</div>
			{props.children}
		</PlateElement>
	);
}
