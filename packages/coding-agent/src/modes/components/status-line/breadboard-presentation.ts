import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { lockValue, longRunBudgets } from "../../../breadboard/harness-lock-view";
import type { HarnessSnapshot } from "../../../breadboard/harness-port";
import { sanitizeStatusText } from "../../shared";
import { theme } from "../../theme/theme";
import { getPreset } from "./presets";
import type { BreadboardComposerActivity, StatusLinePreset } from "./types";

export interface BreadboardStatusSnapshot {
	readonly modelName: string;
	/** Display label, already resolved to the active workspace/worktree. */
	readonly workspace: string;
	readonly harness?: HarnessSnapshot | null;
	readonly branch?: string | null;
	readonly activity?: BreadboardComposerActivity | null;
	readonly elapsedMs?: number | null;
	readonly context?: { readonly tokens: number; readonly capacity: number } | null;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly vim?: string;
}

export function isBreadboardPreset(preset: StatusLinePreset | undefined): boolean {
	return preset === "bb-balanced" || preset === "bb-quiet" || preset === "bb-detailed";
}

export function renderBreadboardActivity(
	activity: BreadboardComposerActivity | null | undefined,
	elapsedMs: number | null | undefined,
	width: number,
): string {
	if (!activity && elapsedMs == null) return "";
	const kind = activity?.kind ?? "working";
	const color = kind === "error" ? "error" : kind === "approval" || kind === "cancelling" ? "warning" : "muted";
	const icon = kind === "error" ? theme.status.error : kind === "approval" ? theme.status.warning : "";
	const label = sanitizeStatusText(activity?.label ?? "Working");
	const elapsed =
		elapsedMs == null || kind === "approval" || kind === "error" ? "" : ` ${Math.floor(elapsedMs / 1000)}s`;
	return theme.fg(color, truncateToWidth(`${icon ? `${icon} ` : ""}${label}${elapsed}`, width));
}

export function renderBreadboardPolicy(harness: HarnessSnapshot | null | undefined): string {
	if (!harness?.verifiedIdentity || harness.verifiedIdentity.lockHash !== harness.lockHash) return "";
	const response = lockValue(harness.lock, "permissions.options.default_response")?.value;
	if (response !== "ask" && response !== "allow" && response !== "deny") return "";
	return theme.fg(response === "allow" ? "warning" : "muted", `Default: ${response}`);
}

interface StatusPart {
	readonly text: string;
	readonly priority: number;
	readonly side: "left" | "right";
}

/** Shared by the real composer and metadata-only setup; never constructs a coding session. */
export function renderBreadboardStatusLine(
	snapshot: BreadboardStatusSnapshot,
	preset: StatusLinePreset,
	width: number,
	layout: "box" | "band" | "plain-full" | "plain-left" | "plain-right",
): string {
	if (width < 1) return "";
	const options = getPreset(preset).segmentOptions;
	const parts: StatusPart[] = [];
	const add = (text: string, priority: number, side: StatusPart["side"] = "left") => {
		if (text) parts.push({ text, priority, side });
	};
	const iconLabel = (icon: string, label: string) => `${icon ? `${icon} ` : ""}${label}`;
	const clipped = (text: string, max: number) => truncateToWidth(sanitizeStatusText(text), max);
	const activity = renderBreadboardActivity(
		snapshot.activity,
		snapshot.elapsedMs,
		Math.min(36, Math.max(1, width - 2)),
	);
	add(activity, 100);
	if (snapshot.vim) add(theme.fg("accent", clipped(snapshot.vim, 12)), 95);
	add(theme.fg("statusLineModel", iconLabel(theme.icon.model, clipped(snapshot.modelName, 28))), 90);
	const harness = snapshot.harness;
	if (harness && preset !== "bb-quiet") {
		const name =
			options?.harness?.showGeneration === false ? harness.name.replace(/\.(?:harness|ya?ml)$/u, "") : harness.name;
		let label = clipped(name, options?.harness?.maxLength ?? 24);
		if (harness.mode) label += ` / ${clipped(harness.mode, 12)}`;
		if (preset === "bb-detailed" && harness.generation) {
			label += ` g${clipped(harness.generation.replace(/^sha256:/u, "").slice(0, 8), 8)}`;
		}
		add(theme.fg("muted", label), 50);
	}
	add(renderBreadboardPolicy(harness), 85);
	if (preset === "bb-detailed") {
		const budgets = longRunBudgets(harness?.lock ?? null);
		const limits: string[] = [];
		if (budgets?.totalCostUsd !== undefined) limits.push(`$${budgets.totalCostUsd.toFixed(2)}`);
		if (budgets?.totalTokens !== undefined) limits.push(`${formatNumber(budgets.totalTokens)} tok`);
		if (limits.length) add(theme.fg("muted", `limit ${limits.join(" / ")}`), 35);
	}
	add(
		theme.fg(
			"statusLinePath",
			iconLabel(theme.icon.folder, clipped(snapshot.workspace, options?.path?.maxLength ?? 24)),
		),
		70,
		"right",
	);
	if (snapshot.branch && preset !== "bb-quiet") {
		add(theme.fg("muted", iconLabel(theme.icon.branch, clipped(snapshot.branch, 22))), 60, "right");
	}
	const context = snapshot.context;
	if (context && context.capacity > 0 && context.tokens >= 0) {
		const percent = (context.tokens / context.capacity) * 100;
		if (percent >= (options?.context_pct?.minPercent ?? 0)) {
			const amount = percent > 0 && percent < 1 ? "<1" : `${Math.round(percent)}`;
			add(
				theme.fg(
					percent >= 90 ? "error" : percent >= 75 ? "warning" : "muted",
					`ctx ~${amount}% / ${formatNumber(context.capacity)}`,
				),
				percent >= 90 ? 92 : percent >= 75 ? 80 : 30,
				"right",
			);
		}
	}
	if (preset === "bb-detailed") {
		if (snapshot.inputTokens !== undefined)
			add(theme.fg("muted", `in ${formatNumber(snapshot.inputTokens)}`), 20, "right");
		if (snapshot.outputTokens !== undefined)
			add(theme.fg("muted", `out ${formatNumber(snapshot.outputTokens)}`), 20, "right");
	}
	// Rule-based shapes put their right group above the input and left group below it.
	const selected = parts.filter(part =>
		layout === "plain-left" ? part.side === "left" : layout === "plain-right" ? part.side === "right" : true,
	);
	const separator = theme.fg("dim", theme.getSymbolPreset() === "ascii" ? " | " : " · ");
	const measure = () =>
		selected.reduce((sum, part) => sum + visibleWidth(part.text), 0) + Math.max(0, selected.length - 1) * 3 + 2;
	while (selected.length > 1 && measure() > width) {
		let drop = selected.length - 1;
		for (let index = selected.length - 2; index >= 0; index--) {
			if (selected[index]!.priority < selected[drop]!.priority) drop = index;
		}
		selected.splice(drop, 1);
	}
	if (selected.length === 0) return "";
	if (selected.length === 1) return truncateToWidth(` ${selected[0]!.text} `, width);
	const left = selected
		.filter(part => part.side === "left")
		.map(part => part.text)
		.join(separator);
	const right = selected
		.filter(part => part.side === "right")
		.map(part => part.text)
		.join(separator);
	if (!left || !right) return truncateToWidth(` ${left || right} `, width);
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 2);
	const fill = layout === "box" ? theme.fg("dim", theme.boxRound.horizontal.repeat(gap)) : " ".repeat(gap);
	return ` ${left}${fill}${right} `;
}
