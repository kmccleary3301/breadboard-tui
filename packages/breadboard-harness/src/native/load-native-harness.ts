import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isJsonRecord, type JsonRecord } from "../canonical-json";
import { compileHarnessYaml, HarnessCompileError, parseHarnessYaml } from "../compiler";
import { builtinNativeHarness } from "./builtin-harnesses";
import { HOST_MODEL, nativeHostSurfaceMode } from "./host-surface";
import { loadNativeLock, nativeLockPathForSpec } from "./lock-loader";
import { nativeLockValue } from "./lock-values";
import { assembleNativePrompts } from "./prompt-assembly";
import { loadNativeToolSurfaces } from "./tool-pack";
import { allNativeToolSurface, createNativeStageMachine, type NativeHarnessStage } from "./stage-machine";
import type { NativeToolDefinition, NativeToolSurfacePack } from "./types";

export type NativeHarnessReloadErrorCode =
	| "builtin"
	| "compile"
	| "lock-mismatch"
	| "host-surface-refused"
	| "reload-failed";

export class NativeHarnessReloadError extends Error {
	override readonly name = "NativeHarnessReloadError";

	constructor(
		readonly code: NativeHarnessReloadErrorCode,
		readonly generation: number,
		message: string,
		options?: { readonly cause?: unknown },
	) {
		super(message, options);
	}
}

export interface LoadNativeHarnessOptions {
	/**
	 * A built-in harness id (`bb-omp.native`), or a harness spec (`bb.harness_definition.v1` YAML).
	 * Relative spec paths resolve against `workspaceRoot`.
	 */
	readonly specPath: string;
	readonly workspaceRoot: string;
}
export interface NativeHarnessGenerationChange {
	readonly previousGeneration: number;
	readonly generation: number;
	readonly harness: LoadedNativeHarness;
}

export interface NativeHarnessLiveState {
	readonly editable: boolean;
	readonly generation: number;
	current(): LoadedNativeHarness;
	reload(): Promise<LoadedNativeHarness>;
	subscribe(listener: (change: NativeHarnessGenerationChange) => void): () => void;
}


export interface LoadedNativeHarness {
	/** The built-in id, or the spec path relative to the workspace (`/`-separated). */
	readonly harnessId: string;
	/** Absolute spec path; for a built-in, its path under the package's `harnesses/` directory. */
	readonly specPath: string;
	readonly workspaceRoot: string;
	readonly lock: JsonRecord;
	readonly graphHash: string;
	/** Path of the precompiled lock that was verified against this compilation, if one exists. */
	readonly verifiedCachePath?: string;
	/**
	 * The session keeps the host's own tools, system prompt and, with `@host.model`, model selection.
	 * The harness adds no tools; `systemPrompt` holds the blocks it appends after the host prompt.
	 */
	readonly hostSurface: boolean;
	/** The initial stage's compiled system prompt; on a host surface, the blocks appended to the host prompt. */
	readonly systemPrompt: string;
	/** The initial stage's per-turn tool catalog. */
	readonly perTurnPrompt: string;
	/** The initial active mode's tool surface. */
	readonly toolSurface: NativeToolSurfacePack;
	/** Every declared mode, with its stage-specific prompt and tools. */
	readonly stages: readonly NativeHarnessStage[];
	/** The union registered with OMP so later stages can activate their tools. */
	readonly registeredToolSurface: NativeToolSurfacePack;
	/** `providers.default_model`, an OMP `provider/model` selector; absent for `@host.model`. */
	readonly defaultModel?: string;
	readonly permissions: { readonly mode?: string; readonly shell?: string };
	readonly todos: { readonly enabled: boolean; readonly strict: boolean };
	/** Shared live-edit state; built-in harnesses expose it only to return a typed refusal. */
	readonly live?: NativeHarnessLiveState;
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

/** A prompt resource's bytes; `file` is false for a path `_load_text` cannot read as text (a directory). */
type PromptResource = { bytes: Uint8Array; file: boolean };

/**
 * What `_load_text` yields for a prompt string: `undefined` when it names no path and so stays literal text, empty
 * bytes for a path it cannot read as text (a directory), else the file. Python resolves against the working directory
 * and the config's directories; a native harness resolves only inside its spec directory, and refuses a string that
 * names an existing path outside it.
 */
async function readResource(specDirectory: string, resource: string): Promise<PromptResource | undefined> {
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

interface HarnessSource {
	readonly harnessId: string;
	readonly specPath: string;
	readonly workspaceRoot: string;
	readonly source: string;
	readonly sourceRef: string;
	readonly readResource: (resource: string) => Promise<PromptResource | undefined>;
	/** A precompiled lock beside a workspace spec, verified as a cache. */
	readonly cachePath?: string;
}

function bindWorkspaceDescription(tool: NativeToolDefinition, workspaceRoot: string): NativeToolDefinition {
	const description = tool.description.replace(/All commands run in\s+.*?\s+by default\./su, `All commands run in ${workspaceRoot} by default.`);
	return description === tool.description ? tool : { ...tool, description };
}

function bindWorkspaceSurface(surface: NativeToolSurfacePack, workspaceRoot: string): NativeToolSurfacePack {
	const bind = (tool: NativeToolDefinition): NativeToolDefinition => bindWorkspaceDescription(tool, workspaceRoot);
	return Object.freeze({
		mode: surface.mode,
		native: Object.freeze(surface.native.map(bind)),
		textInvoked: Object.freeze(surface.textInvoked.map(bind)),
	});
}

async function compileNativeHarness(input: HarnessSource): Promise<LoadedNativeHarness> {
	const promptTexts = new Map<string, Uint8Array>();
	const resourceInputs = new Map<string, Uint8Array>();
	for (const resource of promptResourceCandidates(parseHarnessYaml(input.source))) {
		const loaded = await input.readResource(resource);
		if (loaded === undefined) continue;
		promptTexts.set(resource, loaded.bytes);
		if (loaded.file) resourceInputs.set(`${input.sourceRef}::${resource}`, loaded.bytes);
	}
	const { lock } = compileHarnessYaml(input.source, { sourceRef: input.sourceRef, resourceInputs });
	const graphHash = lock.graph_hash;
	if (typeof graphHash !== "string") throw new Error("native harness compilation produced no graph_hash");

	let verifiedCachePath: string | undefined;
	if (input.cachePath !== undefined && (await exists(input.cachePath))) {
		const cached = await loadNativeLock(input.cachePath);
		if (cached.graphHash !== graphHash) {
			throw new Error(
				`native harness lock ${input.cachePath} is stale: it records ${cached.graphHash}, the spec compiles to ${graphHash}`,
			);
		}
		verifiedCachePath = input.cachePath;
	}

	const hostMode = nativeHostSurfaceMode(lock);
	const stages: NativeHarnessStage[] = [];
	if (hostMode === undefined) {
		for (const [mode, rawToolSurface] of await loadNativeToolSurfaces(lock)) {
			const toolSurface = bindWorkspaceSurface(rawToolSurface, input.workspaceRoot);
			const prompts = await assembleNativePrompts(lock, promptTexts, toolSurface, mode);
			stages.push(
				Object.freeze({
					mode,
					systemPrompt: prompts.system,
					perTurnPrompt: prompts.perTurn,
					toolPromptMode: stringValue(lock, "prompts.tool_prompt_mode"),
					toolSurface,
				}),
			);
		}
	} else {
		// The host's own tools answer every turn, so there is no harness tool catalog to frame into messages.
		const toolSurface: NativeToolSurfacePack = Object.freeze({ mode: hostMode, native: [], textInvoked: [] });
		const prompts = await assembleNativePrompts(lock, promptTexts, toolSurface, hostMode);
		stages.push(
			Object.freeze({
				mode: hostMode,
				systemPrompt: prompts.system,
				perTurnPrompt: "",
				toolPromptMode: stringValue(lock, "prompts.tool_prompt_mode"),
				toolSurface,
			}),
		);
	}
	const initialStage = createNativeStageMachine(lock, stages).current;
	const defaultModel = stringValue(lock, "providers.default_model");
	return Object.freeze({
		harnessId: input.harnessId,
		specPath: input.specPath,
		workspaceRoot: input.workspaceRoot,
		lock,
		graphHash,
		...(verifiedCachePath === undefined ? {} : { verifiedCachePath }),
		hostSurface: hostMode !== undefined,
		systemPrompt: initialStage.systemPrompt,
		perTurnPrompt: initialStage.perTurnPrompt,
		toolSurface: initialStage.toolSurface,
		stages: Object.freeze(stages),
		registeredToolSurface: allNativeToolSurface(stages),
		...(defaultModel === undefined || defaultModel === HOST_MODEL ? {} : { defaultModel }),
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

/** The package's `harnesses/` directory; built-in `source_ref`s are relative to it. */
const BUILTIN_HARNESS_ROOT = resolve(import.meta.dir, "../../harnesses");

/**
 * Compile a harness into its effective lock and the session inputs it implies. A workspace spec may
 * carry a precompiled lock beside it; that lock is only a cache and must match this compilation's
 * `graph_hash`. A built-in harness compiles from the sources embedded in the product.
 */
async function loadNativeHarnessOnce(options: LoadNativeHarnessOptions): Promise<LoadedNativeHarness> {
	const workspaceRoot = resolve(options.workspaceRoot);
	const builtin = builtinNativeHarness(options.specPath);
	if (builtin !== undefined) {
		const encoder = new TextEncoder();
		return compileNativeHarness({
			harnessId: builtin.id,
			specPath: resolve(BUILTIN_HARNESS_ROOT, builtin.sourceRef),
			workspaceRoot,
			source: builtin.source,
			sourceRef: builtin.sourceRef,
			readResource: async resource => {
				const text = builtin.resources.get(resource);
				return text === undefined ? undefined : { bytes: encoder.encode(text), file: true };
			},
		});
	}
	const specPath = resolve(workspaceRoot, options.specPath);
	if (!contained(workspaceRoot, specPath)) throw new Error(`native harness spec must be inside the workspace: ${specPath}`);
	const specDirectory = dirname(specPath);
	const sourceRef = posixRelative(workspaceRoot, specPath);
	return compileNativeHarness({
		harnessId: sourceRef,
		specPath,
		workspaceRoot,
		source: await readFile(specPath, "utf8"),
		sourceRef,
		readResource: resource => readResource(specDirectory, resource),
		cachePath: nativeLockPathForSpec(specPath),
	});
}

function reloadErrorCode(error: unknown): NativeHarnessReloadErrorCode {
	if (error instanceof HarnessCompileError) return "compile";
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes(" is stale:")) return "lock-mismatch";
	if (message.includes("host token") || message.includes("host-surface") || message.includes("host-surface harness")) {
		return "host-surface-refused";
	}
	return "reload-failed";
}

/**
 * Compile a harness into its effective lock and session inputs. Workspace specs receive a shared
 * live state so an explicit reload can publish the next generation without replacing the session.
 */
export async function loadNativeHarness(options: LoadNativeHarnessOptions): Promise<LoadedNativeHarness> {
	let generation = 1;
	let current = await loadNativeHarnessOnce(options);
	const editable = builtinNativeHarness(options.specPath) === undefined;
	const listeners = new Set<(change: NativeHarnessGenerationChange) => void>();
	let live: NativeHarnessLiveState;
	const withLive = (harness: LoadedNativeHarness): LoadedNativeHarness =>
		Object.freeze({ ...harness, live });
	live = {
		editable,
		get generation() {
			return generation;
		},
		current: () => current,
		reload: async () => {
			if (!editable) {
				throw new NativeHarnessReloadError(
					"builtin",
					generation,
					`Harness ${current.harnessId} is built in and cannot be live-edited.`,
				);
			}
			let next: LoadedNativeHarness;
			try {
				next = await loadNativeHarnessOnce(options);
			} catch (error) {
				const code = reloadErrorCode(error);
				throw new NativeHarnessReloadError(
					code,
					generation,
					`Harness reload rejected (${code}): ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
			if (current.hostSurface || next.hostSurface) {
				throw new NativeHarnessReloadError(
					"host-surface-refused",
					generation,
					"Live reload cannot change or introduce a host-surface harness.",
				);
			}
			const previousGeneration = generation;
			generation += 1;
			current = withLive(next);
			const change = { previousGeneration, generation, harness: current } as const;
			for (const listener of listeners) listener(change);
			return current;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	current = withLive(current);
	return current;
}
