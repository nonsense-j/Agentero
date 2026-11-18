#!/usr/bin/env node

/**
 * Maintainer single-command seed pipeline for Plaza Paper Collection (`2026`).
 *
 * Orchestrates:
 *   Step 1: Stateless TS multi-channel crawling (28 Venues + 2026 arXiv categories)
 *           loaded directly via Vite SSR (`ssrLoadModule`, zero extra npm deps),
 *           persisting each Venue / arXiv batch into `collection.sqlite` via
 *           `agentero-cli collection upsert-file`.
 *   Step 2: High-concurrency citation edge resolution, maintainer LLM keyword baking,
 *           and `.jsonl.gz` + `manifest.json` bundle export via
 *           `agentero-cli collection seed-bake`.
 *   Step 3: Optional GitHub Prerelease upload (`collection-seed-2026`) via `gh` CLI
 *           or `GITHUB_TOKEN` REST API when `--upload` is passed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const DEFAULT_CATEGORIES = "cs.SE,cs.CR,cs.PL";
const DEFAULT_OUT_DIR = "dist/seed";
const DEFAULT_LLM_BASE_URL = "https://x666.me/v1";
const DEFAULT_LLM_MODEL = "ernie-5.5-flash-preview";
const DEFAULT_LLM_CONCURRENCY = 1;
const DEFAULT_LLM_BATCH_SIZE = 8;
const DEFAULT_LLM_RPM = 5;
const DEFAULT_RELEASE_TAG = "collection-seed-2026";
const DEFAULT_YEAR = 2026;

function loadRepoDotenv() {
	const envPath = path.join(REPO_ROOT, ".env");
	if (!existsSync(envPath)) return;
	const raw = readFileSync(envPath, "utf8");
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const cleaned = trimmed.startsWith("export ")
			? trimmed.slice(7).trim()
			: trimmed;
		const eqIdx = cleaned.indexOf("=");
		if (eqIdx <= 0) continue;
		const key = cleaned.slice(0, eqIdx).trim();
		let val = cleaned.slice(eqIdx + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		if (key && process.env[key] === undefined) {
			process.env[key] = val;
		}
	}
}

const HELP_TEXT = `Usage: node scripts/collection-seed-publish.mjs [options]

Maintainer pipeline to crawl 2026 Venue + arXiv papers, bake citation edges and
maintainer LLM keywords into collection.sqlite, export compressed seed bundles,
and optionally publish assets to GitHub Release (${DEFAULT_RELEASE_TAG}).

Options:
  -h, --help                  Show this help message and exit
  --dry-run                   Verify Vite SSR TS module loading and print planned steps
  --skip-fetch                Skip Step 1 upstream fetching; run Step 2 seed-bake directly
  --only-venues               Fetch only 2026 Venues in Step 1 (skip arXiv)
  --only-arxiv                Fetch only 2026 arXiv categories in Step 1 (skip Venues)
  --venues <ids>              Comma-separated venue IDs to fetch (default: all 28 built-in)
  --categories <cats>         Comma-separated arXiv categories (default: ${DEFAULT_CATEGORIES})
  --year <yyyy>               Target publication year (default: ${DEFAULT_YEAR})
  --db <path>                 Custom path to collection.sqlite
  --out-dir <dir>             Output directory for seed bundle (default: ${DEFAULT_OUT_DIR})
  --llm-base-url <url>        OpenAI-compatible base URL (default: ${DEFAULT_LLM_BASE_URL})
  --llm-model <model>         Model name for seed-bake (default: ${DEFAULT_LLM_MODEL})
  --llm-api-key <key>         API key for seed-bake LLM (or AGENTERO_KEYWORD_LLM_API_KEY env)
  --llm-concurrency <n>       Concurrent LLM requests in seed-bake (default: ${DEFAULT_LLM_CONCURRENCY})
  --llm-batch-size <n>        Papers per LLM batch in seed-bake (default: ${DEFAULT_LLM_BATCH_SIZE})
  --llm-rpm <n>               Hard RPM limit across workers (0 disables; default: ${DEFAULT_LLM_RPM})
  --openalex-api-key <key>    OpenAlex API key for Step 1 (or OPENALEX_API_KEY env)
  --skip-refs                 Pass --skip-refs to agentero-cli collection seed-bake
  --skip-llm                  Pass --skip-llm to agentero-cli collection seed-bake
  --delta-since <iso>         Also emit delta bundle since ISO timestamp in seed-bake
  --upload                    Upload exported seed assets to GitHub Release (--prerelease)
  --no-upload                 Do not upload to GitHub Release (default)
  --release-tag <tag>         GitHub Release tag name (default: ${DEFAULT_RELEASE_TAG})
  --repo <owner/name>         GitHub repository slug (auto-detected from git origin if omitted)

Examples:
  pnpm collection:seed-publish --dry-run
  pnpm collection:seed-publish --categories cs.SE,cs.CR,cs.PL,cs.AI
  pnpm collection:seed-publish --skip-fetch --out-dir dist/seed --upload
`;

function parseCliOptions(argv) {
	const { values } = parseArgs({
		args: argv,
		strict: true,
		allowNegative: true,
		options: {
			help: { type: "boolean", short: "h", default: false },
			"dry-run": { type: "boolean", default: false },
			"skip-fetch": { type: "boolean", default: false },
			"only-venues": { type: "boolean", default: false },
			"only-arxiv": { type: "boolean", default: false },
			venues: { type: "string" },
			categories: { type: "string", default: DEFAULT_CATEGORIES },
			year: { type: "string", default: String(DEFAULT_YEAR) },
			db: { type: "string" },
			"out-dir": { type: "string", default: DEFAULT_OUT_DIR },
			"llm-base-url": { type: "string", default: DEFAULT_LLM_BASE_URL },
			"llm-model": { type: "string", default: DEFAULT_LLM_MODEL },
			"llm-api-key": { type: "string" },
			"llm-concurrency": {
				type: "string",
				default: String(DEFAULT_LLM_CONCURRENCY),
			},
			"llm-batch-size": {
				type: "string",
				default: String(DEFAULT_LLM_BATCH_SIZE),
			},
			"llm-rpm": { type: "string", default: String(DEFAULT_LLM_RPM) },
			"openalex-api-key": { type: "string" },
			"skip-refs": { type: "boolean", default: false },
			"skip-llm": { type: "boolean", default: false },
			"delta-since": { type: "string" },
			upload: { type: "boolean", default: false },
			"release-tag": { type: "string", default: DEFAULT_RELEASE_TAG },
			repo: { type: "string" },
		},
	});

	if (values["only-venues"] && values["only-arxiv"]) {
		throw new Error("Cannot combine --only-venues and --only-arxiv.");
	}

	const year = Number.parseInt(values.year, 10);
	if (!Number.isFinite(year) || year < 2000 || year > 2100) {
		throw new Error(`Invalid --year value: ${values.year}`);
	}

	const llmConcurrency = Number.parseInt(values["llm-concurrency"], 10);
	if (!Number.isFinite(llmConcurrency) || llmConcurrency < 1) {
		throw new Error(
			`Invalid --llm-concurrency value: ${values["llm-concurrency"]}`,
		);
	}
	const llmBatchSize = Number.parseInt(values["llm-batch-size"], 10);
	if (!Number.isFinite(llmBatchSize) || llmBatchSize < 1 || llmBatchSize > 32) {
		throw new Error(
			`Invalid --llm-batch-size value: ${values["llm-batch-size"]}`,
		);
	}
	const llmRpm = Number.parseInt(values["llm-rpm"], 10);
	if (!Number.isFinite(llmRpm) || llmRpm < 0) {
		throw new Error(`Invalid --llm-rpm value: ${values["llm-rpm"]}`);
	}

	const categories = values.categories
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const venueFilter = values.venues
		? new Set(
				values.venues
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
			)
		: null;

	return {
		help: Boolean(values.help),
		dryRun: Boolean(values["dry-run"]),
		skipFetch: Boolean(values["skip-fetch"]),
		onlyVenues: Boolean(values["only-venues"]),
		onlyArxiv: Boolean(values["only-arxiv"]),
		venueFilter,
		categories,
		year,
		dbPath: values.db ? path.resolve(REPO_ROOT, values.db) : null,
		outDir: path.resolve(REPO_ROOT, values["out-dir"]),
		llmBaseUrl: values["llm-base-url"],
		llmModel: values["llm-model"],
		llmApiKey:
			values["llm-api-key"] ??
			process.env.AGENTERO_KEYWORD_LLM_API_KEY ??
			undefined,
		llmConcurrency,
		llmBatchSize,
		llmRpm,
		openAlexApiKey:
			values["openalex-api-key"] ?? process.env.OPENALEX_API_KEY ?? null,
		skipRefs: Boolean(values["skip-refs"]),
		skipLlm: Boolean(values["skip-llm"]),
		deltaSince: values["delta-since"] ?? null,
		upload: Boolean(values.upload),
		releaseTag: values["release-tag"],
		repo: values.repo ?? null,
	};
}

function sleepMs(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerVal) {
	if (!headerVal) return null;
	const trimmed = String(headerVal).trim();
	if (!trimmed) return null;
	const secs = Number(trimmed);
	if (Number.isFinite(secs) && secs >= 0) {
		return Math.min(120_000, Math.ceil(secs * 1000));
	}
	const dateMs = Date.parse(trimmed);
	if (!Number.isNaN(dateMs)) {
		return Math.min(120_000, Math.max(0, dateMs - Date.now()));
	}
	return null;
}

/**
 * Node fetch text wrapper with patient HTTP 429 / 5xx exponential backoff.
 */
async function resilientFetchText(
	url,
	accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
) {
	const maxAttempts = 6;
	let lastErr = null;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const res = await fetch(url, {
				headers: {
					Accept: accept,
					"User-Agent":
						"Mozilla/5.0 (compatible; AgenteroSeedBot/0.1; +https://github.com/nonsense-j/Agentero)",
				},
				signal: AbortSignal.timeout(60_000),
			});

			if (res.ok && res.status !== 202) {
				return await res.text();
			}

			if (
				res.status === 429 ||
				res.status === 502 ||
				res.status === 503 ||
				res.status === 504
			) {
				const retryAfter = parseRetryAfterMs(res.headers.get("retry-after"));
				const expWait = Math.min(60_000, 3_000 * 2 ** attempt);
				const waitMs = retryAfter ? Math.max(retryAfter, expWait) : expWait;
				console.warn(
					`[fetch] HTTP ${res.status} on ${url} (attempt ${attempt + 1}/${maxAttempts}), backing off ${Math.round(waitMs / 1000)}s...`,
				);
				await sleepMs(waitMs);
				lastErr = new Error(`HTTP ${res.status} fetching ${url}`);
				continue;
			}

			throw new Error(`HTTP ${res.status} fetching ${url}`);
		} catch (err) {
			lastErr = err;
			const msg = err instanceof Error ? err.message : String(err);
			const isNetTransient =
				/timeout|aborted|fetch failed|econnreset|socket|502|503|504|429/i.test(
					msg,
				);
			if (isNetTransient && attempt + 1 < maxAttempts) {
				const waitMs = Math.min(45_000, 2_500 * 2 ** attempt);
				console.warn(
					`[fetch] Transient error on ${url} (${msg}), retrying in ${Math.round(waitMs / 1000)}s...`,
				);
				await sleepMs(waitMs);
				continue;
			}
			throw err;
		}
	}

	throw lastErr ?? new Error(`Exhausted retries fetching ${url}`);
}

async function resilientFetchJson(url) {
	const text = await resilientFetchText(url, "application/json");
	const trimmed = text.trimStart();
	if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
		throw new Error(`Expected JSON but received HTML from ${url}`);
	}
	return JSON.parse(text);
}

function decodeXmlEntities(raw) {
	return raw
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function stripArxivVer(id) {
	return String(id ?? "")
		.replace(/v\d+$/i, "")
		.trim();
}

function formatArxivDateStamp(utcMs) {
	const d = new Date(utcMs);
	const yyyy = String(d.getUTCFullYear());
	const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(d.getUTCDate()).padStart(2, "0");
	const hh = String(d.getUTCHours()).padStart(2, "0");
	const min = String(d.getUTCMinutes()).padStart(2, "0");
	return `${yyyy}${mm}${dd}${hh}${min}`;
}

function toArxivUpperDateStamp(isoString, targetYear, minusMinutes = 0) {
	const parsed = Date.parse(isoString);
	if (Number.isNaN(parsed)) return `${targetYear}12312359`;
	const minYearMs = Date.UTC(targetYear, 0, 1, 0, 0, 0);
	const roundedUpMinute =
		Math.floor(parsed / 60_000) * 60_000 + (1 - minusMinutes) * 60_000;
	return formatArxivDateStamp(Math.max(minYearMs, roundedUpMinute));
}

/**
 * Parse arXiv Atom feed entries while preserving `<arxiv:doi>` publisher DOIs.
 */
function parseArxivAtomPage(
	xmlText,
	cat,
	preferredCategories,
	targetYear,
	extractArxivDoiFromAtomEntry,
) {
	const preferredSet = new Set(preferredCategories);
	const totalMatch =
		/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/i.exec(
			xmlText,
		);
	const totalResults = totalMatch?.[1] ? Number(totalMatch[1]) : undefined;

	let rawEntryCount = 0;
	let newestPublishedAt;
	let oldestPublishedAt;
	const items = [];

	for (const match of xmlText.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
		rawEntryCount += 1;
		const block = match[1] ?? "";
		const rawId = /<id>([\s\S]*?)<\/id>/i.exec(block)?.[1]?.trim() ?? "";
		const rawTitle =
			/<title>([\s\S]*?)<\/title>/i.exec(block)?.[1]?.trim() ?? "";
		const rawSummary =
			/<summary>([\s\S]*?)<\/summary>/i.exec(block)?.[1]?.trim() ?? "";
		const published =
			/<published>([\s\S]*?)<\/published>/i.exec(block)?.[1]?.trim() ||
			/<updated>([\s\S]*?)<\/updated>/i.exec(block)?.[1]?.trim() ||
			"";

		if (published) {
			if (!newestPublishedAt || published > newestPublishedAt) {
				newestPublishedAt = published;
			}
			if (!oldestPublishedAt || published < oldestPublishedAt) {
				oldestPublishedAt = published;
			}
		}

		if (!rawTitle) continue;
		const idMatch = /arxiv\.org\/abs\/([^\s?#<]+)/i.exec(rawId);
		const arxivId = stripArxivVer(idMatch ? idMatch[1] : rawId);
		if (!arxivId) continue;

		const yearMatch = /^(\d{4})/.exec(published);
		const year = yearMatch ? Number(yearMatch[1]) : targetYear;
		if (year < targetYear || year > targetYear) continue;

		const authors = [];
		for (const am of block.matchAll(
			/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi,
		)) {
			const name = decodeXmlEntities(am[1] ?? "");
			if (name) authors.push(name);
		}

		const categories = [];
		for (const cm of block.matchAll(
			/<category[^>]*\bterm=["']([^"']+)["'][^>]*>/gi,
		)) {
			const term = (cm[1] ?? "").trim();
			if (term && !categories.includes(term)) categories.push(term);
		}
		if (!categories.includes(cat)) categories.push(cat);

		const rawPrimaryCat =
			/<arxiv:primary_category[^>]*\bterm=["']([^"']+)["']/i.exec(block)?.[1] ??
			categories[0] ??
			cat;
		const primaryCat =
			preferredSet.size > 0 && !preferredSet.has(rawPrimaryCat)
				? (categories.find((c) => preferredSet.has(c)) ?? cat)
				: rawPrimaryCat;

		const doi = extractArxivDoiFromAtomEntry(block, arxivId);

		items.push({
			id: `arxiv:${arxivId}`,
			arxivId,
			doi,
			title: decodeXmlEntities(rawTitle),
			authors,
			abstract: decodeXmlEntities(rawSummary),
			publishedAt: published || `${year}-01-01T00:00:00Z`,
			year,
			sourceType: "arxiv",
			sourceLabel: primaryCat,
			categories,
			url: `https://arxiv.org/abs/${arxivId}`,
			pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`,
			citationCount: 0,
			keywords: [],
		});
	}

	return {
		items,
		rawEntryCount,
		totalResults,
		newestPublishedAt,
		oldestPublishedAt,
	};
}

function buildAgenteroCliBinary() {
	console.log("[cli] Building release agentero-cli binary...");
	const buildRes = spawnSync(
		"cargo",
		["build", "--release", "-p", "agentero-cli"],
		{
			cwd: REPO_ROOT,
			stdio: "inherit",
			windowsHide: true,
		},
	);
	if (buildRes.status !== 0) {
		throw new Error(
			`cargo build --release -p agentero-cli failed (exit ${buildRes.status})`,
		);
	}

	const exeName = process.platform === "win32" ? "agentero.exe" : "agentero";
	const targetDir = process.env.CARGO_TARGET_DIR
		? path.resolve(REPO_ROOT, process.env.CARGO_TARGET_DIR)
		: path.join(REPO_ROOT, "target");
	const binPath = path.join(targetDir, "release", exeName);
	if (existsSync(binPath)) {
		return { cmd: binPath, prefixArgs: [] };
	}
	return {
		cmd: "cargo",
		prefixArgs: ["run", "--release", "-p", "agentero-cli", "--"],
	};
}

function runAgenteroCli(cliRunner, subArgs) {
	const fullArgs = [...cliRunner.prefixArgs, ...subArgs];
	const res = spawnSync(cliRunner.cmd, fullArgs, {
		cwd: REPO_ROOT,
		stdio: "inherit",
		windowsHide: true,
	});
	if (res.status !== 0) {
		throw new Error(
			`agentero-cli command failed (exit ${res.status}): ${cliRunner.cmd} ${fullArgs.join(" ")}`,
		);
	}
}

async function runUpsertFile(cliRunner, tmpDir, tag, payload, dbPath, venueId) {
	const safeTag = tag.replace(/[^a-zA-Z0-9._-]+/g, "_");
	const jsonPath = path.join(tmpDir, `upsert-${safeTag}-${Date.now()}.json`);
	await writeFile(jsonPath, JSON.stringify(payload), "utf8");
	try {
		const args = ["collection", "upsert-file", "--file", jsonPath];
		if (venueId) {
			args.push("--replace-venue-id", venueId);
		}
		if (dbPath) {
			args.push("--db", dbPath);
		}
		runAgenteroCli(cliRunner, args);
	} finally {
		await rm(jsonPath, { force: true });
	}
}

async function loadPlazaTsPipeline(openAlexApiKey) {
	const { createServer } = await import("vite");
	const vite = await createServer({
		root: REPO_ROOT,
		appType: "custom",
		logLevel: "error",
		optimizeDeps: {
			noDiscovery: true,
			entries: [],
		},
		server: {
			middlewareMode: true,
			hmr: false,
			watch: null,
		},
	});

	try {
		const keywordLlmMod = await vite.ssrLoadModule("/src/lib/keyword-llm.ts");
		const openAlexMod = await vite.ssrLoadModule("/src/lib/openalex.ts");
		const enrichmentMod = await vite.ssrLoadModule(
			"/src/lib/plaza/collection-enrichment.ts",
		);
		const venueChannelsMod = await vite.ssrLoadModule(
			"/src/lib/plaza/collection-venue-channels.ts",
		);

		// Disable frontend BYOK LLM during Step 1 so all keyword baking runs in Step 2 Rust seed-bake.
		keywordLlmMod.setCachedKeywordLlmConfigForTests(null);
		openAlexMod.setCachedOpenAlexApiKeyForTests(openAlexApiKey);

		return {
			vite,
			VENUE_SPECS: enrichmentMod.VENUE_SPECS,
			extractArxivDoiFromAtomEntry: enrichmentMod.extractArxivDoiFromAtomEntry,
			fetchMultiChannelVenuePapers:
				venueChannelsMod.fetchMultiChannelVenuePapers,
		};
	} catch (err) {
		await vite.close();
		throw err;
	}
}

async function crawlArxivCategoryIntoDb({
	cat,
	allCategories,
	year,
	extractArxivDoiFromAtomEntry,
	cliRunner,
	tmpDir,
	dbPath,
}) {
	const fromStamp = `${year}01010000`;
	let upperStamp = `${year}12312359`;
	const pageSize = 200;
	const maxOffsetPerWindow = 800;

	const seenIds = new Set();
	let pendingBatch = [];
	let remoteTotal;
	let newestPublishedAt;
	let newestArxivId;
	let oldestPublishedAt;
	let stalledWindows = 0;

	console.log(`[arxiv:${cat}] Crawling ${year} papers...`);

	while (stalledWindows < 3) {
		let windowOldestPublishedAt;
		let reachedEnd = false;

		for (
			let startOffset = 0;
			startOffset <= maxOffsetPerWindow;
			startOffset += pageSize
		) {
			const dateBound = `+AND+submittedDate:[${fromStamp}+TO+${upperStamp}]`;
			const apiUrl = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(cat)}${dateBound}&sortBy=submittedDate&sortOrder=descending&start=${startOffset}&max_results=${pageSize}`;

			const xml = await resilientFetchText(
				apiUrl,
				"application/atom+xml,text/xml,*/*",
			);
			const page = parseArxivAtomPage(
				xml,
				cat,
				allCategories,
				year,
				extractArxivDoiFromAtomEntry,
			);

			if (remoteTotal === undefined && page.totalResults !== undefined) {
				remoteTotal = page.totalResults;
			}

			for (const item of page.items) {
				if (!newestPublishedAt || item.publishedAt > newestPublishedAt) {
					newestPublishedAt = item.publishedAt;
					newestArxivId = item.arxivId;
				}
				if (!oldestPublishedAt || item.publishedAt < oldestPublishedAt) {
					oldestPublishedAt = item.publishedAt;
				}
				if (!seenIds.has(item.id)) {
					seenIds.add(item.id);
					pendingBatch.push(item);
				}
			}

			if (page.oldestPublishedAt) {
				windowOldestPublishedAt = page.oldestPublishedAt;
			}

			if (pendingBatch.length >= 400) {
				const nowIso = new Date().toISOString();
				await runUpsertFile(
					cliRunner,
					tmpDir,
					`arxiv-${cat}`,
					{
						items: pendingBatch,
						lastRefreshedAt: nowIso,
					},
					dbPath,
					null,
				);
				console.log(
					`[arxiv:${cat}] Flushed ${pendingBatch.length} papers (total unique: ${seenIds.size})`,
				);
				pendingBatch = [];
			}

			const oldestYear = Number(
				/^(\d{4})/.exec(page.oldestPublishedAt ?? "")?.[1] ?? year,
			);
			if (page.rawEntryCount < pageSize || oldestYear < year) {
				reachedEnd = true;
				break;
			}

			// Respect arXiv API's 3-second courtesy spacing between paginated requests.
			await sleepMs(3_250);
		}

		if (reachedEnd || !windowOldestPublishedAt) {
			break;
		}

		const nextUpper = toArxivUpperDateStamp(
			windowOldestPublishedAt,
			year,
			stalledWindows > 0 ? stalledWindows * 5 : 0,
		);
		if (nextUpper >= upperStamp) {
			stalledWindows += 1;
			const forcedUpper = toArxivUpperDateStamp(
				windowOldestPublishedAt,
				year,
				stalledWindows * 15,
			);
			if (forcedUpper >= upperStamp || forcedUpper <= fromStamp) {
				break;
			}
			upperStamp = forcedUpper;
		} else {
			stalledWindows = 0;
			upperStamp = nextUpper;
		}
		await sleepMs(3_250);
	}

	const nowIso = new Date().toISOString();
	const watermarkPayload =
		newestPublishedAt && newestArxivId
			? {
					[cat]: {
						latestPublishedAt: newestPublishedAt,
						latestArxivId: newestArxivId,
						lastSyncedAt: nowIso,
						oldestSyncedPublishedAt: oldestPublishedAt ?? newestPublishedAt,
						...(remoteTotal !== undefined ? { remoteTotal } : {}),
						historyComplete: true,
					},
				}
			: undefined;

	if (pendingBatch.length > 0 || watermarkPayload) {
		await runUpsertFile(
			cliRunner,
			tmpDir,
			`arxiv-${cat}-final`,
			{
				items: pendingBatch,
				...(watermarkPayload ? { arxivWatermarks: watermarkPayload } : {}),
				lastRefreshedAt: nowIso,
			},
			dbPath,
			null,
		);
	}

	console.log(
		`[arxiv:${cat}] Completed: ${seenIds.size} unique ${year} papers.`,
	);
}

function detectGitHubRepoSlug(explicitRepo) {
	if (explicitRepo) return explicitRepo;
	if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
	try {
		const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			windowsHide: true,
		}).trim();
		const m = /github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/i.exec(remoteUrl);
		if (m?.[1]) return m[1];
	} catch {
		// Ignore git remote lookup errors.
	}
	return null;
}

function collectSeedAssetFiles(outDir) {
	if (!existsSync(outDir)) {
		throw new Error(`Seed output directory does not exist: ${outDir}`);
	}
	const entries = readdirSync(outDir);
	const assets = entries
		.filter((name) => name === "manifest.json" || name.endsWith(".jsonl.gz"))
		.map((name) => path.join(outDir, name))
		.filter((fullPath) => statSync(fullPath).isFile());
	if (assets.length === 0) {
		throw new Error(
			`No seed bundle assets (manifest.json / *.jsonl.gz) found in ${outDir}`,
		);
	}
	return assets;
}

function hasGhCli() {
	const res = spawnSync("gh", ["--version"], {
		cwd: REPO_ROOT,
		stdio: "ignore",
		windowsHide: true,
	});
	return res.status === 0;
}

async function uploadReleaseAssetsViaRestApi(repoSlug, tag, assetPaths, token) {
	const apiBase = `https://api.github.com/repos/${repoSlug}`;
	const authHeaders = {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "AgenteroSeedPublisher",
	};

	let release = null;
	const getRes = await fetch(
		`${apiBase}/releases/tags/${encodeURIComponent(tag)}`,
		{ headers: authHeaders },
	);
	if (getRes.ok) {
		release = await getRes.json();
	} else if (getRes.status === 404) {
		const createRes = await fetch(`${apiBase}/releases`, {
			method: "POST",
			headers: {
				...authHeaders,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				tag_name: tag,
				name: `Plaza Paper Collection Seed (${tag})`,
				body: "Automated Plaza 2026 paper collection seed snapshot (`manifest.json` + `.jsonl.gz`).",
				draft: false,
				prerelease: true,
			}),
		});
		if (!createRes.ok) {
			throw new Error(
				`GitHub create release failed (HTTP ${createRes.status}): ${await createRes.text()}`,
			);
		}
		release = await createRes.json();
	} else {
		throw new Error(
			`GitHub get release failed (HTTP ${getRes.status}): ${await getRes.text()}`,
		);
	}

	const uploadBaseUrl = String(release.upload_url ?? "").replace(
		/\{\?name,label\}$/,
		"",
	);
	if (!uploadBaseUrl) {
		throw new Error("GitHub release payload missing upload_url.");
	}

	const existingAssets = Array.isArray(release.assets) ? release.assets : [];
	for (const assetPath of assetPaths) {
		const fileName = path.basename(assetPath);
		const prev = existingAssets.find((a) => a?.name === fileName);
		if (prev?.id) {
			const delRes = await fetch(`${apiBase}/releases/assets/${prev.id}`, {
				method: "DELETE",
				headers: authHeaders,
			});
			if (!delRes.ok && delRes.status !== 404) {
				throw new Error(
					`Failed deleting existing asset ${fileName} (HTTP ${delRes.status})`,
				);
			}
		}

		const bodyBytes = await readFile(assetPath);
		const contentType = fileName.endsWith(".json")
			? "application/json"
			: "application/gzip";
		const upRes = await fetch(
			`${uploadBaseUrl}?name=${encodeURIComponent(fileName)}`,
			{
				method: "POST",
				headers: {
					...authHeaders,
					"Content-Type": contentType,
				},
				body: bodyBytes,
			},
		);
		if (!upRes.ok) {
			throw new Error(
				`Failed uploading asset ${fileName} (HTTP ${upRes.status}): ${await upRes.text()}`,
			);
		}
		console.log(`[upload] Uploaded ${fileName} to ${repoSlug}@${tag}`);
	}
}

async function publishSeedToGitHubRelease({ outDir, releaseTag, repo }) {
	const assetPaths = collectSeedAssetFiles(outDir);
	const repoSlug = detectGitHubRepoSlug(repo);

	if (hasGhCli()) {
		const repoArgs = repoSlug ? ["--repo", repoSlug] : [];
		const viewRes = spawnSync(
			"gh",
			["release", "view", releaseTag, ...repoArgs],
			{
				cwd: REPO_ROOT,
				stdio: "ignore",
				windowsHide: true,
			},
		);
		if (viewRes.status !== 0) {
			console.log(`[upload] Creating GitHub prerelease ${releaseTag}...`);
			const createRes = spawnSync(
				"gh",
				[
					"release",
					"create",
					releaseTag,
					...assetPaths,
					"--prerelease",
					"--title",
					`Plaza Paper Collection Seed (${releaseTag})`,
					"--notes",
					"Automated Plaza 2026 paper collection seed snapshot (`manifest.json` + `.jsonl.gz`).",
					...repoArgs,
				],
				{
					cwd: REPO_ROOT,
					stdio: "inherit",
					windowsHide: true,
				},
			);
			if (createRes.status !== 0) {
				throw new Error(
					`gh release create ${releaseTag} failed (exit ${createRes.status})`,
				);
			}
			return;
		}

		console.log(
			`[upload] Uploading ${assetPaths.length} assets to ${releaseTag} (--clobber)...`,
		);
		const uploadRes = spawnSync(
			"gh",
			[
				"release",
				"upload",
				releaseTag,
				...assetPaths,
				"--clobber",
				...repoArgs,
			],
			{
				cwd: REPO_ROOT,
				stdio: "inherit",
				windowsHide: true,
			},
		);
		if (uploadRes.status !== 0) {
			throw new Error(
				`gh release upload ${releaseTag} failed (exit ${uploadRes.status})`,
			);
		}
		return;
	}

	const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (ghToken && repoSlug) {
		await uploadReleaseAssetsViaRestApi(
			repoSlug,
			releaseTag,
			assetPaths,
			ghToken,
		);
		return;
	}

	throw new Error(
		"Cannot upload seed bundle: neither `gh` CLI nor (`GITHUB_TOKEN` + `--repo`) is available.",
	);
}

function resolveAgenteroSettingsCandidates() {
	const candidates = [];
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	if (xdg) {
		candidates.push(path.join(xdg, "agentero", "settings.json"));
	}
	if (process.platform === "win32") {
		const appData =
			process.env.APPDATA?.trim() ||
			path.join(os.homedir(), "AppData", "Roaming");
		candidates.push(path.join(appData, "agentero", "settings.json"));
	} else if (process.platform === "darwin") {
		candidates.push(
			path.join(os.homedir(), ".config", "agentero", "settings.json"),
			path.join(
				os.homedir(),
				"Library",
				"Application Support",
				"agentero",
				"settings.json",
			),
		);
	} else {
		candidates.push(
			path.join(os.homedir(), ".config", "agentero", "settings.json"),
		);
	}
	return Array.from(new Set(candidates));
}

function mergeLoopbackNoProxy(existing) {
	const parts = String(existing || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	for (const host of ["127.0.0.1", "localhost"]) {
		if (!parts.some((p) => p.toLowerCase() === host)) {
			parts.push(host);
		}
	}
	return parts.join(",");
}

async function bootstrapNetworkProxy() {
	const hadEnvProxy = Boolean(
		process.env.HTTP_PROXY?.trim() ||
			process.env.HTTPS_PROXY?.trim() ||
			process.env.http_proxy?.trim() ||
			process.env.https_proxy?.trim(),
	);
	const hadStartupNodeEnvProxy =
		process.execArgv.includes("--use-env-proxy") ||
		(hadEnvProxy && process.env.NODE_USE_ENV_PROXY === "1");

	if (!hadEnvProxy) {
		for (const settingsPath of resolveAgenteroSettingsCandidates()) {
			if (!existsSync(settingsPath)) continue;
			try {
				const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
				const proxyUrl =
					raw?.networkProxyEnabled === true &&
					typeof raw?.networkProxyUrl === "string"
						? raw.networkProxyUrl.trim()
						: "";
				if (proxyUrl) {
					process.env.HTTP_PROXY = proxyUrl;
					process.env.HTTPS_PROXY = proxyUrl;
					process.env.NO_PROXY = mergeLoopbackNoProxy(process.env.NO_PROXY);
					process.env.NODE_USE_ENV_PROXY = "1";
					console.error(
						`[proxy] Auto-loaded network proxy from ${settingsPath}: ${proxyUrl}`,
					);
					break;
				}
			} catch {
				// Ignore unreadable or malformed settings.json
			}
		}
	} else {
		process.env.NO_PROXY = mergeLoopbackNoProxy(process.env.NO_PROXY);
	}

	const activeProxy =
		process.env.HTTPS_PROXY?.trim() ||
		process.env.HTTP_PROXY?.trim() ||
		process.env.https_proxy?.trim() ||
		process.env.http_proxy?.trim() ||
		"";
	if (!activeProxy) return false;

	const undiciMod = await import("undici").catch(() => null);
	if (undiciMod?.EnvHttpProxyAgent && undiciMod?.setGlobalDispatcher) {
		undiciMod.setGlobalDispatcher(new undiciMod.EnvHttpProxyAgent());
		return false;
	}

	if (
		!hadStartupNodeEnvProxy &&
		process.env.AGENTERO_SEED_PROXY_BOOTSTRAPPED !== "1"
	) {
		const probe = spawnSync(process.execPath, ["--use-env-proxy", "-e", "0"], {
			stdio: "ignore",
		});
		if (probe.status === 0) {
			const child = spawnSync(
				process.execPath,
				["--use-env-proxy", ...process.argv.slice(1)],
				{
					stdio: "inherit",
					env: {
						...process.env,
						NODE_USE_ENV_PROXY: "1",
						AGENTERO_SEED_PROXY_BOOTSTRAPPED: "1",
					},
				},
			);
			process.exitCode = child.status ?? 1;
			return true;
		}
	}

	return false;
}

async function main() {
	loadRepoDotenv();
	const opts = parseCliOptions(process.argv.slice(2));
	if (opts.help) {
		process.stdout.write(HELP_TEXT);
		return;
	}

	if (await bootstrapNetworkProxy()) {
		return;
	}

	if (opts.dryRun) {
		const pipeline = await loadPlazaTsPipeline(opts.openAlexApiKey);
		try {
			const targetVenues = pipeline.VENUE_SPECS.filter(
				(v) => !opts.venueFilter || opts.venueFilter.has(v.id),
			);
			console.log(
				JSON.stringify(
					{
						status: "ok",
						mode: "dry-run",
						year: opts.year,
						skipFetch: opts.skipFetch,
						venueCount: opts.onlyArxiv ? 0 : targetVenues.length,
						categories: opts.onlyVenues ? [] : opts.categories,
						outDir: opts.outDir,
						llmBaseUrl: opts.llmBaseUrl,
						llmModel: opts.llmModel,
						llmConcurrency: opts.llmConcurrency,
						proxyUrl:
							process.env.HTTPS_PROXY ||
							process.env.HTTP_PROXY ||
							process.env.https_proxy ||
							process.env.http_proxy ||
							null,
						upload: opts.upload,
						releaseTag: opts.releaseTag,
					},
					null,
					2,
				),
			);
		} finally {
			await pipeline.vite.close();
		}
		return;
	}

	const cliRunner = buildAgenteroCliBinary();

	if (!opts.skipFetch) {
		const pipeline = await loadPlazaTsPipeline(opts.openAlexApiKey);
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "agentero-seed-"));

		try {
			if (!opts.onlyArxiv) {
				const targetVenues = pipeline.VENUE_SPECS.filter(
					(spec) => !opts.venueFilter || opts.venueFilter.has(spec.id),
				);
				console.log(
					`[venues] Fetching ${targetVenues.length} venues for ${opts.year}...`,
				);

				for (let i = 0; i < targetVenues.length; i++) {
					const spec = targetVenues[i];
					const venueConfig = {
						id: spec.id,
						name: spec.name,
						url: spec.url,
						tracks: [...spec.tracks],
						mode: "auto",
						kind: spec.kind,
						domain: spec.domain,
						ccfRank: spec.ccfRank,
					};

					console.log(
						`[venues ${i + 1}/${targetVenues.length}] Crawling ${spec.name} (${spec.id})...`,
					);
					try {
						const res = await pipeline.fetchMultiChannelVenuePapers(
							venueConfig,
							opts.year,
							resilientFetchJson,
							resilientFetchText,
							{ maxPages: 30, skipTitleSearch: true },
						);
						const nowIso = new Date().toISOString();
						await runUpsertFile(
							cliRunner,
							tmpDir,
							`venue-${spec.id}`,
							{
								items: res.items,
								replaceVenueId: spec.id,
								venueUpdate: {
									venueId: spec.id,
									lastFetchedAt: nowIso,
									latestPublishedAt: res.latestPublishedAt,
									remoteTotalCount: res.remoteTotalCount,
								},
								lastRefreshedAt: nowIso,
							},
							opts.dbPath,
							spec.id,
						);
						console.log(
							`[venues ${i + 1}/${targetVenues.length}] Upserted ${res.items.length} papers for ${spec.name}.`,
						);
					} catch (err) {
						console.error(
							`[venues] Failed crawling ${spec.name} (${spec.id}):`,
							err instanceof Error ? err.message : err,
						);
					}
				}
			}

			if (!opts.onlyVenues) {
				for (const cat of opts.categories) {
					await crawlArxivCategoryIntoDb({
						cat,
						allCategories: opts.categories,
						year: opts.year,
						extractArxivDoiFromAtomEntry: pipeline.extractArxivDoiFromAtomEntry,
						cliRunner,
						tmpDir,
						dbPath: opts.dbPath,
					});
				}
			}
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
			await pipeline.vite.close();
		}
	}

	// Step 2: Bake citation edges + maintainer LLM keywords + export seed bundle
	const bakeArgs = [
		"collection",
		"seed-bake",
		"--out-dir",
		opts.outDir,
		"--llm-base-url",
		opts.llmBaseUrl,
		"--llm-model",
		opts.llmModel,
		"--llm-concurrency",
		String(opts.llmConcurrency),
		"--llm-batch-size",
		String(opts.llmBatchSize),
		"--llm-rpm",
		String(opts.llmRpm),
	];
	if (opts.dbPath) {
		bakeArgs.push("--db", opts.dbPath);
	}
	if (opts.llmApiKey) {
		bakeArgs.push("--llm-api-key", opts.llmApiKey);
	}
	if (opts.skipRefs) {
		bakeArgs.push("--skip-refs");
	}
	if (opts.skipLlm) {
		bakeArgs.push("--skip-llm");
	}
	if (opts.deltaSince) {
		bakeArgs.push("--delta-since", opts.deltaSince);
	}

	console.log(`[seed-bake] Running agentero-cli ${bakeArgs.join(" ")}...`);
	runAgenteroCli(cliRunner, bakeArgs);

	// Step 3: Optional GitHub Release upload
	if (opts.upload) {
		await publishSeedToGitHubRelease({
			outDir: opts.outDir,
			releaseTag: opts.releaseTag,
			repo: opts.repo,
		});
	} else {
		console.log(
			`[done] Seed bundle ready in ${opts.outDir} (pass --upload to publish to GitHub Release ${opts.releaseTag}).`,
		);
	}
}

main().catch((err) => {
	console.error(
		"[collection-seed-publish] Fatal:",
		err instanceof Error ? err.stack || err.message : err,
	);
	process.exitCode = 1;
});
