import { CUSTOM_STATUS_LINE_DEFAULTS } from "./schema";
import type { PresetDef, SegmentContext, StatusLinePreset, StatusLineSegmentOptions } from "./types";
import type { StatusLineSession } from "./host";
import type { ComposerPreviewStatusSource } from "../overlays/composer-shape-preview";

export const STATUS_LINE_PRESETS: Record<StatusLinePreset, PresetDef> = {
	default: {
		leftSegments: ["pi", "vim", "model", "mode", "collab", "stream", "path", "git", "pr", "context_pct", "cost"],
		rightSegments: ["session_name"],
		separator: "powerline-thin",
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 40, stripWorkPrefix: true },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
		},
	},

	minimal: {
		leftSegments: ["vim", "path", "git"],
		rightSegments: ["session_name", "mode", "context_pct"],
		separator: "slash",
		segmentOptions: {
			path: { abbreviate: true, maxLength: 30 },
			git: { showBranch: true, showStaged: false, showUnstaged: false, showUntracked: false },
		},
	},

	compact: {
		leftSegments: ["vim", "model", "mode", "git", "pr"],
		rightSegments: ["session_name", "cost", "context_pct"],
		separator: "powerline-thin",
		segmentOptions: {
			model: { showThinkingLevel: false },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: false },
		},
	},

	full: {
		leftSegments: ["pi", "vim", "hostname", "model", "mode", "path", "git", "pr", "subagents"],
		rightSegments: [
			"session_name",
			"cache_hit",
			"token_in",
			"token_out",
			"token_rate",
			"cache_read",
			"cost",
			"context_pct",
			"time_spent",
			"time",
		],
		separator: "powerline",
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 50 },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
			time: { format: "24h", showSeconds: false },
		},
	},

	nerd: {
		// Full preset with all Nerd Font icons
		leftSegments: ["pi", "vim", "hostname", "model", "mode", "path", "git", "pr", "session", "subagents"],
		rightSegments: [
			"session_name",
			"token_in",
			"token_out",
			"cache_read",
			"cache_write",
			"token_rate",
			"cost",
			"context_pct",
			"context_total",
			"time_spent",
			"time",
		],
		separator: "powerline",
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 60 },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
			time: { format: "24h", showSeconds: true },
		},
	},

	ascii: {
		// No Nerd Font dependencies
		leftSegments: ["vim", "model", "mode", "path", "git", "pr"],
		rightSegments: ["session_name", "token_total", "cost", "context_pct"],
		separator: "ascii",
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 40 },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
		},
	},

	custom: {
		// User-defined - these are just defaults that get overridden
		leftSegments: [...CUSTOM_STATUS_LINE_DEFAULTS.left],
		rightSegments: [...CUSTOM_STATUS_LINE_DEFAULTS.right],
		separator: "powerline-thin",
		segmentOptions: {},
	},
};

export interface StatusLinePresetRenderContext {
	readonly session: StatusLineSession;
	readonly ctx: SegmentContext;
	readonly width: number;
	readonly layout: "box" | "band" | "plain-right" | "plain-left" | "plain-full" | "standalone";
	readonly preset: string;
	readonly options: StatusLineSegmentOptions;
	readonly config?: unknown;
	readonly customActivity?: unknown;
	readonly placeholders?: boolean;
	readonly previewTitle?: string;
	readonly backgroundWait?: number;
}

export interface StatusLinePresetRegistration {
	readonly name: string;
	readonly def?: PresetDef;
	readonly supportsTopAttachment?: boolean;
	readonly render?: (context: StatusLinePresetRenderContext) => { content: string; overflow?: string };
	readonly renderRows?: (context: StatusLinePresetRenderContext) => { top: string; bottom: string };
	readonly createPreviewStatus?: (host: unknown) => ComposerPreviewStatusSource | undefined;
}

const customPresets = new Map<string, StatusLinePresetRegistration>();

export function resetStatusLinePresets(): void {
	customPresets.clear();
}

export function registerStatusLinePreset(registration: StatusLinePresetRegistration): () => void {
	customPresets.set(registration.name, registration);
	return () => {
		customPresets.delete(registration.name);
	};
}

export function getStatusLinePreset(name: string | undefined): StatusLinePresetRegistration | undefined {
	if (!name) return undefined;
	const custom = customPresets.get(name);
	if (custom) return custom;
	const builtin = STATUS_LINE_PRESETS[name as StatusLinePreset];
	if (builtin) {
		return {
			name,
			def: builtin,
		};
	}
	return undefined;
}

export function getAllStatusLinePresets(): readonly StatusLinePresetRegistration[] {
	const builtins = Object.entries(STATUS_LINE_PRESETS).map(([name, def]) => ({ name, def }));
	return [...builtins, ...customPresets.values()];
}

export function isStatusLineTopAttachmentSupported(preset: string | undefined): boolean {
	if (!preset) return false;
	const reg = getStatusLinePreset(preset);
	return reg?.supportsTopAttachment === true;
}

export function getPreset(name: StatusLinePreset | string): PresetDef {
	const custom = customPresets.get(name);
	if (custom?.def) return custom.def;
	return STATUS_LINE_PRESETS[name as StatusLinePreset] ?? STATUS_LINE_PRESETS.default;
}
