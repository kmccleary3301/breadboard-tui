import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Ellipsis, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import type { HarnessSnapshot } from "@oh-my-pi/pi-tui/status-line/types";
import { thinkingLevelGlyph } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeStatusText } from "@oh-my-pi/pi-tui/chrome/shared";
import { type ThemeColor, theme } from "@oh-my-pi/pi-tui/theme/theme";
import { type BreadboardFieldSettings, resolveBreadboardFields } from "./breadboard-fields";
import { getContextUsageLevel, getContextUsageThemeColor } from "@oh-my-pi/pi-tui/chrome/context-thresholds";

export interface BreadboardComposerActivity {
	readonly kind: "working" | "tool" | "approval" | "cancelling" | "error";
	readonly label: string;
}

export interface BreadboardStatusSnapshot {
	readonly modelName: string;
	/** Display label, already resolved to the active workspace/worktree. */
	readonly workspace: string;
	readonly workspacePath?: string;
	readonly sessionName?: string | null;
	readonly harness?: HarnessSnapshot | null;
	readonly branch?: string | null;
	readonly effort?: ThinkingLevel | null;
	readonly spend?: {
		readonly sessionUsd: number | null;
		readonly turnUsd: number | null;
		readonly estimated: boolean;
	} | null;
	readonly activity?: BreadboardComposerActivity | null;
	readonly elapsedMs?: number | null;
	/** Running background jobs holding an open turn that is no longer streaming. */
	readonly backgroundWait?: number;
	readonly context?: { readonly tokens: number; readonly capacity: number } | null;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly vim?: string;
}

export interface BreadboardStatusRows {
	readonly top: string;
	readonly bottom: string;
}

export function isBreadboardPreset(preset: string | undefined): boolean {
	return preset === "bb-balanced" || preset === "bb-quiet" || preset === "bb-detailed";
}

function clip(text: string, width: number): string {
	return truncateToWidth(text, width, theme.getSymbolPreset() === "ascii" ? Ellipsis.Ascii : Ellipsis.Unicode);
}

function iconLabel(icon: string, label: string): string {
	return icon ? `${icon} ${label}` : label;
}

function elapsedLabel(elapsedMs: number): string {
	return elapsedMs < 60_000 ? `${Math.floor(elapsedMs / 1000)}s` : formatDuration(elapsedMs);
}

function backgroundWaitLabel(jobs: number): string {
	return jobs === 1 ? "Waiting on 1 background job" : `Waiting on ${jobs} background jobs`;
}

export function renderBreadboardActivity(
	activity: BreadboardComposerActivity | null | undefined,
	elapsedMs: number | null | undefined,
	width: number,
	backgroundWait = 0,
): string {
	// A turn held open only by background jobs is not working: the composer takes
	// input. Operator states (approval, cancelling, error, running tools) keep priority.
	const waiting = backgroundWait > 0 && (!activity || activity.kind === "working");
	if (!activity && elapsedMs == null && !waiting) return "";
	const kind = activity?.kind ?? "working";
	const color = kind === "error" ? "error" : kind === "approval" || kind === "cancelling" ? "warning" : "muted";
	const icon = kind === "error" ? theme.status.error : kind === "approval" ? theme.status.warning : "";
	const label = waiting ? backgroundWaitLabel(backgroundWait) : sanitizeStatusText(activity?.label ?? "Working");
	const elapsed =
		elapsedMs == null || elapsedMs < 1_000 || kind === "approval" || kind === "error"
			? ""
			: ` ${iconLabel(theme.icon.time, elapsedLabel(elapsedMs))}`;
	return theme.fg(color, clip(`${iconLabel(icon, label)}${elapsed}`, width));
}

export function renderBreadboardPolicy(harness: HarnessSnapshot | null | undefined): string {
	if (!harness?.verifiedIdentity || harness.verifiedIdentity.lockHash !== harness.lockHash) return "";
	const values = harness.lock?.effective_values;
	if (!Array.isArray(values)) return "";
	const entry = values.find(
		value =>
			typeof value === "object" &&
			value !== null &&
			"path" in value &&
			value.path === "permissions.options.default_response",
	);
	const response = entry && typeof entry === "object" && "value" in entry ? entry.value : undefined;
	if (response !== "ask" && response !== "allow" && response !== "deny") return "";
	return theme.fg(response === "allow" ? "warning" : "muted", `Default: ${response}`);
}

interface StatusPart {
	readonly text: string;
	readonly width: number;
	readonly minWidth: number;
	readonly priority: number;
	readonly order: number;
	readonly side: "left" | "right";
	readonly preferredRow: "top" | "bottom";
}

function statusParts(
	snapshot: BreadboardStatusSnapshot,
	preset: string,
	overrides?: Partial<BreadboardFieldSettings>,
): StatusPart[] {
	const fields = resolveBreadboardFields(preset, overrides);
	const icons = theme.icon;
	const parts: StatusPart[] = [];
	const add = (
		text: string,
		priority: number,
		side: StatusPart["side"],
		preferredRow: StatusPart["preferredRow"],
		minWidth = visibleWidth(text),
	) => {
		if (text)
			parts.push({ text, width: visibleWidth(text), minWidth, priority, side, preferredRow, order: parts.length });
	};
	const named = (
		icon: string,
		label: string,
		color: ThemeColor,
		priority: number,
		side: StatusPart["side"],
		row: StatusPart["preferredRow"],
		max: number,
		min: number,
	) => {
		const clean = sanitizeStatusText(label);
		if (!clean) return;
		const prefix = icon ? visibleWidth(icon) + 1 : 0;
		add(
			theme.fg(color, iconLabel(icon, clip(clean, max))),
			priority,
			side,
			row,
			prefix + Math.min(min, visibleWidth(clean)),
		);
	};
	const folder = fields.folder === "full" ? (snapshot.workspacePath ?? snapshot.workspace) : snapshot.workspace;
	if (fields.folder !== "hidden")
		named(
			icons.folder,
			folder,
			"statusLinePath",
			90,
			"left",
			"top",
			fields.folder === "full" ? visibleWidth(folder) : 28,
			8,
		);
	if (fields.branch === "shown" && snapshot.branch)
		named(icons.branch, snapshot.branch, "muted", 50, "left", "top", 22, 8);
	if (fields.session === "shown" && snapshot.sessionName)
		named(icons.session, snapshot.sessionName, "accent", 70, "right", "top", 36, 12);
	if (snapshot.vim) named("", snapshot.vim, "accent", 105, "left", "bottom", 12, 6);
	const effort =
		fields.effort === "shown" && snapshot.effort != null ? thinkingLevelGlyph(snapshot.effort, theme) : "";
	if (fields.model === "shown")
		named(effort || icons.model, snapshot.modelName, "statusLineModel", 95, "left", "bottom", 28, 10);
	else if (effort) add(theme.fg("statusLineModel", effort), 94, "left", "bottom");
	if (fields.harness === "shown" && snapshot.harness)
		named(
			icons.package,
			snapshot.harness.name.replace(/\.(?:harness|ya?ml)$/u, ""),
			"muted",
			40,
			"left",
			"bottom",
			24,
			8,
		);
	const context = snapshot.context;
	if (fields.context !== "hidden" && context && context.capacity > 0 && context.tokens >= 0) {
		const percent = (context.tokens / context.capacity) * 100;
		if (fields.context !== "pressure" || percent >= 75) {
			const amount = percent > 0 && percent < 1 ? "<1" : `${Math.round(percent)}`;
			const value =
				fields.context === "tokens"
					? `~${formatNumber(context.tokens)}/${formatNumber(context.capacity)}`
					: `~${amount}%`;
			add(
				theme.fg(
					getContextUsageThemeColor(getContextUsageLevel(percent, context.capacity)),
					iconLabel(icons.context, value),
				),
				percent >= 90 ? 108 : percent >= 75 ? 100 : 80,
				"right",
				"bottom",
			);
		}
	}
	if (fields.spend !== "hidden" && snapshot.spend) {
		const amount = fields.spend === "turn" ? snapshot.spend.turnUsd : snapshot.spend.sessionUsd;
		if (amount != null && Number.isFinite(amount) && amount >= 0) {
			const value = `${snapshot.spend.estimated ? "~" : ""}${amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2)}`;
			add(theme.fg("statusLineCost", iconLabel(icons.cost || "$", value)), 75, "right", "bottom");
		}
	}
	if (preset === "bb-detailed") {
		if (snapshot.inputTokens !== undefined && snapshot.inputTokens > 0)
			add(theme.fg("muted", iconLabel(icons.input, formatNumber(snapshot.inputTokens))), 20, "right", "bottom");
		if (snapshot.outputTokens !== undefined && snapshot.outputTokens > 0)
			add(theme.fg("muted", iconLabel(icons.output, formatNumber(snapshot.outputTokens))), 20, "right", "bottom");
	}
	const activity = snapshot.activity;
	const critical = activity?.kind === "approval" || activity?.kind === "error" || activity?.kind === "cancelling";
	if (critical || fields.activity === "shown") {
		const text = renderBreadboardActivity(
			activity,
			activity ? null : snapshot.elapsedMs == null ? null : 0,
			36,
			snapshot.backgroundWait,
		);
		add(
			text,
			critical ? 120 : 85,
			"right",
			"bottom",
			critical ? visibleWidth(text) : Math.min(12, visibleWidth(text)),
		);
	}
	if (
		fields.elapsed === "shown" &&
		snapshot.elapsedMs != null &&
		snapshot.elapsedMs >= 1_000 &&
		activity?.kind !== "approval" &&
		activity?.kind !== "error"
	) {
		add(theme.fg("muted", iconLabel(icons.time, elapsedLabel(snapshot.elapsedMs))), 30, "right", "bottom");
	}
	return parts;
}

function rowWidth(parts: readonly StatusPart[]): number {
	return parts.reduce((sum, part) => sum + part.width, 0) + Math.max(0, parts.length - 1) * 3 + (parts.length ? 2 : 0);
}

/** Names yield characters before any field yields its slot. Numeric fields remain whole. */
function fitRow(parts: readonly StatusPart[], width: number): StatusPart[] | null {
	let excess = rowWidth(parts) - width;
	if (excess <= 0) return [...parts];
	const fitted = [...parts];
	const flexible = parts.filter(part => part.width > part.minWidth).sort((a, b) => a.priority - b.priority);
	for (const part of flexible) {
		const target = Math.max(part.minWidth, part.width - excess);
		const text = clip(part.text, target);
		const clippedWidth = visibleWidth(text);
		fitted[fitted.indexOf(part)] = { ...part, text, width: clippedWidth };
		excess -= part.width - clippedWidth;
		if (excess <= 0) return fitted;
	}
	return null;
}

function renderRow(parts: readonly StatusPart[], width: number, rule: boolean): string {
	if (!parts.length || width < 1) return "";
	const ordered = [...parts].sort((a, b) => a.order - b.order);
	const separator = theme.fg("dim", theme.getSymbolPreset() === "ascii" ? " | " : " · ");
	const left = ordered
		.filter(part => part.side === "left")
		.map(part => part.text)
		.join(separator);
	const right = ordered
		.filter(part => part.side === "right")
		.map(part => part.text)
		.join(separator);
	if (!left || !right) {
		const content = ` ${left || right} `;
		const remaining = Math.max(0, width - visibleWidth(content));
		const fill = rule ? theme.fg("dim", theme.boxRound.horizontal.repeat(remaining)) : " ".repeat(remaining);
		return clip(left ? content + fill : fill + content, width);
	}
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 4);
	const fill = rule ? theme.fg("dim", theme.boxRound.horizontal.repeat(gap)) : " ".repeat(gap);
	return clip(` ${left} ${fill} ${right} `, width);
}

/** Wide bars stay on one edge; constrained bars pack higher-priority fields first across both edges. */
export function renderBreadboardStatusRows(
	snapshot: BreadboardStatusSnapshot,
	preset: string,
	width: number,
	layout: "box" | "band" | "plain-right",
	fields?: Partial<BreadboardFieldSettings>,
): BreadboardStatusRows {
	if (width < 1) return { top: "", bottom: "" };
	const parts = statusParts(snapshot, preset, fields);
	if (rowWidth(parts) <= width) return { top: renderRow(parts, width, layout === "box"), bottom: "" };
	const rows: { top: StatusPart[]; bottom: StatusPart[] } = { top: [], bottom: [] };
	for (const part of [...parts].sort((a, b) => b.priority - a.priority || a.order - b.order)) {
		const preferred = part.preferredRow;
		const alternate = preferred === "top" ? "bottom" : "top";
		const fitted = fitRow([...rows[preferred], part], width);
		if (fitted) rows[preferred] = fitted;
		else {
			const other = fitRow([...rows[alternate], part], width);
			if (other) rows[alternate] = other;
			else if (!rows.top.length && !rows.bottom.length)
				rows.top.push({ ...part, text: clip(part.text, Math.max(1, width - 2)), width: Math.max(1, width - 2) });
		}
	}
	// Reclaim top-edge space progressively, not only at the all-fields-fit breakpoint.
	for (const part of [...rows.bottom].sort((a, b) => b.priority - a.priority || a.order - b.order)) {
		const original = parts[part.order]!;
		const promoted = fitRow([...rows.top, original], width);
		if (!promoted) continue;
		rows.top = promoted;
		rows.bottom = rows.bottom.filter(candidate => candidate.order !== part.order);
	}
	// Avoid an empty top edge when only runtime fields are configured.
	if (!rows.top.length) return { top: renderRow(rows.bottom, width, layout === "box"), bottom: "" };
	return { top: renderRow(rows.top, width, layout === "box"), bottom: renderRow(rows.bottom, width, false) };
}

/** Detached shapes and legacy segment consumers have one row; they use the same field priorities. */
export function renderBreadboardStatusLine(
	snapshot: BreadboardStatusSnapshot,
	preset: string,
	width: number,
	layout: "box" | "band" | "plain-full" | "plain-left" | "plain-right",
	fields?: Partial<BreadboardFieldSettings>,
): string {
	if (width < 1) return "";
	const parts = statusParts(snapshot, preset, fields);
	let selected: StatusPart[] = [];
	for (const part of [...parts].sort((a, b) => b.priority - a.priority || a.order - b.order)) {
		const fitted = fitRow([...selected, part], width);
		if (fitted) selected = fitted;
		else if (!selected.length)
			selected.push({ ...part, text: clip(part.text, Math.max(1, width - 2)), width: Math.max(1, width - 2) });
	}
	return renderRow(selected, width, layout === "box");
}
