/**
 * Native mode runs OMP's own loop on a harness spec: no engine owns turns, and the spec comes from
 * `--harness`, then the selected `sessionConfigPath`, then `breadboard.harness.default`.
 */
import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { resolveNativeHarnessSpec, startupBreadboardEngineOwnsTurns } from "@oh-my-pi/pi-coding-agent/breadboard/runtime";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const WORKSPACE = os.tmpdir();

function settingsWith(values: {
	engineMode?: string;
	sessionConfigPath?: string;
	harnessDefault?: string;
}): Settings {
	return Settings.isolated({
		...(values.engineMode === undefined ? {} : { "breadboard.engineMode": values.engineMode }),
		...(values.sessionConfigPath === undefined ? {} : { "breadboard.sessionConfigPath": values.sessionConfigPath }),
		...(values.harnessDefault === undefined ? {} : { "breadboard.harness.default": values.harnessDefault }),
	});
}

describe("native startup selection", () => {
	it("keeps turns on OMP's loop in native and off modes only", () => {
		const native = settingsWith({ engineMode: "native" });
		expect(startupBreadboardEngineOwnsTurns({}, native, WORKSPACE, true)).toBe(false);
		expect(startupBreadboardEngineOwnsTurns({ engineMode: "off" }, native, WORKSPACE, true)).toBe(false);
		expect(startupBreadboardEngineOwnsTurns({ engineMode: "local-owned" }, native, WORKSPACE, true)).toBe(true);
	});

	it("resolves the spec from --harness, then sessionConfigPath, then the configured default", () => {
		const configured = settingsWith({
			engineMode: "native",
			sessionConfigPath: "selected/harness.yaml",
			harnessDefault: "default/harness.yaml",
		});
		expect(resolveNativeHarnessSpec({ harness: "cli/harness.yaml" }, configured, WORKSPACE, true)).toBe(
			"cli/harness.yaml",
		);
		expect(resolveNativeHarnessSpec({}, configured, WORKSPACE, true)).toBe("selected/harness.yaml");
		const defaultOnly = settingsWith({ engineMode: "native", harnessDefault: "default/harness.yaml" });
		expect(resolveNativeHarnessSpec({}, defaultOnly, WORKSPACE, true)).toBe("default/harness.yaml");
	});

	it("returns no spec outside native mode and rejects a non-spec harness id in native mode", () => {
		expect(resolveNativeHarnessSpec({ engineMode: "off" }, settingsWith({}), WORKSPACE, false)).toBeUndefined();
		// `daily_driver` is an engine catalog id; native mode has no engine to resolve it.
		expect(() => resolveNativeHarnessSpec({}, settingsWith({ engineMode: "native" }), WORKSPACE, true)).toThrow(
			/native mode runs a harness spec/,
		);
	});
});
