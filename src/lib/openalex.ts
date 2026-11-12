/**
 * OpenAlex API key & probe helpers.
 *
 * `AppSettings.openAlexKey` stays masked (`****`) in UI state, while
 * `ensureOpenAlexRuntimeKeyLoaded()` resolves the plaintext key once per
 * settings change so Plaza's direct CORS OpenAlex batches can append
 * `api_key=` at 10 req/s / 100k daily credits.
 */

import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { isSecretMask } from "@/lib/core/secret-mask";
import { isTauri } from "@/lib/core/tauri";
import { subscribeSettings } from "@/lib/settings/store";

export const OPENALEX_KEY_URL = "https://openalex.org/settings/api";

export type OpenAlexProbeStatus = "idle" | "probing" | "ok" | "fail";

const OPENALEX_API_HOST_PREFIX = "https://api.openalex.org/";

let cachedRuntimeKey: string | null = null;
let runtimeKeyLoaded = false;
let runtimeKeyPromise: Promise<string | null> | null = null;
let subscribedToSettings = false;
let lastObservedSettingsMask: string | null = null;

function ensureSubscribed(): void {
	if (subscribedToSettings) return;
	subscribedToSettings = true;
	subscribeSettings((next) => {
		if (next.openAlexKey === lastObservedSettingsMask) return;
		lastObservedSettingsMask = next.openAlexKey;
		if (!next.openAlexKey.trim()) {
			cachedRuntimeKey = null;
			runtimeKeyLoaded = true;
			runtimeKeyPromise = null;
			return;
		}
		if (!isSecretMask(next.openAlexKey)) {
			cachedRuntimeKey = next.openAlexKey.trim();
			runtimeKeyLoaded = true;
			runtimeKeyPromise = null;
			return;
		}
		// Masked update from Host (`settings:changed` / `settings_set`): reload on next call.
		runtimeKeyLoaded = false;
		runtimeKeyPromise = null;
	});
}

/**
 * Resolve and cache the stored OpenAlex API key from the Host once per change.
 */
export async function ensureOpenAlexRuntimeKeyLoaded(): Promise<string | null> {
	ensureSubscribed();
	if (runtimeKeyLoaded) return cachedRuntimeKey;
	if (!isTauri()) {
		runtimeKeyLoaded = true;
		return cachedRuntimeKey;
	}
	if (runtimeKeyPromise) return runtimeKeyPromise;
	runtimeKeyPromise = (async () => {
		try {
			const key = await callApi(() => commands.openAlexKeyGet(), {
				fallback: "open_alex_key_get failed",
			});
			const trimmed = key?.trim() ?? "";
			cachedRuntimeKey = trimmed && !isSecretMask(trimmed) ? trimmed : null;
		} catch {
			cachedRuntimeKey = null;
		} finally {
			runtimeKeyLoaded = true;
			runtimeKeyPromise = null;
		}
		return cachedRuntimeKey;
	})();
	return runtimeKeyPromise;
}

/** Synchronous access to the cached OpenAlex API key (after `ensureOpenAlexRuntimeKeyLoaded`). */
export function getCachedOpenAlexApiKey(): string | null {
	return cachedRuntimeKey;
}

export function hasCachedOpenAlexApiKey(): boolean {
	return Boolean(cachedRuntimeKey);
}

/** Override or reset the in-memory OpenAlex API key in unit tests. */
export function setCachedOpenAlexApiKeyForTests(key: string | null): void {
	const trimmed = key?.trim() ?? "";
	cachedRuntimeKey = trimmed && !isSecretMask(trimmed) ? trimmed : null;
	runtimeKeyLoaded = true;
	runtimeKeyPromise = null;
}

/**
 * Append `api_key=` to `https://api.openalex.org/...` URLs when a key is active.
 * Idempotent when `api_key=` is already present.
 */
export function withOpenAlexApiKey(
	url: string,
	explicitKey: string | null = cachedRuntimeKey,
): string {
	if (!url.startsWith(OPENALEX_API_HOST_PREFIX) || url.includes("api_key=")) {
		return url;
	}
	const key = explicitKey?.trim();
	if (!key || isSecretMask(key)) return url;
	const hashIdx = url.indexOf("#");
	const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
	const frag = hashIdx >= 0 ? url.slice(hashIdx) : "";
	const sep = base.includes("?") ? "&" : "?";
	return `${base}${sep}api_key=${encodeURIComponent(key)}${frag}`;
}

/**
 * Probe an OpenAlex API key through the Host (respecting configured network proxy).
 * Pass `apiKey` to probe an unsaved/freshly entered plaintext key, or omit to
 * probe the durable key stored in `settings.json`.
 */
export async function probeOpenAlexKey(
	apiKey?: string | null,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!isTauri()) return false;
	const override =
		apiKey?.trim() && !isSecretMask(apiKey) ? apiKey.trim() : null;
	try {
		const ok = await callApi(() => commands.openAlexProbe(override), {
			fallback: "OpenAlex probe failed",
		});
		if (signal?.aborted) return false;
		return ok;
	} catch {
		return false;
	}
}
