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
import type { NativeBinding } from "../../src/native/omp-extension";
import { loadNativeHarness } from "../../src/native/load-native-harness";
import { BUILTIN_TOOLS, type Tool } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";

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

function createHostSession(cwd: string, options: { taskBatch?: boolean } = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		canPromptUser: true,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
		// Enable the gated host tools some packs delegate to (memory_edit, manage_skill, debug).
		settings: Settings.isolated({
			"autolearn.enabled": true,
			"memory.backend": "mnemopi",
			"debug.enabled": true,
			"task.batch": options.taskBatch ?? true,
		}),
		refreshSkills: async () => {},
	};
}

async function resolveHostTool(
	binding: NativeBinding,
	tool: NativeToolDefinition,
	session: ToolSession,
): Promise<Tool | undefined> {
	if (typeof binding.delegate === "function") {
		return (await binding.delegate(session)) as Tool;
	}
	if (typeof binding.delegate === "string") {
		if (binding.delegate === "apply_patch") return undefined;
		const name = binding.delegate;
		if (name === "task") {
			const taskSession = createHostSession(session.cwd, { taskBatch: true });
			return TaskTool.create(taskSession);
		}
		const factory = BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS];
		if (!factory) throw new Error(`Unknown host tool delegate name: ${name}`);
		const created = await factory(session);
		if (!created) throw new Error(`Host tool factory for '${name}' returned null`);
		return created;
	}
	return undefined;
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
					context: {
						invokeTool: async () => {
							throw new Error("unexpected invokeTool");
						},
					} as never,
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
			const hostBash = new BashTool(patchSession(scratch));
			const result = await researchBindingForTool(tool).run({
				input: { command: "cat fixture.txt", workdir: nested, timeout_ms: 5000 },
				harness: { workspaceRoot: scratch } as never,
				context: {
					invokeTool: async (params: JsonObject) =>
						hostBash.execute("research-shell", hostBash.parameters.assert(params)),
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
	test.skipIf(!Bun.which("tmux"))(
		"executes the oh_my_opencode interactive_bash tmux schema through real host bash",
		async () => {
			const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-tmux-"));
			try {
				const loaded = await loadNativeHarness({ specPath: "oh_my_opencode", workspaceRoot: scratch });
				const tool = loaded.registeredToolSurface.native.find(t => t.name === "interactive_bash");
				if (!tool) throw new Error("missing oh_my_opencode interactive_bash tool");
				const hostBash = new BashTool(patchSession(scratch));
				const result = await researchBindingForTool(tool).run({
					input: { tmux_command: "-V" },
					harness: { workspaceRoot: scratch } as never,
					context: {
						invokeTool: async (params: JsonObject) =>
							hostBash.execute("research-tmux", hostBash.parameters.assert(params)),
					} as never,
					signal: undefined,
					onUpdate: undefined,
					todos: {} as never,
					guard: {} as never,
				});
				expect(result.isError).not.toBe(true);
				expect(result.text).toMatch(/tmux \d/u);
			} finally {
				await fs.rm(scratch, { recursive: true, force: true });
			}
		},
	);
	test("executes the oh_my_opencode webfetch schema by reading the URL through real host read", async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-webfetch-"));
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("WEBFETCH_BODY_OK\n") });
		try {
			const loaded = await loadNativeHarness({ specPath: "oh_my_opencode", workspaceRoot: scratch });
			const tool = loaded.registeredToolSurface.native.find(t => t.name === "webfetch");
			if (!tool) throw new Error("missing oh_my_opencode webfetch tool");
			const hostRead = new ReadTool(patchSession(scratch));
			const result = await researchBindingForTool(tool).run({
				input: { url: `http://127.0.0.1:${server.port}/page.txt`, format: "text" },
				harness: { workspaceRoot: scratch } as never,
				context: {
					invokeTool: async (params: JsonObject) =>
						hostRead.execute("research-webfetch", hostRead.parameters.assert(params)),
				} as never,
				signal: undefined,
				onUpdate: undefined,
				todos: {} as never,
				guard: {} as never,
			});
			expect(result.isError).not.toBe(true);
			expect(result.text).toContain("WEBFETCH_BODY_OK");
		} finally {
			server.stop(true);
			await fs.rm(scratch, { recursive: true, force: true });
		}
	});
	test("sends host bash seconds for each pack's declared timeout unit and keeps host-identical options", async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-bash-timeout-"));
		try {
			const hostBash = new BashTool(patchSession(scratch));
			const delegated = async (harnessId: string, name: string, input: Record<string, unknown>) => {
				const loaded = await loadNativeHarness({ specPath: harnessId, workspaceRoot: scratch });
				const tool = loaded.registeredToolSurface.native.find(t => t.name === name);
				if (!tool) throw new Error(`missing ${harnessId} ${name} tool`);
				let sent: Record<string, unknown> | undefined;
				await researchBindingForTool(tool).run({
					input: input as JsonObject,
					harness: { workspaceRoot: scratch } as never,
					context: {
						invokeTool: async (params: JsonObject) => {
							sent = hostBash.parameters.assert(params) as Record<string, unknown>;
							return { content: [{ type: "text", text: "ok" }] };
						},
					} as never,
					signal: undefined,
					onUpdate: undefined,
					todos: {} as never,
					guard: {} as never,
				});
				return sent;
			};
			// claude_code, codex and opencode declare milliseconds; pi and oh_my_pi declare seconds.
			expect((await delegated("claude_code", "Bash", { command: "true", timeout: 1500 }))?.timeout).toBe(2);
			expect(
				await delegated("codex", "shell_command", { command: "true", timeout_ms: 5000, workdir: scratch }),
			).toMatchObject({
				timeout: 5,
				cwd: scratch,
			});
			expect((await delegated("opencode", "bash", { command: "true", timeout: 120000 }))?.timeout).toBe(120);
			expect((await delegated("pi", "bash", { command: "true", timeout: 7 }))?.timeout).toBe(7);
			expect(
				await delegated("oh_my_pi", "bash", { command: "sleep 1", timeout: 30, async: true, pty: false }),
			).toMatchObject({
				timeout: 30,
				async: true,
				pty: false,
			});
		} finally {
			await fs.rm(scratch, { recursive: true, force: true });
		}
	});
	test("requires exec approval for oh_my_opencode background_task subagents", async () => {
		const loaded = await loadNativeHarness({ specPath: "oh_my_opencode", workspaceRoot: os.tmpdir() });
		const tool = loaded.registeredToolSurface.native.find(t => t.name === "background_task");
		if (!tool) throw new Error("missing oh_my_opencode background_task tool");
		expect(researchBindingForTool(tool).approval).toBe("exec");
	});
	describe("pi listing and search contracts through real host tools", () => {
		const runPiTool = async (scratch: string, name: string, input: Record<string, unknown>) => {
			const loaded = await loadNativeHarness({ specPath: "pi", workspaceRoot: scratch });
			const tool = loaded.registeredToolSurface.native.find(t => t.name === name);
			if (!tool) throw new Error(`missing pi ${name} tool`);
			const host = name === "grep" ? new GrepTool(patchSession(scratch)) : new GlobTool(patchSession(scratch));
			const result = await researchBindingForTool(tool).run({
				input: input as JsonObject,
				harness: { workspaceRoot: scratch } as never,
				context: {
					invokeTool: async (params: JsonObject) =>
						host.execute(`research-${name}`, host.parameters.assert(params) as never),
				} as never,
				signal: undefined,
				onUpdate: undefined,
				todos: {} as never,
				guard: {} as never,
			});
			expect(result.isError).not.toBe(true);
			return result.text;
		};
		const withTree = async (body: (scratch: string) => Promise<void>) => {
			const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-pi-"));
			try {
				await fs.mkdir(path.join(scratch, "sub", "deep"), { recursive: true });
				await Bun.write(path.join(scratch, "top.ts"), "call(a.b)\n");
				await Bun.write(path.join(scratch, "sub", "mid.ts"), "callXaYb\n");
				await Bun.write(path.join(scratch, "sub", "deep", "low.ts"), "nothing\n");
				await body(scratch);
			} finally {
				await fs.rm(scratch, { recursive: true, force: true });
			}
		};

		test("ls lists one directory level", () =>
			withTree(async scratch => {
				const text = await runPiTool(scratch, "ls", { path: scratch });
				expect(text).toContain("top.ts");
				expect(text).toContain("sub/");
				expect(text).not.toContain("mid.ts");
			}));

		test("find matches a slash-free glob against file names at any depth", () =>
			withTree(async scratch => {
				const text = await runPiTool(scratch, "find", { path: scratch, pattern: "*.ts" });
				expect(text).toContain("top.ts");
				expect(text).toContain("low.ts");
			}));

		test("find matches a slash pattern at any depth like fd --full-path", () =>
			withTree(async scratch => {
				const text = await runPiTool(scratch, "find", { path: scratch, pattern: "deep/*.ts" });
				expect(text).toContain("low.ts");
				expect(text).not.toContain("mid.ts");
			}));

		test("grep literal matches the pattern text, not the regex", () =>
			withTree(async scratch => {
				const text = await runPiTool(scratch, "grep", { path: scratch, pattern: "call(a.b)", literal: true });
				expect(text).toContain("top.ts");
				expect(text).not.toContain("mid.ts");
			}));
	});
	test("executes the oh_my_opencode list schema through real host glob", async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-list-"));
		try {
			await Bun.write(path.join(scratch, "sample.txt"), "sample-content\n");
			const loaded = await loadNativeHarness({ specPath: "oh_my_opencode", workspaceRoot: scratch });
			const tool = loaded.registeredToolSurface.native.find(t => t.name === "list");
			if (!tool) throw new Error("missing oh_my_opencode list tool");
			const hostGlob = new GlobTool(patchSession(scratch));
			const result = await researchBindingForTool(tool).run({
				input: { path: scratch },
				harness: { workspaceRoot: scratch } as never,
				context: {
					invokeTool: async (params: JsonObject) =>
						hostGlob.execute("research-list", hostGlob.parameters.assert(params)),
				} as never,
				signal: undefined,
				onUpdate: undefined,
				todos: {} as never,
				guard: {} as never,
			});
			expect(result.isError).not.toBe(true);
			expect(result.text).toContain("sample.txt");
		} finally {
			await fs.rm(scratch, { recursive: true, force: true });
		}
	});

	test("executes the claude_code Glob schema through real host glob", async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-glob-"));
		try {
			const sub = path.join(scratch, "subdir");
			await fs.mkdir(sub);
			await Bun.write(path.join(sub, "matched.ts"), "ts-content\n");
			await Bun.write(path.join(sub, "ignored.txt"), "txt-content\n");
			const loaded = await loadNativeHarness({ specPath: "claude_code", workspaceRoot: scratch });
			const tool = loaded.registeredToolSurface.native.find(t => t.name === "Glob");
			if (!tool) throw new Error("missing claude_code Glob tool");
			const hostGlob = new GlobTool(patchSession(scratch));
			const result = await researchBindingForTool(tool).run({
				input: { path: sub, pattern: "*.ts" },
				harness: { workspaceRoot: scratch } as never,
				context: {
					invokeTool: async (params: JsonObject) =>
						hostGlob.execute("research-glob", hostGlob.parameters.assert(params)),
				} as never,
				signal: undefined,
				onUpdate: undefined,
				todos: {} as never,
				guard: {} as never,
			});
			expect(result.isError).not.toBe(true);
			expect(result.text).toContain("matched.ts");
		} finally {
			await fs.rm(scratch, { recursive: true, force: true });
		}
	});

	test("executes the oh_my_opencode grep schema with include through real host grep", async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-grep-"));
		try {
			await Bun.write(path.join(scratch, "needle.ts"), "FIND_ME_IN_TS\n");
			await Bun.write(path.join(scratch, "needle.md"), "FIND_ME_IN_MD\n");
			await Bun.write(path.join(scratch, "nested", "deeper.ts"), "FIND_ME_NESTED\n");
			const loaded = await loadNativeHarness({ specPath: "oh_my_opencode", workspaceRoot: scratch });
			const tool = loaded.registeredToolSurface.native.find(t => t.name === "grep");
			if (!tool) throw new Error("missing oh_my_opencode grep tool");
			const hostGrep = new GrepTool(patchSession(scratch));
			const result = await researchBindingForTool(tool).run({
				input: { pattern: "FIND_ME", path: scratch, include: "*.ts" },
				harness: { workspaceRoot: scratch } as never,
				context: {
					invokeTool: async (params: JsonObject) =>
						hostGrep.execute("research-grep", hostGrep.parameters.assert(params)),
				} as never,
				signal: undefined,
				onUpdate: undefined,
				todos: {} as never,
				guard: {} as never,
			});
			expect(result.isError).not.toBe(true);
			expect(result.text).toContain("needle.ts");
			expect(result.text).not.toContain("needle.md");
			expect(result.text).toContain("deeper.ts");
		} finally {
			await fs.rm(scratch, { recursive: true, force: true });
		}
	});

	test("reads the same host window for a 1-indexed and a declared 0-based offset", async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-read-"));
		try {
			const target = path.join(scratch, "lines.txt");
			await Bun.write(target, Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join("\n"));
			const hostRead = new ReadTool(patchSession(scratch));
			const readWindow = async (harnessId: string, input: Record<string, unknown>) => {
				const loaded = await loadNativeHarness({ specPath: harnessId, workspaceRoot: scratch });
				const tool = loaded.registeredToolSurface.native.find(t => t.name === "read");
				if (!tool) throw new Error(`missing ${harnessId} read tool`);
				const result = await researchBindingForTool(tool).run({
					input: input as JsonObject,
					harness: { workspaceRoot: scratch } as never,
					context: {
						invokeTool: async (params: JsonObject) =>
							hostRead.execute("research-read", hostRead.parameters.assert(params)),
					} as never,
					signal: undefined,
					onUpdate: undefined,
					todos: {} as never,
					guard: {} as never,
				});
				expect(result.isError).not.toBe(true);
				return result.text;
			};
			// Line 10 is offset 10 in pi's declared 1-indexed contract and offset 9 in oh_my_opencode's 0-based one.
			const oneIndexed = await readWindow("pi", { path: target, offset: 10, limit: 5 });
			const zeroBased = await readWindow("oh_my_opencode", { filePath: target, offset: 9, limit: 5 });
			expect(oneIndexed).toContain("line-10");
			expect(oneIndexed).toContain("line-14");
			expect(zeroBased).toBe(oneIndexed);
		} finally {
			await fs.rm(scratch, { recursive: true, force: true });
		}
	});

	test("executes the claude_code Skill schema by loading skill:// URI through real host read", async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-skill-"));
		const skillDir = path.join(scratch, "test-skill");
		try {
			await fs.mkdir(skillDir);
			await Bun.write(path.join(skillDir, "SKILL.md"), "# Specialized Test Skill Instructions\n");
			const session = {
				...patchSession(scratch),
				skills: [
					{
						name: "test-skill",
						description: "test skill description",
						filePath: path.join(skillDir, "SKILL.md"),
						baseDir: skillDir,
						source: "user" as const,
					},
				],
			};
			const loaded = await loadNativeHarness({ specPath: "claude_code", workspaceRoot: scratch });
			const tool = loaded.registeredToolSurface.native.find(t => t.name === "Skill");
			if (!tool) throw new Error("missing claude_code Skill tool");
			const hostRead = new ReadTool(session);
			const result = await researchBindingForTool(tool).run({
				input: { skill: "test-skill" },
				harness: { workspaceRoot: scratch } as never,
				context: {
					invokeTool: async (params: JsonObject) =>
						hostRead.execute("research-skill", hostRead.parameters.assert(params)),
				} as never,
				signal: undefined,
				onUpdate: undefined,
				todos: {} as never,
				guard: {} as never,
			});
			expect(result.isError).not.toBe(true);
			expect(result.text).toContain("Specialized Test Skill Instructions");
		} finally {
			await fs.rm(scratch, { recursive: true, force: true });
		}
	});

	test("adapts oh_my_opencode task schema into host batch task, validating at executor boundary", async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "research-binding-task-"));
		try {
			const session = createHostSession(scratch, { taskBatch: true });
			const hostTask = await TaskTool.create(session);
			const loaded = await loadNativeHarness({ specPath: "oh_my_opencode", workspaceRoot: scratch });
			const tool = loaded.registeredToolSurface.native.find(t => t.name === "task");
			if (!tool) throw new Error("missing oh_my_opencode task tool");
			let capturedBatch: JsonObject | undefined;
			const result = await researchBindingForTool(tool).run({
				input: {
					description: "Research task",
					prompt: "Perform subagent investigation",
					subagent_type: "general",
				},
				harness: { workspaceRoot: scratch } as never,
				context: {
					invokeTool: async (params: JsonObject) => {
						capturedBatch = params;
						const validated = hostTask.parameters.assert(params) as { tasks: unknown[] };
						return {
							content: [{ type: "text", text: `task-staged: ${validated.tasks.length} tasks` }],
						};
					},
				} as never,
				signal: undefined,
				onUpdate: undefined,
				todos: {} as never,
				guard: {} as never,
			});
			expect(result.isError).not.toBe(true);
			expect(result.text).toContain("task-staged: 1 tasks");
			expect(capturedBatch).toBeDefined();
			expect(capturedBatch!.context).toBe("Research task\nRequested agent role: general");
			const [item] = capturedBatch!.tasks as Array<Record<string, unknown>>;
			expect(item.task).toBe("Perform subagent investigation");
			// "general" is an oh-my-opencode role, not a host agent; the host default agent must run it.
			expect(item.agent).toBeUndefined();
		} finally {
			await fs.rm(scratch, { recursive: true, force: true });
		}
	});

	describe("research pack delegation contract against current host schemas", () => {
		const RESEARCH_HARNESS_IDS = ["claude_code", "codex", "opencode", "oh_my_opencode", "pi", "oh_my_pi"] as const;

		for (const harnessId of RESEARCH_HARNESS_IDS) {
			test(`validates delegated tools for ${harnessId} against current host tool schemas`, async () => {
				const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `research-contract-${harnessId}-`));
				try {
					const session = createHostSession(scratch);
					const loaded = await loadNativeHarness({ specPath: harnessId, workspaceRoot: scratch });
					for (const tool of loaded.registeredToolSurface.native) {
						const binding = researchBindingForTool(tool);
						if (!binding.delegate || binding.delegate === "apply_patch") continue;

						const hostTool = await resolveHostTool(binding, tool, session);
						expect(hostTool).toBeDefined();

						const hostSchema = hostTool!.parameters.toJsonSchema();
						const hostProperties = new Set(Object.keys(hostSchema.properties ?? {}));
						const hostRequired = new Set<string>((hostSchema.required as string[] | undefined) ?? []);

						const packProperties = Object.keys(tool.parameters.properties ?? {});
						const dummyInput = Object.fromEntries(packProperties.map(key => [key, `mock-${key}`]));

						let mappedArgs: Record<string, unknown> | undefined;
						await binding.run({
							input: dummyInput,
							harness: { workspaceRoot: scratch } as never,
							context: {
								invokeTool: async (params: Record<string, unknown>) => {
									mappedArgs = params;
									return { content: [{ type: "text", text: "ok" }] };
								},
							} as never,
							signal: undefined,
							onUpdate: undefined,
							todos: {} as never,
							guard: {} as never,
						});

						expect(mappedArgs).toBeDefined();

						// (1) Every mapped argument must be an accepted parameter of the host tool
						for (const mappedKey of Object.keys(mappedArgs!)) {
							expect(
								hostProperties.has(mappedKey),
								`Pack '${harnessId}' tool '${tool.name}' mapped argument '${mappedKey}' which is not a parameter of host '${hostTool!.name}' (valid parameters: ${[...hostProperties].join(", ")})`,
							).toBe(true);
						}

						// (2) Every required host parameter must have a declared source in the pack schema
						for (const requiredKey of hostRequired) {
							expect(
								mappedArgs![requiredKey],
								`Pack '${harnessId}' tool '${tool.name}' delegates to host '${hostTool!.name}', but required parameter '${requiredKey}' has no declared source in pack parameters (${packProperties.join(", ")})`,
							).toBeDefined();
						}
					}
				} finally {
					await fs.rm(scratch, { recursive: true, force: true });
				}
			});
		}
	});
});
