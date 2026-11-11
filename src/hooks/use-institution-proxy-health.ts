import { useEffect } from "react";
import { useSettings } from "@/hooks/use-app-stores";
import i18n from "@/i18n";
import { commands } from "@/lib/core/bindings";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";

const CHECK_INTERVAL = 24 * 60 * 60 * 1000;

/** Check saved gateway credentials at most once a day while the app is open. */
export function useInstitutionProxyHealth(): void {
	const type = useSettings((s) => s.institutionProxyType);
	const prefix = useSettings((s) => s.institutionProxyPrefix);
	const cookie = useSettings((s) => s.institutionProxyCookie);

	useEffect(() => {
		if (!isTauri() || type === "direct" || !prefix || !cookie) return;
		let cancelled = false;
		let checking = false;
		const key = `institution-proxy-checked:${prefix}`;
		const check = async () => {
			if (
				checking ||
				Date.now() - Number(localStorage.getItem(key) || 0) < CHECK_INTERVAL
			)
				return;
			checking = true;
			localStorage.setItem(key, String(Date.now()));
			try {
				const result = await commands.institutionProxyProbe(null);
				if (
					!cancelled &&
					result.error?.code === "institution_proxy_auth_required"
				) {
					notifyError(
						i18n.t("settings:general.institutionProxy.cookieExpired"),
					);
				}
			} catch {
				// Network outages do not imply an expired login session.
			} finally {
				checking = false;
			}
		};
		const initial = window.setTimeout(() => void check(), 10_000);
		const interval = window.setInterval(() => void check(), 60 * 60 * 1000);
		return () => {
			cancelled = true;
			window.clearTimeout(initial);
			window.clearInterval(interval);
		};
	}, [type, prefix, cookie]);
}
