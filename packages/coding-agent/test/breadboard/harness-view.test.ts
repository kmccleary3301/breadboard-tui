import { beforeAll, describe, expect, test } from "bun:test";
import type { HarnessSnapshot } from "../../src/breadboard/harness-port";
import {
	HarnessView,
	projectHarnessEffectiveRows,
	projectHarnessEffectiveRowsByPanel,
	type HarnessPanel,
} from "../../src/modes/components/agent-hub/harness-view";
import { initTheme } from "@oh-my-pi/pi-tui/theme/theme";

const lockFixture = JSON.parse(
	await Bun.file(new URL("./fixtures/codex_e4.lock.json", import.meta.url)).text(),
) as Readonly<Record<string, unknown>>;

beforeAll(async () => {
	await initTheme(false);
});

function viewFor(
	lock: Readonly<Record<string, unknown>>,
	overrides: Partial<HarnessSnapshot> = {},
	initialPanel: HarnessPanel = "overview",
): HarnessView {
	const snapshot: HarnessSnapshot = {
		harnessId: "codex_e4.yaml",
		name: "Codex E4",
		lockHash: "sha256:codex-e4",
		generation: "generation-4",
		mode: "plan",
		lock,
		provenance: {},
		loadedAt: 1,
		...overrides,
	};
	return new HarnessView({
		getSnapshot: () => snapshot,
		requestRender: () => {},
		renderTabs: () => "1 agents  2 activity  3 messages  4 harness",
		initialPanel,
	});
}

function rendered(view: HarnessView, height = 50): string {
	return Bun.stripANSI(view.render(120, height).join("\n"));
}

function nextPanel(view: HarnessView, count: number): void {
	for (let index = 0; index < count; index++) view.handleInput("\x1b[C");
}

describe("HarnessView canonical lock projection", () => {
	test("projects every visible fixture leaf into exactly one canonical panel", () => {
		const effectiveValues = (lockFixture.effective_values as readonly unknown[]).filter(
			value =>
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value) &&
				(value as { visibility?: unknown }).visibility !== "redacted" &&
				(value as { value_kind?: unknown }).value_kind !== "secret-ref",
		);
		const expectedPaths = effectiveValues.map(value => (value as { path: string }).path);
		const panels = projectHarnessEffectiveRowsByPanel(lockFixture);
		const projected = projectHarnessEffectiveRows(lockFixture);
		expect(projected).toHaveLength(expectedPaths.length);
		expect(projected.map(field => field.path).sort()).toEqual(expectedPaths.sort());
		expect(new Set(projected.map(field => field.path)).size).toBe(expectedPaths.length);

		const prefixes = [
			"completion",
			"concurrency",
			"features",
			"long_running",
			"loop",
			"modes",
			"multi_agent",
			"prompts",
			"provider_tools",
			"providers",
			"schema_version",
			"tools",
			"version",
			"workspace",
		];
		for (const prefix of prefixes) {
			const owners = Object.entries(panels).filter(([, fields]) =>
				fields.some(field => field.path === prefix || field.path.startsWith(`${prefix}.`)),
			);
			expect(owners).toHaveLength(1);
		}
	});

	test("renders real effective lock leaves across the harness panels", () => {
		const view = viewFor(lockFixture);

		expect(rendered(view)).toContain("Mode 1: plan");
		expect(rendered(view)).toContain("Mode 2: build");

		nextPanel(view, 1);
		expect(rendered(view)).toContain("Team size: 2");
		expect(rendered(view)).toContain("multi_agent.team_config.team.agents.main.role: main");
		expect(rendered(view)).toContain("multi_agent.team_config.team.coordination.mission_owner_role: supervisor");
		view.handleInput("\x1b[D");
		expect(rendered(view)).toContain("Mode 1: plan");
		nextPanel(view, 1);
		nextPanel(view, 1);
		expect(rendered(view)).toContain("tools.aliases.bash: run_shell");
		expect(rendered(view)).toContain("tools.registry.include:");
		expect(rendered(view)).toContain("provider_tools.use_native: true");

		nextPanel(view, 1);
		expect(rendered(view)).toContain("prompts.packs.base.system:");
		expect(rendered(view)).toContain("prompts.tool_prompt_mode: none");

		nextPanel(view, 1);
		expect(rendered(view)).toContain("completion.primary: hybrid");
		expect(rendered(view)).toContain("Default model: openai/gpt-5.1-codex-mini");
		expect(rendered(view)).toContain("providers.models:");
		expect(rendered(view)).toContain("Modes:");

		nextPanel(view, 1);
		expect(rendered(view)).toContain("long_running.enabled: false");
		expect(rendered(view)).toContain("long_running.budgets.total_tokens: 0");

		nextPanel(view, 1);
		expect(rendered(view)).toContain("workspace.sandbox.driver: process");
		expect(rendered(view)).toContain("No permissions.* or guardrails.* rows in the effective lock.");
	});
	test("opens directly on static panels and explains empty projections", () => {
		const emptyLock = { effective_values: [] };
		const cases = [
			["team", 2, "No multi_agent.* rows in the effective lock."],
			["prompts", 4, "No prompts.* rows in the effective lock."],
			["evidence", 8, "No lock or generation metadata is available."],
		] as const;

		for (const [panel, panelNumber, emptyMessage] of cases) {
			const view = viewFor(emptyLock, panel === "evidence" ? { lockHash: null, generation: null } : {}, panel);
			const output = rendered(view);
			expect(output).toContain(`Harness panel ${panelNumber}/8: ${panel}`);
			expect(output).toContain(emptyMessage);
		}
	});

	test("never renders redacted or secret-reference rows in any panel", () => {
		const lock = {
			...lockFixture,
			effective_values: [
				...((lockFixture.effective_values as readonly unknown[]) ?? []),
				{
					path: "tools.redacted_secret",
					value: "must-not-render",
					value_kind: "string",
					visibility: "redacted",
				},
				{
					path: "prompts.secret_ref",
					value: "secret://must-not-render",
					value_kind: "secret-ref",
					visibility: "model-visible",
				},
			],
		};
		const view = viewFor(lock);

		for (let index = 0; index < 8; index++) {
			expect(rendered(view)).not.toContain("must-not-render");
			view.handleInput("\x1b[C");
		}
	});
});
