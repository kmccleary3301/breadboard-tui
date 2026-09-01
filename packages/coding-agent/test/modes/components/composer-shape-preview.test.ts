import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { COMPOSER_SHAPE_VALUES, type ComposerShape } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	ComposerShapePreview,
	renderComposerShapePreview,
} from "@oh-my-pi/pi-coding-agent/modes/components/composer-shape-preview";
import {
	getComposerShapeOptions,
	installExtensionComposerShape,
} from "@oh-my-pi/pi-coding-agent/modes/components/composer-shape-registry";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { composerSetupScene } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/scenes/composer";
import type { SetupSceneHost } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/scenes/types";
import { initTheme, setTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	BREADBOARD_PRODUCT_IDENTITY,
	OMP_PRODUCT_IDENTITY,
	type ProductIdentity,
} from "@oh-my-pi/pi-coding-agent/product-identity";
import type { ComposerStyle } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme();
});

describe("composer shape preview", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	const shapes: ComposerShape[] = [...COMPOSER_SHAPE_VALUES];

	function createPreviewSession() {
		return {
			state: { messages: [] },
			messages: [],
			model: { contextWindow: 128_000 },
			contextUsageRevision: 0,
			systemPrompt: [],
			agent: { state: { tools: [] } },
			skills: [],
			isStreaming: false,
			isAutoThinking: false,
			autoResolvedThinkingLevel: () => undefined,
			isAdvisorActive: () => false,
			getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
			isFastModeActive: () => false,
			getAsyncJobSnapshot: () => ({ running: [] }),
			getCurrentModel: () => undefined,
			isFastModeEnabled: () => false,
			getContextUsage: () => ({ tokens: 0, contextWindow: 128_000 }),
			getGoalModeState: () => null,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: {
				getSessionName: () => "",
				getUsageStatistics: () => ({
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					orchestrationInput: 0,
					orchestrationOutput: 0,
					orchestrationCacheRead: 0,
					premiumRequests: 0,
					cost: 0,
				}),
			},
		} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
	}

	function createPreviewStatus(identity: ProductIdentity): StatusLineComponent {
		const status = new StatusLineComponent(createPreviewSession(), identity);
		status.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			sessionAccent: false,
		});
		return status;
	}

	it.each(shapes)("renders %s shape preview without throwing in dark theme", async (shape: ComposerShape) => {
		await setTheme("dark");
		const lines = renderComposerShapePreview(shape, 80);
		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		expect(joined).toContain("Ask anything");
	});

	it.each(shapes)("renders %s shape preview without throwing in light theme", async (shape: ComposerShape) => {
		await setTheme("light");
		const lines = renderComposerShapePreview(shape, 80);
		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		expect(joined).toContain("Ask anything");
	});

	it("updates preview when setValue is called on ComposerShapePreview component", async () => {
		await setTheme("dark");
		let renderRequested = false;
		const preview = new ComposerShapePreview("box", {
			requestRender: () => {
				renderRequested = true;
			},
		});
		const initialLines = preview.render(80);
		expect(initialLines.some(l => l.includes("Preview:"))).toBe(true);

		preview.setValue("claude");
		expect(renderRequested).toBe(true);
		const nextLines = preview.render(80);
		expect(nextLines.some(l => l.includes("Preview:"))).toBe(true);
	});

	it("borrows status rows from the live status source per shape layout", async () => {
		await setTheme("dark");
		// Echo mocks: the stand-in title must be forwarded as a prop to every
		// title-bearing status call, not glued onto the rendered content.
		const status = {
			getTopBorder: (_width: number, previewTitle?: string) => {
				const content = `TOPBAR ${previewTitle ?? ""}`;
				return { content, width: content.length };
			},
			getStandaloneTopBorder: (_width: number, previewTitle?: string) => {
				const content = `CHIP ${previewTitle ?? ""}`;
				return { content, width: content.length };
			},
			renderBottomBar: (_width: number, groups: "left" | "full", previewTitle?: string) =>
				`BOTTOM-${groups.toUpperCase()} ${previewTitle ?? ""}`,
		};

		const box = renderComposerShapePreview("box", 80, status).join("\n");
		expect(box).toContain("TOPBAR"); // embedded in the top border
		expect(box).toContain("omp"); // stand-in title forwarded to the status source
		expect(box).not.toContain("BOTTOM"); // box has no standalone bottom bar

		const claude = renderComposerShapePreview("claude", 80, status).join("\n");
		expect(claude).toContain("CHIP"); // right group chips onto the top rule
		expect(claude).toContain("omp");
		expect(claude).toContain("BOTTOM-LEFT"); // left group only on the bottom bar

		const rule = renderComposerShapePreview("rule", 80, status);
		expect(rule.join("\n")).toContain("CHIP");
		expect(rule.join("\n")).toContain("omp");
		expect(rule.join("\n")).toContain("BOTTOM-LEFT");
		expect(rule[rule.length - 2]).toBe(""); // spacer row: rule has no bottom chrome

		const pi = renderComposerShapePreview("pi", 80, status);
		expect(pi.join("\n")).not.toContain("CHIP");
		expect(pi.join("\n")).toContain("omp");
		expect(pi.join("\n")).toContain("BOTTOM-FULL"); // both groups on the bottom bar
		expect(pi[pi.length - 2]).not.toBe(""); // bottom rule already separates the bar

		const borderless = renderComposerShapePreview("borderless", 80, status).join("\n");
		expect(borderless).toContain("omp");
		expect(borderless).toContain("BOTTOM-FULL");

		for (const shape of ["field", "rail"]) {
			const rendered = renderComposerShapePreview(shape, 80, status);
			expect(rendered.join("\n")).not.toContain("CHIP");
			expect(rendered.join("\n")).toContain("omp");
			expect(rendered.join("\n")).toContain("BOTTOM-FULL");
			expect(rendered[rendered.length - 2]).toBe(""); // spacer row before the bar
		}
	});

	it("uses the real status source for native and product marks across every symbol preset", async () => {
		for (const preset of ["unicode", "nerd", "ascii"] as const) {
			await initTheme(false, preset, false, "titanium", "light");
			for (const identity of [OMP_PRODUCT_IDENTITY, BREADBOARD_PRODUCT_IDENTITY]) {
				const status = createPreviewStatus(identity);
				const rendered = Bun.stripANSI(renderComposerShapePreview("pi", 80, status, identity.cliName).join("\n"));
				const expectedMark = identity.id === OMP_PRODUCT_IDENTITY.id ? theme.icon.pi : identity.compactLogo[preset];
				expect(rendered).toContain(expectedMark);
				expect(rendered).toContain(identity.cliName);
				if (identity.id === BREADBOARD_PRODUCT_IDENTITY.id) {
					expect(rendered).not.toMatch(/\bomp\b/i);
					expect(rendered).not.toContain("π");
				}
			}
		}
	});

	it("keeps the stable pi id while adapting its user-facing label", () => {
		expect(getComposerShapeOptions(OMP_PRODUCT_IDENTITY).find(option => option.value === "pi")?.label).toBe("Pi");
		expect(getComposerShapeOptions(BREADBOARD_PRODUCT_IDENTITY).find(option => option.value === "pi")?.label).toBe(
			"Framed Rules",
		);
	});

	it("renders the setup composer scene through the injected identity and real status source", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		for (const identity of [OMP_PRODUCT_IDENTITY, BREADBOARD_PRODUCT_IDENTITY]) {
			const isolated = Settings.isolated();
			isolated.set("composer.shape", "pi");
			const host = {
				identity,
				ctx: {
					settings: isolated,
					statusLine: createPreviewStatus(identity),
				},
				requestRender: () => {},
				finish: () => {},
				setFocus: () => {},
				restoreFocus: () => {},
			} as unknown as SetupSceneHost;
			const rendered = Bun.stripANSI(composerSetupScene.mount(host).render(80, 40).join("\n"));
			if (identity.id === BREADBOARD_PRODUCT_IDENTITY.id) {
				expect(rendered).toContain("Framed Rules");
				expect(rendered).toContain("bb");
				expect(rendered).not.toMatch(/\bomp\b/i);
				expect(rendered).not.toMatch(/\bPi\b/);
				expect(rendered).not.toContain("π");
			} else {
				expect(rendered).toMatch(/\bPi\b/);
				expect(rendered).toContain("omp");
				expect(rendered).toContain(theme.icon.pi);
				expect(rendered).not.toContain("Framed Rules");
			}
		}
	});

	it("installs extension shapes into both selectors and live rendering", async () => {
		await setTheme("dark");
		const style: ComposerStyle = {
			id: "extension-dock",
			sideBorders: false,
			verticalChrome: 1,
			statusAttachment: "none",
			bottomBar: "full",
			bottomBarGap: false,
			defaultPromptGutter: "EXT ",
			defaultPaddingX: () => 0,
			sideChromeWidth: () => 0,
			renderTop: context => context.borderColor("=".repeat(context.width)),
			renderRow: context => [context.gutter + context.text + context.pad],
			renderBottom: () => undefined,
		};
		const dispose = installExtensionComposerShape({
			label: "Extension Dock",
			description: "Custom extension composer",
			style,
		});

		try {
			expect(getComposerShapeOptions().at(-1)).toEqual({
				value: "extension-dock",
				label: "Extension Dock",
				description: "Custom extension composer",
			});
			const rendered = renderComposerShapePreview("extension-dock", 76).join("\n");
			expect(rendered).toContain("=".repeat(76));
			expect(rendered).toContain("EXT ");
			expect(rendered).toContain("Ask anything");
		} finally {
			dispose();
		}

		expect(getComposerShapeOptions().some(option => option.value === "extension-dock")).toBe(false);
	});

	it("renders preview inside SettingsSelectorComponent submenu without crashing", async () => {
		await setTheme("dark");
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark", "light"],
				providers: [],
				cwd: process.cwd(),
			},
			{
				onChange: () => {},
				onCancel: () => {},
			},
		);

		for (const ch of "composer shape") selector.handleInput(ch);
		// Open the composer.shape submenu
		selector.handleInput("\n");

		const rendered = selector.render(80).join("\n");
		expect(rendered).toContain("Composer Shape");
		expect(rendered).toContain("Preview:");
		expect(rendered).toContain("Ask anything");

		// Cycle down to claude
		selector.handleInput("\x1b[B");
		const nextRendered = selector.render(80).join("\n");
		expect(nextRendered).toContain("Claude Code");
		expect(nextRendered).toContain("Preview:");
	});
});
