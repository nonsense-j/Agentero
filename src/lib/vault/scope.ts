import { commands } from "@/lib/core/bindings";
import { isTauri } from "@/lib/core/tauri";

/** In-flight / completed fs-scope grants, keyed by normalized vault root. */
const fsScopeGrants = new Map<string, Promise<void>>();

/**
 * Grant the fs-plugin scope for a local vault root (idempotent, cached).
 *
 * The dialog plugin grants runtime scope for an interactively-picked folder,
 * but that grant is not persisted. On startup restore, a vault located outside
 * the static scope (`$HOME/**`, `$DOCUMENT/**`, …) fails every fs-plugin call
 * (`readDir` / `readTextFile` / `exists` …) with "forbidden path" until a dialog
 * re-grants it. Call before any fs-plugin read for a restored vault. Concurrent
 * callers share one grant; no-op off Tauri.
 */
export function ensureLocalFsScope(rootPath: string | null): Promise<void> {
	if (!isTauri() || !rootPath) {
		return Promise.resolve();
	}
	const key = rootPath.replace(/[\\/]+$/, "");
	let pending = fsScopeGrants.get(key);
	if (!pending) {
		pending = commands
			.vaultAllowFsScope(key)
			.then(() => undefined)
			.catch(() => {
				// Best-effort: the static scope may already cover it; the actual
				// read surfaces any genuine error. Drop the cache so a later call
				// can retry (e.g. after the command becomes available).
				fsScopeGrants.delete(key);
			});
		fsScopeGrants.set(key, pending);
	}
	return pending;
}
