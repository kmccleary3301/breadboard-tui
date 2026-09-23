import { describe, expect, test } from "bun:test";
import type { JsonRecord } from "../../src/canonical-json";
import { createNativeStageMachine, type NativeHarnessStage } from "../../src/native/stage-machine";

function stage(mode: string): NativeHarnessStage {
	return { mode, systemPrompt: `${mode} prompt`, perTurnPrompt: `${mode} tools`, toolSurface: { mode, native: [], textInvoked: [] } };
}

function lock(sequence: JsonRecord["effective_values"], featuresPlan: boolean, planTurnLimit: number): JsonRecord {
	return {
		effective_values: [
			{ path: "features.plan", value: featuresPlan },
			{ path: "loop.plan_turn_limit", value: planTurnLimit },
			{ path: "loop.sequence", value: sequence },
		],
	};
}

describe("native stage machine", () => {
	test("uses the first eligible conditional stage, then excludes it after plan transition", () => {
		const stages = [stage("plan"), stage("build")];
		const machine = createNativeStageMachine(
			lock(
				[
					{ if: "features.plan", then: { mode: "plan" } },
					{ mode: "build" },
				],
				true,
				1,
			),
			stages,
		);
		expect(machine.current.mode).toBe("plan");
		machine.endTurn(true);
		expect(machine.current.mode).toBe("build");
	});

	test("honors plan_turn_limit and does not count a turn without open todos", () => {
		const machine = createNativeStageMachine(
			lock([{ if: "features.plan", then: { mode: "plan" } }, { mode: "build" }], true, 2),
			[stage("plan"), stage("build")],
		);
		machine.endTurn(false);
		expect(machine.planTurns).toBe(0);
		machine.endTurn(true);
		expect(machine.current.mode).toBe("plan");
		machine.endTurn(true);
		expect(machine.current.mode).toBe("build");
	});

	test("captures consecutive stage requests with prompt and active tools", () => {
		const plan = {
			...stage("plan"),
			systemPrompt: "plan prompt",
			toolSurface: { mode: "plan", native: [{ id: "read", name: "read_file", description: "", parameters: {}, nativePrimary: true }], textInvoked: [] },
		};
		const build = {
			...stage("build"),
			systemPrompt: "build prompt",
			toolSurface: { mode: "build", native: [{ id: "shell", name: "run_shell", description: "", parameters: {}, nativePrimary: true }], textInvoked: [] },
		};
		const machine = createNativeStageMachine(
			lock([{ if: "features.plan", then: { mode: "plan" } }, { mode: "build" }], true, 1),
			[plan, build],
		);
		const requests: Array<{ prompt: string; tools: readonly string[] }> = [];
		requests.push({ prompt: machine.current.systemPrompt, tools: machine.current.toolSurface.native.map(tool => tool.name) });
		machine.endTurn(true);
		requests.push({ prompt: machine.current.systemPrompt, tools: machine.current.toolSurface.native.map(tool => tool.name) });
		// Python mode resolution: `agent_llm_openai.py:3052-3080`; transition: `guardrails/orchestrator.py:269-349`.
		expect(requests).toEqual([
			{ prompt: "plan prompt", tools: ["read_file"] },
			{ prompt: "build prompt", tools: ["run_shell"] },
		]);
	});

	test("falls through a disabled conditional in sequence order", () => {
		const machine = createNativeStageMachine(
			lock([{ if: "features.plan", then: { mode: "plan" } }, { mode: "build" }], false, 1),
			[stage("plan"), stage("build")],
		);
		expect(machine.current.mode).toBe("build");
	});
});
