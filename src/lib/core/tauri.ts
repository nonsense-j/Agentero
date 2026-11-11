/** True when running inside a Tauri webview (not plain browser). */
export function isTauri(): boolean {
	return (
		typeof window !== "undefined" &&
		("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
	);
}

/**
 * Best-effort desktop OS detection from the webview UA.
 * Mirrors the platform checks in `shortcuts.ts` / `reveal.ts`.
 */
export function getPlatformOS(): "macos" | "windows" | "linux" | "other" {
	if (typeof navigator === "undefined") return "other";
	const platform = navigator.platform ?? "";
	const ua = navigator.userAgent ?? "";
	if (/Mac|iPhone|iPad|iPod/.test(platform)) return "macos";
	if (/Win/.test(platform) || /Windows/.test(ua)) return "windows";
	if (/Linux|X11/.test(platform)) return "linux";
	return "other";
}

/**
 * True for WebKit webviews (macOS WKWebView, Linux WebKitGTK).
 *
 * Blink (WebView2 / Chrome / Edge) and Gecko both include an `AppleWebKit`
 * token in their UA, so the token alone is not enough: only treat a UA as
 * WebKit when it has no Chromium tokens. Used to gate rendering optimizations
 * whose cost/benefit differs by engine.
 */
export function isWebKitEngine(ua?: string): boolean {
	const userAgent =
		ua ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
	if (!/AppleWebKit/.test(userAgent)) return false;
	return !/(Chrome|Chromium|CriOS|Edg|OPR)\//.test(userAgent);
}

/**
 * macOS keeps native traffic lights via the Overlay title bar; other desktop
 * platforms use a frameless window with custom caption buttons.
 */
export function isMacOS(): boolean {
	return getPlatformOS() === "macos";
}

/** Windows desktop shell (user-PATH registry handling, terminal wording). */
export function isWindows(): boolean {
	return getPlatformOS() === "windows";
}
