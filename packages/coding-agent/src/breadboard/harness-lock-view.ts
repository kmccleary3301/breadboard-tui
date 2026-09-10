/**
 * Pure projection helpers for the canonical `harness_lock.get` effective config graph.
 *
 * The engine returns one row per dotted path in `effective_values`; callers must
 * not read guessed top-level fields or prefix-match nested paths. Redacted and
 * secret-reference rows are intentionally unavailable to presentation callers.
 */

import { isRecord } from "@oh-my-pi/pi-utils";
import type { HarnessSnapshot } from "./harness-port";

export type EffectiveLockVisibility = "model-visible" | "host-only" | "redacted";
export type EffectiveLockValueKind = "string" | "number" | "boolean" | "object" | "array" | "null" | "secret-ref";

export type EffectiveLockValue =
	| string
	| number
	| boolean
	| null
	| readonly EffectiveLockValue[]
	| { readonly [key: string]: EffectiveLockValue };

export interface EffectiveLockValueRow {
	readonly path: string;
	readonly valueKind: EffectiveLockValueKind;
	readonly value: EffectiveLockValue;
	readonly visibility: EffectiveLockVisibility;
}

export interface EffectiveLockValueResult {
	readonly value: EffectiveLockValue;
	readonly visibility: Exclude<EffectiveLockVisibility, "redacted">;
}

type Lock = HarnessSnapshot["lock"];


function isLockValue(value: unknown): value is EffectiveLockValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isLockValue);
	if (!isRecord(value)) return false;
	return Object.values(value).every(isLockValue);
}

function isValueKind(value: unknown): value is EffectiveLockValueKind {
	return (
		value === "string" ||
		value === "number" ||
		value === "boolean" ||
		value === "object" ||
		value === "array" ||
		value === "null" ||
		value === "secret-ref"
	);
}

function isVisibility(value: unknown): value is EffectiveLockVisibility {
	return value === "model-visible" || value === "host-only" || value === "redacted";
}

function readRow(value: unknown): EffectiveLockValueRow | undefined {
	if (!isRecord(value)) return undefined;
	const path = value.path;
	const valueKind = value.value_kind;
	const visibility = value.visibility;
	if (typeof path !== "string" || !isValueKind(valueKind) || !isVisibility(visibility)) return undefined;
	if (!isLockValue(value.value)) return undefined;
	return { path, valueKind, value: value.value, visibility };
}

function findRow(lock: Lock, path: string): EffectiveLockValueRow | undefined {
	if (!lock) return undefined;
	const effectiveValues = lock.effective_values;
	if (!Array.isArray(effectiveValues)) return undefined;
	for (const candidate of effectiveValues) {
		const row = readRow(candidate);
		if (row?.path === path) return row;
	}
	return undefined;
}

/** Return a model-safe exact-path value from the effective config graph. */
export function lockValue(lock: Lock, path: string): EffectiveLockValueResult | undefined {
	const row = findRow(lock, path);
	if (!row || row.visibility === "redacted" || row.valueKind === "secret-ref") return undefined;
	return { value: row.value, visibility: row.visibility };
}

/** Effective team size, gated by the canonical multi-agent enable flag. */
export function teamSize(lock: Lock): number | undefined {
	if (lockValue(lock, "multi_agent.enabled")?.value !== true) return undefined;
	const value = lockValue(lock, "multi_agent.team_config.team.orchestration.scheduler.max_concurrent_agents")?.value;
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Whether the canonical long-running controller is enabled. */
export function longRunEnabled(lock: Lock): boolean | undefined {
	const value = lockValue(lock, "long_running.enabled")?.value;
	return typeof value === "boolean" ? value : undefined;
}

/** Ordered mode names exposed by the lock, excluding the transient compact mode. */
export function modeNames(lock: Lock): readonly string[] {
	const value = lockValue(lock, "modes")?.value;
	if (!Array.isArray(value)) return [];
	const names: string[] = [];
	for (const mode of value) {
		if (!isRecord(mode) || typeof mode.name !== "string" || mode.name.length === 0 || mode.name === "compact") continue;
		names.push(mode.name);
	}
	return names;
}

/** Ordered, presentation-ready parts of the effective compute posture. */
export function posture(lock: Lock): readonly string[] {
	const parts: string[] = [];
	const nativeTools = lockValue(lock, "provider_tools.use_native")?.value;
	if (typeof nativeTools === "boolean") parts.push(nativeTools ? "native tools" : "prompted tools");

	const apiVariant = lockValue(lock, "provider_tools.api_variant")?.value;
	if (apiVariant === "responses") parts.push("responses API");

	const modes = modeNames(lock);
	if (modes.length > 0) parts.push(modes.join("→"));
	return parts;
}
