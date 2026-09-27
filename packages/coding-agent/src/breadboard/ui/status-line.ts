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
import type { BreadboardFieldSettings } from "./status-line/breadboard-fields";

function buildBreadboardSnapshot(context: StatusLinePresetRenderContext): BreadboardStatusSnapshot {
	const { ctx, session, placeholders, previewTitle, backgroundWait } = context;
	return {
		modelName: placeholders
			? "Connecting"
			: (session.state.model?.name ?? session.state.model?.id ?? "No model"),
		workspace: ctx.worktree
			? `${ctx.worktree.projectName}/${ctx.worktree.worktreeName}`
			: path.basename(getProjectDir()),
		workspacePath: getProjectDir(),
		sessionName: session.sessionManager.getSessionName() ?? previewTitle,
		harness: ctx.harness,
		branch: ctx.git.branch,
		activity: placeholders ? null : undefined,
		elapsedMs: placeholders ? null : ctx.turnElapsedMs,
		backgroundWait: placeholders ? 0 : backgroundWait ?? 0,
		context: placeholders ? null : { tokens: ctx.contextTokens, capacity: ctx.contextWindow },
		inputTokens: placeholders ? undefined : ctx.usageStats.input,
		outputTokens: placeholders ? undefined : ctx.usageStats.output,
		vim:
			ctx.vim && ctx.vim.display !== "none"
				? `${ctx.vim.mode}${ctx.vim.pending ? ` ${ctx.vim.pending}` : ""}`
				: undefined,
	};
}

let registered = false;

export function registerBreadboardStatusLine(): void {
	if (registered) return;
	registered = true;

	registerStatusLineSegment(harnessSegment);
	registerStatusLineSegment(breadboardPolicySegment);

	for (const [name, def] of Object.entries(BREADBOARD_STATUS_LINE_PRESETS)) {
		registerStatusLinePreset({
			name,
			def,
			supportsTopAttachment: true,
			render(context) {
				const snapshot = buildBreadboardSnapshot(context);
				const content = renderBreadboardStatusLine(
					snapshot,
					name,
					context.width,
					context.layout,
					context.config as Partial<BreadboardFieldSettings> | undefined,
				);
				return { content };
			},
			renderRows(context) {
				const snapshot = buildBreadboardSnapshot(context);
				const rows = renderBreadboardStatusRows(
					snapshot,
					name,
					context.width,
					context.layout,
					context.config as Partial<BreadboardFieldSettings> | undefined,
				);
				return { top: rows.top, bottom: rows.bottom };
			},
		});
	}
}
