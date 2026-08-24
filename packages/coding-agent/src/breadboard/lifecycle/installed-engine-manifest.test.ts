import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
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
	engineDistributionId,
	INSTALLED_ENGINE_SELECTION_PRECEDENCE,
	INSTALLED_ENGINE_SUPPORTED_TARGET,
	InstalledEngineDiscoveryError,
	installedEngineManifestPath,
	interfaceRangeContains,
	parseTrustedEngineDistributionManifest,
	resolveInstalledEngineExecutablePath,
} from "./installed-engine-manifest";

function sha256(value: string | Uint8Array): EngineDistributionSha256 {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const backendCommit = "c".repeat(40);
const backendTree = "d".repeat(40);
const payload: EngineDistributionManifestPayload = {
	productVersion: "0.1.0-rc.3",
	pathStrategy: ENGINE_DISTRIBUTION_PATH_STRATEGY,
	target: { platform: "darwin", architecture: "arm64" },
	engine: {
		executablePath: "payload/venv/bin/python",
		argv: ["-I", "-m", "breadboard_engine.api.cli_bridge.server"],
		executableSizeBytes: 42_000_000,
		executableSha256: sha256("python executable"),
		engineSourceSha256: sha256("breadboard engine Python sources"),
		servedBackendCommit: backendCommit,
		servedBackendTree: backendTree,
		interfaceVersion: "0.3.0",
		interfaceRange: ">=0.1.0 <0.4.0",
	},
	profile: {
		profileId: "daily_driver.v1",
		definitionRef: "agent_configs/templates/daily_driver.v1.yaml",
		schemaVersion: "bb.harness_definition.v1",
		sourceSha256: "sha256:155e9db1dabee3975739a221324215993002438dc33dd73402959dc4649709f5",
		effectiveLockSchemaVersion: "bb.effective_config_graph.v1",
		effectiveLockSha256: "sha256:165d34c5ed177005fa289544da0b451294c89bb51b0d289f2372c4bd081eff43",
	},
	provenance: {
		sourceRepository: "https://github.com/kmccleary3301/breadboard",
		sourceCommit: backendCommit,
		sourceTree: backendTree,
		buildRecipeSha256: sha256("engine build recipe"),
		dependencyLockSha256: sha256("engine dependency lock"),
	},
	signature: { kind: "unsigned-development" },
};

function discoveryError(run: () => unknown): InstalledEngineDiscoveryError {
	try {
		run();
	} catch (error) {
		if (error instanceof InstalledEngineDiscoveryError) return error;
		throw error;
	}
	throw new Error("expected InstalledEngineDiscoveryError");
}

function rawWithUpdatedTrust(value: unknown, trust: EngineDistributionTrustRoot) {
	const raw = `${JSON.stringify(value)}\n`;
	return {
		raw,
		trust: { ...trust, expectedManifestSha256: sha256(raw) },
	};
}

const manifest = createEngineDistributionManifest(payload);
const canonical = canonicalEngineDistributionManifest(manifest);
const trust = Object.freeze({
	schemaVersion: ENGINE_DISTRIBUTION_TRUST_SCHEMA,
	expectedManifestSha256: "sha256:9488a963d57ceffd978b22e611a1c513757264137ec0bea094441a8fb3342692",
	productVersion: "0.1.0-rc.3",
	target: { platform: "darwin", architecture: "arm64" },
	interfaceRange: ">=0.1.0 <0.4.0",
	profile: {
		profileId: "daily_driver.v1",
		effectiveLockSha256: "sha256:165d34c5ed177005fa289544da0b451294c89bb51b0d289f2372c4bd081eff43",
	},
	signature: { kind: "unsigned-development" },
} satisfies EngineDistributionTrustRoot);

describe("installed engine distribution contract", () => {
	test("creates one canonical content-addressed manifest and accepts only its build-pinned trust root", () => {
		expect(sha256(canonical)).toBe(trust.expectedManifestSha256);
		const parsed = parseTrustedEngineDistributionManifest(canonical, trust);

		expect(parsed).toEqual(manifest);
		expect(parsed.distributionId).toBe(engineDistributionId(payload));
		expect(canonical.endsWith("\n")).toBe(true);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.engine)).toBe(true);
		expect(Object.isFrozen(parsed.engine.argv)).toBe(true);
		expect(Object.isFrozen(parsed.profile)).toBe(true);
		expect(Object.isFrozen(parsed.provenance)).toBe(true);
		expect(Object.isFrozen(parsed.signature)).toBe(true);
	});

	test("keeps explicit selection ahead of the installed distribution without a network fallback", () => {
		expect(INSTALLED_ENGINE_SELECTION_PRECEDENCE).toEqual([
			"cli",
			"environment",
			"selected-config",
			"installed-distribution",
		]);
		expect(INSTALLED_ENGINE_SELECTION_PRECEDENCE).not.toContain("network");
		expect(INSTALLED_ENGINE_SUPPORTED_TARGET).toEqual({ platform: "darwin", architecture: "arm64" });
	});

	test("rejects byte tampering before parsing and rejects non-canonical trusted bytes", () => {
		const tampered = canonical.replace('"productVersion":"0.1.0-rc.3"', '"productVersion":"0.1.0-rc.4"');
		expect(discoveryError(() => parseTrustedEngineDistributionManifest(tampered, trust)).code).toBe(
			"engine_manifest_untrusted",
		);

		const nonCanonical = canonical.replace("\n", " \n");
		const updatedTrust = { ...trust, expectedManifestSha256: sha256(nonCanonical) };
		expect(discoveryError(() => parseTrustedEngineDistributionManifest(nonCanonical, updatedTrust)).code).toBe(
			"engine_manifest_invalid",
		);
		const duplicateKey = `${canonical.trimEnd().slice(0, -1)},"productVersion":"0.1.0-rc.3"}\n`;
		const duplicateTrust = { ...trust, expectedManifestSha256: sha256(duplicateKey) };
		expect(discoveryError(() => parseTrustedEngineDistributionManifest(duplicateKey, duplicateTrust)).code).toBe(
			"engine_manifest_invalid",
		);

		const invalidUtf8 = Uint8Array.of(0xff);
		const invalidUtf8Trust = { ...trust, expectedManifestSha256: sha256(invalidUtf8) };
		expect(discoveryError(() => parseTrustedEngineDistributionManifest(invalidUtf8, invalidUtf8Trust)).code).toBe(
			"engine_manifest_invalid",
		);
	});

	test("rejects unknown fields, stale distribution identity, path escape, and contradictory provenance", () => {
		const unknown = { ...structuredClone(manifest), executableDigest: sha256("unknown") };
		const unknownInput = rawWithUpdatedTrust(unknown, trust);
		expect(
			discoveryError(() => parseTrustedEngineDistributionManifest(unknownInput.raw, unknownInput.trust)).code,
		).toBe("engine_manifest_invalid");

		const staleIdentity = { ...structuredClone(manifest), distributionId: sha256("stale distribution") };
		const staleInput = rawWithUpdatedTrust(staleIdentity, trust);
		expect(discoveryError(() => parseTrustedEngineDistributionManifest(staleInput.raw, staleInput.trust)).code).toBe(
			"engine_manifest_invalid",
		);

		expect(
			discoveryError(() =>
				createEngineDistributionManifest({
					...payload,
					engine: { ...payload.engine, executablePath: "../outside/python" },
				}),
			).code,
		).toBe("engine_manifest_invalid");

		expect(
			discoveryError(() =>
				createEngineDistributionManifest({
					...payload,
					provenance: { ...payload.provenance, sourceTree: "e".repeat(40) },
				}),
			).code,
		).toBe("engine_manifest_invalid");
	});

	test("rejects mismatched product, target, interface, profile, and signature trust roots distinctly", () => {
		expect(
			discoveryError(() =>
				parseTrustedEngineDistributionManifest(canonical, {
					...trust,
					productVersion: "0.1.0-rc.4",
				}),
			).code,
		).toBe("engine_product_mismatch");
		expect(
			discoveryError(() =>
				parseTrustedEngineDistributionManifest(canonical, {
					...trust,
					target: { platform: "linux", architecture: "arm64" },
				}),
			).code,
		).toBe("engine_target_mismatch");
		expect(
			discoveryError(() =>
				parseTrustedEngineDistributionManifest(canonical, {
					...trust,
					interfaceRange: ">=0.2.0 <0.4.0",
				}),
			).code,
		).toBe("engine_interface_mismatch");
		expect(
			discoveryError(() =>
				parseTrustedEngineDistributionManifest(canonical, {
					...trust,
					profile: { ...trust.profile, effectiveLockSha256: sha256("different profile") },
				}),
			).code,
		).toBe("engine_profile_mismatch");
		expect(
			discoveryError(() =>
				parseTrustedEngineDistributionManifest(canonical, {
					...trust,
					signature: {
						kind: "release-envelope",
						keyId: "breadboard-release-1",
						envelopeSha256: "sha256:a87d6fb8295705aa759987670c5428e6fcd8d3a6a7ba41d944b018768d8d95f0",
					},
				}),
			).code,
		).toBe("engine_signature_untrusted");
	});

	test("requires a valid bounded interface range containing the engine version", () => {
		expect(interfaceRangeContains(">=0.1.0 <0.4.0", "0.3.0")).toBe(true);
		expect(interfaceRangeContains(">=0.1.0 <0.3.0", "0.3.0")).toBe(false);
		expect(interfaceRangeContains(">=0.1.0 <0.4.0", "0.4.0")).toBe(false);
		expect(interfaceRangeContains(">=0.1.0 <0.4.0", "0.3.0-rc.1")).toBe(false);
		expect(
			interfaceRangeContains(">=999999999999999999999.0.0 <999999999999999999999.0.1", "999999999999999999999.0.0"),
		).toBe(false);
		expect(
			discoveryError(() =>
				createEngineDistributionManifest({
					...payload,
					engine: { ...payload.engine, interfaceVersion: "0.4.0" },
				}),
			).code,
		).toBe("engine_interface_mismatch");
		expect(
			discoveryError(() =>
				createEngineDistributionManifest({
					...payload,
					engine: { ...payload.engine, interfaceRange: ">=0.4.0 <0.4.0" },
				}),
			).code,
		).toBe("engine_manifest_invalid");
		expect(
			discoveryError(() =>
				createEngineDistributionManifest({
					...payload,
					engine: {
						...payload.engine,
						interfaceRange: ">=999999999999999999999.0.0 <999999999999999999999.0.1",
					},
				}),
			).code,
		).toBe("engine_manifest_invalid");
	});

	test("separates a release-envelope declaration from independently pinned signature facts", () => {
		const signature = {
			kind: "release-envelope" as const,
			keyId: "breadboard-release-1",
			envelopePath: "signatures/engine.sig",
		};
		const releaseManifest = createEngineDistributionManifest({ ...payload, signature });
		const releaseRaw = canonicalEngineDistributionManifest(releaseManifest);
		const releaseTrust: EngineDistributionTrustRoot = {
			...trust,
			expectedManifestSha256: "sha256:a17290014d05355658b23ee412458c7e617daa5e6b608743dc85b33ef3d10148",
			signature: {
				kind: "release-envelope",
				keyId: "breadboard-release-1",
				envelopeSha256: "sha256:a87d6fb8295705aa759987670c5428e6fcd8d3a6a7ba41d944b018768d8d95f0",
			},
		};

		expect(sha256(releaseRaw)).toBe(releaseTrust.expectedManifestSha256);
		expect(parseTrustedEngineDistributionManifest(releaseRaw, releaseTrust).signature).toEqual(signature);
	});

	test("derives one adjacent bundled manifest from the canonical bb executable", () => {
		const productExecutable = resolve("bundle", "bb");
		expect(installedEngineManifestPath(productExecutable, path => path)).toBe(
			resolve(dirname(productExecutable), ENGINE_DISTRIBUTION_DIRECTORY, ENGINE_DISTRIBUTION_MANIFEST_FILENAME),
		);
		expect(discoveryError(() => installedEngineManifestPath("bb")).code).toBe("engine_manifest_unavailable");
		expect(
			discoveryError(() =>
				installedEngineManifestPath(productExecutable, () => {
					throw new Error("missing");
				}),
			).code,
		).toBe("engine_manifest_unavailable");
		expect(discoveryError(() => installedEngineManifestPath(productExecutable, () => "relative")).code).toBe(
			"engine_manifest_unavailable",
		);
	});

	test("resolves only a canonical executable contained by the manifest directory", () => {
		const manifestPath = resolve("bundle", "engine", ENGINE_DISTRIBUTION_MANIFEST_FILENAME);
		const root = dirname(manifestPath);
		const expected = resolve(root, manifest.engine.executablePath);
		expect(resolveInstalledEngineExecutablePath(manifestPath, manifest, path => path)).toBe(expected);

		const escaped = discoveryError(() =>
			resolveInstalledEngineExecutablePath(manifestPath, manifest, path =>
				path === root ? path : resolve(root, "..", "outside", "python"),
			),
		);
		expect(escaped.code).toBe("engine_artifact_mismatch");
		expect(
			discoveryError(() => resolveInstalledEngineExecutablePath(manifestPath, manifest, () => "relative")).code,
		).toBe("engine_artifact_mismatch");

		let calls = 0;
		const unavailable = discoveryError(() =>
			resolveInstalledEngineExecutablePath(manifestPath, manifest, path => {
				calls++;
				if (calls === 1) return path;
				throw new Error("missing");
			}),
		);
		expect(unavailable.code).toBe("engine_artifact_unavailable");
		expect(discoveryError(() => resolveInstalledEngineExecutablePath("relative/manifest.json", manifest)).code).toBe(
			"engine_manifest_invalid",
		);
	});

	test("provides secret-safe complete-distribution remediation instead of accepting user replacement hashes", () => {
		for (const code of [
			"engine_manifest_unavailable",
			"engine_manifest_untrusted",
			"engine_manifest_invalid",
			"engine_profile_mismatch",
			"engine_signature_untrusted",
			"engine_artifact_unavailable",
			"engine_artifact_mismatch",
		] as const) {
			const error = new InstalledEngineDiscoveryError(code);
			expect(error.message).not.toContain(payload.engine.executablePath);
			expect(error.remediation).toContain("complete trusted distribution");
			expect(error.remediation).toContain("do not edit");
			expect(error.remediation).not.toContain(payload.engine.executableSha256);
		}
	});
});
