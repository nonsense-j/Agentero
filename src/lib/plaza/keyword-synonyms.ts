/**
 * Canonical academic keyword normalization and shared-word synonym taxonomy
 * for Plaza (`cs.SE`, `cs.CR`, `cs.PL`, and 28 CCF-A/B PL/SE, Security, and AI venues).
 *
 * Pure zero-dependency module mirrored 1-to-1 by Rust
 * `crates/agentero-core/src/features/paper/discovery/collection/keywords.rs`.
 */

export type KeywordSynonymGroup = {
	readonly canonical: string;
	readonly aliases: readonly string[];
};

/**
 * High-precision academic synonym groups across PL/SE, Security/CR, and AI.
 *
 * Design invariants:
 * - Only merge true synonyms and shared-word equivalent categories (e.g.,
 *   `Defect Detection` = `Bug Detection` = `Vulnerability Detection`;
 *   `AI Agent` = `LLM Agent` = `Agent` = `Autonomous Agent`).
 * - Keep distinct subfields and distinct techniques separate (e.g., `Code Generation`,
 *   `Program Synthesis`, `Fuzzing`, `Directed Fuzzing`, `Random Testing`,
 *   `Unit Test Generation`, `Test Generation`, `Symbolic Execution`,
 *   `Concolic Execution`, `Defect Prediction` remain distinct).
 * - Avoid ambiguous cross-domain acronyms (`DP`, `MPC`, `CPS`, `CFG`).
 */
export const SYNONYM_GROUPS: readonly KeywordSynonymGroup[] = [
	// 1. Vulnerability / Defect / Bug / Fault & Security Testing (SE + CR)
	{
		canonical: "Vulnerability Detection",
		aliases: [
			"Defect Detection",
			"Bug Detection",
			"Software Defect Detection",
			"Software Vulnerability Detection",
			"Software Bug Detection",
			"Code Vulnerability Detection",
			"Source Code Vulnerability Detection",
			"Automated Vulnerability Detection",
			"Automatic Vulnerability Detection",
			"Vulnerability Discovery",
			"Automated Vulnerability Discovery",
			"Bug Finding",
			"Automated Bug Finding",
			"Bug Discovery",
			"Security Vulnerability Detection",
			"Flaw Detection",
			"Software Flaw Detection",
		],
	},
	{
		canonical: "Defect Prediction",
		aliases: [
			"Software Defect Prediction",
			"Bug Prediction",
			"Software Bug Prediction",
			"Fault Prediction",
			"Software Fault Prediction",
		],
	},
	{
		canonical: "Just-in-Time Defect Prediction",
		aliases: ["JIT Defect Prediction"],
	},
	{
		canonical: "Fault Localization",
		aliases: [
			"Fault Location",
			"Bug Localization",
			"Defect Localization",
			"Software Fault Localization",
			"Automated Fault Localization",
			"Program Fault Localization",
		],
	},
	{
		canonical: "Root Cause Analysis",
		aliases: [
			"Root Cause Localization",
			"Root Cause Identification",
			"Root Cause Diagnosis",
			"RCA",
		],
	},
	{
		canonical: "Vulnerability Repair",
		aliases: [
			"Automated Vulnerability Repair",
			"Automatic Vulnerability Repair",
			"Vulnerability Patching",
			"Automated Vulnerability Patching",
			"Security Patch Generation",
		],
	},

	// 2. AI Agents & Multi-Agent Systems (AI + SE + CR)
	{
		canonical: "AI Agent",
		aliases: [
			"LLM Agent",
			"Agent",
			"Autonomous Agent",
			"Autonomous AI Agent",
			"Language Agent",
			"Language Model Agent",
			"Large Language Model Agent",
			"LLM-Based Agent",
			"Agentic AI",
			"Agentic System",
			"Agentic AI System",
			"Agentic LLM",
			"Agentic Large Language Model",
			"Intelligent Agent",
			"Software Agent",
			"Foundation Model Agent",
		],
	},
	{
		canonical: "Coding Agent",
		aliases: [
			"Code Agent",
			"LLM Coding Agent",
			"AI Coding Agent",
			"Autonomous Coding Agent",
			"Software Engineering Agent",
			"SWE Agent",
			"Agentic Coding",
			"Agentic Software Engineering",
		],
	},
	{
		canonical: "Multi-Agent System",
		aliases: [
			"Multi-Agent",
			"Multiagent System",
			"Multi-Agent LLM System",
			"Multi-Agent Framework",
			"Multi-Agent AI",
			"LLM Multi-Agent System",
		],
	},
	{
		canonical: "AI Agent Security",
		aliases: [
			"Agent Security",
			"LLM Agent Security",
			"Autonomous Agent Security",
			"Agentic AI Security",
		],
	},
	{
		canonical: "AI Agent Safety",
		aliases: ["Agent Safety", "LLM Agent Safety", "Agentic Safety"],
	},
	{
		canonical: "Model Context Protocol",
		aliases: ["MCP"],
	},

	// 3. Software Testing, Fuzzing, Program Analysis & Repair (PL/SE)
	{
		canonical: "Fuzzing",
		aliases: ["Fuzz Testing", "Software Fuzzing", "Fuzzer"],
	},
	{
		canonical: "Greybox Fuzzing",
		aliases: ["Grey-Box Fuzzing", "Graybox Fuzzing", "Gray-Box Fuzzing"],
	},
	{
		canonical: "Black-Box Fuzzing",
		aliases: ["Blackbox Fuzzing"],
	},
	{
		canonical: "Program Repair",
		aliases: [
			"Automated Program Repair",
			"Automatic Program Repair",
			"APR",
			"Software Repair",
			"Automated Software Repair",
			"Code Repair",
			"Automated Code Repair",
			"Bug Repair",
			"Defect Repair",
			"Fault Repair",
			"Automated Repair",
		],
	},
	{
		canonical: "Static Analysis",
		aliases: [
			"Static Program Analysis",
			"Static Code Analysis",
			"Source Code Static Analysis",
		],
	},
	{
		canonical: "Dynamic Analysis",
		aliases: ["Dynamic Program Analysis"],
	},
	{
		canonical: "Taint Analysis",
		aliases: ["Taint Tracking"],
	},
	{
		canonical: "Symbolic Execution",
		aliases: ["Symbolic Program Execution"],
	},
	{
		canonical: "Concolic Execution",
		aliases: ["Dynamic Symbolic Execution"],
	},
	{
		canonical: "Formal Verification",
		aliases: [
			"Formal Methods",
			"Formal Software Verification",
			"Mechanized Verification",
		],
	},
	{
		canonical: "Code Generation",
		aliases: [
			"Automatic Code Generation",
			"Automated Code Generation",
			"LLM-Based Code Generation",
			"LLM Code Generation",
			"AI-Assisted Code Generation",
			"AI Code Generation",
			"Source Code Generation",
		],
	},
	{
		canonical: "Test Generation",
		aliases: [
			"Test Case Generation",
			"Automated Test Generation",
			"Automatic Test Generation",
			"Test Suite Generation",
			"LLM-Based Test Generation",
			"Automated Test Case Generation",
		],
	},
	{
		canonical: "Unit Test Generation",
		aliases: [
			"Automated Unit Test Generation",
			"Automatic Unit Test Generation",
		],
	},
	{
		canonical: "Search-Based Software Testing",
		aliases: ["Search-Based Testing", "SBST"],
	},
	{
		canonical: "Code Review",
		aliases: [
			"Automated Code Review",
			"Modern Code Review",
			"AI-Assisted Code Review",
		],
	},
	{
		canonical: "Code Clone Detection",
		aliases: ["Clone Detection", "Software Clone Detection", "Code Clone"],
	},
	{
		canonical: "Code Smell",
		aliases: ["Software Code Smell", "Bad Smell"],
	},
	{
		canonical: "Software Maintenance",
		aliases: [
			"Software Maintainability",
			"Maintenance Engineering",
			"Software Maintenance and Evolution",
		],
	},
	{
		canonical: "AI-Assisted Software Development",
		aliases: [
			"LLM-Assisted Software Development",
			"AI-Assisted Programming",
			"Generative AI in Software Development",
			"Artificial Intelligence in Software Development",
			"AI for Software Engineering",
			"LLM4SE",
			"AI4SE",
		],
	},

	// 4. Programming Languages, Compilers & Systems (PL)
	{
		canonical: "Type System",
		aliases: ["Static Type System"],
	},
	{
		canonical: "Domain-Specific Language",
		aliases: ["DSL"],
	},
	{
		canonical: "Control-Flow Graph",
		aliases: ["Control Flow Graph"],
	},
	{
		canonical: "Abstract Syntax Tree",
		aliases: ["AST"],
	},
	{
		canonical: "Program Dependence Graph",
		aliases: ["PDG"],
	},
	{
		canonical: "Code Property Graph",
		aliases: ["CPG"],
	},
	{
		canonical: "Intermediate Representation",
		aliases: ["Compiler IR"],
	},
	{
		canonical: "Satisfiability Modulo Theories",
		aliases: ["SMT", "SMT Solving", "SMT Solver"],
	},
	{
		canonical: "Boolean Satisfiability",
		aliases: ["SAT Solving", "SAT Solver"],
	},
	{
		canonical: "WebAssembly",
		aliases: ["Wasm"],
	},
	{
		canonical: "Microservices",
		aliases: ["Microservice", "Microservice Architecture"],
	},
	{
		canonical: "Integrated Development Environment",
		aliases: ["IDE"],
	},
	{
		canonical: "Application Programming Interface",
		aliases: ["API"],
	},

	// 5. Security, Cryptography & Privacy (CR)
	{
		canonical: "LLM Security",
		aliases: ["Large Language Model Security", "Language Model Security"],
	},
	{
		canonical: "LLM Safety",
		aliases: ["Large Language Model Safety", "Language Model Safety"],
	},
	{
		canonical: "Prompt Injection",
		aliases: ["Prompt Injection Attack"],
	},
	{
		canonical: "Jailbreak Attack",
		aliases: ["Jailbreaking", "LLM Jailbreak", "LLM Jailbreaking", "Jailbreak"],
	},
	{
		canonical: "Backdoor Attack",
		aliases: ["Trojan Attack", "Neural Backdoor"],
	},
	{
		canonical: "Black-Box Attack",
		aliases: ["Blackbox Attack"],
	},
	{
		canonical: "White-Box Attack",
		aliases: ["Whitebox Attack"],
	},
	{
		canonical: "Side-Channel Attack",
		aliases: ["Side Channel Attack"],
	},
	{
		canonical: "Side-Channel Analysis",
		aliases: ["Side Channel Analysis"],
	},
	{
		canonical: "Membership Inference Attack",
		aliases: ["Membership Inference", "MIA"],
	},
	{
		canonical: "Data Poisoning",
		aliases: ["Data Poisoning Attack", "Training Data Poisoning"],
	},
	{
		canonical: "Zero-Knowledge Proof",
		aliases: ["ZKP", "Zero-Knowledge"],
	},
	{
		canonical: "Fully Homomorphic Encryption",
		aliases: ["FHE"],
	},
	{
		canonical: "Post-Quantum Cryptography",
		aliases: [
			"PQC",
			"Quantum-Resistant Cryptography",
			"Quantum-Safe Cryptography",
		],
	},
	{
		canonical: "Secure Multi-Party Computation",
		aliases: [
			"Secure Multiparty Computation",
			"Multi-Party Computation",
			"Multiparty Computation",
			"SMPC",
		],
	},
	{
		canonical: "Trusted Execution Environment",
		aliases: ["TEE"],
	},
	{
		canonical: "Differential Privacy",
		aliases: ["Differential Privacy Mechanism"],
	},
	{
		canonical: "Local Differential Privacy",
		aliases: ["LDP"],
	},
	{
		canonical: "Privacy-Preserving Machine Learning",
		aliases: ["PPML"],
	},
	{
		canonical: "Privacy-Utility Trade-Off",
		aliases: ["Privacy Utility Trade Off"],
	},
	{
		canonical: "Intrusion Detection",
		aliases: ["Intrusion Detection System", "IDS"],
	},
	{
		canonical: "Network Intrusion Detection",
		aliases: ["Network Intrusion Detection System", "NIDS"],
	},
	{
		canonical: "Software Supply Chain Security",
		aliases: ["Supply Chain Security"],
	},
	{
		canonical: "Software Bill of Materials",
		aliases: ["SBOM"],
	},
	{
		canonical: "Control-Flow Integrity",
		aliases: ["CFI"],
	},
	{
		canonical: "Cross-Site Scripting",
		aliases: ["XSS"],
	},
	{
		canonical: "SQL Injection",
		aliases: ["SQLi"],
	},
	{
		canonical: "Denial-of-Service Attack",
		aliases: ["Denial of Service", "Denial-of-Service", "DoS Attack"],
	},
	{
		canonical: "Distributed Denial-of-Service",
		aliases: ["DDoS", "DDoS Attack", "Distributed Denial of Service"],
	},
	{
		canonical: "Smart Contract",
		aliases: ["Blockchain Smart Contract"],
	},
	{
		canonical: "Decentralized Finance",
		aliases: ["DeFi"],
	},
	{
		canonical: "Internet of Things",
		aliases: ["IoT"],
	},
	{
		canonical: "Internet of Things Security",
		aliases: ["IoT Security"],
	},
	{
		canonical: "Cyber-Physical System",
		aliases: ["Cyber Physical System"],
	},
	{
		canonical: "Static Application Security Testing",
		aliases: ["SAST"],
	},

	// 6. AI / Machine Learning / NLP Core Concepts (AI)
	{
		canonical: "Large Language Model",
		aliases: ["LLM"],
	},
	{
		canonical: "Small Language Model",
		aliases: ["SLM"],
	},
	{
		canonical: "Vision-Language Model",
		aliases: ["VLM", "Large Vision-Language Model", "LVLM"],
	},
	{
		canonical: "Multimodal Large Language Model",
		aliases: ["MLLM"],
	},
	{
		canonical: "Code Large Language Model",
		aliases: ["Code LLM", "Code Language Model"],
	},
	{
		canonical: "Retrieval-Augmented Generation",
		aliases: ["RAG"],
	},
	{
		canonical: "Chain-of-Thought Prompting",
		aliases: [
			"Chain-of-Thought",
			"CoT",
			"CoT Prompting",
			"Chain-of-Thought Reasoning",
		],
	},
	{
		canonical: "Zero-Shot Prompting",
		aliases: ["Zero Shot Prompting"],
	},
	{
		canonical: "Few-Shot Prompting",
		aliases: ["Few Shot Prompting"],
	},
	{
		canonical: "Few-Shot Learning",
		aliases: ["Few Shot Learning", "FSL"],
	},
	{
		canonical: "Zero-Shot Learning",
		aliases: ["Zero Shot Learning", "ZSL"],
	},
	{
		canonical: "Reinforcement Learning from Human Feedback",
		aliases: ["RLHF"],
	},
	{
		canonical: "Direct Preference Optimization",
		aliases: ["DPO"],
	},
	{
		canonical: "Parameter-Efficient Fine-Tuning",
		aliases: ["PEFT"],
	},
	{
		canonical: "Low-Rank Adaptation",
		aliases: ["LoRA"],
	},
	{
		canonical: "Supervised Fine-Tuning",
		aliases: ["SFT"],
	},
	{
		canonical: "Fine-Tuning",
		aliases: [
			"Model Fine-Tuning",
			"LLM Fine-Tuning",
			"Language Model Fine-Tuning",
		],
	},
	{
		canonical: "In-Context Learning",
		aliases: ["ICL"],
	},
	{
		canonical: "Graph Neural Network",
		aliases: ["GNN"],
	},
	{
		canonical: "Convolutional Neural Network",
		aliases: ["CNN"],
	},
	{
		canonical: "Generative Adversarial Network",
		aliases: ["GAN"],
	},
	{
		canonical: "Deep Reinforcement Learning",
		aliases: ["DRL"],
	},
	{
		canonical: "Multi-Agent Reinforcement Learning",
		aliases: ["MARL"],
	},
	{
		canonical: "Explainable AI",
		aliases: ["Explainable Artificial Intelligence", "XAI"],
	},
	{
		canonical: "Generative AI",
		aliases: ["Generative Artificial Intelligence", "GenAI"],
	},
	{
		canonical: "LLM-as-a-Judge",
		aliases: ["LLM as a Judge"],
	},
	{
		canonical: "Hallucination",
		aliases: ["LLM Hallucination", "Model Hallucination"],
	},
	{
		canonical: "Open-Source Software",
		aliases: [
			"Open Source Software",
			"OSS",
			"FOSS",
			"Free and Open-Source Software",
		],
	},
];

/**
 * Broad top-level disciplines, venue/tier badges, generic academic filler,
 * and IEEE Xplore / OpenAlex index boilerplate terms rejected from paper keywords.
 */
export const NON_KEYWORD_STOPLIST: ReadonlySet<string> = new Set([
	// Venue / portal / CCF tier badges & broad top-level disciplines
	"ai",
	"cr",
	"pl/se",
	"pl se",
	"ccf-a",
	"ccf a",
	"ccf-b",
	"ccf b",
	"ccf-c",
	"ccf c",
	"computer science",
	"general computer science",
	"software engineering",
	"artificial intelligence",
	"artificial intelligence and robotics",
	"computer networks and communications",
	"hardware and architecture",
	"information systems",
	"engineering",
	"mathematics",
	"physics",
	"medicine",
	"psychology",
	"sociology",
	"business",
	"materials science",
	"software",
	"security",
	"privacy",
	// Generic academic filler words
	"article",
	"paper",
	"research",
	"study",
	"method",
	"methodology",
	"approach",
	"framework",
	"system",
	"model",
	"modeling",
	"modelling",
	"tool",
	"technique",
	"analysis",
	"evaluation",
	"experiment",
	"experimental",
	"performance",
	"result",
	"proposed",
	"application",
	"overview",
	"survey",
	"literature review",
	"systematic literature review",
	"empirical study",
	"case study",
	"benchmark",
	"benchmarking",
	"dataset",
	// IEEE Xplore / OpenAlex boilerplate index noise
	"printing",
	"codes",
	"code",
	"conferences",
	"conference",
	"manuals",
	"manual",
	"equations",
	"equation",
	"vectors",
	"vector",
	"costing",
	"costs",
	"cost",
	"syntactics",
	"poles and zeros",
	"electronic mail",
	"source coding",
	"labeling",
	"timing",
]);

const IRREGULAR_PLURALS: Readonly<Record<string, string>> = {
	analyses: "analysis",
	syntheses: "synthesis",
	hypotheses: "hypothesis",
	diagnoses: "diagnosis",
	theses: "thesis",
	crises: "crisis",
	matrices: "matrix",
	vertices: "vertex",
	indices: "index",
	indexes: "index",
	appendices: "appendix",
	codices: "codex",
	cookies: "cookie",
	zombies: "zombie",
	caches: "cache",
	niches: "niche",
	avalanches: "avalanche",
	leaves: "leaf",
	halves: "half",
	buses: "bus",
	gases: "gas",
	biases: "bias",
	aliases: "alias",
	campuses: "campus",
	viruses: "virus",
	corpora: "corpus",
};

const INVARIANT_WORDS: ReadonlySet<string> = new Set([
	"adfs",
	"alias",
	"apfs",
	"atlas",
	"automata",
	"aws",
	"bayes",
	"bias",
	"bios",
	"bus",
	"calculus",
	"canvas",
	"chaos",
	"cmos",
	"codeforces",
	"compas",
	"consensus",
	"cors",
	"corpus",
	"cosmos",
	"criteria",
	"data",
	"ddos",
	"debris",
	"devops",
	"diabetes",
	"dns",
	"dos",
	"dtls",
	"ethos",
	"focus",
	"gas",
	"genesis",
	"gpfs",
	"gprs",
	"gps",
	"hdfs",
	"hermes",
	"hips",
	"hsts",
	"https",
	"iaas",
	"ipfs",
	"iptables",
	"jenkins",
	"k8s",
	"keras",
	"kubernetes",
	"lens",
	"less",
	"linux",
	"macos",
	"mars",
	"means",
	"media",
	"mems",
	"microservices",
	"mips",
	"mlops",
	"mpls",
	"mtls",
	"news",
	"nextjs",
	"nids",
	"nodejs",
	"ntfs",
	"numpy",
	"nuscenes",
	"openhands",
	"ops",
	"paas",
	"pandas",
	"pass",
	"plus",
	"postgres",
	"prometheus",
	"qos",
	"quartz",
	"radius",
	"redis",
	"rtos",
	"rtps",
	"saas",
	"secops",
	"series",
	"species",
	"texas",
	"things",
	"this",
	"tls",
	"umts",
	"versus",
	"wasm",
	"windows",
]);

const INVARIANT_SUFFIXES = [
	"ss",
	"us",
	"is",
	"os",
	"ics",
	"aas",
	"ias",
	"eas",
] as const;

const ES_PLURAL_SUFFIXES = [
	"sses",
	"xes",
	"zes",
	"tches",
	"nches",
	"rches",
	"eaches",
	"oaches",
	"shes",
] as const;

const MINOR_TITLE_WORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"as",
	"at",
	"by",
	"for",
	"from",
	"in",
	"into",
	"of",
	"on",
	"or",
	"the",
	"to",
	"via",
	"vs",
	"with",
]);

const CANONICAL_SLASH_TOKENS: Readonly<Record<string, string>> = {
	"c/c++": "C/C++",
	"ci/cd": "CI/CD",
	"i/o": "I/O",
	"tcp/ip": "TCP/IP",
};

const CANONICAL_TOKEN_CASING: Readonly<Record<string, string>> = {
	abi: "ABI",
	aes: "AES",
	ai: "AI",
	api: "API",
	apr: "APR",
	arm: "ARM",
	asic: "ASIC",
	aslr: "ASLR",
	asr: "ASR",
	ast: "AST",
	aws: "AWS",
	bgp: "BGP",
	bios: "BIOS",
	bpf: "BPF",
	"c#": "C#",
	"c++": "C++",
	cfg: "CFG",
	cfi: "CFI",
	cli: "CLI",
	cmos: "CMOS",
	cnn: "CNN",
	coq: "Coq",
	cors: "CORS",
	cot: "CoT",
	cpg: "CPG",
	cps: "CPS",
	cpu: "CPU",
	crdt: "CRDT",
	csrf: "CSRF",
	css: "CSS",
	ctl: "CTL",
	cuda: "CUDA",
	cve: "CVE",
	cvss: "CVSS",
	cwe: "CWE",
	dag: "DAG",
	dao: "DAO",
	dast: "DAST",
	ddos: "DDoS",
	defi: "DeFi",
	devops: "DevOps",
	dns: "DNS",
	dom: "DOM",
	dos: "DoS",
	dpo: "DPO",
	dram: "DRAM",
	drl: "DRL",
	dsl: "DSL",
	dtls: "DTLS",
	ebpf: "eBPF",
	ecc: "ECC",
	ecdsa: "ECDSA",
	edr: "EDR",
	evm: "EVM",
	"f#": "F#",
	faas: "FaaS",
	fhe: "FHE",
	foss: "FOSS",
	fpga: "FPGA",
	gan: "GAN",
	gat: "GAT",
	gcn: "GCN",
	genai: "GenAI",
	github: "GitHub",
	gitlab: "GitLab",
	gnn: "GNN",
	gpu: "GPU",
	graphql: "GraphQL",
	grpc: "gRPC",
	grpo: "GRPO",
	gui: "GUI",
	hdfs: "HDFS",
	hls: "HLS",
	hsm: "HSM",
	hsts: "HSTS",
	html: "HTML",
	http: "HTTP",
	https: "HTTPS",
	iaas: "IaaS",
	iast: "IAST",
	icl: "ICL",
	ide: "IDE",
	ids: "IDS",
	iiot: "IIoT",
	ios: "iOS",
	iot: "IoT",
	ipfs: "IPFS",
	ips: "IPS",
	ir: "IR",
	isa: "ISA",
	javascript: "JavaScript",
	jit: "JIT",
	json: "JSON",
	jvm: "JVM",
	k8s: "K8s",
	ldp: "LDP",
	llm: "LLM",
	llvm: "LLVM",
	lora: "LoRA",
	lstm: "LSTM",
	ltl: "LTL",
	lvlm: "LVLM",
	macos: "macOS",
	marl: "MARL",
	mcp: "MCP",
	mips: "MIPS",
	mllm: "MLLM",
	mlops: "MLOps",
	moe: "MoE",
	mongodb: "MongoDB",
	mpc: "MPC",
	mpi: "MPI",
	mpls: "MPLS",
	mtls: "mTLS",
	mysql: "MySQL",
	nft: "NFT",
	nids: "NIDS",
	nlp: "NLP",
	nodejs: "Node.js",
	npu: "NPU",
	nvme: "NVMe",
	ocr: "OCR",
	openmp: "OpenMP",
	openssl: "OpenSSL",
	os: "OS",
	oss: "OSS",
	paas: "PaaS",
	pdg: "PDG",
	peft: "PEFT",
	pki: "PKI",
	plc: "PLC",
	postgresql: "PostgreSQL",
	ppml: "PPML",
	ppo: "PPO",
	pqc: "PQC",
	pytorch: "PyTorch",
	qbf: "QBF",
	qkd: "QKD",
	qlora: "QLoRA",
	qos: "QoS",
	quic: "QUIC",
	rag: "RAG",
	rasp: "RASP",
	rca: "RCA",
	rce: "RCE",
	rest: "REST",
	risc: "RISC",
	rl: "RL",
	rlhf: "RLHF",
	rnn: "RNN",
	rop: "ROP",
	rpc: "RPC",
	rsa: "RSA",
	rtl: "RTL",
	rtos: "RTOS",
	saas: "SaaS",
	sast: "SAST",
	sat: "SAT",
	sbom: "SBOM",
	sbst: "SBST",
	sdk: "SDK",
	secops: "SecOps",
	sev: "SEV",
	sft: "SFT",
	sgx: "SGX",
	siem: "SIEM",
	simd: "SIMD",
	slm: "SLM",
	smpc: "SMPC",
	smt: "SMT",
	soc: "SoC",
	sql: "SQL",
	sqli: "SQLi",
	sqlite: "SQLite",
	sram: "SRAM",
	ssa: "SSA",
	ssl: "SSL",
	ssrf: "SSRF",
	swe: "SWE",
	tcp: "TCP",
	tdx: "TDX",
	tee: "TEE",
	tensorflow: "TensorFlow",
	"tla+": "TLA+",
	tls: "TLS",
	tpm: "TPM",
	tpu: "TPU",
	typescript: "TypeScript",
	uav: "UAV",
	udp: "UDP",
	ui: "UI",
	url: "URL",
	ux: "UX",
	vae: "VAE",
	vllm: "vLLM",
	vlm: "VLM",
	vm: "VM",
	vpn: "VPN",
	vram: "VRAM",
	waf: "WAF",
	wasm: "Wasm",
	webassembly: "WebAssembly",
	webrtc: "WebRTC",
	x86: "x86",
	xai: "XAI",
	xml: "XML",
	xss: "XSS",
	yaml: "YAML",
	zkp: "ZKP",
	zksnark: "zkSNARK",
	zkstark: "zkSTARK",
};

const ARXIV_CATEGORY_CODE_RE =
	/^(?:cs|stat|math|eess|physics|q-bio|q-fin|econ|astro-ph|cond-mat|gr-qc|hep-[a-z]+|nlin|nucl-[a-z]+|quant-ph)(?:\.[a-z-]+)?$/i;

const UNICODE_DASH_RE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
const WRAPPER_PUNCT_CHARS = new Set(['"', "'", "`", ",", ";", ":", "."]);

function stripLeadingKeywordPrefix(s: string): string {
	return s.replace(/^(?:keywords?|index\s+terms?)\s*[:：-]\s*/i, "").trim();
}

function unwrapOuterBrackets(s: string): string {
	if (s.length >= 4) {
		if (
			(s.startsWith("(") && s.endsWith(")") && !s.slice(1, -1).includes(")")) ||
			(s.startsWith("[") && s.endsWith("]") && !s.slice(1, -1).includes("]")) ||
			(s.startsWith("{") && s.endsWith("}") && !s.slice(1, -1).includes("}"))
		) {
			return s.slice(1, -1).trim();
		}
	}
	return s;
}

function stripWrapperPunctuation(s: string): string {
	let start = 0;
	let end = s.length;
	while (start < end && WRAPPER_PUNCT_CHARS.has(s[start] ?? "")) {
		start += 1;
	}
	while (end > start && WRAPPER_PUNCT_CHARS.has(s[end - 1] ?? "")) {
		end -= 1;
	}
	return s.slice(start, end).trim();
}

function stripTrailingParentheticalAcronym(s: string): string {
	if (!s.endsWith(")")) return s;
	const openIdx = s.lastIndexOf(" (");
	if (openIdx < 4) return s;
	const inner = s.slice(openIdx + 2, -1);
	if (
		inner.length >= 2 &&
		inner.length <= 12 &&
		/^[A-Za-z0-9/+&-]+$/.test(inner)
	) {
		return s.slice(0, openIdx).trim();
	}
	return s;
}

/**
 * Clean raw surface whitespace, Unicode dashes, wrapper punctuation, and trailing `(ACRONYM)`.
 */
export function cleanKeywordSurface(raw: string): string {
	let s = raw.replace(UNICODE_DASH_RE, "-").replace(/\s+/g, " ").trim();
	if (!s) return "";
	s = stripLeadingKeywordPrefix(s);
	s = unwrapOuterBrackets(s);
	s = stripWrapperPunctuation(s);
	s = stripTrailingParentheticalAcronym(s);
	s = stripWrapperPunctuation(s);
	return s;
}

function hasAsciiAlpha(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
			return true;
		}
	}
	return false;
}

function hasStandaloneYear(s: string): boolean {
	const tokens = s.split(/[^A-Za-z0-9]+/);
	for (const tok of tokens) {
		if (
			tok.length === 4 &&
			(tok.startsWith("19") || tok.startsWith("20")) &&
			/^\d{4}$/.test(tok)
		) {
			return true;
		}
	}
	return false;
}

function isRejectedCleanedSurface(cleaned: string): boolean {
	const charLen = [...cleaned].length;
	if (charLen < 2 || charLen > 48) return true;
	if (!hasAsciiAlpha(cleaned)) return true;
	if (
		cleaned.includes("->") ||
		cleaned.includes("→") ||
		cleaned.includes(">")
	) {
		return true;
	}
	if (hasStandaloneYear(cleaned)) return true;
	if (ARXIV_CATEGORY_CODE_RE.test(cleaned)) return true;
	if (cleaned.split(" ").length > 6) return true;
	if (NON_KEYWORD_STOPLIST.has(cleaned.toLowerCase())) return true;
	return false;
}

/**
 * Conservative English head-noun singularizer tailored for CS/SE/CR/AI terminology.
 */
export function singularizeKeywordToken(wordLower: string): string {
	const irregular = IRREGULAR_PLURALS[wordLower];
	if (irregular) return irregular;
	if (wordLower.length <= 3 || INVARIANT_WORDS.has(wordLower)) {
		return wordLower;
	}
	for (const suffix of INVARIANT_SUFFIXES) {
		if (wordLower.endsWith(suffix)) return wordLower;
	}
	if (wordLower.endsWith("ies") && wordLower.length > 4) {
		const before = wordLower[wordLower.length - 4] ?? "";
		if (!"aeiou".includes(before)) {
			return `${wordLower.slice(0, -3)}y`;
		}
	}
	for (const suffix of ES_PLURAL_SUFFIXES) {
		if (wordLower.endsWith(suffix)) {
			return wordLower.slice(0, -2);
		}
	}
	if (wordLower.endsWith("s")) {
		return wordLower.slice(0, -1);
	}
	return wordLower;
}

/**
 * Build a de-hyphenated, singularized lowercase lookup key for synonym matching.
 */
export function buildKeywordLookupKey(raw: string): string {
	const cleaned = cleanKeywordSurface(raw);
	if (!cleaned) return "";
	const collapsed = cleaned
		.toLowerCase()
		.replace(/[-_]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!collapsed) return "";
	const tokens = collapsed.split(" ");
	const lastIdx = tokens.length - 1;
	tokens[lastIdx] = singularizeKeywordToken(tokens[lastIdx] ?? "");
	return tokens.join(" ");
}

function buildSynonymMap(): ReadonlyMap<string, string> {
	const map = new Map<string, string>();
	for (const group of SYNONYM_GROUPS) {
		const canonKey = buildKeywordLookupKey(group.canonical);
		if (canonKey) {
			map.set(canonKey, group.canonical);
		}
		for (const alias of group.aliases) {
			const aliasKey = buildKeywordLookupKey(alias);
			if (aliasKey) {
				map.set(aliasKey, group.canonical);
			}
		}
	}
	return map;
}

/** Lookup map from `buildKeywordLookupKey(term)` to its canonical display keyword. */
export const KEYWORD_SYNONYM_MAP: ReadonlyMap<string, string> =
	buildSynonymMap();

function isAllAsciiUpperAlphaNum(seg: string): boolean {
	let alphaCount = 0;
	for (let i = 0; i < seg.length; i++) {
		const c = seg.charCodeAt(i);
		if (c >= 65 && c <= 90) {
			alphaCount += 1;
		} else if (c >= 97 && c <= 122) {
			return false;
		}
	}
	return alphaCount >= 2;
}

function isPluralizedAcronym(seg: string): boolean {
	if (seg.length < 3 || !seg.endsWith("s")) return false;
	return isAllAsciiUpperAlphaNum(seg.slice(0, -1));
}

function hasInternalMixedCase(seg: string): boolean {
	let hasLower = false;
	let hasInternalUpper = false;
	for (let i = 0; i < seg.length; i++) {
		const c = seg.charCodeAt(i);
		if (c >= 97 && c <= 122) {
			hasLower = true;
		} else if (i > 0 && c >= 65 && c <= 90) {
			hasInternalUpper = true;
		}
	}
	return hasLower && hasInternalUpper;
}

function capitalizeAsciiWord(wordLower: string): string {
	for (let i = 0; i < wordLower.length; i++) {
		const c = wordLower.charCodeAt(i);
		if (c >= 97 && c <= 122) {
			return (
				wordLower.slice(0, i) +
				String.fromCharCode(c - 32) +
				wordLower.slice(i + 1)
			);
		}
		if (c >= 65 && c <= 90) {
			return wordLower;
		}
	}
	return wordLower;
}

function formatSubSegment(
	rawSeg: string,
	isFirstTokenInPhrase: boolean,
	isFinalSegmentInPhrase: boolean,
): string {
	if (!rawSeg) return rawSeg;

	if (isFinalSegmentInPhrase && isPluralizedAcronym(rawSeg)) {
		const stem = rawSeg.slice(0, -1);
		const mapped = CANONICAL_TOKEN_CASING[stem.toLowerCase()];
		return mapped ?? stem;
	}

	const rawLower = rawSeg.toLowerCase();
	const preserveOriginalSurface =
		isAllAsciiUpperAlphaNum(rawSeg) || hasInternalMixedCase(rawSeg);

	const targetLower =
		isFinalSegmentInPhrase && !preserveOriginalSurface
			? singularizeKeywordToken(rawLower)
			: rawLower;

	const canonicalToken = CANONICAL_TOKEN_CASING[targetLower];
	if (canonicalToken) {
		return canonicalToken;
	}

	if (preserveOriginalSurface && targetLower === rawLower) {
		if (isAllAsciiUpperAlphaNum(rawSeg) && rawSeg.length > 6) {
			return capitalizeAsciiWord(rawLower);
		}
		return rawSeg;
	}

	if (!isFirstTokenInPhrase && MINOR_TITLE_WORDS.has(targetLower)) {
		return targetLower;
	}

	return capitalizeAsciiWord(targetLower);
}

function formatOpenVocabularyKeyword(cleaned: string): string {
	const words = cleaned.split(" ");
	const formattedWords: string[] = [];

	for (let wIdx = 0; wIdx < words.length; wIdx++) {
		const word = words[wIdx] ?? "";
		const slashCanonical = CANONICAL_SLASH_TOKENS[word.toLowerCase()];
		if (slashCanonical) {
			formattedWords.push(slashCanonical);
			continue;
		}

		const parts: string[] = [];
		const delims: string[] = [];
		let start = 0;
		for (let i = 0; i < word.length; i++) {
			const ch = word[i];
			if (ch === "-" || ch === "/") {
				parts.push(word.slice(start, i));
				delims.push(ch);
				start = i + 1;
			}
		}
		parts.push(word.slice(start));

		let rebuilt = "";
		for (let pIdx = 0; pIdx < parts.length; pIdx++) {
			const seg = parts[pIdx] ?? "";
			const isFirst = wIdx === 0 && pIdx === 0;
			const isFinal = wIdx === words.length - 1 && pIdx === parts.length - 1;
			rebuilt += formatSubSegment(seg, isFirst, isFinal);
			if (pIdx < delims.length) {
				rebuilt += delims[pIdx];
			}
		}
		formattedWords.push(rebuilt);
	}

	return formattedWords.join(" ");
}

/**
 * Canonicalize a single raw academic keyword into its canonical English Title Case
 * singular form, or return `null` if it is empty, invalid, or non-keyword noise.
 */
export function canonicalizePaperKeyword(raw: string): string | null {
	if (typeof raw !== "string") return null;
	const cleaned = cleanKeywordSurface(raw);
	if (!cleaned || isRejectedCleanedSurface(cleaned)) {
		return null;
	}

	const lookupKey = buildKeywordLookupKey(cleaned);
	if (!lookupKey || NON_KEYWORD_STOPLIST.has(lookupKey)) {
		return null;
	}

	const mapped = KEYWORD_SYNONYM_MAP.get(lookupKey);
	if (mapped) {
		return mapped;
	}

	return formatOpenVocabularyKeyword(cleaned);
}

/**
 * Return the canonical lowercase deduplication key for any keyword or query chip.
 * Synonyms map to the same key (e.g., `"Defect Detection"` -> `"vulnerability detection"`).
 */
export function normalizeKeywordKey(raw: string): string {
	const canonical = canonicalizePaperKeyword(raw);
	if (canonical) {
		return canonical.toLowerCase();
	}
	return cleanKeywordSurface(raw).toLowerCase();
}

/**
 * Canonicalize, filter, and deduplicate a list of raw keyword strings (splitting `;` / `\n`).
 */
export function canonicalizePaperKeywords(
	upstreamKeywords?: readonly string[] | null,
	maxCount = 8,
): string[] {
	if (!upstreamKeywords || upstreamKeywords.length === 0 || maxCount <= 0) {
		return [];
	}
	const result: string[] = [];
	const seen = new Set<string>();

	for (const rawEntry of upstreamKeywords) {
		if (typeof rawEntry !== "string") continue;
		const segments = stripLeadingKeywordPrefix(rawEntry).split(/[;\n]+/);
		for (const seg of segments) {
			const canonical = canonicalizePaperKeyword(seg);
			if (!canonical) continue;
			const key = canonical.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(canonical);
			if (result.length >= maxCount) {
				return result;
			}
		}
	}

	return result;
}
