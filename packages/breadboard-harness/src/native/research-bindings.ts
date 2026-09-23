import type { JsonRecord } from "../canonical-json";
import { RESEARCH_TOOL_DEFINITIONS } from "./research-tool-definitions";
import type { NativeBinding, NativeCall } from "./omp-extension";
import type { NativeToolResult } from "./types";

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
	read: "read",
	edit: "edit",
	write: "write",
	glob: "glob",
	grep: "grep",
	list: "find",
	find: "find",
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

function mappedInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
	if (name === "Bash") return { command: input.command ?? "", timeout: input.timeout };
	if (name === "Read") return { path: input.file_path ?? "", offset: input.offset, limit: input.limit };
	if (name === "Write") return { filePath: input.file_path, content: input.content ?? "" };
	if (name === "Edit")
		return {
			filePath: input.file_path,
			oldString: input.old_string,
			newString: input.new_string,
			replaceAll: input.replace_all,
		};
	if (name === "Glob") return { path: input.path, pattern: input.pattern };
	if (name === "Grep") return { pattern: input.pattern, path: input.path, include: input.glob };
	if (name === "read") return { path: input.filePath ?? "", offset: input.offset, limit: input.limit };
	if (name === "write") return { filePath: input.filePath, content: input.content ?? "" };
	if (name === "edit")
		return {
			filePath: input.filePath,
			oldString: input.oldString,
			newString: input.newString,
			replaceAll: input.replaceAll,
		};
	if (name === "list") return { path: input.path };
	return input;
}

async function delegate(call: NativeCall, toolName: string, input: Record<string, unknown>): Promise<NativeToolResult> {
	const delegateName = DIRECT_DELEGATES[toolName];
	if (delegateName === undefined || call.context.invokeTool === undefined) {
		return { text: `Tool '${toolName}' is not available in the native host.`, isError: true };
	}
	const result = await call.context.invokeTool(mappedInput(toolName, input), {
		signal: call.signal,
		onUpdate: call.onUpdate,
	});
	const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
	return {
		text,
		...(typeof result.details === "object" && result.details !== null
			? { details: result.details as JsonRecord }
			: {}),
		...(result.isError === true ? { isError: true } : {}),
	};
}

const names = Object.values(RESEARCH_TOOL_DEFINITIONS).flatMap(definitions =>
	definitions.map(definition => definition.name),
);

export const RESEARCH_NATIVE_BINDINGS: Readonly<Record<string, NativeBinding>> = Object.fromEntries(
	[...new Set(names)].map(name => [
		name,
		{
			approval: /^(Bash|bash|background_|task|webfetch|eval|interactive_bash)$/u.test(name) ? "exec" : "read",
			...(DIRECT_DELEGATES[name] === undefined ? {} : { delegate: DIRECT_DELEGATES[name] }),
			run: (call: NativeCall) => delegate(call, name, call.input),
		},
	]),
);
