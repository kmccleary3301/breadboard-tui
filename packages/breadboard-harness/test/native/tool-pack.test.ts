import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { canonicalJson, isJsonRecord, parseCanonicalJson, type JsonRecord } from "../../src/canonical-json";
import { loadNativeHarness } from "../../src/native/load-native-harness";
import { loadNativeToolSurfaces, nativeFunctionTool } from "../../src/native/tool-pack";

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
	test("preserves enabled order after exclusions and falls back when exclusions remove every tool", async () => {
		const harness = await loadNativeHarness({ specPath: R39_SPEC, workspaceRoot: R39_WORKSPACE });
		const lock = JSON.parse(JSON.stringify(harness.lock)) as JsonRecord;
		const modes = lock.effective_values;
		if (!Array.isArray(modes)) throw new Error("fixture lock has no effective values");
		const modesEntry = modes.find(value => isJsonRecord(value) && value.path === "modes");
		if (!isJsonRecord(modesEntry)) throw new Error("fixture lock has no modes entry");
		modesEntry.value = [
			{ name: "ordered", tools_enabled: ["run_shell", "read_file"], tools_disabled: ["read_file"] },
			{ name: "fallback", tools_enabled: ["run_shell", "read_file"], tools_disabled: ["run_shell", "read_file"] },
		];

		const surfaces = await loadNativeToolSurfaces(lock);
		expect(surfaces.get("ordered")?.native.map(tool => tool.name)).toEqual(["run_shell"]);
		expect(surfaces.get("fallback")?.native.map(tool => tool.name)).toEqual(["read_file", "run_shell"]);
	});
});
