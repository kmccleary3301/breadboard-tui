import type { TspSpan } from "@oh-my-pi/pi-wire";
import { formatDoubleTap, formatKeyHint, formatKeyHints, type KeyName } from "../app-keybindings";
import { editorKey } from "../chrome/keybinding-hints";
import { getKeybindings, type Keybinding } from "../keybindings";
import { registerNativeBlob } from "../native/blobs";
import { card, col, kbd, keyed, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { runTranscriptAction } from "../chat/transcript-actions";
import { plainLine } from "../native/spans";
import { isNativeRendering } from "../native/state";
import { colorToAnsi, paintAnsi } from "../theme/color";
import { hexToOklch, oklchToHex, rgbToHex, type OKLCH } from "@oh-my-pi/pi-utils/color";
import type { ColorMode } from "../theme/schema";
import { theme } from "../theme/theme";
import { isReducedMotionEnabled } from "../reduced-motion";
import type { Component } from "../tui";
import { padding, replaceTabs, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";
import tipsText from "./tips.txt" with { type: "text" };
import {
	type GradientPalette,
	getProductIdentity,
	OMP_PRODUCT_IDENTITY,
	type ProductAppearance,
	type ProductIdentity,
} from "../product-identity";

const NATIVE_ONLY_TIP_PREFIX = "[native-only]";

interface TipTemplate {
	readonly text: string;
	readonly nativeOnly: boolean;
}

/** Tip templates embedded at build time; command/display tokens resolve from immutable identity data. */
const TIP_TEMPLATES: readonly TipTemplate[] = Object.freeze(
	tipsText
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.map(line =>
			Object.freeze({
				text: line.startsWith(NATIVE_ONLY_TIP_PREFIX) ? line.slice(NATIVE_ONLY_TIP_PREFIX.length) : line,
				nativeOnly: line.startsWith(NATIVE_ONLY_TIP_PREFIX),
			}),
		),
);

export function getWelcomeTips(identity: ProductIdentity = getProductIdentity()): readonly string[] {
	const includeNativeOnly = identity.id === OMP_PRODUCT_IDENTITY.id;
	return Object.freeze(
		TIP_TEMPLATES.filter(template => includeNativeOnly || !template.nativeOnly).map(template =>
			template.text.replaceAll("{cli}", identity.cliName).replaceAll("{display}", identity.welcomeTitle),
		),
	);
}

/**
 * Fixed number of session rows in the welcome box so its height stays stable
 * across recent-session updates.
 */
export const WELCOME_SESSION_SLOTS = 4;

/**
 * Fixed number of LSP-server rows, for the same reason. Overflow is sliced so
 * the box height is constant regardless of how many servers a project has.
 */
export const WELCOME_LSP_SLOTS = 4;

/** Trailing marker that flags a tip as a "what's new" callout. Stripped before
 *  wrapping (with any preceding whitespace) and replaced by {@link NEW_TAG_TEXT}
 *  painted as a shimmering rainbow. Non-global so `.test` stays stateless. */
const NEW_TIP_MARKER = /\s*\[NEW\]\s*$/;

/** Visible text rendered in place of {@link NEW_TIP_MARKER}. */
const NEW_TAG_TEXT = "NEW!";

/** Milliseconds for one full hue rotation of the rainbow "NEW!" tag. */
const NEW_GLOW_PERIOD_MS = 1500;

/** Selection weight for "[NEW]" tips; ordinary tips weigh 1, so a freshly added
 *  affordance surfaces this many times as often. */
const NEW_TIP_WEIGHT = 4;

/** Pick a tip from `tips`, biased toward "[NEW]" tips by {@link NEW_TIP_WEIGHT};
 *  `r` is a uniform sample in [0, 1). Returns "" when `tips` is empty.
 *  Exported for tests. */
export function pickWeightedTip(tips: readonly string[], r: number): string {
	if (tips.length === 0) return "";
	const weights = tips.map(tip => (NEW_TIP_MARKER.test(tip) ? NEW_TIP_WEIGHT : 1));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	let acc = r * total;
	for (let i = 0; i < tips.length; i++) {
		acc -= weights[i] ?? 1;
		if (acc < 0) return tips[i] ?? "";
	}
	return tips[tips.length - 1] ?? "";
}

/** Paint each glyph of {@link NEW_TAG_TEXT} on a moving HSL rainbow. */
function renderNewTag(phase: number): string {
	const wrapped = ((phase % 1) + 1) % 1;
	const chars = [...NEW_TAG_TEXT];
	const painted = chars
		.map((char, index) => {
			const hue = Math.round(((index / chars.length + wrapped) % 1) * 360);
			return theme.customColor(`hsl(${hue}, 95%, 60%)`, char);
		})
		.join("");
	return theme.bold(painted);
}

/** Key placeholders in tips.txt: `{key:shift+tab}`, `{keys:up,down}`, `{tap:left}`, `{action:tui.editor.undo}`. */
const TIP_KEY_PLACEHOLDER = /\{(key|keys|tap|action):([^}]+)\}/g;

const MODIFIER_NAMES: Record<string, true | undefined> = {
	ctrl: true,
	shift: true,
	alt: true,
	super: true,
};

/** A `+`-joined chord whose leading parts are modifiers (`ctrl+o`, `shift`, `left`). */
function isKeyName(key: string): key is KeyName {
	const parts = key.split("+");
	return parts.every((part, i) => part.length > 0 && (i === parts.length - 1 || MODIFIER_NAMES[part] === true));
}

function isKeybinding(action: string): action is Keybinding {
	return action in getKeybindings().getResolvedBindings();
}

/** Expand tip key placeholders through the key formatter; malformed ones stay verbatim. */
function expandTipKeys(tip: string): string {
	return tip.replace(TIP_KEY_PLACEHOLDER, (placeholder, kind: string, value: string) => {
		if (kind === "action") return isKeybinding(value) ? editorKey(value) : placeholder;
		const keys = value.split(",");
		if (!keys.every(isKeyName)) return placeholder;
		if (kind === "keys") return formatKeyHints(keys);
		const [key] = keys;
		if (key === undefined) return placeholder;
		return kind === "tap" ? formatDoubleTap(key) : formatKeyHint(key);
	});
}

export function renderWelcomeTip(tip: string, boxWidth: number, phase = 0): string[] {
	const label = "Tip: ";
	const labelWidth = visibleWidth(label);
	const bodyBudget = boxWidth - 1 - labelWidth; // 1 = leading indent
	if (bodyBudget < 8) return [];

	const isNew = NEW_TIP_MARKER.test(tip);
	const body = expandTipKeys(isNew ? tip.replace(NEW_TIP_MARKER, "") : tip);

	const wrappedBody = wrapTextWithAnsi(replaceTabs(body), bodyBudget);
	if (wrappedBody.length === 0) return [];

	// Pull both colors from the active theme so the line stays readable on light
	// themes; the previous hardcoded `#b48cff` / `#9ccfff` pastels (plus a manual
	// `\x1b[2m` dim on the body) dropped to ~1.5:1 contrast on a white background.
	const continuationIndent = padding(labelWidth);
	const styledLabel = theme.fg("customMessageLabel", label);

	const lines = wrappedBody.map((line, index) => {
		const styledBody = theme.fg("muted", line);
		const content = index === 0 ? `${styledLabel}${styledBody}` : `${continuationIndent}${styledBody}`;
		return ` ${theme.italic(content)}`;
	});

	if (isNew) {
		// Append the rainbow tag to the final body line when it fits within the
		// box; otherwise drop it onto its own indented continuation line so the
		// styled glyphs never overflow or reflow the wrapped body.
		const tag = renderNewTag(phase);
		const tagWidth = 1 + visibleWidth(NEW_TAG_TEXT); // 1 = space separator
		const lastLine = lines[lines.length - 1];
		if (lastLine !== undefined && visibleWidth(lastLine) + tagWidth <= boxWidth) {
			lines[lines.length - 1] = `${lastLine} ${tag}`;
		} else {
			lines.push(` ${continuationIndent}${tag}`);
		}
	}

	return lines;
}

export interface RecentSession {
	name: string;
	timeAgo: string;
	/** Session file; a native click on the row resumes it. */
	path?: string;
}

export interface LspServerInfo {
	name: string;
	status: "ready" | "error" | "connecting" | "available";
	fileTypes: string[];
}

/**
 * Premium welcome screen with identity-provided logo art and two-column layout.
 */
export class WelcomeComponent implements Component {
	#animStart: number | null = null;
	#animTimer: Timer | null = null;
	#requestRender: (() => void) | null = null;
	#selectedTip: string | undefined;
	readonly #tips: readonly string[];
	// Tip randomness is latched once so the tip is stable across renders, but
	// the nerdfont-nag gate re-reads the live preset: the startup prepaint can
	// run under the default "unicode" preset before settings resolve the real
	// one, and a memoized nag would survive the switch to "nerd".
	#nagRoll: number | undefined;
	#tipRoll: number | undefined;
	// Render cache: the welcome box is the first transcript-area component, so
	// returning a stable array reference keeps the whole frame prefix stable.
	// Bypassed while the intro animation runs (every frame differs).
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;
	#native: { tip: string | undefined; node: NativeNode } | undefined;

	#restFrames = new Map<string, readonly string[]>();
	constructor(
		private version: string,
		private modelName: string,
		private providerName: string,
		private recentSessions: RecentSession[] = [],
		/** Detected project servers; `null` means LSP is disabled and hides the section. */
		private lspServers: LspServerInfo[] | null = [],
		private readonly identity: ProductIdentity = getProductIdentity(),
		private readonly appearance?: ProductAppearance,
		private reduceMotion?: boolean,
		private harnessIdentity = "",
	) {
		this.#tips = getWelcomeTips(identity);
	}
	/** One pre-rendered row naming the active harness, shown under "Tips"; empty hides it. */
	setHarnessIdentity(text: string): void {
		this.harnessIdentity = text;
		this.invalidate();
	}
	get tip(): string | undefined {
		this.#nagRoll ??= Math.random();
		this.#tipRoll ??= Math.random();
		if (theme.getSymbolPreset() === "unicode" && this.#nagRoll < 0.1) {
			return "Please use nerdfont 😭.";
		}
		if (this.#selectedTip === undefined) this.#selectedTip = pickWeightedTip(this.#tips, this.#tipRoll);
		return this.#selectedTip;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
		this.#native = undefined;
	}

	/** Update the speculative startup preference; `undefined` delegates to the live settings reader. */
	setReducedMotion(value: boolean | undefined): void {
		this.reduceMotion = value;
		if (isReducedMotionEnabled(value)) this.#stopAnimation();
	}

	/**
	 * A `card` (`omp.welcome`) titled with the app version. The brand column
	 * (`omp.welcome.brand`: greeting, the animated SVG mark, model, provider) sits
	 * beside the info column (`omp.welcome.info`: prompt-sigil keycaps, LSP
	 * servers, recent sessions); the tip of the session closes the card. Roles
	 * carry the look (gradient logo, type scale, column hairline); a "[NEW]" tip
	 * carries a terminal-clocked shimmering tag.
	 */
	describe(_cx: DescribeContext): NativeNode {
		const tip = this.tip;
		if (this.#native && this.#native.tip === tip) return this.#native.node;
		const line = (spans: readonly TspSpan[], role?: string, key?: string): NativeNode =>
			keyed(text(spans, { wrap: "none", truncate: "end", role }), key ?? role ?? "");
		// Centered brand lines are short and fixed; the logo is multi-line art that must never truncate.
		const art = (spans: readonly TspSpan[], role: string): NativeNode =>
			keyed(text(spans, { wrap: "none", role }), role);
		const greeting = this.identity.welcomeGreeting ?? "Welcome back!";
		const brandChildren: NativeNode[] = [
			art([span(greeting, "strong")], "omp.welcome.greeting"),
			node(
				"image",
				{
					blob: welcomeLogoBlob(),
					alt: this.identity.displayName,
					w: 128,
					role: "omp.welcome.logo",
				},
				undefined,
				"logo",
			),
			art([span(plainLine(this.modelName), "accent")], "omp.welcome.model"),
			art([span(plainLine(this.providerName), "muted")], "omp.welcome.provider"),
		];
		if (this.harnessIdentity) {
			brandChildren.push(art([span(plainLine(this.harnessIdentity), "muted")], "omp.welcome.harness"));
		}
		const brand = keyed(col(brandChildren, { align: "center", role: "omp.welcome.brand" }), "brand");
		const section = (key: string, label: string, rows: readonly NativeChild[]): NativeNode =>
			keyed(
				col([line([span(label, "dim")], "omp.welcome.heading"), ...rows], {
					gap: "xs",
					role: `omp.welcome.${key}`,
				}),
				key,
			);
		const shortcut = (key: string, label: string): NativeNode =>
			keyed(row([kbd(key), line([span(label, "muted")])], { gap: "sm" }), label);
		const info: NativeChild[] = [
			line([span(this.version, "dim mono")], "omp.welcome.version"),
			section("tips", "Tips", [
				shortcut("#", "prompt actions"),
				shortcut("/", "commands"),
				shortcut("!", "run bash"),
				shortcut("$", "run python"),
			]),
		];
		if (this.lspServers !== null) {
			const lsp: NativeChild[] = [];
			if (this.lspServers.length === 0) lsp.push(line([span("No LSP servers", "dim")], undefined, "none"));
			for (const server of this.lspServers.slice(0, WELCOME_LSP_SLOTS)) {
				const [symbol, token] =
					server.status === "ready"
						? (["status.enabled", "success"] as const)
						: server.status === "available"
							? (["status.enabled", "dim"] as const)
							: server.status === "connecting"
								? (["status.pending", "muted"] as const)
								: (["status.error", "error"] as const);
				lsp.push(
					keyed(
						row(
							[
								text([span("●", token)], { role: "omp.welcome.lsp-dot", title: server.status, aria: symbol }),
								line([span(server.name)]),
								...server.fileTypes
									.slice(0, 3)
									.map(type => node("badge", { text: type, role: "omp.welcome.lsp-type" }, undefined, type)),
							],
							{ gap: "sm", role: "omp.welcome.lsp-row" },
						),
						server.name,
					),
				);
			}
			info.push(section("lsp", "LSP servers", lsp));
		}
		const recents: NativeChild[] = [];
		if (this.recentSessions.length === 0) recents.push(line([span("No recent sessions", "dim")], undefined, "none"));
		for (const [index, session] of this.recentSessions.slice(0, WELCOME_SESSION_SLOTS).entries()) {
			recents.push(
				keyed(
					row(
						[
							line([span(plainLine(session.name))], "omp.welcome.session"),
							line([span(session.timeAgo, "dim")], "omp.welcome.age"),
						],
						{
							gap: "md",
							justify: "between",
							role: "omp.welcome.recent",
							actions: session.path ? { click: "resume" } : undefined,
							title: session.path ? `Resume ${plainLine(session.name)}` : undefined,
						},
					),
					`s${index}`,
				),
			);
		}
		info.push(section("recents", "Recent sessions", recents));
		const body: NativeChild[] = [
			keyed(
				row([brand, keyed(col(info, { gap: "md", role: "omp.welcome.info" }), "info")], {
					align: "start",
					wrap: true,
					role: "omp.welcome.grid",
				}),
				"grid",
			),
		];
		if (tip) {
			const isNew = NEW_TIP_MARKER.test(tip);
			const tipText = plainLine(expandTipKeys(isNew ? tip.replace(NEW_TIP_MARKER, "") : tip));
			const tipRow: NativeChild[] = [
				node("icon", { name: "lightbulb", role: "omp.welcome.tip-icon" }),
				text(tipText, { wrap: "word", role: "omp.welcome.tip-text" }),
			];
			if (isNew) tipRow.push(node("shimmer", { text: "New", role: "omp.welcome.new" }));
			body.push(node("row", { gap: "sm", align: "start", role: "omp.welcome.tip" }, tipRow, "tip"));
		}
		// No head row or chevron: the card is the hero; the version sits in the info column.
		const described = card({ role: "omp.welcome" }, body);
		this.#native = { tip, node: described };
		return described;
	}
	/** A click on a recent session resumes it. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action" || event.act !== "resume") return;
		const index = Number(/\/s(\d+)$/.exec(event.key)?.[1]);
		const path = this.recentSessions[index]?.path;
		if (path) runTranscriptAction({ act: "resume", path });
	}
	/** The intro keeps the welcome block mutable; settling lets it retire to history. */
	isTranscriptBlockFinalized(): boolean {
		return this.#animTimer == null;
	}

	/**
	 * Play a one-shot intro that sweeps the gradient through every phase
	 * before settling on the resting frame. Safe to call multiple times —
	 * subsequent calls reset and replay.
	 */
	playIntro(requestRender: () => void): void {
		this.#stopAnimation();
		// The intro is a repaint-only gradient sweep; a TSP terminal shows the
		// settled card right away.
		if (isReducedMotionEnabled(this.reduceMotion) || isNativeRendering()) {
			requestRender();
			return;
		}
		this.#requestRender = requestRender;
		this.#animStart = performance.now();
		this.#requestRender();
		this.#animTimer = setInterval(() => {
			const requestCurrentRender = this.#requestRender;
			const elapsed = performance.now() - (this.#animStart ?? 0);
			if (isReducedMotionEnabled(this.reduceMotion) || elapsed >= INTRO_MS) {
				this.#stopAnimation();
				requestCurrentRender?.();
				return;
			}
			requestCurrentRender?.();
		}, INTRO_TICK_MS);
	}

	#stopAnimation(): void {
		if (this.#animTimer != null) {
			clearInterval(this.#animTimer);
			this.#animTimer = null;
		}
		this.#animStart = null;
		this.#requestRender = null;
		// The settled (resting) frame differs from the last intro frame.
		this.invalidate();
	}

	/**
	 * Redirect a running intro's render callback to a new target when a host
	 * remounts this component mid-animation.
	 * Returns true while the intro is still animating; false = no-op (settled).
	 */
	retargetIntro(requestRender: () => void): boolean {
		if (this.#animTimer == null) return false;
		this.#requestRender = requestRender;
		return true;
	}

	/** Stop the intro immediately and settle on the resting frame. Safe when idle. */
	stopIntro(): void {
		this.#stopAnimation();
	}

	/** Update the version embedded in the welcome border title. */
	setVersion(version: string): void {
		this.version = version;
		this.invalidate();
	}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
		this.invalidate();
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
		this.invalidate();
	}

	setLspServers(servers: LspServerInfo[] | null): void {
		this.lspServers = servers;
		this.invalidate();
	}

	render(termWidth: number): readonly string[] {
		const animating = this.#animStart != null;
		if (!animating && this.#cachedLines && this.#cachedWidth === termWidth) {
			return this.#cachedLines;
		}
		const lines = this.#renderLines(termWidth);
		if (animating) {
			this.#cachedLines = undefined;
			this.#cachedWidth = -1;
		} else {
			this.#cachedLines = lines;
			this.#cachedWidth = termWidth;
		}
		return lines;
	}

	#renderLines(termWidth: number): string[] {
		const greeting = this.identity.welcomeGreeting ?? "Welcome back!";
		// Box dimensions - responsive with max width and small-terminal support
		const maxWidth = 100;
		const boxWidth = Math.min(maxWidth, Math.max(0, termWidth - 2));
		if (boxWidth < 4) {
			return [];
		}
		const dualContentWidth = boxWidth - 3; // 3 = │ + │ + │
		const logoWidth = Math.max(...this.identity.logoArt.map(line => visibleWidth(line)));
		const preferredLeftCol = Math.max(26, logoWidth + 2);
		const minLeftCol = Math.max(12, logoWidth);
		const minRightCol = 20;
		// Dynamic model/provider labels are truncated inside the fixed column.
		// Letting them influence the responsive breakpoint changes the box height
		// when authoritative session data replaces the empty prepaint labels.
		const leftMinContentWidth = Math.max(minLeftCol, visibleWidth(greeting));
		const desiredLeftCol = Math.max(
			Math.min(preferredLeftCol, Math.max(minLeftCol, Math.floor(dualContentWidth * 0.35))),
			leftMinContentWidth,
		);
		const dualLeftCol =
			dualContentWidth >= minRightCol + 1
				? Math.min(desiredLeftCol, dualContentWidth - minRightCol)
				: Math.max(1, dualContentWidth - 1);
		const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
		const showRightColumn = dualLeftCol >= leftMinContentWidth && dualRightCol >= minRightCol;
		const leftCol = showRightColumn ? dualLeftCol : boxWidth - 2;
		const rightCol = showRightColumn ? dualRightCol : 0;

		// Logo: pick a frame from the intro animation if active, else the resting frame.
		const logoColored = this.#currentLogoFrame();

		// Left column - centered content
		const leftLines = [
			"",
			this.#centerText(theme.bold(greeting), leftCol),
			"",
			...logoColored.map(l => this.#centerText(l, leftCol)),
			"",
			this.#centerText(theme.fg("muted", this.modelName), leftCol),
			this.#centerText(theme.fg("borderMuted", this.providerName), leftCol),
		];

		// Right column separator
		const separatorWidth = Math.max(0, rightCol - 2); // padding on each side
		const separator = ` ${theme.fg("dim", theme.boxRound.horizontal.repeat(separatorWidth))}`;

		// Recent sessions content
		const sessionLines: string[] = [];
		if (this.recentSessions.length === 0) {
			sessionLines.push(` ${theme.fg("dim", "No recent sessions")}`);
		} else {
			// Reserve width for the bullet prefix (" • ") and the trailing " (timeAgo)"
			// so the relative time is never the part that gets truncated. The name
			// absorbs whatever space is left.
			const bulletPrefix = ` ${theme.md.bullet} `;
			const prefixWidth = visibleWidth(bulletPrefix);
			for (const session of this.recentSessions.slice(0, WELCOME_SESSION_SLOTS)) {
				const timeSuffixRaw = ` (${session.timeAgo})`;
				const timeWidth = visibleWidth(timeSuffixRaw);
				const nameBudget = Math.max(1, rightCol - prefixWidth - timeWidth);
				const nameVis = visibleWidth(session.name);
				const name = nameVis > nameBudget ? truncateToWidth(session.name, nameBudget) : session.name;
				sessionLines.push(
					`${theme.fg("dim", bulletPrefix)}${theme.fg("muted", name)}${theme.fg("dim", timeSuffixRaw)}`,
				);
			}
		}
		// Pad to the fixed slot count so the box height doesn't depend on session count.
		while (sessionLines.length < WELCOME_SESSION_SLOTS) {
			sessionLines.push("");
		}

		// Right column
		const harnessIdentity = this.harnessIdentity;
		const harnessLines = harnessIdentity ? wrapTextWithAnsi(` ${harnessIdentity}`, rightCol) : [];
		const rightLines = [
			` ${theme.bold(theme.fg("accent", "Tips"))}`,
			...harnessLines,
			` ${theme.fg("dim", "#")}${theme.fg("muted", " for prompt actions")}`,
			` ${theme.fg("dim", "/")}${theme.fg("muted", " for commands")}`,
			` ${theme.fg("dim", "!")}${theme.fg("muted", " to run bash")}`,
			` ${theme.fg("dim", "$")}${theme.fg("muted", " to run python")}`,
			...this.#renderLspSection(separator),
			separator,
			` ${theme.bold(theme.fg("accent", "Recent sessions"))}`,
			...sessionLines,
			"",
		];

		// Border characters (dim)
		const hChar = theme.boxRound.horizontal;
		const h = theme.fg("dim", hChar);
		const v = theme.fg("dim", theme.boxRound.vertical);
		const tl = theme.fg("dim", theme.boxRound.topLeft);
		const tr = theme.fg("dim", theme.boxRound.topRight);
		const bl = theme.fg("dim", theme.boxRound.bottomLeft);
		const br = theme.fg("dim", theme.boxRound.bottomRight);

		const lines: string[] = [];

		// Top border with embedded title
		const title = ` ${this.identity.welcomeTitle} v${this.version} `;
		const titlePrefixRaw = hChar.repeat(3);
		const titleStyled = theme.fg("dim", titlePrefixRaw) + theme.fg("muted", title);
		const titleVisLen = visibleWidth(titlePrefixRaw) + visibleWidth(title);
		const titleSpace = boxWidth - 2;
		if (titleVisLen >= titleSpace) {
			lines.push(tl + truncateToWidth(titleStyled, titleSpace) + tr);
		} else {
			const afterTitle = titleSpace - titleVisLen;
			lines.push(tl + titleStyled + theme.fg("dim", hChar.repeat(afterTitle)) + tr);
		}

		// Content rows
		const maxRows = showRightColumn ? Math.max(leftLines.length, rightLines.length) : leftLines.length;
		for (let i = 0; i < maxRows; i++) {
			const left = this.#fitToWidth(leftLines[i] ?? "", leftCol);
			if (showRightColumn) {
				const right = this.#fitToWidth(rightLines[i] ?? "", rightCol);
				lines.push(v + left + v + right + v);
			} else {
				lines.push(v + left + v);
			}
		}
		// Bottom border
		if (showRightColumn) {
			lines.push(bl + h.repeat(leftCol) + theme.fg("dim", theme.boxRound.teeUp) + h.repeat(rightCol) + br);
		} else {
			lines.push(bl + h.repeat(leftCol) + br);
		}

		// Randomly picked tip, rendered directly beneath the box.
		lines.push(...this.#renderTip(boxWidth));

		return lines;
	}

	/** Right-column LSP rows padded to a fixed height; empty when LSP is disabled. */
	#renderLspSection(separator: string): string[] {
		if (this.lspServers === null) return [];
		const lspLines: string[] = [];
		if (this.lspServers.length === 0) {
			lspLines.push(` ${theme.fg("dim", "No LSP servers")}`);
		} else {
			for (const server of this.lspServers.slice(0, WELCOME_LSP_SLOTS)) {
				const icon =
					server.status === "ready"
						? theme.styledSymbol("status.enabled", "success")
						: server.status === "available"
							? theme.styledSymbol("status.enabled", "dim")
							: server.status === "connecting"
								? theme.styledSymbol("status.pending", "muted")
								: theme.styledSymbol("status.error", "error");
				const exts = server.fileTypes.slice(0, 3).join(" ");
				lspLines.push(` ${icon} ${theme.fg("muted", server.name)} ${theme.fg("dim", exts)}`);
			}
		}
		// Pad to the fixed slot count so the box height doesn't depend on server count.
		while (lspLines.length < WELCOME_LSP_SLOTS) {
			lspLines.push("");
		}
		return [separator, ` ${theme.bold(theme.fg("accent", "LSP Servers"))}`, ...lspLines];
	}

	/**
	 * Render the per-instance tip line: the `customMessageLabel`-themed `Tip:`
	 * label followed by a `muted` body, the whole line italicized. Returns `[]`
	 * when no tip is available or the box is too narrow to be useful.
	 */
	#renderTip(boxWidth: number): string[] {
		const tip = this.tip;
		if (!tip) return [];
		// A trailing "[NEW]" marker paints an animated rainbow "NEW!" tag. Derive
		// its hue phase from wall-clock time so it shimmers across the welcome
		// intro's re-render frames, then settles into a still rainbow once the box
		// caches its resting frame. Non-"[NEW]" tips ignore the phase entirely.
		const phase =
			NEW_TIP_MARKER.test(tip) && !isReducedMotionEnabled(this.reduceMotion)
				? performance.now() / NEW_GLOW_PERIOD_MS
				: 0;
		return renderWelcomeTip(tip, boxWidth, phase);
	}

	/** Center text within a given width */
	#centerText(text: string, width: number): string {
		const visLen = visibleWidth(text);
		if (visLen >= width) {
			return truncateToWidth(text, width);
		}
		const leftPad = Math.floor((width - visLen) / 2);
		const rightPad = width - visLen - leftPad;
		return padding(leftPad) + text + padding(rightPad);
	}

	/** Fit string to exact width with ANSI-aware truncation/padding */
	#fitToWidth(str: string, width: number): string {
		const visLen = visibleWidth(str);
		if (visLen > width) {
			const ellipsis = "…";
			const ellipsisWidth = visibleWidth(ellipsis);
			const maxWidth = Math.max(0, width - ellipsisWidth);
			let truncated = "";
			let currentWidth = 0;
			let inEscape = false;
			for (const char of str) {
				if (char === "\x1b") inEscape = true;
				if (inEscape) {
					truncated += char;
					if (char === "m") inEscape = false;
				} else if (currentWidth < maxWidth) {
					truncated += char;
					currentWidth++;
				}
			}
			return `${truncated}${ellipsis}`;
		}
		return str + padding(width - visLen);
	}

	/** Pick the logo frame for the current intro phase, or the resting frame. */
	#currentLogoFrame(): readonly string[] {
		const appearance = this.appearance ?? (theme.isLight ? "light" : "dark");
		const mode = theme.getColorMode();
		const key = `${this.identity.id}:${appearance}:${mode}`;
		let restFrame = this.#restFrames.get(key);
		if (!restFrame) {
			restFrame = gradientLogo(
				this.identity.logoArt,
				0,
				undefined,
				this.identity.gradientPalettes[appearance],
				mode,
			);
			this.#restFrames.set(key, restFrame);
		}
		if (this.#animStart == null) return restFrame;
		const elapsed = performance.now() - this.#animStart;
		if (elapsed >= INTRO_MS) return restFrame;
		return introLogoFrame(
			elapsed / INTRO_MS,
			this.identity.logoArt,
			this.identity.gradientPalettes[appearance],
			mode,
		);
	}
}

/**
 * {@link PI_LOGO} as SVG for the native welcome, on the terminal's grid: a
 * cell is 3×6 units, so the 12×5-cell art spans 36×30 from (14,16). The left
 * leg's `▒▒` tail is a half-opacity cell; the gradient spans the whole art in
 * user space (per-axis normalized, like {@link gradientLogo}) so the tail
 * keeps its colour. Tern mounts SVG blobs as live DOM, so the classes are
 * animation hooks: `trace` (the outline, `pathLength=1` for a draw-on), `mark`
 * (the fills) and the gradient stops `s0`–`s2`.
 */
const WELCOME_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 12 44 38">
<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" gradientTransform="matrix(36 0 0 30 14 16)" x1="0" y1="0" x2="1" y2="1">
<stop class="s0" offset="0" stop-color="#ed4abf"/><stop class="s1" offset=".5" stop-color="#9b4dff"/><stop class="s2" offset="1" stop-color="#5ad8e6"/>
</linearGradient></defs>
<path class="mark" fill="url(#g)" d="M14 16h36v6h-9v24h-6V22h-6v12h-6V22h-9z"/>
<rect class="mark" fill="url(#g)" opacity=".5" x="23" y="34" width="6" height="6"/>
<path class="trace" fill="none" stroke="url(#g)" stroke-width="1" stroke-linejoin="round" pathLength="1" d="M14 16h36v6h-9v24h-6V22h-6v18h-6V22h-9z"/>
</svg>`;

let welcomeLogoId: string | undefined;

/** The registered blob id of {@link WELCOME_LOGO_SVG}. */
function welcomeLogoBlob(): string {
	welcomeLogoId ??= registerNativeBlob(new TextEncoder().encode(WELCOME_LOGO_SVG), "image/svg+xml");
	return welcomeLogoId;
}

/** Block-grid brand mark shared by the welcome and setup surfaces. */
export const PI_LOGO = ["████████████", "   ██  ██   ", "   ██  ██   ", "   ▒▒  ██   ", "       ██   "];

/** The block-grid brand mark as accent lines; `shimmer` declares the terminal-clocked shine sweep. */
export function logoNode(lines: readonly string[], shimmer: boolean): NativeNode {
	return col(
		lines.map(line =>
			text([span(line, "accent", shimmer ? { fx: "shimmer" } : undefined)], {
				wrap: "none",
			}),
		),
		{ align: "center", role: "omp.setup.logo" },
	);
}

/** Half-width of the shine highlight band, expressed in gradient-t units. */
const SHINE_HALF_WIDTH = 0.18;

const PALETTE_OKLCH_CACHE = new WeakMap<GradientPalette, readonly OKLCH[]>();

function paletteOklch(palette: GradientPalette): readonly OKLCH[] {
	const cached = PALETTE_OKLCH_CACHE.get(palette);
	if (cached) return cached;
	const resolved = palette.stops.map(stop => hexToOklch(rgbToHex({ r: stop[0], g: stop[1], b: stop[2] })));
	PALETTE_OKLCH_CACHE.set(palette, resolved);
	return resolved;
}

function interpolatePalette(t: number, palette: GradientPalette): OKLCH {
	const stops = paletteOklch(palette);
	const position = Math.max(0, Math.min(1, t)) * (stops.length - 1);
	const index = Math.min(stops.length - 2, Math.floor(position));
	const fraction = position - index;
	const start = stops[index]!;
	const end = stops[index + 1]!;
	let hueDelta = end.h - start.h;
	if (hueDelta > 180) hueDelta -= 360;
	if (hueDelta < -180) hueDelta += 360;
	return {
		l: start.l + (end.l - start.l) * fraction,
		c: start.c + (end.c - start.c) * fraction,
		h: (start.h + hueDelta * fraction + 360) % 360,
	};
}

function gradientColor(t: number, shine: ShineConfig | undefined, palette: GradientPalette): string {
	const color = interpolatePalette(t, palette);
	if (shine && shine.strength > 0) {
		const intensity = Math.max(0, 1 - Math.abs(t - shine.pos) / SHINE_HALF_WIDTH) * shine.strength;
		if (intensity > 0) {
			color.l += (1 - color.l) * intensity;
			color.c *= 1 - intensity;
		}
	}
	return oklchToHex(color);
}

export interface ShineConfig {
	/** Overall opacity of the shine overlay, in [0, 1]. */
	strength: number;
	/** Center of the shine band along the horizontal wordmark, in [0, 1]. */
	pos: number;
}

/**
 * Resolve the gradient SGR foreground escape for a normalized horizontal
 * position `t` (0..1), compositing the optional sliding shine highlight.
 * The truecolor path uses OKLCH interpolation with the active product
 * palette; indexed modes use the frozen palette ramps.
 * Shared by {@link gradientLogo} and the setup splash so both encode identical
 * truecolor, indexed, basic-color, or plain output.
 */
export function gradientEscape(
	t: number,
	shine?: ShineConfig,
	palette: GradientPalette = OMP_PRODUCT_IDENTITY.gradientPalettes.dark,
	mode: ColorMode = theme.getColorMode(),
): string {
	if (mode === "none") return "";
	const shineStrength = shine && shine.strength > 0 ? shine.strength : 0;
	const shinePos = shine ? shine.pos : 0;
	if (mode === "truecolor") return colorToAnsi(gradientColor(t, shine, palette), mode);
	const ramp = mode === "16color" ? palette.ramp16 : palette.ramp256;
	const normalized = Math.max(0, Math.min(1, t));
	let index = Math.min(ramp.length - 1, Math.max(0, Math.floor(normalized * (ramp.length - 1) + 0.5)));
	if (shineStrength > 0) {
		const dist = Math.abs(normalized - shinePos);
		const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
		if (intensity > 0.5) index = ramp.length - 1;
	}
	const color = ramp[index];
	return mode === "16color" ? `\x1b[${color}m` : `\x1b[38;5;${color}m`;
}

/**
 * Apply a multi-stop horizontal gradient (left → right) plus an optional
 * sliding shine band across the wordmark. `phase` (0..1) shifts the gradient
 * along the row, wrapping at 1. When `shine` is provided, a soft white
 * highlight is composited on top, centered at `shine.pos`.
 */
export function gradientLogo(
	lines: readonly string[],
	phase = 0,
	shine?: ShineConfig,
	palette: GradientPalette = OMP_PRODUCT_IDENTITY.gradientPalettes.dark,
	mode: ColorMode = theme.getColorMode(),
): string[] {
	if (mode === "none") return [...lines];
	const cols = Math.max(...lines.map(line => line.length));
	const xSpan = Math.max(1, cols - 1);
	const normalizedPhase = ((phase % 1) + 1) % 1;
	return lines.map(line => {
		let result = "";
		for (let x = 0; x < line.length; x++) {
			const char = line[x];
			if (char === " ") {
				result += char;
				continue;
			}
			const base = x / xSpan;
			const t = normalizedPhase === 0 ? base : (base + normalizedPhase) % 1;
			result += paintAnsi(gradientEscape(t, shine, palette, mode), char);
		}
		return `\x1b[1m${result}\x1b[22m`;
	});
}

/** Total length of the intro animation. */
const INTRO_MS = 3000;
/** Render cadence during the intro (~30fps). */
const INTRO_TICK_MS = 33;
/** Number of full gradient rotations the sweep performs before settling. */
const INTRO_SWEEPS = 2.5;
/** Number of times the shine highlight crosses the diagonal across the intro. */
const INTRO_SHINE_TRAVERSALS = 3;

/**
 * Logo frame for a normalized intro progress in [0, 1).
 *
 * Ease-out cubic so the spin decelerates into the resting state. The gradient
 * sweeps backward through INTRO_SWEEPS full rotations (`eased == 1` → phase =
 * 0 = resting frame) while the shine traverses the diagonal at a steady pace,
 * decoupled from the gradient phase so the two layers parallax; its strength
 * fades with the same ease-out curve so the highlight is gone by the resting
 * frame.
 */
function introLogoFrame(
	progress: number,
	art: readonly string[] = OMP_PRODUCT_IDENTITY.logoArt,
	palette: GradientPalette = OMP_PRODUCT_IDENTITY.gradientPalettes.dark,
	mode: ColorMode = theme.getColorMode(),
): string[] {
	const eased = 1 - (1 - progress) ** 3;
	const phase = ((((1 - eased) * INTRO_SWEEPS) % 1) + 1) % 1;
	const shinePos = (((progress * INTRO_SHINE_TRAVERSALS) % 1) + 1) % 1;
	const shineStrength = (1 - eased) ** 1.5;
	return gradientLogo(art, phase, { strength: shineStrength, pos: shinePos }, palette, mode);
}
