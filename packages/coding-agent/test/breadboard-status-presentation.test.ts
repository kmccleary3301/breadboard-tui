import { afterEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { HarnessSnapshot } from "../src/breadboard/harness-port";
import {
	renderBreadboardActivity,
	renderBreadboardPolicy,
	renderBreadboardStatusLine,
	renderBreadboardStatusRows,
} from "@oh-my-pi/pi-tui/status-line/breadboard-presentation";
import { initTheme, setSymbolPreset } from "@oh-my-pi/pi-tui/theme";
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

	it("shows low context by default and respects field-specific overrides", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const snapshot = { modelName: "Luna", workspace: "repo", context: { tokens: 2_000, capacity: 100_000 } };
		const balanced = stripVTControlCharacters(renderBreadboardStatusLine(snapshot, "bb-balanced", 100, "box"));
		const hidden = stripVTControlCharacters(
			renderBreadboardStatusLine(snapshot, "bb-balanced", 100, "box", { context: "hidden" }),
		);
		expect(balanced).toContain("~2%");
		expect(hidden).not.toContain("~2%");
		expect(hidden).toContain(snapshot.workspace);
		expect(renderBreadboardActivity(null, null, 40)).toBe("");
	});

	it("keeps model identity in place as turn activity changes", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const snapshot = { modelName: "Luna", workspace: "repo" };
		const idle = stripVTControlCharacters(renderBreadboardStatusLine(snapshot, "bb-balanced", 80, "box"));
		const active = stripVTControlCharacters(
			renderBreadboardStatusLine(
				{ ...snapshot, activity: { kind: "tool", label: "Running run_shell" }, elapsedMs: 65_000 },
				"bb-balanced",
				80,
				"box",
			),
		);
		expect(active.indexOf(snapshot.modelName)).toBe(idle.indexOf(snapshot.modelName));
		expect(active.indexOf("Running run_shell")).toBeGreaterThan(active.indexOf(snapshot.workspace));
		expect(visibleWidth(active)).toBe(80);
	});

	it("reveals the complete selected folder path when the edge has room", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const snapshot = {
			modelName: "Luna",
			workspace: "breadboard",
			workspacePath: "/Users/developer/projects/experiments/terminal/breadboard",
		};
		const full = renderBreadboardStatusRows(snapshot, "bb-balanced", 120, "box", { folder: "full" });
		const name = renderBreadboardStatusRows(snapshot, "bb-balanced", 120, "box", { folder: "name" });
		expect(stripVTControlCharacters(full.top)).toContain(snapshot.workspacePath);
		expect(full.bottom).toBe("");
		expect(stripVTControlCharacters(name.top)).toContain(snapshot.workspace);
		expect(name.top).not.toContain("/Users/");
	});

	it("moves fields below the input before dropping them and promotes them on expansion", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const snapshot = {
			modelName: "Luna",
			workspace: "breadboard",
			sessionName: "Fix login flow",
			branch: "feature/login",
			harness,
			context: { tokens: 40_000, capacity: 100_000 },
			spend: { sessionUsd: 1.25, turnUsd: 0.05, estimated: true },
		};
		const narrow = renderBreadboardStatusRows(snapshot, "bb-balanced", 50, "box");
		const wide = renderBreadboardStatusRows(snapshot, "bb-balanced", 160, "box");
		expect(narrow.bottom).not.toBe("");
		const combined = stripVTControlCharacters(`${narrow.top}\n${narrow.bottom}`);
		expect(combined).toContain(snapshot.modelName);
		expect(combined).toContain(snapshot.workspace);
		expect(combined).toContain("~40%");
		expect(combined).toContain("~1.25");
		expect(visibleWidth(narrow.top)).toBeLessThanOrEqual(50);
		expect(visibleWidth(narrow.bottom)).toBeLessThanOrEqual(50);
		expect(wide.bottom).toBe("");
		expect(stripVTControlCharacters(wide.top)).toContain(snapshot.sessionName);
	});

	it("keeps critical state and context ahead of routine metadata across both edges", async () => {
		await initTheme(false, "emoji", false, "titanium", "light");
		const rows = renderBreadboardStatusRows(
			{
				modelName: "Luna",
				workspace: "breadboard",
				sessionName: "A long session title",
				harness: { ...harness, name: "Rules" },
				context: { tokens: 95_000, capacity: 100_000 },
				activity: { kind: "approval", label: "Approval required" },
			},
			"bb-detailed",
			24,
			"box",
			{ context: "percent", activity: "hidden" },
		);
		const combined = stripVTControlCharacters(`${rows.top}\n${rows.bottom}`);
		expect(combined).toContain("Approval required");
		expect(combined).toContain("~95%");
		expect(combined).not.toContain("Rules");
		expect(visibleWidth(rows.top)).toBeLessThanOrEqual(24);
		expect(visibleWidth(rows.bottom)).toBeLessThanOrEqual(24);
	});

	it("shows the chosen spend scope without treating unavailable accounting as zero", async () => {
		await initTheme(false, "nerd", false, "titanium", "light");
		const snapshot = {
			modelName: "Luna",
			workspace: "repo",
			spend: { sessionUsd: 1.25, turnUsd: 0.05, estimated: true },
		};
		const turn = stripVTControlCharacters(
			renderBreadboardStatusLine(snapshot, "bb-balanced", 100, "box", { spend: "turn" }),
		);
		expect(turn).toContain("~0.05");
		expect(turn).not.toContain("1.25");
		const absent = stripVTControlCharacters(
			renderBreadboardStatusLine({ ...snapshot, spend: null }, "bb-balanced", 100, "box"),
		);
		expect(absent).not.toContain("0.00");
	});

	it("reports background wait with running-job count instead of Working during a pending async wake", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const snapshotSingle = {
			modelName: "Luna",
			workspace: "repo",
			activity: { kind: "tool" as const, label: "Waiting on 1 background job" },
			elapsedMs: 4_000,
		};
		const renderedSingle = stripVTControlCharacters(renderBreadboardStatusLine(snapshotSingle, "bb-balanced", 80, "box"));
		expect(renderedSingle).toContain("Waiting on 1 background job");
		expect(renderedSingle).not.toContain("Working");

		const snapshotMultiple = {
			modelName: "Luna",
			workspace: "repo",
			activity: { kind: "tool" as const, label: "Waiting on 3 background jobs" },
			elapsedMs: 12_000,
		};
		const renderedMultiple = stripVTControlCharacters(renderBreadboardStatusLine(snapshotMultiple, "bb-balanced", 80, "box"));
		expect(renderedMultiple).toContain("Waiting on 3 background jobs");
		expect(renderedMultiple).not.toContain("Working");
	});

	it("does not fall back to Working when activity is null during a pending async wake with open elapsed time", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		expect(renderBreadboardActivity(null, 4_000, 40)).toBe("");
		const snapshot = {
			modelName: "Luna",
			workspace: "repo",
			activity: null,
			elapsedMs: 4_000,
		};
		const rendered = stripVTControlCharacters(renderBreadboardStatusLine(snapshot, "bb-balanced", 80, "box"));
		expect(rendered).not.toContain("Working");
	});
});
