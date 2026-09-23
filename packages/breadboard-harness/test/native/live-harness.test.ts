import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeHarnessReloadError, loadNativeHarness } from "../../src/native/load-native-harness";

const FIXTURE = join(import.meta.dir, "fixtures/r39-workspace/.breadboard/bb-omp/r39");
const SPEC = ".breadboard/bb-omp/r39/bb-omp.harness.yaml";
const PROMPT = ".breadboard/bb-omp/r39/prompts/daily_driver_system.md";
const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "bb-live-harness-"));
	roots.push(root);
	const source = await readFile(join(FIXTURE, "bb-omp.harness.yaml"), "utf8");
	await mkdir(join(root, ".breadboard/bb-omp/r39/prompts"), { recursive: true });
	await writeFile(join(root, SPEC), source);
	await writeFile(join(root, PROMPT), await readFile(join(FIXTURE, "prompts/daily_driver_system.md")));
	return root;
}

describe("native harness live state", () => {
	it("publishes the next generation and keeps a failed edit at the current generation", async () => {
		const root = await workspace();
		const harness = await loadNativeHarness({ workspaceRoot: root, specPath: SPEC });
		const generations: number[] = [];
		harness.live?.subscribe(change => generations.push(change.generation));
		const sourcePath = join(root, SPEC);
		const source = await readFile(sourcePath, "utf8");
		await writeFile(sourcePath, source.replace("- eval\n", "- eval\n  - TodoWrite\n"));
		await harness.live?.reload();
		expect(harness.live?.generation).toBe(2);
		expect(generations).toEqual([2]);
		await writeFile(sourcePath, "schema_version: bb.harness_definition.v1\nworkspace: null\n");
		await expect(harness.live?.reload()).rejects.toBeInstanceOf(NativeHarnessReloadError);
		expect(harness.live?.generation).toBe(2);
	});

	it("validates a replacement before publishing its generation", async () => {
		const root = await workspace();
		const harness = await loadNativeHarness({ workspaceRoot: root, specPath: SPEC });
		const generations: number[] = [];
		harness.live?.subscribe(change => generations.push(change.generation));
		harness.live?.setReloadValidator(() => {
			throw new Error("native tool binding is unavailable");
		});
		const sourcePath = join(root, SPEC);
		const source = await readFile(sourcePath, "utf8");
		await writeFile(sourcePath, source.replace("- eval\n", "- eval\n  - TodoWrite\n"));
		await expect(harness.live?.reload()).rejects.toMatchObject({
			code: "bind",
			generation: 1,
		});
		expect(harness.live?.generation).toBe(1);
		expect(generations).toEqual([]);
	});
});
