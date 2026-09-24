import type { JsonRecord } from "../canonical-json";
import { applyUnifiedPatchAdapter } from "./adapters";
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
	apply_patch: "apply_patch",
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

type ArgumentMapping = Readonly<Record<string, string>>;

interface BindingPlan {
	readonly delegateName: DelegateName | undefined;
	readonly argumentMapping: ArgumentMapping;
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
	if (delegateName === "read") {
		return Object.fromEntries(
			[
				["path", declaredAlias(properties, ["filePath", "file_path", "path", "file_name"])],
				["offset", declaredAlias(properties, ["offset"])],
				["limit", declaredAlias(properties, ["limit"])],
			].filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
	}
	if (delegateName === "write") {
		return Object.fromEntries(
			[
				["filePath", declaredAlias(properties, ["filePath", "file_path", "path", "file_name"])],
				["content", declaredAlias(properties, ["content", "text"])],
			].filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
	}
	if (delegateName === "edit") {
		return Object.fromEntries(
			[
				["filePath", declaredAlias(properties, ["filePath", "file_path", "path", "file_name"])],
				["oldString", declaredAlias(properties, ["oldString", "old_string", "oldText", "search"])],
				["newString", declaredAlias(properties, ["newString", "new_string", "newText", "replace"])],
				["replaceAll", declaredAlias(properties, ["replaceAll", "replace_all"])],
			].filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
	}
	if (delegateName === "bash") {
		return Object.fromEntries(
			[
				["command", declaredAlias(properties, ["command"])],
				["timeout", declaredAlias(properties, ["timeout"])],
			].filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
	}
	if (delegateName === "grep") {
		return Object.fromEntries(
			[
				["pattern", declaredAlias(properties, ["pattern"])],
				["path", declaredAlias(properties, ["path"])],
				["include", declaredAlias(properties, ["include", "glob"])],
			].filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
	}
	if (delegateName === "glob") {
		return Object.fromEntries(
			[
				["path", declaredAlias(properties, ["path"])],
				["pattern", declaredAlias(properties, ["pattern"])],
			].filter((entry): entry is [string, string] => entry[1] !== undefined),
		);
	}
	if (delegateName === "find") {
		return Object.fromEntries(
			[
				["path", declaredAlias(properties, ["path"])],
				["pattern", declaredAlias(properties, ["pattern"])],
				["limit", declaredAlias(properties, ["limit"])],
			].filter((entry): entry is [string, string] => entry[1] !== undefined),
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

function bindingPlanForTool(tool: NativeToolDefinition): BindingPlan {
	const delegateName = researchDelegateForTool(tool);
	return { delegateName, argumentMapping: mappingForTool(tool, delegateName) };
}

function mappedInput(plan: BindingPlan, input: Record<string, unknown>): Record<string, unknown> {
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

function bindingFor(tool: NativeToolDefinition): NativeBinding {
	const plan = bindingPlanForTool(tool);
	return {
		approval: /^(Bash|bash|shell_command|apply_patch|background_|task|webfetch|eval|interactive_bash)$/u.test(tool.name)
			? "exec"
			: "read",
		...(plan.delegateName === undefined ? {} : { delegate: plan.delegateName }),
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
