import type { SVGProps } from "react";
import { cn } from "@/lib/core/utils";

/**
 * Paper Collection icon — Magpie-inspired layered stack of curated documents
 * with a subtle top bookmark accent.
 */
export function PlazaCollectionIcon({
	className,
	...props
}: SVGProps<SVGSVGElement>) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden
			{...props}
		>
			<title>Paper Collection</title>
			<rect
				x="4"
				y="4"
				width="16"
				height="16"
				rx="3.5"
				fill="currentColor"
				fillOpacity="0.08"
			/>
			<path d="M8 4v6l2.5-1.75L13 10V4" />
			<path d="M8 14h8" />
			<path d="M8 17h5" />
		</svg>
	);
}

/**
 * Paper Discover icon — Magpie-inspired precision compass & radar lens for
 * multi-source scholarly discovery.
 */
export function PlazaDiscoverIcon({
	className,
	...props
}: SVGProps<SVGSVGElement>) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden
			{...props}
		>
			<title>Paper Discover</title>
			<circle cx="11" cy="11" r="7" fill="currentColor" fillOpacity="0.08" />
			<polygon
				points="13.8 8.2 12.1 12.1 8.2 13.8 9.9 9.9 13.8 8.2"
				fill="currentColor"
				fillOpacity="0.2"
			/>
			<path d="m16.2 16.2 3.8 3.8" />
		</svg>
	);
}

/**
 * Paper Recommend icon — Magpie-inspired telescope / spark pulse for
 * keyword-matched non-repeating recommendations.
 */
export function PlazaRecommendIcon({
	className,
	...props
}: SVGProps<SVGSVGElement>) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden
			{...props}
		>
			<title>Paper Recommend</title>
			<path
				d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"
				fill="currentColor"
				fillOpacity="0.12"
			/>
			<path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15z" />
			<path d="M5 16l.6 1.4L7 18l-1.4.6L5 20l-.6-1.4L3 18l1.4-.6L5 16z" />
		</svg>
	);
}

/**
 * CCF Deadline icon — Magpie-inspired calendar chronometer with crisp
 * countdown dial.
 */
export function PlazaDeadlineIcon({
	className,
	...props
}: SVGProps<SVGSVGElement>) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden
			{...props}
		>
			<title>CCF Deadline</title>
			<path d="M8 2v3" />
			<path d="M16 2v3" />
			<rect
				x="3"
				y="4"
				width="18"
				height="17"
				rx="3.5"
				fill="currentColor"
				fillOpacity="0.07"
			/>
			<path d="M3 9h18" />
			<circle cx="12" cy="15" r="3.2" />
			<path d="M12 13.5v1.6l1.1.8" />
		</svg>
	);
}

const PROVIDER_STYLES: Record<string, { label: string; tone: string }> = {
	arxiv: {
		label: "arXiv",
		tone: "text-[#b31b1b] dark:text-[#f87171] bg-[#b31b1b]/10",
	},
	venue: {
		label: "Venue",
		tone: "text-[#0284c7] dark:text-[#38bdf8] bg-[#0284c7]/10",
	},
	dblp: {
		label: "DBLP",
		tone: "text-[#0369a1] dark:text-[#7dd3fc] bg-[#0369a1]/10",
	},
	acm: {
		label: "ACM",
		tone: "text-[#0085ca] dark:text-[#38bdf8] bg-[#0085ca]/10",
	},
	usenix: {
		label: "USENIX",
		tone: "text-[#be123c] dark:text-[#fb7185] bg-[#be123c]/10",
	},
	openreview: {
		label: "OpenReview",
		tone: "text-[#8c1b13] dark:text-[#fca5a5] bg-[#8c1b13]/10",
	},
	iacr: {
		label: "IACR",
		tone: "text-[#4f46e5] dark:text-[#a5b4fc] bg-[#4f46e5]/10",
	},
	s2: {
		label: "S2",
		tone: "text-[#ca8a04] dark:text-[#facc15] bg-[#ca8a04]/10",
	},
	openalex: {
		label: "OpenAlex",
		tone: "text-[#059669] dark:text-[#34d399] bg-[#059669]/10",
	},
};

/**
 * Sleek Magpie-style source pill badge for arXiv, Venue (ASE, ICSE, FSE,
 * ISSTA, PLDI, TOSEM, TSE), DBLP, ACM, USENIX, OpenReview, IACR, S2, OpenAlex.
 */
export function PlazaSourceBadge({
	source,
	label,
	className,
}: {
	source: string;
	label?: string;
	className?: string;
}) {
	const key = source.toLowerCase();
	const cfg = PROVIDER_STYLES[key] ?? {
		label: label || source,
		tone: "text-muted-foreground bg-foreground/8",
	};
	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 font-medium font-mono text-[10px] tracking-tight shadow-[inset_0_0.5px_0_var(--magpie-edge),0_0_0_0.5px_var(--magpie-hairline)]",
				cfg.tone,
				className,
			)}
		>
			<span
				className="size-1.5 rounded-full bg-current opacity-80"
				aria-hidden
			/>
			{label || cfg.label}
		</span>
	);
}
