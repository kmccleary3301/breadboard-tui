import type { JsonRecord } from "../canonical-json";
import { RESEARCH_TOOL_DEFINITIONS } from "./research-tool-definitions";
import type { NativeBinding, NativeCall } from "./omp-extension";
import type { NativeToolDefinition, NativeToolResult } from "./types";

const DIRECT_DELEGATES: Readonly<Record<string, string>> = {
	Bash: "bash",
	Read: "read",
	Edit: "edit",
	Write: "write",
	Glob: "glob",
	Grep: "grep",
	Skill: "manage_skill",
	WebSearch: "web_search",
	bash: "bash",
	shell_command: "bash",
	read: "read",
	edit: "edit",
	apply_patch: "edit",
	write: "write",
	glob: "glob",
	grep: "grep",
	list: "find",
	find: "find",
	ls: "find",
	task: "task",
	background_task: "task",
	webfetch: "web_search",
	manage_skill: "manage_skill",
	eval: "eval",
	todo: "todo",
	ast_grep: "ast_grep",
	ast_edit: "ast_edit",
	ask: "ask",
	debug: "debug",
	github: "github",
	lsp: "lsp",
	checkpoint: "checkpoint",
	rewind: "rewind",
	memory_edit: "memory_edit",
	retain: "retain",
	recall: "recall",
	reflect: "reflect",
	learn: "learn",
};

type DelegateName = string;

function firstString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		if (typeof input[key] === "string") return input[key] as string;
	}
	return undefined;
}

function schemaProperties(tool: NativeToolDefinition): ReadonlySet<string> {
	const properties = tool.parameters.properties;
	if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return new Set();
	return new Set(Object.keys(properties));
}
function requiredProperties(tool: NativeToolDefinition): ReadonlySet<string> {
	const required = tool.parameters.required;
	return new Set(Array.isArray(required) ? required.filter((value): value is string => typeof value === "string") : []);
}

/** Selects one host builtin from the vendored definition, before any model call runs. */
export function researchDelegateForTool(tool: NativeToolDefinition): DelegateName | undefined {
	const direct = DIRECT_DELEGATES[tool.name];
	if (direct === undefined) return undefined;
	const properties = schemaProperties(tool);
	const required = requiredProperties(tool);
	if (tool.name === "grep" && !properties.has("pattern") && properties.has("path")) return "read";
	if ((tool.name === "task" || tool.name === "web_search") && required.has("command")) return "bash";
	return direct;
}

function mappedInput(delegateName: DelegateName, input: Record<string, unknown>): Record<string, unknown> {
	if (delegateName === "bash") return { command: input.command ?? "", timeout: input.timeout };
	if (delegateName === "read")
		return {
			path: firstString(input, "filePath", "file_path", "path", "file_name") ?? "",
			offset: input.offset,
			limit: input.limit,
		};
	if (delegateName === "write")
		return {
			filePath: firstString(input, "filePath", "file_path", "path", "file_name"),
			content: input.content ?? "",
		};
	if (delegateName === "edit")
		return {
			filePath: firstString(input, "filePath", "file_path", "path", "file_name"),
			oldString: firstString(input, "oldString", "old_string", "oldText", "search"),
			newString: firstString(input, "newString", "new_string", "newText", "replace"),
			replaceAll: input.replaceAll ?? input.replace_all,
		};
	if (delegateName === "grep")
		return {
			pattern: input.pattern ?? "",
			path: input.path,
			include: input.include ?? input.glob,
		};
	if (delegateName === "glob")
		return {
			path: input.path,
			pattern: input.pattern ?? "**/*",
		};
	if (delegateName === "find")
		return { path: input.path, pattern: input.pattern ?? "*", limit: input.limit };
	return input;
}

const MISSING_PACK_TOOL_NAMES = [
	"apply_patch",
	"shell_command",
	"blob.get",
	"blob.put",
	"blob.put_file_slice",
	"blob.search",
	"create_file",
	"llm.batch_query",
	"llm.query",
	"record_branch_decision",
	"record_proof_receipt",
	"record_verification_receipt",
	"request_finish_receipt",
	"todo.attach",
	"todo.cancel",
	"todo.complete",
	"todo.create",
	"todo.list",
	"todo.note",
	"todo.reorder",
	"todo.update",
	"update_plan",
] as const;

async function delegate(
	call: NativeCall,
	toolName: string,
	delegateName: DelegateName | undefined,
	input: Record<string, unknown>,
): Promise<NativeToolResult> {
	if (delegateName === undefined || call.context.invokeTool === undefined) {
		return { text: `Tool '${toolName}' is not available in the native host.`, isError: true };
	}
	const result = await call.context.invokeTool(mappedInput(delegateName, input), {
		signal: call.signal,
		onUpdate: call.onUpdate,
	});
	const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
	return {
		text,
		...(typeof result.details === "object" && result.details !== null ? { details: result.details as JsonRecord } : {}),
		...(result.isError === true ? { isError: true } : {}),
	};
}

function bindingFor(tool: NativeToolDefinition): NativeBinding {
	const delegateName = researchDelegateForTool(tool);
	return {
		approval: /^(Bash|bash|shell_command|apply_patch|background_|task|webfetch|eval|interactive_bash)$/u.test(tool.name)
			? "exec"
			: "read",
		...(delegateName === undefined ? {} : { delegate: delegateName }),
		run: (call: NativeCall) => delegate(call, tool.name, delegateName, call.input),
	};
}

export function researchBindingForTool(tool: NativeToolDefinition): NativeBinding {
	return bindingFor(tool);
}

const allDefinitions = Object.values(RESEARCH_TOOL_DEFINITIONS).flat();
const names = [...new Set([...allDefinitions.map(definition => definition.name), ...MISSING_PACK_TOOL_NAMES])];

export const RESEARCH_NATIVE_BINDINGS: Readonly<Record<string, NativeBinding>> = Object.fromEntries(
	names.map(name => {
		const definition = allDefinitions.find(tool => tool.name === name);
		return [name, definition === undefined ? bindingFor({ id: name, name, description: "", parameters: {}, nativePrimary: true }) : bindingFor(definition)];
	}),
);
