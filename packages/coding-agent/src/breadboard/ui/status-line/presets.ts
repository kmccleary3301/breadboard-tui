import type { PresetDef } from "@oh-my-pi/pi-tui/status-line/types";
export { isBreadboardPreset } from "./breadboard-presentation";

export const BREADBOARD_STATUS_LINE_PRESETS: Record<string, PresetDef> = {
	"bb-balanced": {
		leftSegments: ["vim", "model", "harness", "bb_policy"],
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
		leftSegments: ["vim", "model", "bb_policy"],
		rightSegments: ["path", "context_pct"],
		separator: "pipe",
		segmentOptions: {
			model: { showThinkingLevel: false },
			path: { abbreviate: true, maxLength: 20 },
			context_pct: { minPercent: 75 },
		},
	},
	"bb-detailed": {
		leftSegments: ["vim", "model", "harness", "bb_policy"],
		rightSegments: ["path", "git", "context_pct", "token_in", "token_out"],
		separator: "pipe",
		segmentOptions: {
			model: { showThinkingLevel: false },
			harness: { showGeneration: true, maxLength: 28 },
			path: { abbreviate: true, maxLength: 28 },
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
		},
	},
};
