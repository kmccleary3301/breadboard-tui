import { afterEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { HarnessSnapshot } from "../src/breadboard/harness-port";
import {
	renderBreadboardActivity,
	renderBreadboardPolicy,
	renderBreadboardStatusLine,
} from "../src/modes/components/status-line/breadboard-presentation";
import { initTheme, setSymbolPreset } from "../src/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const harness: HarnessSnapshot = {
	harnessId: "daily",
	name: "Daily driver",
	lockHash: "sha256:verified",
	verifiedIdentity: { harnessId: "daily", lockHash: "sha256:verified" },
	generation: "sha256:12345678abcdef",
	mode: "coding",
	provenance: {},
	loadedAt: 0,
	lock: {
		effective_values: [
			{ path: "permissions.options.default_response", value_kind: "string", value: "ask", visibility: "host-only" },
		],
	},
};

afterEach(async () => {
	await setSymbolPreset("unicode");
});

describe("BreadBoard composer presentation", () => {
	it("preserves approval over optional information in a narrow emoji composer", async () => {
		await initTheme(false, "emoji", false, "titanium", "light");
		const rendered = renderBreadboardStatusLine(
			{
				modelName: "GPT-5.6 Luna",
				workspace: "long-workspace-name",
				branch: "feature/long-branch",
				harness,
				activity: { kind: "approval", label: "Approval required" },
				elapsedMs: 9_000,
				context: { tokens: 95_000, capacity: 100_000 },
				inputTokens: 500,
				outputTokens: 100,
			},
			"bb-detailed",
			32,
			"box",
		);
		expect(visibleWidth(rendered)).toBeLessThanOrEqual(32);
		expect(stripVTControlCharacters(rendered)).toContain("Approval required");
		expect(stripVTControlCharacters(rendered)).not.toContain("9s");
	});

	it("keeps ASCII presentation ASCII even with narrow layout and warning state", async () => {
		await initTheme(false, "ascii", false, "titanium", "light");
		const rendered = renderBreadboardStatusLine(
			{ modelName: "Luna", workspace: "repo", activity: { kind: "error", label: "Engine disconnected" } },
			"bb-balanced",
			48,
			"box",
		);
		expect(visibleWidth(rendered)).toBeLessThanOrEqual(48);
		expect(stripVTControlCharacters(rendered)).toMatch(/^[\x20-\x7e]*$/u);
		expect(stripVTControlCharacters(rendered)).toContain("Engine disconnected");
	});

	it("requires matching verified identity before displaying an effective policy", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		expect(renderBreadboardPolicy({ ...harness, verifiedIdentity: null })).toBe("");
		expect(renderBreadboardPolicy({ ...harness, lockHash: "sha256:different" })).toBe("");
		expect(stripVTControlCharacters(renderBreadboardPolicy(harness))).toBe("Default: ask");
	});

	it("keeps generation and low context estimates in Detailed, not Balanced", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const snapshot = { modelName: "Luna", workspace: "repo", harness, context: { tokens: 2_000, capacity: 100_000 } };
		const balanced = stripVTControlCharacters(renderBreadboardStatusLine(snapshot, "bb-balanced", 160, "box"));
		const detailed = stripVTControlCharacters(renderBreadboardStatusLine(snapshot, "bb-detailed", 160, "box"));
		expect(balanced).toContain("Daily driver / coding");
		expect(balanced).not.toContain("g12345678");
		expect(balanced).not.toContain("ctx");
		expect(detailed).toContain("g12345678");
		expect(detailed).toContain("ctx ~2% / 100K");
		expect(renderBreadboardActivity(null, null, 40)).toBe("");
	});
});
