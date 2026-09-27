import { describe, expect, test } from "bun:test";
import { BreadboardBridgeRefusalError } from "../bridge-refusal";
import {
	BREADBOARD_ENGINE_MODES,
	BreadboardRunConfigError,
	parseSelectedBreadboardConfig,
	resolveBreadboardRunConfig,
} from "./run-config";

const baseInput = {
	workspacePath: "/workspace",
	canonicalizeWorkspace: () => "/canonical/workspace",
	environment: {} as Record<string, string | undefined>,
};

describe("BREADBOARD_ENGINE_MODES", () => {
	test("contains only native and off", () => {
		expect(BREADBOARD_ENGINE_MODES).toEqual(["native", "off"]);
	});
});

describe("resolveBreadboardRunConfig", () => {
	test("defaults to native mode in product environment", () => {
		const config = resolveBreadboardRunConfig({
			...baseInput,
			environment: { BREADBOARD_PRODUCT: "1" },
		});
		expect(config.mode).toBe("native");
		expect(config.sources.mode).toBe("derived-default");
		expect(config.workspaceId).toStartWith("workspace:v1:sha256:");
	});

	test("defaults to native mode without product env", () => {
		const config = resolveBreadboardRunConfig(baseInput);
		expect(config.mode).toBe("native");
	});

	test("resolves explicit off mode", () => {
		const cli = resolveBreadboardRunConfig({ ...baseInput, cli: { engineMode: "off" } });
		expect(cli.mode).toBe("off");
		expect(cli.sources.mode).toBe("cli");

		const env = resolveBreadboardRunConfig({
			...baseInput,
			environment: { BREADBOARD_ENGINE_MODE: "off" },
		});
		expect(env.mode).toBe("off");
		expect(env.sources.mode).toBe("environment");

		const setting = resolveBreadboardRunConfig({
			...baseInput,
			selectedConfig: { engineMode: "off" },
		});
		expect(setting.mode).toBe("off");
		expect(setting.sources.mode).toBe("selected-config");
	});

	test("resolves explicit native mode", () => {
		const cli = resolveBreadboardRunConfig({ ...baseInput, cli: { engineMode: "native" } });
		expect(cli.mode).toBe("native");
		expect(cli.sources.mode).toBe("cli");

		const env = resolveBreadboardRunConfig({
			...baseInput,
			environment: { BREADBOARD_ENGINE_MODE: "native" },
		});
		expect(env.mode).toBe("native");
		expect(env.sources.mode).toBe("environment");

		const setting = resolveBreadboardRunConfig({
			...baseInput,
			selectedConfig: { engineMode: "native" },
		});
		expect(setting.mode).toBe("native");
		expect(setting.sources.mode).toBe("selected-config");
	});

	test("refuses bridge modes requested via CLI", () => {
		for (const mode of ["local-owned", "local-external", "remote"]) {
			expect(() => resolveBreadboardRunConfig({ ...baseInput, cli: { engineMode: mode } })).toThrow(
				BreadboardBridgeRefusalError,
			);
		}
	});

	test("refuses bridge modes requested via environment", () => {
		for (const mode of ["local-owned", "local-external", "remote"]) {
			expect(() =>
				resolveBreadboardRunConfig({ ...baseInput, environment: { BREADBOARD_ENGINE_MODE: mode } }),
			).toThrow(BreadboardBridgeRefusalError);
		}
	});

	test("refuses bridge modes requested via settings", () => {
		for (const mode of ["local-owned", "local-external", "remote"]) {
			expect(() => resolveBreadboardRunConfig({ ...baseInput, selectedConfig: { engineMode: mode } })).toThrow(
				BreadboardBridgeRefusalError,
			);
		}
	});

	test("refuses implied bridge modes via URL flag, URL env, or baseUrl setting", () => {
		expect(() => resolveBreadboardRunConfig({ ...baseInput, cli: { engineUrl: "http://127.0.0.1:9099" } })).toThrow(
			BreadboardBridgeRefusalError,
		);

		expect(() =>
			resolveBreadboardRunConfig({ ...baseInput, environment: { BREADBOARD_API_URL: "http://127.0.0.1:8080" } }),
		).toThrow(BreadboardBridgeRefusalError);

		expect(() =>
			resolveBreadboardRunConfig({ ...baseInput, selectedConfig: { baseUrl: "http://127.0.0.1:8080" } }),
		).toThrow(BreadboardBridgeRefusalError);
	});

	test("refuses implied bridge modes via engine artifact env or setting", () => {
		expect(() =>
			resolveBreadboardRunConfig({
				...baseInput,
				environment: { BREADBOARD_ENGINE_ARTIFACT: "/path/to/bundle" },
			}),
		).toThrow(BreadboardBridgeRefusalError);

		expect(() =>
			resolveBreadboardRunConfig({
				...baseInput,
				selectedConfig: { engineArtifact: "/path/to/bundle" },
			}),
		).toThrow(BreadboardBridgeRefusalError);
	});
});

describe("parseSelectedBreadboardConfig", () => {
	test("preserves supported own enumerable settings", () => {
		const parsed = parseSelectedBreadboardConfig({
			sessionConfigPath: "/tmp/spec.yaml",
			harness: { default: "daily_driver" },
		});
		expect(parsed.sessionConfigPath).toBe("/tmp/spec.yaml");
		expect(parsed.harness).toEqual({ default: "daily_driver" });
	});

	test("rejects an unsupported own enumerable field", () => {
		expect(() => parseSelectedBreadboardConfig({ unexpectedField: true })).toThrow(BreadboardRunConfigError);
	});
});
