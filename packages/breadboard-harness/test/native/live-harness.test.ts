import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeHarnessExtension } from "../../src/native/omp-extension";
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

	it("coalesces quick edits into one ordered publication of the last source", async () => {
		const root = await workspace();
		const harness = await loadNativeHarness({ workspaceRoot: root, specPath: SPEC });
		const generations: number[] = [];
		harness.live?.subscribe(change => generations.push(change.generation));
		const sourcePath = join(root, SPEC);
		const source = await readFile(sourcePath, "utf8");
		const firstSource = source.replace("  - eval\n", "  - eval\n  - TodoWrite\n");
		const secondSource = firstSource.replace("  - run_shell\n", "");
		await writeFile(sourcePath, firstSource);
		const firstReload = harness.live?.reload();
		await writeFile(sourcePath, secondSource);
		const secondReload = harness.live?.reload();
		const [firstResult, secondResult] = await Promise.all([firstReload, secondReload]);
		expect(firstResult?.graphHash).toBe(secondResult?.graphHash);
		expect(harness.live?.generation).toBe(2);
		expect(generations).toEqual([2]);
	});
	it("keeps in-flight turn tools stable and commits a staged generation at the next turn", async () => {
		const root = await workspace();
		const harness = await loadNativeHarness({ workspaceRoot: root, specPath: SPEC });
		const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
		const registeredTools: string[] = [];
		const activeTools: string[][] = [];
		const entries: Array<{ type: string; data: unknown }> = [];
		let blockNextActiveTools = false;
		let releaseActiveTools: (() => void) | undefined;
		const api = {
			on(event: string, handler: unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler as (event: unknown, context: unknown) => unknown);
				handlers.set(event, list);
			},
			registerCommand() {},
			registerTool(tool: { name: string }) {
				registeredTools.push(tool.name);
			},
			setActiveTools(names: string[]) {
				activeTools.push([...names]);
				if (!blockNextActiveTools) return;
				blockNextActiveTools = false;
				return new Promise<void>(resolve => {
					releaseActiveTools = resolve;
				});
			},
			appendEntry(type: string, data: unknown) {
				entries.push({ type, data });
			},
		};
		const invoke = async (event: string): Promise<void> => {
			for (const handler of handlers.get(event) ?? []) await handler({}, {});
		};
		createNativeHarnessExtension(harness)(api as never);
		await invoke("agent_start");
		const toolsDuringTurn = [...activeTools.at(-1)!];
		const registrationsBeforeReload = registeredTools.length;
		const sourcePath = join(root, SPEC);
		const source = await readFile(sourcePath, "utf8");
		await writeFile(sourcePath, source.replace("  - list_dir\n", ""));
		const g2 = await harness.live?.reload();
		expect(activeTools.at(-1)).toEqual(toolsDuringTurn);
		expect(registeredTools).toHaveLength(registrationsBeforeReload);
		expect(entries).toEqual([]);
		await invoke("turn_start");
		expect(activeTools.at(-1)).not.toEqual(toolsDuringTurn);
		expect(registeredTools).toHaveLength(registrationsBeforeReload + toolsDuringTurn.length - 1);
		expect(entries.map(entry => entry.data)).toEqual([
			{ generation: 2, spec_path: SPEC, graph_hash: g2?.graphHash },
		]);
		const g2Source = await readFile(sourcePath, "utf8");
		await writeFile(sourcePath, g2Source.replace("  - run_shell\n", ""));
		const g3 = await harness.live?.reload();
		blockNextActiveTools = true;
		const inFlightTurn = invoke("turn_start");
		for (let attempt = 0; attempt < 10 && releaseActiveTools === undefined; attempt++) await Promise.resolve();
		expect(releaseActiveTools).toBeDefined();
		await writeFile(sourcePath, g2Source);
		const g4 = await harness.live?.reload();
		releaseActiveTools?.();
		await inFlightTurn;
		expect(entries.map(entry => entry.data)).toEqual([
			{ generation: 2, spec_path: SPEC, graph_hash: g2?.graphHash },
			{ generation: 3, spec_path: SPEC, graph_hash: g3?.graphHash },
		]);
		await invoke("turn_start");
		expect(entries.map(entry => entry.data).at(-1)).toEqual({
			generation: 4,
			spec_path: SPEC,
			graph_hash: g4?.graphHash,
		});
	});
	it("cancels a pending watcher debounce when the session shuts down", async () => {
		const root = await workspace();
		const harness = await loadNativeHarness({ workspaceRoot: root, specPath: SPEC });
		const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
		let intervalCallback: (() => void) | undefined;
		let timeoutCallback: (() => void) | undefined;
		let clearCount = 0;
		const api = {
			on(event: string, handler: unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler as (event: unknown, context: unknown) => unknown);
				handlers.set(event, list);
			},
			registerCommand() {},
			registerTool() {},
			setActiveTools() {},
			appendEntry() {},
		};
		createNativeHarnessExtension(harness)(api as never);
		const context = {
			ui: { notify() {} },
			setInterval(callback: () => void) {
				intervalCallback = callback;
				return {} as Timer;
			},
			setTimeout(callback: () => void) {
				timeoutCallback = callback;
				return {} as Timer;
			},
			clearTimer() {
				clearCount += 1;
			},
		};
		await handlers.get("session_start")?.at(-1)?.({}, context);
		const sourcePath = join(root, SPEC);
		const source = await readFile(sourcePath, "utf8");
		await writeFile(sourcePath, source.replace("  - list_dir\n", ""));
		intervalCallback?.();
		for (let attempt = 0; attempt < 10 && timeoutCallback === undefined; attempt++) {
			await new Promise<void>(resolve => setImmediate(resolve));
		}
		expect(timeoutCallback).toBeDefined();
		const shutdown = handlers.get("session_shutdown")?.at(-1);
		await shutdown?.({}, context);
		expect(clearCount).toBe(1);
		timeoutCallback?.();
		await Promise.resolve();
		expect(harness.live?.generation).toBe(1);
	});
});
