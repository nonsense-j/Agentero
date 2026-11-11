/**
 * Start the low-frequency config reminders (#658) in the main window.
 *
 * - `network-proxy`: event hook — this hook registers `reportNetworkFailure`
 *   with the global notify funnel, which fires it on a network-ish failure.
 *
 * Registering here (not in a module side effect) keeps it out of the separate
 * Settings / doc windows.
 */

import { useEffect } from "react";
import { setNetworkFailureReporter } from "@/lib/core/notify";
import { reportNetworkFailure } from "@/lib/settings/reminders";

export function useConfigReminders(): void {
	useEffect(() => {
		setNetworkFailureReporter(reportNetworkFailure);
		return () => setNetworkFailureReporter(null);
	}, []);
}
