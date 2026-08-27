import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removePrivateEngineRuntimeTree } from "./engine-runtime-bundle";
import { LocalAuthorityStore } from "./local-authority-store";
import { RuntimeCleanupStore, RuntimeCleanupStoreError, type RuntimeCleanupStoreSeams } from "./runtime-cleanup-store";

const roots: string[] = [];
const identity = {
	launchId: "l".repeat(43),
	pid: 4242,
	startToken: "darwin:4242:1",
};

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function cleanupStore(
	root: string,
	stateRootRelativePath = "engine-state",
	seams: RuntimeCleanupStoreSeams = {},
): RuntimeCleanupStore {
	const authority = new LocalAuthorityStore(root);
	return new RuntimeCleanupStore(
		{
			stateRootPath: join(root, stateRootRelativePath),
			ensure: relativePath =>
				authority.ensurePrivateDirectory(
					relativePath === undefined ? stateRootRelativePath : join(stateRootRelativePath, relativePath),
				),
		},
		seams,
	);
}

async function fixture(seams: RuntimeCleanupStoreSeams = {}): Promise<{
	readonly store: RuntimeCleanupStore;
	readonly engineRoot: string;
	readonly rayRoot: string;
	readonly recordPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "bb-runtime-cleanup-store-"));
	const engineRoot = await mkdtemp(join(tmpdir(), "bb-engine-runtime-"));
	const rayRoot = await mkdtemp(join(tmpdir(), "bb-ray-"));
	roots.push(root, engineRoot, rayRoot);
	await chmod(engineRoot, 0o500);
	await chmod(rayRoot, 0o700);
	const store = cleanupStore(root, "engine-state", seams);
	const stateRoot = await store.stateRoot();
	if (stateRoot === undefined) throw new Error("expected configured state root");
	return {
		store,
		engineRoot,
		rayRoot,
		recordPath: join(stateRoot, "runtime-cleanup", `${identity.launchId}.json`),
	};
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => removePrivateEngineRuntimeTree(root)));
});

describe("RuntimeCleanupStore", () => {
	test("rejects a symlinked engine-state root before canonicalization", async () => {
		const parent = await mkdtemp(join(tmpdir(), "bb-runtime-cleanup-state-parent-"));
		const target = await mkdtemp(join(tmpdir(), "bb-runtime-cleanup-state-target-"));
		roots.push(parent, target);
		await writeFile(join(target, "unrelated"), "retain");
		await symlink(target, join(parent, "engine-state"));
		const store = cleanupStore(parent);

		const error = await store.stateRoot().catch(cause => cause);
		expect(error).toBeInstanceOf(RuntimeCleanupStoreError);
		expect((error as RuntimeCleanupStoreError).code).toBe("root_integrity");
		expect(await Bun.file(join(target, "unrelated")).text()).toBe("retain");
	});

	test("rejects an intermediate engine-state symlink without creating outside the authority root", async () => {
		const root = await mkdtemp(join(tmpdir(), "bb-runtime-cleanup-state-root-"));
		const target = await mkdtemp(join(tmpdir(), "bb-runtime-cleanup-state-target-"));
		roots.push(root, target);
		await writeFile(join(target, "unrelated"), "retain");
		await symlink(target, join(root, "engine-state"));
		const store = cleanupStore(root, join("engine-state", "endpoint"));

		const error = await store.stateRoot().catch(cause => cause);
		expect(error).toBeInstanceOf(RuntimeCleanupStoreError);
		expect((error as RuntimeCleanupStoreError).code).toBe("root_integrity");
		expect(await exists(join(target, "endpoint"))).toBeFalse();
		expect(await Bun.file(join(target, "unrelated")).text()).toBe("retain");
	});

	test("durably binds bundle and Ray roots to one process identity and removes them after exit", async () => {
		const { store, engineRoot, rayRoot, recordPath } = await fixture();
		expect(await store.persist(identity, engineRoot, rayRoot)).toBeTrue();
		expect((await lstat(recordPath)).mode & 0o777).toBe(0o600);

		expect(await store.remove(identity)).toBeTrue();
		expect(await exists(engineRoot)).toBeFalse();
		expect(await exists(rayRoot)).toBeFalse();
		expect(await exists(recordPath)).toBeFalse();
	});

	test("tracks detached direct-engine Ray cleanup without an extraction root", async () => {
		const { store, rayRoot, recordPath } = await fixture();
		expect(await store.persist(identity, undefined, rayRoot)).toBeTrue();

		expect(await store.remove(identity)).toBeTrue();
		expect(await exists(rayRoot)).toBeFalse();
		expect(await exists(recordPath)).toBeFalse();
	});

	test("reports when no durable cleanup record exists", async () => {
		const { store } = await fixture();
		expect(await store.remove(identity)).toBeFalse();
	});

	test("removes only deterministic launch roots when a prepared start has no cleanup record", async () => {
		const root = await mkdtemp(join(tmpdir(), "bb-runtime-cleanup-prepared-"));
		roots.push(root);
		const store = cleanupStore(root);
		const launchId = "p".repeat(43);
		const temporaryRoot = await realpath(tmpdir());
		const launchRoots = [
			join(temporaryRoot, `bb-engine-runtime-${launchId}`),
			join(temporaryRoot, `bb-ray-${launchId}`),
			join(temporaryRoot, `omp-engine-snapshot-${launchId}`),
		];
		const unrelated = join(temporaryRoot, `bb-ray-${"u".repeat(43)}`);
		roots.push(...launchRoots, unrelated);
		for (const launchRoot of [...launchRoots, unrelated]) {
			await mkdir(launchRoot, { mode: 0o700 });
			await writeFile(join(launchRoot, "owned"), "retain");
		}

		await store.removePrepared(launchId);

		for (const launchRoot of launchRoots) expect(await exists(launchRoot)).toBeFalse();
		expect(await readFile(join(unrelated, "owned"), "utf8")).toBe("retain");
	});

	test("rejects a prepared-root symlink without blocking cleanup of other exact roots", async () => {
		const root = await mkdtemp(join(tmpdir(), "bb-runtime-cleanup-prepared-link-"));
		const target = await mkdtemp(join(tmpdir(), "bb-runtime-cleanup-prepared-target-"));
		roots.push(root, target);
		const store = cleanupStore(root);
		const launchId = "s".repeat(43);
		const temporaryRoot = await realpath(tmpdir());
		const engineRoot = join(temporaryRoot, `bb-engine-runtime-${launchId}`);
		const rayRoot = join(temporaryRoot, `bb-ray-${launchId}`);
		roots.push(engineRoot);
		await mkdir(engineRoot, { mode: 0o700 });
		await writeFile(join(target, "unrelated"), "retain");
		await symlink(target, rayRoot);
		try {
			await expect(store.removePrepared(launchId)).rejects.toBeInstanceOf(RuntimeCleanupStoreError);
			expect(await exists(engineRoot)).toBeFalse();
			expect(await readFile(join(target, "unrelated"), "utf8")).toBe("retain");
			expect((await lstat(rayRoot)).isSymbolicLink()).toBeTrue();
		} finally {
			await unlink(rayRoot);
		}
	});

	test("maps an exclusive record-open failure to one typed persistence error", async () => {
		const { store, engineRoot, rayRoot, recordPath } = await fixture();
		expect(await store.remove(identity)).toBeFalse();
		await mkdir(recordPath, { mode: 0o700 });

		const error = await store.persist(identity, engineRoot, rayRoot).catch(cause => cause);
		expect(error).toBeInstanceOf(RuntimeCleanupStoreError);
		expect((error as RuntimeCleanupStoreError).code).toBe("root_integrity");
		expect(await exists(engineRoot)).toBeTrue();
		expect(await exists(rayRoot)).toBeTrue();
		expect(await exists(recordPath)).toBeTrue();
	});

	test("unlinks an incomplete record after a typed write failure", async () => {
		const { store, engineRoot, rayRoot, recordPath } = await fixture({
			writeRecord: async () => {
				throw new Error("synthetic record write failure");
			},
		});

		const error = await store.persist(identity, engineRoot, rayRoot).catch(cause => cause);
		expect(error).toBeInstanceOf(RuntimeCleanupStoreError);
		expect((error as RuntimeCleanupStoreError).code).toBe("root_integrity");
		expect(await exists(recordPath)).toBeFalse();
		expect(await exists(engineRoot)).toBeTrue();
		expect(await exists(rayRoot)).toBeTrue();
	});

	test("unlinks a complete record when its file sync rejects", async () => {
		const { store, engineRoot, rayRoot, recordPath } = await fixture({
			syncRecord: async () => {
				throw new Error("synthetic record sync failure");
			},
		});

		const error = await store.persist(identity, engineRoot, rayRoot).catch(cause => cause);
		expect(error).toBeInstanceOf(RuntimeCleanupStoreError);
		expect((error as RuntimeCleanupStoreError).code).toBe("root_integrity");
		expect(await exists(recordPath)).toBeFalse();
		expect(await exists(engineRoot)).toBeTrue();
		expect(await exists(rayRoot)).toBeTrue();
	});

	test("leaves a valid record discoverable when parent-directory sync rejects", async () => {
		let rejectParentSync = true;
		const { store, engineRoot, rayRoot, recordPath } = await fixture({
			syncParent: async handle => {
				if (rejectParentSync) throw new Error("synthetic parent sync failure");
				await handle.sync();
			},
		});

		const error = await store.persist(identity, engineRoot, rayRoot).catch(cause => cause);
		expect(error).toBeInstanceOf(RuntimeCleanupStoreError);
		expect((error as RuntimeCleanupStoreError).code).toBe("root_integrity");
		expect(await exists(recordPath)).toBeTrue();
		expect(await exists(engineRoot)).toBeTrue();
		expect(await exists(rayRoot)).toBeTrue();

		rejectParentSync = false;
		expect(await store.remove(identity)).toBeTrue();
		expect(await exists(recordPath)).toBeFalse();
		expect(await exists(engineRoot)).toBeFalse();
		expect(await exists(rayRoot)).toBeFalse();
	});

	test("fails closed on process identity drift and retains cleanup authority", async () => {
		const { store, engineRoot, rayRoot, recordPath } = await fixture();
		await store.persist(identity, engineRoot, rayRoot);

		await expect(store.remove({ ...identity, pid: identity.pid + 1 })).rejects.toBeInstanceOf(
			RuntimeCleanupStoreError,
		);
		expect(await exists(engineRoot)).toBeTrue();
		expect(await exists(rayRoot)).toBeTrue();
		expect(await exists(recordPath)).toBeTrue();

		await store.remove(identity);
	});

	test("maps a truncated durable record to one typed integrity failure", async () => {
		const { store, engineRoot, rayRoot, recordPath } = await fixture();
		await store.persist(identity, engineRoot, rayRoot);
		await writeFile(recordPath, "{\n", "utf8");

		const error = await store.remove(identity).catch(cause => cause);
		expect(error).toBeInstanceOf(RuntimeCleanupStoreError);
		expect((error as RuntimeCleanupStoreError).code).toBe("root_integrity");
		expect((error as RuntimeCleanupStoreError).cause).toMatchObject({ name: "SyntaxError" });
		expect(await exists(engineRoot)).toBeTrue();
		expect(await exists(rayRoot)).toBeTrue();
		expect(await exists(recordPath)).toBeTrue();
	});

	test("fails closed when a tracked runtime directory inode is replaced", async () => {
		const { store, engineRoot, rayRoot, recordPath } = await fixture();
		await store.persist(identity, engineRoot, rayRoot);
		const displaced = `${engineRoot}-displaced`;
		roots.push(displaced);
		await rename(engineRoot, displaced);
		await mkdir(engineRoot, { mode: 0o500 });

		await expect(store.remove(identity)).rejects.toBeInstanceOf(RuntimeCleanupStoreError);
		expect(await exists(engineRoot)).toBeTrue();
		expect(await exists(displaced)).toBeTrue();
		expect(await exists(rayRoot)).toBeTrue();
		expect(await exists(recordPath)).toBeTrue();
	});

	test("rejects a cleanup record that rebinds Ray cleanup to the engine-root namespace", async () => {
		const { store, engineRoot, rayRoot, recordPath } = await fixture();
		await store.persist(identity, engineRoot, rayRoot);
		const wrongKindRoot = await mkdtemp(join(tmpdir(), "bb-engine-runtime-"));
		roots.push(wrongKindRoot);
		const wrongKindMetadata = await lstat(wrongKindRoot);
		const record = JSON.parse(await readFile(recordPath, "utf8")) as {
			rayRuntime: { path: string; device: number; inode: number };
		};
		record.rayRuntime = {
			path: await realpath(wrongKindRoot),
			device: wrongKindMetadata.dev,
			inode: wrongKindMetadata.ino,
		};
		await writeFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");

		await expect(store.remove(identity)).rejects.toBeInstanceOf(RuntimeCleanupStoreError);
		expect(await exists(engineRoot)).toBeTrue();
		expect(await exists(rayRoot)).toBeTrue();
		expect(await exists(wrongKindRoot)).toBeTrue();
		expect(await exists(recordPath)).toBeTrue();
	});
	test("resumes cleanup after a persisted root was already quarantined", async () => {
		const { store, engineRoot, rayRoot, recordPath } = await fixture();
		await store.persist(identity, engineRoot, rayRoot);
		const quarantineRoot = join(
			await realpath(tmpdir()),
			`bb-runtime-cleanup-quarantine-${process.geteuid?.() ?? process.getuid?.() ?? -1}`,
		);
		const quarantined = join(quarantineRoot, `${identity.launchId}.${identity.pid}.engine`);
		await mkdir(quarantineRoot, { mode: 0o700 });
		await chmod(engineRoot, 0o700);
		await rename(engineRoot, quarantined);

		await store.remove(identity);
		expect(await exists(quarantined)).toBeFalse();
		expect(await exists(rayRoot)).toBeFalse();
		expect(await exists(recordPath)).toBeFalse();
	});

	test("rejects roots outside the canonical temporary-root scope before persisting authority", async () => {
		const { store, rayRoot, recordPath } = await fixture();
		const parent = await mkdtemp(join(tmpdir(), "bb-runtime-cleanup-parent-"));
		roots.push(parent);
		const nested = await mkdtemp(join(parent, "bb-engine-runtime-"));

		await expect(store.persist(identity, nested, rayRoot)).rejects.toBeInstanceOf(RuntimeCleanupStoreError);
		expect(await exists(recordPath)).toBeFalse();
		expect(await exists(nested)).toBeTrue();
	});

	test("does not claim durable cleanup without a configured state root", async () => {
		const store = new RuntimeCleanupStore();
		expect(await store.persist(identity, undefined, "/tmp/bb-ray-unclaimed")).toBeFalse();
		expect(await store.stateRoot()).toBeUndefined();
	});
});
