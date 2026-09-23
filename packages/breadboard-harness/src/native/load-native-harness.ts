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

/**
 * Every prompt string that `_load_text` may read as a file: pack entries, mode prompts, and bare order tokens
 * (`system_prompt_compiler.py:379-410`, `:429`, `:560`). Multiline or longer-than-256 strings are always literal.
 */
function promptResourceCandidates(definition: JsonRecord): Set<string> {
	const candidates = new Set<string>();
	const add = (value: unknown): void => {
		if (typeof value === "string" && value.length > 0 && !value.includes("\n") && value.length <= 256) candidates.add(value);
	};
	const prompts = isJsonRecord(definition.prompts) ? definition.prompts : undefined;
	if (isJsonRecord(prompts?.packs)) {
		for (const pack of Object.values(prompts.packs)) if (isJsonRecord(pack)) Object.values(pack).forEach(add);
	}
	if (isJsonRecord(prompts?.injection)) {
		for (const order of Object.values(prompts.injection)) {
			if (!Array.isArray(order)) continue;
			for (const token of order) if (typeof token === "string" && token !== "mode_specific" && !token.startsWith("@pack(")) add(token);
		}
	}
	if (Array.isArray(definition.modes)) for (const mode of definition.modes) if (isJsonRecord(mode)) add(mode.prompt);
	return candidates;
}

/**
 * What `_load_text` yields for a prompt string: `undefined` when it names no path and so stays literal text, empty
 * bytes for a path it cannot read as text (a directory), else the file. Python resolves against the working directory
 * and the config's directories; a native harness resolves only inside its spec directory, and refuses a string that
 * names an existing path outside it.
 */
async function readResource(specDirectory: string, resource: string): Promise<{ bytes: Uint8Array; file: boolean } | undefined> {
	const path = resolve(specDirectory, resource);
	const info = await stat(path).catch(() => undefined);
	if (info === undefined) return undefined;
	if (isAbsolute(resource) || (path !== specDirectory && !contained(specDirectory, path))) {
		throw new Error(`native harness resource escapes its spec directory: ${resource}`);
	}
	return info.isFile() ? { bytes: new Uint8Array(await readFile(path)), file: true } : { bytes: new Uint8Array(), file: false };
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
	const promptTexts = new Map<string, Uint8Array>();
	const resourceInputs = new Map<string, Uint8Array>();
	for (const resource of promptResourceCandidates(parseHarnessYaml(source))) {
		const loaded = await readResource(specDirectory, resource);
		if (loaded === undefined) continue;
		promptTexts.set(resource, loaded.bytes);
		if (loaded.file) resourceInputs.set(`${sourceRef}::${resource}`, loaded.bytes);
	}
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
	const prompts = await assembleNativePrompts(lock, promptTexts, toolSurface);
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
