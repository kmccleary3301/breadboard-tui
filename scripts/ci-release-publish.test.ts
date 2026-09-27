import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	legalPayloadFiles,
	npmDistTag,
	packages,
	prepareNativeCorePackage,
	rewriteManifest,
	rewritePackedBundledDependencies,
	stageLegalPayloads,
} from "./ci-release-publish";

describe("npm dist-tags", () => {
	it("routes canaries while rejecting other prereleases", () => {
		expect(npmDistTag("0.13.0-canary.2")).toBe("canary");
		expect(npmDistTag("0.13.0")).toBe("latest");
		expect(() => npmDistTag("0.13.0-rc.1")).toThrow("Unsupported prerelease version");
	});
});

describe("published legal payloads", () => {
	it("selects the exact payload for MIT packages", () => {
		expect(legalPayloadFiles("MIT")).toEqual(["LICENSE", "THIRD-PARTY-NOTICES.txt"]);
		expect(() => legalPayloadFiles("MIT OR Apache-2.0")).toThrow("Unsupported package license: MIT OR Apache-2.0");
		expect(() => legalPayloadFiles(undefined)).toThrow("Unsupported package license: <missing>");
	});

	it("stages missing legal files without replacing package-local text", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-publish-legal-"));
		const pkgDir = path.join(root, "package");
		await fs.mkdir(pkgDir);
		try {
			await Promise.all([
				Bun.write(path.join(root, "LICENSE"), "root MIT\n"),
				Bun.write(path.join(root, "THIRD-PARTY-NOTICES.txt"), "notices\n"),
				Bun.write(path.join(pkgDir, "LICENSE"), "package MIT\n"),
			]);

			const files = await stageLegalPayloads(pkgDir, "MIT", true, root);
			expect(files).toEqual(["LICENSE", "THIRD-PARTY-NOTICES.txt"]);
			expect(await Bun.file(path.join(pkgDir, "LICENSE")).text()).toBe("package MIT\n");
			expect(await Bun.file(path.join(pkgDir, "THIRD-PARTY-NOTICES.txt")).text()).toBe("notices\n");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("lists every legal file explicitly in the native core package", async () => {
		const pkgDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-core-"));
		try {
			await Bun.write(
				path.join(pkgDir, "package.json"),
				JSON.stringify({
					name: "@oh-my-pi/pi-natives",
					version: "15.5.15",
					license: "MIT",
				}),
			);
			const manifest = await prepareNativeCorePackage(pkgDir, false);
			expect(manifest.files).toEqual([
				"native/index.js",
				"native/index.d.ts",
				"native/clipboard.js",
				"native/clipboard.d.ts",
				"native/desktop.js",
				"native/desktop.d.ts",
				"native/desktop-adapter.js",
				"native/desktop-adapter.d.ts",
				"native/version-sentinel.js",
				"native/version-sentinel.d.ts",
				"native/loader-state.js",
				"native/loader-state.d.ts",
				"native/vcs.js",
				"native/vcs.d.ts",
				"native/embedded-addon.js",
				"README.md",
				"LICENSE",
				"THIRD-PARTY-NOTICES.txt",
			]);
		} finally {
			await fs.rm(pkgDir, { recursive: true, force: true });
		}
	});
});

describe("published manifest topology", () => {
	it("repoints omptype runtime entries to dist/js with a bun source condition", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/omptype");
		if (!pkg) throw new Error("omptype missing from publish set");
		expect(pkg.publishJs).toBe(true);

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.main).toBe("./dist/js/index.js");
		expect(manifest.types).toBe("./dist/types/index.d.ts");
		expect(manifest.files).toContain("dist/js");
		expect(manifest.files).toContain("dist/types");
		// `src` must stay packed — the `bun` condition resolves into it.
		expect(manifest.files).toContain("src");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				bun: "./src/index.ts",
				default: "./dist/js/index.js",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
			"./*.js": {
				types: "./dist/types/*.d.ts",
				bun: "./src/*.ts",
				default: "./dist/js/*.js",
			},
		});
	});

	it("keeps source-runtime packages on src with only types repointed", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/utils");
		if (!pkg) throw new Error("utils missing from publish set");

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.files).toEqual(expect.arrayContaining(["LICENSE", "THIRD-PARTY-NOTICES.txt"]));
		expect(manifest.main).toBe("./src/index.ts");
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/types/index.d.ts",
				import: "./src/index.ts",
			},
			"./*": {
				types: "./dist/types/*.d.ts",
				import: "./src/*.ts",
			},
			"./*.js": "./src/*.ts",
			"./ar": {
				types: "./dist/types/ar/index.d.ts",
				import: "./src/ar/index.ts",
			},
		});
	});
});

describe("published coding-agent topology", () => {
	it("routes the omp bin through the native identity bundle", async () => {
		const pkg = packages.find(entry => entry.dir === "packages/coding-agent");
		if (!pkg) throw new Error("coding-agent missing from publish set");

		const manifest = await rewriteManifest(pkg, false);
		expect(manifest.bin).toEqual({ omp: "dist/cli.js" });
		expect(pkg.publishBundledDependencies).toBeUndefined();
		expect(manifest.files).toContain("dist/cli.js");
		expect(manifest.files).toContain("dist/THIRD_PARTY_NOTICES-*.txt");
	});

	it("removes source-only bundled references from the self-contained archive", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-publish-bundled-"));
		const packageRoot = path.join(root, "package");
		const bundledRoot = path.join(packageRoot, "node_modules", "@fixture", "bundled");
		const tarball = path.join(root, "fixture.tgz");
		try {
			await fs.mkdir(bundledRoot, { recursive: true });
			await Promise.all([
				Bun.write(
					path.join(packageRoot, "package.json"),
					JSON.stringify({
						name: "@oh-my-pi/pi-coding-agent",
						version: "18.0.1",
						dependencies: { "@fixture/bundled": "file:./vendor/fixture-bundled.tgz" },
						bundledDependencies: ["@fixture/bundled"],
					}),
				),
				Bun.write(
					path.join(bundledRoot, "package.json"),
					JSON.stringify({
						name: "@fixture/bundled",
						version: "1.0.0",
						dependencies: { "eventsource-parser": "^1.1.2" },
					}),
				),
			]);
			await $`tar -czf ${tarball} -C ${root} package`.quiet();
			await expect(rewritePackedBundledDependencies(tarball, ["@fixture/bundled"])).rejects.toThrow(
				"must retain eventsource-parser@^1.1.2",
			);
			await Bun.write(
				path.join(packageRoot, "package.json"),
				JSON.stringify({
					name: "@oh-my-pi/pi-coding-agent",
					version: "18.0.1",
					dependencies: {
						"@fixture/bundled": "file:./vendor/fixture-bundled.tgz",
						"eventsource-parser": "^1.1.2",
					},
					bundledDependencies: ["@fixture/bundled"],
				}),
			);
			await $`tar -czf ${tarball} -C ${root} package`.quiet();

			await rewritePackedBundledDependencies(tarball, ["@fixture/bundled"]);

			const packedManifest = JSON.parse((await $`tar -xOzf ${tarball} package/package.json`.quiet()).text());
			expect(packedManifest.dependencies?.["@fixture/bundled"]).toBeUndefined();
			expect(packedManifest.dependencies?.["eventsource-parser"]).toBe("^1.1.2");
			expect(
				(await $`tar -xOzf ${tarball} package/node_modules/@fixture/bundled/package.json`.quiet()).text(),
			).toContain('"version":"1.0.0"');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
