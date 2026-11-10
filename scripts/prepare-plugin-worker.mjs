/**
 * Build the plugin worker (`agentero-plugin-host`) and stage it where Tauri
 * `bundle.externalBin` expects a sidecar:
 * `src-tauri/binaries/agentero-plugin-host-<triple>[.exe]`.
 *
 * Desktop `tauri-build` copies that file next to the app exe and hard-fails
 * when it is missing (including `cargo test -p agentero` and clippy). iOS and
 * Android keep `externalBin: []` and skip this script. This is a real console
 * binary, not the historical CLI batch stub.
 *
 * Usage:
 *   node scripts/prepare-plugin-worker.mjs           # debug (default)
 *   node scripts/prepare-plugin-worker.mjs --release
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const release = process.argv.includes("--release");
const MIN_BYTES = 64 * 1024;

function hostTriple() {
	try {
		return execSync("rustc --print host-tuple", { encoding: "utf8" }).trim();
	} catch {
		const out = execSync("rustc -Vv", { encoding: "utf8" });
		const line = out.split("\n").find((l) => l.startsWith("host:"));
		if (!line) throw new Error("could not determine host triple");
		return line.split(/\s+/)[1];
	}
}

function rustcCanTarget(triple) {
	const listed = execSync("rustc --print target-list", { encoding: "utf8" });
	return listed.split("\n").some((line) => line.trim() === triple);
}

const tauriPlatform = process.env.TAURI_ENV_PLATFORM || "";
const envTriple = process.env.TAURI_ENV_TARGET_TRIPLE || "";
const isMobile =
	tauriPlatform === "android" ||
	tauriPlatform === "ios" ||
	/-android|-ios\b/.test(envTriple);
if (isMobile) {
	console.log(
		`[prepare-plugin-worker] mobile (${tauriPlatform || envTriple}): skipped`,
	);
	process.exit(0);
}

const host = hostTriple();
const triple = envTriple || host;

const cargoCannotTarget =
	triple === "universal-apple-darwin" ||
	(triple !== host && !rustcCanTarget(triple));
if (cargoCannotTarget) {
	console.error(
		`[prepare-plugin-worker] ${triple} cannot be built with cargo --target. This repo does not universal-build; stage a concrete arch (for example aarch64-apple-darwin or x86_64-apple-darwin) instead of the host binary.`,
	);
	process.exit(1);
}

const ext = triple.includes("windows") ? ".exe" : "";
const profile = release ? "release" : "debug";
const binName = `agentero-plugin-host${ext}`;
const cargoArgs = ["build", "-p", "agentero-plugin-host"];
if (release) cargoArgs.push("--release");
if (triple !== host) cargoArgs.push("--target", triple);

console.log(`[prepare-plugin-worker] cargo ${cargoArgs.join(" ")}`);
try {
	execFileSync("cargo", cargoArgs, { cwd: root, stdio: "inherit" });
} catch (error) {
	process.exit(error.status || 1);
}

const src =
	triple === host
		? path.join(root, "target", profile, binName)
		: path.join(root, "target", triple, profile, binName);
if (!fs.existsSync(src)) {
	console.error(`[prepare-plugin-worker] missing ${src}`);
	process.exit(1);
}
const size = fs.statSync(src).size;
if (size < MIN_BYTES) {
	console.error(
		`[prepare-plugin-worker] ${src} is only ${size} bytes; refusing (minimum 64 KiB)`,
	);
	process.exit(1);
}

const outDir = path.join(root, "src-tauri", "binaries");
fs.mkdirSync(outDir, { recursive: true });
const dest = path.join(outDir, `agentero-plugin-host-${triple}${ext}`);
const unchanged =
	fs.existsSync(dest) &&
	fs.statSync(dest).size === size &&
	fs.readFileSync(src).equals(fs.readFileSync(dest));
if (!unchanged) {
	fs.copyFileSync(src, dest);
	try {
		fs.chmodSync(dest, 0o755);
	} catch {
		// windows
	}
}
console.log(
	`[prepare-plugin-worker] ${src} → ${dest}${unchanged ? " (unchanged)" : ""}`,
);
