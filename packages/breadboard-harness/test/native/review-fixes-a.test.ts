import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoadedNativeHarness, loadNativeHarness } from "../../src/native/load-native-harness";
import {
	createNativeHarnessExtension,
	type NativeCall,
	nativeBindingForTool,
	nativeToolDelegates,
} from "../../src/native/omp-extension";
import type { NativeHarnessStage } from "../../src/native/stage-machine";
import type { JsonRecord } from "../../src/canonical-json";
import type { NativeToolDefinition, NativeToolSurfacePack } from "../../src/native/types";

describe("native harness review fixes", () => {
	describe("R1-1: R39 eval returns Python JSON shape, distinguished by tool definition", () => {
		it("R39 eval call yields the exact Python JSON text while research eval returns raw text", async () => {
			const R39_WORKSPACE = join(import.meta.dir, "fixtures/r39-workspace");
			const R39_SPEC = ".breadboard/bb-omp/r39/bb-omp.harness.yaml";

			const r39Harness = await loadNativeHarness({ specPath: R39_SPEC, workspaceRoot: R39_WORKSPACE });
			const r39EvalTool = r39Harness.registeredToolSurface.native.find(t => t.name === "eval");
			expect(r39EvalTool).toBeDefined();

			const r39Binding = nativeBindingForTool(r39EvalTool!);
			expect(r39Binding).toBeDefined();

			const mockCall = {
				input: { language: "py", code: "print(42)" },
				harness: r39Harness,
				context: {
					invokeTool: async () => ({
						content: [{ type: "text", text: "42\n" }],
						details: { language: "py", isError: false },
						isError: false,
					}),
				},
				signal: new AbortController().signal,
				todos: {},
				guard: {},
			} as unknown as NativeCall;

			const r39Result = await r39Binding!.run(mockCall);
			// R39 must return Python JSON shape:
			const parsed = JSON.parse(r39Result.text);
			expect(parsed).toEqual({
				stdout: "42\n",
				stderr: "",
				exit: 0,
				result: "",
				kernel_reset: false,
				output_truncated: false,
				__mvi_text_output: "42\n",
			});

			// Now test research pack eval (from oh_my_pi)
			const ohMyPiHarness = await loadNativeHarness({
				specPath: "oh_my_pi",
				workspaceRoot: R39_WORKSPACE,
			});
			const ohMyPiEvalTool = ohMyPiHarness.registeredToolSurface.native.find(t => t.name === "eval");
			expect(ohMyPiEvalTool).toBeDefined();

			const ohMyPiBinding = nativeBindingForTool(ohMyPiEvalTool!);
			expect(ohMyPiBinding).toBeDefined();

			const ohMyPiResult = await ohMyPiBinding!.run(mockCall);
			// Research pack returns raw text from OMP, not JSON:
			expect(ohMyPiResult.text).toBe("42\n");
		});
	});

	describe("R1-2: nativeToolDelegates covers every stage's tools (registeredToolSurface)", () => {
		it("includes delegated tools that appear only in stage 2", () => {
			const stage1Tool: NativeToolDefinition = {
				id: "read_file",
				name: "read_file",
				description: "read",
				parameters: {},
				nativePrimary: true,
			};
			const stage2Tool: NativeToolDefinition = {
				id: "run_shell",
				name: "run_shell",
				description: "shell",
				parameters: {},
				nativePrimary: true,
			};

			const stage1Surface: NativeToolSurfacePack = {
				mode: "stage1",
				native: [stage1Tool],
				textInvoked: [],
			};
			const stage2Surface: NativeToolSurfacePack = {
				mode: "stage2",
				native: [stage2Tool],
				textInvoked: [],
			};

			const stages: NativeHarnessStage[] = [
				{
					mode: "stage1",
					systemPrompt: "sys1",
					perTurnPrompt: "turn1",
					toolSurface: stage1Surface,
				},
				{
					mode: "stage2",
					systemPrompt: "sys2",
					perTurnPrompt: "turn2",
					toolSurface: stage2Surface,
				},
			];

			const twoStageHarness: LoadedNativeHarness = {
				harnessId: "two-stage",
				specPath: "/tmp/spec.yaml",
				workspaceRoot: "/tmp",
				lock: {},
				graphHash: "hash",
				sourceHash: "shash",
				hostSurface: false,
				systemPrompt: "sys1",
				perTurnPrompt: "turn1",
				toolSurface: stage1Surface,
				stages,
				registeredToolSurface: {
					mode: "all",
					native: [stage1Tool, stage2Tool],
					textInvoked: [],
				},
				permissions: { mode: "prompt", shell: "ask" },
				todos: { enabled: false, strict: false },
			};

			const delegates = nativeToolDelegates(twoStageHarness);
			// run_shell is in stage 2 only, but must be in delegates!
			expect(delegates["run_shell"]).toBe("bash");
		});
	});

	describe("R1-3: context hook frames each user message once with its turn's stage", () => {
		it("leaves turn-1 framing untouched after plan->build stage change", async () => {
			// TodoWrite is text-invoked in plan mode, as in the research packs (tool-pack.ts forces it off
			// the native surface); the plan -> build transition needs a non-empty board.
			const todoDef: NativeToolDefinition = {
				id: "TodoWrite",
				name: "TodoWrite",
				description: "todo",
				parameters: { type: "object", properties: { todos: { type: "array" } } },
				nativePrimary: false,
			};

			const stagePlan: NativeHarnessStage = {
				mode: "plan",
				systemPrompt: "SYSTEM: PLAN",
				perTurnPrompt: "PER_TURN: PLAN",
				toolPromptMode: "per_turn_append",
				toolSurface: { mode: "plan", native: [], textInvoked: [todoDef] },
			};
			const stageBuild: NativeHarnessStage = {
				mode: "build",
				systemPrompt: "SYSTEM: BUILD",
				perTurnPrompt: "PER_TURN: BUILD",
				toolPromptMode: "per_turn_append",
				toolSurface: { mode: "build", native: [], textInvoked: [] },
			};

			const lock: JsonRecord = {
				effective_values: [
					{ path: "features.plan", value: true },
					{ path: "loop.plan_turn_limit", value: 1 },
					// oxlint-disable-next-line unicorn/no-thenable
					{ path: "loop.sequence", value: [{ if: "features.plan", then: { mode: "plan" } }, { mode: "build" }] },
				],
			};

			const harness: LoadedNativeHarness = {
				harnessId: "test-stages",
				specPath: "/test/spec.yaml",
				workspaceRoot: "/test",
				lock,
				graphHash: "ghash",
				sourceHash: "shash",
				hostSurface: false,
				systemPrompt: stagePlan.systemPrompt,
				perTurnPrompt: stagePlan.perTurnPrompt,
				toolSurface: stagePlan.toolSurface,
				stages: [stagePlan, stageBuild],
				registeredToolSurface: { mode: "all", native: [], textInvoked: [todoDef] },
				permissions: { mode: "prompt", shell: "ask" },
				todos: { enabled: true, strict: false },
			};

			const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
			const mockApi = {
				on(event: string, handler: (...args: unknown[]) => unknown) {
					handlers[event] ??= [];
					handlers[event].push(handler);
				},
				registerCommand() {},
				registerTool() {},
				setActiveTools() {},
				appendEntry() {},
			};

			const factory = createNativeHarnessExtension(harness);
			factory(mockApi as never);

			const contextHandler = handlers["context"]?.[0] as (event: {
				messages: unknown[];
			}) => Promise<{ messages: Array<{ role: string; content: unknown }> }>;
			const turnSettleHandler = handlers["turn_settle"]?.[0] as (
				event: { message: unknown },
				ctx: unknown,
			) => Promise<unknown>;

			// Turn 1 in PLAN mode
			const transcriptTurn1 = [{ role: "user", content: "Plan the project" }];
			const turn1Result = await contextHandler({ messages: transcriptTurn1 });
			expect(turn1Result.messages[0].content).toContain("PER_TURN: PLAN");

			// Assistant completes turn with text tool call, stepping stageMachine to BUILD
			const assistantMsg = {
				role: "assistant",
				content: [
					{
						type: "text",
						text: '<TOOL_CALL> TodoWrite(todos=[{"content": "write outline", "status": "todo"}]) </TOOL_CALL>',
					},
				],
			};
			await turnSettleHandler({ message: assistantMsg }, { hasUI: false });

			// Turn 2 in BUILD mode
			const transcriptTurn2 = [
				{ role: "user", content: "Plan the project" },
				assistantMsg,
				{ role: "user", content: "Now build it" },
			];
			const turn2Result = await contextHandler({ messages: transcriptTurn2 });

			// Turn 1 message MUST NOT be rewritten to BUILD!
			expect(turn2Result.messages[0].content).toContain("PER_TURN: PLAN");
			expect(turn2Result.messages[0].content).not.toContain("PER_TURN: BUILD");

			// Turn 2 message gets BUILD
			expect(turn2Result.messages[2].content).toContain("PER_TURN: BUILD");
		});
	});

	describe("chained Responses requests keep the system prompt", () => {
		const providerRequestHook = async (pack: string) => {
			const harness = await loadNativeHarness({
				specPath: pack,
				workspaceRoot: join(import.meta.dir, "fixtures/r39-workspace"),
			});
			const handlers: Record<string, ((event: { payload: unknown }) => unknown)[]> = {};
			createNativeHarnessExtension(harness)({
				on(event: string, handler: (event: { payload: unknown }) => unknown) {
					(handlers[event] ??= []).push(handler);
				},
				registerCommand() {},
				registerTool() {},
				setActiveTools() {},
				appendEntry() {},
			} as never);
			return (payload: unknown) => handlers.before_provider_request![0]!({ payload }) as JsonRecord;
		};
		const firstRequest = {
			input: [
				{ role: "developer", content: "SYSTEM PROMPT" },
				{ role: "user", content: [{ type: "input_text", text: "task" }] },
			],
		};
		const chainedRequest = {
			previous_response_id: "resp_1",
			input: [{ type: "function_call_output", call_id: "call_1", output: "result" }],
		};

		it("sends instructions again on a chained request (instructions carrier)", async () => {
			const hook = await providerRequestHook("codex");
			expect(hook(firstRequest).instructions).toBe("SYSTEM PROMPT");
			const chained = hook(chainedRequest);
			expect(chained.instructions).toBe("SYSTEM PROMPT");
			expect(chained.input).toEqual(chainedRequest.input);
		});

		it("puts the developer message back ahead of the delta input (developer carrier)", async () => {
			const hook = await providerRequestHook("opencode");
			hook(firstRequest);
			expect(hook(chainedRequest).input).toEqual([
				{ role: "developer", content: [{ type: "input_text", text: "SYSTEM PROMPT" }] },
				...chainedRequest.input,
			]);
		});
	});

	describe("R1-4: tool removed on reload does not execute against stale generation", () => {
		it("throws when calling registered execute for a tool removed in generation 2", async () => {
			const FIXTURE = join(import.meta.dir, "fixtures/r39-workspace/.breadboard/bb-omp/r39");
			const root = await mkdtemp(join(tmpdir(), "bb-test-r1-4-"));
			try {
				const SPEC = ".breadboard/bb-omp/r39/bb-omp.harness.yaml";
				const PROMPT = ".breadboard/bb-omp/r39/prompts/daily_driver_system.md";
				const source = await readFile(join(FIXTURE, "bb-omp.harness.yaml"), "utf8");
				await mkdir(join(root, ".breadboard/bb-omp/r39/prompts"), { recursive: true });
				await writeFile(join(root, SPEC), source);
				await writeFile(join(root, PROMPT), await readFile(join(FIXTURE, "prompts/daily_driver_system.md")));

				const harness = await loadNativeHarness({ workspaceRoot: root, specPath: SPEC });

				const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
				const registeredTools = new Map<
					string,
					{ name: string; execute: (...args: unknown[]) => Promise<unknown> }
				>();

				const api = {
					on(event: string, handler: (...args: unknown[]) => unknown) {
						const list = handlers.get(event) ?? [];
						list.push(handler);
						handlers.set(event, list);
					},
					registerCommand() {},
					registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
						registeredTools.set(tool.name, tool);
					},
					setActiveTools() {},
					appendEntry() {},
				};

				createNativeHarnessExtension(harness)(api as never);
				for (const h of handlers.get("agent_start") ?? []) await h({}, {});

				// Gen 1 has list_dir
				const listDirTool = registeredTools.get("list_dir");
				expect(listDirTool).toBeDefined();

				// Modify spec to remove list_dir in Gen 2
				const sourcePath = join(root, SPEC);
				const g1Source = await readFile(sourcePath, "utf8");
				await writeFile(sourcePath, g1Source.replace("  - list_dir\n", ""));

				await harness.live?.reload();
				// Commit reload on turn_start
				for (const h of handlers.get("turn_start") ?? []) await h({}, {});

				// Calling registered execute on the removed list_dir tool must throw and not run against Gen 1!
				await expect(listDirTool!.execute("call-1", { path: "." }, undefined, undefined, {})).rejects.toThrow(
					/not registered in the active generation/i,
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	});
});
