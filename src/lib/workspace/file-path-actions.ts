/**
 * Path actions for the vault file tree and document tabs.
 * Reveal and terminal reject with a user-facing message so each surface can
 * present the failure inline or as a toast.
 */

import i18n from "@/i18n";
import { presentAgentComposer } from "@/lib/agent/composer-focus";
import { broadcastAgentAttachContext } from "@/lib/agent/context-attach";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { displayPath } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import { openInTerminal, revealInFileManager } from "@/lib/vault/reveal";

export function copyFilePath(path: string): void {
	void copyTextToClipboard(displayPath(path), {
		successMessage: i18n.t("sidebar:fileTree.copiedPath"),
		errorMessage: i18n.t("sidebar:fileTree.copyPathFailed"),
		successNotify: { duration: 2000 },
	});
}

export async function revealFilePath(path: string): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:fileTree.revealDesktopOnly"));
	}
	try {
		await revealInFileManager(path);
	} catch {
		throw new Error(i18n.t("sidebar:fileTree.revealFailed"));
	}
}

export async function openFilePathInTerminal(path: string): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:fileTree.openInTerminalDesktopOnly"));
	}
	try {
		await openInTerminal(path);
	} catch {
		throw new Error(i18n.t("sidebar:fileTree.openInTerminalFailed"));
	}
}

export function addFilePathToChat(path: string): void {
	broadcastAgentAttachContext([path]);
	presentAgentComposer();
}
