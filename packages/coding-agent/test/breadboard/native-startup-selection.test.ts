/**
 * Native mode runs OMP's own loop on a harness: no engine owns turns, and the harness comes from
 * `--harness`, then the selected `sessionConfigPath`, then `breadboard.harness.default`, whose
 * default names the built-in `bb-omp.native`.
 */
import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { resolveNativeLaunchPolicy } from "@oh-my-pi/pi-coding-agent/breadboard/native-launch-policy";
import {
	resolveNativeHarnessSpec,
	startupBreadboardEngineOwnsTurns,
} from "@oh-my-pi/pi-coding-agent/breadboard/runtime";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const WORKSPACE = os.tmpdir();

function settingsWith(values: { engineMode?: string; sessionConfigPath?: string; harnessDefault?: string }): Settings {
	return Settings.isolated({
		...(values.engineMode === undefined ? {} : { "breadboard.engineMode": values.engineMode }),
		...(values.sessionConfigPath === undefined ? {} : { "breadboard.sessionConfigPath": values.sessionConfigPath }),
		...(values.harnessDefault === undefined ? {} : { "breadboard.harness.default": values.harnessDefault }),
	});
}

describe("native startup selection", () => {
	it("defaults product launches to the native OMP loop", () => {
		const defaults = settingsWith({});
		expect(startupBreadboardEngineOwnsTurns({}, defaults, WORKSPACE, true)).toBe(false);
		expect(resolveNativeHarnessSpec({}, defaults, WORKSPACE, true)).toBe("bb-omp.native");
	});

	it("keeps turns on OMP's loop in native and off modes only", () => {
		const native = settingsWith({ engineMode: "native" });
		expect(startupBreadboardEngineOwnsTurns({}, native, WORKSPACE, true)).toBe(false);
		expect(startupBreadboardEngineOwnsTurns({ engineMode: "off" }, native, WORKSPACE, true)).toBe(false);
		expect(() => startupBreadboardEngineOwnsTurns({ engineMode: "local-owned" }, native, WORKSPACE, true)).toThrow();
	});

	it("opens print and protocol surfaces in native mode and refuses them for engine modes", () => {
		for (const surface of ["print", "rpc", "rpc-ui", "acp"] as const) {
			expect(resolveNativeLaunchPolicy({ engineMode: "native" }, surface).kind).toBe("native");
			expect(resolveNativeLaunchPolicy({ engineMode: "local-owned" }, surface).kind).toBe("unavailable");
		}
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

	it("returns no spec outside native mode and defaults native mode to bb-omp.native", () => {
		expect(resolveNativeHarnessSpec({ engineMode: "off" }, settingsWith({}), WORKSPACE, false)).toBeUndefined();
		expect(resolveNativeHarnessSpec({}, settingsWith({ engineMode: "native" }), WORKSPACE, true)).toBe(
			"bb-omp.native",
		);
		expect(
			resolveNativeHarnessSpec(
				{ harness: "bb-omp.native" },
				settingsWith({ engineMode: "native" }),
				WORKSPACE,
				true,
			),
		).toBe("bb-omp.native");
		// Other engine catalog ids name Python harnesses; native mode has no engine to resolve them.
		expect(() =>
			resolveNativeHarnessSpec(
				{ harness: "research_agent" },
				settingsWith({ engineMode: "native" }),
				WORKSPACE,
				true,
			),
		).toThrow(/native mode runs a built-in harness \(bb-omp\.native\) or a harness spec/);
	});
});
