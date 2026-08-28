import { describe, expect, it } from "bun:test";
import { Markdown } from "@oh-my-pi/pi-tui";
import { WelcomeComponent } from "../src/modes/components/welcome";
import { attachmentSgr } from "../src/modes/composer-attachments";
import { highlightMagicKeywords } from "../src/modes/magic-keywords";
import { renderSetupSplash } from "../src/modes/setup-wizard/scenes/splash";
import { bgAnsi, colorToAnsi, detectColorMode, fgAnsi, paintAnsi } from "../src/modes/theme/color";
import { createTheme, getBuiltinThemes } from "../src/modes/theme/loader";
import type { ThemeJson } from "../src/modes/theme/schema";
import { getCurrentThemeName, getMarkdownTheme, initTheme, setThemeInstance, theme } from "../src/modes/theme/theme";
import type { ProductIdentity } from "../src/product-identity";
import { BREADBOARD_PRODUCT_IDENTITY } from "../src/product-identity";

const SGR = /\x1b\[[0-9;]*m/u;
const EXTENDED_COLOR = /\x1b\[(?:38|48);[25];/u;

describe("theme color mode detection", () => {
	it.each([
		[{ FORCE_COLOR: "0", NO_COLOR: "1", TERM: "xterm-256color" }, "none"],
		[{ FORCE_COLOR: "1", NO_COLOR: "1", TERM: "dumb" }, "16color"],
		[{ FORCE_COLOR: "2", NO_COLOR: "1", TERM: "dumb" }, "256color"],
		[{ FORCE_COLOR: "3", NO_COLOR: "1", TERM: "dumb" }, "truecolor"],
		[{ NO_COLOR: "" }, "none"],
		[{ TERM: "dumb" }, "none"],
		[{ WT_SESSION: "window" }, "truecolor"],
		[{ TERM_PROGRAM: "ghostty", TERM: "xterm" }, "truecolor"],
		[{ COLORTERM: "truecolor", TERM: "xterm" }, "truecolor"],
		[{ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }, "256color"],
		[{ TERM: "xterm-256color" }, "256color"],
		[{ TERM: "ansi" }, "16color"],
		[{ TERM: "xterm" }, "16color"],
		[{}, "16color"],
	] as const)("maps %o to %s", (environment, expected) => {
		expect(detectColorMode(environment)).toBe(expected);
	});
});

describe("theme color encoding", () => {
	it.each([
		["none", "", "", ""],
		["16color", "\x1b[91m", "\x1b[101m", "\x1b[91m"],
		["256color", "\x1b[38;5;196m", "\x1b[48;5;196m", "\x1b[38;5;196m"],
		["truecolor", "\x1b[38;2;255;0;0m", "\x1b[48;2;255;0;0m", "\x1b[38;2;255;0;0m"],
	] as const)("encodes red exactly in %s", (mode, fg, bg, direct) => {
		expect(fgAnsi("#ff0000", mode)).toBe(fg);
		expect(bgAnsi("#ff0000", mode)).toBe(bg);
		expect(colorToAnsi("#ff0000", mode)).toBe(direct);
		expect(paintAnsi(fg, "red", "\x1b[39m")).toBe(fg ? `${fg}red\x1b[39m` : "red");
	});

	it("never emits extended color sequences in 16-color mode", () => {
		const output = [
			fgAnsi("#4f8cff", "16color"),
			bgAnsi("#4f8cff", "16color"),
			fgAnsi(67, "16color"),
			bgAnsi(67, "16color"),
		].join("");
		expect(output).toMatch(SGR);
		expect(output).not.toMatch(EXTENDED_COLOR);
	});
});

describe("Theme capability ownership", () => {
	const dark = getBuiltinThemes().dark;
	if (!dark) throw new Error("dark theme unavailable");

	it.each(["none", "16color", "256color", "truecolor"] as const)(
		"routes semantic, custom, and style paint through %s",
		mode => {
			const theme = createTheme(dark, { mode });
			const rendered = [
				theme.fg("accent", "accent"),
				theme.bg("userMessageBg", "background"),
				theme.customColor("#ff0000", "custom"),
				theme.customBg("#00ff00", "custom background"),
				theme.bold("bold"),
				theme.underline("underline"),
				theme.strikethrough("strike"),
			].join("|");

			expect(theme.getColorMode()).toBe(mode);
			if (mode === "none") {
				expect(rendered).not.toMatch(SGR);
				expect(rendered).toBe("accent|background|custom|custom background|bold|underline|strike");
			} else {
				expect(rendered).toMatch(SGR);
				if (mode === "16color") expect(rendered).not.toMatch(EXTENDED_COLOR);
			}
		},
	);
});

describe("product renderer capability matrix", () => {
	const dark = getBuiltinThemes().dark;
	if (!dark) throw new Error("dark theme unavailable");

	it.each(["none", "16color", "256color", "truecolor"] as const)(
		"keeps product renderers inside %s capability",
		mode => {
			try {
				setThemeInstance(createTheme(dark, { mode }));
				const markdown = new Markdown(
					"Color #ff0000\n\n```mermaid\nflowchart LR\n  A --> B\n```",
					0,
					0,
					getMarkdownTheme(),
				).render(80);
				const markdownOutput = markdown.join("\n");
				const output = [
					...new WelcomeComponent(
						"1.0.0",
						"model",
						"provider",
						[],
						[],
						BREADBOARD_PRODUCT_IDENTITY,
						"dark",
					).render(80),
					...renderSetupSplash(64, 20, 500, BREADBOARD_PRODUCT_IDENTITY, "dark", mode),
					highlightMagicKeywords("ultrathink orchestrate workflowz"),
					attachmentSgr("image", 1),
					...markdown,
				].join("\n");

				if (mode === "none") {
					expect(output).not.toMatch(SGR);
					expect(attachmentSgr("image", 1)).toBe("");
					expect(output).toContain("■ #ff0000");
				} else if (mode === "16color") {
					expect(output).toMatch(SGR);
					expect(output).not.toMatch(EXTENDED_COLOR);
					expect(markdownOutput).not.toMatch(EXTENDED_COLOR);
				} else if (mode === "256color") {
					expect(markdownOutput).toContain("\x1b[38;5;");
					expect(markdownOutput).not.toContain("\x1b[38;2;");
				} else {
					expect(markdownOutput).toContain("\x1b[38;2;");
				}
			} finally {
				setThemeInstance(createTheme(dark, { mode: "truecolor" }));
			}
		},
	);
});

describe("identity and theme customization boundaries", () => {
	const dark = getBuiltinThemes().dark;
	if (!dark) throw new Error("dark theme unavailable");

	it("reskins an alternate identity and custom theme without renderer changes", () => {
		const customTheme: ThemeJson = {
			...dark,
			name: "alternate-theme",
			vars: { ...dark.vars, accent: "#123456" },
			symbols: { preset: "ascii", overrides: { "nav.cursor": "!" } },
		};
		const alternateIdentity = {
			id: "alternate",
			displayName: "Alternate Product",
			shortDisplayName: "Alternate",
			cliName: "alt",
			welcomeTitle: "Alternate",
			setupWordmark: "Alternate",
			composerFrameLabel: "Alternate Frame",
			logoArt: ["ALT"],
			compactLogo: { unicode: "A", nerd: "A", ascii: "A" },
			gradientPalettes: {
				dark: {
					stops: [
						[18, 52, 86],
						[86, 52, 18],
					],
					ramp256: [24, 94],
					ramp16: [34, 33],
				},
				light: {
					stops: [
						[86, 52, 18],
						[18, 52, 86],
					],
					ramp256: [94, 24],
					ramp16: [33, 34],
				},
			},
			defaultThemes: { dark: "alternate-theme", light: "alternate-theme" },
		} as const satisfies ProductIdentity;

		try {
			setThemeInstance(createTheme(customTheme, { mode: "truecolor" }));
			const rendered = new WelcomeComponent("1.2.3", "model", "provider", [], [], alternateIdentity, "dark")
				.render(80)
				.join("\n");
			const plain = Bun.stripANSI(rendered);
			expect(plain).toContain("Alternate v1.2.3");
			expect(plain).toContain("ALT");
			expect(theme.fg("accent", "accent")).toContain("\x1b[38;2;18;52;86m");
			expect(theme.nav.cursor).toBe("!");
		} finally {
			setThemeInstance(createTheme(dark, { mode: "truecolor" }));
		}
	});

	it("preserves dark/light selection, symbol override, and colorblind transforms", async () => {
		const originalColorFgBg = Bun.env.COLORFGBG;
		const darkCosmos = getBuiltinThemes()["dark-cosmos"];
		if (!darkCosmos) throw new Error("dark-cosmos theme unavailable");
		const normalAdded = createTheme(darkCosmos, {
			mode: "256color",
			colorBlindMode: false,
		}).getColorHex("toolDiffAdded");
		const colorblindAdded = createTheme(darkCosmos, {
			mode: "256color",
			colorBlindMode: true,
		}).getColorHex("toolDiffAdded");
		expect(colorblindAdded).not.toBe(normalAdded);
		try {
			Bun.env.COLORFGBG = "0;0";
			await initTheme(false, "ascii", true, "dark-cosmos", "porcelain", "256color");
			expect(getCurrentThemeName()).toBe("dark-cosmos");
			expect(theme.getSymbolPreset()).toBe("ascii");
			expect(theme.getColorHex("toolDiffAdded")).toBe(colorblindAdded);

			Bun.env.COLORFGBG = "0;15";
			await initTheme(false, "ascii", false, "dark-cosmos", "porcelain", "256color");
			expect(getCurrentThemeName()).toBe("porcelain");
			expect(theme.isLight).toBe(true);
			expect(theme.getColorMode()).toBe("256color");
		} finally {
			if (originalColorFgBg === undefined) delete Bun.env.COLORFGBG;
			else Bun.env.COLORFGBG = originalColorFgBg;
			setThemeInstance(createTheme(dark, { mode: "truecolor" }));
		}
	});
});
