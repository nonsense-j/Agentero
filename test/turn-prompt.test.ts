import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { encodeMentionToken } from "@/lib/agent/composer-inline-tokens";
import { assembleTurnPrompt } from "@/lib/agent/turn-prompt";

const t = ((key: string) => key) as unknown as TFunction<"agent", undefined>;

describe("assembleTurnPrompt inline chips", () => {
	it("strips the marker from the prompt and titles a chip-only turn by the chip", () => {
		const token = encodeMentionToken("notes/论文关系图.md");
		const chipOnly = assembleTurnPrompt({
			text: token,
			contextPaths: [],
			visualDrafts: [],
			attachedImages: [],
			isAcpCommand: false,
			t,
		});
		expect(chipOnly.prompt).not.toContain("{{m:");
		expect(chipOnly.historyTitle).toBe("@论文关系图.md");

		const withProse = assembleTurnPrompt({
			text: `帮我梳理 ${token}`,
			contextPaths: [],
			visualDrafts: [],
			attachedImages: [],
			isAcpCommand: false,
			t,
		});
		expect(withProse.prompt).toBe("帮我梳理");
		expect(withProse.historyTitle).toBe("帮我梳理");
	});
});
