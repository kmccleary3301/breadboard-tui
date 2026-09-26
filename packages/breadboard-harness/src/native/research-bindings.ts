import type { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { JsonRecord } from "../canonical-json";
import {
	adaptGlobInput,
	adaptGrepInput,
	adaptReadInput,
	adaptSkillInput,
	adaptTaskInput,
	adaptTmuxInput,
	applyUnifiedPatchAdapter,
} from "./adapters";
import type { NativeBinding, NativeCall } from "./omp-extension";
import type { NativeToolDefinition, NativeToolResult } from "./types";

const DIRECT_DELEGATES: Readonly<Record<string, string>> = {
	Bash: "bash",
	Read: "read",
	Edit: "edit",
	Write: "write",
	Glob: "glob",
	Grep: "grep",
	Skill: "read",
	skill: "read",
	WebSearch: "web_search",
	web_search: "web_search",
	bash: "bash",
	shell_command: "bash",
	interactive_bash: "bash",
	read: "read",
	edit: "edit",
	apply_patch: "apply_patch",
	write: "write",
	glob: "glob",
	grep: "grep",
	list: "glob",
	find: "glob",
	ls: "glob",
	task: "task",
	background_task: "task",
	webfetch: "read",
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

type ArgumentMapping = Readonly<Record<string, string>>;

interface BindingPlan {
	readonly delegateName: DelegateName | undefined;
	readonly argumentMapping: ArgumentMapping;
	readonly adaptInput?: (input: Record<string, unknown>) => Record<string, unknown>;
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

function declaredAlias(properties: ReadonlySet<string>, aliases: readonly string[]): string | undefined {
	return aliases.find(alias => properties.has(alias));
}

function identityMapping(properties: ReadonlySet<string>): ArgumentMapping {
	return Object.fromEntries([...properties].map(name => [name, name]));
}
function mappingForTool(tool: NativeToolDefinition, delegateName: DelegateName | undefined): ArgumentMapping {
	const properties = schemaProperties(tool);
	if (tool.name === "apply_patch" || (delegateName === "edit" && properties.has("input"))) return { input: "input" };
	if (delegateName === "write") {
		return Object.fromEntries(
			[
				["path", declaredAlias(properties, ["filePath", "file_path", "path", "file_name"])],
				["content", declaredAlias(properties, ["content", "text"])],
			].filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
	}
	if (delegateName === "edit") {
		return Object.fromEntries(
			[
				["path", declaredAlias(properties, ["filePath", "file_path", "path", "file_name"])],
				["old_string", declaredAlias(properties, ["oldString", "old_string", "oldText", "search"])],
				["new_string", declaredAlias(properties, ["newString", "new_string", "newText", "replace"])],
				["replace_all", declaredAlias(properties, ["replaceAll", "replace_all"])],
			].filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
	}
	if (delegateName === "bash") {
		return Object.fromEntries(
			[
				["command", declaredAlias(properties, ["command"])],
				["timeout", declaredAlias(properties, ["timeout", "timeout_ms"])],
				["cwd", declaredAlias(properties, ["cwd", "workdir", "working_directory"])],
			].filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
	}
	if (delegateName === "web_search") {
		return Object.fromEntries(
			[
				["query", declaredAlias(properties, ["query"])],
				["recency", declaredAlias(properties, ["recency"])],
				["limit", declaredAlias(properties, ["limit"])],
				["max_tokens", declaredAlias(properties, ["max_tokens"])],
				["temperature", declaredAlias(properties, ["temperature"])],
				["num_search_results", declaredAlias(properties, ["num_search_results"])],
			].filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
	}
	if (delegateName === "eval") {
		return Object.fromEntries(
			["code", "language", "reset", "timeout", "title"]
				.filter(name => properties.has(name))
				.map(name => [name, name]),
		);
	}
	return identityMapping(properties);
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

function adapterForTool(
	tool: NativeToolDefinition,
	delegateName: DelegateName | undefined,
): ((input: Record<string, unknown>) => Record<string, unknown>) | undefined {
	const properties = schemaProperties(tool);
	if (delegateName === "read") {
		if (tool.name === "Skill" || tool.name === "skill") {
			const skillKey = declaredAlias(properties, ["skill", "name"]) ?? "skill";
			return input => adaptSkillInput(input, skillKey);
		}
		// Host read accepts URLs, so URL fetch tools read their `url` directly.
		const pathKey = declaredAlias(properties, ["filePath", "file_path", "path", "file_name", "url"]) ?? "path";
		const offsetSchema = (tool.parameters.properties as Record<string, { description?: unknown }> | undefined)?.offset;
		const zeroBasedOffset = typeof offsetSchema?.description === "string" && /\b0-based\b/i.test(offsetSchema.description);
		return input => adaptReadInput(input, pathKey, zeroBasedOffset);
	}
	if (delegateName === "glob") {
		const pathKey = declaredAlias(properties, ["path", "filePath", "file_path"]) ?? "path";
		const patternKey = declaredAlias(properties, ["pattern"]) ?? "pattern";
		// `ls` lists one level; `find` follows fd, whose slash-free globs match names at any depth.
		const mode = tool.name === "ls" ? "children" : tool.name === "find" ? "basename" : "glob";
		return input => adaptGlobInput(input, pathKey, patternKey, mode);
	}
	if (delegateName === "grep") {
		const pathKey = declaredAlias(properties, ["path"]) ?? "path";
		const includeKey = declaredAlias(properties, ["include", "glob"]);
		return input => adaptGrepInput(input, pathKey, includeKey);
	}
	if (delegateName === "bash" && properties.has("tmux_command")) {
		return input => adaptTmuxInput(input, "tmux_command");
	}
	if (delegateName === "task") {
		const isSingleTask = !properties.has("tasks");
		return input => adaptTaskInput(input, isSingleTask);
	}
	return undefined;
}

function bindingPlanForTool(tool: NativeToolDefinition): BindingPlan {
	const delegateName = researchDelegateForTool(tool);
	const adaptInput = adapterForTool(tool, delegateName);
	if (adaptInput) return { delegateName, argumentMapping: {}, adaptInput };
	return { delegateName, argumentMapping: mappingForTool(tool, delegateName) };
}

function mappedInput(plan: BindingPlan, input: Record<string, unknown>): Record<string, unknown> {
	if (plan.adaptInput) return plan.adaptInput(input);
	return Object.fromEntries(Object.entries(plan.argumentMapping).map(([target, source]) => [target, input[source]]));
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
	"TaskOutput",
	"ExitPlanMode",
	"NotebookEdit",
	"WebFetch",
	"KillShell",
	"AskUserQuestion",
	"SlashCommand",
	"EnterPlanMode",
	"todowrite",
	"todoread",
	"skill",
	"lsp_hover",
	"lsp_goto_definition",
	"lsp_find_references",
	"lsp_document_symbols",
	"lsp_workspace_symbols",
	"lsp_diagnostics",
	"lsp_servers",
	"lsp_prepare_rename",
	"lsp_rename",
	"lsp_code_actions",
	"lsp_code_action_resolve",
	"ast_grep_search",
	"ast_grep_replace",
	"slashcommand",
	"background_output",
	"background_cancel",
	"call_omo_agent",
	"look_at",
	"interactive_bash",
	"context7_resolve-library-id",
	"context7_get-library-docs",
	"websearch_exa_web_search_exa",
	"grep_app_searchGitHub",
	"ssh",
	"inspect_image",
	"browser",
	"job",
	"web_search",
	"irc",
	"search_tool_bm25",
] as const;

async function delegate(
	call: NativeCall,
	toolName: string,
	plan: BindingPlan,
	input: Record<string, unknown>,
): Promise<NativeToolResult> {
	if (plan.delegateName === "apply_patch") {
		const patchText = input.input;
		if (typeof patchText !== "string") return { text: "Tool 'apply_patch' requires its declared input string.", isError: true };
		const result = await applyUnifiedPatchAdapter(call.harness.workspaceRoot, patchText);
		return {
			text: result.text,
			...(result.details === undefined ? {} : { details: result.details as JsonRecord }),
			...(result.isError === true ? { isError: true } : {}),
		};
	}
	if (plan.delegateName === undefined || call.context.invokeTool === undefined) {
		return { text: `Tool '${toolName}' is not available in the native host.`, isError: true };
	}
	const result = await call.context.invokeTool(mappedInput(plan, input), {
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

async function replacementEditDelegate(session: ToolSession): Promise<EditTool> {
	const { EditTool } = await import("@oh-my-pi/pi-coding-agent/edit");
	return new EditTool(session, "replace");
}

function bindingFor(tool: NativeToolDefinition): NativeBinding {
	const plan = bindingPlanForTool(tool);
	const hostDelegate =
		plan.delegateName === "edit" && plan.argumentMapping.old_string !== undefined
			? replacementEditDelegate
			: plan.delegateName;
	return {
		approval:
			plan.delegateName === "write" || plan.delegateName === "edit"
				? "write"
				: /^(Bash|bash|shell_command|apply_patch|background_|task|webfetch|eval|interactive_bash)$/u.test(tool.name)
					? "exec"
					: "read",
		...(hostDelegate === undefined ? {} : { delegate: hostDelegate }),
		run: (call: NativeCall) => delegate(call, tool.name, plan, call.input),
	};
}


export function researchBindingForTool(tool: NativeToolDefinition): NativeBinding {
	return bindingFor(tool);
}

const names = [...new Set([...Object.keys(DIRECT_DELEGATES), ...MISSING_PACK_TOOL_NAMES])];

export const RESEARCH_NATIVE_BINDINGS: Readonly<Record<string, NativeBinding>> = Object.fromEntries(
	names.map(name => [name, bindingFor({ id: name, name, description: "", parameters: {}, nativePrimary: true })]),
);
