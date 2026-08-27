import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removePrivateEngineRuntimeTree } from "./engine-runtime-bundle";
import { RuntimeCleanupStore, RuntimeCleanupStoreError } from "./runtime-cleanup-store";

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

async function fixture(): Promise<{
	readonly store: RuntimeCleanupStore;
	readonly engineRoot: string;
	readonly rayRoot: string;
	readonly recordPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "bb-runtime-cleanup-store-"));
	roots.push(root);
	const engineRoot = await mkdtemp(join(root, "bb-engine-runtime-"));
	const rayRoot = await mkdtemp(join(root, "bb-ray-"));
	await chmod(engineRoot, 0o500);
	await chmod(rayRoot, 0o700);
	const store = new RuntimeCleanupStore(join(root, "engine-state"));
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
	test("durably binds bundle and Ray roots to one process identity and removes them after exit", async () => {
		const { store, engineRoot, rayRoot, recordPath } = await fixture();
		expect(await store.persist(identity, engineRoot, rayRoot)).toBeTrue();
		expect((await lstat(recordPath)).mode & 0o777).toBe(0o600);

		await store.remove(identity);
		expect(await exists(engineRoot)).toBeFalse();
		expect(await exists(rayRoot)).toBeFalse();
		expect(await exists(recordPath)).toBeFalse();
	});

	test("tracks detached direct-engine Ray cleanup without an extraction root", async () => {
		const { store, rayRoot, recordPath } = await fixture();
		expect(await store.persist(identity, undefined, rayRoot)).toBeTrue();

		await store.remove(identity);
		expect(await exists(rayRoot)).toBeFalse();
		expect(await exists(recordPath)).toBeFalse();
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

	test("does not claim durable cleanup without a configured state root", async () => {
		const store = new RuntimeCleanupStore();
		expect(await store.persist(identity, undefined, "/tmp/bb-ray-unclaimed")).toBeFalse();
		expect(await store.stateRoot()).toBeUndefined();
	});
});
