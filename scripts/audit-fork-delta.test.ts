import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	assertManifestUpstreamIdentity,
	auditDeclarations,
	loadDeltaPolicy,
	readChangedPathPatch,
	type ForkLayerManifest,
} from "./audit-fork-delta";

const policy = await loadDeltaPolicy();
const upstream = policy.upstream;

function manifest(paths: ForkLayerManifest["paths"]): ForkLayerManifest {
	return {
		schemaVersion: "bb-omp.delta-manifest.v2",
		policySchemaVersion: "bb-omp.delta-policy.v1",
		upstream,
		paths,
	};
}

function git(root: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

describe("fork delta upstream identity", () => {
	test("rejects a manifest baseline that differs from policy", () => {
		const mismatched = {
			...manifest([]),
			upstream: { ...upstream, commit: "0".repeat(40) },
		};

		expect(() => assertManifestUpstreamIdentity(mismatched, policy)).toThrow(
			"manifest upstream.commit does not match policy upstream.commit",
		);
	});
});
describe("fork delta audit declarations", () => {
	test("creates an unknown path and fails closed", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "bb-fork-unknown-"));
		try {
			const unknownPath = "future/unauthorized-boundary.ts";
			await Bun.write(path.join(root, unknownPath), "export const unauthorized = true;\n");
			const result = auditDeclarations([{ status: "??", path: unknownPath }], manifest([]), policy);
			expect(result.paths[0]).toMatchObject({ path: unknownPath, declared: false, rule: "manual-review-unknown" });
			expect(result.violations).toContainEqual({
				code: "unknown-path",
				path: unknownPath,
				detail: "path did not match an ordered delta-policy rule",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("requires owner and ordered layer for a manual boundary", () => {
		const boundaryPath = "packages/coding-agent/src/cli.ts";
		const result = auditDeclarations(
			[{ status: "M", path: boundaryPath }],
			manifest([{ path: boundaryPath, class: "manual-review", rule: "manual-review-boundaries" }]),
			policy,
		);
		expect(result.violations).toContainEqual({
			code: "manual-boundary",
			path: boundaryPath,
			detail: "manual boundary must declare owner omp-entrypoint and ordered layer 2",
		});
	});

	test("includes unstaged and untracked content in upstream inline patches", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "bb-fork-inline-"));
		try {
			const trackedPath = "src/upstream.ts";
			const untrackedPath = "src/new-upstream.ts";
			await mkdir(path.join(root, "src"), { recursive: true });
			await Bun.write(path.join(root, trackedPath), "export const identity = 'OMP';\n");
			git(root, "init", "-q");
			git(root, "config", "user.name", "Fork Audit Test");
			git(root, "config", "user.email", "fork-audit@example.invalid");
			git(root, "add", trackedPath);
			git(root, "commit", "-qm", "baseline");
			git(root, "tag", "baseline");

			await Bun.write(path.join(root, trackedPath), "export const identity = 'BreadBoard';\n");
			await Bun.write(path.join(root, untrackedPath), "export const product = 'BreadBoard';\n");

			const trackedPatch = await readChangedPathPatch(root, "baseline", { status: " M", path: trackedPath });
			const untrackedPatch = await readChangedPathPatch(root, "baseline", { status: "??", path: untrackedPath });
			expect(trackedPatch).toContain("+export const identity = 'BreadBoard';");
			expect(untrackedPatch).toContain("+export const product = 'BreadBoard';");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
