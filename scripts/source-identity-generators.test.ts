import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

async function run(script: string, cwd = repoRoot): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(["bun", script, "--check"], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

describe("source identity generators", () => {
	test("theme drift makes the check process fail", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "p31-theme-check-"));
		try {
			const themes = path.join(root, "packages", "coding-agent", "src", "modes", "theme", "defaults");
			await mkdir(themes, { recursive: true });
			await Bun.write(path.join(themes, "fixture.json"), "{}\n");
			await Bun.write(path.join(themes, "index.ts"), "// stale\n");
			const result = await run(path.join(repoRoot, "scripts", "sync-themes.ts"), root);
			expect(result.exitCode).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
