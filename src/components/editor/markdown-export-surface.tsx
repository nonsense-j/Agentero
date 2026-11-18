"use client";

import { ImagePlugin } from "@platejs/media/react";
import { Plate, usePlateEditor } from "platejs/react";
import { useEffect, useMemo, useRef } from "react";
import { MarkdownDocProvider } from "@/components/editor/context/markdown-doc-context";
import { Editor } from "@/components/editor/editor-surface";
import { EmbeddedMarkdownProjection } from "@/components/editor/embeds/embedded-markdown-projection";
import { WikiEmbedProjectionProvider } from "@/components/editor/embeds/projection-context";
import {
	type MarkdownExportMode,
	MarkdownExportModeProvider,
} from "@/components/editor/markdown-export-mode-context";
import { ImageElement } from "@/components/editor/nodes/block/image-node";
import { MarkdownEditorKit } from "@/components/editor/plugins/markdown-editor-kit";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";
import type { MarkdownExportSurfaceProps } from "@/lib/markdown/export/types";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";

export function MarkdownExportSurface({
	markdown,
	filePath,
	expandEmbeds,
	paperHeader,
	onMounted,
}: MarkdownExportSurfaceProps) {
	const surfaceRef = useRef<HTMLDivElement | null>(null);
	const exportMode = useMemo<MarkdownExportMode>(
		() => ({
			expandEmbeds,
			hideChromeActions: true,
		}),
		[expandEmbeds],
	);

	const plugins = useMemo(
		() => [...MarkdownEditorKit, ImagePlugin.withComponent(ImageElement)],
		[],
	);
	const editor = usePlateEditor({
		plugins,
		value: (currentEditor) => {
			const { body } = splitFrontmatter(markdown);
			return deserializeMarkdownBody(currentEditor, body);
		},
	});

	useEffect(() => {
		const el = surfaceRef.current;
		if (el) onMounted(el);
	}, [onMounted]);

	return (
		<div
			ref={surfaceRef}
			data-markdown-export-surface=""
			className="bg-background text-foreground"
			style={{ width: 800, boxSizing: "border-box" }}
		>
			{/*
			  Outer surface is edge-to-edge (page bg fills PDF; no white letterbox).
			  Inner inset mirrors the live editor `default` variant horizontal padding
			  (`px-16` / 64px) and top (`pt-4`); bottom uses a modest export tail instead
			  of editor `pb-72` (that gap is only for scroll room while typing).
			*/}
			<div className="px-16 pt-4 pb-10">
				{paperHeader ? (
					<header className="mb-6 border-border border-b pb-4">
						<h1 className="font-semibold text-xl leading-snug tracking-tight">
							{paperHeader.title}
						</h1>
						{(paperHeader.authorsLine || paperHeader.year != null) && (
							<p className="mt-2 text-muted-foreground text-sm leading-relaxed">
								{[
									paperHeader.authorsLine,
									paperHeader.year != null ? String(paperHeader.year) : null,
								]
									.filter(Boolean)
									.join(" · ")}
							</p>
						)}
						{paperHeader.link ? (
							<p className="mt-1.5 text-brand text-sm">
								<a
									href={paperHeader.link}
									className="underline decoration-brand/35 underline-offset-[3px]"
								>
									{paperHeader.linkLabel || paperHeader.link}
								</a>
							</p>
						) : null}
					</header>
				) : null}

				<MarkdownExportModeProvider value={exportMode}>
					<WikiEmbedProjectionProvider component={EmbeddedMarkdownProjection}>
						<MarkdownDocProvider value={{ filePath }}>
							<Plate editor={editor}>
								<Editor
									readOnly
									className="min-h-0 w-full min-w-0 cursor-default break-words text-[0.9375rem] leading-[1.72] tracking-normal [&>*:first-child]:mt-0"
								/>
							</Plate>
						</MarkdownDocProvider>
					</WikiEmbedProjectionProvider>
				</MarkdownExportModeProvider>
			</div>
		</div>
	);
}
