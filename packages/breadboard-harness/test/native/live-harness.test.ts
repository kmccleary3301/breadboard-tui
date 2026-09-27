import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createNativeHarnessExtension, startNativeHarnessWatcher } from "../../src/native/omp-extension";
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
		let bytes = new TextEncoder().encode("one");
		const reloadSources: string[] = [];
		let intervalCallback: (() => void) | undefined;
		let timeoutCallback: (() => void) | undefined;
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
			clearTimer() {},
		};
		const fakeLive = {
			editable: true,
			generation: 1,
			current: () => harness,
			reload: async (prepare?: (next: typeof harness) => void | Promise<void>) => {
				await prepare?.(harness);
				reloadSources.push(new TextDecoder().decode(bytes));
				return harness;
			},
			setReloadValidator() {},
			subscribe() {
				return () => {};
			},
		};
		const watcher = startNativeHarnessWatcher({
			live: fakeLive,
			specPath: "harness.yaml",
			context: context as never,
			statFile: async () => ({ mtimeMs: 1, size: 3 }),
			readSource: async () => bytes,
		});
		await watcher.ready;
		bytes = new TextEncoder().encode("two");
		intervalCallback?.();
		for (let attempt = 0; attempt < 5; attempt++) await Promise.resolve();
		bytes = new TextEncoder().encode("three");
		intervalCallback?.();
		for (let attempt = 0; attempt < 5; attempt++) await Promise.resolve();
		expect(timeoutCallback).toBeDefined();
		timeoutCallback?.();
		for (let attempt = 0; attempt < 5; attempt++) await Promise.resolve();
		expect(reloadSources).toEqual(["three"]);
		watcher.dispose();
	});
	it("rechecks disk after joining a manual reload and publishes the newer source", async () => {
		const root = await workspace();
		const harness = await loadNativeHarness({ workspaceRoot: root, specPath: SPEC });
		let bytes = new TextEncoder().encode("one");
		let releaseFirst: (() => void) | undefined;
		let inFlight: Promise<typeof harness> | undefined;
		let intervalCallback: (() => void) | undefined;
		let timeoutCallback: (() => void) | undefined;
		const publishedHashes: string[] = [];
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
			clearTimer() {},
		};
		const fakeLive = {
			editable: true,
			generation: 1,
			current: () => harness,
			reload: (prepare?: (next: typeof harness) => void | Promise<void>) => {
				if (inFlight !== undefined) return inFlight;
				const sourceHash = new TextDecoder().decode(bytes);
				const operation = (async () => {
					if (publishedHashes.length === 0) {
						await new Promise<void>(resolve => {
							releaseFirst = resolve;
						});
					}
					const loaded = { ...harness, sourceHash };
					await prepare?.(loaded);
					publishedHashes.push(sourceHash);
					return loaded;
				})();
				inFlight = operation.finally(() => {
					inFlight = undefined;
				});
				return inFlight;
			},
			setReloadValidator() {},
			subscribe() {
				return () => {};
			},
		};
		const watcher = startNativeHarnessWatcher({
			live: fakeLive,
			specPath: "harness.yaml",
			context: context as never,
			statFile: async () => ({ mtimeMs: 1, size: 3 }),
			readSource: async () => bytes,
		});
		await watcher.ready;
		const manualReload = fakeLive.reload();
		bytes = new TextEncoder().encode("two");
		intervalCallback?.();
		for (let attempt = 0; attempt < 5; attempt++) await Promise.resolve();
		timeoutCallback?.();
		for (let attempt = 0; attempt < 5; attempt++) await Promise.resolve();
		releaseFirst?.();
		await manualReload;
		for (let attempt = 0; attempt < 10; attempt++) await Promise.resolve();
		timeoutCallback?.();
		for (let attempt = 0; attempt < 10; attempt++) await Promise.resolve();
		expect(publishedHashes).toEqual(["one", "two"]);
		watcher.dispose();
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
		expect(entries.map(entry => entry.data)).toEqual([{ generation: 2, spec_path: SPEC, graph_hash: g2?.graphHash }]);
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
	it("exports the committed generation's harness identity after a live reload", async () => {
		const root = await workspace();
		const sessionDir = await mkdtemp(join(tmpdir(), "bb-live-harness-sessions-"));
		roots.push(sessionDir);
		const harness = await loadNativeHarness({ workspaceRoot: root, specPath: SPEC });
		const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
		let exportTranscript: ((args: string, context: unknown) => Promise<void>) | undefined;
		const api = {
			on(event: string, handler: unknown) {
				handlers.set(event, [
					...(handlers.get(event) ?? []),
					handler as (event: unknown, context: unknown) => unknown,
				]);
			},
			registerCommand(name: string, command: { handler: (args: string, context: unknown) => Promise<void> }) {
				if (name === "bb-transcript") exportTranscript = command.handler;
			},
			registerTool() {},
			setActiveTools() {},
			appendEntry() {},
		};
		const invoke = async (event: string): Promise<void> => {
			for (const handler of handlers.get(event) ?? []) await handler({}, {});
		};
		createNativeHarnessExtension(harness)(api as never);
		const g1Hash = harness.graphHash;
		await invoke("agent_start");
		const sourcePath = join(root, SPEC);
		await writeFile(sourcePath, (await readFile(sourcePath, "utf8")).replace("  - list_dir\n", ""));
		const g2 = await harness.live?.reload();
		await invoke("turn_start");
		expect(g2?.graphHash).not.toBe(g1Hash);

		const manager = SessionManager.create(root, sessionDir);
		manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		await manager.flush();
		const notices: string[] = [];
		await exportTranscript?.("", {
			sessionManager: manager,
			ui: { notify: (message: string) => notices.push(message) },
		});
		const written = notices[0]?.replace(/^Transcript written to /, "");
		expect(written).toBeDefined();
		const transcript = JSON.parse(await readFile(written!, "utf8"));
		expect(transcript.metadata.harness).toEqual({ spec_path: SPEC, graph_hash: g2?.graphHash });
	});
	it("hashes equal-metadata edits and disposes an in-flight debounce deterministically", async () => {
		const root = await workspace();
		const harness = await loadNativeHarness({ workspaceRoot: root, specPath: SPEC });
		let bytes = new TextEncoder().encode("one");
		let intervalCallback: (() => void) | undefined;
		let timeoutCallback: (() => void) | undefined;
		let clearCount = 0;
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
		const watcher = startNativeHarnessWatcher({
			live: harness.live!,
			specPath: "harness.yaml",
			context: context as never,
			statFile: async () => ({ mtimeMs: 1, size: 3 }),
			readSource: async () => bytes,
		});
		await watcher.ready;
		bytes = new TextEncoder().encode("two");
		intervalCallback?.();
		for (let attempt = 0; attempt < 5 && timeoutCallback === undefined; attempt++) await Promise.resolve();
		watcher.dispose();
		expect(clearCount).toBe(2);
		timeoutCallback?.();
		await Promise.resolve();
		expect(harness.live?.generation).toBe(1);
	});
	it("does not publish or notify when an in-flight reload crosses shutdown", async () => {
		const root = await workspace();
		const harness = await loadNativeHarness({ workspaceRoot: root, specPath: SPEC });
		let bytes = new TextEncoder().encode("one");
		let intervalCallback: (() => void) | undefined;
		let timeoutCallback: (() => void) | undefined;
		let releaseReload: (() => void) | undefined;
		let notifyCount = 0;
		let published = false;
		let clearCount = 0;
		const context = {
			ui: {
				notify() {
					notifyCount += 1;
				},
			},
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
		const fakeLive = {
			editable: true,
			generation: 1,
			current: () => ({ ...harness, sourceHash: "one" }),
			reload: async (prepare?: (next: typeof harness) => void | Promise<void>) => {
				await new Promise<void>(resolve => {
					releaseReload = resolve;
				});
				const loaded = { ...harness, sourceHash: "one" };
				await prepare?.(loaded);
				published = true;
				return loaded;
			},
			setReloadValidator() {},
			subscribe() {
				return () => {};
			},
		};
		const watcher = startNativeHarnessWatcher({
			live: fakeLive,
			specPath: "harness.yaml",
			context: context as never,
			statFile: async () => ({ mtimeMs: 1, size: 3 }),
			readSource: async () => bytes,
		});
		await watcher.ready;
		bytes = new TextEncoder().encode("two");
		intervalCallback?.();
		for (let attempt = 0; attempt < 5; attempt++) await Promise.resolve();
		timeoutCallback?.();
		for (let attempt = 0; attempt < 10 && releaseReload === undefined; attempt++) await Promise.resolve();
		expect(releaseReload).toBeDefined();
		watcher.dispose();
		expect(clearCount).toBe(2);
		releaseReload?.();
		for (let attempt = 0; attempt < 3; attempt++) await Promise.resolve();
		expect(published).toBe(false);
		expect(notifyCount).toBe(0);
	});
	it("schedules startup disk drift against the loaded source hash", async () => {
		const root = await workspace();
		const harness = await loadNativeHarness({ workspaceRoot: root, specPath: SPEC });
		let timeoutCallback: (() => void) | undefined;
		let reloadCount = 0;
		const context = {
			ui: { notify() {} },
			setInterval() {
				return {} as Timer;
			},
			setTimeout(callback: () => void) {
				timeoutCallback = callback;
				return {} as Timer;
			},
			clearTimer() {},
		};
		const fakeLive = {
			editable: true,
			generation: 1,
			current: () => ({ ...harness, sourceHash: "loaded" }),
			reload: async (prepare?: (next: typeof harness) => void | Promise<void>) => {
				reloadCount += 1;
				const loaded = { ...harness, sourceHash: "two" };
				await prepare?.(loaded);
				return loaded;
			},
			setReloadValidator() {},
			subscribe() {
				return () => {};
			},
		};
		const watcher = startNativeHarnessWatcher({
			live: fakeLive,
			specPath: "harness.yaml",
			context: context as never,
			statFile: async () => ({ mtimeMs: 1, size: 3 }),
			readSource: async () => new TextEncoder().encode("two"),
		});
		await watcher.ready;
		expect(timeoutCallback).toBeDefined();
		timeoutCallback?.();
		for (let attempt = 0; attempt < 5; attempt++) await Promise.resolve();
		expect(reloadCount).toBe(1);
		watcher.dispose();
	});
	it("does not install a timer when shutdown races initial source loading", async () => {
		const root = await workspace();
		const harness = await loadNativeHarness({ workspaceRoot: root, specPath: SPEC });
		let releaseRead: (() => void) | undefined;
		let intervalInstalled = false;
		const context = {
			ui: { notify() {} },
			setInterval() {
				intervalInstalled = true;
				return {} as Timer;
			},
			setTimeout() {
				return {} as Timer;
			},
			clearTimer() {},
		};
		const watcher = startNativeHarnessWatcher({
			live: harness.live!,
			specPath: "harness.yaml",
			context: context as never,
			statFile: async () => ({ mtimeMs: 1, size: 3 }),
			readSource: async () => {
				await new Promise<void>(resolve => {
					releaseRead = resolve;
				});
				return new TextEncoder().encode("one");
			},
		});
		for (let attempt = 0; attempt < 5 && releaseRead === undefined; attempt++) await Promise.resolve();
		expect(releaseRead).toBeDefined();
		watcher.dispose();
		releaseRead?.();
		await watcher.ready;
		expect(intervalInstalled).toBe(false);
	});
});
