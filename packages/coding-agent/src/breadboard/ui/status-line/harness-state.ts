import type { HarnessSnapshot } from "../../harness-port";

let harness: HarnessSnapshot | null = null;

/**
 * The harness the bb status line shows. Interactive mode sets it from the harness port and then
 * invalidates the status line; the bb segments and presets read it at render time.
 */
export function setStatusLineHarness(snapshot: HarnessSnapshot | null): void {
	harness = snapshot;
}

export function statusLineHarness(): HarnessSnapshot | null {
	return harness;
}
