import { describe, expect, it } from "vitest";
import { vaultRootFace } from "@/components/sidebar/file-tree/tree-helpers";

describe("vaultRootFace", () => {
	it("labels only the product folders at the vault root", () => {
		const vault = "/Users/me/Research";
		expect(vaultRootFace(vault, `${vault}/notes`)).toBe("notes");
		expect(vaultRootFace(vault, `${vault}/data`)).toBe("data");
		expect(vaultRootFace(vault, `${vault}/Notes`)).toBe("notes");
		expect(vaultRootFace(vault, `${vault}/thesis`)).toBeNull();
		expect(vaultRootFace(vault, `${vault}/papers/notes`)).toBeNull();
		expect(vaultRootFace(vault, `${vault}/my-notes`)).toBeNull();
	});

	it("accepts Windows vault roots", () => {
		expect(vaultRootFace("C:\\Research", "C:\\Research\\data")).toBe("data");
	});

	it("returns null without a vault", () => {
		expect(vaultRootFace(null, "/Users/me/Research/notes")).toBeNull();
		expect(vaultRootFace(undefined, "notes")).toBeNull();
	});
});
