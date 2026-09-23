import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assembleNativePrompts, frameNativeUserMessage } from "../../src/native/prompt-assembly";
import { loadNativeHarness } from "../../src/native/load-native-harness";

const ROOT = join(import.meta.dir, "fixtures", "r39-workspace");
const R39 = ".breadboard/bb-omp/r39";
const OPENAI = join(import.meta.dir, "fixtures", "r39-openai");

async function loadR39Prompts() {
	const harness = await loadNativeHarness({ specPath: `${R39}/bb-omp.harness.yaml`, workspaceRoot: ROOT });
	const resourcePath = "prompts/daily_driver_system.md";
	const resource = await readFile(join(ROOT, R39, resourcePath));
	return {
		harness,
		resources: new Map([[resourcePath, new Uint8Array(resource)]]),
	};
}

describe("native prompt assembly", () => {
	test("matches the R39 system and per-turn oracle bytes", async () => {
		const { harness, resources } = await loadR39Prompts();
		const actual = await assembleNativePrompts(harness.lock, resources, harness.toolSurface);
		expect(actual.system).toBe(await readFile(join(OPENAI, "compiled_system.md"), "utf8"));
		expect(actual.perTurn).toBe(await readFile(join(OPENAI, "per_turn/turn_1.md"), "utf8"));
	});

	test("frames only the Python-owned internal block", async () => {
		const { harness, resources } = await loadR39Prompts();
		const { perTurn } = await assembleNativePrompts(harness.lock, resources, harness.toolSurface);
		// Python agent_llm_openai.py:6442-6453 joins user_prompt and BREADBOARD_INTERNAL.
		// The capture fixture was generated through conductor/prompt_planner.py:62-85,
		// dialects/pythonic02.py:15-46, execution/composite.py:13-19, and
		// execution/dialect_manager.py:29-35,99-104 (the Pythonic block is repeated twice).
		expect(frameNativeUserMessage("hello", perTurn)).toBe(await readFile(join(OPENAI, "framed_hello.txt"), "utf8"));
		expect(frameNativeUserMessage("hello", perTurn)).not.toStartWith("<system-reminder>");
	});
});
