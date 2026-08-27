import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { removePrivateEngineRuntimeTree } from "./engine-runtime-bundle";
import { LocalAuthorityStoreError } from "./local-authority-store";

const RUNTIME_CLEANUP_SCHEMA = "bb.lifecycle_runtime_cleanup.v2";
const LAUNCH_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ENGINE_RUNTIME_ROOT_PATTERN = /^bb-engine-runtime-[A-Za-z0-9_-]+$/;
const RAY_RUNTIME_ROOT_PATTERN = /^bb-ray-[A-Za-z0-9_-]+$/;

export interface ExitedEngineIdentity {
	readonly launchId: string;
	readonly pid: number;
	readonly startToken: string;
}

interface RuntimeRootIdentity {
	readonly path: string;
	readonly device: number;
	readonly inode: number;
}

interface RuntimeCleanupRecord extends ExitedEngineIdentity {
	readonly schemaVersion: typeof RUNTIME_CLEANUP_SCHEMA;
	readonly temporaryRoot: string;
	readonly engineRuntime?: RuntimeRootIdentity;
	readonly rayRuntime: RuntimeRootIdentity;
}

export class RuntimeCleanupStoreError extends Error {
	override readonly name = "RuntimeCleanupStoreError";
}

export class RuntimeCleanupStore {
	readonly #engineStateRoot: string | undefined;

	constructor(engineStateRoot?: string) {
		this.#engineStateRoot = engineStateRoot;
	}

	async stateRoot(): Promise<string | undefined> {
		if (this.#engineStateRoot === undefined) return undefined;
		return await this.#ensureDurablePrivateDirectory(this.#engineStateRoot, "engine state root");
	}

	async persist(
		identity: ExitedEngineIdentity,
		engineRuntimeRoot: string | undefined,
		rayRuntimeRoot: string,
	): Promise<boolean> {
		const path = await this.#recordPath(identity.launchId);
		if (path === undefined) return false;
		const temporaryRoot = await realpath(tmpdir());
		const record: RuntimeCleanupRecord = {
			schemaVersion: RUNTIME_CLEANUP_SCHEMA,
			...identity,
			temporaryRoot,
			...(engineRuntimeRoot === undefined
				? {}
				: {
						engineRuntime: await this.#captureRuntimeRoot(
							engineRuntimeRoot,
							temporaryRoot,
							ENGINE_RUNTIME_ROOT_PATTERN,
						),
					}),
			rayRuntime: await this.#captureRuntimeRoot(rayRuntimeRoot, temporaryRoot, RAY_RUNTIME_ROOT_PATTERN),
		};
		const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
		const handle = await open(path, flags, 0o600);
		let persisted = false;
		try {
			await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
			await handle.sync();
			persisted = true;
		} finally {
			await handle.close();
			if (!persisted) await this.#unlinkRecord(path);
		}
		await this.#syncPrivateDirectory(dirname(path), "engine runtime cleanup root");
		return true;
	}

	async remove(identity: ExitedEngineIdentity): Promise<void> {
		const loaded = await this.#read(identity);
		if (loaded === undefined) return;
		if (loaded.record.engineRuntime !== undefined) {
			await this.#quarantineAndRemove(loaded.record, "engine", loaded.record.engineRuntime);
		}
		await this.#quarantineAndRemove(loaded.record, "ray", loaded.record.rayRuntime);
		await this.#unlinkRecord(loaded.path);
	}

	async #ensureDurablePrivateDirectory(path: string, label: string): Promise<string> {
		const createdPath = await mkdir(path, { recursive: true, mode: 0o700 });
		const canonicalPath = await realpath(path);
		await this.#requirePrivateOwnedDirectory(canonicalPath, 0o700, label);
		if (createdPath !== undefined) {
			const firstCreated = await realpath(createdPath);
			const tail = relative(firstCreated, canonicalPath);
			if (tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail)) {
				throw new LocalAuthorityStoreError("root_integrity", `${label} creation escaped its private parent`);
			}
			const createdDirectories = [firstCreated];
			let current = firstCreated;
			if (tail !== "") {
				for (const component of tail.split(sep)) {
					current = join(current, component);
					createdDirectories.push(current);
				}
			}
			for (const created of createdDirectories) {
				await this.#requirePrivateOwnedDirectory(created, 0o700, label);
				await this.#syncPrivateDirectory(dirname(created), `${label} parent`);
			}
		}
		return canonicalPath;
	}

	async #syncPrivateDirectory(path: string, label: string): Promise<void> {
		const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			const before = await handle.stat();
			await this.#requirePrivateOwnedDirectory(path, 0o700, label, before);
			await handle.sync();
			const after = await handle.stat();
			if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory()) {
				throw new LocalAuthorityStoreError("root_integrity", `${label} identity changed while synchronizing`);
			}
		} finally {
			await handle.close();
		}
	}

	async #unlinkRecord(path: string): Promise<void> {
		let removed = false;
		try {
			await unlink(path);
			removed = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (removed) await this.#syncPrivateDirectory(dirname(path), "engine runtime cleanup root");
	}

	async #recordRoot(): Promise<string | undefined> {
		const engineStateRoot = await this.stateRoot();
		if (engineStateRoot === undefined) return undefined;
		const root = join(engineStateRoot, "runtime-cleanup");
		return await this.#ensureDurablePrivateDirectory(root, "engine runtime cleanup root");
	}

	async #recordPath(launchId: string): Promise<string | undefined> {
		const root = await this.#recordRoot();
		if (root === undefined) return undefined;
		if (!LAUNCH_ID_PATTERN.test(launchId)) {
			throw new RuntimeCleanupStoreError("engine runtime cleanup launch identity is invalid");
		}
		return join(root, `${launchId}.json`);
	}

	async #read(
		identity: ExitedEngineIdentity,
	): Promise<{ readonly path: string; readonly record: RuntimeCleanupRecord } | undefined> {
		const path = await this.#recordPath(identity.launchId);
		if (path === undefined) return undefined;
		let handle: FileHandle;
		try {
			handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		let raw: string;
		try {
			const metadata = await handle.stat();
			const expectedUid = process.geteuid?.() ?? process.getuid?.() ?? -1;
			if (
				!metadata.isFile() ||
				metadata.isSymbolicLink() ||
				metadata.nlink !== 1 ||
				(metadata.mode & 0o777) !== 0o600 ||
				metadata.uid !== expectedUid
			) {
				throw new LocalAuthorityStoreError(
					"root_integrity",
					"engine runtime cleanup record is not one private owned file",
				);
			}
			raw = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new RuntimeCleanupStoreError("engine runtime cleanup record is invalid");
		}
		const value = parsed as Record<string, unknown>;
		const expectedKeys =
			value.engineRuntime === undefined
				? "launchId\0pid\0rayRuntime\0schemaVersion\0startToken\0temporaryRoot"
				: "engineRuntime\0launchId\0pid\0rayRuntime\0schemaVersion\0startToken\0temporaryRoot";
		if (
			Object.keys(value).sort().join("\0") !== expectedKeys ||
			value.schemaVersion !== RUNTIME_CLEANUP_SCHEMA ||
			value.launchId !== identity.launchId ||
			value.pid !== identity.pid ||
			value.startToken !== identity.startToken ||
			typeof value.temporaryRoot !== "string" ||
			!this.#isRuntimeRootIdentity(value.rayRuntime) ||
			(value.engineRuntime !== undefined && !this.#isRuntimeRootIdentity(value.engineRuntime))
		) {
			throw new RuntimeCleanupStoreError("engine runtime cleanup identity changed");
		}
		const record = value as unknown as RuntimeCleanupRecord;
		if (!isAbsolute(record.temporaryRoot) || record.temporaryRoot !== (await realpath(tmpdir()))) {
			throw new RuntimeCleanupStoreError("engine runtime cleanup temporary root identity changed");
		}
		this.#validateRecordedRuntimeRoot(record.rayRuntime, record.temporaryRoot, RAY_RUNTIME_ROOT_PATTERN);
		if (record.engineRuntime !== undefined) {
			this.#validateRecordedRuntimeRoot(record.engineRuntime, record.temporaryRoot, ENGINE_RUNTIME_ROOT_PATTERN);
		}
		return { path, record };
	}

	#validateRecordedRuntimeRoot(root: RuntimeRootIdentity, temporaryRoot: string, pattern: RegExp): void {
		if (
			!isAbsolute(root.path) ||
			dirname(root.path) !== temporaryRoot ||
			join(temporaryRoot, basename(root.path)) !== root.path ||
			!pattern.test(basename(root.path))
		) {
			throw new RuntimeCleanupStoreError("engine runtime cleanup path escaped its recorded namespace");
		}
	}

	async #captureRuntimeRoot(path: string, temporaryRoot: string, pattern: RegExp): Promise<RuntimeRootIdentity> {
		if (!isAbsolute(path)) throw new RuntimeCleanupStoreError("engine runtime cleanup path is not absolute");
		const canonicalPath = await realpath(path);
		if (dirname(canonicalPath) !== temporaryRoot || !pattern.test(basename(canonicalPath))) {
			throw new RuntimeCleanupStoreError("engine runtime cleanup path is outside its private temporary scope");
		}
		const metadata = await this.#requirePrivateOwnedDirectory(
			canonicalPath,
			undefined,
			"engine runtime cleanup path",
		);
		return { path: canonicalPath, device: metadata.dev, inode: metadata.ino };
	}

	async #quarantineAndRemove(
		record: RuntimeCleanupRecord,
		kind: "engine" | "ray",
		root: RuntimeRootIdentity,
	): Promise<void> {
		if (dirname(root.path) !== record.temporaryRoot || (await realpath(tmpdir())) !== record.temporaryRoot) {
			throw new RuntimeCleanupStoreError("engine runtime cleanup path escaped its recorded temporary root");
		}
		const expectedUid = process.geteuid?.() ?? process.getuid?.() ?? -1;
		const quarantineRoot = join(record.temporaryRoot, `bb-runtime-cleanup-quarantine-${expectedUid}`);
		await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
		await this.#requirePrivateOwnedDirectory(quarantineRoot, 0o700, "engine runtime cleanup quarantine");
		try {
			const quarantined = join(quarantineRoot, `${record.launchId}.${record.pid}.${kind}`);
			const sourceMetadata = await this.#metadataIfPresent(root.path);
			const quarantinedMetadata = await this.#metadataIfPresent(quarantined);
			if (sourceMetadata !== undefined && quarantinedMetadata !== undefined) {
				throw new RuntimeCleanupStoreError("engine runtime cleanup source and quarantine both exist");
			}
			if (sourceMetadata !== undefined) {
				await this.#makeRuntimeRootWritable(root.path, root);
				try {
					await rename(root.path, quarantined);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			const movedMetadata = await this.#metadataIfPresent(quarantined);
			if (movedMetadata === undefined) {
				if (await this.#metadataIfPresent(root.path)) {
					throw new RuntimeCleanupStoreError("engine runtime cleanup quarantine did not take ownership");
				}
			} else {
				await this.#matchRuntimeRoot(quarantined, root, movedMetadata, false);
				await removePrivateEngineRuntimeTree(quarantined);
			}
		} finally {
			await rmdir(quarantineRoot).catch(error => {
				if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			});
		}
	}

	async #makeRuntimeRootWritable(path: string, expected: RuntimeRootIdentity): Promise<void> {
		const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			const before = await handle.stat();
			await this.#matchRuntimeRoot(path, expected, before);
			await handle.chmod(0o700);
			const after = await handle.stat();
			if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory()) {
				throw new RuntimeCleanupStoreError("engine runtime cleanup directory identity changed while quarantining");
			}
		} finally {
			await handle.close();
		}
	}

	async #matchRuntimeRoot(
		path: string,
		expected: RuntimeRootIdentity,
		metadata: Stats,
		requireCanonical = true,
	): Promise<void> {
		if (
			metadata.dev !== expected.device ||
			metadata.ino !== expected.inode ||
			metadata.isSymbolicLink() ||
			!metadata.isDirectory()
		) {
			throw new RuntimeCleanupStoreError("engine runtime cleanup directory identity changed");
		}
		await this.#requirePrivateOwnedDirectory(path, undefined, "engine runtime cleanup path", metadata);
		if (requireCanonical && (await realpath(path)) !== expected.path) {
			throw new RuntimeCleanupStoreError("engine runtime cleanup canonical path changed");
		}
	}

	async #requirePrivateOwnedDirectory(
		path: string,
		exactMode: number | undefined,
		label: string,
		metadata = undefined as Stats | undefined,
	): Promise<Stats> {
		const observed = metadata ?? (await lstat(path));
		const expectedUid = process.geteuid?.() ?? process.getuid?.() ?? -1;
		if (
			!observed.isDirectory() ||
			observed.isSymbolicLink() ||
			(exactMode === undefined
				? (observed.mode & 0o500) !== 0o500 || Boolean(observed.mode & 0o077)
				: (observed.mode & 0o777) !== exactMode) ||
			observed.uid !== expectedUid
		) {
			throw new LocalAuthorityStoreError("root_integrity", `${label} is not one private owned directory`);
		}
		return observed;
	}

	async #metadataIfPresent(path: string): Promise<Stats | undefined> {
		try {
			return await lstat(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	#isRuntimeRootIdentity(value: unknown): value is RuntimeRootIdentity {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const candidate = value as Record<string, unknown>;
		return (
			Object.keys(candidate).sort().join("\0") === "device\0inode\0path" &&
			typeof candidate.path === "string" &&
			Number.isSafeInteger(candidate.device) &&
			Number.isSafeInteger(candidate.inode)
		);
	}
}
