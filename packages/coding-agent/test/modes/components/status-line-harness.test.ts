import { beforeAll, describe, expect, it } from "bun:test";
import type { HarnessSnapshot } from "@oh-my-pi/pi-coding-agent/breadboard/harness-port";
import { createGallerySegmentContext } from "@oh-my-pi/pi-coding-agent/cli/gallery-fixtures/segments";
import { ALL_SEGMENT_IDS, renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { getPreset } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/presets";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const snapshot: HarnessSnapshot = {
	harnessId: "codex-e4",
	name: "codex-e4",
	lockHash: null,
	generation: "3",
	mode: "build",
	lock: null,
	provenance: {},
	loadedAt: 0,
};

beforeAll(async () => {
	await initTheme();
});

describe("harness status segment", () => {
	it("renders the active harness identity and generation", () => {
		const context = createGallerySegmentContext();
		context.harness = snapshot;

		const rendered = renderSegment("harness", context);

		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe("codex-e4 · build · g3");
	});

	it("renders empty and hidden when no harness is active", () => {
		const context = createGallerySegmentContext();
		context.harness = null;

		const rendered = renderSegment("harness", context);

		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});
	it("registers the segment in the default preset and inventory", () => {
		expect(ALL_SEGMENT_IDS).toContain("harness");
		expect(getPreset("default").leftSegments).toContain("harness");
	});
});
