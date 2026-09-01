import { describe, expect, it } from "bun:test";
import { relativeLuminance } from "@oh-my-pi/pi-utils";
import { resolveVarRefs } from "../src/modes/theme/color";
import { loadTheme, loadThemeJson } from "../src/modes/theme/loader";
import type { ThemeColor } from "../src/modes/theme/theme";

const NORMAL_TEXT_TOKENS: readonly ThemeColor[] = [
	"accent",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"thinkingText",
	"customMessageLabel",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdQuote",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
	"pythonMode",
];

const STATUS_TEXT_TOKENS: readonly ThemeColor[] = [
	"statusLineModel",
	"statusLinePath",
	"statusLineGitClean",
	"statusLineGitDirty",
	"statusLineContext",
	"statusLineSpend",
	"statusLineStaged",
	"statusLineDirty",
	"statusLineUntracked",
	"statusLineOutput",
	"statusLineCost",
	"statusLineSubagents",
];

function contrastRatio(foreground: string, background: string): number {
	const foregroundLuminance = relativeLuminance(foreground);
	const backgroundLuminance = relativeLuminance(background);
	if (foregroundLuminance === undefined || backgroundLuminance === undefined) {
		throw new Error(`invalid RGB contrast pair: ${foreground} on ${background}`);
	}
	return (
		(Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
		(Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
	);
}

async function resolvedExportColor(themeName: string, token: "pageBg"): Promise<string> {
	const themeJson = await loadThemeJson(themeName);
	const value = themeJson.export?.[token];
	if (value === undefined) throw new Error(`${themeName} does not define export.${token}`);
	const resolved = resolveVarRefs(value, themeJson.vars ?? {});
	if (typeof resolved !== "string") throw new Error(`${themeName} export.${token} is not RGB`);
	return resolved;
}

describe("BreadBoard accessibility palette", () => {
	for (const themeName of ["breadboard", "breadboard-light"]) {
		it(`${themeName} keeps normal text roles at WCAG AA contrast`, async () => {
			const [activeTheme, pageBackground] = await Promise.all([
				loadTheme(themeName, { mode: "truecolor" }),
				resolvedExportColor(themeName, "pageBg"),
			]);
			for (const token of NORMAL_TEXT_TOKENS) {
				expect(contrastRatio(activeTheme.getColorHex(token), pageBackground), token).toBeGreaterThanOrEqual(4.5);
			}
		});

		it(`${themeName} keeps status text at WCAG AA and separators at UI contrast`, async () => {
			const [activeTheme, themeJson] = await Promise.all([
				loadTheme(themeName, { mode: "truecolor" }),
				loadThemeJson(themeName),
			]);
			const statusBackground = resolveVarRefs(themeJson.colors.statusLineBg, themeJson.vars ?? {});
			if (typeof statusBackground !== "string") throw new Error(`${themeName} statusLineBg is not RGB`);
			for (const token of STATUS_TEXT_TOKENS) {
				expect(contrastRatio(activeTheme.getColorHex(token), statusBackground), token).toBeGreaterThanOrEqual(4.5);
			}
			expect(contrastRatio(activeTheme.getColorHex("statusLineSep"), statusBackground)).toBeGreaterThanOrEqual(3);
		});
	}
});
