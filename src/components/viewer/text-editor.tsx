import {
	Compartment,
	EditorState,
	type Extension,
	type Text,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTextEditorFontSize } from "@/components/viewer/hooks/use-text-editor-font-size";
import { textLanguageExtensions } from "@/components/viewer/text-editor-language";
import {
	editorChrome,
	editorColorScheme,
	editorHighlight,
} from "@/components/viewer/text-editor-theme";
import { TextEditorToolbar } from "@/components/viewer/text-editor-toolbar";
import { useTextEditorSelection } from "@/components/viewer/use-text-editor-selection";
import { registerTextEditorFlusher } from "@/lib/workspace/text-editor-flush";

interface TextEditorProps {
	seed: string;
	path: string;
	reloadKey: number;
	onPersist: (
		path: string,
		content: string,
		lastSaved: string,
	) => Promise<boolean>;
	onDirtyChange: (dirty: boolean) => void;
	/** Whether the owning tab is the active panel — gates the selection toolbar. */
	active?: boolean;
	className?: string;
}

const AUTOSAVE_DELAY_MS = 800;

/**
 * Plain-text / code editor (CodeMirror 6) for the `text` fallback mode.
 * Same lifecycle contract as ExcalidrawViewer: React props seed the document
 * and signal external reloads (`reloadKey`); live content, dirty state and
 * debounced autosave are owned here and flow out via callbacks. Unlike the
 * Excalidraw viewer a reload swaps the document in place — view, scroll and
 * undo history are not thrown away.
 */
export function TextEditor({
	seed,
	path,
	reloadKey,
	onPersist,
	onDirtyChange,
	active = true,
	className,
}: TextEditorProps) {
	// Font size managed by hook with process-wide persistence (like PDF paper tone).
	const { fontSize, setFontSize } = useTextEditorFontSize();

	// Follow the app theme (system / light / dark preference via next-themes).
	const { resolvedTheme } = useTheme();
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const themeCompartment = useRef(new Compartment());
	const languageCompartment = useRef(new Compartment());
	const fontSizeCompartment = useRef(new Compartment());
	const lastSavedRef = useRef(seed);
	// PERF: pending edits are kept as the CodeMirror `Text` doc (a persistent
	// structure shared with the editor, zero-copy) — the string is
	// materialized once inside the debounced flush, not per keystroke.
	const pendingContentRef = useRef<Text | null>(null);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const dirtyRef = useRef(false);

	// Latest seed for the reload effect without re-mounting the editor.
	const seedRef = useRef(seed);
	seedRef.current = seed;
	// Initial language/theme are read at mount; later changes go through the
	// reconfigure effects below (mounting must stay once-per-tab).
	const pathRef = useRef(path);
	pathRef.current = path;
	const themeRef = useRef(resolvedTheme);
	themeRef.current = resolvedTheme;
	const fontSizeRef = useRef(fontSize);
	fontSizeRef.current = fontSize;

	// Keep callbacks stable across parent re-renders (doc-view passes inline
	// arrows for `onDirtyChange`).
	const onDirtyChangeRef = useRef(onDirtyChange);
	onDirtyChangeRef.current = onDirtyChange;

	// True when disk is current after the flush (nothing pending, or the save
	// landed); false when the save was refused (conflict guard / write error).
	const flush = useCallback(async (): Promise<boolean> => {
		const doc = pendingContentRef.current;
		if (doc == null) return true;
		pendingContentRef.current = null;
		const content = doc.toString();
		const ok = await onPersist(path, content, lastSavedRef.current);
		if (ok) {
			lastSavedRef.current = content;
			dirtyRef.current = false;
			onDirtyChangeRef.current(false);
		}
		return ok;
	}, [onPersist, path]);

	const schedulePersist = useCallback(
		(doc: Text) => {
			pendingContentRef.current = doc;
			if (debounceRef.current) clearTimeout(debounceRef.current);
			debounceRef.current = setTimeout(() => {
				debounceRef.current = null;
				void flush();
			}, AUTOSAVE_DELAY_MS);
		},
		[flush],
	);

	// The update listener is registered once at mount; route it through a ref
	// so a path change (rename) keeps saving to the current file.
	const schedulePersistRef = useRef(schedulePersist);
	schedulePersistRef.current = schedulePersist;

	// Manual save (⌘S / Ctrl+S) rides the CodeMirror keymap (only when the
	// editor is focused, same as its other bindings): flush immediately,
	// skipping the debounce. Routed through refs since the keymap registers
	// once at mount.
	const flushRef = useRef(flush);
	flushRef.current = flush;
	const manualSaveKeymap = useMemo(
		() => [
			{
				key: "Mod-s",
				preventDefault: true,
				run: () => {
					void flushRef.current();
					return true;
				},
			},
		],
		[],
	);

	// Selection → floating Quick chat / Add to chat toolbar (same chrome the
	// PDF surfaces have). The listener extension registers once at mount and
	// routes through refs inside the hook.
	const selection = useTextEditorSelection({
		viewRef,
		path,
		active,
	});

	// Expose the flush to lib actions that read disk bytes directly.
	useEffect(() => registerTextEditorFlusher(path, flush), [path, flush]);

	// Editor owns its state: mount once, reconfigure language/theme in place.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const language = textLanguageExtensions(pathRef.current);
		const extensions: Extension[] = [
			basicSetup,
			EditorView.lineWrapping,
			keymap.of(manualSaveKeymap),
			selection.selectionListener,
			languageCompartment.current.of(language),
			editorChrome,
			editorHighlight,
			themeCompartment.current.of(
				editorColorScheme(themeRef.current === "dark"),
			),
			fontSizeCompartment.current.of(
				EditorView.theme({ "&": { fontSize: `${fontSizeRef.current}px` } }),
			),
			EditorView.updateListener.of((update) => {
				if (!update.docChanged) return;
				if (!dirtyRef.current) {
					dirtyRef.current = true;
					onDirtyChangeRef.current(true);
				}
				schedulePersistRef.current(update.state.doc);
			}),
		];
		const view = new EditorView({
			parent: host,
			state: EditorState.create({ doc: seedRef.current, extensions }),
		});
		viewRef.current = view;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// Mount-once; seed/path/theme changes are handled by the effects below
		// (`manualSaveKeymap` / `selection.selectionListener` are stable — never
		// re-mount the editor).
	}, [manualSaveKeymap, selection.selectionListener]);

	// Follow light/dark without rebuilding the editor. Token colors use
	// light-dark() against this color-scheme, and surface colors are CSS
	// variables, so a palette change does not need another reconfigure.
	useEffect(() => {
		viewRef.current?.dispatch({
			effects: themeCompartment.current.reconfigure(
				editorColorScheme(resolvedTheme === "dark"),
			),
		});
	}, [resolvedTheme]);

	// Follow fontSize changes without rebuilding the editor.
	useEffect(() => {
		viewRef.current?.dispatch({
			effects: fontSizeCompartment.current.reconfigure(
				EditorView.theme({ "&": { fontSize: `${fontSize}px` } }),
			),
		});
	}, [fontSize]);

	// A renamed path only swaps the language support.
	const language = useMemo(() => textLanguageExtensions(path), [path]);
	useEffect(() => {
		viewRef.current?.dispatch({
			effects: languageCompartment.current.reconfigure(language),
		});
	}, [language]);

	// The seed is authoritative: after our own save it equals what we wrote
	// (idempotent), after an external change it is the new disk snapshot.
	useEffect(() => {
		lastSavedRef.current = seed;
	}, [seed]);

	// Flush pending autosave on unmount (tab close / LRU eviction).
	useEffect(() => {
		return () => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
			if (pendingContentRef.current) {
				void flush();
			}
		};
	}, [flush]);

	// A `reloadKey` bump means the file was reloaded from disk (external
	// change the user accepted). Drop any pending autosave from the superseded
	// session — its flush would pass the conflict check (disk === lastSaved)
	// and overwrite the reloaded content — and swap the document in place.
	useEffect(() => {
		if (reloadKey === 0) return; // mount: document was seeded directly
		if (debounceRef.current) {
			clearTimeout(debounceRef.current);
			debounceRef.current = null;
		}
		pendingContentRef.current = null;
		const view = viewRef.current;
		const next = seedRef.current;
		lastSavedRef.current = next;
		if (view && view.state.doc.toString() !== next) {
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: next },
			});
		}
		dirtyRef.current = false;
		onDirtyChangeRef.current(false);
	}, [reloadKey]);

	// An unreadable file still opens an empty buffer — the next autosave
	// creates/repairs the file on disk.
	// The selection chrome portals to body so the fixed-position toolbar and
	// Ask popover escape the panel's overflow/stacking context (same as the
	// PDF card stack); inactive keep-alive panes render no chrome.
	return (
		<div
			className={`relative flex h-full w-full flex-col overflow-hidden ${className ?? ""}`}
		>
			<div className="relative min-h-0 w-full flex-1 overflow-hidden">
				<TextEditorToolbar fontSize={fontSize} onFontSizeChange={setFontSize} />
				<div ref={hostRef} className="h-full w-full overflow-hidden" />
			</div>
		</div>
	);
}
