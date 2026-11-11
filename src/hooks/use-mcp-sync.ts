/**
 * Bind the MCP server to the active local vault + Library folder scope,
 * and restore the settings toggle on launch.
 */

import { useEffect } from "react";
import {
	useLibraryStore,
	useSettings,
	useVaultStore,
} from "@/hooks/use-app-stores";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import {
	mcpSetEnabled,
	mcpSetKnownVaults,
	mcpSetParentDir,
	mcpSetVault,
} from "@/lib/mcp/status";
import { getVaultPath } from "@/lib/vault/store";

export function useMcpSync(): void {
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const recentVaults = useVaultStore((s) => s.recentVaults);
	const libraryScopePath = useLibraryStore((s) => s.scopePath);
	const mcpEnabled = useSettings((s) => s.mcpEnabled);

	useEffect(() => {
		if (!isTauri()) return;
		void mcpSetVault(vaultPath ?? null).catch((e) => {
			console.warn("[mcp] setVault failed", e);
		});
	}, [vaultPath]);

	useEffect(() => {
		if (!isTauri()) return;
		void mcpSetKnownVaults(recentVaults).catch((e) => {
			console.warn("[mcp] setKnownVaults failed", e);
		});
	}, [recentVaults]);

	useEffect(() => {
		if (!isTauri() || !mcpEnabled) return;
		const scope = libraryScopePath
			?.replace(/\\/g, "/")
			.replace(/^\/+|\/+$/g, "");
		const parent =
			scope && (scope === "papers" || scope.startsWith("papers/"))
				? scope
				: "papers";
		void mcpSetParentDir(parent).catch(() => {
			/* ignore */
		});
	}, [libraryScopePath, mcpEnabled]);

	useEffect(() => {
		if (!isTauri()) return;
		void mcpSetEnabled(mcpEnabled)
			.then(async (st) => {
				if (mcpEnabled && st.lastError) {
					notifyError(st.lastError);
				}
				const path = getVaultPath();
				if (mcpEnabled && path) {
					try {
						await mcpSetVault(path);
					} catch (e) {
						console.warn("[mcp] re-bind vault after enable failed", e);
					}
				}
			})
			.catch((e) => {
				notifyError(errorText(e));
			});
	}, [mcpEnabled]);
}
