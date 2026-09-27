import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PRODUCT_TARGET, removePinnedDirectoryTree, targetKey as productTargetKey } from "./product-archive";
import {
	installManagedProductArchive,
	installProductArchive,
	PRODUCT_LIFECYCLE_STATE_DIRECTORY,
	requireInstallableTrust,
	rollbackManagedProductArchive,
	statusManagedProductArchive,
	uninstallManagedProductArchive,
	updateManagedProductArchive,
} from "./install-product-release";
import { openProductArchive } from "./product-archive";

const ALLOW_UNSIGNED = Object.freeze({ allowUnsignedDevelopment: true });
const NATIVE_ADDON_PATH = "native/pi_natives.darwin-arm64.node";

function productTargetKey(): string {
	return `${PRODUCT_TARGET.platform}-${PRODUCT_TARGET.architecture}`;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

async function makeArchive(
	parent: string,
	version: string,
	variant = version,
	_engineVersion = version,
	nativeAddonPath = NATIVE_ADDON_PATH,
): Promise<string> {
	const target = PRODUCT_TARGET;
	const targetKey = productTargetKey();
	const rootName = `bb-${targetKey}-${version}`;
	const buildRoot = join(parent, `build-${variant}`);
	const root = join(buildRoot, rootName);
	const files = new Map<string, Buffer>([
		["bb", Buffer.from(`binary-${variant}`)],
		[nativeAddonPath, Buffer.from(`addon-${variant}`)],
		["LICENSE", Buffer.from("development license")],
		["THIRD_PARTY_NOTICES.txt", Buffer.from("development notices")],
	]);
	const installManifest = {
		schemaVersion: "bb.product_install_manifest.v1",
		archiveSchemaVersion: "bb.product_archive.v1",
		product: "bb",
		productVersion: version,
		target,
		archiveSha256: `sha256:${"0".repeat(64)}`,
		rootSha256: `sha256:${"1".repeat(64)}`,
		binary: {
			path: "bb",
			sizeBytes: files.get("bb")?.byteLength,
			sha256: `sha256:${sha256(files.get("bb") as Buffer)}`,
		},
		nativeAddon: {
			path: nativeAddonPath,
			sizeBytes: files.get(nativeAddonPath)?.byteLength,
			sha256: `sha256:${sha256(files.get(nativeAddonPath) as Buffer)}`,
		},
		legal: { posture: "unsigned-development", inputsPresent: false },
		classification: "development-evidence",
	};
	files.set("install-manifest.v1.json", Buffer.from(`${JSON.stringify(installManifest)}\n`));
	const checksums = [...files]
		.map(([name, bytes]) => `${sha256(bytes)}  ${name}`)
		.sort()
		.join("\n");
	files.set("checksums.sha256", Buffer.from(`${checksums}\n`));
	await mkdir(root, { recursive: true, mode: 0o700 });
	for (const [relative, bytes] of files) {
		const path = join(root, relative);
		await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
		await writeFile(path, bytes, { mode: 0o400 });
	}
	const archivePath = join(parent, `${rootName}-${variant}.tar.gz`);
	const child = Bun.spawn(["tar", "-czf", archivePath, "-C", buildRoot, rootName], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(stderr);
	await chmod(archivePath, 0o400);
	return archivePath;
}

async function fixture(): Promise<{ readonly root: string; readonly archives: Record<"a" | "b" | "c", string> }> {
	const root = await mkdtemp(join(await realpath("/tmp"), "bb-product-lifecycle-test-"));
	return {
		root,
		archives: {
			a: await makeArchive(root, "1.0.0"),
			b: await makeArchive(root, "2.0.0"),
			c: await makeArchive(root, "3.0.0"),
		},
	};
}

async function clean(root: string): Promise<void> {
	await removePinnedDirectoryTree(await realpath(root));
}

describe("managed product lifecycle", () => {
	test("installs the verified snapshot even if its source archive is replaced", async () => {
		const setup = await fixture();
		try {
			const archive = await openProductArchive(setup.archives.a, ALLOW_UNSIGNED);
			await chmod(setup.archives.a, 0o600);
			await writeFile(setup.archives.a, "invalid replacement archive");
			await expect(openProductArchive(setup.archives.a, ALLOW_UNSIGNED)).rejects.toThrow(Error);
			const installed = await archive.install(join(setup.root, "snapshot-install"));
			expect(await readFile(join(installed, "bb"), "utf8")).toBe("binary-1.0.0");
		} finally {
			await clean(setup.root);
		}
	});
	test("rejects unsigned development evidence without explicit authorization", async () => {
		const setup = await fixture();
		try {
			await expect(installManagedProductArchive(setup.archives.a, join(setup.root, "destination"))).rejects.toThrow(
				/unsigned development archive requires explicit authorization/,
			);
			const expectedArchiveSha256 = `sha256:${sha256(await readFile(setup.archives.a))}`;
			await expect(
				installManagedProductArchive(setup.archives.a, join(setup.root, "pinned-destination"), {
					expectedArchiveSha256,
				}),
			).rejects.toThrow(/unsigned development archive requires explicit authorization/);
		} finally {
			await clean(setup.root);
		}
	});
	test("requires and accepts an exact digest for release candidates", () => {
		const archiveSha256 = `sha256:${"a".repeat(64)}` as const;
		expect(() => requireInstallableTrust({ classification: "release-candidate" }, {}, archiveSha256)).toThrow(
			/release candidate requires an independently supplied archive digest/,
		);
		expect(() =>
			requireInstallableTrust(
				{ classification: "release-candidate" },
				{ expectedArchiveSha256: archiveSha256 },
				archiveSha256,
			),
		).not.toThrow();
	});
	test("rejects manifest paths that do not name the launched product files", async () => {
		const root = await mkdtemp(join(await realpath("/tmp"), "bb-product-path-test-"));
		try {
			const archive = await makeArchive(root, "1.0.0", "wrong-addon-path", "1.0.0", "native/addon.node");
			await expect(installManagedProductArchive(archive, join(root, "destination"), ALLOW_UNSIGNED)).rejects.toThrow(
				/executable paths are invalid/,
			);
		} finally {
			await clean(root);
		}
	});

	test("installs A, updates to B, and rolls back to retained A", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		try {
			const installed = await installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			if (!installed.active) throw new Error("expected an active installed product");
			expect(installed.active.version).toBe("1.0.0");
			const productRoot = join(destination, installed.active.rootName);
			expect((await lstat(productRoot)).mode & 0o777).toBe(0o700);
			expect(await Bun.file(join(productRoot, "engine")).exists()).toBeFalse();
			expect((await lstat(join(productRoot, "native"))).mode & 0o777).toBe(0o500);
			const firstRevision = join(destination, PRODUCT_LIFECYCLE_STATE_DIRECTORY, "revisions", "revision-1.json");
			expect((await lstat(firstRevision)).mode & 0o777).toBe(0o400);
			const updated = await updateManagedProductArchive(setup.archives.b, destination, ALLOW_UNSIGNED);
			expect(updated.active?.version).toBe("2.0.0");
			expect(updated.retained.map(root => root.version)).toEqual(["1.0.0"]);
			expect((await rollbackManagedProductArchive(destination)).active?.version).toBe("1.0.0");
		} finally {
			await clean(setup.root);
		}
	});

	test("treats an exact same-version update as a verified no-op", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		try {
			const installed = await installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			const unchanged = await updateManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			expect(unchanged).toEqual(installed);
			expect(unchanged.revision).toBe(1);
			expect(unchanged.action).toBe("install");
		} finally {
			await clean(setup.root);
		}
	});

	test("rejects same-version update when the active release is corrupted", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		try {
			const installed = await installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			if (!installed.active) throw new Error("expected an active installed product");
			const binary = join(destination, installed.active.rootName, "bb");
			await chmod(binary, 0o600);
			await writeFile(binary, "corrupted");
			await expect(updateManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED)).rejects.toThrow();
			await expect(statusManagedProductArchive(destination)).rejects.toThrow();
		} finally {
			await clean(setup.root);
		}
	});

	test("rejects same-version update when the active release mode drifts", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		try {
			const installed = await installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			if (!installed.active) throw new Error("expected an active installed product");
			await chmod(join(destination, installed.active.rootName, "bb"), 0o700);
			await expect(updateManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED)).rejects.toThrow(
				/unsafe ownership or mode/,
			);
		} finally {
			await clean(setup.root);
		}
	});

	test("requires explicit downgrade authorization", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		try {
			await installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			await updateManagedProductArchive(setup.archives.b, destination, ALLOW_UNSIGNED);
			await expect(updateManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED)).rejects.toThrow(
				/downgrade/,
			);
			expect(
				(
					await updateManagedProductArchive(setup.archives.a, destination, {
						allowDowngrade: true,
						allowUnsignedDevelopment: true,
					})
				).active?.version,
			).toBe("1.0.0");
		} finally {
			await clean(setup.root);
		}
	});

	test("allows one concurrent CAS winner and leaves the losing archive recoverable", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		try {
			await installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			const results = await Promise.allSettled([
				updateManagedProductArchive(setup.archives.b, destination, ALLOW_UNSIGNED),
				updateManagedProductArchive(setup.archives.c, destination, ALLOW_UNSIGNED),
			]);
			expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
			expect((await statusManagedProductArchive(destination)).revision).toBe(2);
		} finally {
			await clean(setup.root);
		}
	});

	test("rejects an unbound orphan root and ignores an interrupted pending revision", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		try {
			await installProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			const revisions = join(destination, PRODUCT_LIFECYCLE_STATE_DIRECTORY, "revisions");
			await mkdir(revisions, { recursive: true, mode: 0o700 });
			await writeFile(join(revisions, ".pending-interrupted.json"), "{", { mode: 0o600 });
			await expect(installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED)).rejects.toThrow(
				/unbound product root/,
			);
			const status = await statusManagedProductArchive(destination);
			expect(status.revision).toBe(0);
			expect(status.residue).toContain(`bb-${productTargetKey()}-1.0.0`);
		} finally {
			await clean(setup.root);
		}
	});

	test("uninstall removes the active and every retained product release", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		try {
			const first = await installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			const second = await updateManagedProductArchive(setup.archives.b, destination, ALLOW_UNSIGNED);
			if (!first.active || !second.active) throw new Error("expected installed product identities");
			const removed = await uninstallManagedProductArchive(destination);
			expect(removed.active).toBeNull();
			expect(removed.retained).toEqual([]);
			expect(removed.removed).toEqual([second.active.rootName, first.active.rootName]);
			expect(removed.revision).toBe(6);
			await expect(lstat(join(destination, first.active.rootName))).rejects.toMatchObject({ code: "ENOENT" });
			await expect(lstat(join(destination, second.active.rootName))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await clean(setup.root);
		}
	});

	test("publishes uninstall before authenticated removal and reports residue", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		try {
			await installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			await writeFile(join(destination, "leftover.txt"), "residue", { mode: 0o400 });
			const removed = await uninstallManagedProductArchive(destination);
			expect(removed.action).toBe("cleanup");
			expect(removed.revision).toBe(3);
			expect(removed.removal).toBeNull();
			expect(removed.active).toBeNull();
			expect(removed.removed).toContain(`bb-${productTargetKey()}-1.0.0`);
			expect(removed.residue).toContain("leftover.txt");
			const reinstalled = await installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			expect(reinstalled.revision).toBe(4);
			expect(reinstalled.active?.version).toBe("1.0.0");
		} finally {
			await clean(setup.root);
		}
	});

	test("resumes authenticated removal after uninstall publication interruption", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		try {
			await installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			const revisions = join(destination, PRODUCT_LIFECYCLE_STATE_DIRECTORY, "revisions");
			const first = JSON.parse(await readFile(join(revisions, "revision-1.json"), "utf8"));
			const rootName = first.active.rootName as string;
			const rootPath = join(destination, rootName);
			const rootIdentity = await lstat(rootPath);
			const retirementName = `.bb-retire-${BigInt.asUintN(64, BigInt(rootIdentity.dev)).toString(16)}-${BigInt.asUintN(64, BigInt(rootIdentity.ino)).toString(16)}`;
			const interrupted = {
				...first,
				revision: 2,
				action: "uninstall",
				active: null,
				removal: { rootName, retirementName },
				removed: [rootName],
				residue: [rootName],
			};
			const second = join(revisions, "revision-2.json");
			await writeFile(second, `${JSON.stringify(interrupted)}\n`, { mode: 0o600 });
			await chmod(second, 0o400);
			await rename(rootPath, join(destination, retirementName));
			await expect(installManagedProductArchive(setup.archives.b, destination, ALLOW_UNSIGNED)).rejects.toThrow(
				/cleanup must be resumed/,
			);

			const resumed = await uninstallManagedProductArchive(destination);
			expect(resumed.revision).toBe(3);
			expect(resumed.active).toBeNull();
			expect(resumed.action).toBe("cleanup");
			expect(resumed.removal).toBeNull();
			expect(resumed.residue).not.toContain(rootName);
			await expect(lstat(join(destination, rootName))).rejects.toMatchObject({ code: "ENOENT" });
			await expect(lstat(join(destination, retirementName))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await clean(setup.root);
		}
	});

	test("rejects noncanonical numeric prerelease versions", async () => {
		const root = await mkdtemp(join(await realpath("/tmp"), "bb-product-lifecycle-semver-"));
		const destination = join(root, "destination");
		try {
			const invalid = await makeArchive(root, "1.0.0-01");
			await expect(installManagedProductArchive(invalid, destination, ALLOW_UNSIGNED)).rejects.toThrow(
				/product version is invalid/,
			);
		} finally {
			await clean(root);
		}
	});

	test("rejects build metadata excluded by the product-version contract", async () => {
		const root = await mkdtemp(join(await realpath("/tmp"), "bb-product-lifecycle-build-metadata-"));
		const destination = join(root, "destination");
		try {
			const archive = await makeArchive(root, "1.0.0+build.1", "build-metadata", "1.0.0");
			await expect(installManagedProductArchive(archive, destination, ALLOW_UNSIGNED)).rejects.toThrow();
		} finally {
			await clean(root);
		}
	});

	test("fails closed for an expected-root symlink", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		const rootName = `bb-${productTargetKey()}-1.0.0`;
		try {
			await mkdir(destination, { mode: 0o700 });
			await symlink(setup.root, join(destination, rootName));
			await expect(installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED)).rejects.toThrow();
		} finally {
			await clean(setup.root);
		}
	});
	test("rejects an untrusted ancestor before creating destination components", async () => {
		const setup = await fixture();
		const unsafe = join(setup.root, "unsafe");
		const victim = join(setup.root, "victim");
		const destination = join(unsafe, "redirect", "nested");
		try {
			await mkdir(unsafe, { mode: 0o700 });
			await chmod(unsafe, 0o777);
			await mkdir(victim, { mode: 0o700 });
			await symlink(victim, join(unsafe, "redirect"));
			await expect(installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED)).rejects.toThrow(
				/non-sticky group- or world-writable/,
			);
			await expect(lstat(join(victim, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await clean(setup.root);
		}
	});
	test("rejects a destination symlink before creating descendants", async () => {
		const setup = await fixture();
		const victim = join(setup.root, "victim");
		const redirect = join(setup.root, "redirect");
		const destination = join(redirect, "nested");
		try {
			await mkdir(victim, { mode: 0o700 });
			await symlink(victim, redirect);
			await expect(installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED)).rejects.toThrow(
				/symbolic-link path component/,
			);
			await expect(lstat(join(victim, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await clean(setup.root);
		}
	});

	test("rejects tampered downgrade authorization in a stored revision", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		try {
			await installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			const revision = join(destination, PRODUCT_LIFECYCLE_STATE_DIRECTORY, "revisions", "revision-1.json");
			const record = JSON.parse(await readFile(revision, "utf8"));
			record.allowDowngrade = true;
			await chmod(revision, 0o600);
			await writeFile(revision, `${JSON.stringify(record)}\n`, { mode: 0o600 });
			await chmod(revision, 0o400);
			await expect(statusManagedProductArchive(destination)).rejects.toThrow(/initial revision/);
		} finally {
			await clean(setup.root);
		}
	});

	test("rejects a conflicting same-version orphan archive", async () => {
		const root = await mkdtemp(join(await realpath("/tmp"), "bb-product-lifecycle-conflict-"));
		const destination = join(root, "destination");
		try {
			const original = await makeArchive(root, "1.0.0", "original");
			const conflict = await makeArchive(root, "1.0.0", "conflict");
			await installProductArchive(original, destination, ALLOW_UNSIGNED);
			await expect(installManagedProductArchive(conflict, destination, ALLOW_UNSIGNED)).rejects.toThrow(
				/unbound product root/,
			);
		} finally {
			await clean(root);
		}
	});
	test("rejects tampered removed roots in a stored revision", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		try {
			await installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			await updateManagedProductArchive(setup.archives.b, destination, ALLOW_UNSIGNED);
			const revision = join(destination, PRODUCT_LIFECYCLE_STATE_DIRECTORY, "revisions", "revision-2.json");
			const record = JSON.parse(await readFile(revision, "utf8"));
			record.removed = [`bb-${productTargetKey()}-3.0.0`];
			await chmod(revision, 0o600);
			await writeFile(revision, `${JSON.stringify(record)}\n`, { mode: 0o600 });
			await chmod(revision, 0o400);
			await expect(statusManagedProductArchive(destination)).rejects.toThrow(/update transition/);
		} finally {
			await clean(setup.root);
		}
	});
	test("rejects adversarially large revision numbers before replay", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		try {
			await installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			const revisions = join(destination, PRODUCT_LIFECYCLE_STATE_DIRECTORY, "revisions");
			await writeFile(join(revisions, "revision-9007199254740991.json"), "{}\n", { mode: 0o400 });
			await expect(statusManagedProductArchive(destination)).rejects.toThrow(/revision number is invalid/);
		} finally {
			await clean(setup.root);
		}
	});
	test("refuses revision overflow without bricking the readable head", async () => {
		const setup = await fixture();
		const destination = join(setup.root, "destination");
		try {
			await installManagedProductArchive(setup.archives.a, destination, ALLOW_UNSIGNED);
			await updateManagedProductArchive(setup.archives.b, destination, ALLOW_UNSIGNED);
			const revisions = join(destination, PRODUCT_LIFECYCLE_STATE_DIRECTORY, "revisions");
			let previous = JSON.parse(await readFile(join(revisions, "revision-2.json"), "utf8"));
			for (let revision = 3; revision <= 999; revision += 1) {
				const next = {
					...previous,
					revision,
					action: "rollback",
					active: previous.retained[0],
					retained: [previous.active, ...previous.retained.slice(1)],
					removal: null,
				};
				await writeFile(join(revisions, `revision-${revision}.json`), `${JSON.stringify(next)}\n`, {
					mode: 0o400,
				});
				previous = next;
			}
			expect((await statusManagedProductArchive(destination)).revision).toBe(999);
			await expect(uninstallManagedProductArchive(destination)).rejects.toThrow(/capacity is exhausted/);
			expect((await statusManagedProductArchive(destination)).revision).toBe(999);
			await lstat(join(destination, previous.active.rootName));

			const final = {
				...previous,
				revision: 1_000,
				action: "rollback",
				active: previous.retained[0],
				retained: [previous.active, ...previous.retained.slice(1)],
				removal: null,
			};
			await writeFile(join(revisions, "revision-1000.json"), `${JSON.stringify(final)}\n`, { mode: 0o400 });
			expect((await statusManagedProductArchive(destination)).revision).toBe(1_000);
			await expect(rollbackManagedProductArchive(destination)).rejects.toThrow(/capacity is exhausted/);
			await expect(updateManagedProductArchive(setup.archives.c, destination, ALLOW_UNSIGNED)).rejects.toThrow(
				/capacity is exhausted/,
			);
			await expect(lstat(join(destination, `bb-${productTargetKey()}-3.0.0`))).rejects.toMatchObject({
				code: "ENOENT",
			});
			expect((await statusManagedProductArchive(destination)).revision).toBe(1_000);
		} finally {
			await clean(setup.root);
		}
	});
});
