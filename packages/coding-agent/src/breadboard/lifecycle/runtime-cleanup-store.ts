import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, rm, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, sep } from "node:path";
import { removePrivateEngineRuntimeTree } from "./engine-runtime-bundle";
import { LocalAuthorityStoreError } from "./local-authority-store";

const RUNTIME_CLEANUP_SCHEMA = "bb.lifecycle_runtime_cleanup.v1";
const LAUNCH_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ENGINE_RUNTIME_ROOT_PATTERN = /^bb-engine-runtime-[A-Za-z0-9_-]+$/;
const RAY_RUNTIME_ROOT_PATTERN = /^bb-ray-[A-Za-z0-9_-]+$/;

export interface ExitedEngineIdentity {
	readonly launchId: string;
	readonly pid: number;
	readonly startToken: string;
}

interface RuntimeCleanupRecord extends ExitedEngineIdentity {
	readonly schemaVersion: typeof RUNTIME_CLEANUP_SCHEMA;
	readonly engineRuntimeRoot?: string;
	readonly rayRuntimeRoot: string;
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
		await mkdir(this.#engineStateRoot, { recursive: true, mode: 0o700 });
		const metadata = await lstat(this.#engineStateRoot);
		const expectedUid = process.geteuid?.() ?? process.getuid?.() ?? -1;
		if (
			!metadata.isDirectory() ||
			metadata.isSymbolicLink() ||
			(metadata.mode & 0o777) !== 0o700 ||
			metadata.uid !== expectedUid
		) {
			throw new LocalAuthorityStoreError("root_integrity", "engine state root is not one private owned directory");
		}
		return await realpath(this.#engineStateRoot);
	}

	async persist(
		identity: ExitedEngineIdentity,
		engineRuntimeRoot: string | undefined,
		rayRuntimeRoot: string,
	): Promise<boolean> {
		const path = await this.#recordPath(identity.launchId);
		if (path === undefined) return false;
		const record: RuntimeCleanupRecord = {
			schemaVersion: RUNTIME_CLEANUP_SCHEMA,
			...identity,
			...(engineRuntimeRoot === undefined ? {} : { engineRuntimeRoot }),
			rayRuntimeRoot,
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
			if (!persisted) await unlink(path).catch(() => undefined);
		}
		return true;
	}

	async remove(identity: ExitedEngineIdentity): Promise<void> {
		const loaded = await this.#read(identity);
		if (loaded === undefined) return;
		const { engineRuntimeRoot, rayRuntimeRoot } = loaded.record;
		if (
			engineRuntimeRoot !== undefined &&
			(engineRuntimeRoot === rayRuntimeRoot ||
				engineRuntimeRoot.startsWith(`${rayRuntimeRoot}${sep}`) ||
				rayRuntimeRoot.startsWith(`${engineRuntimeRoot}${sep}`))
		) {
			throw new RuntimeCleanupStoreError("engine runtime cleanup roots overlap");
		}
		if (
			engineRuntimeRoot !== undefined &&
			(await this.#validateRuntimeRoot(engineRuntimeRoot, ENGINE_RUNTIME_ROOT_PATTERN))
		) {
			await removePrivateEngineRuntimeTree(engineRuntimeRoot);
		}
		if (await this.#validateRuntimeRoot(rayRuntimeRoot, RAY_RUNTIME_ROOT_PATTERN)) {
			await rm(rayRuntimeRoot, { recursive: true, force: true });
		}
		await unlink(loaded.path).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	}

	async #recordPath(launchId: string): Promise<string | undefined> {
		const engineStateRoot = await this.stateRoot();
		if (engineStateRoot === undefined) return undefined;
		if (!LAUNCH_ID_PATTERN.test(launchId)) {
			throw new RuntimeCleanupStoreError("engine runtime cleanup launch identity is invalid");
		}
		const root = join(engineStateRoot, "runtime-cleanup");
		await mkdir(root, { recursive: true, mode: 0o700 });
		const metadata = await lstat(root);
		const expectedUid = process.geteuid?.() ?? process.getuid?.() ?? -1;
		if (
			!metadata.isDirectory() ||
			metadata.isSymbolicLink() ||
			(metadata.mode & 0o777) !== 0o700 ||
			metadata.uid !== expectedUid
		) {
			throw new LocalAuthorityStoreError(
				"root_integrity",
				"engine runtime cleanup root is not one private owned directory",
			);
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
			value.engineRuntimeRoot === undefined
				? "launchId\0pid\0rayRuntimeRoot\0schemaVersion\0startToken"
				: "engineRuntimeRoot\0launchId\0pid\0rayRuntimeRoot\0schemaVersion\0startToken";
		if (
			Object.keys(value).sort().join("\0") !== expectedKeys ||
			value.schemaVersion !== RUNTIME_CLEANUP_SCHEMA ||
			value.launchId !== identity.launchId ||
			value.pid !== identity.pid ||
			value.startToken !== identity.startToken ||
			(value.engineRuntimeRoot !== undefined && typeof value.engineRuntimeRoot !== "string") ||
			typeof value.rayRuntimeRoot !== "string"
		) {
			throw new RuntimeCleanupStoreError("engine runtime cleanup identity changed");
		}
		return { path, record: value as unknown as RuntimeCleanupRecord };
	}

	async #validateRuntimeRoot(path: string, pattern: RegExp): Promise<boolean> {
		if (!isAbsolute(path) || !pattern.test(basename(path))) {
			throw new RuntimeCleanupStoreError("engine runtime cleanup path is invalid");
		}
		let metadata: Stats;
		try {
			metadata = await lstat(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
		const expectedUid = process.geteuid?.() ?? process.getuid?.() ?? -1;
		if (
			!metadata.isDirectory() ||
			metadata.isSymbolicLink() ||
			(metadata.mode & 0o500) !== 0o500 ||
			metadata.mode & 0o077 ||
			metadata.uid !== expectedUid
		) {
			throw new LocalAuthorityStoreError("root_integrity", "engine runtime cleanup path is not private and owned");
		}
		return true;
	}
}
