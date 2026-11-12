//! Canonical academic keyword normalization and shared-word synonym taxonomy
//! for Plaza (`cs.SE`, `cs.CR`, `cs.PL`, and 28 CCF-A/B PL/SE, Security, and AI venues).
//!
//! Pure zero-dependency module mirroring TypeScript `src/lib/plaza/keyword-synonyms.ts` 1-to-1.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use super::recommend::casing_quality;

#[derive(Debug, Clone, Copy)]
pub struct KeywordSynonymGroup {
    pub canonical: &'static str,
    pub aliases: &'static [&'static str],
}

/// High-precision academic synonym groups across PL/SE, Security/CR, and AI.
///
/// Design invariants:
/// - Only merge true synonyms and shared-word equivalent categories (e.g.,
///   `Defect Detection` = `Bug Detection` = `Vulnerability Detection`;
///   `AI Agent` = `LLM Agent` = `Agent` = `Autonomous Agent`).
/// - Keep distinct subfields and distinct techniques separate (e.g., `Code Generation`,
///   `Program Synthesis`, `Fuzzing`, `Directed Fuzzing`, `Random Testing`,
///   `Unit Test Generation`, `Test Generation`, `Symbolic Execution`,
///   `Concolic Execution`, `Defect Prediction` remain distinct).
/// - Avoid ambiguous cross-domain acronyms (`DP`, `MPC`, `CPS`, `CFG`).
pub const SYNONYM_GROUPS: &[KeywordSynonymGroup] = &[
    // 1. Vulnerability / Defect / Bug / Fault & Security Testing (SE + CR)
    KeywordSynonymGroup {
        canonical: "Vulnerability Detection",
        aliases: &[
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
    KeywordSynonymGroup {
        canonical: "Defect Prediction",
        aliases: &[
            "Software Defect Prediction",
            "Bug Prediction",
            "Software Bug Prediction",
            "Fault Prediction",
            "Software Fault Prediction",
        ],
    },
    KeywordSynonymGroup {
        canonical: "Just-in-Time Defect Prediction",
        aliases: &["JIT Defect Prediction"],
    },
    KeywordSynonymGroup {
        canonical: "Fault Localization",
        aliases: &[
            "Fault Location",
            "Bug Localization",
            "Defect Localization",
            "Software Fault Localization",
            "Automated Fault Localization",
            "Program Fault Localization",
        ],
    },
    KeywordSynonymGroup {
        canonical: "Root Cause Analysis",
        aliases: &[
            "Root Cause Localization",
            "Root Cause Identification",
            "Root Cause Diagnosis",
            "RCA",
        ],
    },
    KeywordSynonymGroup {
        canonical: "Vulnerability Repair",
        aliases: &[
            "Automated Vulnerability Repair",
            "Automatic Vulnerability Repair",
            "Vulnerability Patching",
            "Automated Vulnerability Patching",
            "Security Patch Generation",
        ],
    },
    // 2. AI Agents & Multi-Agent Systems (AI + SE + CR)
    KeywordSynonymGroup {
        canonical: "AI Agent",
        aliases: &[
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
    KeywordSynonymGroup {
        canonical: "Coding Agent",
        aliases: &[
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
    KeywordSynonymGroup {
        canonical: "Multi-Agent System",
        aliases: &[
            "Multi-Agent",
            "Multiagent System",
            "Multi-Agent LLM System",
            "Multi-Agent Framework",
            "Multi-Agent AI",
            "LLM Multi-Agent System",
        ],
    },
    KeywordSynonymGroup {
        canonical: "AI Agent Security",
        aliases: &[
            "Agent Security",
            "LLM Agent Security",
            "Autonomous Agent Security",
            "Agentic AI Security",
        ],
    },
    KeywordSynonymGroup {
        canonical: "AI Agent Safety",
        aliases: &["Agent Safety", "LLM Agent Safety", "Agentic Safety"],
    },
    KeywordSynonymGroup {
        canonical: "Model Context Protocol",
        aliases: &["MCP"],
    },
    // 3. Software Testing, Fuzzing, Program Analysis & Repair (PL/SE)
    KeywordSynonymGroup {
        canonical: "Fuzzing",
        aliases: &["Fuzz Testing", "Software Fuzzing", "Fuzzer"],
    },
    KeywordSynonymGroup {
        canonical: "Greybox Fuzzing",
        aliases: &["Grey-Box Fuzzing", "Graybox Fuzzing", "Gray-Box Fuzzing"],
    },
    KeywordSynonymGroup {
        canonical: "Black-Box Fuzzing",
        aliases: &["Blackbox Fuzzing"],
    },
    KeywordSynonymGroup {
        canonical: "Program Repair",
        aliases: &[
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
    KeywordSynonymGroup {
        canonical: "Static Analysis",
        aliases: &[
            "Static Program Analysis",
            "Static Code Analysis",
            "Source Code Static Analysis",
        ],
    },
    KeywordSynonymGroup {
        canonical: "Dynamic Analysis",
        aliases: &["Dynamic Program Analysis"],
    },
    KeywordSynonymGroup {
        canonical: "Taint Analysis",
        aliases: &["Taint Tracking"],
    },
    KeywordSynonymGroup {
        canonical: "Symbolic Execution",
        aliases: &["Symbolic Program Execution"],
    },
    KeywordSynonymGroup {
        canonical: "Concolic Execution",
        aliases: &["Dynamic Symbolic Execution"],
    },
    KeywordSynonymGroup {
        canonical: "Formal Verification",
        aliases: &[
            "Formal Methods",
            "Formal Software Verification",
            "Mechanized Verification",
        ],
    },
    KeywordSynonymGroup {
        canonical: "Code Generation",
        aliases: &[
            "Automatic Code Generation",
            "Automated Code Generation",
            "LLM-Based Code Generation",
            "LLM Code Generation",
            "AI-Assisted Code Generation",
            "AI Code Generation",
            "Source Code Generation",
        ],
    },
    KeywordSynonymGroup {
        canonical: "Test Generation",
        aliases: &[
            "Test Case Generation",
            "Automated Test Generation",
            "Automatic Test Generation",
            "Test Suite Generation",
            "LLM-Based Test Generation",
            "Automated Test Case Generation",
        ],
    },
    KeywordSynonymGroup {
        canonical: "Unit Test Generation",
        aliases: &[
            "Automated Unit Test Generation",
            "Automatic Unit Test Generation",
        ],
    },
    KeywordSynonymGroup {
        canonical: "Search-Based Software Testing",
        aliases: &["Search-Based Testing", "SBST"],
    },
    KeywordSynonymGroup {
        canonical: "Code Review",
        aliases: &[
            "Automated Code Review",
            "Modern Code Review",
            "AI-Assisted Code Review",
        ],
    },
    KeywordSynonymGroup {
        canonical: "Code Clone Detection",
        aliases: &["Clone Detection", "Software Clone Detection", "Code Clone"],
    },
    KeywordSynonymGroup {
        canonical: "Code Smell",
        aliases: &["Software Code Smell", "Bad Smell"],
    },
    KeywordSynonymGroup {
        canonical: "Software Maintenance",
        aliases: &[
            "Software Maintainability",
            "Maintenance Engineering",
            "Software Maintenance and Evolution",
        ],
    },
    KeywordSynonymGroup {
        canonical: "AI-Assisted Software Development",
        aliases: &[
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
    KeywordSynonymGroup {
        canonical: "Type System",
        aliases: &["Static Type System"],
    },
    KeywordSynonymGroup {
        canonical: "Domain-Specific Language",
        aliases: &["DSL"],
    },
    KeywordSynonymGroup {
        canonical: "Control-Flow Graph",
        aliases: &["Control Flow Graph"],
    },
    KeywordSynonymGroup {
        canonical: "Abstract Syntax Tree",
        aliases: &["AST"],
    },
    KeywordSynonymGroup {
        canonical: "Program Dependence Graph",
        aliases: &["PDG"],
    },
    KeywordSynonymGroup {
        canonical: "Code Property Graph",
        aliases: &["CPG"],
    },
    KeywordSynonymGroup {
        canonical: "Intermediate Representation",
        aliases: &["Compiler IR"],
    },
    KeywordSynonymGroup {
        canonical: "Satisfiability Modulo Theories",
        aliases: &["SMT", "SMT Solving", "SMT Solver"],
    },
    KeywordSynonymGroup {
        canonical: "Boolean Satisfiability",
        aliases: &["SAT Solving", "SAT Solver"],
    },
    KeywordSynonymGroup {
        canonical: "WebAssembly",
        aliases: &["Wasm"],
    },
    KeywordSynonymGroup {
        canonical: "Microservices",
        aliases: &["Microservice", "Microservice Architecture"],
    },
    KeywordSynonymGroup {
        canonical: "Integrated Development Environment",
        aliases: &["IDE"],
    },
    KeywordSynonymGroup {
        canonical: "Application Programming Interface",
        aliases: &["API"],
    },
    // 5. Security, Cryptography & Privacy (CR)
    KeywordSynonymGroup {
        canonical: "LLM Security",
        aliases: &["Large Language Model Security", "Language Model Security"],
    },
    KeywordSynonymGroup {
        canonical: "LLM Safety",
        aliases: &["Large Language Model Safety", "Language Model Safety"],
    },
    KeywordSynonymGroup {
        canonical: "Prompt Injection",
        aliases: &["Prompt Injection Attack"],
    },
    KeywordSynonymGroup {
        canonical: "Jailbreak Attack",
        aliases: &[
            "Jailbreaking",
            "LLM Jailbreak",
            "LLM Jailbreaking",
            "Jailbreak",
        ],
    },
    KeywordSynonymGroup {
        canonical: "Backdoor Attack",
        aliases: &["Trojan Attack", "Neural Backdoor"],
    },
    KeywordSynonymGroup {
        canonical: "Black-Box Attack",
        aliases: &["Blackbox Attack"],
    },
    KeywordSynonymGroup {
        canonical: "White-Box Attack",
        aliases: &["Whitebox Attack"],
    },
    KeywordSynonymGroup {
        canonical: "Side-Channel Attack",
        aliases: &["Side Channel Attack"],
    },
    KeywordSynonymGroup {
        canonical: "Side-Channel Analysis",
        aliases: &["Side Channel Analysis"],
    },
    KeywordSynonymGroup {
        canonical: "Membership Inference Attack",
        aliases: &["Membership Inference", "MIA"],
    },
    KeywordSynonymGroup {
        canonical: "Data Poisoning",
        aliases: &["Data Poisoning Attack", "Training Data Poisoning"],
    },
    KeywordSynonymGroup {
        canonical: "Zero-Knowledge Proof",
        aliases: &["ZKP", "Zero-Knowledge"],
    },
    KeywordSynonymGroup {
        canonical: "Fully Homomorphic Encryption",
        aliases: &["FHE"],
    },
    KeywordSynonymGroup {
        canonical: "Post-Quantum Cryptography",
        aliases: &[
            "PQC",
            "Quantum-Resistant Cryptography",
            "Quantum-Safe Cryptography",
        ],
    },
    KeywordSynonymGroup {
        canonical: "Secure Multi-Party Computation",
        aliases: &[
            "Secure Multiparty Computation",
            "Multi-Party Computation",
            "Multiparty Computation",
            "SMPC",
        ],
    },
    KeywordSynonymGroup {
        canonical: "Trusted Execution Environment",
        aliases: &["TEE"],
    },
    KeywordSynonymGroup {
        canonical: "Differential Privacy",
        aliases: &["Differential Privacy Mechanism"],
    },
    KeywordSynonymGroup {
        canonical: "Local Differential Privacy",
        aliases: &["LDP"],
    },
    KeywordSynonymGroup {
        canonical: "Privacy-Preserving Machine Learning",
        aliases: &["PPML"],
    },
    KeywordSynonymGroup {
        canonical: "Privacy-Utility Trade-Off",
        aliases: &["Privacy Utility Trade Off"],
    },
    KeywordSynonymGroup {
        canonical: "Intrusion Detection",
        aliases: &["Intrusion Detection System", "IDS"],
    },
    KeywordSynonymGroup {
        canonical: "Network Intrusion Detection",
        aliases: &["Network Intrusion Detection System", "NIDS"],
    },
    KeywordSynonymGroup {
        canonical: "Software Supply Chain Security",
        aliases: &["Supply Chain Security"],
    },
    KeywordSynonymGroup {
        canonical: "Software Bill of Materials",
        aliases: &["SBOM"],
    },
    KeywordSynonymGroup {
        canonical: "Control-Flow Integrity",
        aliases: &["CFI"],
    },
    KeywordSynonymGroup {
        canonical: "Cross-Site Scripting",
        aliases: &["XSS"],
    },
    KeywordSynonymGroup {
        canonical: "SQL Injection",
        aliases: &["SQLi"],
    },
    KeywordSynonymGroup {
        canonical: "Denial-of-Service Attack",
        aliases: &["Denial of Service", "Denial-of-Service", "DoS Attack"],
    },
    KeywordSynonymGroup {
        canonical: "Distributed Denial-of-Service",
        aliases: &["DDoS", "DDoS Attack", "Distributed Denial of Service"],
    },
    KeywordSynonymGroup {
        canonical: "Smart Contract",
        aliases: &["Blockchain Smart Contract"],
    },
    KeywordSynonymGroup {
        canonical: "Decentralized Finance",
        aliases: &["DeFi"],
    },
    KeywordSynonymGroup {
        canonical: "Internet of Things",
        aliases: &["IoT"],
    },
    KeywordSynonymGroup {
        canonical: "Internet of Things Security",
        aliases: &["IoT Security"],
    },
    KeywordSynonymGroup {
        canonical: "Cyber-Physical System",
        aliases: &["Cyber Physical System"],
    },
    KeywordSynonymGroup {
        canonical: "Static Application Security Testing",
        aliases: &["SAST"],
    },
    // 6. AI / Machine Learning / NLP Core Concepts (AI)
    KeywordSynonymGroup {
        canonical: "Large Language Model",
        aliases: &["LLM"],
    },
    KeywordSynonymGroup {
        canonical: "Small Language Model",
        aliases: &["SLM"],
    },
    KeywordSynonymGroup {
        canonical: "Vision-Language Model",
        aliases: &["VLM", "Large Vision-Language Model", "LVLM"],
    },
    KeywordSynonymGroup {
        canonical: "Multimodal Large Language Model",
        aliases: &["MLLM"],
    },
    KeywordSynonymGroup {
        canonical: "Code Large Language Model",
        aliases: &["Code LLM", "Code Language Model"],
    },
    KeywordSynonymGroup {
        canonical: "Retrieval-Augmented Generation",
        aliases: &["RAG"],
    },
    KeywordSynonymGroup {
        canonical: "Chain-of-Thought Prompting",
        aliases: &[
            "Chain-of-Thought",
            "CoT",
            "CoT Prompting",
            "Chain-of-Thought Reasoning",
        ],
    },
    KeywordSynonymGroup {
        canonical: "Zero-Shot Prompting",
        aliases: &["Zero Shot Prompting"],
    },
    KeywordSynonymGroup {
        canonical: "Few-Shot Prompting",
        aliases: &["Few Shot Prompting"],
    },
    KeywordSynonymGroup {
        canonical: "Few-Shot Learning",
        aliases: &["Few Shot Learning", "FSL"],
    },
    KeywordSynonymGroup {
        canonical: "Zero-Shot Learning",
        aliases: &["Zero Shot Learning", "ZSL"],
    },
    KeywordSynonymGroup {
        canonical: "Reinforcement Learning from Human Feedback",
        aliases: &["RLHF"],
    },
    KeywordSynonymGroup {
        canonical: "Direct Preference Optimization",
        aliases: &["DPO"],
    },
    KeywordSynonymGroup {
        canonical: "Parameter-Efficient Fine-Tuning",
        aliases: &["PEFT"],
    },
    KeywordSynonymGroup {
        canonical: "Low-Rank Adaptation",
        aliases: &["LoRA"],
    },
    KeywordSynonymGroup {
        canonical: "Supervised Fine-Tuning",
        aliases: &["SFT"],
    },
    KeywordSynonymGroup {
        canonical: "Fine-Tuning",
        aliases: &[
            "Model Fine-Tuning",
            "LLM Fine-Tuning",
            "Language Model Fine-Tuning",
        ],
    },
    KeywordSynonymGroup {
        canonical: "In-Context Learning",
        aliases: &["ICL"],
    },
    KeywordSynonymGroup {
        canonical: "Graph Neural Network",
        aliases: &["GNN"],
    },
    KeywordSynonymGroup {
        canonical: "Convolutional Neural Network",
        aliases: &["CNN"],
    },
    KeywordSynonymGroup {
        canonical: "Generative Adversarial Network",
        aliases: &["GAN"],
    },
    KeywordSynonymGroup {
        canonical: "Deep Reinforcement Learning",
        aliases: &["DRL"],
    },
    KeywordSynonymGroup {
        canonical: "Multi-Agent Reinforcement Learning",
        aliases: &["MARL"],
    },
    KeywordSynonymGroup {
        canonical: "Explainable AI",
        aliases: &["Explainable Artificial Intelligence", "XAI"],
    },
    KeywordSynonymGroup {
        canonical: "Generative AI",
        aliases: &["Generative Artificial Intelligence", "GenAI"],
    },
    KeywordSynonymGroup {
        canonical: "LLM-as-a-Judge",
        aliases: &["LLM as a Judge"],
    },
    KeywordSynonymGroup {
        canonical: "Hallucination",
        aliases: &["LLM Hallucination", "Model Hallucination"],
    },
    KeywordSynonymGroup {
        canonical: "Open-Source Software",
        aliases: &[
            "Open Source Software",
            "OSS",
            "FOSS",
            "Free and Open-Source Software",
        ],
    },
];

const NON_KEYWORD_STOPLIST_RAW: &[&str] = &[
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
];

const IRREGULAR_PLURALS_RAW: &[(&str, &str)] = &[
    ("analyses", "analysis"),
    ("syntheses", "synthesis"),
    ("hypotheses", "hypothesis"),
    ("diagnoses", "diagnosis"),
    ("theses", "thesis"),
    ("crises", "crisis"),
    ("matrices", "matrix"),
    ("vertices", "vertex"),
    ("indices", "index"),
    ("indexes", "index"),
    ("appendices", "appendix"),
    ("codices", "codex"),
    ("cookies", "cookie"),
    ("zombies", "zombie"),
    ("caches", "cache"),
    ("niches", "niche"),
    ("avalanches", "avalanche"),
    ("leaves", "leaf"),
    ("halves", "half"),
    ("buses", "bus"),
    ("gases", "gas"),
    ("biases", "bias"),
    ("aliases", "alias"),
    ("campuses", "campus"),
    ("viruses", "virus"),
    ("corpora", "corpus"),
];

const INVARIANT_WORDS_RAW: &[&str] = &[
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
];

const INVARIANT_SUFFIXES: &[&str] = &["ss", "us", "is", "os", "ics", "aas", "ias", "eas"];

const ES_PLURAL_SUFFIXES: &[&str] = &[
    "sses", "xes", "zes", "tches", "nches", "rches", "eaches", "oaches", "shes",
];

const MINOR_TITLE_WORDS_RAW: &[&str] = &[
    "a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to",
    "via", "vs", "with",
];

const CANONICAL_SLASH_TOKENS_RAW: &[(&str, &str)] = &[
    ("c/c++", "C/C++"),
    ("ci/cd", "CI/CD"),
    ("i/o", "I/O"),
    ("tcp/ip", "TCP/IP"),
];

const CANONICAL_TOKEN_CASING_RAW: &[(&str, &str)] = &[
    ("abi", "ABI"),
    ("aes", "AES"),
    ("ai", "AI"),
    ("api", "API"),
    ("apr", "APR"),
    ("arm", "ARM"),
    ("asic", "ASIC"),
    ("aslr", "ASLR"),
    ("asr", "ASR"),
    ("ast", "AST"),
    ("aws", "AWS"),
    ("bgp", "BGP"),
    ("bios", "BIOS"),
    ("bpf", "BPF"),
    ("c#", "C#"),
    ("c++", "C++"),
    ("cfg", "CFG"),
    ("cfi", "CFI"),
    ("cli", "CLI"),
    ("cmos", "CMOS"),
    ("cnn", "CNN"),
    ("coq", "Coq"),
    ("cors", "CORS"),
    ("cot", "CoT"),
    ("cpg", "CPG"),
    ("cps", "CPS"),
    ("cpu", "CPU"),
    ("crdt", "CRDT"),
    ("csrf", "CSRF"),
    ("css", "CSS"),
    ("ctl", "CTL"),
    ("cuda", "CUDA"),
    ("cve", "CVE"),
    ("cvss", "CVSS"),
    ("cwe", "CWE"),
    ("dag", "DAG"),
    ("dao", "DAO"),
    ("dast", "DAST"),
    ("ddos", "DDoS"),
    ("defi", "DeFi"),
    ("devops", "DevOps"),
    ("dns", "DNS"),
    ("dom", "DOM"),
    ("dos", "DoS"),
    ("dpo", "DPO"),
    ("dram", "DRAM"),
    ("drl", "DRL"),
    ("dsl", "DSL"),
    ("dtls", "DTLS"),
    ("ebpf", "eBPF"),
    ("ecc", "ECC"),
    ("ecdsa", "ECDSA"),
    ("edr", "EDR"),
    ("evm", "EVM"),
    ("f#", "F#"),
    ("faas", "FaaS"),
    ("fhe", "FHE"),
    ("foss", "FOSS"),
    ("fpga", "FPGA"),
    ("gan", "GAN"),
    ("gat", "GAT"),
    ("gcn", "GCN"),
    ("genai", "GenAI"),
    ("github", "GitHub"),
    ("gitlab", "GitLab"),
    ("gnn", "GNN"),
    ("gpu", "GPU"),
    ("graphql", "GraphQL"),
    ("grpc", "gRPC"),
    ("grpo", "GRPO"),
    ("gui", "GUI"),
    ("hdfs", "HDFS"),
    ("hls", "HLS"),
    ("hsm", "HSM"),
    ("hsts", "HSTS"),
    ("html", "HTML"),
    ("http", "HTTP"),
    ("https", "HTTPS"),
    ("iaas", "IaaS"),
    ("iast", "IAST"),
    ("icl", "ICL"),
    ("ide", "IDE"),
    ("ids", "IDS"),
    ("iiot", "IIoT"),
    ("ios", "iOS"),
    ("iot", "IoT"),
    ("ipfs", "IPFS"),
    ("ips", "IPS"),
    ("ir", "IR"),
    ("isa", "ISA"),
    ("javascript", "JavaScript"),
    ("jit", "JIT"),
    ("json", "JSON"),
    ("jvm", "JVM"),
    ("k8s", "K8s"),
    ("ldp", "LDP"),
    ("llm", "LLM"),
    ("llvm", "LLVM"),
    ("lora", "LoRA"),
    ("lstm", "LSTM"),
    ("ltl", "LTL"),
    ("lvlm", "LVLM"),
    ("macos", "macOS"),
    ("marl", "MARL"),
    ("mcp", "MCP"),
    ("mips", "MIPS"),
    ("mllm", "MLLM"),
    ("mlops", "MLOps"),
    ("moe", "MoE"),
    ("mongodb", "MongoDB"),
    ("mpc", "MPC"),
    ("mpi", "MPI"),
    ("mpls", "MPLS"),
    ("mtls", "mTLS"),
    ("mysql", "MySQL"),
    ("nft", "NFT"),
    ("nids", "NIDS"),
    ("nlp", "NLP"),
    ("nodejs", "Node.js"),
    ("npu", "NPU"),
    ("nvme", "NVMe"),
    ("ocr", "OCR"),
    ("openmp", "OpenMP"),
    ("openssl", "OpenSSL"),
    ("os", "OS"),
    ("oss", "OSS"),
    ("paas", "PaaS"),
    ("pdg", "PDG"),
    ("peft", "PEFT"),
    ("pki", "PKI"),
    ("plc", "PLC"),
    ("postgresql", "PostgreSQL"),
    ("ppml", "PPML"),
    ("ppo", "PPO"),
    ("pqc", "PQC"),
    ("pytorch", "PyTorch"),
    ("qbf", "QBF"),
    ("qkd", "QKD"),
    ("qlora", "QLoRA"),
    ("qos", "QoS"),
    ("quic", "QUIC"),
    ("rag", "RAG"),
    ("rasp", "RASP"),
    ("rca", "RCA"),
    ("rce", "RCE"),
    ("rest", "REST"),
    ("risc", "RISC"),
    ("rl", "RL"),
    ("rlhf", "RLHF"),
    ("rnn", "RNN"),
    ("rop", "ROP"),
    ("rpc", "RPC"),
    ("rsa", "RSA"),
    ("rtl", "RTL"),
    ("rtos", "RTOS"),
    ("saas", "SaaS"),
    ("sast", "SAST"),
    ("sat", "SAT"),
    ("sbom", "SBOM"),
    ("sbst", "SBST"),
    ("sdk", "SDK"),
    ("secops", "SecOps"),
    ("sev", "SEV"),
    ("sft", "SFT"),
    ("sgx", "SGX"),
    ("siem", "SIEM"),
    ("simd", "SIMD"),
    ("slm", "SLM"),
    ("smpc", "SMPC"),
    ("smt", "SMT"),
    ("soc", "SoC"),
    ("sql", "SQL"),
    ("sqli", "SQLi"),
    ("sqlite", "SQLite"),
    ("sram", "SRAM"),
    ("ssa", "SSA"),
    ("ssl", "SSL"),
    ("ssrf", "SSRF"),
    ("swe", "SWE"),
    ("tcp", "TCP"),
    ("tdx", "TDX"),
    ("tee", "TEE"),
    ("tensorflow", "TensorFlow"),
    ("tla+", "TLA+"),
    ("tls", "TLS"),
    ("tpm", "TPM"),
    ("tpu", "TPU"),
    ("typescript", "TypeScript"),
    ("uav", "UAV"),
    ("udp", "UDP"),
    ("ui", "UI"),
    ("url", "URL"),
    ("ux", "UX"),
    ("vae", "VAE"),
    ("vllm", "vLLM"),
    ("vlm", "VLM"),
    ("vm", "VM"),
    ("vpn", "VPN"),
    ("vram", "VRAM"),
    ("waf", "WAF"),
    ("wasm", "Wasm"),
    ("webassembly", "WebAssembly"),
    ("webrtc", "WebRTC"),
    ("x86", "x86"),
    ("xai", "XAI"),
    ("xml", "XML"),
    ("xss", "XSS"),
    ("yaml", "YAML"),
    ("zkp", "ZKP"),
    ("zksnark", "zkSNARK"),
    ("zkstark", "zkSTARK"),
];

static NON_KEYWORD_STOPLIST: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| NON_KEYWORD_STOPLIST_RAW.iter().copied().collect());

static IRREGULAR_PLURALS: LazyLock<HashMap<&'static str, &'static str>> =
    LazyLock::new(|| IRREGULAR_PLURALS_RAW.iter().copied().collect());

static INVARIANT_WORDS: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| INVARIANT_WORDS_RAW.iter().copied().collect());

static MINOR_TITLE_WORDS: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| MINOR_TITLE_WORDS_RAW.iter().copied().collect());

static CANONICAL_SLASH_TOKENS: LazyLock<HashMap<&'static str, &'static str>> =
    LazyLock::new(|| CANONICAL_SLASH_TOKENS_RAW.iter().copied().collect());

static CANONICAL_TOKEN_CASING: LazyLock<HashMap<&'static str, &'static str>> =
    LazyLock::new(|| CANONICAL_TOKEN_CASING_RAW.iter().copied().collect());

pub static KEYWORD_SYNONYM_MAP: LazyLock<HashMap<String, &'static str>> = LazyLock::new(|| {
    let mut map = HashMap::new();
    for group in SYNONYM_GROUPS {
        let canon_key = build_keyword_lookup_key(group.canonical);
        if !canon_key.is_empty() {
            map.insert(canon_key, group.canonical);
        }
        for &alias in group.aliases {
            let alias_key = build_keyword_lookup_key(alias);
            if !alias_key.is_empty() {
                map.insert(alias_key, group.canonical);
            }
        }
    }
    map
});

fn is_js_whitespace(c: char) -> bool {
    c.is_whitespace() || c == '\u{FEFF}'
}

fn trim_js_ws(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

fn strip_ascii_prefix_ignore_case<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len()
        && s.is_char_boundary(prefix.len())
        && s[..prefix.len()].eq_ignore_ascii_case(prefix)
    {
        return Some(&s[prefix.len()..]);
    }
    None
}

/// Mirror `/^(?:keywords?|index\s+terms?)\s*[:：-]\s*/i` + `.trim()`.
pub(crate) fn strip_leading_keyword_prefix(s: &str) -> String {
    let after_head = if let Some(r) = strip_ascii_prefix_ignore_case(s, "keywords") {
        Some(r)
    } else if let Some(r) = strip_ascii_prefix_ignore_case(s, "keyword") {
        Some(r)
    } else if let Some(r) = strip_ascii_prefix_ignore_case(s, "index") {
        let trimmed_ws = r.trim_start_matches(is_js_whitespace);
        if trimmed_ws.len() < r.len() {
            strip_ascii_prefix_ignore_case(trimmed_ws, "terms")
                .or_else(|| strip_ascii_prefix_ignore_case(trimmed_ws, "term"))
        } else {
            None
        }
    } else {
        None
    };

    if let Some(rest) = after_head {
        let rest_ws = rest.trim_start_matches(is_js_whitespace);
        let mut chars = rest_ws.chars();
        if let Some(delim) = chars.next() {
            if matches!(delim, ':' | '：' | '-') {
                return trim_js_ws(chars.as_str()).to_string();
            }
        }
    }

    trim_js_ws(s).to_string()
}

fn unwrap_outer_brackets(s: &str) -> String {
    if s.chars().count() >= 4 {
        for (open, close) in [('(', ')'), ('[', ']'), ('{', '}')] {
            if s.starts_with(open) && s.ends_with(close) {
                let inner = &s[open.len_utf8()..s.len() - close.len_utf8()];
                if !inner.contains(close) {
                    return trim_js_ws(inner).to_string();
                }
            }
        }
    }
    s.to_string()
}

fn is_wrapper_punct(c: char) -> bool {
    matches!(c, '"' | '\'' | '`' | ',' | ';' | ':' | '.')
}

fn strip_wrapper_punctuation(s: &str) -> String {
    trim_js_ws(s.trim_matches(is_wrapper_punct)).to_string()
}

fn strip_trailing_parenthetical_acronym(s: &str) -> String {
    if !s.ends_with(')') {
        return s.to_string();
    }
    let Some(open_idx) = s.rfind(" (") else {
        return s.to_string();
    };
    if s[..open_idx].chars().count() < 4 {
        return s.to_string();
    }
    let inner = &s[open_idx + 2..s.len() - 1];
    if (2..=12).contains(&inner.len())
        && inner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'+' | b'&' | b'-'))
    {
        return trim_js_ws(&s[..open_idx]).to_string();
    }
    s.to_string()
}

/// Clean raw surface whitespace, Unicode dashes, wrapper punctuation, and trailing `(ACRONYM)`.
pub fn clean_keyword_surface(raw: &str) -> String {
    let dash_normalized: String = raw
        .chars()
        .map(|c| match c {
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            other => other,
        })
        .collect();
    let collapsed = dash_normalized
        .split(is_js_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.is_empty() {
        return String::new();
    }
    let s = strip_leading_keyword_prefix(&collapsed);
    let s = unwrap_outer_brackets(&s);
    let s = strip_wrapper_punctuation(&s);
    let s = strip_trailing_parenthetical_acronym(&s);
    strip_wrapper_punctuation(&s)
}

fn has_ascii_alpha(s: &str) -> bool {
    s.bytes().any(|b| b.is_ascii_alphabetic())
}

fn has_standalone_year(s: &str) -> bool {
    s.split(|c: char| !c.is_ascii_alphanumeric()).any(|tok| {
        tok.len() == 4
            && (tok.starts_with("19") || tok.starts_with("20"))
            && tok.bytes().all(|b| b.is_ascii_digit())
    })
}

/// Mirror `/^(?:cs|stat|math|eess|physics|q-bio|q-fin|econ|astro-ph|cond-mat|gr-qc|hep-[a-z]+|nlin|nucl-[a-z]+|quant-ph)(?:\.[a-z-]+)?$/i`.
fn is_arxiv_category_code(s: &str) -> bool {
    let mut parts = s.split('.');
    let Some(prefix) = parts.next() else {
        return false;
    };
    let suffix = parts.next();
    if parts.next().is_some() {
        return false;
    }

    let p_lower = prefix.to_ascii_lowercase();
    let valid_prefix = matches!(
        p_lower.as_str(),
        "cs" | "stat"
            | "math"
            | "eess"
            | "physics"
            | "q-bio"
            | "q-fin"
            | "econ"
            | "astro-ph"
            | "cond-mat"
            | "gr-qc"
            | "nlin"
            | "quant-ph"
    ) || p_lower
        .strip_prefix("hep-")
        .is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_lowercase()))
        || p_lower
            .strip_prefix("nucl-")
            .is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_lowercase()));

    if !valid_prefix {
        return false;
    }

    match suffix {
        None => true,
        Some(suf) => !suf.is_empty() && suf.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-'),
    }
}

fn is_rejected_cleaned_surface(cleaned: &str) -> bool {
    let char_len = cleaned.chars().count();
    if !(2..=48).contains(&char_len) {
        return true;
    }
    if !has_ascii_alpha(cleaned) {
        return true;
    }
    if cleaned.contains("->") || cleaned.contains('→') || cleaned.contains('>') {
        return true;
    }
    if has_standalone_year(cleaned) {
        return true;
    }
    if is_arxiv_category_code(cleaned) {
        return true;
    }
    if cleaned.split(' ').count() > 6 {
        return true;
    }
    let lower = cleaned.to_lowercase();
    if NON_KEYWORD_STOPLIST.contains(lower.as_str()) {
        return true;
    }
    false
}

/// Conservative English head-noun singularizer tailored for CS/SE/CR/AI terminology.
pub fn singularize_keyword_token(word_lower: &str) -> String {
    if let Some(&irregular) = IRREGULAR_PLURALS.get(word_lower) {
        return irregular.to_string();
    }
    if word_lower.chars().count() <= 3 || INVARIANT_WORDS.contains(word_lower) {
        return word_lower.to_string();
    }
    for &suffix in INVARIANT_SUFFIXES {
        if word_lower.ends_with(suffix) {
            return word_lower.to_string();
        }
    }
    if word_lower.ends_with("ies") && word_lower.chars().count() > 4 {
        let stem = &word_lower[..word_lower.len() - 3];
        if let Some(before) = stem.chars().last() {
            if !matches!(before, 'a' | 'e' | 'i' | 'o' | 'u') {
                return format!("{stem}y");
            }
        }
    }
    for &suffix in ES_PLURAL_SUFFIXES {
        if word_lower.ends_with(suffix) {
            return word_lower[..word_lower.len() - 2].to_string();
        }
    }
    if let Some(stripped) = word_lower.strip_suffix('s') {
        return stripped.to_string();
    }
    word_lower.to_string()
}

/// Build a de-hyphenated, singularized lowercase lookup key for synonym matching.
pub fn build_keyword_lookup_key(raw: &str) -> String {
    let cleaned = clean_keyword_surface(raw);
    if cleaned.is_empty() {
        return String::new();
    }
    let mut tokens: Vec<String> = cleaned
        .to_lowercase()
        .split(|c: char| is_js_whitespace(c) || c == '-' || c == '_')
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect();
    let Some(last) = tokens.last_mut() else {
        return String::new();
    };
    *last = singularize_keyword_token(last);
    tokens.join(" ")
}

fn is_all_ascii_upper_alphanum(seg: &str) -> bool {
    let mut alpha_count = 0usize;
    for b in seg.bytes() {
        if b.is_ascii_uppercase() {
            alpha_count += 1;
        } else if b.is_ascii_lowercase() {
            return false;
        }
    }
    alpha_count >= 2
}

fn is_pluralized_acronym(seg: &str) -> bool {
    if seg.len() < 3 || !seg.ends_with('s') {
        return false;
    }
    is_all_ascii_upper_alphanum(&seg[..seg.len() - 1])
}

fn has_internal_mixed_case(seg: &str) -> bool {
    let mut has_lower = false;
    let mut has_internal_upper = false;
    for (i, b) in seg.bytes().enumerate() {
        if b.is_ascii_lowercase() {
            has_lower = true;
        } else if i > 0 && b.is_ascii_uppercase() {
            has_internal_upper = true;
        }
    }
    has_lower && has_internal_upper
}

fn capitalize_ascii_word(word_lower: &str) -> String {
    for (i, b) in word_lower.bytes().enumerate() {
        if b.is_ascii_lowercase() {
            let mut out = String::with_capacity(word_lower.len());
            out.push_str(&word_lower[..i]);
            out.push(char::from(b - 32));
            out.push_str(&word_lower[i + 1..]);
            return out;
        }
        if b.is_ascii_uppercase() {
            return word_lower.to_string();
        }
    }
    word_lower.to_string()
}

fn format_sub_segment(
    raw_seg: &str,
    is_first_token_in_phrase: bool,
    is_final_segment_in_phrase: bool,
) -> String {
    if raw_seg.is_empty() {
        return String::new();
    }

    if is_final_segment_in_phrase && is_pluralized_acronym(raw_seg) {
        let stem = &raw_seg[..raw_seg.len() - 1];
        let stem_lower = stem.to_lowercase();
        if let Some(&mapped) = CANONICAL_TOKEN_CASING.get(stem_lower.as_str()) {
            return mapped.to_string();
        }
        return stem.to_string();
    }

    let raw_lower = raw_seg.to_lowercase();
    let preserve_original_surface =
        is_all_ascii_upper_alphanum(raw_seg) || has_internal_mixed_case(raw_seg);

    let target_lower = if is_final_segment_in_phrase && !preserve_original_surface {
        singularize_keyword_token(&raw_lower)
    } else {
        raw_lower.clone()
    };

    if let Some(&canonical_tok) = CANONICAL_TOKEN_CASING.get(target_lower.as_str()) {
        return canonical_tok.to_string();
    }

    if preserve_original_surface && target_lower == raw_lower {
        if is_all_ascii_upper_alphanum(raw_seg) && raw_seg.chars().count() > 6 {
            return capitalize_ascii_word(&raw_lower);
        }
        return raw_seg.to_string();
    }

    if !is_first_token_in_phrase && MINOR_TITLE_WORDS.contains(target_lower.as_str()) {
        return target_lower;
    }

    capitalize_ascii_word(&target_lower)
}

fn format_open_vocabulary_keyword(cleaned: &str) -> String {
    let words: Vec<&str> = cleaned.split(' ').collect();
    let mut formatted_words: Vec<String> = Vec::with_capacity(words.len());

    for (w_idx, &word) in words.iter().enumerate() {
        let word_lower = word.to_lowercase();
        if let Some(&slash_canonical) = CANONICAL_SLASH_TOKENS.get(word_lower.as_str()) {
            formatted_words.push(slash_canonical.to_string());
            continue;
        }

        let mut parts: Vec<&str> = Vec::new();
        let mut delims: Vec<char> = Vec::new();
        let mut start = 0usize;
        for (i, ch) in word.char_indices() {
            if ch == '-' || ch == '/' {
                parts.push(&word[start..i]);
                delims.push(ch);
                start = i + ch.len_utf8();
            }
        }
        parts.push(&word[start..]);

        let mut rebuilt = String::with_capacity(word.len());
        for (p_idx, &seg) in parts.iter().enumerate() {
            let is_first = w_idx == 0 && p_idx == 0;
            let is_final = w_idx + 1 == words.len() && p_idx + 1 == parts.len();
            rebuilt.push_str(&format_sub_segment(seg, is_first, is_final));
            if let Some(&delim) = delims.get(p_idx) {
                rebuilt.push(delim);
            }
        }
        formatted_words.push(rebuilt);
    }

    formatted_words.join(" ")
}

/// Canonicalize a single raw academic keyword into its canonical English Title Case
/// singular form, or return `None` if it is empty, invalid, or non-keyword noise.
pub fn canonicalize_keyword(raw: &str) -> Option<String> {
    let cleaned = clean_keyword_surface(raw);
    if cleaned.is_empty() || is_rejected_cleaned_surface(&cleaned) {
        return None;
    }

    let lookup_key = build_keyword_lookup_key(&cleaned);
    if lookup_key.is_empty() || NON_KEYWORD_STOPLIST.contains(lookup_key.as_str()) {
        return None;
    }

    if let Some(&mapped) = KEYWORD_SYNONYM_MAP.get(&lookup_key) {
        return Some(mapped.to_string());
    }

    Some(format_open_vocabulary_keyword(&cleaned))
}

/// Return the canonical lowercase deduplication key for any keyword or query chip.
/// Synonyms map to the same key (e.g., `"Defect Detection"` -> `"vulnerability detection"`).
pub fn normalize_keyword_key(raw: &str) -> String {
    if let Some(canonical) = canonicalize_keyword(raw) {
        return canonical.to_lowercase();
    }
    clean_keyword_surface(raw).to_lowercase()
}

/// Canonicalize a user-supplied recommend/query keyword chip: maps synonyms and
/// plurals to their canonical display form, falling back to cleaned surface text
/// when the user explicitly enters a custom query term outside paper-keyword filters.
pub fn canonicalize_query_term(raw: &str) -> Option<String> {
    if let Some(canonical) = canonicalize_keyword(raw) {
        return Some(canonical);
    }
    let cleaned = clean_keyword_surface(raw);
    (!cleaned.is_empty()).then_some(cleaned)
}

/// Canonicalize, filter, and deduplicate a list of raw paper keyword strings (splitting `;` / `\n`).
pub fn canonicalize_keywords(raw_list: &[String]) -> Vec<String> {
    union_canonical_keywords(&[], raw_list)
}

/// Merge existing and incoming paper keyword lists into a canonical, case-insensitively
/// deduplicated list, preferring higher casing quality when open-vocabulary variants collide.
pub fn union_canonical_keywords(existing: &[String], incoming: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();

    for raw_entry in existing.iter().chain(incoming.iter()) {
        let stripped = strip_leading_keyword_prefix(raw_entry);
        for seg in stripped.split([';', '\n']) {
            let Some(canonical) = canonicalize_keyword(seg) else {
                continue;
            };
            let key = canonical.to_lowercase();
            if let Some(&idx) = seen.get(&key) {
                if casing_quality(&canonical) > casing_quality(&out[idx]) {
                    out[idx] = canonical;
                }
            } else {
                seen.insert(key, out.len());
                out.push(canonical);
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defect_detection_and_vulnerability_variants_collapse_to_vulnerability_detection() {
        let variants = [
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
        for raw in variants {
            assert_eq!(
                canonicalize_keyword(raw).as_deref(),
                Some("Vulnerability Detection"),
                "failed for {raw}"
            );
            assert_eq!(normalize_keyword_key(raw), "vulnerability detection");
        }

        let collapsed = canonicalize_keywords(&[
            "Defect Detection".into(),
            "Software Vulnerability Detection".into(),
            "Bug Detection".into(),
        ]);
        assert_eq!(collapsed, vec!["Vulnerability Detection"]);
    }

    #[test]
    fn ai_agent_synonyms_collapse_while_coding_and_multi_agent_stay_distinct() {
        let ai_agent_variants = [
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
        for raw in ai_agent_variants {
            assert_eq!(
                canonicalize_keyword(raw).as_deref(),
                Some("AI Agent"),
                "failed for {raw}"
            );
            assert_eq!(normalize_keyword_key(raw), "ai agent");
        }

        assert_eq!(
            canonicalize_keyword("Coding Agents").as_deref(),
            Some("Coding Agent")
        );
        assert_eq!(
            canonicalize_keyword("Software Engineering Agents").as_deref(),
            Some("Coding Agent")
        );
        assert_eq!(
            canonicalize_keyword("Multi-agent Systems").as_deref(),
            Some("Multi-Agent System")
        );
        assert_eq!(
            canonicalize_keyword("Multi-Agent").as_deref(),
            Some("Multi-Agent System")
        );
    }

    #[test]
    fn high_frequency_se_pl_security_and_ai_synonyms_match_ts_parity() {
        let cases = [
            ("Fuzz Testing", "Fuzzing"),
            ("Fuzzers", "Fuzzing"),
            ("Automated Program Repair", "Program Repair"),
            ("Automatic Program Repair", "Program Repair"),
            ("APR", "Program Repair"),
            ("Code Repair", "Program Repair"),
            ("Static Program Analysis", "Static Analysis"),
            ("Static Code Analysis", "Static Analysis"),
            ("Fault Location", "Fault Localization"),
            ("Bug Localization", "Fault Localization"),
            ("Defect Localization", "Fault Localization"),
            ("Large Language Models", "Large Language Model"),
            ("LLM", "Large Language Model"),
            ("LLMs", "Large Language Model"),
            ("Large Language Models (LLMs)", "Large Language Model"),
            ("RAG", "Retrieval-Augmented Generation"),
            (
                "retrieval augmented generation",
                "Retrieval-Augmented Generation",
            ),
            ("Large Language Model Security", "LLM Security"),
            ("LLM Agent Security", "AI Agent Security"),
            ("Agent Security", "AI Agent Security"),
            ("Zero-Knowledge Proofs", "Zero-Knowledge Proof"),
            ("ZKPs", "Zero-Knowledge Proof"),
            ("Smart Contracts", "Smart Contract"),
            ("Decentralized Finance (DeFi)", "Decentralized Finance"),
        ];
        for (raw, expected) in cases {
            assert_eq!(
                canonicalize_keyword(raw).as_deref(),
                Some(expected),
                "failed for {raw}"
            );
        }
    }

    #[test]
    fn distinct_subfields_and_methodologies_are_never_over_merged() {
        let distinct = [
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
        for term in distinct {
            assert_eq!(canonicalize_keyword(term).as_deref(), Some(term));
        }

        for acronym in ["DP", "MPC", "CPS", "CFG"] {
            assert_eq!(canonicalize_keyword(acronym).as_deref(), Some(acronym));
        }
    }

    #[test]
    fn plurals_invariant_endings_acronyms_and_noise_filters_match_ts_parity() {
        assert_eq!(
            canonicalize_keyword("ebpf verification").as_deref(),
            Some("eBPF Verification")
        );
        assert_eq!(canonicalize_keyword("eBPF").as_deref(), Some("eBPF"));
        assert_eq!(canonicalize_keyword("ebpf").as_deref(), Some("eBPF"));
        assert_eq!(
            canonicalize_keyword("flaky tests").as_deref(),
            Some("Flaky Test")
        );
        assert_eq!(
            canonicalize_keyword("security advisories").as_deref(),
            Some("Security Advisory")
        );
        assert_eq!(
            canonicalize_keyword("security patches").as_deref(),
            Some("Security Patch")
        );
        assert_eq!(
            canonicalize_keyword("instruction caches").as_deref(),
            Some("Instruction Cache")
        );
        assert_eq!(
            canonicalize_keyword("c/c++ memory safety").as_deref(),
            Some("C/C++ Memory Safety")
        );
        assert_eq!(
            canonicalize_keyword("formal semantics").as_deref(),
            Some("Formal Semantics")
        );
        assert_eq!(
            canonicalize_keyword("abstract consensus").as_deref(),
            Some("Abstract Consensus")
        );
        assert_eq!(
            canonicalize_keyword("naive bayes").as_deref(),
            Some("Naive Bayes")
        );
        assert_eq!(
            canonicalize_keyword("serverless computing").as_deref(),
            Some("Serverless Computing")
        );
        assert_eq!(
            canonicalize_keyword("Microservices").as_deref(),
            Some("Microservices")
        );
        assert_eq!(canonicalize_keyword("RTOS").as_deref(), Some("RTOS"));
        assert_eq!(
            canonicalize_keyword("NIDS").as_deref(),
            Some("Network Intrusion Detection")
        );

        for invalid in [
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
        ] {
            assert_eq!(
                canonicalize_keyword(invalid),
                None,
                "expected None for {invalid}"
            );
        }
    }

    #[test]
    fn zero_alias_collisions_and_full_idempotency_across_synonym_groups() {
        assert_eq!(SYNONYM_GROUPS.len(), 107);
        let mut seen_keys: HashMap<String, &'static str> = HashMap::new();
        for group in SYNONYM_GROUPS {
            assert_eq!(
                canonicalize_keyword(group.canonical).as_deref(),
                Some(group.canonical),
                "canonical not idempotent: {}",
                group.canonical
            );
            for &term in std::iter::once(&group.canonical).chain(group.aliases.iter()) {
                let key = build_keyword_lookup_key(term);
                assert!(!key.is_empty(), "empty lookup key for {term}");
                if let Some(&prev) = seen_keys.get(&key) {
                    assert_eq!(
                        prev, group.canonical,
                        "collision on key {key}: {prev} vs {}",
                        group.canonical
                    );
                }
                seen_keys.insert(key.clone(), group.canonical);
                assert_eq!(
                    KEYWORD_SYNONYM_MAP.get(&key).copied(),
                    Some(group.canonical)
                );
                assert_eq!(
                    canonicalize_keyword(term).as_deref(),
                    Some(group.canonical),
                    "alias {term} failed to canonicalize to {}",
                    group.canonical
                );
            }
        }
    }
}
