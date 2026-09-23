import { type CanonicalJson, isJsonRecord, type JsonRecord } from "../canonical-json";
import { nativeLockValue } from "./lock-values";

/**
 * Spec tokens that hand a slot back to the host session. Both compilers treat them as plain
 * strings, so a host-surface spec compiles to the same lock in TypeScript and Python.
 * - `@host.tools` as a mode's only `tools_enabled` entry: the host's own default tool set.
 * - `@host.system` first in `prompts.injection.system_order`: the host's own system prompt, with
 *   the remaining order tokens appended after it.
 * - `@host.model` as `providers.default_model` (and the matching `providers.models[].id`): the
 *   host's own model selection.
 * A host token anywhere else is refused.
 */
export const HOST_TOOLS = "@host.tools";
export const HOST_SYSTEM_PROMPT = "@host.system";
export const HOST_MODEL = "@host.model";

function stringItems(value: CanonicalJson | undefined): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The only places a host token may appear, as `path` → the token that slot takes. */
const HOST_TOKEN_SLOTS: ReadonlyArray<readonly [RegExp, string]> = [
	[/^modes\[\d+\]\.tools_enabled\[\d+\]$/, HOST_TOOLS],
	[/^prompts\.injection\.system_order\[0\]$/, HOST_SYSTEM_PROMPT],
	[/^providers\.default_model$/, HOST_MODEL],
	[/^providers\.models\[\d+\]\.id$/, HOST_MODEL],
];

/** Collects the paths of host tokens under `path`, throwing on one outside the slot that takes it. */
function collectHostTokens(path: string, value: CanonicalJson, found: string[]): void {
	if (typeof value === "string") {
		const token = value.trim();
		if (!token.startsWith("@host.")) return;
		if (!HOST_TOKEN_SLOTS.some(([slot, expected]) => slot.test(path) && token === expected)) {
			throw new Error(`native harness ${path} uses host token ${token} outside the slot that takes it`);
		}
		found.push(path);
	} else if (Array.isArray(value)) {
		value.forEach((item, index) => collectHostTokens(`${path}[${index}]`, item, found));
	} else if (isJsonRecord(value)) {
		for (const [key, item] of Object.entries(value)) collectHostTokens(`${path}.${key}`, item, found);
	}
}

/**
 * The mode of a harness that runs on the host's own tool surface, or undefined for a harness
 * that declares its own tools. A partial host declaration is refused rather than guessed at.
 */
export function nativeHostSurfaceMode(lock: JsonRecord): string | undefined {
	const found: string[] = [];
	for (const row of Array.isArray(lock.effective_values) ? lock.effective_values : []) {
		if (isJsonRecord(row) && typeof row.path === "string" && row.value !== undefined) {
			collectHostTokens(row.path, row.value, found);
		}
	}
	const modes = nativeLockValue(lock, "modes");
	const records = Array.isArray(modes) ? modes.filter(isJsonRecord) : [];
	const hostModes = records.filter(mode => stringItems(mode.tools_enabled).includes(HOST_TOOLS));
	if (hostModes.length === 0) {
		if (found.length > 0) {
			throw new Error(
				`native harness ${found[0]} uses a host token, which requires a mode with tools_enabled [${HOST_TOOLS}]`,
			);
		}
		return undefined;
	}
	const [mode] = hostModes;
	if (records.length !== 1)
		throw new Error(`a host-surface harness declares exactly one mode; found ${records.length}`);
	const enabled = stringItems(mode.tools_enabled);
	if (enabled.length !== 1 || stringItems(mode.tools_disabled).length > 0) {
		throw new Error(`a host-surface mode enables only ${HOST_TOOLS} and disables nothing`);
	}
	if (typeof mode.prompt === "string" && mode.prompt.trim()) {
		throw new Error(`a host-surface mode has no mode prompt; put harness prompt blocks after ${HOST_SYSTEM_PROMPT}`);
	}
	if (stringItems(nativeLockValue(lock, "prompts.injection.system_order"))[0]?.trim() !== HOST_SYSTEM_PROMPT) {
		throw new Error(`a host-surface harness starts prompts.injection.system_order with ${HOST_SYSTEM_PROMPT}`);
	}
	if (stringItems(nativeLockValue(lock, "prompts.injection.per_turn_order")).length > 0) {
		throw new Error("a host-surface harness has no per-turn prompt; the host builds each turn's context");
	}
	if (
		nativeLockValue(lock, "features.todos.enabled") === true ||
		nativeLockValue(lock, "tools.mark_task_complete") === true
	) {
		throw new Error("a host-surface harness keeps the host's own todo and completion behavior");
	}
	if (typeof mode.name !== "string") throw new Error("modes[].name is required");
	return mode.name;
}
