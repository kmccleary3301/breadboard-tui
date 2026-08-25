import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ENGINE_RUNTIME_BUNDLE_SCHEMA } from "./engine-runtime-bundle";
import {
	canonicalEngineDistributionManifest,
	createEngineDistributionManifest,
	ENGINE_DISTRIBUTION_DIRECTORY,
	ENGINE_DISTRIBUTION_MANIFEST_FILENAME,
	ENGINE_DISTRIBUTION_PATH_STRATEGY,
	ENGINE_DISTRIBUTION_TRUST_SCHEMA,
	type EngineDistributionManifestPayload,
	type EngineDistributionSha256,
	type EngineDistributionTrustRoot,
	InstalledEngineDiscoveryError,
} from "./installed-engine-manifest";
import {
	compiledInstalledEngineTrustRoot,
	formatInstalledEngineDiscoveryError,
	resolveInstalledEngineSelection,
} from "./installed-engine-selection";

function sha256(value: string | Uint8Array): EngineDistributionSha256 {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

interface InstalledFixture {
	readonly engineDirectory: string;
	readonly manifestPath: string;
	readonly bundlePath: string;
	readonly bundleBytes: Buffer;
	readonly canonicalManifest: string;
	readonly productExecutablePath: string;
	readonly trustRoot: EngineDistributionTrustRoot;
}

async function createFixture(root: string): Promise<InstalledFixture> {
	const bundleBytes = Buffer.from("sealed runtime bundle bytes", "utf8");
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
	const trustRoot = Object.freeze({
		schemaVersion: ENGINE_DISTRIBUTION_TRUST_SCHEMA,
		distributionId: manifest.distributionId,
		expectedManifestSha256: sha256(canonicalManifest),
		productVersion: payload.productVersion,
		target: payload.target,
		interfaceRange: payload.engine.interfaceRange,
		profile: {
			profileId: payload.profile.profileId,
			effectiveLockSha256: payload.profile.effectiveLockSha256,
		},
		signature: { kind: "unsigned-development" },
	} satisfies EngineDistributionTrustRoot);
	const appDirectory = join(root, "app");
	const engineDirectory = join(
		appDirectory,
		ENGINE_DISTRIBUTION_DIRECTORY,
		manifest.distributionId.slice("sha256:".length),
	);
	const manifestPath = join(engineDirectory, ENGINE_DISTRIBUTION_MANIFEST_FILENAME);
	const bundlePath = join(engineDirectory, bundleName);
	const productExecutablePath = join(appDirectory, "bb");
	await mkdir(engineDirectory, { recursive: true, mode: 0o700 });
	await writeFile(manifestPath, canonicalManifest, { mode: 0o400 });
	await writeFile(bundlePath, bundleBytes, { mode: 0o400 });
	await writeFile(productExecutablePath, "test product binary", { mode: 0o500 });
	await chmod(manifestPath, 0o400);
	await chmod(bundlePath, 0o400);
	await chmod(engineDirectory, 0o500);
	return {
		engineDirectory,
		manifestPath,
		bundlePath,
		bundleBytes,
		canonicalManifest,
		productExecutablePath,
		trustRoot,
	};
}

async function withFixture(run: (fixture: InstalledFixture) => Promise<void>): Promise<void> {
	using tempDir = TempDir.createSync("@breadboard-installed-selection-");
	const fixture = await createFixture(tempDir.path());
	try {
		await run(fixture);
	} finally {
		await chmod(fixture.engineDirectory, 0o700).catch(() => undefined);
	}
}

async function discoveryError(run: () => Promise<unknown>): Promise<InstalledEngineDiscoveryError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof InstalledEngineDiscoveryError) return error;
		throw error;
	}
	throw new Error("expected InstalledEngineDiscoveryError");
}

describe("resolveInstalledEngineSelection", () => {
	test("maps one sealed trusted sidecar to a frozen runtime-bundle artifact", async () => {
		await withFixture(async fixture => {
			const selection = await resolveInstalledEngineSelection({
				productExecutablePath: fixture.productExecutablePath,
				trustRoot: fixture.trustRoot,
			});
			expect(selection.manifestPath).toBe(await realpath(fixture.manifestPath));
			expect(selection.artifact).toMatchObject({
				kind: "runtime-bundle",
				runtimeBundle: {
					path: await realpath(fixture.bundlePath),
					sizeBytes: fixture.bundleBytes.byteLength,
					sha256: sha256(fixture.bundleBytes),
				},
				executablePath: "payload/venv/bin/python",
				servedBackendCommit: "c".repeat(40),
			});
			expect(Object.isFrozen(selection)).toBe(true);
			expect(Object.isFrozen(selection.artifact)).toBe(true);
			expect(Object.isFrozen(selection.artifact.runtimeBundle)).toBe(true);
			expect(selection.identity).toMatchObject({
				schemaVersion: "bb.installed_engine_identity.v1",
				distributionId: fixture.trustRoot.distributionId,
				engine: {
					runtimeBundleSha256: sha256(fixture.bundleBytes),
					executableSha256: sha256("python executable"),
					engineSourceSha256: sha256("engine source"),
				},
			});
			expect(Object.isFrozen(selection.identity)).toBe(true);
			expect(Object.isFrozen(selection.identity.engine)).toBe(true);
			expect(JSON.stringify(selection.identity)).not.toContain("github.com");
			expect(JSON.stringify(selection.identity)).not.toContain("/");
		});
	});

	test("fails closed without embedded trust or an installed manifest", async () => {
		expect(compiledInstalledEngineTrustRoot()).toBeUndefined();
		await withFixture(async fixture => {
			expect(
				(
					await discoveryError(() =>
						resolveInstalledEngineSelection({
							productExecutablePath: fixture.productExecutablePath,
							trustRoot: undefined,
						}),
					)
				).code,
			).toBe("engine_manifest_untrusted");
			expect(
				(
					await discoveryError(() =>
						resolveInstalledEngineSelection({
							productExecutablePath: join(fixture.engineDirectory, "missing", "bb"),
							trustRoot: fixture.trustRoot,
						}),
					)
				).code,
			).toBe("engine_manifest_unavailable");
		});
	});

	test("rejects mutable directories, mutable manifests, tampered manifests, and wrong bundle size", async () => {
		await withFixture(async fixture => {
			await chmod(fixture.engineDirectory, 0o700);
			expect(
				(
					await discoveryError(() =>
						resolveInstalledEngineSelection({
							productExecutablePath: fixture.productExecutablePath,
							trustRoot: fixture.trustRoot,
						}),
					)
				).code,
			).toBe("engine_manifest_untrusted");

			await chmod(fixture.manifestPath, 0o600);
			await chmod(fixture.engineDirectory, 0o500);
			expect(
				(
					await discoveryError(() =>
						resolveInstalledEngineSelection({
							productExecutablePath: fixture.productExecutablePath,
							trustRoot: fixture.trustRoot,
						}),
					)
				).code,
			).toBe("engine_manifest_untrusted");

			await chmod(fixture.engineDirectory, 0o700);
			await writeFile(fixture.manifestPath, fixture.canonicalManifest.replace("0.1.0-rc.3", "0.1.0-rc.4"), {
				mode: 0o400,
			});
			await chmod(fixture.manifestPath, 0o400);
			await chmod(fixture.engineDirectory, 0o500);
			expect(
				(
					await discoveryError(() =>
						resolveInstalledEngineSelection({
							productExecutablePath: fixture.productExecutablePath,
							trustRoot: fixture.trustRoot,
						}),
					)
				).code,
			).toBe("engine_manifest_untrusted");

			await chmod(fixture.engineDirectory, 0o700);
			await chmod(fixture.manifestPath, 0o600);
			await writeFile(fixture.manifestPath, fixture.canonicalManifest, { mode: 0o400 });
			await chmod(fixture.manifestPath, 0o400);
			await chmod(fixture.bundlePath, 0o600);
			await writeFile(fixture.bundlePath, Buffer.concat([fixture.bundleBytes, Buffer.from("x")]));
			await chmod(fixture.bundlePath, 0o400);
			await chmod(fixture.engineDirectory, 0o500);
			expect(
				(
					await discoveryError(() =>
						resolveInstalledEngineSelection({
							productExecutablePath: fixture.productExecutablePath,
							trustRoot: fixture.trustRoot,
						}),
					)
				).code,
			).toBe("engine_artifact_mismatch");
		});
	});

	test("rejects a symlinked bundle and emits only code-based remediation", async () => {
		await withFixture(async fixture => {
			const outsidePath = join(fixture.engineDirectory, "..", "outside.bundle");
			await chmod(fixture.engineDirectory, 0o700);
			await unlink(fixture.bundlePath);
			await writeFile(outsidePath, fixture.bundleBytes, { mode: 0o400 });
			await symlink(outsidePath, fixture.bundlePath);
			await chmod(fixture.engineDirectory, 0o500);
			const error = await discoveryError(() =>
				resolveInstalledEngineSelection({
					productExecutablePath: fixture.productExecutablePath,
					trustRoot: fixture.trustRoot,
				}),
			);
			expect(error.code).toBe("engine_artifact_unavailable");
			const formatted = formatInstalledEngineDiscoveryError(error);
			expect(formatted).toContain("[engine_artifact_unavailable]");
			expect(formatted).toContain("Reinstall BreadBoard");
			expect(formatted).not.toContain(fixture.productExecutablePath);
			expect(formatted).not.toContain(outsidePath);
		});
	});
});
