import { beforeAll, describe, expect, it } from "bun:test";
import { EFFECTIVE_HARNESS_SNAPSHOT } from "./effective-lock-fixture";
import { createGallerySegmentContext } from "@oh-my-pi/pi-coding-agent/cli/gallery-fixtures/segments";
import { ALL_SEGMENT_IDS, renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { getPreset } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/presets";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const snapshot = EFFECTIVE_HARNESS_SNAPSHOT;

beforeAll(async () => {
	await initTheme();
});

describe("harness status segment", () => {
	it("renders the active harness identity and generation", () => {
		// Catches canonical-lock wiring regressions that silently fall back to stale top-level fields.
		const context = createGallerySegmentContext();
		context.harness = snapshot;

		const rendered = renderSegment("harness", context);

		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe("codex-e4 · build · g3");
	});

	it("omits unavailable mode and generation members without placeholders", () => {
		// Catches fabricated identity placeholders when nullable snapshot fields are absent.
		const context = createGallerySegmentContext();
		context.harness = { ...snapshot, mode: null, generation: null };

		const rendered = renderSegment("harness", context);

		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe("codex-e4");
	});

	it("renders empty and hidden when no harness is active", () => {
		// Catches stale identity surviving after the harness port reports no active snapshot.
		const context = createGallerySegmentContext();
		context.harness = null;

		const rendered = renderSegment("harness", context);

		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("keeps harness identity out of non-default presets", () => {
		// Catches preset migration that makes BreadBoard identity appear in unrelated status layouts.
		expect(getPreset("minimal").leftSegments).not.toContain("harness");
		expect(getPreset("minimal").rightSegments).not.toContain("harness");
		expect(ALL_SEGMENT_IDS).toContain("harness");
		expect(getPreset("default").leftSegments).toContain("harness");
	});
});
