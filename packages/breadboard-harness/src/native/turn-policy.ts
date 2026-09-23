import type { NativeToolSurfacePack } from "./types";

export interface NativeToolAdmission {
	readonly block: true;
	readonly reason: string;
}

/**
 * Per-turn tool-call accounting for a harness surface. The Python reference counts each tool's
 * calls within one model turn and refuses calls past `execution.max_per_turn`.
 */
export class NativeTurnPolicy {
	readonly #limits: ReadonlyMap<string, number>;
	readonly #calls = new Map<string, number>();
	#completed = false;

	constructor(surface: NativeToolSurfacePack) {
		const limits = new Map<string, number>();
		for (const tool of [...surface.native, ...surface.textInvoked]) {
			if (tool.maxPerTurn !== undefined) limits.set(tool.name, tool.maxPerTurn);
		}
		this.#limits = limits;
	}

	/** Start counting a new model turn. */
	beginTurn(): void {
		this.#calls.clear();
	}

	/** Count one call; returns a block decision once the tool exceeds its per-turn limit. */
	admit(toolName: string): NativeToolAdmission | undefined {
		const limit = this.#limits.get(toolName);
		if (limit === undefined) return undefined;
		const count = (this.#calls.get(toolName) ?? 0) + 1;
		this.#calls.set(toolName, count);
		if (count <= limit) return undefined;
		return { block: true, reason: `${toolName} allows at most ${limit} call${limit === 1 ? "" : "s"} per turn` };
	}

	/** Record that the model called `mark_task_complete`. */
	markCompleted(): void {
		this.#completed = true;
	}

	get completed(): boolean {
		return this.#completed;
	}
}
