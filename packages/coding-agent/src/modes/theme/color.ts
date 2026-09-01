import { detectTerminalId, getTerminalInfo } from "@oh-my-pi/pi-tui";
import { type ColorLevel, detectColorLevel } from "@oh-my-pi/pi-utils/chalk";
import type { ColorMode, ColorValue } from "./schema";

// ============================================================================
// Color Utilities
// ============================================================================

const RGBA_PATTERN = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),/u;

function colorLevelToMode(level: ColorLevel): ColorMode {
	switch (level) {
		case 0:
			return "none";
		case 1:
			return "16color";
		case 2:
			return "256color";
		case 3:
			return "truecolor";
	}
}

/** Resolve theme color depth once from shared FORCE_COLOR/NO_COLOR and terminal facts. */
export function detectColorMode(env: NodeJS.ProcessEnv = Bun.env): ColorMode {
	if (env.FORCE_COLOR !== undefined) return colorLevelToMode(detectColorLevel(env, true));
	if ("NO_COLOR" in env || env.TERM === "dumb") return "none";
	if (env.WT_SESSION) return "truecolor";
	const terminal = getTerminalInfo(detectTerminalId(env), process.platform, env);
	if (terminal.trueColor) return "truecolor";
	return colorLevelToMode(detectColorLevel(env, true));
}

function colorToRgb(color: string): readonly [red: number, green: number, blue: number] {
	const rgba = Bun.color(color, "rgba");
	const match = rgba ? RGBA_PATTERN.exec(rgba) : null;
	if (!match) throw new Error(`Invalid color value: ${color}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Deterministically quantize an RGB color to a basic or bright ANSI foreground code. */
export function rgbToAnsi16Code(red: number, green: number, blue: number): number {
	const value = Math.max(red, green, blue);
	if (value < 50) return 30;
	let code = 30 + ((Math.round(blue / 255) << 2) | (Math.round(green / 255) << 1) | Math.round(red / 255));
	if (value > 191) code += 60;
	return code;
}

export function colorToAnsi(color: string, mode: ColorMode): string {
	if (mode === "none") return "";
	if (mode === "16color") {
		const [red, green, blue] = colorToRgb(color);
		return `\x1b[${rgbToAnsi16Code(red, green, blue)}m`;
	}
	const ansi = Bun.color(color, mode === "truecolor" ? "ansi-16m" : "ansi-256");
	if (ansi === null) throw new Error(`Invalid color value: ${color}`);
	return ansi;
}

export function fgAnsi(color: string | number, mode: ColorMode): string {
	if (mode === "none") return "";
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") {
		return mode === "16color" ? colorToAnsi(ansi256ToHex(color), mode) : `\x1b[38;5;${color}m`;
	}
	return colorToAnsi(color, mode);
}

export function bgAnsi(color: string | number, mode: ColorMode): string {
	if (mode === "none") return "";
	if (color === "") return "\x1b[49m";
	const ansi =
		typeof color === "number"
			? mode === "16color"
				? colorToAnsi(ansi256ToHex(color), mode)
				: `\x1b[38;5;${color}m`
			: colorToAnsi(color, mode);
	return ansi.replace("\x1b[38;", "\x1b[48;").replace(/\x1b\[(3|9)(\d)m/u, (_, family, digit) => {
		const code = Number(`${family}${digit}`);
		return `\x1b[${code + 10}m`;
	});
}

/** Paint text with an already-resolved SGR escape, omitting both wrapper bytes in plain mode. */
export function paintAnsi(ansi: string, text: string, reset = "\x1b[0m"): string {
	return ansi ? `${ansi}${text}${reset}` : text;
}

export function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

export function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

/**
 * Resolve a theme color value (hex string or 256-color index) to a CSS hex string.
 * Empty string represents the default terminal color.
 */
export function resolveToHex(value: string | number, isLight: boolean): string {
	if (typeof value === "number") return ansi256ToHex(value);
	if (value === "") return isLight ? "#000000" : "#e5e5e7";
	return value;
}

/**
 * Convert a 256-color index to hex string.
 * Indices 0-15: basic colors (approximate)
 * Indices 16-231: 6x6x6 color cube
 * Indices 232-255: grayscale ramp
 */
export function ansi256ToHex(index: number): string {
	// Basic colors (0-15) - approximate common terminal values
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}
