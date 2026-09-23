import type { CanonicalJson } from "../canonical-json";
import {
	applyUnifiedPatchAdapter,
	createFileFromBlockAdapter,
	listDirAdapter,
	readFileAdapter,
} from "./adapters";
import type {
	NativeExtensionApi,
	NativeHookEvent,
	NativeToolCallContext,
	NativeToolDefinition,
	NativeToolRegistration,
	NativeToolResult,
	NativeToolSurfacePack,
} from "./types";

function recordInput(input: Readonly<Record<string, CanonicalJson>>): Readonly<Record<string, CanonicalJson>> {
	return input;
}

function stringInput(input: Readonly<Record<string, CanonicalJson>>, key: string, required = true): string | undefined {
	const value = input[key];
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string") throw new Error(`native harness tool argument ${key} must be a string`);
	return value;
}

function numberInput(input: Readonly<Record<string, CanonicalJson>>, key: string): number | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`native harness tool argument ${key} must be a number`);
	return value;
}

function arrayInput(input: Readonly<Record<string, CanonicalJson>>, key: string): readonly CanonicalJson[] {
	const value = input[key];
	if (!Array.isArray(value)) throw new Error(`native harness tool argument ${key} must be an array`);
	return value;
}


function detailsResult(text: string, details: CanonicalJson): NativeToolResult {
	return { text, details };
}

async function executeTool(
	tool: NativeToolDefinition,
	workspaceRoot: string,
	input: Readonly<Record<string, CanonicalJson>>,
	context: NativeToolCallContext,
	markCompleted: () => void,
): Promise<NativeToolResult> {
	switch (tool.name) {
		case "read_file":
			return readFileAdapter(workspaceRoot, {
				path: stringInput(input, "path")!,
				offset: numberInput(input, "offset"),
				limit: numberInput(input, "limit"),
			});
		case "list_dir":
			return listDirAdapter(workspaceRoot, { path: stringInput(input, "path")!, depth: numberInput(input, "depth") });
		case "apply_unified_patch":
			return applyUnifiedPatchAdapter(workspaceRoot, stringInput(input, "patch")!);
		case "create_file_from_block": {
			const content = stringInput(input, "content")!;
			return createFileFromBlockAdapter(workspaceRoot, {
				filePath: stringInput(input, "filePath", false),
				file_name: stringInput(input, "file_name", false),
				content,
			});
		}
		case "run_shell": {
			if (context.runShell === undefined) throw new Error("native harness shell adapter is not bound");
			return context.runShell(stringInput(input, "command")!, numberInput(input, "timeout"), context.signal);
		}
		case "eval": {
			if (context.runEval === undefined) throw new Error("native harness eval adapter is not bound");
			return context.runEval(recordInput(input), context.signal);
		}
		case "TodoWrite": {
			const todos = arrayInput(input, "todos");
			return detailsResult(`Updated ${todos.length} todo item${todos.length === 1 ? "" : "s"}`, { todos });
		}
		case "mark_task_complete":
			markCompleted();
			context.shutdown();
			return detailsResult("Task marked as complete. Ending session.", { completed: true });
		default:
			throw new Error(`native harness has no adapter for ${tool.name}`);
	}
}

/** Build the R39 extension factory and enforce its per-turn tool limits. */
export function createNativeHarnessExtensionFactory(
	workspaceRoot: string,
	toolSurface: NativeToolSurfacePack,
): (api: NativeExtensionApi) => void {
	return (api: NativeExtensionApi): void => {
		const callsThisTurn = new Map<string, number>();
		let completed = false;
		for (const tool of toolSurface.tools) {
			const registration: NativeToolRegistration = {
				...tool,
				execute: async (input, context) => executeTool(tool, workspaceRoot, input, context, () => {
					completed = true;
				}),
			};
			api.registerTool(registration);
		}
		api.on("turn_start", (_event: NativeHookEvent) => {
			callsThisTurn.clear();
		});
		api.on("tool_call", event => {
			if (event.type !== "tool_call") return;
			const tool = toolSurface.byName.get(event.toolName);
			if (tool?.maxPerTurn === undefined) return;
			const count = (callsThisTurn.get(event.toolName) ?? 0) + 1;
			callsThisTurn.set(event.toolName, count);
			if (count > tool.maxPerTurn) {
				return { decision: "block", reason: `${event.toolName} allows at most ${tool.maxPerTurn} call per turn` };
			}
		});
		api.on("before_agent_start", (_event: NativeHookEvent) => undefined);
		api.on("session_stop", (_event: NativeHookEvent) => {
			// Completion is intentionally graceful: mark_task_complete asks the normal OMP loop to
			// shut down, while an interactive user can still submit another explicit prompt.
			if (completed) return undefined;
			return undefined;
		});
	};
}
