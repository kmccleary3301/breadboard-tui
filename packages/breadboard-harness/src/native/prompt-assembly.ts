import { readEngineDataFile } from "../engine-data";
import { isJsonRecord, type CanonicalJson, type JsonRecord } from "../canonical-json";
import { HOST_SYSTEM_PROMPT } from "./host-surface";
import { nativeLockValue } from "./lock-values";
import type { NativeToolDefinition, NativeToolSurfacePack } from "./types";

// `system_prompt_compiler.py:407`: `re.match(r"@pack\(([^)]+)\)\.(.+)$", token.strip())`.
const PACK_REFERENCE = /^@pack\(([^)]+)\)\.(.+)$/u;
const TODO_PROMPT_PATHS = Object.freeze({
	todo_plan: "implementations/prompts/todos/plan.md",
	todo_build: "implementations/prompts/todos/build.md",
});

function decode(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function stringValue(value: CanonicalJson | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function lockRows(lock: JsonRecord): readonly JsonRecord[] {
	const values = lock.effective_values;
	if (!Array.isArray(values)) return [];
	return values.filter(isJsonRecord);
}

function packValues(lock: JsonRecord): Map<string, Map<string, string>> {
	const packs = new Map<string, Map<string, string>>();
	for (const row of lockRows(lock)) {
		if (typeof row.path !== "string" || !row.path.startsWith("prompts.packs.")) continue;
		const parts = row.path.split(".");
		if (parts.length !== 4) continue;
		const value = stringValue(row.value);
		if (value === undefined) continue;
		let pack = packs.get(parts[2]);
		if (pack === undefined) {
			pack = new Map<string, string>();
			packs.set(parts[2], pack);
		}
		pack.set(parts[3], value);
	}
	return packs;
}

function arrayValue(lock: JsonRecord, path: string): readonly CanonicalJson[] | undefined {
	const value = nativeLockValue(lock, path);
	return Array.isArray(value) ? value : undefined;
}

function normalizedOrder(lock: JsonRecord, path: string): { value: string[]; defined: boolean } {
	const raw = nativeLockValue(lock, path);
	const defined = raw !== undefined;
	if (!Array.isArray(raw)) return { value: [], defined };
	const value: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		let token = item.trim();
		if (token.toUpperCase().startsWith("[CACHE]")) token = token.slice("[CACHE]".length).trim();
		if (token) value.push(token);
	}
	return { value, defined };
}

function selectedMode(lock: JsonRecord): string {
	const sequence = arrayValue(lock, "loop.sequence");
	const first = sequence?.[0];
	if (isJsonRecord(first) && typeof first.mode === "string") return first.mode;
	return "";
}

function modePromptReference(lock: JsonRecord, mode: string): string | undefined {
	const modes = arrayValue(lock, "modes");
	const selected = modes?.find(candidate => isJsonRecord(candidate) && candidate.name === mode);
	return isJsonRecord(selected) ? stringValue(selected.prompt) : undefined;
}

function parameterOrder(parameters: JsonRecord): readonly [string, JsonRecord][] {
	const properties = parameters.properties;
	if (!isJsonRecord(properties)) return [];
	return Object.entries(properties).filter((entry): entry is [string, JsonRecord] => isJsonRecord(entry[1]));
}


function pythonicFunctionPrompt(tools: readonly NativeToolDefinition[]): string {
	const functions = tools.map(tool => {
		const argumentLines = parameterOrder(tool.parameters).map(([name, schema]) => {
			const description = typeof schema.description === "string" ? schema.description.replaceAll("\n", " ") : "";
			const type = typeof schema.type === "string" ? schema.type : "";
			const defaultValue = schema.default;
			const parts = [name];
			if (type) parts.push(`: ${type}`);
			if (defaultValue !== undefined && defaultValue !== null) parts.push(` = ${String(defaultValue)}`);
			if (description) parts.push(`\t # ${description}`);
			return parts.join("");
		});
		const args = argumentLines.join(",\n\t");
		return `def ${tool.name}(\t\t${args}\n)\n\"\"\"\n${tool.description}\n\"\"\"`;
	});
	const available = functions.join("\n\n");
	return `\nYou may call a python functions to execute an action.\nTo do so, you must wrap it in the following template:\n\n<TOOL_CALL> function_name(arg_1=value1, arg2=value2, ...) </TOOL_CALL>\n\nand it is wrapped as <TOOL_CALL> ... </TOOL_CALL>.\nThe call MUST begin with the sequence "<TOOL_CALL>" and MUST end with the sequence "</TOOL_CALL>" to be valid.\nThe inner content must be valid python code.\n\nHere are your available functions:\n\n${available}\n\nSyntax: strictly use parentheses with comma-separated arguments and equal signs for keyword args.\nExample: my_tool(arg1=123, arg2=\"text\"). Do NOT use colons.\n`;
}

function perTurnCatalog(surface: NativeToolSurfacePack): string {
	const sections = ["\n\nSYSTEM MESSAGE - AVAILABLE TOOLS\n"];
	if (surface.native.length > 0) {
		sections.push(
			"NATIVE TOOLS AVAILABLE VIA TOOL CALLING:\n" +
				surface.native.map(tool => `- ${tool.name}`).join("\n") +
			"\n",
		);
	}
	if (surface.textInvoked.length > 0) {
		const functionPrompt = pythonicFunctionPrompt(surface.textInvoked);
		sections.push(
			"\nADDITIONAL TEXT-INVOKED FUNCTIONS:\n" +
				`<FUNCTIONS>\n${functionPrompt}\n\n${functionPrompt}\n\n\n</FUNCTIONS>\n`,
		);
	}
	sections.push("END SYSTEM MESSAGE\n");
	return sections.join("");
}

/**
 * Assemble the Python v2 prompt compiler's system blocks and per-turn tool catalog.
 *
 * Python references: `system_prompt_compiler.py:379-410` (_load_text and pack refs),
 * `:515-581` (orders, dedupe, and `\n\n` joining), and
 * `agent_llm_openai.py:5141-5175` (todo prompt-pack injection).
 * `readEngineDataFile` supplies the two built-in todo resources named by that injection.
 */
export async function assembleNativePrompts(
	lock: JsonRecord,
	resources: ReadonlyMap<string, Uint8Array>,
	surface: NativeToolSurfacePack,
	modeOverride?: string,
): Promise<{ system: string; perTurn: string }> {
	const mode = modeOverride ?? selectedMode(lock);
	const packs = packValues(lock);
	const todosEnabled = nativeLockValue(lock, "features.todos.enabled") === true;
	if (todosEnabled) {
		const base = packs.get("base") ?? new Map<string, string>();
		packs.set("base", base);
		for (const [key, path] of Object.entries(TODO_PROMPT_PATHS)) {
			if (!base.has(key)) base.set(key, await readEngineDataFile(path));
		}
	}

	const loadText = (value: string | undefined): string => {
		if (!value) return "";
		if (value.includes("\n") || value.length > 256) return value;
		const bytes = resources.get(value);
		return bytes === undefined ? value : decode(bytes);
	};
	const resolvePackReference = (token: string): string => {
		const reference = PACK_REFERENCE.exec(token.trim());
		return reference === null ? "" : loadText(packs.get(reference[1])?.get(reference[2]));
	};
	// `system_prompt_compiler.py:423-434`: a mode prompt may itself be a pack reference, then loads once more (:556).
	const modePrompt = (mode: string): string => {
		const text = loadText(modePromptReference(lock, mode));
		return loadText(text.startsWith("@pack(") ? resolvePackReference(text) : text);
	};
	const resolveToken = (token: string, mode: string): string => {
		if (token === "mode_specific") return modePrompt(mode);
		// The host renders its own prompt in this slot; the harness contributes nothing to it.
		if (token === HOST_SYSTEM_PROMPT) return "";
		return token.startsWith("@pack(") ? resolvePackReference(token) : loadText(token);
	};
	const assemble = (order: readonly string[], mode: string, dedupe: boolean): string => {
		const segments: string[] = [];
		const seen = new Set<string>();
		for (const token of order) {
			const text = resolveToken(token, mode).trim();
			if (!text) continue;
			if (dedupe) {
				const digest = new Bun.CryptoHasher("sha256").update(text).digest("hex");
				if (seen.has(digest)) continue;
				seen.add(digest);
			}
			segments.push(text);
		}
		return segments.join("\n\n").trim();
	};

	const systemOrder = normalizedOrder(lock, "prompts.injection.system_order");
	const perTurnOrder = normalizedOrder(lock, "prompts.injection.per_turn_order");
	const system = systemOrder.defined
		? systemOrder.value
		: ["@pack(base).system"];
	if (todosEnabled && system.length > 0) {
		if (!system.includes("@pack(base).todo_plan") && !perTurnOrder.value.includes("@pack(base).todo_plan")) {
			system.push("@pack(base).todo_plan");
		}
		if (!system.includes("@pack(base).todo_build") && !perTurnOrder.value.includes("@pack(base).todo_build")) {
			system.push("@pack(base).todo_build");
		}
	}
	const dedupe = nativeLockValue(lock, "prompts.dedupe") === true;
	const assembledSystem = assemble(system, mode, dedupe);
	const toolPromptMode = nativeLockValue(lock, "prompts.tool_prompt_mode");
	const perTurn =
		toolPromptMode === "none"
			? ""
			: toolPromptMode === "system_compiled_and_persistent_per_turn"
				? assembledSystem
				: perTurnCatalog(surface);
	return { system: assembledSystem, perTurn };
}

export type NativeUserTextBlock = { readonly type: "text"; readonly text: string };

/**
 * Frame user content with the same block structure as Python's persistent per-turn mode:
 * the compiled system is inside BREADBOARD_INTERNAL, followed by a separate tool-catalog text block.
 */
export function frameNativeUserContent(userText: string, stage: { readonly perTurnPrompt: string; readonly toolPromptMode?: string; readonly toolSurface: NativeToolSurfacePack }): string | NativeUserTextBlock[] {
	const framed = frameNativeUserMessage(userText, stage.perTurnPrompt);
	if (stage.toolPromptMode !== "system_compiled_and_persistent_per_turn") return framed;
	return [{ type: "text", text: framed }, { type: "text", text: perTurnCatalog(stage.toolSurface) }];
}

/**
 * Frame the initial user message exactly as Python does at
 * `agent_llm_openai.py:6442-6453`: the caller's text followed by the internal per-turn block.
 * The gateway's leading `<system-reminder>` is not Python-owned and is intentionally excluded.
 */
export function frameNativeUserMessage(userText: string, perTurn: string): string {
	const parts = [userText, perTurn ? `<BREADBOARD_INTERNAL>\n${perTurn}\n</BREADBOARD_INTERNAL>` : ""];
	return parts.filter(part => part.trim()).join("\n\n");
}
