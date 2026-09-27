/**
 * Native mode runs OMP's own loop on a harness: the harness comes from `--harness`, then the
 * selected `sessionConfigPath`, then `breadboard.harness.default`, whose default names the built-in
 * `bb-omp.native`. Every request for the removed Python bridge refuses startup.
 */
import { describe, expect, it } from "bun:test";
import { BreadboardBridgeRefusalError } from "@oh-my-pi/pi-coding-agent/breadboard/bridge-refusal";
import {
	BreadboardSettingsError,
	resolveBreadboardEngineMode,
	resolveNativeHarnessSpec,
} from "@oh-my-pi/pi-coding-agent/breadboard/runtime";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

function settingsWith(breadboard?: Record<string, unknown>): Settings {
	const settings = Settings.isolated();
	if (breadboard !== undefined) settings.getRaw = (key: string) => (key === "breadboard" ? breadboard : undefined);
	return settings;
}

function refusal(run: () => unknown): { source: string; value: string; exitCode: number } {
	try {
		run();
	} catch (error) {
		if (error instanceof BreadboardBridgeRefusalError) {
			return { source: error.source, value: error.value, exitCode: error.exitCode };
		}
		throw error;
	}
	throw new Error("expected a bridge refusal");
}

describe("native startup selection", () => {
	it("defaults the product to native and stock OMP to off", () => {
		expect(resolveBreadboardEngineMode({}, settingsWith(), true, {})).toBe("native");
		expect(resolveBreadboardEngineMode({}, settingsWith(), false, {})).toBe("off");
	});

	it("takes the flag over the environment over settings", () => {
		const settings = settingsWith({ engineMode: "native" });
		expect(resolveBreadboardEngineMode({}, settings, false, {})).toBe("native");
		expect(resolveBreadboardEngineMode({}, settings, true, { BREADBOARD_ENGINE_MODE: "off" })).toBe("off");
		expect(
			resolveBreadboardEngineMode({ engineMode: "native" }, settings, true, { BREADBOARD_ENGINE_MODE: "off" }),
		).toBe("native");
	});

	it("never refuses in stock OMP, which runs native only on an explicit native request", () => {
		for (const mode of ["local-owned", "local-external", "remote"]) {
			expect(resolveBreadboardEngineMode({ engineMode: mode }, settingsWith(), false, {})).toBe("off");
			expect(resolveBreadboardEngineMode({}, settingsWith(), false, { BREADBOARD_ENGINE_MODE: mode })).toBe("off");
			expect(resolveBreadboardEngineMode({}, settingsWith({ engineMode: mode }), false, {})).toBe("off");
		}
		expect(resolveBreadboardEngineMode({ engineUrl: "http://127.0.0.1:1" }, settingsWith(), false, {})).toBe("off");
		expect(
			resolveBreadboardEngineMode({}, settingsWith({ engineArtifact: { path: "/bundle" } }), false, {
				BREADBOARD_API_URL: "http://127.0.0.1:1",
			}),
		).toBe("off");
		expect(resolveBreadboardEngineMode({}, settingsWith(), false, { BREADBOARD_ENGINE_MODE: "native" })).toBe(
			"native",
		);
	});

	it("refuses every bridge source with exit code 2, naming the source", () => {
		const none = settingsWith();
		for (const mode of ["local-owned", "local-external", "remote"]) {
			expect(refusal(() => resolveBreadboardEngineMode({ engineMode: mode }, none, true, {}))).toEqual({
				source: "--engine-mode",
				value: mode,
				exitCode: 2,
			});
			expect(
				refusal(() => resolveBreadboardEngineMode({}, none, true, { BREADBOARD_ENGINE_MODE: mode })).source,
			).toBe("BREADBOARD_ENGINE_MODE");
			expect(refusal(() => resolveBreadboardEngineMode({}, settingsWith({ engineMode: mode }), true, {}))).toEqual({
				source: "breadboard.engineMode",
				value: mode,
				exitCode: 2,
			});
		}
		expect(
			refusal(() => resolveBreadboardEngineMode({ engineUrl: "http://127.0.0.1:1" }, none, true, {})).source,
		).toBe("--engine-url");
		for (const name of ["BREADBOARD_API_URL", "BREADBOARD_ENGINE_ARTIFACT"]) {
			expect(refusal(() => resolveBreadboardEngineMode({}, none, true, { [name]: "/x" })).source).toBe(name);
		}
		// Blank bridge variables are treated as unset.
		expect(resolveBreadboardEngineMode({}, none, true, { BREADBOARD_API_URL: " " })).toBe("native");
	});

	it("refuses every legacy bridge setting, whatever its value", () => {
		for (const field of [
			"baseUrl",
			"auth",
			"tls",
			"engineArtifact",
			"workspaceId",
			"startupTimeoutMs",
			"requestTimeoutMs",
			"ownerExitPolicy",
		]) {
			expect(refusal(() => resolveBreadboardEngineMode({}, settingsWith({ [field]: false }), true, {}))).toEqual({
				source: `breadboard.${field}`,
				value: "false",
				exitCode: 2,
			});
		}
		expect(
			refusal(() => resolveBreadboardEngineMode({}, settingsWith({ engineArtifact: { path: "/bundle" } }), true, {}))
				.value,
		).toBe("/bundle");
	});

	it("rejects unknown and malformed breadboard settings with exit code 2", () => {
		for (const [raw, message] of [
			[{ unexpectedField: true }, "bb: breadboard.unexpectedField is not a BreadBoard setting; remove it."],
			[{ sessionConfigPath: " " }, "bb: breadboard.sessionConfigPath must be a non-empty harness spec path."],
		] as const) {
			let caught: unknown;
			try {
				resolveNativeHarnessSpec({}, settingsWith(raw), true);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(BreadboardSettingsError);
			expect((caught as BreadboardSettingsError).message).toBe(message);
			expect((caught as BreadboardSettingsError).exitCode).toBe(2);
		}
	});

	it("resolves the spec from --harness, then sessionConfigPath, then the configured default", () => {
		const configured = settingsWith({
			engineMode: "native",
			sessionConfigPath: "selected/harness.yaml",
			harness: { default: "default/harness.yaml" },
		});
		expect(resolveNativeHarnessSpec({ harness: "cli/harness.yaml" }, configured, true)).toBe("cli/harness.yaml");
		expect(resolveNativeHarnessSpec({}, configured, true)).toBe("selected/harness.yaml");
		const defaultOnly = settingsWith({ harness: { default: "default/harness.yaml" } });
		expect(resolveNativeHarnessSpec({}, defaultOnly, true)).toBe("default/harness.yaml");
	});

	it("returns no spec outside native mode and defaults native mode to bb-omp.native", () => {
		expect(resolveNativeHarnessSpec({ engineMode: "off" }, settingsWith(), true)).toBeUndefined();
		expect(resolveNativeHarnessSpec({}, settingsWith(), false)).toBeUndefined();
		expect(resolveNativeHarnessSpec({}, settingsWith({ harness: { default: "daily_driver" } }), true)).toBe(
			"bb-omp.native",
		);
		expect(resolveNativeHarnessSpec({ harness: "bb-omp.native" }, settingsWith(), true)).toBe("bb-omp.native");
		// Engine catalog ids named Python harnesses; native mode runs only built-ins and specs.
		expect(() => resolveNativeHarnessSpec({ harness: "research_agent" }, settingsWith(), true)).toThrow(
			/native mode runs a built-in harness \(bb-omp\.native\) or a harness spec/,
		);
	});
});
