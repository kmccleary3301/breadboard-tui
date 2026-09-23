import { beforeAll, describe, expect, it } from "bun:test";
import { EFFECTIVE_HARNESS_SNAPSHOT } from "./effective-lock-fixture";
import { createGallerySegmentContext } from "@oh-my-pi/pi-coding-agent/cli/gallery-fixtures/segments";
import { renderSegment } from "@oh-my-pi/pi-tui/status-line/segments";
import { getPreset } from "@oh-my-pi/pi-tui/status-line/presets";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

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

	it("shortens sha256 generation hashes to prevent status line overflow", () => {
		const context = createGallerySegmentContext();
		context.harness = {
			...snapshot,
			generation: "sha256:1c756e4ff8ae7dee8dd96e37ba759dce661054245e387cd3dcba357b78dbd5af",
		};

		const rendered = renderSegment("harness", context);

		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe("codex-e4 · build · g1c756e4f");
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

function withLongRun(enabled: boolean, caps: Record<string, number>) {
	const rows = [
		{ path: "long_running.enabled", value_kind: "boolean", value: enabled, visibility: "model-visible" },
		...Object.entries(caps).map(([leaf, value]) => ({
			path: `long_running.budgets.${leaf}`,
			value_kind: "number",
			value,
			visibility: "model-visible",
		})),
	];
	return { ...snapshot, lock: { ...snapshot.lock, effective_values: rows } };
}

describe("longrun status segment", () => {
	it("stays hidden while the long-run controller is disabled, even with caps present", () => {
		const context = createGallerySegmentContext();
		context.harness = withLongRun(false, { total_cost_usd: 5, total_tokens: 20000 });

		expect(renderSegment("longrun", context).visible).toBe(false);
	});

	it("shows only the caps the engine enforces and treats zero as uncapped", () => {
		const context = createGallerySegmentContext();
		context.harness = withLongRun(true, {
			total_cost_usd: 2.5,
			total_tokens: 0,
			wall_clock_s: 3600,
			total_episodes: 4,
		});

		const rendered = renderSegment("longrun", context);

		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe("longrun ≤ $2.50");
	});

	it("falls back to the bare label when every enforced cap is unset", () => {
		const context = createGallerySegmentContext();
		context.harness = withLongRun(true, { total_cost_usd: 0, total_tokens: 0 });

		expect(Bun.stripANSI(renderSegment("longrun", context).content)).toBe("longrun");
	});
});
