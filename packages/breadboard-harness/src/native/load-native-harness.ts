import { dirname, resolve } from "node:path";
import { loadNativeLock } from "./lock-loader";
import { resolveNativeSystemPrompt, nativeLockValue } from "./prompt-pack";
import { createNativeHarnessExtensionFactory } from "./extension";
import { loadNativeToolSurface } from "./tool-pack";
import type { CanonicalJson } from "../canonical-json";
import type { LoadedNativeHarness } from "./types";

export interface LoadNativeHarnessOptions {
	readonly lockPath: string;
	readonly workspaceRoot: string;
}

function numericValue(value: CanonicalJson | undefined): number | undefined {
	if (typeof value === "number") return value;
	if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return "value" in value && typeof value.value === "number" ? value.value : undefined;
}

function booleanValue(value: CanonicalJson | undefined): boolean {
	return value === true;
}

/** Load a verified lock, prompt pack, and model-facing R39 tool extension. */
export async function loadNativeHarness(options: LoadNativeHarnessOptions): Promise<LoadedNativeHarness> {
	const workspaceRoot = resolve(options.workspaceRoot);
	const loadedLock = await loadNativeLock(resolve(options.lockPath));
	const systemPrompt = await resolveNativeSystemPrompt(loadedLock.lock, dirname(loadedLock.lockPath));
	const toolSurface = await loadNativeToolSurface(loadedLock.lock);
	const completion = {
		idleTurnLimit: numericValue(nativeLockValue(loadedLock.lock, "completion.natural_finish.idle_turn_limit")),
		noToolTurnsThreshold: numericValue(nativeLockValue(loadedLock.lock, "completion.natural_finish.no_tool_turns_threshold")),
	};
	const todos = {
		enabled: booleanValue(nativeLockValue(loadedLock.lock, "features.todos.enabled")),
		strict: booleanValue(nativeLockValue(loadedLock.lock, "features.todos.strict")),
	};
	return Object.freeze({
		lockPath: loadedLock.lockPath,
		workspaceRoot,
		lock: loadedLock.lock,
		meta: loadedLock.meta,
		graphHash: loadedLock.graphHash,
		systemPrompt,
		toolSurface,
		toolNames: toolSurface.tools.map(tool => tool.name),
		extensionFactory: createNativeHarnessExtensionFactory(workspaceRoot, toolSurface),
		completion,
		todos,
	});
}
