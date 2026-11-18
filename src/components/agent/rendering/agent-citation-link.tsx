"use client";

import { ExternalLink } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { isValidElement, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
	citationLabelFromHref,
	isCitationStatusLabel,
	rewriteCitationHrefToPdf,
} from "@/lib/agent/citation-href";
import { cn } from "@/lib/core/utils";

type AgentCitationLinkProps = ComponentPropsWithoutRef<"a"> & {
	node?: {
		properties?: Record<string, unknown>;
	};
	children?: ReactNode;
	onOpenSource?: (source: string) => void;
};

function isHttpUrl(href: string): boolean {
	return /^https?:\/\//i.test(href);
}

function hrefFromProps(
	href: string | undefined,
	node: AgentCitationLinkProps["node"],
): string {
	if (href?.trim()) return href.trim();
	const fromNode = node?.properties?.href;
	return typeof fromNode === "string" ? fromNode.trim() : "";
}

/** Flatten simple React children to a label string when possible. */
function labelFromChildren(children: ReactNode): string {
	if (typeof children === "string" || typeof children === "number") {
		return String(children).trim();
	}
	if (Array.isArray(children)) {
		return children.map(labelFromChildren).filter(Boolean).join("").trim();
	}
	if (isValidElement<{ children?: ReactNode }>(children)) {
		return labelFromChildren(children.props.children);
	}
	return "";
}

export function AgentCitationLink({
	href,
	children,
	onOpenSource,
	className: _streamdownClassName,
	node,
	target: _target,
	rel: _rel,
	...props
}: AgentCitationLinkProps) {
	const { t } = useTranslation("aiElements");
	const rawHref = hrefFromProps(href, node);
	const incomplete = rawHref === "streamdown:incomplete-link";
	const resolvedHref = useMemo(() => {
		if (!rawHref || incomplete) return rawHref;
		return rewriteCitationHrefToPdf(rawHref);
	}, [rawHref, incomplete]);

	const handleClick = useCallback(
		(event: React.MouseEvent<HTMLAnchorElement>) => {
			event.preventDefault();
			if (!resolvedHref || incomplete) return;
			if (isHttpUrl(resolvedHref)) {
				void import("@tauri-apps/plugin-opener")
					.then(({ openUrl }) => openUrl(resolvedHref))
					.catch(() => {
						window.open(resolvedHref, "_blank", "noopener,noreferrer");
					});
				return;
			}
			onOpenSource?.(resolvedHref);
		},
		[resolvedHref, incomplete, onOpenSource],
	);

	const rawLabel = labelFromChildren(children);
	const label = useMemo(() => {
		if (rawLabel && !isCitationStatusLabel(rawLabel)) return rawLabel;
		if (resolvedHref && !incomplete) {
			return citationLabelFromHref(resolvedHref) || resolvedHref;
		}
		return rawLabel || t("sources.link");
	}, [rawLabel, resolvedHref, incomplete, t]);

	const isExternal = Boolean(resolvedHref && isHttpUrl(resolvedHref));

	// Every resolved agent link is a compact secondary pill (keeps paired
	// secondary/secondary-foreground contrast across tweakcn themes). Ignore
	// Streamdown's default `underline text-primary` className.
	const link = (
		<Button
			asChild
			variant="secondary"
			size="xs"
			className={cn(
				"mx-0.5 inline-flex h-[1.3rem] max-w-[13rem] items-center gap-1 rounded-md border border-border/60 px-1.5 py-0 align-baseline font-medium text-[0.75rem] leading-none no-underline shadow-[inset_0_0.5px_0_var(--magpie-edge)] hover:border-foreground/20",
				incomplete && "pointer-events-none cursor-default opacity-65",
			)}
		>
			<a
				href={incomplete ? undefined : resolvedHref || undefined}
				data-incomplete={incomplete || undefined}
				{...props}
				onClick={handleClick}
			>
				<span className="block min-w-0 truncate">{label}</span>
				{isExternal ? (
					<ExternalLink className="size-2.5 shrink-0 opacity-60" aria-hidden />
				) : null}
			</a>
		</Button>
	);
	if (!resolvedHref || incomplete) return link;
	return (
		<HoverCard openDelay={120} closeDelay={100}>
			<HoverCardTrigger asChild>{link}</HoverCardTrigger>
			<HoverCardContent className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-1 p-2.5">
				<span className="font-medium text-xs text-foreground">{label}</span>
				<a
					href={resolvedHref}
					onClick={handleClick}
					className="break-all font-mono text-[0.6875rem] text-muted-foreground transition-colors hover:text-foreground"
				>
					{resolvedHref}
				</a>
			</HoverCardContent>
		</HoverCard>
	);
}
