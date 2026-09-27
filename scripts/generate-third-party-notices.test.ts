import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const packageRoot = path.join(repoRoot, "packages", "coding-agent");

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

describe("distribution notice bundle", () => {
	test("is deterministic and complete", async () => {
		const check = Bun.spawn(["bun", "scripts/generate-third-party-notices.ts", "--check"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [, stderr, exitCode] = await Promise.all([
			new Response(check.stdout).text(),
			new Response(check.stderr).text(),
			check.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });

		const manifest = await Bun.file(path.join(packageRoot, "THIRD_PARTY_NOTICES.manifest.json")).json();
		const bundle = await Bun.file(path.join(packageRoot, "THIRD_PARTY_NOTICES.txt")).text();
		expect(manifest.bundle.sha256).toBe(sha256(bundle));
		expect(bundle).toContain("===== BEGIN LICENSE =====");
		expect(bundle).toContain("===== BEGIN crates/pi-natives/src/fonts/Silver.LICENSE =====");
		// Upstream's dependency aggregates cover code compiled into the bb binary and addon.
		expect(bundle).toContain("===== BEGIN THIRD-PARTY-NOTICES.txt =====");
		expect(bundle).toContain("===== BEGIN packages/natives/THIRD-PARTY-NOTICES.txt =====");
		expect(await Bun.file(path.join(packageRoot, "LICENSE")).text()).toBe(
			await Bun.file(path.join(repoRoot, "LICENSE")).text(),
		);
	});
});
