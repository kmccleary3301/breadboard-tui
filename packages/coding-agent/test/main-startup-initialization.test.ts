import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { resolveBreadboardBackendModel, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const SESSION_FIXTURE = path.join(import.meta.dir, "fixtures", "large-session.jsonl");

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "ProcessExitSignal";
	}
}

async function runEarlyExit(args: string[]): Promise<{
	exitCode: number;
	stdout: string;
	discoverCalls: number;
}> {
	using agentDir = TempDir.createSync("@omp-main-startup-");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
	setAgentDir(agentDir.path());

	const fixtureBefore = await Bun.file(SESSION_FIXTURE).text();
	const output: string[] = [];
	const events: string[] = [];
	let captureStdoutEvents = false;
	let discoverCalls = 0;
	let thrown: unknown;
	const previousExitCode = process.exitCode;

	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		if (captureStdoutEvents) events.push("stdout");
		return true;
	});
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		events.push("exit");
		throw new ProcessExitSignal(code ?? 0);
	}) as typeof process.exit);
	captureStdoutEvents = true;

	try {
		const parsed = args[0] === "--version" ? parseArgs(args) : parseArgs(["--export", ...args]);
		await runRootCommand(parsed, args, {
			discoverAuthStorage: async () => {
				discoverCalls += 1;
				events.push("discover");
				throw new Error("early-exit commands must not initialize auth storage");
			},
		});
	} catch (error) {
		thrown = error;
	} finally {
		vi.restoreAllMocks();
		process.exitCode = previousExitCode;
		if (previousAgentDir === undefined) {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			setAgentDir(previousAgentDir);
		}
	}

	const fixtureAfter = await Bun.file(SESSION_FIXTURE).text();
	expect(fixtureAfter).toBe(fixtureBefore);
	expect(thrown).toBeInstanceOf(ProcessExitSignal);
	expect(events).toEqual(["stdout", "exit"]);
	expect(discoverCalls).toBe(0);

	return {
		exitCode: (thrown as ProcessExitSignal).code,
		stdout: output.join(""),
		discoverCalls,
	};
}

describe("runRootCommand — startup early exits", () => {
	it("prints --version without initializing auth or models", async () => {
		const result = await runEarlyExit(["--version"]);

		expect(result.exitCode).toBe(0);
		expect(result.discoverCalls).toBe(0);
		expect(result.stdout).toMatch(/\S+\n/);
	});

	it("exports a session without initializing auth or models or mutating its fixture", async () => {
		using outputDir = TempDir.createSync("@omp-main-export-");
		const outputPath = path.join(outputDir.path(), "session.html");
		const result = await runEarlyExit([SESSION_FIXTURE, outputPath]);

		expect(result.exitCode).toBe(0);
		expect(result.discoverCalls).toBe(0);
		expect(fs.existsSync(outputPath)).toBe(true);
		expect(result.stdout).toContain(`Exported to: ${outputPath}`);
	});
});

describe("BreadBoard backend model authority", () => {
	it("maps the engine codex runtime id to OMP's openai-codex catalog id", () => {
		const model = { provider: "openai-codex", id: "gpt-5.5" } as Model;

		expect(
			resolveBreadboardBackendModel("codex/gpt-5.5", {
				getAll: () => [model],
			}),
		).toBe(model);
	});
});
