import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBuildEngineDistribution } from "../packages/coding-agent/scripts/prepare-installed-engine-sidecar";
import { ENGINE_RUNTIME_BUNDLE_SCHEMA } from "../packages/coding-agent/src/breadboard/lifecycle/engine-runtime-bundle";
import {
	canonicalEngineDistributionManifest,
	createEngineDistributionManifest,
	ENGINE_DISTRIBUTION_PATH_STRATEGY,
	ENGINE_DISTRIBUTION_TRUST_SCHEMA,
	type EngineDistributionManifestPayload,
	INSTALLED_ENGINE_SUPPORTED_TARGET,
} from "../packages/coding-agent/src/breadboard/lifecycle/installed-engine-manifest";
import { BREADBOARD_DISTRIBUTION_POLICY } from "../packages/utils/src/product-distribution";
import { buildProductRelease } from "./build-product-release";
import { verifyProductArchive } from "./install-product-release";

const ALLOW_UNSIGNED = Object.freeze({ allowUnsignedDevelopment: true });

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

async function fixture(
	root: string,
	interfaceVersion = BREADBOARD_DISTRIBUTION_POLICY.sdkVersion,
	interfaceRange = BREADBOARD_DISTRIBUTION_POLICY.engineApiRange,
): Promise<{
	readonly binaryPath: string;
	readonly nativeAddonPath: string;
	readonly engineDistributionRoot: string;
}> {
	const binaryPath = join(root, "bb");
	const nativeAddonPath = join(root, "pi_natives.darwin-arm64.node");
	const engineDistributionRoot = join(root, "engine-build");
	await writeFile(
		binaryPath,
		`#!/bin/sh\nprintf '%s\\n' '${[
			`bb/${BREADBOARD_DISTRIBUTION_POLICY.productVersion}`,
			`omp/${BREADBOARD_DISTRIBUTION_POLICY.ompVersion}`,
			`sdk/${BREADBOARD_DISTRIBUTION_POLICY.sdkVersion}`,
			`engine-api ${BREADBOARD_DISTRIBUTION_POLICY.engineApiRange}`,
		].join(" ")}'\n`,
	);
	await chmod(binaryPath, 0o500);
	await writeFile(nativeAddonPath, Buffer.from("native-addon"));
	await chmod(nativeAddonPath, 0o400);

	const bundle = Buffer.from("engine-runtime");
	const payload: EngineDistributionManifestPayload = {
		productVersion: BREADBOARD_DISTRIBUTION_POLICY.productVersion,
		pathStrategy: ENGINE_DISTRIBUTION_PATH_STRATEGY,
		target: INSTALLED_ENGINE_SUPPORTED_TARGET,
		engine: {
			runtimeBundle: {
				schemaVersion: ENGINE_RUNTIME_BUNDLE_SCHEMA,
				path: "breadboard-engine-runtime.v1.bundle",
				sizeBytes: bundle.byteLength,
				sha256: `sha256:${sha256(bundle)}`,
			},
			executablePath: "payload/venv/bin/python",
			argv: ["-I", "-m", "breadboard_engine.api.cli_bridge.server"],
			executableSizeBytes: 12,
			executableSha256: `sha256:${sha256("python-engine")}`,
			engineSourceSha256: `sha256:${sha256("engine-source")}`,
			servedBackendCommit: "a".repeat(40),
			servedBackendTree: "b".repeat(40),
			interfaceVersion,
			interfaceRange,
		},
		profile: {
			profileId: "daily_driver.v1",
			definitionRef: "agent_configs/templates/daily_driver.v1.yaml",
			schemaVersion: "bb.harness_definition.v1",
			sourceSha256: `sha256:${sha256("profile-source")}`,
			effectiveLockSchemaVersion: "bb.effective_config_graph.v1",
			effectiveLockSha256: `sha256:${sha256("profile-lock")}`,
		},
		provenance: {
			sourceRepository: "https://example.invalid/current-breadboard",
			sourceCommit: "a".repeat(40),
			sourceTree: "b".repeat(40),
			buildRecipeSha256: `sha256:${sha256("build-recipe")}`,
			dependencyLockSha256: `sha256:${sha256("dependency-lock")}`,
		},
		signature: { kind: "unsigned-development" },
	};
	const manifest = createEngineDistributionManifest(payload);
	const manifestBytes = Buffer.from(canonicalEngineDistributionManifest(manifest));
	const distributionName = manifest.distributionId.slice("sha256:".length);
	const distributionRoot = join(engineDistributionRoot, distributionName);
	const trust = {
		schemaVersion: ENGINE_DISTRIBUTION_TRUST_SCHEMA,
		distributionId: manifest.distributionId,
		expectedManifestSha256: `sha256:${sha256(manifestBytes)}`,
		productVersion: payload.productVersion,
		target: payload.target,
		interfaceRange: payload.engine.interfaceRange,
		profile: { profileId: payload.profile.profileId, effectiveLockSha256: payload.profile.effectiveLockSha256 },
		signature: { kind: "unsigned-development" as const },
	};
	await mkdir(engineDistributionRoot, { recursive: true, mode: 0o700 });
	await mkdir(distributionRoot, { mode: 0o700 });
	await writeFile(join(distributionRoot, "breadboard-engine-manifest.v1.json"), manifestBytes);
	await chmod(join(distributionRoot, "breadboard-engine-manifest.v1.json"), 0o400);
	await writeFile(join(distributionRoot, payload.engine.runtimeBundle.path), bundle);
	await chmod(join(distributionRoot, payload.engine.runtimeBundle.path), 0o400);
	await writeFile(join(engineDistributionRoot, `${distributionName}.trust.json`), `${JSON.stringify(trust)}\n`);
	await chmod(join(engineDistributionRoot, `${distributionName}.trust.json`), 0o400);
	await chmod(distributionRoot, 0o500);
	await chmod(engineDistributionRoot, 0o700);
	await loadBuildEngineDistribution(engineDistributionRoot);
	return { binaryPath, nativeAddonPath, engineDistributionRoot };
}
async function removeFixtureRoot(root: string): Promise<void> {
	const engineRoot = join(root, "engine-build");
	for (const entry of await readdir(engineRoot, { withFileTypes: true }).catch(() => [])) {
		if (entry.isDirectory()) await chmod(join(engineRoot, entry.name), 0o700);
	}
	await chmod(engineRoot, 0o700).catch(() => undefined);
	await rm(root, { recursive: true, force: true });
}

describe("product release builder", () => {
	test("builds a deterministic Darwin arm64 archive from the current policy and engine", async () => {
		const root = await mkdtemp(join(tmpdir(), "bb-product-build-test-"));
		try {
			const inputs = await fixture(root);
			const licensePath = join(root, "LICENSE");
			const noticesPath = join(root, "THIRD_PARTY_NOTICES.txt");
			await writeFile(licensePath, "license\n");
			await writeFile(noticesPath, "notices\n");
			await chmod(licensePath, 0o400);
			await chmod(noticesPath, 0o400);
			const options = {
				...inputs,
				productVersion: BREADBOARD_DISTRIBUTION_POLICY.productVersion,
				developmentEvidence: true,
				licensePath,
				noticesPath,
			};
			const first = await buildProductRelease({ ...options, outputRoot: join(root, "release-a") });
			const second = await buildProductRelease({ ...options, outputRoot: join(root, "release-b") });
			expect(first.target).toEqual(INSTALLED_ENGINE_SUPPORTED_TARGET);
			expect(first.legal).toEqual({ posture: "unsigned-development", inputsPresent: true });
			expect(first.archiveSha256).toBe(second.archiveSha256);
			expect(await readFile(first.archivePath)).toEqual(await readFile(second.archivePath));
			expect(first.entries.some(entry => entry.endsWith("/bb"))).toBeTrue();
			expect((await verifyProductArchive(first.archivePath, ALLOW_UNSIGNED)).productVersion).toBe(
				BREADBOARD_DISTRIBUTION_POLICY.productVersion,
			);
		} finally {
			await removeFixtureRoot(root);
		}
	});

	test("rejects a native addon path the installer cannot launch", async () => {
		const root = await mkdtemp(join(tmpdir(), "bb-product-build-test-"));
		try {
			const inputs = await fixture(root);
			const incompatibleAddonPath = join(root, "foo.node");
			await writeFile(incompatibleAddonPath, await readFile(inputs.nativeAddonPath));
			await chmod(incompatibleAddonPath, 0o400);
			await expect(
				buildProductRelease({
					...inputs,
					nativeAddonPath: incompatibleAddonPath,
					outputRoot: join(root, "release"),
					productVersion: BREADBOARD_DISTRIBUTION_POLICY.productVersion,
					developmentEvidence: true,
				}),
			).rejects.toThrow(/native addon path must name pi_natives\.darwin-arm64\.node/);
		} finally {
			await removeFixtureRoot(root);
		}
	});

	test("rejects a product version that is not the current distribution policy", async () => {
		const root = await mkdtemp(join(tmpdir(), "bb-product-build-test-"));
		try {
			const inputs = await fixture(root);
			await expect(
				buildProductRelease({
					...inputs,
					outputRoot: join(root, "release"),
					productVersion: "9.9.9",
					developmentEvidence: true,
				}),
			).rejects.toThrow(/current distribution policy/);
		} finally {
			await removeFixtureRoot(root);
		}
	});
	test("rejects an engine outside the current interface contract", async () => {
		const root = await mkdtemp(join(tmpdir(), "bb-product-build-test-"));
		try {
			const inputs = await fixture(root, "0.3.0", ">=0.1.0 <0.4.0");
			await expect(
				buildProductRelease({
					...inputs,
					outputRoot: join(root, "release"),
					productVersion: BREADBOARD_DISTRIBUTION_POLICY.productVersion,
					developmentEvidence: true,
				}),
			).rejects.toThrow(/engine interface.*does not match current distribution policy/);
		} finally {
			await removeFixtureRoot(root);
		}
	});
});
