import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { gradientEscape, gradientLogo, logoNode } from "../../prompt/welcome";
import { getProductIdentity, type ProductAppearance, type ProductIdentity } from "../../product-identity";
import { paintAnsi } from "../../theme/color";
import type { ColorMode } from "../../theme/schema";
import { theme } from "../../theme/theme";
import { formatKeyHint } from "../../app-keybindings";
import { col, node, span, text } from "../../native/describe";
import type { NativeNode } from "../../native/node";
import { Memo } from "../../native/memo";

export const SETUP_SPLASH_MS = 2200;
export const SETUP_TICK_MS = 33;

interface Logo {
	readonly lines: readonly string[];
	readonly width: number;
}

const enlargedLogos = new WeakMap<ProductIdentity, Logo>();

/** Scale the pixels represented by half blocks, not the glyphs themselves. */
function getEnlargedLogo(identity: ProductIdentity): Logo {
	const cached = enlargedLogos.get(identity);
	if (cached) return cached;
	const lines = identity.logoArt.flatMap(line => {
		let upper = "";
		let lower = "";
		for (const char of line) {
			upper += char === "▄" ? "  " : char === "▀" ? "██" : char.repeat(2);
			lower += char === "▀" ? "  " : char === "▄" ? "██" : char.repeat(2);
		}
		return [upper, lower];
	});
	const logo = { lines, width: Math.max(...lines.map(line => visibleWidth(line))) };
	enlargedLogos.set(identity, logo);
	return logo;
}

interface Point {
	readonly x: number;
	readonly y: number;
}
interface Rectangle {
	readonly left: number;
	readonly right: number;
	readonly top: number;
	readonly bottom: number;
}

const SNAKE_GLYPHS = ["━", "┃", "╭", "╮", "╯", "╰", "●"] as const;

/** Skip affordance; built at render time so it follows the live symbol preset. */
function skipHint(): string {
	return `press ${formatKeyHint("enter")} to skip`;
}

/** A continuous clockwise spiral stops before touching the protected wordmark. */
function spiralRoute(width: number, height: number, protectedArea: Rectangle): Point[] {
	if (width < 56 || height < 18) return [];
	let left = 2;
	let right = width - 3;
	let top = 1;
	let bottom = height - 4;
	let x = left;
	let y = top;
	const points: Point[] = [{ x, y }];
	const insetX = Math.max(4, Math.floor((protectedArea.left - left) / 2));
	const insetY = Math.max(2, Math.floor((protectedArea.top - top) / 2));
	const walkTo = (targetX: number, targetY: number): boolean => {
		const dx = Math.sign(targetX - x);
		const dy = Math.sign(targetY - y);
		while (x !== targetX || y !== targetY) {
			const nextX = x + dx;
			const nextY = y + dy;
			if (
				nextX >= protectedArea.left &&
				nextX <= protectedArea.right &&
				nextY >= protectedArea.top &&
				nextY <= protectedArea.bottom
			)
				return false;
			x = nextX;
			y = nextY;
			points.push({ x, y });
		}
		return true;
	};
	while (left < right && top < bottom) {
		if (!walkTo(right, y)) break;
		top += insetY;
		if (top >= bottom || !walkTo(x, bottom)) break;
		right -= insetX;
		if (left >= right || !walkTo(left, y)) break;
		bottom -= insetY;
		if (top >= bottom || !walkTo(x, top)) break;
		left += insetX;
	}
	return points;
}

function connector(points: readonly Point[], index: number): number {
	const point = points[index];
	const before = points[index - 1] ?? point;
	const after = points[index + 1] ?? point;
	if (before.y === after.y) return 0;
	if (before.x === after.x) return 1;
	const left = before.x < point.x || after.x < point.x;
	const down = before.y > point.y || after.y > point.y;
	return left ? (down ? 3 : 4) : down ? 2 : 5;
}

interface SplashScene {
	readonly width: number;
	readonly height: number;
	readonly appearance: ProductAppearance;
	readonly mode: ColorMode;
	readonly cells: string[][];
	readonly route: readonly Point[];
	readonly connectors: readonly number[];
	readonly trail: readonly (readonly string[])[];
	readonly tailLength: number;
	previousStart: number;
	previousEnd: number;
}

// Keep only the current viewport per identity; resize replaces rather than accumulates scenes.
const scenes = new WeakMap<ProductIdentity, SplashScene>();

function createScene(
	width: number,
	height: number,
	identity: ProductIdentity,
	appearance: ProductAppearance,
	mode: ColorMode,
): SplashScene {
	const enlarged = getEnlargedLogo(identity);
	const art = width >= 100 && height >= 30 && enlarged.width <= width - 16 ? enlarged.lines : identity.logoArt;
	const artWidth = Math.max(...art.map(line => visibleWidth(line)));
	const palette = identity.gradientPalettes[appearance];
	const content =
		artWidth <= width && height >= art.length + 5
			? [...gradientLogo(art, 0, undefined, palette, mode), "", identity.setupWordmark]
			: [truncateToWidth(identity.setupWordmark, width)];
	const contentWidth = Math.max(...content.map(line => visibleWidth(line)));
	const logoTop = Math.max(0, Math.floor((height - 2 - content.length) / 2));
	const logoLeft = Math.floor((width - contentWidth) / 2);
	const cells = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
	const placeLine = (text: string, y: number): void => {
		const line = truncateToWidth(text, width);
		const lineWidth = visibleWidth(line);
		if (!lineWidth) return;
		const x = Math.floor((width - lineWidth) / 2);
		cells[y][x] = line;
		for (let column = x + 1; column < x + lineWidth; column++) cells[y][column] = "";
	};
	content.forEach((line, row) => placeLine(line, logoTop + row));
	if (height > 2) placeLine(paintAnsi(mode === "none" ? "" : "\x1b[2m", skipHint()), height - 2);
	const route = spiralRoute(width, height, {
		left: logoLeft - 3,
		right: logoLeft + contentWidth + 2,
		top: logoTop - 2,
		bottom: logoTop + content.length + 1,
	});
	const tailLength = Math.min(140, Math.max(32, Math.floor(route.length / 5)));
	const colors = Array.from(
		{ length: tailLength },
		(_, age) =>
			gradientEscape(age / (tailLength - 1), undefined, palette, mode) +
			(mode !== "none" && age > tailLength * 0.6 ? "\x1b[2m" : ""),
	);
	return {
		width,
		height,
		appearance,
		mode,
		cells,
		route,
		connectors: route.map((_, index) => connector(route, index)),
		trail: SNAKE_GLYPHS.map(glyph => colors.map(color => paintAnsi(color, glyph))),
		tailLength,
		previousStart: 0,
		previousEnd: -1,
	};
}

/** One finite light trail coils around an unchanged, centered product wordmark. */
export function renderSetupSplash(
	width: number,
	height: number,
	elapsedMs: number,
	identity: ProductIdentity = getProductIdentity(),
	appearance: ProductAppearance = theme.isLight ? "light" : "dark",
	mode: ColorMode = theme.getColorMode(),
): string[] {
	const w = Math.max(1, width);
	const h = Math.max(1, height);
	let scene = scenes.get(identity);
	if (!scene || scene.width !== w || scene.height !== h || scene.appearance !== appearance || scene.mode !== mode) {
		scene = createScene(w, h, identity, appearance, mode);
		scenes.set(identity, scene);
	}
	for (let index = scene.previousStart; index <= scene.previousEnd; index++) {
		const point = scene.route[index];
		scene.cells[point.y][point.x] = " ";
	}
	const progress = Math.max(0, Math.min(1, elapsedMs / SETUP_SPLASH_MS));
	const head = Math.floor(progress * (scene.route.length + scene.tailLength));
	const start = Math.max(0, head - scene.tailLength + 1);
	const end = Math.min(head, scene.route.length - 1);
	for (let index = start; index <= end; index++) {
		const point = scene.route[index];
		const glyph = index === head ? 6 : scene.connectors[index];
		scene.cells[point.y][point.x] = scene.trail[glyph][head - index];
	}
	scene.previousStart = start;
	scene.previousEnd = end;
	return scene.cells.map(row => row.join(""));
}

export function renderStarfield(width: number, height: number, frame: number): string[] {
	const lines: string[] = [];
	for (let y = 0; y < height; y++) {
		let line = "";
		for (let x = 0; x < width; x++) {
			const hash = (x * 73856093) ^ (y * 19349663) ^ ((frame >> 3) * 83492791);
			const bucket = Math.abs(hash) % 97;
			line += bucket === 0 ? theme.fg("accent", "✦") : bucket === 1 ? theme.fg("muted", "·") : " ";
		}
		lines.push(line);
	}
	return lines;
}
const splashMemo = new Memo();

/**
 * Native splash: the 2x brand mark with a terminal-clocked shimmer, the
 * wordmark, and the skip hint pinned to the bottom. A click on the splash
 * sends the `skip` action.
 */
export function describeSetupSplash(identity: ProductIdentity = getProductIdentity()): NativeNode {
	const hint = skipHint();
	return splashMemo.get([identity.id, hint], () =>
		col(
			[
				node("spacer", { grow: 1 }),
				logoNode(identity.logoArt, true),
				text([span(identity.displayName, "strong")], { wrap: "none" }),
				node("spacer", { grow: 1 }),
				text([span(hint, "dim")], { wrap: "none" }),
			],
			{ align: "center", gap: "md", grow: 1, role: "omp.setup.splash", actions: { click: "skip" } },
		),
	);
}
