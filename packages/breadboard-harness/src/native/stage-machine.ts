import { isJsonRecord, type JsonRecord } from "../canonical-json";
import { nativeLockValue } from "./lock-values";
import type { NativeToolSurfacePack } from "./types";

export interface NativeHarnessStage {
	readonly mode: string;
	readonly systemPrompt: string;
	readonly perTurnPrompt: string;
	readonly toolPromptMode?: string;
	readonly suppressPrompts?: boolean;
	readonly toolSurface: NativeToolSurfacePack;
}

interface StageStep {
	readonly mode: string;
	readonly condition?: string;
}

function modeFromStep(step: JsonRecord): string | undefined {
	if (typeof step.mode === "string") return step.mode;
	const then = step.then;
	return isJsonRecord(then) && typeof then.mode === "string" ? then.mode : undefined;
}

function stepsFromLock(lock: JsonRecord): readonly StageStep[] {
	const sequence = nativeLockValue(lock, "loop.sequence");
	if (!Array.isArray(sequence)) return [];
	const steps: StageStep[] = [];
	for (const item of sequence) {
		if (!isJsonRecord(item)) continue;
		const mode = modeFromStep(item);
		if (mode === undefined) continue;
		const condition = typeof item.if === "string" ? item.if : undefined;
		steps.push(condition === undefined ? { mode } : { mode, condition });
	}
	return steps;
}

function featureValues(lock: JsonRecord): Map<string, boolean> {
	const values = new Map<string, boolean>();
	const rows = lock.effective_values;
	if (!Array.isArray(rows)) return values;
	for (const row of rows) {
		if (!isJsonRecord(row) || typeof row.path !== "string" || !row.path.startsWith("features.")) continue;
		if (typeof row.value === "boolean") values.set(row.path.slice("features.".length), row.value);
	}
	return values;
}

function planTurnLimit(lock: JsonRecord): number {
	const value = nativeLockValue(lock, "loop.plan_turn_limit");
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Runtime mode selector matching Python's `_resolve_active_mode` and
 * `GuardrailOrchestrator.maybe_transition_plan_mode` (`agent_llm_openai.py:3052-3080`,
 * `guardrails/orchestrator.py:258-349`).
 */
export class NativeStageMachine {
	readonly #stages: ReadonlyMap<string, NativeHarnessStage>;
	readonly #steps: readonly StageStep[];
	#features: Map<string, boolean>;
	readonly #planLimit: number;
	#current: NativeHarnessStage;
	#planTurns = 0;

	constructor(lock: JsonRecord, stages: ReadonlyMap<string, NativeHarnessStage>) {
		this.#stages = stages;
		this.#steps = stepsFromLock(lock);
		this.#features = featureValues(lock);
		this.#planLimit = planTurnLimit(lock);
		const initial = this.#selectMode();
		if (initial !== undefined) {
			this.#current = initial;
			return;
		}
		const fallback = stages.values().next().value;
		if (fallback === undefined) throw new Error("native harness has no stages");
		this.#current = fallback;
	}

	get current(): NativeHarnessStage {
		return this.#current;
	}

	get planTurns(): number {
		return this.#planTurns;
	}
	/** Reset per-run mode state while preserving session-level feature transitions. */
	reset(): void {
		this.#planTurns = 0;
		this.#current = this.#selectMode() ?? this.#current;
	}

	/** Advance after a completed plan turn; Python requires a non-empty TODO board, regardless of item statuses. */
	endTurn(hasTodos: boolean): NativeHarnessStage {
		if (this.#current.mode !== "plan" || !hasTodos) return this.#current;
		this.#planTurns += 1;
		if (this.#planLimit !== 0 && this.#planTurns < this.#planLimit) return this.#current;
		if (this.#features.get("plan") !== true) return this.#current;
		this.#features.set("plan", false);
		this.#current = this.#selectMode() ?? this.#current;
		return this.#current;
	}

	#selectMode(): NativeHarnessStage | undefined {
		for (const step of this.#steps) {
			if (step.condition !== undefined && !this.#conditionEnabled(step.condition)) continue;
			const stage = this.#stages.get(step.mode);
			if (stage !== undefined) return stage;
		}
		return this.#stages.values().next().value;
	}

	#conditionEnabled(condition: string): boolean {
		if (!condition.startsWith("features.")) return false;
		return this.#features.get(condition.slice("features.".length)) === true;
	}
}

export function createNativeStageMachine(lock: JsonRecord, stages: readonly NativeHarnessStage[]): NativeStageMachine {
	return new NativeStageMachine(lock, new Map(stages.map(stage => [stage.mode, stage])));
}

export function allNativeToolSurface(stages: readonly NativeHarnessStage[]): NativeToolSurfacePack {
	const mode = stages[0]?.mode ?? "";
	const native = new Map<string, NativeToolSurfacePack["native"][number]>();
	const textInvoked = new Map<string, NativeToolSurfacePack["textInvoked"][number]>();
	for (const stage of stages) {
		for (const tool of stage.toolSurface.native) native.set(tool.name, tool);
		for (const tool of stage.toolSurface.textInvoked) textInvoked.set(tool.name, tool);
	}
	return Object.freeze({
		mode,
		native: Object.freeze([...native.values()]),
		textInvoked: Object.freeze([...textInvoked.values()]),
	});
}
