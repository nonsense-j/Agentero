import { defineStepper } from "@stepperize/react";

/** First-run wizard steps (Raycast-style linear flow). */
export const onboardingFlow = defineStepper([
	{ id: "welcome" },
	{ id: "theme" },
	{ id: "proxy" },
	{ id: "node" },
	{ id: "agent" },
	{ id: "translate" },
	{ id: "layout" },
	{ id: "openalex" },
	{ id: "vault" },
]);

export type OnboardingStepId = (typeof onboardingFlow.steps)[number]["id"];
