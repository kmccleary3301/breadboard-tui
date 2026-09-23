import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadNativeHarness } from "../../src/native/load-native-harness";
import { NativeTurnPolicy } from "../../src/native/turn-policy";

const R39_WORKSPACE = join(import.meta.dir, "fixtures", "r39-workspace");

describe("NativeTurnPolicy", () => {
	test("blocks the second run_shell in one turn and admits it again next turn", async () => {
		const harness = await loadNativeHarness({
			specPath: ".breadboard/bb-omp/r39/bb-omp.harness.yaml",
			workspaceRoot: R39_WORKSPACE,
		});
		const policy = new NativeTurnPolicy(harness.toolSurface);
		policy.beginTurn();
		expect(policy.admit("run_shell")).toBeUndefined();
		expect(policy.admit("run_shell")).toEqual({ block: true, reason: "run_shell allows at most 1 call per turn" });
		// Tools without `max_per_turn` are never counted against a limit.
		expect(policy.admit("eval")).toBeUndefined();
		expect(policy.admit("eval")).toBeUndefined();
		policy.beginTurn();
		expect(policy.admit("run_shell")).toBeUndefined();
	});
});
