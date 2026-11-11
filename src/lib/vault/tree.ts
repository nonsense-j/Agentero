import { commands, type VaultTreeNode_Serialize } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { toVaultRelative } from "@/lib/core/path";
import { perfOp } from "@/lib/core/perf";
import { compareNaturalName } from "@/lib/core/sort";
import { normalizePathKey } from "@/lib/vault/path";
import { ensureLocalFsScope } from "@/lib/vault/scope";
import type { FileNode } from "@/lib/vault/types";
import { isWikiTargetPath } from "@/lib/wiki/target-path";

/**
 * Names never listed in the file tree.
 * Includes VCS, build/cache, virtualenvs, and Host-only `.agentero`.
 */
export const TREE_IGNORE_NAMES = new Set([
	".git",
	".DS_Store",
	"node_modules",
	"target",
	"dist",
	".agentero",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".tox",
	".eggs",
	".codex",
	".idea",
	".vscode",
	"site-packages",
]);

/**
 * Vault-root segment names that are fully recursive on open (product surface).
 * Everything else at the vault root is shallow (one level) until expanded.
 */
export const TREE_EAGER_ROOT_NAMES = new Set(["papers", "notes", ".agents"]);

/**
 * Dot-directories that are still part of the product surface (not ignored).
 * Must stay in sync with {@link TREE_EAGER_ROOT_NAMES} where applicable.
 */
const TREE_ALLOWED_DOT_NAMES = new Set([".env.example", ".agents"]);

/** True when this basename should never appear in the tree. */
export function shouldIgnoreTreeName(name: string): boolean {
	if (!name) return true;
	if (TREE_IGNORE_NAMES.has(name)) return true;
	if (TREE_ALLOWED_DOT_NAMES.has(name)) return false;
	// Other hidden entries (`.git`, `.venv`, `.codex`, …).
	if (name.startsWith(".")) return true;
	// Python packaging / build noise.
	if (name.endsWith(".egg-info")) return true;
	return false;
}

/**
 * Whether a directory under the vault should be fully walked on open.
 * - Under `papers/` / `notes/` / `.agents/`: always eager (markers, skills).
 * - Other vault-root trees (`src/`, `thesis/`, …): shallow only until user expands.
 */
export function isEagerTreeRel(rel: string): boolean {
	const r = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!r) return true; // vault root itself is always listed
	const top = r.split("/")[0]?.toLowerCase() ?? "";
	return TREE_EAGER_ROOT_NAMES.has(top);
}

export function compareVaultTreeNodes(a: FileNode, b: FileNode): number {
	if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
	return compareNaturalName(a.name, b.name);
}

function sortNodes(nodes: FileNode[]): FileNode[] {
	return [...nodes].sort(compareVaultTreeNodes);
}

/**
 * True when an FS error means the path is gone (or never existed).
 * Matches Host local tree semantics: missing dirs list as empty, not hard fail.
 */
export function isPathMissingError(error: unknown): boolean {
	const msg = errorText(error).toLowerCase();
	return (
		msg.includes("no such file") ||
		msg.includes("nosuchfile") ||
		msg.includes("not found") ||
		msg.includes("enoent") ||
		msg.includes("does not exist")
	);
}

/** Map Host `vault_tree_build` / `vault_tree_children` nodes to `FileNode`s,
 *  sorting each level like {@link sortNodes}. */
function mapHostTreeNodes(nodes: VaultTreeNode_Serialize[]): FileNode[] {
	return sortNodes(
		nodes.map((n) => {
			const node: FileNode = {
				id: n.path,
				name: n.name,
				path: n.path,
				kind: n.kind === "directory" ? "directory" : "file",
			};
			if (n.children) node.children = mapHostTreeNodes(n.children);
			if (n.childrenPending != null) node.childrenPending = n.childrenPending;
			if (n.hasTex != null) node.hasTex = n.hasTex;
			if (n.needsSource != null) node.needsSource = n.needsSource;
			return node;
		}),
	);
}

/**
 * List one directory level only (used when expanding a lazy folder).
 * Nested directories stay `childrenPending` (expand again to go deeper).
 */
export async function listVaultDirChildren(
	rootPath: string,
	dirAbsPath: string,
): Promise<FileNode[]> {
	const nodes = await callApiResult(() =>
		commands.vaultTreeChildren(rootPath, dirAbsPath),
	);
	return mapHostTreeNodes(nodes);
}

/**
 * Paths of directory nodes that still need listing, among `expandedPaths`.
 * Used to load children when the user expands a lazy folder.
 */
export function pendingDirsAmongExpanded(
	nodes: FileNode[],
	expandedPaths: ReadonlySet<string>,
): string[] {
	const out: string[] = [];
	const walk = (list: FileNode[]) => {
		for (const n of list) {
			if (n.kind !== "directory") continue;
			if (n.childrenPending && expandedPaths.has(n.path)) {
				out.push(n.path);
			}
			if (n.children?.length) walk(n.children);
		}
	};
	walk(nodes);
	return out;
}

/**
 * Insert or replace one child under a loaded parent. Other children stay,
 * so a new paper does not re-list `papers/`.
 */
export function upsertTreeChild(
	nodes: FileNode[],
	parentPath: string,
	child: FileNode,
): FileNode[] {
	const parentKey = normalizePathKey(parentPath);
	const childKey = normalizePathKey(child.path);
	const walk = (list: FileNode[]): FileNode[] =>
		list.map((node) => {
			if (
				normalizePathKey(node.path) === parentKey &&
				node.kind === "directory"
			) {
				const children = (node.children ?? []).filter(
					(existing) => normalizePathKey(existing.path) !== childKey,
				);
				children.push(child);
				sortNodes(children);
				return { ...node, children, childrenPending: false };
			}
			if (node.children?.length) {
				return { ...node, children: walk(node.children) };
			}
			return node;
		});
	return walk(nodes);
}

export function directoryIsLoaded(nodes: FileNode[], path: string): boolean {
	const key = normalizePathKey(path);
	const walk = (list: FileNode[]): boolean => {
		for (const node of list) {
			if (normalizePathKey(node.path) === key) {
				return node.kind === "directory" && !node.childrenPending;
			}
			if (node.children?.length && walk(node.children)) return true;
		}
		return false;
	};
	return walk(nodes);
}

/** Immutable replace of a directory node's children (by absolute path). */
export function replaceTreeNodeChildren(
	nodes: FileNode[],
	dirPath: string,
	children: FileNode[],
): FileNode[] {
	const key = normalizePathKey(dirPath);
	const walk = (list: FileNode[]): FileNode[] =>
		list.map((n) => {
			if (normalizePathKey(n.path) === key && n.kind === "directory") {
				return {
					...n,
					children,
					childrenPending: false,
				};
			}
			if (n.children?.length) {
				return { ...n, children: walk(n.children) };
			}
			return n;
		});
	return walk(nodes);
}

/**
 * Remove a node (file or directory) and any of its descendants from the tree.
 * Used after delete / when a lazy expand finds the path already gone remotely.
 */
export function removeTreeNode(
	nodes: FileNode[],
	targetPath: string,
): FileNode[] {
	const key = normalizePathKey(targetPath);
	const walk = (list: FileNode[]): FileNode[] => {
		const out: FileNode[] = [];
		for (const n of list) {
			const nKey = normalizePathKey(n.path);
			if (nKey === key || nKey.startsWith(`${key}/`)) continue;
			if (n.children?.length) {
				out.push({ ...n, children: walk(n.children) });
			} else {
				out.push(n);
			}
		}
		return out;
	};
	return walk(nodes);
}

/** True if any directory under `nodes` still needs listing. */
export function treeHasPendingChildren(nodes: FileNode[]): boolean {
	for (const n of nodes) {
		if (n.kind === "directory" && n.childrenPending) return true;
		if (n.children?.length && treeHasPendingChildren(n.children)) return true;
	}
	return false;
}

/** Max targeted refreshes per debounce window before falling back to a full rebuild. */
const MAX_TREE_REFRESH_TARGETS = 8;

/**
 * Map watcher-changed absolute paths to the loaded directory nodes that need
 * re-listing (targeted refresh instead of a full tree rebuild).
 *
 * Returns `null` when a full rebuild is required (change at the vault root,
 * no loaded ancestor, or too many distinct targets). Returns `[]` when every
 * change is invisible to the tree (e.g. only ignored names).
 */
export function collectTreeRefreshTargets(
	nodes: FileNode[],
	vaultPath: string,
	changedAbsPaths: string[],
): string[] | null {
	const rootKey = normalizePathKey(vaultPath);

	// Loaded (non-pending) directory nodes, keyed for case-insensitive lookup.
	const loadedDirs = new Map<string, string>();
	const walk = (list: FileNode[]) => {
		for (const n of list) {
			if (n.kind !== "directory") continue;
			if (!n.childrenPending) loadedDirs.set(normalizePathKey(n.path), n.path);
			if (n.children?.length) walk(n.children);
		}
	};
	walk(nodes);

	const targetKeys = new Set<string>();
	for (const changed of changedAbsPaths) {
		const key = normalizePathKey(changed);
		if (key === rootKey) return null;
		if (!key.startsWith(`${rootKey}/`)) continue;
		const relSegments = key.slice(rootKey.length + 1).split("/");
		if (relSegments.some((s) => shouldIgnoreTreeName(s))) continue;

		let dirKey = key.slice(0, key.lastIndexOf("/"));
		while (dirKey.length > rootKey.length) {
			if (loadedDirs.has(dirKey)) {
				targetKeys.add(dirKey);
				break;
			}
			dirKey = dirKey.slice(0, dirKey.lastIndexOf("/"));
		}
		// Nearest loaded ancestor is the vault root: needs a full rebuild.
		if (dirKey.length <= rootKey.length) return null;
	}

	// Drop targets covered by an ancestor target whose refresh recurses (eager).
	const keys = [...targetKeys].sort((a, b) => a.length - b.length);
	const kept: string[] = [];
	for (const key of keys) {
		const covered = kept.some(
			(k) =>
				key.startsWith(`${k}/`) && isEagerTreeRel(k.slice(rootKey.length + 1)),
		);
		if (!covered) kept.push(key);
	}
	if (kept.length > MAX_TREE_REFRESH_TARGETS) return null;
	return kept.map((k) => loadedDirs.get(k) ?? k);
}

/** Flatten the loaded tree to Vault-relative internal-link targets. */
export function collectWikiTargetRelPaths(
	nodes: FileNode[],
	vaultPath: string | null,
): string[] {
	const out: string[] = [];
	const walk = (list: FileNode[]) => {
		for (const node of list) {
			if (node.kind === "directory" && node.children) {
				walk(node.children);
			} else if (node.kind === "file" && isWikiTargetPath(node.path)) {
				out.push(toVaultRelative(vaultPath, node.path));
			}
		}
	};
	walk(nodes);
	return out;
}

/**
 * Build the vault file tree.
 *
 * - Eager recursive: `papers/`, `notes/`, `.agents/`
 * - Shallow elsewhere: vault-root extras (`src/`, `thesis/`, …) appear as
 *   one level with `childrenPending`; expand via {@link listVaultDirChildren}.
 * - Ignored names ({@link TREE_IGNORE_NAMES} / dots / `*.egg-info`) are never listed.
 */
export async function loadVaultTree(rootPath: string): Promise<FileNode[]> {
	return perfOp("vault_tree_build", async () => {
		await ensureLocalFsScope(rootPath);
		// The Host walks the vault in-process and returns the tree in one IPC.
		const nodes = await callApiResult(() => commands.vaultTreeBuild(rootPath));
		return mapHostTreeNodes(nodes);
	});
}
