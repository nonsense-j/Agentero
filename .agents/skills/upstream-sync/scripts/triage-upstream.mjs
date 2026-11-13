#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUCKETS = [
	"ADOPT",
	"ADAPT",
	"SKIP_PRUNED",
	"SKIP_DIVERGED_OR_DUPLICATE",
	"DEFER_LARGE_SERIES",
];

const PRUNED_PATH_PATTERNS = [
	/^src-tauri\/src\/features\/writing\//,
	/^src-tauri\/src\/features\/compile\//,
	/^src-tauri\/src\/features\/rtex\//,
	/^src-tauri\/rtex\//,
	/^src\/components\/writing\//,
	/^src\/lib\/writing\//,
	/^src\/lib\/tex\//,
	/^src\/lib\/tex-live\//,
	/^src\/components\/viewer\/texlive\//,
	/^src\/components\/viewer\/tex-citation-picker\.tsx$/,
	/^src\/components\/viewer\/text-editor-lint-footer\.tsx$/,
	/^src\/components\/viewer\/pdf\/hooks\/use-pdf-synctex\.ts$/,
	/^src\/hooks\/use-tex-root\.ts$/,
	/^src\/components\/sidebar\/use-tex-project\.ts$/,
	/^src\/components\/sidebar\/file-tree\/hooks\/use-tex-compile\.ts$/,
	/^src\/lib\/workspace\/(?:tex-compile|tex-outline-bridge|writing-focus|actions-latex-translation)\.ts$/,
	/^src\/components\/mobile\//,
	/^src\/lib\/bridge\//,
	/^src-tauri\/src\/integration\/bridge\//,
	/^src-tauri\/gen\/(?:android|apple)\//,
	/^src-tauri\/(?:ios-project\.yml|tauri\.android\.conf\.json|tauri\.ios\.conf\.json)$/,
	/^scripts\/ios-/,
	/^\.github\/workflows\/ios-/,
	/^src-tauri\/src\/integration\/remote\//,
	/^src-tauri\/src\/features\/agent\/(?:remote_host|commands\/remote|registry\/remote)\.rs$/,
	/^src-tauri\/src\/features\/agent\/delegate\//,
	/^src-tauri\/src\/integration\/delegate_mcp\.rs$/,
	/^src-tauri\/src\/integration\/mcp\/tunnel\.rs$/,
	/^src\/lib\/mcp\/tunnel\.ts$/,
	/^src\/lib\/vault\/(?:remote\/|remote-path\.ts$)/,
	/^src\/components\/dialogs\/remote-vault-dialog\.tsx$/,
	/^src\/components\/settings\/panes\/remote-access-pane\.tsx$/,
	/^src-tauri\/src\/app\/account\.rs$/,
	/^src\/features\/account\//,
	/^src\/components\/settings\/panes\/account-pane\.tsx$/,
	/^src\/components\/settings\/cloud-usage\.tsx$/,
	/^src\/components\/settings\/panes\/about-feedback\.tsx$/,
	/^crates\/agentero-core\/src\/features\/sync\/(?:agentero|config)\.rs$/,
	/^crates\/agentero-core\/src\/remote\.rs$/,
	/^crates\/agentero-plugin-host\//,
	/^crates\/agentero-core\/src\/plugins\.rs$/,
	/^src-tauri\/src\/integration\/plugins\//,
	/^src\/components\/settings\/panes\/plugins-pane\.tsx$/,
	/^src\/lib\/plugins\//,
	/^src-tauri\/src\/integration\/word\//,
	/^src\/components\/settings\/word-settings\.tsx$/,
	/^src\/components\/dialogs\/word-citation-dialog\.tsx$/,
	/^src\/lib\/word\//,
	/^crates\/agentero-core\/src\/features\/zhihu\//,
	/^src-tauri\/src\/features\/zhihu\//,
	/^src\/components\/agent\/zhihu-discussions\.tsx$/,
	/^src\/components\/settings\/panes\/agent\/zhihu-agent-row\.tsx$/,
	/^src\/lib\/zhihu\.ts$/,
	/^src-tauri\/src\/core\/telemetry\//,
	/^src\/lib\/pdf\/reflow\//,
	/^src\/components\/viewer\/pdf\/hooks\/use-(?:pdf-reflow|reflow-display-document)\.ts$/,
	/^src\/components\/viewer\/pdf\/layers\/reflow-page-overlay\.tsx$/,
	/^test\/pdf-reflow-/,
	/^src-tauri\/src\/features\/paper\/analyze\/layout\/model_assets\//,
	/^src\/hooks\/use-layout-model-prefetch\.ts$/,
	/^vendor\/tesseract-rs\//,
	/^patches\/.*tesseract/,
	/^templates\/vault\/thesis\//,
	/^templates\/vault\/\.agents\/skills\/research-paper-writing\//,
	/^mkdocs\.yml$/,
	/^docs\/(?:backend\/word|frontend\/latex|frontend\/zhihu)\.md$/,
	/^src\/i18n\/locales\/[^/]+\/(?:account|latexBuild|latexLanguage|latexPdf|mobile)\.json$/,
];

const DIVERGED_PATH_PATTERNS = [
	/institution[-_]proxy/i,
	/^\.agents\/skills\/release\//,
	/^docs\/development\/rfc-scholarly-data-resolution\.md$/,
];

const CONTRACT_HOTSPOT_PATTERNS = [
	/^src\/lib\/core\/bindings\.ts$/,
	/^src-tauri\/src\/app\/(?:handlers|bindings_test|events_contract)\.rs$/,
	/^src\/components\/workspace\/doc-view\.tsx$/,
	/^src\/components\/settings\/settings-content\.tsx$/,
	/^src\/components\/shell\/palette-commands\.ts$/,
	/^src-tauri\/src\/integration\/connector\/state\.rs$/,
	/^src-tauri\/(?:build\.rs|Cargo\.toml)$/,
	/^Cargo\.lock$/,
	/^pnpm-lock\.yaml$/,
	/^patches\//,
	/^src\/lib\/pdf\/layout\/provider(?:-config|s)\.ts$/,
	/^src\/components\/viewer\/pdf\/pdf-viewer\.tsx$/,
	/^src\/components\/viewer\/pdf\/hooks\/use-pdf-text-selection\.ts$/,
	/^src\/components\/settings\/panes\/agent\/agent-catalog-rows\.tsx$/,
	/^src-tauri\/src\/features\/agent\/registry\/discovery\.rs$/,
	/^src\/lib\/lifecycle\/register\.ts$/,
	/^docs\/development\/plaza\.md$/,
];

const SERIES_SUBJECT_RULES = [
	{
		series: "navigator-vim",
		pattern:
			/\b(navigator|hint mode|hint sessions|vim keys|vimMode|j\/k\/h\/l|vim key handler|numbered page jumps|in-group tab cycling)\b/i,
	},
	{
		series: "auto-translate-queue",
		pattern:
			/\b(full-?text translation|partial[- ]translation|auto-?translation|shared (?:document|paper) translations|enqueue translation|page counts|translation caches|unreachable translation provider|preserved translation|sidecar readiness|missing layout pages|verifiable layout completeness|bibliography regions|front matter during full translation|translation selection across viewers|shared jobs in page)\b/i,
	},
	{
		series: "rail-peek",
		pattern:
			/\b(comment rail|rail peek|comment peek|center the page when fitting width)\b/i,
	},
	{
		series: "comment-card-markdown",
		pattern:
			/\b(comment cards? at fixed|size comment cards|cap comment card|comment cards as Markdown|comment card layout|selection note editor)\b/i,
	},
	{
		series: "cross-page-selection",
		pattern:
			/\b(cross-page text selection|selection filtering off the drag|first-selection highlight delay|selection lint checks)\b/i,
	},
	{
		series: "underline-annotations",
		pattern:
			/\b(underline annotations|selection bookmark into more menu|highlight or underline per color swatch)\b/i,
	},
	{
		series: "annotation-history",
		pattern: /\b(grouped annotation history|annotation undo and redo)\b/i,
	},
	{
		series: "library-multi-select",
		pattern: /\b(multi-select rows with marquee)\b/i,
	},
];

const DIVERGED_SUBJECT_PATTERNS = [
	/^chore\(release\): bump version\b/i,
	/\binstitution proxy\b/i,
	/^fix\(dev\): stop Vite from watching Rust target/i,
	/^docs: add scholarly data resolution RFC$/i,
	/^docs\(skills\): cover the full release shipping flow$/i,
	/^fix\(docs\): drop nav entries for removed bug notes$/i,
];

function fail(message) {
	process.stderr.write(`triage-upstream: ${message}\n`);
	process.exit(1);
}

function runGit(args, options = {}) {
	try {
		return execFileSync("git", args, {
			cwd: options.cwd ?? process.cwd(),
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", options.quietStderr ? "ignore" : "pipe"],
		});
	} catch (error) {
		if (options.allowFailure) {
			return null;
		}
		const stderr = error.stderr?.toString().trim();
		fail(stderr || `git ${args.join(" ")} failed`);
	}
}

function printUsage() {
	process.stdout.write(
		`${[
			"Usage: node .agents/skills/upstream-sync/scripts/triage-upstream.mjs [base] [target] [--json]",
			"",
			"Defaults:",
			"  base    Read `Last Synced Upstream Commit` from references/divergence-map.md",
			"  target  upstream/main",
		].join("\n")}\n`,
	);
}

function parseArgs(argv) {
	let json = false;
	const positionals = [];

	for (const arg of argv) {
		if (arg === "--json") {
			json = true;
		} else if (arg === "-h" || arg === "--help") {
			printUsage();
			process.exit(0);
		} else if (arg.startsWith("-")) {
			fail(`Unknown option: ${arg}`);
		} else {
			positionals.push(arg);
		}
	}

	if (positionals.length > 2) {
		fail("Expected at most two positional arguments: [base] [target]");
	}

	return {
		baseArg: positionals[0] ?? null,
		targetArg: positionals[1] ?? "upstream/main",
		json,
	};
}

function readWatermarkBase(divergenceMapPath) {
	if (!existsSync(divergenceMapPath)) {
		fail(`Cannot find divergence map at ${divergenceMapPath}`);
	}
	const content = readFileSync(divergenceMapPath, "utf8");
	const match = content.match(
		/^Last Synced Upstream Commit:\s*([0-9a-fA-F]{7,40})\b/m,
	);
	if (!match) {
		fail(
			`Could not parse "Last Synced Upstream Commit: <sha>" from ${divergenceMapPath}`,
		);
	}
	return match[1];
}

function resolveCommit(repoRoot, ref) {
	const out = runGit(["rev-parse", "--verify", `${ref}^{commit}`], {
		cwd: repoRoot,
		allowFailure: true,
		quietStderr: true,
	});
	if (!out) {
		fail(
			`Unable to resolve git ref "${ref}". Check that the remote/commit exists (e.g. git fetch upstream main --no-tags).`,
		);
	}
	return out.trim();
}

function parseDirtyPaths(repoRoot) {
	const raw = runGit(["status", "--porcelain"], { cwd: repoRoot });
	const files = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}
		let pathPart = line.slice(3).trim();
		const renameIdx = pathPart.indexOf(" -> ");
		if (renameIdx !== -1) {
			pathPart = pathPart.slice(renameIdx + 4).trim();
		}
		if (pathPart.startsWith('"') && pathPart.endsWith('"')) {
			pathPart = pathPart.slice(1, -1);
		}
		if (pathPart) {
			files.push(pathPart.replace(/\\/g, "/"));
		}
	}
	return files;
}

function loadHeadTrackedSet(repoRoot) {
	const raw = runGit(["ls-files", "-z"], { cwd: repoRoot });
	const tracked = new Set();
	for (const entry of raw.split("\0")) {
		if (entry) {
			tracked.add(entry.replace(/\\/g, "/"));
		}
	}
	return tracked;
}

function loadNonMergeCommits(repoRoot, baseSha, targetSha) {
	const raw = runGit(
		[
			"log",
			"--no-merges",
			"--reverse",
			"--date=short",
			"--format=%H%x1f%h%x1f%cs%x1f%an%x1f%s%x1e",
			`${baseSha}..${targetSha}`,
		],
		{ cwd: repoRoot },
	);

	if (!raw.trim()) {
		return [];
	}

	return raw
		.split("\x1e")
		.map((record) => record.replace(/^\r?\n+/, "").trimEnd())
		.filter(Boolean)
		.map((record) => {
			const [sha, shortSha, date, author, subject] = record.split("\x1f");
			const diffRaw = runGit(
				["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", sha],
				{ cwd: repoRoot },
			);

			const changes = [];
			for (const line of diffRaw.split(/\r?\n/)) {
				if (!line.trim()) {
					continue;
				}
				const parts = line.split("\t");
				const status = parts[0];
				if (status.startsWith("R") || status.startsWith("C")) {
					changes.push({
						status: status[0],
						oldPath: parts[1],
						path: parts[2],
					});
				} else {
					changes.push({
						status: status[0],
						oldPath: null,
						path: parts[1],
					});
				}
			}

			return {
				sha,
				shortSha,
				date,
				author,
				subject,
				changes,
			};
		});
}

function matchesAny(filePath, patterns) {
	return patterns.some((pattern) => pattern.test(filePath));
}

function classifyCommit(commit, headTracked, addedInRange, dirtySet) {
	const paths = commit.changes.map((c) => c.path);
	const prunedPaths = paths.filter((p) => matchesAny(p, PRUNED_PATH_PATTERNS));
	const divergedPaths = paths.filter((p) =>
		matchesAny(p, DIVERGED_PATH_PATTERNS),
	);
	const hotspotPaths = paths.filter((p) =>
		matchesAny(p, CONTRACT_HOTSPOT_PATTERNS),
	);
	const dirtyOverlapPaths = paths.filter((p) => dirtySet.has(p));

	const missingLocalPaths = commit.changes
		.filter((c) => c.status === "M" || c.status === "D")
		.map((c) => c.path)
		.filter((p) => !headTracked.has(p) && !addedInRange.has(p));

	for (const change of commit.changes) {
		if (change.status === "A" || change.status === "R") {
			addedInRange.add(change.path);
		}
	}

	const seriesMatch = SERIES_SUBJECT_RULES.find((rule) =>
		rule.pattern.test(commit.subject),
	);
	const divergedSubjectMatch = DIVERGED_SUBJECT_PATTERNS.some((pattern) =>
		pattern.test(commit.subject),
	);

	const flags = [];
	if (prunedPaths.length > 0) {
		flags.push("TOUCHES_PRUNED_PATH");
	}
	if (missingLocalPaths.length > 0) {
		flags.push("MISSING_IN_HEAD");
	}
	if (hotspotPaths.length > 0) {
		flags.push("CONTRACT_HOTSPOT");
	}
	if (dirtyOverlapPaths.length > 0) {
		flags.push("DIRTY_WORKTREE_OVERLAP");
	}
	if (seriesMatch) {
		flags.push(`SERIES:${seriesMatch.series}`);
	}

	let bucket = "ADOPT";
	const reasons = [];

	if (divergedSubjectMatch) {
		bucket = "SKIP_DIVERGED_OR_DUPLICATE";
		reasons.push("matches local diverged/duplicate workflow");
	} else if (seriesMatch) {
		bucket = "DEFER_LARGE_SERIES";
		reasons.push(`part of deferred series "${seriesMatch.series}"`);
	} else if (
		prunedPaths.length > 0 ||
		/\bsearch the visible translation in find bar\b/i.test(commit.subject)
	) {
		bucket = "SKIP_PRUNED";
		if (prunedPaths.length > 0) {
			reasons.push(`pruned paths: ${prunedPaths.slice(0, 3).join(", ")}`);
		} else {
			reasons.push("coupled to pruned pdf/reflow subsystem");
		}
	} else if (divergedPaths.length > 0) {
		bucket = "SKIP_DIVERGED_OR_DUPLICATE";
		reasons.push(`diverged paths: ${divergedPaths.slice(0, 3).join(", ")}`);
	} else if (
		missingLocalPaths.length > 0 &&
		missingLocalPaths.length === paths.length
	) {
		bucket = "SKIP_PRUNED";
		reasons.push(
			`all modified/deleted files absent in HEAD: ${missingLocalPaths.slice(0, 3).join(", ")}`,
		);
	} else if (paths.length >= 15 && /^(feat|refactor)\(/i.test(commit.subject)) {
		bucket = "DEFER_LARGE_SERIES";
		reasons.push(
			`large multi-file ${commit.subject.split(":")[0]} (${paths.length} files)`,
		);
	} else if (hotspotPaths.length > 0 || missingLocalPaths.length > 0) {
		bucket = "ADAPT";
		if (hotspotPaths.length > 0) {
			reasons.push(`contract hotspots: ${hotspotPaths.slice(0, 3).join(", ")}`);
		}
		if (missingLocalPaths.length > 0) {
			reasons.push(
				`missing in HEAD: ${missingLocalPaths.slice(0, 3).join(", ")}`,
			);
		}
	} else {
		bucket = "ADOPT";
		reasons.push("clean shared-surface paths");
	}

	return {
		sha: commit.sha,
		shortSha: commit.shortSha,
		date: commit.date,
		author: commit.author,
		subject: commit.subject,
		fileCount: paths.length,
		paths,
		bucket,
		reasons,
		flags,
		dirtyOverlapPaths,
		hotspotPaths,
		prunedPaths,
		missingLocalPaths,
	};
}

function renderMarkdown(report) {
	const lines = [
		`# Upstream Triage Report (\`${report.base.slice(0, 8)}..${report.targetRef}\`)`,
		"",
		`- **Base SHA**: \`${report.base}\``,
		`- **Target Ref / SHA**: \`${report.targetRef}\` (\`${report.target}\`)`,
		`- **Non-merge commits**: **${report.totalCommits}**`,
		`- **Dirty working tree files**: **${report.dirtyFiles.length}**`,
		"",
	];

	if (report.totalCommits === 0) {
		lines.push(
			"0 unsynced commits between base watermark and target. Nothing to triage.",
		);
		return `${lines.join("\n")}\n`;
	}

	lines.push("## Summary Counts", "", "| Bucket | Count |", "|---|---:|");
	for (const bucket of BUCKETS) {
		lines.push(`| \`${bucket}\` | ${report.counts[bucket]} |`);
	}
	lines.push(`| **Total** | **${report.totalCommits}** |`, "");

	lines.push("## Dirty Working Tree Overlap", "");
	if (report.dirtyOverlaps.length === 0) {
		lines.push(
			"No upstream commits in this range touch currently dirty files.",
			"",
		);
	} else {
		lines.push(
			"| SHA | Bucket | Subject | Overlapping Dirty Paths |",
			"|---|---|---|---|",
		);
		for (const item of report.dirtyOverlaps) {
			lines.push(
				`| \`${item.shortSha}\` | \`${item.bucket}\` | ${item.subject} | ${item.dirtyOverlapPaths.map((p) => `\`${p}\``).join(", ")} |`,
			);
		}
		lines.push("");
	}

	for (const bucket of BUCKETS) {
		const items = report.commits.filter((c) => c.bucket === bucket);
		lines.push(`## ${bucket} (${items.length})`, "");
		if (items.length === 0) {
			lines.push("_None._", "");
			continue;
		}
		lines.push(
			"| SHA | Date | Files | Subject | Notes |",
			"|---|---|---:|---|---|",
		);
		for (const item of items) {
			const noteParts = [...item.reasons];
			if (item.dirtyOverlapPaths.length > 0) {
				noteParts.push(`dirty overlap: ${item.dirtyOverlapPaths.join(", ")}`);
			}
			lines.push(
				`| \`${item.shortSha}\` | ${item.date} | ${item.fileCount} | ${item.subject} | ${noteParts.join("; ")} |`,
			);
		}
		lines.push("");
	}

	return `${lines.join("\n")}\n`;
}

function main() {
	const { baseArg, targetArg, json } = parseArgs(process.argv.slice(2));
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const repoRoot =
		runGit(["rev-parse", "--show-toplevel"], {
			allowFailure: true,
			quietStderr: true,
		})?.trim() || resolve(scriptDir, "../../../..");

	const divergenceMapPath = resolve(
		scriptDir,
		"../references/divergence-map.md",
	);
	const rawBase = baseArg ?? readWatermarkBase(divergenceMapPath);
	const baseSha = resolveCommit(repoRoot, rawBase);
	const targetSha = resolveCommit(repoRoot, targetArg);

	const dirtyFiles = parseDirtyPaths(repoRoot);
	const dirtySet = new Set(dirtyFiles);
	const headTracked = loadHeadTrackedSet(repoRoot);
	const rawCommits = loadNonMergeCommits(repoRoot, baseSha, targetSha);

	const addedInRange = new Set();
	const classified = rawCommits.map((commit) =>
		classifyCommit(commit, headTracked, addedInRange, dirtySet),
	);

	const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
	for (const item of classified) {
		counts[item.bucket] += 1;
	}

	const dirtyOverlaps = classified.filter(
		(item) => item.dirtyOverlapPaths.length > 0,
	);

	const report = {
		base: baseSha,
		targetRef: targetArg,
		target: targetSha,
		totalCommits: classified.length,
		counts,
		dirtyFiles,
		dirtyOverlaps: dirtyOverlaps.map((item) => ({
			sha: item.sha,
			shortSha: item.shortSha,
			bucket: item.bucket,
			subject: item.subject,
			dirtyOverlapPaths: item.dirtyOverlapPaths,
		})),
		commits: classified,
	};

	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}

	process.stdout.write(renderMarkdown(report));
}

main();
