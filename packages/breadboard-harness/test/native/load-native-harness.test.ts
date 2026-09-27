import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNativeHarness } from "../../src/native/load-native-harness";
import { loadNativeLock } from "../../src/native/lock-loader";

const R39_WORKSPACE = join(import.meta.dir, "fixtures", "r39-workspace");
const R39_DIR = ".breadboard/bb-omp/r39";
const R39_SPEC = `${R39_DIR}/bb-omp.harness.yaml`;
const R39_LOCK = `${R39_DIR}/bb-omp.harness.lock.json`;
const R39_GRAPH_HASH = "sha256:b962c4e249d1f529325bb29b32ac6e17a83a456df857e61734b7ffa20dec7fcd";

const scratch: string[] = [];
afterEach(async () => {
	await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function copyOfR39(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "bb-native-harness-"));
	scratch.push(root);
	await cp(R39_WORKSPACE, root, { recursive: true });
	return root;
}

describe("loadNativeHarness", () => {
	test("compiles the R39 spec to the shipped lock and verifies that lock as a cache", async () => {
		const harness = await loadNativeHarness({ specPath: R39_SPEC, workspaceRoot: R39_WORKSPACE });
		expect(harness.graphHash).toBe(R39_GRAPH_HASH);
		expect(harness.verifiedCachePath).toBe(join(R39_WORKSPACE, R39_LOCK));
		// Oracle bytes from the R39 QC run's compiled system prompt and first per-turn catalog.
		expect(harness.systemPrompt).toBe(
			await readFile(join(import.meta.dir, "fixtures/r39-openai/compiled_system.md"), "utf8"),
		);
		expect(harness.perTurnPrompt).toBe(
			await readFile(join(import.meta.dir, "fixtures/r39-openai/per_turn/turn_1.md"), "utf8"),
		);
		expect(harness.defaultModel).toBe("openai-codex/gpt-5.6-luna");
		expect(harness.permissions).toEqual({ mode: "prompt", shell: "ask" });
		expect(harness.todos).toEqual({ enabled: true, strict: true });
	});

	test("compiles without a cached lock", async () => {
		const root = await copyOfR39();
		await rm(join(root, R39_LOCK));
		const harness = await loadNativeHarness({ specPath: R39_SPEC, workspaceRoot: root });
		expect(harness.graphHash).toBe(R39_GRAPH_HASH);
		expect(harness.verifiedCachePath).toBeUndefined();
	});

	test("refuses a cached lock the edited spec no longer compiles to", async () => {
		const root = await copyOfR39();
		const spec = join(root, R39_SPEC);
		await writeFile(spec, (await readFile(spec, "utf8")).replace("idle_turn_limit: 2", "idle_turn_limit: 3"));
		await expect(loadNativeHarness({ specPath: R39_SPEC, workspaceRoot: root })).rejects.toThrow(/is stale/);
	});

	test("refuses a cached lock after the prompt resource changes", async () => {
		const root = await copyOfR39();
		await writeFile(join(root, R39_DIR, "prompts/daily_driver_system.md"), "You are someone else.\n");
		await expect(loadNativeHarness({ specPath: R39_SPEC, workspaceRoot: root })).rejects.toThrow(/is stale/);
	});

	test("keeps a prompt string that names no file as literal text", async () => {
		const root = await copyOfR39();
		await rm(join(root, R39_LOCK));
		const spec = join(root, R39_SPEC);
		await writeFile(spec, (await readFile(spec, "utf8")).replace("prompts/daily_driver_system.md", "inline prompt"));
		const harness = await loadNativeHarness({ specPath: R39_SPEC, workspaceRoot: root });
		expect(harness.systemPrompt.startsWith("inline prompt\n\n")).toBe(true);
	});

	test("resolves a mode prompt that is a pack reference", async () => {
		const root = await copyOfR39();
		await rm(join(root, R39_LOCK));
		const spec = join(root, R39_SPEC);
		await writeFile(
			spec,
			(await readFile(spec, "utf8")).replace(
				"prompts:\n",
				"prompts:\n  injection:\n    system_order:\n    - mode_specific\n",
			),
		);
		const harness = await loadNativeHarness({ specPath: R39_SPEC, workspaceRoot: root });
		expect(harness.systemPrompt).toBe(
			await readFile(join(import.meta.dir, "fixtures/r39-openai/compiled_system.md"), "utf8"),
		);
	});

	test("refuses a prompt resource outside the spec directory", async () => {
		const root = await copyOfR39();
		const spec = join(root, R39_SPEC);
		await writeFile(
			spec,
			(await readFile(spec, "utf8")).replace("prompts/daily_driver_system.md", "../../../secret.md"),
		);
		await writeFile(join(root, "secret.md"), "not a prompt\n");
		await expect(loadNativeHarness({ specPath: R39_SPEC, workspaceRoot: root })).rejects.toThrow(
			/escapes its spec directory/,
		);
	});
	test("compiles plan and build stages with stage-specific prompts and tools", async () => {
		const root = await copyOfR39();
		await rm(join(root, R39_LOCK));
		await writeFile(
			join(root, R39_DIR, "bb-omp.harness.yaml"),
			`schema_version: bb.harness_definition.v1
version: 1
workspace:
  root: .
providers:
  default_model: openai-codex/gpt-5.6-luna
  models:
  - id: openai-codex/gpt-5.6-luna
    adapter: openai_responses
prompts:
  packs:
    base:
      system: base prompt
  injection:
    system_order:
    - mode_specific
features:
  plan: true
modes:
- name: plan
  prompt: plan prompt
  tools_enabled: [read_file]
- name: build
  prompt: build prompt
  tools_enabled: [run_shell]
loop:
  sequence:
  - if: features.plan
    then: {mode: plan}
  - mode: build
  plan_turn_limit: 1
`,
		);
		const harness = await loadNativeHarness({ specPath: R39_SPEC, workspaceRoot: root });
		expect(harness.stages.map(stage => stage.mode)).toEqual(["plan", "build"]);
		expect(harness.stages.map(stage => stage.systemPrompt)).toEqual(["plan prompt", "build prompt"]);
		expect(harness.stages[0]?.toolSurface.native.map(tool => tool.name)).toContain("read_file");
		expect(harness.stages[1]?.toolSurface.native.map(tool => tool.name)).toContain("run_shell");
	});
});

describe("loadNativeLock", () => {
	test("rejects an edited lock whose recorded graph_hash no longer matches its content", async () => {
		const root = await copyOfR39();
		const lock = join(root, R39_LOCK);
		await writeFile(lock, (await readFile(lock, "utf8")).replace('"value": 2', '"value": 3'));
		await expect(loadNativeLock(lock)).rejects.toThrow(/graph_hash mismatch/);
	});

	test("rejects a lock whose sidecar is missing", async () => {
		const root = await copyOfR39();
		await rm(join(root, R39_DIR, ".bb-omp.harness.lock.json.meta.json"));
		await expect(loadNativeLock(join(root, R39_LOCK))).rejects.toThrow(/sidecar are both required/);
	});
});
