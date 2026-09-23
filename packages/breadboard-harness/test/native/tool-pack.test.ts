import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { canonicalJson, parseCanonicalJson } from "../../src/canonical-json";
import { loadNativeHarness } from "../../src/native/load-native-harness";
import { nativeFunctionTool } from "../../src/native/tool-pack";

const FIXTURES = join(import.meta.dir, "fixtures");
const R39_WORKSPACE = join(FIXTURES, "r39-workspace");
const R39_SPEC = ".breadboard/bb-omp/r39/bb-omp.harness.yaml";

describe("R39 tool surface", () => {
	test("offers exactly the function tools the Python reference sent to the provider", async () => {
		// Oracle: `provider_native/tools_provided/turn_1.json` from the R39 installed-release QC run
		// (sha256 33a1a3b0…, identical on turns 1, 9, 17 and 25).
		const oracle = parseCanonicalJson(await Bun.file(join(FIXTURES, "r39-openai", "tools-provided.turn_1.json")).text());
		const harness = await loadNativeHarness({ specPath: R39_SPEC, workspaceRoot: R39_WORKSPACE });
		const offered = harness.toolSurface.native.map(nativeFunctionTool);
		// Key order is part of the wire payload, so compare serialized bytes, not structural equality.
		expect(JSON.stringify(offered)).toBe(JSON.stringify(oracle));
		expect(canonicalJson(offered)).toBe(canonicalJson(oracle));
	});

	test("keeps the tools the reference offers only as text calls out of the function surface", async () => {
		const harness = await loadNativeHarness({ specPath: R39_SPEC, workspaceRoot: R39_WORKSPACE });
		expect(harness.toolSurface.textInvoked.map(tool => tool.name)).toEqual(["apply_unified_patch", "TodoWrite"]);
	});
});
