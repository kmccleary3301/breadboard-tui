import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { bgAnsi, colorToAnsi, detectColorMode, fgAnsi, paintAnsi } from "@oh-my-pi/pi-tui/theme/color";
import { createTheme, getBuiltinThemes } from "@oh-my-pi/pi-tui/theme/loader";

const SGR = /\x1b\[[0-9;]*m/u;
const EXTENDED_COLOR = /\x1b\[(?:38|48);[25];/u;

describe("theme color mode", () => {
	it("emits 256-color SGR for macOS Terminal.app", () => {
		const mode = detectColorMode({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" });

		expect(mode).toBe("256color");
		expect(colorToAnsi("#f5e0ac", mode)).toBe("\x1b[38;5;223m");
	});

	it("keeps repeated foreground conversions separate across color depths", () => {
		expect(colorToAnsi("#f5e0ac", "truecolor")).toBe("\x1b[38;2;245;224;172m");
		expect(colorToAnsi("#f5e0ac", "256color")).toBe("\x1b[38;5;223m");
		expect(colorToAnsi("#f5e0ac", "truecolor")).toBe("\x1b[38;2;245;224;172m");
	});

	it("emits 256-color session accents for macOS Terminal.app", async () => {
		const proc = Bun.spawn(
			[
				process.execPath,
				"--eval",
				'import { getSessionAccentAnsi } from "./packages/tui/src/theme/session-color.ts"; process.stdout.write(getSessionAccentAnsi("#f5e0ac") ?? "undefined");',
			],
			{
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: {
					...process.env,
					KITTY_WINDOW_ID: "",
					GHOSTTY_RESOURCES_DIR: "",
					WEZTERM_PANE: "",
					ITERM_SESSION_ID: "",
					VSCODE_PID: "",
					ALACRITTY_WINDOW_ID: "",
					TERM_PROGRAM: "Apple_Terminal",
					TERM: "xterm-256color",
					COLORTERM: "",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("\x1b[38;5;223m");
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
				theme.fgResolved("text", "resolved"),
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
				expect(rendered).toBe("accent|resolved|background|custom|custom background|bold|underline|strike");
			} else {
				expect(rendered).toMatch(SGR);
				if (mode === "16color") expect(rendered).not.toMatch(EXTENDED_COLOR);
			}
		},
	);
});
