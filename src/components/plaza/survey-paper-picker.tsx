/**
 * Paper Survey seed picker: searchable, virtualized multi-select over the
 * vault Library (`libraryStore`), with the current selection as removable
 * chips. Papers are identified by their vault-relative folder `path`.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/components/ui/input-group";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLibraryStore, useVaultStore } from "@/hooks/use-app-stores";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import type { PaperLibraryRow } from "@/lib/paper/types";
import { ensureSurveyLibraryLoaded } from "@/lib/plaza/survey-store";

function firstAuthor(row: PaperLibraryRow, etAl: string): string {
	const [first, ...rest] = row.authors;
	if (!first) return "";
	return rest.length > 0 ? `${first} ${etAl}` : first;
}

function matches(row: PaperLibraryRow, needle: string): boolean {
	if (!needle) return true;
	const hay = [
		row.title,
		row.authors.join(" "),
		row.year ? String(row.year) : "",
		row.publication ?? "",
	]
		.join(" ")
		.toLowerCase();
	return needle
		.split(/\s+/)
		.filter(Boolean)
		.every((part) => hay.includes(part));
}

export function SurveyPaperPicker({
	selected,
	onChange,
	disabled,
	className,
}: {
	selected: readonly string[];
	onChange: (paths: string[]) => void;
	disabled?: boolean;
	className?: string;
}) {
	const { t } = useTranslation("sidebar");
	const papers = useLibraryStore((s) => s.papers);
	const loading = useLibraryStore((s) => s.loading);
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const [query, setQuery] = useState("");
	const idPrefix = useId();
	const listRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!vaultPath) return;
		void ensureSurveyLibraryLoaded().catch((err) =>
			notifyError(errorText(err)),
		);
	}, [vaultPath]);

	const selectedSet = useMemo(() => new Set(selected), [selected]);
	const byPath = useMemo(() => {
		const map = new Map<string, PaperLibraryRow>();
		for (const p of papers) map.set(p.path, p);
		return map;
	}, [papers]);

	const needle = query.trim().toLowerCase();
	const filtered = useMemo(
		() => papers.filter((p) => p.title && matches(p, needle)),
		[papers, needle],
	);

	const virtualizer = useVirtualizer({
		count: filtered.length,
		getScrollElement: () => listRef.current,
		estimateSize: () => 52,
		overscan: 8,
	});

	const toggle = (path: string) => {
		if (disabled) return;
		onChange(
			selectedSet.has(path)
				? selected.filter((p) => p !== path)
				: [...selected, path],
		);
	};

	const chips = selected
		.map((path) => byPath.get(path))
		.filter((p): p is PaperLibraryRow => Boolean(p));

	const etAl = t("plaza.survey.etAl");

	return (
		<div className={cn("flex min-h-[10rem] flex-1 flex-col gap-2", className)}>
			<div className="flex h-6 items-center justify-between gap-2">
				<span className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
					{t("plaza.survey.papers")}
					{selected.length > 0 ? (
						<span className="rounded-full bg-brand/15 px-1.5 font-mono text-[0.6875rem] text-brand tabular-nums leading-tight">
							{selected.length}
						</span>
					) : null}
				</span>
				{selected.length > 0 ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								disabled={disabled}
								onClick={() => onChange([])}
								aria-label={t("plaza.survey.clearSelection")}
								className="text-muted-foreground"
							>
								<X className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{t("plaza.survey.clearSelection")}
						</TooltipContent>
					</Tooltip>
				) : null}
			</div>

			{chips.length > 0 ? (
				<div className="agentero-scroll flex max-h-[5.25rem] flex-wrap gap-1 overflow-y-auto">
					{chips.map((p) => (
						<span
							key={p.path}
							className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border bg-background pr-0.5 pl-2 text-[0.6875rem] text-foreground"
						>
							<span className="max-w-[12rem] truncate">{p.title}</span>
							<button
								type="button"
								disabled={disabled}
								onClick={() => toggle(p.path)}
								aria-label={t("plaza.survey.removePaper")}
								className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
							>
								<X className="size-3" />
							</button>
						</span>
					))}
				</div>
			) : null}

			<InputGroup className="h-8 shrink-0">
				<InputGroupAddon align="inline-start">
					<Search className="size-3.5" />
				</InputGroupAddon>
				<InputGroupInput
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder={t("plaza.survey.searchPapers")}
					disabled={!vaultPath}
					className="text-xs"
				/>
				{query ? (
					<InputGroupAddon align="inline-end">
						<InputGroupButton
							size="icon-xs"
							onClick={() => setQuery("")}
							aria-label={t("plaza.collection.clearSearch")}
							className="text-muted-foreground hover:text-foreground"
						>
							<X className="size-3" />
						</InputGroupButton>
					</InputGroupAddon>
				) : null}
			</InputGroup>

			<div className="relative min-h-[6rem] flex-1 overflow-hidden rounded-xl border bg-background/60">
				{!vaultPath ? (
					<p className="flex h-full items-center justify-center px-6 text-center text-muted-foreground text-xs leading-relaxed">
						{t("plaza.survey.noVault")}
					</p>
				) : loading && papers.length === 0 ? (
					<div className="flex h-full items-center justify-center">
						<Loader2 className="size-4 animate-spin text-muted-foreground" />
					</div>
				) : filtered.length === 0 ? (
					<p className="flex h-full items-center justify-center px-6 text-center text-muted-foreground text-xs leading-relaxed">
						{papers.length === 0
							? t("plaza.survey.libraryEmpty")
							: t("plaza.survey.noMatch")}
					</p>
				) : (
					<div
						ref={listRef}
						className="agentero-scroll absolute inset-0 overflow-y-auto p-1"
					>
						<div
							className="relative w-full"
							style={{ height: virtualizer.getTotalSize() }}
						>
							{virtualizer.getVirtualItems().map((item) => {
								const row = filtered[item.index];
								const checked = selectedSet.has(row.path);
								const meta = [firstAuthor(row, etAl), row.year, row.publication]
									.filter(Boolean)
									.join(" · ");
								return (
									<div
										key={row.path}
										data-index={item.index}
										ref={virtualizer.measureElement}
										className="absolute top-0 left-0 w-full pb-0.5"
										style={{ transform: `translateY(${item.start}px)` }}
									>
										<label
											htmlFor={`${idPrefix}-${item.index}`}
											className={cn(
												"flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors",
												checked ? "bg-brand/8" : "hover:bg-muted/60",
												disabled && "cursor-default opacity-60",
											)}
										>
											<Checkbox
												id={`${idPrefix}-${item.index}`}
												checked={checked}
												disabled={disabled}
												onCheckedChange={() => toggle(row.path)}
												className="mt-0.5"
											/>
											<span className="min-w-0 flex-1">
												<span className="line-clamp-2 text-foreground text-xs leading-snug">
													{row.title}
												</span>
												{meta ? (
													<span className="mt-0.5 block truncate text-[0.6875rem] text-muted-foreground tabular-nums">
														{meta}
													</span>
												) : null}
											</span>
										</label>
									</div>
								);
							})}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
