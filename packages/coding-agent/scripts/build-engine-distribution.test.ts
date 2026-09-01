import { afterAll, describe, expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeRuntimeSymlinks, writePinnedFile } from "./build-engine-distribution";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "breadboard-pinned-engine-trust-"));
	temporaryRoots.push(root);
	return root;
}

afterAll(async () => {
	await Promise.all(temporaryRoots.map(root => rm(root, { recursive: true, force: true })));
});

describe("pinned engine trust publication", () => {
	test("publishes one sealed file and accepts only the same bytes", async () => {
		const root = await temporaryRoot();
		const path = join(root, "engine.trust.json");
		const content = "fixture\n";
		await writePinnedFile(path, content);
		await writePinnedFile(path, content);
		const metadata = await lstat(path);
		expect(metadata.isFile()).toBe(true);
		expect(metadata.nlink).toBe(1);
		expect(metadata.mode & 0o777).toBe(0o400);
		await expect(writePinnedFile(path, "changed\n")).rejects.toThrow("existing pinned file differs");
	});

	test("rejects writable, multiply linked, and symlinked existing paths", async () => {
		const root = await temporaryRoot();
		const content = "fixture\n";

		const writable = join(root, "writable.trust.json");
		await Bun.write(writable, content);
		await chmod(writable, 0o600);
		await expect(writePinnedFile(writable, content)).rejects.toThrow("identity is invalid");

		const multiplyLinked = join(root, "multiply-linked.trust.json");
		await Bun.write(multiplyLinked, content);
		await chmod(multiplyLinked, 0o400);
		await link(multiplyLinked, join(root, "other-link.trust.json"));
		await expect(writePinnedFile(multiplyLinked, content)).rejects.toThrow("identity is invalid");

		const target = join(root, "symlink-target.trust.json");
		const symlinkPath = join(root, "symlink.trust.json");
		await Bun.write(target, content);
		await chmod(target, 0o400);
		await symlink(target, symlinkPath);
		await expect(writePinnedFile(symlinkPath, content)).rejects.toThrow("identity is invalid");
	});
});

describe("frozen runtime normalization", () => {
	test("materializes contained file symlinks without changing bytes or mode", async () => {
		const root = await temporaryRoot();
		const runtime = join(root, "runtime");
		const libraryRoot = join(runtime, "pyarrow");
		const target = join(libraryRoot, "libarrow.dylib");
		const alias = join(runtime, "libarrow.dylib");
		await mkdir(libraryRoot, { recursive: true });
		await Bun.write(target, "signed library bytes");
		await chmod(target, 0o500);
		await symlink("pyarrow/libarrow.dylib", alias);

		await materializeRuntimeSymlinks(runtime);

		const metadata = await lstat(alias);
		expect(metadata.isFile()).toBe(true);
		expect(metadata.isSymbolicLink()).toBe(false);
		expect(metadata.nlink).toBe(1);
		expect(metadata.mode & 0o777).toBe(0o500);
		expect(await readFile(alias, "utf8")).toBe("signed library bytes");
	});

	test("rejects runtime symlinks that escape their private root", async () => {
		const root = await temporaryRoot();
		const runtime = join(root, "runtime");
		await mkdir(runtime);
		await Bun.write(join(root, "outside.dylib"), "outside");
		await symlink("../outside.dylib", join(runtime, "escaped.dylib"));

		await expect(materializeRuntimeSymlinks(runtime)).rejects.toThrow(
			"engine runtime symlink escapes the runtime root",
		);
	});
});
