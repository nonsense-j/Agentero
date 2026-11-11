import { getPlatformOS } from "@/lib/core/tauri";

const SCROLLING_CLASS = "scrolling";
const HIDE_DELAY_MS = 800;
const TIMEOUT_KEY = Symbol("agentero-scrollbar-timeout");
const AUTO_HIDE_TARGETS =
	".agentero-scroll, .agentero-scroll-both, .cm-scroller";

function handleScroll(event: Event) {
	const target = event.target;
	if (!(target instanceof Element)) return;

	if (!target.matches(AUTO_HIDE_TARGETS)) return;

	const classes = target.classList;
	classes.add(SCROLLING_CLASS);
	const previous = (target as HTMLElement & { [TIMEOUT_KEY]?: number })[
		TIMEOUT_KEY
	];
	if (previous) {
		window.clearTimeout(previous);
	}

	(target as HTMLElement & { [TIMEOUT_KEY]?: number })[TIMEOUT_KEY] =
		window.setTimeout(() => {
			classes.remove(SCROLLING_CLASS);
		}, HIDE_DELAY_MS);
}

export function initAutoHideScrollbars() {
	if (typeof document === "undefined") return;

	document.documentElement.toggleAttribute(
		"data-linux-scrollbars",
		getPlatformOS() === "linux",
	);

	document.addEventListener("scroll", handleScroll, {
		capture: true,
		passive: true,
	});
}
