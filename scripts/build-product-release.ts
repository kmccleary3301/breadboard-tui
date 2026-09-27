#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { BREADBOARD_DISTRIBUTION_POLICY, formatBreadboardVersion } from "../packages/utils/src/product-distribution";

const ARCHIVE_SCHEMA = "bb.product_archive.v1" as const;
const INSTALL_SCHEMA = "bb.product_install_manifest.v1" as const;
const PROVENANCE_SCHEMA = "bb.product_provenance.v1" as const;
const ARCHIVE_ROOT_PATTERN = /^bb-darwin-arm64-[0-9A-Za-z.-]+$/;
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;
const PRODUCT_BINARY_NAME = "bb";
const PRODUCT_NATIVE_ADDON_NAME = "pi_natives.darwin-arm64.node";

export interface ProductReleaseTarget {
	readonly platform: "darwin";
	readonly architecture: "arm64";
}

export const PRODUCT_TARGET: ProductReleaseTarget = Object.freeze({
	platform: "darwin",
	architecture: "arm64",
});

function targetKey(target: ProductReleaseTarget = PRODUCT_TARGET): string {
	return `${target.platform}-${target.architecture}`;
}

const execFileAsync = promisify(execFile);

export interface ProductReleaseOptions {
	readonly binaryPath: string;
	readonly nativeAddonPath: string;
	readonly outputRoot: string;
	readonly productVersion: string;
	readonly developmentEvidence: boolean;
	readonly licensePath?: string;
	readonly noticesPath?: string;
}

export interface ProductArchiveReceipt {
	readonly schemaVersion: typeof ARCHIVE_SCHEMA;
	readonly classification: "release-candidate" | "development-evidence";
	readonly archivePath: string;
	readonly archiveSha256: `sha256:${string}`;
	readonly target: ProductReleaseTarget;
	readonly entries: readonly string[];
	readonly legal: { readonly posture: "release-ready" | "unsigned-development"; readonly inputsPresent: boolean };
}

function fail(message: string, cause?: unknown): never {
	throw new Error(message, cause === undefined ? undefined : { cause });
}

async function sealedFile(path: string): Promise<Buffer> {
	const metadata = await lstat(path).catch(error => fail(`required product input is unavailable: ${path}`, error));
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o022) !== 0) {
		fail(`required product input is not one private regular file: ${path}`);
	}
	const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const current = await descriptor.stat();
		if (!current.isFile() || current.nlink !== 1 || current.dev !== metadata.dev || current.ino !== metadata.ino) {
			fail(`product input identity changed: ${path}`);
		}
		return await descriptor.readFile();
	} finally {
		await descriptor.close();
	}
}

export async function verifyProductBinaryVersion(binary: Buffer, expectedVersion: string): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "bb-release-version-"));
	const binaryPath = join(root, "bb");
	const home = join(root, "home");
	const config = join(root, "config");
	const agent = join(root, "agent");
	const temporary = join(root, "tmp");
	try {
		await Promise.all([home, config, agent, temporary].map(path => mkdir(path, { mode: 0o700 })));
		const file = await open(
			binaryPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o500,
		);
		try {
			await file.writeFile(binary);
			await file.sync();
			await file.chmod(0o500);
		} finally {
			await file.close();
		}
		let stdout: string;
		try {
			const result = await execFileAsync(binaryPath, ["--version"], {
				encoding: "utf8",
				cwd: root,
				env: {
					BREADBOARD_CONFIG_DIR: config,
					HOME: home,
					OMP_SKIP_SETUP: "1",
					PATH: "/usr/bin:/bin",
					PI_CODING_AGENT_DIR: agent,
					TMPDIR: temporary,
				},
				maxBuffer: 4096,
				killSignal: "SIGKILL",
				timeout: 10_000,
			});
			stdout = result.stdout;
		} catch (error) {
			fail("product binary version probe failed", error);
		}
		const identity = stdout.trim();
		const expectedIdentity = formatBreadboardVersion();
		if (identity !== expectedIdentity || !identity.startsWith(`bb/${expectedVersion} `)) {
			fail(`product binary version ${identity || "<empty>"} does not match requested identity ${expectedIdentity}`);
		}
	} finally {
		await chmod(root, 0o700).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function octal(value: number, width: number): Buffer {
	const text = `${value.toString(8).padStart(width - 1, "0")}\0`;
	return Buffer.from(text, "ascii");
}

function tarEntry(name: string, bytes: Uint8Array, mode = 0o400): Buffer {
	const header = Buffer.alloc(512);
	const components = name.split("/");
	let entryName = name;
	let prefix = "";
	for (let index = components.length - 1; Buffer.byteLength(entryName) > 100 && index > 0; index--) {
		prefix = components.slice(0, index).join("/");
		entryName = components.slice(index).join("/");
		if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(entryName) <= 100) break;
	}
	const nameBytes = Buffer.from(entryName, "utf8");
	const prefixBytes = Buffer.from(prefix, "utf8");
	if (nameBytes.length > 100 || prefixBytes.length > 155) fail(`archive entry name is too long: ${name}`);
	nameBytes.copy(header, 0);
	prefixBytes.copy(header, 345);
	octal(mode, 8).copy(header, 100);
	octal(0, 8).copy(header, 108);
	octal(0, 8).copy(header, 116);
	octal(bytes.byteLength, 12).copy(header, 124);
	octal(0, 12).copy(header, 136);
	Buffer.from("        ", "ascii").copy(header, 148);
	header[156] = 48;
	Buffer.from("ustar\0", "ascii").copy(header, 257);
	Buffer.from("00", "ascii").copy(header, 263);
	const checksum = header.reduce((sum, byte) => sum + byte, 0);
	octal(checksum, 8).copy(header, 148);
	const padding = Buffer.alloc((512 - (bytes.byteLength % 512)) % 512);
	return Buffer.concat([header, Buffer.from(bytes), padding]);
}

function makeArchive(entries: ReadonlyMap<string, Buffer>): Buffer {
	const chunks: Buffer[] = [];
	for (const [name, bytes] of [...entries].sort(([left], [right]) =>
		Buffer.compare(Buffer.from(left), Buffer.from(right)),
	)) {
		chunks.push(tarEntry(name, bytes));
	}
	chunks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

async function gitIdentity(): Promise<{ readonly commit: string; readonly tree: string }> {
	const run = async (args: readonly string[]): Promise<string> => {
		const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) fail(`product source identity failed: git ${args.join(" ")}`);
		return result.stdout.toString().trim();
	};
	const status = await run(["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status !== "") fail("product source checkout must be clean, including untracked files");
	const commit = await run(["rev-parse", "--verify", "HEAD^{commit}"]);
	if (!GIT_OBJECT_ID.test(commit)) fail("product source commit identity is invalid");
	const tree = await run(["rev-parse", "--verify", `${commit}^{tree}`]);
	if (!GIT_OBJECT_ID.test(tree)) fail("product source tree identity is invalid");
	return { commit, tree };
}

export async function buildProductRelease(options: ProductReleaseOptions): Promise<ProductArchiveReceipt> {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		fail(`macOS arm64 product release building is unsupported on ${process.platform}/${process.arch}`);
	if (options.productVersion !== BREADBOARD_DISTRIBUTION_POLICY.productVersion) {
		fail(
			`product version ${options.productVersion} does not match current distribution policy ${BREADBOARD_DISTRIBUTION_POLICY.productVersion}`,
		);
	}
	if (basename(options.binaryPath) !== PRODUCT_BINARY_NAME) {
		fail(`product binary path must name ${PRODUCT_BINARY_NAME}`);
	}
	if (basename(options.nativeAddonPath) !== PRODUCT_NATIVE_ADDON_NAME) {
		fail(`native addon path must name ${PRODUCT_NATIVE_ADDON_NAME}`);
	}
	const source = await gitIdentity();
	const target = PRODUCT_TARGET;
	const distributionTargetKey = targetKey(target);
	const binary = await sealedFile(options.binaryPath);
	const addon = await sealedFile(options.nativeAddonPath);
	await verifyProductBinaryVersion(binary, options.productVersion);

	if (!options.developmentEvidence && (!options.licensePath || !options.noticesPath)) {
		fail(
			"release candidate requires explicit license and third-party notices inputs; use --development-evidence for local evidence only",
		);
	}
	const legalInputsPresent = options.licensePath !== undefined && options.noticesPath !== undefined;
	const legal = {
		posture: options.developmentEvidence ? "unsigned-development" : "release-ready",
		inputsPresent: legalInputsPresent,
	} as const;
	const rootName = `${BREADBOARD_DISTRIBUTION_POLICY.productName}-${distributionTargetKey}-${options.productVersion}`;
	if (!ARCHIVE_ROOT_PATTERN.test(rootName)) fail(`invalid release archive root name: ${rootName}`);

	const entries = new Map<string, Buffer>();
	entries.set(`${rootName}/${PRODUCT_BINARY_NAME}`, binary);
	entries.set(`${rootName}/native/${PRODUCT_NATIVE_ADDON_NAME}`, addon);
	if (options.licensePath) entries.set(`${rootName}/LICENSE`, await sealedFile(options.licensePath));
	if (options.noticesPath) entries.set(`${rootName}/THIRD_PARTY_NOTICES.txt`, await sealedFile(options.noticesPath));
	const provenance = {
		schemaVersion: PROVENANCE_SCHEMA,
		productVersion: options.productVersion,
		target,
		productSource: source,
		legal,
	} as const;
	entries.set(`${rootName}/provenance.v1.json`, Buffer.from(`${JSON.stringify(provenance)}\n`));
	const installManifest = {
		schemaVersion: INSTALL_SCHEMA,
		archiveSchemaVersion: ARCHIVE_SCHEMA,
		product: BREADBOARD_DISTRIBUTION_POLICY.productName,
		productVersion: options.productVersion,
		target,
		binary: { path: PRODUCT_BINARY_NAME, sizeBytes: binary.byteLength, sha256: sha256(binary) },
		nativeAddon: {
			path: `native/${PRODUCT_NATIVE_ADDON_NAME}`,
			sizeBytes: addon.byteLength,
			sha256: sha256(addon),
		},
		legal,
		classification: options.developmentEvidence ? "development-evidence" : "release-candidate",
	} as const;
	entries.set(`${rootName}/install-manifest.v1.json`, Buffer.from(`${JSON.stringify(installManifest)}\n`));
	const finalChecksums = `${[...entries]
		.map(([name, bytes]) => `${sha256(bytes).slice("sha256:".length)}  ${name.slice(rootName.length + 1)}`)
		.sort()
		.join("\n")}\n`;
	entries.set(`${rootName}/checksums.sha256`, Buffer.from(finalChecksums));
	const archive = makeArchive(entries);
	const finalSource = await gitIdentity();
	if (finalSource.commit !== source.commit || finalSource.tree !== source.tree) {
		fail("product source identity changed while building the release archive");
	}
	await mkdir(options.outputRoot, { recursive: true, mode: 0o700 });
	const outputMetadata = await lstat(options.outputRoot);
	if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink() || (outputMetadata.mode & 0o777) !== 0o700)
		fail("product release output root must be one private directory");
	const archivePath = join(options.outputRoot, `${rootName}.tar.gz`);
	const archiveFile = await open(
		archivePath,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await archiveFile.writeFile(archive);
		await archiveFile.sync();
		await archiveFile.chmod(0o400);
	} finally {
		await archiveFile.close();
	}
	return Object.freeze({
		schemaVersion: ARCHIVE_SCHEMA,
		classification: options.developmentEvidence ? "development-evidence" : "release-candidate",
		archivePath,
		archiveSha256: sha256(archive),
		target,
		entries: Object.freeze([...entries.keys()].sort()),
		legal,
	});
}

if (import.meta.main) {
	const developmentEvidence = Bun.env.BB_DEVELOPMENT_EVIDENCE === "1";
	const receipt = await buildProductRelease({
		binaryPath: Bun.env.BB_BINARY_PATH ?? fail("BB_BINARY_PATH is required"),
		nativeAddonPath: Bun.env.BB_NATIVE_ADDON_PATH ?? fail("BB_NATIVE_ADDON_PATH is required"),
		outputRoot: Bun.env.BB_RELEASE_OUTPUT_ROOT ?? join(process.cwd(), "dist", "release"),
		productVersion: Bun.env.BB_PRODUCT_VERSION ?? fail("BB_PRODUCT_VERSION is required"),
		developmentEvidence,
		licensePath: Bun.env.BB_LICENSE_PATH,
		noticesPath: Bun.env.BB_NOTICES_PATH,
	});
	process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
