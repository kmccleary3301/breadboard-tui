import { describe, expect, it } from "bun:test";
import { EFFECTIVE_LOCK_FIXTURE } from "../modes/components/effective-lock-fixture";
import {
	lockValue,
	longRunBudgets,
	longRunEnabled,
	posture,
	teamSize,
} from "@oh-my-pi/pi-coding-agent/breadboard/harness-lock-view";

type Lock = Parameters<typeof lockValue>[0];

function lockWith(rows: readonly Record<string, unknown>[]): Lock {
	return { ...EFFECTIVE_LOCK_FIXTURE, effective_values: rows };
}

const row = (path: string, valueKind: string, value: unknown, visibility = "model-visible") => ({
	path,
	value_kind: valueKind,
	value,
	source_layer_id: "workspace_project",
	visibility,
	env_gate_ids: [],
});

describe("harness lock projection", () => {
	it("omits redacted and secret-reference rows regardless of the other field", () => {
		const lock = lockWith([
			row("providers.openai.api_key", "secret-ref", "secret://env/OPENAI_API_KEY", "redacted"),
			row("providers.openai.org", "string", "org-123", "redacted"),
			row("providers.openai.token_hint", "secret-ref", "secret://env/TOKEN"),
			row("workspace.root", "string", "/repo", "host-only"),
		]);
		expect(lockValue(lock, "providers.openai.api_key")).toBeUndefined();
		expect(lockValue(lock, "providers.openai.org")).toBeUndefined();
		expect(lockValue(lock, "providers.openai.token_hint")).toBeUndefined();
		expect(lockValue(lock, "workspace.root")).toEqual({ value: "/repo", visibility: "host-only" });
	});

	it("matches dotted paths exactly, never by prefix or descendant", () => {
		expect(lockValue(EFFECTIVE_LOCK_FIXTURE, "multi_agent.enabled")?.value).toBe(true);
		expect(lockValue(EFFECTIVE_LOCK_FIXTURE, "multi_agent")).toBeUndefined();
		expect(lockValue(EFFECTIVE_LOCK_FIXTURE, "multi_agent.enabled.value")).toBeUndefined();
		expect(lockValue(EFFECTIVE_LOCK_FIXTURE, "provider_tools")).toBeUndefined();
	});

	it("skips malformed rows without hiding well-formed rows behind them", () => {
		const lock = lockWith([
			{ value_kind: "boolean", value: true, visibility: "model-visible" },
			row("long_running.enabled", "toggle", true),
			row("long_running.enabled", "boolean", true, "public"),
			row("long_running.enabled", "boolean", true),
		]);
		expect(longRunEnabled(lock)).toBe(true);
		expect(longRunEnabled(null)).toBeUndefined();
	});

	it("gates team size on the canonical multi-agent flag and integer bounds", () => {
		const sizePath = "multi_agent.team_config.team.orchestration.scheduler.max_concurrent_agents";
		expect(teamSize(EFFECTIVE_LOCK_FIXTURE)).toBe(2);
		expect(
			teamSize(lockWith([row("multi_agent.enabled", "boolean", false), row(sizePath, "number", 4)])),
		).toBeUndefined();
		expect(teamSize(lockWith([row(sizePath, "number", 4)]))).toBeUndefined();
		expect(
			teamSize(lockWith([row("multi_agent.enabled", "boolean", true), row(sizePath, "number", 2.5)])),
		).toBeUndefined();
		expect(
			teamSize(lockWith([row("multi_agent.enabled", "boolean", true), row(sizePath, "number", -1)])),
		).toBeUndefined();
		// The engine compiler rejects non-positive team limits (server_compiler.py validate_team_limit).
		expect(
			teamSize(lockWith([row("multi_agent.enabled", "boolean", true), row(sizePath, "number", 0)])),
		).toBeUndefined();
		expect(teamSize(lockWith([row("multi_agent.enabled", "boolean", true), row(sizePath, "number", 1)]))).toBe(1);
		expect(
			teamSize(lockWith([row("multi_agent.enabled", "boolean", true), row(sizePath, "string", "2")])),
		).toBeUndefined();
	});

	it("orders posture parts and drops the compact mode", () => {
		expect(posture(EFFECTIVE_LOCK_FIXTURE)).toEqual(["native tools", "responses API", "plan→build"]);
		expect(
			posture(
				lockWith([
					row("provider_tools.use_native", "boolean", false),
					row("provider_tools.api_variant", "string", "chat"),
					row("modes", "array", [{ name: "compact" }, { name: "" }, { kind: "plan" }]),
				]),
			),
		).toEqual(["prompted tools"]);
		expect(posture(null)).toEqual([]);
	});

	it("exposes long-run caps only when enabled and only for enforced, positive leaves", () => {
		const caps = (enabled: boolean, cost: number, tokens: number) =>
			lockWith([
				row("long_running.enabled", "boolean", enabled),
				row("long_running.budgets.total_cost_usd", "number", cost),
				row("long_running.budgets.total_tokens", "number", tokens),
				row("long_running.budgets.wall_clock_s", "number", 3600),
			]);
		expect(longRunBudgets(caps(false, 5, 100))).toBeUndefined();
		expect(longRunBudgets(caps(true, 5, 100))).toEqual({ totalCostUsd: 5, totalTokens: 100 });
		expect(longRunBudgets(caps(true, 0, 0))).toEqual({});
		expect(longRunBudgets(EFFECTIVE_LOCK_FIXTURE)).toBeUndefined();
	});
});
