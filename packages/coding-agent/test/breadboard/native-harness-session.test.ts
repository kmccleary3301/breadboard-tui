/**
 * An OMP session configured by a compiled R39 harness runs Python's tool contract on OMP's loop:
 * harness function tools only, `run_shell` through OMP bash with Python's result text, text-dialect
 * TodoWrite through `turn_settle`, the strict-todo completion guard, per-turn framing, and a
 * `mark_task_complete` that ends the run.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type LoadedNativeHarness, loadNativeHarness } from "@breadboard/harness";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { applyNativeHarnessSessionOptions } from "@oh-my-pi/pi-coding-agent/breadboard/native-harness-session";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const R39_FIXTURE = path.resolve(import.meta.dir, "../../../breadboard-harness/test/native/fixtures/r39-workspace");
const R39_SPEC = ".breadboard/bb-omp/r39/bb-omp.harness.yaml";
const GUARD_ONE_OPEN = "Outstanding todos must be completed or canceled before finishing. Pending items: write the test";

let modelRegistry: ModelRegistry;
const tempDirs: string[] = [];
const sessions: AgentSession[] = [];

beforeAll(async () => {
	const authDir = fs.mkdtempSync(path.join(os.tmpdir(), `bb-native-session-auth-${Snowflake.next()}-`));
	tempDirs.push(authDir);
	modelRegistry = new ModelRegistry(await discoverAuthStorage(authDir));
	modelRegistry.authStorage.keys.setRuntime("openai", "test-key");
});

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
});

afterAll(() => {
	for (const dir of tempDirs) removeSyncWithRetries(dir);
});

async function nativeSession(
	responses: MockResponse[],
	options: { autoApprove?: boolean; extensions?: ExtensionFactory[] } = {},
	configureHarness?: (harness: LoadedNativeHarness) => LoadedNativeHarness,
): Promise<{ session: AgentSession; harness: LoadedNativeHarness; calls: ReturnType<typeof createMockModel>["calls"] }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bb-native-session-${Snowflake.next()}-`));
	tempDirs.push(root);
	const cwd = fs.realpathSync(root);
	fs.cpSync(R39_FIXTURE, cwd, { recursive: true });
	const loadedHarness = await loadNativeHarness({ specPath: R39_SPEC, workspaceRoot: cwd });
	const harness = configureHarness?.(loadedHarness) ?? loadedHarness;
	const settings = Settings.isolated({
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"bashInterceptor.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
	});
	const sessionOptions: CreateAgentSessionOptions = {
		cwd,
		agentDir: cwd,
		modelRegistry,
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		model: getBundledModel("openai", "gpt-4o-mini"),
		autoApprove: options.autoApprove ?? false,
		disableExtensionDiscovery: true,
		skills: [],
		rules: [],
		contextFiles: [],
		workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	};
	applyNativeHarnessSessionOptions(sessionOptions, harness, settings, { approvalSelected: false });
	if (options.extensions) {
		sessionOptions.extensions = [...(sessionOptions.extensions ?? []), ...options.extensions];
	}
	const { session } = await createAgentSession(sessionOptions);
	sessions.push(session);
	const mock = createMockModel({ responses });
	vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
	return { session, harness, calls: mock.calls };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): MockResponse {
	return { content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" };
}

const todoWrite: MockResponse = {
	content: [
		{
			type: "text",
			text: '<TOOL_CALL> TodoWrite(todos=[{"content": "write the test", "status": "pending", "activeForm": "Writing the test"}]) </TOOL_CALL>',
		},
	],
	stopReason: "stop",
};

function toolResult(session: AgentSession, id: string): ToolResultMessage | undefined {
	return session.messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === id,
	);
}

function textOf(message: { content: ReadonlyArray<{ type: string; text?: string }> } | undefined): string {
	return (message?.content ?? []).flatMap(block => (block.type === "text" && block.text ? [block.text] : [])).join("");
}

function userTexts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap(message => {
		if (message.role !== "user") return [];
		const content = message.content;
		return [typeof content === "string" ? content : textOf({ content })];
	});
}
function configureStagedHarness(harness: LoadedNativeHarness, planTurnLimit = 1): LoadedNativeHarness {
	const toolByName = new Map(harness.registeredToolSurface.native.map(tool => [tool.name, tool]));
	const pack = (mode: string, names: string[]) => ({
		mode,
		native: names.map(name => {
			const tool = toolByName.get(name);
			if (!tool) throw new Error(`fixture does not provide ${name}`);
			return tool;
		}),
		textInvoked: harness.toolSurface.textInvoked,
	});
	const planPack = pack("plan", ["read_file"]);
	const buildPack = pack("build", ["run_shell"]);
	const plan = { mode: "plan", systemPrompt: "PLAN_STAGE_PROMPT", perTurnPrompt: "", toolSurface: planPack };
	const build = { mode: "build", systemPrompt: "BUILD_STAGE_PROMPT", perTurnPrompt: "", toolSurface: buildPack };
	const effectiveValues = Array.isArray(harness.lock.effective_values)
		? harness.lock.effective_values.map(value => {
				if (!value || typeof value !== "object") return value;
				const entry = value as { path?: unknown; value?: unknown };
				if (entry.path === "modes") {
					return {
						...entry,
						value: [
							{ name: "plan", prompt: "PLAN_STAGE_PROMPT", tools_enabled: ["read_file"] },
							{ name: "build", prompt: "BUILD_STAGE_PROMPT", tools_enabled: ["run_shell"] },
						],
					};
				}
				if (entry.path === "loop.sequence") return { ...entry, value: [{ mode: "plan", if: "features.plan" }, { mode: "build" }] };
				return value;
			})
		: [];
	effectiveValues.push(
		{ path: "features.plan", value: true },
		{ path: "loop.plan_turn_limit", value: planTurnLimit },
	);
	const lock = { ...harness.lock, effective_values: effectiveValues };
	return {
		...harness,
		lock,
		systemPrompt: plan.systemPrompt,
		toolSurface: planPack,
		stages: [plan, build],
		registeredToolSurface: { mode: "registered", native: [...planPack.native, ...buildPack.native], textInvoked: [] },
	};
}


describe("native harness session", () => {
	it("sends exactly the harness function tools and schemas under the compiled system prompt", async () => {
		const { session, harness, calls } = await nativeSession(
			[
				toolCall("shell-1", "run_shell", { command: "printf ok" }),
				{ content: [{ type: "text", text: "ok" }], stopReason: "stop" },
			],
			{ autoApprove: true },
		);
		expect(session.getActiveToolNames().toSorted()).toEqual(
			["create_file_from_block", "eval", "list_dir", "mark_task_complete", "read_file", "run_shell"].toSorted(),
		);
		expect(session.agent.state.systemPrompt.join("\n\n")).toBe(harness.systemPrompt);

		await session.prompt("hello");
		await session.waitForIdle();
		// Python sends the compiled schemas unchanged (`provider/adapters.py:98-164`): no intent field, no closed
		// objects, and nothing left behind by validating the run_shell call.
		const expected = Object.fromEntries(harness.toolSurface.native.map(tool => [tool.name, tool.parameters]));
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			const wire = Object.fromEntries((call.context.tools ?? []).map(tool => [tool.name, tool.parameters]));
			expect(JSON.parse(JSON.stringify(wire))).toEqual(expected);
		}
	});

	it("runs run_shell on OMP bash, returns Python's result text, and ends the run on mark_task_complete", async () => {
		const { session, harness, calls } = await nativeSession(
			[
				toolCall("shell-1", "run_shell", { command: "printf native-ok" }),
				toolCall("done-1", "mark_task_complete", {}),
				{ content: [{ type: "text", text: "never requested" }] },
			],
			{ autoApprove: true },
		);

		await session.prompt("hello");
		await session.waitForIdle();

		expect(textOf(toolResult(session, "shell-1"))).toBe(
			'{"stdout": "native-ok", "exit": 0, "__mvi_text_output": "native-ok"}',
		);
		expect(toolResult(session, "done-1")?.isError).toBe(false);
		expect(calls).toHaveLength(2);
		// The model sees Python's framing; the transcript keeps what the user typed.
		expect(userTexts(calls[0]?.context.messages ?? [])).toEqual([
			`hello\n\n<BREADBOARD_INTERNAL>\n${harness.perTurnPrompt}\n</BREADBOARD_INTERNAL>`,
		]);
		expect(userTexts(session.messages)).toEqual(["hello"]);
	});

	it("runs text TodoWrite at the turn boundary and holds completion while a todo is open", async () => {
		const { session, calls } = await nativeSession([
			todoWrite,
			toolCall("done-early", "mark_task_complete", {}),
			{ content: [{ type: "text", text: "still working" }], stopReason: "stop" },
		]);

		await session.prompt("plan it");
		await session.waitForIdle();

		expect(calls).toHaveLength(3);
		// Python's TodoWrite success text (`todo/manager.py`), sent back as a user message.
		expect(userTexts(calls[1]?.context.messages ?? []).at(-1)).toBe(
			'[TodoWrite] "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable"',
		);
		// The held completion keeps its normal result; Python's advisory follows it as a user message.
		expect(toolResult(session, "done-early")?.isError).toBe(false);
		expect(userTexts(calls[2]?.context.messages ?? []).at(-1)).toBe(
			`<VALIDATION_ERROR>\n${GUARD_ONE_OPEN}\nCompletion guard engaged. Provide concrete file edits and successful tests. Warnings remaining before abort: 1.\n</VALIDATION_ERROR>`,
		);
	});

	it("ends the run on the second held completion, as Python's guard threshold does", async () => {
		const { session, calls } = await nativeSession([
			todoWrite,
			toolCall("done-1", "mark_task_complete", {}),
			toolCall("done-2", "mark_task_complete", {}),
			{ content: [{ type: "text", text: "never requested" }] },
		]);

		await session.prompt("plan it");
		await session.waitForIdle();

		expect(calls).toHaveLength(3);
		expect(toolResult(session, "done-2")?.isError).toBe(false);
	});

	it("asks before run_shell under the harness's prompt permissions", async () => {
		const { session, calls } = await nativeSession([
			toolCall("shell-denied", "run_shell", { command: "printf should-not-run > ran.txt" }),
			{ content: [{ type: "text", text: "ok" }], stopReason: "stop" },
		]);

		await session.prompt("hello");
		await session.waitForIdle();

		expect(calls).toHaveLength(2);
		expect(toolResult(session, "shell-denied")?.isError).toBe(true);
		expect(fs.existsSync(path.join(session.sessionManager.getCwd(), "ran.txt"))).toBe(false);
	});
	it("applies the next stage on the continuation provider request", async () => {
		const prepareEvents: Array<{ previousMode: string | undefined }> = [];
		const observer: ExtensionFactory = api => {
			api.on("turn_prepare", event => {
				prepareEvents.push({ previousMode: event.previousMode });
			});
		};
		const { session, calls } = await nativeSession(
			[
				{
					content: [
						...(todoWrite.content ?? []),
						{ type: "toolCall", id: "read-1", name: "read_file", arguments: { path: "prompts/daily_driver_system.md" } },
					],
					stopReason: "toolUse",
				},
				{ content: [{ type: "text", text: "build complete" }], stopReason: "stop" },
			],
			{ extensions: [observer] },
			configureStagedHarness,
		);

		await session.prompt("implement it");
		await session.waitForIdle();

		// Python's stage transition waits for the turn boundary after TodoWrite
		// (`agent_llm_openai.py:3052-3080`, `guardrails/orchestrator.py:269-349`).
		expect(prepareEvents.map(event => event.previousMode)).toEqual([undefined, "plan"]);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.context.systemPrompt).toEqual(["PLAN_STAGE_PROMPT"]);
		expect(calls[0]?.context.tools?.map(tool => tool.name)).toEqual(["read_file"]);
		expect(calls[1]?.context.systemPrompt).toEqual(["BUILD_STAGE_PROMPT"]);
		expect(calls[1]?.context.tools?.map(tool => tool.name)).toEqual(["run_shell"]);
	});
	it("keeps build mode on the second prompt after a two-turn plan run", async () => {
		const { session, calls } = await nativeSession(
			[
				{
					content: [
						{
							type: "text",
							text: '<TOOL_CALL> TodoWrite(todos=[{"content":"closed work","status":"completed"}]) </TOOL_CALL>',
						},
						{ type: "toolCall", id: "read-1", name: "read_file", arguments: { path: "prompts/daily_driver_system.md" } },
					],
					stopReason: "toolUse",
				},
				{ content: [{ type: "text", text: "first run complete" }], stopReason: "stop" },
				{ content: [{ type: "text", text: "second run complete" }], stopReason: "stop" },
			],
			{},
			harness => configureStagedHarness(harness, 2),
		);

		await session.prompt("first run");
		await session.waitForIdle();
		await session.prompt("second run");
		await session.waitForIdle();

		expect(calls).toHaveLength(3);
		expect(calls[0]?.context.systemPrompt).toEqual(["PLAN_STAGE_PROMPT"]);
		expect(calls[2]?.context.systemPrompt).toEqual(["BUILD_STAGE_PROMPT"]);
		expect(calls[2]?.context.tools?.map(tool => tool.name)).toEqual(["run_shell"]);
	});
});

type OmpSessionKind = "stock" | "bb-omp.native" | "bridge";

/** One OMP session per kind over the same settings and workspace: stock OMP, native mode on `bb-omp.native`, or a bridge-owned stream. */
async function ompSession(
	kind: OmpSessionKind,
	responses: MockResponse[] = [],
): Promise<{ session: AgentSession; harness?: LoadedNativeHarness; calls: ReturnType<typeof createMockModel>["calls"] }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bb-omp-native-${Snowflake.next()}-`));
	tempDirs.push(root);
	const cwd = fs.realpathSync(root);
	const settings = Settings.isolated({ "retry.enabled": false });
	const mock = createMockModel({ responses });
	const options: CreateAgentSessionOptions = {
		cwd,
		agentDir: cwd,
		modelRegistry,
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		rules: [],
		contextFiles: [],
		workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	};
	let harness: LoadedNativeHarness | undefined;
	if (kind === "bb-omp.native") {
		harness = await loadNativeHarness({ specPath: "bb-omp.native", workspaceRoot: cwd });
		applyNativeHarnessSessionOptions(options, harness, settings, { approvalSelected: false });
	}
	if (kind === "bridge") {
		options.mainStreamOwnsTurnLifecycle = true;
		options.mainStreamFn = mock.stream;
	}
	const { session } = await createAgentSession(options);
	sessions.push(session);
	if (kind !== "bridge") vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
	return { session, harness, calls: mock.calls };
}

describe("bb-omp.native session", () => {
	it("keeps OMP's own tools, prompt and settings and appends the BreadBoard identity pack", async () => {
		const done: MockResponse = { content: [{ type: "text", text: "ok" }], stopReason: "stop" };
		const stock = await ompSession("stock", [done]);
		const native = await ompSession("bb-omp.native", [done]);
		expect(native.harness?.hostSurface).toBe(true);
		expect(native.session.getActiveToolNames()).toEqual(stock.session.getActiveToolNames());
		expect(native.session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "eval", "task", "read", "edit"]));
		expect(native.session.settings.get("todo.enabled")).toBe(stock.session.settings.get("todo.enabled"));
		expect(native.session.settings.get("tools.intentTracing")).toBe(stock.session.settings.get("tools.intentTracing"));

		for (const { session } of [stock, native]) {
			await session.prompt("hello");
			await session.waitForIdle();
		}
		const stockRequest = stock.calls[0]?.context;
		const nativeRequest = native.calls[0]?.context;
		expect(nativeRequest?.tools?.map(tool => tool.name)).toEqual(stockRequest?.tools?.map(tool => tool.name));
		const identity = native.harness?.systemPrompt ?? "";
		expect(identity).toStartWith("# BreadBoard");
		expect(nativeRequest?.systemPrompt).toEqual([...(stockRequest?.systemPrompt ?? []), identity]);
	});

	it("lifts every OMP control that a bridge-owned session restricts", async () => {
		const native = (await ompSession("bb-omp.native")).session;
		const bridge = (await ompSession("bridge")).session;
		expect(native.mainStreamOwnsTurnLifecycle).toBe(false);
		expect(bridge.mainStreamOwnsTurnLifecycle).toBe(true);
		const model = native.model;
		if (model === undefined) throw new Error("the fixture session has a model");
		const controls: ReadonlyArray<readonly [string, (session: AgentSession) => unknown]> = [
			["advisor", session => session.setAdvisorEnabled(true)],
			["compaction", session => session.setAutoCompactionEnabled(false)],
			["plan", session => session.setPlanReferencePath("plan.md")],
			["automation", session => session.followUp("continue after this turn")],
			["prewalk", session => session.armPrewalk(model)],
			["thinking", session => session.setThinkingLevel("auto")],
			["context", session => session.dropImages()],
			["provider-state", session => session.pinCurrentProviderOAuthAccount(1)],
			["model-roles", session => session.setModel(model)],
			["native-session-transition", session => session.newSession()],
		];
		for (const [control, run] of controls) {
			const attempt = async (session: AgentSession): Promise<unknown> => {
				try {
					await run(session);
					return undefined;
				} catch (error) {
					return error;
				}
			};
			expect({ control, error: String(await attempt(native)) }).toEqual({ control, error: "undefined" });
			expect({ control, error: String(await attempt(bridge)) }).toEqual({ control, error: expect.stringMatching(/BreadBoard/) });
		}
	});
});
