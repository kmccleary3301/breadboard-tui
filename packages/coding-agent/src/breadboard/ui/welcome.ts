import { sanitizeStatusText } from "@oh-my-pi/pi-tui/chrome/shared";
import type { HarnessSnapshot } from "../harness-port";

function lockValue(lock: HarnessSnapshot["lock"], path: string): unknown {
	const rows = lock?.effective_values;
	if (!Array.isArray(rows)) return undefined;
	const row = rows.find(
		(candidate): candidate is Readonly<Record<string, unknown>> =>
			typeof candidate === "object" && candidate !== null && candidate.path === path,
	);
	return row && row.visibility !== "redacted" && row.value_kind !== "secret-ref" ? row.value : undefined;
}

function harnessTeamSize(lock: HarnessSnapshot["lock"]): number | undefined {
	if (lockValue(lock, "multi_agent.enabled") !== true) return undefined;
	const value = lockValue(lock, "multi_agent.team_config.team.orchestration.scheduler.max_concurrent_agents");
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function harnessPosture(lock: HarnessSnapshot["lock"]): readonly string[] {
	const parts: string[] = [];
	const nativeTools = lockValue(lock, "provider_tools.use_native");
	if (typeof nativeTools === "boolean") parts.push(nativeTools ? "native tools" : "prompted tools");
	if (lockValue(lock, "provider_tools.api_variant") === "responses") parts.push("responses API");
	const modes = lockValue(lock, "modes");
	if (Array.isArray(modes)) {
		const names: string[] = [];
		for (const mode of modes) {
			if (typeof mode !== "object" || mode === null || !("name" in mode) || typeof mode.name !== "string") continue;
			if (mode.name !== "compact") names.push(mode.name);
		}
		if (names.length > 0) parts.push(names.join("→"));
	}
	return parts;
}

/**
 * The welcome screen's one-row harness identity: name, mode and generation, team size, tool
 * posture, then the `/harness` hint. Empty without a harness.
 */
export function formatWelcomeHarnessIdentity(harness: HarnessSnapshot | null | undefined): string {
	if (!harness) return "";
	const identityParts = [`Harness ${sanitizeStatusText(harness.name)}`];
	const detailParts: string[] = [];
	if (harness.mode !== null) detailParts.push(sanitizeStatusText(harness.mode));
	if (harness.generation !== null) {
		const generation = sanitizeStatusText(harness.generation)
			.replace(/^sha256:/, "")
			.slice(0, 8);
		detailParts.push(`g${generation}`);
	}
	if (detailParts.length > 0) identityParts[0] += ` (${detailParts.join(", ")})`;
	const lock = harness.lock;
	const size = harnessTeamSize(lock);
	if (size !== undefined) identityParts.push(`team ${size}`);
	identityParts.push(...harnessPosture(lock));
	if (lock === null) identityParts.push("details unverified");
	identityParts.push("/harness");
	return identityParts.join(" · ");
}
