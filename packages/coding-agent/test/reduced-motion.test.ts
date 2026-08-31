import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { shimmerEnabled } from "@oh-my-pi/pi-coding-agent/modes/theme/shimmer";
import { isReducedMotionEnabled } from "@oh-my-pi/pi-coding-agent/utils/reduced-motion";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("reduced motion setting", () => {
	let state: SettingsTestState | undefined;
	let root: TempDir;

	beforeEach(() => {
		state = beginSettingsTest();
		root = TempDir.createSync("@bb-reduced-motion-");
	});

	afterEach(async () => {
		restoreSettingsTestState(state);
		state = undefined;
		await root.remove();
	});

	it("defaults off before initialization and persists an explicit preference", async () => {
		expect(isReducedMotionEnabled()).toBe(false);
		expect(shimmerEnabled()).toBe(true);
		const agentDir = root.join("agent");
		const projectDir = root.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		const active = await Settings.init({ agentDir, cwd: projectDir });

		active.set("display.reduceMotion", true);
		await active.flush();

		expect(shimmerEnabled()).toBe(false);
		expect(isReducedMotionEnabled()).toBe(true);
		const persisted = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as {
			display?: { reduceMotion?: boolean };
		};
		expect(persisted.display?.reduceMotion).toBe(true);
	});
});
