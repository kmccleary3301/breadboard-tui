import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadNativeHarness } from "../../src/native/load-native-harness";
import { frameNativeUserContent, frameNativeUserMessage } from "../../src/native/prompt-assembly";

const ROOT = join(import.meta.dir, "fixtures", "r39-workspace");
const R39 = ".breadboard/bb-omp/r39";
const OPENAI = join(import.meta.dir, "fixtures", "r39-openai");

describe("native prompt assembly", () => {
	test("frames only the Python-owned internal block", async () => {
		const { perTurnPrompt } = await loadNativeHarness({
			specPath: `${R39}/bb-omp.harness.yaml`,
			workspaceRoot: ROOT,
		});
		// Python agent_llm_openai.py:6442-6453 joins user_prompt and BREADBOARD_INTERNAL.
		// The capture fixture was generated through conductor/prompt_planner.py:62-85,
		// dialects/pythonic02.py:15-46, execution/composite.py:13-19, and
		// execution/dialect_manager.py:29-35,99-104 (the Pythonic block is repeated twice).
		expect(frameNativeUserMessage("hello", perTurnPrompt)).toBe(
			await readFile(join(OPENAI, "framed_hello.txt"), "utf8"),
		);
		expect(frameNativeUserMessage("hello", perTurnPrompt)).not.toStartWith("<system-reminder>");
	});

	test("suppresses per-turn framing when the compiled pack sets tool_prompt_mode none", async () => {
		const { perTurnPrompt } = await loadNativeHarness({ specPath: "codex", workspaceRoot: ROOT });
		expect(perTurnPrompt).toBe("");
		expect(frameNativeUserMessage("hello", perTurnPrompt)).toBe("hello");
	});

	test("emits Python's separate tool-catalog text block for Claude persistent mode", async () => {
		const harness = await loadNativeHarness({ specPath: "claude_code", workspaceRoot: ROOT });
		const content = frameNativeUserContent("hello", harness.stages[0]!);
		expect(Array.isArray(content)).toBe(true);
		expect(content).toHaveLength(2);
		expect(content[0]).toEqual({ type: "text", text: frameNativeUserMessage("hello", harness.perTurnPrompt) });
		expect(content[1]).toEqual({
			type: "text",
			text: expect.stringContaining("\n\nSYSTEM MESSAGE - AVAILABLE TOOLS\n"),
		});
	});
});
