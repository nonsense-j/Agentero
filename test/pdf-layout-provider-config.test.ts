import { describe, expect, it } from "vitest";
import { layoutBackendsAfterClearingProvider } from "@/lib/pdf/layout/provider-config";
import {
	LAYOUT_PROVIDERS,
	layoutProviderCard,
	mergeProviderCards,
	PARSER_PROVIDERS,
} from "@/lib/pdf/layout/providers";
import {
	DEFAULT_LAYOUT_SETTINGS,
	type LayoutSettings,
} from "@/lib/pdf/layout/settings";

function layoutWith(
	partial: Partial<LayoutSettings> &
		Pick<LayoutSettings, "backend" | "parserBackend">,
): LayoutSettings {
	return {
		...DEFAULT_LAYOUT_SETTINGS,
		providerConfigs: {},
		...partial,
	};
}

describe("layoutBackendsAfterClearingProvider", () => {
	it("falls layout backend back to default when it pointed at the cleared provider", () => {
		const next = layoutBackendsAfterClearingProvider(
			layoutWith({ backend: "mineru", parserBackend: "local" }),
			"mineru",
		);
		expect(next).toEqual({ backend: "paddle", parserBackend: "local" });
	});

	it("falls parser backend back to local when it pointed at the cleared provider", () => {
		const next = layoutBackendsAfterClearingProvider(
			layoutWith({ backend: "paddle", parserBackend: "mineru" }),
			"mineru",
		);
		expect(next).toEqual({ backend: "paddle", parserBackend: "local" });
	});

	it("falls both backends when both pointed at the cleared provider", () => {
		const next = layoutBackendsAfterClearingProvider(
			layoutWith({ backend: "mineru", parserBackend: "mineru" }),
			"mineru",
		);
		expect(next).toEqual({ backend: "paddle", parserBackend: "local" });
	});

	it("leaves unrelated backends unchanged", () => {
		const next = layoutBackendsAfterClearingProvider(
			layoutWith({ backend: "mineru", parserBackend: "openaiCompatible" }),
			"paddle",
		);
		expect(next).toEqual({
			backend: "mineru",
			parserBackend: "openaiCompatible",
		});
	});

	it("only resets parserBackend for openaiCompatible (not a layout backend)", () => {
		const next = layoutBackendsAfterClearingProvider(
			layoutWith({ backend: "paddle", parserBackend: "openaiCompatible" }),
			"openaiCompatible",
		);
		expect(next).toEqual({
			backend: "paddle",
			parserBackend: "local",
		});
	});
});

describe("provider card descriptors", () => {
	// The MinerU self-hosted switch is rendered from this flag, so it must
	// survive `layoutProviderCard` + the layout and parser card merge.
	it("keeps supportsSelfHosted on the merged MinerU card only", () => {
		const mineru = mergeProviderCards([
			layoutProviderCard(LAYOUT_PROVIDERS.mineru),
			PARSER_PROVIDERS.mineru,
		]);
		expect(mineru).toHaveLength(1);
		expect(mineru[0]?.supportsSelfHosted).toBe(true);

		const paddle = mergeProviderCards([
			layoutProviderCard(LAYOUT_PROVIDERS.paddle),
			PARSER_PROVIDERS.paddle,
		]);
		expect(paddle[0]?.supportsSelfHosted).toBeUndefined();
	});
});
