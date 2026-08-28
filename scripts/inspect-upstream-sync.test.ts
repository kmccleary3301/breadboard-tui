import { describe, expect, it } from "bun:test";
import {
	classifyPath,
	formatInspectHelp,
	type GitResult,
	type GitRunner,
	inspectUpstreamSync,
	loadSyncPolicy,
	parseInspectArgs,
	type SyncPolicy,
} from "./inspect-upstream-sync";

const UPSTREAM_COMMIT = "6c1209842323bb4713f127ac303c97fd043d585c";
const CURRENT_COMMIT = "8954758812a482ea40d1fb3e53a730081b73df66";

interface FixtureGit {
	run: GitRunner;
	calls: string[][];
}

function fixtureGit(policy: SyncPolicy): FixtureGit {
	const calls: string[][] = [];
	const run: GitRunner = async args => {
		const command = [...args];
		calls.push(command);
		if (command[0] === "rev-parse" && command.includes(`${policy.upstream.commit}^{commit}`)) {
			return { exitCode: 0, stdout: `${UPSTREAM_COMMIT}\n`, stderr: "" } satisfies GitResult;
		}
		if (command[0] === "rev-parse" && command.includes("HEAD^{commit}")) {
			return { exitCode: 0, stdout: `${CURRENT_COMMIT}\n`, stderr: "" } satisfies GitResult;
		}
		if (command[0] === "merge-base" && command[1] === "--is-ancestor") {
			const isUpstreamToHead = command[2] === UPSTREAM_COMMIT && command[3] === CURRENT_COMMIT;
			return { exitCode: isUpstreamToHead ? 0 : 1, stdout: "", stderr: "" } satisfies GitResult;
		}
		if (command[0] === "merge-base") {
			return { exitCode: 0, stdout: `${UPSTREAM_COMMIT}\n`, stderr: "" } satisfies GitResult;
		}
		if (command[0] === "diff") {
			const commits = command.slice(-3, -1).join("..");
			if (commits === `${UPSTREAM_COMMIT}..${UPSTREAM_COMMIT}`) {
				return { exitCode: 0, stdout: "", stderr: "" } satisfies GitResult;
			}
			return {
				exitCode: 0,
				stdout: [
					"packages/coding-agent/src/generated/compiled.generated.ts",
					"unknown/future-boundary.txt",
					"packages/coding-agent/src/breadboard/session-port.ts",
					"unknown/future-boundary.txt",
				].join("\0"),
				stderr: "",
			} satisfies GitResult;
		}
		throw new Error(`unexpected git command for ${policy.schemaVersion}: ${command.join(" ")}`);
	};
	return { run, calls };
}

const policy = await loadSyncPolicy();

describe("upstream sync policy", () => {
	it("uses ordered precedence for authority, generated, and boundary paths", () => {
		expect(classifyPath("packages/coding-agent/src/breadboard/generated/runtime.ts", policy)).toEqual({
			class: "breadboard-owned",
			rule: "breadboard-owned-adapters-and-controls",
		});
		expect(classifyPath("packages/coding-agent/src/generated/runtime.generated.ts", policy)).toEqual({
			class: "generated",
			rule: "generated-artifacts",
		});
		expect(classifyPath("dist/coding-agent.js", policy)).toEqual({
			class: "generated",
			rule: "generated-artifacts",
		});
		expect(classifyPath("build/output.js", policy)).toEqual({
			class: "generated",
			rule: "generated-artifacts",
		});
		expect(classifyPath("docs/conformance/p31/e4-canonical-tui-evidence.md", policy)).toEqual({
			class: "breadboard-owned",
			rule: "breadboard-owned-adapters-and-controls",
		});
		expect(classifyPath("packages/coding-agent/package.json", policy)).toEqual({
			class: "manual-review",
			rule: "manual-review-boundaries",
		});
		expect(classifyPath("packages/coding-agent/src/cli.ts", policy)).toEqual({
			class: "manual-review",
			rule: "manual-review-boundaries",
		});
	});

	it("fails closed for an unknown path", () => {
		expect(classifyPath("future/authority-boundary.txt", policy)).toEqual({
			class: "manual-review",
			rule: "manual-review-unknown",
		});
	});
});

describe("upstream sync inspection", () => {
	it("sorts changed paths and classified records deterministically", async () => {
		const fixture = fixtureGit(policy);
		const result = await inspectUpstreamSync({ upstreamRef: policy.upstream.commit, git: fixture.run, policy });
		expect(result.changedPaths.upstream).toEqual([]);
		expect(result.changedPaths.candidate).toEqual([
			"packages/coding-agent/src/breadboard/session-port.ts",
			"packages/coding-agent/src/generated/compiled.generated.ts",
			"unknown/future-boundary.txt",
		]);
		expect(result.paths.map(entry => entry.path)).toEqual([
			"packages/coding-agent/src/breadboard/session-port.ts",
			"packages/coding-agent/src/generated/compiled.generated.ts",
			"unknown/future-boundary.txt",
		]);
		expect(result.unresolvedPaths).toEqual(["unknown/future-boundary.txt"]);
	});

	it("derives the exact v18.0.1 default from the validated policy", async () => {
		const fixture = fixtureGit(policy);
		const result = await inspectUpstreamSync({ git: fixture.run, policy });
		expect(result.upstreamRef).toBe(policy.upstream.commit);
		expect(result.commits.upstream).toBe(UPSTREAM_COMMIT);
		expect(result.commits.head).toBe(CURRENT_COMMIT);
		expect(result.commits.base).toBe(UPSTREAM_COMMIT);
		expect(result.commits.base).toBe(result.commits.mergeBase);
		expect(result.ancestry).toEqual({
			relation: "upstream-ancestor",
			upstreamIsAncestorOfHead: true,
			headIsAncestorOfUpstream: false,
		});
		expect(result.mode).toBe("read-only");
		expect(fixture.calls.every(([command]) => !["fetch", "merge", "rebase", "reset"].includes(command))).toBe(true);
	});

	it("parses explicit refs and reports the policy-derived default in help", () => {
		expect(parseInspectArgs(["--ref", "refs/tags/v18.0.1"])).toEqual({
			help: false,
			upstreamRef: "refs/tags/v18.0.1",
		});
		expect(parseInspectArgs(["refs/heads/candidate"])).toEqual({
			help: false,
			upstreamRef: "refs/heads/candidate",
		});
		expect(formatInspectHelp(policy)).toContain(`Default upstream ref: ${policy.upstream.commit}`);
	});
});
