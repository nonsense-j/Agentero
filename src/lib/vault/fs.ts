import { readFile, readTextFile } from "@tauri-apps/plugin-fs";
import i18n from "@/i18n";
import { isTauri } from "@/lib/core/tauri";

export { isMarkdownPath, isTextOpenable } from "./path-kinds";

export async function readVaultFile(path: string): Promise<string> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.readDesktopOnly"));
	}

	return readTextFile(path);
}

/**
 * Read a Vault file into an owned byte array.
 *
 * No defensive copy: plugin-fs `readFile` already returns a `Uint8Array`
 * owning a fresh, exactly-sized ArrayBuffer per call. Duplicating it doubled
 * peak memory on large PDFs; callers that need a bare `ArrayBuffer` normalize
 * ownership themselves (see `localFileToArrayBuffer`).
 */
export async function readVaultBytes(path: string): Promise<Uint8Array> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.readDesktopOnly"));
	}

	return readFile(path);
}

/** Write text file (creates parent dirs when possible). */
export async function writeVaultFile(
	path: string,
	content: string,
): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}

	const { mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
	const parent = path.replace(/[\\/][^\\/]+$/, "");
	if (parent && parent !== path) {
		try {
			await mkdir(parent, { recursive: true });
		} catch {
			// Parent may already exist
		}
	}
	await writeTextFile(path, content);
}

/** Write binary file (creates parent dirs when possible). Used for Markdown `./assets/` images. */
export async function writeVaultBytes(
	path: string,
	bytes: Uint8Array,
): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}

	const { mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
	const parent = path.replace(/[\\/][^\\/]+$/, "");
	if (parent && parent !== path) {
		try {
			await mkdir(parent, { recursive: true });
		} catch {
			// Parent may already exist
		}
	}
	await writeFile(path, bytes);
}

/**
 * Split a vault-relative path into parent dir + basename.
 * Empty `rel` (vault root) returns null.
 */
export function splitVaultRel(
	rel: string,
): { parent: string; name: string } | null {
	const normalized = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!normalized) return null;
	const slash = normalized.lastIndexOf("/");
	if (slash === -1) return { parent: "", name: normalized };
	return {
		parent: normalized.slice(0, slash),
		name: normalized.slice(slash + 1),
	};
}

/** Whether a vault path exists. */
export async function vaultPathExists(path: string): Promise<boolean> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.readDesktopOnly"));
	}

	const { exists } = await import("@tauri-apps/plugin-fs");
	return exists(path);
}

/** Create a directory (and parents) under the vault. */
export async function createVaultDirectory(path: string): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}

	const { mkdir } = await import("@tauri-apps/plugin-fs");
	await mkdir(path, { recursive: true });
}

/**
 * Remove a file or directory under the vault.
 * Directories are removed recursively (including non-empty).
 */
export async function removeVaultPath(path: string): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}
	const trimmed = path.trim();
	if (!trimmed || trimmed.startsWith("agentero:")) {
		throw new Error(i18n.t("sidebar:fileTree.deleteInvalid"));
	}
	const { remove } = await import("@tauri-apps/plugin-fs");
	await remove(trimmed, { recursive: true });
}
