import { beforeAll, describe, expect, test } from "bun:test";
import type { HarnessSnapshot } from "../../src/breadboard/harness-port";
import { HarnessView } from "../../src/modes/components/agent-hub/harness-view";
import { initTheme } from "../../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});
function viewFor(lock: Readonly<Record<string, unknown>>, overrides: Partial<HarnessSnapshot> = {}): HarnessView {
	const snapshot: HarnessSnapshot = {
		harnessId: "codex.yaml",
		name: "Codex",
		lockHash: null,
		generation: null,
		mode: null,
		lock,
		provenance: {},
		loadedAt: 1,
		...overrides,
	};
	return new HarnessView({
		getSnapshot: () => snapshot,
		requestRender: () => {},
		renderTabs: () => "1 agents  2 activity  3 messages  4 harness",
	});
}

function rendered(view: HarnessView): string {
	return view.render(120, 20).join("\n");
}

describe("HarnessView canonical lock projection", () => {
	test("maps team size, tool posture, long-run state, modes, and exact provenance", () => {
		const view = viewFor(
			{
				multi_agent: { team_config: { team: { orchestration: { scheduler: { max_concurrent_agents: 4 } } } } },
				provider_tools: { api_variant: "responses", use_native: true },
				long_running: { enabled: true },
				modes: [{ name: "plan" }, { name: "build" }],
			},
			{
				provenance: {
					"multi_agent.team_config.team.orchestration.scheduler.max_concurrent_agents": {
						source: "codex.yaml",
						line: 12,
					},
					"provider_tools.api_variant": { source: "codex.yaml", line: 20 },
				},
			},
		);

		expect(rendered(view)).toContain("Name: Codex");
		expect(rendered(view)).toContain("Mode 1: plan");
		expect(rendered(view)).toContain("Mode 2: build");
		view.handleInput("right");
		expect(rendered(view)).toContain("Team size: 4");
		view.handleInput("right");
		view.handleInput("right");
		view.handleInput("right");
		expect(rendered(view)).toContain("API variant: responses");
		expect(rendered(view)).toContain("Native tools: true");
		expect(rendered(view)).toContain("codex.yaml:20");
		view.handleInput("right");
		expect(rendered(view)).toContain("Enabled: true");
	});

	test("redacts marked values and omits unavailable fields", () => {
		const view = viewFor({
			provider_tools: { use_native: false },
			effective_values: [
				{ path: "provider_tools.api_variant", value: "secret-api", visibility: "redacted" },
			],
		});
		const overview = rendered(view);
		expect(overview).not.toContain("unknown");
		expect(overview).not.toContain("—");
		view.handleInput("right");
		view.handleInput("right");
		view.handleInput("right");
		view.handleInput("right");
		const compute = rendered(view);
		expect(compute).toContain("API variant: <redacted>");
		expect(compute).not.toContain("secret-api");
		expect(compute).toContain("Native tools: false");
		view.handleInput("right");
		expect(rendered(view)).not.toContain("Enabled:");
	});
});
