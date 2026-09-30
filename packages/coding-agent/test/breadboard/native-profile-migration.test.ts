import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgComposerShape,
	cfgDisplayShowTokenUsage,
	cfgStatusLinePreset,
	cfgSymbolPreset,
	cfgThemeDark,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import {
	migrateNativeProfile,
	registerNativeProfileMigration,
} from "@oh-my-pi/pi-coding-agent/breadboard/native-profile-migration";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("native profile migration", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-native-profile-migration-test-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	const getConfigPath = () => path.join(agentDir, "config.yml");
	const writeSettings = async (settings: Record<string, unknown>) => {
		await Bun.write(getConfigPath(), YAML.stringify(settings, null, 2));
	};
	const readSettings = async (): Promise<Record<string, unknown>> => {
		const file = Bun.file(getConfigPath());
		if (!(await file.exists())) return {};
		const parsed = YAML.parse(await file.text());
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	};

	afterEach(async () => {
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await Bun.sleep(0);
		await tempDir?.remove();
	});

	it("migrates an R39 bridge profile to native without changing shared preferences", async () => {
		await writeSettings({
			symbolPreset: "nerd",
			composer: { shape: "rule" },
			theme: { dark: "titanium", light: "light" },
			statusLine: { preset: "bb-balanced" },
			breadboard: {
				engineMode: "local-owned",
				harness: {
					default: ".breadboard/bb-omp/r39/bb-omp.harness.yaml",
					paletteHeader: false,
					unsupportedCommands: "hide",
				},
				engineArtifact: { kind: "runtime-bundle", runtimeBundle: { path: "/old/r39.bundle" } },
			},
		});
		const previousProduct = process.env.BREADBOARD_PRODUCT;
		const previousReceipt = process.env.BREADBOARD_NATIVE_PROFILE_MIGRATION_RECEIPT;
		const migrationReceipt = path.join(agentDir, ".bb-native-profile-migration.receipt.v1.json");
		process.env.BREADBOARD_PRODUCT = "1";
		const unregisterMigration = registerNativeProfileMigration();
		process.env.BREADBOARD_NATIVE_PROFILE_MIGRATION_RECEIPT = migrationReceipt;
		try {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(await Bun.file(migrationReceipt).exists()).toBe(true);
			expect(cfgSymbolPreset.get(settings)).toBe("nerd");
			expect(cfgComposerShape.get(settings)).toBe("rule");
			expect(cfgThemeDark.get(settings)).toBe("titanium");
			expect(cfgStatusLinePreset.get(settings)).toBe("bb-balanced");

			cfgDisplayShowTokenUsage.set(settings, true);
			await settings.flush();
			const migrated = await readSettings();
			expect(migrated.breadboard).toEqual({
				harness: {
					default: "daily_driver",
					paletteHeader: false,
					unsupportedCommands: "hide",
				},
			});
			const firstBytes = await Bun.file(getConfigPath()).text();
			await settings.reloadFromDisk();
			expect(await Bun.file(getConfigPath()).text()).toBe(firstBytes);
		} finally {
			if (previousProduct === undefined) delete process.env.BREADBOARD_PRODUCT;
			else process.env.BREADBOARD_PRODUCT = previousProduct;
			unregisterMigration();
			if (previousReceipt === undefined) delete process.env.BREADBOARD_NATIVE_PROFILE_MIGRATION_RECEIPT;
			else process.env.BREADBOARD_NATIVE_PROFILE_MIGRATION_RECEIPT = previousReceipt;
		}
	});

	it("writes a receipt when an already migrated profile is requested again", async () => {
		await writeSettings({ breadboard: { harness: { default: "daily_driver" } } });
		const previousProduct = process.env.BREADBOARD_PRODUCT;
		const previousReceipt = process.env.BREADBOARD_NATIVE_PROFILE_MIGRATION_RECEIPT;
		const migrationReceipt = path.join(agentDir, ".bb-native-profile-migration.receipt.v1.json");
		process.env.BREADBOARD_PRODUCT = "1";
		const unregisterMigration = registerNativeProfileMigration();
		process.env.BREADBOARD_NATIVE_PROFILE_MIGRATION_RECEIPT = migrationReceipt;
		try {
			await Settings.init({ cwd: projectDir, agentDir });
			expect(await Bun.file(migrationReceipt).exists()).toBe(true);
		} finally {
			if (previousProduct === undefined) delete process.env.BREADBOARD_PRODUCT;
			else process.env.BREADBOARD_PRODUCT = previousProduct;
			unregisterMigration();
			if (previousReceipt === undefined) delete process.env.BREADBOARD_NATIVE_PROFILE_MIGRATION_RECEIPT;
			else process.env.BREADBOARD_NATIVE_PROFILE_MIGRATION_RECEIPT = previousReceipt;
		}
	});

	it("keeps a bridge selection from a config overlay above the seeded profile migration", async () => {
		await writeSettings({
			breadboard: {
				engineMode: "local-owned",
				harness: { default: ".breadboard/bb-omp/r39/bb-omp.harness.yaml" },
				engineArtifact: { kind: "runtime-bundle", runtimeBundle: { path: "/old/r39.bundle" } },
			},
		});
		const overlayPath = tempDir.join("overlay.yml");
		await Bun.write(
			overlayPath,
			YAML.stringify({
				breadboard: {
					engineMode: "local-owned",
					harness: { default: ".breadboard/bb-omp/r39/overlay.yaml" },
				},
			}),
		);
		const previousProduct = process.env.BREADBOARD_PRODUCT;
		process.env.BREADBOARD_PRODUCT = "1";
		const unregisterMigration = registerNativeProfileMigration();
		try {
			const settings = await Settings.init({ cwd: projectDir, agentDir, configFiles: [overlayPath] });
			expect(settings.getRaw("breadboard")).toMatchObject({
				engineMode: "local-owned",
				harness: { default: ".breadboard/bb-omp/r39/overlay.yaml" },
			});
			expect((await readSettings()).breadboard).toEqual({ harness: { default: "daily_driver" } });
		} finally {
			if (previousProduct === undefined) delete process.env.BREADBOARD_PRODUCT;
			else process.env.BREADBOARD_PRODUCT = previousProduct;
			unregisterMigration();
		}
	});
	it("recognizes already migrated profiles through the BreadBoard migration module", () => {
		const previousProduct = process.env.BREADBOARD_PRODUCT;
		process.env.BREADBOARD_PRODUCT = "1";
		try {
			expect(migrateNativeProfile({ breadboard: { harness: { default: "daily_driver" } } })).toBe(true);
		} finally {
			if (previousProduct === undefined) delete process.env.BREADBOARD_PRODUCT;
			else process.env.BREADBOARD_PRODUCT = previousProduct;
		}
	});
	it("keeps product startup identity independent of shared pi-utils initialization", () => {
		const codingAgentRoot = path.resolve(import.meta.dir, "../..");
		const result = Bun.spawnSync([process.execPath, path.join(codingAgentRoot, "src/bb.ts"), "--version"], {
			cwd: codingAgentRoot,
			env: { ...process.env, BREADBOARD_PRODUCT: undefined },
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toMatch(/^bb\/0\.1\.0-rc\.7 omp\/18\.3\.0(?:\s|$)/);
	});
});
