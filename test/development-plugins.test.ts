import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	vault: "/vault-a",
	paper: { path: "papers/a" },
	listeners: new Set<
		(state: { vaultPath: string }, previous: { vaultPath: string }) => void
	>(),
	load: vi.fn(),
	run: vi.fn(),
	unload: vi.fn(),
	success: vi.fn(),
	error: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@/lib/lifecycle/public", () => ({ onPublic: () => () => {} }));
vi.mock("@/lib/paper/library-store", () => ({ refreshLibrary: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => "/plugin" }));
vi.mock("@/i18n", () => ({
	default: {
		resolvedLanguage: "en",
		t: (key: string, args?: { title?: string }) => args?.title ?? key,
	},
}));
vi.mock("@/lib/core/bindings", () => ({
	events: {
		pluginsChanged: { listen: async () => () => {} },
		pluginsDataChanged: { listen: async () => () => {} },
	},
	commands: {
		pluginDevLoad: state.load,
		pluginEditorState: async () => undefined,
		pluginRun: state.run,
		pluginUnload: state.unload,
	},
}));
vi.mock("@/lib/core/ipc", () => ({
	callResult: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => true,
	isMobileApp: () => false,
}));
vi.mock("@/lib/core/notify", () => ({
	notifySuccess: state.success,
	notifyError: state.error,
}));
vi.mock("@/lib/vault/store", () => ({
	getVaultPath: () => state.vault,
	vaultStore: {
		subscribe: (
			listener: typeof state.listeners extends Set<infer T> ? T : never,
		) => {
			state.listeners.add(listener);
			return () => state.listeners.delete(listener);
		},
	},
}));
vi.mock("@/lib/workspace/store", () => ({
	getActiveTab: () => ({ paperMeta: state.paper }),
	getTabs: () => [],
	workspaceStore: { subscribe: () => () => {} },
}));

import {
	loadDevelopmentPlugin,
	startDevelopmentPlugins,
	unloadDevelopmentPlugins,
} from "@/lib/plugins/runtime";
import {
	runMenuContribution,
	visibleMenuContributions,
} from "@/lib/shell/commands/menu-contributions";

import {
	listCommands,
	resetCommandRegistryForTests,
	subscribeCommands,
} from "@/lib/shell/commands/registry";

const manifest = {
	apiVersion: 1,
	id: "demo",
	version: "1.0.0",
	name: {},
	permissions: ["vault:read"],
	commands: [{ id: "inspect", title: { en: "Inspect", "zh-CN": "查看" } }],
	menus: [],
	events: [],
	settings: [],
};
const plugin = {
	manifest,
	grants: ["vault:read"],
	instanceId: "instance-1",
	pluginId: "demo",
	commands: [{ id: "inspect", title: { en: "Inspect", "zh-CN": "查看" } }],
};

function switchVault() {
	const previous = state.vault;
	state.vault = "/vault-b";
	for (const listener of state.listeners)
		listener({ vaultPath: state.vault }, { vaultPath: previous });
}

beforeEach(async () => {
	await unloadDevelopmentPlugins();
	resetCommandRegistryForTests();
	vi.clearAllMocks();
	state.vault = "/vault-a";
	state.paper = { path: "papers/a" };
	state.load.mockResolvedValue(plugin);
	state.unload.mockResolvedValue(undefined);
	state.run.mockResolvedValue("");
});

describe("development plugin scope", () => {
	it("registers live commands, snapshots context and removes them on unload", async () => {
		const changed = vi.fn();
		const stop = subscribeCommands(changed);
		await loadDevelopmentPlugin();
		expect(listCommands()).toHaveLength(1);
		expect(changed).toHaveBeenCalled();
		state.run.mockResolvedValue("Paper A");
		await listCommands()[0].run();
		expect(state.run).toHaveBeenCalledWith(
			"instance-1",
			"inspect",
			expect.objectContaining({
				paperRef: "papers/a",
				locale: "en",
				kind: "command",
			}),
		);
		await unloadDevelopmentPlugins();
		expect(listCommands()).toEqual([]);
		expect(state.unload).toHaveBeenCalledWith("instance-1");
		stop();
	});

	it("passes the clicked menu row instead of retargeting the focused paper", async () => {
		state.load.mockResolvedValue({
			...plugin,
			manifest: {
				...manifest,
				menus: [{ menu: "library.row", command: "inspect", order: 0 }],
			},
		});
		await loadDevelopmentPlugin();
		const context = {
			vaultPath: "/vault-a",
			paperId: "clicked",
			relPath: "papers/clicked",
		};
		const [item] = visibleMenuContributions("library.row", context);
		const running = runMenuContribution(item, context);
		state.paper = { path: "papers/later-focus" };
		await running;
		expect(state.run).toHaveBeenCalledWith(
			"instance-1",
			"inspect",
			expect.objectContaining({
				paperRef: "clicked",
				relPath: "papers/clicked",
			}),
		);
	});

	it("revokes a load that finishes after the window switches vault", async () => {
		const stop = startDevelopmentPlugins();
		let resolve!: (value: typeof plugin) => void;
		state.load.mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const loading = loadDevelopmentPlugin();
		await vi.waitFor(() => expect(state.load).toHaveBeenCalled());
		switchVault();
		resolve(plugin);
		await loading;
		expect(listCommands()).toEqual([]);
		expect(state.unload).toHaveBeenCalledWith("instance-1");
		stop();
	});

	it("suppresses late results after revoking the vault scope", async () => {
		const stop = startDevelopmentPlugins();
		await loadDevelopmentPlugin();
		state.success.mockClear();
		let resolve!: (value: string) => void;
		state.run.mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const running = listCommands()[0].run();
		state.paper = { path: "papers/b" };
		switchVault();
		resolve("Paper A");
		await running;
		expect(state.success).not.toHaveBeenCalled();
		expect(listCommands()).toEqual([]);
		stop();
	});
});
