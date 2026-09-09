import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncPolicy } from "./inspect-upstream-sync";
import { createCommandRunner, verifyUpstreamSync } from "./verify-upstream-sync";

const valuePath = "packages/coding-agent/src/breadboard/value.txt";
const featurePath = "packages/coding-agent/src/breadboard/feature.txt";

async function fixture(conflicting: boolean) {
	const root = await mkdtemp(join(tmpdir(), "p31-sync-test-"));
	const run = createCommandRunner();
	const git = async (...args: string[]): Promise<string> => {
		const result = await run(["git", ...args], root);
		if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
		return result.stdout.trim();
	};
	try {
		await git("init", "--initial-branch=upstream", "--template=");
		await git("config", "user.name", "Sync test");
		await git("config", "user.email", "sync@example.invalid");
		await git("config", "commit.gpgsign", "false");
		await git("config", "core.hooksPath", "/dev/null");
		await mkdir(join(root, "packages/coding-agent/src/breadboard"), { recursive: true });
		await writeFile(join(root, valuePath), "base\n");
		await git("add", ".");
		await git("commit", "-m", "base");
		await git("checkout", "-b", "candidate");
		await writeFile(join(root, conflicting ? valuePath : featurePath), "feature\n");
		await git("add", ".");
		await git("commit", "-m", "feature");
		await git("checkout", "upstream");
		await writeFile(join(root, valuePath), "upstream\n");
		await git("commit", "-am", "upstream");
		const upstream = await git("rev-parse", "HEAD");
		const upstreamTree = await git("rev-parse", "HEAD^{tree}");
		await git("-c", "tag.gpgsign=false", "tag", "v1.0.0");
		await git("checkout", "candidate");
		const policy: SyncPolicy = {
			schemaVersion: "p31.upstream-sync-policy.v1",
			upstream: { tag: "v1.0.0", commit: upstream, tree: upstreamTree },
			classes: ["breadboard-owned", "upstream-owned", "generated", "manual-review"],
			rules: [
				{
					id: "known",
					class: "breadboard-owned",
					description: "known BreadBoard seam",
					patterns: ["packages/coding-agent/src/breadboard/**"],
				},
				{
					id: "manual-review-unknown",
					class: "manual-review",
					description: "fail closed",
					patterns: ["**"],
					fallback: true,
				},
			],
		};
		const verificationRoot = join(root, "verification");
		return {
			root,
			git,
			run,
			verificationRoot,
			options: {
				repoRoot: root,
				upstreamRef: upstream,
				policy,
				linkNodeModules: false,
				createTempRoot: async () => {
					await mkdir(verificationRoot);
					return verificationRoot;
				},
			},
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

function outputHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

const valueProof = [
	process.execPath,
	"-e",
	`process.stdout.write(await Bun.file(${JSON.stringify(valuePath)}).text())`,
];

describe("verifyUpstreamSync", () => {
	test("preserves an integrated merge resolution and proves its exact tree", async () => {
		const repo = await fixture(true);
		try {
			const merge = await repo.run(["git", "merge", "--no-commit", "upstream"], repo.root);
			expect(merge.exitCode).toBe(1);
			await writeFile(join(repo.root, valuePath), "resolved\n");
			await repo.git("add", valuePath);
			await repo.git("commit", "-m", "retain resolved merge");
			const candidate = await repo.git("rev-parse", "HEAD");
			const tree = await repo.git("rev-parse", "HEAD^{tree}");
			const receipt = await verifyUpstreamSync({ ...repo.options, proofCommands: [valueProof] });
			expect(receipt).toMatchObject({
				status: "pass",
				mode: "disposable-worktree-existing-ancestry",
				rebaseExitCode: null,
				commits: { candidateBefore: candidate, candidateAfter: candidate, treeAfter: tree },
				proofReceipts: [{ exitCode: 0, stdoutSha256: outputHash("resolved\n") }],
			});
			expect(await repo.git("rev-parse", "HEAD")).toBe(candidate);
			expect(await readFile(join(repo.root, valuePath), "utf8")).toBe("resolved\n");
			await expect(access(repo.verificationRoot)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(repo.root, { recursive: true, force: true });
		}
	});

	test("rebases a divergent candidate only in the disposable worktree", async () => {
		const repo = await fixture(false);
		try {
			const candidate = await repo.git("rev-parse", "HEAD");
			const receipt = await verifyUpstreamSync({ ...repo.options, proofCommands: [valueProof] });
			expect(receipt).toMatchObject({
				status: "pass",
				mode: "disposable-worktree-rebase",
				rebaseExitCode: 0,
				proofReceipts: [{ exitCode: 0, stdoutSha256: outputHash("upstream\n") }],
			});
			expect(receipt.commits.candidateAfter).not.toBe(candidate);
			expect(await repo.git("rev-parse", "HEAD")).toBe(candidate);
			expect(await readFile(join(repo.root, valuePath), "utf8")).toBe("base\n");
			await expect(access(repo.verificationRoot)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(repo.root, { recursive: true, force: true });
		}
	});

	test("reports real rebase conflicts without running proofs or changing the candidate", async () => {
		const repo = await fixture(true);
		const marker = join(repo.root, "proof-ran");
		try {
			const candidate = await repo.git("rev-parse", "HEAD");
			const receipt = await verifyUpstreamSync({
				...repo.options,
				proofCommands: [[process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, "ran")`]],
			});
			expect(receipt.status).toBe("conflict");
			expect(receipt.conflicts).toEqual([
				{ path: valuePath, sides: ["upstream", "candidate"], class: "breadboard-owned", rule: "known" },
			]);
			expect(receipt.proofReceipts).toEqual([]);
			expect(await repo.git("rev-parse", "HEAD")).toBe(candidate);
			await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(access(repo.verificationRoot)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(repo.root, { recursive: true, force: true });
		}
	});

	test("stops after a failed proof and retains hashes rather than raw output", async () => {
		const repo = await fixture(false);
		const marker = join(repo.root, "second-proof-ran");
		try {
			const receipt = await verifyUpstreamSync({
				...repo.options,
				proofCommands: [
					[process.execPath, "-e", 'console.log(["sensitive", "proof", "output"].join(" ")); process.exit(7)'],
					[process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, "ran")`],
				],
			});
			expect(receipt.status).toBe("proof-failed");
			expect(receipt.proofReceipts).toHaveLength(1);
			expect(receipt.proofReceipts[0]).toMatchObject({
				exitCode: 7,
				stdoutSha256: outputHash("sensitive proof output\n"),
			});
			expect(JSON.stringify(receipt)).not.toContain("sensitive proof output");
			await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(access(repo.verificationRoot)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(repo.root, { recursive: true, force: true });
		}
	});
});
