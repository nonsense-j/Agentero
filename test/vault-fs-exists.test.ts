import { describe, expect, it } from "vitest";
import { splitVaultRel } from "@/lib/vault/fs";

describe("splitVaultRel", () => {
	it("returns null for empty / root rel", () => {
		expect(splitVaultRel("")).toBeNull();
		expect(splitVaultRel("/")).toBeNull();
		expect(splitVaultRel("///")).toBeNull();
	});

	it("splits single-segment and nested paths", () => {
		expect(splitVaultRel("notes")).toEqual({ parent: "", name: "notes" });
		expect(splitVaultRel("notes/todo.md")).toEqual({
			parent: "notes",
			name: "todo.md",
		});
		expect(splitVaultRel("papers/a/b")).toEqual({
			parent: "papers/a",
			name: "b",
		});
	});

	it("normalizes slashes and trailing separators", () => {
		expect(splitVaultRel("notes\\draft\\")).toEqual({
			parent: "notes",
			name: "draft",
		});
		expect(splitVaultRel("/notes/x/")).toEqual({
			parent: "notes",
			name: "x",
		});
	});
});
