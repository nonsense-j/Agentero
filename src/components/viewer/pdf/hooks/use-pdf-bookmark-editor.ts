import type { PdfBookmarkObject } from "@embedpdf/models";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApi } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { notifyError } from "@/lib/core/notify";
import { findLocalPdfPath } from "@/lib/paper/media";
import { noteBookmarkWrite } from "@/lib/pdf/bookmark-echo";
import {
	type EditableBookmark,
	editableBookmarks,
} from "@/lib/pdf/bookmark-edit";

type Draft = {
	nodes: EditableBookmark[];
	/** Bytes the next save must hash. After a successful write these are the file just written. */
	bytes: ArrayBuffer;
	/** Viewer buffer this draft was opened against. A new buffer means the file was reloaded. */
	source: ArrayBuffer;
	saving: boolean;
	failed?: boolean;
};
// Keep unsaved drafts across the viewer LRU, external reloads and closing /
// reopening a tab. A successful write keeps the draft so the outline stays
// put, but swaps in the written bytes for the next hash.
const drafts = createStore<Record<string, Draft>>(() => ({}));
function discard(path: string) {
	drafts.setState((state) => {
		const next = { ...state };
		delete next[path];
		return next;
	}, true);
}
function buildPdf(
	bytes: ArrayBuffer,
	nodes: EditableBookmark[],
): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(
			new URL("../../../../lib/pdf/bookmark-write.worker.ts", import.meta.url),
			{ type: "module" },
		);
		worker.onmessage = (
			event: MessageEvent<{ bytes?: Uint8Array; error?: string }>,
		) => {
			worker.terminate();
			if (event.data.bytes) resolve(event.data.bytes);
			else reject(new Error(event.data.error ?? "failed"));
		};
		worker.onerror = () => {
			worker.terminate();
			reject(new Error("failed"));
		};
		const copy = bytes.slice(0);
		worker.postMessage({ bytes: copy, nodes }, [copy]);
	});
}
function base64(bytes: Uint8Array): string {
	const chunks: string[] = [];
	for (let i = 0; i < bytes.length; i += 8192)
		chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
	return btoa(chunks.join(""));
}

export function usePdfBookmarkEditor({
	path,
	bytes,
	outline,
	ready,
}: {
	path: string | null;
	bytes: ArrayBuffer | null;
	outline: PdfBookmarkObject[];
	ready: boolean;
}) {
	const { t } = useTranslation("viewer");
	const draft = useStore(drafts, (state) => (path ? state[path] : undefined));
	const available = Boolean(
		path && bytes && ready && !/^(https?:|agentero:)/i.test(path),
	);
	const [markers, setMarkers] = useState<{
		bytes: ArrayBuffer;
		origins: string[];
	} | null>(null);
	useEffect(() => {
		if (!available || !bytes) return;
		const worker = new Worker(
			new URL("../../../../lib/pdf/bookmark-write.worker.ts", import.meta.url),
			{ type: "module" },
		);
		worker.onmessage = (event: MessageEvent<{ origins?: string[] }>) => {
			setMarkers({ bytes, origins: event.data.origins ?? [] });
			worker.terminate();
		};
		worker.onerror = () => {
			setMarkers({ bytes, origins: [] });
			worker.terminate();
		};
		const copy = bytes.slice(0);
		worker.postMessage({ bytes: copy }, [copy]);
		return () => worker.terminate();
	}, [available, bytes]);
	const initialNodes = useMemo(() => {
		const origins = new Set(markers?.bytes === bytes ? markers.origins : []);
		const visit = (nodes: EditableBookmark[]): EditableBookmark[] =>
			nodes.map((node) => ({
				...node,
				pageBookmark: origins.has(node.origin ?? ""),
				children: visit(node.children),
			}));
		return visit(editableBookmarks(outline));
	}, [outline, markers, bytes]);
	const canEdit = available && (Boolean(draft) || markers?.bytes === bytes);
	const nodes = draft?.nodes ?? initialNodes;
	useEffect(() => {
		if (!path || !bytes) return;
		const current = drafts.getState()[path];
		// A failed edit still belongs to the user. A saved outline should follow
		// a real reload of the file instead of shadowing it.
		if (
			current &&
			!current.failed &&
			!current.saving &&
			current.source !== bytes
		)
			discard(path);
	}, [path, bytes]);
	const begin = useCallback(() => {
		if (!path || !bytes || !canEdit || drafts.getState()[path]) return;
		drafts.setState({
			[path]: {
				nodes: initialNodes,
				bytes: bytes.slice(0),
				source: bytes,
				saving: false,
			},
		});
	}, [path, bytes, canEdit, initialNodes]);
	const save = useCallback(async () => {
		if (!path) return;
		const current = drafts.getState()[path];
		if (!current || current.saving) return;
		drafts.setState({ [path]: { ...current, saving: true, failed: false } });
		try {
			// A paper tab is keyed by the paper directory. The bytes belong to
			// the PDF inside it; writing the directory is rejected as invalid.
			const filePath = /\.pdf$/i.test(path)
				? path
				: await findLocalPdfPath(path);
			if (!filePath) throw new Error("invalid");
			const hash = Array.from(
				new Uint8Array(await crypto.subtle.digest("SHA-256", current.bytes)),
				(byte) => byte.toString(16).padStart(2, "0"),
			).join("");
			const saved = await buildPdf(current.bytes, current.nodes);
			noteBookmarkWrite(filePath);
			await callApi(() =>
				commands.pdfSaveBookmarks(filePath, hash, base64(saved)),
			);
			// Keep the open document mounted. Swapping pdfBytes mints a new
			// EmbedPDF id and reloads the page, which flashes the viewer.
			drafts.setState({
				[path]: {
					nodes: current.nodes,
					bytes: saved.buffer.slice(
						saved.byteOffset,
						saved.byteOffset + saved.byteLength,
					) as ArrayBuffer,
					source: current.source,
					saving: false,
				},
			});
		} catch (error) {
			drafts.setState({ [path]: { ...current, saving: false, failed: true } });
			const code = errorText(error);
			logger.warn("pdf: bookmark save failed", { path, error: code });
			const key =
				code === "conflict"
					? "conflict"
					: code === "protected"
						? "protected"
						: code === "unsupported"
							? "unsupported"
							: "failed";
			notifyError(t(`pdf.bookmarks.${key}`), {
				action: {
					label: t("pdf.bookmarks.discard"),
					onClick: () => {
						if (!drafts.getState()[path]?.saving) discard(path);
					},
				},
			});
		}
	}, [path, t]);
	const change = useCallback(
		(nodes: EditableBookmark[]) => {
			if (!path || !canEdit) return;
			begin();
			const current = drafts.getState()[path];
			if (!current || current.saving) return;
			drafts.setState({ [path]: { ...current, nodes } });
			void save();
		},
		[path, canEdit, begin, save],
	);
	return { draft, nodes, canEdit, begin, change, save };
}
export type PdfBookmarkEditor = ReturnType<typeof usePdfBookmarkEditor>;
