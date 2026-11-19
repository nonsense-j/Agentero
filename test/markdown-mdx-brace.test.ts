import { createSlateEditor, NodeApi } from "platejs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { escapeStrayMdxBraces } from "@/lib/markdown/deserialize";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";

function deserialize(source: string) {
	const editor = createSlateEditor({ plugins: MarkdownKit });
	const value = deserializeMarkdownBody(editor, source);
	return {
		value,
		text: value.map((node) => NodeApi.string(node as never)).join("\n"),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("escapeStrayMdxBraces", () => {
	it("turns prose braces into entities that MDX cannot see", () => {
		expect(escapeStrayMdxBraces("集合 {a,b} 与 } 收尾")).toBe(
			"集合 &#123;a,b&#125; 与 &#125; 收尾",
		);
	});

	it("drops the LaTeX backslash so the entity decodes to a literal brace", () => {
		expect(escapeStrayMdxBraces("\\max\\{\\rho_z\\}")).toBe(
			"\\max&#123;\\rho_z&#125;",
		);
	});

	it("leaves code fences, `$$` math, inline code and inline math untouched", () => {
		const source = [
			"```",
			"const x = { a: 1 };",
			"```",
			"$$",
			"\\max\\{\\rho_z\\}",
			"$$",
			"code `{x}` and math $\\{x\\}$ stay",
		].join("\n");
		expect(escapeStrayMdxBraces(source)).toBe(source);
	});

	it("is a no-op without braces", () => {
		expect(escapeStrayMdxBraces("plain $x$ text")).toBe("plain $x$ text");
	});
});

describe("MDX braces in notes", () => {
	it("keeps the literal braces visible after deserialize", () => {
		const { text } = deserialize("前文 $x$ 后文 \\max\\{\\rho_z\\} 收尾");
		expect(text).toContain("{");
		expect(text).toContain("}");
		expect(text).not.toContain("&#123;");
	});

	it("does not truncate a note whose LaTeX braces need MDX for a table break", () => {
		// `\(...\)` is editor math (normalized to `$…$` before deserialize), so
		// `\{` inside it never reaches acorn; before the normalization it was
		// plain text whose `{` threw. Plate's recovery then cut the source at
		// `$\rho<1$` and dropped the rest.
		const source = [
			"# title",
			"",
			"| a | b |",
			"| - | - |",
			"| x<br/>y | z |",
			"",
			"* 列表一",
			"* 列表二",
			"",
			"以及 \\(\\mathcal E^{t+1}\\le\\max\\{\\rho_z,\\rho_G\\}\\,\\mathcal E^t\\)。",
			"",
			"## after",
			"",
			"后面的内容应当完整保留。",
		].join("\n");
		const { value, text } = deserialize(source);
		expect(text).toContain("列表二");
		expect(text).toContain("后面的内容应当完整保留。");
		expect(JSON.stringify(value)).toContain("inline_equation");
		const inline = value
			.flatMap((node) => ("children" in node ? node.children : []))
			.find(
				(child) => (child as { type?: string }).type === "inline_equation",
			) as { texExpression?: string } | undefined;
		expect(inline?.texExpression).toBe(
			"\\mathcal E^{t+1}\\le\\max\\{\\rho_z,\\rho_G\\}\\,\\mathcal E^t",
		);
	});

	it("falls back to a no-MDX parse so content survives any MDX error", () => {
		// Escaped braces make this JSX attribute invalid on purpose: the first
		// parse throws and only a full no-MDX re-parse keeps every block.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const source =
			'<div style={{color:"red"}}>x</div>\n\nafter paragraph stays';
		const { text } = deserialize(source);
		expect(text).toContain("after paragraph stays");
		expect(warn).toHaveBeenCalled();
	});
});
