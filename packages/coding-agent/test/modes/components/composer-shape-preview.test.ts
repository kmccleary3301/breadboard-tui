import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { COMPOSER_SHAPE_VALUES, type ComposerShape } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { composerSetupScene } from "@oh-my-pi/pi-tui/setup/scenes/composer";
import { createBreadboardPreviewStatusSource } from "@oh-my-pi/pi-tui/setup/scenes/information-layout";
import type { SetupSceneHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
import { BREADBOARD_PRODUCT_IDENTITY, OMP_PRODUCT_IDENTITY, type ProductIdentity } from "../../../src/product-identity";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { ComposerShapePreview, renderComposerShapePreview } from "@oh-my-pi/pi-tui/overlays/composer-shape-preview";
import { getComposerShapeOptions, installExtensionComposerShape } from "@oh-my-pi/pi-tui/overlays/composer-shape-registry";
import { initTheme, setTheme, theme } from "@oh-my-pi/pi-tui/theme/theme";
import { type ComposerStyle, visibleWidth } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme();
});
function createPreviewSession(): ConstructorParameters<typeof StatusLineComponent>[0] {
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
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				orchestrationInput: 0, orchestrationOutput: 0, orchestrationCacheRead: 0,
				premiumRequests: 0, cost: 0,
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

describe("composer shape preview", () => {
	it("resolves transparent composer preview text away from the terminal default", async () => {
		// The built-in `light` theme leaves `text` empty; a transparent shape must
		// still emit an explicit contrast foreground instead of ESC[39m, matching
		// the live editor so the preview stays readable on a light terminal.
		await setTheme("light");
		const box = renderComposerShapePreview("box", 80).join("\n");
		expect(box).not.toContain("\x1b[39mAsk anything");
		expect(box).toMatch(/\x1b\[38[;0-9]*mAsk anything/);
	});

	it("borrows status rows from the live status source per shape layout", async () => {
		await setTheme("dark");
		// Echo mocks: the stand-in title must be forwarded as a prop to every
		// title-bearing status call, not glued onto the rendered content.
		const source = createBreadboardPreviewStatusSource(
			{
				modelName: "Model",
				workspace: "Folder",
				sessionName: "Session",
				branch: "Branch",
				context: { tokens: 40_000, capacity: 100_000 },
				spend: { sessionUsd: 1.25, turnUsd: 0.05, estimated: true },
			},
			"bb-balanced",
		);
		const narrow = renderComposerShapePreview("box", 56, source).map(Bun.stripANSI);
		const wide = renderComposerShapePreview("box", 96, source).map(Bun.stripANSI);
		for (const value of ["Model", "Folder", "Session", "Branch", "~40%", "~1.25"]) {
			expect(narrow.join("\n").split(value).length - 1).toBe(1);
			expect(wide.join("\n").split(value).length - 1).toBe(1);
		}
		expect(narrow[narrow.length - 1]).toContain("~40%");
		expect(wide[wide.length - 1]).toContain("╰");
	});

	it("keeps Quiet identity anchored when activity appears on the rule", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const identity = { modelName: "Model", workspace: "Folder" };
		const idle = Bun.stripANSI(
			renderComposerShapePreview("rule", 80, createBreadboardPreviewStatusSource(identity, "bb-quiet"))[0]!,
		);
		const active = Bun.stripANSI(
			renderComposerShapePreview(
				"rule",
				80,
				createBreadboardPreviewStatusSource(
					{ ...identity, activity: { kind: "working", label: "Working" } },
					"bb-quiet",
				),
			)[0]!,
		);
		expect(idle).toContain("Folder");
		expect(active).toContain("Working");
		expect(idle.indexOf("Folder")).toBe(active.indexOf("Folder"));
	});

	it("uses the real status source for native and product marks across every symbol preset", async () => {
		for (const preset of ["unicode", "nerd", "emoji", "ascii"] as const) {
			await initTheme(false, preset, false, "titanium", "light");
			for (const identity of [OMP_PRODUCT_IDENTITY, BREADBOARD_PRODUCT_IDENTITY]) {
				const status = createPreviewStatus(identity);
				const rendered = Bun.stripANSI(renderComposerShapePreview("pi", 80, status, identity.cliName).join("\n"));
				const expectedMark =
					identity.id === OMP_PRODUCT_IDENTITY.id ? theme.icon.omp : identity.compactLogo[preset];
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
				expect(rendered).toContain(theme.icon.omp);
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

	it("uses the full overlay width instead of clipping the status band (issue #12500)", async () => {
		await setTheme("dark");
		const status = {
			getTopBorder: (width: number) => ({ content: "", width }),
			getStandaloneTopBorder: (width: number) => ({ content: "", width }),
			getBandTopBorder: (width: number) => ({ content: " ".repeat(width - 6) + "STATUS", width }),
			renderBottomBar: () => "",
		};

		const [statusBand] = renderComposerShapePreview("band", 200, status);

		expect(visibleWidth(statusBand ?? "")).toBe(200);
		expect(statusBand).toEndWith("STATUS");
	});
});
