import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEngineRuntimeBundle,
	EngineRuntimeBundleError,
	extractVerifiedEngineRuntimeBundle,
	sha256File,
} from "./engine-runtime-bundle";

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	temporaryRoots.push(root);
	return root;
}

afterAll(async () => {
	await Promise.all(temporaryRoots.map(root => rm(root, { recursive: true, force: true })));
});

async function createRuntimeSource(root: string): Promise<string> {
	await mkdir(join(root, "_internal", "breadboard_engine"), { recursive: true });
	const executablePath = join(root, "breadboard-engine");
	await Bun.write(executablePath, "#!/bin/sh\nexit 0\n");
	await chmod(executablePath, 0o755);
	await Bun.write(join(root, "_internal", "breadboard_engine", "runtime.py"), "ENGINE = 'breadboard'\n");
	await Bun.write(join(root, "_internal", "empty.data"), "");
	await Bun.write(join(root, "_internal", "Lorem ipsum.txt"), "packaged runtime data\n");
	return executablePath;
}

async function bundleError(run: () => Promise<unknown>): Promise<EngineRuntimeBundleError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof EngineRuntimeBundleError) return error;
		throw error;
	}
	throw new Error("expected EngineRuntimeBundleError");
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("engine runtime bundle", () => {
	test("creates deterministic actual-byte bundles and extracts one read-only runtime", async () => {
		const tempDir = await temporaryRoot("breadboard-engine-bundle-");
		const sourceRoot = join(tempDir, "source");
		await createRuntimeSource(sourceRoot);
		const first = await createEngineRuntimeBundle({
			sourceRoot,
			executablePath: "breadboard-engine",
			outputPath: join(tempDir, "first.bundle"),
		});
		const second = await createEngineRuntimeBundle({
			sourceRoot,
			executablePath: "breadboard-engine",
			outputPath: join(tempDir, "second.bundle"),
		});

		expect(first.bundle.sha256).toBe(second.bundle.sha256);
		expect(await readFile(first.bundle.path)).toEqual(await readFile(second.bundle.path));
		expect(first.executableSha256).toBe(await sha256File(join(sourceRoot, "breadboard-engine")));

		const extracted = await extractVerifiedEngineRuntimeBundle({
			bundle: first.bundle,
			executablePath: first.executablePath,
			executableSizeBytes: first.executableSizeBytes,
			executableSha256: first.executableSha256,
		});
		const extractedRoot = extracted.rootPath;
		expect(await readFile(extracted.executablePath, "utf8")).toBe("#!/bin/sh\nexit 0\n");
		expect((await stat(extracted.executablePath)).mode & 0o777).toBe(0o500);
		expect((await stat(join(extracted.rootPath, "_internal", "breadboard_engine", "runtime.py"))).mode & 0o777).toBe(
			0o400,
		);
		expect(extracted.executableBytes).toEqual(await readFile(extracted.executablePath));
		await extracted.cleanup();
		expect(await Bun.file(extractedRoot).exists()).toBe(false);
	});

	test("extracts into one exact launch-scoped runtime root", async () => {
		const tempDir = await temporaryRoot("breadboard-engine-bundle-launch-");
		const sourceRoot = join(tempDir, "source");
		await createRuntimeSource(sourceRoot);
		const created = await createEngineRuntimeBundle({
			sourceRoot,
			executablePath: "breadboard-engine",
			outputPath: join(tempDir, "engine.bundle"),
		});
		const runtimeRootPath = join(await realpath(tmpdir()), `bb-engine-runtime-${"b".repeat(43)}`);
		temporaryRoots.push(runtimeRootPath);

		const extracted = await extractVerifiedEngineRuntimeBundle({
			bundle: created.bundle,
			executablePath: created.executablePath,
			executableSizeBytes: created.executableSizeBytes,
			executableSha256: created.executableSha256,
			runtimeRootPath,
		});

		expect(extracted.rootPath).toBe(runtimeRootPath);
		await extracted.cleanup();
		expect(await Bun.file(runtimeRootPath).exists()).toBeFalse();
	});

	test("rejects tampered and partial bundles before extraction succeeds", async () => {
		const tempDir = await temporaryRoot("breadboard-engine-bundle-tamper-");
		const sourceRoot = join(tempDir, "source");
		await createRuntimeSource(sourceRoot);
		const created = await createEngineRuntimeBundle({
			sourceRoot,
			executablePath: "breadboard-engine",
			outputPath: join(tempDir, "engine.bundle"),
		});
		const original = await readFile(created.bundle.path);
		const tampered = Buffer.from(original);
		tampered[tampered.length - 1] ^= 0xff;
		await chmod(created.bundle.path, 0o600);
		await Bun.write(created.bundle.path, tampered);
		await chmod(created.bundle.path, 0o400);

		expect(
			(
				await bundleError(() =>
					extractVerifiedEngineRuntimeBundle({
						bundle: created.bundle,
						executablePath: created.executablePath,
						executableSizeBytes: created.executableSizeBytes,
						executableSha256: created.executableSha256,
					}),
				)
			).code,
		).toBe("bundle_mismatch");

		const partial = original.subarray(0, original.length - 1);
		await chmod(created.bundle.path, 0o600);
		await Bun.write(created.bundle.path, partial);
		await chmod(created.bundle.path, 0o400);
		const partialReference = {
			...created.bundle,
			sizeBytes: partial.byteLength,
			sha256: sha256(partial),
		};
		expect(
			(
				await bundleError(() =>
					extractVerifiedEngineRuntimeBundle({
						bundle: partialReference,
						executablePath: created.executablePath,
						executableSizeBytes: created.executableSizeBytes,
						executableSha256: created.executableSha256,
					}),
				)
			).code,
		).toBe("bundle_invalid");
	});

	test("refuses symlinked or unsafe source payloads", async () => {
		const tempDir = await temporaryRoot("breadboard-engine-bundle-source-");
		const sourceRoot = join(tempDir, "source");
		await createRuntimeSource(sourceRoot);
		await symlink("runtime.py", join(sourceRoot, "_internal", "breadboard_engine", "runtime-link.py"));
		expect(
			(
				await bundleError(() =>
					createEngineRuntimeBundle({
						sourceRoot,
						executablePath: "breadboard-engine",
						outputPath: join(tempDir, "symlink.bundle"),
					}),
				)
			).code,
		).toBe("bundle_source_invalid");
		await unlink(join(sourceRoot, "_internal", "breadboard_engine", "runtime-link.py"));

		await Bun.write(join(sourceRoot, "unsafe#name"), "untrusted");
		expect(
			(
				await bundleError(() =>
					createEngineRuntimeBundle({
						sourceRoot,
						executablePath: "breadboard-engine",
						outputPath: join(tempDir, "unsafe.bundle"),
					}),
				)
			).code,
		).toBe("bundle_invalid");
	});
});
