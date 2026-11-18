"use client";

import { Copy, Download, Maximize2, Minimize2 } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
	extractTableDataFromElement,
	tableDataToCSV,
	tableDataToMarkdown,
	tableDataToTSV,
} from "streamdown";
import { downloadText } from "@/components/agent/rendering/plain-code-block";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { cn } from "@/lib/core/utils";

type PlainTableProps = ComponentPropsWithoutRef<"table"> & {
	node?: unknown;
};

export function PlainTable({
	children,
	className,
	node: _node,
	...props
}: PlainTableProps) {
	const { t } = useTranslation("aiElements");
	const tableRef = useRef<HTMLTableElement>(null);
	const fullscreenTableRef = useRef<HTMLTableElement>(null);
	const [fullscreen, setFullscreen] = useState(false);

	const getData = useCallback(() => {
		const table = fullscreen ? fullscreenTableRef.current : tableRef.current;
		if (!table) return null;
		try {
			return extractTableDataFromElement(table);
		} catch {
			return null;
		}
	}, [fullscreen]);

	const handleCopy = useCallback(
		(format: "csv" | "tsv" | "md") => {
			const data = getData();
			if (!data) return;
			const text =
				format === "csv"
					? tableDataToCSV(data)
					: format === "tsv"
						? tableDataToTSV(data)
						: tableDataToMarkdown(data);
			void copyTextToClipboard(text, {
				successMessage: t("table.copy"),
			});
		},
		[getData, t],
	);

	const handleDownload = useCallback(
		(format: "csv" | "markdown") => {
			const data = getData();
			if (!data) return;
			const text =
				format === "csv" ? tableDataToCSV(data) : tableDataToMarkdown(data);
			downloadText(`table.${format === "csv" ? "csv" : "md"}`, text);
		},
		[getData],
	);

	useEffect(() => {
		if (!fullscreen) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setFullscreen(false);
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [fullscreen]);

	const handleFullscreen = useCallback(() => {
		setFullscreen((value) => !value);
	}, []);

	const iconButtonClass =
		"size-6 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100";
	const tableClassName = cn(
		"w-full border-collapse caption-bottom text-[0.8125rem]",
		"[&_thead]:bg-muted/55 [&_thead_tr]:border-b [&_thead_tr]:border-border/65",
		"[&_th]:px-3.5 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:tracking-wide [&_th]:text-foreground/85",
		"[&_tbody]:divide-y [&_tbody]:divide-border/45 [&_tbody_tr]:transition-colors hover:[&_tbody_tr]:bg-muted/30",
		"[&_td]:px-3.5 [&_td]:py-2 [&_td]:align-top [&_td]:text-[0.8125rem] [&_td]:leading-relaxed",
		className,
	);

	const actionButtons = (
		<TooltipProvider>
			<DropdownMenu>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className={iconButtonClass}
								aria-label={t("table.copy")}
							>
								<Copy className="size-4" />
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent>
						<p>{t("table.copy")}</p>
					</TooltipContent>
				</Tooltip>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => handleCopy("md")}>
						{t("table.copyAsMarkdown")}
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => handleCopy("csv")}>
						{t("table.copyAsCsv")}
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => handleCopy("tsv")}>
						{t("table.copyAsTsv")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<DropdownMenu>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className={iconButtonClass}
								aria-label={t("table.download")}
							>
								<Download className="size-4" />
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent>
						<p>{t("table.download")}</p>
					</TooltipContent>
				</Tooltip>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => handleDownload("csv")}>
						{t("table.downloadAsCsv")}
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => handleDownload("markdown")}>
						{t("table.downloadAsMarkdown")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className={iconButtonClass}
						aria-label={
							fullscreen ? t("table.exitFullscreen") : t("table.viewFullscreen")
						}
						onClick={handleFullscreen}
					>
						{fullscreen ? (
							<Minimize2 className="size-4" />
						) : (
							<Maximize2 className="size-4" />
						)}
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					<p>
						{fullscreen ? t("table.exitFullscreen") : t("table.viewFullscreen")}
					</p>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);

	return (
		<>
			<div className="group/table relative my-3.5 overflow-hidden rounded-xl border border-border/65 bg-card/55 shadow-[0_1px_2px_rgba(0,0,0,0.02)] dark:bg-muted/15">
				<div className="agentero-scroll-both agentero-scroll-x-only overflow-x-auto">
					<table ref={tableRef} className={tableClassName} {...props}>
						{children}
					</table>
				</div>

				<div
					className={cn(
						"absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-lg border border-border/60 bg-popover/90 p-0.5 shadow-raised backdrop-blur-md",
						"opacity-0 transition-opacity duration-150 group-hover/table:opacity-100",
						"focus-within:opacity-100",
					)}
				>
					{actionButtons}
				</div>
			</div>

			{fullscreen && typeof document !== "undefined"
				? createPortal(
						<div
							className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
							role="dialog"
							aria-modal="true"
							aria-label={t("table.viewFullscreen")}
							data-agentero-table-fullscreen
						>
							<div className="flex h-12 shrink-0 items-center justify-end border-border border-b px-4">
								{actionButtons}
							</div>
							<div className="min-h-0 flex-1 overflow-auto p-6 [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-muted">
								<table
									ref={fullscreenTableRef}
									className={tableClassName}
									{...props}
								>
									{children}
								</table>
							</div>
						</div>,
						document.body,
					)
				: null}
		</>
	);
}
