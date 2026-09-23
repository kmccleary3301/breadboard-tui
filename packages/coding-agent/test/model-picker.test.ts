import { createModelBrowserSource } from "../src/modes/model-browser-source";
import { beforeAll, describe, expect, type Mock, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelPickerComponent, type ModelPickerOptions } from "@oh-my-pi/pi-tui/overlays/model-picker";
import { resolveSegmentPalette } from "@oh-my-pi/pi-tui/chrome/segment-track";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import type { ResolvedRoleModel } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { TUI } from "@oh-my-pi/pi-tui";

function normalize(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n")).replace(/\s+/g, " ").trim();
}

function makeModel(provider: string, id: string, contextWindow = 128_000, kind?: Model["kind"]): Model {
	return buildModel({
		id,
		name: id,
		api: kind === "image" ? "openai-images" : "ollama-chat",
		...(kind ? { kind } : {}),
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 1024,
	});
}

let testTheme = await getThemeByName("dark");
if (!testTheme) throw new Error("Failed to load dark theme for ModelPicker tests");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load dark theme for ModelPicker tests");
	setThemeInstance(testTheme);
}

interface RegistryOverrides {
	refresh?: (mode: string) => Promise<void>;
}

interface PickerHarness {
	picker: ModelPickerComponent;
	onPick: Mock<(model: Model, selector: string, meta: { overContext: boolean }) => void | Promise<void>>;
	onPickRole: Mock<(entry: ResolvedRoleModel) => void>;
	onCancel: Mock<() => void>;
}

function createPicker(options: {
	models: Model[] | (() => Model[]);
	mainStreamOwnsTurnLifecycle: boolean;
	scopedModels?: Model[];
	scoped?: boolean;
	settings?: Settings;
	registry?: RegistryOverrides;
	onPick?: (model: Model, selector: string, meta: { overContext: boolean }) => void | Promise<void>;
	picker?: Omit<ModelPickerOptions, "mainStreamOwnsTurnLifecycle">;
}): PickerHarness {
	installTestTheme();
	const modelsFn = typeof options.models === "function" ? options.models : () => options.models as Model[];
	const settings = options.settings ?? Settings.isolated({});
	const registry = {
		refresh: options.registry?.refresh ?? (async () => {}),
		getError: () => undefined,
		getAvailable: modelsFn,
		getAll: modelsFn,
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
	const onPick: Mock<(model: Model, selector: string, meta: { overContext: boolean }) => void | Promise<void>> = vi.fn(
		options.onPick,
	);
	const onPickRole = vi.fn();
	const onCancel = vi.fn();
	const picker = new ModelPickerComponent(
		ui,
		createModelBrowserSource(settings),
		registry,
		options.scopedModels
			? options.scopedModels.map(model => ({ model }))
			: options.scoped
				? modelsFn().map(model => ({ model }))
				: [],
		{ onPick, onPickRole, onCancel },
		{
			mainStreamOwnsTurnLifecycle: options.mainStreamOwnsTurnLifecycle,
			...options.picker,
		},
	);
	return { picker, onPick, onPickRole, onCancel };
}

const DOWN = "\x1b[B";
const ESC = "\x1b";

describe("ModelPicker", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelPicker tests");
		}
	});

	test("shows kind-role metadata only on accepted model kinds", () => {
		const chat = makeModel("test", "chat-model");
		const image = makeModel("test", "image-model", 128_000, "image");
		const settings = Settings.isolated({ modelRoles: { image: "test/image-model" } });
		const { picker } = createPicker({ mainStreamOwnsTurnLifecycle: false, models: [chat, image], scoped: true, settings });

		picker.handleInput("image");

		expect(normalize(picker.render(220))).toContain("● image");
	});

	test("flags over-context models but keeps them selectable, reporting overContext on pick", () => {
		const small = makeModel("test", "a-small", 4096);
		const large = makeModel("test", "b-large", 128_000);
		const { picker, onPick } = createPicker({
			mainStreamOwnsTurnLifecycle: false,
			models: [small, large],
			scoped: true,
			picker: { currentContextTokens: 6000 },
		});

		expect(normalize(picker.render(220))).toContain("Session-only switch");

		picker.handleInput("small");
		const rendered = normalize(picker.render(220));
		expect(rendered).toContain("context>4.1k");
		expect(rendered).toContain("compacts with current model");

		picker.handleInput("\n");
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]?.[0]).toBe(small);
		expect(onPick.mock.calls[0]?.[2]).toEqual({ overContext: true });
	});

	test("picking a model that fits reports overContext false", () => {
		const small = makeModel("test", "a-small", 4096);
		const large = makeModel("test", "b-large", 128_000);
		const { picker, onPick } = createPicker({
			mainStreamOwnsTurnLifecycle: false,
			models: [small, large],
			scoped: true,
			picker: { currentContextTokens: 6000 },
		});

		picker.handleInput("large");
		picker.handleInput("\n");
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]?.[0]).toBe(large);
		expect(onPick.mock.calls[0]?.[2]).toEqual({ overContext: false });
	});

	test("uses cached models for Enter while the offline refresh is still pending", () => {
		const cached = makeModel("test", "cached-fast");
		const refreshGate = Promise.withResolvers<void>();
		const refresh = vi.fn(() => refreshGate.promise);
		const { picker, onPick } = createPicker({
			mainStreamOwnsTurnLifecycle: false,
			models: [cached],
			registry: { refresh },
		});

		picker.handleInput("\n");
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick.mock.calls[0]?.[0]).toBe(cached);
		expect(refresh).toHaveBeenCalledTimes(1);
		refreshGate.resolve();
	});

	test("keeps the highlighted model when a background refresh reorders the list", async () => {
		const modelBb = makeModel("test", "bb-model");
		const modelCc = makeModel("test", "cc-model");
		const modelAa = makeModel("test", "aa-model");
		let available = [modelBb, modelCc];
		const refreshGate = Promise.withResolvers<void>();
		const { picker, onPick } = createPicker({
			mainStreamOwnsTurnLifecycle: false,
			models: () => available,
			registry: { refresh: () => refreshGate.promise },
		});

		picker.handleInput(DOWN); // highlight cc-model
		available = [modelAa, modelBb, modelCc];
		refreshGate.resolve();
		// Not a tuned delay: one zero-length tick drains the component's
		// refresh().then(...) continuation chain deterministically.
		await Bun.sleep(0);
		picker.handleInput("\n");
		expect(onPick.mock.calls[0]?.[0]?.id).toBe("cc-model");
	});

	test("highlights and preselects the session's current model", () => {
		const models = [makeModel("test", "aa-model"), makeModel("test", "bb-model"), makeModel("test", "cc-model")];
		const { picker, onPick } = createPicker({
			mainStreamOwnsTurnLifecycle: false,
			models,
			scoped: true,
			picker: { currentSelector: "test/bb-model" },
		});

		// The detail block tags the selected (= current) model.
		expect(normalize(picker.render(220))).toContain("current");

		// Enter without navigation picks the preselected current model.
		picker.handleInput("\n");
		expect(onPick.mock.calls[0]?.[0]?.id).toBe("bb-model");
	});

	test("search jumps to the first result when choices through the current model change", () => {
		const models = [makeModel("test", "aa-unrelated"), makeModel("test", "bb-match"), makeModel("test", "cc-match")];
		const { picker, onPick } = createPicker({
			mainStreamOwnsTurnLifecycle: false,
			models,
			scoped: true,
			picker: { currentSelector: "test/cc-match" },
		});

		picker.handleInput("match");
		picker.handleInput("\n");

		expect(onPick.mock.calls[0]?.[0]?.id).toBe("bb-match");
	});

	test("search keeps the selection when every choice through it stays unchanged", () => {
		const models = [makeModel("test", "aa-shared"), makeModel("test", "bb-shared"), makeModel("test", "cc-shared")];
		const { picker, onPick } = createPicker({
			mainStreamOwnsTurnLifecycle: false,
			models,
			scoped: true,
			picker: { currentSelector: "test/cc-shared" },
		});

		picker.handleInput("shared");
		picker.handleInput("\n");

		expect(onPick.mock.calls[0]?.[0]?.id).toBe("cc-shared");
	});

	test("shows and applies ctrl+p quick roles when search starts with @", () => {
		const smol = makeModel("test", "smol-model");
		const slow = makeModel("test", "slow-model");
		const quickRoles: ResolvedRoleModel[] = [
			{ role: "smol", model: smol, explicitThinkingLevel: false },
			{ role: "slow", model: slow, explicitThinkingLevel: false },
		];
		const { picker, onPick, onPickRole } = createPicker({
			mainStreamOwnsTurnLifecycle: false,
			models: [smol, slow],
			scoped: true,
			picker: {
				quickRoles,
				quickRoleOrder: ["smol", "slow"],
				currentQuickRole: "slow",
			},
		});

		picker.handleInput("@");
		const rendered = picker.render(220);
		const frame = rendered.join("\n");
		expect(normalize(rendered)).toContain("@smol");
		expect(normalize(rendered)).toContain("@slow");
		const palette = resolveSegmentPalette(2);
		expect(frame).toContain(`${theme.getFgAnsi(palette[0])}@smol`);
		expect(frame).toContain(`${theme.getFgAnsi(palette[1])}@slow`);

		picker.handleInput("\n");
		expect(onPickRole).toHaveBeenCalledWith(quickRoles[1]);
		expect(onPick).not.toHaveBeenCalled();
	});

	test("external picker uses only the engine scope and ignores native role controls", () => {
		const native = makeModel("native", "native-only");
		const engine = makeModel("engine", "engine-model");
		const { picker, onPick, onPickRole } = createPicker({
			mainStreamOwnsTurnLifecycle: true,
			models: [native, engine],
			scopedModels: [engine],
			settings: Settings.isolated({
				modelRoles: { default: "native/native-only", smol: "native/native-only" },
			}),
			picker: {
				quickRoles: [{ role: "smol", model: native, explicitThinkingLevel: false }],
				quickRoleOrder: ["smol"],
				currentQuickRole: "smol",
			},
		});

		const rendered = normalize(picker.render(220));
		expect(rendered).toContain("engine-model");
		expect(rendered).not.toContain("native-only");
		expect(rendered).not.toContain("quick roles");
		expect(rendered).not.toContain("default");

		picker.handleInput("\n");
		expect(onPick.mock.calls[0]?.[0]).toBe(engine);
		expect(onPickRole).not.toHaveBeenCalled();
	});
	test("blocks repeated external picks while owner selection is pending", async () => {
		const engine = makeModel("engine", "engine-model");
		const selection = Promise.withResolvers<void>();
		const { picker, onPick } = createPicker({
			mainStreamOwnsTurnLifecycle: true,
			models: [engine],
			scopedModels: [engine],
			onPick: () => selection.promise,
		});

		picker.handleInput("\n");
		picker.handleInput("\n");

		expect(onPick).toHaveBeenCalledTimes(1);
		expect(normalize(picker.render(220))).toContain("selection pending");

		selection.resolve();
		await selection.promise;
	});
	test("shows rejected external selection and permits another choice", async () => {
		const first = makeModel("engine", "first-model");
		const second = makeModel("engine", "second-model");
		const selection = Promise.withResolvers<void>();
		let attempts = 0;
		const { picker, onPick } = createPicker({
			mainStreamOwnsTurnLifecycle: true,
			models: [first, second],
			scopedModels: [first, second],
			onPick: () => {
				attempts += 1;
				return attempts === 1 ? selection.promise : undefined;
			},
		});

		picker.handleInput("\n");
		selection.reject(new Error("owner rejected model"));
		await selection.promise.catch(() => undefined);
		expect(normalize(picker.render(220))).toContain("owner rejected model");

		picker.handleInput(DOWN);
		picker.handleInput("\n");
		expect(onPick).toHaveBeenCalledTimes(2);
	});
	test("external picks do not flag over-context models or request native compaction", () => {
		const small = makeModel("engine", "small-model", 4096);
		const { picker, onPick } = createPicker({
			mainStreamOwnsTurnLifecycle: true,
			models: [small],
			scopedModels: [small],
			picker: { currentContextTokens: 6000 },
		});

		const rendered = normalize(picker.render(220));
		expect(rendered).not.toContain("compacts with current model");
		expect(rendered).not.toContain("context>");

		picker.handleInput("\n");
		expect(onPick.mock.calls[0]?.[2]).toEqual({ overContext: false });
	});

	test("Esc clears an active query first, then cancels", () => {
		const { picker, onCancel } = createPicker({
			mainStreamOwnsTurnLifecycle: false,
			models: [makeModel("test", "test-model")],
			scoped: true,
		});

		picker.handleInput("q");
		picker.handleInput(ESC);
		expect(onCancel).not.toHaveBeenCalled();

		picker.handleInput(ESC);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
