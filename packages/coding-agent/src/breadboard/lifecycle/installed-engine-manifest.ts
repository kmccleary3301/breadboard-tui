import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ENGINE_RUNTIME_BUNDLE_SCHEMA, parseEngineRuntimeBundleRelativePath } from "./engine-runtime-bundle";

export const ENGINE_DISTRIBUTION_MANIFEST_SCHEMA = "bb.engine_distribution_manifest.v1" as const;
export const ENGINE_DISTRIBUTION_TRUST_SCHEMA = "bb.engine_distribution_trust.v1" as const;
export const ENGINE_DISTRIBUTION_PATH_STRATEGY = "manifest-bundle-relative-v1" as const;
export const ENGINE_DISTRIBUTION_MANIFEST_FILENAME = "breadboard-engine-manifest.v1.json" as const;
export const ENGINE_DISTRIBUTION_DIRECTORY = "engine" as const;
/** Explicit operator configuration always wins; discovery is a product-only final fallback. */
export const INSTALLED_ENGINE_SELECTION_PRECEDENCE = [
	"cli",
	"environment",
	"selected-config",
	"installed-distribution",
] as const;

export const ENGINE_DISTRIBUTION_MAX_MANIFEST_BYTES = 64 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCHEMA_ID = /^bb\.[a-z0-9_.]+\.v[0-9]+$/;
const PRODUCT_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const INTERFACE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const INTERFACE_RANGE =
	/^>=(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*) <(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export type EngineDistributionSha256 = `sha256:${string}`;
export type EngineDistributionPlatform = "darwin" | "linux";
export type EngineDistributionArchitecture = "arm64" | "x64";

export interface EngineDistributionTarget {
	readonly platform: EngineDistributionPlatform;
	readonly architecture: EngineDistributionArchitecture;
}
/** The current verified lifecycle adapter supports exactly the native Apple Silicon product target. */
export const INSTALLED_ENGINE_SUPPORTED_TARGET = Object.freeze({
	platform: "darwin",
	architecture: "arm64",
} as const);

export interface EngineDistributionRuntimeBundle {
	readonly schemaVersion: typeof ENGINE_RUNTIME_BUNDLE_SCHEMA;
	readonly path: string;
	readonly sizeBytes: number;
	readonly sha256: EngineDistributionSha256;
}

export interface EngineDistributionEngine {
	readonly runtimeBundle: EngineDistributionRuntimeBundle;
	readonly executablePath: string;
	readonly argv: readonly string[];
	readonly executableSizeBytes: number;
	readonly executableSha256: EngineDistributionSha256;
	readonly engineSourceSha256: EngineDistributionSha256;
	readonly servedBackendCommit: string;
	readonly servedBackendTree: string;
	readonly interfaceVersion: string;
	readonly interfaceRange: string;
}

export interface EngineDistributionProfile {
	readonly profileId: string;
	readonly definitionRef: string;
	readonly schemaVersion: string;
	readonly sourceSha256: EngineDistributionSha256;
	readonly effectiveLockSchemaVersion: string;
	readonly effectiveLockSha256: EngineDistributionSha256;
}

export interface EngineDistributionProvenance {
	readonly sourceRepository: string;
	readonly sourceCommit: string;
	readonly sourceTree: string;
	readonly buildRecipeSha256: EngineDistributionSha256;
	readonly dependencyLockSha256: EngineDistributionSha256;
}

/** The manifest declares where the detached release envelope lives; it cannot authorize its own digest. */
export type EngineDistributionSignature =
	| { readonly kind: "unsigned-development" }
	| {
			readonly kind: "release-envelope";
			readonly keyId: string;
			readonly envelopePath: string;
	  };

/** The envelope digest is an independent build-pinned fact, avoiding a manifest/signature hash cycle. */
export type EngineDistributionSignatureTrust =
	| { readonly kind: "unsigned-development" }
	| {
			readonly kind: "release-envelope";
			readonly keyId: string;
			readonly envelopeSha256: EngineDistributionSha256;
	  };

export interface EngineDistributionManifestPayload {
	readonly productVersion: string;
	readonly pathStrategy: typeof ENGINE_DISTRIBUTION_PATH_STRATEGY;
	readonly target: EngineDistributionTarget;
	readonly engine: EngineDistributionEngine;
	readonly profile: EngineDistributionProfile;
	readonly provenance: EngineDistributionProvenance;
	readonly signature: EngineDistributionSignature;
}

export interface EngineDistributionManifest extends EngineDistributionManifestPayload {
	readonly schemaVersion: typeof ENGINE_DISTRIBUTION_MANIFEST_SCHEMA;
	readonly distributionId: EngineDistributionSha256;
}

/** Build-generated facts embedded with `bb`; never load this value from settings, environment, or the manifest. */
export interface EngineDistributionTrustRoot {
	readonly schemaVersion: typeof ENGINE_DISTRIBUTION_TRUST_SCHEMA;
	readonly expectedManifestSha256: EngineDistributionSha256;
	readonly productVersion: string;
	readonly target: EngineDistributionTarget;
	readonly interfaceRange: string;
	readonly profile: {
		readonly profileId: string;
		readonly effectiveLockSha256: EngineDistributionSha256;
	};
	readonly signature: EngineDistributionSignatureTrust;
}

export type InstalledEngineDiscoveryErrorCode =
	| "engine_manifest_unavailable"
	| "engine_manifest_untrusted"
	| "engine_manifest_invalid"
	| "engine_target_mismatch"
	| "engine_interface_mismatch"
	| "engine_product_mismatch"
	| "engine_profile_mismatch"
	| "engine_signature_untrusted"
	| "engine_artifact_unavailable"
	| "engine_artifact_mismatch";

const ERROR_MESSAGES: Readonly<Record<InstalledEngineDiscoveryErrorCode, string>> = Object.freeze({
	engine_manifest_unavailable: "The installed BreadBoard engine manifest is unavailable.",
	engine_manifest_untrusted: "The installed BreadBoard engine manifest is not trusted by this bb build.",
	engine_manifest_invalid: "The installed BreadBoard engine manifest is invalid.",
	engine_target_mismatch: "The installed BreadBoard engine targets a different platform or architecture.",
	engine_interface_mismatch: "The installed BreadBoard engine interface is incompatible with this bb build.",
	engine_product_mismatch: "The installed BreadBoard engine belongs to a different product version.",
	engine_profile_mismatch: "The installed BreadBoard engine profile does not match this bb build.",
	engine_signature_untrusted: "The installed BreadBoard engine signature does not match this bb build.",
	engine_artifact_unavailable: "The installed BreadBoard engine executable is unavailable.",
	engine_artifact_mismatch: "The installed BreadBoard engine executable does not match its trusted distribution.",
});

const REINSTALL_REMEDIATION =
	"Reinstall BreadBoard from one complete trusted distribution; do not edit the manifest or supply replacement hashes.";
const REMEDIATIONS: Readonly<Record<InstalledEngineDiscoveryErrorCode, string>> = Object.freeze({
	engine_manifest_unavailable: REINSTALL_REMEDIATION,
	engine_manifest_untrusted: REINSTALL_REMEDIATION,
	engine_manifest_invalid: REINSTALL_REMEDIATION,
	engine_target_mismatch: "Install the BreadBoard distribution built for this platform and architecture.",
	engine_interface_mismatch: "Install a complete BreadBoard distribution whose bb and engine versions match.",
	engine_product_mismatch: "Install one complete BreadBoard distribution; do not mix bb and engine versions.",
	engine_profile_mismatch: REINSTALL_REMEDIATION,
	engine_signature_untrusted: REINSTALL_REMEDIATION,
	engine_artifact_unavailable: REINSTALL_REMEDIATION,
	engine_artifact_mismatch: REINSTALL_REMEDIATION,
});

export class InstalledEngineDiscoveryError extends Error {
	override readonly name = "InstalledEngineDiscoveryError";
	readonly remediation: string;

	constructor(readonly code: InstalledEngineDiscoveryErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.remediation = REMEDIATIONS[code];
	}
}

function fail(code: InstalledEngineDiscoveryErrorCode): never {
	throw new InstalledEngineDiscoveryError(code);
}

function expectRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail("engine_manifest_invalid");
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		fail("engine_manifest_invalid");
	}
	return record;
}

function expectString(value: unknown, pattern?: RegExp): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0") || (pattern && !pattern.test(value))) {
		fail("engine_manifest_invalid");
	}
	return value;
}

function expectSha256(value: unknown): EngineDistributionSha256 {
	return expectString(value, SHA256) as EngineDistributionSha256;
}

function expectPositiveInteger(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) fail("engine_manifest_invalid");
	return value as number;
}

function expectRelativePath(value: unknown): string {
	const path = expectString(value);
	if (
		path !== path.trim() ||
		path.includes("\\") ||
		path.startsWith("/") ||
		path.endsWith("/") ||
		path.split("/").some(part => part.length === 0 || part === "." || part === "..")
	) {
		fail("engine_manifest_invalid");
	}
	return path;
}

function expectRepository(value: unknown): string {
	const repository = expectString(value);
	let parsed: URL;
	try {
		parsed = new URL(repository);
	} catch {
		return fail("engine_manifest_invalid");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.pathname === "/"
	) {
		fail("engine_manifest_invalid");
	}
	return repository;
}

function expectArgv(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.some(argument => typeof argument !== "string" || argument.includes("\0"))) {
		fail("engine_manifest_invalid");
	}
	return Object.freeze([...value]) as readonly string[];
}

function decodeTarget(value: unknown): EngineDistributionTarget {
	const record = expectRecord(value, ["platform", "architecture"]);
	if (record.platform !== "darwin" && record.platform !== "linux") fail("engine_manifest_invalid");
	if (record.architecture !== "arm64" && record.architecture !== "x64") fail("engine_manifest_invalid");
	return Object.freeze({ platform: record.platform, architecture: record.architecture });
}

function expectRuntimeBundlePath(value: unknown): string {
	try {
		return parseEngineRuntimeBundleRelativePath(value);
	} catch {
		return fail("engine_manifest_invalid");
	}
}

function decodeRuntimeBundle(value: unknown): EngineDistributionRuntimeBundle {
	const record = expectRecord(value, ["schemaVersion", "path", "sizeBytes", "sha256"]);
	if (record.schemaVersion !== ENGINE_RUNTIME_BUNDLE_SCHEMA) fail("engine_manifest_invalid");
	const path = expectRuntimeBundlePath(record.path);
	return Object.freeze({
		schemaVersion: ENGINE_RUNTIME_BUNDLE_SCHEMA,
		path,
		sizeBytes: expectPositiveInteger(record.sizeBytes),
		sha256: expectSha256(record.sha256),
	});
}

function decodeEngine(value: unknown): EngineDistributionEngine {
	const record = expectRecord(value, [
		"runtimeBundle",
		"executablePath",
		"argv",
		"executableSizeBytes",
		"executableSha256",
		"engineSourceSha256",
		"servedBackendCommit",
		"servedBackendTree",
		"interfaceVersion",
		"interfaceRange",
	]);
	const interfaceVersion = expectString(record.interfaceVersion, INTERFACE_VERSION);
	const interfaceRange = expectInterfaceRange(record.interfaceRange);
	if (!interfaceRangeContains(interfaceRange, interfaceVersion)) fail("engine_interface_mismatch");
	return Object.freeze({
		runtimeBundle: decodeRuntimeBundle(record.runtimeBundle),
		executablePath: expectRuntimeBundlePath(record.executablePath),
		argv: expectArgv(record.argv),
		executableSizeBytes: expectPositiveInteger(record.executableSizeBytes),
		executableSha256: expectSha256(record.executableSha256),
		engineSourceSha256: expectSha256(record.engineSourceSha256),
		servedBackendCommit: expectString(record.servedBackendCommit, GIT_OBJECT_ID),
		servedBackendTree: expectString(record.servedBackendTree, GIT_OBJECT_ID),
		interfaceVersion,
		interfaceRange,
	});
}

function decodeProfile(value: unknown): EngineDistributionProfile {
	const record = expectRecord(value, [
		"profileId",
		"definitionRef",
		"schemaVersion",
		"sourceSha256",
		"effectiveLockSchemaVersion",
		"effectiveLockSha256",
	]);
	return Object.freeze({
		profileId: expectString(record.profileId, PROFILE_ID),
		definitionRef: expectRelativePath(record.definitionRef),
		schemaVersion: expectString(record.schemaVersion, SCHEMA_ID),
		sourceSha256: expectSha256(record.sourceSha256),
		effectiveLockSchemaVersion: expectString(record.effectiveLockSchemaVersion, SCHEMA_ID),
		effectiveLockSha256: expectSha256(record.effectiveLockSha256),
	});
}

function decodeProvenance(value: unknown): EngineDistributionProvenance {
	const record = expectRecord(value, [
		"sourceRepository",
		"sourceCommit",
		"sourceTree",
		"buildRecipeSha256",
		"dependencyLockSha256",
	]);
	return Object.freeze({
		sourceRepository: expectRepository(record.sourceRepository),
		sourceCommit: expectString(record.sourceCommit, GIT_OBJECT_ID),
		sourceTree: expectString(record.sourceTree, GIT_OBJECT_ID),
		buildRecipeSha256: expectSha256(record.buildRecipeSha256),
		dependencyLockSha256: expectSha256(record.dependencyLockSha256),
	});
}

function decodeSignature(value: unknown): EngineDistributionSignature {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail("engine_manifest_invalid");
	const kind = (value as Record<string, unknown>).kind;
	if (kind === "unsigned-development") {
		expectRecord(value, ["kind"]);
		return Object.freeze({ kind });
	}
	if (kind === "release-envelope") {
		const record = expectRecord(value, ["kind", "keyId", "envelopePath"]);
		return Object.freeze({
			kind,
			keyId: expectString(record.keyId, IDENTIFIER),
			envelopePath: expectRelativePath(record.envelopePath),
		});
	}
	return fail("engine_manifest_invalid");
}

function decodeSignatureTrust(value: unknown): EngineDistributionSignatureTrust {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail("engine_manifest_invalid");
	const kind = (value as Record<string, unknown>).kind;
	if (kind === "unsigned-development") {
		expectRecord(value, ["kind"]);
		return Object.freeze({ kind });
	}
	if (kind === "release-envelope") {
		const record = expectRecord(value, ["kind", "keyId", "envelopeSha256"]);
		return Object.freeze({
			kind,
			keyId: expectString(record.keyId, IDENTIFIER),
			envelopeSha256: expectSha256(record.envelopeSha256),
		});
	}
	return fail("engine_manifest_invalid");
}

function decodePayload(value: unknown): EngineDistributionManifestPayload {
	const record = expectRecord(value, [
		"productVersion",
		"pathStrategy",
		"target",
		"engine",
		"profile",
		"provenance",
		"signature",
	]);
	if (record.pathStrategy !== ENGINE_DISTRIBUTION_PATH_STRATEGY) fail("engine_manifest_invalid");
	const engine = decodeEngine(record.engine);
	const provenance = decodeProvenance(record.provenance);
	if (engine.servedBackendCommit !== provenance.sourceCommit || engine.servedBackendTree !== provenance.sourceTree) {
		fail("engine_manifest_invalid");
	}
	return Object.freeze({
		productVersion: expectString(record.productVersion, PRODUCT_VERSION),
		pathStrategy: ENGINE_DISTRIBUTION_PATH_STRATEGY,
		target: decodeTarget(record.target),
		engine,
		profile: decodeProfile(record.profile),
		provenance,
		signature: decodeSignature(record.signature),
	});
}

function canonicalPayload(payload: EngineDistributionManifestPayload): string {
	return JSON.stringify(payload);
}

export function engineDistributionId(payload: EngineDistributionManifestPayload): EngineDistributionSha256 {
	const normalized = decodePayload(payload);
	return `sha256:${createHash("sha256")
		.update("breadboard-engine-distribution-v1\0")
		.update(canonicalPayload(normalized))
		.digest("hex")}`;
}

export function createEngineDistributionManifest(
	payload: EngineDistributionManifestPayload,
): EngineDistributionManifest {
	const normalized = decodePayload(payload);
	return Object.freeze({
		schemaVersion: ENGINE_DISTRIBUTION_MANIFEST_SCHEMA,
		distributionId: engineDistributionId(normalized),
		...normalized,
	});
}

function decodeManifest(value: unknown): EngineDistributionManifest {
	const record = expectRecord(value, [
		"schemaVersion",
		"distributionId",
		"productVersion",
		"pathStrategy",
		"target",
		"engine",
		"profile",
		"provenance",
		"signature",
	]);
	if (record.schemaVersion !== ENGINE_DISTRIBUTION_MANIFEST_SCHEMA) fail("engine_manifest_invalid");
	const payload = decodePayload({
		productVersion: record.productVersion,
		pathStrategy: record.pathStrategy,
		target: record.target,
		engine: record.engine,
		profile: record.profile,
		provenance: record.provenance,
		signature: record.signature,
	});
	const distributionId = expectSha256(record.distributionId);
	if (distributionId !== engineDistributionId(payload)) fail("engine_manifest_invalid");
	return Object.freeze({
		schemaVersion: ENGINE_DISTRIBUTION_MANIFEST_SCHEMA,
		distributionId,
		...payload,
	});
}

export function canonicalEngineDistributionManifest(manifest: EngineDistributionManifest): string {
	return `${JSON.stringify(decodeManifest(manifest))}\n`;
}

type InterfaceVersion = readonly [number, number, number];

function parseInterfaceVersion(version: string): InterfaceVersion | undefined {
	if (!INTERFACE_VERSION.test(version)) return undefined;
	const parts = version.split(".").map(Number);
	if (parts.length !== 3) return undefined;
	const major = parts[0];
	const minor = parts[1];
	const patch = parts[2];
	if (
		major === undefined ||
		minor === undefined ||
		patch === undefined ||
		![major, minor, patch].every(Number.isSafeInteger)
	) {
		return undefined;
	}
	return [major, minor, patch];
}

function parseInterfaceRange(range: string): readonly [InterfaceVersion, InterfaceVersion] | undefined {
	const match = INTERFACE_RANGE.exec(range);
	if (!match) return undefined;
	const lower = parseInterfaceVersion(`${match[1]}.${match[2]}.${match[3]}`);
	const upper = parseInterfaceVersion(`${match[4]}.${match[5]}.${match[6]}`);
	if (!lower || !upper || compareVersion(lower, upper) >= 0) return undefined;
	return [lower, upper];
}

function expectInterfaceRange(value: unknown): string {
	const range = expectString(value, INTERFACE_RANGE);
	if (!parseInterfaceRange(range)) fail("engine_manifest_invalid");
	return range;
}

function compareVersion(left: InterfaceVersion, right: InterfaceVersion): number {
	for (let index = 0; index < 3; index++) {
		const difference = left[index] - right[index];
		if (difference !== 0) return difference;
	}
	return 0;
}

export function interfaceRangeContains(range: string, version: string): boolean {
	const bounds = parseInterfaceRange(range);
	const actual = parseInterfaceVersion(version);
	if (!bounds || !actual) return false;
	const [lower, upper] = bounds;
	return compareVersion(actual, lower) >= 0 && compareVersion(actual, upper) < 0;
}

function decodeTrustRoot(value: unknown): EngineDistributionTrustRoot {
	const record = expectRecord(value, [
		"schemaVersion",
		"expectedManifestSha256",
		"productVersion",
		"target",
		"interfaceRange",
		"profile",
		"signature",
	]);
	if (record.schemaVersion !== ENGINE_DISTRIBUTION_TRUST_SCHEMA) fail("engine_manifest_invalid");
	const profile = expectRecord(record.profile, ["profileId", "effectiveLockSha256"]);
	const target = decodeTarget(record.target);
	if (
		target.platform !== INSTALLED_ENGINE_SUPPORTED_TARGET.platform ||
		target.architecture !== INSTALLED_ENGINE_SUPPORTED_TARGET.architecture
	) {
		fail("engine_target_mismatch");
	}
	return Object.freeze({
		schemaVersion: ENGINE_DISTRIBUTION_TRUST_SCHEMA,
		expectedManifestSha256: expectSha256(record.expectedManifestSha256),
		productVersion: expectString(record.productVersion, PRODUCT_VERSION),
		target,
		interfaceRange: expectInterfaceRange(record.interfaceRange),
		profile: Object.freeze({
			profileId: expectString(profile.profileId, PROFILE_ID),
			effectiveLockSha256: expectSha256(profile.effectiveLockSha256),
		}),
		signature: decodeSignatureTrust(record.signature),
	});
}

/**
 * The pinned manifest digest establishes D1 manifest trust. D2 must hash and cryptographically verify the detached
 * envelope bytes before treating release provenance as verified.
 */
function signatureMatchesTrust(
	signature: EngineDistributionSignature,
	trust: EngineDistributionSignatureTrust,
): boolean {
	if (signature.kind === "unsigned-development") return trust.kind === "unsigned-development";
	return trust.kind === "release-envelope" && signature.keyId === trust.keyId;
}

export function parseTrustedEngineDistributionManifest(
	input: string | Uint8Array,
	trustRoot: EngineDistributionTrustRoot,
): EngineDistributionManifest {
	const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
	if (bytes.byteLength === 0 || bytes.byteLength > ENGINE_DISTRIBUTION_MAX_MANIFEST_BYTES)
		fail("engine_manifest_invalid");
	const trust = decodeTrustRoot(trustRoot);
	const actualManifestSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	if (actualManifestSha256 !== trust.expectedManifestSha256) fail("engine_manifest_untrusted");

	let text: string;
	let value: unknown;
	try {
		text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
		value = JSON.parse(text);
	} catch {
		return fail("engine_manifest_invalid");
	}
	const manifest = decodeManifest(value);
	if (text !== canonicalEngineDistributionManifest(manifest)) fail("engine_manifest_invalid");
	if (
		manifest.target.platform !== trust.target.platform ||
		manifest.target.architecture !== trust.target.architecture
	) {
		fail("engine_target_mismatch");
	}
	if (
		manifest.engine.interfaceRange !== trust.interfaceRange ||
		!interfaceRangeContains(trust.interfaceRange, manifest.engine.interfaceVersion)
	) {
		fail("engine_interface_mismatch");
	}
	if (manifest.productVersion !== trust.productVersion) fail("engine_product_mismatch");
	if (
		manifest.profile.profileId !== trust.profile.profileId ||
		manifest.profile.effectiveLockSha256 !== trust.profile.effectiveLockSha256
	) {
		fail("engine_profile_mismatch");
	}
	if (!signatureMatchesTrust(manifest.signature, trust.signature)) fail("engine_signature_untrusted");
	return manifest;
}

/** The bundled layout is `<canonical bb directory>/engine/<manifest>`, with no startup network lookup. */
export function installedEngineManifestPath(
	productExecutablePath: string,
	canonicalize: (path: string) => string = realpathSync,
): string {
	if (!isAbsolute(productExecutablePath) || productExecutablePath.includes("\0")) {
		fail("engine_manifest_unavailable");
	}
	let executable: string;
	try {
		executable = canonicalize(productExecutablePath);
	} catch {
		return fail("engine_manifest_unavailable");
	}
	if (!isAbsolute(executable) || executable.includes("\0")) fail("engine_manifest_unavailable");
	return resolve(dirname(executable), ENGINE_DISTRIBUTION_DIRECTORY, ENGINE_DISTRIBUTION_MANIFEST_FILENAME);
}

export function resolveInstalledEngineBundlePath(
	manifestPath: string,
	manifest: EngineDistributionManifest,
	canonicalize: (path: string) => string = realpathSync,
): string {
	if (!isAbsolute(manifestPath) || manifestPath.includes("\0")) fail("engine_manifest_invalid");
	let root: string;
	let bundle: string;
	try {
		root = canonicalize(dirname(manifestPath));
		bundle = canonicalize(resolve(root, manifest.engine.runtimeBundle.path));
	} catch {
		return fail("engine_artifact_unavailable");
	}
	if (!isAbsolute(root) || !isAbsolute(bundle) || root.includes("\0") || bundle.includes("\0")) {
		fail("engine_artifact_mismatch");
	}
	const child = relative(root, bundle);
	if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		fail("engine_artifact_mismatch");
	}
	return bundle;
}
