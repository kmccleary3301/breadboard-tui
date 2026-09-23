import { CUSTOM_STATUS_LINE_DEFAULTS } from "./schema";
import type { PresetDef, StatusLinePreset } from "./types";

export const STATUS_LINE_PRESETS: Record<StatusLinePreset, PresetDef> = {
	"bb-balanced": {
		leftSegments: ["bb_activity", "vim", "model", "harness", "bb_policy"],
		rightSegments: ["path", "git", "context_pct"],
		separator: "pipe",
		segmentOptions: {
			model: { showThinkingLevel: false },
			harness: { showGeneration: false, maxLength: 24 },
			path: { abbreviate: true, maxLength: 24 },
			git: { showBranch: true, showStaged: false, showUnstaged: false, showUntracked: false },
			context_pct: { minPercent: 50 },
		},
	},
	"bb-quiet": {
		leftSegments: ["bb_activity", "vim", "model", "bb_policy"],
		rightSegments: ["path", "context_pct"],
		separator: "pipe",
		segmentOptions: {
			model: { showThinkingLevel: false },
			path: { abbreviate: true, maxLength: 20 },
			context_pct: { minPercent: 75 },
		},
	},
	"bb-detailed": {
		leftSegments: ["bb_activity", "vim", "model", "harness", "bb_policy", "longrun"],
		rightSegments: ["path", "git", "context_pct", "token_in", "token_out"],
		separator: "pipe",
		segmentOptions: {
			model: { showThinkingLevel: false },
			harness: { showGeneration: true, maxLength: 28 },
			path: { abbreviate: true, maxLength: 28 },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
		},
	},
	default: {
		leftSegments: [
			"pi",
			"vim",
			"model",
			"mode",
			"collab",
			"stream",
			"harness",
			"longrun",
			"path",
			"git",
			"pr",
			"context_pct",
			"cost",
		],
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

export function getPreset(name: StatusLinePreset): PresetDef {
	return STATUS_LINE_PRESETS[name] ?? STATUS_LINE_PRESETS.default;
}
