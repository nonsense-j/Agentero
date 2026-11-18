"use client";

import type { TImageElement } from "platejs";
import {
	PlateElement,
	type PlateElementProps,
	useFocused,
	useSelected,
} from "platejs/react";
import { useEffect, useRef, useState } from "react";

import { useImageGroup } from "@/components/editor/context/image-group-context";
import { useMarkdownDoc } from "@/components/editor/context/markdown-doc-context";
import { useMarkdownExportMode } from "@/components/editor/markdown-export-mode-context";
import { useInView } from "@/hooks/use-in-view";
import { cn } from "@/lib/core/utils";
import {
	formatMarkdownImageSyntax,
	isRemoteOrInlineImageUrl,
	resolveMarkdownImageAbs,
} from "@/lib/markdown/image";
import {
	acquireImageSource,
	releaseImageSource,
} from "@/lib/markdown/image-source-cache";
import { imageMimeFromPath } from "@/lib/workspace/viewer";

export function ImageElement(props: PlateElementProps<TImageElement>) {
	const url = props.element.url ?? "";
	const alt = (props.element as { alt?: string }).alt ?? "";
	const { filePath } = useMarkdownDoc();
	const exportMode = useMarkdownExportMode();
	const imageGroup = useImageGroup();
	const selected = useSelected();
	const focused = useFocused();
	const active = selected && focused;
	const figureRef = useRef<HTMLElement | null>(null);
	const [src, setSrc] = useState<string>(() =>
		url && isRemoteOrInlineImageUrl(url) ? url : "",
	);
	const [failed, setFailed] = useState(false);
	// Export must paint every image; reading may defer offscreen ones.
	const inView = useInView(figureRef, { enabled: !exportMode });

	useEffect(() => {
		if (!inView) return;
		let cancelled = false;

		if (!url) {
			setSrc("");
			setFailed(false);
			return;
		}
		if (isRemoteOrInlineImageUrl(url)) {
			setSrc(url);
			setFailed(false);
			return;
		}
		const abs = filePath ? resolveMarkdownImageAbs(filePath, url) : null;
		if (!abs) {
			setSrc("");
			setFailed(true);
			return;
		}
		const mime = imageMimeFromPath(abs);
		setFailed(false);
		void acquireImageSource(abs, mime).then((resolved) => {
			if (cancelled) return;
			setSrc(resolved ?? "");
			setFailed(!resolved);
		});
		return () => {
			cancelled = true;
			releaseImageSource(abs, mime);
		};
	}, [inView, url, filePath]);

	const sourceText = formatMarkdownImageSyntax(alt, url);

	return (
		<PlateElement
			{...props}
			className={cn(imageGroup ? null : "py-2", active && "rounded-sm")}
			data-selected={active ? "true" : undefined}
		>
			{/*
			 * Keep the bitmap mounted when selected. Replacing it with source-only
			 * UI made cut/copy feel like editing text, unmounted the <img>, and
			 * conflicted with void-node selection. Show a selection ring + caption
			 * instead so the image stays visible.
			 */}
			<figure
				ref={figureRef}
				className="m-0"
				contentEditable={false}
				data-export-pending={url && !src && !failed ? "true" : undefined}
			>
				{src ? (
					<img
						src={src}
						alt={alt}
						className={cn(
							// 组内由 item 的 aspect-ratio 定形,图片铺满格子等高显示。
							imageGroup
								? "h-full w-full rounded-lg object-contain ring-1 ring-inset ring-black/8 dark:ring-white/10"
								: "max-w-full rounded-lg ring-1 ring-inset ring-black/8 dark:ring-white/10",
							active &&
								"ring-2 ring-default-ring ring-offset-2 ring-offset-background",
						)}
						loading={exportMode ? "eager" : "lazy"}
						decoding="async"
						draggable={false}
						onLoad={(event) => {
							const img = event.currentTarget;
							if (imageGroup && img.naturalWidth > 0 && img.naturalHeight > 0) {
								imageGroup.reportRatio(
									url,
									img.naturalWidth / img.naturalHeight,
								);
							}
						}}
						onError={() => setFailed(true)}
					/>
				) : failed && url ? (
					<div
						className={cn(
							"rounded-sm border border-dashed border-border px-3 py-6 text-center text-muted-foreground text-sm",
							active &&
								"ring-2 ring-default-ring ring-offset-2 ring-offset-background",
						)}
					>
						{url}
					</div>
				) : url ? (
					<div
						aria-hidden
						className="min-h-8 rounded-sm border border-dashed border-border/50 bg-muted/10"
					/>
				) : null}
				{active ? (
					<figcaption className="mt-1 break-all font-mono text-caption text-muted-foreground leading-snug">
						{sourceText}
					</figcaption>
				) : null}
			</figure>
			{props.children}
		</PlateElement>
	);
}
