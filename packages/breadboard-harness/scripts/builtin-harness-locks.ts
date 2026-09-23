/**
 * Writes the lock and metadata sidecar beside each built-in harness spec under `harnesses/`.
 * Run after editing a built-in spec or its prompts: `bun scripts/builtin-harness-locks.ts`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson } from "../src/canonical-json";
import { type BuiltinNativeHarness, builtinNativeHarnesses } from "../src/native/builtin-harnesses";
import { loadNativeHarness } from "../src/native/load-native-harness";
import { nativeLockMetadataPath, nativeLockPathForSpec } from "../src/native/lock-loader";

export interface BuiltinHarnessLockFiles {
	readonly lockPath: string;
	readonly lockText: string;
	readonly metaPath: string;
	readonly metaText: string;
}

const HARNESS_ROOT = resolve(import.meta.dir, "../harnesses");

function sortedJson(value: Record<string, string>): string {
	const sorted = Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** The lock and sidecar bytes a built-in harness compiles to; the workspace root does not enter the lock. */
export async function renderBuiltinHarnessLock(harness: BuiltinNativeHarness): Promise<BuiltinHarnessLockFiles> {
	const workspace = await mkdtemp(join(tmpdir(), "bb-builtin-harness-"));
	try {
		const loaded = await loadNativeHarness({ specPath: harness.id, workspaceRoot: workspace });
		const lockPath = nativeLockPathForSpec(join(HARNESS_ROOT, harness.sourceRef));
		const sourceSha = new Bun.CryptoHasher("sha256").update(harness.source).digest("hex");
		return {
			lockPath,
			lockText: canonicalJson(loaded.lock),
			metaPath: nativeLockMetadataPath(lockPath),
			metaText: sortedJson({
				graph_hash: loaded.graphHash,
				schema_version: "bb.harness_lock_metadata.v1",
				source_ref: harness.sourceRef,
				source_sha256: `sha256:${sourceSha}`,
			}),
		};
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	for (const harness of builtinNativeHarnesses()) {
		const files = await renderBuiltinHarnessLock(harness);
		await writeFile(files.lockPath, files.lockText);
		await writeFile(files.metaPath, files.metaText);
		console.log(`${harness.id}: ${files.lockPath}`);
	}
}
