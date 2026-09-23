import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { CanonicalJson } from "../canonical-json";

function valueAtPath(lock: Readonly<Record<string, CanonicalJson>>, path: string): CanonicalJson | undefined {
	const row = lock.effective_values;
	if (!Array.isArray(row)) return undefined;
	for (const candidate of row) {
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
		if (candidate.path === path) return candidate.value;
	}
	return undefined;
}

function safeResourcePath(root: string, resource: string): string {
	if (resource.length === 0 || isAbsolute(resource)) throw new Error(`native harness resource path is not workspace-relative: ${resource}`);
	const resolved = resolve(root, resource);
	const rest = relative(root, resolved);
	if (rest === "" || rest.startsWith("..") || isAbsolute(rest)) {
		throw new Error(`native harness resource escapes lock directory: ${resource}`);
	}
	return resolved;
}

/** Resolve the effective base system prompt from a verified lock. */
export async function resolveNativeSystemPrompt(
	lock: Readonly<Record<string, CanonicalJson>>,
	lockDirectory: string,
): Promise<string> {
	const resource = valueAtPath(lock, "prompts.packs.base.system");
	if (typeof resource !== "string") throw new Error("native harness lock has no prompts.packs.base.system value");
	const path = safeResourcePath(lockDirectory, resource);
	return await readFile(path, "utf8");
}

export function nativeLockValue(
	lock: Readonly<Record<string, CanonicalJson>>,
	path: string,
): CanonicalJson | undefined {
	return valueAtPath(lock, path);
}
