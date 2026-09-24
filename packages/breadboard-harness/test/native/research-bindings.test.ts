import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadNativeToolDefinitionsByRegistryPath } from "../../src/native/tool-pack";
import { researchBindingForTool, researchDelegateForTool } from "../../src/native/research-bindings";
import type { JsonRecord } from "../../src/canonical-json";
import type { NativeToolDefinition } from "../../src/native/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

type JsonObject = JsonRecord;


const directDelegates: Readonly<Record<string, string>> = {
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
	interactive_bash: "bash",
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

function expectedDelegate(tool: NativeToolDefinition): string | undefined {
	const direct = directDelegates[tool.name];
	if (direct === undefined) return undefined;
	const properties = tool.parameters.properties;
	const names = typeof properties === "object" && properties !== null && !Array.isArray(properties) ? Object.keys(properties) : [];
	const required = Array.isArray(tool.parameters.required) ? tool.parameters.required : [];
	if (tool.name === "grep" && !names.includes("pattern") && names.includes("path")) return "read";
	if ((tool.name === "task" || tool.name === "web_search") && required.includes("command")) return "bash";
	return direct;
}

async function delegatedInput(tool: NativeToolDefinition, input: JsonObject): Promise<JsonObject> {
	let received: JsonObject | undefined;
	await researchBindingForTool(tool).run({
		input,
		harness: {} as never,
		context: {
			invokeTool: async (params: JsonObject) => {
				received = params;
				return { content: [{ type: "text", text: "ok" }] };
			},
		} as never,
		signal: undefined,
		onUpdate: undefined,

		todos: {} as never,
		guard: {} as never,
	});
	if (received === undefined) throw new Error(`${tool.name} did not invoke a builtin`);
	return received;
}
function patchSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
		settings: Settings.isolated({ "edit.mode": "replace" }),
	} as unknown as ToolSession;
}


describe("research native builtin bindings", () => {
	test("binds every pack definition from its declared YAML", async () => {
		const definitions = await loadNativeToolDefinitionsByRegistryPath();
		for (const tools of definitions.values()) {
			for (const tool of tools) expect(researchDelegateForTool(tool)).toBe(expectedDelegate(tool));
		}
	});
	test("maps every declared exec tool through one host binding call", async () => {
		const definitions = await loadNativeToolDefinitionsByRegistryPath();
		const expectedKeys = new Set(["command", "timeout", "cwd", "name", "agent", "task", "context", "tasks", "query", "recency", "limit", "max_tokens", "temperature", "num_search_results", "code", "language", "reset", "title"]);
		for (const tools of definitions.values()) {
			for (const tool of tools) {
				if (!/^(?:Bash|bash|shell_command|background_|task|webfetch|eval|interactive_bash)$/u.test(tool.name)) continue;
				const delegate = researchDelegateForTool(tool);
				expect(delegate, `${tool.name} must have an exec binding`).toBeDefined();
				const properties = tool.parameters.properties;
				const input = Object.fromEntries(
					Object.keys(typeof properties === "object" && properties !== null && !Array.isArray(properties) ? properties : {}).map(name => [name, "probe"]),
				);
				let received: JsonObject | undefined;
				await researchBindingForTool(tool).run({
					input,
					harness: {} as never,
					context: {
						invokeTool: async (params: JsonObject) => {
							received = params;
							return { content: [{ type: "text", text: "ok" }] };
						},
					} as never,
					signal: undefined,
					onUpdate: undefined,
					todos: {} as never,
					guard: {} as never,
				});
				expect(received, `${tool.name} did not invoke host binding`).toBeDefined();
				for (const key of Object.keys(received ?? {})) expect(expectedKeys.has(key), `${tool.name} emitted unknown host key ${key}`).toBe(true);
			}
		}
	});

	test("does not let an agent-shaped task call bash", async () => {
		const definitions = await loadNativeToolDefinitionsByRegistryPath();
		const tool = definitions.get("implementations/tools/defs_oc")?.find(candidate => candidate.name === "task");
		if (!tool) throw new Error("missing OpenCode task definition");
		expect(researchDelegateForTool(tool)).toBe("task");
		expect(await delegatedInput(tool, { command: "printf should-not-run", prompt: "agent task" })).toEqual({
			task: "agent task",
		});
	});

	test("maps the Pi and OMO-Pi path/text aliases to host builtins", async () => {
		const definitions = await loadNativeToolDefinitionsByRegistryPath();
		const piRead = definitions.get("defs_pi")?.find(tool => tool.name === "read");
		const piEdit = definitions.get("defs_pi")?.find(tool => tool.name === "edit");
		const omoEdit = definitions.get("defs_oh_my_pi")?.find(tool => tool.name === "edit");
		if (!piRead || !piEdit || !omoEdit) throw new Error("missing Group B definition");
		expect(await delegatedInput(piRead, { path: "fixture.txt", offset: 1, limit: 20 })).toEqual({
			path: "fixture.txt",
			offset: 1,
			limit: 20,
		});
		expect(await delegatedInput(piEdit, { path: "fixture.txt", oldText: "a", newText: "b" })).toEqual({
			filePath: "fixture.txt",
			oldString: "a",
			newString: "b",
		});
		expect(await delegatedInput(omoEdit, { input: "patch payload", file_name: "alias.txt", search: "a", replace: "b" })).toEqual({
			input: "patch payload",
		});
	});
	test("prefers a declared path over an undeclared alias", async () => {
		const definitions = await loadNativeToolDefinitionsByRegistryPath();
		const piRead = definitions.get("defs_pi")?.find(tool => tool.name === "read");
		if (!piRead) throw new Error("missing Pi read definition");
		expect(await delegatedInput(piRead, { path: "declared.txt", filePath: "alias.txt" })).toEqual({
			path: "declared.txt",
		});
	});

	test("applies apply_patch through the host patch path regardless of edit mode", async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-patch-"));
		try {
			const target = path.join(scratch, "target.txt");
			const hostSession = patchSession(scratch);
			expect(hostSession.settings.get("edit.mode")).toBe("replace");
			await Bun.write(target, "before\n");
			const input = [
				"*** Begin Patch",
				"*** Update File: target.txt",
				"@@",
				"-before",
				"+after",
				"*** End Patch",
				"",
			].join("\n");
			const tool: NativeToolDefinition = {
				id: "apply_patch",
				name: "apply_patch",
				description: "",
				parameters: {
					type: "object",
					properties: { input: { type: "string" } },
					required: ["input"],
				},
				nativePrimary: true,
			};
			const result = await researchBindingForTool(tool).run({
				input: { input },
				harness: { workspaceRoot: scratch } as never,
				context: {
					invokeTool: async () => {
						throw new Error("apply_patch must not depend on the session edit mode");
					},
				} as never,
				signal: undefined,
				onUpdate: undefined,
				todos: {} as never,
				guard: {} as never,
			});
			expect(result.isError).not.toBe(true);
			expect(await Bun.file(target).text()).toBe("after\n");
		} finally {
			await fs.rm(scratch, { recursive: true, force: true });
		}
	});
	test("refuses apply_patch paths outside the workspace, including symlink escapes", async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-escape-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-outside-"));
		try {
			await Bun.write(path.join(outside, "target.txt"), "before\n");
			await fs.symlink(outside, path.join(scratch, "alias"), "dir");
			const tool: NativeToolDefinition = {
				id: "apply_patch",
				name: "apply_patch",
				description: "",
				parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
				nativePrimary: true,
			};
			const run = (file: string) =>
				researchBindingForTool(tool).run({
					input: {
						input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-before\n+after\n*** End Patch\n`,
					},
					harness: { workspaceRoot: scratch } as never,
					context: { invokeTool: async () => { throw new Error("unexpected invokeTool"); } } as never,
					signal: undefined,
					onUpdate: undefined,
					todos: {} as never,
					guard: {} as never,
				});
			expect((await run("../outside.txt")).isError).toBe(true);
			expect((await run("alias/target.txt")).isError).toBe(true);
			expect(await Bun.file(path.join(outside, "target.txt")).text()).toBe("before\n");
		} finally {
			await fs.rm(scratch, { recursive: true, force: true });
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
	test("executes the Codex shell_command schema through real host bash", async () => {
		const definitions = await loadNativeToolDefinitionsByRegistryPath();
		const tool = definitions.get("implementations/tools/defs")?.find(candidate => candidate.name === "shell_command");
		if (!tool) throw new Error("missing Codex shell_command definition");
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-shell-"));
		try {
			const nested = path.join(scratch, "nested");
			await fs.mkdir(nested);
			await Bun.write(path.join(nested, "fixture.txt"), "codex-shell-ok\n");
			const hostBash = new (await import("@oh-my-pi/pi-coding-agent/tools/bash")).BashTool(patchSession(scratch));
			const result = await researchBindingForTool(tool).run({
				input: { command: "cat fixture.txt", workdir: nested, timeout_ms: 5000 },
				harness: { workspaceRoot: scratch } as never,
				context: {
					invokeTool: async (params: JsonObject) => hostBash.execute("research-shell", params as never),
				} as never,
				signal: undefined,
				onUpdate: undefined,
				todos: {} as never,
				guard: {} as never,
			});
			expect(result.isError).not.toBe(true);
			expect(result.text).toContain("codex-shell-ok");
		} finally {
			await fs.rm(scratch, { recursive: true, force: true });
		}
	});
});
