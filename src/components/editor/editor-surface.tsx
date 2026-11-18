"use client";
import type { PlateContentProps } from "platejs/react";
import {
	PlateContainer,
	PlateContent,
	useComposedRef,
	useEditorContainerRef,
	useEditorRef,
} from "platejs/react";
import { type ComponentProps, type RefObject, useEffect } from "react";

import { markOnce } from "@/lib/core/perf";
import { cn } from "@/lib/core/utils";

const editorContainerClassName = cn(
	// Neutral selection (not brand blue) so selected text stays readable in light/dark.
	"relative h-full w-full cursor-text select-text overflow-y-auto caret-foreground selection:bg-foreground/15 focus-visible:outline-none",
	"[&_.slate-selection-area]:z-50 [&_.slate-selection-area]:border [&_.slate-selection-area]:border-foreground/20 [&_.slate-selection-area]:bg-foreground/10",
);

export function EditorContainer({
	className,
	ref,
	...props
}: ComponentProps<"div">) {
	const editor = useEditorRef();
	const plateContainerRef = useEditorContainerRef();
	const composedRef = useComposedRef(plateContainerRef, ref);
	useEffect(() => {
		plateContainerRef.current?.setAttribute("data-agentero-editor", "");
		markOnce("notes_editor_ready", { anchor: "open" });
	}, [plateContainerRef]);
	const containerProps: ComponentProps<"div"> = {
		...props,
		id: editor.meta.uid,
		ref: composedRef,
	};

	return (
		<PlateContainer
			className={cn(
				"ignore-click-outside/toolbar",
				editorContainerClassName,
				className,
			)}
			{...containerProps}
		/>
	);
}

const editorClassName = cn(
	"group/editor",
	"relative w-full cursor-text select-text overflow-x-hidden whitespace-break-spaces break-words leading-[1.72] text-foreground/92",
	"rounded-md ring-offset-background focus-visible:outline-none",
	"**:data-slate-placeholder:!top-1/2 **:data-slate-placeholder:-translate-y-1/2 placeholder:text-muted-foreground/75 **:data-slate-placeholder:text-muted-foreground/75 **:data-slate-placeholder:opacity-100!",
	"[&_strong]:font-semibold [&_strong]:text-foreground",
);

export const Editor = ({
	className,
	ref,
	...props
}: PlateContentProps & { ref?: RefObject<HTMLDivElement | null> }) => (
	<PlateContent
		ref={ref}
		className={cn(editorClassName, className)}
		disableDefaultStyles
		{...props}
	/>
);

Editor.displayName = "Editor";
