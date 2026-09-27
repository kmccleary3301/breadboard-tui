import path from "node:path";
import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { registerStatusLinePreset, registerStatusLineSegment } from "@oh-my-pi/pi-tui/status-line";
import type { StatusLinePresetRenderContext } from "@oh-my-pi/pi-tui/status-line/presets";
import { BREADBOARD_STATUS_LINE_PRESETS } from "./status-line/presets";
import { harnessSegment, breadboardPolicySegment } from "./status-line/segments";
import {
	renderBreadboardStatusLine,
	renderBreadboardStatusRows,
	type BreadboardStatusSnapshot,
} from "./status-line/breadboard-presentation";
import { registerSettingValueNormalizer } from "../../config/settings-extensions";
import {
	BREADBOARD_FIELD_DEFINITIONS,
	type BreadboardFieldSettings,
	DEFAULT_BREADBOARD_FIELD_SETTINGS,
} from "./status-line/breadboard-fields";

function assertBreadboardFieldSettings(value: unknown): asserts value is Partial<BreadboardFieldSettings> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("statusLine.breadboard must be an object of field choices.");
	}
	for (const [key, choice] of Object.entries(value)) {
		const field = BREADBOARD_FIELD_DEFINITIONS.find(candidate => candidate.key === key);
		if (!field) throw new Error(`Unknown BreadBoard information field: ${key}`);
		if (!field.options.some(option => option.value === choice)) {
			throw new Error(`Invalid BreadBoard information choice for ${key}: ${String(choice)}`);
		}
	}
}

function buildBreadboardSnapshot(context: StatusLinePresetRenderContext): BreadboardStatusSnapshot {
	const { ctx, session, placeholders, previewTitle, backgroundWait } = context;
	const customSnapshot = (ctx as any)?.snapshot as BreadboardStatusSnapshot | undefined;
	if (customSnapshot) {
		return customSnapshot;
	}
	const s = session as any;
	return {
		modelName: placeholders
			? "Connecting"
			: (s?.state?.model?.name ?? s?.state?.model?.id ?? s?.model?.name ?? s?.model?.id ?? "No model"),
		workspace: ctx?.worktree
			? `${ctx.worktree.projectName}/${ctx.worktree.worktreeName}`
			: path.basename(getProjectDir()),
		workspacePath: getProjectDir(),
		sessionName: s?.sessionManager?.getSessionName?.() ?? previewTitle,
		harness: ctx?.harness,
		branch: ctx?.git?.branch,
		activity: placeholders ? null : undefined,
		elapsedMs: placeholders ? null : ctx?.turnElapsedMs,
		backgroundWait: placeholders ? 0 : (backgroundWait ?? 0),
		context: placeholders ? null : { tokens: ctx?.contextTokens ?? 0, capacity: ctx?.contextWindow ?? 0 },
		inputTokens: placeholders ? undefined : ctx?.usageStats?.input,
		outputTokens: placeholders ? undefined : ctx?.usageStats?.output,
		vim:
			ctx?.vim && ctx.vim.display !== "none"
				? `${ctx.vim.mode}${ctx.vim.pending ? ` ${ctx.vim.pending}` : ""}`
				: undefined,
	};
}

/** Register the bb status-line segments and presets; returns a handle that removes them. */
export function registerBreadboardStatusLine(): () => void {
	const unregisters = [
		registerSettingValueNormalizer("statusLine.breadboard", {
			validate: assertBreadboardFieldSettings,
			resolve: value => ({ ...DEFAULT_BREADBOARD_FIELD_SETTINGS, ...(value as Partial<BreadboardFieldSettings>) }),
		}),
		registerStatusLineSegment(harnessSegment),
		registerStatusLineSegment(breadboardPolicySegment),
	];

	for (const [name, def] of Object.entries(BREADBOARD_STATUS_LINE_PRESETS)) {
		const unregisterPreset = registerStatusLinePreset({
			name,
			def,
			supportsTopAttachment: true,
			render(context) {
				const snapshot = buildBreadboardSnapshot(context);
				const layout = context.layout === "standalone" ? "box" : context.layout;
				const content = renderBreadboardStatusLine(
					snapshot,
					name,
					context.width,
					layout,
					context.config as Partial<BreadboardFieldSettings> | undefined,
				);
				return { content };
			},
			renderRows(context) {
				const snapshot = buildBreadboardSnapshot(context);
				const layout =
					context.layout === "box" || context.layout === "band" || context.layout === "plain-right"
						? context.layout
						: "box";
				const rows = renderBreadboardStatusRows(
					snapshot,
					name,
					context.width,
					layout,
					context.config as Partial<BreadboardFieldSettings> | undefined,
				);
				return { top: rows.top, bottom: rows.bottom };
			},
		});
		unregisters.push(unregisterPreset);
	}
	return () => {
		for (const unregister of unregisters.reverse()) unregister();
	};
}
