import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isJsonRecord, type JsonRecord } from "../canonical-json";
import { compileHarnessYaml, parseHarnessYaml } from "../compiler";
import { loadNativeLock, nativeLockPathForSpec } from "./lock-loader";
import { nativeLockValue } from "./lock-values";
import { assembleNativePrompts } from "./prompt-assembly";
import { loadNativeToolSurface } from "./tool-pack";
import type { NativeToolSurfacePack } from "./types";

export interface LoadNativeHarnessOptions {
	/** Harness spec (`bb.harness_definition.v1` YAML). Relative paths resolve against `workspaceRoot`. */
	readonly specPath: string;
	readonly workspaceRoot: string;
}

export interface LoadedNativeHarness {
	readonly specPath: string;
	readonly workspaceRoot: string;
	readonly lock: JsonRecord;
	readonly graphHash: string;
	/** Path of the precompiled lock that was verified against this compilation, if one exists. */
	readonly verifiedCachePath?: string;
	/** The compiled system prompt (`system_prompt_compiler.py` order, todo packs included). */
	readonly systemPrompt: string;
	/** The per-turn tool catalog Python frames into each user message. */
	readonly perTurnPrompt: string;
	readonly toolSurface: NativeToolSurfacePack;
	/** `providers.default_model`, an OMP `provider/model` selector. */
	readonly defaultModel?: string;
	readonly permissions: { readonly mode?: string; readonly shell?: string };
	readonly todos: { readonly enabled: boolean; readonly strict: boolean };
}

function contained(root: string, candidate: string): boolean {
	const rest = relative(root, candidate);
	return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

function posixRelative(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

/** Every `prompts.packs.<pack>.<role>` file path a spec names, relative to the spec's directory. */
function packResourcePaths(definition: JsonRecord): string[] {
	const prompts = definition.prompts;
	const packs = isJsonRecord(prompts) ? prompts.packs : undefined;
	if (!isJsonRecord(packs)) return [];
	const paths: string[] = [];
	for (const pack of Object.values(packs)) {
		if (!isJsonRecord(pack)) continue;
		for (const value of Object.values(pack)) if (typeof value === "string") paths.push(value);
	}
	return paths;
}

async function readResource(specDirectory: string, resource: string): Promise<Uint8Array> {
	if (resource.length === 0 || isAbsolute(resource)) {
		throw new Error(`native harness resource must be relative to its spec: ${resource}`);
	}
	const path = resolve(specDirectory, resource);
	if (!contained(specDirectory, path)) throw new Error(`native harness resource escapes its spec directory: ${resource}`);
	return new Uint8Array(await readFile(path));
}

function stringValue(lock: JsonRecord, path: string): string | undefined {
	const value = nativeLockValue(lock, path);
	return typeof value === "string" ? value : undefined;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Compile a harness spec into its effective lock and the session inputs it implies. A precompiled
 * lock beside the spec is only a cache: it must verify and match this compilation's `graph_hash`.
 */
export async function loadNativeHarness(options: LoadNativeHarnessOptions): Promise<LoadedNativeHarness> {
	const workspaceRoot = resolve(options.workspaceRoot);
	const specPath = resolve(workspaceRoot, options.specPath);
	if (!contained(workspaceRoot, specPath)) throw new Error(`native harness spec must be inside the workspace: ${specPath}`);
	const source = await readFile(specPath, "utf8");
	const sourceRef = posixRelative(workspaceRoot, specPath);
	const specDirectory = dirname(specPath);
	const resources = new Map<string, Uint8Array>();
	for (const resource of packResourcePaths(parseHarnessYaml(source))) {
		if (!resources.has(resource)) resources.set(resource, await readResource(specDirectory, resource));
	}
	const resourceInputs = new Map([...resources].map(([path, bytes]) => [`${sourceRef}::${path}`, bytes]));
	const { lock } = compileHarnessYaml(source, { sourceRef, resourceInputs });
	const graphHash = lock.graph_hash;
	if (typeof graphHash !== "string") throw new Error("native harness compilation produced no graph_hash");

	const cachePath = nativeLockPathForSpec(specPath);
	let verifiedCachePath: string | undefined;
	if (await exists(cachePath)) {
		const cached = await loadNativeLock(cachePath);
		if (cached.graphHash !== graphHash) {
			throw new Error(
				`native harness lock ${cachePath} is stale: it records ${cached.graphHash}, the spec compiles to ${graphHash}`,
			);
		}
		verifiedCachePath = cachePath;
	}

	const toolSurface = await loadNativeToolSurface(lock);
	const prompts = await assembleNativePrompts(lock, resources, toolSurface);
	return Object.freeze({
		specPath,
		workspaceRoot,
		lock,
		graphHash,
		...(verifiedCachePath === undefined ? {} : { verifiedCachePath }),
		systemPrompt: prompts.system,
		perTurnPrompt: prompts.perTurn,
		toolSurface,
		...(stringValue(lock, "providers.default_model") === undefined
			? {}
			: { defaultModel: stringValue(lock, "providers.default_model") }),
		permissions: Object.freeze({
			mode: stringValue(lock, "permissions.options.mode"),
			shell: stringValue(lock, "permissions.shell.default"),
		}),
		todos: Object.freeze({
			enabled: nativeLockValue(lock, "features.todos.enabled") === true,
			strict: nativeLockValue(lock, "features.todos.strict") === true,
		}),
	});
}
