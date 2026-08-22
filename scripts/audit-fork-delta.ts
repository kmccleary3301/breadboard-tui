#!/usr/bin/env bun

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { readTarNoticeMembers } from "./generate-third-party-notices";
import { classifyPath, loadSyncPolicy, matchesPolicyPattern, type SyncPolicy } from "./inspect-upstream-sync";

export const POLICY_PATH = path.resolve(import.meta.dir, "p31", "upstream-sync-policy.json");
export const MANIFEST_PATH = path.resolve(import.meta.dir, "fork-layer-manifest.json");
export const DEFAULT_RECEIPT_JSON = "artifacts/fork-delta-audit.json";
export const DEFAULT_RECEIPT_MARKDOWN = "artifacts/fork-delta-audit.md";
export const RECEIPT_SCHEMA = "bb-omp.delta-audit.v1" as const;

const CLASSES = ["breadboard-owned", "upstream-owned", "generated", "manual-review"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SDK_IMPORT = /(?:from\s*|import\s*\(\s*)["']@breadboard\/sdk(?:\/[^"']*)?["']/g;
const BREADBOARD_LITERAL =
	/@breadboard\/sdk|https?:\/\/[^\s"'`]*breadboard[^\s"'`]*|\b(?:BreadBoard|BREADBOARD_[A-Z0-9_]+|P30_[A-Z0-9_]+|workspace:v1:sha256:|breadboard:[a-z][a-z0-9_-]*)\b/i;
const INLINE_BREADBOARD =
	/@breadboard\/sdk|https?:\/\/[^\s"'`]*breadboard[^\s"'`]*|\b(?:BreadBoard|BREADBOARD_[A-Z0-9_]+|P30_[A-Z0-9_]+|workspace:v1:sha256:|breadboard:[a-z][a-z0-9_-]*)\b/i;

type DeltaClass = (typeof CLASSES)[number];

export interface PolicyManualBoundary {
	readonly id: string;
	readonly owner: string;
	readonly layer: number;
	readonly patterns: readonly string[];
}

export interface DeltaPolicy extends SyncPolicy {
	readonly schemaVersion: "bb-omp.delta-policy.v1";
	readonly upstream: {
		readonly tag: string;
		readonly commit: string;
		readonly tree: string;
	};
	readonly budgets: {
		readonly maxTotalChangedPaths: number;
		readonly maxUpstreamEntrypointPaths: number;
	};
	readonly manualBoundaries: readonly PolicyManualBoundary[];
	readonly upstreamEntrypoints: readonly string[];
	readonly adapters: {
		readonly sdkImports: readonly string[];
		readonly endpointAndSchemaLiterals: readonly string[];
	};
	readonly distribution: DistributionPolicy;
	readonly receiptPaths?: {
		readonly json: string;
		readonly markdown: string;
	};
}

interface DistributionPolicy {
	readonly packageRoot: string;
	readonly packageName: string;
	readonly packageVersion: string;
	readonly artifactPath: string;
	readonly provenancePath: string;
	readonly packageLicensePath: string;
	readonly noticeBundlePath: string;
	readonly noticeManifestPath: string;
	readonly expectedSdkDependency: string;
	readonly expectedSdkLicenseAssertion: string;
}

export interface ManifestPathEntry {
	readonly path: string;
	readonly class: DeltaClass;
	readonly rule: string;
	readonly owner?: string;
	readonly layer?: number;
}

export interface ForkLayerManifest {
	readonly schemaVersion: "bb-omp.delta-manifest.v2";
	readonly policySchemaVersion: "bb-omp.delta-policy.v1";
	readonly upstream: {
		readonly tag: string;
		readonly commit: string;
		readonly tree: string;
	};
	readonly paths: readonly ManifestPathEntry[];
}

export interface ChangedPathRecord {
	readonly status: string;
	readonly path: string;
	readonly oldPath?: string;
}

export interface ClassifiedDeltaPath {
	readonly path: string;
	readonly status: string;
	readonly oldPath?: string;
	readonly class: DeltaClass;
	readonly rule: string;
	readonly declared: boolean;
	readonly owner?: string;
	readonly layer?: number;
}

export interface AuditViolation {
	readonly code:
		| "upstream-identity"
		| "manifest"
		| "unknown-path"
		| "budget"
		| "manual-boundary"
		| "adapter-boundary"
		| "monorepo-dependency"
		| "inline-breadboard"
		| "distribution";
	readonly path?: string;
	readonly detail: string;
}

export interface ForkDeltaReceipt {
	readonly schemaVersion: typeof RECEIPT_SCHEMA;
	readonly status: "pass" | "fail";
	readonly upstream: {
		readonly tag: string;
		readonly expectedCommit: string;
		readonly observedCommit: string | null;
		readonly expectedTree: string;
		readonly observedTree: string | null;
	};
	readonly candidate: {
		readonly commit: string | null;
		readonly tree: string | null;
	};
	readonly delta: {
		readonly changedPathCount: number;
		readonly renameCount: number;
		readonly paths: readonly ClassifiedDeltaPath[];
	};
	readonly budgets: {
		readonly maxTotalChangedPaths: number | null;
		readonly maxUpstreamEntrypointPaths: number | null;
		readonly upstreamEntrypointPaths: number;
	};
	readonly checks: Readonly<Record<string, "pass" | "fail" | "skipped">>;
	readonly violations: readonly AuditViolation[];
}

export interface AuditOptions {
	readonly repoRoot?: string;
	readonly policyPath?: string;
	readonly manifestPath?: string;
	readonly receiptDir?: string;
	readonly writeReceipts?: boolean;
}

interface GitIdentity {
	readonly upstreamCommit: string;
	readonly upstreamTree: string;
	readonly candidateCommit: string;
	readonly candidateTree: string;
}

interface AuditState {
	readonly policy: DeltaPolicy;
	readonly manifest: ForkLayerManifest;
	readonly identity: GitIdentity;
	readonly records: readonly ChangedPathRecord[];
	readonly paths: readonly string[];
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function runGit(repoRoot: string, args: readonly string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		const stderr = Buffer.from(result.stderr).toString("utf8").trim();
		throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
	}
	return Buffer.from(result.stdout).toString("utf8");
}

function parseNul(output: string): string[] {
	return output.split("\0").filter(Boolean);
}

function parseDiffRecords(output: string): ChangedPathRecord[] {
	const fields = parseNul(output);
	const records: ChangedPathRecord[] = [];
	for (let index = 0; index < fields.length; ) {
		const status = fields[index++] ?? "";
		if (/^[RC]/.test(status)) {
			const oldPath = fields[index++];
			const newPath = fields[index++];
			if (oldPath && newPath)
				records.push({ status, oldPath: normalizePath(oldPath), path: normalizePath(newPath) });
			continue;
		}
		const changedPath = fields[index++];
		if (changedPath) records.push({ status, path: normalizePath(changedPath) });
	}
	return records;
}

function parseStatusRecords(output: string): ChangedPathRecord[] {
	const fields = parseNul(output);
	const records: ChangedPathRecord[] = [];
	for (let index = 0; index < fields.length; ) {
		const entry = fields[index++] ?? "";
		if (entry.length < 3) continue;
		const status = entry.slice(0, 2).trim() || entry.slice(0, 2);
		const firstPath = normalizePath(entry.slice(3));
		if (/R/.test(entry.slice(0, 2))) {
			const newPath = fields[index++];
			if (newPath) records.push({ status, oldPath: firstPath, path: normalizePath(newPath) });
		} else if (firstPath) {
			records.push({ status, path: firstPath });
		}
	}
	return records;
}

function receiptPathSet(policy: DeltaPolicy): Set<string> {
	return new Set([
		normalizePath(policy.receiptPaths?.json ?? DEFAULT_RECEIPT_JSON),
		normalizePath(policy.receiptPaths?.markdown ?? DEFAULT_RECEIPT_MARKDOWN),
	]);
}

function collectChanged(repoRoot: string, policy: DeltaPolicy): { records: ChangedPathRecord[]; paths: string[] } {
	const diff = parseDiffRecords(
		runGit(repoRoot, [
			"diff",
			"--name-status",
			"--find-renames",
			"--no-ext-diff",
			"--no-textconv",
			"-z",
			`${policy.upstream.tag}^{commit}`,
			"HEAD",
			"--",
		]),
	);
	const status = parseStatusRecords(runGit(repoRoot, ["status", "--short", "--untracked-files=all", "-z"]));
	const ignored = receiptPathSet(policy);
	const recordsByPath = new Map<string, ChangedPathRecord>();
	for (const record of [...diff, ...status]) {
		for (const candidate of [record.path, record.oldPath]) {
			if (!candidate || ignored.has(candidate)) continue;
			const existing = recordsByPath.get(candidate);
			if (!existing || record.status.startsWith("R")) recordsByPath.set(candidate, { ...record, path: candidate });
		}
	}
	const records = [...recordsByPath.values()].sort((left, right) => compare(left.path, right.path));
	return { records, paths: records.map(record => record.path) };
}

function validatePolicy(raw: unknown): asserts raw is DeltaPolicy {
	if (!isRecord(raw)) throw new Error("delta policy must be an object");
	if (raw.schemaVersion !== "bb-omp.delta-policy.v1") throw new Error("unsupported delta policy schema");
	if (!isRecord(raw.upstream) || !isRecord(raw.budgets) || !isRecord(raw.adapters) || !isRecord(raw.distribution)) {
		throw new Error("delta policy is missing upstream, budgets, adapters, or distribution");
	}
	for (const field of ["tag", "commit", "tree"] as const) assertString(raw.upstream[field], `upstream.${field}`);
	if (!/^[0-9a-f]{40,64}$/.test(raw.upstream.commit) || !/^[0-9a-f]{40,64}$/.test(raw.upstream.tree)) {
		throw new Error("upstream commit/tree must be full git object ids");
	}
	for (const field of ["maxTotalChangedPaths", "maxUpstreamEntrypointPaths"] as const) {
		if (!Number.isSafeInteger(raw.budgets[field]) || raw.budgets[field] < 1)
			throw new Error(`budgets.${field} must be a positive integer`);
	}
	if (!Array.isArray(raw.manualBoundaries) || raw.manualBoundaries.length === 0)
		throw new Error("manualBoundaries must be non-empty");
	const layers = raw.manualBoundaries.map(boundary => {
		if (!isRecord(boundary)) throw new Error("manual boundary must be an object");
		assertString(boundary.id, "manual boundary id");
		assertString(boundary.owner, `manual boundary ${boundary.id} owner`);
		if (!Number.isSafeInteger(boundary.layer) || boundary.layer < 1)
			throw new Error(`manual boundary ${boundary.id} layer must be positive`);
		if (!Array.isArray(boundary.patterns) || boundary.patterns.length === 0)
			throw new Error(`manual boundary ${boundary.id} patterns must be non-empty`);
		return boundary.layer;
	});
	if (layers.some((layer, index) => index > 0 && layer <= layers[index - 1]!))
		throw new Error("manual boundary layers must be strictly ordered");
	if (
		!Array.isArray(raw.upstreamEntrypoints) ||
		raw.upstreamEntrypoints.length === 0 ||
		raw.upstreamEntrypoints.some(value => typeof value !== "string")
	) {
		throw new Error("upstreamEntrypoints must be a non-empty string array");
	}
	for (const field of ["sdkImports", "endpointAndSchemaLiterals"] as const) {
		if (
			!Array.isArray(raw.adapters[field]) ||
			raw.adapters[field].length === 0 ||
			raw.adapters[field].some(value => typeof value !== "string")
		) {
			throw new Error(`adapters.${field} must be a non-empty string array`);
		}
	}
	for (const field of [
		"packageRoot",
		"packageName",
		"packageVersion",
		"artifactPath",
		"provenancePath",
		"packageLicensePath",
		"noticeBundlePath",
		"noticeManifestPath",
		"expectedSdkDependency",
		"expectedSdkLicenseAssertion",
	] as const)
		assertString(raw.distribution[field], `distribution.${field}`);
}

export async function loadDeltaPolicy(policyPath = POLICY_PATH): Promise<DeltaPolicy> {
	const raw = JSON.parse(await Bun.file(policyPath).text()) as unknown;
	validatePolicy(raw);
	const syncPolicy = await loadSyncPolicy(policyPath);
	return { ...syncPolicy, ...raw } as DeltaPolicy;
}

export async function loadForkManifest(manifestPath = MANIFEST_PATH): Promise<ForkLayerManifest> {
	const raw = JSON.parse(await Bun.file(manifestPath).text()) as unknown;
	if (
		!isRecord(raw) ||
		raw.schemaVersion !== "bb-omp.delta-manifest.v2" ||
		raw.policySchemaVersion !== "bb-omp.delta-policy.v1"
	) {
		throw new Error("unsupported fork layer manifest schema");
	}
	if (!isRecord(raw.upstream)) throw new Error("manifest upstream identity is missing");
	for (const field of ["tag", "commit", "tree"] as const)
		assertString(raw.upstream[field], `manifest upstream.${field}`);
	if (!Array.isArray(raw.paths)) throw new Error("manifest paths must be an array");
	const entries = raw.paths.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`manifest path ${index} must be an object`);
		assertString(entry.path, `manifest path ${index}.path`);
		assertString(entry.rule, `manifest path ${entry.path}.rule`);
		if (!CLASSES.includes(entry.class as DeltaClass))
			throw new Error(`manifest path ${entry.path} has an invalid class`);
		if (entry.owner !== undefined && (typeof entry.owner !== "string" || entry.owner.length === 0))
			throw new Error(`manifest path ${entry.path} owner is invalid`);
		if (entry.layer !== undefined && (!Number.isSafeInteger(entry.layer) || entry.layer < 1))
			throw new Error(`manifest path ${entry.path} layer is invalid`);
		return entry as unknown as ManifestPathEntry;
	});
	const paths = entries.map(entry => normalizePath(entry.path));
	if (new Set(paths).size !== paths.length) throw new Error("manifest paths must be unique");
	return {
		...raw,
		paths: entries.map(entry => ({ ...entry, path: normalizePath(entry.path) })),
	} as unknown as ForkLayerManifest;
}

export function assertManifestUpstreamIdentity(manifest: ForkLayerManifest, policy: DeltaPolicy): void {
	for (const field of ["tag", "commit", "tree"] as const) {
		if (manifest.upstream[field] !== policy.upstream[field]) {
			throw new Error(
				`manifest upstream.${field} does not match policy upstream.${field}: ` +
					`${manifest.upstream[field]} != ${policy.upstream[field]}`,
			);
		}
	}
}

function readIdentity(repoRoot: string, policy: DeltaPolicy): GitIdentity {
	const upstreamCommit = runGit(repoRoot, [
		"rev-parse",
		"--verify",
		`refs/tags/${policy.upstream.tag}^{commit}`,
	]).trim();
	const upstreamTree = runGit(repoRoot, ["rev-parse", "--verify", `refs/tags/${policy.upstream.tag}^{tree}`]).trim();
	const candidateCommit = runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	const candidateTree = runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{tree}"]).trim();
	return { upstreamCommit, upstreamTree, candidateCommit, candidateTree };
}

function matchingBoundary(filePath: string, policy: DeltaPolicy): PolicyManualBoundary | undefined {
	return policy.manualBoundaries.find(boundary =>
		boundary.patterns.some(pattern => matchesPolicyPattern(filePath, pattern)),
	);
}

export interface DeclarationAudit {
	readonly paths: readonly ClassifiedDeltaPath[];
	readonly violations: readonly AuditViolation[];
}

export function auditDeclarations(
	changedRecords: readonly ChangedPathRecord[],
	manifest: ForkLayerManifest,
	policy: DeltaPolicy,
): DeclarationAudit {
	const declarations = new Map(manifest.paths.map(entry => [normalizePath(entry.path), entry]));
	const paths: ClassifiedDeltaPath[] = [];
	const violations: AuditViolation[] = [];
	for (const record of [...changedRecords].sort((left, right) => compare(left.path, right.path))) {
		const normalized = normalizePath(record.path);
		const classification = classifyPath(normalized, policy);
		const declaration = declarations.get(normalized);
		const entry: ClassifiedDeltaPath = {
			path: normalized,
			status: record.status,
			...(record.oldPath === undefined ? {} : { oldPath: normalizePath(record.oldPath) }),
			class: classification.class,
			rule: classification.rule,
			declared: declaration !== undefined,
			...(declaration?.owner === undefined ? {} : { owner: declaration.owner }),
			...(declaration?.layer === undefined ? {} : { layer: declaration.layer }),
		};
		paths.push(entry);
		if (classification.rule === "manual-review-unknown") {
			violations.push({
				code: "unknown-path",
				path: normalized,
				detail: "path did not match an ordered delta-policy rule",
			});
			continue;
		}
		if (!declaration) {
			if (classification.class === "manual-review") {
				violations.push({
					code: "manifest",
					path: normalized,
					detail: "manual boundary path is absent from the migrated manifest",
				});
			}
			continue;
		}
		if (declaration.class !== classification.class || declaration.rule !== classification.rule) {
			violations.push({
				code: "manifest",
				path: normalized,
				detail: `manifest declares ${declaration.class}/${declaration.rule}, policy resolves ${classification.class}/${classification.rule}`,
			});
		}
		if (classification.class === "manual-review") {
			const boundary = matchingBoundary(normalized, policy);
			if (!boundary) {
				violations.push({
					code: "manual-boundary",
					path: normalized,
					detail: "manual-review path has no declared owner/layer boundary",
				});
			} else if (declaration.owner !== boundary.owner || declaration.layer !== boundary.layer) {
				violations.push({
					code: "manual-boundary",
					path: normalized,
					detail: `manual boundary must declare owner ${boundary.owner} and ordered layer ${boundary.layer}`,
				});
			}
		}
	}
	return { paths, violations };
}

async function inspectAdapters(repoRoot: string, state: AuditState): Promise<AuditViolation[]> {
	const violations: AuditViolation[] = [];
	for (const entry of state.records) {
		const absolute = path.resolve(repoRoot, entry.path);
		let text: string;
		try {
			text = await Bun.file(absolute).text();
		} catch {
			continue;
		}
		if (!SOURCE_EXTENSIONS.has(path.extname(entry.path).toLowerCase())) continue;
		if (SDK_IMPORT.test(text)) {
			SDK_IMPORT.lastIndex = 0;
			if (!state.policy.adapters.sdkImports.some(pattern => matchesPolicyPattern(entry.path, pattern))) {
				violations.push({
					code: "adapter-boundary",
					path: entry.path,
					detail: "@breadboard/sdk import is outside a declared adapter",
				});
			}
		}
		if (
			BREADBOARD_LITERAL.test(text) &&
			!state.policy.adapters.endpointAndSchemaLiterals.some(pattern => matchesPolicyPattern(entry.path, pattern))
		) {
			violations.push({
				code: "adapter-boundary",
				path: entry.path,
				detail: "BreadBoard endpoint/schema literal is outside a declared adapter",
			});
		}
	}
	return violations;
}

export async function readChangedPathPatch(
	repoRoot: string,
	upstreamTag: string,
	entry: Pick<ClassifiedDeltaPath, "path" | "status">,
): Promise<string> {
	if (entry.status === "??") {
		try {
			const text = await Bun.file(path.resolve(repoRoot, entry.path)).text();
			return text
				.split(/\r?\n/)
				.map(line => `+${line}`)
				.join("\n");
		} catch {
			return "";
		}
	}
	return runGit(repoRoot, [
		"diff",
		"--unified=0",
		"--no-ext-diff",
		"--no-textconv",
		`${upstreamTag}^{commit}`,
		"--",
		entry.path,
	]);
}

async function inspectUpstreamInlineLogic(
	repoRoot: string,
	state: AuditState,
	declarations: DeclarationAudit,
): Promise<AuditViolation[]> {
	const violations: AuditViolation[] = [];
	for (const entry of declarations.paths) {
		if (entry.class !== "upstream-owned") continue;
		const diff = await readChangedPathPatch(repoRoot, state.policy.upstream.tag, entry);
		for (const line of diff.split(/\r?\n/)) {
			if (!line.startsWith("+") || line.startsWith("+++")) continue;
			if (INLINE_BREADBOARD.test(line)) {
				violations.push({
					code: "inline-breadboard",
					path: entry.path,
					detail: "upstream-owned diff adds inline BreadBoard logic",
				});
				break;
			}
		}
	}
	return violations;
}

function dependencyValues(value: unknown): string[] {
	if (!isRecord(value)) return [];
	const values: string[] = [];
	for (const section of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
		"overrides",
	] as const) {
		const sectionValue = value[section];
		if (!isRecord(sectionValue)) continue;
		for (const dependency of Object.values(sectionValue)) if (typeof dependency === "string") values.push(dependency);
	}
	return values;
}

async function inspectFilesystemDependencies(repoRoot: string, state: AuditState): Promise<AuditViolation[]> {
	const violations: AuditViolation[] = [];
	for (const entry of state.records.filter(item => item.path.endsWith("package.json"))) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await Bun.file(path.resolve(repoRoot, entry.path)).text());
		} catch {
			continue;
		}
		for (const dependency of dependencyValues(parsed)) {
			const allowedSdk =
				entry.path === "packages/coding-agent/package.json" &&
				dependency === state.policy.distribution.expectedSdkDependency;
			if (!allowedSdk && /^(?:workspace:|link:|file:)/.test(dependency)) {
				violations.push({
					code: "monorepo-dependency",
					path: entry.path,
					detail: `filesystem dependency ${dependency} is not permitted`,
				});
			}
		}
	}
	return violations;
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sha512Base64(bytes: Uint8Array): string {
	return createHash("sha512").update(bytes).digest("base64");
}

function tarString(bytes: Uint8Array, offset: number, length: number): string {
	const field = bytes.subarray(offset, offset + length);
	const nul = field.indexOf(0);
	return new TextDecoder().decode(nul === -1 ? field : field.subarray(0, nul));
}

function tarSize(bytes: Uint8Array, offset: number, length: number): number {
	const value = tarString(bytes, offset, length).trim();
	if (!/^[0-7]+$/.test(value)) throw new Error("bundled SDK tar member has an invalid size");
	return Number.parseInt(value, 8);
}

function readTarMember(archiveBytes: Uint8Array, wantedPath: string): Uint8Array | undefined {
	const tarBytes = new Uint8Array(gunzipSync(archiveBytes));
	for (let offset = 0; offset + 512 <= tarBytes.byteLength; ) {
		const header = tarBytes.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) return undefined;
		const name = tarString(header, 0, 100);
		const prefix = tarString(header, 345, 155);
		const memberPath = prefix ? `${prefix}/${name}` : name;
		const size = tarSize(header, 124, 12);
		const dataStart = offset + 512;
		const dataEnd = dataStart + size;
		if (dataEnd > tarBytes.byteLength) throw new Error("bundled SDK tar member is truncated");
		if (memberPath === wantedPath && (header[156] === 0 || header[156] === 48))
			return tarBytes.slice(dataStart, dataEnd);
		offset = dataStart + Math.ceil(size / 512) * 512;
	}
	return undefined;
}

function assertEqual(actual: unknown, expected: unknown, detail: string): void {
	if (actual !== expected) throw new Error(`${detail}: expected ${String(expected)}, observed ${String(actual)}`);
}

async function verifyDistribution(repoRoot: string, policy: DeltaPolicy): Promise<void> {
	const distribution = policy.distribution;
	const packageRoot = path.resolve(repoRoot, distribution.packageRoot);
	const packageJson = JSON.parse(await Bun.file(path.join(packageRoot, "package.json")).text()) as Record<
		string,
		unknown
	>;
	const dependencies = isRecord(packageJson.dependencies) ? packageJson.dependencies : {};
	assertEqual(dependencies["@breadboard/sdk"], distribution.expectedSdkDependency, "@breadboard/sdk dependency");
	const artifactBytes = new Uint8Array(
		await Bun.file(path.resolve(repoRoot, distribution.artifactPath)).arrayBuffer(),
	);
	const provenanceBytes = new Uint8Array(
		await Bun.file(path.resolve(repoRoot, distribution.provenancePath)).arrayBuffer(),
	);
	const provenance = JSON.parse(new TextDecoder().decode(provenanceBytes)) as Record<string, unknown>;
	assertEqual(provenance.schemaVersion, "p30.breadboard-sdk-provenance.v1", "SDK provenance schema");
	assertEqual(provenance.packageName, distribution.packageName, "SDK provenance package name");
	assertEqual(provenance.packageVersion, distribution.packageVersion, "SDK provenance package version");
	assertEqual(provenance.artifactPath, "./vendor/breadboard-sdk-0.3.0.tgz", "SDK provenance artifact path");
	assertEqual(provenance.artifactSha256, sha256(artifactBytes), "SDK artifact sha256");
	assertEqual(provenance.artifactSha512Base64, sha512Base64(artifactBytes), "SDK artifact sha512");
	assertEqual(provenance.artifactSizeBytes, artifactBytes.byteLength, "SDK artifact byte size");
	const packageMember = readTarMember(artifactBytes, "package/package.json");
	if (!packageMember) throw new Error("SDK tarball is missing package/package.json");
	const sdkPackage = JSON.parse(new TextDecoder().decode(packageMember)) as Record<string, unknown>;
	assertEqual(sdkPackage.name, distribution.packageName, "SDK tarball package name");
	assertEqual(sdkPackage.version, distribution.packageVersion, "SDK tarball package version");
	assertString(sdkPackage.main, "SDK tarball main");
	assertString(sdkPackage.types, "SDK tarball types");
	if (!isRecord(sdkPackage.exports)) throw new Error("SDK tarball package exports are missing");
	const licenseBytes = new Uint8Array(
		await Bun.file(path.resolve(repoRoot, distribution.packageLicensePath)).arrayBuffer(),
	);
	if (licenseBytes.byteLength === 0) throw new Error("package license is empty");
	const noticeManifest = JSON.parse(
		await Bun.file(path.resolve(repoRoot, distribution.noticeManifestPath)).text(),
	) as Record<string, unknown>;
	if (!isRecord(noticeManifest.bundle) || !isRecord(noticeManifest.packageLicense) || !isRecord(noticeManifest.sdk))
		throw new Error("third-party notice manifest is incomplete");
	const bundleBytes = new Uint8Array(
		await Bun.file(path.resolve(repoRoot, distribution.noticeBundlePath)).arrayBuffer(),
	);
	assertEqual(noticeManifest.bundle.sha256, sha256(bundleBytes), "notice bundle sha256");
	assertEqual(noticeManifest.bundle.bytes, bundleBytes.byteLength, "notice bundle byte size");
	assertEqual(noticeManifest.packageLicense.sha256, sha256(licenseBytes), "package license sha256");
	assertEqual(noticeManifest.sdk.artifactSha256, sha256(artifactBytes), "notice SDK artifact sha256");
	assertEqual(noticeManifest.sdk.provenanceSha256, sha256(provenanceBytes), "notice provenance sha256");
	assertEqual(noticeManifest.sdk.licenseAssertion, distribution.expectedSdkLicenseAssertion, "SDK license assertion");
	const noticeText = new TextDecoder().decode(bundleBytes);
	if (!noticeText.startsWith("BREADBOARD / OMP DISTRIBUTION NOTICE BUNDLE\n"))
		throw new Error("notice bundle header is invalid");
	if (!noticeText.includes(`Package: ${distribution.packageName}@${distribution.packageVersion}`))
		throw new Error("notice bundle lacks SDK package provenance");
	const archiveNoticeMembers = readTarNoticeMembers(artifactBytes);
	assertEqual(
		noticeManifest.sdk.licenseNoticeMemberPresent,
		archiveNoticeMembers.length > 0,
		"SDK notice member presence",
	);
	const check = Bun.spawnSync(["bun", "scripts/generate-third-party-notices.ts", "--check"], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (check.exitCode !== 0) throw new Error("third-party notices are not reproducible");
}

function validateIdentity(identity: GitIdentity, policy: DeltaPolicy): AuditViolation[] {
	const violations: AuditViolation[] = [];
	if (identity.upstreamCommit !== policy.upstream.commit)
		violations.push({
			code: "upstream-identity",
			detail: `upstream tag ${policy.upstream.tag} resolves to ${identity.upstreamCommit}, expected ${policy.upstream.commit}`,
		});
	if (identity.upstreamTree !== policy.upstream.tree)
		violations.push({
			code: "upstream-identity",
			detail: `upstream tag ${policy.upstream.tag} tree is ${identity.upstreamTree}, expected ${policy.upstream.tree}`,
		});
	return violations;
}

function createFailureReceipt(detail: string): ForkDeltaReceipt {
	return {
		schemaVersion: RECEIPT_SCHEMA,
		status: "fail",
		upstream: {
			tag: "unknown",
			expectedCommit: "unknown",
			observedCommit: null,
			expectedTree: "unknown",
			observedTree: null,
		},
		candidate: { commit: null, tree: null },
		delta: { changedPathCount: 0, renameCount: 0, paths: [] },
		budgets: { maxTotalChangedPaths: null, maxUpstreamEntrypointPaths: null, upstreamEntrypointPaths: 0 },
		checks: { policy: "fail" },
		violations: [{ code: "upstream-identity", detail }],
	};
}

function markdownReceipt(receipt: ForkDeltaReceipt): string {
	const lines = [
		"# Fork delta audit receipt",
		"",
		`- Schema: \`${receipt.schemaVersion}\``,
		`- Status: **${receipt.status}**`,
		`- Changed paths: ${receipt.delta.changedPathCount}`,
		`- Renames: ${receipt.delta.renameCount}`,
		"",
		"## Upstream identity",
		"",
		`- Tag: \`${receipt.upstream.tag}\``,
		`- Commit: expected \`${receipt.upstream.expectedCommit}\`, observed \`${receipt.upstream.observedCommit ?? "unavailable"}\``,
		`- Tree: expected \`${receipt.upstream.expectedTree}\`, observed \`${receipt.upstream.observedTree ?? "unavailable"}\``,
		"",
		"## Checks",
		"",
	];
	for (const [name, status] of Object.entries(receipt.checks).sort(([left], [right]) => compare(left, right)))
		lines.push(`- ${name}: ${status}`);
	lines.push(
		"",
		"## Paths",
		"",
		"| Path | Class | Rule | Declared | Owner | Layer |",
		"| --- | --- | --- | --- | --- | --- |",
	);
	for (const entry of receipt.delta.paths)
		lines.push(
			`| ${entry.path} | ${entry.class} | ${entry.rule} | ${entry.declared ? "yes" : "no"} | ${entry.owner ?? ""} | ${entry.layer ?? ""} |`,
		);
	lines.push("", "## Violations", "");
	if (receipt.violations.length === 0) lines.push("None.");
	else
		for (const violation of receipt.violations)
			lines.push(`- **${violation.code}**${violation.path ? ` \`${violation.path}\`` : ""}: ${violation.detail}`);
	return `${lines.join("\n")}\n`;
}

export async function writeReceipts(receipt: ForkDeltaReceipt, receiptDir: string): Promise<void> {
	await fs.mkdir(receiptDir, { recursive: true });
	await Bun.write(path.join(receiptDir, "fork-delta-audit.json"), `${JSON.stringify(receipt, null, 2)}\n`);
	await Bun.write(path.join(receiptDir, "fork-delta-audit.md"), markdownReceipt(receipt));
}

export async function auditForkDelta(options: AuditOptions = {}): Promise<ForkDeltaReceipt> {
	const repoRoot = path.resolve(options.repoRoot ?? path.resolve(import.meta.dir, ".."));
	let receipt: ForkDeltaReceipt;
	try {
		const policy = await loadDeltaPolicy(options.policyPath ?? POLICY_PATH);
		const manifest = await loadForkManifest(options.manifestPath ?? MANIFEST_PATH);
		assertManifestUpstreamIdentity(manifest, policy);
		const identity = readIdentity(repoRoot, policy);
		const collected = collectChanged(repoRoot, policy);
		const state: AuditState = { policy, manifest, identity, records: collected.records, paths: collected.paths };
		const declarationAudit = auditDeclarations(collected.records, manifest, policy);
		const violations: AuditViolation[] = [...validateIdentity(identity, policy), ...declarationAudit.violations];
		const upstreamEntrypointPaths = collected.paths.filter(pathValue =>
			policy.upstreamEntrypoints.some(pattern => matchesPolicyPattern(pathValue, pattern)),
		).length;
		if (collected.paths.length > policy.budgets.maxTotalChangedPaths)
			violations.push({
				code: "budget",
				detail: `changed path count ${collected.paths.length} exceeds total budget ${policy.budgets.maxTotalChangedPaths}`,
			});
		if (upstreamEntrypointPaths > policy.budgets.maxUpstreamEntrypointPaths)
			violations.push({
				code: "budget",
				detail: `upstream entrypoint count ${upstreamEntrypointPaths} exceeds budget ${policy.budgets.maxUpstreamEntrypointPaths}`,
			});
		violations.push(...(await inspectAdapters(repoRoot, state)));
		violations.push(...(await inspectUpstreamInlineLogic(repoRoot, state, declarationAudit)));
		violations.push(...(await inspectFilesystemDependencies(repoRoot, state)));
		const checks: Record<string, "pass" | "fail" | "skipped"> = {
			adapters: violations.some(violation => violation.code === "adapter-boundary") ? "fail" : "pass",
			budgets:
				collected.paths.length <= policy.budgets.maxTotalChangedPaths &&
				upstreamEntrypointPaths <= policy.budgets.maxUpstreamEntrypointPaths
					? "pass"
					: "fail",
			distribution: "pass",
			manifest: declarationAudit.violations.length === 0 ? "pass" : "fail",
			monorepoDependencies: "pass",
			upstreamIdentity: validateIdentity(identity, policy).length === 0 ? "pass" : "fail",
			upstreamInlineLogic: "pass",
		};
		if (violations.some(violation => violation.code === "inline-breadboard")) checks.upstreamInlineLogic = "fail";
		if (violations.some(violation => violation.code === "monorepo-dependency")) checks.monorepoDependencies = "fail";
		try {
			await verifyDistribution(repoRoot, policy);
		} catch (error) {
			checks.distribution = "fail";
			violations.push({ code: "distribution", detail: error instanceof Error ? error.message : String(error) });
		}
		receipt = {
			schemaVersion: RECEIPT_SCHEMA,
			status: violations.length === 0 ? "pass" : "fail",
			upstream: {
				tag: policy.upstream.tag,
				expectedCommit: policy.upstream.commit,
				observedCommit: identity.upstreamCommit,
				expectedTree: policy.upstream.tree,
				observedTree: identity.upstreamTree,
			},
			candidate: { commit: identity.candidateCommit, tree: identity.candidateTree },
			delta: {
				changedPathCount: collected.paths.length,
				renameCount: collected.records.filter(record => record.oldPath !== undefined).length,
				paths: declarationAudit.paths,
			},
			budgets: {
				maxTotalChangedPaths: policy.budgets.maxTotalChangedPaths,
				maxUpstreamEntrypointPaths: policy.budgets.maxUpstreamEntrypointPaths,
				upstreamEntrypointPaths,
			},
			checks,
			violations,
		};
	} catch (error) {
		receipt = createFailureReceipt(error instanceof Error ? error.message : String(error));
	}
	if (options.writeReceipts !== false)
		await writeReceipts(receipt, path.resolve(options.receiptDir ?? path.dirname(DEFAULT_RECEIPT_JSON)));
	return receipt;
}

if (import.meta.main) {
	const receiptDirArgumentIndex = process.argv.indexOf("--receipt-dir");
	const receiptDir = receiptDirArgumentIndex >= 0 ? process.argv[receiptDirArgumentIndex + 1] : undefined;
	const result = await auditForkDelta({ ...(receiptDir ? { receiptDir } : {}) });
	console.log(JSON.stringify(result, null, 2));
	if (result.status !== "pass") process.exitCode = 1;
}
