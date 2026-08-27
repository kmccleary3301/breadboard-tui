import { afterEach, describe, expect, test } from "bun:test";
import { fstatSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LinuxPinnedDirectoryError,
	normalizeNodeErrno,
	openLinuxPinnedDirectory,
	openLinuxPinnedDirectoryWithMountIdentityForTesting,
} from "./linux-pinned-directory";
import {
	openPinnedDirectory,
	PINNED_DIRECTORY_LIMITS,
	type PinnedDirectory,
	PinnedDirectoryUnsupportedPlatformError,
} from "./pinned-directory";

const roots: string[] = [];
const handles: PinnedDirectory[] = [];

async function temporaryDirectory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "linux-pinned-directory-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(handles.splice(0).map(async handle => await handle.close().catch(() => {})));
	await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("Linux pinned directory", () => {
	test("reads nested regular bytes and pinned symlinks and enumerates leaves", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(root, "nested", "value"), "secret");
		await chmod(join(root, "nested", "value"), 0o640);
		await symlink("nested/value", join(root, "link"));

		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);
		const file = await pinned.openFile("nested/value");
		try {
			expect(await file.read(64)).toEqual(Buffer.from("secret"));
			expect((await file.stat()).mode & 0o777).toBe(0o640);
		} finally {
			await file.close();
		}
		expect(await pinned.readlink("link", 64)).toEqual(Buffer.from("nested/value"));
		expect(await pinned.listLeaves({ maxEntries: 8, maxPathBytes: 128 })).toEqual(["link", "nested/value"]);
	});

	test("pins the opened root across pathname replacement", async () => {
		const root = await temporaryDirectory();
		const parked = `${root}.parked`;
		roots.push(parked);
		await mkdir(join(root, "nested"));
		await writeFile(join(root, "nested", "original"), "original");
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);

		await rename(root, parked);
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(root, "nested", "replacement"), "replacement");
		expect(await pinned.readFile("nested/original", 64)).toEqual(Buffer.from("original"));
		expect(await pinned.listLeaves({ maxEntries: 8, maxPathBytes: 128 })).toEqual(["nested/original"]);
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
		).rejects.toBeInstanceOf(LinuxPinnedDirectoryError);
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
		const pinned = await openLinuxPinnedDirectoryWithMountIdentityForTesting(
			root,
			(_fd, relativePath, actualIdentity) =>
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
		const pinned = await openLinuxPinnedDirectoryWithMountIdentityForTesting(
			root,
			(_fd, relativePath, actualIdentity) => {
				if (relativePath !== "target/nested") return actualIdentity;
				nestedMountObservations += 1;
				return nestedMountObservations === 1 ? actualIdentity : `${actualIdentity}:replacement-mount`;
			},
		);
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

	test("rejects unsafe paths, symlink traversal, and oversized values", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, "real"));
		await writeFile(join(root, "real", "value"), "secret");
		await symlink("real", join(root, "alias"));
		await symlink("real/value", join(root, "link"));
		const pinned = await openPinnedDirectory(root);
		handles.push(pinned);

		for (const relativePath of [
			"",
			".",
			"..",
			"/real/value",
			"real//value",
			"real/./value",
			"real/../value",
			"nul\0tail",
		]) {
			await expect(pinned.readFile(relativePath, 16)).rejects.toBeInstanceOf(LinuxPinnedDirectoryError);
		}
		await expect(pinned.readFile("alias/value", 16)).rejects.toBeInstanceOf(LinuxPinnedDirectoryError);
		await expect(pinned.readFile("link", 16)).rejects.toBeInstanceOf(LinuxPinnedDirectoryError);
		await expect(
			pinned.readFile(`${"a".repeat(PINNED_DIRECTORY_LIMITS.maxComponentBytes + 1)}/value`, 16),
		).rejects.toBeInstanceOf(LinuxPinnedDirectoryError);
		await expect(pinned.readFile("real/value", PINNED_DIRECTORY_LIMITS.maxFileBytes + 1)).rejects.toBeInstanceOf(
			LinuxPinnedDirectoryError,
		);
		await expect(pinned.readlink("link", 4)).rejects.toBeInstanceOf(LinuxPinnedDirectoryError);
	});

	test("enforces enumeration caps and closes descriptors idempotently", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "a"), "a");
		await writeFile(join(root, "bb"), "b");
		const pinned = await openPinnedDirectory(root);
		const file = await pinned.openFile("a");
		const fileFd = file.fd;
		const rootFd = pinned.fd;
		handles.push(pinned);

		await expect(pinned.listLeaves({ maxEntries: 1, maxPathBytes: 128 })).rejects.toBeInstanceOf(
			LinuxPinnedDirectoryError,
		);
		await expect(pinned.listLeaves({ maxEntries: 8, maxPathBytes: 1 })).rejects.toBeInstanceOf(
			LinuxPinnedDirectoryError,
		);
		await file.close();
		await file.close();
		expect(() => fstatSync(fileFd)).toThrow();
		await pinned.close();
		await pinned.close();
		expect(() => fstatSync(rootFd)).toThrow();
		handles.splice(handles.indexOf(pinned), 1);
	});
});

test("Linux backend fails closed off Linux x64", async () => {
	if (process.platform === "darwin" || (process.platform === "linux" && process.arch === "x64")) return;
	await expect(openLinuxPinnedDirectory(".")).rejects.toBeInstanceOf(LinuxPinnedDirectoryError);
	await expect(openPinnedDirectory(".")).rejects.toBeInstanceOf(PinnedDirectoryUnsupportedPlatformError);
});

test("normalizes Node EINTR errno variants", () => {
	expect(normalizeNodeErrno({ errno: -4 })).toBe(4);
	expect(normalizeNodeErrno({ code: "EINTR" })).toBe(4);
	expect(normalizeNodeErrno({ errno: 4 })).toBe(4);
});
