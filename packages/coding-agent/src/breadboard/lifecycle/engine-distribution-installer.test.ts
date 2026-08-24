import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineDistributionInstallError, installEngineDistributionAtomically } from "./engine-distribution-installer";
import { createEngineRuntimeBundle } from "./engine-runtime-bundle";
import {
	createEngineDistributionManifest,
	ENGINE_DISTRIBUTION_PATH_STRATEGY,
	type EngineDistributionManifest,
	type EngineDistributionSha256,
} from "./installed-engine-manifest";

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
}

async function removeTemporaryRoot(root: string): Promise<void> {
	await chmod(root, 0o700).catch(() => undefined);
	try {
		for (const child of await readdir(root, { withFileTypes: true })) {
			if (child.isDirectory() && !child.isSymbolicLink()) await removeTemporaryRoot(join(root, child.name));
		}
	} catch {
		return;
	}
	await rm(root, { recursive: true, force: true });
}

afterAll(async () => {
	await Promise.all(temporaryRoots.map(removeTemporaryRoot));
});

function sha256(value: string): EngineDistributionSha256 {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function createDistribution(
	root: string,
	version: string,
	commitCharacter: string,
): Promise<{ readonly manifest: EngineDistributionManifest; readonly sourceBundlePath: string }> {
	const sourceRoot = join(root, `source-${version}`);
	await mkdir(join(sourceRoot, "_internal"), { recursive: true });
	await Bun.write(join(sourceRoot, "breadboard-engine"), "#!/bin/sh\nexit 0\n");
	await chmod(join(sourceRoot, "breadboard-engine"), 0o755);
	await Bun.write(join(sourceRoot, "_internal", "runtime.py"), `VERSION = ${JSON.stringify(version)}\n`);
	const built = await createEngineRuntimeBundle({
		sourceRoot,
		executablePath: "breadboard-engine",
		outputPath: join(root, `build-${version}.bundle`),
	});
	const commit = commitCharacter.repeat(40);
	return {
		manifest: createEngineDistributionManifest({
			productVersion: version,
			pathStrategy: ENGINE_DISTRIBUTION_PATH_STRATEGY,
			target: { platform: "darwin", architecture: "arm64" },
			engine: {
				runtimeBundle: {
					...built.bundle,
					path: "breadboard-engine-runtime.v1.bundle",
				},
				executablePath: built.executablePath,
				argv: [],
				executableSizeBytes: built.executableSizeBytes,
				executableSha256: built.executableSha256,
				engineSourceSha256: sha256(`source-${version}`),
				servedBackendCommit: commit,
				servedBackendTree: commitCharacter.toUpperCase().toLowerCase().repeat(40),
				interfaceVersion: "0.3.0",
				interfaceRange: ">=0.1.0 <0.4.0",
			},
			profile: {
				profileId: "daily_driver.v1",
				definitionRef: "agent_configs/templates/daily_driver.v1.yaml",
				schemaVersion: "bb.harness_definition.v1",
				sourceSha256: sha256("profile"),
				effectiveLockSchemaVersion: "bb.effective_config_graph.v1",
				effectiveLockSha256: sha256("profile-lock"),
			},
			provenance: {
				sourceRepository: "https://github.com/kmccleary3301/breadboard",
				sourceCommit: commit,
				sourceTree: commitCharacter.toUpperCase().toLowerCase().repeat(40),
				buildRecipeSha256: sha256("recipe"),
				dependencyLockSha256: sha256("dependencies"),
			},
			signature: { kind: "unsigned-development" },
		}),
		sourceBundlePath: built.bundle.path,
	};
}

async function installError(run: () => Promise<unknown>): Promise<EngineDistributionInstallError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof EngineDistributionInstallError) return error;
		throw error;
	}
	throw new Error("expected EngineDistributionInstallError");
}

describe("engine distribution installer", () => {
	test("publishes complete content-addressed distributions atomically and retains the prior artifact", async () => {
		const tempRoot = await temporaryRoot("breadboard-engine-install-");
		const installationRoot = join(tempRoot, "installed");
		const firstSource = await createDistribution(tempRoot, "0.1.0", "a");
		const secondSource = await createDistribution(tempRoot, "0.1.1", "b");

		const first = await installEngineDistributionAtomically({
			root: installationRoot,
			manifest: firstSource.manifest,
			bundlePath: firstSource.sourceBundlePath,
		});
		const same = await installEngineDistributionAtomically({
			root: installationRoot,
			manifest: firstSource.manifest,
			bundlePath: firstSource.sourceBundlePath,
		});
		const second = await installEngineDistributionAtomically({
			root: installationRoot,
			manifest: secondSource.manifest,
			bundlePath: secondSource.sourceBundlePath,
		});

		expect(same.distributionPath).toBe(first.distributionPath);
		expect(second.distributionPath).not.toBe(first.distributionPath);
		expect(second.retainedDistributionPaths).toEqual([first.distributionPath]);
		expect(await readFile(first.bundlePath)).toEqual(await readFile(firstSource.sourceBundlePath));
		expect(await readFile(second.bundlePath)).toEqual(await readFile(secondSource.sourceBundlePath));
		expect((await readdir(installationRoot)).some(name => name.startsWith(".stage-"))).toBe(false);
	});

	test("refuses to replace a tampered or partial content-addressed object", async () => {
		const tempRoot = await temporaryRoot("breadboard-engine-install-corrupt-");
		const installationRoot = join(tempRoot, "installed");
		const source = await createDistribution(tempRoot, "0.2.0", "c");
		const installed = await installEngineDistributionAtomically({
			root: installationRoot,
			manifest: source.manifest,
			bundlePath: source.sourceBundlePath,
		});
		const original = await readFile(installed.bundlePath);
		const tampered = Buffer.from(original);
		tampered[tampered.length - 1] ^= 0xff;
		await chmod(installed.distributionPath, 0o700);
		await chmod(installed.bundlePath, 0o600);
		await Bun.write(installed.bundlePath, tampered);
		await chmod(installed.bundlePath, 0o400);
		await chmod(installed.distributionPath, 0o500);

		expect(
			(
				await installError(() =>
					installEngineDistributionAtomically({
						root: installationRoot,
						manifest: source.manifest,
						bundlePath: source.sourceBundlePath,
					}),
				)
			).message,
		).toContain("digest differs");

		await chmod(installed.distributionPath, 0o700);
		await rm(installed.bundlePath);
		await chmod(installed.distributionPath, 0o500);
		expect(
			(
				await installError(() =>
					installEngineDistributionAtomically({
						root: installationRoot,
						manifest: source.manifest,
						bundlePath: source.sourceBundlePath,
					}),
				)
			).message,
		).toContain("partial");
	});
});
