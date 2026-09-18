import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_RUNTIME_BUNDLE_SCHEMA } from "../packages/coding-agent/src/breadboard/lifecycle/engine-runtime-bundle";
import {
	ENGINE_DISTRIBUTION_MANIFEST_SCHEMA,
	ENGINE_DISTRIBUTION_PATH_STRATEGY,
	ENGINE_DISTRIBUTION_TRUST_SCHEMA,
	INSTALLED_ENGINE_SUPPORTED_TARGET,
	type EngineDistributionSha256,
} from "../packages/coding-agent/src/breadboard/lifecycle/installed-engine-manifest";
import type { BuildEngineDistribution } from "../packages/coding-agent/scripts/prepare-installed-engine-sidecar";
import { renderLocalProductLauncher } from "./local-product-launcher";

const FIXTURE_DIGEST: EngineDistributionSha256 = "sha256:launcher-fixture";

const distribution = {
	trustRoot: {
		schemaVersion: ENGINE_DISTRIBUTION_TRUST_SCHEMA,
		distributionId: FIXTURE_DIGEST,
		expectedManifestSha256: FIXTURE_DIGEST,
		productVersion: "0.1.0-rc.7",
		target: INSTALLED_ENGINE_SUPPORTED_TARGET,
		interfaceRange: ">=0.4.0 <0.5.0",
		profile: { profileId: "launcher-fixture", effectiveLockSha256: FIXTURE_DIGEST },
		signature: { kind: "unsigned-development" },
	},
	manifest: {
		schemaVersion: ENGINE_DISTRIBUTION_MANIFEST_SCHEMA,
		distributionId: FIXTURE_DIGEST,
		productVersion: "0.1.0-rc.7",
		pathStrategy: ENGINE_DISTRIBUTION_PATH_STRATEGY,
		target: INSTALLED_ENGINE_SUPPORTED_TARGET,
		engine: {
			runtimeBundle: {
				schemaVersion: ENGINE_RUNTIME_BUNDLE_SCHEMA,
				path: "breadboard-engine-runtime.v1.bundle",
				sizeBytes: 1,
				sha256: FIXTURE_DIGEST,
			},
			executablePath: "payload/venv/bin/python",
			argv: ["-I", "-m", "fixture"],
			executableSizeBytes: 1,
			executableSha256: FIXTURE_DIGEST,
			engineSourceSha256: FIXTURE_DIGEST,
			servedBackendCommit: "fixture-commit",
			servedBackendTree: "fixture-tree",
			interfaceVersion: "0.4.0",
			interfaceRange: ">=0.4.0 <0.5.0",
		},
		profile: {
			profileId: "launcher-fixture",
			definitionRef: "fixture.yaml",
			schemaVersion: "bb.harness_definition.v1",
			sourceSha256: FIXTURE_DIGEST,
			effectiveLockSchemaVersion: "bb.effective_config_graph.v1",
			effectiveLockSha256: FIXTURE_DIGEST,
		},
		provenance: {
			sourceRepository: "https://example.invalid/launcher-fixture",
			sourceCommit: "fixture-commit",
			sourceTree: "fixture-tree",
			buildRecipeSha256: FIXTURE_DIGEST,
			dependencyLockSha256: FIXTURE_DIGEST,
		},
		signature: { kind: "unsigned-development" },
	},
	manifestBytes: Buffer.from("launcher-fixture-manifest"),
	manifestPath: "/tmp/launcher-fixture-manifest.json",
	bundlePath: "/tmp/launcher-fixture.bundle",
} satisfies BuildEngineDistribution;

describe("local product launcher environment", () => {
	test("forwards PI_DEBUG_STARTUP but keeps unrelated environment out", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-local-launcher-env-"));
		try {
			const home = join(root, "home");
			const workspace = join(root, "workspace");
			const sourceRoot = join(root, "source");
			const profileRoot = join(root, "profile");
			const harnessPath = join(sourceRoot, "daily.harness.yaml");
			const binaryPath = join(root, "fake-bb");
			await Promise.all([
				mkdir(home, { recursive: true }),
				mkdir(workspace, { recursive: true }),
				mkdir(sourceRoot, { recursive: true }),
			]);
			await Promise.all([
				writeFile(harnessPath, "fixture: launcher\n"),
				writeFile(
					binaryPath,
					`#!/bin/sh\nprintf 'debug=%s\\nunrelated=%s\\n' "\${PI_DEBUG_STARTUP-}" "\${UNRELATED_SENTINEL-}"\n`,
				),
			]);
			await chmod(binaryPath, 0o700);
			const launcher = join(profileRoot, "launch");
			await mkdir(profileRoot, { recursive: true });
			await writeFile(
				launcher,
				renderLocalProductLauncher({
					binaryPath,
					profileRoot,
					harnessPath,
					workspaceHarnessPath: "config/daily.harness.yaml",
					authSource: join(root, "auth-source"),
					defaultModel: "fixture/model",
					distribution,
				}),
			);
			await chmod(launcher, 0o700);

			const run = async (debugStartup: boolean): Promise<string> => {
				const env = {
					...process.env,
					HOME: home,
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					UNRELATED_SENTINEL: "must-not-cross-env-i",
				};
				if (debugStartup) env.PI_DEBUG_STARTUP = "1";
				else delete env.PI_DEBUG_STARTUP;
				const child = Bun.spawn([launcher], { cwd: workspace, env, stdout: "pipe", stderr: "pipe" });
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(exitCode, stderr).toBe(0);
				expect(stderr).toBe("");
				return stdout;
			};

			expect(await run(true)).toBe("debug=1\nunrelated=\n");
			expect(await run(false)).toBe("debug=\nunrelated=\n");
			expect(await readFile(join(workspace, "config", "daily.harness.yaml"), "utf8")).toBe("fixture: launcher\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
