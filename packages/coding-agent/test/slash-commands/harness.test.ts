import { describe, expect, test, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { InteractiveModeContext } from "../../src/modes/types";
import { executeHarnessSlashCommand } from "../../src/slash-commands/harness";

function runtimeFor(startHarnessSession: (harnessId: string) => Promise<boolean>) {
	const showStatus = vi.fn();
	const runtime = {
		ctx: {
			settings: Settings.isolated(),
			harnessPort: undefined,
			startHarnessSession,
			showStatus,
		} as unknown as InteractiveModeContext,
	};
	return { runtime, showStatus };
}

describe("/harness use", () => {
	test("routes the selected harness to the controller and reports a new session", async () => {
		const startHarnessSession = vi.fn(async (harnessId: string) => harnessId === "codex");
		const harness = runtimeFor(startHarnessSession);

		expect(await executeHarnessSlashCommand("/harness use codex", harness.runtime)).toBe(true);
		expect(startHarnessSession).toHaveBeenCalledWith("codex");
		expect(harness.showStatus).toHaveBeenCalledWith(
			"Started a new BreadBoard session on harness codex; previous session remains resumable.",
		);
	});

	test("keeps the failure path silent after the controller reports that the session was not started", async () => {
		const startHarnessSession = vi.fn(async () => false);
		const harness = runtimeFor(startHarnessSession);

		expect(await executeHarnessSlashCommand("/harness use missing", harness.runtime)).toBe(true);
		expect(startHarnessSession).toHaveBeenCalledWith("missing");
		expect(harness.showStatus).not.toHaveBeenCalled();
	});
});
