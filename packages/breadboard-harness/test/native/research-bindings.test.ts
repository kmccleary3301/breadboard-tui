import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadNativeToolDefinitionsByRegistryPath } from "../../src/native/tool-pack";
import { researchBindingForTool } from "../../src/native/research-bindings";
import type { JsonRecord } from "../../src/canonical-json";
import type { NativeToolDefinition } from "../../src/native/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

type JsonObject = JsonRecord;

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
	};
}


describe("research native builtin bindings", () => {
	test("applies the declared patch to workspace files", async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-patch-"));
		try {
			const target = path.join(scratch, "target.txt");
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
					invokeTool: async (params: JsonObject) => hostBash.execute("research-shell", hostBash.parameters.assert(params)),
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
