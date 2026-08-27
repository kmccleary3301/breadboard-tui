import { afterEach, describe, expect, test } from "bun:test";
import { fstatSync, watch } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DARWIN_PINNED_DIRECTORY_LIMITS,
	DarwinPinnedDirectoryError,
	openPinnedDirectory,
	openPinnedDirectoryWithMountIdentityForTesting,
	type PinnedDirectory,
} from "./darwin-pinned-directory";

const roots: string[] = [];
const handles: PinnedDirectory[] = [];

async function temporaryDirectory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "darwin-pinned-directory-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(handles.splice(0).map(async handle => await handle.close().catch(() => {})));
	await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "darwin")("Darwin pinned directory", () => {
	test("whole-root rename, substitution, and restoration cannot redirect reads or enumeration", async () => {
		const root = await temporaryDirectory();
		const parked = `${root}.parked`;
		roots.push(parked);
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(root, "nested", "original.txt"), "original dirty bytes");

		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);
		const identity = await pinned.stat();
		const descriptorStat = fstatSync(pinned.fd, { bigint: true });
		expect(identity.dev).toBe(descriptorStat.dev);
		expect(identity.ino).toBe(descriptorStat.ino);
		expect(BigInt(identity.mode)).toBe(descriptorStat.mode);
		await rename(root, parked);
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(root, "nested", "replacement.txt"), "replacement bytes");

		expect(await pinned.readFile("nested/original.txt", 64)).toEqual(Buffer.from("original dirty bytes"));
		expect(await pinned.listLeaves({ maxEntries: 8, maxPathBytes: 128 })).toEqual(["nested/original.txt"]);
		expect((await pinned.stat()).dev).toBe(identity.dev);
		expect((await pinned.stat()).ino).toBe(identity.ino);

		await rm(root, { recursive: true });
		await rename(parked, root);
		expect(await pinned.readFile("nested/original.txt", 64)).toEqual(Buffer.from("original dirty bytes"));
	});

	test("removes only one inode-bound direct-child tree through directory descriptors", async () => {
		const root = await temporaryDirectory();
		const target = join(root, "target");
		const outside = join(root, "outside.txt");
		await mkdir(join(target, "nested"), { recursive: true });
		await writeFile(join(target, "nested", "value"), "remove");
		await writeFile(outside, "retain");
		await symlink("../outside.txt", join(target, "escape"));
		await chmod(join(target, "nested"), 0o500);
		await chmod(target, 0o500);
		const targetMetadata = await lstat(target);
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);

		await pinned.removeDirectoryTree("target", {
			dev: BigInt(targetMetadata.dev),
			ino: BigInt(targetMetadata.ino),
		});
		await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await Bun.file(outside).text()).toBe("retain");
	});

	test("rejects a substituted cleanup root without deleting either tree", async () => {
		const root = await temporaryDirectory();
		const target = join(root, "target");
		const parked = join(root, "parked");
		await mkdir(target);
		await writeFile(join(target, "original"), "original");
		const targetMetadata = await lstat(target);
		await rename(target, parked);
		await mkdir(target);
		await writeFile(join(target, "replacement"), "replacement");
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);

		await expect(
			pinned.removeDirectoryTree("target", {
				dev: BigInt(targetMetadata.dev),
				ino: BigInt(targetMetadata.ino),
			}),
		).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
		expect(await Bun.file(join(parked, "original")).text()).toBe("original");
		expect(await Bun.file(join(target, "replacement")).text()).toBe("replacement");
	});

	test("rejects a simulated same-device mount before recursive mutation", async () => {
		const root = await temporaryDirectory();
		const target = join(root, "target");
		const nested = join(target, "nested");
		const outside = join(root, "outside");
		await mkdir(nested, { recursive: true });
		await mkdir(outside);
		await writeFile(join(nested, "value"), "retain");
		await writeFile(join(outside, "value"), "outside");
		await chmod(nested, 0o500);
		const targetMetadata = await lstat(target);
		const pinned = await openPinnedDirectoryWithMountIdentityForTesting(root, (_fd, relativePath, actualIdentity) =>
			relativePath === "target/nested" ? `${actualIdentity}:foreign-mount` : actualIdentity,
		);
		handles.push(pinned);

		await expect(
			pinned.removeDirectoryTree("target", {
				dev: BigInt(targetMetadata.dev),
				ino: BigInt(targetMetadata.ino),
			}),
		).rejects.toThrow("cleanup refuses to cross a mount boundary");
		expect((await lstat(nested)).mode & 0o777).toBe(0o500);
		expect(await Bun.file(join(nested, "value")).text()).toBe("retain");
		expect(await Bun.file(join(outside, "value")).text()).toBe("outside");
		await chmod(nested, 0o700);
	});

	test("rejects a simulated same-device mount replacement after traversal", async () => {
		const root = await temporaryDirectory();
		const target = join(root, "target");
		const nested = join(target, "nested");
		const outside = join(root, "outside");
		await mkdir(nested, { recursive: true });
		await mkdir(outside);
		await writeFile(join(nested, "value"), "remove-before-race");
		await writeFile(join(outside, "value"), "outside");
		const targetMetadata = await lstat(target);
		let nestedMountObservations = 0;
		const pinned = await openPinnedDirectoryWithMountIdentityForTesting(root, (_fd, relativePath, actualIdentity) => {
			if (relativePath !== "target/nested") return actualIdentity;
			nestedMountObservations += 1;
			return nestedMountObservations === 1 ? actualIdentity : `${actualIdentity}:replacement-mount`;
		});
		handles.push(pinned);

		await expect(
			pinned.removeDirectoryTree("target", {
				dev: BigInt(targetMetadata.dev),
				ino: BigInt(targetMetadata.ino),
			}),
		).rejects.toThrow("cleanup refuses to cross a mount boundary");
		expect(nestedMountObservations).toBe(2);
		expect((await lstat(nested)).isDirectory()).toBeTrue();
		await expect(lstat(join(nested, "value"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await Bun.file(join(outside, "value")).text()).toBe("outside");
	});

	test("fails closed when the cleanup root name is replaced after descriptor traversal starts", async () => {
		const root = await temporaryDirectory();
		const target = join(root, "target");
		const parked = join(root, "parked");
		const ready = join(root, "attacker-ready");
		const work = join(target, "zzz-work");
		await mkdir(work, { recursive: true });
		await writeFile(join(target, "000-marker"), "marker");
		for (let batch = 0; batch < 16; batch += 1) {
			await Promise.all(
				Array.from({ length: 128 }, async (_, index) => {
					await writeFile(join(work, `${batch}-${index}`), "");
				}),
			);
		}
		const targetMetadata = await lstat(target);
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);
		// An external process must race native syscalls here; fake timers cannot drive this boundary.
		const readySignal = Promise.withResolvers<void>();
		const readyWatcher = watch(root, (_event, filename) => {
			if (filename?.toString() === "attacker-ready") readySignal.resolve();
		});
		const attacker = Bun.spawn([
			process.execPath,
			"-e",
			`import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [target, parked, ready] = process.argv.slice(1);
writeFileSync(ready, "ready");
const marker = join(target, "000-marker");
const deadline = Date.now() + 10_000;
while (existsSync(marker) && Date.now() < deadline) {}
if (existsSync(marker)) process.exit(2);
renameSync(target, parked);
mkdirSync(target);
writeFileSync(join(target, "replacement"), "replacement");`,
			target,
			parked,
			ready,
		]);
		if (await Bun.file(ready).exists()) readySignal.resolve();
		await readySignal.promise;
		readyWatcher.close();

		await expect(
			pinned.removeDirectoryTree("target", {
				dev: BigInt(targetMetadata.dev),
				ino: BigInt(targetMetadata.ino),
			}),
		).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
		expect(await attacker.exited).toBe(0);
		expect(await Bun.file(join(target, "replacement")).text()).toBe("replacement");
		expect((await lstat(parked)).isDirectory()).toBeTrue();
	}, 20_000);

	test("reads nested regular bytes and mode, symlink targets, active Git exclude, and untracked leaves", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, ".git", "info"), { recursive: true });
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, ".git", "info", "exclude"), "ignored.tmp\n");
		await writeFile(join(root, "src", "tracked.ts"), "export {};\n");
		await chmod(join(root, "src", "tracked.ts"), 0o640);
		await writeFile(join(root, "untracked.txt"), "dirty\n");
		await symlink("src/tracked.ts", join(root, "tracked-link"));

		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);
		const file = await pinned.openFile("src/tracked.ts");
		try {
			expect(await file.read(64)).toEqual(Buffer.from("export {};\n"));
			expect((await file.stat()).mode & 0o777).toBe(0o640);
		} finally {
			await file.close();
		}
		expect(await pinned.readFile(".git/info/exclude", 64)).toEqual(Buffer.from("ignored.tmp\n"));
		expect(await pinned.readlink("tracked-link", 64)).toEqual(Buffer.from("src/tracked.ts"));
		expect(await pinned.listLeaves({ maxEntries: 16, maxPathBytes: 128 })).toEqual([
			".git/info/exclude",
			"src/tracked.ts",
			"tracked-link",
			"untracked.txt",
		]);
	});

	test("rejects symlinked directory components and symlink terminal reads", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, "real"));
		await writeFile(join(root, "real", "value"), "secret");
		await symlink("real", join(root, "alias"));
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);

		await expect(pinned.readFile("alias/value", 64)).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
		await expect(pinned.readFile("alias", 64)).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
		expect(await pinned.readlink("alias", 64)).toEqual(Buffer.from("real"));
	});

	test("rejects unsafe and oversized relative paths before native traversal", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "file"), "ok");
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);

		for (const path of ["", ".", "..", "/file", "a//b", "a/./b", "a/../b", "nul\0tail"]) {
			await expect(pinned.readFile(path, 16)).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
		}
		await expect(
			pinned.readFile(`${"a".repeat(DARWIN_PINNED_DIRECTORY_LIMITS.maxComponentBytes + 1)}/file`, 16),
		).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
	});

	test("enforces file, symlink, entry, path, and total-output caps", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, "nested"));
		await writeFile(join(root, "large"), "12345");
		await writeFile(join(root, "nested", "leaf"), "x");
		await symlink("target-name", join(root, "link"));
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);

		await expect(pinned.readFile("large", 4)).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
		await expect(pinned.readlink("link", 4)).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
		await expect(pinned.listLeaves({ maxEntries: 2, maxPathBytes: 128 })).rejects.toBeInstanceOf(
			DarwinPinnedDirectoryError,
		);
		await expect(pinned.listLeaves({ maxEntries: 8, maxPathBytes: 8 })).rejects.toBeInstanceOf(
			DarwinPinnedDirectoryError,
		);
		await expect(
			pinned.listLeaves({ maxEntries: 8, maxPathBytes: 128, maxTotalPathBytes: 8 }),
		).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
		await expect(pinned.readFile("large", DARWIN_PINNED_DIRECTORY_LIMITS.maxFileBytes + 1)).rejects.toBeInstanceOf(
			DarwinPinnedDirectoryError,
		);
	});

	test("rejects special directory entries during enumeration", async () => {
		const root = await temporaryDirectory();
		const socketPath = join(root, "special.sock");
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);
		try {
			await expect(pinned.listLeaves({ maxEntries: 8, maxPathBytes: 128 })).rejects.toBeInstanceOf(
				DarwinPinnedDirectoryError,
			);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close(error => (error === undefined ? resolve() : reject(error))),
			);
		}
	});

	test("closes file and directory descriptors idempotently", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "file"), "ok");
		const pinned = await openPinnedDirectory(root);
		const file = await pinned.openFile("file");
		const fileFd = file.fd;
		const rootFd = pinned.fd;

		await file.close();
		await file.close();
		expect(() => fstatSync(fileFd)).toThrow();
		await pinned.close();
		await pinned.close();
		expect(() => fstatSync(rootFd)).toThrow();
	});

	test("rejects a symlink as the opened root", async () => {
		const parent = await temporaryDirectory();
		await mkdir(join(parent, "real"));
		await symlink("real", join(parent, "alias"));
		await expect(openPinnedDirectory(join(parent, "alias"))).rejects.toBeInstanceOf(DarwinPinnedDirectoryError);
	});
});
