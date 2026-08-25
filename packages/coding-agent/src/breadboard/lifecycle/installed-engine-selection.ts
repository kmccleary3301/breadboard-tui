import { dirname } from "node:path";
import {
	createInstalledEngineIdentity,
	ENGINE_DISTRIBUTION_MANIFEST_FILENAME,
	ENGINE_DISTRIBUTION_MAX_MANIFEST_BYTES,
	type EngineDistributionManifest,
	type EngineDistributionTrustRoot,
	InstalledEngineDiscoveryError,
	type InstalledEngineIdentity,
	installedEngineManifestPath,
	parseTrustedEngineDistributionManifest,
	resolveInstalledEngineBundlePath,
} from "./installed-engine-manifest";
import { openPinnedDirectory, type PinnedDirectory, type PinnedFile, type PinnedStat } from "./pinned-directory";

declare const __BREADBOARD_ENGINE_TRUST_ROOT_JSON__: string | undefined;

export interface InstalledEngineArtifactInput {
	readonly kind: "runtime-bundle";
	readonly runtimeBundle: {
		readonly schemaVersion: "bb.engine_runtime_bundle.v1";
		readonly path: string;
		readonly sizeBytes: number;
		readonly sha256: `sha256:${string}`;
	};
	readonly executablePath: string;
	readonly executableSizeBytes: number;
	readonly argv: readonly string[];
	readonly executableSha256: `sha256:${string}`;
	readonly engineSourceSha256: `sha256:${string}`;
	readonly servedBackendCommit: string;
}

export interface InstalledEngineSelection {
	readonly artifact: InstalledEngineArtifactInput;
	readonly manifest: EngineDistributionManifest;
	readonly identity: InstalledEngineIdentity;
	readonly manifestPath: string;
}

function discoveryFailure(code: ConstructorParameters<typeof InstalledEngineDiscoveryError>[0]): never {
	throw new InstalledEngineDiscoveryError(code);
}
function mapDiscoveryFailure(
	error: unknown,
	code: ConstructorParameters<typeof InstalledEngineDiscoveryError>[0],
): never {
	if (error instanceof InstalledEngineDiscoveryError) throw error;
	discoveryFailure(code);
}

function expectSealedDirectory(metadata: PinnedStat): void {
	if (metadata.type !== "directory" || (metadata.mode & 0o777) !== 0o500) {
		discoveryFailure("engine_manifest_untrusted");
	}
}

function expectSealedFile(
	metadata: PinnedStat,
	sizeBytes: number,
	code: "engine_manifest_untrusted" | "engine_artifact_mismatch",
): void {
	if (metadata.type !== "regular" || metadata.size !== BigInt(sizeBytes) || (metadata.mode & 0o777) !== 0o400) {
		discoveryFailure(code);
	}
}

async function openManifest(
	directory: PinnedDirectory,
): Promise<{ readonly file: PinnedFile; readonly bytes: Buffer }> {
	let file: PinnedFile;
	try {
		file = await directory.openFile(ENGINE_DISTRIBUTION_MANIFEST_FILENAME);
	} catch {
		discoveryFailure("engine_manifest_unavailable");
	}
	try {
		const metadata = await file.stat();
		if (
			metadata.type !== "regular" ||
			metadata.size <= 0n ||
			metadata.size > BigInt(ENGINE_DISTRIBUTION_MAX_MANIFEST_BYTES)
		) {
			discoveryFailure("engine_manifest_invalid");
		}
		expectSealedFile(metadata, Number(metadata.size), "engine_manifest_untrusted");
		return { file, bytes: await file.read(ENGINE_DISTRIBUTION_MAX_MANIFEST_BYTES) };
	} catch (error) {
		await file.close().catch(() => undefined);
		mapDiscoveryFailure(error, "engine_manifest_unavailable");
	}
}

async function verifyBundleIdentity(directory: PinnedDirectory, manifest: EngineDistributionManifest): Promise<void> {
	let file: PinnedFile;
	try {
		file = await directory.openFile(manifest.engine.runtimeBundle.path);
	} catch {
		discoveryFailure("engine_artifact_unavailable");
	}
	try {
		expectSealedFile(await file.stat(), manifest.engine.runtimeBundle.sizeBytes, "engine_artifact_mismatch");
	} catch (error) {
		mapDiscoveryFailure(error, "engine_artifact_unavailable");
	} finally {
		await file.close().catch(() => undefined);
	}
}

export function compiledInstalledEngineTrustRoot(): EngineDistributionTrustRoot | undefined {
	const encoded =
		typeof __BREADBOARD_ENGINE_TRUST_ROOT_JSON__ === "undefined" ? undefined : __BREADBOARD_ENGINE_TRUST_ROOT_JSON__;
	if (encoded === undefined) return undefined;
	try {
		return JSON.parse(encoded) as EngineDistributionTrustRoot;
	} catch {
		discoveryFailure("engine_manifest_untrusted");
	}
}

export async function resolveInstalledEngineSelection(input: {
	readonly productExecutablePath: string;
	readonly trustRoot: EngineDistributionTrustRoot | undefined;
}): Promise<InstalledEngineSelection> {
	if (input.trustRoot === undefined) discoveryFailure("engine_manifest_untrusted");
	const manifestPath = installedEngineManifestPath(input.productExecutablePath, input.trustRoot);
	let directory: PinnedDirectory;
	try {
		directory = await openPinnedDirectory(dirname(manifestPath));
	} catch {
		discoveryFailure("engine_manifest_unavailable");
	}
	try {
		expectSealedDirectory(await directory.stat());
		const opened = await openManifest(directory);
		let manifest: EngineDistributionManifest;
		try {
			manifest = parseTrustedEngineDistributionManifest(opened.bytes, input.trustRoot);
		} finally {
			await opened.file.close().catch(() => undefined);
		}
		await verifyBundleIdentity(directory, manifest);
		const bundlePath = resolveInstalledEngineBundlePath(manifestPath, manifest);
		const artifact: InstalledEngineArtifactInput = Object.freeze({
			kind: "runtime-bundle",
			runtimeBundle: Object.freeze({
				schemaVersion: manifest.engine.runtimeBundle.schemaVersion,
				path: bundlePath,
				sizeBytes: manifest.engine.runtimeBundle.sizeBytes,
				sha256: manifest.engine.runtimeBundle.sha256,
			}),
			executablePath: manifest.engine.executablePath,
			executableSizeBytes: manifest.engine.executableSizeBytes,
			argv: Object.freeze([...manifest.engine.argv]),
			executableSha256: manifest.engine.executableSha256,
			engineSourceSha256: manifest.engine.engineSourceSha256,
			servedBackendCommit: manifest.engine.servedBackendCommit,
		});
		return Object.freeze({
			artifact,
			manifest,
			identity: createInstalledEngineIdentity(manifest, input.trustRoot),
			manifestPath,
		});
	} catch (error) {
		mapDiscoveryFailure(error, "engine_manifest_unavailable");
	} finally {
		await directory.close().catch(() => undefined);
	}
}

export function formatInstalledEngineDiscoveryError(error: InstalledEngineDiscoveryError): string {
	return `BreadBoard installed engine error [${error.code}]: ${error.message}\n${error.remediation}`;
}
