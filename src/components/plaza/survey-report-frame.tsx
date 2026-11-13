/**
 * In-app preview of a Paper Survey HTML report: a sandboxed `srcdoc` iframe
 * that grows to its content height so the report reads as one long card.
 *
 * Sandbox is `allow-same-origin` only — no `allow-scripts`, so nothing in the
 * agent-written HTML can execute. Same-origin access is used solely by this
 * component to measure the document height and to route link clicks
 * (`#ref-…` anchors scroll the outer pane, http(s) links open in the system
 * browser).
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { loadSurveyReportHtml } from "@/lib/plaza/survey-store";

const FRAME_SANDBOX = "allow-same-origin";
const MIN_HEIGHT_PX = 240;
/** Fail-safe against viewport-relative CSS (`100vh`) growing the frame forever. */
const MAX_HEIGHT_PX = 24_000;

/** Nearest scrollable ancestor (the run pane), used for `#anchor` jumps. */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
	let node = el?.parentElement ?? null;
	while (node) {
		const { overflowY } = getComputedStyle(node);
		if (overflowY === "auto" || overflowY === "scroll") return node;
		node = node.parentElement;
	}
	return null;
}

export function SurveyReportFrame({
	runId,
	title,
}: {
	runId: string;
	title: string;
}) {
	const { t } = useTranslation("sidebar");
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	const [html, setHtml] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const [height, setHeight] = useState(MIN_HEIGHT_PX);

	useEffect(() => {
		let cancelled = false;
		setHtml(null);
		setFailed(false);
		void loadSurveyReportHtml(runId)
			.then((text) => {
				if (!cancelled) setHtml(text);
			})
			.catch((err) => {
				if (cancelled) return;
				setFailed(true);
				notifyError(t("plaza.survey.reportLoadFailed"), {
					description: errorText(err),
				});
			});
		return () => {
			cancelled = true;
		};
	}, [runId, t]);

	useEffect(() => {
		const frame = frameRef.current;
		if (!frame || html === null) return;
		let observer: ResizeObserver | null = null;
		let detach: (() => void) | null = null;

		const onLoad = () => {
			const doc = frame.contentDocument;
			if (!doc?.documentElement) return;
			const measure = () => {
				const next = Math.min(
					MAX_HEIGHT_PX,
					Math.max(
						MIN_HEIGHT_PX,
						doc.documentElement.scrollHeight,
						doc.body?.scrollHeight ?? 0,
					),
				);
				setHeight((prev) => (Math.abs(prev - next) > 1 ? next : prev));
			};
			measure();
			observer?.disconnect();
			observer = new ResizeObserver(measure);
			observer.observe(doc.documentElement);
			if (doc.body) observer.observe(doc.body);

			const onClick = (event: MouseEvent) => {
				const anchor = (event.target as Element | null)?.closest?.("a[href]");
				if (!anchor) return;
				const href = anchor.getAttribute("href") ?? "";
				event.preventDefault();
				if (href.startsWith("#")) {
					const target = doc.getElementById(decodeURIComponent(href.slice(1)));
					const scroller = scrollParentOf(frame);
					if (!target || !scroller) return;
					const top =
						frame.getBoundingClientRect().top -
						scroller.getBoundingClientRect().top +
						scroller.scrollTop +
						target.getBoundingClientRect().top -
						16;
					const reduce = window.matchMedia(
						"(prefers-reduced-motion: reduce)",
					).matches;
					scroller.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
					return;
				}
				if (/^https?:\/\//i.test(href)) openExternalUrl(href);
			};
			doc.addEventListener("click", onClick);
			detach = () => doc.removeEventListener("click", onClick);
		};

		frame.addEventListener("load", onLoad);
		if (frame.contentDocument?.readyState === "complete") onLoad();
		return () => {
			frame.removeEventListener("load", onLoad);
			observer?.disconnect();
			detach?.();
		};
	}, [html]);

	if (failed) return null;

	if (html === null) {
		return (
			<div className="flex flex-col gap-3 p-6">
				<Skeleton className="h-6 w-2/3" />
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-4 w-11/12" />
				<Skeleton className="h-40 w-full" />
				<Skeleton className="h-4 w-4/5" />
			</div>
		);
	}

	return (
		<iframe
			ref={frameRef}
			title={title}
			sandbox={FRAME_SANDBOX}
			srcDoc={html}
			style={{ height }}
			className="block w-full border-0 bg-white"
		/>
	);
}
