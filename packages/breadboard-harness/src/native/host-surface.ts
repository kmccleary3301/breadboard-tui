import { type CanonicalJson, isJsonRecord, type JsonRecord } from "../canonical-json";
import { nativeLockValue } from "./lock-values";

/**
 * Spec tokens that hand a slot back to the host session. Both compilers treat them as plain
 * strings, so a host-surface spec compiles to the same lock in TypeScript and Python.
 * - `@host.tools` as a mode's only `tools_enabled` entry: the host's own default tool set.
 * - `@host.system` first in `prompts.injection.system_order`: the host's own system prompt, with
 *   the remaining order tokens appended after it.
 * - `@host.model` as `providers.default_model`: the host's own model selection.
 */
export const HOST_TOOLS = "@host.tools";
export const HOST_SYSTEM_PROMPT = "@host.system";
export const HOST_MODEL = "@host.model";

function stringItems(value: CanonicalJson | undefined): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mentionsHostToken(value: CanonicalJson | undefined): boolean {
	if (typeof value === "string") return value.trim().startsWith("@host.");
	if (Array.isArray(value)) return value.some(mentionsHostToken);
	if (isJsonRecord(value)) return Object.values(value).some(mentionsHostToken);
	return false;
}

/**
 * The mode of a harness that runs on the host's own tool surface, or undefined for a harness
 * that declares its own tools. A partial host declaration is refused rather than guessed at.
 */
export function nativeHostSurfaceMode(lock: JsonRecord): string | undefined {
	const modes = nativeLockValue(lock, "modes");
	const records = Array.isArray(modes) ? modes.filter(isJsonRecord) : [];
	const hostModes = records.filter(mode => stringItems(mode.tools_enabled).includes(HOST_TOOLS));
	if (hostModes.length === 0) {
		for (const path of ["modes", "prompts.injection.system_order", "providers.default_model"]) {
			if (mentionsHostToken(nativeLockValue(lock, path))) {
				throw new Error(
					`native harness ${path} uses a host token, which requires a mode with tools_enabled [${HOST_TOOLS}]`,
				);
			}
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
	const order = stringItems(nativeLockValue(lock, "prompts.injection.system_order")).map(token => token.trim());
	if (order[0] !== HOST_SYSTEM_PROMPT || order.slice(1).some(token => token.startsWith("@host."))) {
		throw new Error(`a host-surface harness starts prompts.injection.system_order with ${HOST_SYSTEM_PROMPT}, once`);
	}
	if (
		nativeLockValue(lock, "features.todos.enabled") === true ||
		nativeLockValue(lock, "tools.mark_task_complete") === true
	) {
		throw new Error("a host-surface harness keeps the host's own todo and completion behavior");
	}
	const defaultModel = nativeLockValue(lock, "providers.default_model");
	if (typeof defaultModel === "string" && defaultModel.startsWith("@host.") && defaultModel !== HOST_MODEL) {
		throw new Error(`unknown host model token ${defaultModel}; use ${HOST_MODEL}`);
	}
	if (typeof mode.name !== "string") throw new Error("modes[].name is required");
	return mode.name;
}
