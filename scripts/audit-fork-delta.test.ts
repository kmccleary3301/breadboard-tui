import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertManifestUpstreamIdentity,
	auditDeclarations,
	countUpstreamEntrypointPaths,
	type ForkLayerManifest,
	loadDeltaPolicy,
	evaluatePathBudgets,
	inspectTuiBreadboardIdentifiers,
	readChangedPathPatch,
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

describe("fork delta entrypoint budget", () => {
	test("counts modified upstream entrypoints but not fork-added paths that match a pattern", () => {
		const records = [
			{ status: "M", path: "packages/coding-agent/src/main.ts" },
			{ status: "A", path: "packages/breadboard-harness/src/index.ts" },
			{ status: "M", path: "packages/coding-agent/src/sdk.ts" },
		];
		expect(countUpstreamEntrypointPaths(records, policy.upstreamEntrypoints)).toBe(1);
	});
});

describe("tui breadboard identifier inline scan (ticket 26)", () => {
	test("(a) planted const x = 'bb-balanced' in an upstream-owned packages/tui/src/... file fails", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "bb-fork-tui-a-"));
		try {
			const tuiPath = "packages/tui/src/button.ts";
			await mkdir(path.join(root, "packages/tui/src"), { recursive: true });
			await Bun.write(path.join(root, tuiPath), "export const button = true;\n");
			git(root, "init", "-q");
			git(root, "config", "user.name", "Fork Audit Test");
			git(root, "config", "user.email", "fork-audit@example.invalid");
			git(root, "add", tuiPath);
			git(root, "commit", "-qm", "baseline");
			git(root, "tag", "baseline");

			await Bun.write(path.join(root, tuiPath), 'export const x = "bb-balanced";\n');

			const testPolicy = { ...policy, upstream: { ...policy.upstream, tag: "baseline" } };
			const state = {
				policy: testPolicy,
				manifest: manifest([]),
				identity: { upstreamCommit: "0", upstreamTree: "0", candidateCommit: "0", candidateTree: "0" },
				records: [{ status: "M", path: tuiPath }],
				paths: [tuiPath],
			};
			const declarations = {
				paths: [
					{
						path: tuiPath,
						status: "M",
						class: "upstream-owned" as const,
						rule: "upstream-ordinary-omp",
						declared: true,
					},
				],
				violations: [],
			};
			const violations = await inspectTuiBreadboardIdentifiers(root, state, declarations);
			expect(violations).toHaveLength(1);
			expect(violations[0]).toMatchObject({
				code: "tui-breadboard-identifier",
				path: tuiPath,
			});
			expect(violations[0]?.detail).toContain("bb-balanced");
			expect(violations[0]?.detail).toContain("line 1");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("(b) the same identifier declared in genericSeams passes", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "bb-fork-tui-b-"));
		try {
			const tuiPath = "packages/tui/src/button.ts";
			await mkdir(path.join(root, "packages/tui/src"), { recursive: true });
			await Bun.write(path.join(root, tuiPath), "export const button = true;\n");
			git(root, "init", "-q");
			git(root, "config", "user.name", "Fork Audit Test");
			git(root, "config", "user.email", "fork-audit@example.invalid");
			git(root, "add", tuiPath);
			git(root, "commit", "-qm", "baseline");
			git(root, "tag", "baseline");

			await Bun.write(path.join(root, tuiPath), 'export const x = "bb-balanced";\n');

			const testPolicy = { ...policy, upstream: { ...policy.upstream, tag: "baseline" } };
			const state = {
				policy: testPolicy,
				manifest: manifest([]),
				identity: { upstreamCommit: "0", upstreamTree: "0", candidateCommit: "0", candidateTree: "0" },
				records: [{ status: "M", path: tuiPath }],
				paths: [tuiPath],
			};
			const declarations = {
				paths: [
					{
						path: tuiPath,
						status: "M",
						class: "upstream-owned" as const,
						rule: "upstream-ordinary-omp",
						declared: true,
						genericSeams: ["bb-balanced"],
					},
				],
				violations: [],
			};
			const violations = await inspectTuiBreadboardIdentifiers(root, state, declarations);
			expect(violations).toHaveLength(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("(c) a breadboard-owned class on a packages/tui/ path still fails", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "bb-fork-tui-c-"));
		try {
			const tuiPath = "packages/tui/src/button.ts";
			await mkdir(path.join(root, "packages/tui/src"), { recursive: true });
			await Bun.write(path.join(root, tuiPath), "export const button = true;\n");
			git(root, "init", "-q");
			git(root, "config", "user.name", "Fork Audit Test");
			git(root, "config", "user.email", "fork-audit@example.invalid");
			git(root, "add", tuiPath);
			git(root, "commit", "-qm", "baseline");
			git(root, "tag", "baseline");

			await Bun.write(path.join(root, tuiPath), 'export const x = "bb-balanced";\n');

			const testPolicy = { ...policy, upstream: { ...policy.upstream, tag: "baseline" } };
			const state = {
				policy: testPolicy,
				manifest: manifest([]),
				identity: { upstreamCommit: "0", upstreamTree: "0", candidateCommit: "0", candidateTree: "0" },
				records: [{ status: "M", path: tuiPath }],
				paths: [tuiPath],
			};
			const declarations = {
				paths: [
					{
						path: tuiPath,
						status: "M",
						class: "breadboard-owned" as const,
						rule: "breadboard-owned-adapters-and-controls",
						declared: true,
					},
				],
				violations: [],
			};
			const violations = await inspectTuiBreadboardIdentifiers(root, state, declarations);
			expect(violations).toHaveLength(1);
			expect(violations[0]).toMatchObject({
				code: "tui-breadboard-identifier",
				path: tuiPath,
			});
			expect(violations[0]?.detail).toContain("bb-balanced");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("fork delta non-package changed paths budget (Kyle's D12 decision)", () => {
	test("(d) non-package budget counts exclude packages/breadboard-harness/ and fail at 401", () => {
		const harnessPaths = Array.from({ length: 50 }, (_, i) => `packages/breadboard-harness/src/file${i}.ts`);
		const nonPackage400 = Array.from({ length: 400 }, (_, i) => `packages/tui/src/file${i}.ts`);
		const nonPackage401 = Array.from({ length: 401 }, (_, i) => `packages/tui/src/file${i}.ts`);

		const passing = evaluatePathBudgets([...nonPackage400, ...harnessPaths], policy);
		expect(passing.changedPaths).toEqual({
			total: 450,
			nonPackage: 400,
			package: 50,
		});
		expect(passing.violation).toBeUndefined();

		const failing = evaluatePathBudgets([...nonPackage401, ...harnessPaths], policy);
		expect(failing.changedPaths).toEqual({
			total: 451,
			nonPackage: 401,
			package: 50,
		});
		expect(failing.violation).toMatchObject({
			code: "budget",
			detail: "non-package changed path count 401 exceeds budget 400",
		});
	});

	test("(e) a policy carrying maxTotalChangedPaths is rejected", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "bb-fork-policy-"));
		try {
			const badPolicyPath = path.join(root, "bad-policy.json");
			const raw = {
				...policy,
				budgets: {
					maxTotalChangedPaths: 400,
					maxUpstreamEntrypointPaths: 13,
				},
			};
			await Bun.write(badPolicyPath, JSON.stringify(raw));
			expect(loadDeltaPolicy(badPolicyPath)).rejects.toThrow("budgets.maxTotalChangedPaths is no longer supported");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
