#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const PINNED_UPSTREAM_REF = "72000acfeb";
export const MANIFEST_PATH = resolve(import.meta.dir, "fork-layer-manifest.json");

interface ForkLayerManifest {
	readonly schemaVersion: "aci.fork-layer-manifest.v1";
	readonly upstreamRef: string;
	readonly paths: readonly string[];
}

function normalizePath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function runGit(args: readonly string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${Buffer.from(result.stderr).toString("utf8")}`);
	}
	return Buffer.from(result.stdout).toString("utf8");
}

function parseDiffPaths(output: string): Set<string> {
	return new Set(output.split(/\r?\n/).map(normalizePath).filter(Boolean));
}

function parseStatusPaths(output: string): Set<string> {
	const paths = new Set<string>();
	for (const line of output.split(/\r?\n/)) {
		if (line.length < 4) continue;
		const raw = line.slice(3).trim();
		if (!raw) continue;
		const renamed = raw.split(" -> ").pop();
		if (renamed) paths.add(normalizePath(renamed));
	}
	return paths;
}

export async function auditForkDelta(): Promise<{ readonly changed: readonly string[]; readonly missing: readonly string[] }> {
	const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as ForkLayerManifest;
	if (manifest.schemaVersion !== "aci.fork-layer-manifest.v1") throw new Error("unsupported fork layer manifest schema");
	if (manifest.upstreamRef !== PINNED_UPSTREAM_REF) throw new Error(`manifest upstreamRef must be ${PINNED_UPSTREAM_REF}`);
	const changed = new Set([
		...parseDiffPaths(runGit(["diff", "--name-only", PINNED_UPSTREAM_REF, "HEAD"])),
		...parseStatusPaths(runGit(["status", "--short", "--untracked-files=all"])),
	]);
	const declared = new Set(manifest.paths.map(normalizePath));
	const missing = [...changed].filter(path => !declared.has(path)).sort();
	return { changed: [...changed].sort(), missing };
}

if (import.meta.main) {
	const result = await auditForkDelta();
	console.log(JSON.stringify({ upstreamRef: PINNED_UPSTREAM_REF, changedCount: result.changed.length, declaredCount: result.changed.length - result.missing.length, missing: result.missing }, null, 2));
	if (result.missing.length > 0) {
		console.error(`Fork delta audit failed: ${result.missing.length} path(s) are not declared in ${MANIFEST_PATH}`);
		process.exitCode = 1;
	}
}
