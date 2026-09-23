import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ALL_SCENES, createSetupHost, type SetupWizardContext } from "@oh-my-pi/pi-coding-agent/modes/setup";
import {
	BREADBOARD_PRODUCT_IDENTITY,
	OMP_PRODUCT_IDENTITY,
	type ProductIdentity,
} from "@oh-my-pi/pi-coding-agent/product-identity";
import { type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { getWelcomeTips, renderWelcomeTip } from "@oh-my-pi/pi-tui/prompt/welcome";
import { renderSetupOutro } from "@oh-my-pi/pi-tui/setup/scenes/outro";
import { renderSetupSplash, SETUP_SPLASH_MS } from "@oh-my-pi/pi-tui/setup/scenes/splash";
import type { SetupHost, SetupScene, SetupSceneHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
import { SetupWizardComponent } from "@oh-my-pi/pi-tui/setup/wizard-overlay";
import { initTheme } from "@oh-my-pi/pi-tui/theme/theme";

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});

afterEach(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});

function stripFrame(lines: readonly string[]): string[] {
	return lines.map(line => Bun.stripANSI(line));
}

function assertFrameGeometry(lines: readonly string[], width: number, height: number): void {
	expect(lines).toHaveLength(height);
	for (const line of lines) expect(visibleWidth(line)).toBe(width);
}

function assertNoNativeIdentity(text: string): void {
	expect(text).not.toMatch(/\bomp\b/i);
	expect(text).not.toContain("Oh My Pi");
	expect(text).not.toContain("O h   M y   P i");
	expect(text).not.toContain("π");
}

describe("setup identity renderers", () => {
	it.each([OMP_PRODUCT_IDENTITY, BREADBOARD_PRODUCT_IDENTITY])(
		"renders deterministic full start/mid/end frames for $id",
		identity => {
			const frames = [0, SETUP_SPLASH_MS / 2, SETUP_SPLASH_MS].map(elapsed =>
				renderSetupSplash(80, 30, elapsed, identity, "dark", "truecolor"),
			);
			for (const frame of frames) {
				assertFrameGeometry(frame, 80, 30);
				for (const row of identity.logoArt) expect(stripFrame(frame).join("\n")).toContain(row);
			}
			expect(frames[0]?.join("\n")).not.toBe(frames[1]?.join("\n"));
			expect(frames[1]?.join("\n")).not.toBe(frames[2]?.join("\n"));
		},
	);

	it.each([OMP_PRODUCT_IDENTITY, BREADBOARD_PRODUCT_IDENTITY])(
		"keeps the original $id art in compact viewports",
		identity => {
			for (const height of [16, 10]) {
				const frame = renderSetupSplash(60, height, 700, identity, "dark", "truecolor");
				assertFrameGeometry(frame, 60, height);
				const text = stripFrame(frame).join("\n");
				expect(text).toContain(identity.setupWordmark);
				for (const row of identity.logoArt) expect(text).toContain(row.trim());
			}
		},
	);

	it("keeps the complete BreadBoard wordmark when its enlarged form cannot fit", () => {
		const frame = renderSetupSplash(48, 16, 700, BREADBOARD_PRODUCT_IDENTITY, "dark", "truecolor");
		assertFrameGeometry(frame, 48, 16);
		const text = stripFrame(frame).join("\n");
		for (const row of BREADBOARD_PRODUCT_IDENTITY.logoArt) expect(text).toContain(row.trim());
	});

	it("scales half-block pixels instead of duplicating their glyphs", () => {
		const identity: ProductIdentity = { ...BREADBOARD_PRODUCT_IDENTITY, logoArt: ["█▀▄"] };
		const frame = stripFrame(renderSetupSplash(120, 36, SETUP_SPLASH_MS, identity, "dark", "none"));
		const top = frame.findIndex(line => line.trim() === "████");
		expect(top).toBeGreaterThanOrEqual(0);
		expect(frame[top + 1]?.trim()).toBe("██  ██");
	});

	it("keeps the moving trail connected and clears it on completion and resize", () => {
		const snake = new Set(["━", "┃", "╭", "╮", "╯", "╰", "●"]);
		for (const elapsed of [250, 650, 1100, 1650]) {
			const frame = stripFrame(renderSetupSplash(120, 36, elapsed, BREADBOARD_PRODUCT_IDENTITY, "dark", "none"));
			assertFrameGeometry(frame, 120, 36);
			const positions = new Set<number>();
			frame.forEach((line, y) =>
				[...line].forEach((char, x) => {
					if (snake.has(char)) positions.add(y * 120 + x);
				}),
			);
			const first = positions.values().next().value;
			if (first === undefined) throw new Error("animated trail missing");
			const pending = [first];
			const visited = new Set<number>();
			while (pending.length > 0) {
				const cell = pending.pop();
				if (cell === undefined || visited.has(cell)) continue;
				visited.add(cell);
				for (const neighbor of [cell - 1, cell + 1, cell - 120, cell + 120]) {
					if (positions.has(neighbor) && !visited.has(neighbor)) pending.push(neighbor);
				}
			}
			expect(visited.size).toBe(positions.size);
		}
		for (const [width, height] of [
			[80, 24],
			[32, 10],
			[120, 36],
			[1, 1],
		]) {
			const frame = stripFrame(
				renderSetupSplash(width, height, SETUP_SPLASH_MS, BREADBOARD_PRODUCT_IDENTITY, "dark", "none"),
			);
			assertFrameGeometry(frame, width, height);
			expect([...frame.join("")].some(char => snake.has(char))).toBe(false);
		}
	});

	it("keeps product setup frames free of native identity while preserving native copy", () => {
		const productCompact = stripFrame(
			renderSetupSplash(48, 16, SETUP_SPLASH_MS / 2, BREADBOARD_PRODUCT_IDENTITY, "dark", "truecolor"),
		).join("\n");
		assertNoNativeIdentity(productCompact);
		expect(productCompact).toContain("BreadBoard");

		const nativeCompact = stripFrame(
			renderSetupSplash(48, 16, SETUP_SPLASH_MS / 2, OMP_PRODUCT_IDENTITY, "dark", "truecolor"),
		).join("\n");
		expect(nativeCompact).toContain("O h   M y   P i");
		expect(nativeCompact).not.toContain("BreadBoard");

		const productOutro = renderSetupOutro(80, 24, 600, BREADBOARD_PRODUCT_IDENTITY, "dark", "truecolor");
		const nativeOutro = renderSetupOutro(80, 24, 600, OMP_PRODUCT_IDENTITY, "dark", "truecolor");
		assertFrameGeometry(productOutro, 80, 24);
		assertFrameGeometry(nativeOutro, 80, 24);
		expect(stripFrame(productOutro).join("\n")).toContain(BREADBOARD_PRODUCT_IDENTITY.logoArt[2] ?? "");
		expect(stripFrame(nativeOutro).join("\n")).toContain(OMP_PRODUCT_IDENTITY.logoArt[2] ?? "");
		assertNoNativeIdentity(stripFrame(productOutro).join("\n"));
	});
});

function wizardContext(rows: number): SetupWizardContext {
	const settings = Settings.isolated();
	return {
		ui: {
			terminal: { rows },
			requestRender: () => {},
			setFocus: () => {},
			invalidate: () => {},
		} as unknown as TUI,
		settings,
		modelRegistry: {
			authStorage: {
				has: () => false,
				hasAuth: () => false,
				getCredentialOrigin: () => undefined,
			} as unknown as AuthStorage,
			getAvailable: () => [],
			getAll: () => [],
			refresh: async () => {},
			refreshProvider: async () => {},
		} as unknown as ModelRegistry,
		modelSelection: {
			mode: "default",
			currentModel: undefined,
			availableModels: () => [],
			refresh: async () => {},
			select: async () => {},
		},
		openInBrowser: () => {},
	};
}

function identityHost(ctx: SetupWizardContext, identity: ProductIdentity): SetupHost {
	return { ...createSetupHost(ctx), identity };
}

function identityScene(): SetupScene {
	return {
		id: "identity-check",
		title: "Identity check",
		minVersion: 1,
		mount: () => ({
			title: "Identity check",
			subtitle: "Deterministic scene body",
			render: () => ["BODY"],
			invalidate: () => {},
		}),
	};
}

describe("SetupWizardComponent identity boundary", () => {
	it.each([OMP_PRODUCT_IDENTITY, BREADBOARD_PRODUCT_IDENTITY])(
		"uses injected $id identity through splash, scene header, and outro",
		async identity => {
			let now = 0;
			const component = new SetupWizardComponent(identityHost(wizardContext(24), identity), [identityScene()], {
				now: () => now,
			});
			const pending = component.run();
			try {
				const splash = stripFrame(component.render(80)).join("\n");
				component.handleInput("\r");
				now = 421;
				const scene = stripFrame(component.render(80)).join("\n");
				expect(scene).toContain(identity.welcomeTitle);
				expect(scene).toContain(identity.logoArt[2] ?? "");
				component.handleInput("\x03");
				now = 1021;
				const outro = stripFrame(component.render(80)).join("\n");
				expect(outro).toContain(identity.logoArt[2] ?? "");
				expect(outro).toContain("Setup saved");
				if (identity.id === BREADBOARD_PRODUCT_IDENTITY.id) {
					assertNoNativeIdentity(`${splash}\n${scene}\n${outro}`);
				} else {
					expect(scene).toContain("omp");
					expect(`${splash}\n${scene}\n${outro}`).not.toContain("BreadBoard");
				}
				component.handleInput("\r");
				await pending;
			} finally {
				component.dispose();
			}
		},
	);
});

function modelHost(identity: ProductIdentity): SetupSceneHost {
	const settings = Settings.isolated();
	const ctx: SetupWizardContext = {
		settings,
		ui: {
			terminal: { rows: 30 },
			requestRender: () => {},
			setFocus: () => {},
			invalidate: () => {},
		} as unknown as TUI,
		modelRegistry: {
			authStorage: {
				has: () => false,
				hasAuth: () => false,
				getCredentialOrigin: () => undefined,
			} as unknown as AuthStorage,
			getAvailable: () => [],
			getAll: () => [],
			refresh: async () => {},
			refreshProvider: async () => {},
		} as unknown as ModelRegistry,
		modelSelection: {
			mode: "default",
			currentModel: undefined,
			availableModels: () => [],
			refresh: async () => {},
			select: async () => {},
		},
		openInBrowser: () => {},
	};
	return {
		ctx: identityHost(ctx, identity),
		requestRender: () => {},
		finish: () => {},
		setFocus: () => {},
		restoreFocus: () => {},
	};
}

describe("setup remediation identity", () => {
	it("keeps native model-empty copy and explains the product provider-free default", () => {
		const scene = ALL_SCENES.find(candidate => candidate.id === "model");
		if (!scene) throw new Error("model setup scene is missing");
		const native = stripFrame(scene.mount(modelHost(OMP_PRODUCT_IDENTITY)).render(100)).join("\n");
		const product = stripFrame(scene.mount(modelHost(BREADBOARD_PRODUCT_IDENTITY)).render(100)).join("\n");
		expect(native).toContain("No models available in this scope");
		expect(native).not.toContain("BreadBoard");
		expect(product).toContain("BreadBoard's provider-free default remains available");
		expect(product).not.toMatch(/API key.*required/i);
	});
});

describe("identity-resolved tips", () => {
	it("renders every product tip with supported identity data and filters native auth commands", () => {
		const tips = getWelcomeTips(BREADBOARD_PRODUCT_IDENTITY);
		const text = tips.join("\n");
		expect(text).not.toMatch(/auth-broker|auth-gateway/);
		expect(text).not.toMatch(/\{(?:cli|display)\}/);
		for (const tip of tips) {
			const rendered = stripFrame(renderWelcomeTip(tip, 120)).join("\n");
			assertNoNativeIdentity(rendered);
		}
	});
});

describe("identity module startup graph", () => {
	it("does not pull setup, provider-auth, or OAuth modules into the data-only owner", async () => {
		const entrypoint = path.resolve(import.meta.dir, "../src/product-identity.ts");
		const result = await Bun.build({ entrypoints: [entrypoint], target: "bun", format: "esm", metafile: true });
		expect(result.success).toBe(true);
		const inputs = Object.keys(result.metafile?.inputs ?? {});
		expect(inputs.some(input => /setup-wizard|provider-auth|oauth/i.test(input))).toBe(false);
	});
});
