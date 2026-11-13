import { describe, expect, it } from "vitest";
import {
	buildKeywordLookupKey,
	canonicalizePaperKeyword,
	canonicalizePaperKeywords,
	KEYWORD_SYNONYM_MAP,
	normalizeKeywordKey,
	SYNONYM_GROUPS,
} from "@/lib/plaza/keyword-synonyms";

describe("Plaza canonical keyword synonym taxonomy & morphological normalization", () => {
	it("maps Defect Detection, Bug Detection, and shared-word vulnerability variants to Vulnerability Detection", () => {
		const variants = [
			"Defect Detection",
			"defect detection",
			"Vulnerability Detection",
			"Bug Detection",
			"Software Defect Detection",
			"Software Vulnerability Detection",
			"Code Vulnerability Detection",
			"Source Code Vulnerability Detection",
			"Automated Vulnerability Detection",
			"Vulnerability Discovery",
			"Bug Finding",
		];
		for (const raw of variants) {
			expect(canonicalizePaperKeyword(raw)).toBe("Vulnerability Detection");
			expect(normalizeKeywordKey(raw)).toBe("vulnerability detection");
		}

		// Collapses co-occurring synonyms on a single paper into one canonical entry
		expect(
			canonicalizePaperKeywords([
				"Defect Detection",
				"Software Vulnerability Detection",
				"Bug Detection",
			]),
		).toEqual(["Vulnerability Detection"]);
	});

	it("maps Agent, AI Agent, LLM Agent, Autonomous Agent, and Agentic AI variants to AI Agent while keeping Coding Agent & Multi-Agent System distinct", () => {
		const aiAgentVariants = [
			"Agent",
			"Agents",
			"AI Agent",
			"AI Agents",
			"LLM Agent",
			"LLM Agents",
			"llm-based agents",
			"LLM-Based Agent",
			"Autonomous Agent",
			"Autonomous Agents",
			"Language Agent",
			"Language Model Agents",
			"Agentic AI",
			"Agentic Systems",
		];
		for (const raw of aiAgentVariants) {
			expect(canonicalizePaperKeyword(raw)).toBe("AI Agent");
			expect(normalizeKeywordKey(raw)).toBe("ai agent");
		}

		expect(canonicalizePaperKeyword("Coding Agents")).toBe("Coding Agent");
		expect(canonicalizePaperKeyword("Software Engineering Agents")).toBe(
			"Coding Agent",
		);
		expect(canonicalizePaperKeyword("Multi-agent Systems")).toBe(
			"Multi-Agent System",
		);
		expect(canonicalizePaperKeyword("Multi-Agent")).toBe("Multi-Agent System");
	});

	it("normalizes high-frequency PL/SE, Security/CR, and AI synonym groups accurately", () => {
		expect(canonicalizePaperKeyword("Fuzz Testing")).toBe("Fuzzing");
		expect(canonicalizePaperKeyword("Fuzzers")).toBe("Fuzzing");

		expect(canonicalizePaperKeyword("Automated Program Repair")).toBe(
			"Program Repair",
		);
		expect(canonicalizePaperKeyword("Automatic Program Repair")).toBe(
			"Program Repair",
		);
		expect(canonicalizePaperKeyword("APR")).toBe("Program Repair");
		expect(canonicalizePaperKeyword("Code Repair")).toBe("Program Repair");

		expect(canonicalizePaperKeyword("Static Program Analysis")).toBe(
			"Static Analysis",
		);
		expect(canonicalizePaperKeyword("Static Code Analysis")).toBe(
			"Static Analysis",
		);

		expect(canonicalizePaperKeyword("Fault Location")).toBe(
			"Fault Localization",
		);
		expect(canonicalizePaperKeyword("Bug Localization")).toBe(
			"Fault Localization",
		);
		expect(canonicalizePaperKeyword("Defect Localization")).toBe(
			"Fault Localization",
		);

		expect(canonicalizePaperKeyword("Large Language Models")).toBe(
			"Large Language Model",
		);
		expect(canonicalizePaperKeyword("LLM")).toBe("Large Language Model");
		expect(canonicalizePaperKeyword("LLMs")).toBe("Large Language Model");
		expect(canonicalizePaperKeyword("Large Language Models (LLMs)")).toBe(
			"Large Language Model",
		);

		expect(canonicalizePaperKeyword("RAG")).toBe(
			"Retrieval-Augmented Generation",
		);
		expect(canonicalizePaperKeyword("retrieval augmented generation")).toBe(
			"Retrieval-Augmented Generation",
		);

		expect(canonicalizePaperKeyword("Large Language Model Security")).toBe(
			"LLM Security",
		);
		expect(canonicalizePaperKeyword("LLM Agent Security")).toBe(
			"AI Agent Security",
		);
		expect(canonicalizePaperKeyword("Agent Security")).toBe(
			"AI Agent Security",
		);
		expect(canonicalizePaperKeyword("Zero-Knowledge Proofs")).toBe(
			"Zero-Knowledge Proof",
		);
		expect(canonicalizePaperKeyword("ZKPs")).toBe("Zero-Knowledge Proof");
		expect(canonicalizePaperKeyword("Smart Contracts")).toBe("Smart Contract");
		expect(canonicalizePaperKeyword("Decentralized Finance (DeFi)")).toBe(
			"Decentralized Finance",
		);
	});

	it("preserves distinct research subfields and methodology classes without over-merging", () => {
		const distinctCategories = [
			"Code Generation",
			"Program Synthesis",
			"Random Testing",
			"Fuzzing",
			"Directed Fuzzing",
			"Greybox Fuzzing",
			"Unit Test Generation",
			"Test Generation",
			"Mutation Testing",
			"Metamorphic Testing",
			"Differential Testing",
			"Property-Based Testing",
			"Symbolic Execution",
			"Concolic Execution",
			"Concolic Testing",
			"Static Analysis",
			"Dynamic Analysis",
			"Program Analysis",
			"Formal Verification",
			"Model Checking",
			"Defect Prediction",
			"Vulnerability Detection",
			"Vulnerability Repair",
			"Fault Localization",
		];

		const canonicalized = distinctCategories.map((term) =>
			canonicalizePaperKeyword(term),
		);
		expect(canonicalized).toEqual(distinctCategories);
		expect(new Set(canonicalized).size).toBe(distinctCategories.length);

		// Ambiguous cross-domain acronyms are NOT force-merged into the wrong domain
		expect(canonicalizePaperKeyword("DP")).toBe("DP");
		expect(canonicalizePaperKeyword("MPC")).toBe("MPC");
		expect(canonicalizePaperKeyword("CPS")).toBe("CPS");
		expect(canonicalizePaperKeyword("CFG")).toBe("CFG");
	});

	it("handles trailing plurals, invariant -s endings, mixedCase/acronyms, and noise rejection", () => {
		// Open-vocabulary singularization + Title Case + acronym casing preservation
		expect(canonicalizePaperKeyword("ebpf verification")).toBe(
			"eBPF Verification",
		);
		expect(canonicalizePaperKeyword("eBPF")).toBe("eBPF");
		expect(canonicalizePaperKeyword("flaky tests")).toBe("Flaky Test");
		expect(canonicalizePaperKeyword("Flaky Test")).toBe("Flaky Test");
		expect(canonicalizePaperKeyword("security advisories")).toBe(
			"Security Advisory",
		);
		expect(canonicalizePaperKeyword("security patches")).toBe("Security Patch");
		expect(canonicalizePaperKeyword("instruction caches")).toBe(
			"Instruction Cache",
		);
		expect(canonicalizePaperKeyword("c/c++ memory safety")).toBe(
			"C/C++ Memory Safety",
		);

		// Invariant -s words are never mangled
		expect(canonicalizePaperKeyword("formal semantics")).toBe(
			"Formal Semantics",
		);
		expect(canonicalizePaperKeyword("abstract consensus")).toBe(
			"Abstract Consensus",
		);
		expect(canonicalizePaperKeyword("naive bayes")).toBe("Naive Bayes");
		expect(canonicalizePaperKeyword("serverless computing")).toBe(
			"Serverless Computing",
		);
		expect(canonicalizePaperKeyword("Microservices")).toBe("Microservices");
		expect(canonicalizePaperKeyword("RTOS")).toBe("RTOS");
		expect(canonicalizePaperKeyword("NIDS")).toBe(
			"Network Intrusion Detection",
		);

		// Broad disciplines, arXiv codes, years, ACM CCS arrows, and IEEE boilerplate return null
		for (const invalid of [
			"",
			"a",
			"2026",
			"ICSE 2026",
			"cs.SE",
			"stat.ML",
			"Computer Science",
			"Software Engineering",
			"Artificial Intelligence",
			"Benchmark",
			"Benchmarking",
			"Methodology",
			"Framework",
			"Printing",
			"Conferences",
			"Codes",
			"Software and its engineering -> Software testing",
		]) {
			expect(canonicalizePaperKeyword(invalid)).toBeNull();
		}
	});

	it("guarantees zero alias lookup collisions and 100% idempotency across all SYNONYM_GROUPS", () => {
		const seenLookupKeys = new Map<string, string>();
		for (const group of SYNONYM_GROUPS) {
			// Canonical output must be idempotent
			expect(canonicalizePaperKeyword(group.canonical)).toBe(group.canonical);

			for (const term of [group.canonical, ...group.aliases]) {
				const key = buildKeywordLookupKey(term);
				expect(key.length).toBeGreaterThan(0);
				const prev = seenLookupKeys.get(key);
				if (prev !== undefined) {
					expect(prev).toBe(group.canonical);
				}
				seenLookupKeys.set(key, group.canonical);
				expect(KEYWORD_SYNONYM_MAP.get(key)).toBe(group.canonical);
				expect(canonicalizePaperKeyword(term)).toBe(group.canonical);
			}
		}
	});
});
