/**
 * Generic extension-tool seams. `toolDelegates` lets an extension tool reach a built-in through
 * `ctx.invokeTool` under its own name and schema without activating that built-in; `terminal` on a
 * tool definition reaches the session tool.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const SETTINGS = { "async.enabled": false, "bash.autoBackground.enabled": false, "bashInterceptor.enabled": false };

const runShell: ExtensionFactory = api => {
	api.registerTool({
		name: "run_shell",
		label: "run_shell",
		description: "Run a shell command.",
		parameters: api.typebox.Type.Object({ command: api.typebox.Type.String() }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (ctx.invokeTool === undefined) return { content: [{ type: "text", text: "no delegate" }] };
			const result = await ctx.invokeTool({ command: params.command }, { signal });
			return { content: result.content };
		},
	});
	api.registerTool({
		name: "finish",
		label: "finish",
		description: "Finish the task.",
		parameters: api.typebox.Type.Object({}),
		terminal: true,
		async execute() {
			return { content: [{ type: "text", text: "done" }] };
		},
	});
};

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.flatMap(block => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
}

describe("createAgentSession extension tool seams", () => {
	let tempDir: string;
	let session: AgentSession;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-tool-delegates-${Snowflake.next()}-`));
		const cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager: SessionManager.create(cwd, path.join(tempDir, "sessions")),
			settings: Settings.isolated(SETTINGS),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [runShell],
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["run_shell"],
			toolDelegates: { run_shell: "bash" },
		});
		session = created.session;
	});

	afterAll(async () => {
		await session.dispose();
		removeSyncWithRetries(tempDir);
	});

	it("runs the delegate built-in without activating it", async () => {
		expect(session.getActiveToolNames()).toContain("run_shell");
		expect(session.getActiveToolNames()).not.toContain("bash");
		const tool = session.getToolByName("run_shell");
		if (!tool) throw new Error("Expected run_shell");
		const result = await tool.execute("delegated", { command: "echo delegated-ok" }, undefined, undefined, {
			settings: Settings.isolated(SETTINGS),
		} as AgentToolContext);
		expect(textOf(result)).toContain("delegated-ok");
	});

	it("carries an extension tool's terminal flag onto the session tool", () => {
		expect(session.getToolByName("finish")?.terminal).toBe(true);
		expect(session.getToolByName("run_shell")?.terminal).toBeUndefined();
	});
});
