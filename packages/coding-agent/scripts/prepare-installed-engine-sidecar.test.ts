import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ENGINE_RUNTIME_BUNDLE_SCHEMA } from "../src/breadboard/lifecycle/engine-runtime-bundle";
import {
	canonicalEngineDistributionManifest,
	createEngineDistributionManifest,
	ENGINE_DISTRIBUTION_MANIFEST_FILENAME,
	ENGINE_DISTRIBUTION_PATH_STRATEGY,
	ENGINE_DISTRIBUTION_TRUST_SCHEMA,
	type EngineDistributionManifestPayload,
	type EngineDistributionSha256,
	type EngineDistributionTrustRoot,
} from "../src/breadboard/lifecycle/installed-engine-manifest";
import {
	InstalledEngineSidecarBuildError,
	loadBuildEngineDistribution,
	stageInstalledEngineSidecar,
} from "./prepare-installed-engine-sidecar";

function sha256(value: string | Uint8Array): EngineDistributionSha256 {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

interface DistributionFixture {
	readonly root: string;
	readonly distributionDirectory: string;
	readonly manifestPath: string;
	readonly bundlePath: string;
	readonly canonicalManifest: string;
	readonly bundleBytes: Buffer;
	readonly distributionId: string;
}

async function createDistribution(root: string): Promise<DistributionFixture> {
	const bundleBytes = Buffer.from("verified compiled engine bundle", "utf8");
	const bundleName = "breadboard-engine-runtime.v1.bundle";
	const payload: EngineDistributionManifestPayload = {
		productVersion: "0.1.0-rc.3",
		pathStrategy: ENGINE_DISTRIBUTION_PATH_STRATEGY,
		target: { platform: "darwin", architecture: "arm64" },
		engine: {
			runtimeBundle: {
				schemaVersion: ENGINE_RUNTIME_BUNDLE_SCHEMA,
				path: bundleName,
				sizeBytes: bundleBytes.byteLength,
				sha256: sha256(bundleBytes),
			},
			executablePath: "payload/venv/bin/python",
			argv: ["-I", "-m", "breadboard_engine.api.cli_bridge.server"],
			executableSizeBytes: 42,
			executableSha256: sha256("python executable"),
			engineSourceSha256: sha256("engine source"),
			servedBackendCommit: "c".repeat(40),
			servedBackendTree: "d".repeat(40),
			interfaceVersion: "0.3.0",
			interfaceRange: ">=0.1.0 <0.4.0",
		},
		profile: {
			profileId: "daily_driver.v1",
			definitionRef: "agent_configs/templates/daily_driver.v1.yaml",
			schemaVersion: "bb.harness_definition.v1",
			sourceSha256: sha256("profile source"),
			effectiveLockSchemaVersion: "bb.effective_config_graph.v1",
			effectiveLockSha256: sha256("effective lock"),
		},
		provenance: {
			sourceRepository: "https://github.com/kmccleary3301/breadboard",
			sourceCommit: "c".repeat(40),
			sourceTree: "d".repeat(40),
			buildRecipeSha256: sha256("build recipe"),
			dependencyLockSha256: sha256("dependency lock"),
		},
		signature: { kind: "unsigned-development" },
	};
	const manifest = createEngineDistributionManifest(payload);
	const canonicalManifest = canonicalEngineDistributionManifest(manifest);
	const distributionId = manifest.distributionId.slice("sha256:".length);
	const trustRoot = {
		schemaVersion: ENGINE_DISTRIBUTION_TRUST_SCHEMA,
		expectedManifestSha256: sha256(canonicalManifest),
		productVersion: payload.productVersion,
		target: payload.target,
		interfaceRange: payload.engine.interfaceRange,
		profile: {
			profileId: payload.profile.profileId,
			effectiveLockSha256: payload.profile.effectiveLockSha256,
		},
		signature: { kind: "unsigned-development" },
	} satisfies EngineDistributionTrustRoot;
	const distributionDirectory = join(root, distributionId);
	const manifestPath = join(distributionDirectory, ENGINE_DISTRIBUTION_MANIFEST_FILENAME);
	const bundlePath = join(distributionDirectory, bundleName);
	await mkdir(distributionDirectory, { recursive: true, mode: 0o700 });
	await writeFile(manifestPath, canonicalManifest);
	await writeFile(bundlePath, bundleBytes);
	await writeFile(join(root, `${distributionId}.trust.json`), `${JSON.stringify(trustRoot)}\n`);
	await chmod(manifestPath, 0o400);
	await chmod(bundlePath, 0o400);
	await chmod(join(root, `${distributionId}.trust.json`), 0o400);
	await chmod(distributionDirectory, 0o500);
	await chmod(root, 0o700);
	return {
		root,
		distributionDirectory,
		manifestPath,
		bundlePath,
		canonicalManifest,
		bundleBytes,
		distributionId,
	};
}

async function withDistribution(run: (fixture: DistributionFixture, tempRoot: string) => Promise<void>): Promise<void> {
	using tempDir = TempDir.createSync("@breadboard-build-sidecar-");
	const sourceRoot = join(tempDir.path(), "distribution");
	await mkdir(sourceRoot, { mode: 0o700 });
	const fixture = await createDistribution(sourceRoot);
	try {
		await run(fixture, tempDir.path());
	} finally {
		await chmod(fixture.distributionDirectory, 0o700).catch(() => undefined);
		await chmod(join(tempDir.path(), "output", "engine"), 0o700).catch(() => undefined);
	}
}

async function buildError(run: () => Promise<unknown>): Promise<InstalledEngineSidecarBuildError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof InstalledEngineSidecarBuildError) return error;
		throw error;
	}
	throw new Error("expected InstalledEngineSidecarBuildError");
}

describe("installed engine sidecar build preparation", () => {
	test("loads one exact D2 distribution and stages an immutable adjacent sidecar idempotently", async () => {
		await withDistribution(async (fixture, tempRoot) => {
			const distribution = await loadBuildEngineDistribution(fixture.root);
			expect(distribution.manifest.distributionId).toBe(`sha256:${fixture.distributionId}`);
			expect(distribution.manifestBytes.toString("utf8")).toBe(fixture.canonicalManifest);
			const productExecutablePath = join(tempRoot, "output", "bb");
			const sidecarRoot = await stageInstalledEngineSidecar(productExecutablePath, distribution);
			const stagedManifest = join(sidecarRoot, ENGINE_DISTRIBUTION_MANIFEST_FILENAME);
			const stagedBundle = join(sidecarRoot, distribution.manifest.engine.runtimeBundle.path);
			expect(await readFile(stagedManifest, "utf8")).toBe(fixture.canonicalManifest);
			expect((await readFile(stagedBundle)).equals(fixture.bundleBytes)).toBe(true);
			expect((await stat(sidecarRoot)).mode & 0o777).toBe(0o500);
			expect((await stat(stagedManifest)).mode & 0o777).toBe(0o400);
			expect((await stat(stagedBundle)).mode & 0o777).toBe(0o400);
			const manifestInode = (await stat(stagedManifest)).ino;
			expect(await stageInstalledEngineSidecar(productExecutablePath, distribution)).toBe(sidecarRoot);
			expect((await stat(stagedManifest)).ino).toBe(manifestInode);
			expect(await readdir(join(tempRoot, "output"))).toEqual(["engine"]);
		});
	});

	test("rejects source bundle tampering and non-sealed source roots", async () => {
		await withDistribution(async fixture => {
			await chmod(fixture.distributionDirectory, 0o700);
			await chmod(fixture.bundlePath, 0o600);
			await writeFile(fixture.bundlePath, Buffer.alloc(fixture.bundleBytes.byteLength, 0x78));
			await chmod(fixture.bundlePath, 0o400);
			await chmod(fixture.distributionDirectory, 0o500);
			expect((await buildError(() => loadBuildEngineDistribution(fixture.root))).message).toContain(
				"distribution digest changed",
			);
			await chmod(fixture.root, 0o755);
			expect((await buildError(() => loadBuildEngineDistribution(fixture.root))).message).toContain(
				"directory identity is invalid",
			);
		});
	});

	test("rejects a partial existing sidecar without replacing it", async () => {
		await withDistribution(async (fixture, tempRoot) => {
			const distribution = await loadBuildEngineDistribution(fixture.root);
			const productExecutablePath = join(tempRoot, "output", "bb");
			const sidecarRoot = join(tempRoot, "output", "engine");
			await mkdir(sidecarRoot, { recursive: true, mode: 0o700 });
			await chmod(sidecarRoot, 0o500);
			expect(
				(await buildError(() => stageInstalledEngineSidecar(productExecutablePath, distribution))).message,
			).toContain("file is unavailable");
			expect(await readdir(sidecarRoot)).toEqual([]);
		});
	});

	test("rejects stale or tampered existing sidecars instead of replacing them", async () => {
		await withDistribution(async (fixture, tempRoot) => {
			const distribution = await loadBuildEngineDistribution(fixture.root);
			const productExecutablePath = join(tempRoot, "output", "bb");
			const sidecarRoot = await stageInstalledEngineSidecar(productExecutablePath, distribution);
			const stagedManifest = join(sidecarRoot, ENGINE_DISTRIBUTION_MANIFEST_FILENAME);
			await chmod(sidecarRoot, 0o700);
			await chmod(stagedManifest, 0o600);
			await writeFile(stagedManifest, `${fixture.canonicalManifest.trimEnd()} `);
			await chmod(stagedManifest, 0o400);
			await chmod(sidecarRoot, 0o500);
			expect(
				(await buildError(() => stageInstalledEngineSidecar(productExecutablePath, distribution))).message,
			).toContain("manifest differs");
			expect(await readFile(stagedManifest, "utf8")).toEndWith(" ");
		});
	});

	test("rejects a same-size staged bundle digest mismatch", async () => {
		await withDistribution(async (fixture, tempRoot) => {
			const distribution = await loadBuildEngineDistribution(fixture.root);
			const productExecutablePath = join(tempRoot, "output", "bb");
			const sidecarRoot = await stageInstalledEngineSidecar(productExecutablePath, distribution);
			const stagedBundle = join(sidecarRoot, distribution.manifest.engine.runtimeBundle.path);
			await chmod(sidecarRoot, 0o700);
			await chmod(stagedBundle, 0o600);
			await writeFile(stagedBundle, Buffer.alloc(fixture.bundleBytes.byteLength, 0x78));
			await chmod(stagedBundle, 0o400);
			await chmod(sidecarRoot, 0o500);
			expect(
				(await buildError(() => stageInstalledEngineSidecar(productExecutablePath, distribution))).message,
			).toContain("digest changed");
		});
	});
});
