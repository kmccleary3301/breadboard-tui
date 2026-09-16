import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";
import { compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";

describe("Windows release binary target", () => {
	it("resolves local Windows cross-build aliases for both architectures", () => {
		expect(resolveCrossBuild("win32-x64")).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("win32-arm64")).toEqual({
			id: "win32-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
		expect(resolveCrossBuild("windows-arm64")).toEqual({
			id: "windows-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
	});
});

it("executes bundled module resolution in a standalone binary", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "omp-compiled-module-"));
	try {
		const entrypoint = path.join(root, "entry.ts");
		const outfile = path.join(root, process.platform === "win32" ? "probe.exe" : "probe");
		await Bun.write(entrypoint, 'console.log(import.meta.resolve(process.argv[2] ?? "node:fs"));');
		await compileCodingAgent({
			repoRoot: root,
			entrypoint,
			outfile,
			transformersVersion: "0.0.0",
			skipBuiltinCodesign: process.platform === "darwin",
		});
		if (process.platform === "darwin") {
			await $`codesign --force --sign - ${outfile}`.quiet();
		}
		const result = await $`${outfile}`.quiet().nothrow();
		expect(result.exitCode).toBe(0);
		expect(result.text().trim()).toBe("node:fs");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
